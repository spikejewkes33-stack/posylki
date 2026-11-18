import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, normalizeTrack } from '../site/src/parse.js';
import { ScanFilter } from '../site/src/scanfilter.js';
import { createStore } from '../site/src/store.js';
import { buildReport, buildNoteText, excelSheets, pdfDoc } from '../site/src/report.js';
import writeExcelFile from 'write-excel-file/node';
import { unzipSync, strFromU8 } from 'fflate';

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

test('строка без названия товара: «3. ТРЕК»', () => {
  const r = parseNote('Закуп 14.11\nИл\n1. YT7640469574885\n3. 6932554458157');
  assert.equal(r.items[1].n, '3');
  assert.equal(r.items[1].name, '');
  assert.equal(r.items[1].recipient, 'Ил');
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
  const report = buildReport(store.view());
  assert.match(report, /Приехало: 1/);
  assert.match(report, /JT5517710794659/);
  assert.match(report, /СКАНИРОВАЛИ ПОВТОРНО/);
  assert.match(buildNoteText(store.view()), /✅ 11\. Гольф JT9002792964087/);
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

test('фильтр кадров: чужая наклейка с треком и номером заказа — один красный, с треком', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE), 'Список');
  const f = new ScanFilter({ unknownDelayMs: 700 });
  const frame = ['5127196179821070646', 'JT5599887766554', 'JT5599887766554', '收件人 广东省'];
  const events = [];
  for (let t = 0; t <= 3000; t += 100) {
    events.push(...f.feed(frame, t, (c) => store.lookup(c), (c) => store.shapeScore(c)));
  }
  assert.deepEqual(events, [{ type: 'unknown', code: 'JT5599887766554' }]);
});

test('фильтр кадров: чужой трек краснеет только после задержки', () => {
  const f = new ScanFilter({ unknownDelayMs: 700 });
  const lookup = () => null;
  assert.deepEqual(f.feed(['JT5517710794659'], 0, lookup), []);
  assert.deepEqual(f.feed(['JT5517710794659'], 400, lookup), []);
  assert.deepEqual(f.feed(['JT5517710794659'], 800, lookup), [{ type: 'unknown', code: 'JT5517710794659' }]);
  assert.deepEqual(f.feed(['JT5517710794659'], 1200, lookup), []);
});

// ---------- закупки, архив, резервная копия, Excel ----------

const NOTE_2 = `Закуп нояб 10

Сева
1. Носки 0012345678901
2. Шапка JT9002792964087`;

test('старые данные (до закупок с архивом) открываются без потерь', () => {
  // Так данные лежали в телефоне 14.11: закупки без отметки архива.
  const old = {
    lists: [{ id: 'l1', title: 'Закуп нояб 9', addedAt: 1 }],
    items: [
      { id: 'a', listId: 'l1', list: 'Закуп нояб 9', recipient: 'Сева', n: '1', name: 'Чехол', track: '777456551825815', arrivedAt: 5, arrivedBy: 'scan' },
      { id: 'b', listId: 'l1', list: 'Закуп нояб 9', recipient: 'Сева', n: '2', name: 'Бумажник', track: '0012345678901', arrivedAt: null, arrivedBy: null },
    ],
    log: [{ at: 5, code: '777456551825815', track: '777456551825815', result: 'found' }],
    unknown: [{ code: 'JT5517710794659', firstAt: 6, lastAt: 6, count: 1 }],
  };
  const storage = memoryStorage();
  storage.setItem('parcel-scanner:v1', JSON.stringify(old));
  const store = createStore(storage);
  assert.deepEqual(store.state, old);
  assert.deepEqual(store.stats(), { total: 2, arrived: 1, left: 1, percent: 50 });
  assert.equal(store.lookup('0012345678901'), '0012345678901');
  const [p] = store.purchases();
  assert.equal(p.title, 'Закуп нояб 9');
  assert.equal(p.total, 2);
  assert.equal(p.arrived, 1);
  // Любое изменение сохраняет все старые поля.
  store.markByTrack('0012345678901', '0012345678901', 7);
  const saved = JSON.parse(storage.getItem('parcel-scanner:v1'));
  assert.equal(saved.items.length, 2);
  assert.equal(saved.unknown.length, 1);
  assert.equal(saved.log.length, 2);
});

