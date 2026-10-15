const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const notion = require('./notion');
const { etDay, fromUtc, toUtc, DAY, listPaged, listItems, fullName } = require('./crmHistory');

/* Notion KPIs: Time to Fill a Position (Talent Administrator) and Audits Completed (Auditing Specialist). */
const MONTHS_BACK = 5;
const monthStart = (day, back) => { const [y, m] = day.split('-').map(Number); return fromUtc(Date.UTC(y, m - 1 - back, 1)); };
const monthsFrom = (first, last) => { const out = []; for (let m = first; m <= last; m = monthStart(`${m}-01`, -1).slice(0, 7)) out.push(m); return out; };
const dayOf = value => (value && value.start ? String(value.start).slice(0, 10) : null);
const round1 = n => Math.round(n * 10) / 10;

/* ---------- Time to Fill a Position ---------- */
const MANAGER_ROLE = /\b(manager|team lead|lead|director|head)\b/i;
const roleType = positions => ((positions || []).some(position => MANAGER_ROLE.test(position)) ? 'Team Lead/Manager' : 'Contractor');
/* A row counts once it has a Filled Date, whatever its status. Rows that were turned down or dropped out never count. */
const DROPPED = new Set(['Rejected', 'FOR REJECTION EMAIL', 'Withdrew', 'Declined Offer', 'Blacklisted']);
/* Statuses where the person has accepted and the Filled Date is expected to be entered next */
const AWAITING = ['Contract Signing', 'Onboarding', 'Hired'];
const FILL_ZONES = { Contractor: { exceptional: 14, target: 21 }, 'Team Lead/Manager': { exceptional: 30, target: 45 } };
const fillZone = (type, days) => (days <= FILL_ZONES[type].exceptional ? 'Exceptional' : days <= FILL_ZONES[type].target ? 'Target' : 'Below target');

async function timeToFill() {
  const today = reportToday();
  const firstMonth = [monthStart(today, MONTHS_BACK).slice(0, 7), config.COUNT_FROM.slice(0, 7)].sort().pop();
  const months = monthsFrom(firstMonth, today.slice(0, 7));
  const [db, users] = await Promise.all([notion.getDatabase('applicants'), listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems)]);
  const hired = db.rows.filter(row => row.fields.Status === 'Hired');
  const hires = [];
  const awaiting = Object.fromEntries(AWAITING.map(status => [status, 0]));
  let missingFilled = 0, missingOpen = 0, excluded = 0;
  for (const row of db.rows) {
    if (DROPPED.has(row.fields.Status)) continue;
    const open = dayOf(row.fields['Position Open Date']), filled = dayOf(row.fields['Filled Date']);
    if (!filled && !open) continue;
    if (!filled) { if (AWAITING.includes(row.fields.Status)) { awaiting[row.fields.Status]++; missingFilled++; } continue; }
    if (filled < config.COUNT_FROM || filled > today) continue;
    if (!open) { missingOpen++; continue; }
    if (String(row.fields['Time to Fill Exclusion'] || '').trim()) { excluded++; continue; }
    const type = roleType(row.fields.Position);
    const days = Math.round((toUtc(filled) - toUtc(open)) / DAY);
    hires.push({ name: row.fields['Applicant Name'] || '', positions: row.fields.Position || [], type, open, filled, days, zone: fillZone(type, days), url: row.url });
  }
  const byMonth = months.map(month => {
    const row = { month, inProgress: month === today.slice(0, 7) };
    for (const type of Object.keys(FILL_ZONES)) {
      const list = hires.filter(hire => hire.type === type && hire.filled.slice(0, 7) === month);
      const avg = list.length ? round1(list.reduce((sum, hire) => sum + hire.days, 0) / list.length) : null;
      row[type] = { filled: list.length, avgDays: avg, zone: avg == null ? null : fillZone(type, avg) };
    }
    return row;
  });
  return {
    range: { to: today }, zones: FILL_ZONES, months: byMonth, hires: hires.sort((a, b) => (a.filled < b.filled ? 1 : -1)),
    admins: users.filter(user => /^talent administrator$/i.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: fullName(user) })),
    counts: { applicants: db.total, hired: hired.length, hiredWithOpenDate: hired.filter(row => dayOf(row.fields['Position Open Date'])).length, withFilledDate: db.rows.filter(row => dayOf(row.fields['Filled Date'])).length, missingFilled, missingOpen, excluded, awaiting },
    provisional: true,
    notes: [
      'Calendar days from Position Open Date to Filled Date, counted in the month of the Filled Date. A row counts as soon as it has a Filled Date, whatever its status, except Rejected, For Rejection Email, Withdrew, Declined Offer and Blacklisted.',
      'Rows with text in Time to Fill Exclusion are left out.',
      'Counting starts on 1 October 2026: hires with a Filled Date before that day are not counted.',
      'Role type: a position whose name contains Manager, Lead, Director or Head is Team Lead/Manager; every other position is Contractor.',
      'Exceptional: Contractor 14 days or fewer, Team Lead/Manager 30 or fewer · Target: Contractor 15 to 21, Team Lead/Manager 31 to 45 · Below target: Contractor over 21, Team Lead/Manager over 45.'
    ]
  };
}

