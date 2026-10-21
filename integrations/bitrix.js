const config = require('./config');
const CACHE_TTL_MS = 60_000;
const STALE_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 50;
const BATCH_SIZE = 20;
const RETRY_LIMIT = 5;
/* many KPI calculations run together; only this many Bitrix requests are in flight at once, the rest wait their turn */
const MAX_CONCURRENT = Number(process.env.BITRIX_MAX_CONCURRENT) || 6;
let active = 0;
const waiting = [];
async function acquire() {
  while (active >= MAX_CONCURRENT) await new Promise(resolve => waiting.push(resolve));
  active++;
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

const cache = new Map();
const pending = new Map();

function webhookBase() {
  const webhook = process.env.BITRIX_WEBHOOK_URL?.trim();
  if (!webhook) throw new Error('Bitrix webhook not configured');
  const parsed = new URL(webhook);
  if (parsed.protocol !== 'https:') throw new Error('Bitrix webhook must use HTTPS');
  return webhook.endsWith('/') ? webhook : `${webhook}/`;
}

function safeError(data, response) {
  const code = data?.error || data?.error_description;
  const retryable = response.status === 429 || response.status >= 500 ||
    ['QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'TOO_MANY_REQUESTS'].includes(code);
  const error = new Error(code || (retryable ? 'Bitrix is temporarily rate limited or unavailable' : 'Bitrix request failed'));
  error.retryable = retryable;
  return error;
}

async function call(method, params = {}) {
  const url = `${webhookBase()}${method}.json`;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    let response;
    try {
      let data;
      await acquire();
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30_000)
        });
        data = await response.json();
      } finally {
        release();
      }
      if (response.ok && !data.error) return data;

      const error = safeError(data, response);
      if (!error.retryable || attempt === RETRY_LIMIT - 1) throw error;
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      await new Promise(resolve => setTimeout(resolve, retryAfter || 500 * (2 ** attempt)));
    } catch (error) {
      if (error.retryable === false || attempt === RETRY_LIMIT - 1) {
        throw new Error(error.retryable === false ? error.message : 'Unable to reach Bitrix24');
      }
      /* a dropped connection or a timeout also waits before the next try, with a growing pause */
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw new Error('Bitrix request failed after retries');
}

async function listAll(method, params = {}) {
  const rows = [];
  let start = 0;
  let total = null;
  do {
    const data = await call(method, { ...params, start, ...(params.select ? {} : {}) });
    const page = Array.isArray(data.result) ? data.result : [];
    rows.push(...page);
    total = data.total ?? total;
    if (data.next == null || page.length === 0) break;
    start = Number(data.next);
  } while (rows.length < (total ?? Number.MAX_SAFE_INTEGER));

  return { rows, total: total ?? rows.length };
}

async function getDeals() {
  const params = {
    order: { ID: 'DESC' },
    select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY']
  };
  const firstPage = await call('crm.deal.list', { ...params, start: 0 });
  const deals = Array.isArray(firstPage.result) ? [...firstPage.result] : [];
  const totalDeals = Number(firstPage.total) || deals.length;
  const nextStart = Number(firstPage.next ?? PAGE_SIZE);

  for (let start = nextStart; start < totalDeals; start += PAGE_SIZE * BATCH_SIZE) {
    const starts = Array.from({ length: Math.min(BATCH_SIZE, Math.ceil((totalDeals - start) / PAGE_SIZE)) },
      (_, index) => start + index * PAGE_SIZE);
    const cmd = Object.fromEntries(starts.map((pageStart, index) => {
      const query = new URLSearchParams();
      query.set('order[ID]', 'DESC');
      params.select.forEach(field => query.append('select[]', field));
      query.set('start', String(pageStart));
      return [`page${index}`, `crm.deal.list?${query.toString()}`];
    }));
    const batch = await call('batch', { halt: 0, cmd });
    const pages = batch.result?.result || {};

    for (let index = 0; index < starts.length; index++) {
      const page = pages[`page${index}`];
      if (Array.isArray(page)) {
        deals.push(...page);
        continue;
      }
      const fallback = await call('crm.deal.list', { ...params, start: starts[index] });
      if (Array.isArray(fallback.result)) deals.push(...fallback.result);
    }
  }

  const uniqueDeals = [...new Map(deals.map(deal => [String(deal.ID), deal])).values()];
  return { deals: uniqueDeals, totalDeals };
}

