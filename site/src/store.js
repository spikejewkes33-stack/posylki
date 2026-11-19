// Данные приложения в памяти телефона (localStorage). Всё хранится одним объектом.
// Закупка (list) живёт отдельно: у неё своя дата (date, «ГГГГ-ММ-ДД»), сканер в ней сверяет только её посылки.
// Закрытая закупка (archivedAt) не удаляется: её не видно на главном, сканер её не сверяет, её можно вернуть.
import { buildIndex, findTrackInCode } from './match.js';
import { normalizeTrack, looksLikeTrack } from './parse.js';
import { dateKey, dateFromTitle, isDateKey } from './dates.js';

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
  // Закупкам до 20.11 даты не было: ставим день создания.
  for (const l of s.lists) if (!isDateKey(l.date)) l.date = dateKey(l.addedAt || Date.now());
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
      if (added) state.lists.push({ id: listId, title, addedAt: now, date: dateFromTitle(title, now) ?? dateKey(now) });
      commit();
      return { added, skipped };
    },

    /**
     * Отмечает позиции с этим треком: в закупке listId или (без listId) во всех активных.
     * Возвращает 'found' или 'repeat' и сами позиции. Если трек есть только в другой активной закупке,
     * ничего не отмечает и возвращает 'other', позиции той закупки и её название.
     */
    markByTrack(track, code, now = Date.now(), listId = null) {
      const all = (index.get(track) || []).map((i) => active[i]);
      const items = listId ? all.filter((it) => it.listId === listId) : all;
      const where = listId ? { listId } : {};
      if (!items.length) {
        state.log.push({ at: now, code, track, result: 'other', ...where });
        commit();
        const lists = [...new Set(all.map((it) => it.listId))].map((id) => titleOf(id));
        return { result: 'other', items: all, lists };
      }
      const fresh = items.filter((it) => !it.arrivedAt);
      fresh.forEach((it) => {
        it.arrivedAt = now;
        it.arrivedBy = 'scan';
      });
      const result = fresh.length ? 'found' : 'repeat';
      state.log.push({ at: now, code, track, result, ...where });
      commit();
      return { result, items };
    },

    /** Код, которого нет ни в одной активной закупке. С listId запоминается за этой закупкой. */
    addUnknown(code, now = Date.now(), listId = null) {
      const norm = normalizeTrack(code);
      const same = (u) => u.code === norm && (u.listId ?? null) === listId;
      const known = state.unknown.find(same);
      const where = listId ? { listId } : {};
      if (known) {
        known.count++;
        known.lastAt = now;
      } else {
        state.unknown.push({ code: norm, firstAt: now, lastAt: now, count: 1, ...where });
      }
      state.log.push({ at: now, code: norm, track: null, result: 'unknown', ...where });
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

    removeUnknown(code, listId = null) {
      state.unknown = state.unknown.filter((u) => !(u.code === code && (u.listId ?? null) === listId));
      commit();
    },

    clearAll() {
      state = emptyState();
      commit();
    },

    // ---------- закупки ----------

    /**
     * Закупки со счётчиками: сначала активные, потом закрытые; внутри — по дате, новые выше.
     * Посылки без записи о закупке собираются по listId.
     */
    purchases() {
      const byId = new Map([...state.lists].reverse().map((l) => [l.id, { ...l, items: [] }]));
      for (const it of state.items) {
        if (!byId.has(it.listId)) {
          byId.set(it.listId, { id: it.listId, title: it.list || 'Без названия', addedAt: 0, date: dateKey(), items: [] });
        }
        byId.get(it.listId).items.push(it);
      }
      return [...byId.values()]
        .map(({ items, ...l }) => ({ ...l, ...countItems(items) }))
        .sort((a, b) => Boolean(a.archivedAt) - Boolean(b.archivedAt) || (b.date > a.date) - (b.date < a.date));
    },

    /**
     * Что показывать: одну закупку или (id 'all' / пусто) все активные вместе.
     * «Нет в списке» у закупки — коды, отсканированные в ней.
     */
    view(listId) {
      if (!listId || listId === 'all') return { id: 'all', title: '', items: active, unknown: state.unknown, log: state.log };
      const list = store.purchases().find((l) => l.id === listId);
      return {
        id: listId,
        title: list?.title ?? '',
        date: list?.date ?? '',
        archived: Boolean(list?.archivedAt),
        items: state.items.filter((it) => it.listId === listId),
        unknown: state.unknown.filter((u) => u.listId === listId),
        log: state.log,
      };
    },

    /** Закрыть закупку или вернуть её в активные. Данные не трогаются. */
    setArchived(listId, archived) {
      const list = ensureList(listId);
      if (!list) return;
      if (archived) list.archivedAt = Date.now();
      else delete list.archivedAt;
      commit();
    },

    /** Меняет дату закупки (из поля выбора даты). Посылки и отметки не трогаются. */
    setDate(listId, date) {
      const list = isDateKey(date) && ensureList(listId);
      if (!list) return false;
      list.date = date;
      commit();
      return true;
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

  // Запись о закупке; для посылок без неё (на всякий случай) создаётся.
  function ensureList(listId) {
    let list = state.lists.find((l) => l.id === listId);
    if (!list) {
      const first = state.items.find((it) => it.listId === listId);
      if (!first) return null;
      list = { id: listId, title: first.list || 'Без названия', addedAt: 0, date: dateKey() };
      state.lists.push(list);
    }
    return list;
  }

  function titleOf(listId) {
    return state.lists.find((l) => l.id === listId)?.title ?? state.items.find((it) => it.listId === listId)?.list ?? '';
  }
  return store;
}
