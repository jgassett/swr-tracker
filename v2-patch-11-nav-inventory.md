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
3. Stack survives reloads: persisted to `sessionStorage` (iOS PWA
   relaunches and the v2.8 terminated-client recovery reload no longer
   wipe Back's memory); still cleared at the sign-in screen.
