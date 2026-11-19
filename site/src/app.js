// Экраны приложения. Каждая закупка — отдельно: открыл её и работаешь только с ней.
// Маршрут в адресе: #/ (активные закупки), #/purchase/<id|all>, #/scan/<id>, #/list/all|arrived|waiting[/id],
// #/unknown[/id], #/report[/id], #/lists (закрытые закупки), #/import, #/history, #/backup
import { parseNote } from './parse.js';
import { createStore } from './store.js';
import { ScanFilter } from './scanfilter.js';
import { buildReport, buildNoteText, groupItems, reportData, fmtTime } from './report.js';
import { fmtDate } from './dates.js';
import { makeXlsx, makePdf, shareFile, preloadExports, XLSX_TYPE } from './files.js';
import { openCamera, closeCamera, createScanLoop, decodeImage, torchControl, zoomControl, listCameras } from './scanner.js';
import { unlockAudio, signal, soundOn, setSound } from './feedback.js';

const store = createStore();
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');

// ---------- помощники ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = app) => root.querySelector(sel);
const go = (hash) => (location.hash = hash);

const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const purchaseHash = (id) => `#/purchase/${encodeURIComponent(id)}`;

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

async function copyText(text, done = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Не удалось скопировать');
  }
}

// Отдаёт файл через «Поделиться». Если телефон просит новое нажатие (файл собирался долго), показывает кнопку.
async function deliver(name, type, content) {
  const r = await shareFile(name, type, content);
  if (r !== 'blocked') return r;
  return new Promise((resolve) => {
    sheet.innerHTML = `<form method="dialog" class="sheet"><p><b>Файл готов</b></p><p class="mono small">${esc(name)}</p>
      <button class="primary" type="button" id="send">Отправить</button><button class="btn" value="">Отмена</button></form>`;
    sheet.onclose = () => resolve('cancelled');
    sheet.querySelector('#send').onclick = () => {
      sheet.onclose = null;
      resolve(shareFile(name, type, content)); // внутри нажатия: «Поделиться» откроется
      sheet.close();
    };
    sheet.returnValue = '';
    sheet.showModal();
  });
}

async function saveBackup() {
  const r = await deliver(`posylki-kopiya-${today()}.json`, 'application/json', store.exportBackup());
  if (r === 'shared' || r === 'downloaded') {
    store.markBackedUp();
    sheet.onclose = null;
    sheet.innerHTML = `<form method="dialog" class="sheet"><p class="ok-text">Копия сохранена ✅</p>
      <p>Это файл для восстановления, открывать его не нужно: внутри служебный текст.</p>
      <p>Чтобы вернуть данные: «Резервная копия» → «Вернуть данные из файла».</p>
      <button class="primary" value="">Понятно</button></form>`;
    sheet.returnValue = '';
    sheet.showModal();
  }
  return r;
}

function header(title, back = '#/') {
  return `<header class="bar"><a class="back" href="${back}" aria-label="Назад">‹ Назад</a><h1>${esc(title)}</h1></header>`;
}

function itemTitle(it) {
  return `${it.n ? `${esc(it.n)}. ` : ''}${esc(it.name || 'Без названия')}`;
}

// ---------- главный экран ----------
function renderHome() {
  const all = store.purchases();
  const active = all.filter((p) => !p.archivedAt);
  const closed = all.length - active.length;
  app.innerHTML = `
    <header class="app-head">
      <h1>📦 Посылки</h1>
      <p>Приёмка посылок по штрихкоду</p>
    </header>
    ${active.length
      ? active.map((p) => purchaseCard(p)).join('')
      : `<p class="hint">Открой заметку со списком, нажми «Выбрать все» → «Скопировать», потом здесь «Добавить список».</p>`}
    <a class="btn wide" href="#/import">＋ Добавить список</a>
    <div class="row">
      <a class="btn" href="#/lists">Закрытые закупки${closed ? ` · ${closed}` : ''}</a>
      <a class="btn" href="#/history">История</a>
    </div>
    <div class="row links">
      <a class="link" href="#/backup">Резервная копия</a>
      <button class="link danger" id="clear">Очистить всё</button>
    </div>
    ${active.length > 1 ? '<a class="link" href="#/purchase/all">Все активные закупки вместе</a>' : ''}`;
  $('#clear').onclick = () => {
    if (!store.state.items.length && !store.state.unknown.length) return;
    if (confirm('Удалить все закупки, отметки и историю? Сначала лучше сохранить резервную копию.')) {
      store.clearAll();
      renderHome();
    }
  };
}

