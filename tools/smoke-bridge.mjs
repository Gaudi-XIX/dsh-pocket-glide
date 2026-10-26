// Standalone smoke test for the Pocket bridge (no host credential required).
// Boots the bridge with a stub innerAuth, then exercises the independent
// server: desktop bootstrap + gating, unpaired rejection, status shape.
import { LanMobileBridge } from '../lib/bridge.js'

const innerAuth = {
  ready: async () => undefined, // no dsh-auth cookie: RPC forwarding degrades
  invalidate: () => {},
}

const bridge = new LanMobileBridge({
  harnessUrl: () => 'http://127.0.0.1:19387',
  innerAuth,
  locale: 'zh',
  pairingPinStore: { load: () => ({}), save: () => true },
  tunnelLog: () => {},
})

const snap = await bridge.start()
const base = `http://127.0.0.1:${snap.port}`
console.log(`bridge assigned port ${snap.port}`)
console.log('snapshot:', JSON.stringify(snap, null, 2))

const get = async (url, opts = {}) => {
  const res = await fetch(url, opts)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

// 1. Unpaired API status must be rejected.
const unpaired = await get(`${base}/api/status`)
console.log('1) unpaired /api/status ->', unpaired.status)

// 2. Desktop without bootstrap must be 403.
const noBoot = await get(`${base}/desktop`, { headers: { 'sec-fetch-site': 'same-origin' } })
console.log('2) /desktop no bootstrap ->', noBoot.status)

// 3. Desktop bootstrap via loopback one-time token.
const desktopUrl = bridge.createDesktopUrl()
const boot = await get(desktopUrl, { redirect: 'manual' })
console.log('3) bootstrap ->', boot.status, 'set-cookie?', boot.headers.get('set-cookie')?.split(';')[0])
const cookie = boot.headers.get('set-cookie')?.split(';')[0]

// 4. Authenticated desktop status (follows to /desktop after cookie set).
const deskStatus = await get(`${base}/desktop/status`, { headers: { Cookie: cookie } })
console.log('4) /desktop/status ->', deskStatus.status, deskStatus.text.slice(0, 200))

// 5. Security headers on a page.
const pairPage = await get(`${base}/pair?token=bogus`)
console.log('5) bogus pair ->', pairPage.status,
  '| x-frame-options:', pairPage.headers.get('x-frame-options'),
  '| cache-control:', pairPage.headers.get('cache-control'))

await bridge.stop()
console.log('6) bridge stopped cleanly')
