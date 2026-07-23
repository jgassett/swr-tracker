/* v2-patch-11 Item 4: scripted simulation of the reworked navigation —
   history stack + overlay-first Back, mirroring index.html's logic.
   Asserts stack contents at every step. */
const NAV_HISTORY_MAX = 50;
let navHistory = [], navLastPage = null, navSuppressPush = false;
let appMode = null, currentView = 'dashboard', screen = null;
let overlays = { confirm: false, camAssign: false, camera: false, rebait: false, detailSheet: false, howItWorks: false };
let landingBackVisible = false;

const navPageKey = (p) => p ? (p.landing ? 'landing' : `${p.mode}:${p.view}`) : '';
function recordNavArrival(page) {
  if (!navSuppressPush && navLastPage && navPageKey(navLastPage) !== navPageKey(page)) {
    navHistory.push(navLastPage);
    if (navHistory.length > NAV_HISTORY_MAX) navHistory.shift();
  }
  navLastPage = page;
}
function closeSheetOverlays() { overlays.camAssign = overlays.camera = overlays.rebait = overlays.detailSheet = overlays.howItWorks = false; }
function showLanding() {
  screen = 'landing';
  recordNavArrival({ landing: true });
  landingBackVisible = navHistory.length > 0;
}
function backToLanding() { closeSheetOverlays(); currentView = 'dashboard'; showLanding(); }
function setAppModeQuiet(m) { appMode = m; }
function setView(name, opts) {
  if (name === 'menu') { backToLanding(); return; }
  currentView = name; screen = `${appMode}:${name}`;
  recordNavArrival({ mode: appMode, view: name });
}
function setAppMode(m) { appMode = m; setView('dashboard'); }
function closeTopOverlay() {
  for (const k of ['confirm', 'camAssign', 'camera', 'rebait', 'detailSheet', 'howItWorks']) {
    if (overlays[k]) { overlays[k] = false; return true; }
  }
  return false;
}
function goBackNav() {
  if (closeTopOverlay()) return;
  const prev = navHistory.pop();
  if (!prev || prev.landing) {
    navSuppressPush = true;
    try { backToLanding(); } finally { navSuppressPush = false; }
    return;
  }
  navSuppressPush = true;
  try {
    if (appMode !== prev.mode) setAppModeQuiet(prev.mode);
    setView(prev.view, { preserveForm: true });
  } finally { navSuppressPush = false; }
}
/* App entry points, as now implemented */
function openLifecycleJob() { if (appMode !== 'jobs' && appMode !== 'schedule') setAppModeQuiet('jobs'); setView('job-detail'); }
function viewJobRecords() { setAppMode('allrecords'); }
function openDetail() { overlays.detailSheet = true; }        /* record sheet */
function confirmDialog() { overlays.confirm = true; }
function showFieldDetail() { if (appMode !== 'field') setAppModeQuiet('field'); setView('field-detail'); }
function openJob() { if (appMode !== 'schedule') setAppModeQuiet('schedule'); setView('schedule-detail'); }

let step = 0;
function expect(desc, gotScreen, stackKeys, extra = {}) {
  step++;
  const stack = navHistory.map(navPageKey).join(' | ');
  const want = stackKeys.join(' | ');
  const fail = (m) => { console.error(`FAIL step ${step} (${desc}): ${m}\n  screen=${screen} stack=[${stack}]`); process.exit(1); };
  if (screen !== gotScreen) fail(`screen ${screen} != ${gotScreen}`);
  if (stack !== want) fail(`stack [${stack}] != [${want}]`);
  if (extra.sheet !== undefined && overlays.detailSheet !== extra.sheet) fail(`detailSheet ${overlays.detailSheet} != ${extra.sheet}`);
  if (extra.landingBack !== undefined && landingBackVisible !== extra.landingBack) fail(`landingBack ${landingBackVisible} != ${extra.landingBack}`);
  console.log(`ok ${String(step).padStart(2)}: ${desc.padEnd(46)} screen=${screen.padEnd(22)} stack=[${stack}]`);
}

/* ---- the scripted sequence: 12 navigations + overlay opens, Home mid-sequence ---- */
showLanding();
expect('boot → landing', 'landing', [], { landingBack: false });

setAppMode('jobs');                                             // nav 1
expect('landing → Jobs', 'jobs:dashboard', ['landing']);

openLifecycleJob();                                             // nav 2
expect('Jobs → Job Detail', 'jobs:job-detail', ['landing', 'jobs:dashboard']);

viewJobRecords();                                               // nav 3
expect('Job Detail → View Records (job filter)', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail']);

openDetail();                                                   // overlay open
expect('record sheet opens (overlay, no stack change)', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail'], { sheet: true });

goBackNav();                                                    // nav 4 (overlay close)
expect('Back closes record sheet only', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail'], { sheet: false });

goBackNav();                                                    // nav 5
expect('Back → Job Detail', 'jobs:job-detail', ['landing', 'jobs:dashboard']);

goBackNav();                                                    // nav 6
expect('Back → Jobs', 'jobs:dashboard', ['landing']);

setView('menu');                                                // nav 7: HOME mid-sequence
expect('Home → landing (page left is pushed)', 'landing', ['landing', 'jobs:dashboard'], { landingBack: true });

goBackNav();                                                    // nav 8: landing Back
expect('Back after Home → the page you left', 'jobs:dashboard', ['landing']);

setView('menu');                                                // nav 9
expect('Home again', 'landing', ['landing', 'jobs:dashboard'], { landingBack: true });

setAppMode('field');                                            // nav 10
expect('landing → Monitoring', 'field:dashboard', ['landing', 'jobs:dashboard', 'landing']);

showFieldDetail();                                              // nav 11 (was Class-c bypass)
expect('Monitoring → camera detail (BUG A path)', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard']);

/* two overlays stacked: record-style sheet + confirm — Back peels one at a time */
openDetail(); confirmDialog();
goBackNav();
expect('Back closes confirm first', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard'], { sheet: true });
goBackNav();
expect('Back closes sheet second', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard'], { sheet: false });

goBackNav();                                                    // nav 12
expect('Back → Monitoring dashboard (NOT landing — BUG A fixed)', 'field:dashboard', ['landing', 'jobs:dashboard', 'landing']);

goBackNav();
expect('Back → landing', 'landing', ['landing', 'jobs:dashboard'], { landingBack: true });

goBackNav();
expect('landing Back → jobs dashboard', 'jobs:dashboard', ['landing']);

/* legacy schedule detail (the other Class-c bypass), entered from schedule */
setView('menu');
setAppMode('schedule');
openJob();
expect('schedule → legacy job detail (BUG A path 2)', 'schedule:schedule-detail',
  ['landing', 'jobs:dashboard', 'landing', 'schedule:dashboard']);
goBackNav();
expect('Back → schedule dashboard (not landing)', 'schedule:dashboard',
  ['landing', 'jobs:dashboard', 'landing']);

/* drain to empty; Back on empty = Home, no stack growth */
goBackNav(); goBackNav(); goBackNav(); goBackNav();
expect('drained to landing', 'landing', [], { landingBack: false });
goBackNav();
expect('Back on empty history = Home (no growth)', 'landing', [], { landingBack: false });

console.log('\nnav v2.9 simulation: ALL steps passed');
