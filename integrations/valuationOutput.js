const bitrix = require('./bitrix');
const { isWorkingDay } = require('./holidays');
const { TIME_ZONE, etDay, addDays, toUtc, listPaged, listItems, chunk, fullName, historyFor, entriesInto, resolveRange } = require('./crmHistory');

/* Valuation and proposal output per working day (Score Card Mapping KPIs 3, 4 and 7):
   - Valuation Reviews per Day (Valuation Team Lead): deals moved out of Valuation Model For Review to Video Presentation or Axed
   - Valuation Models Built per Day (Financial Analyst): deals moved out of Valuation Modeling to Valuation Model For Review or Axed,
     credited to the person the "Valuation Modeling" activity was assigned to
   - Proposal Videos per Day (Proposal Specialist): "Video Presentation" activities completed, credited to the activity's responsible person
   Cutoff: work that arrives after 4:00 PM ET (or on a weekend or US holiday) is assessed on the next working day.
   A day below the goal is a "KPI gap" when deals arrived before the cutoff (so work was available), as the document says. */
const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 60;
const WARMUP_DAYS = 8; /* covers a long weekend or holiday run, so work that arrived after the previous cutoff is included */
const HISTORY_LOOKBACK_DAYS = 45;
const CUTOFF_MINUTES = 16 * 60;

const STAGE = { MODELING: 'FINANCIAL_MODEL', REVIEW: 'MODEL_REVIEW', PRESENTATION: 'DEAL_PRESENTATION', AXED: 'LOSE' };
const SPECS = {
  reviews: { name: 'Valuation Reviews per Day', title: /^valuation team lead$/i, goal: 60, exceptional: 80, floor: 60 },
  models: { name: 'Valuation Models Built per Day', title: /^financial analyst$/i, goal: 20, exceptional: 30, floor: 20 },
  videos: { name: 'Proposal Videos per Day', title: /^(deal )?proposal specialist$/i, goal: 20, exceptional: 21, floor: 15 }
};

const workingOnOrAfter = day => { while (!isWorkingDay(day)) day = addDays(day, 1); return day; };
const minutesEt = value => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(value));
  return (Number(parts.find(p => p.type === 'hour').value) % 24) * 60 + Number(parts.find(p => p.type === 'minute').value);
};
/* the working day a piece of work arriving at this time is assessed on */
const assessedOn = value => workingOnOrAfter(minutesEt(value) <= CUTOFF_MINUTES ? etDay(value) : addDays(etDay(value), 1));
/* the working day a completion counts on */
const completedOn = value => workingOnOrAfter(etDay(value));

function workingDays(start, end) {
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) if (isWorkingDay(day)) days.push(day);
  return days;
}

async function activities(subject, createdSince) {
  return listPaged('crm.activity.list', {
    filter: { OWNER_TYPE_ID: 2, SUBJECT: subject, '>=CREATED': `${createdSince}T00:00:00-04:00` },
    select: ['ID', 'OWNER_ID', 'RESPONSIBLE_ID', 'COMPLETED', 'CREATED', 'LAST_UPDATED'],
    order: { ID: 'ASC' }
  }, listItems);
}

/* one row per working day: what was done, what arrived for that day's assessment, and the result */
function dailyTable(spec, from, to, warmStart, arrivals, built) {
  return workingDays(from, to).map(day => {
    const arrived = arrivals.get(day) || 0, done = built.get(day) || 0;
    return { day, built: done, arrived, state: done >= spec.goal ? 'met' : arrived > 0 ? 'gap' : 'none' };
  });
}

