// Проверка набора для тестировщика: какие штрихкоды читаются со снимка страницы.
// Запуск: node scripts/check-kit.mjs <снимок.png>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const root = fileURLToPath(new URL('..', import.meta.url));
prepareZXingModule({
  overrides: { wasmBinary: readFileSync(`${root}node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`) },
  fireImmediately: true,
});
const img = new Blob([readFileSync(process.argv[2])], { type: 'image/png' });
const res = await readBarcodes(img, { formats: ['Code128', 'QRCode'], tryHarder: true, tryRotate: true, maxNumberOfSymbols: 60 });
const counts = new Map();
for (const r of res.filter((x) => x.isValid)) {
  const key = `${r.format}: ${r.text.slice(0, 40)}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}
for (const [k, n] of [...counts].sort()) console.log(`${n}× ${k}`);
