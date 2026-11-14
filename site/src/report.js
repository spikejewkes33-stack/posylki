// Отчёт о приёмке и текст для вставки обратно в заметку.

function fmtTime(ts) {
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

/** Данные отчёта: и для экрана, и для текста. */
export function reportData(state) {
  const waiting = state.items.filter((it) => !it.arrivedAt);
  const counts = new Map();
  for (const e of state.log) {
    if (e.result === 'repeat') counts.set(e.track, (counts.get(e.track) || 0) + 1);
  }
  const byTrack = new Map(state.items.map((it) => [it.track, it]));
  return {
    total: state.items.length,
    arrived: state.items.length - waiting.length,
    waiting,
    unknown: state.unknown,
    repeats: [...counts].map(([track, count]) => ({ track, count, item: byTrack.get(track) })),
  };
}

export function buildReport(state, now = Date.now()) {
  const d = reportData(state);
  const out = [];
  out.push(`ОТЧЁТ О ПРИЁМКЕ · ${fmtTime(now)}`);
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

// Таблица для Excel (CSV, «;», с BOM). Трек записан как ="…", чтобы Excel не превратил его в число.
export function buildCsv(state) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const text = (v) => `"=""${String(v).replace(/"/g, '')}"""`;
  const rows = [['Закупка', 'Получатель', '№', 'Товар', 'Трек-номер', 'Статус', 'Когда'].map(cell).join(';')];
  for (const it of state.items) {
    rows.push(
      [cell(it.list), cell(it.recipient), cell(it.n), cell(it.name), text(it.track),
        cell(it.arrivedAt ? 'Приехал' : 'Ожидается'), cell(it.arrivedAt ? fmtTime(it.arrivedAt) : '')].join(';'),
    );
  }
  for (const u of state.unknown) {
    rows.push(['', '', '', cell('НЕТ В СПИСКЕ'), text(u.code), cell(`Сканировали ${u.count} раз`), cell(fmtTime(u.lastAt))].join(';'));
  }
  return '﻿' + rows.join('\r\n');
}

// Текст заметки с отметками: «✅» у приехавших. Можно вставить в новую заметку.
export function buildNoteText(state) {
  const out = [];
  for (const [list, recipients] of groupItems(state.items)) {
    out.push(list, '');
    for (const [recipient, items] of recipients) {
      if (recipient) out.push(recipient);
      items.forEach((it) => out.push(`${it.arrivedAt ? '✅' : '⬜️'} ${itemLine(it)}`));
      out.push('');
    }
  }
  return out.join('\n').trim();
}