async function calculate({ from, to }) {
  const warmStart = addDays(from, -WARMUP_DAYS);
  const [users, modelingActs, videoActs, reviewEntries] = await Promise.all([
    listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems),
    activities('Valuation Modeling', warmStart),
    activities('Video Presentation', warmStart),
    entriesInto([STAGE.REVIEW], warmStart)
  ]);
  const people = key => users.filter(user => SPECS[key].title.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: fullName(user) }));
  const roster = { reviews: people('reviews'), models: people('models'), videos: people('videos') };

  const dealIds = new Set([
    ...modelingActs.filter(a => a.COMPLETED === 'Y').map(a => String(a.OWNER_ID)),
    ...videoActs.map(a => String(a.OWNER_ID)),
    ...reviewEntries.map(entry => String(entry.OWNER_ID))
  ]);
  const history = await historyFor(dealIds, addDays(warmStart, -HISTORY_LOOKBACK_DAYS));
  const tally = () => new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  /* models */
  const modelArrivals = new Map(roster.models.map(p => [p.bitrixId, tally()]));
  const modelBuilt = new Map(roster.models.map(p => [p.bitrixId, tally()]));
  const modelExcluded = new Map(roster.models.map(p => [p.bitrixId, 0]));
  for (const act of modelingActs) {
    const person = String(act.RESPONSIBLE_ID);
    if (!modelArrivals.has(person)) continue;
    bump(modelArrivals.get(person), assessedOn(act.CREATED));
    if (act.COMPLETED !== 'Y') continue;
    const rows = history.get(String(act.OWNER_ID)) || [];
    const exit = rows.find(row => new Date(row.CREATED_TIME) >= new Date(act.CREATED) && row.STAGE_ID !== STAGE.MODELING);
    if (!exit) continue;
    const day = completedOn(exit.CREATED_TIME);
    if (day < from || day > to) continue;
    if (exit.STAGE_ID === STAGE.REVIEW || exit.STAGE_ID === STAGE.AXED) bump(modelBuilt.get(person), day);
    else modelExcluded.set(person, modelExcluded.get(person) + 1);
  }

  /* reviews */
  const reviewArrivals = tally(), reviewBuilt = tally();
  for (const rows of history.values()) {
    rows.forEach((row, index) => {
      if (row.STAGE_ID === STAGE.REVIEW) bump(reviewArrivals, assessedOn(row.CREATED_TIME));
      if (index > 0 && rows[index - 1].STAGE_ID === STAGE.REVIEW && (row.STAGE_ID === STAGE.PRESENTATION || row.STAGE_ID === STAGE.AXED)) {
        const day = completedOn(row.CREATED_TIME);
        if (day >= from && day <= to) bump(reviewBuilt, day);
      }
    });
  }

  /* videos */
  const videoArrivals = new Map(roster.videos.map(p => [p.bitrixId, tally()]));
  const videoBuilt = new Map(roster.videos.map(p => [p.bitrixId, tally()]));
  for (const act of videoActs) {
    const person = String(act.RESPONSIBLE_ID);
    if (!videoArrivals.has(person)) continue;
    bump(videoArrivals.get(person), assessedOn(act.CREATED));
    if (act.COMPLETED === 'Y') { const day = completedOn(act.LAST_UPDATED); if (day >= from && day <= to) bump(videoBuilt.get(person), day); }
  }

  const build = (key, arrivalsOf, builtOf, extra = () => ({})) => ({
    ...SPECS[key], title: undefined,
    people: roster[key].map(person => ({ ...person, ...extra(person), daily: dailyTable(SPECS[key], from, to, warmStart, arrivalsOf(person), builtOf(person)) }))
  });
  const portal = bitrix.portal();
  return {
    range: { from, to }, timezone: TIME_ZONE, portal, provisional: true,
    reviews: build('reviews', () => reviewArrivals, () => reviewBuilt),
    models: build('models', p => modelArrivals.get(p.bitrixId), p => modelBuilt.get(p.bitrixId), p => ({ notCounted: modelExcluded.get(p.bitrixId) })),
    videos: build('videos', p => videoArrivals.get(p.bitrixId), p => videoBuilt.get(p.bitrixId)),
    notes: [
      'Work that arrives after 4:00 PM ET, or on a weekend, is assessed on the next working day. Completions on a weekend count on the next working day.',
      'Reviews are credited to the Valuation Team Lead role, because Bitrix does not assign a review to a person. Models and videos are credited to the person the Bitrix activity is assigned to.',
      'A model counts only when the deal moves out of Valuation Modeling to Valuation Model For Review or Axed. Deals sent back to the M&A Associate or to Action Required are not counted.',
      'A day below the goal is a KPI gap when deals arrived before the cutoff, so work was available. Days below the goal with no arrivals show "No work arrived".',
      'Videos are counted when the "Video Presentation" activity is marked done, on the day it was last updated.',
      'US holidays are not working days: no goal is set for them and work arriving then is assessed on the next working day.'
    ]
  };
}

async function valuationOutput({ from, to, force }) {
  const { start, end } = resolveRange({ from, to }, DEFAULT_WEEKS, MAX_WEEKS);
  const result = await bitrix.loadCached(`kpi:valuation-output:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { valuationOutput };
