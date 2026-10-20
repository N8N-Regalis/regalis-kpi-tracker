const bitrix = require('./bitrix');
const { isWorkingDay } = require('./holidays');
const config = require('./config');
const { reportToday } = config;

/* Bitrix Tasks KPIs from the Score Card Mapping document:
   - Automation Tasks On Time (KPI 9), Audit Tasks On Time (KPI 12), HR Tasks Turnaround (KPI 16): on-time rate against each task's deadline
   - Days to Deploy an Automation (KPI 10): working days from task created to task completed
   - Daily Tasks Completed (KPI 11): share of tasks completed within 2 business days, carry-overs checked against comments
   Credit goes to the task's responsible person, matched to the role by their Bitrix job title.
   Operations Associates (Daily Tasks Completed) are also credited for tasks where they are a participant (co-executor). */
const TIME_ZONE = 'America/New_York';
const DAY = 86_400_000;
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 60;
const WINDOW_BUSINESS_DAYS = 2;

const DEFS = [
  { id: 'automation_tasks', name: 'Automation Tasks On Time', role: 'Assistant Operations Manager (Automations)', title: /^assistant operations manager \(automations\)$/i, group: 5, kind: 'onTime' },
  { id: 'deploy_time', name: 'Days to Deploy an Automation', role: 'Automations Engineer', title: /^automations engineer$/i, group: 5, kind: 'deploy' },
  { id: 'daily_tasks', name: 'Daily Tasks Completed', role: 'Operations Associate (Automations)', title: /^operations associate$/i, group: 5, kind: 'daily', participants: true },
  { id: 'audit_tasks', name: 'Audit Tasks On Time', role: 'Assistant Operations Manager (Auditing)', title: /^assistant operations manager \(auditing\)$/i, group: 19, kind: 'onTime' },
  { id: 'hr_turnaround', name: 'HR Tasks Turnaround', role: 'Talent Assistant', title: /^talent assistant$/i, group: 9, kind: 'onTime' }
];

const etDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const toUtc = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);
const mondayOf = day => { const ms = toUtc(day); return fromUtc(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY); };
const addDays = (day, n) => fromUtc(toUtc(day) + n * DAY);

function validDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) || fromUtc(toUtc(value)) !== value) throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}

/* Mon-Fri days elapsed after `from` up to and including `to` (same day = 0). US holidays are skipped. */
function businessDays(from, to) {
  if (to <= from) return 0;
  let n = 0;
  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {
    if (isWorkingDay(day)) n++;
  }
  return n;
}

async function listAll(method, params, key) {
  const rows = [];
  for (let start = 0; ;) {
    const data = await bitrix.call(method, { ...params, start });
    const page = key ? data.result?.[key] : data.result;
    rows.push(...(Array.isArray(page) ? page : []));
    if (data.next == null) break;
    start = Number(data.next);
  }
  return rows;
}

async function getUsers() {
  const users = await listAll('user.get', { FILTER: { ACTIVE: true }, ORDER: { ID: 'ASC' } });
  return users.map(user => ({ id: String(user.ID), name: [user.NAME, user.SECOND_NAME && user.SECOND_NAME !== user.NAME ? user.SECOND_NAME : '', user.LAST_NAME].filter(Boolean).join(' ').trim(), title: user.WORK_POSITION || '' }));
}

async function fetchTasks(def, ids, fromDay) {
  const field = def.kind === 'onTime' ? 'DEADLINE' : def.kind === 'deploy' ? 'CLOSED_DATE' : 'CREATED_DATE';
  const ask = role => listAll('tasks.task.list', {
    filter: { GROUP_ID: def.group, [role]: ids, [`>=${field}`]: addDays(fromDay, -1) },
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'ACCOMPLICES', 'STATUS', 'DEADLINE', 'CREATED_DATE', 'CLOSED_DATE', 'COMMENTS_COUNT'],
    order: { ID: 'ASC' }
  }, 'tasks');
  const tasks = await ask('RESPONSIBLE_ID');
  if (!def.participants) return tasks;
  const seen = new Set(tasks.map(task => String(task.id)));
  (await ask('ACCOMPLICE')).forEach(task => { if (!seen.has(String(task.id))) tasks.push(task); });
  return tasks;
}

