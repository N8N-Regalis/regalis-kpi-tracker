const bitrix = require('./bitrix');

const TIME_ZONE = 'America/New_York';
const PAGE_SIZE = 50;
const BATCH_SIZE = 20;
const MAX_RANGE_DAYS = 366;
const PRESENTATION_STAGE = 'DEAL_PRESENTATION';
const ACCEPTANCE_STAGE = 'SELLER_CALL';

function parseDateOnly(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${name} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${name} is not a valid calendar date`);
  }
  return { year, month, day, value };
}

function offsetMinutes(instant) {
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'longOffset'
  }).formatToParts(instant).find(part => part.type === 'timeZoneName')?.value || 'GMT';
  const match = zone.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0));
}

function localMidnightUtc({ year, month, day }) {
  const wallClock = Date.UTC(year, month - 1, day);
  let instant = wallClock;
  for (let attempt = 0; attempt < 4; attempt++) {
    const adjusted = wallClock - offsetMinutes(new Date(instant)) * 60_000;
    if (adjusted === instant) break;
    instant = adjusted;
  }
  return new Date(instant);
}

function zonedDate(instant) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(instant);
}

function mondayStart(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(instant);
  const value = type => parts.find(part => part.type === type).value;
  const daysSinceMonday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[value('weekday')];
  const date = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) - daysSinceMonday));
  return localMidnightUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

function stageRows(response) {
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.result?.items)) return response.result.items;
  if (Array.isArray(response?.result)) return response.result;
  return [];
}

async function listStageHistory(stageId, from, to, force) {
  const cacheKey = `kpi-test-history:${stageId}:${from}:${to}`;
  return bitrix.loadCached(cacheKey, async () => {
    const params = {
      entityTypeId: 2,
      filter: { STAGE_ID: stageId, '>=CREATED_TIME': from, '<CREATED_TIME': to },
      order: { CREATED_TIME: 'ASC' },
      select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME', 'CATEGORY_ID']
    };
    const first = await bitrix.call('crm.stagehistory.list', { ...params, start: 0 });
    const events = stageRows(first);
    const total = Number(first.total ?? first.result?.total) || events.length;
    let next = first.next ?? first.result?.next;

    while (next != null && events.length < total) {
      const starts = [];
      for (let start = Number(next); start < total && starts.length < BATCH_SIZE; start += PAGE_SIZE) starts.push(start);
      if (!starts.length) break;
      const command = Object.fromEntries(starts.map((start, index) => {
        const query = new URLSearchParams();
        query.set('entityTypeId', '2');
        query.set('filter[STAGE_ID]', stageId);
        query.set('filter[>=CREATED_TIME]', from);
        query.set('filter[<CREATED_TIME]', to);
        query.set('order[CREATED_TIME]', 'ASC');
        for (const field of params.select) query.append('select[]', field);
        query.set('start', String(start));
        return [`page${index}`, `crm.stagehistory.list?${query.toString()}`];
      }));
      const batch = await bitrix.call('batch', { halt: 0, cmd: command });
      const pages = batch.result?.result || {};
      const errors = batch.result?.result_error || {};
      for (let index = 0; index < starts.length; index++) {
        let page = pages[`page${index}`];
        if (errors[`page${index}`] || !page) {
          page = await bitrix.call('crm.stagehistory.list', { ...params, start: starts[index] });
        }
        let pageRows = stageRows(page);
        if (!pageRows.length && !errors[`page${index}`]) {
          page = await bitrix.call('crm.stagehistory.list', { ...params, start: starts[index] });
          pageRows = stageRows(page);
        }
        if (!pageRows.length) {
          next = null;
          break;
        }
        events.push(...pageRows);
        next = page.next ?? page.result?.next ?? null;
      }
    }

    const unique = [...new Map(events.map(event => [String(event.ID), event])).values()];
    return { events: unique, total, complete: unique.length >= total };
  }, force);
}

async function listContactLinks(dealIds) {
  const links = new Map();
  let errors = 0;
  for (let offset = 0; offset < dealIds.length; offset += BATCH_SIZE) {
    const chunk = dealIds.slice(offset, offset + BATCH_SIZE);
    const cmd = Object.fromEntries(chunk.map((id, index) => [`contact${index}`, `crm.deal.contact.items.get?id=${encodeURIComponent(id)}`]));
    const batch = await bitrix.call('batch', { halt: 0, cmd });
    const results = batch.result?.result || {};
    const failures = batch.result?.result_error || {};
    for (let index = 0; index < chunk.length; index++) {
      const value = results[`contact${index}`];
      if (failures[`contact${index}`] || !Array.isArray(value)) {
        errors++;
        links.set(chunk[index], null);
      } else {
        links.set(chunk[index], [...new Set(value.map(item => String(item.CONTACT_ID || '')).filter(Boolean))]);
      }
    }
  }
  return { links, errors };
}

async function calculateKpiTest({ from, to, force = false }) {
  const fromDate = parseDateOnly(from, 'from');
  const toDate = parseDateOnly(to, 'to');
  const start = localMidnightUtc(fromDate);
  const endDay = new Date(Date.UTC(toDate.year, toDate.month - 1, toDate.day + 1));
  const end = localMidnightUtc({ year: endDay.getUTCFullYear(), month: endDay.getUTCMonth() + 1, day: endDay.getUTCDate() });
  const rangeDays = (Date.UTC(toDate.year, toDate.month - 1, toDate.day) - Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day)) / 86_400_000 + 1;
  if (start > end || rangeDays < 1) throw new Error('Invalid date range');
  if (rangeDays > MAX_RANGE_DAYS) throw new Error(`Test Mode date range cannot exceed ${MAX_RANGE_DAYS} days`);

  const stages = await bitrix.loadCached('stages', bitrix.getStages, force);
  const stageById = new Map(stages.data.map(stage => [stage.id, stage]));
  const presentationStage = stageById.get(PRESENTATION_STAGE);
  const acceptanceStage = stageById.get(ACCEPTANCE_STAGE);
  if (!presentationStage || !acceptanceStage) throw new Error('Required Bitrix stages were not returned');

  const now = new Date();
  now.setSeconds(0, 0);
  const presentationResult = await listStageHistory(PRESENTATION_STAGE, start.toISOString(), end.toISOString(), force);
  const acceptanceResult = await listStageHistory(ACCEPTANCE_STAGE, start.toISOString(), now.toISOString(), force);
  const presentationEvents = presentationResult.data.events;
  const acceptanceEvents = acceptanceResult.data.events;
  const dealIds = [...new Set(presentationEvents.map(event => String(event.OWNER_ID)).filter(Boolean))];
  const { links, errors: contactLookupErrors } = await listContactLinks(dealIds);

  const acceptancesByDeal = new Map();
  for (const event of acceptanceEvents) {
    const key = String(event.OWNER_ID);
    if (!acceptancesByDeal.has(key)) acceptancesByDeal.set(key, []);
    acceptancesByDeal.get(key).push(new Date(event.CREATED_TIME));
  }
  for (const dates of acceptancesByDeal.values()) dates.sort((a, b) => a - b);

  const dealClientWeeks = new Map();
  let repeatedPresentationEvents = 0;
  let missingOrFailedContacts = 0;
  let multipleContactDeals = 0;
  for (const event of presentationEvents) {
    const dealId = String(event.OWNER_ID);
    const contactIds = links.get(dealId);
    if (!Array.isArray(contactIds) || contactIds.length !== 1) {
      if (contactIds?.length > 1) multipleContactDeals++;
      else missingOrFailedContacts++;
      continue;
    }
    const presentationDate = new Date(event.CREATED_TIME);
    const week = mondayStart(presentationDate);
    const weekStart = zonedDate(week);
    const key = `${dealId}|${contactIds[0]}|${week.toISOString()}`;
    const acceptedAt = (acceptancesByDeal.get(dealId) || []).find(date => date > presentationDate) || null;
    if (dealClientWeeks.has(key)) repeatedPresentationEvents++;
    const previous = dealClientWeeks.get(key);
    dealClientWeeks.set(key, {
      weekStart,
      weekEnd: zonedDate(new Date(week.getTime() + 6 * 86_400_000)),
      presentationEvents: (previous?.presentationEvents || 0) + 1,
      accepted: !!previous?.accepted || !!acceptedAt,
      acceptanceAfterPresentation: previous?.acceptanceAfterPresentation || acceptedAt?.toISOString() || null
    });
  }

  const weeks = new Map();
  for (const item of dealClientWeeks.values()) {
    if (!weeks.has(item.weekStart)) weeks.set(item.weekStart, { weekStart: item.weekStart, weekEnd: item.weekEnd, presentedDealClients: 0, acceptedDealClients: 0, acceptancePending: 0, presentationEvents: 0 });
    const week = weeks.get(item.weekStart);
    week.presentedDealClients++;
    week.presentationEvents += item.presentationEvents;
    if (item.accepted) week.acceptedDealClients++;
    else week.acceptancePending++;
  }
  const summary = [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const presentedDealClients = summary.reduce((sum, week) => sum + week.presentedDealClients, 0);
  const acceptedDealClients = summary.reduce((sum, week) => sum + week.acceptedDealClients, 0);
  return {
    mode: 'KPI TEST MODE',
    provisional: true,
    officialScoresActivated: false,
    timezone: TIME_ZONE,
    range: { from, to },
    stages: {
      presentation: { id: PRESENTATION_STAGE, name: presentationStage.name },
      acceptance: { id: ACCEPTANCE_STAGE, name: acceptanceStage.name }
    },
    metrics: {
      presentationEvents: presentationEvents.length,
      deduplicatedPresentedDealClients: presentedDealClients,
      acceptedPresentedDealClients: acceptedDealClients,
      acceptancePending: presentedDealClients - acceptedDealClients,
      repeatedPresentationEventsRemoved: repeatedPresentationEvents,
      unattributedPresented: presentedDealClients,
      unattributedAccepted: acceptedDealClients,
      missingOrFailedContactLinks: missingOrFailedContacts,
      multipleContactDeals: multipleContactDeals,
      contactLinkHistoryUnavailable: true,
      eventTimeOwnerHistoryUnavailable: true
    },
    verification: {
      historyComplete: presentationResult.data.complete && acceptanceResult.data.complete,
      contactAssociationSource: 'crm.deal.contact.items.get current links',
      acceptanceRule: 'A later SELLER_CALL stage-history event on the same deal',
      acceptedLaterThanPresentationRequired: true,
      acceptanceAndPresentationMustShareDeal: true,
      employeeCreditAssigned: false,
      reason: 'Bitrix stage history does not expose event-time ASSIGNED_BY_ID; current assignment is not substituted.',
      contactReason: 'Contact links are read from current deal-contact associations; historical link changes are unavailable.',
      contactLookupErrors,
      stageLabelMismatch: acceptanceStage.name !== 'Seller Call'
    },
    weeks: summary
  };
}

module.exports = { calculateKpiTest, TIME_ZONE, MAX_RANGE_DAYS };