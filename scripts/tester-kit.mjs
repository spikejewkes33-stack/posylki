// Собирает папку для тестировщика: тестовый список, штрихкоды «коробок», инструкцию и вопросы.
// Запуск: node scripts/tester-kit.mjs <папка>. Затем HTML печатается в PDF (Edge headless):
//   msedge --headless=new --no-pdf-header-footer --print-to-pdf=<папка>/Posylki-test.pdf file:///<html>
// Проверка штрихкодов: снимок страницы (--screenshot) и node scripts/check-kit.mjs <снимок.png>.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareZXingModule, writeBarcode } from 'zxing-wasm/writer';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('Укажи папку: node scripts/tester-kit.mjs <папка>');
mkdirSync(out, { recursive: true });

prepareZXingModule({
  overrides: { wasmBinary: readFileSync(`${root}node_modules/zxing-wasm/dist/writer/zxing_writer.wasm`) },
  fireImmediately: true,
});

const APP_URL = 'https://spikejewkes33-stack.github.io/posylki/';

// Выдуманные данные в форматах настоящих треков (YT, STL, JT, 13–15 цифр). Строка «8 тапки» без точки нарочно.
const NOTE = `Тест закуп 1

Анна
1. Платье 3 шт YT0812345678901
2. Сумка STL240011223344
3. Подушки YT812233445566

Иван мама
4. Брюки 9840512345678
5. Боди 777456112233445
6. Кофта 2 шт 9840587654321
7. Свитер 465791122334455
8 тапки 777456998877665
9. Гольф JT9001234567890
10. Куртка 79151234567890

Олег
11. Чехол 777456223344556
12. Кошелёк YT0798765432101`;

const ORDER = '5127196179821070646';
const BOXES = [
  { n: 1, track: 'YT0812345678901', full: true, expect: 'ЗЕЛЁНЫЙ: «1. Платье 3 шт», Анна. Красного быть не должно, хотя на наклейке 4 кода.' },
  { n: 2, track: '9840512345678', expect: 'ЗЕЛЁНЫЙ: «4. Брюки», Иван мама' },
  { n: 3, track: 'JT9001234567890', expect: 'ЗЕЛЁНЫЙ: «9. Гольф», Иван мама' },
  { n: 4, track: '777456998877665', expect: 'ЗЕЛЁНЫЙ: «8. тапки», Иван мама' },
  { n: 5, track: 'YT0798765432101', expect: 'ЗЕЛЁНЫЙ: «12. Кошелёк», Олег' },
  { n: 6, track: 'JT5599887766554', full: true, expect: 'КРАСНЫЙ «Нет в списке» один раз (номер JT5599887766554)' },
  { n: 7, track: '465799999999999', expect: 'КРАСНЫЙ «Нет в списке» (номер 465799999999999)' },
  { n: 8, track: '79151234567890', qr: true, expect: 'ЗЕЛЁНЫЙ: «10. Куртка», Иван мама (трек в QR-коде)' },
];

