/* =====================================================================
 * SWR Tracker — QuickBooks Online → Firestore customer sync
 * ---------------------------------------------------------------------
 * Static PWA (GitHub Pages) can't hold the OAuth client secret, so the
 * whole QuickBooks connector lives here in Cloud Functions:
 *
 *   qbConnect   (HTTP)      -> redirects the admin to Intuit to authorize
 *   qbCallback  (HTTP)      -> OAuth redirect target; exchanges the code,
 *                              captures realmId, stores tokens in Firestore
 *   qbSyncNow   (callable)  -> "Sync Now" button; runs the sync on demand
 *   qbDailySync (scheduled) -> same sync, once per day
 *
 * Gen-1 functions are used so the OAuth redirect URI is predictable and
 * can be pre-registered in the Intuit Developer portal:
 *   https://us-central1-swr-tracker-54dfd.cloudfunctions.net/qbCallback
 *
 * Static client credentials live in Secret Manager (QBO_CLIENT_ID /
 * QBO_CLIENT_SECRET). The *rotating* OAuth tokens + realmId live in
 * Firestore at integrations/quickbooks — a path the security rules deny
 * to every client (the Admin SDK here bypasses rules), so the 3 trapper
 * accounts can never read them.
 * ===================================================================== */

const crypto = require('crypto');
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

/* ---------- Configuration ---------- */
const REGION = 'us-central1';

/* Sandbox credentials -> sandbox API. Flip to 'production' (and re-run the
 * OAuth connect against your production keys) when going live. The OAuth
 * authorize/token endpoints are identical across environments; only the
 * Accounting API base URL differs. */
const QBO_ENV = 'production';
const API_BASE = QBO_ENV === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const AUTH_ENDPOINT  = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES = 'com.intuit.quickbooks.accounting';
const REDIRECT_URI = `https://${REGION}-swr-tracker-54dfd.cloudfunctions.net/qbCallback`;
const MINOR_VERSION = '73';

const TOKEN_DOC = db.doc('integrations/quickbooks');
const STATE_DOC = db.doc('integrations/oauthState');
const SECRETS = ['QBO_CLIENT_ID', 'QBO_CLIENT_SECRET'];

/* Only these accounts may approve + push estimates to QuickBooks. Mirrors
 * ADMIN_EMAILS in the app. */
const ADMIN_EMAILS = ['jon@southern-wildlife.com'];

/* All SWR estimate lines map to a single generic QuickBooks Product/Service;
 * the human-readable category/species/detail goes in each line's Description. */
const SERVICE_ITEM_NAME = 'Wildlife Services';

/* ---- Field Information (Cuddeback CuddeLink) ingestion ---- */
const cb = require('./cuddeback-parse');
const MS_SECRETS = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'];
const PHOTOS_MAILBOX = 'photos@southern-wildlife.com';
const REPORT_TZ = 'America/New_York';
const CL_IMG_SENDER = 'images.cuddelink.com';
const CL_REPORT_SENDER = 'reports.cuddelink.com';

