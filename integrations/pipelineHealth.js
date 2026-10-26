const bitrix = require('./bitrix');
const { reportToday } = require('./config');
const { etDay, addDays, toUtc, DAY, entriesInto, validDay } = require('./crmHistory');

/* Pipeline Health: where deals are now and where they get stuck, from Bitrix stage history.
   Steps run along the main line of the Default pipeline. Broker Intro Call, Seller Call and IOI Stage are one "Accepted" step.
   "Got here" = deals that entered the step between the chosen dates (the last WINDOW_DAYS days by default) out of those that entered the step above (a ratio of counts, not a strict cohort).
   Waiting time = days since a deal last entered the stage it sits in, read from stage history going back LOOKBACK_DAYS. */
const WINDOW_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const LOOKBACK_DAYS = 120;
const MIN_QUEUE = 10;
const MAIN_LINE = [
  { key: 'sourced', ids: [], name: 'Deals Sourced' },
  { key: 'valuation', ids: ['FINANCIAL_MODEL'] },
  { key: 'review', ids: ['MODEL_REVIEW'] },
  { key: 'presentation', ids: ['DEAL_PRESENTATION'] },
  { key: 'accepted', ids: ['INTRO_CALL', 'SELLER_CALL', 'IOI_STAGE'], name: 'Accepted (Intro Call, Seller Call or IOI)' },
  { key: 'loi', ids: ['NEGOTIATION'] },
  { key: 'postLoi', ids: ['DUE_DILIGENCE'] },
  { key: 'closing', ids: ['LAST_PHASE'] },
  { key: 'closed', ids: ['WON'] }
];
const SIDE = ['NEW', 'ACTION_REQUIRED', 'POST_SELLER', 'COUNTER_NEGO', 'LENDER', 'LEGALITIES', 'HOLD', 'LOSE'];
/* a deal has left a step once it enters any of these later stages (or is Axed); a send-back or On Hold is not counted as leaving */
const LATER = ['IOI_STAGE', 'INTRO_CALL', 'SELLER_CALL', 'POST_SELLER', 'NEGOTIATION', 'COUNTER_NEGO', 'DUE_DILIGENCE', 'LENDER', 'LEGALITIES', 'LAST_PHASE', 'WON', 'DEAL_PRESENTATION', 'MODEL_REVIEW', 'LOSE'];

const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const round1 = value => (value == null ? null : Math.round(value * 10) / 10);

