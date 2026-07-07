#!/usr/bin/env node
/*
 * qb-push-retry.mjs — find customers with no qbId and push them to QuickBooks
 * by invoking the deployed qbCreateCustomer callable.
 *
 * Unlike reset-pin.mjs this needs NO service-account key: it signs in with an
 * operator Employee ID + PIN (exactly like the app) and calls the live Cloud
 * Function with that user's ID token, so all the server-side QBO logic
 * (duplicate-name linking, token refresh) is reused as-is.
 *
 * Usage:
 *   node qb-push-retry.mjs                 # list customers missing a qbId
 *   node qb-push-retry.mjs <docId>         # push one customer by Firestore doc id
 *   node qb-push-retry.mjs --all           # push every customer missing a qbId
 *   node qb-push-retry.mjs --find <text>   # show docId + qbId for customers whose name matches
 *   node qb-push-retry.mjs --unlink <docId># clear a stale qbId so the customer can be re-pushed
 *   node qb-push-retry.mjs --photos [KEY]  # diagnose camera-photo access (all, or one camera key)
 *
 * You'll be prompted for Employee ID and PIN (PIN input is hidden).
 * Requires Node 18+ (built-in fetch).
 */

import { createInterface } from 'node:readline';

const PROJECT = 'swr-tracker-54dfd';
const API_KEY = 'AIzaSyDTfeTRBYN4WT-I7NtAyx8vfO7Tq0N-Tz0'; // public web key (same as index.html)
const FN_URL = `https://us-central1-${PROJECT}.cloudfunctions.net/qbCreateCustomer`;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const EMPLOYEE_ID_TO_EMAIL = {
  JG01: 'jon@southern-wildlife.com',
  RG01: 'robin@southern-wildlife.com',
  CG01: 'chris@southern-wildlife.com'
};

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      /* Mute echo while the PIN is typed. */
      const orig = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => { if (s.includes(question)) orig(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function signIn() {
  const idRaw = (await ask('Employee ID (e.g. JG01) or email: ')).toUpperCase();
  const email = EMPLOYEE_ID_TO_EMAIL[idRaw] || idRaw.toLowerCase();
  const pin = await ask('PIN: ', { hidden: true });
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pin, returnSecureToken: true })
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`Sign-in failed: ${(json.error && json.error.message) || res.status}`);
  console.log(`Signed in as ${email}\n`);
  return json.idToken;
}

/* Page through the customers collection via the Firestore REST API (subject to
 * the same security rules as the app). Returns all docs. */
async function fetchAllCustomers(idToken) {
  const out = [];
  let pageToken = '';
  do {
    const url = `${FS_BASE}/customers?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Firestore read failed: ${JSON.stringify(json.error || json)}`);
    for (const d of json.documents || []) {
      const id = d.name.split('/').pop();
      const f = d.fields || {};
      const s = (k) => (f[k] && (f[k].stringValue ?? null)) ?? null;
      out.push({ id, name: s('name'), qbId: s('qbId'), source: s('source'), active: !!(f.active && f.active.booleanValue) });
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function pushOne(idToken, docId) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: { customerId: docId } })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`${e.status || res.status}: ${e.message || 'push failed'}`);
  }
  return json.result || {};
}