/* ---------- Small helpers ---------- */
function basicAuthHeader() {
  const id = process.env.QBO_CLIENT_ID;
  const secret = process.env.QBO_CLIENT_SECRET;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlPage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:14vh auto;padding:0 20px;color:#1c2b22;line-height:1.5}
h1{font-size:22px;color:#1d6b3b}code{background:#eef3ef;padding:2px 6px;border-radius:5px}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${bodyHtml}</p></body></html>`;
}

/* POST to the Intuit token endpoint (authorization_code or refresh_token). */
async function postToken(bodyObj) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams(bodyObj).toString()
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Token endpoint ${res.status}: ${text}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

/* Build the Firestore token record from an Intuit token response.
 * Intuit rotates the refresh token, so we always persist whatever it just
 * returned — never the old value. */
function tokenRecordFromResponse(json, extra = {}) {
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessTokenExpiresAt: new Date(now + (json.expires_in || 3600) * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now + (json.x_refresh_token_expires_in || 8640000) * 1000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    needsReauth: false,
    ...extra
  };
}

/* Return a live access token + realmId, refreshing (and rotating the stored
 * refresh token) if the current access token is within 60s of expiry. */
async function getValidAccessToken() {
  const snap = await TOKEN_DOC.get();
  if (!snap.exists) throw new Error('QuickBooks not connected — run the Connect flow first.');
  const t = snap.data();
  if (!t.realmId) throw new Error('QuickBooks connection missing realmId — reconnect.');

  const bufferMs = 60 * 1000;
  const stillValid = t.accessToken && t.accessTokenExpiresAt &&
    (Date.parse(t.accessTokenExpiresAt) - bufferMs) > Date.now();
  if (stillValid) return { accessToken: t.accessToken, realmId: t.realmId };

  if (!t.refreshToken) throw new Error('No refresh token stored — reconnect QuickBooks.');
  let json;
  try {
    json = await postToken({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
  } catch (err) {
    /* invalid_grant => the refresh token is dead (expired/revoked). Flag it so
     * the app can prompt a reconnect instead of silently failing forever. */
    await TOKEN_DOC.set({
      needsReauth: true,
      lastError: String(err.message).slice(0, 500),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    throw new Error('QuickBooks token refresh failed — reconnect required.');
  }
  const rec = tokenRecordFromResponse(json, {
    realmId: t.realmId,
    connectedAt: t.connectedAt || new Date().toISOString()
  });
  await TOKEN_DOC.set(rec, { merge: true });
  return { accessToken: rec.accessToken, realmId: rec.realmId };
}

/* ---------- QuickBooks Accounting API ---------- */
async function qboQuery(realmId, accessToken, query) {
  const url = `${API_BASE}/v3/company/${realmId}/query` +
    `?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QBO query ${res.status}: ${text}`);
  return JSON.parse(text);
}

/* Page through the full customer list (QBO caps a page at 1000 rows). */
async function fetchAllQboCustomers(realmId, accessToken) {
  const all = [];
  const pageSize = 1000;
  let start = 1;
  for (;;) {
    const q = `SELECT * FROM Customer STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
    const data = await qboQuery(realmId, accessToken, q);
    const page = (data.QueryResponse && data.QueryResponse.Customer) || [];
    all.push(...page);
    if (page.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

/* Map a QBO Customer to *contact* fields only. Anything not present in QBO
 * is omitted (never blanked) so we don't wipe manually-entered contact data. */
function contactFieldsFromQbo(c) {
  const out = {};
  const name = c.DisplayName || c.CompanyName ||
    [c.GivenName, c.FamilyName].filter(Boolean).join(' ').trim();
  if (name) out.name = name;
  const phone = c.PrimaryPhone && c.PrimaryPhone.FreeFormNumber;
  if (phone) out.phone = phone;
  const email = c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address;
  if (email) out.email = email;
  const addr = c.BillAddr || c.ShipAddr;
  if (addr) {
    const line = [addr.Line1, addr.Line2].filter(Boolean).join(' ').trim();
    if (line) out.address = line;
    if (addr.City) out.city = addr.City;
  }
  return out;
}

/* POST a resource to the QuickBooks API (create). */
async function qboPost(realmId, accessToken, resource, body) {
  const url = `${API_BASE}/v3/company/${realmId}/${resource}?minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QBO ${resource} POST ${res.status}: ${text}`);
  return JSON.parse(text);
}

/* Return the QuickBooks Item Id for the generic service item, creating it once
 * if needed. The Id is cached on the token doc to avoid a lookup per push. */
async function ensureServiceItemId(realmId, accessToken) {
  const snap = await TOKEN_DOC.get();
  const cached = snap.exists ? snap.data().serviceItemId : null;
  if (cached) return cached;

  const found = await qboQuery(realmId, accessToken,
    `SELECT Id, Name FROM Item WHERE Name = '${SERVICE_ITEM_NAME}'`);
  let item = found.QueryResponse && found.QueryResponse.Item && found.QueryResponse.Item[0];

  if (!item) {
    const acctData = await qboQuery(realmId, accessToken,
      `SELECT Id, Name FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
    const acct = acctData.QueryResponse && acctData.QueryResponse.Account && acctData.QueryResponse.Account[0];
    if (!acct) {
      throw new Error(`No income account found to auto-create the "${SERVICE_ITEM_NAME}" item — ` +
        `create a Product/Service named "${SERVICE_ITEM_NAME}" in QuickBooks and retry.`);
    }
    const created = await qboPost(realmId, accessToken, 'item', {
      Name: SERVICE_ITEM_NAME,
      Type: 'Service',
      IncomeAccountRef: { value: acct.Id }
    });
    item = created.Item;
  }
  await TOKEN_DOC.set({ serviceItemId: item.Id }, { merge: true });
  return item.Id;
}

/* ---------- The sync ----------
 * One-way, additive + update, keyed on qbId:
 *   - existing (qbId already in Firestore) -> merge CONTACT FIELDS ONLY.
 *     Never touches active / cameraId / county / notes (all app-owned).
 *   - new                                  -> create with active:false,
 *     source:'quickbooks', qbId.
 *   - QBO customers with no usable contact data are skipped.
 *   - Firestore rows absent from QBO are left untouched (no deletes). */
async function syncCustomers(meta = {}) {
  const { accessToken, realmId } = await getValidAccessToken();
  const qboCustomers = await fetchAllQboCustomers(realmId, accessToken);

  /* Build qbId -> Firestore docId map. Manual rows carry qbId:null and so
   * never collide with a QBO id. */
  const existingSnap = await db.collection('customers').get();
  const byQbId = new Map();
  existingSnap.forEach((d) => {
    const qbId = d.get('qbId');
    if (qbId) byQbId.set(String(qbId), d.id);
  });

  const nowIso = new Date().toISOString();
  let created = 0, updated = 0, skipped = 0;

  /* Batch writes in chunks (Firestore caps a batch at 500 ops). */
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const c of qboCustomers) {
    const qbId = String(c.Id);
    const contact = contactFieldsFromQbo(c);
    if (!Object.keys(contact).length) { skipped++; continue; }

    const existingId = byQbId.get(qbId);
    if (existingId) {
      batch.set(db.doc(`customers/${existingId}`),
        { ...contact, lastSyncedAt: nowIso, updatedAt: nowIso },
        { merge: true });
      updated++;
    } else {
      batch.set(db.collection('customers').doc(), {
        ...contact,
        qbId,
        source: 'quickbooks',
        active: false,                    // app-controlled; only ever set on create
        createdByUid: null,
        createdByEmail: 'quickbooks-sync',
        createdAt: nowIso,
        updatedAt: nowIso,
        lastSyncedAt: nowIso
      });
      created++;
    }
    if (++ops >= 450) await flush();
  }
  await flush();

  const result = { fetched: qboCustomers.length, created, updated, skipped, at: nowIso, ...meta };
  await TOKEN_DOC.set({ lastSyncAt: nowIso, lastSyncResult: result }, { merge: true });
  return result;
}

/* =====================================================================
 * Exported functions
 * ===================================================================== */

/* Step 1 of OAuth: redirect the admin to Intuit's consent screen. */
exports.qbConnect = functions
  .region(REGION)
  .runWith({ secrets: ['QBO_CLIENT_ID'] })
  .https.onRequest(async (req, res) => {
    const state = crypto.randomBytes(24).toString('hex');
    await STATE_DOC.set({ state, createdAt: new Date().toISOString() });
    const url = `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(process.env.QBO_CLIENT_ID)}` +
      `&response_type=code&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}`;
    res.redirect(url);
  });

/* Step 2 of OAuth: Intuit redirects back here with code + realmId. */
exports.qbCallback = functions
  .region(REGION)
  .runWith({ secrets: SECRETS })
  .https.onRequest(async (req, res) => {
    const { code, state, realmId, error, error_description } = req.query;
    if (error) {
      return res.status(400).send(htmlPage('QuickBooks authorization failed',
        escapeHtml(error_description || error)));
    }

    /* CSRF: the state must match the one we just issued and be recent. */
    const stateSnap = await STATE_DOC.get();
    const saved = stateSnap.exists ? stateSnap.data() : null;
    const fresh = saved && (Date.now() - Date.parse(saved.createdAt) < 10 * 60 * 1000);
    if (!saved || !fresh || saved.state !== state) {
      return res.status(400).send(htmlPage('Authorization rejected',
        'Invalid or expired state. Start again from “Connect QuickBooks”.'));
    }
    await STATE_DOC.delete().catch(() => {});

    if (!code || !realmId) {
      return res.status(400).send(htmlPage('Authorization incomplete',
        'Missing authorization code or company id (realmId).'));
    }

    try {
      const json = await postToken({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI
      });
      const rec = tokenRecordFromResponse(json, {
        realmId: String(realmId),
        env: QBO_ENV,
        connectedAt: new Date().toISOString(),
        /* Clear the cached generic-item id so it re-resolves for the newly
           connected company (e.g. switching sandbox → production). */
        serviceItemId: admin.firestore.FieldValue.delete()
      });
      await TOKEN_DOC.set(rec, { merge: true });
      return res.status(200).send(htmlPage('QuickBooks connected ✔',
        `Company <code>${escapeHtml(String(realmId))}</code> is now linked ` +
        `(${escapeHtml(QBO_ENV)}). You can close this tab and use ` +
        `<strong>Sync Now</strong> in the app.`));
    } catch (err) {
      console.error('Token exchange failed', err);
      return res.status(500).send(htmlPage('Token exchange failed', escapeHtml(err.message)));
    }
  });

/* Disconnect landing URL. Intuit redirects here when a user disconnects the
 * app from within QuickBooks (Apps → Disconnect). At that point Intuit has
 * already revoked the tokens, so we just clear our stored connection: drop the
 * tokens and flag needsReauth, which stops the daily sync from erroring and
 * tells the app to reconnect. */
exports.qbDisconnect = functions
  .region(REGION)
  .https.onRequest(async (req, res) => {
    try {
      await TOKEN_DOC.set({
        accessToken: admin.firestore.FieldValue.delete(),
        refreshToken: admin.firestore.FieldValue.delete(),
        needsReauth: true,
        disconnectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error('Disconnect cleanup failed', err);
    }
    res.status(200).send(htmlPage('QuickBooks disconnected',
      'This app has been disconnected from QuickBooks. To resume syncing, ' +
      'reconnect from the app’s Settings → Connect QuickBooks.'));
  });

/* "Sync Now" button — authenticated callable. */
exports.qbSyncNow = functions
  .region(REGION)
  .runWith({ secrets: SECRETS, timeoutSeconds: 300, memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    }
    try {
      return await syncCustomers({
        trigger: 'manual',
        by: (context.auth.token && context.auth.token.email) || context.auth.uid
      });
    } catch (err) {
      console.error('Manual sync failed', err);
      const needsConnect = /not connected|reconnect|refresh failed|realmId/i.test(err.message || '');
      throw new functions.https.HttpsError(
        needsConnect ? 'failed-precondition' : 'internal',
        err.message || 'Sync failed'
      );
    }
  });

/* Approve + push a single estimate to QuickBooks as an Estimate (quote).
 * Admin-only. Reuses getValidAccessToken() (refresh + rotation). The customer
 * is linked by the qbId already stored on the Firestore customer record. */
exports.qbPushEstimate = functions
  .region(REGION)
  .runWith({ secrets: SECRETS, timeoutSeconds: 120, memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    }
    const email = ((context.auth.token && context.auth.token.email) || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) {
      throw new functions.https.HttpsError('permission-denied',
        'Only an administrator can approve and push estimates.');
    }
    const estimateId = data && data.estimateId;
    if (!estimateId) {
      throw new functions.https.HttpsError('invalid-argument', 'estimateId is required.');
    }

    const estRef = db.doc(`estimates/${estimateId}`);
    const estSnap = await estRef.get();
    if (!estSnap.exists) throw new functions.https.HttpsError('not-found', 'Estimate not found.');
    const est = estSnap.data();

    if (!est.customerId) {
      throw new functions.https.HttpsError('failed-precondition', 'Estimate has no customer.');
    }
    const custSnap = await db.doc(`customers/${est.customerId}`).get();
    const qbId = custSnap.exists ? custSnap.get('qbId') : null;
    if (!qbId) {
      throw new functions.https.HttpsError('failed-precondition',
        'This customer isn’t linked to QuickBooks yet (no qbId). Make sure the customer ' +
        'exists in QuickBooks / run a customer sync, then retry.');
    }

    let accessToken, realmId;
    try {
      ({ accessToken, realmId } = await getValidAccessToken());
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition',
        err.message || 'QuickBooks not connected.');
    }

    try {
      const itemId = await ensureServiceItemId(realmId, accessToken);
      const lines = (est.lineItems || []).map((li) => ({
        DetailType: 'SalesItemLineDetail',
        Amount: Number(li.lineTotal) || 0,
        Description: [li.category, li.species, li.description].filter(Boolean).join(' – '),
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: Number(li.quantity) || 1,
          UnitPrice: Number(li.unitPrice) || 0
        }
      }));
      if (!lines.length) throw new Error('Estimate has no line items.');

      const payload = { CustomerRef: { value: String(qbId) }, Line: lines };
      if (est.estimateNumber) payload.DocNumber = est.estimateNumber;

      const result = await qboPost(realmId, accessToken, 'estimate', payload);
      const qbEstimateId = (result.Estimate && result.Estimate.Id) || null;

      await estRef.set({
        status: 'Pushed to QB',
        qbEstimateId,
        pushedAt: new Date().toISOString(),
        pushedByEmail: email,
        updatedAt: new Date().toISOString(),
        pushError: admin.firestore.FieldValue.delete()
      }, { merge: true });

      return {
        qbEstimateId,
        docNumber: est.estimateNumber || null,
        customerName: est.customerName || null,
        createdByEmail: est.createdByEmail || null
      };
    } catch (err) {
      console.error('Estimate push failed', err);
      await estRef.set({
        pushError: String(err.message).slice(0, 500),
        updatedAt: new Date().toISOString()
      }, { merge: true });
      throw new functions.https.HttpsError('internal', err.message || 'QuickBooks estimate push failed.');
    }
  });

/* Daily scheduled sync. */
exports.qbDailySync = functions
  .region(REGION)
  .runWith({ secrets: SECRETS, timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('every 24 hours')
  .timeZone('America/New_York')
  .onRun(async () => {
    try {
      const r = await syncCustomers({ trigger: 'scheduled' });
      console.log('Daily QBO sync complete', r);
    } catch (err) {
      console.error('Daily QBO sync failed', err);
    }
    return null;
  });

/* =====================================================================
 * Field Information — Cuddeback photo + report ingestion (Microsoft Graph)
 * ---------------------------------------------------------------------
 * Polls the photos@ shared mailbox with an app-only Graph token. Photo
 * emails (images.cuddelink.com) → JPEG to Firebase Storage + a cameraPhotos
 * doc matched to the active customer by subject key. Report emails
 * (reports.cuddelink.com) → parse the attached HTML → cameraHealth docs.
 * ===================================================================== */
async function graphToken() {
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    }).toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph token ${res.status}: ${text}`);
  return JSON.parse(text).access_token;
}
async function graphGet(token, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph GET ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function graphGetBytes(token, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph bytes GET ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
async function graphMarkRead(token, id) {
  await fetch(`https://graph.microsoft.com/v1.0/users/${PHOTOS_MAILBOX}/messages/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true })
  });
}

