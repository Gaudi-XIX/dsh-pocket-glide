// Dev-only: regenerate test/fixtures/qr-matrices.json from the real `qrcode`
// package. Not shipped (the package "files" allowlist excludes tools/).
// Run from the plugin root: node tools/gen-qr-fixtures.mjs
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'test', 'fixtures', 'qr-matrices.json');

// Lowercase ASCII forces byte mode (uppercase/digits would be optimized into
// alphanumeric mode and change the version boundaries).
function dump(text) {
  const { version, modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return {
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    version,
    size: modules.size,
    bits: Array.from(modules.data).join(''),
  };
}

// qrcode's public create() rejects '' ("No input text"), so drive an explicit
// empty byte-mode segment through it to capture the legitimate empty payload.
function dumpEmpty() {
  const Mode = require('qrcode/lib/core/mode');
  const { version, modules } = QRCode.create(
    [{ data: '', mode: Mode.BYTE }],
    { errorCorrectionLevel: 'M' },
  );
  return {
    text: '',
    byteLength: 0,
    version,
    size: modules.size,
    bits: Array.from(modules.data).join(''),
  };
}

// Find the smallest ASCII byte length that selects each version 1..10.
const boundaryLengths = {};
for (let n = 1; n <= 213; n += 1) {
  const { version } = QRCode.create('a'.repeat(n), { errorCorrectionLevel: 'M' });
  if (boundaryLengths[version] === undefined) boundaryLengths[version] = n;
}

const cases = [
  { name: 'empty', entry: dumpEmpty() },
  { name: 'ascii-short', entry: dump('Hello, QR!') },
  { name: 'utf8-chinese', entry: dump('你好，世界！QR二维码') },
];
for (let v = 1; v <= 10; v += 1) {
  const n = boundaryLengths[v];
  if (n === undefined) throw new Error(`no input found that selects version ${v}`);
  cases.push({ name: `version-${v}-boundary`, entry: dump('a'.repeat(n)) });
}

const payload = {
  errorCorrectionLevel: 'M',
  generatedBy: 'tools/gen-qr-fixtures.mjs (qrcode npm package)',
  cases: cases.map(({ name, entry }) => ({ name, ...entry })),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${outPath}`);
for (const c of payload.cases) {
  console.log(`  ${c.name}: ${c.byteLength} bytes -> v${c.version} (${c.size}x${c.size})`);
}
