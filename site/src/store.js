// Данные приложения в памяти телефона (localStorage). Всё хранится одним объектом.
// Закупка (list) может быть в архиве: её посылки не участвуют в сверке и не считаются на главном.
import { buildIndex, findTrackInCode } from './match.js';
import { normalizeTrack, looksLikeTrack } from './parse.js';

const KEY = 'parcel-scanner:v1';
const BACKUP_APP = 'posylki';

function emptyState() {
  return { lists: [], items: [], log: [], unknown: [] };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Приводит загруженные данные к нужному виду, ничего не выбрасывая.
function normalizeState(raw) {
  const s = { ...emptyState(), ...raw };
  for (const k of ['lists', 'items', 'log', 'unknown']) if (!Array.isArray(s[k])) s[k] = [];
  for (const it of s.items) {
    it.track = String(it.track ?? '');
    // Разбор до 14.11 строку «1. ТРЕК» без названия записывал как товар «1.»: номер переносим в n.
    const num = !it.n && String(it.name ?? '').trim().match(/^(\d{1,4})[.)]$/);
    if (num) {
      it.n = num[1];
      it.name = '';
    }
  }
  return s;
}

function countItems(items) {
  const arrived = items.filter((it) => it.arrivedAt).length;
  const total = items.length;
  return { total, arrived, left: total - arrived, percent: total ? Math.floor((arrived * 100) / total) : 0 };
}

