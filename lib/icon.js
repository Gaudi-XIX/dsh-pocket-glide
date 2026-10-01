import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Build a small (96px) data-URI version of the app icon so cold page loads need
 * zero image round-trips. pngjs is a direct dependency of the plugin. Results
 * are memoized per source path.
 */
const cache = new Map()

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
      const S = src.width
      const D = Math.min(96, S)
      const out = new PNG({ width: D, height: D })
      const sample = (x, y, c) => {
        const xi = Math.max(0, Math.min(S - 1, Math.floor(x)))
        const yi = Math.max(0, Math.min(S - 1, Math.floor(y)))
        const x2 = Math.min(S - 1, xi + 1)
        const y2 = Math.min(S - 1, yi + 1)
        const fx = x - xi
        const fy = y - yi
        const at = (px, py) => src.data[(py * S + px) * 4 + c]
        return (
          at(xi, yi) * (1 - fx) * (1 - fy) +
          at(x2, yi) * fx * (1 - fy) +
          at(xi, y2) * (1 - fx) * fy +
          at(x2, y2) * fx * fy
        )
      }
      for (let y = 0; y < D; y++) {
        for (let x = 0; x < D; x++) {
          const sx = ((x + 0.5) * S) / D - 0.5
          const sy = ((y + 0.5) * S) / D - 0.5
          const o = (y * D + x) * 4
          for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(sample(sx, sy, c))
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
