#!/usr/bin/env node
/*
 * diagnose-camera-keys.mjs — READ-ONLY diagnostic for the v2-patch-14
 * duplicate-Monitoring-entry bug (Item 7).
 *
 * Dumps every distinct camera key as actually stored, with invisible
 * characters made visible, across the four places a key can live:
 *   - properties (collectionGroup) .cameraId
 *   - cameraHealth .customerKey (+ doc id prefix) + customerName/customerId
 *   - cameraPhotos .customerKey + customerName/customerId
 *   - cameraStatus .customerKey (+ doc id) + customerName/customerId
 *
 * Then groups them the way the CURRENT client fieldGroups() does
 * (verbatim, case-sensitive) vs the PROPOSED normalized way
 * (trim + strip zero-width + uppercase) and reports which keys split.
 *
 * NOTHING IS WRITTEN. Uses the same credential lookup as the other admin
 * tools (admin-tools/serviceAccountKey.json or GOOGLE_APPLICATION_CREDENTIALS,
 * falling back to application-default credentials).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PROJECT = 'swr-tracker-54dfd';

function credential() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(HERE, 'serviceAccountKey.json');
  if (existsSync(keyPath)) {
    const json = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (json.type === 'service_account') {
      if (json.project_id && json.project_id !== EXPECTED_PROJECT) {
        throw new Error(`Key is for project "${json.project_id}", expected "${EXPECTED_PROJECT}".`);
      }
      return cert(json);
    }
    /* authorized_user (application-default) credential — let ADC handle it */
  }
  return applicationDefault();
}

/* Reveal invisible characters: anything outside printable ASCII becomes \u{XXXX}. */
function reveal(s) {
  if (s == null) return '(null)';
  return JSON.stringify(String(s).replace(/[^\x20-\x7E]/g, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`));
}

/* Current client grouping: verbatim. Proposed: trim + strip zero-width + uppercase. */
const ZW = /[​-‍﻿]/g;
const propose = (v) => (v == null ? '' : String(v)).replace(ZW, '').trim().toUpperCase();

async function main() {
  initializeApp({ credential: credential(), projectId: EXPECTED_PROJECT });
  const db = getFirestore();

  const rows = []; // { source, rawKey, name, customerId, propertyId, docId, extra }

  const props = await db.collectionGroup('properties').get();
  props.forEach((d) => {
    const cam = d.get('cameraId');
    if (cam == null || cam === '') return;
    rows.push({
      source: 'property.cameraId', rawKey: cam, docId: d.id,
      customerId: d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null),
      name: d.get('siteNickname') || null
    });
  });

  const health = await db.collection('cameraHealth').get();
  health.forEach((d) => rows.push({
    source: 'cameraHealth', rawKey: d.get('customerKey'), docId: d.id,
    name: d.get('customerName'), customerId: d.get('customerId'), propertyId: d.get('propertyId'),
    extra: `createdAt=${d.get('updatedAt') || '—'} internal=${d.get('internal') === true} pending=${d.get('pending') === true}`
  }));

  const photos = await db.collection('cameraPhotos').get();
  photos.forEach((d) => rows.push({
    source: 'cameraPhotos', rawKey: d.get('customerKey'), docId: d.id,
    name: d.get('customerName'), customerId: d.get('customerId'), propertyId: d.get('propertyId'),
    extra: `receivedAt=${d.get('receivedAt') || '—'} createdBy=${d.get('createdByEmail') || '—'}`
  }));

  const status = await db.collection('cameraStatus').get();
  status.forEach((d) => rows.push({
    source: 'cameraStatus', rawKey: d.get('customerKey'), docId: d.id,
    name: d.get('customerName'), customerId: d.get('customerId'), propertyId: d.get('propertyId'),
    extra: `lastSeen=${d.get('lastSeen') || '—'}`
  }));

  console.log(`\n=== Camera-key inventory (${rows.length} rows) — READ-ONLY ===\n`);

  /* Group by the PROPOSED normalized key; inside each, list the distinct
   * verbatim forms (= the buckets the current client creates). */
  const byNorm = new Map();
  for (const r of rows) {
    const n = propose(r.rawKey) || '(empty)';
    if (!byNorm.has(n)) byNorm.set(n, new Map());
    const forms = byNorm.get(n);
    const f = String(r.rawKey ?? '(null)');
    if (!forms.has(f)) forms.set(f, []);
    forms.get(f).push(r);
  }

  let splitKeys = 0;
  for (const [norm, forms] of [...byNorm.entries()].sort()) {
    const isSplit = forms.size > 1;
    if (isSplit) splitKeys++;
    console.log(`${isSplit ? '✖ SPLIT' : '  ok  '} ${norm}  (${forms.size} verbatim form${forms.size === 1 ? '' : 's'})`);
    for (const [form, list] of forms) {
      const bySource = {};
      for (const r of list) bySource[r.source] = (bySource[r.source] || 0) + 1;
      console.log(`    form ${reveal(form)}  →  ${Object.entries(bySource).map(([s, c]) => `${s}×${c}`).join(', ')}`);
      /* customerName variants observed on this form (stale-stamp check) */
      const names = [...new Set(list.map((r) => r.name).filter(Boolean))];
      if (names.length) console.log(`      customerName values: ${names.map(reveal).join(' | ')}`);
      for (const r of list.slice(0, 3)) {
        console.log(`      e.g. [${r.source}] doc=${r.docId} customerId=${r.customerId || '—'} propertyId=${r.propertyId || '—'} ${r.extra || ''}`);
      }
      if (list.length > 3) console.log(`      … +${list.length - 3} more`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Normalized keys:   ${byNorm.size}`);
  console.log(`  Keys that SPLIT under the current verbatim grouping: ${splitKeys}`);
  console.log('');
}

main().catch((err) => { console.error(`\n✖ ${err && err.stack ? err.stack : err}\n`); process.exit(1); });
