const bitrix = require('./bitrix');
const sheets = require('./sheets');
const { addDays } = require('./crmHistory');

/* Approved leave from the OOO Tracker sheet (Regalis Capital). A day on leave is not scored for that person.
   PTO DATA holds one row per leave (nickname, start, end, type, note); CONTRACTOR links the nickname to a full name,
   and the full name to the Bitrix user.
   A row is NOT leave (the day still counts against the person) when its note says "unexcused" or "rejected".
   Every other leave type, approved or with no approval text, skips the day. */
const MAX_SPAN_DAYS = 60; /* a row longer than this is a typing error, not a leave */

/* nickname -> Bitrix name, for people whose tracker full name differs from Bitrix (confirmed). John, Aldwin, Quirr and
   Faith are deliberately left unmapped. */
const NAME_OVERRIDES = {
  'el-jay': 'El-jay D.', franz: 'Franz Barquilla', kristyl: 'Kristyl', sandra: 'Sandra', sean: 'Sean', andela: 'Angela Perisic'
};

const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const day = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
const notExcused = note => /unexcused|rejected/i.test(String(note || ''));

function table(rows, headerCell) {
  const at = rows.findIndex(row => row.some(cell => String(cell || '').trim().toUpperCase() === headerCell));
  if (at < 0) throw new Error(`OOO Tracker is missing the ${headerCell} column`);
  const head = rows[at].map(cell => String(cell || '').trim().toUpperCase());
  return rows.slice(at + 1).map(row => key => row[head.indexOf(key)]);
}

function matchUser(users, nickname, fullName) {
  const override = NAME_OVERRIDES[nickname.toLowerCase()];
  if (override) return users.find(user => norm(user.name) === norm(override)) || null;
  const full = norm(fullName.replace(/\(.*\)/, ''));
  const exact = users.filter(user => norm(user.name) === full);
  if (exact.length === 1) return exact[0];
  const parts = full.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const close = users.filter(user => norm(user.name).split(' ').includes(parts[0]) && norm(user.name).split(' ').includes(parts[parts.length - 1]));
  return close.length === 1 ? close[0] : null;
}

async function calculate() {
  const id = process.env.GOOGLE_OOO_SHEET_ID?.trim();
  if (!id) throw new Error('OOO Tracker not configured');
  const [users, workbook] = await Promise.all([bitrix.getUsers(), sheets.getWorkbook(id)]);
  const roster = table(workbook.tabs.CONTRACTOR || [], 'CONTRACTOR NAME');
  const log = table(workbook.tabs['PTO DATA'] || [], 'CONTRACTOR NAME');

  const bitrixIdOf = new Map(), unmapped = [];
  for (const row of roster) {
    const nickname = String(row('CONTRACTOR NAME') || '').trim();
    if (!nickname) continue;
    const user = matchUser(users, nickname, String(row('CONTRACTOR FULL NAME') || ''));
    if (user) bitrixIdOf.set(nickname.toLowerCase(), user.id); else unmapped.push(nickname);
  }

  const people = {}, unknown = new Set();
  let skippedUnexcused = 0;
  for (const row of log) {
    const nickname = String(row('CONTRACTOR NAME') || '').trim();
    const start = day(row('START DATE')), end = day(row('END DATE')) || start;
    if (!nickname || !start || end < start) continue;
    if (notExcused(row('ADDITIONAL INFORMATION'))) { skippedUnexcused++; continue; }
    if (end > addDays(start, MAX_SPAN_DAYS)) continue;
    const bitrixId = bitrixIdOf.get(nickname.toLowerCase());
    if (!bitrixId) { unknown.add(nickname); continue; }
    (people[bitrixId] ||= []).push({ start, end, type: String(row('LEAVE TYPE') || 'Leave').trim() });
  }
  return { people, unmapped, unknownNames: [...unknown], skippedUnexcused, sheet: workbook.name, modifiedTime: workbook.modifiedTime };
}

async function leave({ force } = {}) {
  const result = await bitrix.loadCached('leave:ooo', calculate, force);
  return { ...result.data, notes: [
    'Source: the OOO Tracker sheet (read-only). A day on leave is not scored: it is not a miss and not a hit.',
    'A leave row whose note says "unexcused" or "rejected" is not treated as leave, so those days count against the person.',
    'People are matched by the full name on the CONTRACTOR tab. Anyone without a Bitrix match is listed under unmapped and gets no leave.'
  ], cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { leave };
