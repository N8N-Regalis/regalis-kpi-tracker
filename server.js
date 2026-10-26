
require('dotenv').config();

const express = require('express');
const path = require('path');
const bitrix = require('./integrations/bitrix');
const config = require('./integrations/config');
const auth = require('./integrations/auth');
const notion = require('./integrations/notion');
const sheets = require('./integrations/sheets');
const { signedLois } = require('./integrations/signedLois');
const { taskKpis } = require('./integrations/taskKpis');
const { dealsPresented } = require('./integrations/dealsPresented');
const { dealQuality } = require('./integrations/dealQuality');
const { valuationOutput } = require('./integrations/valuationOutput');
const { holidayList } = require('./integrations/holidays');
const { teamHealth } = require('./integrations/teamHealth');
const { kpiCheck } = require('./integrations/kpiCheck');
const { pipelineHealth } = require('./integrations/pipelineHealth');
const { closingAgreements } = require('./integrations/closingAgreements');
const { conversion } = require('./integrations/conversion');
const { teamLoiClosing } = require('./integrations/teamLoiClosing');
const { onboarding } = require('./integrations/onboarding');
const { timeToFill, audits } = require('./integrations/notionKpis');
const { calculateKpiTest } = require('./integrations/kpiTest');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_DIR = path.join(__dirname, 'app');

/* Local default: bound to this PC only. When hosted, set HOST=0.0.0.0, ALLOWED_HOSTS (this server's
   hostname) and ALLOWED_ORIGINS (the Netlify site, e.g. https://regalis-kpi-tracker-v1.netlify.app). */
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const list = value => (value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', ...list(process.env.ALLOWED_HOSTS)];
const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS);
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

/* a request is accepted when it comes from this server's own page or from a listed origin */
function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.get('host') || ALLOWED_ORIGINS.includes(url.origin.toLowerCase());
  } catch {
    return false;
  }
}

app.use('/api', (req, res, next) => {
  if (!ALLOWED_HOSTS.includes(req.hostname.toLowerCase())) return res.sendStatus(403);
  if (!originAllowed(req)) return res.sendStatus(403);
  res.set('Cache-Control', 'no-store');
  next();
});

/* ---- login: one password for contractors (viewer), one for the admin ---- */
app.get('/login', (req, res) => {
  if (auth.sessionRole(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  if (!auth.configured()) return res.redirect('/login?error=setup');
  if (!originAllowed(req)) return res.sendStatus(403);
  if (auth.lockedOut(req.ip)) return res.redirect('/login?error=locked');
  const role = auth.roleFor(String(req.body.password || ''));
  if (!role) {
    auth.recordFail(req.ip);
    return res.redirect('/login?error=bad');
  }
  auth.clearFails(req.ip);
  auth.startSession(req, res, role);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  auth.endSession(res);
  res.redirect('/login');
});

/* everything below needs a session */
app.use((req, res, next) => {
  const role = auth.sessionRole(req);
  if (role) {
    req.role = role;
    return next();
  }
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login');
});

app.get('/api/session', (req, res) => res.json({ role: req.role }));

/* a KPI request can ask for another counting window, for example one quarter: ?qfrom=2026-10-01&qto=2026-12-31 */
app.use('/api/kpi', (req, res, next) => {
  const { qfrom, qto } = req.query;
  if (qfrom === undefined && qto === undefined) return next();
  const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!isDay(qfrom) || (qto !== undefined && qto !== '' && !isDay(qto))) return res.status(400).json({ error: 'qfrom and qto must be valid YYYY-MM-DD dates' });
  const from = qfrom < config.DEFAULT_FROM ? config.DEFAULT_FROM : qfrom;
  const to = qto ? qto : null;
  if (to && to < from) return res.status(400).json({ error: 'qto must not be before qfrom' });
  config.withWindow({ from, to }, next);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    bitrixConfigured: Boolean(process.env.BITRIX_WEBHOOK_URL?.trim()),
    bitrixPortal: bitrix.portal(),
    countFrom: config.DEFAULT_FROM,
    countTo: config.DEFAULT_TO,
    windowQuery: true,
    holidays: holidayList().map(item => item.day)
  });
});

app.get('/api/bitrix/test', async (req, res) => {
  try {
    res.json(await bitrix.connectionTest());
  } catch (error) {
    res.status(502).json({
      connected: false,
      error: error.message
    });
  }
});

app.get('/api/bitrix/deals', async (req, res) => {
  try {
    const result = await bitrix.loadCached('deals', bitrix.getDeals, req.query.refresh === '1');
    res.json({
      connected: true,
      fetchedDeals: result.data.deals.length,
      totalDeals: result.data.totalDeals,
      deals: result.data.deals,
      cached: result.cached,
      stale: result.stale,
      error: result.error || null
    });
  } catch (error) {
    res.status(502).json({ connected: false,
      error: error.message
    });
  }
});

