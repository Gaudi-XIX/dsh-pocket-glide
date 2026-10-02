/**
 * Self-contained QR Code 2001 encoder + SVG renderer.
 *
 * Why this exists: pairing pages need a scannable QR code for the pairing URL,
 * but the `qrcode` npm package pulls in renderer/dependency surface the plugin
 * ships to users' machines. This implements the subset the bridge needs:
 *   - byte mode only (UTF-8 via TextEncoder)
 *   - error-correction level M
 *   - automatic version selection, versions 1-10 (~213 UTF-8 bytes at M)
 *   - all 8 mask patterns with the standard penalty-score selection
 *   - Reed-Solomon GF(256) ECC, format + version information
 *
 * Matrix equality against the reference `qrcode` package is covered by
 * test/qr-svg.test.js (fixtures under test/fixtures/).
 */

const ECL_BIT = 0 // error-correction level M
const MIN_VERSION = 1
const MAX_VERSION = 10

// Per-version tables for level M, indices 0..9 == versions 1..10.
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const EC_CODEWORDS = [10, 16, 26, 36, 48, 64, 72, 88, 110, 130]
const EC_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const BYTE_CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]

// Alignment pattern center coordinates (row/col) for versions 1..10.
const ALIGNMENT_COORDS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

// ---------------------------------------------------------------------------
// Galois field GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

const EXP_TABLE = new Uint8Array(512)
const LOG_TABLE = new Uint8Array(256)
;(function initTables() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x
    LOG_TABLE[Math.max(0, x)] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP_TABLE[i] = EXP_TABLE[i - 255]
})()

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]]
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256)
// ---------------------------------------------------------------------------

function polyMul(p1, p2) {
  const coeff = new Uint8Array(p1.length + p2.length - 1)
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      coeff[i + j] ^= gfMul(p1[i], p2[j])
    }
  }
  return coeff
}

function polyMod(dividend, divisor) {
  let result = new Uint8Array(dividend)
  while (result.length - divisor.length >= 0) {
    const coeff = result[0]
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMul(divisor[i], coeff)
    }
    let offset = 0
    while (offset < result.length && result[offset] === 0) offset++
    result = result.slice(offset)
  }
  return result
}

function generatorPolynomial(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, new Uint8Array([1, EXP_TABLE[i]]))
  }
  return poly
}

function reedSolomonEc(data, ecCount) {
  const padded = new Uint8Array(data.length + ecCount)
  padded.set(data)
  const remainder = polyMod(padded, generatorPolynomial(ecCount))
  const start = ecCount - remainder.length
  if (start > 0) {
    const buff = new Uint8Array(ecCount)
    buff.set(remainder, start)
    return buff
  }
  return remainder
}

// ---------------------------------------------------------------------------
// Bit buffer + data encoding (byte mode)
// ---------------------------------------------------------------------------

class BitBuffer {
  constructor() {
    this.buffer = []
    this.lengthInBits = 0
  }

  put(value, bitCount) {
    for (let i = 0; i < bitCount; i++) {
      this.putBit(((value >>> (bitCount - i - 1)) & 1) === 1)
    }
  }

  putBit(bit) {
    const byteIndex = this.lengthInBits >> 3
    if (this.buffer.length <= byteIndex) this.buffer.push(0)
    if (bit) this.buffer[byteIndex] |= 0x80 >>> (this.lengthInBits % 8)
    this.lengthInBits += 1
  }
}

