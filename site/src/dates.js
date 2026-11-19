// Дата закупки: строка «ГГГГ-ММ-ДД», как у поля <input type="date">. Без времени и часовых поясов.

const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_STEMS = { янв: 0, фев: 1, мар: 2, апр: 3, май: 4, мая: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11 };
// Месяц словом целиком или сокращением: «нояб», «ноября», «дек.». «Маршрут» и «мартышка» — не месяц.
const MONTH_RE = '(январ[ья]|янв|феврал[ья]|фев|марта?|мар|апрел[ья]|апр|ма[йя]|июн[ья]?|июл[ья]?|августа?|авг|'
  + 'сентябр[ья]|сент?|октябр[ья]|окт|ноябр[ья]|нояб?|декабр[ья]|дек)\\.?(?![а-яё])';
const WEEK = 7 * 24 * 3600 * 1000;

/** Дата дня по местному времени телефона. */
export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function makeDate(year, month, day) {
  const d = new Date(year, month, day, 12);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

export function isDateKey(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return Boolean(m && makeDate(+m[1], +m[2] - 1, +m[3]));
}

/** «17 ноября», а не в этом году — «17 ноября 2025». */
export function fmtDate(key, now = Date.now()) {
  if (!isDateKey(key)) return '';
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1]}${y === new Date(now).getFullYear() ? '' : ` ${y}`}`;
}

// Из нескольких возможных дат берёт самую позднюю, но не дальше недели после создания закупки
// («Закупка от 30», созданная 20-го, — это прошлый месяц).
function closest(candidates, created) {
  const ok = candidates.filter((d) => d && d - created <= WEEK);
  if (!ok.length) return null;
  return dateKey(Math.max(...ok));
}

/**
 * Дата из названия закупки, если её можно понять: «Закуп 14.11», «Закуп нояб 9», «9 ноября», «Закупка от 17».
 * Год и месяц, которых нет в названии, — самые поздние, не дальше недели после создания. Не поняли — null.
 */
export function dateFromTitle(title, created = Date.now()) {
  const t = String(title ?? '').toLowerCase();
  const c = new Date(created);
  const year = c.getFullYear();

  let m = t.match(/(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?!\d)/);
  if (m) {
    const [day, month] = [+m[1], +m[2] - 1];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const d = makeDate(y, month, day);
      return d ? dateKey(d) : null;
    }
    return closest([year - 1, year, year + 1].map((y) => makeDate(y, month, day)), created);
  }

  const monthFirst = t.match(new RegExp(`(?<![а-яё])${MONTH_RE}\\s*(\\d{1,2})(?!\\d)`));
  const dayFirst = t.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s*${MONTH_RE}`));
  if (monthFirst || dayFirst) {
    const [stem, day] = monthFirst ? [monthFirst[1], +monthFirst[2]] : [dayFirst[2], +dayFirst[1]];
    const month = MONTH_STEMS[stem.slice(0, 3)];
    return closest([year - 1, year, year + 1].map((y) => makeDate(y, month, day)), created);
  }

  m = t.match(/(?<![а-яё])от\s+(\d{1,2})(?!\d)/);
  if (m) {
    const day = +m[1];
    const months = [-1, 0, 1].map((k) => new Date(year, c.getMonth() + k, 1));
    return closest(months.map((first) => makeDate(first.getFullYear(), first.getMonth(), day)), created);
  }
  return null;
}
