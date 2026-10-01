import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { WebSocket } from 'ws'
import { startCloudflareQuickTunnel } from './tunnel.js'
import { buildIconDataUri } from './icon.js'
import {
  mobilePageAssets,
  renderDesktopPairingPage,
  renderMobilePage,
  renderMobileReconnectPage,
  renderPairingPinPage,
  renderServiceWorker
} from './pages.js'

const MAX_BODY_BYTES = 64 * 1024
const PAIRING_TTL_MS = 5 * 60 * 1000
const PIN_TTL_MS = PAIRING_TTL_MS
const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000
const PIN_FAIL_PER_IP = 5
const PIN_FAIL_GLOBAL = 20
const MUX_RECONNECT_MS = 500
const MUX_RECONNECT_CAP_MS = 30_000

/**
 * Mobile session cookie lifetime.
 * Changed from the source's one year (Max-Age=31536000) to 30 days.
 */
const MOBILE_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Lifetime of the one-time `/desktop?k=` bootstrap token. */
const DESKTOP_BOOTSTRAP_TTL_MS = 10 * 60 * 1000

/** SSE keepalive comment interval for forwarded session streams. */
const SSE_KEEPALIVE_MS = 15_000

/**
 * Cadence of the connection-state frames pushed down a session stream. The phone
 * skips its HTTP status poll while these keep arriving, so this replaces the old
 * 1.5s round trip; the settings underneath are cached for 5s, so the frames cost
 * no harness traffic of their own.
 */
const SSE_STATUS_MS = 5_000

/** Gateway stream carrier: one WebSocket multiplexing every logical stream. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Gateway-internal stream delivering forwarded Cordis events. */
const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** Gateway-internal unary endpoint settling one forwarded event. */
const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
/** Waterfall event a Host raises when it needs an answer from the user. */
const USER_QUESTION_EVENT = 'user-questions/request'
const EVENT_STREAM_ID = 'mobile-events'
const WORKSPACE_STREAM_ID = 'mobile-workspaces'
const MUX_STABLE_MS = 5_000

/**
 * Mobile method name to the Host endpoint that serves it.
 *
 * 0.1.2-alpha.1 deleted `dsh-host-apiproxy`, whose string-keyed `/api/<name>`
 * routes this bridge was written against, and moved the same operations onto
 * Typert Remote. The transport is unchanged — same `/api` prefix, same
 * client-request envelope — but an endpoint is now `<namespace>/<method>` and
 * its payload carries named args rather than a bare object. Several shapes
 * moved too, so each entry owns its own translation instead of a blanket
 * rename.
 *
 * The mobile page's vocabulary is deliberately left alone: it is served from
 * this file, but a phone may still be holding an older page.
 */
const HARNESS_ENDPOINTS = {
  'agentPreset.list': { endpoint: 'agentPresets/list', args: () => ({}) },
  // The preset selector is keyed by agent id, which for a top-level session is
  // the session id the mobile page already sends.
  'agentPreset.select': {
    endpoint: 'agentPresets/select',
    args: (payload) => ({ agentId: payload.sessionId, agentPreset: payload.agentPreset })
  },
  'session.list': { endpoint: 'session/list', args: () => ({ _request: {} }) },
  // The catalog is no longer per-session: it describes what the Host can route
  // to, so it takes no arguments and the page's sessionId is dropped.
  'session.models': { endpoint: 'session/modelCatalog', args: () => ({}) },
  'session.selectModel': {
    endpoint: 'session/selectModel',
    args: (payload) => ({ request: payload })
  },
  'session.create': { endpoint: 'session/create', args: (payload) => ({ request: payload }) },
  'session.prompt': {
    endpoint: 'session/prompt',
    // requestId must come last so a client payload cannot pin/override it.
    args: (payload) => ({ request: { ...payload, requestId: randomUUID() } })
  },
  'session.cancel': { endpoint: 'session/cancel', args: (payload) => ({ request: payload }) },
  // No-arg call returning every settings namespace at once; the page only reads
  // ui-conversation.busyEnter and ui-chat.transcriptView / performanceUsage.
  'settings.describe': { endpoint: 'settings/describe', args: () => ({}) }
}

const RPC_ALLOWLIST = new Set([...Object.keys(HARNESS_ENDPOINTS), 'session.history', 'workspace.list'])

// Pull only the three desktop settings the mobile UI inherits. Anything missing
// falls back to the desktop defaults on the page, so a partial answer is fine.
function extractMobileSettings(describeValue) {
  const namespaces = Array.isArray(describeValue?.namespaces) ? describeValue.namespaces : []
  const byNs = new Map(namespaces.map((ns) => [String(ns.ns), ns.value || {}]))
  const conversation = byNs.get('ui-conversation') || {}
  const chat = byNs.get('ui-chat') || {}
  return {
    busyEnter: conversation.busyEnter === 'steer' ? 'steer' : 'queue',
    transcriptView: ['compact', 'standard', 'detailed', 'verbose'].includes(chat.transcriptView)
      ? chat.transcriptView
      : 'standard',
    performanceUsage: chat.performanceUsage === 'compact' ? 'compact' : 'detailed'
  }
}

/**
 * @typedef {Object} LanMobileBridgeOptions
 * @property {() => string | undefined} harnessUrl Base URL of the Harness, e.g. http://127.0.0.1:19387.
 * @property {{
 *   ready(): Promise<string | undefined>
 *   invalidate(): void
 * }} innerAuth Process credential: `ready()` resolves to a `dsh-auth-xxx=...` cookie pair.
 * @property {'en' | 'zh' | (() => 'en' | 'zh')} [locale]
 * @property {{ light: string, dark: string }} [brandLogoPaths]
 * @property {string} [appIconPath]
 * @property {number} [port]
 * @property {(port: number) => Promise<object>} [createCloudflareTunnel] Test seam for the tunnel instance.
 * @property {(message: string) => void} [tunnelLog]
 * @property {() => number} [now]
 * @property {() => void} [onReconnectRequested]
 * @property {(connected: boolean) => void} [onConnectedChange]
 * @property {{ load(): { pin?: string, pinConsent?: boolean }, save(state: { pin?: string, pinConsent?: boolean }): boolean }} [pairingPinStore]
 */

/**
 * @typedef {Object} ConnectedDevice
 * @property {string} label
 * @property {string} remoteAddress
 * @property {number} issuedAt
 * @property {number} expiresAt
 */

/**
 * @typedef {Object} LanMobileBridgeSnapshot
 * @property {boolean} running
 * @property {boolean} connected
 * @property {number} [port]
 * @property {string} [pairingUrl]
 * @property {string} [desktopUrl]
 * @property {number} [expiresAt]
 * @property {boolean} [tunnelActive]
 * @property {boolean} [tunnelLoading]
 * @property {string} [tunnelUrl]
 * @property {string} [tunnelProvider]
 * @property {string} [tunnelError]
 * @property {ConnectedDevice[]} connectedDevices
 */

/**
 * @typedef {Object} MobileSession
 * @property {string} token
 * @property {string} remoteAddress
 * @property {string} [label] Short device label derived from the pairing User-Agent.
 * @property {number} [issuedAt]
 * @property {number} [expiresAt]
 */

/**
 * @typedef {'lan' | 'tunnel'} MobileConnectionMode
 */

/**
 * @typedef {Object} PairingPinView
 * @property {string} [pin]
 * @property {boolean} expired
 * @property {boolean} consent
 * @property {number} [expiresAt]
 */

export class LanMobileBridge {
  /** @type {import('node:http').Server | undefined} */
  server
  /** @type {number | undefined} */
  port
  /** @type {string | undefined} */
  pairingToken
  /** @type {number | undefined} */
  pairingExpiresAt
  /** @type {object | undefined} */
  tunnelInstance
  tunnelActive = false
  tunnelLoading = false
  /** @type {string | undefined} */
  tunnelError
  /** @type {Promise<void> | undefined} */
  tunnelLaunch
  /** @type {Map<string, MobileSession>} */
  sessions = new Map()
  /** @type {Map<string, MobileSession>} */
  suspendedSessions = new Map()
  /** Sessions moved here only by a desktop disconnect. Reconnect will not honor anything else. */
  /** @type {Map<string, MobileSession>} */
  resumableSessions = new Map()
  pendingQuestions = new Map()
  /** @type {string | undefined} */
  ephemeralPin
  /** @type {number | undefined} */
  ephemeralPinExpiresAt
  pinFailuresByIp = new Map()
  pinFailuresGlobal = []
  tunnelExpectedStop = false
  /** @type {string | undefined} */
  lastTunnelProvider
  unexpectedlyClosed = false
  /** @type {number | undefined} */
  tunnelExpiresAt
  /** Client generation id from the event stream's `ready` frame; results quote it. */
  /** @type {string | undefined} */
  eventClientId
  /** Latest `workspace/follow` baseline, standing in for the removed unary list. */
  workspaceSnapshot
  /** @type {() => number} */
  now
  /** @type {AbortController | undefined} */
  muxAbort
  /** @type {Promise<void> | undefined} */
  muxTask
  sessionStreamAborts = new Set()
  lastConnected = false
  desktopSessionToken = randomBytes(32).toString('base64url')
  /** @type {string | undefined} */
  desktopBootstrapToken
  /** @type {number | undefined} */
  desktopBootstrapExpiresAt

  /** @param {LanMobileBridgeOptions} options */
  constructor(options) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  log(level, message) {
    try {
      this.options.log?.(level, message)
    } catch {
      // logging must never break request handling
    }
  }

  /** @returns {string | undefined} */
  createDesktopUrl() {
    if (!this.server || !this.port) return undefined
    this.desktopBootstrapToken = randomBytes(32).toString('base64url')
    this.desktopBootstrapExpiresAt = this.now() + DESKTOP_BOOTSTRAP_TTL_MS
    return `http://127.0.0.1:${this.port}/desktop?k=${this.desktopBootstrapToken}`
  }

