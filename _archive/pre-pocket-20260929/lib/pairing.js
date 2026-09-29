/**
 * Pairing gate for the phone bridge.
 *
 * The phone never gets a credential until it proves it is in front of the
 * pairing page on the desktop, so the public tunnel URL alone is not enough.
 * Two tokens exist:
 *
 *  - `pairingToken`: a 256-bit base64url secret minted when the tunnel starts
 *    and embedded in the pairing QR. It authorizes ONE phone.
 *  - `sessionCookie`: minted at PIN/pair confirmation, HttpOnly + SameSite=Strict,
 *    long-lived (1 year), and revocable from the desktop. `+Secure` is appended
 *    when the request came through the tunnel.
 *
 * Ported from
 * F:\defws\tmp\20260929-dsh-remote-composer\x-dshdesktop-mobile\LanMobileBridge.js
 * (rotatePairingToken / generatePairingPin / pinsEqual / issueSessionCookie /
 *  the PIN_FAIL_* rate limiters).
 */

import {
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'
import { Buffer } from 'node:buffer'

/** How long a pairing token stays valid: 10 minutes. */
const PAIRING_TTL_MS = 10 * 60 * 1000
/** How long the minted session cookie lives: 1 year. */
const SESSION_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60
/** PIN failure window before per-IP and global counters reset. */
const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000
/** Max PIN attempts from one IP inside the window. */
const PIN_FAIL_PER_IP = 8
/** Max PIN attempts from any IP inside the window (global, blocks bots). */
const PIN_FAIL_GLOBAL = 40

/**
 * The pairing state machine. One instance per plugin lifetime; `reset()` is
 * called whenever the tunnel (re)starts so a stale QR cannot be replayed.
 */
export class PairingGate {
  token = undefined
  sessions = new Map()
  pinFailures = new Map()
  pinFailGlobal = { count: 0, at: 0 }
  listeners = new Set()

  /** Notified whenever the gate material changes (QR must be re-rendered). */
  onChange(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener() } catch { /* a dead listener must not break minting */ }
    }
  }

  /** Mint a fresh pairing token; the previous one dies immediately. */
  rotatePairingToken() {
    this.token = {
      value: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + PAIRING_TTL_MS,
    }
    this.emit()
    return this.token.value
  }

  /** The current pairing token, or undefined when expired/absent. */
  currentPairingToken() {
    if (this.token === undefined) return undefined
    if (Date.now() > this.token.expiresAt) {
      this.token = undefined
      return undefined
    }
    return this.token.value
  }

  /** Drop every session and the pairing token (used on disconnect-all). */
  revokeAll() {
    this.sessions.clear()
    this.token = undefined
    this.pinFailures.clear()
    this.pinFailGlobal = { count: 0, at: 0 }
    this.emit()
  }

  /** Generate a 6-digit PIN as a zero-padded string. */
  generatePairingPin() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0')
  }

  /**
   * Constant-time comparison of two PINs. Both are compared as 6-char strings
   * of equal length, so no length side channel exists.
   */
  pinsEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    const left = Buffer.from(a.padEnd(6, '\0').slice(0, 6), 'utf8')
    const right = Buffer.from(b.padEnd(6, '\0').slice(0, 6), 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  /**
   * Record a PIN attempt and decide whether it is allowed.
   * @returns true when the attempt may proceed, false when rate-limited.
   */
  allowPinAttempt(ip) {
    const now = Date.now()
    if (now - this.pinFailGlobal.at > PIN_FAIL_WINDOW_MS) {
      this.pinFailGlobal = { count: 0, at: now }
    }
    if (this.pinFailGlobal.count >= PIN_FAIL_GLOBAL) return false
    const row = this.pinFailures.get(ip)
    if (row !== undefined && now - row.at > PIN_FAIL_WINDOW_MS) {
      this.pinFailures.delete(ip)
    }
    const current = this.pinFailures.get(ip)
    if (current !== undefined && current.count >= PIN_FAIL_PER_IP) return false
    return true
  }

  /** Record a failed PIN attempt for rate limiting. */
  recordPinFailure(ip) {
    const now = Date.now()
    this.pinFailGlobal = { count: this.pinFailGlobal.count + 1, at: now }
    const row = this.pinFailures.get(ip)
    if (row === undefined) {
      this.pinFailures.set(ip, { count: 1, at: now })
    } else {
      this.pinFailures.set(ip, { count: row.count + 1, at: now })
    }
  }

  /** Clear the failure counters for one IP (after a success). */
  clearPinFailures(ip) {
    this.pinFailures.delete(ip)
  }

  /**
   * Mint a device session and return the cookie value.
   * The cookie value is independent of the pairing token so revoking one
   * pairing does not invalidate live phones.
   */
  issueSessionCookie(label) {
    const id = randomBytes(16).toString('base64url')
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(id, {
      id,
      token,
      label: label.slice(0, 120),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    })
    this.emit()
    return token
  }

  /** Resolve a cookie value to a live session, refreshing its last-seen time. */
  resolveSession(cookieValue) {
    if (cookieValue === undefined || cookieValue === '') return undefined
    for (const session of this.sessions.values()) {
      if (session.token === cookieValue) {
        session.lastSeenAt = Date.now()
        return session
      }
    }
    return undefined
  }

  /** Revoke one session by cookie value. */
  revokeSession(cookieValue) {
    for (const [id, session] of this.sessions) {
      if (session.token === cookieValue) {
        this.sessions.delete(id)
        this.emit()
        return true
      }
    }
    return false
  }

  /** Snapshot of live sessions for the desktop status endpoint. */
  sessionSnapshot() {
    return [...this.sessions.values()].map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt }))
  }

  /** Build the `set-cookie` value for a minted session. */
  static sessionCookieHeader(value, secure) {
    return [
      `dsh_mobile=${value}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${SESSION_COOKIE_MAX_AGE_S}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  /** Cookie name used for the phone session. */
  static COOKIE_NAME = 'dsh_mobile'
}