// ---------- добавление списка ----------
function renderImport() {
  app.innerHTML = `
    ${header('Добавить список')}
    <p class="hint">Вставь текст заметки целиком: название закупки, имена получателей и строки вида «4. Штаны 9840471421968». Можно и один номер.</p>
    <div class="row">
      <button class="btn" id="paste">Вставить из буфера</button>
      <label class="btn">Из файла<input type="file" id="file" accept=".txt,.md,.csv,text/plain" hidden></label>
    </div>
    <textarea id="text" rows="10" placeholder="Закуп нояб 9&#10;&#10;Макс мама&#10;4. Штаны 9840471421968"></textarea>
    <label class="field">Название списка<input id="title" placeholder="например, Закуп нояб 9"></label>
    <div id="preview"></div>
    <button class="primary" id="add" disabled>Добавить</button>`;
  const text = $('#text');
  const title = $('#title');
  let titleTouched = false;

  const update = () => {
    const parsed = parseNote(text.value);
    if (!titleTouched) title.value = parsed.title;
    const groups = new Map();
    parsed.items.forEach((it) => groups.set(it.recipient || 'Без получателя', (groups.get(it.recipient || 'Без получателя') || 0) + 1));
    const checked = parsed.items.filter((it) => it.checked).length;
    $('#preview').innerHTML = parsed.items.length
      ? `<div class="card"><b>Найдено посылок: ${parsed.items.length}</b>
          <ul>${[...groups].map(([r, n]) => `<li>${esc(r)}: ${n}</li>`).join('')}</ul>
          ${checked ? `<p>Уже отмечены в заметке: ${checked} (будут «Приехал»)</p>` : ''}
          ${parsed.skipped.length ? `<p class="warn">Не понял строки:<br>${parsed.skipped.map(esc).join('<br>')}</p>` : ''}
          <details><summary>Проверить разбор</summary><ol class="mono small">${parsed.items
            .map((it) => `<li>${esc(it.name)} → <b>${esc(it.track)}</b></li>`)
            .join('')}</ol></details></div>`
      : text.value.trim()
        ? '<p class="warn">Не нашёл ни одного трек-номера. Номер должен быть в строке целиком, без пробелов внутри.</p>'
        : '';
    $('#add').disabled = !parsed.items.length;
  };

  text.oninput = update;
  title.oninput = () => (titleTouched = true);
  $('#paste').onclick = async () => {
    try {
      text.value = await navigator.clipboard.readText();
      update();
    } catch {
      toast('Нажми в поле и выбери «Вставить»');
      text.focus();
    }
  };
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) {
      text.value = await f.text();
      update();
    }
  };
  $('#add').onclick = async () => {
    const parsed = parseNote(text.value);
    parsed.title = title.value.trim();
    const { added, skipped } = store.importParsed(parsed, `Список от ${fmtTime(Date.now())}`);
    navigator.storage?.persist?.().catch(() => {});
    toast(`Добавлено: ${added}${skipped ? `, уже были: ${skipped}` : ''}`);
    go(added ? purchaseHash(store.state.lists.at(-1).id) : '#/');
  };
}

// ---------- списки ----------
const LIST_TITLES = { all: 'Весь список', arrived: 'Приехали', waiting: 'Ожидаются' };

