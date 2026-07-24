/* v2-patch-11 Item 4, updated v2-patch-13 Items 1 & 5: scripted simulation
   of the navigation — history stack + overlay-first Back, mirroring
   index.html's logic. Asserts stack contents at every step.
   v2-patch-13 changes modeled here:
   - Item 1 (F-01): the seven local detail Back buttons are gone; the ribbon
     Back is the single exit from every detail view. Covered by the
     re-entry-loop cases at the bottom (bug B-02).
   - Item 5 (owner #4): the landing Back button is gone — landing is the
     root. goBackNav is unreachable from landing (the ribbon lives in #app,
     hidden on landing), so no sequence here calls it there. */
const NAV_HISTORY_MAX = 50;
let navHistory = [], navLastPage = null, navSuppressPush = false;
let appMode = null, currentView = 'dashboard', screen = null;
let overlays = { confirm: false, camAssign: false, camera: false, rebait: false, detailSheet: false, howItWorks: false };

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
function openEstimate() { setView('estimate-detail'); }
function openTask() { if (appMode !== 'jobs' && appMode !== 'schedule') setAppModeQuiet('jobs'); setView('task-detail'); }
function openAppointment() { setView('appointment-detail'); }
function openCloseoutConfirm() { setView('closeout-confirm'); }

/* Sim-only: a fresh app launch (page reload) — history starts empty. */
function freshLaunch() {
  navHistory = []; navLastPage = null; navSuppressPush = false;
  appMode = null; currentView = 'dashboard';
  closeSheetOverlays(); overlays.confirm = false;
  showLanding();
}

let step = 0;
function expect(desc, gotScreen, stackKeys, extra = {}) {
  step++;
  const stack = navHistory.map(navPageKey).join(' | ');
  const want = stackKeys.join(' | ');
  const fail = (m) => { console.error(`FAIL step ${step} (${desc}): ${m}\n  screen=${screen} stack=[${stack}]`); process.exit(1); };
  if (screen !== gotScreen) fail(`screen ${screen} != ${gotScreen}`);
  if (stack !== want) fail(`stack [${stack}] != [${want}]`);
  if (extra.sheet !== undefined && overlays.detailSheet !== extra.sheet) fail(`detailSheet ${overlays.detailSheet} != ${extra.sheet}`);
  console.log(`ok ${String(step).padStart(2)}: ${desc.padEnd(50)} screen=${screen.padEnd(22)} stack=[${stack}]`);
}

/* ---- sequence 1: module navigation, overlays, Home, landing-as-root ---- */
freshLaunch();
expect('boot → landing', 'landing', []);

setAppMode('jobs');
expect('landing → Jobs', 'jobs:dashboard', ['landing']);

openLifecycleJob();
expect('Jobs → Job Detail', 'jobs:job-detail', ['landing', 'jobs:dashboard']);

viewJobRecords();
expect('Job Detail → View Records (job filter)', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail']);

openDetail();
expect('record sheet opens (overlay, no stack change)', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail'], { sheet: true });

goBackNav();
expect('Back closes record sheet only', 'allrecords:dashboard', ['landing', 'jobs:dashboard', 'jobs:job-detail'], { sheet: false });

goBackNav();
expect('Back → Job Detail', 'jobs:job-detail', ['landing', 'jobs:dashboard']);

goBackNav();
expect('Back → Jobs', 'jobs:dashboard', ['landing']);

setView('menu');
expect('Home → landing (page left is pushed; landing is root, no Back)', 'landing', ['landing', 'jobs:dashboard']);

/* landing has no Back button — the only exits are module entries */
setAppMode('field');
expect('landing → Monitoring', 'field:dashboard', ['landing', 'jobs:dashboard', 'landing']);

showFieldDetail();
expect('Monitoring → camera detail', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard']);

/* two overlays stacked: record-style sheet + confirm — Back peels one at a time */
openDetail(); confirmDialog();
goBackNav();
expect('Back closes confirm first', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard'], { sheet: true });
goBackNav();
expect('Back closes sheet second', 'field:field-detail', ['landing', 'jobs:dashboard', 'landing', 'field:dashboard'], { sheet: false });

goBackNav();
expect('Back → Monitoring dashboard (not landing)', 'field:dashboard', ['landing', 'jobs:dashboard', 'landing']);

goBackNav();
expect('Back pops the landing entry → landing (root; stops here)', 'landing', ['landing', 'jobs:dashboard']);

/* legacy schedule detail, entered from schedule; residue below the last
   landing entry stays parked — landing is the floor, Back can't dig past it */
setAppMode('schedule');
openJob();
expect('schedule → legacy job detail', 'schedule:schedule-detail',
  ['landing', 'jobs:dashboard', 'landing', 'schedule:dashboard']);
goBackNav();
expect('Back → schedule dashboard (not landing)', 'schedule:dashboard',
  ['landing', 'jobs:dashboard', 'landing']);
goBackNav();
expect('Back → landing again (floor)', 'landing', ['landing', 'jobs:dashboard']);

/* ---- sequence 2: Back on empty history = landing, no stack growth ---- */
freshLaunch();
setAppMode('trap');
expect('fresh launch → Trapping', 'trap:dashboard', ['landing']);
goBackNav();
expect('Back → landing', 'landing', []);
setAppMode('trap');
goBackNav(); /* pops 'landing' → landing */
expect('re-enter + Back → landing (no growth)', 'landing', []);

/* ---- sequence 3 (v2-patch-13 Item 1, F-01): local Backs removed; ribbon
   Back is the single exit. Formerly a local Back did setView('dashboard'),
   pushing the exited detail onto the stack, so the NEXT ribbon Back
   re-entered it (bug B-02). For each detail: enter → ribbon Back lands on
   the dashboard → second ribbon Back lands on landing, never the detail. */
const detailCases = [
  ['estimate-detail', 'pricing', openEstimate],
  ['schedule-detail', 'schedule', openJob],
  ['job-detail', 'jobs', openLifecycleJob],
  ['task-detail', 'jobs', openTask],
  ['appointment-detail', 'jobs', openAppointment],
  ['closeout-confirm', 'closeout', openCloseoutConfirm],
  ['field-detail', 'field', showFieldDetail],
];
for (const [view, mode, enter] of detailCases) {
  freshLaunch();
  setAppMode(mode);
  expect(`landing → ${mode} dashboard`, `${mode}:dashboard`, ['landing']);
  enter();
  expect(`${mode} dashboard → ${view}`, `${mode}:${view}`, ['landing', `${mode}:dashboard`]);
  goBackNav();                       /* ribbon Back — the ONLY exit now */
  expect(`ribbon Back exits ${view}`, `${mode}:dashboard`, ['landing']);
  goBackNav();                       /* second Back must NOT re-enter the detail */
  expect(`second Back → landing (no ${view} re-entry)`, 'landing', []);
}

console.log('\nnav v2.11 simulation: ALL steps passed');
