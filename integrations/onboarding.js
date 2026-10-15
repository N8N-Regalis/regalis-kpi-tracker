const bitrix = require('./bitrix');
const config = require('./config');
const { reportToday } = config;
const { etDay, fromUtc, listPaged, listItems, fullName } = require('./crmHistory');

/* Client Onboarding Calls per Month (Score Card Mapping, Customer Success Manager).
   A client counts in the month of their "Onboarding Call Date" when "Onboarding Completed" is ticked, credited to the
   "Onboarded By" list value. Scored for the Customer Success Managers only (Angela and Milica); Sergio is not mapped in
   Bitrix and is shown as not scored. */
const CALL_DATE = 'UF_CRM_1755183436825';
const COMPLETED = 'UF_CRM_1770669490468';
const ONBOARDED_BY = 'UF_CRM_1791291278493';
const CALL_LINK = 'UF_CRM_1772482914358';
const EXCEPTIONAL = 10;
const TARGET = 7;
const MONTHS_BACK = 5;

const norm = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const monthStart = (day, back) => { const [y, m] = day.split('-').map(Number); return fromUtc(Date.UTC(y, m - 1 - back, 1)); };
const monthsFrom = (first, last) => { const out = []; for (let m = first; m <= last; m = monthStart(`${m}-01`, -1).slice(0, 7)) out.push(m); return out; };
const isTrue = value => value === true || ['Y', '1', 'true'].includes(String(value));

async function calculate() {
  const portal = bitrix.portal();
  const today = reportToday();
  const thisMonth = today.slice(0, 7);
  const from = monthStart(today, MONTHS_BACK) > config.COUNT_FROM ? monthStart(today, MONTHS_BACK) : config.COUNT_FROM;
  const months = monthsFrom(from.slice(0, 7), thisMonth);

  const [fields, users, contacts] = await Promise.all([
    bitrix.call('crm.contact.fields'),
    listPaged('user.get', { FILTER: { ACTIVE: true }, ORDER: { ID: 'ASC' } }, listItems),
    listPaged('crm.contact.list', { filter: { [`>=${CALL_DATE}`]: from }, select: ['ID', 'NAME', 'LAST_NAME', CALL_DATE, COMPLETED, ONBOARDED_BY, CALL_LINK], order: { ID: 'ASC' } }, listItems)
  ]);
  const optionName = new Map((fields.result?.[ONBOARDED_BY]?.items || []).map(item => [String(item.ID), String(item.VALUE).trim()]));
  const managers = users.filter(user => /^customer success manager$/i.test(user.WORK_POSITION || ''))
    .map(user => ({ bitrixId: String(user.ID), name: fullName(user) }));

  const blank = () => Object.fromEntries(months.map(month => [month, 0]));
  const people = new Map(managers.map(manager => [norm(manager.name), { ...manager, monthly: blank(), total: 0, clients: [] }]));
  const notScored = {};
  const unattributed = { total: 0, clients: [] };
  let notCompleted = 0;

  for (const contact of contacts) {
    const day = String(contact[CALL_DATE] || '').slice(0, 10);
    if (!day || day.slice(0, 7) < months[0] || day > today) continue;
    if (!isTrue(contact[COMPLETED])) { notCompleted++; continue; }
    const entry = { id: String(contact.ID), name: [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ').trim() || `Contact #${contact.ID}`, day, url: `${portal}/crm/contact/details/${contact.ID}/` };
    const by = optionName.get(String(contact[ONBOARDED_BY]));
    if (!by) { unattributed.total++; unattributed.clients.push(entry); continue; }
    const person = people.get(norm(by));
    if (!person) { notScored[by] = (notScored[by] || 0) + 1; continue; }
    person.monthly[day.slice(0, 7)]++;
    person.total++;
    person.clients.push(entry);
  }
  const rows = [...people.values()].map(person => ({ ...person, clients: person.clients.sort((a, b) => (a.day < b.day ? 1 : -1)) }));

  return {
    range: { from, to: today }, countFrom: config.COUNT_FROM, months, thisMonth, exceptional: EXCEPTIONAL, target: TARGET, people: rows,
    notScored, unattributed, notCompleted, provisional: true,
    notes: [
      'Counting starts on 1 October 2026 (Q4 2026). Calls dated earlier are not counted.',
      'A client counts in the month of the Onboarding Call Date when Onboarding Completed is ticked, credited to the Onboarded By value.',
      'Exceptional: 10 or more completed a month · Target: 7 to 9 · Below target: under 7.',
      'This KPI is for the Customer Success Managers (Angela and Milica) only. Sergio is not mapped in Bitrix, so his calls are shown as not scored.',
      'Clients with a completed call but no Onboarded By are listed separately and credit nobody.'
    ]
  };
}

async function onboarding({ force }) {
  const result = await bitrix.loadCached('kpi:onboarding', calculate, force);
  return { ...result.data, cached: result.cached, stale: result.stale, cacheError: result.error || null };
}

module.exports = { onboarding };