function renderList(kind, listId) {
  const view = store.view(listId);
  app.innerHTML = `
    ${header(LIST_TITLES[kind] || 'Список', listId ? purchaseHash(listId) : '#/')}
    ${view.title ? `<p class="hint">${esc(view.title)}</p>` : ''}
    <input class="search" id="q" type="search" placeholder="Поиск: номер, товар, получатель" autocomplete="off">
    <div id="items"></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toUpperCase().replace(/\s+/g, '');
    const qText = $('#q').value.trim().toLowerCase();
    const items = store.view(listId).items.filter((it) => {
      if (kind === 'arrived' && !it.arrivedAt) return false;
      if (kind === 'waiting' && it.arrivedAt) return false;
      if (!qText) return true;
      return it.track.includes(q) || `${it.name} ${it.recipient} ${it.list}`.toLowerCase().includes(qText);
    });
    if (!items.length) {
      $('#items').innerHTML = `<p class="hint">${qText ? 'Ничего не найдено.' : 'Пусто.'}</p>`;
      return;
    }
    let html = '';
    for (const [list, recipients] of groupItems(items)) {
      html += `<h2>${esc(list)}</h2>`;
      for (const [recipient, rows] of recipients) {
        if (recipient) html += `<h3>${esc(recipient)}</h3>`;
        html += rows
          .map(
            (it) => `<button class="item ${it.arrivedAt ? 'is-ok' : ''}" data-id="${esc(it.id)}">
              <i class="dot"></i><span><span class="name">${itemTitle(it)}</span><span class="mono">${esc(it.track)}</span></span>
              <small>${it.arrivedAt ? fmtTime(it.arrivedAt) : ''}</small></button>`,
          )
          .join('');
      }
    }
    $('#items').innerHTML = html;
  };
  $('#q').oninput = draw;
  $('#items').onclick = (e) => {
    const row = e.target.closest('.item');
    if (row) openItem(row.dataset.id, draw);
  };
  draw();
}

function openItem(id, onChange) {
  const it = store.state.items.find((x) => x.id === id);
  if (!it) return;
  const via = { scan: 'сканером', hand: 'вручную', note: 'из заметки' }[it.arrivedBy] || '';
  sheet.innerHTML = `
    <form method="dialog" class="sheet">
      <p class="mono big">${esc(it.track)}</p>
      <p><b>${itemTitle(it)}</b><br>${esc(it.recipient)}<br><small>${esc(it.list)}</small></p>
      <p class="${it.arrivedAt ? 'ok-text' : ''}">${it.arrivedAt ? `Приехал ${fmtTime(it.arrivedAt)} ${via}` : 'Ещё не приехал'}</p>
      <button class="primary" value="toggle">${it.arrivedAt ? 'Сбросить отметку «Приехал»' : 'Отметить «Приехал»'}</button>
      <details><summary>Изменить</summary>
        <label class="field">Товар<input name="name" value="${esc(it.name)}"></label>
        <label class="field">Получатель<input name="recipient" value="${esc(it.recipient)}"></label>
        <label class="field">Трек-номер<input name="track" class="mono" value="${esc(it.track)}" autocapitalize="characters"></label>
        <button class="btn" value="save">Сохранить</button>
      </details>
      <div class="row"><button class="btn danger" value="delete">Удалить</button><button class="btn" value="close">Закрыть</button></div>
    </form>`;
  sheet.onclose = () => {
    const form = sheet.querySelector('form');
    const action = sheet.returnValue;
    if (action === 'toggle') store.setArrived(id, !it.arrivedAt);
    if (action === 'delete' && confirm('Удалить эту посылку из списка?')) store.deleteItem(id);
    if (action === 'save') {
      const ok = store.updateItem(id, { name: form.name.value, recipient: form.recipient.value, track: form.track.value });
      if (!ok) toast('Трек-номер не похож на трек: только латиница и цифры, от 8 знаков');
    }
    onChange();
  };
  sheet.returnValue = '';
  sheet.showModal();
}

// ---------- не найдены ----------
function renderUnknown(listId) {
  const list = [...store.view(listId).unknown].sort((a, b) => b.lastAt - a.lastAt);
  const title = store.view(listId).title;
  app.innerHTML = `
    ${header('Не найдены', listId && listId !== 'all' ? purchaseHash(listId) : '#/')}
    <p class="hint">${title ? `${esc(title)}. ` : ''}Отсканированы, но этих номеров нет в списке.</p>
    ${list.length ? '<button class="btn" id="copy">Скопировать все номера</button>' : ''}
    <div id="items">${
      list
        .map(
          (u) => `<div class="item is-bad"><i class="dot"></i><span><span class="mono">${esc(u.code)}</span>
            <small>${fmtTime(u.lastAt)}${u.count > 1 ? ` · сканировали ${u.count} раза` : ''}</small></span>
            <button class="link" data-code="${esc(u.code)}" data-list="${esc(u.listId ?? '')}">Убрать</button></div>`,
        )
        .join('') || '<p class="hint">Пусто.</p>'
    }</div>`;
  $('#copy')?.addEventListener('click', () => copyText(list.map((u) => u.code).join('\n')));
  $('#items').onclick = (e) => {
    const code = e.target.dataset?.code;
    if (code) {
      store.removeUnknown(code, e.target.dataset.list || null);
      renderUnknown(listId);
    }
  };
}

// ---------- отчёт ----------
function reportRow(it, side = '') {
  return `<div class="item"><i class="dot"></i><span><span class="name">${itemTitle(it)}</span>
    <span class="mono">${esc(it.track)}</span></span>${side ? `<small>${side}</small>` : ''}</div>`;
}

function renderReport(listId) {
  const view = store.view(listId);
  const single = view.id !== 'all';
  const text = buildReport(view);
  const d = reportData(view);
  let waitingHtml = '';
  for (const [list, recipients] of groupItems(d.waiting)) {
    waitingHtml += `<h3>${esc(list)}</h3>`;
    for (const [recipient, items] of recipients) {
      if (recipient) waitingHtml += `<p class="who">${esc(recipient)}</p>`;
      waitingHtml += items.map((it) => reportRow(it)).join('');
    }
  }
  const stats = [
    `<div class="stat"><b>${d.total}</b><span>Всего</span></div>`,
    `<div class="stat ok"><b>${d.arrived}</b><span>Приехало</span></div>`,
    `<div class="stat"><b>${d.waiting.length}</b><span>Осталось</span></div>`,
    `<div class="stat bad"><b>${d.unknown.length}</b><span>Нет в списке</span></div>`,
    `<div class="stat warn"><b>${d.repeats.length}</b><span>Повторно</span></div>`,
  ].filter(Boolean);
  app.innerHTML = `
    ${header('Отчёт о приёмке', single ? purchaseHash(view.id) : '#/')}
    <p class="hint">${view.title ? `${esc(view.title)} · ` : ''}${fmtTime(Date.now())}</p>
    <section class="report-stats" style="grid-template-columns:repeat(${stats.length},1fr)">${stats.join('')}</section>
    ${store.needsBackup() ? `<div class="tip"><span>💾 Сохрани копию данных — на случай, если телефон их сотрёт.</span>
      <button class="link" id="backup">Сохранить</button></div>` : ''}
    <button class="primary" id="copy">Скопировать отчёт</button>
    <div class="row">
      <button class="btn" id="xlsx">Excel</button>
      <button class="btn" id="pdf">PDF</button>
    </div>
    <button class="btn wide" id="note">Текст для заметки ✅</button>
    ${d.waiting.length ? `<h2>Ещё не приехали · ${d.waiting.length}</h2>${waitingHtml}` : '<h2 class="ok-text">Всё приехало 🎉</h2>'}
    ${d.unknown.length ? `<h2>Нет в списке · ${d.unknown.length}</h2>${d.unknown
      .map((u) => `<div class="item is-bad"><i class="dot"></i><span><span class="mono">${esc(u.code)}</span></span>
        <small>${u.count > 1 ? `×${u.count}` : ''}</small></div>`)
      .join('')}` : ''}
    ${d.repeats.length ? `<h2>Сканировали повторно · ${d.repeats.length}</h2>${d.repeats
      .map(({ track, count, item }) => `<div class="item is-warn"><i class="dot"></i><span>
        <span class="name">${item ? itemTitle(item) : ''}</span><span class="mono">${esc(track)}${item?.recipient ? ` · ${esc(item.recipient)}` : ''}</span></span>
        <small>повторов: ${count}</small></div>`)
      .join('')}` : ''}`;
  preloadExports();
  $('#copy').onclick = () => copyText(text, 'Отчёт скопирован');
  $('#note').onclick = () => copyText(buildNoteText(view), 'Скопировано. Вставь в новую заметку');
  $('#xlsx').onclick = (e) => exportReport(e.currentTarget, 'xlsx', view);
  $('#pdf').onclick = (e) => exportReport(e.currentTarget, 'pdf', view);
  $('#backup')?.addEventListener('click', async () => {
    if ((await saveBackup()) !== 'cancelled') $('.tip')?.remove();
  });
}

async function exportReport(btn, kind, view) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Готовлю…';
  try {
    const blob = kind === 'xlsx' ? await makeXlsx(view) : await makePdf(view);
    await deliver(`priyomka-${today()}.${kind}`, kind === 'xlsx' ? XLSX_TYPE : 'application/pdf', blob);
  } catch (err) {
    console.error(err);
    toast('Не получилось сделать файл');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- закупки ----------
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function purchaseCard(p) {
  return `<a class="purchase ${p.archivedAt ? 'is-archived' : ''}" href="${purchaseHash(p.id)}">
    <b>${esc(p.title)}</b>
    <span>${fmtDate(p.date)} · ${p.total} ${plural(p.total, 'товар', 'товара', 'товаров')}</span>
    <span>Отсканировано ${p.arrived} из ${p.total}</span>
    <div class="progress"><i style="width:${p.percent}%"></i></div></a>`;
}

function renderLists() {
  const closed = store.purchases().filter((p) => p.archivedAt);
  app.innerHTML = `
    ${header('Закрытые закупки')}
    <p class="hint">Не видны на главном, сканер их не сверяет. Все данные сохранены: открой, чтобы посмотреть или вернуть в активные.</p>
    ${closed.map((p) => purchaseCard(p)).join('') || '<p class="hint">Закрытых закупок нет.</p>'}`;
}

function renderPurchase(id) {
  const isAll = id === 'all';
  const p = isAll ? null : store.purchases().find((x) => x.id === id);
  if (!isAll && !p) return go('#/');
  const s = store.stats(id);
  const unknown = store.view(id).unknown.length;
  const q = `/${encodeURIComponent(id)}`;
  app.innerHTML = `
    ${header(isAll ? 'Все активные закупки' : p.title, p?.archivedAt ? '#/lists' : '#/')}
    ${isAll ? '<p class="hint">Все активные закупки вместе. Сканировать — внутри каждой закупки.</p>' : `
      <label class="date-row">Дата закупки<input type="date" id="date" value="${esc(p.date)}"></label>`}
    ${p?.archivedAt ? `<p class="note">Закупка закрыта ${fmtTime(p.archivedAt)}. Сканер её не сверяет, все данные сохранены.</p>` : ''}
    <section class="stats">
      <div class="stat"><b>${s.total}</b><span>Всего</span></div>
      <div class="stat ok"><b>${s.arrived}</b><span>Приехало</span></div>
      <div class="stat"><b>${s.left}</b><span>Осталось</span></div>
      <div class="stat"><b>${s.percent}%</b><span>Готово</span></div>
      <div class="progress"><i style="width:${s.percent}%"></i></div>
      <p class="progress-text">Отсканировано ${s.arrived} из ${s.total}, осталось ${s.left}</p>
    </section>
    ${isAll || p.archivedAt ? '' : '<button class="scan-btn" id="scan">СКАНИРОВАТЬ</button>'}
    <nav class="grid top">
      <a class="tile" href="#/list/all${q}"><b>${s.total}</b>ВЕСЬ СПИСОК</a>
      <a class="tile ok" href="#/list/arrived${q}"><b>${s.arrived}</b>ПРИЕХАЛИ</a>
      <a class="tile wait" href="#/list/waiting${q}"><b>${s.left}</b>ОЖИДАЮТСЯ</a>
      <a class="tile bad" href="#/unknown${q}"><b>${unknown}</b>НЕ НАЙДЕНЫ</a>
    </nav>
    <a class="btn wide" href="#/report${q}">Отчёт</a>
    ${isAll ? '' : `
      <button class="btn wide" id="archive">${p.archivedAt ? 'Вернуть в активные' : 'Закрыть закупку'}</button>
      <button class="link danger" id="delete">Удалить закупку</button>`}`;
  if (isAll) return;
  $('#scan')?.addEventListener('click', () => {
    unlockAudio();
    go(`#/scan${q}`);
  });
  $('#date').onchange = (e) => {
    if (store.setDate(id, e.target.value)) toast(`Дата: ${fmtDate(e.target.value)}`);
    else e.target.value = p.date; // очистили поле — оставляем прежнюю дату
  };
  $('#archive').onclick = () => {
    if (p.archivedAt) {
      store.setArchived(id, false);
      toast('Закупка снова в активных');
    } else {
      if (s.left && !confirm(`Ещё не приехали: ${s.left}. Всё равно закрыть? Закупка уйдёт в «Закрытые закупки», данные сохранятся.`)) return;
      store.setArchived(id, true);
      toast('Закупка закрыта');
    }
    renderPurchase(id);
  };
  $('#delete').onclick = () => {
    const what = `${s.total} ${plural(s.total, 'посылку', 'посылки', 'посылок')}`;
    if (!confirm(`Удалить закупку «${p.title}» целиком: ${what} с отметками? Вернуть можно только из резервной копии.`)) return;
    store.deleteList(id);
    toast('Закупка удалена');
    go('#/');
  };
}

