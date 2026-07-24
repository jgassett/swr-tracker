/* =====================================================================
 * v2-patch-12: camera-health pipeline write cores — SERVER-SIDE.
 * ---------------------------------------------------------------------
 * Every ingest-pipeline write to cameraHealth lives here, behind one
 * invariant (Item 1): pipeline writes are MERGE-ONLY and never touch an
 * operator-set field — `internal` (marked from the Monitoring pending
 * queue) and the watchdog removal flags must survive every ingest.
 *
 * Sticky internal flag: the operator's mark lands on the docs that exist
 * at flag time, but a later report can renumber devices or add rows,
 * creating sibling docs the mark never touched. The upsert therefore
 * propagates internal=true from any existing doc on the same camera key
 * to every row it writes. It only ever propagates `true` — clearing the
 * flag is the operator's alone (the app writes internal=false on unmark).
 *
 * Kept separate from index.js so the emulator regression test can require
 * this module and exercise the EXACT shipped logic (same pattern as
 * admin-migrations.js). Every core takes the Firestore instance as an
 * argument for the same reason.
 * ===================================================================== */

'use strict';

const cb = require('./cuddeback-parse');
const { normKey } = require('./admin-migrations');

/* Fields the ingest pipeline must NEVER write: `internal` is operator-set
 * (Monitoring pending queue), the removal flags belong to the watchdog +
 * admin confirm, lastNotifiedAt to the alert dedup transaction. Stripping
 * is a regression guard — payloads built below don't include these, but a
 * future edit that adds one must not silently clobber an operator's flag. */
const OPERATOR_FIELDS = [
  'internal',
  'pendingRemoval', 'pendingRemovalAt',
  'removalConfirmed', 'removalConfirmedAt', 'removalConfirmedBy',
  'lastNotifiedAt'
];

function stripOperatorFields(payload) {
  const clean = { ...payload };
  for (const f of OPERATOR_FIELDS) delete clean[f];
  return clean;
}

/* True when any existing health row on this camera key carries the
 * operator's internal mark. */
async function keyMarkedInternal(db, key) {
  const snap = await db.collection('cameraHealth').where('customerKey', '==', key).get();
  return snap.docs.some((d) => d.get('internal') === true);
}

/* Daily status report → one merged health row per device. */
async function upsertReportHealthCore(db, { parsed, match, today, nowIso }) {
  const internal = await keyMarkedInternal(db, parsed.network);
  const batch = db.batch();
  for (const d of parsed.devices) {
    const status = cb.deviceStatus(d, parsed.reportDate, today);
    const payload = stripOperatorFields({
      customerKey: parsed.network,
      customerId: match ? match.id : null,
      customerName: match ? match.name : null,
      propertyId: (match && match.propertyId) || null,
      cameraNumber: d.cameraNumber,
      cameraName: d.cameraName,
      mode: d.mode,
      species: parsed.species || null,
      reportDate: parsed.reportDate,
      battery: d.battery,
      batteryOk: !/low/i.test(d.battery || ''),
      batteryDays: d.batteryDays != null ? d.batteryDays : null,
      sdPhotos: d.sdPhotos != null ? d.sdPhotos : null,
      sdFreeSpace: d.sdFreeSpace,
      sdFreeGB: d.sdFreeGB,
      photoQueue: d.photoQueue != null ? d.photoQueue : null,
      fwVersion: d.fwVersion,
      clVersion: d.clVersion,
      deficiencies: cb.deviceDeficiencies(d),
      status,
      dateCurrent: parsed.reportDate === today,
      updatedAt: nowIso
    });
    if (internal) payload.internal = true;
    batch.set(db.doc(`cameraHealth/${parsed.network}__${d.cameraNumber}`), payload, { merge: true });
  }
  await batch.commit();
  return { devices: parsed.devices.length, internal };
}

/* Unparsed/unmatched status report → the __pending manual-review row. */
async function queueUnmatchedHealthCore(db, { key, reason, subject, receivedAt, nowIso }) {
  const internal = await keyMarkedInternal(db, key);
  const payload = stripOperatorFields({
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
    subject,
    receivedAt,
    updatedAt: nowIso
  });
  if (internal) payload.internal = true;
  await db.doc(`cameraHealth/${key}__pending`).set(payload, { merge: true });
}

