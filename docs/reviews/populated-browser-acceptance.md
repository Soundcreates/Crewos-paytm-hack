# Populated browser acceptance

Reviewed by Director on 2026-10-25 in the mounted Browser tab of the Screen panel, at `http://localhost:4186/?acceptance=team-review`. Product source is `3131e20`; the observed script was `/assets/index-DZDHajG4.js`. Repository HEAD during this pass was `b056170` (subsequent documentation only).

## Session boundary

Director's mounted browser is signed in as CrewOS QA Owner in CrewOS Acceptance and contains Support QA. DesignLead reported Test user / Personal in its own session. These are different observed sessions; the Personal fixture limitation does not establish that the Acceptance data is missing. This review used Director's populated session directly.

## Observed checks

- Employees opened Support QA. Its record showed Deployed, role v1, and a passed probation result at 100%.
- The Probation tab's View evidence opened a dialog for Refund over limit, suite v1/spec v1, with `payments.refund` passed. Expected and observed decisions were both REQUIRE_APPROVAL under the refunds-over-$500 policy. Closing the dialog returned to the record. This inspects existing evidence; probation/deployment were not rerun during this pass.
- Schedules showed the existing QA recurring support review at every 60 minutes, Asia/Kolkata, enabled. Run history expanded to six failed occurrences with Open task controls.
- Existing schedule Edit prefilled the correct name, employee, instructions, 60-minute interval and timezone. A temporary name edit followed by Cancel left the persisted name, rule and enabled state unchanged.
- Open task from the latest history entry opened its task detail. Activity showed Task assigned and Task failed. The page explicitly explained that OpenRouter is not configured and requires OPENROUTER_API_KEY for ReAct tasks. This is expected provider-disabled failure evidence, not successful model execution.
- Created a separate disposable schedule named Director QA weekday 1430 for Support QA, weekdays at 14:30, Asia/Calcutta. The list showed the next occurrence on October 26 at 14:30. The mounted fill helper did not populate the native time input correctly initially; the browser eval tool set its native value and dispatched input/change events, after which form validity and the saved list confirmed 14:30. This workaround is automation evidence, not a reported product defect.
- Paused that new schedule. Reopening Edit correctly selected Every weekday and prefilled 14:30 and Asia/Calcutta. Changing only the name to Director QA weekday 1430 verified and saving preserved Weekdays at 14:30, Asia/Calcutta and Paused in the final rendered list.

## State and limits

The new Director QA weekday 1430 verified record remains paused for inspection. The original recurring schedule and employee were not changed. No provider connection, external call, actual payment, task assignment, or new probation/deployment was initiated by this pass. Refund probation evidence is simulated.

Settings direct/keyboard/history acceptance is separately recorded in ux.md. This pass does not certify mobile viewport behavior, reduced motion, complete live auth/tenant lifecycle, live integrations, successful provider-backed tasks, or production configuration. Automated release evidence remains in final-verification.md; earlier PostgreSQL/runtime results apply to the unchanged backend.
