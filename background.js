// Automation engine. Runs every 30 seconds via chrome.alarms,
// and immediately when the dashboard asks.
//
// DATA SAFETY: this file never deletes running cases on install/update. All stored data is
// upgraded in place by migrate() (schemaVersion), so follow-up counts, schedules and history
// continue exactly where they left off after an update (replace files + Reload).
import * as C from './cdax.js';

const ALARM = 'followup-engine';
const MAX_LOG = 300;
const MAX_HISTORY = 5000;        // history entries kept (oldest dropped first)
const SCHEMA_VERSION = 4;
const WATCH_EVERY_MS = 2 * 60 * 1000;   // a Ready-for-closure case is re-checked for replies at most every 2 minutes
const AGENT_WAIT_MS = 15 * 60 * 1000;   // wait up to 15 min for an agent to accept a new chat before writing the note
const REMOVE_MAX_ATTEMPTS = 5;          // attempts to remove a finished case from its queue

/* ---------- Serialised storage access (prevents races / duplicate sends) ---------- */
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

/* ---------- Startup + data migration ---------- */
async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM);
  if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

// Upgrades stored data to the current schema WITHOUT removing anything.
async function migrate() {
  const d = await chrome.storage.local.get(['schemaVersion', 'sequences', 'dismissed', 'history']);
  const sequences = d.sequences || {};
  const dismissed = d.dismissed || {};
  const history = d.history || {};
  let changed = false;

  for (const s of Object.values(sequences)) {
    if (!s || typeof s !== 'object') continue;
    if (s.status === 'error' && !(s.recipient && s.recipient.email) && /no customer email/i.test(s.lastError || '')) {
      s.status = 'noemail'; s.lastError = null; s.noEmailNotified = true; changed = true;
    }
    if (!Array.isArray(s.sent)) { s.sent = []; changed = true; }
    if (!Array.isArray(s.timeline)) { s.timeline = []; changed = true; }
    if (typeof s.sentCount !== 'number') { s.sentCount = s.sent.length; changed = true; }
    if (!s.createdAt) { s.createdAt = new Date().toISOString(); changed = true; }
    // v1.12: "Removed from queue" is its own status (it used to show as a red "Stopped")
    if (s.status === 'stopped' && /^Removed from the follow-up queue/i.test(s.stopReason || '')) { s.status = 'removed'; changed = true; }
    // v1.12: 2 follow-up emails instead of 3. Cases still being followed up move to the 2-email plan;
    // cases that already finished keep the plan they ran with (3).
    if (!s.planned) {
      changed = true;
      if (['active', 'paused', 'waactive', 'error', 'noemail'].includes(s.status)) {
        s.planned = C.CONFIG.maxFollowups;
        if (s.status === 'active' && (s.sentCount || 0) >= s.planned) {
          s.status = 'ready'; s.readyAt = s.readyAt || new Date().toISOString(); s.closureCheckAt = null;
          event(s, `Updated to 2 follow-ups: ${s.sentCount} follow-up email(s) were already sent - READY FOR CLOSURE`);
          markFinished(s);
        } else if (s.status === 'active') {
          event(s, 'Updated to 2 follow-ups: the next email is the closing notice, and the case becomes Ready for closure once it is sent');
        }
      } else s.planned = 3;
    }
    upsertHistory(history, s);
  }
  for (const h of Object.values(history)) {
    if (!h) continue;
    if (h.status === 'stopped' && /^Removed from the follow-up queue/i.test(h.stopReason || '')) h.status = 'removed';
    if (!h.planned) h.planned = 3;
  }
  for (const [id, v] of Object.entries(dismissed)) {
    if (v === null) { delete dismissed[id]; changed = true; }
    else if (typeof v === 'string') { dismissed[id] = { queueItemId: v, at: null }; changed = true; }
  }

  await chrome.storage.local.set({ sequences, dismissed, history: trimHistory(history), schemaVersion: SCHEMA_VERSION });
  if (changed || (d.schemaVersion || 0) < SCHEMA_VERSION) {
    await log(`Data checked after start/update (schema v${SCHEMA_VERSION}): ${Object.keys(sequences).length} case(s) kept, nothing removed.`);
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); serial(migrate); });
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
serial(migrate);

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) runEngine(); });