test('архивная закупка не участвует в сверке и не считается на главном', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE), 'Список');
  store.importParsed(parseNote(NOTE_2), 'Список 2');
  const [second, first] = store.purchases(); // новые выше
  assert.equal(first.title, 'Закуп нояб 9');
  assert.equal(second.title, 'Закуп нояб 10');
  assert.equal(store.stats().total, 13);
  // JT9002792964087 есть в обеих: отмечаются обе позиции.
  assert.equal(store.markByTrack('JT9002792964087', 'JT9002792964087').items.length, 2);

  store.setArchived(first.id, true);
  assert.equal(store.stats().total, 2);
  assert.equal(store.lookup('YT0719739925067'), null); // трек только из архивной
  assert.equal(store.lookup('0012345678901'), '0012345678901');
  assert.equal(store.shapeScore('YT0000000000000') < 2, true); // буквы YT только в архивной
  assert.equal(store.view(first.id).items.length, 11); // архивную можно открыть
  assert.equal(store.purchases().at(-1).id, first.id); // архив в конце списка

  store.setArchived(first.id, false);
  assert.equal(store.lookup('YT0719739925067'), 'YT0719739925067');
  assert.equal(store.stats().total, 13);

  store.deleteList(second.id);
  assert.equal(store.state.items.length, 11);
  assert.equal(store.purchases().length, 1);
  assert.equal(store.state.log.length, 1); // история остаётся
});

test('повторный импорт в архивную закупку создаёт новую активную', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE_2), 'Список');
  store.setArchived(store.purchases()[0].id, true);
  assert.deepEqual(store.importParsed(parseNote(NOTE_2), 'Список'), { added: 2, skipped: 0 });
  assert.equal(store.stats().total, 2);
});

test('резервная копия: туда и обратно без потерь, чужой файл не принимается', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE), 'Список');
  store.markByTrack('JT9002792964087', 'JT9002792964087', 100);
  store.addUnknown('JT5517710794659', 101);
  assert.equal(store.needsBackup(), true);
  const file = store.exportBackup(200);
  store.markBackedUp(200);
  assert.equal(store.needsBackup(), false);
  const before = structuredClone(store.state);

  const other = createStore(memoryStorage());
  other.importParsed(parseNote(NOTE_2), 'Другое');
  const info = other.readBackup(file);
  assert.deepEqual({ lists: info.lists, items: info.items, savedAt: info.savedAt }, { lists: 1, items: 11, savedAt: 200 });
  assert.equal(other.state.items.length, 2); // readBackup ничего не меняет
  other.restoreBackup(file);
  assert.deepEqual(other.state, before);
  assert.equal(other.lookup('JT9002792964087'), 'JT9002792964087');
  assert.equal(other.lookup('0012345678901'), null);
  assert.equal(other.needsBackup(), false);

  assert.throws(() => other.readBackup('не json'), /не файл копии/);
  assert.throws(() => other.readBackup('{"a":1}'), /не файл копии/);
  assert.deepEqual(other.state, before);
});

test('Excel: настоящий xlsx, трек записан текстом (ведущие нули целы)', async () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE_2), 'Список');
  store.addUnknown('0098765432100');
  const buffer = await writeExcelFile(excelSheets(store.view())).toBuffer();
  const zip = unzipSync(new Uint8Array(buffer));
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  const strings = strFromU8(zip['xl/sharedStrings.xml'] ?? new Uint8Array());
  const xml = sheet + strings;
  assert.match(xml, /0012345678901/);
  assert.match(xml, /Носки/);
  // Ни одна ячейка с треком не записана числом: <c ...><v>12345678901</v> без t="s"/inlineStr.
  assert.doesNotMatch(sheet, /<v>12345678901<\/v>/);
  const cells = [...sheet.matchAll(/<c ([^>]*)>(.*?)<\/c>/g)];
  assert.ok(cells.length >= 7 + 6 * 2, "шапка и две строки");
  const numeric = cells.filter(([, attrs]) => !/t="(s|inlineStr|str)"/.test(attrs));
  assert.equal(numeric.length, 0, 'на листе «Посылки» нет числовых ячеек');
  assert.ok(zip['xl/worksheets/sheet2.xml'], 'лист «Нет в списке»');
  assert.match(strFromU8(zip['xl/worksheets/sheet2.xml']) + strings, /0098765432100/);
});

test('PDF: в описании документа треки строками и шрифт с кириллицей', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE_2), 'Список');
  const doc = pdfDoc(store.view(), 0);
  assert.equal(doc.defaultStyle.font, 'Roboto');
  const json = JSON.stringify(doc.content);
  assert.match(json, /"0012345678901"/);
  assert.match(json, /Ещё не приехали · 2/);
});

