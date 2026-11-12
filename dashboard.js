import * as C from './cdax.js';

const $ = (id) => document.getElementById(id);

const state = {
  running: true, busy: false, connected: false, timer: null, nextAt: 0,
  me: null, queueName: '',
  known: null, items: [], newIds: new Set(), lastRefresh: null,
  sequences: {}, settings: { ...C.DEFAULT_SETTINGS }, activity: [], engine: null, history: {},
  dlg: null,      // current manual-start dialog data
  queue: { id: C.CONFIG.queueId, name: C.CONFIG.queueName },
  showLog: false,
  templates: null, templatesMeta: null,
  filter: 'all',
  badgeSeen: {}, badgeLoaded: false, badgeEls: {}
};

const send = (msg) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(msg, (r) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!r || !r.ok) return reject(new Error((r && r.error) || 'Unknown error'));
    resolve(r);
  });
});
const bgLog = (msg, level) => send({ type: 'log', msg, level }).catch(() => {});

/* ================= Storage sync ================= */
async function loadStorage() {
  const s = await chrome.storage.local.get(['sequences', 'settings', 'activity', 'engine', 'monitorQueue', 'showLog', 'templates', 'templatesMeta', 'history', 'badgeSeen']);
  if (!state.badgeLoaded) { state.badgeSeen = s.badgeSeen || {}; state.badgeLoaded = true; }   // kept in memory afterwards
  state.templates = s.templates || null;
  state.templatesMeta = s.templatesMeta || null;
  if (s.monitorQueue && s.monitorQueue.id) state.queue = s.monitorQueue;
  state.showLog = !!s.showLog;
  state.sequences = s.sequences || {};
  state.settings = { ...C.DEFAULT_SETTINGS, ...(s.settings || {}) };
  state.activity = s.activity || [];
  state.engine = s.engine || null;
  state.history = s.history || {};
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  await loadStorage();
  if (changes.settings || changes.templates || changes.templatesMeta) fillSettings();
  render();
  if (changes.history && $('histDlg').open) renderHistory();
});

/* ================= Connect + poll ================= */
async function connect() {
  setConn('connecting', 'Connecting to CDAX...');
  state.me = await C.whoAmI();
  $('userName').textContent = state.me.fullname || state.me.id;
  const q = await C.getQueue(state.queue.id);
  state.queueName = q.name;
  state.queue = { id: q.queueid, name: q.name };
  $('queueName').textContent = q.name;
  $('queueName').title = q.queueid;
  state.connected = true;
  bgLog(`Dashboard connected to CDAX. Monitoring queue "${q.name}".`);
}

async function poll() {
  if (state.busy) return;
  state.busy = true;
  try {
    if (!state.connected) await connect();
    const qid = state.queue.id;
    const items = await C.getQueueItems(qid);
    if (qid !== state.queue.id) return;          // queue was changed while this request was running
    diff(items);
    state.lastRefresh = new Date();
    setConn('on', 'Connected');
    hide('error');
  } catch (e) {
    state.connected = false;
    setConn('off', 'Not connected');
    const msg = e.message === 'NO_TAB'
      ? `No CDAX tab found.\nOpen ${C.CONFIG.orgUrl} in this browser, sign in, and keep that tab open.`
      : e.message;
    $('error').textContent = msg; show('error');
  } finally {
    state.busy = false;
    render();
    schedule();
  }
}

function schedule() {
  clearTimeout(state.timer);
  if (!state.running) return;
  state.nextAt = Date.now() + C.CONFIG.pollMs;
  state.timer = setTimeout(poll, C.CONFIG.pollMs);
}

function diff(items) {
  const current = new Map(items.map(i => [i.id, i]));
  const added = [];
  if (state.known === null) {
    bgLog(`Initial load: ${items.length} item(s) in the queue.`);
  } else {
    for (const [id, i] of current) if (!state.known.has(id)) { state.newIds.add(id); added.push(i); bgLog(`NEW in queue: case ${i.caseNumber || i.type}`, 'new'); }
    for (const [id, i] of state.known) if (!current.has(id)) { state.newIds.delete(id); bgLog(`Removed from queue: case ${i.caseNumber || i.type}`, 'removed'); }
  }
  state.known = current;
  state.items = items;
  if (added.length) {
    if (state.settings.autoStart) send({ type: 'runNow' }).catch(() => {});
    $('banner').textContent = `${added.length} new case(s) added to the queue: ${added.map(i => i.caseNumber).join(', ')}` +
      (state.settings.autoStart ? ' - follow-ups start automatically.' : ' - auto-start is OFF, click "Start" to begin follow-ups.');
    show('banner');
  }
}

/* ================= Rendering ================= */
const STATUS = {
  none: 'Waiting to start', active: 'Follow-up in progress', paused: 'Paused',
  responded: 'Customer responded', ready: 'Ready for closure', stopped: 'Stopped', error: 'Error',
  noemail: 'No email address found', waactive: 'conversation Active', removed: 'Removed from queue'
};
const FILTER_LABEL = {
  all: 'all cases', inqueue: 'cases still in the queue and being followed up', none: 'cases waiting to start', progress: 'follow-ups in progress',
  responded: 'cases where the customer responded', newcontact: 'cases with a new chat or call', done: 'cases with both follow-ups sent', removed: 'cases removed from the queue', ready: 'cases ready for closure',
  noemail: 'cases with no email address', other: 'stopped / error cases'
};
const fmt = (t) => (t ? new Date(t).toLocaleString() : '');
const statusOf = (r) => (r.s ? r.s.status : 'none');
// A case where the customer came back by chat/call after our first follow-up
const hasNC = (s) => !!(s && s.newContact);
const ncLabel = (nc) => (nc && nc.isCall ? 'New call initiated' : 'New chat initiated');
// Status text / CSS class shown for a sequence (or history entry)
const statusText = (s, st) => (hasNC(s) ? ncLabel(s.newContact) :
  (st === 'responded' && s && s.response && s.response.channel === 'whatsapp'
    ? 'customer responded on whats app'
    : (STATUS[st] || st)));