// Encode payload bytes into interleaved data + EC codewords.
function createCodewords(version, bytes) {
  const index = version - 1
  const totalCodewords = TOTAL_CODEWORDS[index]
  const ecTotalCodewords = EC_CODEWORDS[index]
  const ecTotalBlocks = EC_BLOCKS[index]
  const dataTotalCodewords = totalCodewords - ecTotalCodewords

  const buffer = new BitBuffer()
  // An empty payload produces zero segments (matching the reference package,
  // whose segment builder drops falsy data): no mode/count header, just the
  // terminator and pad codewords below.
  if (bytes.length > 0) {
    // Mode indicator: byte = 0100.
    buffer.put(0b0100, 4)
    // Character count: 8 bits (v1-9) or 16 bits (v10+).
    buffer.put(bytes.length, version < 10 ? 8 : 16)
    for (const byte of bytes) buffer.put(byte, 8)
  }

  const dataTotalCodewordsBits = dataTotalCodewords * 8
  // Terminator: up to four 0 bits.
  if (buffer.lengthInBits + 4 <= dataTotalCodewordsBits) buffer.put(0, 4)
  // Pad to a byte boundary.
  while (buffer.lengthInBits % 8 !== 0) buffer.putBit(0)
  // Pad codewords 0xEC / 0x11 alternately.
  const remainingBytes = (dataTotalCodewordsBits - buffer.lengthInBits) / 8
  for (let i = 0; i < remainingBytes; i++) {
    buffer.put(i % 2 ? 0x11 : 0xec, 8)
  }

  // Split data into the two (possibly different-sized) block groups.
  const blocksInGroup2 = totalCodewords % ecTotalBlocks
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2
  const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks)
  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks)
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1
  const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1

  const dcData = new Array(ecTotalBlocks)
  const ecData = new Array(ecTotalBlocks)
  let offset = 0
  let maxDataSize = 0
  const source = new Uint8Array(buffer.buffer)
  for (let b = 0; b < ecTotalBlocks; b++) {
    const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2
    dcData[b] = source.slice(offset, offset + dataSize)
    ecData[b] = reedSolomonEc(dcData[b], ecCount)
    offset += dataSize
    maxDataSize = Math.max(maxDataSize, dataSize)
  }

  // Interleave: data codewords column-wise (short group-1 blocks end early),
  // then EC codewords column-wise.
  const data = new Uint8Array(totalCodewords)
  let pos = 0
  for (let i = 0; i < maxDataSize; i++) {
    for (let b = 0; b < ecTotalBlocks; b++) {
      if (i < dcData[b].length) data[pos++] = dcData[b][i]
    }
  }
  for (let i = 0; i < ecCount; i++) {
    for (let b = 0; b < ecTotalBlocks; b++) {
      data[pos++] = ecData[b][i]
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

class BitMatrix {
  constructor(size) {
    this.size = size
    this.data = new Uint8Array(size * size)
    this.reservedBit = new Uint8Array(size * size)
  }

  set(row, col, value, reserved = false) {
    const index = row * this.size + col
    this.data[index] = value ? 1 : 0
    if (reserved) this.reservedBit[index] = 1
  }

  get(row, col) {
    return this.data[row * this.size + col]
  }

  xor(row, col, value) {
    if (value) this.data[row * this.size + col] ^= 1
  }

  isReserved(row, col) {
    return this.reservedBit[row * this.size + col] === 1
  }
}

function setupFinderPattern(matrix, version) {
  const { size } = matrix
  const positions = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]
  for (const [row, col] of positions) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        matrix.set(row + r, col + c, dark, true)
      }
    }
  }
}

function setupTimingPattern(matrix) {
  const { size } = matrix
  for (let r = 8; r < size - 8; r++) {
    const value = r % 2 === 0
    matrix.set(r, 6, value, true)
    matrix.set(6, r, value, true)
  }
}

function setupAlignmentPattern(matrix, version) {
  const coords = ALIGNMENT_COORDS[version - 1]
  const last = coords.length - 1
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      // Skip the three positions overlapped by finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        continue
      }
      const row = coords[i]
      const col = coords[j]
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)
          matrix.set(row + r, col + c, dark, true)
        }
      }
    }
  }
}

function bchDigit(data) {
  let digit = 0
  while (data !== 0) {
    digit++
    data >>>= 1
  }
  return digit
}

// (15,5) BCH for format information, XOR-masked so it is never all zero.
function formatInfoBits(maskPattern) {
  const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1
  const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1)
  const G15_BCH = bchDigit(G15)
  const data = (ECL_BIT << 3) | maskPattern
  let d = data << 10
  while (bchDigit(d) - G15_BCH >= 0) {
    d ^= G15 << (bchDigit(d) - G15_BCH)
  }
  return ((data << 10) | d) ^ G15_MASK
}

