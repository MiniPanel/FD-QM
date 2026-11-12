// Shared CDAX / Dataverse helpers, configuration and the follow-up template.
// Used by both background.js (automation engine) and dashboard.js (UI).

export const CONFIG = {
  orgUrl: 'https://hpcdax.crm.dynamics.com',
  apiVersion: 'v9.2',
  queueId: '72ed1e99-198a-ee11-8178-0022480937d6', // Default queue (Srijeeth A) - can be changed on the dashboard
  queueName: 'Srijeeth A',
  pollMs: 5000,          // dashboard refresh
  maxFollowups: 2,       // follow-up emails per case: #1 = standard follow-up, #2 = closing notice -> Ready for closure
  maxErrors: 5           // consecutive failures before a sequence goes to "Error"
};

// Version of the customer-email lookup. Cases marked "No email address found" by an older
// lookup are checked once more after an update that raises this number.
export const EMAIL_LOOKUP_V = 2;

// Mailbox the follow-ups are sent FROM. Must be a mailbox that CDAX can send through
// (server-side sync approved) - your manual case emails go out from HPservicessupport.
export const DEFAULT_SENDER_QUEUE = 'HPservicessupport';

// Interval between follow-ups. 24 hours is the standard; 2 minutes is for a quick end-to-end run on a real case.
export const INTERVALS = [
  { label: '24 hours', ms: 24 * 3600 * 1000 },
  { label: '2 minutes', ms: 2 * 60 * 1000 }
];
export const DEFAULT_SETTINGS = { intervalMs: INTERVALS[0].ms, senderQueue: DEFAULT_SENDER_QUEUE, autoStart: true, removeFromQueue: true };

/* ---------------------------------------------------------------
   Runs INSIDE the CDAX tab (same origin) so it uses the signed-in
   CDAX session. Must stay self-contained (no outside references).
   --------------------------------------------------------------- */
async function cdaxFetch(url, method, body, prefer) {
  try {
    const headers = {
      'Accept': 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Prefer': prefer || 'odata.include-annotations="*"'
    };
    const init = { method: method || 'GET', credentials: 'include', headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 800) };
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: true, status: res.status, data, entityId: res.headers.get('OData-EntityId') };
  } catch (e) {
    return { ok: false, status: 0, body: String((e && e.message) || e) };
  }
}

export async function getCdaxTab() {
  const tabs = await chrome.tabs.query({ url: CONFIG.orgUrl + '/*' });
  if (!tabs.length) throw new Error('NO_TAB');
  return tabs.find(t => !t.discarded && t.status === 'complete') || tabs.find(t => !t.discarded) || tabs[0];
}

// Transient errors when the CDAX tab navigates / reloads mid-request ("Frame with ID 0 was removed").
const TRANSIENT = /frame with id|was removed|no tab with id|tab was closed|receiving end does not exist|cannot access contents|back\/forward cache/i;

