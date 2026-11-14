// Кладёт библиотеку распознавания рядом с приложением (чтобы работало без интернета).
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}node_modules/zxing-wasm/dist/`;
mkdirSync(`${root}site/vendor`, { recursive: true });
copyFileSync(`${dist}iife/reader/index.js`, `${root}site/vendor/zxing-reader.js`);
copyFileSync(`${dist}reader/zxing_reader.wasm`, `${root}site/vendor/zxing_reader.wasm`);
console.log('vendor: zxing-wasm скопирован');