function setupFormatInfo(matrix, maskPattern) {
  const { size } = matrix
  const bits = formatInfoBits(maskPattern)
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1

    // Vertical strip beside the top-left finder.
    if (i < 6) matrix.set(i, 8, mod, true)
    else if (i < 8) matrix.set(i + 1, 8, mod, true)
    else matrix.set(size - 15 + i, 8, mod, true)

    // Horizontal strip beside the top-left finder.
    if (i < 8) matrix.set(8, size - i - 1, mod, true)
    else if (i < 9) matrix.set(8, 15 - i - 1 + 1, mod, true)
    else matrix.set(8, 15 - i - 1, mod, true)
  }
  // Fixed dark module.
  matrix.set(size - 8, 8, 1, true)
}

// (18,6) Golay code for version information (v7+).
function versionInfoBits(version) {
  const G18 =
    (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1
  const G18_BCH = bchDigit(G18)
  let d = version << 12
  while (bchDigit(d) - G18_BCH >= 0) {
    d ^= G18 << (bchDigit(d) - G18_BCH)
  }
  return (version << 12) | d
}

function setupVersionInfo(matrix, version) {
  const { size } = matrix
  const bits = versionInfoBits(version)
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3)
    const col = (i % 3) + size - 8 - 3
    const mod = ((bits >> i) & 1) === 1
    matrix.set(row, col, mod, true)
    matrix.set(col, row, mod, true)
  }
}

function setupData(matrix, data) {
  const { size } = matrix
  let inc = -1
  let row = size - 1
  let bitIndex = 7
  let byteIndex = 0

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (!matrix.isReserved(row, col - c)) {
          let dark = false
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1
          matrix.set(row, col - c, dark)
          bitIndex--
          if (bitIndex === -1) {
            byteIndex++
            bitIndex = 7
          }
        }
      }
      row += inc
      if (row < 0 || size <= row) {
        row -= inc
        inc = -inc
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mask patterns + penalty scoring
// ---------------------------------------------------------------------------

function maskAt(pattern, i, j) {
  switch (pattern) {
    case 0:
      return (i + j) % 2 === 0
    case 1:
      return i % 2 === 0
    case 2:
      return j % 3 === 0
    case 3:
      return (i + j) % 3 === 0
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0
    case 5:
      return (i * j) % 2 + (i * j) % 3 === 0
    case 6:
      return ((i * j) % 2 + (i * j) % 3) % 2 === 0
    case 7:
      return ((i * j) % 3 + (i + j) % 2) % 2 === 0
    default:
      throw new Error(`bad mask pattern: ${pattern}`)
  }
}

function applyMask(pattern, matrix) {
  const { size } = matrix
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (matrix.isReserved(row, col)) continue
      matrix.xor(row, col, maskAt(pattern, row, col))
    }
  }
}

function penaltyN1(matrix) {
  const { size } = matrix
  let points = 0
  for (let row = 0; row < size; row++) {
    let runHorizontal = 0
    let runVertical = 0
    let lastHorizontal = null
    let lastVertical = null
    for (let col = 0; col < size; col++) {
      const horizontal = matrix.get(row, col)
      if (horizontal === lastHorizontal) {
        runHorizontal++
      } else {
        if (runHorizontal >= 5) points += 3 + (runHorizontal - 5)
        lastHorizontal = horizontal
        runHorizontal = 1
      }

      const vertical = matrix.get(col, row)
      if (vertical === lastVertical) {
        runVertical++
      } else {
        if (runVertical >= 5) points += 3 + (runVertical - 5)
        lastVertical = vertical
        runVertical = 1
      }
    }
    if (runHorizontal >= 5) points += 3 + (runHorizontal - 5)
    if (runVertical >= 5) points += 3 + (runVertical - 5)
  }
  return points
}

function penaltyN2(matrix) {
  const { size } = matrix
  let blocks = 0
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum =
        matrix.get(row, col) +
        matrix.get(row, col + 1) +
        matrix.get(row + 1, col) +
        matrix.get(row + 1, col + 1)
      if (sum === 0 || sum === 4) blocks++
    }
  }
  return blocks * 3
}