const statusClass = (s, st) => (hasNC(s) ? 'newcontact' : st);

function buildRows() {
  const rows = [];
  const seen = new Set();
  for (const i of state.items) {
    if (!i.isCase) continue;
    seen.add(i.incidentId);
    rows.push({ q: i, s: state.sequences[i.incidentId] || null, inQueue: true });
  }
  for (const s of Object.values(state.sequences)) {
    if ((s.queueId || C.CONFIG.queueId) !== state.queue.id) continue;   // belongs to another queue
    if (!seen.has(s.incidentId)) rows.push({ q: null, s, inQueue: false });
  }
  return rows;
}

const plannedOf = (s) => (s && s.planned) || C.CONFIG.maxFollowups;
// Finished cases are shown only under their own button, not under "In queue"
const isFinished = (r) => ['responded', 'ready', 'stopped', 'removed'].includes(statusOf(r)) || hasNC(r.s);
const FILTERS = {
  all: () => true,
  inqueue: (r) => r.inQueue && !isFinished(r),
  none: (r) => ['none', 'waactive'].includes(statusOf(r)),
  progress: (r) => ['active', 'paused'].includes(statusOf(r)),
  responded: (r) => statusOf(r) === 'responded' || hasNC(r.s),
  newcontact: (r) => hasNC(r.s),
  done: (r) => !!(r.s && statusOf(r) !== 'noemail' && r.s.sentCount >= plannedOf(r.s)),
  removed: (r) => statusOf(r) === 'removed',
  ready: (r) => statusOf(r) === 'ready',
  noemail: (r) => statusOf(r) === 'noemail',
  other: (r) => ['stopped', 'error'].includes(statusOf(r)) && !hasNC(r.s)
};

