const bitrix = require('./bitrix');
const { reportToday } = require('./config');
const { etDay, mondayOf, addDays, entriesInto } = require('./crmHistory');

/* KPI Check: does a KPI move with a business outcome?
   For each KPI that has a stage-history proxy, the weekly count of deals entering the KPI's stages is compared with the weekly count
   of deals entering an outcome stage some weeks later (Pearson correlation, best lag within a limit).
   It uses company-wide Bitrix stage history for the last WEEKS finished weeks, including weeks before scoring started,
   because a test needs a long history. KPIs with no Bitrix deal series (tasks, Notion, HR) are not tested. */
const WEEKS = 26;
const MIN_PAIRS = 12;
const STAGES = {
  valuation: ['FINANCIAL_MODEL'],
  review: ['MODEL_REVIEW'],
  loi: ['NEGOTIATION'],
  postLoi: ['DUE_DILIGENCE'],
  closing: ['LAST_PHASE'],
  closed: ['WON'],
  presented: ['DEAL_PRESENTATION'],
  accepted: ['INTRO_CALL', 'SELLER_CALL', 'IOI_STAGE']
};
const LABEL = {
  valuation: 'deals moved into Valuation Modeling',
  review: 'deals moved into Valuation Model For Review',
  postLoi: 'deals moved into Post LOI Stage',
  closing: 'deals moved into Closing',
  loi: 'deals moved into LOI Stage',
  closed: 'deals closed (Deal Closed)',
  presented: 'deals moved into Video Presentation',
  accepted: 'deals accepted (Broker Intro Call, Seller Call or IOI Stage)'
};
/* proxy = what is counted for the KPI, outcome = what it should lead to, maxLag = longest delay tested, in weeks */
const TESTS = [
  { id: 'signed_lois', proxy: 'loi', outcome: 'closed', maxLag: 12 },
  { id: 'acceptance_rate', proxy: 'accepted', outcome: 'loi', maxLag: 8 },
  { id: 'val_reviews', proxy: 'presented', outcome: 'accepted', maxLag: 6 },
  { id: 'val_models', proxy: 'review', outcome: 'presented', maxLag: 4 },
  /* a rate: the share of deals moved into valuation that reached Video Presentation in the same week */
  { id: 'sourcing_quality', proxy: 'presented', per: 'valuation', proxyLabel: 'the share of deals moved into valuation that reached Video Presentation', outcome: 'accepted', maxLag: 6 },
  { id: 'purchase_agreements', proxy: 'closing', outcome: 'closed', maxLag: 8 },
  { id: 'loi_conversion', proxy: 'loi', outcome: 'postLoi', maxLag: 8 },
  { id: 'closing_conversion', proxy: 'postLoi', outcome: 'closed', maxLag: 8 }
];

const pearson = (xs, ys) => {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
};
const strengthOf = r => (r >= 0.8 ? ['Very strong', 'strong'] : r >= 0.6 ? ['Strong', 'strong'] : r >= 0.35 ? ['Moderate', 'mid'] : ['Weak', 'weak']);

async function calculate() {
  const lastWeek = addDays(mondayOf(reportToday()), -7);
  const first = addDays(lastWeek, -(WEEKS - 1) * 7);
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(first, i * 7));
  const index = new Map(weeks.map((week, i) => [week, i]));

  const series = {};
  for (const [key, stages] of Object.entries(STAGES)) {
    const seen = new Set();
    const counts = weeks.map(() => 0);
    (await entriesInto(stages, addDays(first, -1))).forEach(row => {
      const i = index.get(mondayOf(etDay(row.CREATED_TIME)));
      const once = `${row.OWNER_ID}:${i}`;
      if (i === undefined || seen.has(once)) return;
      seen.add(once);
      counts[i]++;
    });
    series[key] = counts;
  }

  const tests = TESTS.map(test => {
    const x = test.per ? series[test.proxy].map((n, i) => (series[test.per][i] ? n / series[test.per][i] : 0)) : series[test.proxy], y = series[test.outcome];
    let best = null;
    for (let lag = 0; lag <= test.maxLag; lag++) {
      const n = WEEKS - lag;
      if (n < MIN_PAIRS) break;
      const r = pearson(x.slice(0, n), y.slice(lag));
      if (r != null && (!best || r > best.r)) best = { lag, r, n };
    }
    const proxyLabel = test.proxyLabel || LABEL[test.proxy];
    const base = { id: test.id, proxy: proxyLabel, outcome: LABEL[test.outcome], maxLag: test.maxLag };
    if (!best) return { ...base, rating: 'Not enough data yet', key: 'none', detail: `Needs at least ${MIN_PAIRS} weeks of activity in both series; the series are flat or too short.` };
    const r = Math.round(best.r * 100) / 100;
    const [rating, key] = strengthOf(best.r);
    return { ...base, rating, key, r, lagWeeks: best.lag, pairs: best.n,
      detail: `Over ${best.n} weeks, ${proxyLabel} moved with ${LABEL[test.outcome]} ${best.lag === 0 ? 'in the same week' : best.lag + ' week' + (best.lag === 1 ? '' : 's') + ' later'} (correlation ${r}).` };
  });

  return {
    from: first, to: addDays(lastWeek, 6), weeks: WEEKS, minPairs: MIN_PAIRS, tests, provisional: true,
    notes: [
      'Each test counts company-wide deals entering a stage per week (a deal counts once per week per stage) and compares it with the outcome count some weeks later. The delay with the strongest link is shown.',
      'Correlation is not proof that one thing causes the other, and picking the best delay makes a result look slightly stronger than it is. Very strong: 0.8 or more · Strong: 0.6 or more · Moderate: 0.35 or more · Weak: under 0.35.',
      'The tests use Bitrix history from before scoring started, so the longer window gives a fair test. Rate KPIs are tested through the count of deals behind them (Sourcing Quality through the weekly share).',
      'KPIs without a Bitrix deal series (tasks, Notion, HR, onboarding) cannot be tested this way.'
    ]
  };
}

async function kpiCheck({ force }) {
  const result = await bitrix.loadCached('kpi:kpi-check', calculate, force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { kpiCheck };