async function unlinkOne(idToken, docId) {
  const url = `${FS_BASE}/customers/${docId}?updateMask.fieldPaths=qbId&updateMask.fieldPaths=updatedAt`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      fields: { qbId: { nullValue: null }, updatedAt: { stringValue: new Date().toISOString() } }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Unlink failed: ${JSON.stringify(json.error || json)}`);
}

const arg = process.argv[2];
const arg2 = process.argv[3];
const idToken = await signIn();

if (arg === '--find') {
  if (!arg2) { console.log('Usage: node qb-push-retry.mjs --find <name text>'); process.exit(1); }
  const customers = await fetchAllCustomers(idToken);
  const q = arg2.toLowerCase();
  const hits = customers.filter((c) => (c.name || '').toLowerCase().includes(q));
  if (!hits.length) { console.log(`No customer name contains "${arg2}".`); process.exit(0); }
  for (const c of hits) {
    console.log(`  ${c.id}   ${c.name || '(no name)'}   qbId: ${c.qbId || '(none)'}${c.active ? '' : '   [inactive]'}${c.source ? `   (source: ${c.source})` : ''}`);
  }
} else if (arg === '--unlink') {
  if (!arg2) { console.log('Usage: node qb-push-retry.mjs --unlink <docId>'); process.exit(1); }
  await unlinkOne(idToken, arg2);
  console.log(`✓ Cleared qbId on ${arg2}. Now push it fresh:\n   node qb-push-retry.mjs ${arg2}`);
} else if (arg === '--photos') {
  /* Diagnose camera-photo access the same way the app does:
     1. metadata GET with the user's ID token  → what getDownloadURL() does (storage-rules-checked)
     2. file GET with the download token       → what the <img> then loads (token-checked) */
  const key = (arg2 || '').toUpperCase();
  const BUCKET = `${PROJECT}.firebasestorage.app`;
  const docs = [];
  let pageToken = '';
  do {
    const url = `${FS_BASE}/cameraPhotos?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`Firestore read failed: ${JSON.stringify(json.error || json)}`);
    for (const d of json.documents || []) {
      const f = d.fields || {};
      const s = (k) => (f[k] && f[k].stringValue) || '';
      docs.push({ key: s('customerKey'), path: s('storagePath'), receivedAt: s('receivedAt') });
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  const subset = key ? docs.filter((p) => (p.key || '').toUpperCase() === key) : docs;
  console.log(`${subset.length} photo doc(s)${key ? ` for ${key}` : ''} in Firestore. Testing access…`);
  const tally = {};
  let shown = 0;
  for (const p of subset) {
    if (!p.path) { tally['no storagePath'] = (tally['no storagePath'] || 0) + 1; continue; }
    const metaRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p.path)}`,
      { headers: { Authorization: `Firebase ${idToken}` } });
    let mediaStatus = '—';
    if (metaRes.ok) {
      const meta = await metaRes.json();
      const tok = String(meta.downloadTokens || '').split(',')[0];
      const mediaRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p.path)}?alt=media&token=${tok}`,
        { headers: { Range: 'bytes=0-0' } });
      mediaStatus = String(mediaRes.status);
    }
    const label = `metadata ${metaRes.status} / file ${mediaStatus}`;
    tally[label] = (tally[label] || 0) + 1;
    const bad = !metaRes.ok || Number(mediaStatus) >= 400;
    if (bad && shown < 10) {
      shown++;
      console.log(`  ✗ ${p.key || '?'}  ${(p.receivedAt || '').slice(0, 16)}  ${label}`);
      console.log(`     ${p.path}`);
    }
  }
  console.log('\nSummary:');
  for (const [k, n] of Object.entries(tally)) console.log(`  ${k}: ${n} photo(s)`);
  console.log('\nHow to read it:');
  console.log('  metadata 403          → storage rules are blocking reads (rules problem)');
  console.log('  metadata 404          → file is gone from Storage (retention cleanup) but the doc remains');
  console.log('  metadata 200/file 403 → download token invalid');
  console.log('  metadata 200/file 200 or 206 → healthy');
} else if (!arg) {
  /* List mode: catches qbId === null AND docs where the field is missing entirely. */
  const customers = await fetchAllCustomers(idToken);
  const missing = customers.filter((c) => !c.qbId);
  if (!missing.length) { console.log('Every customer already has a qbId — nothing to push.'); process.exit(0); }
  console.log(`${missing.length} customer(s) missing a qbId:\n`);
  for (const c of missing) {
    console.log(`  ${c.id}   ${c.name || '(no name)'}${c.active ? '' : '   [inactive]'}${c.source ? `   (source: ${c.source})` : ''}`);
  }
  console.log('\nPush one:   node qb-push-retry.mjs <docId>');
  console.log('Push all:   node qb-push-retry.mjs --all');
} else if (arg === '--all') {
  const customers = await fetchAllCustomers(idToken);
  const missing = customers.filter((c) => !c.qbId);
  console.log(`Pushing ${missing.length} customer(s)…\n`);
  for (const c of missing) {
    try {
      const r = await pushOne(idToken, c.id);
      console.log(`  ✓ ${c.name || c.id} → qbId ${r.qbId}${r.alreadyLinked ? ' (linked to existing QBO customer)' : ''}`);
    } catch (err) {
      console.log(`  ✗ ${c.name || c.id} — ${err.message}`);
    }
  }
} else {
  const r = await pushOne(idToken, arg);
  console.log(`✓ Pushed. qbId ${r.qbId}${r.alreadyLinked ? ' (linked to existing QBO customer)' : ''}`);
}