function penaltyN3(matrix) {
  const { size } = matrix
  let found = 0
  for (let row = 0; row < size; row++) {
    let bitsHorizontal = 0
    let bitsVertical = 0
    for (let col = 0; col < size; col++) {
      bitsHorizontal = ((bitsHorizontal << 1) & 0x7ff) | matrix.get(row, col)
      if (col >= 10 && (bitsHorizontal === 0x5d0 || bitsHorizontal === 0x05d)) found++

      bitsVertical = ((bitsVertical << 1) & 0x7ff) | matrix.get(col, row)
      if (col >= 10 && (bitsVertical === 0x5d0 || bitsVertical === 0x05d)) found++
    }
  }
  return found * 40
}

function penaltyN4(matrix) {
  let dark = 0
  for (let i = 0; i < matrix.data.length; i++) dark += matrix.data[i]
  const k = Math.abs(Math.ceil((dark * 100) / matrix.data.length / 5) - 10)
  return k * 10
}

function chooseMask(matrix) {
  let bestPattern = 0
  let lowestPenalty = Infinity
  for (let pattern = 0; pattern < 8; pattern++) {
    setupFormatInfo(matrix, pattern)
    applyMask(pattern, matrix)
    const penalty =
      penaltyN1(matrix) + penaltyN2(matrix) + penaltyN3(matrix) + penaltyN4(matrix)
    applyMask(pattern, matrix) // undo
    if (penalty < lowestPenalty) {
      lowestPenalty = penalty
      bestPattern = pattern
    }
  }
  return bestPattern
}

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

function selectVersion(byteLength) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteLength <= BYTE_CAPACITY[version - 1]) return version
  }
  throw new Error(
    `QR data too long: ${byteLength} bytes exceeds version ${MAX_VERSION} capacity ` +
      `${BYTE_CAPACITY[MAX_VERSION - 1]} bytes at error-correction level M`,
  )
}

/**
 * Encode text into a QR code symbol.
 *
 * @param {string} text UTF-8 payload
 * @returns {{ version:number, size:number, maskPattern:number, modules:Uint8Array }}
 *   modules is row-major (index = row*size + col), 1 = dark
 */
export function encodeQr(text) {
  const bytes = new TextEncoder().encode(text)
  const version = selectVersion(bytes.length)
  const size = version * 4 + 17

  const data = createCodewords(version, bytes)
  const matrix = new BitMatrix(size)

  setupFinderPattern(matrix, version)
  setupTimingPattern(matrix)
  setupAlignmentPattern(matrix, version)
  // Reserve format-info modules with dummy bits before data placement.
  setupFormatInfo(matrix, 0)
  if (version >= 7) setupVersionInfo(matrix, version)
  setupData(matrix, data)

  const maskPattern = chooseMask(matrix)
  applyMask(maskPattern, matrix)
  setupFormatInfo(matrix, maskPattern)

  return { version, size, maskPattern, modules: matrix.data }
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/**
 * Text as XML character data / attribute value. The payload of a pairing symbol
 * is a URL and URLs carry `&`; unescaped it is malformed markup and the name a
 * reader announces stops at the ampersand.
 * @param {string} value
 * @returns {string}
 */
function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render text as a standalone SVG string, drop-in compatible with
 * `QRCode.toString(text, { type: 'svg', margin: 1, width: 260 })` for use as
 * an element's innerHTML.
 *
 * @param {string} text UTF-8 payload
 * @param {{ width?:number, margin?:number, label?:string }} [options]
 * @returns {string} SVG markup (no XML declaration; one <rect> per module)
 */
export function renderQrSvg(text, options = {}) {
  const { width = 260, margin = 1, label } = options
  const { size, modules } = encodeQr(text)
  const extent = size + margin * 2
  // The accessible name of a symbol that is pure data. Without `role="img"` and
  // a `<title>` a screen reader walking this SVG finds several hundred anonymous
  // rects — a nameless image, for a payload whose whole purpose is to be read.
  // The default name is the payload itself (the pairing URL), which is what the
  // sighted user's second device is handed.
  const title = escapeXmlText(label === undefined || label === '' ? String(text) : label)

  const rects = [`<rect width="${extent}" height="${extent}" fill="#ffffff"/>`]
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row * size + col] === 1) {
        rects.push(
          `<rect x="${col + margin}" y="${row + margin}" width="1" height="1" fill="#000000"/>`,
        )
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" ` +
    `viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    rects.join('') +
    `</svg>`
  )
}
