# CrewOS manager-journey design review

Review date: 2026-10-25
Scope: implemented manager journey against `docs/reviews/scope.md` and `DESIGN_SYSTEM.md`.
Final source checked: `3131e20`

## Recommendation

**APPROVE WITH MINOR CHANGES.** The implemented source provides a coherent, legible manager journey and its calendar name-only edit path preserves the saved rule. The earlier schedule-reset finding is retracted below. Director's separate mounted-browser report confirms a bounded populated employee/schedule flow on source `3131e20`, alongside Settings route checks in [`ux.md`](ux.md). A full end-to-end browser journey is **not** claimed; mobile, live-service, and several lifecycle paths remain open.

## Evidence and limits

### Observed in the mounted browser

In DesignLead's earlier mounted Browser attempt, navigation to `http://localhost:4173` failed with `net::ERR_SOCKS_CONNECTION_FAILED`; no product page rendered in that session. This was followed by a separate successful mounted-browser review on QA assets for source `3131e20`. Director's session was signed in to CrewOS Acceptance and contained Support QA, unlike DesignLead's Personal-only session. See [`populated-browser-acceptance.md`](populated-browser-acceptance.md) for the direct observations. Browser evidence is session-specific: Director observed existing employee/probation evidence and a bounded schedule round trip, but did not rerun probation/deployment or demonstrate successful model-backed work.

### Source and local-test evidence

- The route model covers authentication/reset, workspace setup, employee creation and versioned editing, probation, deployment, schedules, tasks, and task history. See `frontend/src/app/App.jsx`, `AuthPage.jsx`, `EmployeeEditor.jsx`, `SchedulesPage.jsx`, and `OperationsPages.jsx`.
- The UI design system is consistently tokenized: local fonts, light/dark palettes, restrained accent color, visible focus styling, reduced-motion support, and responsive breakpoints are defined in `frontend/src/styles/tokens.css`, `base.css`, and `responsive.css`.
- Calculated token-pair contrast passes the normal-text 4.5:1 target for sampled core pairings: muted text on white 4.83:1; primary action 5.10:1; success 5.27:1; warning 5.65:1; and danger 5.18:1. This is a source calculation, not a rendered-page audit.
- Passed locally: `npm --workspace @solari/frontend run build`, `npm run check:source`, and four focused schedule/office suites (`32/32`). The build emitted third-party bundler warnings about ignored `"use client"` directives, but completed successfully.
- Reproduced by source trace and a bounded browser round trip: opening a saved interval schedule retains its frequency/timezone, and Director's new weekday 14:30 schedule reopened with the same cadence and timezone after pause; a name-only save retained that cadence and paused state. The report does not cover switching an existing cron to a different cadence preset. No release-blocking name-only schedule-reset defect is established.

## Strengths

- The manager flow explains its safety model where decisions happen. The employee wizard states that role edits create a new version and require probation; schedule copy explains current permissions and approval rules; task records separate results, actions, and activity.
- Empty states are actionable: an undeployed workspace directs a manager to Employees before schedule creation, and a task-less team directs the manager to assignment or employee setup.
- The shell includes a skip link, labelled navigation, visible focus treatment, labelled icon buttons, an accessible mobile navigation dialog, semantic tables, and textual status badges rather than color alone.
- Loading and failure states exist at startup, route load, dialog submit, schedule-history fetch, lazy view load, and background operations. Form values are retained for dialog/API errors.
- Narrow-screen source rules replace the sidebar with a modal menu, collapse grids, enlarge general controls to 44px, stack forms, and move task detail into a single-pane flow.

## Reclassified findings and improvements

### [RETRACTED] Name-only calendar edits do not reset the time

**Earlier claim:** editing a weekday schedule at 14:30 and changing only its name sends 09:00.

**Correction:** Existing cron schedules deliberately reopen as `Custom calendar rule`, not as a weekday/daily/monthly preset. The custom field is initialized from the saved cron and the submit mapper returns it unchanged. The exact name-only case therefore preserves `30 14 * * 1-5`. Director's separate mounted-browser pass confirmed that a weekday 14:30 schedule retained its cadence, timezone, and paused state after reopening and a name-only save. The source and this bounded runtime check do not support a required name-only defect.

### [SUGGESTION] Make a deliberate calendar-cadence change safer to review

**Location:** `frontend/src/components/forms/ScheduleEditor.jsx:5`, `:19-22`, and `:30-36`.

