import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, normalizeTrack } from '../site/src/parse.js';
import { ScanFilter } from '../site/src/scanfilter.js';
import { createStore } from '../site/src/store.js';
import { buildReport, buildNoteText } from '../site/src/report.js';

// Текст как на скриншоте заметки пользователя (14.11.2026).
const NOTE = `Закуп нояб 9

АВ Наташа Маник
1. Огоньки 3 шт YT0719739925067
2. Зеркала STL130009446991
3. Маши подушки YT764943754855

Макс мама
4. Штаны 9840471421968
5. Боди 777456555909539
6. Кофта 2 шт  9840497611078
9 тапки 777456400022037
11. Гольф JT9002792964087
16. Куртка 79152943055070

Сева
17. Чехол 777456551825815
18. Бумажник YT0720585696371`;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
}

test('разбор заметки: заголовок, получатели, номер, товар, трек', () => {
  const r = parseNote(NOTE);
  assert.equal(r.title, 'Закуп нояб 9');
  assert.equal(r.items.length, 11);
  assert.deepEqual(r.items[0], {
    recipient: 'АВ Наташа Маник', n: '1', name: 'Огоньки 3 шт', track: 'YT0719739925067', checked: false,
    line: '1. Огоньки 3 шт YT0719739925067',
  });
  const tapki = r.items.find((i) => i.track === '777456400022037');
  assert.equal(tapki.n, '9');
  assert.equal(tapki.name, 'тапки');
  assert.equal(tapki.recipient, 'Макс мама');
  assert.equal(r.items.find((i) => i.track === '9840497611078').name, 'Кофта 2 шт');
  assert.equal(r.items.at(-1).recipient, 'Сева');
  assert.equal(r.skipped.length, 0);
});

test('трек остаётся строкой: ведущие нули, буквы, кириллица-двойник', () => {
  const r = parseNote('Сева\n1. Тест 0012345678901\n2. Тест УТ0719739925067');
  assert.equal(r.items[0].track, '0012345678901');
  assert.equal(r.items[1].track, 'YT0719739925067');
  assert.equal(normalizeTrack(' jt 5517710794659 '), 'JT5517710794659');
});

test('Markdown-чек-лист: отмеченные пункты приходят как приехавшие', () => {
  const r = parseNote('Закуп\nСева\n- [x] 1. Чехол 777456551825815\n- [ ] 2. Бумажник YT0720585696371');
  assert.equal(r.items[0].checked, true);
  assert.equal(r.items[0].name, 'Чехол');
  assert.equal(r.items[1].checked, false);
});

test('сверка и статусы: найдено, повтор, нет в списке', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE), 'Список');
  assert.equal(store.stats().total, 11);
  assert.equal(store.lookup('JT9002792964087'), 'JT9002792964087');
  assert.equal(store.lookup('JT9002792964087-1-1-'), 'JT9002792964087'); // код с добавкой
  assert.equal(store.lookup('JT5517710794659'), null);
  assert.equal(store.markByTrack('JT9002792964087', 'JT9002792964087').result, 'found');
  assert.equal(store.markByTrack('JT9002792964087', 'JT9002792964087').result, 'repeat');
  store.addUnknown('JT5517710794659');
  const s = store.stats();
  assert.deepEqual(s, { total: 11, arrived: 1, left: 10, percent: 9 });
  const report = buildReport(store.state);
  assert.match(report, /Приехало: 1/);
  assert.match(report, /JT5517710794659/);
  assert.match(report, /СКАНИРОВАЛИ ПОВТОРНО/);
  assert.match(buildNoteText(store.state), /✅ 11\. Гольф JT9002792964087/);
});

test('повторный импорт той же заметки ничего не дублирует', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE), 'Список');
  const again = store.importParsed(parseNote(NOTE), 'Список');
  assert.deepEqual(again, { added: 0, skipped: 11 });
});

test('фильтр кадров: код в кадре не срабатывает повторно, служебные коды молчат', () => {
  const f = new ScanFilter();
  const lookup = (c) => (c === 'YT7640469574885' ? c : null);
  // Наклейка YTO: трек (горизонтальный и вертикальный) + QR с адресом + номер заказа.
  const frame = ['YT7640469574885', 'YT7640469574885', 'https://example/广东省佛山市', '5127196179821070646'];
  assert.deepEqual(f.feed(frame, 0, lookup), [{ type: 'match', code: 'YT7640469574885', track: 'YT7640469574885' }]);
  assert.deepEqual(f.feed(frame, 100, lookup), []);
  // Коробка 3 секунды в кадре (кадр каждые 100 мс): молчим, номер заказа не краснеет.
  for (let t = 200; t <= 3000; t += 100) assert.deepEqual(f.feed(frame, t, lookup), []);
  // Коробка ушла из кадра и вернулась: снова событие (будет жёлтый «повтор»).
  assert.equal(f.feed(frame, 6000, lookup).length, 1);
});

test('фильтр кадров: чужая коробка сразу после нашей всё равно краснеет', () => {
  const f = new ScanFilter({ unknownDelayMs: 700 });
  const lookup = (c) => (c === 'YT0719739925067' ? c : null);
  const events = [];
  for (let t = 0; t <= 1000; t += 100) events.push(...f.feed(['YT0719739925067'], t, lookup));
  for (let t = 1100; t <= 2500; t += 100) events.push(...f.feed(['JT5517710794659'], t, lookup));
  assert.deepEqual(events.map((e) => e.type), ['match', 'unknown']);
});

test('фильтр кадров: чужой трек краснеет только после задержки', () => {
  const f = new ScanFilter({ unknownDelayMs: 700 });
  const lookup = () => null;
  assert.deepEqual(f.feed(['JT5517710794659'], 0, lookup), []);
  assert.deepEqual(f.feed(['JT5517710794659'], 400, lookup), []);
  assert.deepEqual(f.feed(['JT5517710794659'], 800, lookup), [{ type: 'unknown', code: 'JT5517710794659' }]);
  assert.deepEqual(f.feed(['JT5517710794659'], 1200, lookup), []);
});