  /** @returns {Promise<LanMobileBridgeSnapshot>} */
  async start() {
    if (this.server) {
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken()
      }
      this.syncConnected()
      return this.snapshot()
    }
    this.rotatePairingToken()
    this.server = this.createBridgeServer()
    // Port precedence: explicit env override, then the caller's option, then
    // the product default. `0` from the caller means "OS-assigned ephemeral
    // port" and must survive (tests rely on it); only an unset option falls
    // back to 43127.
    const envPort = Number(process.env.DSH_MOBILE_PORT)
    const preferredPort =
      Number.isInteger(envPort) && envPort > 0 ? envPort : (this.options.port ?? 43127)
    let chosenPort = preferredPort
    // Small retry loop: EADDRINUSE on 43127/43128 retries once on port+1.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          this.server?.once('error', reject)
          this.server?.listen(chosenPort, '0.0.0.0', resolve)
        })
        break
      } catch (error) {
        const retryable =
          error instanceof Error &&
          'code' in error &&
          error.code === 'EADDRINUSE' &&
          (chosenPort === 43127 || chosenPort === 43128) &&
          attempt === 0
        if (!retryable) throw error
        // A server whose listen failed is replaced so the retry keeps the same
        // createServer -> listen structure as the first attempt.
        this.server = this.createBridgeServer()
        chosenPort += 1
      }
    }
    const address = this.server.address()
    this.port = address && typeof address === 'object' ? address.port : chosenPort
    this.iconDataUri = await buildIconDataUri(this.options.appIconPath)
    this.syncConnected()
    return this.snapshot()
  }

  /**
   * @returns {import('node:http').Server}
   */
  createBridgeServer() {
    return createServer((request, response) => {
      void this.handle(request, response)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.log('error', `request ${request.method ?? '?'} ${request.url ?? '?'} failed: ${message}`)
          this.json(response, 500, { ok: false, error: message })
        })
        // Every session change is the result of a request: pairing approval,
        // reconnect, or disconnect. Reconciling here keeps the mux monitor and
        // the renderers in step without polling either of them.
        .finally(() => this.syncConnected())
    })
  }

  /** @returns {Promise<void>} */
  async stop() {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.pairingToken = undefined
    this.pairingExpiresAt = undefined
    this.desktopBootstrapToken = undefined
    this.desktopBootstrapExpiresAt = undefined
    // Wait for an in-flight launch so the tunnel it spawns is stopped below
    // instead of outliving the bridge (and the app).
    if (this.tunnelLaunch) {
      await this.tunnelLaunch.catch(() => undefined)
      this.tunnelLaunch = undefined
    }
    await this.stopCurrentTunnel()
    this.tunnelActive = false
    this.tunnelLoading = false
    this.tunnelError = undefined
    this.sessions.clear()
    this.suspendedSessions.clear()
    this.resumableSessions.clear()
    this.pendingQuestions.clear()
    this.ephemeralPin = undefined
    this.ephemeralPinExpiresAt = undefined
    this.clearPinFailures()
    this.clearTunnelDeathFlags()
    this.tunnelExpiresAt = undefined
    for (const abort of this.sessionStreamAborts) abort.abort()
    this.sessionStreamAborts.clear()
    this.syncConnected()
    this.muxAbort?.abort()
    const muxTask = this.muxTask
    this.muxAbort = undefined
    this.muxTask = undefined
    if (muxTask) await muxTask.catch(() => undefined)
    if (!server) return
    // An in-flight mobile RPC can hold its socket for up to the 30s abort
    // timeout; close() alone waits for active connections to drain, which
    // would stall app shutdown. Drop every live socket explicitly.
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /**
   * @param {boolean} [enable]
   * @returns {Promise<LanMobileBridgeSnapshot>}
   */
  async toggleTunnel(enable) {
    const targetState = enable !== undefined ? enable : !this.tunnelActive
    if (targetState && this.sessions.size > 0 && !this.tunnelActive) {
      throw new Error('Disconnect the phone before switching connection modes.')
    }
    if (!targetState) {
      // Wait for an in-flight launch, then stop the tunnel it spawned:
      // otherwise the just-launched process is orphaned (or silently revives
      // the tunnel the user asked to disable).
      if (this.tunnelLaunch) {
        await this.tunnelLaunch.catch(() => undefined)
        this.tunnelLaunch = undefined
      }
      await this.stopCurrentTunnel()
      this.tunnelActive = false
      this.tunnelLoading = false
      this.tunnelError = undefined
      this.clearTunnelDeathFlags()
      this.tunnelExpiresAt = undefined
      return this.snapshot()
    }

    if (this.tunnelActive && this.tunnelInstance?.url) {
      return this.snapshot()
    }

    // A launch is already in flight (the cloudflared download alone can take
    // seconds): report the loading state instead of racing a second tunnel,
    // which would orphan the first cloudflared process.
    if (this.tunnelLaunch) {
      return this.snapshot()
    }

    this.tunnelLoading = true
    this.tunnelError = undefined
    const launch = this.launchTunnel()
    this.tunnelLaunch = launch
    try {
      await launch
      this.tunnelActive = true
      this.clearTunnelDeathFlags()
      this.armTunnelProcess(this.tunnelInstance)
    } catch (error) {
      this.tunnelActive = false
      this.tunnelError = error instanceof Error ? error.message : String(error)
      this.log('error', `tunnel launch failed: ${this.tunnelError}`)
    } finally {
      this.tunnelLoading = false
      if (this.tunnelLaunch === launch) this.tunnelLaunch = undefined
    }
    return this.snapshot()
  }

  /** @returns {Promise<void>} */
  async launchTunnel() {
    const port = this.port
    if (!port) throw new Error('Bridge is not running.')
    // Seam: Pinggy SSH fallback re-added in a later change (pinggy-tunnel.ts source available).
    this.tunnelInstance = await this.startCloudflareInstance(port)
  }

  /**
   * @param {number} port
   * @returns {Promise<object>}
   */
  async startCloudflareInstance(port) {
    if (this.options.createCloudflareTunnel) return this.options.createCloudflareTunnel(port)
    return startCloudflareQuickTunnel({ port, log: this.options.tunnelLog })
  }

  /** @returns {LanMobileBridgeSnapshot} */
  snapshot() {
    this.sweepExpiredSessions()
    if (!this.server || !this.port) {
      return { running: false, connected: this.sessions.size > 0, connectedDevices: this.connectedDevices() }
    }
    // The pairing token is single-use (consumed on approval) and short-lived.
    // Tunnel and listener state must stay visible regardless, otherwise the
    // desktop window loses the connection-mode UI right after a phone pairs.
    const tokenValid = this.pairingTokenValid()
    const address = preferredLanAddress()
    const pairingUrl =
      !tokenValid
        ? undefined
        : this.tunnelActive && this.tunnelInstance?.url
          ? `${this.tunnelInstance.url}/pair?token=${this.pairingToken}`
          : address
            ? `http://${address}:${this.port}/pair?token=${this.pairingToken}`
            : undefined
    return {
      running: true,
      connected: this.sessions.size > 0,
      port: this.port,
      ...(tokenValid && pairingUrl ? { pairingUrl, expiresAt: this.pairingExpiresAt } : {}),
      desktopUrl: `http://127.0.0.1:${this.port}/desktop`,
      tunnelActive: this.tunnelActive,
      tunnelLoading: this.tunnelLoading,
      tunnelUrl: this.tunnelInstance?.url,
      tunnelProvider: this.tunnelInstance?.provider,
      tunnelError: this.tunnelError,
      connectedDevices: this.connectedDevices()
    }
  }

  /** @returns {ConnectedDevice[]} */
  connectedDevices() {
    return [...this.sessions.values()].map((session) => ({
      label: session.label ?? 'Phone',
      remoteAddress: session.remoteAddress,
      issuedAt: session.issuedAt ?? 0,
      expiresAt: session.expiresAt ?? 0
    }))
  }

  rotatePairingToken() {
    this.pairingToken = randomBytes(32).toString('base64url')
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS
  }

  /** @returns {boolean} */
  pairingTokenValid() {
    return Boolean(this.pairingToken && this.pairingExpiresAt && this.pairingExpiresAt >= this.now())
  }

  storedPinState() {
    return this.options.pairingPinStore?.load() ?? {}
  }

  /** @returns {PairingPinView} */
  readPairingPin() {
    const stored = this.storedPinState()
    if (stored.pinConsent === true) {
      return { pin: stored.pin, expired: false, consent: true }
    }
    if (this.ephemeralPin && this.ephemeralPinExpiresAt && this.ephemeralPinExpiresAt >= this.now()) {
      return {
        pin: this.ephemeralPin,
        expired: false,
        consent: false,
        expiresAt: this.ephemeralPinExpiresAt
      }
    }
    if (this.ephemeralPin && this.ephemeralPinExpiresAt && this.ephemeralPinExpiresAt < this.now()) {
      return { expired: true, consent: false, expiresAt: this.ephemeralPinExpiresAt }
    }
    return { expired: false, consent: false }
  }

  /** @returns {boolean} */
  tunnelPinAcceptsReconnect() {
    const view = this.readPairingPin()
    return Boolean(view.pin) && !view.expired
  }

  /** @returns {string} */
  generatePairingPin() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0')
  }

  /** @returns {string | undefined} */
  ensurePairingPin() {
    const stored = this.storedPinState()
    if (stored.pinConsent === true) {
      if (stored.pin) return stored.pin
      const pin = this.generatePairingPin()
      if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) return undefined
      this.ephemeralPin = undefined
      this.ephemeralPinExpiresAt = undefined
      return pin
    }
    const current = this.readPairingPin()
    if (current.pin && !current.expired) return current.pin
    this.ephemeralPin = this.generatePairingPin()
    this.ephemeralPinExpiresAt = this.now() + PIN_TTL_MS
    return this.ephemeralPin
  }

  desktopPinFields() {
    const pin = this.tunnelActive ? this.ensurePairingPin() : undefined
    const view = this.readPairingPin()
    return {
      ...(pin ? { pairingPin: pin } : {}),
      pinConsent: view.consent,
      ...(view.consent || !view.expiresAt ? {} : { pinExpiresAt: view.expiresAt })
    }
  }

  /**
   * @param {string} left
   * @param {string} right
   * @returns {boolean}
   */
  pinsEqual(left, right) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * @param {number[]} stamps
   * @returns {number[]}
   */
  pruneFailures(stamps) {
    const cutoff = this.now() - PIN_FAIL_WINDOW_MS
    return stamps.filter((stamp) => stamp > cutoff)
  }

  /**
   * @param {string} remoteAddress
   * @returns {number | undefined}
   */
  pinRetryAfterSeconds(remoteAddress) {
    const ip = this.pruneFailures(this.pinFailuresByIp.get(remoteAddress) ?? [])
    const global = this.pruneFailures(this.pinFailuresGlobal)
    this.pinFailuresByIp.set(remoteAddress, ip)
    this.pinFailuresGlobal = global
    const limited =
      ip.length >= PIN_FAIL_PER_IP || global.length >= PIN_FAIL_GLOBAL
    if (!limited) return undefined
    const oldest = Math.min(
      ...(ip.length >= PIN_FAIL_PER_IP ? [ip[0]] : []),
      ...(global.length >= PIN_FAIL_GLOBAL ? [global[0]] : [])
    )
    return Math.max(1, Math.ceil((oldest + PIN_FAIL_WINDOW_MS - this.now()) / 1000))
  }

  /**
   * @param {string} remoteAddress
   * @returns {number}
   */
  recordPinFailure(remoteAddress) {
    const ip = this.pruneFailures(this.pinFailuresByIp.get(remoteAddress) ?? [])
    ip.push(this.now())
    this.pinFailuresByIp.set(remoteAddress, ip)
    this.pinFailuresGlobal = this.pruneFailures(this.pinFailuresGlobal)
    this.pinFailuresGlobal.push(this.now())
    return this.pinRetryAfterSeconds(remoteAddress) ?? 1
  }

  clearPinFailures() {
    this.pinFailuresByIp.clear()
    this.pinFailuresGlobal = []
  }

  revokeMobileSessions() {
    this.sessions.clear()
    this.suspendedSessions.clear()
    this.resumableSessions.clear()
    this.rotatePairingToken()
    this.clearPinFailures()
    this.syncConnected()
  }

  /**
   * Fill the per-device fields on a session promoted from a placeholder or a
   * restored suspended session. Already-issued sessions keep their original
   * label and expiry.
   * @param {MobileSession} session
   * @param {import('node:http').IncomingMessage} request
   */
  stampSession(session, request) {
    if (session.issuedAt === undefined) {
      session.issuedAt = this.now()
      session.expiresAt = session.issuedAt + MOBILE_COOKIE_TTL_MS
    }
    if (session.label === undefined) {
      session.label = uaLabel(request.headers['user-agent'])
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   */
  issueSessionCookie(request, response, remoteAddress, connectionMode) {
    this.sweepExpiredSessions()
    const token = randomBytes(32).toString('base64url')
    if (connectionMode === 'tunnel') {
      const existing = this.mobileToken(request)
      if (existing && this.suspendedSessions.has(existing)) {
        const session = this.suspendedSessions.get(existing)
        this.stampSession(session, request)
        this.capDeviceMap(this.sessions, existing)
        this.sessions.set(existing, session)
        this.suspendedSessions.delete(existing)
        this.resumableSessions.delete(existing)
      }
    } else {
      for (const [savedToken, session] of this.suspendedSessions) {
        if (session.remoteAddress !== remoteAddress) continue
        this.stampSession(session, request)
        this.capDeviceMap(this.sessions, savedToken)
        this.sessions.set(savedToken, session)
        this.suspendedSessions.delete(savedToken)
        this.resumableSessions.delete(savedToken)
      }
    }
    const issuedAt = this.now()
    this.capDeviceMap(this.sessions, token)
    this.sessions.set(token, {
      token,
      remoteAddress,
      label: uaLabel(request.headers['user-agent']),
      issuedAt,
      expiresAt: issuedAt + MOBILE_COOKIE_TTL_MS
    })
    this.pairingToken = undefined
    this.pairingExpiresAt = undefined
    const secure = connectionMode === 'tunnel' ? '; Secure' : ''
    response.setHeader(
      'set-cookie',
      `dsh_mobile=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${MOBILE_COOKIE_TTL_MS / 1000}`
    )
    this.log('info', `device paired mode=${connectionMode} addr=${remoteAddress} label=${uaLabel(request.headers['user-agent'])}`)
  }

  /** @returns {Promise<void>} */
  async stopCurrentTunnel() {
    if (!this.tunnelInstance) return
    this.tunnelExpectedStop = true
    try {
      await this.tunnelInstance.stop().catch(() => undefined)
    } finally {
      this.tunnelExpectedStop = false
      this.tunnelInstance = undefined
    }
  }

  clearTunnelDeathFlags() {
    this.unexpectedlyClosed = false
    this.lastTunnelProvider = undefined
  }

  /** @param {object | undefined} instance */
  armTunnelProcess(instance) {
    if (!instance) return
    // The only provider this build launches is Cloudflare, whose quick tunnels
    // carry no TTL; the Pinggy expiry branch returns with that provider.
    this.tunnelExpiresAt = undefined
    instance.process.once?.('close', () => {
      if (this.tunnelInstance !== instance) return
      if (this.tunnelExpectedStop) return
      this.handleUnexpectedTunnelClose(instance)
    })
  }

  /** @param {object} instance */
  handleUnexpectedTunnelClose(instance) {
    this.log('error', `tunnel closed unexpectedly provider=${instance.provider ?? '?'} url=${instance.url ?? '?'}`)
    this.lastTunnelProvider = instance.provider
    this.unexpectedlyClosed = true
    this.tunnelActive = false
    this.tunnelLoading = false
    this.tunnelExpiresAt = undefined
    this.tunnelInstance = undefined
    this.sessions.clear()
    this.syncConnected()
  }

  /**
   * @param {LanMobileBridgeSnapshot} snapshot
   * @param {string} [qrSvg]
   * @returns {Record<string, unknown>}
   */
  desktopTunnelPayload(snapshot, qrSvg) {
    return {
      active: snapshot.tunnelActive,
      loading: snapshot.tunnelLoading,
      url: snapshot.tunnelUrl,
      provider: snapshot.tunnelProvider ?? this.lastTunnelProvider,
      error: snapshot.tunnelError,
      pairingUrl: snapshot.pairingUrl,
      qrSvg,
      expiresAt: snapshot.expiresAt,
      unexpectedlyClosed: this.unexpectedlyClosed,
      tunnelExpiresAt: this.tunnelExpiresAt,
      connectedDevices: this.connectedDevices(),
      ...this.desktopPinFields()
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async handle(request, response) {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    )

    const transportAddress = normalizeRemoteAddress(request.socket.remoteAddress ?? '')
    if (!isPrivateAddress(transportAddress)) return this.text(response, 403, 'Private network only.')
    const connectionMode = this.requestConnectionMode(request, transportAddress)
    const forwardedAddress =
      firstHeaderValue(request.headers['cf-connecting-ip']) ??
      firstHeaderValue(request.headers['x-forwarded-for'])
    const remoteAddress =
      connectionMode === 'tunnel' && forwardedAddress
        ? normalizeRemoteAddress(forwardedAddress)
        : transportAddress
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname.startsWith('/brand-logo/')) {
      const variant = url.pathname === '/brand-logo/dark' ? 'dark' : 'light'
      const path = this.options.brandLogoPaths?.[variant]
      if (!path) return this.text(response, 404, 'Brand asset not found.')
      try {
        const body = await readFile(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=3600')
        response.end(body)
      } catch {
        this.text(response, 404, 'Brand asset not found.')
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/app-icon') {
      const path = this.options.appIconPath
      if (!path) return this.text(response, 404, 'App icon not found.')
      try {
        const body = await readFile(path)
        response.statusCode = 200
        response.setHeader('content-type', 'image/png')
        response.setHeader('cache-control', 'public, max-age=86400')
        response.end(body)
      } catch {
        this.text(response, 404, 'App icon not found.')
      }
      return
    }

    if (request.method === 'GET' && url.pathname === '/sw.js') {
      response.statusCode = 200
      response.setHeader('content-type', 'application/javascript; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(renderServiceWorker())
      return
    }

    if (request.method === 'GET' && url.pathname === '/desktop') {
      if (url.searchParams.has('k')) {
        this.consumeDesktopBootstrap(url.searchParams.get('k'), transportAddress, response)
        return
      }
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.verifyTrustedOrigin(request)
      if (!this.server || !this.port) return this.text(response, 503, 'Bridge unavailable.')
      // The token is consumed once a phone pairs, and expires after five
      // minutes. The desktop window stays open across both: rotate so it
      // keeps showing a scannable code instead of a dead one (or a 503).
      if (!this.pairingTokenValid()) {
        this.rotatePairingToken()
      }
      const snapshot = this.snapshot()
      const connected = this.sessions.size > 0
      if (!snapshot.pairingUrl && !connected) return this.text(response, 503, 'Bridge unavailable.')
      const qrSvg = snapshot.pairingUrl
        ? await QRCode.toString(snapshot.pairingUrl, { type: 'svg', margin: 1, width: 260 })
        : ''
      const pin = this.desktopPinFields()
      return this.html(
        response,
        renderDesktopPairingPage({
          qrSvg,
          pairingUrl: snapshot.pairingUrl ?? '',
          expiresAt: snapshot.expiresAt ?? this.now(),
          locale: this.locale(),
          connected,
          connectedDevices: this.connectedDevices(),
          tunnelActive: snapshot.tunnelActive,
          tunnelLoading: snapshot.tunnelLoading,
          tunnelProvider: snapshot.tunnelProvider ?? this.lastTunnelProvider,
          tunnelUrl: snapshot.tunnelUrl,
          tunnelError: snapshot.tunnelError,
          unexpectedlyClosed: this.unexpectedlyClosed,
          pairingPin: pin.pairingPin,
          pinConsent: pin.pinConsent,
          pinExpiresAt: pin.pinExpiresAt,
          tunnelExpiresAt: this.tunnelExpiresAt
        })
      )
    }

    if (request.method === 'GET' && url.pathname === '/desktop/status') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.sweepExpiredSessions()
      return this.json(response, 200, {
        connected: this.sessions.size > 0,
        connectedDevices: this.connectedDevices()
      })
    }

    if (request.method === 'GET' && url.pathname === '/desktop/tunnel/status') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      const snapshot = this.snapshot()
      const qrSvg = snapshot.pairingUrl
        ? await QRCode.toString(snapshot.pairingUrl, { type: 'svg', margin: 1, width: 260 })
        : undefined
      return this.json(response, 200, this.desktopTunnelPayload(snapshot, qrSvg))
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pin/consent') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.verifySameOrigin(request)
      let consent = false
      try {
        const parsed = JSON.parse(await readBody(request))
        consent = parsed.consent === true
      } catch {
        return this.json(response, 400, { ok: false, error: 'Invalid consent payload.' })
      }
      if (consent) {
        const pin = this.generatePairingPin()
        if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) {
          return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
        }
        this.ephemeralPin = undefined
        this.ephemeralPinExpiresAt = undefined
        this.clearPinFailures()
      } else {
        const previous = this.storedPinState()
        if (!this.options.pairingPinStore?.save({ pinConsent: false })) {
          return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
        }
        if (previous.pinConsent === true) this.revokeMobileSessions()
        this.ephemeralPin = undefined
        this.ephemeralPinExpiresAt = undefined
        this.ensurePairingPin()
      }
      const snapshot = this.snapshot()
      const qrSvg = snapshot.pairingUrl
        ? await QRCode.toString(snapshot.pairingUrl, { type: 'svg', margin: 1, width: 260 })
        : undefined
      return this.json(response, 200, {
        ok: true,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/pin/reset') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.verifySameOrigin(request)
      if (this.storedPinState().pinConsent !== true) {
        return this.json(response, 400, { ok: false, error: 'A durable pairing password is not enabled.' })
      }
      const pin = this.generatePairingPin()
      if (!this.options.pairingPinStore?.save({ pin, pinConsent: true })) {
        return this.json(response, 500, { ok: false, error: 'Unable to save the pairing password.' })
      }
      this.revokeMobileSessions()
      const snapshot = this.snapshot()
      const qrSvg = snapshot.pairingUrl
        ? await QRCode.toString(snapshot.pairingUrl, { type: 'svg', margin: 1, width: 260 })
        : undefined
      return this.json(response, 200, {
        ok: true,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/tunnel/toggle') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.verifySameOrigin(request)
      if (this.sessions.size > 0) {
        return this.json(response, 409, {
          ok: false,
          error: 'Disconnect the phone before switching connection modes.'
        })
      }
      let enable
      try {
        const bodyText = await readBody(request)
        if (bodyText) {
          const parsed = JSON.parse(bodyText)
          if (typeof parsed.enable === 'boolean') enable = parsed.enable
        }
      } catch {}
      // Report an in-progress switch honestly instead of answering with the
      // current (stale) snapshot the desktop UI cannot render.
      if (enable === true && this.tunnelLoading && !this.tunnelActive) {
        return this.json(response, 409, {
          ok: false,
          error: 'A tunnel switch is already in progress.'
        })
      }
      let snapshot
      try {
        snapshot = await this.toggleTunnel(enable)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('Disconnect the phone')) {
          return this.json(response, 409, { ok: false, error: message })
        }
        throw error
      }
      const qrSvg = snapshot.pairingUrl
        ? await QRCode.toString(snapshot.pairingUrl, { type: 'svg', margin: 1, width: 260 })
        : undefined
      return this.json(response, 200, {
        ok: !snapshot.tunnelError,
        ...this.desktopTunnelPayload(snapshot, qrSvg)
      })
    }

    if (request.method === 'POST' && url.pathname === '/desktop/disconnect') {
      if (this.rejectUnlessDesktop(request, transportAddress, response)) return
      this.verifySameOrigin(request)
      for (const [token, session] of this.sessions) {
        this.suspendedSessions.set(token, session)
        this.capDeviceMap(this.resumableSessions, token)
        this.resumableSessions.set(token, session)
      }
      this.sessions.clear()
      this.rotatePairingToken()
      this.syncConnected()
      return this.json(response, 200, { ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/disconnected') {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode)
      if (migrationUrl) return this.redirect(response, migrationUrl)
      return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode))
    }

    if (request.method === 'GET' && url.pathname === '/reconnect') {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode)
      if (migrationUrl) return this.redirect(response, migrationUrl)
      if (connectionMode === 'tunnel') {
        if (this.tunnelPinAcceptsReconnect()) {
          return this.html(response, renderPairingPinPage(this.locale(), this.iconDataUri))
        }
        return this.html(response, renderMobileReconnectPage(this.locale(), 'tunnel', { expired: true }))
      }
      // The phone that was just disconnected still holds its cookie. Restoring
      // that one session does not admit a neighbor who only knows the port.
      if (this.resumeSuspendedMobileSession(request) || this.mobileSessionActive(request)) {
        return this.redirect(response, '/')
      }
      this.options.onReconnectRequested?.()
      return this.html(response, renderMobileReconnectPage(this.locale(), 'lan', { resumeUnavailable: true }))
    }

    if (request.method === 'POST' && url.pathname === '/pair/retry') {
      this.verifySameOrigin(request)
      const migrationUrl = this.tunnelMigrationUrl(new URL('/reconnect', url), connectionMode)
      if (migrationUrl) return this.json(response, 200, { redirectUrl: migrationUrl })
      if (connectionMode === 'tunnel') {
        this.options.onReconnectRequested?.()
        return this.json(response, 200, { ok: true, pinRequired: true })
      }
      if (this.resumeSuspendedMobileSession(request) || this.mobileSessionActive(request)) {
        return this.json(response, 200, { ok: true, reconnected: true })
      }
      this.options.onReconnectRequested?.()
      return this.json(response, 200, { ok: true, rescan: true })
    }

    if (request.method === 'GET' && url.pathname === '/pair') {
      const migrationUrl = this.tunnelMigrationUrl(url, connectionMode)
      if (migrationUrl) return this.redirect(response, migrationUrl)
      if (this.authorized(request, remoteAddress, connectionMode)) {
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
      if (!this.validPairingToken(url.searchParams.get('token'))) {
        this.log('warn', `pair rejected: invalid or expired token addr=${remoteAddress} mode=${connectionMode}`)
        return this.text(response, 401, 'This pairing link is invalid or expired.')
      }
      if (connectionMode === 'lan') {
        this.issueSessionCookie(request, response, remoteAddress, 'lan')
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
      return this.html(response, renderPairingPinPage(this.locale(), this.iconDataUri))
    }

    if (request.method === 'POST' && url.pathname === '/pair/verify') {
      this.verifySameOrigin(request)
      if (connectionMode !== 'tunnel') {
        return this.json(response, 400, { ok: false, error: 'PIN verification is only used for internet pairing.' })
      }
      const retryAfter = this.pinRetryAfterSeconds(remoteAddress)
      if (retryAfter) {
        response.setHeader('retry-after', String(retryAfter))
        return this.json(response, 429, { ok: false, error: 'Too many attempts.', retryAfter })
      }
      let pin = ''
      try {
        const parsed = JSON.parse(await readBody(request))
        pin = typeof parsed.pin === 'string' ? parsed.pin.trim() : ''
      } catch {
        pin = ''
      }
      const view = this.readPairingPin()
      if (!view.pin || view.expired || !this.pinsEqual(pin, view.pin)) {
        if (view.expired || !view.pin) {
          this.log('warn', `pin verify rejected: pin expired or missing addr=${remoteAddress}`)
          return this.json(response, 401, { ok: false, error: 'expired', rescan: true })
        }
        this.recordPinFailure(remoteAddress)
        this.log('warn', `pin verify rejected: wrong pin addr=${remoteAddress}`)
        const limited = this.pinRetryAfterSeconds(remoteAddress)
        if (limited) {
          response.setHeader('retry-after', String(limited))
          return this.json(response, 429, { ok: false, error: 'Too many attempts.', retryAfter: limited })
        }
        return this.json(response, 401, { ok: false, error: 'Invalid pairing password.' })
      }
      this.clearPinFailures()
      this.issueSessionCookie(request, response, remoteAddress, 'tunnel')
      return this.json(response, 200, { ok: true })
    }

    if (!this.authorized(request, remoteAddress, connectionMode)) {
      this.rememberMobileContext(request, remoteAddress, connectionMode)
      if (!this.authorized(request, remoteAddress, connectionMode)) {
        if (request.method === 'GET' && url.pathname === '/') {
          const migrationUrl = this.tunnelMigrationUrl(url, connectionMode)
          if (migrationUrl) return this.redirect(response, migrationUrl)
          return this.html(response, renderMobileReconnectPage(this.locale(), connectionMode))
        }
        return this.text(response, 401, 'Pair your phone again.')
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return this.json(response, 200, await this.buildStatusPayload(request))
    }
    if (request.method === 'GET' && url.pathname === '/api/boot') {
      // The cold-open payload, and the exact bytes the handoff fetches as its
      // "syncing conversation" stage: the phone then opens the app document
      // (which no longer carries this payload) and paints from memory.
      try {
        const started = this.now()
        const payload = await this.buildMobileBoot()
        if (!payload) return this.json(response, 503, { ok: false, error: 'Boot unavailable.' })
        const bytes = Buffer.byteLength(JSON.stringify(payload))
        const bootMs = this.now() - started
        const diag = this._bootDiag ?? {}
        if (bootMs >= 300) this.log('info', `boot ${bootMs}ms list=${diag.listMs ?? -1}ms candidate=${diag.candidate ?? 'none'} events=${diag.events ?? 0} bytes=${bytes}${diag.reason ? ` reason=${diag.reason}` : ''}`)
        return this.json(response, 200, payload)
      } catch (error) {
        return this.json(response, 503, { ok: false, error: error?.message || 'Boot failed.' })
      }
    }
    if (request.method === 'GET' && (url.pathname === '/app.css' || url.pathname === '/app.js')) {
      const locale = url.searchParams.get('l') === 'en' ? 'en' : 'zh'
      const assets = this.mobileAssetBodies(locale)
      const isScript = url.pathname === '/app.js'
      const body = isScript ? assets.js : assets.css
      // Content-addressed by the hash in the URL the page used: the name changes
      // whenever this file does, so a long lifetime can never serve stale code.
      // The page still re-fetches with a fresh query when the copy it got back
      // was mangled — the phone has done that to a cached document before.
      response.statusCode = 200
      response.setHeader('content-type', isScript ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8')
      response.setHeader('cache-control', 'private, max-age=604800')
      response.end(body)
      return
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return this.renderMobilePage(request, response)
    }
    if (request.method === 'GET' && url.pathname === '/api/session/stream') {
      this.verifyTrustedOrigin(request)
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return this.text(response, 400, 'Session id is required.')
      // `sinceSeq` says how far the phone's own copy already reaches (the
      // handoff payload): the opening snapshot then only carries newer records.
      const sinceParam = url.searchParams.get('sinceSeq')
      const sinceSeq = sinceParam === null ? -1 : Number(sinceParam)
      return this.streamSession(request, response, sessionId, Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : -1)
    }
    if (request.method === 'POST' && url.pathname === '/api/rpc') {
      this.verifySameOrigin(request)
      /** @type {string} */
      let body
      try {
        body = await readBody(request)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'Request body is too large.') {
          return this.json(response, 413, { ok: false, error: 'Request body is too large.' })
        }
        throw error
      }
      let input
      try {
        input = JSON.parse(body)
      } catch {
        return this.json(response, 400, { ok: false, error: 'Malformed request body.' })
      }
      if (!isRecord(input)) {
        return this.json(response, 400, { ok: false, error: 'Malformed request body.' })
      }
      if (input.method === 'interaction.pending') {
        const sessionId = requiredStringField(input.payload, 'sessionId')
        const pending = [...this.pendingQuestions.values()].find(
          (item) => item.sessionId === sessionId
        )
        return this.json(response, 200, { ok: true, value: pending ?? null })
      }
      if (input.method === 'interaction.answer') {
        const answer = parseQuestionResponse(input.payload)
        const pending = this.assertPendingQuestion(answer.rpcId, answer.sessionId)
        validateQuestionAnswers(pending, answer.answers)
        const result = await this.respondToQuestion(answer.rpcId, {
          kind: 'result',
          value: { answers: answer.answers }
        })
        return this.json(response, result.ok ? 200 : 400, result)
      }
      if (input.method === 'interaction.cancel') {
        const rpcId = requiredStringField(input.payload, 'rpcId')
        const sessionId = requiredStringField(input.payload, 'sessionId')
        this.assertPendingQuestion(rpcId, sessionId)
        const result = await this.respondToQuestion(rpcId, {
          kind: 'rejected',
          error: {
            name: 'Error',
            message: 'the user closed this question request',
            code: 'cancelled'
          }
        })
        return this.json(response, result.ok ? 200 : 400, result)
      }
      if (typeof input.method !== 'string' || !RPC_ALLOWLIST.has(input.method)) {
        return this.json(response, 403, { ok: false, error: 'RPC method is not available on mobile.' })
      }
      const result = await this.forwardRpc(input.method, input.payload ?? {})
      return this.json(response, result.ok ? 200 : 400, result)
    }
    this.text(response, 404, 'Not found.')
  }

  /** @returns {'en' | 'zh'} */
  locale() {
    const value = this.options.locale
    return typeof value === 'function' ? value() : value ?? 'en'
  }

  /**
   * @param {string | null} candidate
   * @returns {boolean}
   */
  validPairingToken(candidate) {
    if (!candidate || !this.pairingToken || !this.pairingExpiresAt) return false
    if (this.now() > this.pairingExpiresAt) return false
    const left = Buffer.from(candidate)
    const right = Buffer.from(this.pairingToken)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   * @returns {boolean}
   */
  authorized(request, remoteAddress, connectionMode) {
    const token = this.mobileToken(request)
    if (token) {
      const record = this.sessions.get(token)
      if (record !== undefined) {
        if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
          this.sessions.delete(token)
        } else {
          return true
        }
      }
    }
    if (connectionMode === 'tunnel') return false
    return [...this.sessions.values()].some((session) => session.remoteAddress === remoteAddress)
  }

  /**
   * Lazy cleanup of aged-out mobile sessions. Invoked where sessions are
   * issued and where status is read, so expired records neither authorize
   * requests nor appear as connected devices.
   * @returns {void}
   */
  sweepExpiredSessions() {
    const now = this.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) this.sessions.delete(token)
    }
  }

  /**
   * Evict the oldest entry of a device-state map before inserting a new token,
   * mirroring the suspendedSessions cap so sessions/resumableSessions never
   * grow past 16 either.
   * @param {Map<string, MobileSession>} map
   * @param {string} incomingToken
   * @returns {void}
   */
  capDeviceMap(map, incomingToken) {
    if (!map.has(incomingToken) && map.size >= 16) {
      const oldest = map.keys().next().value
      if (oldest) map.delete(oldest)
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {string | undefined}
   */
  mobileToken(request) {
    return this.cookieValue(request, 'dsh_mobile')
  }

  /**
   * Restores one session the desktop disconnect suspended. Cookies that
   * `rememberMobileContext` recorded from an anonymous request are not eligible,
   * so a neighbor cannot mint a cookie and reconnect.
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  resumeSuspendedMobileSession(request) {
    const token = this.mobileToken(request)
    if (!token) return false
    const session = this.resumableSessions.get(token)
    if (!session) return false
    this.resumableSessions.delete(token)
    this.suspendedSessions.delete(token)
    this.capDeviceMap(this.sessions, token)
    this.sessions.set(token, session)
    return true
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  mobileSessionActive(request) {
    const token = this.mobileToken(request)
    return Boolean(token && this.sessions.has(token))
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} remoteAddress
   * @param {MobileConnectionMode} connectionMode
   */
  rememberMobileContext(request, remoteAddress, connectionMode) {
    if (connectionMode === 'tunnel') return
    const token = this.mobileToken(request)
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const sameDeviceIsActive = [...this.sessions.values()].some(
      (session) => session.remoteAddress === remoteAddress
    )
    if (sameDeviceIsActive) {
      const session = { token, remoteAddress }
      this.stampSession(session, request)
      this.capDeviceMap(this.sessions, token)
      this.sessions.set(token, session)
      this.suspendedSessions.delete(token)
      this.resumableSessions.delete(token)
      return
    }
    if (!this.suspendedSessions.has(token) && this.suspendedSessions.size >= 16) {
      const oldest = this.suspendedSessions.keys().next().value
      if (oldest) this.suspendedSessions.delete(oldest)
    }
    this.suspendedSessions.set(token, { token, remoteAddress })
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} transportAddress
   * @param {import('node:http').ServerResponse} response
   * @returns {boolean}
   */
  rejectUnlessDesktop(request, transportAddress, response) {
    if (isLoopbackAddress(transportAddress) && this.hasDesktopSession(request)) return false
    this.text(response, 403, 'Desktop only.')
    return true
  }

  /**
   * @param {string | null} candidate
   * @param {string} transportAddress
   * @param {import('node:http').ServerResponse} response
   * @returns {boolean}
   */
  consumeDesktopBootstrap(candidate, transportAddress, response) {
    const expected = this.desktopBootstrapToken
    if (
      !isLoopbackAddress(transportAddress) ||
      !candidate ||
      !expected ||
      this.desktopBootstrapExpiresAt === undefined ||
      this.desktopBootstrapExpiresAt <= this.now() ||
      !this.pinsEqual(candidate, expected)
    ) {
      this.text(response, 403, 'Desktop only.')
      return false
    }
    this.desktopBootstrapToken = undefined
    this.desktopBootstrapExpiresAt = undefined
    response.setHeader(
      'set-cookie',
      `dsh_desktop=${this.desktopSessionToken}; HttpOnly; SameSite=Strict; Path=/`
    )
    response.statusCode = 303
    response.setHeader('location', '/desktop')
    response.end()
    return true
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @returns {boolean}
   */
  hasDesktopSession(request) {
    const token = this.cookieValue(request, 'dsh_desktop')
    return Boolean(token && this.pinsEqual(token, this.desktopSessionToken))
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} name
   * @returns {string | undefined}
   */
  cookieValue(request, name) {
    const cookie = request.headers.cookie ?? ''
    return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1]
  }

  /** @param {import('node:http').IncomingMessage} request */
  verifySameOrigin(request) {
    this.verifyTrustedOrigin(request)
  }

  /**
   * Rejects browser-driven cross-site requests (CSRF / drive-by) against the
   * loopback-only desktop surface. The pairing window's own navigations and
   * same-origin fetches pass; requests without Fetch Metadata and Origin
   * headers (local tooling, tests) pass as well.
   * @param {import('node:http').IncomingMessage} request
   */
  verifyTrustedOrigin(request) {
    const site = firstHeaderValue(request.headers['sec-fetch-site'])
    if (site && site !== 'same-origin' && site !== 'none') {
      throw new Error('Cross-site request rejected.')
    }
    const origin = request.headers.origin
    const host = request.headers.host
    if (origin && host && new URL(origin).host !== host) throw new Error('Cross-origin request rejected.')
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {string} transportAddress
   * @returns {MobileConnectionMode}
   */
  requestConnectionMode(request, transportAddress) {
    if (!isLoopbackAddress(transportAddress)) return 'lan'
    const host = (request.headers.host ?? '').split(':', 1)[0]?.toLowerCase() ?? ''
    const forwardedAddress = firstHeaderValue(request.headers['cf-connecting-ip'])
    const ray = firstHeaderValue(request.headers['cf-ray'])
    return isInternetTunnelHost(host) || Boolean(forwardedAddress && ray)
      ? 'tunnel'
      : 'lan'
  }

  /**
   * @param {URL} url
   * @param {MobileConnectionMode} connectionMode
   * @returns {string | undefined}
   */
  tunnelMigrationUrl(url, connectionMode) {
    if (connectionMode === 'tunnel' || !this.tunnelActive || !this.tunnelInstance?.url) return undefined
    return new URL(`${url.pathname}${url.search}`, this.tunnelInstance.url).toString()
  }

  /**
   * Call the Host with the process session cookie, re-requesting the
   * credential once and retrying once if the stored cookie stopped being accepted.
   * @param {URL} url
   * @param {RequestInit} init
   * @returns {Promise<Response>}
   */
  async harnessFetch(url, init) {
    const send = async (cookie) => fetch(url, {
      ...init,
      headers: { ...init.headers, ...(cookie === undefined ? {} : { cookie }) }
    })
    let response = await send(await this.options.innerAuth.ready())
    if (response.status === 401) {
      this.options.innerAuth.invalidate()
      this.cycleMux()
      const retry = await this.options.innerAuth.ready()
      if (retry !== undefined) response = await send(retry)
    }
    return response
  }

  /**
   * Close the live mux socket after the harness credential was invalidated so
   * it cannot keep carrying the dead cookie. Aborting the monitor also ends
   * its loop; once the task settles, syncConnected re-arms it (when a phone is
   * still paired) and the new socket opens with the fresh cookie.
   * @returns {void}
   */
  cycleMux() {
    const task = this.muxTask
    this.muxAbort?.abort()
    if (task === undefined) return
    task.finally(() => {
      if (this.server !== undefined) this.syncConnected()
    }).catch(() => undefined)
  }

  /**
   * Translate one mobile method onto its Host endpoint and drive it.
   *
   * `session.history` is the one call the page cannot express directly: the
   * Host replaced open-ended history reads with a cursor-bounded page, and
   * refuses a `throughSeq` past the session's own cursor. The cursor lives on
   * the session list row, so the read is two calls here rather than a
   * protocol the page has to learn.
   * @param {string} method
   * @param {unknown} payload
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  /**
   * Shared, short-TTL cache of the Host session catalogue. Both `session.list`
   * and the history cursor lookup read one number from this same full list, so
   * polling history must not re-download the whole catalogue each time. A
   * missing cursor forces one refresh so freshly created sessions still load.
   *
   * @param {boolean} [force]
   * @returns {Promise<{ ok: boolean, value?: any, error?: string }>}
   */
  /**
   * The phone's static shell (CSS + the app script) with content hashes.
   *
   * @param {string} locale
   */
  mobileAssetBodies(locale) {
    if (!this._mobileAssets) this._mobileAssets = new Map()
    const cached = this._mobileAssets.get(locale)
    if (cached) return cached
    const blocks = mobilePageAssets({ locale })
    const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12)
    const assets = {
      css: blocks.css,
      js: blocks.js,
      urls: {
        cssUrl: `/app.css?h=${digest(blocks.css)}`,
        jsUrl: `/app.js?l=${locale}&h=${digest(blocks.js)}`
      }
    }
    this._mobileAssets.set(locale, assets)
    return assets
  }

  async renderMobilePage(request, response) {
    // Piggyback the startup data onto the HTML response. Both reads stay on the
    // desktop loopback (fast); folding them in removes one whole tunnel round
    // trip before the phone can choose and open its focus session.
    let boot = null
    let payload = null
    // When the phone is going to open a session, render the initial HTML in the
    // chat view (with the message skeleton) instead of the workspace list. The
    // phone then paints the conversation page from the first byte — no list
    // flash while the document streams over the tunnel, no visible view switch.
    // This must NOT depend on the inline history read succeeding: tying it to
    // `payload.focus` alone made the landing fall back to the workspace list
    // whenever that read failed (observed live 2026-10-01), which reintroduced
    // the list → chat → content sequence the PIN prewarm exists to remove.
    // Default to the chat view even when the boot payload is unavailable (a
    // transient startup race): the page's own startup path switches to the
    // session list when there is genuinely nothing to open.
    let initialChat = true
    try {
      payload = await this.buildMobileBoot({ history: false })
      if (payload) {
        boot = JSON.stringify(payload)
        initialChat = !!(payload.focus && payload.focus.sessionId) || !!this.pickFocusItem(payload.sess?.items)
      }
    } catch (error) {
      this.log('warn', `mobile boot data unavailable: ${error?.message || error}`)
    }
    const html = renderMobilePage({ locale: this.locale(), boot, icon: this.iconDataUri, initialChat, assets: this.mobileAssetBodies(this.locale()).urls })
    const diag = payload ? (this._bootDiag ?? {}) : {}
    this.log('info', `doc url=${String(request.url || '/')} initialChat=${initialChat} bytes=${Buffer.byteLength(html)} boot=${diag.bootMs ?? -1}ms candidate=${diag.candidate ?? 'none'} baseline=${diag.reason ?? 'none'}`)
    // Never cacheable, and never compressed at the origin. 2026-10-01 cost two
    // broken rounds: a `max-age` window made the phone render a mangled copy the
    // browser replayed for the landing navigation, and origin gzip made it render
    // compressed bytes as text. Both dials stay off; the conversation payload now
    // travels through /api/boot and the tab's own memory instead.
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-pocket-cache', 'app')
    return this.html(response, html)
  }

  // Build the cold-open payload: workspace snapshot, session list, desktop
  // settings and the focus session's last turn. Shared by the embedded HTML
  // boot and /api/boot, which lets a service-worker-cached shell reconcile in
  // the background without waiting for a full page download over the tunnel.
  async buildMobileBoot(options = {}) {
    const withHistory = options.history !== false
    const t0 = this.now()
    const [wsResult, sessResult, settingsResult] = await Promise.all([
      Promise.resolve(isWorkspaceSnapshot(this.workspaceSnapshot)
        ? { ok: true, value: this.workspaceSnapshot }
        : { ok: false }),
      this.cachedSessionList(false),
      this.cachedSettings(false).catch(() => ({ ok: false }))
    ])
    const listMs = this.now() - t0
    if (!wsResult.ok || !sessResult.ok) return null
    const awaiting = new Set(
      [...this.pendingQuestions.values()]
        .map((item) => item.sessionId)
        .filter((sessionId) => typeof sessionId === 'string')
    )
    const rawItems = Array.isArray(sessResult.value?.items)
      ? sessResult.value.items
      : []
    const sess = {
      ...sessResult.value,
      items: rawItems.map((item) => ({
        ...item,
        awaitingQuestion: awaiting.has(item.sessionId)
      }))
    }
    const settings = settingsResult.ok ? extractMobileSettings(settingsResult.value) : null
    // The focus session's last turn (latest user question + answer). `history:
    // false` keeps it out of the app document — the document is then ~2.5x
    // smaller and the handoff fetches this payload separately, so the phone
    // still paints the conversation on the first frame without any cache or
    // service worker in the path.
    const focusItem = this.pickFocusItem(sess.items)
    let focus = null
    this._focusBootReason = ''
    if (focusItem && !withHistory) {
      this._bootDiag = {
        bootMs: this.now() - t0,
        listMs,
        focusMs: 0,
        candidate: focusItem.sessionId ?? 'none',
        events: 0,
        reason: 'history-deferred'
      }
    } else if (focusItem) {
      const tf = this.now()
      focus = await this.focusBootHistory(focusItem).catch(() => null)
      const focusMs = this.now() - tf
      this._bootDiag = {
        bootMs: this.now() - t0,
        listMs,
        focusMs,
        candidate: focusItem.sessionId ?? 'none',
        events: focus?.history?.events?.length ?? 0,
        reason: focus ? '' : (this._focusBootReason || 'no-history')
      }
    } else {
      this._bootDiag = { bootMs: this.now() - t0, listMs, focusMs: 0, candidate: 'none', events: 0, reason: 'no-candidate' }
    }
    return {
      ws: wsResult.value,
      sess,
      settings,
      ...(focus ? { focus } : {})
    }
  }

  // Mirror of the phone page's pickFocusSession(): the session the cold-open
  // page jumps into. Must stay in sync with pages.js so the embedded history is
  // for the session the UI actually opens.
  pickFocusItem(items) {
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item && !item.missingSummary && !item.blank)
    if (!list.length) return null
    if (list.length === 1) return list[0]
    const awaiting = list.filter((item) => item.awaitingQuestion)
    if (awaiting.length) {
      awaiting.sort((a, b) => b.updatedAt - a.updatedAt)
      return awaiting[0]
    }
    const running = list.filter((item) => item.running)
    if (running.length) {
      running.sort((a, b) => b.updatedAt - a.updatedAt)
      return running[0]
    }
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  // Fetch the focus session's last turn for inline boot. turnWindow aligns the
  // page to the latest turn boundary, so the payload is one question + answer.
  async focusBootHistory(item) {
    const sessionId = item.sessionId
    if (typeof sessionId !== 'string') {
      this._focusBootReason = 'no-session-id'
      return null
    }
    // `turnWindow` aligns the page to the latest turn boundary; `throughSeq`
    // pins it to the sequence the list was built from. Both are optimisations:
    // the first attempt that yields records wins, and later attempts drop the
    // bound / the window so a stale or not-yet-indexed projection can never
    // silence the embedded history (root cause of the 2026-10-01 regression
    // where the phone landed on the workspace list again).
    const throughSeq = item.projections?.asOfSeq
    const attempts = []
    if (typeof throughSeq === 'number') attempts.push({ throughSeq, maxMessages: 40, turnWindow: { minMessages: 1, minTurns: 1 } })
    attempts.push({ maxMessages: 40, turnWindow: { minMessages: 1, minTurns: 1 } })
    attempts.push({ maxMessages: 40 })
    let reason = 'no-attempt'
    for (const bound of attempts) {
      try {
        const page = await this.invokeHarness('session/page', {
          request: { address: { kind: 'session', sessionId }, ...bound }
        })
        if (!page?.ok) {
          reason = `page-failed:${(page?.error && (page.error.message || page.error)) || 'unknown'}`
          continue
        }
        const records = page.value?.records
        if (!Array.isArray(records)) {
          reason = 'records-missing'
          continue
        }
        if (!records.length) {
          reason = 'records-empty'
          continue
        }
        this._focusBootReason = ''
        const events = compactSessionRecords(records)
        this.noteRecordSavings(records, events)
        return {
          sessionId,
          history: {
            events,
            projections: item.projections ?? null,
            hasMore: page.value.hasMore === true
          }
        }
      } catch (error) {
        reason = `throw:${error?.message || error}`
      }
    }
    this._focusBootReason = reason
    return null
  }

  async cachedSessionList(force = false) {
    const now = Date.now()
    const cache = this._sessionListCache
    if (!force && cache && now - cache.at < 1500) return cache.promise
    const promise = this.invokeHarness('session/list', { _request: {} })
    this._sessionListCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  // Settings change rarely; a longer TTL keeps the page's manual-refresh /
  // resume path from paying for settings on every pass while still picking up a
  // desktop-side change within a few seconds.
  async cachedSettings(force = false) {
    const now = Date.now()
    const cache = this._settingsCache
    if (!force && cache && now - cache.at < 5000) return cache.promise
    const promise = this.invokeHarness('settings/describe', {})
    this._settingsCache = { at: now, promise }
    promise.catch(() => {})
    return promise
  }

  async forwardRpc(method, payload) {
    const fields = typeof payload === 'object' && payload !== null
      ? payload
      : {}

    if (method === 'workspace.list') {
      // The Host kept no unary workspace read: `workspace/follow` is a stream,
      // and its opening `baseline` frame is exactly the projection this call
      // used to return. The mux consumer keeps that baseline, so the answer is
      // whatever the carrier last observed.
      const snapshot = this.workspaceSnapshot
      if (!isWorkspaceSnapshot(snapshot)) return { ok: false, error: 'Harness workspaces are not loaded yet.' }
      return { ok: true, value: snapshot }
    }

    if (method === 'session.history') {
      const sessionId = fields.sessionId
      // The Host's backwards-page cursor (throughSeq) only has to be a valid log
      // offset at or after the page we request. Once learned for a session it
      // stays valid for every older page, so cache it: pull-older never has to
      // re-download the global session list. The first open / RPC fallback still
      // resolves it from the list exactly once.
      let throughSeq = this._sessionCursors?.get(sessionId)
      let projections = null
      if (typeof throughSeq !== 'number' || typeof fields.beforeSeq !== 'number') {
        let listed = await this.cachedSessionList(false)
        if (!listed.ok) return listed
        let items = listed.value?.items ?? []
        let row = items.find((item) => item.sessionId === sessionId)
        // A fresh session may not be in the 1.5s-old cache yet: force one
        // refresh before giving up, rather than failing to open it.
        if (!row) {
          listed = await this.cachedSessionList(true)
          if (!listed.ok) return listed
          items = listed.value?.items ?? []
          row = items.find((item) => item.sessionId === sessionId)
        }
        projections = row?.projections
        throughSeq = projections?.asOfSeq
        if (typeof throughSeq !== 'number') return { ok: false, error: 'Harness has no cursor for this session.' }
        if (!this._sessionCursors) this._sessionCursors = new Map()
        this._sessionCursors.set(sessionId, throughSeq)
      }
      /** @type {Record<string, unknown>} */
      const baseRequest = { address: { kind: 'session', sessionId }, throughSeq }
      const maxMessages = typeof fields.maxMessages === 'number' ? fields.maxMessages : 30
      // One request shape per attempt, best first. 2026-10-01: the aligned
      // last-turn window can come back empty, and the phone then replaced the
      // conversation it had already painted with that empty page (blank chat).
      // An empty answer is therefore only accepted when no other shape has
      // records either.
      const pageRequests = []
      if (typeof fields.beforeSeq === 'number') {
        // Pull-older: beforeSeq is the Host's exclusive backwards-page cursor,
        // and an empty page there is a real end-of-history.
        pageRequests.push({ ...baseRequest, maxMessages, turnWindow: { minMessages: 1, minTurns: 1 }, beforeSeq: fields.beforeSeq })
      } else {
        pageRequests.push({ ...baseRequest, maxMessages, turnWindow: { minMessages: 1, minTurns: 1 } })
        pageRequests.push({ ...baseRequest, maxMessages })
        pageRequests.push({ ...baseRequest, maxMessages: Math.max(maxMessages, 60) })
      }
      let value = null
      let failure = null
      for (const pageRequest of pageRequests) {
        const page = await this.invokeHarness('session/page', { request: pageRequest })
        if (!page.ok) {
          failure = page
          continue
        }
        const candidate = page.value
        if (!Array.isArray(candidate?.records)) {
          failure = { ok: false, error: 'Harness returned invalid session history.' }
          continue
        }
        if (!value) value = candidate
        if (candidate.records.length) {
          value = candidate
          break
        }
      }
      if (!value) return failure ?? { ok: false, error: 'Harness returned invalid session history.' }
      // Harness 0.1.2 calls the durable entries `records` and serves
      // projections on the list row. Keep the stable mobile-page contract so
      // cached pages can still render messages, running state, and todos.
      const events = compactSessionRecords(value.records)
      this.noteRecordSavings(value.records, events)
      return {
        ok: true,
        value: {
          events,
          projections,
          hasMore: value.hasMore === true
        }
      }
    }

    if (method === 'session.list') {
      const result = await this.cachedSessionList(false)
      if (!result.ok) return result
      const awaiting = new Set(
        [...this.pendingQuestions.values()]
          .map((item) => item.sessionId)
          .filter((sessionId) => typeof sessionId === 'string')
      )
      const items = Array.isArray(result.value?.items)
        ? result.value.items.map((item) => ({
            ...item,
            awaitingQuestion: awaiting.has(item.sessionId)
          }))
        : result.value?.items
      return { ok: true, value: { ...result.value, items } }
    }

    const route = HARNESS_ENDPOINTS[method]
    if (route === undefined) return { ok: false, error: 'RPC method is not available on mobile.' }
    return this.invokeHarness(route.endpoint, route.args(fields))
  }

  /**
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async invokeHarness(endpoint, args) {
    const base = this.options.harnessUrl()
    if (!base) return { ok: false, error: 'Harness is not ready.' }
    const rpcId = randomUUID()
    const response = await this.harnessFetch(new URL(`/api/${endpoint}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) return { ok: false, error: `Harness transport returned HTTP ${response.status}.` }
    const envelope = await response.json()
    if (envelope.rpcId !== rpcId) return { ok: false, error: 'Harness RPC response did not match the request.' }
    if (envelope.result?.ok !== true) {
      const message = envelope.result?.error?.message
      return { ok: false, error: typeof message === 'string' ? message : 'Harness rejected the request.' }
    }
    return { ok: true, value: envelope.result.value }
  }

  /**
   * Reconciles everything that depends on a phone being attached. The mux
   * downlink exists purely to track questions raised for a mobile client, so
   * running it with no client meant reconnecting twice a second, forever, on
   * every desktop that never used the feature.
   */
  syncConnected() {
    const connected = this.sessions.size > 0
    if (connected) this.startMuxMonitor()
    else this.muxAbort?.abort()
    if (connected === this.lastConnected) return
    this.lastConnected = connected
    // Reconciliation runs off the request path, so a throwing observer must not
    // turn into an unhandled rejection that fails the request behind it.
    try {
      this.options.onConnectedChange?.(connected)
    } catch {
      // A renderer that went away mid-broadcast is not the bridge's problem.
    }
  }

  startMuxMonitor() {
    if (this.muxTask) return
    const abort = new AbortController()
    this.muxAbort = abort
    this.muxTask = this.monitorMux(abort.signal).finally(() => {
      if (this.muxAbort === abort) {
        this.muxAbort = undefined
        this.muxTask = undefined
      }
    })
  }

  /** @param {AbortSignal} signal @returns {Promise<void>} */
  async monitorMux(signal) {
    let lastBase
    // A Harness that never accepts the downlink used to be retried at a flat
    // 500ms for as long as the app ran. Backing off turns a permanent failure
    // into two attempts a minute instead of a hundred.
    let backoffMs = MUX_RECONNECT_MS
    const backOff = async () => {
      await waitFor(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, MUX_RECONNECT_CAP_MS)
    }

    while (!signal.aborted) {
      const base = this.options.harnessUrl()
      if (!base) {
        this.pendingQuestions.clear()
        await backOff()
        continue
      }
      if (base !== lastBase) {
        this.pendingQuestions.clear()
        lastBase = base
        backoffMs = MUX_RECONNECT_MS
      }
      let openedAt
      try {
        await this.consumeMux(base, signal, () => {
          openedAt = this.now()
        })
        backoffMs = MUX_RECONNECT_MS
      } catch (error) {
        if (signal.aborted) return
        this.log('warn', `mux downlink lost${error instanceof Error ? `: ${error.message}` : ''}`)
        this.pendingQuestions.clear()
        // A connection that held for a while and then dropped is a transient
        // fault, not a Harness that refuses the downlink: retry promptly.
        if (openedAt !== undefined && this.now() - openedAt >= MUX_STABLE_MS) {
          backoffMs = MUX_RECONNECT_MS
        }
        await backOff()
      }
    }
  }

  /**
   * @param {string} base
   * @param {AbortSignal} signal
   * @param {() => void} [onOpen]
   * @returns {Promise<void>}
   */
  async consumeMux(base, signal, onOpen) {
    // 0.1.2-alpha.1 replaced the event mux with the Gateway stream carrier:
    // one WebSocket multiplexing logical streams, each opened by name. The
    // forwarded-event stream is `$events`, and the upgrade itself is
    // authenticated, so it carries the same session cookie as the unary calls.
    const url = new URL(REMOTE_STREAM_MUX_PATH, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const cookie = await this.options.innerAuth.ready()
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: cookie === undefined ? {} : { cookie }
      })
      // `ws` raises 'error' asynchronously when close() aborts a still-CONNECTING
      // socket ("WebSocket was closed before the connection was established") —
      // exactly what finish() below does to unwind on abort. cleanup() has
      // already removed the real handleError listener by the time that fires,
      // so without a permanent sink here that self-inflicted error becomes an
      // unhandled 'error' event and crashes the process.
      socket.addEventListener('error', () => {})
      let settled = false
      const cleanup = () => {
        signal.removeEventListener('abort', handleAbort)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('close', handleClose)
        socket.removeEventListener('error', handleError)
      }
      const finish = (error) => {
        if (settled) return
        settled = true
        cleanup()
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close()
        }
        if (error) reject(error)
        else resolve()
      }
      const handleAbort = () => finish()
      const handleOpen = () => {
        onOpen?.()
        this.pendingQuestions.clear()
        this.eventClientId = undefined
        // Two logical streams share this carrier: the forwarded events that
        // raise questions, and the workspace projection whose opening
        // `baseline` frame is the list the Host no longer serves unary.
        socket.send(JSON.stringify({
          type: 'open',
          streamId: EVENT_STREAM_ID,
          endpoint: REMOTE_EVENT_STREAM_ENDPOINT,
          payload: { args: {} }
        }))
        socket.send(JSON.stringify({
          type: 'open',
          streamId: WORKSPACE_STREAM_ID,
          endpoint: 'workspace/follow',
          payload: { args: {} }
        }))
      }
      const handleMessage = (event) => {
        const data = event.data
        if (typeof data === 'string') this.consumeMuxEnvelope(data)
        else if (Buffer.isBuffer(data)) this.consumeMuxEnvelope(data.toString('utf8'))
      }
      const handleClose = () => {
        finish(signal.aborted ? undefined : new Error('Harness mux WebSocket closed.'))
      }
      const handleError = () => finish(new Error('Harness mux WebSocket failed.'))
      socket.addEventListener('open', handleOpen)
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('close', handleClose, { once: true })
      socket.addEventListener('error', handleError, { once: true })
      signal.addEventListener('abort', handleAbort, { once: true })
      if (signal.aborted) handleAbort()
    })
  }

  /** Forward one native Harness session/follow stream to an authenticated phone as SSE. */
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  /**
   * Everything the phone used to learn from a 1.5s `/api/status` poll. It is now
   * also pushed down the session stream as a `status` frame, so a phone with a
   * live stream pays for zero reachability round trips.
   *
   * @param {import('node:http').IncomingMessage} request
   */
  async buildStatusPayload(request) {
    const body = {
      connected: true,
      tunnelProvider: this.tunnelInstance?.provider,
      tunnelExpiresAt: this.tunnelExpiresAt
    }
    // The session behind the caller's cookie exposes its own expiry.
    const token = this.mobileToken(request)
    const session = token ? this.sessions.get(token) : undefined
    if (session) {
      body.issuedAt = session.issuedAt
      body.expiresAt = session.expiresAt
    }
    // Piggyback live desktop settings so the phone tracks changes without a
    // separate poll; cachedSettings caps the harness round trips.
    try {
      const settingsResult = await this.cachedSettings(false)
      if (settingsResult.ok) body.settings = extractMobileSettings(settingsResult.value)
    } catch {
      body.settings = null
    }
    return body
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} sessionId
   * @param {number} sinceSeq  Records at or below this sequence are already on
   *   the phone (it arrived through the handoff payload), so the opening
   *   snapshot only carries what is new. -1 sends everything.
   */
  async streamSession(request, response, sessionId, sinceSeq = -1) {
    const base = this.options.harnessUrl()
    if (!base) return this.text(response, 503, 'Harness is not ready.')
    const cookie = await this.options.innerAuth.ready()
    const url = new URL(REMOTE_STREAM_MUX_PATH, base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const streamId = `mobile-session-${randomUUID()}`
    const abort = new AbortController()
    this.sessionStreamAborts.add(abort)

    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders()
    response.write('retry: 500\n\n')

    await new Promise((resolve) => {
      // SSE keepalive: a comment frame every 15s keeps proxies from idling the
      // response out. Cleared in cleanup() on abort/close.
      const keepAlive = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(': ping\n\n')
      }, SSE_KEEPALIVE_MS)
      // Connection state rides the stream the phone already holds open, so the
      // client can stop polling /api/status while its stream is healthy. Both
      // timers are unref'd: a test or a shutdown must never be held open by a
      // stream's housekeeping.
      keepAlive.unref?.()
      const statusFrames = setInterval(() => {
        if (response.destroyed || response.writableEnded) return
        this.buildStatusPayload(request).then((body) => {
          if (!response.destroyed && !response.writableEnded) response.write(`event: status\ndata: ${JSON.stringify(body)}\n\n`)
        }).catch(() => {})
      }, SSE_STATUS_MS)
      statusFrames.unref?.()
      const socket = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } })
      // `ws` raises 'error' asynchronously when close() aborts a still-CONNECTING
      // socket ("WebSocket was closed before the connection was established") —
      // exactly what finish() below does to unwind on abort. cleanup() has
      // already removed the real handleError listener by the time that fires,
      // so without a permanent sink here that self-inflicted error becomes an
      // unhandled 'error' event and crashes the process. consumeMux guards the
      // same close pattern with the identical sink; keep the two in lockstep.
      socket.addEventListener('error', () => {})
      let settled = false
      const cleanup = () => {
        clearInterval(keepAlive)
        clearInterval(statusFrames)
        request.removeListener('close', finish)
        abort.signal.removeEventListener('abort', finish)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('close', handleClose)
        socket.removeEventListener('error', handleError)
        this.sessionStreamAborts.delete(abort)
      }
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
        if (!response.writableEnded) response.end()
        resolve()
      }
      const handleOpen = () => {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: { address: { kind: 'session', sessionId }, maxMessages: 30, turnWindow: { minMessages: 1, minTurns: 1 }, assistantStream: true }
            }
          }
        }))
      }
      const handleMessage = (event) => {
        const text = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
        if (!text) return
        let frame
        try { frame = JSON.parse(text) } catch { return }
        if (!isRecord(frame) || frame.streamId !== streamId) return
        if (frame.type === 'item') {
          const value = frame.value
          if (isRecord(value) && value.type === 'assistant-stream') {
            // Token-level streaming channel. The host still emits the durable
            // committed event after the stream ends, so no replay is invented.
            response.write(`event: token\ndata: ${JSON.stringify(value.frame)}\n\n`)
          } else {
            const eventName = isRecord(value) && value.type === 'snapshot' ? 'snapshot' : 'event'
            const payload = stripRecordsThrough(compactSessionFrame(value), sinceSeq)
            // A fully-superseded frame is dropped, except the snapshot itself:
            // the phone must still learn that its stream is live.
            if (payload !== null) response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
          }
        } else if (frame.type === 'error' || frame.type === 'end') {
          finish()
        }
      }
      const handleClose = () => finish()
      const handleError = () => finish()
      request.once('close', finish)
      abort.signal.addEventListener('abort', finish, { once: true })
      socket.addEventListener('open', handleOpen)
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('close', handleClose, { once: true })
      socket.addEventListener('error', handleError, { once: true })
      if (abort.signal.aborted) finish()
    })
  }

  /**
   * Consume one carrier frame.
   *
   * Every logical stream shares this socket, so a frame is routed by its
   * `streamId` first. The event stream replaces the old `server-request`
   * envelopes: a question now arrives as a `waterfall` frame carrying its own
   * `eventId`, which is also the id the phone answers with, and the opening
   * `ready` frame names the generation every answer has to quote.
   * @param {string} data
   */
  consumeMuxEnvelope(data) {
    let frame
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(frame) || frame.type !== 'item') return
    const value = frame.value
    if (frame.streamId === WORKSPACE_STREAM_ID) {
      // The phone filters its session list by this snapshot. A session created
      // after connect arrives as an increment, so keeping only the opening
      // baseline hides it until the follow stream reconnects.
      if (isRecord(value)) this.workspaceSnapshot = applyWorkspaceFollowFrame(this.workspaceSnapshot, value)
      return
    }
    if (frame.streamId !== EVENT_STREAM_ID || !isRecord(value)) return
    if (value.type === 'ready' && typeof value.clientId === 'string') {
      this.eventClientId = value.clientId
      return
    }
    if (value.type === 'waterfall' && value.event === USER_QUESTION_EVENT) {
      const eventId = typeof value.eventId === 'string' ? value.eventId : undefined
      const request = isRecord(value.request) ? value.request : undefined
      // The Agent identity travels on the frame, not in the request: the
      // gateway strips the live Agent and the cancellation signal before the
      // request crosses the wire. For a top-level session that identity is the
      // session id, which is what the phone pairs its answer with.
      const agentId = typeof value.agentId === 'string' ? value.agentId : undefined
      if (!eventId || !request || !agentId) return
      const pending = parsePendingQuestion(eventId, { ...request, sessionId: agentId })
      if (pending) this.pendingQuestions.set(eventId, pending)
      return
    }
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      this.pendingQuestions.delete(value.eventId)
    }
  }

  /**
   * @param {string} rpcId
   * @param {string} sessionId
   */
  assertPendingQuestion(rpcId, sessionId) {
    const pending = this.pendingQuestions.get(rpcId)
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error('This question request is no longer pending.')
    }
    return pending
  }

  /**
   * Settle one forwarded question.
   *
   * `/api/respond` went with the ApiProxy. A forwarded event is now settled
   * through the Gateway's own unary endpoint, which pairs the event with the
   * client generation that received it — so an answer sent after a reconnect
   * is refused rather than applied to a stale question.
   * @param {string} eventId
   * @param {Record<string, unknown>} outcome
   * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
   */
  async respondToQuestion(eventId, outcome) {
    const clientId = this.eventClientId
    if (clientId === undefined) return { ok: false, error: 'Harness event stream is not connected.' }
    const settled = await this.invokeHarness(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId,
      eventId,
      outcome
    })
    if (settled.ok) this.pendingQuestions.delete(eventId)
    return settled
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {string} body
   */
  // Never compress this response at the origin. 2026-10-01: serving the mobile
  // document with `content-encoding: gzip` made the phone render the compressed
  // bytes as text (stripped header, untouched body somewhere along the tunnel /
  // browser path) — the page came up as a wall of JSON fragments. Whatever
  // compression happens on the wire is the edge's business.
  /**
   * Report what the record projection actually saved, at most once a minute.
   * The numbers are the ones the phone pays over the tunnel, so they belong in
   * the log rather than in a benchmark script.
   *
   * @param {unknown[]} raw
   * @param {unknown} compacted
   */
  noteRecordSavings(raw, compacted) {
    const now = Date.now()
    if (this._recordSavingsAt && now - this._recordSavingsAt < 60_000) return
    this._recordSavingsAt = now
    try {
      const before = Buffer.byteLength(JSON.stringify(raw))
      const after = Buffer.byteLength(JSON.stringify(compacted))
      this.log('info', `records ${raw.length} ${Math.round(before / 1024)}KB -> ${Math.round(after / 1024)}KB`)
    } catch {
      // A payload that cannot be measured must never break the response.
    }
  }

  html(response, body) {
    if (response.destroyed) return
    response.statusCode = 200
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {string} location
   */
  redirect(response, location) {
    response.statusCode = 302
    response.setHeader('location', location)
    response.end()
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {string} body
   */
  text(response, status, body) {
    if (response.destroyed) return
    response.statusCode = status
    response.setHeader('content-type', 'text/plain; charset=utf-8')
    response.end(body)
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {unknown} body
   */
  json(response, status, body) {
    if (response.destroyed) return
    if (response.headersSent) {
      response.end()
      return
    }
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  }
}

/** @returns {string | undefined} */
export function preferredLanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) return entry.address
    }
  }
  return undefined
}

