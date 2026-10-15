const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const { etDay, fromUtc, chunk, entriesInto, listPaged, listItems, fullName } = require('./crmHistory');

/* Signed Purchase Agreements per Month (Score Card Mapping, Closing Analyst).
   Bitrix has no signing date, so a deal counts in the month it first moves into the Closing stage (confirmed by the user).
   Credit goes to the deal's "Closing Analyst" list field. Raymond (transferred to Deal Execution Manager) and MC (offboarded)
   are not scored; deals credited to them are shown as not scored. */
const CLOSING_STAGE = 'LAST_PHASE';
const ANALYST_FIELD = 'UF_CRM_1780683200817';
const NOT_SCORED = new Set(['raymond', 'mc']);
const EXCEPTIONAL = 2;
const TARGET = 1;
const BELOW_STREAK = 3;
const MONTHS_BACK = 5;
const HISTORY_SINCE = '2024-01-01';

const norm = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const monthStart = (day, back) => { const [y, m] = day.split('-').map(Number); return fromUtc(Date.UTC(y, m - 1 - back, 1)); };
const monthsFrom = (first, last) => { const out = []; for (let m = first; m <= last; m = monthStart(`${m}-01`, -1).slice(0, 7)) out.push(m); return out; };

async function calculate() {
  const portal = bitrix.portal();
  const today = reportToday();
  const thisMonth = today.slice(0, 7);
  const firstMonth = [monthStart(today, MONTHS_BACK).slice(0, 7), config.COUNT_FROM.slice(0, 7)].sort().pop();
  const months = monthsFrom(firstMonth, thisMonth);

  const fields = await bitrix.call('crm.deal.fields');
  const options = (fields.result?.[ANALYST_FIELD]?.items || []).map(item => ({ id: String(item.ID), name: String(item.VALUE).trim() }));
  const optionName = new Map(options.map(option => [option.id, option.name]));

  /* first time each deal entered Closing, in ET */
  const first = new Map();
  (await entriesInto([CLOSING_STAGE], HISTORY_SINCE)).sort((a, b) => Number(a.ID) - Number(b.ID))
    .forEach(row => { if (!first.has(String(row.OWNER_ID))) first.set(String(row.OWNER_ID), etDay(row.CREATED_TIME)); });
  const counted = [...first.entries()].filter(([, day]) => day.slice(0, 7) >= months[0]);

  const deals = [];
  for (const ids of chunk(counted.map(([id]) => id), 40)) {
    deals.push(...await listPaged('crm.deal.list', { filter: { ID: ids }, select: ['ID', 'TITLE', 'STAGE_ID', ANALYST_FIELD] }, listItems));
  }
  const dealById = new Map(deals.map(deal => [String(deal.ID), deal]));

  const users = await listPaged('user.get', { FILTER: { ACTIVE: true }, ORDER: { ID: 'ASC' } }, listItems);
  const userByName = new Map(users.filter(user => /^closing analyst$/i.test(user.WORK_POSITION || '')).map(user => [norm(fullName(user)), String(user.ID)]));
  const analysts = new Map(options.filter(option => !NOT_SCORED.has(option.name.toLowerCase()))
    .map(option => [option.name, { name: option.name, bitrixId: userByName.get(norm(option.name)) || null, monthly: Object.fromEntries(months.map(m => [m, 0])), total: 0, deals: [], inClosingNow: 0 }]));
  const notScored = {};
  const unassigned = { total: 0, deals: [] };

  for (const [id, day] of counted.sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
    const deal = dealById.get(id);
    if (!deal) continue;
    if (day > today) continue;
    const entry = { id, title: deal.TITLE, day, stage: deal.STAGE_ID, url: `${portal}/crm/deal/details/${id}/` };
    const name = optionName.get(String(deal[ANALYST_FIELD]));
    if (!name) { unassigned.total++; unassigned.deals.push(entry); continue; }
    const analyst = analysts.get(name);
    if (!analyst) { notScored[name] = (notScored[name] || 0) + 1; continue; }
    analyst.monthly[day.slice(0, 7)]++;
    analyst.total++;
    analyst.deals.push(entry);
    if (deal.STAGE_ID === CLOSING_STAGE) analyst.inClosingNow++;
  }

  const lastFull = months.filter(m => m < thisMonth);
  const rows = [...analysts.values()].map(analyst => {
    let streak = 0;
    for (let i = lastFull.length - 1; i >= 0 && analyst.monthly[lastFull[i]] === 0; i--) streak++;
    return { ...analyst, zeroStreak: streak, belowTarget: streak >= BELOW_STREAK };
  });

  return {
    range: { from: months[0], to: today }, months, thisMonth, exceptional: EXCEPTIONAL, target: TARGET, belowStreak: BELOW_STREAK,
    analysts: rows, unassigned, notScored, provisional: true,
    notes: [
      'Bitrix has no purchase-agreement signing date, so a deal counts in the month it first moves into the Closing stage (stage history, ET). A deal that leaves and re-enters Closing counts once.',
      'Credit goes to the deal\'s Closing Analyst field. Deals with no Closing Analyst are shown separately and credit nobody.',
      'Raymond (transferred to Deal Execution Manager) and MC (offboarded) are not scored.',
      'Exceptional: 2 or more in a month · Target: 1 · Below target: 0 for 3 or more consecutive full months with no pipeline justification. Pipeline justification is a judgment call and is not automated: check the deals in Closing now.'
    ]
  };
}

async function closingAgreements({ force }) {
  const result = await bitrix.loadCached('kpi:closing-agreements', calculate, force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { closingAgreements };
