const bitrix = require('./bitrix');
const { reportToday } = require('./config');
const { TIME_ZONE, mondayOf, addDays, listPaged, listItems, chunk, fullName, historyFor, weeksBetween, resolveRange } = require('./crmHistory');

/* Completed Booked Seller Calls per Week (M&A Coordinator). Rule given 2026-11-24:
   a deal counts when it has been in the Seller Call stage, the person assigned to its "Coordinating Seller Call" activity is the
   M&A Coordinator, and the deal's "Seller Call Completed Date" is filled. It is counted in the week of that date and credited
   to the coordinator on the activity (when a deal has several such activities, the most recent one).
   Exceptional: 5 or more a week. Target: 4. Below target: fewer than 4. */
const SELLER_STAGE = 'SELLER_CALL';
const COMPLETED_FIELD = 'UF_CRM_1779474066333'; /* Seller Call Completed Date */
const ACTIVITY_SUBJECT = 'Coordinating Seller Call';
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 60;
const HISTORY_LOOKBACK_DAYS = 365;
const coordinatorTitle = /^m&a coordinator$/i;
/* Not tracked yet (decided 2026-11-23): new coordinators with no completed calls. Remove a name here to start scoring them. */
const NOT_TRACKED_YET = [/^christyl neri$/i, /^justin joyce concepcion$/i];

async function calculate({ from: rangeFrom, to }) {
  const from = mondayOf(rangeFrom);
  const users = await listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems);
  const coordinators = new Map(users.filter(user => coordinatorTitle.test(user.WORK_POSITION || '') && !NOT_TRACKED_YET.some(rx => rx.test(fullName(user)))).map(user => [String(user.ID), { bitrixId: String(user.ID), name: fullName(user), deals: [] }]));
  const nameOf = new Map(users.map(user => [String(user.ID), fullName(user)]));

  /* deals with a Seller Call Completed Date in the range (the date comes back as a timestamp, so the calendar date is read from the text) */
  const deals = await listPaged('crm.deal.list', {
    filter: { [`>=${COMPLETED_FIELD}`]: addDays(from, -1), [`<${COMPLETED_FIELD}`]: addDays(to, 2) },
    select: ['ID', 'STAGE_ID', COMPLETED_FIELD]
  }, listItems);
  const dated = deals.map(deal => ({ id: String(deal.ID), stage: deal.STAGE_ID, day: String(deal[COMPLETED_FIELD] || '').slice(0, 10) }))
    .filter(deal => /^\d{4}-\d{2}-\d{2}$/.test(deal.day) && deal.day >= from && deal.day <= to);

  const ids = dated.map(deal => deal.id);
  const history = await historyFor(new Set(ids), addDays(from, -HISTORY_LOOKBACK_DAYS));
  const activityOf = new Map();
  for (const group of chunk(ids, 50)) {
    const rows = await listPaged('crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: group, SUBJECT: ACTIVITY_SUBJECT },
      select: ['ID', 'OWNER_ID', 'RESPONSIBLE_ID'], order: { ID: 'ASC' }
    }, listItems);
    rows.forEach(row => activityOf.set(String(row.OWNER_ID), String(row.RESPONSIBLE_ID))); /* ascending: the last one wins */
  }

  const portal = bitrix.portal();
  const skipped = { neverInSellerCall: 0, noCoordinatingActivity: 0, notACoordinator: {} };
  for (const deal of dated) {
    if (!(history.get(deal.id) || []).some(row => row.STAGE_ID === SELLER_STAGE) && deal.stage !== SELLER_STAGE) { skipped.neverInSellerCall++; continue; }
    const owner = activityOf.get(deal.id);
    if (!owner) { skipped.noCoordinatingActivity++; continue; }
    const coordinator = coordinators.get(owner);
    if (!coordinator) { const name = nameOf.get(owner) || `User ${owner}`; skipped.notACoordinator[name] = (skipped.notACoordinator[name] || 0) + 1; continue; }
    coordinator.deals.push({ id: deal.id, day: deal.day, week: mondayOf(deal.day), stage: deal.stage, url: `${portal}/crm/deal/details/${deal.id}/` });
  }

  /* nothing is booked on a weekend, so a week is finished once its Friday has passed */
  const today = reportToday();
  const weeks = weeksBetween(from, to).map(week => ({ ...week, inProgress: addDays(week.start, 4) >= today }));
  const rows = [...coordinators.values()].map(coordinator => ({
    bitrixId: coordinator.bitrixId,
    name: coordinator.name,
    weekly: weeks.map(week => coordinator.deals.filter(deal => deal.week === week.start).length),
    total: coordinator.deals.length,
    deals: coordinator.deals.sort((a, b) => (a.day < b.day ? 1 : -1))
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    range: { from: rangeFrom, to }, timezone: TIME_ZONE, weeks, coordinators: rows, skipped, provisional: true,
    notes: [
      'A completed booked seller call is a deal that has been in the Seller Call stage, has a Seller Call Completed Date, and has a "Coordinating Seller Call" activity assigned to the M&A Coordinator. It is counted in the week of the Seller Call Completed Date.',
      'Credit goes to the person on the deal\'s most recent Coordinating Seller Call activity. Deals whose activity is assigned to someone who is not an M&A Coordinator are not counted for anyone.',
      'Exceptional: 5 or more completed booked seller calls a week · Target: 4 · Below target: fewer than 4.'
    ]
  };
}

async function sellerCalls({ from, to, force }) {
  const { start, end } = resolveRange({ from, to }, DEFAULT_WEEKS, MAX_WEEKS);
  const result = await bitrix.loadCached(`kpi:seller-calls:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { sellerCalls };
