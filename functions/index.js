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
const QBO_ENV = 'sandbox';
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
        connectedAt: new Date().toISOString()
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