/**
 * @param {string} address
 * @returns {string}
 */
export function normalizeRemoteAddress(address) {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  return address === '::1' || address === '127.0.0.1'
}

/**
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  if (isLoopbackAddress(address)) return true
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true
  const match = /^172\.(\d+)\./.exec(address)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe8[0-9a-f]:/i.test(address)
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 */
async function readBody(request) {
  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  const first = Array.isArray(value) ? value[0] : value?.split(',', 1)[0]
  const normalized = first?.trim()
  return normalized || undefined
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isInternetTunnelHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return (
    (normalized.endsWith('.trycloudflare.com') && normalized !== 'api.trycloudflare.com') ||
    normalized.endsWith('.pinggy.link') ||
    normalized.endsWith('.pinggy-free.link') ||
    normalized.endsWith('.pinggy.online')
  )
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Record fields the phone provably never reads, measured on production data
 * (a 200-record window of a real session: 785 KB total).
 *
 *  - `stream`:  the replayed token stream of a finished turn (592 KB, 75%) — the
 *               live channel carries tokens separately, and the client's
 *               renderer only ever looks at `assistant/chunk` records.
 *  - `meta`:    a tool result's file-match snippets (61 KB, 8%) — the client
 *               reads only `message.content[].toolCallId/isError/content`.
 *  - `header`:  the full request header incl. every tool schema (50 KB, 6%) —
 *               no client code touches a record's `header`.
 *
 * Dropping exactly these keeps the painted transcript byte-identical (verified
 * by rendering the same session from both shapes) while cutting ~90% of the
 * bytes the phone pulls for every session it opens.
 */
const PHONE_RECORD_DROP_KEYS = ['stream', 'header', 'meta']

/**
 * Strip the phone-invisible bulk from one harness record without mutating it.
 *
 * @param {unknown} record
 * @returns {unknown}
 */
function compactPhoneRecord(record) {
  if (!isRecord(record)) return record
  /** @type {Record<string, unknown>} */
  const compact = { ...record }
  if (isRecord(record.event)) compact.event = compactPhoneRecord(record.event)
  if (isRecord(record.data)) {
    /** @type {Record<string, unknown>} */
    const data = { ...record.data }
    for (const key of PHONE_RECORD_DROP_KEYS) delete data[key]
    compact.data = data
  }
  return compact
}

/**
 * Drop the records a phone already has (sequence <= sinceSeq) from one SSE
 * frame. Returns null when nothing is left to send and the frame is not the
 * opening snapshot — the client still needs that one to know the stream is live.
 *
 * @param {unknown} frame
 * @param {number} sinceSeq
 * @returns {unknown}
 */
export function stripRecordsThrough(frame, sinceSeq) {
  if (!isRecord(frame) || !(sinceSeq >= 0)) return frame
  const seqOf = (entry) => {
    const event = isRecord(entry) && isRecord(entry.event) ? entry.event : entry
    const seq = isRecord(event) ? event.seq : undefined
    return typeof seq === 'number' ? seq : -1
  }
  const keep = (list) => list.filter((entry) => seqOf(entry) > sinceSeq)
  if (Array.isArray(frame.records)) {
    const records = keep(frame.records)
    return records.length === frame.records.length ? frame : { ...frame, records }
  }
  if (Array.isArray(frame.events)) {
    const events = keep(frame.events)
    return events.length === frame.events.length ? frame : { ...frame, events }
  }
  return seqOf(frame) > sinceSeq ? frame : null
}

/**
 * @param {unknown} records
 * @returns {unknown}
 */
export function compactSessionRecords(records) {
  if (!Array.isArray(records)) return records
  return records.map((record) => compactPhoneRecord(record))
}

/**
 * Compact one SSE frame: a `snapshot` carries the page records, an `event`
 * carries a single record (possibly wrapped).
 *
 * @param {unknown} frame
 * @returns {unknown}
 */
export function compactSessionFrame(frame) {
  if (!isRecord(frame)) return frame
  /** @type {Record<string, unknown>} */
  const compact = { ...frame }
  if (Array.isArray(frame.records)) compact.records = compactSessionRecords(frame.records)
  if (Array.isArray(frame.events)) compact.events = compactSessionRecords(frame.events)
  if (isRecord(frame.event)) compact.event = compactPhoneRecord(frame.event)
  return compact
}

/**
 * @typedef {{ items: unknown[] } & Record<string, unknown>} WorkspaceSnapshot
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isWorkspaceSnapshot(value) {
  return isRecord(value) && Array.isArray(value.items)
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function workspaceIdOf(value) {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) return undefined
  return value.workspaceId
}

/**
 * Fold one `workspace/follow` frame into the snapshot `workspace.list` serves.
 *
 * The Host has no unary workspace read. The opening frame is a full baseline;
 * later frames are increments. Increments that arrive before a baseline are
 * ignored, because there is no projection to apply them to.
 * @param {unknown} snapshot
 * @param {Record<string, unknown>} frame
 * @returns {unknown}
 */
export function applyWorkspaceFollowFrame(snapshot, frame) {
  if (frame.type === 'baseline') return isWorkspaceSnapshot(frame.value) ? frame.value : snapshot
  const current = isWorkspaceSnapshot(snapshot) ? snapshot : undefined
  if (current === undefined) return snapshot
  if (frame.type === 'upsert') {
    const workspaceId = workspaceIdOf(frame.workspace)
    if (workspaceId === undefined || !isRecord(frame.workspace)) return snapshot
    const items = current.items.slice()
    const index = items.findIndex((item) => workspaceIdOf(item) === workspaceId)
    if (index >= 0) items[index] = frame.workspace
    else items.push(frame.workspace)
    return { ...current, items }
  }
  if (frame.type === 'remove') {
    const workspaceId = typeof frame.workspaceId === 'string' ? frame.workspaceId : undefined
    if (workspaceId === undefined || workspaceId.length === 0) return snapshot
    return {
      ...current,
      items: current.items.filter((item) => workspaceIdOf(item) !== workspaceId)
    }
  }
  if (frame.type === 'order' && Array.isArray(frame.workspaceIds)) {
    const rank = new Map()
    for (const [index, id] of frame.workspaceIds.entries()) {
      if (typeof id === 'string' && id.length > 0) rank.set(id, index)
    }
    const items = current.items.slice().sort((left, right) => {
      const leftRank = rank.get(workspaceIdOf(left) ?? '')
      const rightRank = rank.get(workspaceIdOf(right) ?? '')
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER)
    })
    return { ...current, items }
  }
  if (frame.type === 'archived' && Array.isArray(frame.archivedSessionIds)) {
    return { ...current, archivedSessionIds: frame.archivedSessionIds.slice() }
  }
  if (frame.type === 'pinned') {
    // Baseline marker for pinned-session ordering. This snapshot carries no
    // pinned projection, so acknowledge explicitly without mutating state.
    return snapshot
  }
  return snapshot
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requiredStringField(value, field) {
  if (!isRecord(value) || typeof value[field] !== 'string' || !value[field]) {
    throw new Error(`Invalid ${field}.`)
  }
  return value[field]
}

/**
 * Short device label from the pairing request's User-Agent.
 * @param {unknown} ua
 * @returns {string}
 */
function uaLabel(ua) {
  if (typeof ua !== 'string' || ua.length === 0) return 'Phone'
  return ua.slice(0, 40)
}

/**
 * @param {string} rpcId
 * @param {Record<string, unknown>} payload
 * @returns {{ rpcId: string, sessionId: string, questions: Array<Record<string, unknown>> } | undefined}
 */
function parsePendingQuestion(rpcId, payload) {
  if (typeof payload.sessionId !== 'string' || !Array.isArray(payload.questions)) return undefined
  /** @type {Array<Record<string, unknown>>} */
  const questions = []
  for (const item of payload.questions.slice(0, 20)) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.question !== 'string') continue
    /** @type {Record<string, unknown>} */
    const question = { id: item.id, question: item.question }
    if (typeof item.detail === 'string') question.detail = item.detail
    if (typeof item.header === 'string') question.header = item.header
    if (typeof item.multiSelect === 'boolean') question.multiSelect = item.multiSelect
    if (typeof item.intent === 'string') question.intent = item.intent
    if (Array.isArray(item.options)) {
      question.options = item.options.slice(0, 50).flatMap((option) => {
        if (!isRecord(option) || typeof option.label !== 'string') return []
        return [{
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {})
        }]
      })
    }
    questions.push(question)
  }
  if (!questions.length) return undefined
  return { rpcId, sessionId: payload.sessionId, questions }
}