export function createStore(storage = globalThis.localStorage) {
  let state = emptyState();
  let active = []; // посылки активных закупок: только с ними идёт сверка
  let index = new Map();
  let shapes = { prefixes: new Set(), lengths: new Set() };
  const listeners = new Set();
  const prefixOf = (code) => code.match(/^[A-Z]*/)[0];
  const indexAll = () => {
    const archived = new Set(state.lists.filter((l) => l.archivedAt).map((l) => l.id));
    active = state.items.filter((it) => !archived.has(it.listId));
    index = buildIndex(active);
    shapes = {
      prefixes: new Set(active.map((it) => prefixOf(it.track))),
      lengths: new Set(active.map((it) => it.track.length)),
    };
  };

  try {
    const raw = storage?.getItem(KEY);
    if (raw) state = normalizeState(JSON.parse(raw));
  } catch {
    state = emptyState();
  }
  indexAll();

  function commit() {
    indexAll();
    try {
      storage?.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Не удалось сохранить', err);
    }
    listeners.forEach((fn) => fn());
  }

  const store = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Трек из активных закупок для текста штрихкода или null. */
    lookup(code) {
      return findTrackInCode(code, index)?.track ?? null;
    },

    /** Насколько чужой код похож на треки списка: те же буквы в начале (+2), та же длина (+1). */
    shapeScore(code) {
      const norm = normalizeTrack(code);
      return (shapes.prefixes.has(prefixOf(norm)) ? 2 : 0) + (shapes.lengths.has(norm.length) ? 1 : 0);
    },

    /**
     * Добавляет разобранную заметку новой закупкой. Позиции, которые уже есть в активных закупках, пропускает.
     * Одинаковые строки внутри заметки (2 шт. одного товара под одним треком) — разные позиции:
     * пропускается ровно столько копий, сколько их уже есть в активных закупках.
     */
    importParsed(parsed, fallbackTitle) {
      const listId = uid();
      const title = parsed.title || fallbackTitle;
      const now = Date.now();
      const keyOf = (it) => `${it.track}|${it.name}|${it.recipient}`;
      const exists = new Map();
      for (const it of active) exists.set(keyOf(it), (exists.get(keyOf(it)) || 0) + 1);
      let added = 0;
      let skipped = 0;
      for (const p of parsed.items) {
        const key = keyOf(p);
        const left = exists.get(key) || 0;
        if (left > 0) {
          exists.set(key, left - 1);
          skipped++;
          continue;
        }
        state.items.push({
          id: uid() + added,
          listId,
          list: title,
          recipient: p.recipient,
          n: p.n,
          name: p.name,
          track: p.track,
          arrivedAt: p.checked ? now : null,
          arrivedBy: p.checked ? 'note' : null,
        });
        added++;
      }
      if (added) state.lists.push({ id: listId, title, addedAt: now });
      commit();
      return { added, skipped };
    },

    /** Отмечает все позиции активных закупок с этим треком. Возвращает 'found' или 'repeat' и сами позиции. */
    markByTrack(track, code, now = Date.now()) {
      const items = (index.get(track) || []).map((i) => active[i]);
      const fresh = items.filter((it) => !it.arrivedAt);
      fresh.forEach((it) => {
        it.arrivedAt = now;
        it.arrivedBy = 'scan';
      });
      const result = fresh.length ? 'found' : 'repeat';
      state.log.push({ at: now, code, track, result });
      commit();
      return { result, items };
    },

    /** Код, которого нет в активных закупках. */
    addUnknown(code, now = Date.now()) {
      const norm = normalizeTrack(code);
      const known = state.unknown.find((u) => u.code === norm);
      if (known) {
        known.count++;
        known.lastAt = now;
      } else {
        state.unknown.push({ code: norm, firstAt: now, lastAt: now, count: 1 });
      }
      state.log.push({ at: now, code: norm, track: null, result: 'unknown' });
      commit();
      return { result: 'unknown', repeated: Boolean(known) };
    },

    setArrived(id, arrived) {
      const it = state.items.find((x) => x.id === id);
      if (!it) return;
      it.arrivedAt = arrived ? Date.now() : null;
      it.arrivedBy = arrived ? 'hand' : null;
      commit();
    },

    updateItem(id, patch) {
      const it = state.items.find((x) => x.id === id);
      if (!it) return false;
      if (patch.track !== undefined) {
        const t = normalizeTrack(patch.track);
        if (!looksLikeTrack(t)) return false;
        it.track = t;
      }
      if (patch.name !== undefined) it.name = patch.name.trim();
      if (patch.recipient !== undefined) it.recipient = patch.recipient.trim();
      commit();
      return true;
    },

    deleteItem(id) {
      state.items = state.items.filter((x) => x.id !== id);
      commit();
    },

    removeUnknown(code) {
      state.unknown = state.unknown.filter((u) => u.code !== code);
      commit();
    },

    clearAll() {
      state = emptyState();
      commit();
    },

    // ---------- закупки ----------

    /** Закупки со счётчиками: сначала активные, новые (добавленные позже) выше. Посылки без записи о закупке собираются по listId. */
    purchases() {
      const byId = new Map([...state.lists].reverse().map((l) => [l.id, { ...l, items: [] }]));
      for (const it of state.items) {
        if (!byId.has(it.listId)) byId.set(it.listId, { id: it.listId, title: it.list || 'Без названия', addedAt: 0, items: [] });
        byId.get(it.listId).items.push(it);
      }
      return [...byId.values()]
        .map(({ items, ...l }) => ({ ...l, ...countItems(items) }))
        .sort((a, b) => Boolean(a.archivedAt) - Boolean(b.archivedAt));
    },

    /**
     * Что показывать: посылки всех активных закупок ('all' или пусто) или одной закупки.
     * «Нет в списке» относится к сверке со всеми активными, поэтому у одной закупки его нет.
     */
    view(listId) {
      if (!listId || listId === 'all') return { id: 'all', title: '', items: active, unknown: state.unknown, log: state.log };
      const list = store.purchases().find((l) => l.id === listId);
      return {
        id: listId,
        title: list?.title ?? '',
        archived: Boolean(list?.archivedAt),
        items: state.items.filter((it) => it.listId === listId),
        unknown: [],
        log: state.log,
      };
    },

    /** Завершить закупку (в архив) или вернуть её в работу. */
    setArchived(listId, archived) {
      let list = state.lists.find((l) => l.id === listId);
      if (!list) {
        const first = state.items.find((it) => it.listId === listId);
        if (!first) return;
        list = { id: listId, title: first.list || 'Без названия', addedAt: 0 };
        state.lists.push(list);
      }
      if (archived) list.archivedAt = Date.now();
      else delete list.archivedAt;
      commit();
    },

    /** Удаляет закупку целиком со всеми посылками. История сканирований остаётся. */
    deleteList(listId) {
      state.items = state.items.filter((it) => it.listId !== listId);
      state.lists = state.lists.filter((l) => l.id !== listId);
      commit();
    },

    /** Счётчики по активным закупкам или по одной. */
    stats(listId) {
      return countItems(store.view(listId).items);
    },

    // ---------- резервная копия ----------

    /** Текст файла копии со всеми данными. */
    exportBackup(now = Date.now()) {
      return JSON.stringify({ app: BACKUP_APP, format: 1, savedAt: now, data: { ...state, backupAt: now } });
    },

    /** Копию сохранили: подсказка «Сохрани копию» не нужна до новых сканирований. */
    markBackedUp(now = Date.now()) {
      state.backupAt = now;
      commit();
    },

    /** Разбирает файл копии, ничего не меняя. Бросает ошибку с понятным текстом. */
    readBackup(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Это не файл копии «Посылок»');
      }
      const data = parsed?.app === BACKUP_APP ? parsed.data : parsed;
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.lists)) throw new Error('Это не файл копии «Посылок»');
      const s = normalizeState(data);
      return { savedAt: parsed.savedAt ?? null, data: s, lists: s.lists.length, items: s.items.length };
    },

    /** Заменяет все данные данными из копии. */
    restoreBackup(text) {
      const backup = store.readBackup(text);
      state = backup.data;
      commit();
      return backup;
    },

    /** Были сканирования после последней копии. */
    needsBackup() {
      const last = state.log.at(-1);
      return Boolean(last) && last.at > (state.backupAt || 0);
    },
  };
  return store;
}