/* Build a camera-key → customer lookup. An explicit `cameraId` on a customer
 * wins (exact, any customer); otherwise fall back to a unique name-derived key
 * among ACTIVE customers. Ambiguous name-keys are dropped (→ unassigned). */
async function customerKeyMap() {
  const snap = await db.collection('customers').get();
  const byCam = new Map();
  const byName = new Map();
  const nameAmbiguous = new Set();
  snap.forEach((d) => {
    const cam = (d.get('cameraId') || '').trim().toUpperCase();
    if (cam) byCam.set(cam, { id: d.id, name: d.get('name') || '' });
    if (d.get('active')) {
      const key = cb.customerKeyFor(d.get('name'));
      if (key) {
        if (byName.has(key)) nameAmbiguous.add(key);
        else byName.set(key, { id: d.id, name: d.get('name') || '' });
      }
    }
  });
  nameAmbiguous.forEach((k) => byName.delete(k));
  return { get: (k) => byCam.get(k) || byName.get(k) || null };
}

async function handlePhotoMessage(token, m, keyMap) {
  const key = cb.subjectKey(m.subject);
  const match = key ? keyMap.get(key) : null;
  const atts = await graphGet(token, `/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments?$select=id,name,contentType,isInline`);
  const bucket = admin.storage().bucket();
  let photos = 0;
  for (const a of (atts.value || [])) {
    if (a.isInline || !/^image\//i.test(a.contentType || '')) continue;
    const buf = await graphGetBytes(token, `/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments/${a.id}/$value`);
    const dlToken = crypto.randomUUID();
    const safeName = (a.name || 'photo.jpg').replace(/[^\w.\-]/g, '_');
    const path = `cameraPhotos/${key || 'unassigned'}/${m.id}_${safeName}`;
    await bucket.file(path).save(buf, {
      resumable: false,
      metadata: { contentType: a.contentType || 'image/jpeg', metadata: { firebaseStorageDownloadTokens: dlToken } }
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${dlToken}`;
    await db.collection('cameraPhotos').add({
      customerKey: key || null,
      customerId: match ? match.id : null,
      customerName: match ? match.name : null,
      assigned: !!match,
      subject: m.subject || '',
      receivedAt: m.receivedDateTime || new Date().toISOString(),
      storagePath: path,
      url,
      source: 'cuddelink',
      createdByUid: null,
      createdByEmail: 'cuddelink-ingest',
      createdAt: new Date().toISOString()
    });
    photos++;
  }
  return { photos, unassigned: !match };
}

async function handleReportMessage(token, m, keyMap) {
  const atts = await graphGet(token, `/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments?$select=id,name,contentType,isInline`);
  const htmlAtt = (atts.value || []).find((a) => /html/i.test(a.contentType || '') || /\.html?$/i.test(a.name || ''));
  if (!htmlAtt) throw new Error('report message has no HTML attachment');
  const buf = await graphGetBytes(token, `/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments/${htmlAtt.id}/$value`);
  const parsed = cb.parseReportHtml(buf.toString('utf8'));
  if (!parsed || !parsed.network) throw new Error('could not parse report HTML');

  const today = cb.todayMDY(REPORT_TZ);
  const match = keyMap.get(parsed.network) || null;
  const nowIso = new Date().toISOString();
  const batch = db.batch();
  for (const d of parsed.devices) {
    const status = cb.deviceStatus(d, parsed.reportDate, today);
    batch.set(db.doc(`cameraHealth/${parsed.network}__${d.cameraNumber}`), {
      customerKey: parsed.network,
      customerId: match ? match.id : null,
      customerName: match ? match.name : null,
      cameraNumber: d.cameraNumber,
      cameraName: d.cameraName,
      mode: d.mode,
      reportDate: parsed.reportDate,
      battery: d.battery,
      batteryOk: !/low/i.test(d.battery || ''),
      sdFreeSpace: d.sdFreeSpace,
      sdFreeGB: d.sdFreeGB,
      photoQueue: d.photoQueue,
      fwVersion: d.fwVersion,
      clVersion: d.clVersion,
      deficiencies: cb.deviceDeficiencies(d),
      status,
      dateCurrent: parsed.reportDate === today,
      updatedAt: nowIso
    }, { merge: true });
  }
  await batch.commit();
  return { devices: parsed.devices.length };
}

/* Poll the mailbox: process unread photo + report messages, mark them read. */
async function ingestMailbox() {
  const token = await graphToken();
  const data = await graphGet(token,
    `/users/${PHOTOS_MAILBOX}/messages?$filter=isRead eq false&$top=25` +
    `&$select=id,subject,from,receivedDateTime,hasAttachments&$orderby=receivedDateTime desc`);
  const msgs = data.value || [];
  let photos = 0, reports = 0, unassigned = 0, skipped = 0;
  const keyMap = msgs.length ? await customerKeyMap() : { get: () => null };
  for (const m of msgs) {
    const sender = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    try {
      if (sender.includes(CL_IMG_SENDER)) {
        const r = await handlePhotoMessage(token, m, keyMap);
        photos += r.photos;
        if (r.unassigned) unassigned++;
      } else if (sender.includes(CL_REPORT_SENDER)) {
        await handleReportMessage(token, m, keyMap);
        reports++;
      } else {
        skipped++;
      }
      await graphMarkRead(token, m.id);
    } catch (err) {
      console.error('Ingest failed for message', m.id, err.message); // leave unread → retried next run
    }
  }
  return { processed: msgs.length, photos, reports, unassigned, skipped, at: new Date().toISOString() };
}

/* Scheduled poll every 15 minutes. */
exports.cuddebackIngest = functions
  .region(REGION)
  .runWith({ secrets: MS_SECRETS, timeoutSeconds: 300, memory: '512MB' })
  .pubsub.schedule('every 15 minutes')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    try {
      const r = await ingestMailbox();
      console.log('Cuddeback ingest complete', r);
    } catch (err) {
      console.error('Cuddeback ingest failed', err);
    }
    return null;
  });

/* Manual "Sync Now" for the Field Information module (authenticated). */
exports.fieldSyncNow = functions
  .region(REGION)
  .runWith({ secrets: MS_SECRETS, timeoutSeconds: 300, memory: '512MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    try {
      return await ingestMailbox();
    } catch (err) {
      console.error('Field sync failed', err);
      throw new functions.https.HttpsError('internal', err.message || 'Field sync failed');
    }
  });