/* =====================================================================
 * Item 2: permanent camera deletion (admin callable core).
 * ---------------------------------------------------------------------
 * Deletes the camera key's cameraHealth rows, its cameraPhotos metadata
 * (+ Storage files, best-effort), and its cameraStatus row. Properties
 * and customer records are deliberately untouched. A deletedCameras/{KEY}
 * marker is left behind so the pipeline can LOG the reappearance if the
 * key ever sends mail again — the fresh rows carry no internal flag and
 * no assignment, so a truly stray key re-enters the pending queue as
 * unmatched instead of resurrecting silently, which is correct.
 * ===================================================================== */
async function deleteCameraCore(db, bucket, rawKey, by) {
  const key = normKey(rawKey);
  if (!key) throw new Error('Camera key required.');
  const nowIso = new Date().toISOString();

  /* Health rows — full scan + normalized filter so legacy mixed-case keys
     and rows whose customerKey field is missing (id-prefix only) all go. */
  const healthSnap = await db.collection('cameraHealth').get();
  const healthDocs = healthSnap.docs.filter((d) =>
    normKey(d.get('customerKey') || (d.id.includes('__') ? d.id.split('__')[0] : d.id)) === key);

  /* Photo metadata — pipeline keys are already normalized uppercase. */
  const photoSnap = await db.collection('cameraPhotos').where('customerKey', '==', key).get();

  /* Storage files first, cleanup-job semantics: a photo doc whose file
     delete fails (non-404) is KEPT so the daily retention job retries the
     file — docs deleted here would orphan the bytes forever. */
  let filesDeleted = 0;
  const fileErrors = [];
  const deletablePhotoDocs = [];
  for (const p of photoSnap.docs) {
    const path = p.get('storagePath');
    if (path && bucket) {
      try {
        await bucket.file(path).delete();
        filesDeleted++;
      } catch (err) {
        const code = err && (err.code || (err.errors && err.errors[0] && err.errors[0].reason));
        if (code !== 404 && code !== 'notFound') {
          fileErrors.push(`${path}: ${String((err && err.message) || err).slice(0, 200)}`);
          continue;
        }
      }
    }
    deletablePhotoDocs.push(p);
  }

  /* Status rows (lastSeen/removal flags) — without this the group would
     stay alive in Monitoring and the watchdog would keep alerting. */
  const statusSnap = await db.collection('cameraStatus').get();
  const statusDocs = statusSnap.docs.filter((d) => normKey(d.get('customerKey') || d.id) === key);

  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const d of [...healthDocs, ...deletablePhotoDocs, ...statusDocs]) {
    batch.delete(d.ref);
    if (++ops >= 450) await flush();
  }
  await flush();

  await db.doc(`deletedCameras/${key}`).set({
    key,
    deletedAt: nowIso,
    deletedBy: by || null,
    healthDeleted: healthDocs.length,
    photosDeleted: deletablePhotoDocs.length,
    filesDeleted
  });

  return {
    key,
    healthDeleted: healthDocs.length,
    photosDeleted: deletablePhotoDocs.length,
    filesDeleted,
    statusDeleted: statusDocs.length,
    fileErrors: fileErrors.slice(0, 10)
  };
}

/* Pipeline guard: if this key was permanently deleted, consume the marker
 * and return it so the caller can log the reappearance. One log per
 * resurrection episode — the marker is deleted here, and the key is a live
 * camera again from this moment. */
async function consumeDeletedMarker(db, rawKey) {
  const key = normKey(rawKey);
  if (!key) return null;
  const ref = db.doc(`deletedCameras/${key}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const marker = snap.data();
  await ref.delete();
  return marker;
}

module.exports = {
  OPERATOR_FIELDS,
  stripOperatorFields,
  keyMarkedInternal,
  upsertReportHealthCore,
  queueUnmatchedHealthCore,
  deleteCameraCore,
  consumeDeletedMarker
};