async function openDashboard() {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
chrome.action.onClicked.addListener(openDashboard);
chrome.notifications.onClicked.addListener((id) => { openDashboard(); chrome.notifications.clear(id); });

async function load() {
  const s = await chrome.storage.local.get(['sequences', 'activity', 'settings', 'templates', 'dismissed']);
  const settings = { ...C.DEFAULT_SETTINGS, ...(s.settings || {}) };
  if (!C.INTERVALS.some(i => i.ms === settings.intervalMs)) settings.intervalMs = C.DEFAULT_SETTINGS.intervalMs;
  return { sequences: s.sequences || {}, activity: s.activity || [], settings,
           templates: s.templates || null, dismissed: s.dismissed || {} };
}

/* ---------- History (permanent record of every case handled) ---------- */
const historyKey = (s) => `${s.incidentId}|${s.createdAt}`;

function historyEntry(s, extra = {}) {
  const realSent = (s.sent || []).filter(r => r.emailId);
  return {
    key: historyKey(s),
    incidentId: s.incidentId,
    caseNumber: s.caseNumber,
    customerName: s.customerName || '',
    customerEmail: (s.recipient && s.recipient.email) || '',
    owner: s.ownerSignature || s.owner || '',
    queueName: s.queueName || '',
    addedAt: s.createdAt,
    startedBy: s.auto ? 'Auto-start' : ((s.startedBy && s.startedBy.name) || ''),
    intervalMs: s.intervalMs,
    sentCount: s.sentCount || 0,
    planned: s.planned || C.CONFIG.maxFollowups,
    sentDates: realSent.map(r => ({ n: r.n, at: r.at, status: r.statusText || '' })),
    responded: s.status === 'responded',
    response: s.response ? { at: s.response.at, subject: s.response.subject || '', from: s.response.from || '',
                             channel: s.response.channel || '', manual: !!s.response.manual } : null,
    newContact: s.newContact ? { at: s.newContact.at, channel: s.newContact.channel, isCall: !!s.newContact.isCall,
                                 agent: s.newContact.agent || '', queue: s.newContact.queue || '',
                                 otherCase: s.newContact.otherCase || '' } : null,
    queueRemoved: s.queueRemoval && s.queueRemoval.done ? { at: s.queueRemoval.at, removed: s.queueRemoval.removed } : null,
    status: s.status,
    stopReason: s.stopReason || null,
    readyAt: s.readyAt || null,
    lastError: s.lastError || null,
    updatedAt: new Date().toISOString(),
    timeline: (s.timeline || []).slice(-60),
    ...extra
  };
}

function upsertHistory(history, s, extra) {
  if (!s || !s.incidentId || !s.createdAt) return;
  const prev = history[historyKey(s)];
  history[historyKey(s)] = { ...(prev || {}), ...historyEntry(s, extra) };
}

function trimHistory(history) {
  const keys = Object.keys(history);
  if (keys.length <= MAX_HISTORY) return history;
  keys.sort((a, b) => Date.parse(history[a].addedAt || 0) - Date.parse(history[b].addedAt || 0));
  for (const k of keys.slice(0, keys.length - MAX_HISTORY)) delete history[k];
  return history;
}

// Saves running cases AND updates their history entries in the same write.
async function saveSequences(sequences, extraFor = {}, dropHistoryKeys = []) {
  const { history = {} } = await chrome.storage.local.get('history');
  for (const k of dropHistoryKeys) delete history[k];
  for (const s of Object.values(sequences)) upsertHistory(history, s, extraFor[s.incidentId]);
  await chrome.storage.local.set({ sequences, history: trimHistory(history) });
}

async function log(msg, level = 'info') {
  const { activity = [] } = await chrome.storage.local.get('activity');
  activity.unshift({ at: new Date().toISOString(), msg, level });
  await chrome.storage.local.set({ activity: activity.slice(0, MAX_LOG) });
}

function notify(title, message) {
  chrome.notifications.create(`cdax-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, {
    type: 'basic', iconUrl: 'icon128.png', title, message, priority: 2, requireInteraction: true
  });
}

function event(s, text) {
  s.timeline = s.timeline || [];
  s.timeline.push({ at: new Date().toISOString(), text });
}

/* ---------- Messages from the dashboard ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(r => sendResponse({ ok: true, ...r }), e => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'runNow': runEngine(); return {};
    case 'resolveSender': {
      const { settings } = await load();
      return { sender: await C.resolveSender(settings.senderQueue, msg.incidentId) };
    }
    case 'saveSettings':
      return serial(async () => {
        const ms = Number(msg.settings && msg.settings.intervalMs);
        if (!C.INTERVALS.some(i => i.ms === ms)) throw new Error('Invalid interval.');
        const senderQueue = String((msg.settings && msg.settings.senderQueue) || '').trim() || C.DEFAULT_SENDER_QUEUE;
        const sender = await C.resolveSender(senderQueue, null);
        const { settings: cur } = await load();
        await chrome.storage.local.set({ settings: { ...cur, intervalMs: ms, senderQueue } });
        await log(`Settings saved: interval ${C.formatDuration(ms)}, send from "${sender.name}" (${sender.source}). Applies to new sequences.`);
        return { sender };
      });
    case 'log': return serial(() => log(msg.msg, msg.level));
    case 'setRemoveFromQueue': {
      await serial(async () => {
        const { settings: cur } = await load();
        await chrome.storage.local.set({ settings: { ...cur, removeFromQueue: !!msg.value } });
        await log(`Removing finished cases from the queue turned ${msg.value ? 'ON' : 'OFF'}.`);
      });
      if (msg.value) runEngine();
      return {};
    }
    case 'setAutoStart': {
      await serial(async () => {
        const { settings: cur } = await load();
        await chrome.storage.local.set({ settings: { ...cur, autoStart: !!msg.value } });
        await log(`Auto-start for new cases turned ${msg.value ? 'ON' : 'OFF'}.`);
      });
      if (msg.value) runEngine();
      return {};
    }
    case 'importBackup': {
      await serial(async () => {
        const data = msg.data || {};
        if (!data.sequences || typeof data.sequences !== 'object') throw new Error('This file is not a CDAX Follow-up Bot backup.');
        const keep = ['sequences', 'dismissed', 'history', 'settings', 'templates', 'templatesMeta', 'monitorQueue', 'showLog', 'activity'];
        const toSet = {};
        for (const k of keep) if (data[k] !== undefined) toSet[k] = data[k];
        await chrome.storage.local.set(toSet);
        await migrate();
        await log(`Backup restored (${Object.keys(data.sequences).length} case(s)).`);
      });
      runEngine();
      return {};
    }
    case 'startSequence': {
      await serial(() => startSequence(msg.data));
      runEngine();
      return {};
    }
    case 'pause': case 'resume': case 'stop': case 'dismiss':
      await serial(() => changeSequence(msg.type, msg.incidentId));
      if (msg.type === 'resume') runEngine();
      return {};
    case 'removeFromQueue':
      await serial(() => manuallyRemoveFromQueue(msg.incidentId));
      return {};
    default: throw new Error(`Unknown message ${msg.type}`);
  }
}

async function createSequence(d, settings, templates, me, auto, needSender = true) {
  const waWindow = d.whatsappWindow || null;
  const waitForWhatsappBlock = !!(waWindow && !waWindow.blocked);
  const s = {
    incidentId: d.incidentId,
    queueId: d.queueId || C.CONFIG.queueId,
    queueName: d.queueName || C.CONFIG.queueName,
    queueItemId: d.queueItemId || null,
    caseNumber: d.caseNumber,
    crmNumber: d.crmNumber,
    customerName: d.customerName,
    recipient: d.recipient,                 // {type, id, email, label}
    contactIds: Array.isArray(d.contactIds) ? d.contactIds : null,   // case contacts - used to detect new chats/calls
    owner: d.owner,
    templateKind: d.templateKind === 'chat' ? 'chat' : 'default',   // 'chat' = non-WhatsApp case (chat disconnected email)
    caseChannel: d.caseChannel || null,                             // e.g. "Live chat" / "WhatsApp" / null (no conversation)
    waConversationId: d.waConversationId || (waWindow && waWindow.conversationId) || null,
    waLastCustomerMessageAt: (waWindow && waWindow.lastCustomerMessageAt) || null,
    waWindowEndsAt: (waWindow && waWindow.windowEndsAt) || null,
    waWindowKnown: !!(waWindow && waWindow.known),
    templateId: d.templateKind === 'chat' ? 'chat-disconnected' : (templates ? 'custom' : C.TEMPLATE.id),
    templateName: d.templateKind === 'chat' ? `${C.CHAT_TEMPLATE_NAME} (${d.caseChannel || 'chat'})`
                                            : (templates ? 'Custom templates' : 'Default templates'),
    auto: !!auto,
    startedBy: auto ? { id: null, name: 'Auto-start' } : { id: me.id, name: me.fullname },
    intervalMs: settings.intervalMs,
    sender: needSender ? await C.resolveSender(settings.senderQueue, d.incidentId) : null,
    emailLookupV: C.EMAIL_LOOKUP_V,
    planned: C.CONFIG.maxFollowups,
    status: waitForWhatsappBlock ? 'waactive' : 'active',
    sentCount: 0,
    sent: [],
    nextDueAt: waitForWhatsappBlock && waWindow.windowEndsAt ? Date.parse(waWindow.windowEndsAt) : (waitForWhatsappBlock ? null : Date.now()),
    closureCheckAt: null,
    response: null,
    newContact: null,
    queueRemoval: null,
    errorCount: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    timeline: []
  };
  if (waitForWhatsappBlock) {
    event(s, `${auto ? 'Checked automatically when the case entered the queue' : `Checked by ${me.fullname || 'agent'}`} - ` +
             'WhatsApp conversation is active, so no follow-up was sent. The bot will re-check until the 24-hour window ends.');
    event(s, s.waLastCustomerMessageAt
      ? `Latest customer WhatsApp message: ${s.waLastCustomerMessageAt}; 24-hour window ends: ${s.waWindowEndsAt}`
      : 'No customer-message timestamp is available yet; treated as an active WhatsApp conversation for safety.');
  } else if (needSender) {
    event(s, `${auto ? 'Auto-started when the case entered the queue' : `Started by ${me.fullname || 'agent'}`} - ` +
             `${s.templateName}, ${C.CONFIG.maxFollowups} follow-ups to ${s.recipient.email || '(no email)'}` +
             `${s.recipient.label ? ' (' + s.recipient.label + ')' : ''} from ${s.sender.name}, ${C.formatDuration(s.intervalMs)} apart`);
    event(s, s.caseChannel
      ? `Case came in on ${s.caseChannel} - ${s.templateKind === 'chat' ? 'using the "chat got disconnected" email (reconnect link in every email)' : 'using the standard follow-up emails'}`
      : 'No chat or call is linked to the case - using the standard follow-up emails');
  }
  return s;
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

async function startSequence(d) {
  const { sequences, settings, templates, dismissed } = await load();
  const existing = sequences[d.incidentId];
  if (existing && ['active', 'paused'].includes(existing.status)) {
    throw new Error(`Case ${existing.caseNumber} already has a follow-up sequence running.`);
  }
  if (!validEmail(d.recipient && d.recipient.email)) throw new Error('A valid customer email address is required.');
  const me = await C.whoAmI();
  const ch = await C.getCaseChannel(d.incidentId);       // throws on API error -> nothing is started
  const waWindow = ch && ch.isWhatsApp ? await C.getCaseWhatsappWindow(d.incidentId, ch) : null;
  d = { ...d, templateKind: C.templateKindFor(ch), caseChannel: ch ? ch.channel : null,
        waConversationId: ch && ch.isWhatsApp ? ch.id : null, whatsappWindow: waWindow };
  const s = await createSequence(d, settings, templates, me, false, !(waWindow && !waWindow.blocked));
  sequences[d.incidentId] = s;
  if (dismissed[d.incidentId] !== undefined) { delete dismissed[d.incidentId]; await chrome.storage.local.set({ dismissed }); }
  await saveSequences(sequences);
  await log(waWindow && !waWindow.blocked
    ? `Case ${s.caseNumber}: WhatsApp conversation is active - follow-ups stopped until the 24-hour window ends.`
    : `Follow-up sequence started for case ${s.caseNumber} (to ${s.recipient.email}).`, 'new');
}

function isBlockedByClear(dm, it) {
  if (dm === undefined || dm === null) return false;
  if (typeof dm === 'string') return dm === it.id;
  if (typeof dm === 'object') {
    if (dm.queueItemId && dm.queueItemId === it.id) return true;
    const clearedAt = Date.parse(dm.at || 0);
    const entered = Date.parse(it.enteredOn || 0);
    if (!dm.queueItemId && entered && clearedAt && entered <= clearedAt) return true;
  }
  return false;
}

const MAX_AUTO_PER_RUN = 10;
const autoFail = new Map();

async function autoStartNew(sequences, settings, templates, dismissed, me) {
  const mq = await C.getMonitorQueue();
  const items = await C.getQueueItems(mq.id);
  let started = 0;
  for (const it of items) {
    if (started >= MAX_AUTO_PER_RUN) break;
    if (!it.isCase || !it.caseActive || !it.incidentId) continue;
    const id = it.incidentId;
    const ex = sequences[id];
    if (ex && ['active', 'paused'].includes(ex.status)) continue;
    // "No email address found" from an older, narrower email lookup -> check this queue entry once more
    const recheckNoEmail = !!(ex && ex.status === 'noemail' && (ex.emailLookupV || 1) < C.EMAIL_LOOKUP_V);
    if (ex && !recheckNoEmail && (ex.queueItemId || it.id) === it.id) continue;   // already handled for this queue entry
    if (dismissed[id] !== undefined) {
      if (isBlockedByClear(dismissed[id], it)) continue;
      delete dismissed[id]; await chrome.storage.local.set({ dismissed });
      await log(`Case ${it.caseNumber}: was cleared earlier, but has been added to the queue again - starting follow-ups.`);
    }
    try {
      const det = await C.getIncidentDetails(id);
      const r = det.recipients[0];
      const base = {
        incidentId: id, queueId: mq.id, queueName: mq.name, queueItemId: it.id,
        caseNumber: it.caseNumber || det.caseNumber, crmNumber: det.crmNumber, owner: det.owner || it.owner,
        contactIds: det.contactIds || []
      };
      const dropKeys = [];
      if (recheckNoEmail && r) dropKeys.push(`${ex.incidentId}|${ex.createdAt}`);   // the earlier "no email" was wrong
      let s;
      if (r && validEmail(r.email)) {
        const ch = await C.getCaseChannel(id);           // throws on API error -> auto-start retries on the next run
        const waWindow = ch && ch.isWhatsApp ? await C.getCaseWhatsappWindow(id, ch) : null;
        base.templateKind = C.templateKindFor(ch);
        base.caseChannel = ch ? ch.channel : null;
        base.waConversationId = ch && ch.isWhatsApp ? ch.id : null;
        base.whatsappWindow = waWindow;
        s = await createSequence({ ...base, customerName: r.firstname || r.name || det.customerName || '',
                                   recipient: { type: r.type, id: r.id, email: r.email, label: r.label } }, settings, templates, me, true,
                                   !(waWindow && !waWindow.blocked));
        if (recheckNoEmail) event(s, 'Customer email found after an update of the email lookup (was "No email address found").');
        await log(waWindow && !waWindow.blocked
          ? `Case ${s.caseNumber}: WhatsApp conversation is active - no follow-up sent; re-checking until the 24-hour window ends.`
          : `Case ${s.caseNumber}: ${recheckNoEmail ? 'email found on re-check' : 'added to the queue'} - follow-ups started automatically (to ${r.email}, ${r.label}).`, 'new');
      } else if (recheckNoEmail) {
        ex.emailLookupV = C.EMAIL_LOOKUP_V;                 // still no email - keep as is, don't check again
        event(ex, 'Re-checked after update - still no email address found.');
        sequences[id] = ex;
        await saveSequences(sequences);
        continue;
      } else {
        s = await createSequence({ ...base, customerName: det.customerName || '',
                                   recipient: { type: 'address', id: null, email: '' } }, settings, templates, me, true, false);
        s.status = 'noemail';
        s.noEmailNotified = true;
        event(s, 'No contact email address found on the case - no follow-ups sent. Add the email to the case contact in CDAX, then remove and re-add the case to the queue.');
        await log(`Case ${s.caseNumber}: no email address found - follow-ups not started.`, 'removed');
        notify(`No email address found - Case ${s.caseNumber}`, 'Add the email to the case contact in CDAX, then remove and re-add the case to the queue.');
      }
      sequences[id] = s;
      await saveSequences(sequences, {}, dropKeys);
      autoFail.delete(id);
      started++;
    } catch (e) {
      if (autoFail.get(id) !== e.message) {
        autoFail.set(id, e.message);
        await log(`Case ${it.caseNumber}: auto-start failed, will retry - ${e.message}`, 'error');
      }
    }
  }
}

async function changeSequence(action, incidentId) {
  const { sequences, dismissed } = await load();
  const s = sequences[incidentId];
  if (!s) throw new Error('Sequence not found.');
  const me = await C.whoAmI().catch(() => ({ fullname: 'agent' }));
  const who = me.fullname || 'agent';
  if (action === 'dismiss') {
    event(s, `Cleared from the dashboard by ${who}`);
    const { history = {} } = await chrome.storage.local.get('history');
    upsertHistory(history, s, { clearedBy: who, clearedAt: new Date().toISOString() });
    dismissed[incidentId] = { queueItemId: s.queueItemId || null, at: new Date().toISOString() };
    delete sequences[incidentId];
    await chrome.storage.local.set({ dismissed, sequences, history: trimHistory(history) });
    await log(`Case ${s.caseNumber} cleared from automation by ${who}. It will start again only if it is removed and added to the queue again.`);
    return;
  }
  if (action === 'pause' && s.status === 'active') { s.status = 'paused'; event(s, `Paused by ${who}`); }
  else if (action === 'resume' && s.status === 'paused') {
    s.status = 'active'; s.nextDueAt = Math.max(s.nextDueAt || 0, Date.now());
    event(s, `Resumed by ${who}`);
    if ((s.sentCount || 0) >= (s.planned || C.CONFIG.maxFollowups)) {       // all emails were already sent
      s.status = 'ready'; s.readyAt = new Date().toISOString(); s.closureCheckAt = null;
      event(s, 'All follow-up emails were already sent - READY FOR CLOSURE');
      markFinished(s);
    }
  }
  else if (action === 'stop' && ['active', 'paused', 'error'].includes(s.status)) { s.status = 'stopped'; s.stopReason = `Stopped by ${who}`; event(s, s.stopReason); }
  else return;
  await saveSequences(sequences);
  await log(`Case ${s.caseNumber}: ${action} by ${who}.`);
}

// Explicit action shown while a WhatsApp conversation is still active. It removes only the queue
// item (never the case), records the result, and prevents the held sequence from starting later.
async function manuallyRemoveFromQueue(incidentId) {
  const { sequences } = await load();
  const s = sequences[incidentId];
  if (!s) throw new Error('Sequence not found.');
  if (s.status !== 'waactive') throw new Error('Remove from queue is available only while the WhatsApp conversation is active.');
  const me = await C.whoAmI().catch(() => ({ fullname: 'agent' }));
  const who = me.fullname || 'agent';
  const r = await C.removeCaseFromQueue(s.queueId || C.CONFIG.queueId, s.incidentId);
  s.status = 'removed';
  s.stopReason = `Removed from the follow-up queue by ${who}`;
  s.queueRemoval = { pending: false, attempts: 0, done: true, at: new Date().toISOString(), removed: r.removed, manual: true, error: null };
  event(s, r.removed
    ? `Removed from queue "${s.queueName || 'queue'}" by ${who} while the WhatsApp conversation was active`
    : `Queue removal requested by ${who}; the case was already not in the queue`);
  await saveSequences(sequences);
  await log(`Case ${s.caseNumber}: ${r.removed ? 'removed from the queue' : 'already not in the queue'} by ${who} (WhatsApp conversation active).`, 'removed');
}

/* ---------- Engine ---------- */
let engineRunning = false;
let rerun = false;

function runEngine() {
  if (engineRunning) { rerun = true; return; }
  engineRunning = true;
  serial(engineTick)
    .catch(e => serial(() => log(`Engine error: ${e.message}`, 'error')))
    .finally(() => {
      engineRunning = false;
      if (rerun) { rerun = false; runEngine(); }
    });
}

let currentTemplates = null;

async function engineTick() {
  await engineMain();
  try { await removeFinishedPass(); } catch { /* retried on the next run */ }
}

async function engineMain() {
  const { sequences, settings, templates, dismissed } = await load();
  currentTemplates = templates;
  let autoErr = null;
  if (settings.autoStart) {
    try { await autoStartNew(sequences, settings, templates, dismissed, await C.whoAmI()); }
    catch (e) { autoErr = e.message === 'NO_TAB' ? 'No CDAX tab open - follow-ups are on hold until CDAX is open and signed in.' : e.message; }
  }
  // Finish new-chat records that were waiting for an agent to accept the chat
  try { await completePendingNewContacts(sequences); } catch { /* retried next run */ }

  const live = Object.values(sequences).filter(s => s.status === 'active' || s.status === 'waactive');
  // Ready-for-closure cases keep being watched for a customer reply until the case is closed in CDAX
  const watchers = Object.values(sequences).filter(s => s.status === 'ready' && !s.watchEnded);
  const running = [...live, ...watchers];
  await chrome.storage.local.set({ engine: { lastRun: new Date().toISOString(), activeCount: live.length, watching: watchers.length, error: autoErr, autoStart: !!settings.autoStart } });
  if (!running.length) return;

  let me; const queueIds = {};
  try {
    me = await C.whoAmI();
    for (const qid of new Set(live.map(s => s.queueId || C.CONFIG.queueId))) {
      queueIds[qid] = new Set((await C.getQueueItems(qid)).map(i => i.incidentId));
    }
  } catch (e) {
    const msg = e.message === 'NO_TAB' ? 'No CDAX tab open - follow-ups are on hold until CDAX is open and signed in.' : e.message;
    await chrome.storage.local.set({ engine: { lastRun: new Date().toISOString(), activeCount: live.length, watching: watchers.length, error: msg, autoStart: !!settings.autoStart } });
    return;
  }

  for (const s of running) {
    try {
      if (s.status === 'waactive') await processWaitingWhatsapp(s, settings, queueIds);
      if (s.status === 'ready') {
        if (Date.now() - (s.lastWatchAt || 0) < WATCH_EVERY_MS) continue;     // throttled
        s.lastWatchAt = Date.now();
      } else if (s.status !== 'active') { sequences[s.incidentId] = s; await saveSequences(sequences); continue; }
      await refreshDelivery(s);
      if (s.status !== 'active' && s.status !== 'ready') { sequences[s.incidentId] = s; await saveSequences(sequences); continue; }
      await processSequence(s, me, queueIds);
      // Recovered: clear a stale "Access denied (HTTP 401)" warning once a case check succeeds
      if (s.lastError && /Access denied \(HTTP 401\)/i.test(s.lastError)) { s.lastError = null; s.errorCount = 0; }
      // A Ready-for-closure case that is only being watched: a successful check clears a temporary connection error
      if (s.status === 'ready' && s.lastError && /Access denied|HTTP \d{3}|Could not run the request|No response from the CDAX tab/i.test(s.lastError)) { s.lastError = null; s.errorCount = 0; }
    } catch (e) {
      s.errorCount = (s.errorCount || 0) + 1;
      s.lastError = e.message;
      await log(`Case ${s.caseNumber}: ${e.message} (attempt ${s.errorCount}/${C.CONFIG.maxErrors})`, 'error');
      if (s.errorCount >= C.CONFIG.maxErrors && s.status !== 'waactive' && s.status !== 'ready') {
        s.status = 'error';
        event(s, `Stopped after ${s.errorCount} failed attempts: ${e.message}`);
        notify(`Follow-up error - Case ${s.caseNumber}`, 'The follow-up sequence stopped after repeated errors. Open the dashboard for details.');
      }
    }
    sequences[s.incidentId] = s;
    await saveSequences(sequences);
  }
}

const STUCK_MS = 15 * 60 * 1000;

async function refreshDelivery(s) {
  for (const rec of s.sent || []) {
    if (!rec.emailId || [3, 2].includes(rec.statuscode) || rec.duplicateSkipped) continue;
    const st = await C.getEmailStatus(rec.emailId);
    if (st.statuscode === rec.statuscode) {
      if ([6, 7].includes(st.statuscode) && !rec.stuckWarned && Date.now() - Date.parse(rec.at) > STUCK_MS) {
        rec.stuckWarned = true;
        const m = `Follow-up ${rec.n} has been "${st.statusText}" for over ${STUCK_MS / 60000} minutes - CDAX has not delivered it. ` +
                  `The sending mailbox (${(s.sender && s.sender.name) || 'unknown'}) may not be enabled for server-side sync.${s.status === 'ready' ? '' : ' Next follow-ups are on hold.'}`;
        s.lastError = m; event(s, m);
        await log(`Case ${s.caseNumber}: ${m}`, 'error');
        notify(`Email not delivered - Case ${s.caseNumber}`, m);
      }
      continue;
    }
    if (st.statuscode === 3) {
      s.lastError = null;
      rec.deliveredAt = new Date().toISOString();
      if (rec === s.sent[s.sent.length - 1] && s.status === 'active') s.nextDueAt = Date.now() + s.intervalMs;
    }
    rec.statuscode = st.statuscode; rec.statusText = st.statusText;
    event(s, `Follow-up ${rec.n} delivery status: ${st.statusText}`);
    if (st.statuscode === 8 || st.statuscode === 5) {
      s.status = 'error';
      s.lastError = `Follow-up ${rec.n} ${st.statusText.toLowerCase()} in CDAX (mailbox / server-side sync problem). Open the email in CDAX for the reason.`;
      event(s, s.lastError);
      await log(`Case ${s.caseNumber}: ${s.lastError}`, 'error');
      notify(`Email failed - Case ${s.caseNumber}`, s.lastError);
    }
  }
}

/* ---------- Case notes (Dynamic Notes) ---------- */
// Supplemental Log first; Timeline note only if that fails. Never throws.
async function writeNote(s, text, fallbackSubject, owner) {
  const ownerName = owner.name || C.displayName(owner.raw) || 'the case owner';
  try {
    const nr = await C.addSupplementalLog(s.incidentId, text, owner);
    if (!nr.ownerSet && owner.id) {
      await log(`Case ${s.caseNumber}: Supplemental Log added, but it could not be assigned to the case owner - ${nr.ownerError}`, 'error');
    }
    return { noteId: nr.noteId, noteType: 'supplemental', ownerName, ownerSet: nr.ownerSet };
  } catch (e) {
    await log(`Case ${s.caseNumber}: Supplemental Log failed - ${e.message}. Adding a Timeline note instead.`, 'error');
  }
  try {
    const nr = await C.addCaseNote(s.incidentId, fallbackSubject, text, owner);
    return { noteId: nr.noteId, noteType: 'timeline', ownerName, ownerSet: nr.ownerSet };
  } catch (e) {
    await log(`Case ${s.caseNumber}: no note could be added - ${e.message}`, 'error');
    return null;
  }
}

async function documentFollowup(s, rec, n, owner) {
  const max = C.CONFIG.maxFollowups;
  const ownerName = owner.name || C.displayName(owner.raw) || 'the case owner';
  const text = `Follow-up email sent from the case on behalf of ${ownerName} by the bot.`;
  const r = await writeNote(s, text, `Bot follow-up ${n}/${max} sent to customer`, owner);
  if (r) {
    rec.noteId = r.noteId; rec.noteType = r.noteType;
    event(s, r.noteType === 'supplemental'
      ? `Dynamic Notes: Supplemental Log added for follow-up ${n}/${max}` + (r.ownerSet ? ` (owner: ${ownerName})` : '')
      : `Timeline note added for follow-up ${n}/${max} (fallback)`);
  } else {
    event(s, `Could not document follow-up ${n} on the case`);
  }
}

/* ---------- Finished cases leave the queue (but stay on the dashboard) ---------- */
// Called at the moment a sequence finishes: customer replied (email or marked manually), a new
// chat/call started, or both follow-ups are sent with no response (Ready for closure). Only sequences that finish
// AFTER this version is installed are flagged, so cases that finished earlier are never touched.
function markFinished(s) {
  if (!s.queueRemoval) s.queueRemoval = { pending: true, attempts: 0, done: false };
}

function finishReason(s) {
  if (s.newContact) return s.newContact.isCall ? 'new call from the customer' : 'new chat from the customer';
  if (s.status === 'responded') return 'customer responded';
  if (s.status === 'ready') return '2 follow-ups done';
  return 'follow-up finished';
}

async function removeFinishedPass() {
  const { sequences, settings } = await load();
  if (!settings.removeFromQueue) return;
  const todo = Object.values(sequences).filter(s => s.queueRemoval && s.queueRemoval.pending && !s.queueRemoval.done &&
    (s.queueRemoval.attempts || 0) < REMOVE_MAX_ATTEMPTS && ['responded', 'ready', 'stopped'].includes(s.status));
  if (!todo.length) return;
  let changed = false;
  for (const s of todo) {
    const qr = s.queueRemoval;
    try {
      const r = await C.removeCaseFromQueue(s.queueId || C.CONFIG.queueId, s.incidentId);
      qr.done = true; qr.pending = false; qr.at = new Date().toISOString(); qr.removed = r.removed; qr.error = null;
      const why = finishReason(s);
      event(s, r.removed ? `Removed from queue "${s.queueName || 'queue'}" (${why}) - kept on the dashboard` : `Already not in the queue (${why})`);
      await log(`Case ${s.caseNumber}: ${r.removed ? 'removed from the queue' : 'already not in the queue'} (${why}).`, 'removed');
      changed = true;
    } catch (e) {
      if (e.message === 'NO_TAB') break;
      qr.attempts = (qr.attempts || 0) + 1;
      qr.error = e.message.slice(0, 300);
      event(s, `Could not remove from the queue (attempt ${qr.attempts}/${REMOVE_MAX_ATTEMPTS}): ${qr.error}`);
      await log(`Case ${s.caseNumber}: could not remove from the queue (attempt ${qr.attempts}/${REMOVE_MAX_ATTEMPTS}) - ${qr.error}`, 'error');
      if (qr.attempts >= REMOVE_MAX_ATTEMPTS) {
        qr.pending = false;
        notify(`Remove from queue failed - Case ${s.caseNumber}`, 'The bot could not remove this finished case from the queue. Please remove it manually in CDAX.');
      }
      changed = true;
    }
  }
  if (changed) await saveSequences(sequences);
}

/* ---------- New chat / call from the customer ---------- */
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function channelText(c) {
  if (c.isCall) return /call/i.test(c.channel) ? c.channel : `${c.channel} call`;
  return /chat/i.test(c.channel) ? c.channel : `${c.channel} chat`;
}

function newContactSentence(c) {
  const agent = c.agent ? C.displayName(c.agent) : 'not yet assigned to an agent';
  const queue = c.queue || c.workstream || '';
  const recv = c.agent ? `received by ${agent}` : agent;
  return `new ${channelText(c)} initiated on ${fmtWhen(c.at)}, ${recv}${queue ? ` in queue ${queue}` : ''}` +
         (c.otherCase ? ` (linked to case ${c.otherCase})` : '');
}

function newContactReason(c) {
  return c.otherCase
    ? `Customer contacted us on another case - ${newContactSentence(c)}. Please check.`
    : `Customer ${newContactSentence(c)}.`;
}

async function writeNewContactNote(s) {
  const c = s.newContact;
  let owner = { name: '' };
  try { owner = await C.getCaseOwner(s.incidentId); } catch { /* note still written */ }
  const ownerName = owner.name || C.displayName(owner.raw) || 'the case owner';
  const text = `Follow-up stopped - customer ${newContactSentence(c)}. Follow-up terminated by the bot on behalf of ${ownerName}.`;
  const r = await writeNote(s, text, 'Bot follow-up stopped - new customer contact', owner);
  c.noteDone = true;
  c.noteId = r ? r.noteId : null;
  event(s, r ? `Dynamic Notes: follow-up termination logged (${r.noteType === 'supplemental' ? 'Supplemental Log' : 'Timeline note'})`
             : 'Could not log the follow-up termination on the case');
}

async function stopForNewContact(s, c) {
  s.status = 'stopped';
  s.newContact = { ...c, detectedAt: new Date().toISOString(), noteDone: false };
  s.stopReason = newContactReason(s.newContact);
  event(s, `Follow-up terminated - ${s.stopReason}`);
  markFinished(s);
  await log(`Case ${s.caseNumber}: follow-up terminated - ${s.stopReason}`, 'new');
  notify(`New ${c.isCall ? 'call' : 'chat'} - Case ${s.caseNumber}`, `Follow-ups stopped. ${s.stopReason}`);
  // Write the note now if the agent is known; otherwise wait (up to 15 min) for an agent to accept the chat.
  if (c.agent || c.source !== 'conversation') await writeNewContactNote(s);
}

async function stopForWhatsappResponse(s, at, details = {}) {
  s.status = 'responded';
  s.response = {
    at: at || new Date().toISOString(),
    subject: 'WhatsApp customer message',
    from: details.customer || '',
    channel: 'whatsapp',
    conversationId: details.id || s.waConversationId || null,
    agent: details.agent || '',
    queue: details.queue || ''
  };
  event(s, 'Customer responded on WhatsApp after a follow-up email - remaining follow-ups cancelled.');
  markFinished(s);
  await log(`Case ${s.caseNumber}: CUSTOMER RESPONDED ON WHATSAPP - sequence stopped, agent action required.`, 'new');
  notify(`WhatsApp customer response - Case ${s.caseNumber}`, 'Remaining follow-ups cancelled. Agent action required.');
}

// For chats still waiting in a queue when detected: pick up the agent once accepted, then write the note.
async function completePendingNewContacts(sequences) {
  let changed = false;
  for (const s of Object.values(sequences)) {
    const c = s.newContact;
    if (!c || c.noteDone) continue;
    const waited = Date.now() - Date.parse(c.detectedAt || 0);
    if (c.source === 'conversation' && !c.agent) {
      try {
        const cur = await C.getConversation(c.id);
        if (cur.agent) {
          c.agent = cur.agent;
          if (cur.queue) c.queue = cur.queue;
          s.stopReason = newContactReason(c);
          event(s, `New ${c.isCall ? 'call' : 'chat'} accepted by ${C.displayName(cur.agent)}`);
        }
      } catch { /* try again next run */ }
    }
    if (c.agent || waited >= AGENT_WAIT_MS) { await writeNewContactNote(s); changed = true; }
  }
  if (changed) await saveSequences(sequences);
}

const isWhatsappSequence = (s) => !!(s && (s.waConversationId || /whatsapp|192300000/i.test(s.caseChannel || '')));

function rememberWhatsappWindow(s, w) {
  if (!w) return;
  s.waConversationId = w.conversationId || s.waConversationId || null;
  s.waWindowKnown = !!w.known;
  s.waLastCustomerMessageAt = w.lastCustomerMessageAt || null;
  s.waWindowEndsAt = w.windowEndsAt || null;
}

// A non-greyed-out WhatsApp case is held safely: no email is sent, but it is re-checked every
// engine run. Once 24 hours have elapsed since the latest customer message, the normal sequence
// starts immediately. If the timestamp is not available, it remains held rather than guessing.
async function processWaitingWhatsapp(s, settings, queueIds) {
  const cs = await C.getCaseState(s.incidentId);
  if (!cs.active) {
    s.status = 'stopped'; s.stopReason = `Case is ${cs.state || 'no longer active'}`;
    event(s, s.stopReason); await log(`Case ${s.caseNumber}: WhatsApp hold stopped - ${s.stopReason}.`, 'removed');
    return;
  }
  const qSet = queueIds[s.queueId || C.CONFIG.queueId];
  if (qSet && !qSet.has(s.incidentId)) {
    s.status = 'removed'; s.stopReason = `Removed from the follow-up queue${s.queueName ? ' "' + s.queueName + '"' : ''}`;
    event(s, s.stopReason); await log(`Case ${s.caseNumber}: WhatsApp hold stopped - removed from queue.`, 'removed');
    return;
  }

  let w;
  if (s.waConversationId) w = await C.getWhatsappWindow(s.waConversationId);
  else w = await C.getCaseWhatsappWindow(s.incidentId);
  const oldMessageAt = s.waLastCustomerMessageAt;
  rememberWhatsappWindow(s, w);
  if (s.waLastCustomerMessageAt && s.waLastCustomerMessageAt !== oldMessageAt) {
    event(s, `Latest customer WhatsApp message updated to ${s.waLastCustomerMessageAt}; 24-hour window ends ${s.waWindowEndsAt}`);
  }
  if (!w || !w.blocked) {
    s.nextDueAt = w && w.windowEndsAt ? Date.parse(w.windowEndsAt) : null;
    s.errorCount = 0; s.lastError = null;
    return;
  }

  s.sender = await C.resolveSender(settings.senderQueue, s.incidentId);
  s.status = 'active';
  s.nextDueAt = Date.now();
  s.errorCount = 0; s.lastError = null;
  event(s, 'WhatsApp 24-hour window has ended (chat greyed out) - normal follow-ups started.');
  await log(`Case ${s.caseNumber}: WhatsApp chat is greyed out - follow-ups started automatically.`, 'new');
}

async function processSequence(s, me, queueIds) {
  const cs = await C.getCaseState(s.incidentId);
  if (!cs.active) {
    if (s.status === 'ready') {            // the case was closed in CDAX - nothing left to watch
      s.watchEnded = true; s.watchEndedAt = new Date().toISOString();
      event(s, `Case is ${cs.state || 'closed'} in CDAX - monitoring for customer replies ended`);
      await log(`Case ${s.caseNumber}: case is ${cs.state || 'closed'} - monitoring for customer replies ended.`, 'removed');
      return;
    }
    s.status = 'stopped'; s.stopReason = `Case is ${cs.state || 'no longer active'}`;
    event(s, s.stopReason); await log(`Case ${s.caseNumber}: sequence stopped - ${s.stopReason}.`, 'removed');
    return;
  }
  // An agent took the case out of the queue while follow-ups were running. (Ready cases are expected to
  // leave the queue - the bot removes them itself - and are watched regardless.)
  const qSet = queueIds[s.queueId || C.CONFIG.queueId];
  if (s.status === 'active' && qSet && !qSet.has(s.incidentId)) {
    s.status = 'removed'; s.stopReason = `Removed from the follow-up queue${s.queueName ? ' "' + s.queueName + '"' : ''}`;
    event(s, s.stopReason); await log(`Case ${s.caseNumber}: sequence stopped - removed from queue.`, 'removed');
    return;
  }

  const firstReal = (s.sent || []).find(r => r.emailId && !r.duplicateSkipped);
  // Also protect zero-send WhatsApp sequences created by v1.10.0 and close the small gap between
  // queue detection and email 1: re-confirm that the composer is greyed out immediately before
  // the first send.
  if (!firstReal && isWhatsappSequence(s)) {
    if (!s.waConversationId) {
      const ch = await C.getCaseChannel(s.incidentId);
      if (ch && ch.isWhatsApp) s.waConversationId = ch.id;
    }
    if (s.waConversationId) {
      const w = await C.getWhatsappWindow(s.waConversationId);
      rememberWhatsappWindow(s, w);
      if (!w.blocked) {
        s.status = 'waactive';
        s.nextDueAt = w.windowEndsAt ? Date.parse(w.windowEndsAt) : null;
        event(s, 'WhatsApp conversation is active immediately before the first send - no follow-up sent; monitoring until the 24-hour window ends.');
        return;
      }
    }
  }
  if (firstReal) {
    const since = new Date(Math.max(Date.parse(firstReal.at), Date.parse(s.createdAt))).toISOString();

    // A reply in the SAME long-running WhatsApp conversation does not create a new conversation
    // record. Detect it from the message-block customer timestamp, without reading message text.
    if (isWhatsappSequence(s)) {
      if (!s.waConversationId) {
        const ch = await C.getCaseChannel(s.incidentId);
        if (ch && ch.isWhatsApp) s.waConversationId = ch.id;
      }
      if (s.waConversationId) {
        const w = await C.getWhatsappWindow(s.waConversationId);
        rememberWhatsappWindow(s, w);
        if (w.lastCustomerMessageAt && Date.parse(w.lastCustomerMessageAt) > Date.parse(since)) {
          await stopForWhatsappResponse(s, w.lastCustomerMessageAt, { id: s.waConversationId });
          return;
        }
      }
    }

    const { reply, ignored } = await C.findCustomerReply(s.incidentId, since);
    for (const ig of ignored) {
      if (!(s.ignoredReplies || []).includes(ig.activityid)) {
        s.ignoredReplies = [...(s.ignoredReplies || []), ig.activityid];
        event(s, `Auto-reply ignored: "${ig.subject}"`);
      }
    }
    if (reply) {
      s.status = 'responded';
      s.response = { at: reply.createdon, subject: reply.subject || '', from: reply.sender || '', emailId: reply.activityid };
      event(s, `Customer responded: "${s.response.subject}" - remaining follow-ups cancelled`);
      markFinished(s);
      await log(`Case ${s.caseNumber}: CUSTOMER RESPONDED - sequence stopped, agent action required.`, 'new');
      notify(`Customer responded - Case ${s.caseNumber}`, `${s.customerName || 'Customer'} replied. Remaining follow-ups cancelled. Agent action required.`);
      return;
    }
    // 2. Customer started a new chat / call after the first follow-up email
    if (!Array.isArray(s.contactIds)) {
      try { s.contactIds = await C.getCaseContactIds(s.incidentId); } catch { s.contactIds = []; }
    }
    const ids = [...new Set([...(s.contactIds || []),
      ...(s.recipient && s.recipient.type === 'contact' && s.recipient.id ? [s.recipient.id] : [])])];
    const hits = await C.findNewContacts(s.incidentId, ids, firstReal.at);
    if (hits.length) {
      const hit = hits.find(h => !h.otherCase) || hits[0];   // prefer a contact on this case
      if (!hit.otherCase && /whatsapp/i.test(hit.channel || '')) await stopForWhatsappResponse(s, hit.at, hit);
      else await stopForNewContact(s, hit);
      return;
    }
  }

  if (s.status === 'ready') return;        // Ready for closure: only watching for a reply, never sends again

  const now = Date.now();
  const prev = (s.sent || [])[s.sent.length - 1];
  const prevPending = prev && prev.emailId && !prev.duplicateSkipped && [1, 6, 7].includes(prev.statuscode);
  if (prevPending) return;

  const max = s.planned || C.CONFIG.maxFollowups;
  if (s.sentCount < max && now >= s.nextDueAt) {
    const n = s.sentCount + 1;
    const existing = await C.findOutgoingFollowup(s.incidentId, n, s.createdAt);
    let rec;
    if (existing) {
      rec = { n, at: existing.createdon, emailId: existing.activityid, duplicateSkipped: true };
      event(s, `Follow-up ${n} was already sent for this sequence ("${existing.subject}") - not sent again`);
    } else {
      let owner = { name: '' };
      try { owner = await C.getCaseOwner(s.incidentId); } catch { /* falls back to HP Support Team */ }
      if (owner.name && owner.name !== s.ownerSignature) {
        if (s.ownerSignature) event(s, `Case owner changed - signature now "${owner.name}"`);
        s.ownerSignature = owner.name;
      }
      const { subject, html } = C.renderTemplateFor(s.templateKind || 'default', n, {
        caseNumber: s.caseNumber, customerName: s.customerName, agentName: owner.name || 'HP Support Team', intervalMs: s.intervalMs
      }, currentTemplates);
      const to = s.recipient;
      if (!s.sender) s.sender = await C.resolveSender(C.DEFAULT_SENDER_QUEUE, s.incidentId);
      const r = await C.sendFollowupEmail({ incidentId: s.incidentId, sender: s.sender, to, subject, html });
      rec = { n, at: new Date().toISOString(), emailId: r.emailId, to: to.email, subject, statuscode: r.statuscode, statusText: r.statusText };
      event(s, `Follow-up ${n}/${C.CONFIG.maxFollowups} created on the case and sent to ${to.email} (CDAX status: ${r.statusText})`);
      await log(`Case ${s.caseNumber}: follow-up ${n}/${C.CONFIG.maxFollowups} sent to ${to.email} - CDAX status ${r.statusText}.`, 'new');
      await documentFollowup(s, rec, n, owner);
    }
    s.sent.push(rec);
    s.sentCount = n;
    s.errorCount = 0; s.lastError = null;
    s.nextDueAt = Date.parse(rec.at) + s.intervalMs;
    if (n >= max) {                         // closing notice sent -> Ready for closure right away
      s.status = 'ready';
      s.readyAt = new Date().toISOString();
      s.closureCheckAt = null;
      s.lastWatchAt = Date.now();             // first re-check for a reply happens after the normal 2-minute interval
      event(s, `Follow-up ${n}/${max} (closing notice) sent - READY FOR CLOSURE. Still watching for a customer reply until the case is closed.`);
      markFinished(s);
      await log(`Case ${s.caseNumber}: closing notice sent - READY FOR CLOSURE (still watching for a reply).`, 'new');
      notify(`Ready for closure - Case ${s.caseNumber}`, 'Both follow-ups were sent with no response. Please review and close the case. The bot keeps watching for a reply until the case is closed.');
    }
  }
}