// ---------- история сканирований ----------
const LOG_FILTERS = [['all', 'Все'], ['found', 'Приехал'], ['repeat', 'Повтор'], ['unknown', 'Нет в списке'], ['other', 'Другая закупка']];
const LOG_LABEL = { found: 'Приехал', repeat: 'Повтор', unknown: 'Нет в списке', other: 'Из другой закупки' };
const LOG_PAGE = 200;

function renderHistory() {
  const log = store.state.log;
  const byTrack = new Map();
  for (const it of store.state.items) {
    if (!byTrack.has(it.track)) byTrack.set(it.track, []);
    byTrack.get(it.track).push(it);
  }
  const counts = { all: log.length };
  for (const e of log) counts[e.result] = (counts[e.result] || 0) + 1;
  let filter = 'all';
  let limit = LOG_PAGE;
  app.innerHTML = `
    ${header('История сканирований')}
    <div class="chips" id="chips">${LOG_FILTERS
      .map(([k, t]) => `<button class="chip log-${k}" data-f="${k}">${t} <b>${counts[k] || 0}</b></button>`)
      .join('')}</div>
    <input class="search" id="q" type="search" placeholder="Поиск по номеру" autocomplete="off" autocapitalize="characters">
    <div id="items"></div>`;
  const draw = () => {
    const q = $('#q').value.toUpperCase().replace(/\s+/g, '');
    $('#chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.f === filter));
    const rows = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (filter !== 'all' && e.result !== filter) continue;
      if (q && !String(e.code).toUpperCase().includes(q) && !(e.track || '').includes(q)) continue;
      rows.push(e);
    }
    const html = rows.slice(0, limit).map((e) => {
      const items = (e.track && byTrack.get(e.track)) || [];
      const it = items[0];
      const more = items.length > 1 ? ` + ещё ${items.length - 1}` : '';
      const about = it ? `${itemTitle(it)}${more}${it.recipient ? ` · ${esc(it.recipient)}` : ''}` : '';
      return `<div class="item log-${esc(e.result)}"><i class="dot"></i><span>
        <span class="name">${LOG_LABEL[e.result] || esc(e.result)}</span><span class="mono">${esc(e.code)}</span>
        ${about ? `<small>${about}</small>` : ''}</span><small>${fmtTime(e.at)}</small></div>`;
    }).join('');
    $('#items').innerHTML = html
      ? html + (rows.length > limit ? `<button class="btn wide" id="more">Показать ещё (${rows.length - limit})</button>` : '')
      : `<p class="hint">${log.length ? 'Ничего не найдено.' : 'Сканирований ещё не было.'}</p>`;
  };
  $('#chips').onclick = (e) => {
    const f = e.target.closest('.chip')?.dataset.f;
    if (!f) return;
    filter = f;
    limit = LOG_PAGE;
    draw();
  };
  $('#q').oninput = () => {
    limit = LOG_PAGE;
    draw();
  };
  $('#items').onclick = (e) => {
    if (e.target.id !== 'more') return;
    limit += LOG_PAGE;
    draw();
  };
  draw();
}

