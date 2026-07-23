/* =====================================================================
 * v2-patch-8: admin data-management migrations — SERVER-SIDE cores.
 * ---------------------------------------------------------------------
 * These ran client-side in v2-patch-7 and died with "The client has
 * already been terminated": the Firestore Web SDK's persistent multi-tab
 * cache shuts down permanently when the tab loses its IndexedDB lease
 * mid-run (iOS suspending the PWA during a minutes-long sequential write
 * loop). The Admin SDK has no such failure mode, no rules latency, and no
 * per-write network round-trip from a phone.
 *
 * Kept separate from index.js so the emulator functional test can require
 * this module directly and run the EXACT shipped logic against seeded
 * data (FIRESTORE_EMULATOR_HOST). Both cores take the Firestore instance
 * as an argument for the same reason.
 * ===================================================================== */

'use strict';

/* Backfill: one "Primary" property per customer with an EMPTY properties
 * subcollection, built from the customer's home address fields. Idempotent
 * — customers with any property are skipped, so running twice is safe. */
async function backfillPrimaryPropertiesCore(db) {
  const [custSnap, propSnap] = await Promise.all([
    db.collection('customers').get(),
    db.collectionGroup('properties').get()
  ]);
  const hasProps = new Set();
  propSnap.forEach((d) => {
    const cid = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (cid) hasProps.add(cid);
  });
  const nowIso = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  let backfilled = 0;
  let skipped = 0;
  for (const d of custSnap.docs) {
    if (hasProps.has(d.id)) { skipped++; continue; }
    batch.set(d.ref.collection('properties').doc(), {
      customerId: d.id,
      siteNickname: 'Primary',
      address: d.get('address') || '',
      city: d.get('city') || '',
      county: d.get('county') || '',
      insideCityLimits: null,
      cameraId: '',
      isPrimary: true,
      autoCreated: true,
      manuallyEdited: false,
      createdAt: nowIso,
      createdByUid: null,
      createdByEmail: 'admin-backfill',
      updatedAt: nowIso
    });
    backfilled++;
    if (++ops >= 450) await flush();
  }
  await flush();
  return { backfilled, skipped };
}

/* Re-link: every cameraHealth record's camera key matched against property
 * cameraIds — EXACT string match only (the property record is the single
 * source of truth; no fuzzy name matching server-side). Matches get their
 * denormalized link fields (customerId / customerName / propertyId)
 * refreshed on the cameraHealth docs and the per-network cameraStatus doc,
 * so previously-pending rows resolve. Returns the unique keys linked and
 * the unique keys that still match nothing (the pending queue). */
async function relinkCamerasCore(db) {
  const [healthSnap, propSnap, custSnap, statusSnap] = await Promise.all([
    db.collection('cameraHealth').get(),
    db.collectionGroup('properties').get(),
    db.collection('customers').get(),
    db.collection('cameraStatus').get()
  ]);
  const nameById = new Map();
  custSnap.forEach((d) => nameById.set(d.id, d.get('name') || ''));
  const byCam = new Map();
  propSnap.forEach((d) => {
    const cam = (d.get('cameraId') || '').trim().toUpperCase();
    if (!cam) return;
    const customerId = d.get('customerId') || (d.ref.parent.parent ? d.ref.parent.parent.id : null);
    if (!customerId) return;
    byCam.set(cam, { customerId, propertyId: d.id, customerName: nameById.get(customerId) || '' });
  });

  const nowIso = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  const linkedKeys = new Set();
  const unmatchedKeys = new Set();

  const keyOf = (d) =>
    ((d.get('customerKey') || (d.id.includes('__') ? d.id.split('__')[0] : d.id)) || '')
      .trim().toUpperCase();

  for (const d of healthSnap.docs) {
    const key = keyOf(d);
    if (!key) continue;
    const match = byCam.get(key);
    if (!match) { unmatchedKeys.add(key); continue; }
    linkedKeys.add(key);
    if (d.get('customerId') !== match.customerId || d.get('propertyId') !== match.propertyId
        || d.get('customerName') !== match.customerName) {
      batch.set(d.ref, {
        customerId: match.customerId,
        customerName: match.customerName,
        propertyId: match.propertyId,
        updatedAt: nowIso
      }, { merge: true });
      if (++ops >= 450) await flush();
    }
  }
  for (const d of statusSnap.docs) {
    const key = ((d.get('customerKey') || d.id) || '').trim().toUpperCase();
    const match = byCam.get(key);
    if (!match) continue;
    if (d.get('customerId') !== match.customerId || d.get('propertyId') !== match.propertyId
        || d.get('customerName') !== match.customerName) {
      batch.set(d.ref, {
        customerId: match.customerId,
        customerName: match.customerName,
        propertyId: match.propertyId,
        updatedAt: nowIso
      }, { merge: true });
      if (++ops >= 450) await flush();
    }
  }
  await flush();
  return { linked: linkedKeys.size, unmatched: [...unmatchedKeys].sort() };
}

module.exports = { backfillPrimaryPropertiesCore, relinkCamerasCore };
