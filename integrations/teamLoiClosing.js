const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const { etDay, fromUtc, toUtc, DAY } = require('./crmHistory');
const { signedLois } = require('./signedLois');
const { closingAgreements } = require('./closingAgreements');

/* Team LOI & Closing Health (Score Card Mapping, Deal Execution Manager).
   Team = every Deal Analyst plus every Closing Analyst (confirmed). Share of the team at their own monthly baseline:
   Deal Analyst 1 signed LOI a week (4 a month), Closing Analyst 1 deal entering Closing a month.
   Exceptional 100% of the team, Target 90% or more, Below target under 90%. */
const LOI_PER_MONTH = 4;
const CLOSING_PER_MONTH = 1;
const MONTHS_BACK = 2;
const RAMP_DAYS = 45;

const monthStart = (day, back) => { const [y, m] = day.split('-').map(Number); return fromUtc(Date.UTC(y, m - 1 - back, 1)); };
const monthEnd = month => { const [y, m] = month.split('-').map(Number); return fromUtc(Date.UTC(y, m, 0)); };

async function calculate({ force }) {
  const today = reportToday();
  const thisMonth = today.slice(0, 7);
  const requested = monthStart(today, MONTHS_BACK);
  const from = requested < config.COUNT_FROM ? config.COUNT_FROM : requested;
  const months = [0, 1, 2].map(i => monthStart(today, MONTHS_BACK - i).slice(0, 7)).filter(month => month >= config.COUNT_FROM.slice(0, 7));
  const [loi, closing] = await Promise.all([signedLois({ from, to: today, force }), closingAgreements({ force })]);

  const members = [
    ...loi.analysts.map(a => ({ role: 'Deal Analyst', name: a.name, bitrixId: a.bitrixId, baseline: LOI_PER_MONTH, hireDate: a.hireDate, monthly: a.monthly })),
    ...closing.analysts.map(a => ({ role: 'Closing Analyst', name: a.name, bitrixId: a.bitrixId, baseline: CLOSING_PER_MONTH, hireDate: null, monthly: a.monthly }))
  ];
  /* a new hire is not scored until their 45-day ramp has ended, as in Signed LOIs per Week */
  const scored = (member, month) => !member.hireDate || toUtc(member.hireDate) + RAMP_DAYS * DAY <= toUtc(monthEnd(month));

  const rows = months.map(month => {
    const team = members.filter(member => scored(member, month));
    const met = team.filter(member => (member.monthly[month] || 0) >= member.baseline);
    return { month, inProgress: month === thisMonth, headcount: team.length, met: met.length, share: team.length ? Math.round(met.length / team.length * 1000) / 10 : null,
      members: members.map(member => ({ name: member.name, role: member.role, baseline: member.baseline, count: member.monthly[month] || 0,
        scored: scored(member, month), met: scored(member, month) ? (member.monthly[month] || 0) >= member.baseline : null })) };
  });
  return {
    range: { from, to: today }, loiPerMonth: LOI_PER_MONTH, closingPerMonth: CLOSING_PER_MONTH, months: rows, provisional: true,
    notes: [
      'Team = every Deal Analyst plus every Closing Analyst. Each is held to their own baseline for the month.',
      'Deal Analyst baseline: 1 signed LOI a week, counted as 4 a month. Signed LOIs use the LOI Signed Date and are credited to the Deal Analyst on the client profile, as in Signed LOIs per Week.',
      'Closing Analyst baseline: 1 deal that first moves into Closing in the month, credited to the Closing Analyst on the deal.',
      'Contractors still inside their 45-day ramp are left out of that month.',
      'Exceptional: 100% of the team at baseline · Target: 90% or more · Below target: under 90%.'
    ]
  };
}

async function teamLoiClosing({ force }) {
  const result = await bitrix.loadCached('kpi:team-loi-closing', () => calculate({ force }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { teamLoiClosing };
