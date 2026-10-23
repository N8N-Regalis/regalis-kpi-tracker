const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const { etDay, fromUtc, addDays, chunk, entriesInto, listPaged, listItems } = require('./crmHistory');

/* LOI Conversion Rate (Asst Deal Exec Manager KPI 1, rolling 3 months) and Closing Conversion Rate (KPI 2, rolling 6 months).
   LOI: deals that first entered LOI Stage in the window, and how many have a "LOI Signed Date".
   Closing: deals that first entered Closing in the window, and how many are now Deal Closed.
   Outcomes are the deal's state today, not as of the window end, so recent windows are not final. */
const LOI_STAGE = 'NEGOTIATION';
const CLOSING_STAGE = 'LAST_PHASE';
const SIGNED_DATE = 'UF_CRM_1758748037506';
/* the deal's "Reason for Axed" list field; option 993 is "Other - Internal" */
const AXED_REASON_FIELD = 'UF_CRM_1755636401';
const OTHER_INTERNAL = '993';
const HISTORY_SINCE = '2024-01-01';
const LOI_MONTHS = 3;
const CLOSING_MONTHS = 6;
const REVIEWS_BACK = 3;

const addMonths = (day, n) => { const [y, m, d] = day.split('-').map(Number); const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate(); return fromUtc(Date.UTC(y, m - 1 + n, Math.min(d, last))); };
const monthEnd = (day, back) => { const [y, m] = day.split('-').map(Number); return fromUtc(Date.UTC(y, m - back, 0)); };
const rate = (part, whole) => (whole ? Math.round(part / whole * 1000) / 10 : null);

async function firstEntries(stage) {
  const first = new Map();
  (await entriesInto([stage], HISTORY_SINCE)).sort((a, b) => Number(a.ID) - Number(b.ID))
    .forEach(row => { if (!first.has(String(row.OWNER_ID))) first.set(String(row.OWNER_ID), etDay(row.CREATED_TIME)); });
  return first;
}

async function dealsById(ids) {
  const out = new Map();
  for (const part of chunk(ids, 40)) {
    (await listPaged('crm.deal.list', { filter: { ID: part }, select: ['ID', 'STAGE_ID', SIGNED_DATE, AXED_REASON_FIELD] }, listItems)).forEach(deal => out.set(String(deal.ID), deal));
  }
  return out;
}

function windows(today, months) {
  const ends = [today, ...Array.from({ length: REVIEWS_BACK }, (_, i) => monthEnd(today, i + 1))].filter((day, i, all) => all.indexOf(day) === i);
  return ends.filter(end => end >= config.COUNT_FROM).map(end => {
    const start = addMonths(end, -months);
    const first = addDays(start, 1);
    return { end, start: first < config.COUNT_FROM ? config.COUNT_FROM : first };
  });
}

async function calculate() {
  const portal = bitrix.portal();
  const today = reportToday();
  const [loiFirst, closingFirst] = await Promise.all([firstEntries(LOI_STAGE), firstEntries(CLOSING_STAGE)]);
  const loiWin = windows(today, LOI_MONTHS), closingWin = windows(today, CLOSING_MONTHS);
  const loiFrom = loiWin[loiWin.length - 1].start, closingFrom = closingWin[closingWin.length - 1].start;
  const loiIds = [...loiFirst].filter(([, day]) => day >= loiFrom).map(([id]) => id);
  const closingIds = [...closingFirst].filter(([, day]) => day >= closingFrom).map(([id]) => id);
  const [loiDeals, closingDeals] = await Promise.all([dealsById(loiIds), dealsById(closingIds)]);
  /* deals Axed with the reason "Other - Internal" are not counted in Closing Conversion */
  let excludedInternal = 0;
  for (const [id, deal] of closingDeals) {
    if (deal.STAGE_ID === 'LOSE' && String(deal[AXED_REASON_FIELD]) === OTHER_INTERNAL) { closingDeals.delete(id); excludedInternal++; }
  }
  const link = id => `${portal}/crm/deal/details/${id}/`;

  const loi = loiWin.map(({ start, end }) => {
    const inWin = loiIds.filter(id => loiFirst.get(id) >= start && loiFirst.get(id) <= end && loiDeals.has(id));
    const signed = inWin.filter(id => loiDeals.get(id)[SIGNED_DATE]);
    return { start, end, entered: inWin.length, signed: signed.length, rate: rate(signed.length, inWin.length), inProgress: end === today };
  });
  const closing = closingWin.map(({ start, end }) => {
    const inWin = closingIds.filter(id => closingFirst.get(id) >= start && closingFirst.get(id) <= end && closingDeals.has(id));
    const stage = id => closingDeals.get(id).STAGE_ID;
    const closed = inWin.filter(id => stage(id) === 'WON').length;
    const axed = inWin.filter(id => stage(id) === 'LOSE').length;
    return { start, end, entered: inWin.length, closed, axed, open: inWin.length - closed - axed,
      rate: rate(closed, closed + axed), rateOfEntered: rate(closed, inWin.length), inProgress: end === today };
  });
  const current = { loi: loiWin[0], closing: closingWin[0] };
  const deals = {
    loi: loiIds.filter(id => loiFirst.get(id) >= current.loi.start && loiFirst.get(id) <= current.loi.end && loiDeals.has(id)).sort((a, b) => (loiFirst.get(b) < loiFirst.get(a) ? -1 : 1))
      .map(id => ({ id, url: link(id), day: loiFirst.get(id), outcome: loiDeals.get(id)[SIGNED_DATE] ? 'Signed LOI' : 'No signed LOI date', stage: loiDeals.get(id).STAGE_ID })),
    closing: closingIds.filter(id => closingFirst.get(id) >= current.closing.start && closingFirst.get(id) <= current.closing.end && closingDeals.has(id)).sort((a, b) => (closingFirst.get(b) < closingFirst.get(a) ? -1 : 1))
      .map(id => ({ id, url: link(id), day: closingFirst.get(id), stage: closingDeals.get(id).STAGE_ID }))
  };
  return {
    today, loiMonths: LOI_MONTHS, closingMonths: CLOSING_MONTHS, loi, closing, deals, excludedInternal, provisional: true,
    notes: [
      'LOI Conversion: deals that first moved into LOI Stage in the 3-month window, and the share that have a LOI Signed Date. Exceptional 18% or more · Target 13% · Below target under 13%.',
      'Closing Conversion: deals that first moved into Closing in the 6-month window, and the share now in Deal Closed. The rate is Deal Closed out of Deal Closed plus Axed, because deals still in Closing or On Hold have not had an outcome yet. Deals Axed with the reason "Other - Internal" are not counted at all. The share of all entered deals is shown too. Exceptional 80% or more · Target 70% · Below target under 70%.',
      'The Bitrix End date field is filled on every deal (it is the expected close date), so it is not used to decide whether a deal closed.',
      'Outcomes are each deal\'s state today, so recent windows are not final. A deal that leaves and re-enters a stage counts once, in the first window.',
      'Counting starts on 1 October 2026: a window never reaches back before that day, so the rolling windows are shorter than 3 and 6 months until they fill up.',
      'LOI Signed Date is rarely filled for recent deals, which can understate the LOI rate.'
    ]
  };
}

async function conversion({ force }) {
  const result = await bitrix.loadCached('kpi:conversion', calculate, force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { conversion };
