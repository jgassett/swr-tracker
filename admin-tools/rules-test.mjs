/* v2-patch-13 security audit (Pass 1): firestore.rules tests for the Item 12
   cameraPhotos update narrowing — per-operator hiddenBy self-hide + the
   assignment shape — plus regression checks on the neighboring
   camera-collection rules. Run from the repo root:
     JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
     npx firebase-tools emulators:exec --only firestore --project swr-tracker-54dfd \
       "node admin-tools/rules-test.mjs" */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'swr-tracker-54dfd',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
});

let step = 0, failed = 0;
async function check(desc, p) {
  step++;
  try { await p; console.log(`ok ${String(step).padStart(2)}: ${desc}`); }
  catch (e) { failed++; console.error(`FAIL ${step}: ${desc}\n   ${e.message}`); }
}

const ALICE = 'alice@southern-wildlife.com';
const BOB = 'bob@southern-wildlife.com';
const JON = 'jon@southern-wildlife.com';

/* Seed data with rules disabled. */
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'cameraPhotos/P1'), {
    customerKey: 'HAYDENT1', storagePath: 'cuddeback/p1.jpg',
    customerId: null, customerName: '', assigned: false,
    hiddenBy: [ALICE],
  });
  await setDoc(doc(ctx.firestore(), 'cameraHealth/D1'), {
    customerKey: 'HAYDENT1', cameraName: 'Cam 1', internal: false, battery: 'OK',
  });
});

const bob = env.authenticatedContext('bob-uid', { email: BOB }).firestore();
const jon = env.authenticatedContext('jon-uid', { email: JON }).firestore();
const anon = env.unauthenticatedContext().firestore();

/* ---- cameraPhotos: reads and the hiddenBy self-hide ---- */
await check('unauthenticated read denied',
  assertFails(getDoc(doc(anon, 'cameraPhotos/P1'))));
await check('signed-in read allowed',
  assertSucceeds(getDoc(doc(bob, 'cameraPhotos/P1'))));
await check('bob adds HIS OWN email to hiddenBy',
  assertSucceeds(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [ALICE, BOB] })));
await check('bob removes HIS OWN email from hiddenBy',
  assertSucceeds(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [ALICE] })));
await check("bob CANNOT remove alice's email",
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [] })));
await check("bob CANNOT add carol's email",
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [ALICE, 'carol@x.com'] })));
await check('bob CANNOT swap himself in while pulling alice out (one write)',
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [BOB] })));
await check('bob CANNOT set hiddenBy to a non-list',
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: 'all' })));
await check('bob CANNOT combine a self-hide with another field',
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { hiddenBy: [ALICE, BOB], archived: true })));
await check('admin (jon) is bound by the same rule — cannot clear alice',
  assertFails(updateDoc(doc(jon, 'cameraPhotos/P1'), { hiddenBy: [] })));
await check('jon can add his own email like anyone else',
  assertSucceeds(updateDoc(doc(jon, 'cameraPhotos/P1'), { hiddenBy: [ALICE, JON] })));

/* ---- cameraPhotos: the assignment shape stays available ---- */
await check('assignment stamping shape allowed (customer/property/assigned/updatedAt)',
  assertSucceeds(updateDoc(doc(bob, 'cameraPhotos/P1'), {
    customerId: 'C9', customerName: 'Hayden', propertyId: 'PR1', assigned: true,
    updatedAt: new Date().toISOString(),
  })));
await check('arbitrary field update denied (storagePath)',
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { storagePath: 'evil.jpg' })));
await check('legacy deletedBy is read-only history — writes denied',
  assertFails(updateDoc(doc(bob, 'cameraPhotos/P1'), { deletedBy: [BOB] })));

/* ---- cameraPhotos: deletion stays admin-only ---- */
await check('operator delete denied',
  assertFails(deleteDoc(doc(bob, 'cameraPhotos/P1'))));
await check('admin delete allowed',
  assertSucceeds(deleteDoc(doc(jon, 'cameraPhotos/P1'))));

/* ---- regression: cameraHealth single-field internal rule unchanged ---- */
await check('cameraHealth: internal flag toggle allowed',
  assertSucceeds(updateDoc(doc(bob, 'cameraHealth/D1'), { internal: true })));
await check('cameraHealth: non-bool internal denied',
  assertFails(updateDoc(doc(bob, 'cameraHealth/D1'), { internal: 'yes' })));
await check('cameraHealth: any other field denied',
  assertFails(updateDoc(doc(bob, 'cameraHealth/D1'), { battery: 'LOW' })));
await check('cameraHealth: client create denied',
  assertFails(setDoc(doc(bob, 'cameraHealth/D2'), { internal: true })));

await env.cleanup();
if (failed) { console.error(`\nrules-test: ${failed} FAILURE(S)`); process.exit(1); }
console.log('\nrules-test: ALL steps passed');