/* ---------- Audits Completed ---------- */
/* Deadline is text like "09/25/2026; 09:12 AM", read as Eastern Time. */
function easternMs(day, hour, minute) {
  const utc = Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  for (const offset of [4, 5]) {
    const candidate = utc + offset * 3_600_000;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(candidate));
    const get = type => parts.find(part => part.type === type).value;
    if (`${get('year')}-${get('month')}-${get('day')}` === day && Number(get('hour')) === hour && Number(get('minute')) === minute) return candidate;
  }
  return utc + 5 * 3_600_000;
}

function parseDeadline(text) {
  const match = String(text || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4});?\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === 'PM') hour += 12;
  return easternMs(`${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`, hour, Number(match[5]));
}

async function audits() {
  const [db, users] = await Promise.all([notion.getDatabase('auditing'), listPaged('user.get', { FILTER: { ACTIVE: true } }, listItems)]);
  const startMs = Date.parse(`${config.COUNT_FROM}T00:00:00-04:00`);
  const endMs = config.COUNT_TO ? Date.parse(`${config.COUNT_TO}T23:59:59-04:00`) : Infinity;
  const items = db.rows.filter(row => row.fields['Person Audited']).map(row => {
    const submitted = row.fields['Date Submitted']?.start || null;
    const deadlineText = row.fields.Deadline || '';
    const deadline = parseDeadline(deadlineText);
    const submittedMs = submitted ? Date.parse(/T/.test(submitted) ? submitted : `${submitted}T23:59:59-04:00`) : null;
    let result = 'No deadline';
    if (deadline != null) result = submittedMs == null ? (deadline < Date.now() ? 'Overdue' : 'Open') : submittedMs <= deadline ? 'On time' : 'Late';
    const refMs = deadline != null ? deadline : submittedMs;
    return { refMs, audited: row.fields['Person Audited'], team: (row.fields.Team || []).join(', '), status: row.fields.Status || '', deadline: deadlineText, submitted, result, url: row.url };
  }).filter(item => item.refMs != null && item.refMs >= startMs && item.refMs <= endMs);
  const judged = items.filter(item => ['On time', 'Late', 'Overdue'].includes(item.result));
  const onTime = judged.filter(item => item.result === 'On time').length;
  return {
    specialists: users.filter(user => /^auditing specialist$/i.test(user.WORK_POSITION || '')).map(user => ({ bitrixId: String(user.ID), name: fullName(user) })),
    total: items.length, submitted: items.filter(item => item.submitted).length,
    judged: judged.length, onTime, late: judged.length - onTime, rate: judged.length ? round1(onTime / judged.length * 100) : null,
    items: items.filter(item => item.result !== 'No deadline'), noDeadline: items.filter(item => item.result === 'No deadline').length,
    provisional: true,
    notes: [
      'Counting starts on 1 October 2026: an audit counts when its Deadline (or, with no Deadline, its Date Submitted) is on or after that day.',
      'Both Auditing Specialists share one result: the table has no owner column, so every audit is credited to both.',
      'An audit counts as completed in its cycle when Date Submitted is on or before the Deadline (Eastern Time). A date with no time is read as the end of that day.',
      'Only audits that have a Deadline can be judged. Audits with no Deadline are counted but not scored.',
      'The table has no priority-audit marker, so "priority audits ahead of schedule" is not scored.',
      'Exceptional: 100% in the cycle with no overdue audits · Target: 90 to 99% · Below target: under 90%.'
    ]
  };
}

const cached = (key, loader) => async ({ force }) => {
  const result = await bitrix.loadCached(key, loader, force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
};

module.exports = { timeToFill: cached('kpi:time-to-fill', timeToFill), audits: cached('kpi:audits', audits) };
