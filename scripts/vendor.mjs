// Кладёт библиотеки рядом с приложением (чтобы работало без интернета).
// Распознавание: zxing-wasm. Excel: write-excel-file. PDF: pdfmake и шрифт Roboto с кириллицей.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = `${root}node_modules/`;
const out = `${root}site/vendor/`;
mkdirSync(out, { recursive: true });
const files = [
  ['zxing-wasm/dist/iife/reader/index.js', 'zxing-reader.js'],
  ['zxing-wasm/dist/reader/zxing_reader.wasm', 'zxing_reader.wasm'],
  ['write-excel-file/bundle/write-excel-file.min.js', 'write-excel-file.min.js'],
  ['pdfmake/build/pdfmake.min.js', 'pdfmake.min.js'],
  ['pdfmake/build/fonts/Roboto/Roboto-Regular.ttf', 'Roboto-Regular.ttf'],
  ['pdfmake/build/fonts/Roboto/Roboto-Medium.ttf', 'Roboto-Medium.ttf'],
];
for (const [from, to] of files) copyFileSync(mod + from, out + to);
console.log(`vendor: скопировано файлов: ${files.length}`);
