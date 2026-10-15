const bitrix = require('./bitrix');
const { TIME_ZONE, etDay, mondayOf, addDays, listPaged, listItems, chunk, fullName, historyFor, entriesInto, weeksBetween, resolveRange } = require('./crmHistory');

/* Deal Acceptance Rate (Score Card Mapping KPI 27, Assistant Deal Manager) and
   Sourcing Quality (KPI 28, Deal Sourcing Team Lead). Both are read from Bitrix deal stage history.
   Acceptance: of the deals that left Video Presentation, how many went to Broker Intro Call, Seller Call or IOI Stage (accepted)
   versus Axed. Moving straight to LOI Stage is shown separately and is not in the rate.
   Sourcing quality: of the deals an associate moved into Valuation Modeling / Valuation Model For Review, how many
   later reached Video Presentation. */
const VALUATION = ['FINANCIAL_MODEL', 'MODEL_REVIEW'];
const PRESENTATION = 'DEAL_PRESENTATION';
const ACCEPTED = ['INTRO_CALL', 'SELLER_CALL', 'IOI_STAGE'];
const LOI = 'NEGOTIATION';
const AXED = 'LOSE';
const TEAM_LEADER_FIELD = 'UF_USR_1779466932710';
/* the "Team Leader Name" text on an associate's profile -> the lead's full name in Bitrix */
const LEAD_ALIAS = { ea: 'Emmanuel Dominguez Amboya', rox: 'Ma. Roxette Molina Rojas', moeez: 'Moeez Ul Hassan Khan', rana: 'Rana Kamilah Macauba Torres', lemon: 'Lemmuel Rafael De Guzman' };
const normName = text => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
const sameName = (a, b) => normName(a) === normName(b);
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 60;
const LOOKBACK_DAYS = 120;
const MAX_LISTED = 150;

const rate = (num, den) => (den ? Math.round(num / den * 1000) / 10 : null);
const emptyAcceptance = () => ({ accepted: 0, axed: 0, toLoi: 0, other: 0 });
const emptySourcing = () => ({ transferred: 0, advanced: 0, axed: 0, pending: 0 });

