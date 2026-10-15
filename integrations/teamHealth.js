const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const { etDay, addDays, fromUtc, toUtc, listPaged, listItems } = require('./crmHistory');
const { dealsPresented } = require('./dealsPresented');

/* Team Sourcing Health (Score Card Mapping KPI 26, Deal Manager):
   share of M&A associates who reached the monthly baseline of 4 accepted and presented deals
   (1 per client per week x 4). Team target = headcount x 4.
   "Accepted and presented" uses the same rule as Deals Presented per Client per Week: a deal that moved straight from
   Video Presentation to Broker Intro Call, Seller Call, IOI Stage or LOI Stage in the month. */
const BASELINE_PER_ASSOCIATE = 4;
const MONTHS_BACK = 2;

const monthStart = (day, back) => { const [y, m] = day.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - back, 1)); return fromUtc(d.getTime()); };

async function calculate({ force }) {
  const today = reportToday();
  const requested = monthStart(today, MONTHS_BACK);
  const from = requested < config.COUNT_FROM ? config.COUNT_FROM : requested;
  const data = await dealsPresented({ from, to: today, force });
  const months = [...new Set(data.months)].filter(month => month >= from.slice(0, 7) && month <= today.slice(0, 7));
  const thisMonth = today.slice(0, 7);

  const associates = data.associates.map(associate => ({
    bitrixId: associate.bitrixId,
    name: associate.name,
    clients: associate.clients.length,
    monthly: Object.fromEntries(months.map(month => [month, associate.clients.reduce((sum, client) => sum + (client.monthly[month] || 0), 0)]))
  }));
  const rows = months.map(month => {
    const met = associates.filter(associate => associate.monthly[month] >= BASELINE_PER_ASSOCIATE).length;
    const total = associates.reduce((sum, associate) => sum + associate.monthly[month], 0);
    return { month, inProgress: month === thisMonth, headcount: associates.length, met, share: associates.length ? Math.round(met / associates.length * 1000) / 10 : null,
      teamTotal: total, teamTarget: associates.length * BASELINE_PER_ASSOCIATE };
  });
  const manager = await listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems);

  return {
    range: { from, to: today }, baseline: BASELINE_PER_ASSOCIATE, months: rows, associates,
    dealManagers: manager.filter(user => /^deal manager$/i.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' ') })),
    provisional: true,
    notes: [
      'An associate reaches the baseline in a month with 4 or more accepted and presented deals (a deal that moved straight from Video Presentation to Broker Intro Call, Seller Call, IOI Stage or LOI Stage).',
      'Team = every active M&A Associate who has at least one Deal Flow client. Team target = headcount x 4.',
      'The document says low and medium volume clients need 1 and 2 deals a month, but it does not say how that changes an associate\'s baseline, so every associate is held to 4.'
    ]
  };
}

async function teamHealth({ force }) {
  const result = await bitrix.loadCached('kpi:team-sourcing-health', () => calculate({ force }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { teamHealth };
