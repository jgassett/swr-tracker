#!/usr/bin/env node
/*
 * fieldgroups-sim.mjs — v2-patch-14 Item 7 verification (READ-ONLY).
 *
 * Extracts the REAL fieldGroups pipeline out of index.html (normCamKey,
 * resolveCustomerForKey, worstOf, deviceIsCurrent, deviceDefsLive,
 * deviceStatusLive, fieldGroups, fieldGroupFor — by brace-matching, so the
 * exact shipped code runs, not a mirror), feeds it the LIVE production
 * Firestore data, and asserts:
 *   1. every property-linked camera renders EXACTLY ONE Monitoring entry,
 *   2. that entry unifies photos + health + property link under one key,
 *   3. the pending/unmatched queue holds only keys matching no property,
 *   4. no two visible groups normalize to the same key (no split buckets).
 *
 * Also replays the sim with SYNTHETIC raw-case/whitespace/zero-width doc
 * keys (the pre-patch-9 shapes) to prove the normalization holds for the
 * historical forms that caused the seven duplicate entries.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

/* Brace-matching extractor: `function name(...) {...}` verbatim. */
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const shipped = ['normCamKey', 'resolveCustomerForKey', 'worstOf', 'deviceIsCurrent',
  'deviceDefsLive', 'deviceStatusLive', 'fieldGroups', 'fieldGroupFor']
  .map(extractFn).join('\n');

/* Globals the shipped code closes over. */
globalThis.STATUS_RANK = { red: 0, yellow: 1, green: 2, none: 3 };
globalThis.currentUser = { email: 'jon@southern-wildlife.com' };
globalThis.lifecycleJobs = () => [];
globalThis.cachedCustomers = [];
globalThis.cachedProperties = [];
globalThis.cachedCameraHealth = [];
globalThis.cachedCameraPhotos = [];
globalThis.cachedCameraStatus = [];
const api = new Function(`${shipped}; return { normCamKey, fieldGroups, fieldGroupFor, resolveCustomerForKey };`)();

function credential() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(HERE, 'serviceAccountKey.json');
  if (existsSync(keyPath)) {
    const json = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (json.type === 'service_account') return cert(json);
  }
  return applicationDefault();
}

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✖ FAIL'} ${msg}`);
  if (!cond) failures++;
};

function runAssertions(label) {
  console.log(`\n--- ${label} ---`);
  const groups = api.fieldGroups();

  /* 4. no two visible groups share a normalized key */
  const keys = groups.map((g) => g.key);
  ok(new Set(keys).size === keys.length, `no duplicate group keys (${keys.length} groups)`);

  /* 1+2. every property-linked camera: exactly one entry, unified */
  for (const p of globalThis.cachedProperties) {
    const K = api.normCamKey(p.cameraId);
    if (!K || !p.customerId) continue;
    const matches = groups.filter((g) => g.key === K);
    const cust = globalThis.cachedCustomers.find((c) => c.id === p.customerId);
    ok(matches.length === 1, `${K}: exactly one entry (got ${matches.length})`);
    const g = matches[0];
    if (!g) continue;
    ok(g.installed === true && g.customerId === p.customerId && g.propertyId === p.id,
      `${K}: linked to ${cust ? cust.name : p.customerId} / property ${p.id.slice(0, 6)}…`);
    const expPhotos = globalThis.cachedCameraPhotos.filter((x) => api.normCamKey(x.customerKey) === K && !x.archived).length;
    const expHealth = globalThis.cachedCameraHealth.filter((x) => api.normCamKey(x.customerKey) === K).length;
    ok(g.photos.length === expPhotos && g.devices.length === expHealth,
      `${K}: unified data — ${g.photos.length}/${expPhotos} photos, ${g.devices.length}/${expHealth} health rows`);
  }

  /* 3. pending queue = only keys with no property match */
  const pendingQ = groups.filter((g) => !g.installed && !g.internal);
  for (const g of pendingQ) {
    ok(api.resolveCustomerForKey(g.key) === null, `pending "${g.key}" is genuinely unmatched`);
  }
  console.log(`  pending/unmatched queue: [${pendingQ.map((g) => g.key).join(', ') || 'empty'}]`);
  return groups;
}

async function main() {
  initializeApp({ credential: credential(), projectId: 'swr-tracker-54dfd' });
  const db = getFirestore();
  const load = async (col) => (await db.collection(col).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  globalThis.cachedCustomers = await load('customers');
  globalThis.cachedProperties = (await db.collectionGroup('properties').get()).docs
    .map((d) => ({ id: d.id, ...d.data(), customerId: d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null) }));
  globalThis.cachedCameraHealth = await load('cameraHealth');
  globalThis.cachedCameraPhotos = await load('cameraPhotos');
  globalThis.cachedCameraStatus = await load('cameraStatus');

  const groups = runAssertions('LIVE production data');
  console.log('\n  Monitoring list as it will render:');
  for (const g of groups) {
    console.log(`    [${g.status}] key=${g.key} name=${g.name || '(unlinked)'} photos=${g.photos.length} devices=${g.devices.length} installed=${g.installed}`);
  }

  /* Historical-shape replay: re-key some docs the pre-patch-9 way. */
  const mangle = (arr, from, to) => arr.forEach((d) => { if (d.customerKey === from) d.customerKey = to; });
  mangle(globalThis.cachedCameraPhotos, 'HAYDENT', 'HaydenT');            // raw case
  mangle(globalThis.cachedCameraHealth, 'HAYDENT', 'HAYDENT ');           // trailing space
  mangle(globalThis.cachedCameraPhotos, 'TACKETTF', 'TACKETTF​');    // zero-width
  mangle(globalThis.cachedCameraStatus, 'CARDWELLC', 'cardwellc');        // lowercase
  runAssertions('SYNTHETIC pre-patch-9 key shapes (raw case / trailing space / zero-width)');

  console.log(failures ? `\n✖ ${failures} assertion(s) FAILED\n` : '\nfieldgroups-sim: ALL assertions passed\n');
  process.exit(failures ? 1 : 0);
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