export async function api(path, opts = {}) {
  // Only GETs are retried automatically. Writes are not, to avoid creating the same email twice;
  // the engine's duplicate check covers write retries on the next run.
  const tries = (opts.method || 'GET') === 'GET' ? 3 : 1;
  for (let i = 1; ; i++) {
    try { return await apiOnce(path, opts); }
    catch (e) {
      if (i >= tries || !TRANSIENT.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

async function apiOnce(path, opts = {}) {
  const tab = await getCdaxTab();
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: cdaxFetch,
      args: [`${CONFIG.orgUrl}/api/data/${CONFIG.apiVersion}/${path}`, opts.method || 'GET', opts.body ?? null, opts.prefer || null]
    });
  } catch (e) {
    throw new Error(`Could not run the request in the CDAX tab: ${e.message}. Avoid reloading or navigating the CDAX tab while the bot is sending.`);
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('No response from the CDAX tab.');
  if (!r.ok) {
    if (r.status === 401) throw new Error('Access denied (HTTP 401). Check that you are signed in to CDAX.');
    if (r.status === 403) throw new Error(`Access denied (HTTP 403). Check that you are signed in to CDAX. ${String(r.body || '').slice(0, 300)}`);
    throw new Error(`HTTP ${r.status}: ${r.body}`);
  }
  if (r.data === null && r.entityId) return { entityId: r.entityId };
  return r.data;
}

export const fv = (o, f) => (o ? (o[`${f}@OData.Community.Display.V1.FormattedValue`] ?? o[f] ?? '') : '');
const q = (s) => String(s).replace(/'/g, "''");
const enc = encodeURIComponent;
const idFromEntityId = (r) => (r && r.entityId ? (r.entityId.match(/\(([^)]+)\)/) || [])[1] : null);
const LOOKUP_TYPE = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const isoNoMs = (iso) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* -------------------- Identity -------------------- */
let meCache = null;
export async function whoAmI() {
  if (meCache) return meCache;
  const w = await api('WhoAmI');
  let fullname = '', email = '';
  try {
    const u = await api(`systemusers(${w.UserId})?$select=fullname,internalemailaddress`);
    fullname = u.fullname || ''; email = u.internalemailaddress || '';
  } catch { /* name is optional */ }
  meCache = { id: w.UserId, fullname, email };
  return meCache;
}

/* -------------------- Queue -------------------- */
export async function getQueue(queueId = CONFIG.queueId) {
  return api(`queues(${queueId})?$select=queueid,name`);
}

// Search active queues by name (for the queue picker).
export async function searchQueues(text) {
  const t = String(text || '').trim();
  const filter = t ? `statecode eq 0 and contains(name,'${q(t)}')` : 'statecode eq 0';
  const d = await api(`queues?$select=queueid,name&$filter=${enc(filter)}&$orderby=name&$top=50`);
  return ((d && d.value) || []).map(x => ({ id: x.queueid, name: x.name }));
}

// Currently selected queue {id, name}. Stored separately from the other settings.
export async function getMonitorQueue() {
  const { monitorQueue } = await chrome.storage.local.get('monitorQueue');
  return monitorQueue && monitorQueue.id ? monitorQueue : { id: CONFIG.queueId, name: CONFIG.queueName };
}

export function queueItemsPath(queueId = CONFIG.queueId) {
  const select = 'queueitemid,title,enteredon,objecttypecode,_objectid_value,_workerid_value,statecode';
  const expand = 'objectid_incident($select=incidentid,ticketnumber,title,statecode,statuscode,_customerid_value,_ownerid_value)';
  const filter = `_queueid_value eq ${queueId} and statecode eq 0`;
  return `queueitems?$select=${select}&$expand=${enc(expand)}&$filter=${enc(filter)}&$orderby=${enc('enteredon desc')}`;
}

export function normaliseQueueItem(qi) {
  const inc = qi.objectid_incident || null;
  return {
    id: qi.queueitemid,
    enteredOn: qi.enteredon,
    type: fv(qi, 'objecttypecode') || 'Unknown',
    isCase: !!inc,
    incidentId: inc ? inc.incidentid : qi._objectid_value,
    caseNumber: (inc && inc.title) || qi.title || '',   // HP case number is stored in the case Title (e.g. 5166598789)
    crmNumber: inc ? (inc.ticketnumber || '') : '',     // CAS-xxxx internal number (kept for reference only)
    customer: fv(inc, '_customerid_value'),
    status: inc ? fv(inc, 'statuscode') : '',
    caseActive: inc ? inc.statecode === 0 : true,
    owner: fv(inc, '_ownerid_value'),
    workedBy: fv(qi, '_workerid_value')
  };
}

export async function getQueueItems(queueId = CONFIG.queueId) {
  const data = await api(queueItemsPath(queueId));
  return (data && data.value ? data.value : []).map(normaliseQueueItem);
}

/* -------------------- Case details / recipients -------------------- */
// Follow-ups go ONLY to a CONTACT's email address (a contact record linked to the case).
// The customer account's email and the case's free-text email field are NOT used.
// Contact fields are checked in this order; the first contact with a valid email is used.
const CONTACT_LOOKUPS = [
  { field: '_primarycontactid_value',              label: 'Primary contact' },
  { field: '_hpi_primaryresponsiblecontact_value', label: 'Primary responsible contact' },
  { field: '_customerid_value',                    label: 'Customer (contact)' },     // only when the customer is a contact
  { field: '_hpi_shippingcontactid_value',         label: 'Shipping contact' },
  { field: '_hpi_equipmencontact_value',           label: 'Equipment contact' }
];
const CASE_FIELDS = 'incidentid,title,ticketnumber,statecode,_customerid_value,_ownerid_value';

async function getContact(id) {
  try { return await api(`contacts(${id})?$select=contactid,fullname,firstname,emailaddress1`); }
  catch { return null; }
}

export async function getIncidentDetails(incidentId) {
  let inc;
  const extra = CONTACT_LOOKUPS.map(c => c.field).filter(f => f !== '_customerid_value').join(',');
  try { inc = await api(`incidents(${incidentId})?$select=${CASE_FIELDS},${extra}`); }
  catch {
    try { inc = await api(`incidents(${incidentId})?$select=${CASE_FIELDS},_primarycontactid_value`); }
    catch { inc = await api(`incidents(${incidentId})?$select=${CASE_FIELDS}`); }
  }

  const options = [];
  const contactIds = [];
  const seen = new Set();
  for (const c of CONTACT_LOOKUPS) {
    const id = inc[c.field];
    if (!id || seen.has(id)) continue;
    if (inc[c.field + LOOKUP_TYPE] && inc[c.field + LOOKUP_TYPE] !== 'contact') continue;   // skip accounts
    seen.add(id);
    contactIds.push(id);
    const ct = await getContact(id);
    const email = ct && String(ct.emailaddress1 || '').trim();
    if (!ct || !isEmail(email)) continue;
    if (options.some(o => o.email.toLowerCase() === email.toLowerCase())) continue;
    options.push({ type: 'contact', id: ct.contactid, name: ct.fullname || '', firstname: ct.firstname || '', email, label: c.label });
  }

  return {
    incidentId: inc.incidentid,
    caseNumber: inc.title || '',
    crmNumber: inc.ticketnumber || '',
    customerName: fv(inc, '_customerid_value'),
    owner: fv(inc, '_ownerid_value'),
    active: inc.statecode === 0,
    recipients: options,
    contactIds                      // every contact linked to the case (used to detect new chats/calls)
  };
}

// Contacts linked to the case (no email needed) - for sequences that did not store them.
export async function getCaseContactIds(incidentId) {
  const extra = CONTACT_LOOKUPS.map(c => c.field).filter(f => f !== '_customerid_value').join(',');
  let inc;
  try { inc = await api(`incidents(${incidentId})?$select=_customerid_value,${extra}`); }
  catch { inc = await api(`incidents(${incidentId})?$select=_customerid_value,_primarycontactid_value`); }
  const ids = [];
  for (const c of CONTACT_LOOKUPS) {
    const id = inc[c.field];
    if (!id || ids.includes(id)) continue;
    if (inc[c.field + LOOKUP_TYPE] && inc[c.field + LOOKUP_TYPE] !== 'contact') continue;
    ids.push(id);
  }
  return ids;
}

/* -------------------- New chats / calls from the customer -------------------- */
// Omnichannel conversations (msdyn_ocliveworkitem: WhatsApp, live chat, voice, ...) created AFTER `sinceIso`
// that are linked to this case OR started by one of the case's contacts, plus incoming phone-call
// activities logged on the case. Field names confirmed from case 5166648504.
const CALL_CHANNEL = /voice|phone|call|telephon/i;

export async function findNewContacts(incidentId, contactIds, sinceIso) {
  const sinceMs = new Date(sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) return [];
  const since = isoNoMs(sinceIso);
  const found = [];

  // 1. Conversations (chat / WhatsApp / voice)
  const who = [`_regardingobjectid_value eq ${incidentId}`, ...(contactIds || []).map(c => `_msdyn_customer_value eq ${c}`)];
  const sel = 'activityid,createdon,msdyn_channel,statuscode,_regardingobjectid_value,_msdyn_activeagentid_value,' +
              '_ownerid_value,_msdyn_cdsqueueid_value,_msdyn_liveworkstreamid_value,_msdyn_customer_value';
  const filter = `createdon gt ${since} and (${who.join(' or ')})`;
  const d = await api(`msdyn_ocliveworkitems?$select=${sel}&$filter=${enc(filter)}&$orderby=${enc('createdon asc')}&$top=20`);
  for (const c of (d && d.value) || []) {
    if (new Date(c.createdon).getTime() <= sinceMs) continue;
    const channel = fv(c, 'msdyn_channel') || 'Chat';
    const regarding = c._regardingobjectid_value || null;
    found.push({
      id: c.activityid,
      source: 'conversation',
      at: c.createdon,
      channel,
      isCall: CALL_CHANNEL.test(channel),
      agent: fv(c, '_msdyn_activeagentid_value') || '',
      queue: fv(c, '_msdyn_cdsqueueid_value') || '',
      workstream: fv(c, '_msdyn_liveworkstreamid_value') || '',
      status: fv(c, 'statuscode') || '',
      customer: fv(c, '_msdyn_customer_value') || '',
      sameCase: !!regarding && regarding.toLowerCase() === String(incidentId).toLowerCase(),
      otherCase: regarding && regarding.toLowerCase() !== String(incidentId).toLowerCase() ? (fv(c, '_regardingobjectid_value') || '') : ''
    });
  }

  // 2. Incoming phone-call activities logged on the case (if your team logs calls this way)
  try {
    const pf = `_regardingobjectid_value eq ${incidentId} and directioncode eq false and createdon gt ${since}`;
    const p = await api(`phonecalls?$select=activityid,createdon,_ownerid_value&$filter=${enc(pf)}&$orderby=${enc('createdon asc')}&$top=10`);
    for (const c of (p && p.value) || []) {
      if (new Date(c.createdon).getTime() <= sinceMs) continue;
      found.push({ id: c.activityid, source: 'phonecall', at: c.createdon, channel: 'Phone call', isCall: true,
                   agent: fv(c, '_ownerid_value') || '', queue: '', workstream: '', status: '', customer: '',
                   sameCase: true, otherCase: '' });
    }
  } catch { /* phone calls are optional */ }

  found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return found;
}

// Re-read one conversation (to pick up the agent once the chat has been accepted).
export async function getConversation(id) {
  const c = await api(`msdyn_ocliveworkitems(${id})?$select=statuscode,_msdyn_activeagentid_value,_msdyn_cdsqueueid_value`);
  return { agent: fv(c, '_msdyn_activeagentid_value') || '', queue: fv(c, '_msdyn_cdsqueueid_value') || '', status: fv(c, 'statuscode') || '' };
}

/* -------------------- Remove a finished case from its queue -------------------- */
// Uses the Dataverse "RemoveFromQueue" action (same as the Remove button in CDAX; it removes the
// queue ITEM only - the case itself is not touched). Returns how many queue items were removed.
export async function findQueueItemIds(queueId, incidentId) {
  const filter = `_queueid_value eq ${queueId} and _objectid_value eq ${incidentId} and statecode eq 0`;
  const d = await api(`queueitems?$select=queueitemid&$filter=${enc(filter)}&$top=10`);
  return ((d && d.value) || []).map(x => x.queueitemid);
}

export async function removeCaseFromQueue(queueId, incidentId) {
  const ids = await findQueueItemIds(queueId, incidentId);
  for (const id of ids) {
    await api(`queueitems(${id})/Microsoft.Dynamics.CRM.RemoveFromQueue`, { method: 'POST', body: {} });
  }
  return { removed: ids.length };
}

// "A, Srijeeth" -> "Srijeeth A";  "Kumar, Revathi S" -> "Revathi S Kumar". Suffixes like "(CW)" are dropped.
export function displayName(raw) {
  let n = String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const m = n.match(/^([^,]+),\s*(.+)$/);
  if (m) n = `${m[2].trim()} ${m[1].trim()}`;
  return n;
}

// Current case owner, read fresh from CDAX before every email (handles reassignment mid-sequence).
// Returns { name, raw, type, id } - name is '' when the owner is a team (template then signs "HP Support Team").
export async function getCaseOwner(incidentId) {
  const inc = await api(`incidents(${incidentId})?$select=_ownerid_value`);
  const type = inc['_ownerid_value' + LOOKUP_TYPE] || '';
  const raw = fv(inc, '_ownerid_value');
  const id = inc._ownerid_value || null;
  if (type !== 'systemuser') return { name: '', raw, type, id };
  let full = raw;
  try {
    const u = await api(`systemusers(${inc._ownerid_value})?$select=fullname,firstname,lastname`);
    full = u.fullname || raw;
  } catch { /* keep formatted value */ }
  return { name: displayName(full), raw, type, id };
}

/* -------------------- Dynamic Notes: Supplemental Log (hpi_noteslog) -------------------- */
// Same record CDAX creates when an agent clicks "Save Notes" under Supplemental Case Notes.
export const SUPPLEMENTAL = {
  entitySet: 'hpi_noteslogs',
  name: 'Agent Supplemental Notes',
  noteType: 100000001,                                   // "Notes Log"
  actionTypeId: 'f85d7d00-7156-f011-877a-7c1e525af8ae',  // "Supplemental Information"
  visibleExternal: false,                                // internal bot note - not shown to the customer
  maxLength: 3000                                        // same limit as the Case Notes box
};

// Creates a Supplemental Log on the case. Owner = case owner (user or team) when possible.
export async function addSupplementalLog(incidentId, text, owner) {
  const body = {
    hpi_name: SUPPLEMENTAL.name,
    hpi_description: String(text || '').slice(0, SUPPLEMENTAL.maxLength),
    hpi_visibleexternal: SUPPLEMENTAL.visibleExternal,
    hpi_notetype: SUPPLEMENTAL.noteType,
    'hpi_NotesActionType@odata.bind': `/hpi_notesactiontypes(${SUPPLEMENTAL.actionTypeId})`,
    'hpi_Case@odata.bind': `/incidents(${incidentId})`
  };
  const ownerBind = owner && owner.id && (owner.type === 'systemuser' || owner.type === 'team')
    ? { 'ownerid@odata.bind': `/${owner.type === 'team' ? 'teams' : 'systemusers'}(${owner.id})` }
    : null;
  if (ownerBind) {
    try {
      const r = await api(SUPPLEMENTAL.entitySet, { method: 'POST', body: { ...body, ...ownerBind } });
      return { noteId: idFromEntityId(r), ownerSet: true, ownerError: null };
    } catch (e) {
      const r = await api(SUPPLEMENTAL.entitySet, { method: 'POST', body });
      return { noteId: idFromEntityId(r), ownerSet: false, ownerError: e.message };
    }
  }
  const r = await api(SUPPLEMENTAL.entitySet, { method: 'POST', body });
  return { noteId: idFromEntityId(r), ownerSet: false, ownerError: 'Case owner not available' };
}

/* -------------------- Timeline note (fallback only) -------------------- */
export async function addCaseNote(incidentId, subject, text, owner) {
  const base = {
    subject,
    notetext: text,
    'objectid_incident@odata.bind': `/incidents(${incidentId})`,
    objecttypecode: 'incident'
  };
  const ownerBind = owner && owner.id && (owner.type === 'systemuser' || owner.type === 'team')
    ? { 'ownerid@odata.bind': `/${owner.type === 'team' ? 'teams' : 'systemusers'}(${owner.id})` }
    : null;
  if (ownerBind) {
    try {
      const r = await api('annotations', { method: 'POST', body: { ...base, ...ownerBind } });
      return { noteId: idFromEntityId(r), ownerSet: true, ownerError: null };
    } catch (e) {
      const r = await api('annotations', { method: 'POST', body: base });
      return { noteId: idFromEntityId(r), ownerSet: false, ownerError: e.message };
    }
  }
  const r = await api('annotations', { method: 'POST', body: base });
  return { noteId: idFromEntityId(r), ownerSet: false, ownerError: 'Case owner not available' };
}

export async function getCaseState(incidentId) {
  const inc = await api(`incidents(${incidentId})?$select=statecode,statuscode`);
  return { active: inc.statecode === 0, state: fv(inc, 'statecode'), status: fv(inc, 'statuscode') };
}

/* -------------------- Emails -------------------- */
export const tagFor = (n) => `[Follow-up ${n}/${CONFIG.maxFollowups}]`;

// Already-sent follow-up n for THIS sequence (only emails created after the sequence started).
// The "[Follow-up n/3]" tag is matched in JavaScript - OData contains() treats [ ] as a wildcard.
export async function findOutgoingFollowup(incidentId, n, sinceIso) {
  const since = new Date(sinceIso).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const filter = `_regardingobjectid_value eq ${incidentId} and directioncode eq true and createdon ge ${since}` +
                 ` and (statuscode eq 3 or statuscode eq 6 or statuscode eq 7)`;
  const d = await api(`emails?$select=activityid,subject,createdon,statuscode&$filter=${enc(filter)}&$orderby=${enc('createdon desc')}&$top=50`);
  const tag = tagFor(n);
  return ((d && d.value) || []).find(e => (e.subject || '').includes(tag)) || null;
}

const AUTO_REPLY = /^\s*(automatic reply|auto.?reply|autoreply|out of (the )?office|undeliverable|delivery (status|has failed)|mail delivery|returned mail)/i;

// First genuine incoming email on the case created AFTER `sinceIso`. Auto-replies / bounces are ignored.
export async function findCustomerReply(incidentId, sinceIso) {
  const sinceMs = new Date(sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) return { reply: null, ignored: [] };
  const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const filter = `_regardingobjectid_value eq ${incidentId} and directioncode eq false and createdon gt ${since}`;
  const d = await api(`emails?$select=activityid,subject,createdon,sender&$filter=${enc(filter)}&$orderby=${enc('createdon asc')}&$top=10`);
  const list = ((d && d.value) || []).filter(e => new Date(e.createdon).getTime() > sinceMs);
  const ignored = list.filter(e => AUTO_REPLY.test(e.subject || ''));
  const reply = list.find(e => !AUTO_REPLY.test(e.subject || ''));
  return { reply: reply || null, ignored };
}

// Email status codes (Dataverse): 1 Draft, 2 Completed, 3 Sent, 4 Received, 5 Canceled, 6 Pending Send, 7 Sending, 8 Failed
export const EMAIL_STATUS = { 1: 'Draft', 2: 'Completed', 3: 'Sent', 4: 'Received', 5: 'Canceled', 6: 'Pending Send', 7: 'Sending', 8: 'Failed' };

export const emailUrl = (id) => `${CONFIG.orgUrl}/main.aspx?pagetype=entityrecord&etn=email&id=${id}`;

const REGARDING_PROPS = ['regardingobjectid_incident_email', 'regardingobjectid_incident'];

/* -------------------- Sender (From) -------------------- */
export async function resolveSender(queueName, incidentId) {
  if (queueName) {
    const d = await api(`queues?$select=queueid,name,emailaddress&$filter=${enc(`name eq '${q(queueName)}'`)}&$top=5`);
    let hit = d && d.value && d.value[0];
    if (!hit) {
      const d2 = await api(`queues?$select=queueid,name,emailaddress&$filter=${enc(`contains(name,'${q(queueName)}')`)}&$top=5`);
      hit = d2 && d2.value && d2.value[0];
    }
    if (hit) return { type: 'queue', id: hit.queueid, name: hit.name, email: hit.emailaddress || '', source: 'Queue mailbox' };
  }
  if (incidentId) {
    const f = `_regardingobjectid_value eq ${incidentId} and directioncode eq true and statuscode eq 3`;
    const d = await api(`emails?$select=activityid&$filter=${enc(f)}&$orderby=${enc('createdon desc')}&$top=1` +
      `&$expand=${enc('email_activity_parties($select=participationtypemask,_partyid_value,addressused)')}`);
    const e = d && d.value && d.value[0];
    const from = e && (e.email_activity_parties || []).find(p => p.participationtypemask === 1);
    if (from && from._partyid_value) {
      const lname = from['_partyid_value' + LOOKUP_TYPE];
      if (lname === 'queue' || lname === 'systemuser') {
        return { type: lname, id: from._partyid_value, name: fv(from, '_partyid_value'), email: from.addressused || '', source: 'Same as last sent email on the case' };
      }
    }
  }
  throw new Error(`Sender mailbox "${queueName}" was not found as a CDAX queue, and no previously sent email on the case to copy the sender from. Check the "Send from" name in settings.`);
}

export async function sendFollowupEmail({ incidentId, sender, to, subject, html }) {
  const fromBind = sender.type === 'queue'
    ? { 'partyid_queue@odata.bind': `/queues(${sender.id})` }
    : { 'partyid_systemuser@odata.bind': `/systemusers(${sender.id})` };
  const parties = [{ participationtypemask: 1, ...fromBind }];
  if (to.type === 'contact' && to.id) parties.push({ participationtypemask: 2, 'partyid_contact@odata.bind': `/contacts(${to.id})` });
  else if (to.type === 'account' && to.id) parties.push({ participationtypemask: 2, 'partyid_account@odata.bind': `/accounts(${to.id})` });
  else parties.push({ participationtypemask: 2, addressused: to.email });

  // 1. Create the email activity on the case
  let created = null, lastErr = null;
  for (const prop of REGARDING_PROPS) {
    try {
      created = await api('emails?$select=activityid', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          subject,
          description: html,
          directioncode: true,
          [`${prop}@odata.bind`]: `/incidents(${incidentId})`,
          email_activity_parties: parties
        }
      });
      break;
    } catch (e) {
      lastErr = e;
      if (!/undeclared|does not exist|not found on type|navigation property/i.test(e.message)) break;
    }
  }
  if (!created) throw new Error(`Could not create the email on the case: ${lastErr && lastErr.message}`);

  let emailId = created.activityid;
  if (!emailId && created.entityId) emailId = idFromEntityId(created);
  if (!emailId) throw new Error('Email was created but its ID was not returned.');

  // 2. Verify it is linked to the case
  const check = await api(`emails(${emailId})?$select=_regardingobjectid_value,statuscode`);
  if (!check._regardingobjectid_value || check._regardingobjectid_value.toLowerCase() !== incidentId.toLowerCase()) {
    try { await api(`emails(${emailId})`, { method: 'DELETE' }); } catch { /* ignore */ }
    throw new Error('Email was created but is not linked to the case - not sent.');
  }

  // 3. Send it
  try {
    await api(`emails(${emailId})/Microsoft.Dynamics.CRM.SendEmail`, { method: 'POST', body: { IssueSend: true } });
  } catch (e) {
    try { await api(`emails(${emailId})`, { method: 'DELETE' }); } catch { /* leave draft if delete not allowed */ }
    throw new Error(`CDAX refused to send the email: ${e.message}`);
  }

  // 4. Read back the delivery status
  const after = await api(`emails(${emailId})?$select=statuscode`);
  return { emailId, statuscode: after.statuscode, statusText: EMAIL_STATUS[after.statuscode] || String(after.statuscode) };
}

