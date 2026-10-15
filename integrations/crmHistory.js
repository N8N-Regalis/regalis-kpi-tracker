const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;

/* Shared helpers for the KPIs that read Bitrix stage history */
const TIME_ZONE = 'America/New_York';
const DAY = 86_400_000;

const etDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const toUtc = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
const mondayOf = day => { const ms = toUtc(day); return fromUtc(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY); };
const addDays = (day, n) => fromUtc(toUtc(day) + n * DAY);

function validDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || fromUtc(toUtc(value)) !== value) throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}

/* Bitrix batch commands are query strings, so nested filters need bracket notation */
function qs(value, prefix = '') {
  const parts = [];
  const add = (key, val) => {
    if (val !== null && typeof val === 'object') parts.push(qs(val, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  };
  if (Array.isArray(value)) value.forEach(item => add(`${prefix}[]`, item));
  else Object.entries(value).forEach(([key, val]) => add(prefix ? `${prefix}[${key}]` : key, val));
  return parts.filter(Boolean).join('&');
}

/* first page directly, the remaining pages through batch calls of up to 50 pages */
async function listPaged(method, params, itemsOf) {
  const first = await bitrix.call(method, { ...params, start: 0 });
  const rows = [...itemsOf(first.result)];
  const total = Number(first.total) || rows.length;
  const starts = [];
  for (let start = Number(first.next ?? total); start < total; start += 50) starts.push(start);
  for (let i = 0; i < starts.length; i += 50) {
    const group = starts.slice(i, i + 50);
    const cmd = Object.fromEntries(group.map((start, index) => [`p${index}`, `${method}?${qs({ ...params, start })}`]));
    const batch = await bitrix.call('batch', { halt: 0, cmd });
    group.forEach((start, index) => { const page = batch.result?.result?.[`p${index}`]; if (page) rows.push(...itemsOf(page)); });
    const missing = group.filter((start, index) => !batch.result?.result?.[`p${index}`]);
    for (const start of missing) rows.push(...itemsOf((await bitrix.call(method, { ...params, start })).result));
  }
  return rows;
}

const historyItems = result => (Array.isArray(result?.items) ? result.items : []);
const listItems = result => (Array.isArray(result) ? result : []);
const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const fullName = user => [user.NAME, user.SECOND_NAME && user.SECOND_NAME !== user.NAME ? user.SECOND_NAME : '', user.LAST_NAME].filter(Boolean).join(' ').trim();

/* every stage-history row for the given deals since a day, grouped per deal in order */
async function historyFor(dealIds, sinceDay) {
  const history = new Map();
  for (const ids of chunk([...dealIds], 40)) {
    const rows = await listPaged('crm.stagehistory.list', {
      entityTypeId: 2, order: { ID: 'ASC' },
      filter: { OWNER_ID: ids, '>=CREATED_TIME': `${sinceDay}T00:00:00-04:00` },
      select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME']
    }, historyItems);
    rows.forEach(row => { const list = history.get(String(row.OWNER_ID)) || []; list.push(row); history.set(String(row.OWNER_ID), list); });
  }
  history.forEach(list => list.sort((a, b) => Number(a.ID) - Number(b.ID)));
  return history;
}

/* stage-history rows that moved a deal into any of the stages since a day */
function entriesInto(stages, sinceDay) {
  return Promise.all(stages.map(stage => listPaged('crm.stagehistory.list', {
    entityTypeId: 2, filter: { '>=CREATED_TIME': `${sinceDay}T00:00:00-04:00`, STAGE_ID: stage }, select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME']
  }, historyItems))).then(lists => lists.flat());
}

function weeksBetween(from, to) {
  const today = reportToday();
  const weeks = [];
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) weeks.push({ start: monday, end: addDays(monday, 6), inProgress: addDays(monday, 6) >= today });
  return weeks;
}

function resolveRange({ from, to }, defaultWeeks, maxWeeks) {
  const end = to ? validDay(to, 'to') : reportToday();
  const requested = from ? validDay(from, 'from') : config.COUNT_FROM;
  const floor = addDays(mondayOf(end), -(maxWeeks - 1) * 7);
  const start = requested < config.COUNT_FROM ? config.COUNT_FROM : !from && requested < floor ? floor : requested;
  if (start > end) throw new Error('from must not be after to');
  if ((toUtc(end) - toUtc(mondayOf(start))) / DAY / 7 > maxWeeks) throw new Error(`Range is limited to ${maxWeeks} weeks`);
  return { start, end };
}

module.exports = { DAY, TIME_ZONE, etDay, toUtc, fromUtc, mondayOf, addDays, validDay, qs, listPaged, historyItems, listItems, chunk, fullName, historyFor, entriesInto, weeksBetween, resolveRange };