An existing cron rule opens as Custom. If a manager deliberately changes Repeats to a preset, `scheduleEditorDefaults` carries parseable clock, weekday, and month-day values into the editor; unsupported or unparseable fields fall back to `09:00`, Monday, or day 1. This is an intentional, visible cadence conversion, not the retracted silent name-only loss. A preview of the resulting rule could make that conversion easier to review. Director's browser pass did not exercise preset conversion from an existing cron.

**Acceptance check:** Start from `30 14 * * 1-5`, choose another cadence, and verify that the visible fields and pre-save summary state the exact resulting local rule; cancel must leave the saved cron unchanged.

### [CLOSED] Static office-map focus stop

**Location:** `frontend/src/components/office/KonvaOfficeScene.jsx:400`; alternatives in `frontend/src/pages/OfficePages.jsx:12` and `frontend/src/components/office/OfficeMap.jsx:52-53`.

The final source removes `tabIndex` from the labelled `role="img"` canvas, and the current Browser exposes Map, Team, and Sessions tabs. This closes the inert static map tab stop finding; populated screen-reader output, edit-layout controls, and save/error announcements still need testing.

### [SUGGESTION] Avoid dense 35px actions on mobile

**Location:** schedule row actions in `SchedulesPage.jsx:48`; `responsive.css:152-156`.

Four compact schedule actions appear in one table cell and `.btn-small` drops to 35px at mobile widths while the main control token is 44px. Keep the primary row action at least 44px on touch layouts and place secondary actions in a labelled overflow menu or an expanded detail row. This will reduce horizontal pressure and accidental destructive taps.

**Acceptance checks:** At 320px, all schedule actions remain visible, have a 44px minimum target or adequate spacing, and Delete retains an explicit confirmation.

### [SUGGESTION] Give the route-load indicator a readable status message

**Location:** `frontend/src/app/App.jsx:238`.

The route fallback is correctly `role="status"`, but its accessible name is only `Loading page`. Add the destination name where available, such as `Loading Schedules`, so a manager switching during an incident understands what is in progress.

**Acceptance checks:** Switching routes announces the route being loaded once, without repeated announcements during normal websocket refreshes.

## Accessibility checklist

| Area | Source result | Browser verification needed |
| --- | --- | --- |
| Keyboard and focus | Visible focus, skip link, modal navigation, Radix dialogs/tabs, and labelled controls are implemented. The mounted Browser confirmed skip-link behavior, Settings keyboard activation/history, and Office tabs. The map is a non-focusable labelled image in final source. | Populated task focus, focus trap/return, escape behavior, screen-reader output, Team/layout alternatives, and save/error announcements. |
| Semantics and labels | Forms use `<label>`, errors use `role="alert"`, tables have headers, status includes text/symbol. | Screen-reader output for forms, async errors, table row actions, live task activity, and map. |
| Contrast | Core token pairs sampled pass 4.5:1. | Rendered chart/canvas/text contrast in both themes and high-contrast preference. |
| Motion | Reduced-motion CSS and Motion hook are present. | Confirm walkthrough, transitions, and office activity stop or simplify with system reduction enabled. |
| Responsive layout | Breakpoints cover 1100px and 767px, including mobile navigation and stacked forms. | Actual 320px/375px/768px screenshots plus horizontal-overflow and dialog-scroll checks. |

## Remaining journey acceptance

The mounted Browser is available and has shown both an empty Personal fixture and a separate populated CrewOS Acceptance fixture. The populated pass confirmed limited employee/evidence inspection and schedule creation, pause, reopen, and name-only-save persistence. It did not complete these remaining checks:

1. A full journey from workspace/invitation and source upload through employee compile/edit, fresh probation/deployment, successful model-backed work, approval/effect, verified evidence, and meeting follow-up.
2. Schedule resume/delete and a complete provider-enabled recurring task lifecycle; direct verification of a deliberate cadence change from an existing cron.
3. Mobile screenshots and interaction at 320px, 375px, and 768px, including overflow, touch targets, and dialog scrolling.
4. Reduced-motion, forced-colors, rendered contrast, and screen-reader checks with populated records, including Office editing, task activity, and save/error announcements.
5. Live Neon Auth and tenant lifecycle, external integrations, provider failure recovery, and production operations.

Director's task detail explicitly reported that OpenRouter was not configured in that QA session; its failed task is expected provider-disabled evidence, not model acceptance. No new probation/deployment, payment, or live provider call was initiated during the populated review.
