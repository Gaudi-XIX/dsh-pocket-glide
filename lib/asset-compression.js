// Precompressed copies of the two content-addressed shell assets.
//
// The bridge builds these once, while it is being constructed, and keeps them
// for the life of the process: `/app.css` and `/app.js` only change when the
// process restarts, and every URL that names them carries a hash of their own
// bytes, so the bytes a request names are known before the request arrives.
// Compressing here instead of per request takes the brotli pass off the phone's
// cold-open path entirely.
//
// Brotli 9 first, gzip 9 as the fallback. br-11 would save another ~7 KB per
// language but costs ~400 ms of synchronous construction time per language;
// that is 2% of a 338 KB script for 15x the startup cost (design
// `2026-10-24-pocket-asset-precompression` §4-A / §8-R5). If br and gzip are
// both missing for some reason, the asset route falls back to the plain bytes:
// this module never throws at its caller, and a missing product is not an
// error the phone should ever see.
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

// The number of hex digits in the `h=` query parameter. `lib/bridge.js`'s
// digest() for the asset URLs is the same expression, and the two must stay
// character-for-character equal: the URL hash is how a product is matched to
// the bytes it was built from.
const HASH_CHARS = 12

/**
 * One asset, compressed both ways.
 *
 * `gzip` and `br` are `null` when that compressor failed — the other one, and
 * the plain `identity` bytes, are still usable. The entry itself is `null` when
 * there is nothing to compress (a missing or non-string body).
 *
 * @typedef {{
 *   identity: Buffer,
 *   gzip: Buffer | null,
 *   br: Buffer | null,
 *   sha256: string
 * }} PrecompressedAsset
 */

/**
 * @param {string | Buffer | null | undefined} source
 * @returns {PrecompressedAsset | null}
 */
function compressOne(source) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) return null
  const identity = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  const sha256 = createHash('sha256').update(identity).digest('hex').slice(0, HASH_CHARS)
  return {
    identity,
    sha256,
    gzip: tryCompress(() => zlib.gzipSync(identity, { level: 9 })),
    br: tryCompress(() => zlib.brotliCompressSync(identity, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }))
  }
}

/**
 * A compressor that failed leaves its product `null`; it must not take the
 * usable one down with it (a host built without brotli still serves gzip).
 * @param {() => Buffer} run
 * @returns {Buffer | null}
 */
function tryCompress(run) {
  try {
    return run()
  } catch {
    return null
  }
}

/**
 * Both products for one locale's shell.
 *
 * Keys are `css@<locale>` and `js@<locale>` so a bilingual bridge keeps the two
 * scripts apart: they differ (`en` is a few KB longer than `zh`) while both
 * locales share one stylesheet.
 *
 * @param {{ locale: string, css?: string | Buffer | null, js?: string | Buffer | null }} input
 * @returns {Map<string, PrecompressedAsset | null>}
 */
export function precompressAssets({ locale, css, js }) {
  return new Map([
    [`css@${locale}`, compressOne(css)],
    [`js@${locale}`, compressOne(js)]
  ])
}

/**
 * Every locale's shell, keyed the same way, for the bridge to hold in one map.
 *
 * @param {Record<string, { css?: string | Buffer | null, js?: string | Buffer | null } | undefined>} bodiesByLocale
 * @returns {Map<string, PrecompressedAsset | null>}
 */
export function precompressShell(bodiesByLocale) {
  const all = new Map()
  for (const [locale, bodies] of Object.entries(bodiesByLocale ?? {})) {
    if (!bodies) continue
    for (const [key, entry] of precompressAssets({ locale, css: bodies.css, js: bodies.js })) {
      all.set(key, entry)
    }
  }
  return all
}

/**
 * Which product to send, given what the client accepts and what we hold.
 *
 * `br` then `gzip` then nothing (identity), the same order `compression` and
 * `shrink-ray` use. Only explicit tokens count: `*` is ignored, and so are
 * `;q=` weights — the candidate list is three entries long and its order is
 * fixed, so weight parsing would add branches nobody tests. `deflate` is never
 * offered (raw vs zlib wrapping is ambiguous); a client that only accepts
 * `deflate` gets the plain bytes, which is a working answer, never a 406.
 *
 * @param {string | string[] | undefined} acceptEncoding
 * @param {{ br?: boolean, gzip?: boolean }} [available]
 * @returns {'br' | 'gzip' | null}
 */
export function preferredEncoding(acceptEncoding, available = {}) {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '')
  const tokens = String(header)
    .toLowerCase()
    .split(',')
    .map((token) => token.split(';')[0].trim())
    .filter(Boolean)
  if (available.br && tokens.includes('br')) return 'br'
  if (available.gzip && tokens.includes('gzip')) return 'gzip'
  return null
}
