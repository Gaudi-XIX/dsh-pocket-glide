import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Build a small (<=96px) data-URI version of the app icon so cold page loads need
 * zero image round-trips. pngjs is a direct dependency of the plugin. Results
 * are memoized per source path.
 *
 * The source is not assumed square (R-T7): `src.width` used to double as the
 * stride, the y-clamp bound and the scale edge, so a 200x100 source produced a
 * 96x96 icon whose lower half was transparent (probe-03: 4608 opaque + 4608 fully
 * transparent pixels), and a 100x200 source silently never sampled rows 100..199.
 * Width and height are now independent, the long edge is scaled to at most 96 and
 * the short edge follows — the aspect ratio is preserved, nothing is stretched
 * and nothing is cropped.
 *
 * Interpolation runs in the PREMULTIPLIED domain (R-T8): averaging straight
 * channels across a transparency edge pulls colour out of pixels that are not
 * there, which showed up as halos around a transparent-bordered icon (probe-08:
 * 142 of 9216 pixels off by more than 8 levels, worst channel 63.67). Alpha
 * itself stays straight; the colour channels are multiplied by alpha, averaged,
 * then divided back out.
 */
const cache = new Map()

/** Largest edge of the produced icon. */
const MAX_EDGE = 96

async function loadPng() {
  const require = createRequire(import.meta.url)
  const pngjsEntry = require.resolve('pngjs')
  return import(pathToFileURL(pngjsEntry).href)
}

export async function buildIconDataUri(sourcePath) {
  if (!sourcePath) return null
  if (cache.has(sourcePath)) return cache.get(sourcePath)
  const promise = (async () => {
    try {
      const { PNG } = await loadPng()
      const src = PNG.sync.read(readFileSync(sourcePath))
      const SW = src.width
      const SH = src.height
      if (!(SW > 0) || !(SH > 0)) return null
      // Fit inside MAX_EDGE without distorting AND without upscaling: the LONG
      // edge is what is bounded, so a wide icon stays wide instead of being
      // squashed into a square, and a small icon is never blown up (which is what
      // kept a square source byte-identical: min(1, 96/S) reproduces the old
      // `D = Math.min(96, S)`).
      const scale = Math.min(1, MAX_EDGE / SW, MAX_EDGE / SH)
      const W = Math.max(1, Math.round(SW * scale))
      const H = Math.max(1, Math.round(SH * scale))
      const out = new PNG({ width: W, height: H })
      const at = (px, py, c) => src.data[(py * SW + px) * 4 + c]
      /** Straight (non-premultiplied) bilinear read, used for the alpha channel. */
      const sampleAlpha = (x, y) => {
        const xi = Math.max(0, Math.min(SW - 1, Math.floor(x)))
        const yi = Math.max(0, Math.min(SH - 1, Math.floor(y)))
        const x2 = Math.min(SW - 1, xi + 1)
        const y2 = Math.min(SH - 1, yi + 1)
        const fx = x - xi
        const fy = y - yi
        return (
          at(xi, yi, 3) * (1 - fx) * (1 - fy) +
          at(x2, yi, 3) * fx * (1 - fy) +
          at(xi, y2, 3) * (1 - fx) * fy +
          at(x2, y2, 3) * fx * fy
        )
      }
      /**
       * Bilinear read of a COLOUR channel, weighted by each corner's own alpha
       * and divided by the interpolated alpha. Where the interpolated alpha is
       * zero there is no colour to recover, so the result is 0 — branching on
       * zero rather than clamping with an epsilon, which would turn "no colour"
       * into "whatever the division produced".
       */
      const sampleColor = (x, y, c) => {
        const xi = Math.max(0, Math.min(SW - 1, Math.floor(x)))
        const yi = Math.max(0, Math.min(SH - 1, Math.floor(y)))
        const x2 = Math.min(SW - 1, xi + 1)
        const y2 = Math.min(SH - 1, yi + 1)
        const fx = x - xi
        const fy = y - yi
        const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
        const corners = [
          [xi, yi],
          [x2, yi],
          [xi, y2],
          [x2, y2],
        ]
        let premultiplied = 0
        let alpha = 0
        for (let index = 0; index < corners.length; index += 1) {
          const [px, py] = corners[index]
          const cornerAlpha = at(px, py, 3)
          premultiplied += at(px, py, c) * cornerAlpha * weights[index]
          alpha += cornerAlpha * weights[index]
        }
        return alpha > 0 ? premultiplied / alpha : 0
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sx = ((x + 0.5) * SW) / W - 0.5
          const sy = ((y + 0.5) * SH) / H - 0.5
          const o = (y * W + x) * 4
          for (let c = 0; c < 3; c++) {
            out.data[o + c] = Math.max(0, Math.min(255, Math.round(sampleColor(sx, sy, c))))
          }
          out.data[o + 3] = Math.max(0, Math.min(255, Math.round(sampleAlpha(sx, sy))))
        }
      }
      const b64 = PNG.sync.write(out).toString('base64')
      return `data:image/png;base64,${b64}`
    } catch {
      return null
    }
  })()
  cache.set(sourcePath, promise)
  return promise
}