async function calculate({ from, to }) {
  const portal = bitrix.portal();
  const weeks = weeksBetween(from, to);
  const weekIndex = new Map(weeks.map((week, index) => [week.start, index]));
  const months = [...new Set(weeks.flatMap(week => [week.start.slice(0, 7), week.end.slice(0, 7)]))].sort();

  const [users, outcomeEntries, valuationEntries] = await Promise.all([
    listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems),
    entriesInto([...ACCEPTED, LOI, AXED], addDays(from, -1)),
    entriesInto(VALUATION, addDays(from, -1))
  ]);
  const dealIds = new Set([...outcomeEntries, ...valuationEntries].map(entry => String(entry.OWNER_ID)));
  const history = await historyFor(dealIds, addDays(from, -LOOKBACK_DAYS));

  /* ---- Deal Acceptance Rate ---- */
  const acceptance = { weekly: weeks.map(emptyAcceptance), monthly: Object.fromEntries(months.map(month => [month, emptyAcceptance()])), total: emptyAcceptance(), daily: {} };
  const axedDeals = [];
  for (const [dealId, rows] of history) {
    rows.forEach((row, index) => {
      if (index === 0 || rows[index - 1].STAGE_ID !== PRESENTATION || row.STAGE_ID === PRESENTATION) return;
      const day = etDay(row.CREATED_TIME);
      if (day < from || day > to) return;
      const kind = ACCEPTED.includes(row.STAGE_ID) ? 'accepted' : row.STAGE_ID === AXED ? 'axed' : row.STAGE_ID === LOI ? 'toLoi' : 'other';
      for (const bucket of [acceptance.weekly[weekIndex.get(mondayOf(day))], acceptance.monthly[day.slice(0, 7)], acceptance.total]) bucket[kind]++;
      (acceptance.daily[day] = acceptance.daily[day] || emptyAcceptance())[kind]++;
      if (kind === 'axed') axedDeals.push({ id: dealId, day, url: `${portal}/crm/deal/details/${dealId}/` });
    });
  }
  axedDeals.sort((a, b) => (a.day < b.day ? 1 : -1));
  const addRates = bucket => ({ ...bucket, rate: rate(bucket.accepted, bucket.accepted + bucket.axed) });
  const assistantDealManagers = users.filter(user => /^assistant deal manager$/i.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: fullName(user) }));

  /* ---- Sourcing Quality ---- */
  const transfers = new Map();
  for (const [dealId, rows] of history) {
    const first = rows.findIndex(row => VALUATION.includes(row.STAGE_ID));
    if (first < 0) continue;
    const day = etDay(rows[first].CREATED_TIME);
    if (day < from || day > to) continue;
    const after = rows.slice(first + 1);
    const outcome = after.some(row => row.STAGE_ID === PRESENTATION) ? 'advanced' : after.some(row => row.STAGE_ID === AXED) ? 'axed' : 'pending';
    transfers.set(dealId, { dealId, day, week: weekIndex.get(mondayOf(day)), outcome });
  }
  const responsible = new Map();
  for (const ids of chunk([...transfers.keys()], 50)) {
    (await listPaged('crm.deal.list', { filter: { ID: ids }, select: ['ID', 'ASSIGNED_BY_ID'] }, listItems))
      .forEach(deal => responsible.set(String(deal.ID), String(deal.ASSIGNED_BY_ID)));
  }

  const leads = users.filter(user => /^deal sourcing (team )?lead$/i.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: fullName(user), associates: new Map() }));
  const leadFor = text => { const full = LEAD_ALIAS[String(text || '').trim().toLowerCase()]; return full ? leads.find(lead => sameName(lead.name, full)) : null; };
  const associateOwner = new Map();
  const unmappedAssociates = [];
  for (const user of users.filter(u => /^m&a associate$/i.test(u.WORK_POSITION || ''))) {
    const lead = leadFor(user[TEAM_LEADER_FIELD]);
    if (!lead) { unmappedAssociates.push(fullName(user)); continue; }
    const row = { bitrixId: String(user.ID), name: fullName(user), weekly: weeks.map(emptySourcing), total: emptySourcing(), daily: {} };
    lead.associates.set(row.bitrixId, row);
    associateOwner.set(row.bitrixId, row);
  }
  let notUnderALead = 0;
  for (const transfer of transfers.values()) {
    const associate = associateOwner.get(responsible.get(transfer.dealId));
    if (!associate) { notUnderALead++; continue; }
    for (const bucket of [associate.weekly[transfer.week], associate.total]) {
      bucket.transferred++;
      bucket[transfer.outcome]++;
    }
    const dayBucket = (associate.daily[transfer.day] = associate.daily[transfer.day] || emptySourcing());
    dayBucket.transferred++;
    dayBucket[transfer.outcome]++;
  }
  const sum = list => list.reduce((acc, item) => { Object.keys(acc).forEach(key => { acc[key] += item[key]; }); return acc; }, emptySourcing());
  const mergeDaily = list => list.reduce((all, daily) => { Object.entries(daily).forEach(([day, b]) => { const e = (all[day] = all[day] || emptySourcing()); Object.keys(e).forEach(k => { e[k] += b[k]; }); }); return all; }, {});
  const sourcingRates = bucket => ({ ...bucket, rate: rate(bucket.advanced, bucket.transferred) });
  const sourcingLeads = leads.map(lead => {
    const associates = [...lead.associates.values()];
    return {
      bitrixId: lead.bitrixId, name: lead.name,
      weekly: weeks.map((week, index) => sourcingRates(sum(associates.map(a => a.weekly[index])))),
      total: sourcingRates(sum(associates.map(a => a.total))),
      daily: mergeDaily(associates.map(a => a.daily)),
      associates: associates.map(a => ({ bitrixId: a.bitrixId, name: a.name, weekly: a.weekly.map(sourcingRates), total: sourcingRates(a.total), daily: a.daily }))
        .sort((x, y) => x.name.localeCompare(y.name))
    };
  });

  return {
    range: { from, to }, timezone: TIME_ZONE, weeks, months, provisional: true,
    acceptance: {
      weekly: acceptance.weekly.map(addRates),
      monthly: Object.fromEntries(Object.entries(acceptance.monthly).map(([month, bucket]) => [month, addRates(bucket)])),
      total: addRates(acceptance.total),
      daily: acceptance.daily,
      axedDeals: axedDeals.slice(0, MAX_LISTED), axedDealsTotal: axedDeals.length,
      assistantDealManagers
    },
    sourcing: { leads: sourcingLeads, dealsNotUnderALead: notUnderALead, unmappedAssociates },
    notes: [
      'Deal Acceptance Rate = deals moved from Video Presentation to Broker Intro Call, Seller Call or IOI Stage, divided by those plus deals Axed from Video Presentation. Deals that went straight to LOI Stage, or to any other stage, are shown separately and are not in the rate. Deals still sitting in Video Presentation are not counted yet.',
      'Bitrix has no link between an Assistant Deal Manager and specific associates, so the acceptance rate is calculated across all associates and shown on each Assistant Deal Manager.',
      'Sourcing Quality = deals moved into Valuation Modeling or Valuation Model For Review that later reached Video Presentation, divided by all deals moved in. Deals still in valuation count as not yet advanced, so recent weeks are not final. Deals are credited to the deal\'s Responsible person.',
      'An associate belongs to a Deal Sourcing Lead through the "Team Leader Name" text on their Bitrix profile (Rox, Moeez, Lemon, EA, Rana), matched to the lead by full name (EA = Emmanuel Dominguez Amboya, Rox = Ma. Roxette Molina Rojas, Moeez = Moeez Ul Hassan Khan, Rana = Rana Kamilah Macauba Torres, Lemon = Lemmuel Rafael De Guzman).'
    ]
  };
}

async function dealQuality({ from, to, force }) {
  const { start, end } = resolveRange({ from, to }, DEFAULT_WEEKS, MAX_WEEKS);
  const result = await bitrix.loadCached(`kpi:deal-quality:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { dealQuality };
