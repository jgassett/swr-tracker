# v2-patch-11 Item 1 — Navigation trace & view/overlay inventory

## How the history system works (v2.8, patch-10 Item 5)

- `setView(name)` reveals one `<section id="view-…">` and calls
  `recordNavArrival({mode, view})`; `showLanding()` records `{landing:true}`.
- `recordNavArrival` pushes the page being **left** whenever the arriving
  page key differs (`navHistory`, cap 50); `goBackNav()` pops one entry and
  restores it (`setAppModeQuiet` + `setView(view, {preserveForm})`), with
  pushes suppressed during the restore.
- The stack lives only in memory and only `setView`/`showLanding` feed it.

## Root cause of both bugs

**Anything that puts UI on screen without `setView` is invisible to Back.**

- **BUG A** — two full-screen views are revealed by hiding all `.view`
  sections and calling `classList.remove('hidden')` directly, so their
  arrival is never recorded and `currentView` goes stale:
  - `view-field-detail` via `showFieldDetail()` (camera detail;
    Monitoring row tap + notification "view camera" action)
  - `view-schedule-detail` via `openJob()` (legacy calendar job detail;
    schedule row tap)

  Sequence *landing → Monitoring → camera detail → Back*: the stack holds
  only `[landing]` (the detail push never happened), so Back lands on the
  landing page — "Back always returns to landing" for the highest-traffic
  detail views. The patch-10 audit fix (landing re-push suppression) was a
  different, real bug; this is the residual variant.

- **BUG B** — record detail (trapping/pesticide, incl. from View Records)
  is the `#detailSheet` bottom-sheet overlay (`openDetail` /
  `openPesticideDetail` → `openSheet`). It *does* have a Close button and
  backdrop-tap dismissal, but:
  - the Close button sits at the **bottom of scrollable sheet content**,
    below the detail rows and photo — off-screen on a long record on an
    iPhone viewport;
  - the bottom-anchored sheet **covers the ribbon** (backdrop z-80,
    sheet z-90), so the global Back button is physically unreachable;
  - the global Back doesn't know overlays exist — on desktop
    (master-detail side panel) it navigates the page *underneath* while
    the sheet stays open on top (the sheet lives outside `#app`).

  Net effect on a phone: the only exits are a thin backdrop strip at the
  top or scrolling to find "Close" — perceived as trapped.

## Complete classification (35/35 `view-*` sections match setView's hide list — no orphans either direction)

### (a) Full-screen views routed through setView — history-safe
dashboard family (all modes incl. records-all/settings/notes/closeout),
records, records-pesticide, add family (add, add-pesticide, add-customer,
add-job, add-task, add-appointment, add-note, add-schedule,
estimate-builder), estimate-detail (`showEstimateDetail`), job-detail
(`openLifecycleJob`), task-detail (`openTask`), appointment-detail
(`openAppointment`), closeout-confirm (`openCloseoutConfirm`),
assign-legacy, notifications (own return button also routes via
setView/backToLanding), settings + 5 sub-screens (each with
`data-settings-back`).

### (b) Overlays/modals with their own close control — but invisible to Back
| Overlay | Close affordance today | Off-screen risk on iPhone |
|---|---|---|
| `#detailSheet` (record detail/review) | bottom "Close" btn + backdrop | **YES** — Close below rows/photo |
| `#rebaitSheet` | cancel via `[data-rebait]` + backdrop | bottom of content |
| `#cameraSheet` | `#cameraSheetCancel` + backdrop | bottom of content |
| `#camAssignSheet` | `#camAssignCancel` + backdrop | bottom of content (long form) |
| `#howItWorksSheet` | `#flowSheetCloseBtn` + own backdrop | bottom of content |
| `#pesticideEditOverlay` | header **and** footer cancel | no (header X) |
| `#confirm` dialog | Cancel/OK buttons | no (compact) |
| `#propertyForm` (inline editor inside add-customer) | `#cancelPropertyBtn` | inline, not an overlay layer |

### (c) Trapped relative to the nav system
- `view-field-detail` (`showFieldDetail`) — local "Back to Monitoring"
  exists but sits at the **bottom** of the content; history bypassed.
- `view-schedule-detail` (`openJob`) — local "Back to Calendar" exists;
  history bypassed.
- `#detailSheet` opened as record detail — close affordance can be
  off-screen; ribbon covered; Back unaware (see BUG B above).

## Fix policy (Item 2)

1. Every full-screen view routes through `setView` → automatic history +
   ribbon Back exit. (`showFieldDetail`, `openJob` rewritten.)
2. Every overlay keeps an explicit close control **visible without
   scrolling** (sticky ✕ pinned to the sheet's top-right, added to all
   five `.sheet` overlays) AND is dismissed by the global Back —
   `goBackNav()` closes the topmost open overlay first (one overlay per
   press), before popping history. Home closes all sheet overlays before
   leaving so nothing floats over the landing page.
3. Back = exactly one step everywhere; Home is itself a recorded
   navigation, and the landing page gains a Back button (hidden when the
   stack is empty) so Back after Home returns to the page you left.
   Persisting the stack across reloads was considered and REJECTED: the
   app always boots to the landing page and every module entry pushes a
   landing entry above any restored history — restored entries would sit
   unreachable beneath it. History is per-app-lifetime by design; after a
   reload, Back appears once you navigate.

## Verification (Item 4)

**Scripted simulation** — `admin-tools/nav-sim.mjs` mirrors the shipped
logic (recordNavArrival / goBackNav / closeTopOverlay / landing Back) and
asserts screen + full stack contents at 22 steps across 12+ navigations:
the brief's acceptance sequence (landing → Jobs → Job Detail → records →
record sheet, Back ×N: sheet, Job Detail, Jobs, landing), Home
mid-sequence with Back-after-Home, both former Class-c paths (camera
detail, legacy schedule detail) now returning to their dashboards instead
of landing, two stacked overlays (sheet + confirm) peeled one per Back
press, drain-to-empty, and Back-on-empty = Home with no stack growth.
All 22 assertions pass.

**iPhone-viewport exit affordances** (static CSS verification — every
value checked in the stylesheet):
- All five `.sheet` overlays: the new ✕ sits in a `position: sticky;
  top: 0` zero-height row placed directly after the sheet handle, inside
  the sheet's own scroll container (`max-height: 86vh; overflow-y:
  auto`), and `openSheet` resets `scrollTop` — the ✕ is on screen the
  moment the sheet opens and stays pinned while scrolling, at any
  viewport width including 375 pt iPhone.
- Every full-screen view: the exit is the ribbon Back in `#bottomNav`
  (`position: fixed; bottom: 0; z-index: 50`) — never scrolls off.
- Landing page: Back lives in the `landing-banner` (`position: fixed;
  bottom: 0`).
- `#pesticideEditOverlay`: ✕ in its fixed `.edit-modal-header` at the top
  of the overlay.
- `#confirm` dialog: compact centered modal; buttons always in view.