const median = list => { const s = [...list].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

function summarise(kind, bucket) {
  if (kind === 'onTime') {
    const done = bucket.onTime + bucket.late;
    return { ...bucket, rate: bucket.due ? Math.round(bucket.onTime / bucket.due * 1000) / 10 : null,
      avgAheadHours: bucket.aheadN ? Math.round(bucket.aheadHoursSum / bucket.aheadN * 10) / 10 : null, completed: done };
  }
  if (kind === 'daily') {
    const judged = bucket.within + bucket.carried;
    return { ...bucket, rate: judged ? Math.round(bucket.within / judged * 1000) / 10 : null };
  }
  return { closed: bucket.days.length, avgDays: bucket.days.length ? Math.round(bucket.days.reduce((a, b) => a + b, 0) / bucket.days.length * 10) / 10 : null, medianDays: median(bucket.days), slowest: bucket.days.length ? Math.max(...bucket.days) : null };
}

const emptyBucket = kind => kind === 'onTime' ? { due: 0, onTime: 0, ahead: 0, late: 0, openOverdue: 0, aheadHoursSum: 0, aheadN: 0 }
  : kind === 'daily' ? { assigned: 0, within: 0, sameDay: 0, carried: 0, carriedWithComments: 0, open: 0, openToday: 0 } : { days: [] };

const bump = (buckets, field, n = 1) => buckets.forEach(bucket => { bucket[field] += n; });

/* `bucketsFor(day)` returns the [day, week, month, overall] buckets a result on that day belongs to. */
function addTask(kind, task, bucketsFor, range, today, now, flag) {
  const closed = task.closedDate && Number(task.status) === 5 ? task.closedDate : null;
  if (kind === 'onTime') {
    if (!task.deadline || [6, 7].includes(Number(task.status))) return;
    const due = etDay(task.deadline);
    if (due < range.from || due > range.to || due > today) return;
    const buckets = bucketsFor(due);
    if (closed) {
      bump(buckets, 'due');
      if (new Date(closed) <= new Date(task.deadline)) {
        bump(buckets, 'onTime');
        if (new Date(closed) < new Date(task.deadline)) bump(buckets, 'ahead');
        bump(buckets, 'aheadHoursSum', (new Date(task.deadline) - new Date(closed)) / 3_600_000);
        bump(buckets, 'aheadN');
      } else {
        bump(buckets, 'late');
        flag(task, 'Late', (new Date(closed) - new Date(task.deadline)) / 3_600_000);
      }
    } else if (new Date(task.deadline) < now) {
      bump(buckets, 'due');
      bump(buckets, 'openOverdue');
      flag(task, 'Still open', (now - new Date(task.deadline)) / 3_600_000);
    }
  } else if (kind === 'daily') {
    if ([6, 7].includes(Number(task.status))) return;
    const created = etDay(task.createdDate);
    if (created < range.from || created > range.to) return;
    const buckets = bucketsFor(created);
    const elapsed = businessDays(created, closed ? etDay(closed) : today);
    bump(buckets, 'assigned');
    if (closed && elapsed <= WINDOW_BUSINESS_DAYS) {
      bump(buckets, 'within');
      if (elapsed === 0) bump(buckets, 'sameDay');
    } else if (elapsed > WINDOW_BUSINESS_DAYS) {
      bump(buckets, 'carried');
      if (Number(task.commentsCount) > 0) bump(buckets, 'carriedWithComments');
      flag(task, 'Carried over', null);
    } else {
      bump(buckets, 'open');
      if (elapsed === 0) bump(buckets, 'openToday');
    }
  } else if (closed) {
    const day = etDay(closed);
    if (day < range.from || day > range.to) return;
    const days = businessDays(etDay(task.createdDate), day);
    bucketsFor(day).forEach(bucket => bucket.days.push(days));
  }
}

async function calculate({ from, to }) {
  const users = await getUsers();
  const now = new Date();
  const today = etDay(now);
  const portal = bitrix.portal();
  const weeks = [];
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) weeks.push({ start: monday, end: addDays(monday, 6), inProgress: addDays(monday, 6) >= today });
  const range = { from, to };
  const months = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); ) {
    const [y, m] = month.split('-').map(Number);
    months.push({ month, inProgress: fromUtc(Date.UTC(y, m, 0)) >= today });
    month = fromUtc(Date.UTC(y, m, 1)).slice(0, 7);
  }

  const kpis = [];
  for (const def of DEFS) {
    const people = users.filter(user => def.title.test(user.title));
    const tasks = people.length ? await fetchTasks(def, people.map(person => Number(person.id)), from) : [];
    const results = people.map(person => {
      const weekly = new Map(weeks.map(week => [week.start, emptyBucket(def.kind)]));
      const monthly = new Map(months.map(month => [month.month, emptyBucket(def.kind)]));
      const days = new Map();
      const total = emptyBucket(def.kind);
      const bucketsFor = day => {
        if (!days.has(day)) days.set(day, emptyBucket(def.kind));
        return [days.get(day), weekly.get(mondayOf(day)), monthly.get(day.slice(0, 7)), total];
      };
      const flagged = [];
      const flag = (task, reason, hours) => flagged.push({
        id: String(task.id), title: String(task.title || '').slice(0, 140), reason,
        deadline: task.deadline || null, closed: task.closedDate || null,
        hours: hours == null ? null : Math.round(hours * 10) / 10, comments: Number(task.commentsCount) || 0,
        url: `${portal}/workgroups/group/${def.group}/tasks/task/view/${task.id}/`
      });
      tasks.filter(task => String(task.responsibleId) === person.id || (def.participants && (task.accomplices || []).map(String).includes(person.id)))
        .forEach(task => addTask(def.kind, task, bucketsFor, range, today, now, flag));
      return {
        bitrixId: person.id,
        name: person.name,
        total: summarise(def.kind, total),
        weekly: weeks.map(week => ({ start: week.start, ...summarise(def.kind, weekly.get(week.start)) })),
        monthly: months.map(month => ({ month: month.month, ...summarise(def.kind, monthly.get(month.month)) })),
        days: [...days.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([day, bucket]) => ({ day, ...summarise(def.kind, bucket) })),
        flagged: flagged.sort((x, y) => (x.deadline || x.closed || '') < (y.deadline || y.closed || '') ? -1 : 1).slice(-200)
      };
    });
    kpis.push({ id: def.id, name: def.name, role: def.role, kind: def.kind, group: def.group, people: results });
  }

  return {
    range, timezone: TIME_ZONE, weeks, months, kpis, provisional: true,
    notes: [
      'Credit goes to the responsible person on each Bitrix task. Roles are matched by Bitrix job title. Operations Associates are also credited for tasks where they are a participant.',
      'Working days count Monday to Friday in ET, skipping US holidays.',
      'Not automated: whether work was accurate, "ahead of deadline" consistency, approved carry-over reasons beyond the comment count, and deadline adjustments made for the stage or team a task is waiting on.'
    ]
  };
}

async function taskKpis({ from, to, force }) {
  const today = reportToday();
  const end = to ? validDay(to, 'to') : today;
  const requested = from ? validDay(from, 'from') : config.COUNT_FROM;
  const floor = addDays(mondayOf(end), -(MAX_WEEKS - 1) * 7);
  const start = requested < config.COUNT_FROM ? config.COUNT_FROM : !from && requested < floor ? floor : requested;
  if (start > end) throw new Error('from must not be after to');
  if ((toUtc(end) - toUtc(mondayOf(start))) / DAY / 7 > MAX_WEEKS) throw new Error(`Range is limited to ${MAX_WEEKS} weeks`);
  const result = await bitrix.loadCached(`kpi:task-kpis:${start}:${end}`, () => calculate({ from: start, to: end }), force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { taskKpis };