app.get('/api/bitrix/pipeline', async (req, res) => {
  try {
    const [deals, stages] = await Promise.all([
      bitrix.loadCached('deals', bitrix.getDeals, req.query.refresh === '1'),
      bitrix.loadCached('stages', bitrix.getStages, req.query.refresh === '1')
    ]);
    const counts = new Map();
    deals.data.deals.forEach(deal => {
      const key = `${String(deal.CATEGORY_ID || '0')}|${deal.STAGE_ID}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const pipelineStages = stages.data.map(stage => ({
      ...stage,
      count: counts.get(`${stage.categoryId}|${stage.id}`) || 0
    }));
    res.json({
      connected: true,
      fetchedDeals: deals.data.deals.length,
      totalDeals: deals.data.totalDeals,
      complete: deals.data.deals.length === deals.data.totalDeals,
      stages: pipelineStages,
      cached: deals.cached || stages.cached,
      stale: deals.stale || stages.stale,
      error: deals.error || stages.error || null
    });
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/bitrix/stages', async (req, res) => {
  try {
    const result = await bitrix.loadCached('stages', bitrix.getStages, req.query.refresh === '1');
    res.json({ connected: true, stages: result.data, cached: result.cached, stale: result.stale, error: result.error || null });
  } catch (error) {
    res.status(502).json({
      connected: false,
      error: error.message
    });
  }
});

app.get('/api/bitrix/users', async (req, res) => {
  try {
    const [usersResult, departmentsResult] = await Promise.allSettled([
      bitrix.loadCached('users', bitrix.getUsers, req.query.refresh === '1'),
      bitrix.loadCached('departments', bitrix.getDepartments, req.query.refresh === '1')
    ]);
    if (usersResult.status === 'rejected') throw usersResult.reason;
    const users = usersResult.value;
    const departments = departmentsResult.status === 'fulfilled' ? departmentsResult.value : { data: [], cached: false, stale: false };
    const departmentNames = new Map(departments.data.map(department => [department.id, department.name]));
    const result = { ...users, data: users.data.map(user => ({
      ...user,
      departments: user.departmentIds.map(id => departmentNames.get(id)).filter(Boolean)
    })) };
    res.json({ connected: true, users: result.data, cached: result.cached || departments.cached, stale: result.stale || departments.stale,
      error: result.error || null, departmentError: departmentsResult.status === 'rejected' ? departmentsResult.reason.message : departments.error || null });
  } catch (error) {
    res.status(502).json({
      connected: false,
      error: error.message
    });
  }
});

app.get('/api/notion/test', async (req, res) => {
  try {
    res.json(await notion.connectionTest());
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/notion/:database', async (req, res) => {
  const key = req.params.database;
  if (!Object.hasOwn(notion.DATABASES, key)) return res.status(404).json({ connected: false, error: 'Unknown Notion database' });
  try {
    const result = await notion.loadCached(`notion:${key}`, () => notion.getDatabase(key), req.query.refresh === '1');
    res.json({ connected: true, ...result.data, cached: result.cached, stale: result.stale, error: result.error || null });
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/sheets/test', async (req, res) => {
  try {
    res.json(await sheets.connectionTest());
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/sheets', async (req, res) => {
  try {
    const result = await sheets.loadCached('sheets:workbook', sheets.getWorkbook, req.query.refresh === '1');
    const { name, modifiedTime, tabs } = result.data;
    res.json({ connected: true, file: name, modifiedTime,
      tabs: Object.entries(tabs).map(([tab, rows]) => ({ tab, rows: rows.length })),
      cached: result.cached, stale: result.stale, error: result.error || null });
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/sheets/:tab', async (req, res) => {
  try {
    const result = await sheets.loadCached('sheets:workbook', sheets.getWorkbook, req.query.refresh === '1');
    const tab = Object.hasOwn(result.data.tabs, req.params.tab) ? req.params.tab : null;
    if (!tab) return res.status(404).json({ connected: true, error: 'Unknown tab' });
    res.json({ connected: true, file: result.data.name, modifiedTime: result.data.modifiedTime, tab,
      rows: result.data.tabs[tab], cached: result.cached, stale: result.stale, error: result.error || null });
  } catch (error) {
    res.status(502).json({ connected: false, error: error.message });
  }
});

app.get('/api/kpi/signed-lois', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await signedLois({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/tasks', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await taskKpis({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/deals-presented', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await dealsPresented({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/deal-quality', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await dealQuality({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/valuation-output', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await valuationOutput({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/pipeline-health', async (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(await pipelineHealth({
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      force: req.query.refresh === '1'
    }));
  } catch (error) {
    res.status(error.message.includes('must') || error.message.includes('limited') ? 400 : 502).json({ error: error.message });
  }
});

app.get('/api/kpi/kpi-check', async (req, res) => {
  try {
    res.json(await kpiCheck({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/team-sourcing-health', async (req, res) => {
  try {
    res.json(await teamHealth({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/closing-agreements', async (req, res) => {
  try {
    res.json(await closingAgreements({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/conversion', async (req, res) => {
  try {
    res.json(await conversion({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/team-loi-closing', async (req, res) => {
  try {
    res.json(await teamLoiClosing({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/onboarding', async (req, res) => {
  try {
    res.json(await onboarding({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/time-to-fill', async (req, res) => {
  try {
    res.json(await timeToFill({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi/audits', async (req, res) => {
  try {
    res.json(await audits({ force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/kpi-test/mna-associate', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: 'from and to date parameters are required (YYYY-MM-DD)' });
    }
    const result = await bitrix.loadCached(
      `kpi-test:mna-associate:${from}:${to}`,
      () => calculateKpiTest({ from, to, force: req.query.refresh === '1' }),
      req.query.refresh === '1'
    );
    res.json({ ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

/* the dashboard page lives in app/ and is only sent after login; nothing else in the folder is served */
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(APP_DIR, 'index.html')));

/* keep the shared Bitrix lists loaded so the first visit after a restart does not have to wait for them */
const warmBitrix = () => Promise.allSettled([
  bitrix.loadCached('deals', bitrix.getDeals),
  bitrix.loadCached('stages', bitrix.getStages),
  bitrix.loadCached('users', bitrix.getUsers),
  bitrix.loadCached('departments', bitrix.getDepartments)
]);

app.listen(PORT, HOST, () => {
  console.log(`KPI Dashboard: http://localhost:${PORT}`);
  warmBitrix();
  setInterval(warmBitrix, 2 * 60_000);
});