async function getUsers() {
  const { rows } = await listAll('user.get', {
    filter: { ACTIVE: 'Y' },
    order: { ID: 'ASC' },
    select: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'WORK_POSITION', 'UF_DEPARTMENT', 'ACTIVE']
  });
  return rows.map(user => ({
    id: String(user.ID),
    name: [user.NAME, user.SECOND_NAME && !String(user.NAME || '').toLowerCase().split(/\s+/).includes(String(user.SECOND_NAME).trim().toLowerCase()) ? user.SECOND_NAME : '', user.LAST_NAME].filter(Boolean).join(' ').trim(), /* a middle name already in the first-name field is not repeated */
    title: user.WORK_POSITION || '',
    departmentIds: Array.isArray(user.UF_DEPARTMENT) ? user.UF_DEPARTMENT.map(String) : [],
    active: user.ACTIVE === true || user.ACTIVE === 'true' || user.ACTIVE === 'Y'
  }));
}

async function getDepartments() {
  const { rows } = await listAll('department.get', {
    sort: { SORT: 'ASC' },
    order: { NAME: 'ASC' }
  });
  return rows.map(department => ({
    id: String(department.ID),
    name: department.NAME || ''
  }));
}

async function getStages() {
  const categories = await listAll('crm.dealcategory.list', {
    order: { SORT: 'ASC' },
    select: ['ID', 'NAME', 'SORT']
  });
  const pipelineCategories = [{ id: '0', name: 'Default pipeline', sort: 0 }, ...categories.rows.map(category => ({
    id: String(category.ID),
    name: category.NAME,
    sort: Number(category.SORT) || 0
  }))];

  const stages = await Promise.all(pipelineCategories.map(async category => {
    const entityId = category.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${category.id}`;
    const result = await listAll('crm.status.list', {
      order: { SORT: 'ASC' },
      filter: { ENTITY_ID: entityId },
      select: ['STATUS_ID', 'NAME', 'SORT', 'EXTRA']
    });
    return result.rows.map(stage => ({
      id: stage.STATUS_ID,
      name: stage.NAME,
      sort: Number(stage.SORT) || 0,
      categoryId: category.id,
      categoryName: category.name,
      type: stage.EXTRA?.SEMANTICS || stage.SEMANTICS || 'process'
    }));
  }));

  return stages.flat();
}

/* Reading every deal takes 40+ seconds, longer than a hosted proxy waits for an answer, so the deals list is kept
   fresh for 5 minutes and an older copy (up to 30 minutes) is sent straight away while a new one loads in the background. */
async function loadCached(rawKey, loader, force = false) {
  const key = rawKey.startsWith('kpi:') ? `${rawKey}|${config.windowKey()}` : rawKey;
  const current = cache.get(key);
  const slow = rawKey === 'deals';
  const freshMs = slow ? 5 * 60_000 : CACHE_TTL_MS;
  const keepMs = slow ? 30 * 60_000 : STALE_TTL_MS;
  const age = current ? Date.now() - current.time : Infinity;
  if (!force && current && age < freshMs) {
    return { data: current.data, cached: true, stale: false };
  }

  const refresh = () => {
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      try {
        const data = await loader();
        cache.set(key, { data, time: Date.now() });
        return { data, cached: false, stale: false };
      } catch (error) {
        if (current && Date.now() - current.time < keepMs) {
          return { data: current.data, cached: true, stale: true, error: error.message };
        }
        throw error;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, request);
    return request;
  };

  if (!force && current && age < keepMs) {
    refresh().catch(() => {});
    return { data: current.data, cached: true, stale: false, refreshing: true };
  }
  return refresh();
}

async function connectionTest() {
  await call('crm.settings.mode.get');
  return { connected: true };
}

function portal() {
  try {
    return new URL(webhookBase()).origin;
  } catch {
    return null;
  }
}

module.exports = { call, connectionTest, getDeals, getDepartments, getStages, getUsers, loadCached, portal };