// ---------- резервная копия ----------
function renderBackup() {
  const { lists, items, backupAt } = store.state;
  app.innerHTML = `
    ${header('Резервная копия')}
    <p class="hint">Все закупки, отметки и история — в одном файле. Сохрани его в «Файлы» или отправь себе в Telegram.
      Если телефон сотрёт данные, их можно вернуть из этого файла. Открывать файл не нужно.</p>
    <div class="card"><b>Сейчас в телефоне: ${lists.length} ${plural(lists.length, 'закупка', 'закупки', 'закупок')},
      ${items.length} ${plural(items.length, 'посылка', 'посылки', 'посылок')}</b>
      <p class="hint">${backupAt ? `Последняя копия: ${fmtTime(backupAt)}` : 'Копию ещё не сохраняли.'}</p></div>
    <button class="primary" id="save">Сохранить копию в файл</button>
    <h2>Вернуть данные из копии</h2>
    <p class="hint">Выбери сохранённый файл копии. Всё, что сейчас в телефоне, заменится данными из него.</p>
    <label class="btn wide">Вернуть данные из файла<input type="file" id="file" accept=".json,application/json" hidden></label>`;
  $('#save').onclick = async () => {
    if ((await saveBackup()) !== 'cancelled') renderBackup();
  };
  $('#file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    let b;
    try {
      b = store.readBackup(text);
    } catch (err) {
      toast(err.message);
      return;
    }
    const when = b.savedAt ? ` от ${fmtTime(b.savedAt)}` : '';
    const msg = `Заменить всё?\n\nСейчас в телефоне: закупок ${lists.length}, посылок ${items.length}.\n`
      + `В копии${when}: закупок ${b.lists}, посылок ${b.items}.\n\nТекущие данные пропадут.`;
    if (!confirm(msg)) return;
    store.restoreBackup(text);
    toast('Данные восстановлены из копии');
    go('#/');
  };
}

