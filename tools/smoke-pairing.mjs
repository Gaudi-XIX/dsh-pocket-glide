// LAN pairing closed loop: valid token -> dsh_mobile cookie (30d) ->
// /api/status carries this device's expiresAt; desktop sees the device.
import { LanMobileBridge } from '../lib/bridge.js'

const bridge = new LanMobileBridge({
  harnessUrl: () => 'http://127.0.0.1:19387',
  innerAuth: { ready: async () => undefined, invalidate: () => {} },
  locale: 'zh',
  pairingPinStore: { load: () => ({}), save: () => true },
  tunnelLog: () => {},
})

const snap = await bridge.start()
const port = snap.port
console.log(`bridge assigned port ${port}`)
// Rewrite the LAN pairing URL to loopback (loopback still resolves to LAN mode).
const token = new URL(snap.pairingUrl).searchParams.get('token')
const pairUrl = `http://127.0.0.1:${port}/pair?token=${token}`

// Parse JSON only when the body claims/contains JSON; error pages are plain
// text (e.g. 401), and res.json() throws on them.
const readJson = async (res) => {
  const text = await res.text()
  try { return { json: JSON.parse(text), text } } catch { return { json: null, text } }
}

const res = await fetch(pairUrl, {
  redirect: 'manual',
  headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) PixelTest/1.0' },
})
const setCookie = res.headers.get('set-cookie') ?? ''
console.log('pair status:', res.status)
console.log('set-cookie:', setCookie)
const mobileCookie = setCookie.split(',')[0].split(';')[0]
const maxAge = /Max-Age=(\d+)/.exec(setCookie)?.[1]
console.log('Max-Age:', maxAge, '(expect 2592000)')

const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
  headers: { Cookie: mobileCookie },
})
const { json: body, text: statusText } = await readJson(status)
if (body) console.log('/api/status:', JSON.stringify(body))
else console.log(`/api/status non-JSON (${status.status}):`, statusText.slice(0, 200))

// Desktop bootstrap to observe connected devices.
const desktopUrl = bridge.createDesktopUrl()
const boot = await fetch(desktopUrl, { redirect: 'manual' })
const desktopCookie = boot.headers.get('set-cookie').split(';')[0]
const deskStatus = await fetch(`http://127.0.0.1:${port}/desktop/status`, {
  headers: { Cookie: desktopCookie },
})
console.log('/desktop/status:', await deskStatus.text())

await bridge.stop()
console.log('stopped')