async function calculate({ from, to }) {
  const today = reportToday();
  const windowFrom = from, windowTo = to;
  const windowDays = (toUtc(windowTo) - toUtc(windowFrom)) / DAY + 1;
  /* waiting times are as of today, so history is read back far enough for them too */
  const lookFrom = windowFrom < addDays(today, -LOOKBACK_DAYS) ? windowFrom : addDays(today, -LOOKBACK_DAYS);
  const [deals, stages] = await Promise.all([
    bitrix.loadCached('deals', bitrix.getDeals),
    bitrix.loadCached('stages', bitrix.getStages)
  ]);
  const sortOf = new Map(stages.data.filter(stage => stage.categoryId === '0').map(stage => [stage.id, stage.sort]));
  const nameOf = new Map(stages.data.filter(stage => stage.categoryId === '0').map(stage => [stage.id, stage.name]));
  const allDeals = deals.data.deals.filter(deal => String(deal.CATEGORY_ID || '0') === '0');

  /* the latest time each deal moved into each stage, within the lookback */
  const stageIds = [...new Set([...MAIN_LINE.flatMap(step => step.ids), ...SIDE, ...LATER])];
  const lastEntry = new Map(); /* stage -> Map(deal -> day) */
  const inWindow = new Map(); /* stage -> Set(deal) */
  await Promise.all(stageIds.map(async stage => {
    const rows = await entriesInto([stage], lookFrom);
    const last = new Map(), recent = new Set();
    rows.forEach(row => {
      const id = String(row.OWNER_ID), day = etDay(row.CREATED_TIME);
      if (!last.has(id) || day > last.get(id)) last.set(id, day);
      if (day >= windowFrom && day <= windowTo) recent.add(id);
    });
    lastEntry.set(stage, last);
    inWindow.set(stage, recent);
  }));

  const currentIn = stage => allDeals.filter(deal => deal.STAGE_ID === stage);
  const sourced = new Set(allDeals.filter(deal => { const day = etDay(deal.DATE_CREATE); return day >= windowFrom && day <= windowTo; }).map(deal => String(deal.ID)));

  const steps = MAIN_LINE.map(step => {
    const entered = step.key === 'sourced' ? sourced : new Set(step.ids.flatMap(id => [...inWindow.get(id)]));
    const waiting = step.ids.flatMap(id => currentIn(id).map(deal => ({ id: String(deal.ID), stage: id })));
    const ages = waiting.map(item => { const day = lastEntry.get(item.stage).get(item.id); return day ? (toUtc(today) - toUtc(day)) / DAY : null; });
    const known = ages.filter(age => age != null);
    const reach = Math.max(...step.ids.map(id => sortOf.get(id) || 0));
    /* left the step = passed through it (it has an entry into the step) and then entered a later stage, or was Axed, in the window */
    const left = new Set();
    if (step.ids.length) {
      LATER.filter(id => (sortOf.get(id) || 0) > reach || id === 'LOSE').forEach(later => {
        inWindow.get(later).forEach(deal => {
          const laterDay = lastEntry.get(later).get(deal);
          if (step.ids.some(id => { const day = lastEntry.get(id).get(deal); return day && day <= laterDay; })) left.add(deal);
        });
      });
    }
    return {
      left: left.size,
      key: step.key, name: step.name || nameOf.get(step.ids[0]) || step.ids[0], stages: step.ids,
      entered: entered.size, current: step.key === 'sourced' || step.key === 'closed' ? null : waiting.length,
      medianWaitDays: round1(median(known)), oldestWaitDays: known.length ? Math.max(...known) : null,
      oldestUnknown: ages.length - known.length
    };
  });
  steps.forEach((step, i) => { step.gotHerePct = i === 0 || !steps[i - 1].entered ? null : Math.min(100, Math.round(step.entered / steps[i - 1].entered * 100)); });

  /* the step where the queue is long and more deals arrive than leave */
  let bottleneck = null;
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    if (windowTo < today) return;
    if (!next || step.current == null || step.current < MIN_QUEUE) return;
    const inPerDay = step.entered / windowDays, outPerDay = step.left / windowDays;
    if (inPerDay <= outPerDay * 1.2) return;
    const score = step.current / Math.max(outPerDay, 0.1);
    if (!bottleneck || score > bottleneck.score) {
      bottleneck = { score, key: step.key, name: step.name, nextName: next.name, queue: step.current, inPerDay: round1(inPerDay), outPerDay: round1(outPerDay),
        growsPerDay: round1(inPerDay - outPerDay), oldestWaitDays: step.oldestWaitDays, oldestUnknown: step.oldestUnknown };
    }
  });
  if (bottleneck) delete bottleneck.score;

  const other = SIDE.map(id => ({ id, name: nameOf.get(id) || id, current: currentIn(id).length, entered: inWindow.get(id).size }));
  const closed = steps.find(step => step.key === 'closed'), loi = steps.find(step => step.key === 'loi');
  return {
    today, from: windowFrom, to: windowTo, windowDays, bottleneckChecked: windowTo >= today, lookbackDays: LOOKBACK_DAYS, provisional: true,
    totals: { sourced: sourced.size, lois: loi.entered, closed: closed.entered, sourcedToClosedPct: sourced.size ? Math.round(closed.entered / sourced.size * 1000) / 10 : null,
      dealsRead: allDeals.length, dealsInBitrix: deals.data.totalDeals, complete: deals.data.deals.length === deals.data.totalDeals },
    steps, bottleneck, other,
    notes: [
      `"Got here" is the number of deals that entered a step in the chosen dates divided by the number that entered the step above, so a deal that skips a step can push it above the step before. It is capped at 100%.`,
      'Deals Sourced = deals created in the last 30 days. Deals Closed and LOIs = deals that moved into Deal Closed or LOI Stage in the last 30 days. Sourced to closed divides one by the other; they are different groups of deals, so read it as a rough guide.',
      `Waiting time is measured from when a deal last moved into its current stage, looking back ${LOOKBACK_DAYS} days. Deals that arrived earlier than that are counted as "older than ${LOOKBACK_DAYS} days".`,
      'A step is flagged as holding things up when at least 10 deals are waiting and more arrive each day than leave to the next step. A deal has left a step when it enters any later stage or is Axed; a send-back or On Hold does not count as leaving.',
      'Only the Default pipeline is read. Side stages (Action Required, On Hold and so on) are listed separately.'
    ]
  };
}

async function pipelineHealth({ from, to, force }) {
  const today = reportToday();
  const end = to ? validDay(to, 'to') : today;
  const start = from ? validDay(from, 'from') : addDays(end, -(WINDOW_DAYS - 1));
  if (end > today) throw new Error('to must not be after today');
  if (start > end) throw new Error('from must not be after to');
  if ((toUtc(end) - toUtc(start)) / DAY + 1 > MAX_RANGE_DAYS) throw new Error(`Range is limited to ${MAX_RANGE_DAYS} days`);
  const result = await bitrix.loadCached(`kpi:pipeline-health:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { pipelineHealth };
