/* US company holidays (the list in the Score Card sheet). A holiday is not a working day:
   it is skipped in the daily goals and in the working-day counts.
   Holidays are generated for every year, so future years need no editing:
   New Year's Day (Jan 1), Good Friday, Memorial Day (last Monday of May), Independence Day (Jul 4),
   Labor Day (first Monday of September), Thanksgiving (fourth Thursday of November),
   Christmas Eve (Dec 24), Christmas Day (Dec 25), Boxing Day (Dec 26) and New Year's Eve (Dec 31).
   A New Year's Day, Independence Day, Christmas Day or Boxing Day that falls on a weekend is observed on the
   Friday before (Saturday) or the Monday after (Sunday); if that day is already a holiday it moves to the next free
   weekday. Christmas Eve and New Year's Eve on a weekend are not observed. This reproduces the sheet exactly
   (Independence Day 4 Jul 2026 is a Saturday, so Fri 3 Jul; Boxing Day 26 Dec 2026 is a Saturday, so Mon 28 Dec). */
const DAY = 86_400_000;
const FIRST_YEAR = 2026;
const LAST_YEAR = 2050;

const pad = n => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const dow = ms => new Date(ms).getUTCDay();

function easter(year) { /* Gregorian Easter Sunday */
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}
const nthWeekday = (year, month, weekday, n) => { /* n = 1..4, or -1 for the last */
  if (n > 0) { const first = utc(year, month, 1); return first + (((weekday - dow(first) + 7) % 7) + (n - 1) * 7) * DAY; }
  const last = utc(year, month + 1, 0); return last - ((dow(last) - weekday + 7) % 7) * DAY;
};

const HOLIDAYS = new Map(); /* day -> name */
const isWeekday = ms => dow(ms) !== 0 && dow(ms) !== 6;
function add(ms, name) { HOLIDAYS.set(dayKey(ms), name); }
function observed(year, month, day, name) {
  let ms = utc(year, month, day);
  if (dow(ms) === 6) ms -= DAY; else if (dow(ms) === 0) ms += DAY;
  while (HOLIDAYS.has(dayKey(ms)) || !isWeekday(ms)) ms += DAY;
  add(ms, name);
}
function onlyWeekday(year, month, day, name) { const ms = utc(year, month, day); if (isWeekday(ms)) add(ms, name); }

for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
  observed(y, 1, 1, "New Year's Day");
  add(easter(y) - 2 * DAY, 'Good Friday');
  add(nthWeekday(y, 5, 1, -1), 'Memorial Day');
  observed(y, 7, 4, 'Independence Day');
  add(nthWeekday(y, 9, 1, 1), 'Labor Day');
  add(nthWeekday(y, 11, 4, 4), 'Thanksgiving Day');
  onlyWeekday(y, 12, 24, 'Christmas Eve');
  observed(y, 12, 25, 'Christmas Day');
  observed(y, 12, 26, 'Boxing Day');
  onlyWeekday(y, 12, 31, "New Year's Eve");
}

const isHoliday = day => HOLIDAYS.has(day);
const isWeekend = day => { const [y, m, d] = day.split('-').map(Number); return [0, 6].includes(dow(utc(y, m, d))); };
const isWorkingDay = day => !isWeekend(day) && !isHoliday(day);
const holidayList = () => [...HOLIDAYS].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, name]) => ({ day, name }));

module.exports = { isHoliday, isWeekend, isWorkingDay, holidayList };
