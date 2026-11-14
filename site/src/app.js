// Экраны приложения. Маршрут в адресе: #/, #/scan, #/list/all|arrived|waiting, #/unknown, #/import, #/report
import { parseNote } from './parse.js';
import { createStore } from './store.js';
import { ScanFilter } from './scanfilter.js';
import { buildReport, buildNoteText, buildCsv, groupItems, reportData } from './report.js';
import { openCamera, closeCamera, createScanLoop, decodeImage, torchControl, zoomControl, listCameras } from './scanner.js';
import { unlockAudio, signal, soundOn, setSound } from './feedback.js';

const store = createStore();
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');

// ---------- помощники ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, root = app) => root.querySelector(sel);
const go = (hash) => (location.hash = hash);

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

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

async function shareFile(name, type, content) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function header(title, back = '#/') {
  return `<header class="bar"><a class="back" href="${back}" aria-label="Назад">‹ Назад</a><h1>${esc(title)}</h1></header>`;
}

function itemTitle(it) {
  return `${it.n ? `${esc(it.n)}. ` : ''}${esc(it.name || 'Без названия')}`;
}

// ---------- главный экран ----------
function renderHome() {
  const s = store.stats();
  const unknown = store.state.unknown.length;
  const lists = store.state.lists.map((l) => l.title).join(' · ');
  app.innerHTML = `
    <header class="app-head">
      <p class="banner">как жаль сегодня Илонину жопу вечером</p>
      <h1>📦 Посылки</h1>
      <p>${lists ? esc(lists) : 'Приёмка посылок по штрихкоду'}</p>
    </header>
    <section class="stats">
      <div class="stat"><b>${s.total}</b><span>Всего</span></div>
      <div class="stat ok"><b>${s.arrived}</b><span>Приехало</span></div>
      <div class="stat"><b>${s.left}</b><span>Осталось</span></div>
      <div class="stat"><b>${s.percent}%</b><span>Готово</span></div>
      <div class="progress"><i style="width:${s.percent}%"></i></div>
    </section>
    ${s.total ? '' : `<p class="hint">Открой заметку со списком, нажми «Выбрать все» → «Скопировать», потом здесь «Добавить список».</p>`}
    <button class="scan-btn" id="scan">СКАНИРОВАТЬ</button>
    <nav class="grid">
      <a class="tile" href="#/list/all"><b>${s.total}</b>ВЕСЬ СПИСОК</a>
      <a class="tile ok" href="#/list/arrived"><b>${s.arrived}</b>ПРИЕХАЛИ</a>
      <a class="tile wait" href="#/list/waiting"><b>${s.left}</b>ОЖИДАЮТСЯ</a>
      <a class="tile bad" href="#/unknown"><b>${unknown}</b>НЕ НАЙДЕНЫ</a>
    </nav>
    <div class="row">
      <a class="btn" href="#/import">＋ Добавить список</a>
      <a class="btn" href="#/report">Отчёт</a>
    </div>
    <button class="link danger" id="clear">Очистить всё</button>`;
  $('#scan').onclick = () => {
    unlockAudio();
    go('#/scan');
  };
  $('#clear').onclick = () => {
    if (!store.state.items.length && !store.state.unknown.length) return;
    if (confirm('Удалить весь список, отметки и историю? Сначала лучше сохранить отчёт.')) {
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
    go('#/');
  };
}

// ---------- списки ----------
const LIST_TITLES = { all: 'Весь список', arrived: 'Приехали', waiting: 'Ожидаются' };

function renderList(kind) {
  app.innerHTML = `
    ${header(LIST_TITLES[kind] || 'Список')}
    <input class="search" id="q" type="search" placeholder="Поиск: номер, товар, получатель" autocomplete="off">
    <div id="items"></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toUpperCase().replace(/\s+/g, '');
    const qText = $('#q').value.trim().toLowerCase();
    const items = store.state.items.filter((it) => {
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
function renderUnknown() {
  const list = [...store.state.unknown].sort((a, b) => b.lastAt - a.lastAt);
  app.innerHTML = `
    ${header('Не найдены')}
    <p class="hint">Отсканированы, но этих номеров нет в списке.</p>
    ${list.length ? '<button class="btn" id="copy">Скопировать все номера</button>' : ''}
    <div id="items">${
      list
        .map(
          (u) => `<div class="item is-bad"><i class="dot"></i><span><span class="mono">${esc(u.code)}</span>
            <small>${fmtTime(u.lastAt)}${u.count > 1 ? ` · сканировали ${u.count} раза` : ''}</small></span>
            <button class="link" data-code="${esc(u.code)}">Убрать</button></div>`,
        )
        .join('') || '<p class="hint">Пусто.</p>'
    }</div>`;
  $('#copy')?.addEventListener('click', () => copyText(list.map((u) => u.code).join('\n')));
  $('#items').onclick = (e) => {
    const code = e.target.dataset?.code;
    if (code) {
      store.removeUnknown(code);
      renderUnknown();
    }
  };
}

// ---------- отчёт ----------
function reportRow(it, side = '') {
  return `<div class="item"><i class="dot"></i><span><span class="name">${itemTitle(it)}</span>
    <span class="mono">${esc(it.track)}</span></span>${side ? `<small>${side}</small>` : ''}</div>`;
}

function renderReport() {
  const text = buildReport(store.state);
  const d = reportData(store.state);
  let waitingHtml = '';
  for (const [list, recipients] of groupItems(d.waiting)) {
    waitingHtml += `<h3>${esc(list)}</h3>`;
    for (const [recipient, items] of recipients) {
      if (recipient) waitingHtml += `<p class="who">${esc(recipient)}</p>`;
      waitingHtml += items.map((it) => reportRow(it)).join('');
    }
  }
  app.innerHTML = `
    ${header('Отчёт о приёмке')}
    <p class="hint">${fmtTime(Date.now())}</p>
    <section class="report-stats">
      <div class="stat"><b>${d.total}</b><span>Всего</span></div>
      <div class="stat ok"><b>${d.arrived}</b><span>Приехало</span></div>
      <div class="stat"><b>${d.waiting.length}</b><span>Осталось</span></div>
      <div class="stat bad"><b>${d.unknown.length}</b><span>Нет в списке</span></div>
      <div class="stat warn"><b>${d.repeats.length}</b><span>Повторно</span></div>
    </section>
    <div class="row wrap">
      <button class="primary" id="copy">Скопировать отчёт</button>
      <button class="btn" id="note">Текст для заметки ✅</button>
      <button class="btn" id="csv">Таблица для Excel</button>
    </div>
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
  $('#copy').onclick = () => copyText(text, 'Отчёт скопирован');
  $('#note').onclick = () => copyText(buildNoteText(store.state), 'Скопировано. Вставь в новую заметку');
  $('#csv').onclick = () => shareFile(`priyomka-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', buildCsv(store.state));
}

// ---------- сканирование ----------
let scan = null; // { stream, loop, filter, session }

const RESULT_TEXT = { found: 'ПРИЕХАЛ', repeat: 'УЖЕ СКАНИРОВАЛИ', unknown: 'НЕТ В СПИСКЕ' };

function renderScan() {
  const s = store.stats();
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
      <div class="result" id="result"><p class="result-title">Наведи камеру на штрихкод</p></div>
      <footer class="scan-bottom">
        <span id="session">✓ 0 · ✗ 0 · ↺ 0</span>
        <label class="pill">Из фото<input type="file" id="photo" accept="image/*" hidden></label>
        <button class="pill" id="manual">Ввести номер</button>
      </footer>
      <div class="flash" id="flash"></div>
    </section>`;
  document.body.classList.add('dark');
  scan = { stream: null, loop: null, filter: new ScanFilter(), session: { found: 0, unknown: 0, repeat: 0 }, torchOn: false };

  $('#done').onclick = () => go('#/report');
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

function showResult(ev) {
  let kind;
  let html;
  if (ev.type === 'match') {
    const { result, items } = store.markByTrack(ev.track, ev.code);
    kind = result;
    const first = items[0];
    const more = items.length > 1 ? `<p>+ ещё ${items.length - 1}: ${items.slice(1).map((i) => esc(i.name)).join(', ')}</p>` : '';
    html = `<p class="result-title">${RESULT_TEXT[kind]}</p>
      <p class="result-name">${itemTitle(first)}</p>
      <p class="result-who">${esc(first.recipient)}</p>${more}
      <p class="mono">${esc(ev.track)}${result === 'repeat' ? ` · отмечен ${fmtTime(first.arrivedAt)}` : ''}</p>`;
  } else {
    kind = 'unknown';
    store.addUnknown(ev.code);
    html = `<p class="result-title">${RESULT_TEXT.unknown}</p><p class="mono big">${esc(ev.code)}</p>`;
  }
  scan.session[kind]++;
  signal(kind);

  const result = $('#result');
  const flash = $('#flash');
  if (!result || !flash) return;
  result.className = `result ${kind}`;
  result.innerHTML = html;
  flash.className = `flash ${kind}`;
  void flash.offsetWidth; // перезапуск анимации
  flash.classList.add('on');
  const s = store.stats();
  $('#count').textContent = `${s.arrived} из ${s.total}`;
  $('#session').textContent = `✓ ${scan.session.found} · ✗ ${scan.session.unknown} · ↺ ${scan.session.repeat}`;
}

// Экран свернули: камеру выключаем, вернулись — включаем снова.
document.addEventListener('visibilitychange', () => {
  if (!scan) return;
  if (document.hidden) stopScanning();
  else if (location.hash === '#/scan') startScanning();
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
  const [, page, arg] = (location.hash || '#/').split('/');
  if (page === 'scan') renderScan();
  else if (page === 'list') renderList(arg);
  else if (page === 'unknown') renderUnknown();
  else if (page === 'import') renderImport();
  else if (page === 'report') renderReport();
  else renderHome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Без офлайна', err));
}
