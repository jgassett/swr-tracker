#!/usr/bin/env node
/*
 * purge-qb-sandbox.mjs — delete QuickBooks-synced customer records.
 *
 * The daily/manual QuickBooks sync creates customers with source:'quickbooks'.
 * When you first connect a QuickBooks *sandbox* company, the sync pulls Intuit's
 * demo customers (Amy's Bird Sanctuary, etc.). This script removes those so you
 * can start clean before pointing the connector at your production company.
 *
 * It ONLY deletes docs in `customers` where source == 'quickbooks'. Manually
 * created customers (source:'manual' or unset) are never touched. Because the
 * sync tags every imported row the same way, run this BEFORE connecting to
 * production — otherwise it would also remove real production imports.
 *
 * Safe by default: with no flags it does a DRY RUN (lists what it would delete
 * and changes nothing). Pass --confirm to actually delete.
 *
 * Usage:
 *   node purge-qb-sandbox.mjs            # dry run — shows what would be deleted
 *   node purge-qb-sandbox.mjs --confirm  # actually delete
 *
 * The service-account key is read from (in order):
 *   1. $GOOGLE_APPLICATION_CREDENTIALS
 *   2. ./serviceAccountKey.json   (next to this script)
 *
 * See README.md in this folder for setup.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PROJECT = 'swr-tracker-54dfd';
const BATCH_LIMIT = 450; // Firestore caps a batch at 500 ops; stay under it.

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function loadServiceAccount() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS || join(HERE, 'serviceAccountKey.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    die(
      `Couldn't read a service-account key.\n` +
      `  Looked at: ${path}\n` +
      `  Download one: Firebase console → Project settings → Service accounts →\n` +
      `  "Generate new private key", then save it as admin-tools/serviceAccountKey.json\n` +
      `  (or set GOOGLE_APPLICATION_CREDENTIALS to its path).`
    );
  }
  let json;
  try { json = JSON.parse(raw); } catch { die(`Service-account key at ${path} is not valid JSON.`); }
  if (json.project_id && json.project_id !== EXPECTED_PROJECT) {
    die(`Key is for project "${json.project_id}", expected "${EXPECTED_PROJECT}". Wrong key file?`);
  }
  return json;
}

async function main() {
  const confirm = process.argv.slice(2).includes('--confirm');

  const serviceAccount = loadServiceAccount();
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  const snap = await db.collection('customers').where('source', '==', 'quickbooks').get();

  if (snap.empty) {
    console.log('\n✔ No customers with source == "quickbooks" found. Nothing to delete.\n');
    process.exit(0);
  }

  console.log(`\nFound ${snap.size} QuickBooks-synced customer${snap.size === 1 ? '' : 's'}:`);
  snap.docs.forEach((d, i) => {
    const c = d.data();
    const active = c.active ? ' [ACTIVE]' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${c.name || '(no name)'}  (qbId ${c.qbId ?? '—'}, doc ${d.id})${active}`);
  });

  /* Guardrail: warn if any are marked active — those may be rows you promoted
     in-app. They still get deleted (they are QuickBooks-sourced), but flag it. */
  const activeCount = snap.docs.filter((d) => d.data().active).length;
  if (activeCount) {
    console.log(`\n⚠  ${activeCount} of these are marked ACTIVE in the app. They will still be deleted.`);
  }

  if (!confirm) {
    console.log(
      `\nDRY RUN — nothing was deleted.\n` +
      `Re-run with --confirm to delete these ${snap.size} record${snap.size === 1 ? '' : 's'}:\n` +
      `  node purge-qb-sandbox.mjs --confirm\n`
    );
    process.exit(0);
  }

  let deleted = 0;
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const chunk = snap.docs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += chunk.length;
    console.log(`  …deleted ${deleted}/${snap.size}`);
  }

  console.log(`\n✔ Deleted ${deleted} QuickBooks-synced customer${deleted === 1 ? '' : 's'}.`);
  console.log('  Manually-created customers were left untouched.');
  console.log('  Reminder: delete admin-tools/serviceAccountKey.json when you no longer need it.\n');
  process.exit(0);
}

main().catch((err) => die(err && err.message || String(err)));
