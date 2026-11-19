// Отчёт о приёмке: текст, таблица Excel, PDF и текст для вставки обратно в заметку.
// Всё строится из «вида» { title, items, unknown, log }: все активные закупки или одна (store.view).

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Группирует позиции: закупка → получатель → позиции, в исходном порядке.
export function groupItems(items) {
  const lists = new Map();
  for (const it of items) {
    if (!lists.has(it.list)) lists.set(it.list, new Map());
    const recipients = lists.get(it.list);
    if (!recipients.has(it.recipient)) recipients.set(it.recipient, []);
    recipients.get(it.recipient).push(it);
  }
  return lists;
}

function itemLine(it) {
  return [it.n ? `${it.n}.` : '', it.name, it.track].filter(Boolean).join(' ');
}

/** Данные отчёта: и для экрана, и для текста. Повторы считаются только по трекам этого вида. */
export function reportData(view) {
  const waiting = view.items.filter((it) => !it.arrivedAt);
  const byTrack = new Map(view.items.map((it) => [it.track, it]));
  const counts = new Map();
  // Сканирование до 20.11 не знает закупку (listId) — считается везде, где есть трек.
  const own = (e) => view.id === 'all' || !e.listId || e.listId === view.id;
  for (const e of view.log) {
    if (e.result === 'repeat' && byTrack.has(e.track) && own(e)) counts.set(e.track, (counts.get(e.track) || 0) + 1);
  }
  return {
    total: view.items.length,
    arrived: view.items.length - waiting.length,
    waiting,
    unknown: view.unknown,
    repeats: [...counts].map(([track, count]) => ({ track, count, item: byTrack.get(track) })),
  };
}

export function buildReport(view, now = Date.now()) {
  const d = reportData(view);
  const out = [];
  out.push(`ОТЧЁТ О ПРИЁМКЕ${view.title ? ` · ${view.title}` : ''} · ${fmtTime(now)}`);
  out.push('');
  out.push(`Всего в списке: ${d.total}`);
  out.push(`Приехало: ${d.arrived}`);
  out.push(`Осталось: ${d.waiting.length}`);
  out.push(`Нет в списке: ${d.unknown.length}`);
  out.push(`Сканировали повторно: ${d.repeats.length}`);

  if (d.waiting.length) {
    out.push('', 'ЕЩЁ НЕ ПРИЕХАЛИ:');
    for (const [list, recipients] of groupItems(d.waiting)) {
      out.push(`— ${list}`);
      for (const [recipient, items] of recipients) {
        if (recipient) out.push(`  ${recipient}`);
        items.forEach((it) => out.push(`    ${itemLine(it)}`));
      }
    }
  }
  if (d.unknown.length) {
    out.push('', 'ОТСКАНИРОВАНЫ, НО НЕТ В СПИСКЕ:');
    d.unknown.forEach((u) => out.push(`  ${u.code}${u.count > 1 ? ` (×${u.count})` : ''}`));
  }
  if (d.repeats.length) {
    out.push('', 'СКАНИРОВАЛИ ПОВТОРНО:');
    for (const { track, count, item } of d.repeats) {
      const about = item ? [itemLine({ ...item, track: '' }), item.recipient].filter(Boolean).join(' · ') : '';
      out.push(`  ${track}${about ? ` · ${about}` : ''} (повторов: ${count})`);
    }
  }
  return out.join('\n');
}

// Текст заметки с отметками: «✅» у приехавших. Можно вставить в новую заметку.
export function buildNoteText(view) {
  const out = [];
  for (const [list, recipients] of groupItems(view.items)) {
    out.push(list, '');
    for (const [recipient, items] of recipients) {
      if (recipient) out.push(recipient);
      items.forEach((it) => out.push(`${it.arrivedAt ? '✅' : '⬜️'} ${itemLine(it)}`));
      out.push('');
    }
  }
  return out.join('\n').trim();
}

// ---------- Excel ----------
// Листы для write-excel-file. Всё, кроме счётчика, — текст (type: String): у трека целы ведущие нули и буквы.
const head = (value) => ({ value, fontWeight: 'bold' });
const text = (value) => ({ type: String, value: String(value ?? '') });