/**
 * @param {unknown} value
 * @returns {{ rpcId: string, sessionId: string, answers: Array<Record<string, unknown>> }}
 */
function parseQuestionResponse(value) {
  const rpcId = requiredStringField(value, 'rpcId')
  const sessionId = requiredStringField(value, 'sessionId')
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length > 20) {
    throw new Error('Invalid question answers.')
  }
  const answers = value.answers.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)) {
      throw new Error('Invalid question answer.')
    }
    const selected = item.selected.map((label) => {
      if (typeof label !== 'string') throw new Error('Invalid selected option.')
      return label
    })
    if (selected.length > 50) throw new Error('Too many selected options.')
    return {
      id: item.id,
      selected,
      ...(typeof item.custom === 'string' && item.custom.trim() ? { custom: item.custom } : {})
    }
  })
  return { rpcId, sessionId, answers }
}

/**
 * @param {{ questions: Array<{ id: string, options?: Array<{ label: string }>, multiSelect?: boolean }> }} pending
 * @param {Array<{ id: string, selected: string[] }>} answers
 */
function validateQuestionAnswers(pending, answers) {
  if (answers.length !== pending.questions.length) throw new Error('Every question needs an answer or skip.')
  const answerById = new Map(answers.map((answer) => [answer.id, answer]))
  if (answerById.size !== answers.length) throw new Error('Duplicate question answer.')
  for (const question of pending.questions) {
    const answer = answerById.get(question.id)
    if (!answer) throw new Error('Every question needs an answer or skip.')
    const allowed = new Set((question.options ?? []).map((option) => option.label))
    if (answer.selected.some((label) => !allowed.has(label))) {
      throw new Error('Answer contains an unknown option.')
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      throw new Error('Only one option can be selected.')
    }
  }
}

/**
 * @param {number} milliseconds
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function waitFor(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timeout = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