export async function getEmailStatus(emailId) {
  const e = await api(`emails(${emailId})?$select=statuscode`);
  return { statuscode: e.statuscode, statusText: EMAIL_STATUS[e.statuscode] || String(e.statuscode) };
}

/* -------------------- Template -------------------- */
export const TEMPLATE = {
  id: 'generic',
  name: 'Generic customer follow-up',
  steps: [
    {
      subject: 'HP Support Case {{caseNumber}} - Follow-up',
      closing: 'Kind regards,',
      body: [
        'Dear {{customerName}},',
        'Thank you for contacting HP Support. We are following up on your case {{caseNumber}}.',
        'We have not heard back from you since our last update. To help us continue working on your case, please reply to this email with any updates or the information we requested.',
        'If your issue has already been resolved, please let us know so that we can close your case.',
        'When replying, please keep the case number in the subject line.'
      ]
    },
    {
      subject: 'HP Support Case {{caseNumber}} - Final follow-up',
      closing: 'Warm regards,',
      body: [
        'Dear {{customerName}},',
        'As we haven’t received a response to our previous follow-ups, we will be temporarily closing your support case.',
        'If you still require assistance, please feel free to contact us and reference your case number {{caseNumber}}. We’ll be happy to reopen the case and continue assisting you.',
        'Thank you for choosing our support services. We appreciate your understanding.'
      ]
    }
  ],
  signature: ['{{closing}}', '{{agentName}}', 'HP Support']
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? '24 hours' : `${d * 24} hours`; }
  if (m % 60 === 0) { const h = m / 60; return `${h} hour${h > 1 ? 's' : ''}`; }
  return `${m} minute${m > 1 ? 's' : ''}`;
}

