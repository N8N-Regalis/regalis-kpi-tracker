const bitrix = require('./bitrix');
const { reportToday } = require('./config');
const { TIME_ZONE, etDay, mondayOf, addDays, listPaged, listItems, chunk, fullName, historyFor, entriesInto, weeksBetween, resolveRange } = require('./crmHistory');

/* Deals Presented per Client per Week (Score Card Mapping KPI 29, M&A Associate).
   A deal counts when it moves straight from Video Presentation to Broker Intro Call, Seller Call or LOI Stage,
   and is counted in the week of the deal's Presented Date (falls back to the move day, ET, when it is empty). It is credited to the client's Responsible person if that person is an M&A Associate.
   Clients counted: contacts whose Client's Status is "Deal Flow". Volume: Low = 1 per month, Medium = 2 per month,
   Normal or not set = 1 per week. */
const FROM_STAGE = 'DEAL_PRESENTATION';
const TO_STAGES = ['INTRO_CALL', 'SELLER_CALL', 'IOI_STAGE', 'NEGOTIATION'];
const STATUS_FIELD = 'UF_CRM_1755185977882';
const VOLUME_FIELD = 'UF_CRM_1770744593756';
const PRESENTED_DATE_FIELD = 'UF_CRM_1768236671239';
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
      volume: volume === 'Low' || volume === 'Medium' ? volume : 'Normal', volumeSet: Boolean(volume), deals: [] };
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

  /* the week comes from the deal's Presented Date, not from the day it was answered; no Presented Date = the move day */
  const contactOf = new Map();
  for (const ids of chunk([...moves.keys()], 50)) {
    const deals = await listPaged('crm.deal.list', { filter: { ID: ids }, select: ['ID', 'CONTACT_ID', PRESENTED_DATE_FIELD] }, listItems);
    deals.forEach(deal => {
      const move = moves.get(String(deal.ID));
      contactOf.set(String(deal.ID), String(deal.CONTACT_ID));
      /* a Bitrix date comes back as a timestamp at midnight in the portal's zone, so read the calendar date from the text */
      const presented = String(deal[PRESENTED_DATE_FIELD] || '').slice(0, 10);
      move.day = /^\d{4}-\d{2}-\d{2}$/.test(presented) ? presented : move.moveDay;
    });
  }
  for (const [dealId, move] of moves) if (!move.day || move.day < from || move.day > to) moves.delete(dealId);

  /* nothing is presented on a weekend, so a week is finished once its Friday has passed */
  const today = reportToday();
  const weeks = weeksBetween(from, to).map(week => ({ ...week, inProgress: addDays(week.start, 4) >= today }));
  let unmatched = 0;
  for (const move of moves.values()) {
    const client = clients.get(contactOf.get(move.dealId));
    if (!client) { unmatched++; continue; }
    client.deals.push({ id: move.dealId, day: move.day, week: mondayOf(move.day), stage: move.stage, answeredOn: move.moveDay });
  }

  const portal = bitrix.portal();
  const months = [...new Set(weeks.flatMap(week => [week.start.slice(0, 7), week.end.slice(0, 7)]))].filter(month => month >= rangeFrom.slice(0, 7) && month <= to.slice(0, 7)).sort();
  const rows = [...associates.values()].filter(associate => associate.clients.length).map(associate => ({
    bitrixId: associate.bitrixId,
    name: associate.name,
    clients: associate.clients.sort((a, b) => a.name.localeCompare(b.name)).map(client => ({
      id: client.id, name: client.name, volume: client.volume, volumeSet: client.volumeSet, url: `${portal}/crm/contact/details/${client.id}/`,
      weekly: weeks.map(week => client.deals.filter(deal => deal.week === week.start).length),
      monthly: Object.fromEntries(months.map(month => [month, client.deals.filter(deal => deal.day.startsWith(month)).length])),
      deals: client.deals.sort((a, b) => (a.day < b.day ? -1 : 1)).map(deal => ({ ...deal, url: `${portal}/crm/deal/details/${deal.id}/` }))
    }))
  }));

  return {
    range: { from: rangeFrom, to }, timezone: TIME_ZONE, weeks, months, associates: rows, provisional: true,
    totals: { clients: clients.size, associates: rows.length, dealsMoved: moves.size, dealsNotMatchedToAClient: unmatched, dealFlowClientsWithoutAnAssociate: notAssociate },
    notes: [
      'A deal counts once it has moved straight from Video Presentation to Broker Intro Call, Seller Call, IOI Stage or LOI Stage. It is counted in the week of its Presented Date, even if the response came in a later week (a deal with no Presented Date is counted in the week it moved). Each deal is counted once.',
      'Clients counted: Client\'s Status is Deal Flow and the Responsible person is an active M&A Associate.',
      'A client with no Low or Medium volume set is a Normal volume client (confirmed) and is held to at least 1 deal per week. Low volume clients need at least 1 per month and Medium at least 2 per month.'
    ]
  };
}

async function dealsPresented({ from, to, force }) {
  const { start, end } = resolveRange({ from, to }, DEFAULT_WEEKS, MAX_WEEKS);
  const result = await bitrix.loadCached(`kpi:deals-presented:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { dealsPresented };
