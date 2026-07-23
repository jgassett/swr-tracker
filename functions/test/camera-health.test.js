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

  /* Regression guard: a future payload edit adding an operator field is
     stripped before it can clobber anything. */
  const stripped = camHealth.stripOperatorFields({ battery: 'OK', internal: false, pendingRemoval: true });
  assert.deepStrictEqual(stripped, { battery: 'OK' }, 'operator-set fields are stripped from pipeline payloads');

  console.log('camera-health emulator regression test: ALL PASS');
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
