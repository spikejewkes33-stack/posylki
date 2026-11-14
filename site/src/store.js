// Данные приложения в памяти телефона (localStorage). Всё хранится одним объектом.
import { buildIndex, findTrackInCode } from './match.js';
import { normalizeTrack, looksLikeTrack } from './parse.js';

const KEY = 'parcel-scanner:v1';

function emptyState() {
  return { lists: [], items: [], log: [], unknown: [] };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function createStore(storage = globalThis.localStorage) {
  let state = emptyState();
  let index = new Map();
  const listeners = new Set();

  try {
    const raw = storage?.getItem(KEY);
    if (raw) state = { ...emptyState(), ...JSON.parse(raw) };
  } catch {
    state = emptyState();
  }
  index = buildIndex(state.items);

  function commit() {
    index = buildIndex(state.items);
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

    /** Трек из списка для текста штрихкода или null. */
    lookup(code) {
      return findTrackInCode(code, index)?.track ?? null;
    },

    /** Добавляет разобранную заметку. Позиции, которые уже есть (тот же трек, товар и получатель), пропускает. */
    importParsed(parsed, fallbackTitle) {
      const listId = uid();
      const title = parsed.title || fallbackTitle;
      const now = Date.now();
      const exists = new Set(state.items.map((it) => `${it.track}|${it.name}|${it.recipient}`));
      let added = 0;
      let skipped = 0;
      for (const p of parsed.items) {
        const key = `${p.track}|${p.name}|${p.recipient}`;
        if (exists.has(key)) {
          skipped++;
          continue;
        }
        exists.add(key);
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

    /** Отмечает все позиции с этим треком. Возвращает 'found' или 'repeat' и сами позиции. */
    markByTrack(track, code, now = Date.now()) {
      const positions = index.get(track) || [];
      const items = positions.map((i) => state.items[i]);
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

    /** Код, которого нет в списке. */
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

    stats() {
      const total = state.items.length;
      const arrived = state.items.filter((it) => it.arrivedAt).length;
      return { total, arrived, left: total - arrived, percent: total ? Math.floor((arrived * 100) / total) : 0 };
    },
  };
  return store;
}
