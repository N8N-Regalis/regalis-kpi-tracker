const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;

/* Signed LOIs per Week (Score Card Mapping, KPI 22) and Team Signed LOIs per Week (KPI 21).
   A deal counts in the week of its "LOI Signed Date". Credit goes to the Deal Analyst on the client (contact) profile. */
const TIME_ZONE = 'America/New_York';
const SIGNED_DATE = 'UF_CRM_1758748037506';
const CLIENT_ANALYST = 'UF_CRM_1757529265783';
const HIRE_DATE = 'UF_EMPLOYMENT_DATE';
const RAMP_DAYS = 45;
const DEFAULT_WEEKS = 12;
const MAX_WEEKS = 60;
const DAY = 86_400_000;

const analystTitle = /^deal analyst$/i;
const leadTitle = /^loi (team )?lead$/i;

const norm = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const toUtc = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
const mondayOf = day => { const ms = toUtc(day); return fromUtc(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY); };
const todayEt = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function validDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || fromUtc(toUtc(value)) !== value) throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function listAll(method, params) {
  const rows = [];
  for (let start = 0; ;) {
    const data = await bitrix.call(method, { ...params, start });
    rows.push(...(Array.isArray(data.result) ? data.result : []));
    if (data.next == null) break;
    start = Number(data.next);
  }
  return rows;
}

/* Start date = Bitrix "Hiring date" if filled, otherwise the day the person's Bitrix account was created. */
function startDate(user) {
  const isDay = value => /^\d{4}-\d{2}-\d{2}/.test(value || '');
  if (isDay(user[HIRE_DATE])) return { hireDate: String(user[HIRE_DATE]).slice(0, 10), hireDateSource: 'Bitrix hiring date' };
  if (isDay(user.DATE_REGISTER)) return { hireDate: String(user.DATE_REGISTER).slice(0, 10), hireDateSource: 'Bitrix account created' };
  return { hireDate: null, hireDateSource: null };
}

async function getAnalysts() {
  const users = await listAll('user.get', { FILTER: { ACTIVE: true }, ORDER: { ID: 'ASC' } });
  const named = user => [user.NAME, user.SECOND_NAME, user.LAST_NAME].filter(Boolean).join(' ').trim();
  const analysts = users.filter(user => analystTitle.test(user.WORK_POSITION || '')).map(user => ({
    bitrixId: String(user.ID),
    name: named(user),
    ...startDate(user)
  }));
  const leads = users.filter(user => leadTitle.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: named(user) }));
  return { analysts, leads };
}

async function calculate({ from, to }) {
  const [{ analysts, leads }, fields] = await Promise.all([getAnalysts(), bitrix.call('crm.contact.fields')]);
  const optionName = new Map((fields.result?.[CLIENT_ANALYST]?.items || []).map(item => [String(item.ID), item.VALUE]));

  const deals = await listAll('crm.deal.list', {
    filter: { [`>=${SIGNED_DATE}`]: from, [`<=${SIGNED_DATE}`]: to },
    select: ['ID', 'CONTACT_ID', SIGNED_DATE],
    order: { [SIGNED_DATE]: 'ASC' }
  });

  const contactIds = [...new Set(deals.map(deal => deal.CONTACT_ID).filter(id => id && id !== '0'))];
  const contactAnalyst = new Map();
  for (const ids of chunk(contactIds, 50)) {
    const data = await bitrix.call('crm.contact.list', { filter: { ID: ids }, select: ['ID', CLIENT_ANALYST] });
    for (const contact of data.result || []) contactAnalyst.set(String(contact.ID), contact[CLIENT_ANALYST]);
  }

  const analystByName = new Map(analysts.map(analyst => [norm(analyst.name), analyst]));
  const weeks = [];
  for (let monday = mondayOf(from); monday <= to; monday = fromUtc(toUtc(monday) + 7 * DAY)) {
    weeks.push({ start: monday, end: fromUtc(toUtc(monday) + 6 * DAY) });
  }
  const today = reportToday();
  weeks.forEach(week => { week.inProgress = week.end >= today; });
  const weekIndex = new Map(weeks.map((week, index) => [week.start, index]));

  const state = new Map(analysts.map(analyst => [analyst.bitrixId, { ...analyst, weekly: weeks.map(() => 0), monthly: {}, daily: {}, total: 0 }]));
  const unattributed = { total: 0, noClient: 0, noAnalyst: 0, notCurrentAnalyst: {}, unknownOption: 0 };

  for (const deal of deals) {
    const day = String(deal[SIGNED_DATE]).slice(0, 10);
    const raw = contactAnalyst.get(String(deal.CONTACT_ID));
    const label = optionName.get(String(raw));
    const analyst = label ? analystByName.get(norm(label)) : null;
    if (analyst) {
      const row = state.get(analyst.bitrixId);
      row.weekly[weekIndex.get(mondayOf(day))]++;
      row.monthly[day.slice(0, 7)] = (row.monthly[day.slice(0, 7)] || 0) + 1;
      row.daily[day] = (row.daily[day] || 0) + 1;
      row.total++;
      continue;
    }
    unattributed.total++;
    if (!deal.CONTACT_ID || deal.CONTACT_ID === '0') unattributed.noClient++;
    else if (!raw || raw === '0') unattributed.noAnalyst++;
    else if (label) unattributed.notCurrentAnalyst[label] = (unattributed.notCurrentAnalyst[label] || 0) + 1;
    else unattributed.unknownOption++;
  }

  const rows = [...state.values()].map(row => {
    const rampEnd = row.hireDate ? fromUtc(toUtc(row.hireDate) + RAMP_DAYS * DAY) : null;
    return { ...row, rampEnd, inRamp: Boolean(rampEnd && today < rampEnd) };
  });
  const headcount = rows.length;
  const team = {
    headcount,
    target: headcount,
    weekly: weeks.map((week, index) => ({ start: week.start, total: rows.reduce((sum, row) => sum + row.weekly[index], 0), inProgress: week.inProgress })),
    daily: rows.reduce((all, row) => { Object.entries(row.daily).forEach(([day, n]) => { all[day] = (all[day] || 0) + n; }); return all; }, {})
  };

  return {
    range: { from, to },
    timezone: TIME_ZONE,
    weeks,
    analysts: rows,
    leads,
    team,
    unattributed,
    totalSignedInRange: deals.length,
    notes: [
      'A deal counts in the week of its LOI Signed Date and is credited to the Deal Analyst on the client profile.',
      'Not automated: seller countersignature check, terms matching the approved terms, analyst-caused rework, and the valid exceptions listed in the Notes of each deal.',
      `New hires are Not scored for ${RAMP_DAYS} days from their start date: the Bitrix hiring date, or the day their Bitrix account was created when no hiring date is set.`
    ],
    provisional: true
  };
}

async function signedLois({ from, to, force }) {
  const end = to ? validDay(to, 'to') : reportToday();
  const requested = from ? validDay(from, 'from') : config.COUNT_FROM;
  const floor = fromUtc(toUtc(mondayOf(end)) - (MAX_WEEKS - 1) * 7 * DAY);
  const start = requested < config.COUNT_FROM ? config.COUNT_FROM : !from && requested < floor ? floor : requested;
  if (start > end) throw new Error('from must not be after to');
  if ((toUtc(end) - toUtc(mondayOf(start))) / DAY / 7 > MAX_WEEKS) throw new Error(`Range is limited to ${MAX_WEEKS} weeks`);
  const result = await bitrix.loadCached(`kpi:signed-lois:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { signedLois };
