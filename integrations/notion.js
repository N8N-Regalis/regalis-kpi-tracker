const { loadCached } = require('./bitrix');

const NOTION_VERSION = '2022-06-28';
const RETRY_LIMIT = 4;

/* Databases the dashboard reads. IDs belong to the databases inside the shared pages. */
const DATABASES = {
  auditing: { id: '20ba5e9c-3639-830e-8698-019e8d13e276', label: 'Auditing Reports' },
  processImprovements: { id: '3e4a5e9c-3639-80a8-90dd-ec607ad961e2', label: 'Process Improvements/Initiatives' },
  applicants: { id: '1aea5e9c-3639-80fa-ae98-c051cca08405', label: 'Applicant Status' }
};

function token() {
  const value = process.env.NOTION_TOKEN?.trim();
  if (!value) throw new Error('Notion token not configured');
  return value;
}

async function call(path, body) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    let response;
    try {
      response = await fetch(`https://api.notion.com/v1/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token()}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      if (attempt === RETRY_LIMIT - 1) throw new Error('Unable to reach Notion');
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
      continue;
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRY_LIMIT - 1) throw new Error(data.code || 'Notion request failed');
    const retryAfter = Number(response.headers.get('retry-after')) * 1000;
    await new Promise(resolve => setTimeout(resolve, retryAfter || 500 * (2 ** attempt)));
  }
  throw new Error('Notion request failed after retries');
}

async function queryAll(databaseId) {
  const pages = [];
  let cursor;
  do {
    const data = await call(`databases/${databaseId}/query`, { page_size: 100, start_cursor: cursor });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

const text = parts => (parts || []).map(part => part.plain_text).join('');

function value(property) {
  switch (property?.type) {
    case 'title': return text(property.title);
    case 'rich_text': return text(property.rich_text);
    case 'select': return property.select?.name ?? null;
    case 'status': return property.status?.name ?? null;
    case 'multi_select': return property.multi_select.map(option => option.name);
    case 'date': return property.date ? { start: property.date.start, end: property.date.end } : null;
    case 'people': return property.people.map(person => person.name || person.id);
    case 'email': return property.email;
    case 'files': return property.files.length;
    case 'last_edited_time': return property.last_edited_time;
    default: return null;
  }
}

function normalise(page) {
  const fields = {};
  for (const [name, property] of Object.entries(page.properties)) fields[name] = value(property);
  return { id: page.id, createdTime: page.created_time, lastEditedTime: page.last_edited_time, url: page.url, fields };
}

async function getDatabase(key) {
  const database = DATABASES[key];
  const pages = await queryAll(database.id);
  return { label: database.label, total: pages.length, rows: pages.map(normalise) };
}

async function connectionTest() {
  const me = await call('users/me');
  return { connected: true, integration: me.name || null, workspace: me.bot?.workspace_name || null };
}

module.exports = { DATABASES, connectionTest, getDatabase, loadCached };