test('PDF: список посылок по закупкам и получателям, сначала не приехавшие, потом приехавшие', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote(NOTE_2), 'Список');
  store.markByTrack('JT9002792964087', 'JT9002792964087', 1000);
  const json = JSON.stringify(pdfDoc(store.view(), 0).content);
  const waiting = json.indexOf('Ещё не приехали · 1');
  const arrived = json.indexOf('Приехали · 1');
  assert.ok(waiting > 0 && arrived > waiting);
  assert.ok(json.indexOf('"Носки"') > waiting && json.indexOf('"Носки"') < arrived);
  assert.ok(json.indexOf('"Шапка"') > arrived);
  assert.match(json, /"Закуп нояб 10"/);
  assert.match(json, /"Сева"/);
  assert.match(json, /"Ожидается"/);
  assert.match(json, /"Приехал \d\d\.\d\d \d\d:\d\d"/);

  // Всё приехало: список всё равно есть.
  store.markByTrack('0012345678901', '0012345678901', 2000);
  const all = JSON.stringify(pdfDoc(store.view(), 0).content);
  assert.match(all, /Всё приехало/);
  assert.match(all, /Приехали · 2/);
  assert.match(all, /"Носки"/);
});

test('одинаковые строки с одним треком не пропадают: 6 позиций, номера подряд, повторный импорт не дублирует', () => {
  const note = 'Закуп Закупка от 17.11.2026\nАнастасия\n1. Пижама женская 79158624862655\n2. Кепка женская 79158929242672\n'
    + '3. Термобельё детское 465856214068314\n4. Термобельё детское 465856214068314\n5. Брюки 465857233364814\n'
    + 'Юлия\n6. Вилки 777462698951021\n';
  const store = createStore(memoryStorage());
  assert.deepEqual(store.importParsed(parseNote(note), 'Список'), { added: 6, skipped: 0 });
  assert.deepEqual(store.state.items.map((i) => i.n), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(store.importParsed(parseNote(note), 'Список'), { added: 0, skipped: 6 });
  assert.equal(store.markByTrack('465856214068314', '465856214068314').items.length, 2);
});

test('два товара под одним треком: один скан отмечает оба, повтор — жёлтый', () => {
  const store = createStore(memoryStorage());
  store.importParsed(parseNote('Закуп\nСева\n1. Носки YT0719739925067\n2. Шапка YT0719739925067\n3. Чехол 777456551825815'), 'Список');
  const first = store.markByTrack('YT0719739925067', 'YT0719739925067', 10);
  assert.equal(first.result, 'found');
  assert.deepEqual(first.items.map((i) => i.name), ['Носки', 'Шапка']);
  assert.ok(first.items.every((i) => i.arrivedAt === 10));
  assert.deepEqual(store.stats(), { total: 3, arrived: 2, left: 1, percent: 66 });
  const again = store.markByTrack('YT0719739925067', 'YT0719739925067', 20);
  assert.equal(again.result, 'repeat');
  assert.equal(again.items.length, 2);
  assert.ok(again.items.every((i) => i.arrivedAt === 10)); // время первой отметки не меняется
});

test('поправка старых данных: товар «1.» без номера становится номером 1 без названия', () => {
  const item = (id, n, name) => ({ id, listId: 'l1', list: 'Закуп', recipient: 'Ил', n, name, track: 'YT7640469574885', arrivedAt: null, arrivedBy: null });
  const old = {
    lists: [{ id: 'l1', title: 'Закуп', addedAt: 1 }],
    items: [item('a', '', '1.'), item('b', '', '12)'), item('c', '', ' 3. '), item('d', '4', 'Штаны'), item('e', '', 'Боди'),
      item('f', '5', '6.'), item('g', '', '2024 г.'), item('h', '', '')],
    log: [],
    unknown: [],
  };
  const storage = memoryStorage();
  storage.setItem('parcel-scanner:v1', JSON.stringify(old));
  const got = createStore(storage).state.items.map((i) => [i.n, i.name]);
  assert.deepEqual(got, [['1', ''], ['12', ''], ['3', ''], ['4', 'Штаны'], ['', 'Боди'], ['5', '6.'], ['', '2024 г.'], ['', '']]);
  // В копии из старой версии то же самое.
  const fromBackup = createStore(memoryStorage()).readBackup(JSON.stringify(old)).data.items;
  assert.deepEqual(fromBackup.map((i) => [i.n, i.name]), got);
});
