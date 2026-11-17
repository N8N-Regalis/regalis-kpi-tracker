const bitrix = require('./bitrix');
const { reportToday } = require('./config');
const { TIME_ZONE, etDay, mondayOf, addDays, listPaged, listItems, chunk, fullName, historyFor, entriesInto, weeksBetween, resolveRange } = require('./crmHistory');

/* Deals Presented per Client per Week (Score Card Mapping KPI 29, M&A Associate). Rule updated 2026-11-17:
   Presented = a deal with a Presented Date in the period (ET calendar date). Accepted = a presented deal that moved straight from
   Video Presentation to Broker Intro Call, Seller Call, IOI Stage or LOI Stage (no Presented Date = counted on the move day).
   Deals axed with the reason "Auto-axed" are not client rejections and are not counted as presented.
   Normal or not set (weekly): Target = at least 1 accepted and at least 2 presented per week, Exceptional = 3+ accepted, otherwise below target.
   Low (monthly; Medium is treated as Low, there is no Medium rule any more): Target = 1+ accepted and 2+ presented per month, Exceptional = 2+ accepted,
   Below target = 0 presented in 2 months. Credited to the client's Responsible person if that person is an M&A Associate.
   Clients counted: contacts whose Client's Status is "Deal Flow". */
const FROM_STAGE = 'DEAL_PRESENTATION';
const TO_STAGES = ['INTRO_CALL', 'SELLER_CALL', 'IOI_STAGE', 'NEGOTIATION'];
const STATUS_FIELD = 'UF_CRM_1755185977882';
const VOLUME_FIELD = 'UF_CRM_1770744593756';
const PRESENTED_DATE_FIELD = 'UF_CRM_1768236671239';
const AXED_STAGE = 'LOSE';
const AXED_REASON_FIELD = 'UF_CRM_1755636401';
const AUTO_AXED = '881'; /* "Auto-axed - Partner did not respond for 1 week" */
const ACTIVE_STATUS = 'Deal Flow';
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 60;
const HISTORY_LOOKBACK_DAYS = 120;
const associateTitle = /^m&a associate$/i;