// ---------- сканирование ----------
let scan = null; // { listId, stream, loop, filter, session }

const RESULT_TEXT = { found: 'ПРИЕХАЛ', repeat: 'УЖЕ СКАНИРОВАЛИ', unknown: 'НЕТ В СПИСКЕ', other: 'НЕ ИЗ ЭТОЙ ЗАКУПКИ' };

// Сканер работает внутри одной активной закупки и сверяет только с ней.
function renderScan(listId) {
  const active = store.purchases().filter((p) => !p.archivedAt);
  const p = active.find((x) => x.id === listId) ?? (listId ? null : active.length === 1 ? active[0] : null);
  if (!p) return go(listId ? purchaseHash(listId) : '#/');
  const s = store.stats(p.id);
  app.innerHTML = `
    <section class="scanner">
      <video id="video" playsinline muted></video>
      <div class="aim"></div>
      <header class="scan-top">
        <button class="pill" id="done">Готово</button>
        <span class="pill" id="count">${s.arrived} из ${s.total}</span>
        <button class="pill" id="sound">${soundOn() ? '🔊' : '🔇'}</button>
        <button class="pill" id="zoom" hidden>1×</button>
        <button class="pill" id="torch" hidden>🔦</button>
        <button class="pill" id="cam">📷</button>
      </header>
      <div class="result" id="result"><p class="result-title">Наведи камеру на штрихкод</p>
        <p class="result-who">Закупка «${esc(p.title)}»</p></div>
      <footer class="scan-bottom">
        <span id="session">✓ 0 · ✗ 0 · ↺ 0</span>
        <label class="pill">Из фото<input type="file" id="photo" accept="image/*" hidden></label>
        <button class="pill" id="manual">Ввести номер</button>
      </footer>
      <div class="flash" id="flash"></div>
    </section>`;
  document.body.classList.add('dark');
  scan = { listId: p.id, stream: null, loop: null, filter: new ScanFilter(), session: { found: 0, unknown: 0, repeat: 0 }, torchOn: false };

  $('#done').onclick = () => go(`#/report/${encodeURIComponent(p.id)}`);
  $('#sound').onclick = (e) => {
    setSound(!soundOn());
    e.target.textContent = soundOn() ? '🔊' : '🔇';
    unlockAudio();
  };
  $('#manual').onclick = () => {
    const code = prompt('Трек-номер с коробки');
    if (code?.trim()) handleCodes([code.trim()], true);
  };
  $('#photo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const codes = await decodeImage(f).catch(() => []);
    if (!codes.length) toast('На фото штрихкод не найден');
    else handleCodes(codes, true);
    e.target.value = '';
  };
  $('#cam').onclick = switchCamera;
  startScanning();
}