export const PLACEHOLDERS = ['customerName', 'caseNumber', 'waitText'];

export function effectiveSteps(custom) {
  const valid = Array.isArray(custom) && custom.every(t => t && typeof t.subject === 'string' && Array.isArray(t.body));
  if (valid && custom.length === CONFIG.maxFollowups) return custom;
  if (valid && custom.length === 3) return [custom[0], custom[2]];   // saved when there were 3 emails: keep email 1 and the final email
  return TEMPLATE.steps;
}

export function validateSteps(steps) {
  const problems = [];
  steps.forEach((t, i) => {
    const tag = `Email ${i + 1}`;
    if (!t.subject || !t.subject.trim()) problems.push(`${tag}: subject is empty.`);
    if (!t.body || !t.body.length) problems.push(`${tag}: body is empty.`);
    const all = [t.subject || '', ...(t.body || []), t.closing || ''].join('\n');
    for (const m of all.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!PLACEHOLDERS.includes(m[1])) problems.push(`${tag}: unknown placeholder {{${m[1]}}} (allowed: ${PLACEHOLDERS.map(p => '{{' + p + '}}').join(', ')}).`);
    }
  });
  return problems;
}

/* -------------------- Which template applies: WhatsApp vs. every other channel -------------------- */
// Each case is created from a conversation (WhatsApp, Live chat, ...). Cases that came in on WhatsApp keep the
// standard follow-up templates; cases from any OTHER channel get the "chat got disconnected" email below.
// Field names / values confirmed on cases 5165119191 (Live chat, code 192360000) and 5166648504 (WhatsApp, 192300000).
const WHATSAPP_CODE = '192300000';
const WHATSAPP_CHANNEL = /whatsapp/i;
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// CDAX greys out the WhatsApp composer once 24 hours have passed since the customer's latest
// message. A missing timestamp is deliberately treated as active/unknown: the bot must not send
// while it cannot prove that the 24-hour window has ended.
export function classifyWhatsappWindow(lastCustomerMessageAt, nowMs = Date.now()) {
  const atMs = Date.parse(lastCustomerMessageAt || '');
  if (!Number.isFinite(atMs)) {
    return { blocked: false, known: false, lastCustomerMessageAt: null, windowEndsAt: null, ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - atMs);
  return {
    blocked: ageMs >= WHATSAPP_WINDOW_MS,
    known: true,
    lastCustomerMessageAt: new Date(atMs).toISOString(),
    windowEndsAt: new Date(atMs + WHATSAPP_WINDOW_MS).toISOString(),
    ageMs
  };
}

// Newest conversation linked to the case, or null when the case has none. Throws on an API error, so the
// caller never starts a sequence with the wrong template because of a failed lookup.
export async function getCaseChannel(incidentId) {
  const sel = 'activityid,createdon,msdyn_channel,_msdyn_liveworkstreamid_value,_msdyn_cdsqueueid_value';
  const filter = `_regardingobjectid_value eq ${incidentId}`;
  const d = await api(`msdyn_ocliveworkitems?$select=${sel}&$filter=${enc(filter)}&$orderby=${enc('createdon desc')}&$top=5`);
  const c = d && d.value && d.value[0];
  if (!c) return null;
  const code = String(c.msdyn_channel ?? '');
  let channel = String(fv(c, 'msdyn_channel') || '').trim();
  if (/^\d+$/.test(channel)) channel = '';          // no readable label from CDAX - only the numeric code
  return {
    id: c.activityid,
    channel: channel || (code ? `Channel ${code}` : 'Chat'),
    code,
    isWhatsApp: WHATSAPP_CHANNEL.test(channel) || code === WHATSAPP_CODE,
    workstream: fv(c, '_msdyn_liveworkstreamid_value') || '',
    queue: fv(c, '_msdyn_cdsqueueid_value') || '',
    at: c.createdon
  };
}

// Latest customer-message timestamp for one conversation. The table/field pair was confirmed in
// this CDAX tenant: msdyn_conversationmessageblock.msdyn_customermessagetimestamp. No message body
// or transcript is read. Rows can arrive a few minutes after the interaction, so callers re-check.
export async function getWhatsappWindow(conversationId, nowMs = Date.now()) {
  if (!conversationId) return classifyWhatsappWindow(null, nowMs);
  const filter = `_msdyn_ocliveworkitemid_value eq ${conversationId} and msdyn_customermessagetimestamp ne null`;
  const select = 'msdyn_conversationmessageblockid,msdyn_customermessagetimestamp,msdyn_lastcustomermessagetimestamp';
  const d = await api(`msdyn_conversationmessageblocks?$select=${select}&$filter=${enc(filter)}` +
                      `&$orderby=${enc('msdyn_customermessagetimestamp desc')}&$top=50`);
  let latest = null;
  for (const b of (d && d.value) || []) {
    for (const value of [b.msdyn_customermessagetimestamp, b.msdyn_lastcustomermessagetimestamp]) {
      const ms = Date.parse(value || '');
      if (Number.isFinite(ms) && (!latest || ms > Date.parse(latest))) latest = new Date(ms).toISOString();
    }
  }
  return { ...classifyWhatsappWindow(latest, nowMs), conversationId };
}

// Window state for the newest conversation linked to a case. Non-WhatsApp cases return null.
export async function getCaseWhatsappWindow(incidentId, channel = null, nowMs = Date.now()) {
  const ch = channel || await getCaseChannel(incidentId);
  if (!ch || !ch.isWhatsApp) return null;
  const window = await getWhatsappWindow(ch.id, nowMs);
  return { ...window, conversationId: ch.id, channel: ch.channel, queue: ch.queue, workstream: ch.workstream };
}

// 'chat' = non-WhatsApp conversation; 'default' = WhatsApp, or no conversation on the case.
export const templateKindFor = (ch) => (ch && !ch.isWhatsApp ? 'chat' : 'default');

export const CHAT_TEMPLATE_NAME = 'Chat disconnected follow-up';
export const CHAT_RECONNECT_URL = 'https://support.hp.com/contact';

// The same email for both follow-ups, reconnect link in every one. Signed "HP Technical Support".
export function renderChatTemplate(n, vars) {
  const name = escapeHtml(vars.customerName || 'Customer');
  const url = escapeHtml(CHAT_RECONNECT_URL);
  const subject = `Follow-up on Your HP Support Chat (${String(vars.caseNumber || '').trim()}) ${tagFor(n)}`;
  const html =
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">' +
    `<p>Hello ${name},</p>` +
    '<p>I hope you\'re doing well. It looks like our recent chat got disconnected\u2014sorry for the inconvenience!</p>' +
    `<p>If you still need assistance, just reply to this email or reach us again via chat at <a href="${url}">${url}</a><br>` +
    'Our support hours are 24/7.</p>' +
    '<p>Looking forward to assisting you further!</p>' +
    '<p>Best regards,<br>HP Technical Support</p></div>';
  return { subject, html };
}

// kind: 'chat' | 'default' (sequences saved before this feature have no kind -> 'default')
export function renderTemplateFor(kind, n, vars, custom) {
  return kind === 'chat' ? renderChatTemplate(n, vars) : renderTemplate(n, vars, custom);
}

export function renderTemplate(n, vars, custom) {
  const step = effectiveSteps(custom)[n - 1];
  const raw = {
    caseNumber: String(vars.caseNumber || ''),
    customerName: vars.customerName || 'Customer',
    waitText: formatDuration(vars.intervalMs)
  };
  const fillHtml = (t) => escapeHtml(t).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k === 'caseNumber' ? `<b>${escapeHtml(raw.caseNumber)}</b>` : escapeHtml(raw[k] ?? ''));
  const fillText = (t) => String(t || '').replace(/\{\{(\w+)\}\}/g, (_, k) => raw[k] ?? '');
  const subject = `${fillText(step.subject).replace(/\s+/g, ' ').trim()} ${tagFor(n)}`;
  const closing = (step.closing || 'Kind regards,').trim();
  const agent = vars.agentName || 'HP Support Team';
  const html =
    '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">' +
    step.body.map(p => `<p>${fillHtml(p).replace(/\n/g, '<br>')}</p>`).join('') +
    `<p>${escapeHtml(closing)}<br>${escapeHtml(agent)}<br>HP Support</p></div>`;
  return { subject, html };
}