async function calculate({ from: rangeFrom, to }) {
  /* a week is counted whole: the week that contains the first counted day starts on its Monday */
  const from = mondayOf(rangeFrom);
  const [users, contactFields] = await Promise.all([
    listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems),
    bitrix.call('crm.contact.fields')
  ]);
  const associates = new Map(users.filter(user => associateTitle.test(user.WORK_POSITION || '')).map(user => [String(user.ID), { bitrixId: String(user.ID), name: fullName(user), clients: [] }]));
  const optionName = field => new Map((contactFields.result?.[field]?.items || []).map(item => [String(item.ID), item.VALUE]));
  const statusName = optionName(STATUS_FIELD), volumeName = optionName(VOLUME_FIELD);

  const contacts = await listPaged('crm.contact.list', { select: ['ID', 'NAME', 'LAST_NAME', 'ASSIGNED_BY_ID', STATUS_FIELD, VOLUME_FIELD] }, listItems);
  const clients = new Map();
  let notAssociate = 0;
  for (const contact of contacts) {
    if (statusName.get(String(contact[STATUS_FIELD])) !== ACTIVE_STATUS) continue;
    const associate = associates.get(String(contact.ASSIGNED_BY_ID));
    if (!associate) { notAssociate++; continue; }
    const volume = volumeName.get(String(contact[VOLUME_FIELD])) || null;
    const client = { id: String(contact.ID), name: [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ').trim() || `Client ${contact.ID}`,
      volume: volume === 'Low' || volume === 'Medium' ? 'Low' : 'Normal', volumeSet: Boolean(volume), deals: [] };
    clients.set(client.id, client);
    associate.clients.push(client);
  }

  /* moves straight out of Video Presentation */
  const entries = await entriesInto(TO_STAGES, addDays(from, -1));
  const history = await historyFor(new Set(entries.map(entry => String(entry.OWNER_ID))), addDays(from, -HISTORY_LOOKBACK_DAYS));
  const moves = new Map();
  for (const [dealId, rows] of history) {
    rows.forEach((row, index) => {
      if (index === 0 || !TO_STAGES.includes(row.STAGE_ID) || rows[index - 1].STAGE_ID !== FROM_STAGE) return;
      const day = etDay(row.CREATED_TIME);
      if (day <= to && !moves.has(dealId)) moves.set(dealId, { dealId, moveDay: day, stage: row.STAGE_ID });
    });
  }

  /* presented = Presented Date in the range (any outcome); accepted = also moved straight out of Video Presentation to an accepted stage */
  const select = ['ID', 'CONTACT_ID', 'STAGE_ID', PRESENTED_DATE_FIELD, AXED_REASON_FIELD];
  const rowsById = new Map();
  const byDate = await listPaged('crm.deal.list', { filter: { [`>=${PRESENTED_DATE_FIELD}`]: from, [`<${PRESENTED_DATE_FIELD}`]: addDays(to, 1) }, select }, listItems);
  byDate.forEach(deal => rowsById.set(String(deal.ID), deal));
  for (const ids of chunk([...moves.keys()].filter(id => !rowsById.has(id)), 50)) {
    (await listPaged('crm.deal.list', { filter: { ID: ids }, select }, listItems)).forEach(deal => rowsById.set(String(deal.ID), deal));
  }
  const presentedDeals = [];
  let autoAxed = 0;
  for (const [dealId, deal] of rowsById) {
    const move = moves.get(dealId);
    /* a Bitrix date comes back as a timestamp at midnight in the portal's zone, so read the calendar date from the text */
    const presented = String(deal[PRESENTED_DATE_FIELD] || '').slice(0, 10);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(presented) ? presented : move && move.moveDay;
    if (!day || day < from || day > to) continue;
    if (deal.STAGE_ID === AXED_STAGE && String(deal[AXED_REASON_FIELD]) === AUTO_AXED) { autoAxed++; continue; }
    presentedDeals.push({ dealId, contactId: String(deal.CONTACT_ID), day, moveDay: move ? move.moveDay : null, accepted: Boolean(move), stage: move ? move.stage : deal.STAGE_ID });
  }

  /* nothing is presented on a weekend, so a week is finished once its Friday has passed */
  const today = reportToday();
  const weeks = weeksBetween(from, to).map(week => ({ ...week, inProgress: addDays(week.start, 4) >= today }));
  let unmatched = 0;
  for (const deal of presentedDeals) {
    const client = clients.get(deal.contactId);
    if (!client) { unmatched++; continue; }
    client.deals.push({ id: deal.dealId, day: deal.day, week: mondayOf(deal.day), stage: deal.stage, accepted: deal.accepted, answeredOn: deal.moveDay });
  }

  const portal = bitrix.portal();
  const months = [...new Set(weeks.flatMap(week => [week.start.slice(0, 7), week.end.slice(0, 7)]))].filter(month => month >= rangeFrom.slice(0, 7) && month <= to.slice(0, 7)).sort();
  const rows = [...associates.values()].filter(associate => associate.clients.length).map(associate => ({
    bitrixId: associate.bitrixId,
    name: associate.name,
    clients: associate.clients.sort((a, b) => a.name.localeCompare(b.name)).map(client => ({
      id: client.id, name: client.name, volume: client.volume, volumeSet: client.volumeSet, url: `${portal}/crm/contact/details/${client.id}/`,
      weekly: weeks.map(week => client.deals.filter(deal => deal.week === week.start).length),
      weeklyAccepted: weeks.map(week => client.deals.filter(deal => deal.week === week.start && deal.accepted).length),
      monthly: Object.fromEntries(months.map(month => [month, client.deals.filter(deal => deal.day.startsWith(month)).length])),
      monthlyAccepted: Object.fromEntries(months.map(month => [month, client.deals.filter(deal => deal.day.startsWith(month) && deal.accepted).length])),
      deals: client.deals.sort((a, b) => (a.day < b.day ? -1 : 1)).map(deal => ({ ...deal, url: `${portal}/crm/deal/details/${deal.id}/` }))
    }))
  }));

  return {
    range: { from: rangeFrom, to }, timezone: TIME_ZONE, weeks, months, associates: rows, provisional: true,
    totals: { clients: clients.size, associates: rows.length, dealsPresented: presentedDeals.length, autoAxedNotCounted: autoAxed, dealsNotMatchedToAClient: unmatched, dealFlowClientsWithoutAnAssociate: notAssociate },
    notes: [
      'A deal is presented when it has a Presented Date, counted in the week (or month) of that date. It is accepted when it also moved straight from Video Presentation to Broker Intro Call, Seller Call, IOI Stage or LOI Stage (a deal with no Presented Date is counted on the day it moved). Each deal is counted once. Deals axed with the reason Auto-axed are not counted.',
      "Clients counted: Client's Status is Deal Flow and the Responsible person is an active M&A Associate.",
      'Normal volume (and any client with no volume set), per week: Target = at least 1 accepted and at least 2 presented; Exceptional = 3 or more accepted; Below target = fewer than 2 presented or no accepted deal. Low volume, per month: Target = at least 1 accepted and 2 presented; Exceptional = 2 or more accepted; Below target = 0 presented in 2 months.'
    ]
  };
}

async function dealsPresented({ from, to, force }) {
  const { start, end } = resolveRange({ from, to }, DEFAULT_WEEKS, MAX_WEEKS);
  const result = await bitrix.loadCached(`kpi:deals-presented:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { dealsPresented };