function render() {
  const rows = buildRows();
  const count = (k) => rows.filter(FILTERS[k]).length;
  $('cAll').textContent = rows.length;
  $('cInQueue').textContent = count('inqueue');
  $('cAwaiting').textContent = count('none');
  $('cProgress').textContent = count('progress');
  $('cResponded').textContent = count('responded');
  $('cNewContact').textContent = count('newcontact');
  $('cDone').textContent = count('done');
  $('cRemoved').textContent = count('removed');
  $('cReady').textContent = count('ready');
  $('cNoEmail').textContent = count('noemail');
  $('cOther').textContent = count('other');
  document.querySelectorAll('.fbtn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
  updateBadges(rows);

  const visible = rows.filter(FILTERS[state.filter] || FILTERS.all);
  $('filterInfo').textContent = state.filter === 'all' ? '' : `Showing ${visible.length} ${FILTER_LABEL[state.filter]} - click the button again to show all.`;

  const tbody = $('rows');
  tbody.textContent = '';
  for (const r of visible) tbody.appendChild(renderRow(r, statusOf(r)));
  $('empty').classList.toggle('hidden', visible.length > 0);
  $('empty').textContent = state.filter === 'all'
    ? 'No cases in the queue yet. Add a case to the queue and it will appear here within 5 seconds.'
    : `No ${FILTER_LABEL[state.filter]}.`;

  $('lastRefresh').textContent = state.lastRefresh ? state.lastRefresh.toLocaleTimeString() : '-';
  const e = state.engine;
  $('engineStatus').textContent = !e ? 'Starting...' :
    e.error ? `On hold - ${e.error}` : `Running (last check ${new Date(e.lastRun).toLocaleTimeString()}, ${e.activeCount} active${e.watching ? `, ${e.watching} watching for replies` : ''})`;

  const attention = rows.filter(r => ['responded', 'ready'].includes(statusOf(r)) || hasNC(r.s)).length + state.newIds.size;
  document.title = attention ? `(${attention}) CDAX Follow-up Bot` : 'CDAX Follow-up Bot';

  renderLog();
}

function renderRow(r, st) {
  const q = r.q, s = r.s;
  const caseNumber = (q && q.caseNumber) || (s && s.caseNumber) || '(no case number)';
  const incidentId = (q && q.incidentId) || s.incidentId;
  const tr = document.createElement('tr');
  if (q && state.newIds.has(q.id)) tr.classList.add('isnew');
  tr.classList.add(`st-${statusClass(s, st)}`);
  if (!r.inQueue) tr.classList.add('gone');

  const b = document.createElement('td');
  if (q && state.newIds.has(q.id)) b.appendChild(el('span', 'badge', 'NEW'));
  tr.appendChild(b);

  const cn = document.createElement('td'); cn.className = 'casenum';
  const a = document.createElement('a');
  a.href = `${C.CONFIG.orgUrl}/main.aspx?pagetype=entityrecord&etn=incident&id=${incidentId}`;
  a.target = '_blank'; a.rel = 'noopener'; a.textContent = caseNumber;
  cn.appendChild(a);
  if (!r.inQueue) cn.appendChild(el('span', 'sub', s && s.queueRemoval && s.queueRemoval.done ? 'Removed from queue by the bot' : 'Not in queue'));
  tr.appendChild(cn);

  tr.appendChild(td((q && q.customer) || (s && s.customerName)));
  tr.appendChild(td(q ? q.status : ''));
  tr.appendChild(td((q && q.owner) || (s && s.owner)));
  tr.appendChild(td(q ? fmt(q.enteredOn) : ''));

  const tp = document.createElement('td');
  if (s && st !== 'noemail') { tp.appendChild(el('span', 'tplname', s.templateName)); if (s.auto) tp.appendChild(el('span', 'sub', 'Auto-started')); }
  else if (s) tp.textContent = '-';
  else tp.textContent = state.templates ? 'Custom templates' : 'Default templates';
  tr.appendChild(tp);

  const fu = document.createElement('td');
  if (s && st !== 'noemail') {
    const dots = el('span', 'dots');
    const pl = plannedOf(s);
    for (let n = 1; n <= pl; n++) dots.appendChild(el('span', n <= s.sentCount ? 'done' : ''));
    fu.appendChild(dots);
    fu.appendChild(document.createTextNode(` ${s.sentCount}/${pl}`));
  } else fu.textContent = '-';
  tr.appendChild(fu);

  tr.appendChild(nextStepCell(s, st));

  const stc = document.createElement('td');
  stc.appendChild(el('span', `status s-${statusClass(s, st)}`, statusText(s, st)));
  if (s && s.queueRemoval && !s.queueRemoval.done && s.queueRemoval.pending) stc.appendChild(el('span', 'sub', 'Removing from the queue...'));
  if (s && s.queueRemoval && !s.queueRemoval.done && !s.queueRemoval.pending && s.queueRemoval.error)
    stc.appendChild(el('span', 'sub', `Could not remove from the queue - remove it manually. ${s.queueRemoval.error.slice(0, 100)}`));
  if (s && s.queueRemoval && s.queueRemoval.done && s.queueRemoval.removed) stc.appendChild(el('span', 'sub', `Removed from the queue ${fmt(s.queueRemoval.at)}`));
  if (s && st === 'waactive') {
    stc.appendChild(el('span', 'sub', s.waLastCustomerMessageAt
      ? `Last customer WhatsApp message: ${fmt(s.waLastCustomerMessageAt)}`
      : 'Customer-message time not available yet; no email will be sent'));
  }
  if (s && !['noemail', 'waactive'].includes(st)) stc.appendChild(el('span', 'sub', `Every ${C.formatDuration(s.intervalMs)}`));
  const last = s && s.sent && s.sent[s.sent.length - 1];
  if (s && s.lastError && /Pending Send|Sending/.test(s.lastError)) stc.appendChild(el('span', 'sub', 'On hold: email not delivered by CDAX'));
  if (last && last.duplicateSkipped) stc.appendChild(el('span', 'sub', `Email ${last.n}: already on the case, not re-sent`));
  else if (last && last.statusText) stc.appendChild(el('span', 'sub', `Email ${last.n}: ${last.statusText}`));
  if (s && s.lastError && st !== 'error') stc.appendChild(el('span', 'sub', `Retrying: ${s.lastError.slice(0, 120)}`));
  if (s && st === 'error') stc.appendChild(el('span', 'sub', s.lastError || ''));
  if (s && (st === 'stopped' || st === 'removed')) stc.appendChild(el('span', 'sub', s.stopReason || ''));
  tr.appendChild(stc);

  const ac = document.createElement('td');
  const btn = (text, fn, cls) => { const x = el('button', `small ${cls || ''}`, text); x.type = 'button'; x.addEventListener('click', fn); ac.appendChild(x); };
  const act = (type) => () => send({ type, incidentId }).catch(e => alert(e.message));
  if (st === 'none') {
    if (!q || !q.caseActive) ac.appendChild(el('span', 'sub', 'Case not active'));
    else if (state.settings.autoStart) ac.appendChild(el('span', 'sub', 'Starting automatically...'));
    else btn('Start', () => openSetup(q), 'primary');
  }
  if (st === 'active') { btn('Pause', act('pause')); btn('Stop', confirmAct('stop', incidentId, caseNumber), 'danger'); }
  if (st === 'paused') { btn('Resume', act('resume'), 'primary'); btn('Stop', confirmAct('stop', incidentId, caseNumber), 'danger'); }
  if (st === 'waactive' && r.inQueue) btn('Remove from queue', confirmAct('removeFromQueue', incidentId, caseNumber), 'danger');
  if (['responded', 'ready', 'stopped', 'removed', 'error', 'noemail'].includes(st)) btn('Clear', confirmAct('dismiss', incidentId, caseNumber));
  if (s) btn('Timeline', () => openTimeline(s));
  tr.appendChild(ac);
  return tr;
}

function confirmAct(type, incidentId, caseNumber) {
  const text = type === 'stop'
    ? `Stop the follow-up sequence for case ${caseNumber}? No more emails will be sent.`
    : type === 'removeFromQueue'
      ? `Remove case ${caseNumber} from the follow-up queue? The case itself is not deleted, and no follow-up email will be sent.`
      : `Clear case ${caseNumber} from the dashboard? It stays in History. It will only start again if it is removed and added to the queue again.`;
  return () => { if (confirm(text)) send({ type, incidentId }).catch(e => alert(e.message)); };
}

function nextStepCell(s, st) {
  const c = document.createElement('td');
  if (!s) { c.textContent = state.settings.autoStart ? 'Starting automatically (within 30 s)' : 'Auto-start is off - click Start'; return c; }
  const max = plannedOf(s);
  if (st === 'noemail') {
    c.textContent = 'Add the email in CDAX, then remove and re-add the case to the queue';
    return c;
  }
  if (st === 'waactive') {
    c.textContent = s.waWindowEndsAt
      ? `Re-checking; follow-ups start after ${fmt(s.waWindowEndsAt)} if the customer does not write again`
      : 'Re-checking the WhatsApp 24-hour window; no follow-up will be sent until it is confirmed closed';
    return c;
  }
  if (st === 'active' || st === 'paused') {
    if (s.sentCount < max) {
      const prev = s.sent && s.sent[s.sent.length - 1];
      if (prev && [1, 6, 7].includes(prev.statuscode)) c.textContent = `Waiting for CDAX to deliver follow-up ${prev.n}`;
      else c.textContent = Date.now() >= s.nextDueAt ? `Sending follow-up ${s.sentCount + 1}...` : `Follow-up ${s.sentCount + 1} at ${fmt(s.nextDueAt)}`;
    } else {
      c.textContent = 'Finishing...';
    }
    if (st === 'paused') c.appendChild(el('span', 'sub', 'Paused - nothing will be sent'));
  } else if (hasNC(s)) {
    c.textContent = 'Agent action required';
    c.appendChild(el('span', 'sub', `${s.newContact.channel}${s.newContact.agent ? ' - ' + C.displayName(s.newContact.agent) : ''}${s.newContact.queue ? ' - ' + s.newContact.queue : ''}`));
  } else if (st === 'responded') {
    c.textContent = 'Agent action required';
    c.appendChild(el('span', 'sub', `Reply ${fmt(s.response && s.response.at)}: ${(s.response && s.response.subject) || ''}`));
  } else if (st === 'ready') {
    c.textContent = 'Review and close the case';
    c.appendChild(el('span', 'sub', `Ready since ${fmt(s.readyAt)}`));
    c.appendChild(el('span', 'sub', s.watchEnded ? 'Case closed in CDAX - monitoring ended' : 'Still watching for a customer reply until the case is closed'));
  } else if (st === 'removed') {
    c.textContent = 'Removed from the queue - follow-ups stopped';
  } else c.textContent = '-';
  return c;
}

function applyLogVisibility() {
  $('logSection').classList.toggle('hidden', !state.showLog);
  $('btnLog').textContent = state.showLog ? 'Hide activity log' : 'Show activity log';
  $('btnLog').setAttribute('aria-expanded', String(state.showLog));
}

function renderLog() {
  if (!state.showLog) return;
  const ul = $('log');
  ul.textContent = '';
  for (const a of state.activity.slice(0, 200)) {
    const li = el('li', a.level === 'info' ? '' : a.level, `[${new Date(a.at).toLocaleString()}] ${a.msg}`);
    ul.appendChild(li);
  }
}

/* ================= Number badges on the status buttons ================= */
// A red number on a button = cases that joined that group since you last looked at it.
// Clicking the button (or having it open while this page is visible) marks them as seen.
const BADGE_KEYS = ['inqueue', 'none', 'progress', 'responded', 'newcontact', 'done', 'ready', 'noemail', 'removed', 'other'];
const rowKey = (r) => (r.s ? `${r.s.incidentId}|${r.s.createdAt}` : `${r.q.incidentId}|${r.q.id}`);

function updateBadges(rows) {
  if (!state.lastRefresh) return;                         // wait for the first successful queue read
  const store = state.badgeSeen[state.queue.id] || (state.badgeSeen[state.queue.id] = {});
  let changed = false;
  for (const k of BADGE_KEYS) {
    const keys = rows.filter(FILTERS[k]).map(rowKey);
    if (!Array.isArray(store[k])) { store[k] = keys; changed = true; }          // first time: nothing counts as new
    const seen = new Set(store[k]);
    if (state.filter === k && !document.hidden && (keys.length !== seen.size || keys.some(x => !seen.has(x)))) {
      store[k] = keys; changed = true;                                          // you are looking at it
      seen.clear(); keys.forEach(x => seen.add(x));
    }
    const fresh = keys.filter(x => !seen.has(x)).length;
    const nb = state.badgeEls[k];
    if (nb) {
      nb.textContent = fresh > 99 ? '99+' : String(fresh);
      nb.classList.toggle('hidden', fresh === 0);
      nb.title = `${fresh} new since you last looked`;
    }
  }
  if (changed) chrome.storage.local.set({ badgeSeen: state.badgeSeen });
}

/* ================= History ================= */
function historyList() {
  return Object.values(state.history).sort((a, b) => Date.parse(b.addedAt || 0) - Date.parse(a.addedAt || 0));
}

function lastAction(h) {
  const t = h.timeline && h.timeline[h.timeline.length - 1];
  if (h.clearedAt) return { at: h.clearedAt, text: `Cleared by ${h.clearedBy || 'agent'}` };
  return t ? { at: t.at, text: t.text } : { at: h.updatedAt, text: '-' };
}

function histMatches(h, text, f) {
  if (text) {
    const hay = [h.caseNumber, h.customerName, h.customerEmail, h.owner, h.queueName].join(' ').toLowerCase();
    if (!hay.includes(text)) return false;
  }
  switch (f) {
    case 'responded': return h.status === 'responded' || !!h.newContact;
    case 'newcontact': return !!h.newContact;
    case 'noresponse': return h.status !== 'responded' && !h.newContact && h.status !== 'noemail' && (h.sentCount || 0) > 0;
    case 'ready': return h.status === 'ready';
    case 'active': return ['active', 'paused', 'waactive'].includes(h.status);
    case 'noemail': return h.status === 'noemail';
    case 'removed': return h.status === 'removed';
    case 'stopped': return ['stopped', 'error'].includes(h.status) && !h.newContact;
    default: return true;
  }
}

function filteredHistory() {
  const text = $('histSearch').value.trim().toLowerCase();
  const f = $('histFilter').value;
  return historyList().filter(h => histMatches(h, text, f));
}

function renderHistory() {
  const all = historyList();
  const list = filteredHistory();
  const responded = all.filter(h => h.status === 'responded' || h.newContact).length;
  const emails = all.reduce((n, h) => n + (h.sentCount || 0), 0);
  $('histSummary').textContent = `${all.length} case(s) in history - ${emails} follow-up email(s) sent - ${responded} customer response(s). Showing ${list.length}.`;
  const tbody = $('histRows');
  tbody.textContent = '';
  for (const h of list) {
    const tr = document.createElement('tr');
    const cn = document.createElement('td'); cn.className = 'casenum';
    const a = document.createElement('a');
    a.href = `${C.CONFIG.orgUrl}/main.aspx?pagetype=entityrecord&etn=incident&id=${h.incidentId}`;
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = h.caseNumber || '-';
    cn.appendChild(a); tr.appendChild(cn);
    tr.appendChild(td(h.customerName));
    tr.appendChild(td(h.owner));
    tr.appendChild(td(h.queueName));
    tr.appendChild(td(fmt(h.addedAt)));
    const fu = document.createElement('td');
    fu.textContent = h.status === 'noemail' ? '-' : `${h.sentCount || 0}/${h.planned || 3}`;
    for (const s of h.sentDates || []) fu.appendChild(el('span', 'sub', `#${s.n}: ${fmt(s.at)}${s.status ? ' (' + s.status + ')' : ''}`));
    tr.appendChild(fu);
    const rs = document.createElement('td');
    if (h.status === 'responded') {
      rs.appendChild(el('span', 'yes', h.response && h.response.channel === 'whatsapp' ? 'Yes - WhatsApp' : 'Yes'));
      if (h.response) rs.appendChild(el('span', 'sub', fmt(h.response.at)));
    } else if (h.newContact) {
      rs.appendChild(el('span', 'yes', h.newContact.isCall ? 'Yes - new call' : 'Yes - new chat'));
      rs.appendChild(el('span', 'sub', `${fmt(h.newContact.at)} - ${h.newContact.channel}${h.newContact.agent ? ' - ' + C.displayName(h.newContact.agent) : ''}${h.newContact.queue ? ' - ' + h.newContact.queue : ''}`));
    } else rs.appendChild(el('span', 'no', 'No'));
    tr.appendChild(rs);
    const st = document.createElement('td');
    st.appendChild(el('span', `status s-${h.newContact ? 'newcontact' : h.status}`, h.newContact ? ncLabel(h.newContact) : statusText(h, h.status)));
    if (h.queueRemoved && h.queueRemoved.removed) st.appendChild(el('span', 'sub', `Removed from queue ${fmt(h.queueRemoved.at)}`));
    if (h.stopReason) st.appendChild(el('span', 'sub', h.stopReason));
    if (h.clearedAt) st.appendChild(el('span', 'sub', `Cleared ${fmt(h.clearedAt)}`));
    tr.appendChild(st);
    const la = lastAction(h);
    const lat = document.createElement('td');
    lat.appendChild(el('span', 'sub', fmt(la.at)));
    lat.appendChild(el('span', 'sub', la.text));
    tr.appendChild(lat);
    const ac = document.createElement('td');
    const tb = el('button', 'small', 'Timeline'); tb.type = 'button';
    tb.addEventListener('click', () => openTimeline({ caseNumber: h.caseNumber, timeline: h.timeline || [], createdAt: h.addedAt,
      recipient: { email: h.customerEmail }, intervalMs: h.intervalMs, sent: [], status: h.status }));
    ac.appendChild(tb);
    tr.appendChild(ac);
    tbody.appendChild(tr);
  }
  $('histEmpty').classList.toggle('hidden', list.length > 0);
}

function openHistory() {
  renderHistory();
  $('histDlg').showModal();
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function exportHistoryCsv() {
  const head = ['Case number', 'Customer', 'Customer email', 'Owner', 'Queue', 'Added', 'Started by', 'Follow-ups sent',
                'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Customer responded', 'Response date', 'Final status',
                'New chat/call', 'New chat/call on', 'New chat/call agent', 'New chat/call queue', 'Removed from queue on',
                'Stop reason', 'Ready for closure on', 'Cleared by', 'Cleared on', 'Last action'];
  const lines = [head.join(',')];
  for (const h of filteredHistory()) {
    const d = (n) => { const x = (h.sentDates || []).find(s => s.n === n); return x ? fmt(x.at) : ''; };
    const la = lastAction(h);
    lines.push([h.caseNumber, h.customerName, h.customerEmail, h.owner, h.queueName, fmt(h.addedAt), h.startedBy,
      h.sentCount || 0, d(1), d(2), d(3), h.status === 'responded' ? 'Yes' : 'No', h.response ? fmt(h.response.at) : '',
      h.newContact ? ncLabel(h.newContact) : statusText(h, h.status),
      h.newContact ? h.newContact.channel : '', h.newContact ? fmt(h.newContact.at) : '',
      h.newContact ? C.displayName(h.newContact.agent) : '', h.newContact ? h.newContact.queue : '',
      h.queueRemoved ? fmt(h.queueRemoved.at) : '',
      h.stopReason || '', fmt(h.readyAt), h.clearedBy || '', fmt(h.clearedAt), la.text].map(csvCell).join(','));
  }
  download(`cdax-followup-history-${stamp()}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv');
}

/* ================= Backup / restore ================= */
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportBackup() {
  const data = await chrome.storage.local.get(null);
  data.backupInfo = { app: 'CDAX Follow-up Bot', version: chrome.runtime.getManifest().version, createdAt: new Date().toISOString() };
  download(`cdax-followup-backup-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
  bgLog('Backup exported.');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const n = data && data.sequences ? Object.keys(data.sequences).length : 0;
    if (!data || !data.sequences) throw new Error('This file is not a CDAX Follow-up Bot backup.');
    const when = data.backupInfo ? ` from ${fmt(data.backupInfo.createdAt)}` : '';
    if (!confirm(`Restore the backup${when}?\n\n${n} case(s) will be restored and REPLACE the current data on this computer.`)) return;
    await send({ type: 'importBackup', data });
    alert('Backup restored.');
  } catch (e) { alert(`Could not restore the backup: ${e.message}`); }
  finally { $('restoreFile').value = ''; }
}

/* ================= Manual start dialog (auto-start OFF only) ================= */
async function openSetup(q) {
  const dlg = $('setupDlg');
  state.dlg = { q, details: null, tab: 1 };
  $('dlgCase').textContent = q.caseNumber;
  $('dlgTplName').textContent = state.templates ? 'Custom templates' : 'Default templates';
  $('dlgInterval').textContent = C.formatDuration(state.settings.intervalMs);
  show('dlgLoading'); hide('dlgBody'); hide('dlgError');
  $('dlgConfirm').disabled = true;
  $('dlgConfirm').textContent = 'Confirm & start follow-ups';
  dlg.showModal();
  try {
    const d = await C.getIncidentDetails(q.incidentId);
    state.dlg.details = d;
    const sel = $('dlgRecipientSel');
    sel.textContent = '';
    d.recipients.forEach((r, idx) => {
      const o = document.createElement('option');
      o.value = String(idx); o.textContent = `${r.label}: ${r.name} <${r.email}>`;
      sel.appendChild(o);
    });
    $('dlgOwner').value = d.owner || q.owner || '';
    state.dlg.kind = 'default';
    C.getCaseChannel(q.incidentId).then(async ch => {          // WhatsApp / no chat -> standard emails; other channels -> chat email
      if (!state.dlg || state.dlg.q !== q) return;
      state.dlg.kind = C.templateKindFor(ch);
      $('dlgTplName').textContent = state.dlg.kind === 'chat' ? `${C.CHAT_TEMPLATE_NAME} (${ch.channel})` : (state.templates ? 'Custom templates' : 'Default templates');
      if (ch && ch.isWhatsApp) {
        const w = await C.getCaseWhatsappWindow(q.incidentId, ch);
        if (!state.dlg || state.dlg.q !== q) return;
        state.dlg.waWindow = w;
        if (!w.blocked) {
          $('dlgModeNote').textContent = w.lastCustomerMessageAt
            ? `The WhatsApp conversation is active until ${fmt(w.windowEndsAt)}. Confirming will monitor it, but no email will be sent until the 24-hour window ends.`
            : 'The WhatsApp customer-message time is not available yet. Confirming will monitor it, but no email will be sent until the 24-hour window is confirmed closed.';
          $('dlgConfirm').textContent = 'Confirm & monitor';
        }
      }
      updatePreview();
    }).catch(() => {});
    hide('dlgLoading'); show('dlgBody');
    if (!d.recipients.length) {
      $('dlgError').textContent = 'No email address found on this case. Add the customer email in CDAX first.';
      show('dlgError');
      return;
    }
    applyRecipient();
    state.dlg.ownerName = '';
    C.getCaseOwner(q.incidentId)
      .then(o => { if (state.dlg && state.dlg.q === q) { state.dlg.ownerName = o.name; updatePreview(); } })
      .catch(() => {});
    const note = $('dlgModeNote');
    note.className = 'modenote live';
    note.textContent = `These ${C.CONFIG.maxFollowups} emails will be sent to the customer and logged on the case, ${C.formatDuration(state.settings.intervalMs)} apart. Email 1 is sent immediately after you confirm.`;
    $('dlgSender').textContent = 'Resolving sender mailbox...';
    send({ type: 'resolveSender', incidentId: q.incidentId })
      .then(r => { $('dlgSender').textContent = `From: ${r.sender.name}${r.sender.email ? ' <' + r.sender.email + '>' : ''} (${r.sender.source})`; })
      .catch(e => { $('dlgSender').textContent = `Sender problem: ${e.message}`; });
    setTab(1);
    validateDlg();
  } catch (e) {
    hide('dlgLoading');
    $('dlgError').textContent = `Could not load case details: ${e.message}`;
    show('dlgBody'); show('dlgError');
  }
}

function applyRecipient() {
  const d = state.dlg.details;
  const r = d.recipients[Number($('dlgRecipientSel').value)] || d.recipients[0];
  $('dlgEmail').value = r ? r.email : '';
  $('dlgName').value = r ? (r.firstname || r.name || d.customerName || '') : (d.customerName || '');
  updatePreview(); validateDlg();
}

function currentRecipient() {
  const d = state.dlg.details;
  const r = d.recipients[Number($('dlgRecipientSel').value)] || d.recipients[0];
  return { type: r.type, id: r.id, email: r.email };
}

function validateDlg() {
  if (!state.dlg || !state.dlg.details || !state.dlg.details.recipients.length) return;
  const problems = [];
  if (!$('dlgName').value.trim()) problems.push('Enter the customer name for the greeting.');
  if (!state.dlg.details.active) problems.push('This case is not active.');
  const err = $('dlgError');
  if (problems.length) { err.textContent = problems.join('\n'); show('dlgError'); } else hide('dlgError');
  $('dlgConfirm').disabled = problems.length > 0;
}

function setTab(n) {
  state.dlg.tab = n;
  document.querySelectorAll('#setupDlg .previewtabs .tab').forEach(t => t.classList.toggle('active', Number(t.dataset.n) === n));
  updatePreview();
}

function updatePreview() {
  if (!state.dlg || !state.dlg.details || !state.dlg.details.recipients.length) return;
  const { subject, html } = C.renderTemplateFor(state.dlg.kind || 'default', state.dlg.tab, {
    caseNumber: state.dlg.q.caseNumber,
    customerName: $('dlgName').value.trim(),
    agentName: state.dlg.ownerName || 'HP Support Team',
    intervalMs: state.settings.intervalMs
  }, state.templates);
  $('pSubject').textContent = subject;
  $('pBody').innerHTML = html;   // template HTML is ours; all variables are HTML-escaped in renderTemplate
}

async function confirmSetup() {
  const d = state.dlg.details, q = state.dlg.q;
  $('dlgConfirm').disabled = true;
  try {
    await send({
      type: 'startSequence',
      data: {
        incidentId: d.incidentId,
        queueId: state.queue.id,
        queueName: state.queue.name,
        queueItemId: q.id,
        caseNumber: q.caseNumber || d.caseNumber,
        crmNumber: d.crmNumber,
        customerName: $('dlgName').value.trim(),
        recipient: currentRecipient(),
        owner: d.owner || q.owner
      }
    });
    state.newIds.delete(q.id);
    $('setupDlg').close();
  } catch (e) {
    $('dlgError').textContent = e.message; show('dlgError');
    $('dlgConfirm').disabled = false;
  }
}

/* ================= Timeline dialog ================= */
function openTimeline(s) {
  $('tlCase').textContent = s.caseNumber;
  const ul = $('tlList');
  ul.textContent = '';
  const first = s.status === 'noemail'
    ? { at: s.createdAt, text: 'Added to the queue - no email address found' }
    : { at: s.createdAt, text: `Sequence created (to ${(s.recipient && s.recipient.email) || '-'}, every ${C.formatDuration(s.intervalMs || 0)})` };
  const items = [first, ...(s.timeline || [])];
  const seen = new Set();
  for (const t of items) {
    const key = t.at + t.text; if (seen.has(key)) continue; seen.add(key);
    const li = document.createElement('li');
    li.appendChild(el('time', '', fmt(t.at)));
    li.appendChild(document.createTextNode(t.text));
    ul.appendChild(li);
  }
  for (const rec of s.sent || []) {
    if (!rec.emailId) continue;
    const li = document.createElement('li');
    li.appendChild(el('time', '', fmt(rec.at)));
    const link = document.createElement('a');
    link.href = C.emailUrl(rec.emailId); link.target = '_blank'; link.rel = 'noopener';
    link.textContent = `Open follow-up ${rec.n} email in CDAX (${rec.statusText || 'status unknown'})`;
    li.appendChild(link);
    ul.appendChild(li);
  }
  if (s.status === 'waactive') {
    const li = document.createElement('li');
    li.appendChild(el('time', '', fmt(s.waWindowEndsAt)));
    li.appendChild(document.createTextNode(s.waWindowEndsAt
      ? '(monitoring) Re-check WhatsApp; start only after the 24-hour window ends'
      : '(monitoring) Waiting for a customer-message timestamp; no email will be sent'));
    ul.appendChild(li);
  } else if (s.status === 'active' && s.sentCount < plannedOf(s)) {
    const li = document.createElement('li');
    li.appendChild(el('time', '', fmt(s.nextDueAt)));
    li.appendChild(document.createTextNode(`(scheduled) Follow-up ${s.sentCount + 1}`));
    ul.appendChild(li);
  } else if (s.status === 'ready') {
    const li = document.createElement('li');
    li.appendChild(el('time', '', fmt(s.watchEnded ? s.watchEndedAt : s.readyAt)));
    li.appendChild(document.createTextNode(s.watchEnded
      ? '(monitoring ended) The case was closed in CDAX'
      : '(monitoring) Watching for a customer reply, chat or call until the case is closed in CDAX'));
    ul.appendChild(li);
  }
  $('tlDlg').showModal();
}

/* ================= Settings ================= */
function fillSettings() {
  $('setAuto').checked = !!state.settings.autoStart;
  $('setRemove').checked = !!state.settings.removeFromQueue;
  $('tplState').textContent = state.templates
    ? `Custom templates in use${state.templatesMeta ? ` (updated ${fmt(state.templatesMeta.updatedAt)} by ${state.templatesMeta.by || 'agent'})` : ''}`
    : 'Default templates in use';
  $('setSender').value = state.settings.senderQueue || C.DEFAULT_SENDER_QUEUE;
  $('setInterval').value = String(state.settings.intervalMs);
  if (!$('setInterval').value) $('setInterval').value = String(C.DEFAULT_SETTINGS.intervalMs);
}

async function saveSettings() {
  const intervalMs = Number($('setInterval').value) || C.DEFAULT_SETTINGS.intervalMs;
  try {
    const senderQueue = $('setSender').value.trim() || C.DEFAULT_SENDER_QUEUE;
    const r = await send({ type: 'saveSettings', settings: { intervalMs, senderQueue } });
    alert(`Saved. Follow-ups will be sent from: ${r.sender.name}${r.sender.email ? ' <' + r.sender.email + '>' : ''}`);
  } catch (e) { alert(e.message); }
}

/* ================= Template editor ================= */
let tplDraft = null, tplTab = 1;

function openTemplates() {
  tplDraft = JSON.parse(JSON.stringify(C.effectiveSteps(state.templates)));
  tplTab = 1;
  hide('tplError');
  loadTplFields();
  $('tplDlg').showModal();
}

function loadTplFields() {
  const t = tplDraft[tplTab - 1];
  $('tplSubject').value = t.subject || '';
  $('tplBody').value = (t.body || []).join('\n\n');
  $('tplClosing').value = t.closing || '';
  document.querySelectorAll('.tpltab').forEach(b => b.classList.toggle('active', Number(b.dataset.t) === tplTab));
  previewTpl();
}

function storeTplFields() {
  const t = tplDraft[tplTab - 1];
  t.subject = $('tplSubject').value.trim();
  t.body = $('tplBody').value.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  t.closing = $('tplClosing').value.trim() || 'Kind regards,';
}

function previewTpl() {
  storeTplFields();
  const { subject, html } = C.renderTemplate(tplTab, {
    caseNumber: '5166598789', customerName: 'John',
    agentName: (state.me && C.displayName(state.me.fullname)) || 'Case Owner',
    intervalMs: state.settings.intervalMs
  }, tplDraft);
  $('tplPSubject').textContent = subject;
  $('tplPBody').innerHTML = html;   // template text is HTML-escaped in renderTemplate
}

async function saveTemplates() {
  storeTplFields();
  const problems = C.validateSteps(tplDraft);
  if (problems.length) { $('tplError').textContent = problems.join('\n'); show('tplError'); return; }
  const by = (state.me && C.displayName(state.me.fullname)) || 'agent';
  await chrome.storage.local.set({ templates: tplDraft, templatesMeta: { updatedAt: new Date().toISOString(), by } });
  bgLog(`Email templates updated by ${by}. Used for all follow-ups from now on (including running sequences).`);
  $('tplDlg').close();
}

async function resetTemplates() {
  if (!confirm('Reset both emails to the default templates?')) return;
  await chrome.storage.local.remove(['templates', 'templatesMeta']);
  bgLog('Email templates reset to the defaults.');
  $('tplDlg').close();
}

/* ================= Queue picker ================= */
function openQueuePicker() {
  $('qdSearch').value = '';
  $('queueDlg').showModal();
  $('qdSearch').focus();
  loadQueueList();
}

let qReq = 0;
async function loadQueueList() {
  const my = ++qReq;
  const text = $('qdSearch').value;
  $('qdStatus').textContent = 'Searching...';
  try {
    const list = await C.searchQueues(text);
    if (my !== qReq) return;
    const ul = $('qdList');
    ul.textContent = '';
    for (const qu of list) {
      const li = document.createElement('li');
      const b = el('button', qu.id === state.queue.id ? 'current' : '', qu.name);
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(qu.id === state.queue.id));
      b.addEventListener('click', () => selectQueue(qu));
      li.appendChild(b); ul.appendChild(li);
    }
    $('qdStatus').textContent = list.length
      ? `${list.length} queue(s)${list.length === 50 ? ' - showing the first 50, type more of the name to narrow down' : ''}`
      : 'No queues match.';
  } catch (e) {
    if (my === qReq) $('qdStatus').textContent = e.message === 'NO_TAB' ? 'Open CDAX in a tab first.' : e.message;
  }
}

async function selectQueue(qu) {
  $('queueDlg').close();
  if (qu.id === state.queue.id) return;
  state.queue = { id: qu.id, name: qu.name };
  state.known = null; state.items = []; state.newIds.clear();
  hide('banner');
  $('queueName').textContent = qu.name;
  await chrome.storage.local.set({ monitorQueue: state.queue });
  bgLog(`Monitoring queue changed to "${qu.name}".`);
  render();
  clearTimeout(state.timer);
  state.connected = false;          // re-validate the queue on the next poll
  poll();
}

/* ================= Helpers ================= */
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function td(text) { return el('td', '', text || '-'); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setConn(cls, text) { $('connDot').className = `dot ${cls}`; $('connText').textContent = text; }

function tick() {
  if (!state.running) $('nextRefresh').textContent = '(refresh paused)';
  else if (state.busy) $('nextRefresh').textContent = '(refreshing...)';
  else $('nextRefresh').textContent = `(next in ${Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000))}s)`;
}

/* ================= Init ================= */
async function init() {
  $('appVersion').textContent = `v${chrome.runtime.getManifest().version}`;
  for (const i of C.INTERVALS) {
    const o = document.createElement('option'); o.value = String(i.ms); o.textContent = i.label; $('setInterval').appendChild(o);
  }
  await loadStorage();
  fillSettings();

  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('setAuto').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (!on && !confirm('Turn OFF auto-start? New cases in the queue will wait until an agent clicks Start.')) { e.target.checked = true; return; }
    try { await send({ type: 'setAutoStart', value: on }); } catch (err) { alert(err.message); e.target.checked = !on; }
  });
  $('setRemove').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && !confirm('Remove finished cases from the queue?\n\nWhen a customer replies, starts a new chat/call, or both follow-ups are sent (Ready for closure), the bot removes that case from its queue in CDAX. The case stays on this dashboard.')) { e.target.checked = false; return; }
    try { await send({ type: 'setRemoveFromQueue', value: on }); } catch (err) { alert(err.message); e.target.checked = !on; }
  });
  $('btnTemplates').addEventListener('click', openTemplates);
  document.querySelectorAll('.tpltab').forEach(b => b.addEventListener('click', () => { storeTplFields(); tplTab = Number(b.dataset.t); loadTplFields(); }));
  ['tplSubject', 'tplBody', 'tplClosing'].forEach(id => $(id).addEventListener('input', previewTpl));
  $('tplSave').addEventListener('click', () => saveTemplates().catch(e => { $('tplError').textContent = e.message; show('tplError'); }));
  $('tplCancel').addEventListener('click', () => $('tplDlg').close());
  $('tplReset').addEventListener('click', () => resetTemplates().catch(e => alert(e.message)));

  document.querySelectorAll('.fbtn').forEach(b => {
    const f = b.dataset.filter;
    if (f === 'all') return;
    const nb = el('span', 'nbadge hidden');
    nb.setAttribute('role', 'status');
    b.appendChild(nb);
    state.badgeEls[f] = nb;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

  // Status buttons: click to filter, click the active one again to show all
  document.querySelectorAll('.fbtn').forEach(b => b.addEventListener('click', () => {
    const f = b.dataset.filter;
    state.filter = (state.filter === f && f !== 'all') ? 'all' : f;
    render();
  }));

  $('btnHistory').addEventListener('click', openHistory);
  $('histClose').addEventListener('click', () => $('histDlg').close());
  $('histSearch').addEventListener('input', renderHistory);
  $('histFilter').addEventListener('change', renderHistory);
  $('histCsv').addEventListener('click', exportHistoryCsv);

  $('btnBackup').addEventListener('click', () => exportBackup().catch(e => alert(e.message)));
  $('btnRestore').addEventListener('click', () => $('restoreFile').click());
  $('restoreFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importBackup(f); });

  $('btnToggle').addEventListener('click', () => {
    state.running = !state.running;
    $('btnToggle').textContent = state.running ? 'Pause refresh' : 'Resume refresh';
    if (state.running) poll(); else clearTimeout(state.timer);
  });
  $('btnRefresh').addEventListener('click', () => { clearTimeout(state.timer); poll(); send({ type: 'runNow' }).catch(() => {}); });
  $('btnAck').addEventListener('click', () => { state.newIds.clear(); hide('banner'); render(); });
  $('btnLog').addEventListener('click', async () => {
    state.showLog = !state.showLog;
    applyLogVisibility();
    renderLog();
    await chrome.storage.local.set({ showLog: state.showLog });
  });
  applyLogVisibility();
  $('btnChangeQueue').addEventListener('click', openQueuePicker);
  $('qdClose').addEventListener('click', () => $('queueDlg').close());
  let qTimer = null;
  $('qdSearch').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadQueueList, 350); });
  $('queueName').textContent = state.queue.name;
  $('dlgRecipientSel').addEventListener('change', applyRecipient);
  $('dlgName').addEventListener('input', () => { updatePreview(); validateDlg(); });
  document.querySelectorAll('#setupDlg .previewtabs .tab').forEach(t => t.addEventListener('click', () => setTab(Number(t.dataset.n))));
  $('dlgCancel').addEventListener('click', () => $('setupDlg').close());
  $('dlgConfirm').addEventListener('click', confirmSetup);
  $('setupForm').addEventListener('submit', (e) => e.preventDefault());
  $('tlClose').addEventListener('click', () => $('tlDlg').close());

  setInterval(tick, 1000);
  setInterval(render, 30000);            // keep "next step" times fresh
  send({ type: 'runNow' }).catch(() => {});
  poll();
}

document.addEventListener('DOMContentLoaded', init);
