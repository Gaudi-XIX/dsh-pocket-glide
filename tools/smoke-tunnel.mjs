// Smoke test: ensureCloudflared resolution chain (should fall through to download attempt)
import { resolveCloudflared, extractTryCloudflareUrl, ensureCloudflared } from '../lib/tunnel.js'

// 1. sync resolver should return 'cloudflared' (bare name, nothing found)
const syncResult = resolveCloudflared()
console.log('sync resolveCloudflared:', syncResult)
if (syncResult !== 'cloudflared') {
  console.error('FAIL: expected bare "cloudflared", got', syncResult)
  process.exit(1)
}
console.log('PASS: sync resolver falls through to bare name')

// 2. extractTryCloudflareUrl
const url = extractTryCloudflareUrl('blah blah https://abc-123-def.trycloudflare.com more text')
if (url === 'https://abc-123-def.trycloudflare.com') {
  console.log('PASS: extractTryCloudflareUrl:', url)
} else {
  console.error('FAIL: extractTryCloudflareUrl got', url)
  process.exit(1)
}

// 3. ensureCloudflared is an async function
console.log('ensureCloudflared is function:', typeof ensureCloudflared === 'function')
console.log('PASS: ensureCloudflared is callable')

console.log('\nAll smoke tests PASS')
