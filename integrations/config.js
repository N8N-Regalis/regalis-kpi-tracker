/* Counting window for every KPI. Counting starts in Q4 2026: nothing dated before the start is counted.
   The default window is DEFAULT_FROM to today. A request can ask for another window (a quarter or a year) with ?qfrom=&qto=,
   and the whole calculation for that request then uses it. DEFAULT_FROM is also the earliest day a request may ask for.
   For a test run, set KPI_COUNT_FROM and KPI_COUNT_TO (YYYY-MM-DD) in the environment; KPI_COUNT_TO becomes "today" for every KPI. */
const { AsyncLocalStorage } = require('node:async_hooks');

const dayRe = /^\d{4}-\d{2}-\d{2}$/;
const fromEnv = process.env.KPI_COUNT_FROM;
const toEnv = process.env.KPI_COUNT_TO;
const DEFAULT_FROM = dayRe.test(fromEnv || '') ? fromEnv : '2026-10-01';
const DEFAULT_TO = dayRe.test(toEnv || '') ? toEnv : null;

const store = new AsyncLocalStorage();
const current = () => store.getStore() || { from: DEFAULT_FROM, to: DEFAULT_TO };

const realToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/* the day every KPI treats as "today": the real day, or the end of the window when that is earlier */
const reportToday = () => { const { to } = current(); const today = realToday(); return to && to < today ? to : today; };

module.exports = {
  get COUNT_FROM() { return current().from; },
  get COUNT_TO() { return current().to; },
  DEFAULT_FROM, DEFAULT_TO, reportToday,
  withWindow: (window, fn) => store.run(window, fn),
  windowKey: () => `${current().from}_${current().to || 'open'}`
};
