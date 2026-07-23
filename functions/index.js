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

/* Operator email → display name. Mirrors EMAIL_TO_TRAPPER in the app. */
const EMAIL_TO_TRAPPER = {
  'jon@southern-wildlife.com': 'Jon Gassett',
  'robin@southern-wildlife.com': 'Robin Gassett',
  'chris@southern-wildlife.com': 'Chris Griffith',
  'tanya.clark0071@gmail.com': 'Tanya Clark'
};
const ALL_OPERATOR_EMAILS = Object.keys(EMAIL_TO_TRAPPER);

/* All SWR estimate lines map to a single generic QuickBooks Product/Service;
 * the human-readable category/species/detail goes in each line's Description. */
const SERVICE_ITEM_NAME = 'Wildlife Services';

/* ---- Monitoring module (Cuddeback CuddeLink) ingestion — Item 17 rename ---- */
const cb = require('./cuddeback-parse');
/* ---- v2-patch-8: server-side admin migrations (backfill + re-link) ---- */
const adminMigrations = require('./admin-migrations');
const MS_SECRETS = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET'];
const PHOTOS_MAILBOX = 'photos@NETORGFT3707352.onmicrosoft.com';
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

/* Item 7 (v2-patch-1): customer records may hold several addresses separated
 * by semicolons — every processing path (QB push, notifications) must use
 * only the first valid address. Mirrors extractPrimaryEmail in the app. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function extractPrimaryEmail(emailString) {
  if (!emailString) return '';
  const parts = String(emailString).split(';').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (EMAIL_RE.test(p)) return p;
  }
  return parts[0] || '';
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
  /* QBO can hold the number in any of these; take the first present. */
  const phone = (c.PrimaryPhone && c.PrimaryPhone.FreeFormNumber) ||
    (c.Mobile && c.Mobile.FreeFormNumber) ||
    (c.AlternatePhone && c.AlternatePhone.FreeFormNumber);
  if (phone) out.phone = phone;
  const email = c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address;
  if (email) out.email = email;
  const addr = c.BillAddr || c.ShipAddr;
  if (addr) {
    const line = [addr.Line1, addr.Line2].filter(Boolean).join(' ').trim();
    if (line) out.address = line;
    if (addr.City) out.city = addr.City;
    if (addr.PostalCode) out.zip = String(addr.PostalCode).trim();
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
  const countyById = new Map();   /* app-maintained county — QBO has none */
  existingSnap.forEach((d) => {
    const qbId = d.get('qbId');
    if (qbId) byQbId.set(String(qbId), d.id);
    countyById.set(d.id, d.get('county') || '');
  });

  /* Item 2 (v2-patch-7): the primary-property invariant is maintained here
   * too — QBO-created customers get a "Primary" property from their QBO
   * address, and QBO address changes flow into an auto-created primary
   * that has never been manually edited in the app. */
  const propSnap = await db.collectionGroup('properties').get();
  const propCountByCustomer = new Map();
  const syncablePrimary = new Map();   /* customerId -> {ref, address, city} */
  propSnap.forEach((d) => {
    const cid = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (!cid) return;
    propCountByCustomer.set(cid, (propCountByCustomer.get(cid) || 0) + 1);
    if (d.get('isPrimary') === true && d.get('autoCreated') === true && d.get('manuallyEdited') !== true) {
      syncablePrimary.set(cid, { ref: d.ref, address: d.get('address') || '', city: d.get('city') || '' });
    }
  });
  /* v2-patch-7 functional audit MEDIUM-2: carry the customer doc's county
     into a sync-created primary — QBO has no county, but the app-side
     customer record often does, and the tax/KDFWR resolution reads the
     property. */
  const primaryPropertyDoc = (customerId, contact, county) => ({
    customerId,
    siteNickname: 'Primary',
    address: contact.address || '',
    city: contact.city || '',
    county: county || '',
    insideCityLimits: null,
    cameraId: '',
    isPrimary: true,
    autoCreated: true,
    manuallyEdited: false,
    createdAt: new Date().toISOString(),
    createdByUid: null,
    createdByEmail: 'quickbooks-sync',
    updatedAt: new Date().toISOString()
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
      /* Primary-property maintenance for the synced address. */
      if (!propCountByCustomer.get(existingId)) {
        batch.set(db.doc(`customers/${existingId}`).collection('properties').doc(),
          primaryPropertyDoc(existingId, contact, countyById.get(existingId)));
        propCountByCustomer.set(existingId, 1);
        ops++;
      } else {
        const prim = syncablePrimary.get(existingId);
        if (prim && (contact.address || contact.city)
            && ((contact.address || prim.address) !== prim.address
                || (contact.city || prim.city) !== prim.city)) {
          const patch = { updatedAt: nowIso };
          if (contact.address) patch.address = contact.address;
          if (contact.city) patch.city = contact.city;
          batch.set(prim.ref, patch, { merge: true });
          ops++;
        }
      }
    } else {
      const custRef = db.collection('customers').doc();
      batch.set(custRef, {
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
      /* Item 2 (v2-patch-7): every new customer is born with its primary. */
      batch.set(custRef.collection('properties').doc(), primaryPropertyDoc(custRef.id, contact, ''));
      ops++;
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

/* Disconnect landing URL. Intuit redirects the *user's browser* here when they
 * disconnect the app from within QuickBooks (Apps → Disconnect). This is an
 * unauthenticated, unsigned redirect — anyone can hit the URL — so it MUST NOT
 * mutate stored state, or it becomes a one-request DoS on the integration
 * (wipe tokens / force a reconnect for everyone).
 *
 * We don't need to clear anything here anyway: once Intuit revokes the tokens,
 * the next sync's refresh gets invalid_grant and getValidAccessToken() already
 * sets needsReauth (and the app prompts a reconnect). So this handler is purely
 * informational. */
exports.qbDisconnect = functions
  .region(REGION)
  .https.onRequest((req, res) => {
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

    /* Atomically claim the push so two concurrent taps can't both POST to Intuit
       (C1), and a retry after an already-completed push can't duplicate (C2).
       Aborts if the estimate is already pushed or another push is in flight. The
       external Intuit POST happens AFTER this transaction commits — a Firestore
       transaction must never span a network call (it may be retried). */
    let est, qbId;
    try {
      const claim = await db.runTransaction(async (tx) => {
        const snap = await tx.get(estRef);
        if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Estimate not found.');
        const e = snap.data();
        if (e.qbEstimateId || e.qbEstimateIdRecovery) {
          throw new functions.https.HttpsError('failed-precondition', 'This estimate has already been pushed to QuickBooks.');
        }
        const inFlight = e.qbPushInProgress ? Date.parse(e.qbPushInProgress) : 0;
        if (inFlight && (Date.now() - inFlight) < 2 * 60 * 1000) {
          throw new functions.https.HttpsError('failed-precondition', 'A push for this estimate is already in progress — wait a moment before retrying.');
        }
        if (!e.customerId) {
          throw new functions.https.HttpsError('failed-precondition', 'Estimate has no customer.');
        }
        const custSnap = await tx.get(db.doc(`customers/${e.customerId}`));
        const cid = custSnap.exists ? custSnap.get('qbId') : null;
        if (!cid) {
          throw new functions.https.HttpsError('failed-precondition',
            'This customer isn’t linked to QuickBooks yet (no qbId). Make sure the customer ' +
            'exists in QuickBooks / run a customer sync, then retry.');
        }
        tx.update(estRef, { qbPushInProgress: new Date().toISOString() });
        return { est: e, qbId: cid };
      });
      est = claim.est; qbId = claim.qbId;
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err;
      throw new functions.https.HttpsError('aborted', err.message || 'Could not start the push.');
    }

    /* Cleared on every exit path below so a failed push doesn't wedge the lock. */
    const clearLock = () => ({ qbPushInProgress: admin.firestore.FieldValue.delete() });

    let accessToken, realmId;
    try {
      ({ accessToken, realmId } = await getValidAccessToken());
    } catch (err) {
      await estRef.set({ ...clearLock(), updatedAt: new Date().toISOString() }, { merge: true });
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

      /* C2 recovery: persist the QBO id BEFORE the full status write. If that
         write then fails, the id isn't lost and a retry won't create a duplicate
         — the transaction above also checks qbEstimateIdRecovery. */
      if (qbEstimateId) {
        await estRef.set({ qbEstimateIdRecovery: qbEstimateId, updatedAt: new Date().toISOString() }, { merge: true });
      }

      await estRef.set({
        status: 'Pushed to QB',
        qbEstimateId,
        pushedAt: new Date().toISOString(),
        pushedByEmail: email,
        updatedAt: new Date().toISOString(),
        ...clearLock(),
        qbEstimateIdRecovery: admin.firestore.FieldValue.delete(),
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
        ...clearLock(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
      throw new functions.https.HttpsError('internal', err.message || 'QuickBooks estimate push failed.');
    }
  });

/* Item 13 (v2-patch-1): qbConvertToInvoice removed — invoicing happens
 * exclusively in QuickBooks Online. The app only pushes estimates (quotes)
 * via qbPushEstimate and syncs customers. Deploying this file deletes the
 * qbConvertToInvoice function from the project. */

/* Create a Firestore customer in QuickBooks and store the returned qbId back
 * on the record. Called when an operator adds a customer in the app. */
exports.qbCreateCustomer = functions
  .region(REGION)
  .runWith({ secrets: SECRETS, timeoutSeconds: 60, memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    const customerId = data && data.customerId;
    if (!customerId) throw new functions.https.HttpsError('invalid-argument', 'customerId is required.');

    const ref = db.doc(`customers/${customerId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Customer not found.');
    const c = snap.data();
    if (c.qbId) return { qbId: c.qbId, alreadyLinked: true };  // already in QuickBooks
    if (!c.name) throw new functions.https.HttpsError('failed-precondition', 'Customer has no name.');

    let accessToken, realmId;
    try {
      ({ accessToken, realmId } = await getValidAccessToken());
    } catch (err) {
      throw new functions.https.HttpsError('failed-precondition', err.message || 'QuickBooks not connected.');
    }

    /* Prevent duplicate QBO customers: if one already exists with this exact
       DisplayName, link to it instead of creating a second. Covers the case
       where a manual customer wasn't linked at first (e.g. QBO was disconnected)
       and now matches a customer already present in QuickBooks. A failed lookup
       must not block creation, so fall through on error. */
    try {
      const escaped = String(c.name).replace(/'/g, "\\'");
      const dup = await qboQuery(realmId, accessToken,
        `SELECT Id FROM Customer WHERE DisplayName = '${escaped}'`);
      const existing = dup.QueryResponse && dup.QueryResponse.Customer && dup.QueryResponse.Customer[0];
      if (existing && existing.Id) {
        await ref.set({ qbId: existing.Id, updatedAt: new Date().toISOString() }, { merge: true });
        return { qbId: existing.Id, alreadyLinked: true };
      }
    } catch (err) {
      console.error('QBO duplicate-name lookup failed; proceeding to create', err);
    }

    const payload = { DisplayName: c.name };
    /* Item 7: QuickBooks gets only the first email of a semicolon list. */
    const primaryEmail = extractPrimaryEmail(c.email);
    if (primaryEmail) payload.PrimaryEmailAddr = { Address: primaryEmail };
    if (c.phone) payload.PrimaryPhone = { FreeFormNumber: c.phone };
    if (c.address || c.city || c.zip) {
      payload.BillAddr = {};
      if (c.address) payload.BillAddr.Line1 = c.address;
      if (c.city) payload.BillAddr.City = c.city;
      if (c.zip) payload.BillAddr.PostalCode = c.zip;
    }
    try {
      const result = await qboPost(realmId, accessToken, 'customer', payload);
      const qbId = (result.Customer && result.Customer.Id) || null;
      await ref.set({ qbId, updatedAt: new Date().toISOString() }, { merge: true });
      return { qbId };
    } catch (err) {
      console.error('QBO customer create failed', err);
      /* Surface QuickBooks' duplicate-name and validation errors to the app. */
      throw new functions.https.HttpsError('internal', err.message || 'QuickBooks customer create failed.');
    }
  });

/* =====================================================================
 * Web push (Firebase Cloud Messaging) — reusable notification foundation.
 * sendPushToEmails() is called by any feature (e.g. job assignments) to push
 * a data-only message to every registered device of the given operators.
 * ===================================================================== */
async function sendPushToEmails(emails, payload) {
  const list = [...new Set((emails || []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (!list.length) return { sent: 0, tokens: 0 };

  /* Collect device tokens. New format (v2): one pushTokens/{email} doc per
   * operator holding a `tokens` array (multiple devices per operator). Legacy
   * format (v1): one pushTokens/{token} doc per device with an `email` field.
   * Both are read so devices registered before the upgrade keep working. */
  const entries = [];   // { token, ref, legacy } — ref used for invalid-token cleanup
  const seen = new Set();
  const emailDocs = await db.getAll(...list.map((e) => db.collection('pushTokens').doc(e)));
  emailDocs.forEach((d) => {
    if (!d.exists) return;
    const arr = d.get('tokens');
    (Array.isArray(arr) ? arr : []).forEach((t) => {
      if (t && !seen.has(t)) { seen.add(t); entries.push({ token: t, ref: d.ref, legacy: false }); }
    });
  });
  /* Legacy docs may hold mixed-case emails, which a lowercased `in` query
     would miss — the collection is tiny (a few devices per operator), so
     scan it and match case-insensitively. */
  const wanted = new Set(list);
  const legacySnap = await db.collection('pushTokens').get();
  legacySnap.forEach((d) => {
    const t = d.get('token');
    const em = String(d.get('email') || '').toLowerCase();
    if (t && wanted.has(em) && !seen.has(t)) { seen.add(t); entries.push({ token: t, ref: d.ref, legacy: true }); }
  });
  if (!entries.length) return { sent: 0, tokens: 0 };

  const tokens = entries.map((e) => e.token);
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: {
      title: String(payload.title || 'SWR Tracker'),
      body: String(payload.body || ''),
      url: String(payload.url || 'https://jgassett.github.io/swr-tracker/'),
      tag: String(payload.tag || '')
    },
    webpush: { headers: { Urgency: 'high' } }
  });
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
        const e = entries[i];
        if (e.legacy) {
          e.ref.delete().catch(() => {});
        } else {
          e.ref.set({ tokens: admin.firestore.FieldValue.arrayRemove(e.token) }, { merge: true }).catch(() => {});
        }
      }
    }
  });
  return { sent: res.successCount, tokens: tokens.length };
}

/* In-app notification feed (Item 12): one doc per recipient in the
 * `notifications` collection. Used alongside sendPushToEmails so alerts land
 * both on the device (push) and in the app's bell feed. */
async function createNotifications(emails, payload) {
  const list = [...new Set((emails || []).filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (!list.length) return 0;
  const now = new Date().toISOString();
  const batch = db.batch();
  for (const email of list) {
    batch.set(db.collection('notifications').doc(), {
      recipientEmail: email,
      type: payload.type || 'general',
      title: String(payload.title || ''),
      body: String(payload.body || ''),
      relatedId: payload.relatedId || null,
      /* Item 6 (v2-patch-6): pinned notices stay at the top of the feed and
         are exempt from age-based cleanup until read/dismissed. */
      pinned: !!payload.pinned,
      read: false,
      createdAt: now
    });
  }
  await batch.commit();
  return list.length;
}

/* Camera health alerting (Item 14): every operator gets both a device push
 * and an in-app feed entry. */
async function notifyAllOperators(payload) {
  try { await sendPushToEmails(ALL_OPERATOR_EMAILS, payload); }
  catch (e) { console.error('operator push failed', e); }
  try { await createNotifications(ALL_OPERATOR_EMAILS, payload); }
  catch (e) { console.error('operator feed notification failed', e); }
}

async function propertyNickname(customerId, propertyId) {
  if (!customerId || !propertyId) return null;
  try {
    const snap = await db.doc(`customers/${customerId}/properties/${propertyId}`).get();
    return snap.exists ? (snap.get('siteNickname') || null) : null;
  } catch (e) { return null; }
}

/* Dedup (Item 14): no repeat notification for the same camera + condition
 * within 2 hours — lastNotifiedAt map on the camera record enforces it.
 * set(..., {merge:true}) deep-merges the map so per-condition keys don't
 * clobber each other. */
const CAMERA_ALERT_WINDOW_MS = 2 * 60 * 60 * 1000;
/* M16: the dedup stamp is CLAIMED in a transaction before sending — two
 * concurrent ingests (scheduled poll + manual Sync Now) both passed the old
 * stale in-memory check and double-alerted every operator. The transaction
 * loser sees the fresh stamp and skips. (existingData is no longer trusted
 * for the check; kept in the signature for the call sites.) */
async function maybeSendCameraAlert(docRef, existingData, condKey, body, relatedId) {
  const now = Date.now();
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const map = (snap.exists && snap.get('lastNotifiedAt')) || {};
      const prev = map[condKey] ? Date.parse(map[condKey]) : 0;
      if (prev && now - prev < CAMERA_ALERT_WINDOW_MS) return false;
      tx.set(docRef, { lastNotifiedAt: { [condKey]: new Date(now).toISOString() } }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('camera alert dedup claim failed', e);
    return false;
  }
  if (!claimed) return false;
  await notifyAllOperators({ type: 'camera', title: 'Camera health alert', body, relatedId, tag: `cam-${condKey}-${relatedId}` });
  return true;
}

/* Item 3 (v2-patch-1): Mapbox address autocomplete — the public token is
 * served from Secret Manager so it is never hardcoded in the client bundle.
 * The client fetches it once per session via this authenticated callable; if
 * the secret is missing or the call fails, the app silently falls back to
 * manual address entry.
 *
 * TODO: add the Mapbox public token to Firebase Secret Manager before the
 * next functions deploy (token value to be provided separately):
 *   firebase functions:secrets:set MAPBOX_PUBLIC_TOKEN
 */
exports.getMapboxToken = functions
  .region(REGION)
  .runWith({ secrets: ['MAPBOX_PUBLIC_TOKEN'], memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    const token = process.env.MAPBOX_PUBLIC_TOKEN || '';
    if (!token) {
      throw new functions.https.HttpsError('failed-precondition', 'Mapbox token not configured.');
    }
    return { token };
  });

/* Send a test push to the caller's own devices (verifies the whole pipeline). */
exports.sendTestPush = functions
  .region(REGION)
  .runWith({ memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    const email = (context.auth.token && context.auth.token.email) || null;
    if (!email) throw new functions.https.HttpsError('failed-precondition', 'No email on your account.');
    try {
      return await sendPushToEmails([email], { title: 'SWR Tracker', body: 'Test notification — push is working ✅' });
    } catch (err) {
      console.error('sendTestPush failed', err);
      throw new functions.https.HttpsError('internal', err.message || 'Push send failed');
    }
  });

/* Notify an appointment's assigned contractors (web push). Reads the job (and,
 * when given, the appointment subcollection doc) server-side so a client can't
 * spam arbitrary push messages — it may only trigger notifications for the
 * operators recorded on a real appointment. Handles both eras of the data
 * model: legacy Schedule docs (the job doc IS the appointment: date/startTime/
 * type/assignees) and v2 lifecycle jobs (jobs/{jobId}/appointments/{apptId}
 * with scheduledDate/scheduledTime/visitType/assignedOperators).
 * The push body includes date, time, job type, customer name, and which
 * contractor it is assigned to (Item 1). */
exports.notifyJobAssignment = functions
  .region(REGION)
  .runWith({ memory: '256MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
    const jobId = data && data.jobId;
    const appointmentId = data && data.appointmentId;
    if (!jobId) throw new functions.https.HttpsError('invalid-argument', 'jobId is required.');
    const jobSnap = await db.collection('jobs').doc(String(jobId)).get();
    if (!jobSnap.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
    const job = jobSnap.data() || {};

    /* Legacy schedule docs double as the appointment record. */
    let a = job;
    if (appointmentId) {
      const apptSnap = await db.collection('jobs').doc(String(jobId))
        .collection('appointments').doc(String(appointmentId)).get();
      if (!apptSnap.exists) throw new functions.https.HttpsError('not-found', 'Appointment not found.');
      a = apptSnap.data() || {};
    }

    const emails = (Array.isArray(a.assignedOperators) && a.assignedOperators.length ? a.assignedOperators
      : Array.isArray(a.assignees) ? a.assignees : []).filter(Boolean);
    if (!emails.length) return { sent: 0 };

    const dateStr = a.scheduledDate || a.date || '';
    const timeStr = a.scheduledTime || a.startTime || '';
    const jobType = a.visitType || a.type || job.type || '';
    const customerName = a.customerName || job.customerName || '';
    /* Reschedules/reassignments notify too — same payload, accurate title. */
    const title = (data && data.event === 'updated') ? 'Appointment updated' : 'New appointment scheduled';

    let sent = 0, tokens = 0;
    /* One personalized push per contractor: "…Assigned to <name>". Push and
       bell feed are independent: a push failure (expired tokens, FCM outage)
       must not skip the feed write for this or any later recipient. */
    for (const email of emails) {
      const name = EMAIL_TO_TRAPPER[String(email).toLowerCase()] || email;
      const body = [
        [dateStr, timeStr].filter(Boolean).join(' '),
        jobType,
        customerName,
        `Assigned to ${name}`
      ].filter(Boolean).join(' · ');
      try {
        const r = await sendPushToEmails([email], {
          title,
          body,
          url: './',
          tag: `appt-${appointmentId || jobId}`
        });
        sent += r.sent; tokens += r.tokens;
      } catch (err) {
        console.error('appointment push failed', email, err);
      }
      /* Mirror into the in-app bell feed (Item 12). */
      await createNotifications([email], {
        type: 'appointment',
        title,
        body,
        relatedId: appointmentId || jobId
      }).catch((e) => console.error('appointment feed notification failed', e));
    }
    return { sent, tokens };
  });

/* Daily cleanup (Item 4, v2-patch-1): delete camera photos older than the
 * in-app retention setting (org/swr.photoRetentionDays, 1–30, default 30) —
 * both the Storage file and the Firestore record.
 *
 * Audit fixes:
 *  - Storage deletes were fire-and-forget and UNAWAITED — Cloud Functions
 *    terminates background work once onRun resolves, so the files were
 *    frequently never deleted (and errors were swallowed) while the
 *    Firestore docs disappeared. Deletes are now awaited per file; a failed
 *    file delete KEEPS the Firestore doc so the photo is retried next run
 *    instead of orphaning the file forever.
 *  - Pinned to a deterministic nightly slot (03:30 America/New_York)
 *    instead of the floating "every 24 hours" interval.
 *  - Retention setting is read from org/swr.photoRetentionDays (the exact
 *    path Settings writes), coerced with Number(), clamped to 1–30, and
 *    converted to an ISO cutoff compared against each photo's receivedAt.
 *  - Every run writes a photoCleanupLog doc: timestamp, retention used,
 *    count deleted, and any errors. */
exports.cleanupCameraPhotos = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '256MB' })
  .pubsub.schedule('every day 03:30')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    const startedAt = new Date().toISOString();
    const errors = [];
    let deleted = 0;
    let days = 30;
    let candidates = 0;
    try {
      const orgSnap = await db.doc('org/swr').get();
      const raw = orgSnap.exists ? orgSnap.get('photoRetentionDays') : null;
      days = Number(raw);
      if (!Number.isFinite(days) || days < 1) days = 30;
      if (days > 30) days = 30;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const snap = await db.collection('cameraPhotos').where('receivedAt', '<', cutoff).get();
      candidates = snap.size;
      const bucket = admin.storage().bucket();
      let batch = db.batch();
      let ops = 0;
      for (const d of snap.docs) {
        const path = d.get('storagePath');
        if (path) {
          try {
            await bucket.file(path).delete();
          } catch (err) {
            const code = err && (err.code || (err.errors && err.errors[0] && err.errors[0].reason));
            if (code === 404 || code === 'notFound') {
              /* File already gone — still remove the metadata doc below. */
            } else {
              errors.push(`storage ${path}: ${String((err && err.message) || err).slice(0, 200)}`);
              continue;   /* keep the doc; retried on the next run */
            }
          }
        }
        batch.delete(d.ref);
        deleted++;
        if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
      if (ops) await batch.commit();
      console.log(`cleanupCameraPhotos: ${deleted}/${candidates} photos older than ${days} days deleted, ${errors.length} errors`);
    } catch (err) {
      errors.push(`run: ${String((err && err.message) || err).slice(0, 300)}`);
      console.error('cleanupCameraPhotos failed', err);
    }
    /* Item 4: audit trail — one log doc per run, success or failure. */
    try {
      await db.collection('photoCleanupLog').add({
        at: startedAt,
        finishedAt: new Date().toISOString(),
        retentionDays: days,
        candidates,
        deleted,
        errorCount: errors.length,
        errors: errors.slice(0, 20)
      });
    } catch (err) {
      console.error('photoCleanupLog write failed', err);
    }
    return null;
  });

/* M12: the notifications feed is append-only (camera alerts fan out to every
 * operator daily) — without cleanup it grows unbounded and the client
 * subscription downloads the whole history each session. Read state lives on
 * each doc, so anything older than 60 days is history nobody scrolls to.
 * Single-field range query — no composite index required. */
exports.cleanupNotifications = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .pubsub.schedule('every 24 hours')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    try {
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
      const snap = await db.collection('notifications').where('createdAt', '<', cutoff).get();
      if (snap.empty) { console.log('cleanupNotifications: nothing older than 60 days'); return null; }
      let batch = db.batch(); let ops = 0; let deleted = 0;
      for (const d of snap.docs) {
        /* Item 6 (v2-patch-6): a pinned notice (KDFWR rollover) survives
           every age-based cleanup until it has been read/dismissed. */
        if (d.get('pinned') === true && d.get('read') !== true) continue;
        batch.delete(d.ref); ops++; deleted++;
        if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
      if (ops) await batch.commit();
      console.log(`cleanupNotifications: deleted ${deleted} notifications older than 60 days`);
    } catch (err) {
      console.error('cleanupNotifications failed', err);
    }
    return null;
  });

/* Item 8 (v2-patch-5): daily cleanup of READ notifications older than 30
 * days, across all operators. Complements cleanupNotifications (which
 * removes everything past 60 days regardless of read state) by pruning the
 * already-read history sooner. Single-field range query on createdAt (no
 * composite index needed); the read flag is filtered in code. */
exports.cleanupReadNotifications = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .pubsub.schedule('every day 04:00')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const snap = await db.collection('notifications').where('createdAt', '<', cutoff).get();
      const stale = snap.docs.filter((d) => d.get('read') === true);
      if (!stale.length) { console.log('cleanupReadNotifications: no read notifications older than 30 days'); return null; }
      let batch = db.batch(); let ops = 0; let deleted = 0;
      for (const d of stale) {
        batch.delete(d.ref); deleted++;
        if (++ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
      }
      if (ops) await batch.commit();
      console.log(`cleanupReadNotifications: deleted ${deleted} read notifications older than 30 days`);
    } catch (err) {
      console.error('cleanupReadNotifications failed', err);
    }
    return null;
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
 * Monitoring — Cuddeback photo + report ingestion (Microsoft Graph)
 * ---------------------------------------------------------------------
 * Polls the photos@ shared mailbox with an app-only Graph token. Photo
 * emails (images.cuddelink.com) → JPEG to Firebase Storage + a cameraPhotos
 * doc matched to the active customer by subject key. Report emails
 * (reports.cuddelink.com) → parse the attached HTML → cameraHealth docs.
 * ===================================================================== */
/* ---- Graph auth hardening (Item 7) ----
 * The app-only token is cached per function instance and refreshed
 * PROACTIVELY five minutes before its expiry, so requests never go out with
 * a token that's about to lapse. Every request runs through graphFetch(),
 * which — should a 401 still slip through (revocation, clock skew) —
 * refreshes the token and retries the request exactly once before failing,
 * so a single 401 never loses a photo. All 401s are logged to the
 * `graphErrors` Firestore collection with timestamp + email subject. */
let _graphTokenCache = { token: null, expiresAt: 0 };

async function graphToken(forceRefresh = false) {
  const REFRESH_BUFFER_MS = 5 * 60 * 1000;
  if (!forceRefresh && _graphTokenCache.token && Date.now() < _graphTokenCache.expiresAt - REFRESH_BUFFER_MS) {
    return _graphTokenCache.token;
  }
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
  const json = JSON.parse(text);
  _graphTokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
  };
  return _graphTokenCache.token;
}

async function logGraphError(status, path, context = {}) {
  try {
    await db.collection('graphErrors').add({
      at: new Date().toISOString(),
      status: status || null,
      path: String(path || '').slice(0, 300),
      subject: context.subject || null,
      /* Item 10 (v2-patch-5): the camera-key extraction attempt, so a
         status email that matched no camera record is diagnosable. */
      cameraKey: context.cameraKey || null,
      message: context.message || null
    });
  } catch (e) {
    console.error('graphErrors log failed', e);
  }
}

/* Authenticated Graph request with 401 refresh-and-retry-once. */
async function graphFetch(path, options = {}, context = {}) {
  const url = path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`;
  const doFetch = async (t) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${t}` }
  });
  let res = await doFetch(await graphToken());
  if (res.status === 401) {
    console.warn('Graph 401 — refreshing token and retrying once', path);
    await logGraphError(401, path, { ...context, message: 'Graph 401 — token refreshed, request retried' });
    res = await doFetch(await graphToken(true));
    if (res.status === 401) {
      await logGraphError(401, path, { ...context, message: 'Graph 401 persisted after token refresh — request failed' });
    }
  }
  return res;
}

async function graphGet(path, context = {}) {
  const res = await graphFetch(path, { headers: { Accept: 'application/json' } }, context);
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph GET ${res.status}: ${text}`);
  return JSON.parse(text);
}
async function graphGetBytes(path, context = {}) {
  const res = await graphFetch(path, {}, context);
  if (!res.ok) throw new Error(`Graph bytes GET ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
async function graphMarkRead(id, context = {}) {
  await graphFetch(`/users/${PHOTOS_MAILBOX}/messages/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isRead: true })
  }, context);
}

/* Build a camera-key → customer lookup. Item 1 (v2-patch-6): PROPERTY
 * records are the single source of truth for camera assignment — the only
 * match is an exact cameraId on a property record, which links the photo to
 * both the customer AND the specific property. Customer-level cameraId
 * (deprecated; stale fields may remain on old docs) and name-derived keys
 * are no longer consulted; an unmatched key ingests unassigned and surfaces
 * in the Monitoring pending queue for manual assignment. */
async function customerKeyMap() {
  const snap = await db.collection('customers').get();
  const nameById = new Map();
  snap.forEach((d) => nameById.set(d.id, d.get('name') || ''));
  const byCam = new Map();
  const propSnap = await db.collectionGroup('properties').get();
  propSnap.forEach((d) => {
    const cam = (d.get('cameraId') || '').trim().toUpperCase();
    if (!cam) return;
    const customerId = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (!customerId) return;
    byCam.set(cam, { id: customerId, name: nameById.get(customerId) || '', propertyId: d.id });
  });
  return { get: (k) => byCam.get(k) || null };
}

async function handlePhotoMessage(m, keyMap) {
  const ctx = { subject: m.subject || '' };
  const key = cb.subjectKey(m.subject);
  const match = key ? keyMap.get(key) : null;
  const atts = await graphGet(`/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments?$select=id,name,contentType,isInline`, ctx);
  const bucket = admin.storage().bucket();
  let photos = 0;
  for (const a of (atts.value || [])) {
    if (a.isInline || !/^image\//i.test(a.contentType || '')) continue;
    const buf = await graphGetBytes(`/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments/${a.id}/$value`, ctx);
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
      propertyId: (match && match.propertyId) || null,
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
  return { photos, unassigned: !match, key, match, receivedAt: m.receivedDateTime || new Date().toISOString() };
}

/* Item 10 (v2-patch-5): a status report that can't be parsed or matched must
 * never vanish silently (or loop unread forever). Log the raw subject, the
 * camera-key extraction attempt, and the failure reason to graphErrors, and
 * drop a pending-queue row into cameraHealth — the same manual-assignment
 * pattern unmatched photos use: it surfaces in the Monitoring module as an
 * unlinked group Jon can assign to a customer. */
async function queueUnmatchedReport(m, keyAttempt, reason) {
  await logGraphError(null, 'cuddeback-report', {
    subject: m.subject || '',
    cameraKey: keyAttempt || null,
    message: `status report not ingested: ${reason}`
  });
  try {
    const key = keyAttempt || 'UNKNOWN';
    await db.doc(`cameraHealth/${key}__pending`).set({
      customerKey: key,
      customerId: null,
      customerName: null,
      propertyId: null,
      cameraNumber: '—',
      cameraName: 'Status report (needs manual review)',
      mode: null,
      reportDate: null,
      battery: null,
      batteryOk: null,
      sdFreeSpace: null,
      sdFreeGB: null,
      photoQueue: null,
      fwVersion: null,
      clVersion: null,
      deficiencies: [],
      status: 'red',
      dateCurrent: false,
      pending: true,
      pendingReason: String(reason).slice(0, 300),
      subject: m.subject || '',
      receivedAt: m.receivedDateTime || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.error('pending report queue write failed', e);
  }
}

async function handleReportMessage(m, keyMap) {
  const ctx = { subject: m.subject || '' };
  const keyAttempt = cb.subjectKey(m.subject);
  const atts = await graphGet(`/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments?$select=id,name,contentType,isInline`, ctx);
  const htmlAtt = (atts.value || []).find((a) => /html/i.test(a.contentType || '') || /\.html?$/i.test(a.name || ''));
  if (!htmlAtt) {
    /* Not retryable — queue it and mark the message read (Item 10). */
    await queueUnmatchedReport(m, keyAttempt, 'report message has no HTML attachment');
    return { devices: 0, pending: true };
  }
  const buf = await graphGetBytes(`/users/${PHOTOS_MAILBOX}/messages/${m.id}/attachments/${htmlAtt.id}/$value`, ctx);
  const parsed = cb.parseReportHtml(buf.toString('utf8'));
  if (!parsed || !parsed.network) {
    await queueUnmatchedReport(m, keyAttempt, 'could not parse report HTML (no table or Network header — possible new firmware format)');
    return { devices: 0, pending: true };
  }
  if (!parsed.devices.length) {
    await queueUnmatchedReport(m, parsed.network || keyAttempt, 'report parsed but contained no device rows (unrecognized row format)');
    return { devices: 0, pending: true };
  }

  const today = cb.todayMDY(REPORT_TZ);
  const match = keyMap.get(parsed.network) || null;
  if (!match) {
    /* Rows below are still written (unassigned) — the existing unmatched
       pattern; this log makes the miss visible with the attempted key. */
    await logGraphError(null, 'cuddeback-report', {
      subject: m.subject || '',
      cameraKey: parsed.network,
      message: `status report network "${parsed.network}" matched no camera record — health rows written unassigned for manual assignment`
    });
  }
  const nowIso = new Date().toISOString();
  const batch = db.batch();
  for (const d of parsed.devices) {
    const status = cb.deviceStatus(d, parsed.reportDate, today);
    batch.set(db.doc(`cameraHealth/${parsed.network}__${d.cameraNumber}`), {
      customerKey: parsed.network,
      customerId: match ? match.id : null,
      customerName: match ? match.name : null,
      propertyId: (match && match.propertyId) || null,
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

  /* A daily status report proves the camera network is alive — refresh
     lastSeen so the 6.5-hour watchdog doesn't flag a healthy network that
     simply had no animal activity (photos are motion-triggered). Only move
     lastSeen forward; a newer photo timestamp must win. */
  try {
    const reportSeen = m.receivedDateTime || nowIso;
    const statusRef = db.doc(`cameraStatus/${parsed.network}`);
    const statusSnap = await statusRef.get();
    const prevSeen = statusSnap.exists ? (statusSnap.get('lastSeen') || '') : '';
    if (!prevSeen || reportSeen > prevSeen) {
      await statusRef.set({
        customerKey: parsed.network,
        customerId: match ? match.id : null,
        customerName: match ? match.name : null,
        propertyId: (match && match.propertyId) || null,
        lastSeen: reportSeen,
        updatedAt: nowIso
      }, { merge: true });
    }
  } catch (err) {
    console.error('cameraStatus lastSeen refresh from report failed', parsed.network, err);
  }

  /* Item 14: any camera failing the green threshold in the daily status
     email alerts every operator — battery low, SD card at/above 90%
     capacity (free space below threshold), an error flag (photo queue
     backlog), or no daily status report received for that camera. 2-hour
     per-camera-per-condition dedup via lastNotifiedAt. */
  try {
    const nickname = await propertyNickname(match ? match.id : null, match ? match.propertyId : null);
    const healthSnap = await db.collection('cameraHealth').where('customerKey', '==', parsed.network).get();
    const inReport = new Set(parsed.devices.map((d) => String(d.cameraNumber)));
    for (const hd of healthSnap.docs) {
      const h = hd.data();
      const conds = [];
      const d = parsed.devices.find((x) => String(x.cameraNumber) === String(h.cameraNumber));
      if (d) {
        const defs = cb.deviceDeficiencies(d);
        if (defs.includes('battery')) conds.push(['battery', 'battery level low']);
        if (defs.includes('sd')) conds.push(['sd', 'SD card at or above 90% capacity']);
        if (defs.includes('queue')) conds.push(['queue', `error flag: photo queue backlog (${d.photoQueue} queued)`]);
      } else if (!inReport.has(String(h.cameraNumber))) {
        /* Retirement cutoff: a camera absent from reports for over 7 days
           is considered removed — stop alerting about it daily forever.
           reportDate/updatedAt are only written while the camera still
           appears in reports, so they mark its last known appearance. */
        const lastAppeared = Date.parse(h.reportDate || '') || Date.parse(h.updatedAt || '') || 0;
        const RETIRED_MS = 7 * 24 * 60 * 60 * 1000;
        if (!lastAppeared || Date.now() - lastAppeared <= RETIRED_MS) {
          conds.push(['noreport', 'no daily status report received for this camera']);
        }
      }
      for (const [condKey, condText] of conds) {
        const camLabel = `${parsed.network} #${h.cameraNumber}${h.cameraName ? ` (${h.cameraName})` : ''}`;
        const body = [`Camera ${camLabel}`, h.customerName || (match && match.name) || null, nickname, condText]
          .filter(Boolean).join(' · ');
        await maybeSendCameraAlert(hd.ref, h, condKey, body, hd.id);
      }
    }
  } catch (err) {
    console.error('camera report alerting failed', err);
  }

  return { devices: parsed.devices.length };
}

/* =====================================================================
 * Item 15 (v2-patch-5): 30-day job duration reminder — Cloud Scheduler,
 * daily. Any lifecycle job (has a jobNumber) that has been Active for 30+
 * days without being closed sends a push and in-app notification to
 * jon@southern-wildlife.com ONLY, repeating every 30 days (tracked via
 * lastDurationReminderAt on the job doc) until the job is closed.
 * ===================================================================== */
exports.jobDurationReminder = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 300, memory: '256MB' })
  .pubsub.schedule('every day 05:00')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    const REMIND_MS = 30 * 24 * 60 * 60 * 1000;
    const JON = 'jon@southern-wildlife.com';
    try {
      const snap = await db.collection('jobs').where('status', '==', 'Active').get();
      const now = Date.now();
      let sent = 0;
      for (const d of snap.docs) {
        const j = d.data();
        if (!j.jobNumber) continue;   /* legacy schedule docs aren't jobs */
        const activeSince = Date.parse(j.startDate || j.createdAt || '') || 0;
        if (!activeSince || now - activeSince < REMIND_MS) continue;
        const last = j.lastDurationReminderAt ? Date.parse(j.lastDurationReminderAt) : 0;
        if (last && now - last < REMIND_MS) continue;   /* repeats every 30 days */
        const days = Math.floor((now - activeSince) / 86400000);
        const payload = {
          type: 'job',
          title: 'Job still open — 30 days',
          body: `${j.jobNumber} · ${j.customerName || 'no customer'} · open ${days} days. Consider closing this job or extending it.`,
          relatedId: d.id,
          tag: `job-duration-${d.id}`
        };
        try { await sendPushToEmails([JON], payload); }
        catch (e) { console.error('job duration push failed', d.id, e); }
        try { await createNotifications([JON], payload); }
        catch (e) { console.error('job duration feed notification failed', d.id, e); }
        await d.ref.set({ lastDurationReminderAt: new Date(now).toISOString() }, { merge: true });
        sent++;
      }
      console.log(`jobDurationReminder: ${sent} reminder${sent === 1 ? '' : 's'} sent`);
    } catch (err) {
      console.error('jobDurationReminder failed', err);
    }
    return null;
  });

/* =====================================================================
 * Item 6 (v2-patch-6): KDFWR reporting-period automation. The cycle is
 * hard-coded — Feb 1 through Jan 31, rolling automatically each year; the
 * period is no longer user-editable in the app. Daily check at 06:00 ET:
 *  - Jan 25 (through Jan 31 as a catch-up window): advance notice to Jon
 *    ONLY — the reporting period closes Jan 31; prepare the KDFWR annual
 *    report.
 *  - Feb 1 (any February day as a catch-up window): notice to Jon that the
 *    period has closed and the just-ended period's report must be
 *    downloaded (Export → Prior period) and submitted, then org/swr is
 *    rolled to the new period. The in-app notice is PINNED — it stays in
 *    the Notifications feed, exempt from age-based cleanup, until Jon
 *    dismisses it.
 * Dedup: org/swr.kdfwrAdvanceNoticeFor / kdfwrRolloverFor record the cycle
 * already handled, so retries and catch-up days can't repeat a notice.
 * ===================================================================== */
exports.kdfwrPeriodRollover = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every day 06:00')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    const JON = 'jon@southern-wildlife.com';
    try {
      /* Calendar date in the report timezone, not UTC. */
      const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: REPORT_TZ });
      const [y, m, d] = todayIso.split('-').map(Number);
      const orgRef = db.doc('org/swr');
      const orgSnap = await orgRef.get();
      const org = orgSnap.exists ? orgSnap.data() : {};

      if (m === 1 && d >= 25) {
        /* The period closing Jan 31 of year y started Feb 1 of y-1. */
        const startYear = y - 1;
        if (org.kdfwrAdvanceNoticeFor !== startYear) {
          const payload = {
            type: 'kdfwr',
            title: 'KDFWR reporting period closes Jan 31',
            body: `The current KDFWR reporting period (Feb 1, ${startYear} – Jan 31, ${y}) closes on January 31. Prepare the KDFWR annual report.`,
            relatedId: 'kdfwr-period',
            tag: `kdfwr-advance-${startYear}`
          };
          try { await sendPushToEmails([JON], payload); }
          catch (e) { console.error('KDFWR advance push failed', e); }
          try { await createNotifications([JON], payload); }
          catch (e) { console.error('KDFWR advance feed notification failed', e); }
          await orgRef.set({ kdfwrAdvanceNoticeFor: startYear }, { merge: true });
          console.log(`kdfwrPeriodRollover: advance notice sent for period starting ${startYear}`);
        }
      }

      if (m === 2 && org.kdfwrRolloverFor !== y) {
        const endedStartYear = y - 1;
        const payload = {
          type: 'kdfwr',
          title: 'KDFWR period closed — submit the annual report',
          body: `The KDFWR reporting period Feb 1, ${endedStartYear} – Jan 31, ${y} has closed. Download the PRIOR period's KDFWR CSV from the Export screen and submit it to KDFWR. This notice stays pinned until you dismiss it.`,
          relatedId: 'kdfwr-period',
          tag: `kdfwr-rollover-${y}`,
          pinned: true
        };
        try { await sendPushToEmails([JON], payload); }
        catch (e) { console.error('KDFWR rollover push failed', e); }
        try { await createNotifications([JON], payload); }
        catch (e) { console.error('KDFWR rollover feed notification failed', e); }
        /* Roll org/swr to the new period (server-maintained bookkeeping —
           the app computes the cycle itself and never edits these). */
        await orgRef.set({
          kdfwrRolloverFor: y,
          reportingPeriodStart: `${y}-02-01`,
          reportingPeriodEnd: `${y + 1}-01-31`
        }, { merge: true });
        console.log(`kdfwrPeriodRollover: rolled org/swr to Feb 1, ${y} – Jan 31, ${y + 1}`);
      }
    } catch (err) {
      console.error('kdfwrPeriodRollover failed', err);
    }
    return null;
  });

/* =====================================================================
 * Camera watchdog (Item 14) — Cloud Scheduler, every 60 minutes.
 * Checks lastSeen across active camera records; any camera silent for more
 * than 390 minutes (6.5 hours) alerts every operator. Action-triggered
 * photos send hourly but scheduled status photos only send every 6 hours,
 * so a camera silent for 6.5 hours is genuinely offline rather than between
 * scheduled transmissions (v2-patch-2 Item 1; was 90 minutes). A camera
 * that has been silent for over 7 days is considered retired and stops
 * alerting. 2-hour dedup via lastNotifiedAt.offline on the camera record.
 * ===================================================================== */
exports.cameraWatchdog = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every 60 minutes')
  .timeZone(REPORT_TZ)
  .onRun(async () => {
    const OFFLINE_MS = 390 * 60 * 1000;   /* 6.5 hours — see header comment */
    const RETIRED_MS = 7 * 24 * 60 * 60 * 1000;
    try {
      const snap = await db.collection('cameraStatus').get();
      const now = Date.now();
      for (const d of snap.docs) {
        const s = d.data();
        const last = s.lastSeen ? Date.parse(s.lastSeen) : 0;
        if (!last) continue;
        const silentFor = now - last;
        if (silentFor <= OFFLINE_MS || silentFor > RETIRED_MS) continue;
        const map = s.lastNotifiedAt || {};
        const prev = map.offline ? Date.parse(map.offline) : 0;
        /* One alert per silence episode: after alerting, stay quiet until a
           new photo/report moves lastSeen forward again — a camera with no
           overnight activity must not re-alert every 2 hours for days. */
        if (prev && (prev >= last || now - prev < CAMERA_ALERT_WINDOW_MS)) continue;
        const nickname = await propertyNickname(s.customerId, s.propertyId);
        const body = [
          `Camera ${d.id}`,
          s.customerName || null,
          nickname,
          'No photo received in 6.5 hours — camera may be offline, stolen, or malfunctioning.'
        ].filter(Boolean).join(' · ');
        await notifyAllOperators({ type: 'camera', title: 'Camera offline', body, relatedId: d.id, tag: `cam-offline-${d.id}` });
        await d.ref.set({ lastNotifiedAt: { offline: new Date(now).toISOString() } }, { merge: true });
      }
      /* Item 21 (v2-patch-5): pending-removal flow. A camera is flagged for
         removal only when BOTH hold: its customer has no Active job (job
         closed) AND it has sent no photo or status report in 14 days.
         Flagging notifies jon@ (push + in-app feed); the camera stays
         visible with a Pending Removal indicator until Jon explicitly
         confirms in the app (removalConfirmed). Fresh activity clears both
         flags so a revived camera reappears automatically. */
      const REMOVAL_SILENCE_MS = 14 * 24 * 60 * 60 * 1000;
      const JON = 'jon@southern-wildlife.com';
      let activeJobCustomers = null;
      try {
        const activeJobs = await db.collection('jobs').where('status', '==', 'Active').get();
        activeJobCustomers = new Set(activeJobs.docs.map((jd) => jd.get('customerId')).filter(Boolean));
      } catch (e) {
        console.error('active-job lookup for camera removal failed', e);
      }
      if (activeJobCustomers) {
        for (const d of snap.docs) {
          const s = d.data();
          const last = s.lastSeen ? Date.parse(s.lastSeen) : 0;
          const fresh = last && (now - last) < REMOVAL_SILENCE_MS;
          if (fresh) {
            /* Camera is alive again — clear any removal state. */
            if (s.pendingRemoval || s.removalConfirmed) {
              await d.ref.set({
                pendingRemoval: false,
                removalConfirmed: false,
                updatedAt: new Date(now).toISOString()
              }, { merge: true });
            }
            continue;
          }
          if (s.pendingRemoval || s.removalConfirmed) continue;   /* already flagged/hidden */
          if (!s.customerId) continue;   /* unlinked cameras go through manual assignment, not removal */
          if (activeJobCustomers.has(s.customerId)) continue;     /* job still active — camera stays */
          await d.ref.set({
            pendingRemoval: true,
            pendingRemovalAt: new Date(now).toISOString()
          }, { merge: true });
          const body = `Camera ${d.id} · ${s.customerName || 'customer'} · job closed and no photo or status report in 14+ days. It will be removed from active monitoring once you confirm in the app.`;
          const payload = { type: 'camera', title: 'Camera pending removal', body, relatedId: d.id, tag: `cam-removal-${d.id}` };
          try { await sendPushToEmails([JON], payload); }
          catch (e) { console.error('camera removal push failed', d.id, e); }
          try { await createNotifications([JON], payload); }
          catch (e) { console.error('camera removal feed notification failed', d.id, e); }
        }
      }
      /* M15: a whole network's daily report can stop arriving — then
         handleReportMessage never runs for it (its `noreport` check only
         fires when a report DOES arrive with a camera missing), and photo
         emails keep lastSeen fresh so the offline check above stays silent.
         Group the health rows by network and alert when the newest report
         ingest is over ~a day old. One alert per silent day; a network
         silent for over 7 days is considered retired. */
      const NOREPORT_NET_MS = 30 * 60 * 60 * 1000;
      const health = await db.collection('cameraHealth').get();
      const newestByNetwork = new Map();
      for (const hd of health.docs) {
        const network = hd.id.includes('__') ? hd.id.split('__')[0] : hd.id;
        const h = hd.data();
        const t = h.updatedAt ? Date.parse(h.updatedAt) : (h.reportDate ? Date.parse(h.reportDate) : 0);
        if (t > (newestByNetwork.get(network) || 0)) newestByNetwork.set(network, t);
      }
      for (const [network, newest] of newestByNetwork) {
        if (!newest) continue;
        const age = now - newest;
        if (age <= NOREPORT_NET_MS || age > RETIRED_MS) continue;
        const statusRef = db.doc(`cameraStatus/${network}`);
        const statusSnap = await statusRef.get();
        const map = (statusSnap.exists && statusSnap.get('lastNotifiedAt')) || {};
        const prev = map.noreportNetwork ? Date.parse(map.noreportNetwork) : 0;
        if (prev && now - prev < NOREPORT_NET_MS) continue;
        const days = Math.max(1, Math.floor(age / 86400000));
        const body = `Camera network ${network} · No daily status report ingested in ${days} day${days > 1 ? 's' : ''} — check the CuddeLink home camera and report email delivery.`;
        await notifyAllOperators({ type: 'camera', title: 'Camera report missing', body, relatedId: network, tag: `cam-noreport-net-${network}` });
        await statusRef.set({ lastNotifiedAt: { noreportNetwork: new Date(now).toISOString() } }, { merge: true });
      }
    } catch (err) {
      console.error('cameraWatchdog failed', err);
    }
    return null;
  });

/* M16: only one mailbox ingest at a time. The scheduled poll and a manual
 * Sync Now both fetch "unread" messages and mark them read only afterwards,
 * so overlapping runs process the same emails twice (duplicate photos and a
 * second pass at the alert dedup). Short transactional lease; a crashed
 * run's lease expires after 10 minutes. */
const INGEST_LEASE_MS = 10 * 60 * 1000;
async function acquireIngestLease() {
  const ref = db.doc('org/ingestLock');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const heldAt = (snap.exists && snap.get('leasedAt')) ? Date.parse(snap.get('leasedAt')) : 0;
    if (heldAt && Date.now() - heldAt < INGEST_LEASE_MS) return false;
    tx.set(ref, { leasedAt: new Date().toISOString() }, { merge: true });
    return true;
  });
}
async function releaseIngestLease() {
  await db.doc('org/ingestLock').set({ leasedAt: null }, { merge: true }).catch(() => {});
}

async function ingestMailbox() {
  /* true = acquired, false = a peer holds it, null = lease check errored
     (proceed for availability, but never release a lease we don't hold). */
  let leased = null;
  try { leased = await acquireIngestLease(); }
  catch (e) { console.error('ingest lease failed — proceeding without a lease', e); }
  if (leased === false) return { busy: true, at: new Date().toISOString() };
  try {
    return await ingestMailboxUnlocked();
  } finally {
    if (leased === true) await releaseIngestLease();
  }
}

/* Poll the mailbox: process unread photo + report messages, mark them read.
 * Every successful run stamps org/graphStatus.lastPollAt so the app's
 * Monitoring module can show a Graph connection indicator (Item 7). */
async function ingestMailboxUnlocked() {
  let data;
  try {
    data = await graphGet(
      `/users/${PHOTOS_MAILBOX}/messages?$filter=isRead eq false&$top=25` +
      `&$select=id,subject,from,receivedDateTime,hasAttachments&$orderby=receivedDateTime desc`,
      { subject: '(mailbox poll)' });
  } catch (err) {
    await db.doc('org/graphStatus').set({
      lastErrorAt: new Date().toISOString(),
      lastError: String(err.message || err).slice(0, 300)
    }, { merge: true }).catch(() => {});
    throw err;
  }
  const msgs = data.value || [];
  let photos = 0, reports = 0, unassigned = 0, skipped = 0;
  const keyMap = msgs.length ? await customerKeyMap() : { get: () => null };
  const lastSeenByKey = new Map();   /* Item 14: newest photo time per camera key */
  for (const m of msgs) {
    const sender = ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
    try {
      if (sender.includes(CL_IMG_SENDER)) {
        const r = await handlePhotoMessage(m, keyMap);
        photos += r.photos;
        if (r.unassigned) unassigned++;
        if (r.photos && r.key) {
          const prev = lastSeenByKey.get(r.key);
          if (!prev || (r.receivedAt || '') > (prev.receivedAt || '')) lastSeenByKey.set(r.key, r);
        }
      } else if (sender.includes(CL_REPORT_SENDER)) {
        await handleReportMessage(m, keyMap);
        reports++;
      } else {
        skipped++;
      }
      await graphMarkRead(m.id, { subject: m.subject || '' });
    } catch (err) {
      console.error('Ingest failed for message', m.id, err.message); // leave unread → retried next run
    }
  }
  /* Item 14 (event-driven): stamp lastSeen on the camera record at write
     time — no polling. One write per camera key per run. */
  for (const [key, r] of lastSeenByKey) {
    await db.doc(`cameraStatus/${key}`).set({
      customerKey: key,
      customerId: r.match ? r.match.id : null,
      customerName: r.match ? r.match.name : null,
      propertyId: (r.match && r.match.propertyId) || null,
      lastSeen: r.receivedAt,
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch((e) => console.error('cameraStatus lastSeen write failed', key, e));
  }
  const result = { processed: msgs.length, photos, reports, unassigned, skipped, at: new Date().toISOString() };
  await db.doc('org/graphStatus').set({
    lastPollAt: result.at,
    lastResult: result,
    lastError: admin.firestore.FieldValue.delete(),
    lastErrorAt: admin.firestore.FieldValue.delete()
  }, { merge: true }).catch(() => {});
  return result;
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

/* =====================================================================
 * v2-patch-8 Item 2: admin data-management callables.
 * ---------------------------------------------------------------------
 * The v2-patch-7 client-side implementations died mid-run when the Web
 * SDK's persistent multi-tab cache terminated (see the Item 1 diagnosis
 * commit). Both migrations now run here on the Admin SDK. Admin-only:
 * same email gate as qbPushEstimate (ADMIN_EMAILS — the app's existing
 * admin check pattern; there are no custom claims in this project).
 * ===================================================================== */
function assertAdminCallable(context) {
  const decision = adminMigrations.adminGateDecision(context.auth, ADMIN_EMAILS);
  if (decision === 'unauthenticated') {
    throw new functions.https.HttpsError('unauthenticated', 'Sign in required.');
  }
  if (decision === 'permission-denied') {
    throw new functions.https.HttpsError('permission-denied', 'Only an administrator can run this tool.');
  }
  return context.auth.token.email.toLowerCase();
}

exports.backfillPrimaryProperties = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (data, context) => {
    const by = assertAdminCallable(context);
    try {
      const result = await adminMigrations.backfillPrimaryPropertiesCore(db);
      console.log(`backfillPrimaryProperties by ${by}:`, result);
      return result;
    } catch (err) {
      console.error('backfillPrimaryProperties failed', err);
      throw new functions.https.HttpsError('internal', err.message || 'Backfill failed');
    }
  });

exports.relinkCameras = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (data, context) => {
    const by = assertAdminCallable(context);
    try {
      const result = await adminMigrations.relinkCamerasCore(db);
      console.log(`relinkCameras by ${by}: linked=${result.linked} unmatched=${result.unmatched.length}`);
      return result;
    } catch (err) {
      console.error('relinkCameras failed', err);
      throw new functions.https.HttpsError('internal', err.message || 'Re-link failed');
    }
  });

/* Manual "Sync Now" for the Monitoring module (authenticated). */
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
