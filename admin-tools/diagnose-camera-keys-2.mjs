#!/usr/bin/env node
/* Part 2 of the Item-7 diagnosis — READ-ONLY forensic dump:
 *  - deletedCameras markers (what was permanently deleted, when)
 *  - graphErrors (last 40: unparsed reports, reappearance logs — historical key forms)
 *  - cameraHealth __pending rows: pendingReason + subject (why reports fail today)
 *  - customers with a legacy customer-level cameraId (stale-stamp source)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
function credential() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(HERE, 'serviceAccountKey.json');
  if (existsSync(keyPath)) {
    const json = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (json.type === 'service_account') return cert(json);
  }
  return applicationDefault();
}
const reveal = (s) => s == null ? '(null)' :
  JSON.stringify(String(s).replace(/[^\x20-\x7E]/g, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`));

async function main() {
  initializeApp({ credential: credential(), projectId: 'swr-tracker-54dfd' });
  const db = getFirestore();

  console.log('\n=== deletedCameras markers ===');
  const del = await db.collection('deletedCameras').get();
  if (del.empty) console.log('  (none — all consumed by reappearance or never created)');
  del.forEach((d) => console.log(`  ${reveal(d.id)}  →`, JSON.stringify(d.data())));

  console.log('\n=== graphErrors (newest 40) ===');
  const errs = await db.collection('graphErrors').orderBy('at', 'desc').limit(40).get()
    .catch(async () => db.collection('graphErrors').limit(40).get());
  errs.forEach((d) => {
    const e = d.data();
    console.log(`  [${e.at || e.createdAt || '—'}] ctx=${e.context || e.kind || '—'} key=${reveal(e.cameraKey)} subject=${reveal(e.subject)}\n    msg=${String(e.message || '').slice(0, 220)}`);
  });

  console.log('\n=== cameraHealth pending rows ===');
  const pend = await db.collection('cameraHealth').where('pending', '==', true).get();
  pend.forEach((d) => {
    const h = d.data();
    console.log(`  doc=${d.id} key=${reveal(h.customerKey)} receivedAt=${h.receivedAt || '—'}\n    subject=${reveal(h.subject)}\n    reason=${h.pendingReason || '—'}`);
  });

  console.log('\n=== customers with legacy customer-level cameraId ===');
  const custs = await db.collection('customers').get();
  custs.forEach((d) => {
    const cam = d.get('cameraId');
    if (cam) console.log(`  ${d.id}  name=${reveal(d.get('name'))}  cameraId=${reveal(cam)}`);
  });

  console.log('\n=== properties: full cameraId inventory (verbatim) ===');
  const props = await db.collectionGroup('properties').get();
  props.forEach((d) => {
    const cam = d.get('cameraId');
    if (cam == null || cam === '') return;
    console.log(`  prop=${d.id} nickname=${reveal(d.get('siteNickname'))} cameraId=${reveal(cam)} customerId=${d.get('customerId') || (d.ref.parent.parent && d.ref.parent.parent.id)}`);
  });
  console.log('');
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
