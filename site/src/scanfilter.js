// Решает, когда считанный код превращается в событие для экрана.
// - Один и тот же код (или трек) не срабатывает повторно, пока он в кадре.
// - Красный экран только для похожих на трек кодов, которые продержались в кадре
//   unknownDelayMs и ни разу не попались в одном кадре с кодом из списка
//   (на одной наклейке бывает несколько кодов: трек, номер заказа и т. п.).
import { isTrackLikeCode } from './match.js';
import { normalizeTrack } from './parse.js';

export class ScanFilter {
  constructor({ holdMs = 1500, unknownDelayMs = 700 } = {}) {
    this.holdMs = holdMs;
    this.unknownDelayMs = unknownDelayMs;
    this.seen = new Map(); // ключ → { first, last, fired }
  }

  /**
   * @param {string[]} codes тексты штрихкодов в кадре
   * @param {number} now время в мс
   * @param {(code: string) => string | null} lookup трек из списка для кода или null
   * @returns {Array<{type: 'match', code: string, track: string} | {type: 'unknown', code: string}>}
   */
  feed(codes, now, lookup) {
    for (const [key, entry] of this.seen) {
      if (now - entry.last > this.holdMs) this.seen.delete(key);
    }

    const frame = [];
    for (const raw of codes) {
      const code = normalizeTrack(raw);
      if (!code) continue;
      const track = lookup(code);
      frame.push({ code, track, key: track ? `T:${track}` : `C:${code}` });
    }
    const frameHasMatch = frame.some((f) => f.track);

    const events = [];
    const firedKeys = new Set();
    for (const f of frame) {
      if (firedKeys.has(f.key)) continue;
      let entry = this.seen.get(f.key);
      if (!entry) {
        entry = { first: now, last: now, fired: false };
        this.seen.set(f.key, entry);
      }
      entry.last = now;
      if (entry.fired) continue;

      if (f.track) {
        entry.fired = true;
        firedKeys.add(f.key);
        events.push({ type: 'match', code: f.code, track: f.track });
      } else if (!isTrackLikeCode(f.code)) {
        entry.fired = true; // служебный код наклейки (QR с адресом и т. п.): молчим
      } else if (frameHasMatch) {
        entry.fired = true; // в кадре есть код из списка: это второй код той же наклейки
      } else if (now - entry.first >= this.unknownDelayMs) {
        entry.fired = true;
        firedKeys.add(f.key);
        events.push({ type: 'unknown', code: f.code });
      }
    }
    return events;
  }
}