async function startScanning(deviceId) {
  const video = $('#video');
  if (!video || !scan) return;
  try {
    scan.stream = await openCamera(video, deviceId);
  } catch (err) {
    $('#result').innerHTML = `<p class="result-title">Нет доступа к камере</p>
      <p>Разреши камеру: Настройки → Приложения → Safari → Камера → «Разрешить». Или введи номер вручную.</p>`;
    console.error(err);
    return;
  }
  const torch = torchControl(scan.stream);
  const torchBtn = $('#torch');
  if (torch && torchBtn) {
    torchBtn.hidden = false;
    torchBtn.onclick = () => {
      scan.torchOn = !scan.torchOn;
      torch(scan.torchOn).catch(() => {});
    };
  }
  const zoom = zoomControl(scan.stream);
  const zoomBtn = $('#zoom');
  if (zoom && zoomBtn) {
    let i = 0;
    zoomBtn.hidden = false;
    zoomBtn.onclick = () => {
      i = (i + 1) % zoom.levels.length;
      zoomBtn.textContent = `${zoom.levels[i]}×`;
      zoom.set(zoom.levels[i]).catch(() => {});
    };
  }
  scan.loop = createScanLoop(video, (codes, now) => handleCodes(codes, false, now));
  scan.loop.start();
  navigator.wakeLock?.request('screen').then((l) => (scan.wakeLock = l)).catch(() => {});
}

function stopScanning() {
  if (!scan) return;
  scan.loop?.stop();
  closeCamera(scan.stream);
  scan.wakeLock?.release?.().catch(() => {});
  scan.stream = null;
  scan.loop = null;
}