export function excelSheets(view) {
  const rows = [['Закупка', 'Получатель', '№', 'Товар', 'Трек-номер', 'Статус', 'Когда'].map(head)];
  for (const it of view.items) {
    rows.push([
      text(it.list), text(it.recipient), text(it.n), text(it.name), text(it.track),
      text(it.arrivedAt ? 'Приехал' : 'Ожидается'), text(it.arrivedAt ? fmtTime(it.arrivedAt) : ''),
    ]);
  }
  const sheets = [{
    data: rows,
    sheet: 'Посылки',
    columns: [{ width: 18 }, { width: 20 }, { width: 5 }, { width: 28 }, { width: 22 }, { width: 11 }, { width: 12 }],
    stickyRowsCount: 1,
  }];
  if (view.unknown.length) {
    const unknown = [['Трек-номер', 'Сколько раз', 'Первый раз', 'Последний раз'].map(head)];
    for (const u of view.unknown) {
      unknown.push([text(u.code), { type: Number, value: u.count }, text(fmtTime(u.firstAt)), text(fmtTime(u.lastAt))]);
    }
    sheets.push({ data: unknown, sheet: 'Нет в списке', columns: [{ width: 24 }, { width: 12 }, { width: 13 }, { width: 13 }], stickyRowsCount: 1 });
  }
  return sheets;
}

// ---------- PDF ----------
// Описание документа для pdfmake. Шрифт Roboto с кириллицей подключает приложение (src/files.js).
function table(header, rows, widths) {
  return {
    table: { headerRows: 1, widths, body: [header.map((t) => ({ text: t, bold: true })), ...rows] },
    layout: 'lightHorizontalLines',
    margin: [0, 4, 0, 14],
  };
}

const str = (v) => String(v ?? '');

// Список посылок: закупка → получатель → строки «№, товар, трек, статус».
function itemsTable(items) {
  const group = (text, extra) => [{ text, colSpan: 4, bold: true, ...extra }, {}, {}, {}];
  const body = [['№', 'Товар', 'Трек-номер', 'Статус'].map((t) => ({ text: t, bold: true }))];
  for (const [list, recipients] of groupItems(items)) {
    body.push(group(list, { fontSize: 11, fillColor: '#eef1f5', margin: [0, 3, 0, 3] }));
    for (const [recipient, rows] of recipients) {
      if (recipient) body.push(group(recipient, { margin: [0, 3, 0, 0] }));
      for (const it of rows) {
        const status = it.arrivedAt
          ? { text: `Приехал ${fmtTime(it.arrivedAt)}`, color: '#188a42' }
          : { text: 'Ожидается', color: '#9a7400' };
        body.push([str(it.n), str(it.name), str(it.track), status]);
      }
    }
  }
  return {
    table: { headerRows: 1, dontBreakRows: true, widths: ['auto', '*', 'auto', 'auto'], body },
    layout: 'lightHorizontalLines',
    margin: [0, 4, 0, 14],
  };
}

export function pdfDoc(view, now = Date.now()) {
  const d = reportData(view);
  const content = [
    { text: `Отчёт о приёмке${view.title ? ` · ${view.title}` : ''}`, fontSize: 16, bold: true },
    { text: fmtTime(now), color: '#646a73', margin: [0, 2, 0, 10] },
    table(
      ['Всего', 'Приехало', 'Осталось', 'Нет в списке', 'Повторно'],
      [[d.total, d.arrived, d.waiting.length, d.unknown.length, d.repeats.length].map((n) => ({ text: str(n), fontSize: 14 }))],
      ['*', '*', '*', '*', '*'],
    ),
  ];
  if (d.waiting.length) {
    content.push({ text: `Ещё не приехали · ${d.waiting.length}`, fontSize: 13, bold: true });
    content.push(itemsTable(d.waiting));
  } else if (d.total) {
    content.push({ text: 'Всё приехало', fontSize: 13, bold: true, color: '#188a42', margin: [0, 0, 0, 14] });
  }
  const arrived = view.items.filter((it) => it.arrivedAt);
  if (arrived.length) {
    content.push({ text: `Приехали · ${arrived.length}`, fontSize: 13, bold: true });
    content.push(itemsTable(arrived));
  }
  if (d.unknown.length) {
    content.push({ text: `Отсканированы, но нет в списке · ${d.unknown.length}`, fontSize: 13, bold: true });
    content.push(table(['Трек-номер', 'Сколько раз', 'Последний раз'], d.unknown.map((u) => [u.code, str(u.count), fmtTime(u.lastAt)]), ['*', 'auto', 'auto']));
  }
  if (d.repeats.length) {
    content.push({ text: `Сканировали повторно · ${d.repeats.length}`, fontSize: 13, bold: true });
    content.push(table(
      ['Трек-номер', 'Товар', 'Получатель', 'Повторов'],
      d.repeats.map(({ track, count, item }) => [track, item?.name, item?.recipient, count].map(str)),
      ['auto', '*', 'auto', 'auto'],
    ));
  }
  return {
    pageSize: 'A4',
    pageMargins: [32, 32, 32, 40],
    defaultStyle: { font: 'Roboto', fontSize: 9 },
    info: { title: 'Отчёт о приёмке' },
    content,
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: '#646a73' }),
  };
}
