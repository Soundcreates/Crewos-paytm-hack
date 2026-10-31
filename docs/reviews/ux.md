# CrewOS UX acceptance review

Review date: 2026-10-25
Branch: `crewos/product-completion`
Final source/build reviewed: `3131e20`
Runtime reviewed: signed-in mounted Browser tab at `http://localhost:4186/?acceptance=team-review`
Served asset verification: Browser loaded `/assets/index-DZDHajG4.js` and `/assets/index-OiZRCyVR.css`, the current QA assets named by the delivery lead.

## Decision

**APPROVE WITH TARGETED GAPS.** A real, signed-in manager shell rendered from the current build in the mounted Browser tab. Initial setup, guarded empty states, Reports, keyboard skip-to-content, Office view tabs, the employee wizard, light/dark theme switching, and Settings routing work.

This supersedes the prior unavailable-browser report and **retracts** its unsupported claim that a name-only schedule edit resets the time. The Personal test fixture had no employees, tasks, schedules, sources, meetings, people, or reports, so record-level workflows in this session were unverified rather than failed.

**Session boundary:** this report describes DesignLead's signed-in `Personal` workspace. Director's separate mounted-browser session used `CrewOS Acceptance` with `Support QA` and verified additional bounded employee/schedule behavior; see [`populated-browser-acceptance.md`](populated-browser-acceptance.md). The empty Personal fixture does not mean the Acceptance fixture was unavailable to every session.

## Actual mounted-browser evidence

| Area | Observation | Result |
| --- | --- | --- |
| Session | Signed in as `Test user / Owner`, workspace `Personal`. | Pass |
| Overview | “Set up your first employee” showed named Hire, Integrations, Upload source, and Invite actions. Probation/deployment actions were disabled until prerequisites exist. | Pass |
| Employees | Heading, search, status filter, card/list controls, and Hire employee rendered. | Pass, empty fixture |
| Hiring | Four-step labelled wizard (Role, Responsibilities, Access, Probation and review) exposed labelled required fields. Cancel returned to Employees without creating data. | Pass |
| Tasks | Search and filters rendered. Assign task displayed `Deploy an employee before assigning a live task.` | Pass, guarded empty state |
| Schedules | Create schedule was disabled; Open employees offered the prerequisite path. | Pass, guarded empty state |
| Office | Map, Team, and Sessions are labelled tabs. Team selected successfully and showed its zero-employee state. | Pass |
| People, Knowledge, Meetings | Correct page headings and primary controls rendered. Knowledge exposed Search, Sources 0, and Notes 0 tabs. | Pass, empty fixture |
| Keyboard | After reload, the first Tab focused Skip to content. Enter moved focus to `#page-content`. | Pass |
| Theme | Light mode changed the document theme and relabelled the control `Switch to dark mode`; dark was restored. | Pass |
| Final assets | Mounted Browser loaded `/assets/index-DZDHajG4.js` and `/assets/index-OiZRCyVR.css`, the current QA assets. | Pass |
| Settings direct load | Both `#settings` and `#/settings?tab=members` rendered Settings / Workspace. | Pass |
| Settings keyboard and history | Keyboard Enter on the Settings link rendered Settings / Workspace; Back returned Overview and Forward restored Settings / Workspace. | Pass |
| Provider-free fixture attempt | In this Personal session no SupportQA fixture appeared. The employee wizard allows no tool-less employee. Every non-finance option was disabled for missing provider setup; the sole enabled option grants `payments.refund`. The role was not saved or granted this capability. | Session-specific blocker |

Evidence screenshots captured in the mounted Browser:

- [Overview empty state](ux-browser-overview-empty.png)
- [Employees empty state](ux-browser-employees-empty.png)
- [Office Team empty state](ux-browser-office-team.png)

## Corrected schedule finding

### [RETRACTED] Name-only calendar edits reset time

The former report said changing only the name of `30 14 * * 1-5` could persist `09:00`. That was not browser-observed and conflicts with the reviewed source path: an existing cron reopens as Custom calendar rule and submits the stored cron unchanged unless the manager deliberately selects a different cadence. No release-blocking schedule-reset defect is established.

### [CORRECTED] Preset cadence conversion now preserves parseable schedule values

**Source-only confirmation from current build:** `frontend/src/components/forms/schedule-values.js`.

The current `scheduleEditorDefaults` parses supported cron time, weekday, and month-day values before populating the editor. The prior suggestion that selecting a preset necessarily defaulted an existing 14:30 rule to 09:00 is stale and withdrawn. The Personal fixture had no schedule record. Director's separate populated session later confirmed that a created weekday 14:30 schedule reopened with its time and timezone and retained them after a name-only save; it did not exercise changing the cadence preset on an existing cron record.

## Follow-ups, clearly separated

### [CORRECTED] Static Office map no longer creates an inert tab stop

**Source and mounted-browser confirmation:** `frontend/src/components/office/KonvaOfficeScene.jsx:400` now renders a labelled `role="img"` without `tabIndex`. The Browser still exposes working Map, Team, and Sessions tabs. The earlier inert-focus-stop suggestion is stale and withdrawn. Populated-data screen-reader and edit-layout checks remain open.

### [CLOSED] Settings routing

On final QA assets, direct `#settings` and `#/settings?tab=members` loads, keyboard activation, Back, and Forward all rendered the Settings heading and Workspace panel. The earlier routing blocker is closed.

## Acceptance gaps

| Area | Status |
| --- | --- |
| Session-specific fixture | DesignLead's session exposed only the empty Personal workspace. Director separately observed CrewOS Acceptance / Support QA. These are different signed-in sessions, not contradictory reports. |
| Populated employee, probation evidence, and schedule round trip | Director inspected the already deployed Support QA employee and its existing simulated 100% passing probation evidence, and verified a separate weekday 14:30 schedule remains paused after reopen/name-only save. No probation/deployment was rerun; the original 60-minute schedule was left unchanged. See [`populated-browser-acceptance.md`](populated-browser-acceptance.md). |
| Task activity and provider-backed execution | Director opened an existing task with assigned/failed activity and a clear missing-OpenRouter configuration error. This is verified failure-state evidence, not a successful model-backed task or a newly approved/executed action. |
| Remaining schedule lifecycle | Schedule history was opened and the new schedule was paused and edited. Resume, delete, and a complete create-to-run lifecycle remain unverified. |
| Full journey, tenant lifecycle, version staleness | Workspace invitation, source-to-employee compilation, fresh probation/deployment, successful assignment/approval/effect, and meeting follow-up remain unverified end to end. |
| Mobile 320/375/768px, horizontal overflow, touch targets, mobile dialog | Not tested: mounted Browser exposed no viewport control |
| Reduced motion, forced colors, rendered contrast | Not tested in runtime |
| Live providers, integrations, OAuth, email/recovery, Neon persistence | Intentionally untested; no external or destructive action was taken |

## Recommendation

Settings routing is accepted on final QA assets. Director's separate populated session confirms a limited employee/schedule review, while the Personal session-specific fixture boundary remains as recorded above. Neither session demonstrates the full manager journey. Responsive/mobile, reduced-motion, forced-colors, rendered-contrast, populated-data screen-reader, live-provider, and persistence checks remain separate acceptance gaps.