async function switchCamera() {
  const cams = await listCameras();
  if (cams.length < 2) return toast('Другой камеры нет');
  sheet.innerHTML = `<form method="dialog" class="sheet"><p><b>Камера</b></p>
    <p class="hint">Для близких коробок на iPhone Pro лучше «тройная» или «двойная широкоугольная».</p>
    ${cams.map((c, i) => `<button class="btn" value="${esc(c.deviceId)}">${esc(c.label || `Камера ${i + 1}`)}</button>`).join('')}
    <button class="btn" value="">Отмена</button></form>`;
  sheet.onclose = () => {
    const id = sheet.returnValue;
    if (!id || !scan) return;
    stopScanning();
    startScanning(id);
  };
  sheet.returnValue = '';
  sheet.showModal();
}

// manual = введено руками или с фото: срабатывает сразу, без фильтра кадров.
function handleCodes(codes, manual, now = performance.now()) {
  if (!scan) return;
  const events = manual
    ? codes.map((code) => {
        const track = store.lookup(code);
        return track ? { type: 'match', code, track } : { type: 'unknown', code };
      })
    : scan.filter.feed(codes, now, (c) => store.lookup(c), (c) => store.shapeScore(c));
  for (const ev of events) showResult(ev);
}

// Что в посылке: один товар или явный список, если под треком несколько товаров.
function resultItems(items) {
  const who = [...new Set(items.map((i) => i.recipient))];
  const whoLine = who.length === 1 && who[0] ? `<p class="result-who">${esc(who[0])}</p>` : '';
  if (items.length === 1) return `<p class="result-name">${itemTitle(items[0])}</p>${whoLine}`;
  const each = (i) => `<li>${itemTitle(i)}${who.length > 1 && i.recipient ? ` · ${esc(i.recipient)}` : ''}</li>`;
  return `<p class="result-name">В посылке ${items.length} ${plural(items.length, 'товар', 'товара', 'товаров')}:</p>
    <ul class="result-items">${items.map(each).join('')}</ul>${whoLine}`;
}

function showResult(ev) {
  let kind;
  let html;
  if (ev.type === 'match') {
    const { result, items, lists } = store.markByTrack(ev.track, ev.code, Date.now(), scan.listId);
    kind = result;
    const first = items[0];
    const from = result === 'other' ? `<p class="result-name">Из закупки «${lists.map(esc).join('», «')}»</p>` : '';
    html = `<p class="result-title">${RESULT_TEXT[kind]}</p>${from}${resultItems(items)}
      <p class="mono">${esc(ev.track)}${result === 'repeat' ? ` · отмечен ${fmtTime(first.arrivedAt)}` : ''}</p>`;
  } else {
    kind = 'unknown';
    store.addUnknown(ev.code, Date.now(), scan.listId);
    html = `<p class="result-title">${RESULT_TEXT.unknown}</p><p class="mono big">${esc(ev.code)}</p>`;
  }
  // «Не из этой закупки» звучит и считается как красный.
  const signalKind = kind === 'other' ? 'unknown' : kind;
  scan.session[signalKind]++;
  signal(signalKind);

  const result = $('#result');
  const flash = $('#flash');
  if (!result || !flash) return;
  result.className = `result ${kind}`;
  result.innerHTML = html;
  flash.className = `flash ${kind}`;
  void flash.offsetWidth; // перезапуск анимации
  flash.classList.add('on');
  const s = store.stats(scan.listId);
  $('#count').textContent = `${s.arrived} из ${s.total}`;
  $('#session').textContent = `✓ ${scan.session.found} · ✗ ${scan.session.unknown} · ↺ ${scan.session.repeat}`;
}

// Экран свернули: камеру выключаем, вернулись — включаем снова.
document.addEventListener('visibilitychange', () => {
  if (!scan) return;
  if (document.hidden) stopScanning();
  else if (location.hash.startsWith('#/scan')) startScanning();
});

// ---------- маршруты ----------
function route() {
  if (scan) {
    stopScanning();
    scan = null;
  }
  document.body.classList.remove('dark');
  sheet.onclose = null;
  if (sheet.open) sheet.close();
  const [, page, arg, arg2] = (location.hash || '#/').split('/').map((p) => decodeURIComponent(p));
  if (page === 'scan') renderScan(arg);
  else if (page === 'list') renderList(arg, arg2);
  else if (page === 'unknown') renderUnknown(arg);
  else if (page === 'import') renderImport();
  else if (page === 'report') renderReport(arg);
  else if (page === 'lists') renderLists();
  else if (page === 'purchase') renderPurchase(arg);
  else if (page === 'history') renderHistory();
  else if (page === 'backup') renderBackup();
  else renderHome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Без офлайна', err));
}
