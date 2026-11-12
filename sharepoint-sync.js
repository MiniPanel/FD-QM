// Direct, delegated Microsoft Graph sync for the SharePoint manager list.
// This uses the signed-in user's permissions; no password or client secret is stored here.
import * as C from './cdax.js';

const CONFIG = {
  tenantId: 'ca7981a2-785a-463d-b82a-3db87dfc3ce6',
  clientId: 'REPLACE_WITH_ENTRA_APPLICATION_CLIENT_ID',
  siteHost: 'hp.sharepoint.com',
  sitePath: '/teams/cdax_followup_automation',
  listName: 'CDAX Follow-up Cases',
  graph: 'https://graph.microsoft.com/v1.0',
  scope: 'openid profile offline_access https://graph.microsoft.com/Sites.ReadWrite.All'
};
const MENU_CONNECT = 'cdax-sharepoint-connect';
const MENU_SYNC = 'cdax-sharepoint-sync';
const AUTH_SESSION_KEY = 'cdaxSharePointAuth';
const SYNC_STATE_KEY = 'cdaxSharePointSync';
const SYNC_DEBOUNCE_MS = 2500;
let debounceTimer = null;
let syncPromise = null;
let siteId = null;
let listId = null;

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
function randomString(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}
async function pkceChallenge(verifier) {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

function configured() {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(CONFIG.tenantId) &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(CONFIG.clientId);
}

async function signIn() {
  if (!configured()) throw new Error('Set the Entra app client ID in sharepoint-sync.js before connecting.');
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomString(48);
  const challenge = await pkceChallenge(verifier);
  const state = randomString(24);
  const authUrl = new URL(`https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/authorize`);
  authUrl.search = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: CONFIG.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();
  const returned = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  if (!returned) throw new Error('Microsoft sign-in was cancelled.');
  const callback = new URL(returned);
  if (callback.searchParams.get('state') !== state) throw new Error('Sign-in state did not match; please try again.');
  const error = callback.searchParams.get('error');
  if (error) throw new Error(callback.searchParams.get('error_description') || error);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Microsoft did not return an authorization code.');
  const token = await tokenRequest({
    client_id: CONFIG.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: CONFIG.scope
  });
  await saveToken(token);
}

async function tokenRequest(form) {
  const res = await fetch(`https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || `Microsoft token request failed (${res.status}).`);
  return data;
}

async function saveToken(token) {
  const auth = {
    accessToken: token.access_token,
    expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600) - 120) * 1000,
    refreshToken: token.refresh_token || null
  };
  // Session storage is cleared when the browser session ends; tokens are never put in sync/local storage.
  await chrome.storage.session.set({ [AUTH_SESSION_KEY]: auth });
}

async function getAccessToken() {
  const stored = await chrome.storage.session.get(AUTH_SESSION_KEY);
  const auth = stored[AUTH_SESSION_KEY];
  if (auth && auth.accessToken && Date.now() < auth.expiresAt) return auth.accessToken;
  if (auth && auth.refreshToken) {
    const token = await tokenRequest({
      client_id: CONFIG.clientId,
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: CONFIG.scope
    });
    await saveToken(token);
    return token.access_token;
  }
  throw new Error('SharePoint is not connected or the sign-in expired. Choose the extension menu > Connect to SharePoint.');
}

async function graph(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${CONFIG.graph}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data && data.error && data.error.message;
    throw new Error(`SharePoint/Graph ${res.status}: ${message || text.slice(0, 300)}`);
  }
  return data;
}

async function ensureList() {
  if (!siteId) {
    const site = await graph(`/sites/${CONFIG.siteHost}:${CONFIG.sitePath}`);
    siteId = site.id;
  }
  if (!listId) {
    const lists = await graph(`/sites/${encodeURIComponent(siteId)}/lists?$select=id,displayName&$top=200`);
    const match = (lists.value || []).find(x => x.displayName === CONFIG.listName);
    if (match) listId = match.id;
    else {
      const created = await graph(`/sites/${encodeURIComponent(siteId)}/lists`, {
        method: 'POST', body: { displayName: CONFIG.listName, list: { template: 'genericList' } }
      });
      listId = created.id;
    }
  }
  const definitions = [
    ['incidentId', { text: { maxLength: 80 } }],
    ['customer', { text: { maxLength: 255 } }],
    ['queueName', { text: { maxLength: 255 } }],
    ['owner', { text: { maxLength: 255 } }],
    ['automationStatus', { text: { maxLength: 80 } }],
    ['followupsSent', { number: { decimalPlaces: 'none' } }],
    ['followupsPlanned', { number: { decimalPlaces: 'none' } }],
    ['inQueue', { boolean: {} }],
    ['responseDetected', { boolean: {} }],
    ['lastUpdated', { text: { maxLength: 80 } }],
    ['lastAction', { text: { maxLength: 255 } }]
  ];
  const existing = await graph(`/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/columns?$select=name&$top=200`);
  const names = new Set((existing.value || []).map(x => x.name));
  for (const [name, type] of definitions) {
    if (!names.has(name)) {
      await graph(`/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/columns`, {
        method: 'POST', body: { name, ...type }
      });
    }
  }
}

function makeRows(items, sequences, queueId, queueName) {
  const byIncident = new Map(Object.entries(sequences || {}));
  const seen = new Set();
  const rows = [];
  const add = (q, s, inQueue) => {
    const incidentId = (q && q.incidentId) || (s && s.incidentId);
    if (!incidentId || seen.has(incidentId)) return;
    seen.add(incidentId);
    const status = (s && s.status) || 'none';
    const timeline = s && Array.isArray(s.timeline) ? s.timeline : [];
    const last = timeline[timeline.length - 1];
    rows.push({
      incidentId: String(incidentId),
      caseNumber: String((q && q.caseNumber) || (s && s.caseNumber) || ''),
      customer: String((q && q.customer) || (s && s.customerName) || ''),
      queueName: String((s && s.queueName) || queueName || ''),
      owner: String((q && q.owner) || (s && (s.ownerSignature || s.owner)) || ''),
      automationStatus: status,
      followupsSent: Number((s && s.sentCount) || 0),
      followupsPlanned: Number((s && s.planned) || C.CONFIG.maxFollowups),
      inQueue: !!inQueue,
      responseDetected: status === 'responded' || !!(s && s.newContact),
      lastUpdated: new Date().toISOString(),
      lastAction: String((last && last.text) || (s && s.stopReason) || '').slice(0, 255)
    });
  };
  for (const q of items || []) {
    if (!q.isCase || !q.incidentId) continue;
    add(q, byIncident.get(q.incidentId), true);
  }
  for (const s of Object.values(sequences || {})) {
    if ((s.queueId || C.CONFIG.queueId) !== queueId) continue;
    add(null, s, false);
  }
  return rows;
}

async function listItems() {
  const result = [];
  let path = `/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/items?$expand=fields($select=incidentId)&$top=200`;
  while (path) {
    const page = await graph(path);
    result.push(...(page.value || []));
    path = page['@odata.nextLink'] ? page['@odata.nextLink'].replace(CONFIG.graph, '') : null;
  }
  return result;
}

async function syncNow() {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    await ensureList();
    const queue = await C.getMonitorQueue();
    const [items, stored] = await Promise.all([
      C.getQueueItems(queue.id),
      chrome.storage.local.get(['sequences'])
    ]);
    const rows = makeRows(items, stored.sequences || {}, queue.id, queue.name);
    const existing = await listItems();
    const byId = new Map();
    for (const item of existing) {
      const incidentId = item.fields && item.fields.incidentId;
      if (incidentId) byId.set(String(incidentId), item.id);
    }
    for (const row of rows) {
      const fields = {
        Title: row.caseNumber || row.incidentId,
        incidentId: row.incidentId,
        customer: row.customer,
        queueName: row.queueName,
        owner: row.owner,
        automationStatus: row.automationStatus,
        followupsSent: row.followupsSent,
        followupsPlanned: row.followupsPlanned,
        inQueue: row.inQueue,
        responseDetected: row.responseDetected,
        lastUpdated: row.lastUpdated,
        lastAction: row.lastAction
      };
      const itemId = byId.get(row.incidentId);
      if (itemId) {
        await graph(`/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/fields`, { method: 'PATCH', body: fields });
      } else {
        await graph(`/sites/${encodeURIComponent(siteId)}/lists/${encodeURIComponent(listId)}/items`, {
          method: 'POST', body: { fields }
        });
      }
    }
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: { lastSyncAt: new Date().toISOString(), itemCount: rows.length, error: null } });
    console.info(`[CDAX SharePoint] Synced ${rows.length} case(s) to ${CONFIG.listName}.`);
  })().catch(async error => {
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: { lastSyncAt: new Date().toISOString(), error: error.message } });
    console.warn('[CDAX SharePoint] Sync failed:', error);
    throw error;
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

function scheduleSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncNow().catch(() => {}), SYNC_DEBOUNCE_MS);
}

export function initSharePointSync() {
  chrome.contextMenus.create({ id: MENU_CONNECT, title: 'Connect / reconnect to SharePoint', contexts: ['action'] });
  chrome.contextMenus.create({ id: MENU_SYNC, title: 'Sync cases to SharePoint now', contexts: ['action'] });
  chrome.contextMenus.onClicked.addListener(async info => {
    if (info.menuItemId === MENU_CONNECT) {
      try {
        await signIn();
        await syncNow();
      } catch (e) {
        console.error('[CDAX SharePoint] Sign-in failed:', e);
        await chrome.storage.local.set({ [SYNC_STATE_KEY]: { error: e.message, lastSyncAt: new Date().toISOString() } });
      }
    } else if (info.menuItemId === MENU_SYNC) {
      syncNow().catch(() => {});
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.sequences || changes.monitorQueue)) scheduleSync();
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: MENU_CONNECT, title: 'Connect / reconnect to SharePoint', contexts: ['action'] });
      chrome.contextMenus.create({ id: MENU_SYNC, title: 'Sync cases to SharePoint now', contexts: ['action'] });
    });
  });
  // Session tokens are intentionally not saved to local/sync storage. If one is absent,
  // the user can explicitly reconnect from the extension's context menu.
  syncNow().catch(() => {});
}
