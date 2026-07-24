/* =====================================================================
 * v2-patch-12 emulator regression test — camera-health.js cores.
 * ---------------------------------------------------------------------
 * Runs the EXACT shipped pipeline write logic against the Firestore
 * emulator (the admin-migrations.js pattern). From the repo root:
 *
 *   firebase emulators:exec --only firestore \
 *     "node functions/test/camera-health.test.js"
 *
 * firebase-tools requires JDK 21+; on this machine the default JDK is 17,
 * so prefix with:
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH="/opt/homebrew/opt/openjdk@21/bin:$PATH"
 *
 * Covers:
 *  Item 1 — an operator's `internal` mark survives status-report ingest
 *           (device rows AND the __pending manual-review row), and stays
 *           sticky when a report adds/renumbers device rows.
 *  Item 2 — permanent deletion removes health/photos/status rows and
 *           leaves a marker; a key that mails again re-enters the pending
 *           queue as unmatched with no internal flag, and the marker is
 *           consumed exactly once (one reappearance log per episode).
 * ===================================================================== */

'use strict';

const assert = require('node:assert');
const path = require('node:path');
const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));
const camHealth = require(path.join(__dirname, '..', 'camera-health.js'));

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set — run via `firebase emulators:exec --only firestore "node functions/test/camera-health.test.js"` from the repo root.');
  process.exit(1);
}

admin.initializeApp({ projectId: 'swr-tracker-54dfd' });
const db = admin.firestore();

/* A parsed daily report in the exact shape cuddeback-parse produces. */
function parsedReport(network, cameraNumbers, reportDate) {
  return {
    network,
    reportDate,
    devices: cameraNumbers.map((n) => ({
      cameraNumber: String(n),
      cameraName: `CAM ${n}`,
      mode: 'Daily',
      battery: 'OK',
      sdFreeSpace: '14.2 GB',
      sdFreeGB: 14.2,
      photoQueue: 0,
      fwVersion: '8.3.0',
      clVersion: '1.2'
    }))
  };
}

async function run() {
  const nowIso = () => new Date().toISOString();

  /* ---- Item 1: internal survives the report-ingest upsert ---- */
  const KEY = 'REGTESTA';
  await camHealth.upsertReportHealthCore(db, {
    parsed: parsedReport(KEY, [1], '07/23/2026'), match: null, today: '07/23/2026', nowIso: nowIso()
  });
  let d1 = await db.doc(`cameraHealth/${KEY}__1`).get();
  assert.ok(d1.exists, 'device row created by report ingest');
  assert.notStrictEqual(d1.get('internal'), true, 'fresh row must not be internal');

  /* Operator marks the camera internal — the app writes exactly this. */
  await db.doc(`cameraHealth/${KEY}__1`).set({ internal: true }, { merge: true });

  /* Next day's report — flag survives, fields update, and the flag
     propagates to a brand-new device row on the same key. */
  await camHealth.upsertReportHealthCore(db, {
    parsed: parsedReport(KEY, [1, 2], '07/24/2026'), match: null, today: '07/24/2026', nowIso: nowIso()
  });
  d1 = await db.doc(`cameraHealth/${KEY}__1`).get();
  const d2 = await db.doc(`cameraHealth/${KEY}__2`).get();
  assert.strictEqual(d1.get('internal'), true, 'internal survives a status-report ingest');
  assert.strictEqual(d1.get('reportDate'), '07/24/2026', 'report fields keep updating');
  assert.strictEqual(d2.get('internal'), true, 'internal propagates to a new device row (sticky per key)');

  /* Unparsed-report path — the __pending row must not clobber the mark. */
  const KEYB = 'REGTESTB';
  await camHealth.queueUnmatchedHealthCore(db, {
    key: KEYB, reason: 'no HTML attachment', subject: 's1', receivedAt: nowIso(), nowIso: nowIso()
  });
  await db.doc(`cameraHealth/${KEYB}__pending`).set({ internal: true }, { merge: true });
  await camHealth.queueUnmatchedHealthCore(db, {
    key: KEYB, reason: 'still no HTML attachment', subject: 's2', receivedAt: nowIso(), nowIso: nowIso()
  });
  const pb = await db.doc(`cameraHealth/${KEYB}__pending`).get();
  assert.strictEqual(pb.get('internal'), true, 'internal survives repeated unparsed-report queue writes');
  assert.strictEqual(pb.get('pendingReason'), 'still no HTML attachment', 'pending fields keep updating');

  /* v2-patch-15: a report for the key finally ingests (e.g. Tracks solo
     after the species fix) — the stale __pending row is RESOLVED (deleted)
     so it can't trip noreport alerts or hold the key red in the pending
     queue, and the operator's internal mark on it has already propagated
     to the real device row. */
  const resolved = await camHealth.upsertReportHealthCore(db, {
    parsed: parsedReport(KEYB, [1], '07/24/2026'), match: null, today: '07/24/2026', nowIso: nowIso()
  });
  assert.strictEqual(resolved.pendingResolved, true, 'successful ingest reports the pending resolution');
  assert.ok(!(await db.doc(`cameraHealth/${KEYB}__pending`).get()).exists, 'stale __pending row deleted on successful ingest');
  const kb1 = await db.doc(`cameraHealth/${KEYB}__1`).get();
  assert.strictEqual(kb1.get('internal'), true, 'internal mark carried from the pending row to the real device row');

  /* Regression guard: a future payload edit adding an operator field is
     stripped before it can clobber anything. */
  const stripped = camHealth.stripOperatorFields({ battery: 'OK', internal: false, pendingRemoval: true });
  assert.deepStrictEqual(stripped, { battery: 'OK' }, 'operator-set fields are stripped from pipeline payloads');

  /* ---- Item 2: permanent deletion + reappearance guard ---- */
  await db.collection('cameraPhotos').add({ customerKey: KEY, storagePath: null, receivedAt: nowIso() });
  await db.doc(`cameraStatus/${KEY}`).set({ customerKey: KEY, lastSeen: nowIso() });
  const del = await camHealth.deleteCameraCore(db, null, KEY, 'test@swr');
  assert.strictEqual(del.healthDeleted, 2, 'both health rows deleted');
  assert.strictEqual(del.photosDeleted, 1, 'photo metadata deleted');
  assert.strictEqual(del.statusDeleted, 1, 'status row deleted');
  assert.ok(!(await db.doc(`cameraHealth/${KEY}__1`).get()).exists, 'health row is gone');
  assert.ok((await db.doc(`deletedCameras/${KEY}`).get()).exists, 'deletion marker written');

  /* The key sends mail again: marker is consumed exactly once (one log per
     episode) and the re-ingested row is unmatched with no internal flag —
     it re-enters the pending queue instead of resurrecting silently. */
  const marker = await camHealth.consumeDeletedMarker(db, KEY);
  assert.ok(marker && marker.deletedBy === 'test@swr', 'marker consumed with its metadata');
  assert.strictEqual(await camHealth.consumeDeletedMarker(db, KEY), null, 'marker consumed exactly once');
  await camHealth.upsertReportHealthCore(db, {
    parsed: parsedReport(KEY, [1], '07/25/2026'), match: null, today: '07/25/2026', nowIso: nowIso()
  });
  const revived = await db.doc(`cameraHealth/${KEY}__1`).get();
  assert.ok(revived.exists, 're-ingest recreates the row');
  assert.strictEqual(revived.get('customerId'), null, 'revived row is unmatched (pending queue)');
  assert.notStrictEqual(revived.get('internal'), true, 'revived row carries no internal flag');

  console.log('camera-health emulator regression test: ALL PASS');
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