async function svg(text, format, rotate = 0) {
  const r = await writeBarcode(text, { format, scale: 0, withQuietZones: true, rotate });
  if (r.error) throw new Error(`${text}: ${r.error}`);
  return `data:image/svg+xml;base64,${Buffer.from(r.svg).toString('base64')}`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function boxHtml(b) {
  const main = b.qr ? await svg(b.track, 'QRCode') : await svg(b.track, 'Code128');
  let extra = '';
  if (b.full) {
    extra = `
      <img class="side" src="${await svg(b.track, 'Code128', 90)}" alt="">
      <div class="label-row"><img class="qr" src="${await svg('收件人: 测试 ****4329 广东省佛山市 测试仓库 13号 (EL80000)', 'QRCode')}" alt="">
      <div><img class="order" src="${await svg(ORDER, 'Code128')}" alt=""><p class="digits small">${ORDER}</p></div></div>`;
  }
  return `<section class="box ${b.full ? 'full' : ''}">
    <p class="box-n">Коробка ${b.n}</p>
    <div class="label">
      <p class="sort">100 S181-00 023</p>
      <img class="${b.qr ? 'qr-main' : 'main'}" src="${main}" alt="">
      <p class="digits">${b.track}</p>${extra}
    </div>
    <p class="expect">Ожидается: ${esc(b.expect)}</p>
  </section>`;
}

const QUESTIONS = [
  ['Телефон', [
    'Модель iPhone и версия iOS (Настройки → Основные → Об этом устройстве).',
  ]],
  ['Установка', [
    'Получилось открыть ссылку в Safari и добавить на экран «Домой»? Иконка и название «Посылки» на месте?',
    'Включи авиарежим и открой приложение с иконки: открывается без интернета?',
  ]],
  ['Список из Заметок', [
    'Сколько посылок показало после вставки? Должно быть 12: Анна 3, Иван мама 7, Олег 2.',
    'В «Проверить разбор» у каждой строки верный трек? Строка «8 тапки» (без точки) разобралась?',
    'Если делал заметку чек-листом и отметил один пункт галочкой: после вставки он стал «Приехал»? (Просто напиши, что увидел.)',
  ]],
  ['Сканирование', [
    'Камера спросила разрешение? При следующем запуске с иконки спрашивает снова?',
    'Сколько проходит от наведения до цвета: сразу / около 1 с / 2–3 с / дольше?',
    'Цвета совпали с «Ожидается» у каждой коробки? Если нет — номер коробки и что показало.',
    'Коробка 1 второй раз (убрать и снова навести): показало ЖЁЛТЫЙ «Уже сканировали»?',
    'Пока держишь одну коробку перед камерой 5 секунд, результат не повторяется?',
    'На коробках 1 и 6 четыре кода. Были лишние красные экраны?',
    'Был звук? А в беззвучном режиме (переключатель сбоку)?',
    'Была вибрация при результате?',
    'Кнопка 📷: какие камеры в списке? С какой вблизи (10–20 см) читается лучше?',
    'Появилась кнопка фонарика 🔦? Работает?',
    '«Ввести номер» → STL240011223344: показало ЗЕЛЁНЫЙ «2. Сумка»?',
  ]],
  ['Списки и отчёт', [
    'Цифры на главном экране после всего теста. Ожидается: всего 12, приехало 7, осталось 5, не найдены 2.',
    'Поиск по последним 4 цифрам трека находит посылку? Нажать на посылку → «Сбросить отметку» работает?',
    '«Отчёт» → «Скопировать отчёт» и «Текст для заметки ✅»: вставляется в Заметки нормально?',
    '«Таблица для Excel»: файл открылся? Треки целиком, а не 7,77E+14?',
  ]],
  ['Удобство', [
    'Что было неудобно, мелко или непонятно? Где задумался, куда нажать?',
    'Чего не хватает? Что бы добавил или убрал?',
    'Пришли скриншоты экранов, где что-то пошло не так.',
  ]],
];

function questionsText() {
  let n = 0;
  return QUESTIONS.map(([title, qs]) => `${title.toUpperCase()}\n${qs.map((q) => `${++n}. ${q}\n   Ответ: `).join('\n')}`).join('\n\n');
}

function questionsHtml() {
  let n = 0;
  return QUESTIONS.map(([title, qs]) => `<h3>${title}</h3><ol start="${n + 1}">${qs.map((q) => (n++, `<li>${esc(q)}</li>`)).join('')}</ol>`).join('');
}

const STEPS = `
<ol>
  <li>Открой ссылку <b>в Safari</b> (не внутри Telegram): <b>${APP_URL}</b><br>
    В Telegram ссылку можно зажать → «Открыть в Safari».</li>
  <li>Внизу «Поделиться» (квадрат со стрелкой) → «На экран "Домой"» → «Добавить». Дальше запускай с иконки «Посылки».</li>
  <li>Создай заметку в «Заметках» и вставь в неё тестовый список (он ниже и в файле «Тестовый список.txt»).
    По желанию сделай строки с товарами чек-листом, как в настоящих заметках.</li>
  <li>В заметке: «Выбрать все» → «Скопировать». В приложении: «＋ Добавить список» → «Вставить из буфера» → «Добавить».</li>
  <li>Открой страницы с коробками на компьютере или втором телефоне (или распечатай).
    В приложении «СКАНИРОВАТЬ» и наводи камеру на коробки 1–8 по очереди, не закрывая камеру.</li>
  <li>Ответь на вопросы (можно номерами прямо в Telegram) и пришли скриншоты.</li>
</ol>`;

const boxes = (await Promise.all(BOXES.map(boxHtml))).join('\n');

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Посылки — тест</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #15171a; font-size: 12pt; line-height: 1.45; }
  h1 { font-size: 22pt; margin: 0 0 4px; } h2 { font-size: 15pt; margin: 18px 0 6px; border-bottom: 2px solid #1f5fd6; padding-bottom: 3px; }
  h3 { font-size: 12pt; margin: 12px 0 2px; color: #1f5fd6; }
  .lead { color: #444; } li { margin: 3px 0; }
  .colors span { display: inline-block; padding: 2px 8px; border-radius: 6px; color: #fff; font-weight: 700; }
  pre { background: #f4f5f7; padding: 10px 12px; border-radius: 8px; font-size: 11pt; white-space: pre-wrap; }
  .page { page-break-before: always; }
  .box { page-break-inside: avoid; margin: 0 0 10mm; }
  .box-n { font-size: 16pt; font-weight: 700; margin: 0 0 4px; }
  .label { position: relative; border: 2px solid #222; border-radius: 6px; padding: 8px 12px; width: 150mm; background: #fff; }
  .box.full .label { padding-right: 34mm; }
  .sort { font-size: 18pt; font-weight: 700; margin: 0; font-family: Consolas, monospace; }
  .main { width: 110mm; height: 26mm; display: block; image-rendering: pixelated; }
  .qr-main { width: 38mm; height: 38mm; display: block; }
  .digits { font-family: Consolas, monospace; font-size: 13pt; margin: 2px 0 6px; }
  .small { font-size: 10pt; }
  .side { position: absolute; right: 6mm; top: 6mm; width: 22mm; height: calc(100% - 12mm); object-fit: contain; }
  .label-row { display: flex; gap: 8mm; align-items: center; }
  .qr { width: 26mm; height: 26mm; } .order { width: 88mm; height: 16mm; display: block; }
  .expect { margin: 4px 0 0; font-weight: 600; }
</style></head><body>
<h1>«Посылки» — тест приложения</h1>
<p class="lead">Приложение для iPhone: камера читает штрихкод на коробке, приложение само сверяет трек-номер со списком посылок из «Заметок» и отмечает «Приехал».
Сделано для приёмки сотен посылок из Китая подряд, не возвращаясь на главный экран.</p>
<p class="colors"><span style="background:#188a42">ЗЕЛЁНЫЙ</span> есть в списке, отмечен «Приехал» ·
<span style="background:#f2b705;color:#1d1a00">ЖЁЛТЫЙ</span> уже сканировали ·
<span style="background:#c9302c">КРАСНЫЙ</span> нет в списке</p>
<p>Ссылка: <b>${APP_URL}</b><br>Всё хранится только в телефоне, никуда не отправляется. Работает и без интернета. Тест займёт 10–15 минут.</p>

<h2>Как проверить</h2>${STEPS}

<h2>Тестовый список (выдуманные данные)</h2>
<pre>${esc(NOTE)}</pre>

<h2>Вопросы</h2>
<p>Отвечай номерами, коротко. «Не понял» и «не проверял» тоже ответы.</p>
${questionsHtml()}

<div class="page"></div>
<h2>Коробки для сканирования</h2>
<p>Открой эти страницы на экране компьютера или распечатай. Наводи камеру по очереди, камеру не закрывай. Потом коробку 1 ещё раз — должен быть жёлтый.</p>
${boxes}
</body></html>`;

// HTML — промежуточный файл для печати в PDF, в папку тестировщика не кладём.
const htmlPath = join(tmpdir(), 'posylki-kit.html');
writeFileSync(htmlPath, html);
console.log('html:', htmlPath);
writeFileSync(`${out}/Тестовый список.txt`, `${NOTE}\n`);
writeFileSync(`${out}/Вопросы тестировщику.txt`, `«Посылки» — вопросы после теста\nСсылка: ${APP_URL}\n\n${questionsText()}\n`);
writeFileSync(
  `${out}/Сообщение в Телеграм.txt`,
  `Привет! Протестируй, пожалуйста, моё приложение для iPhone «Посылки» — сканер приёмки посылок по штрихкоду.

Ссылка (открыть в Safari): ${APP_URL}

В PDF всё по шагам: как поставить на экран «Домой», тестовый список, коробки со штрихкодами для сканирования (открой их на компьютере или распечатай) и вопросы. Займёт 10–15 минут.
Ответы можно номерами прямо сюда, плюс скриншоты, если что-то не так. Спасибо!
`,
);
console.log('готово:', out);
