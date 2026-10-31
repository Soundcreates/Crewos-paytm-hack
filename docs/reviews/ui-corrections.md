# UI correction verification

Frontend changes preserve existing pilot restrictions and scheduler execution semantics. Saved cron rules that match a preset now reopen with their saved time and day; unsupported cron stays custom with its original text. Cadence changes keep the saved timezone and parsed clock. Navigation preserves modified and middle-click browser behavior, and canceled changes leave the mobile menu open. The skip target now has a visible focus ring, the office canvas is not a tab stop, and schedule actions have 44px mobile targets with 8px spacing. Sandbox command evidence is labeled separately from browser and desktop replay.

## Evidence

- `node --test test/frontend-ui-corrections.test.mjs test/schedule-editor-values.test.mjs`: 9 passed.
- `node --test test/schedules.test.mjs test/crewos-release-schedules.test.mjs`: 16 passed, including timezone, DST, month-end, interval, and pilot scheduling checks.
- `npm run check:source`: passed.
- `git diff --check`: passed.
- From `frontend/`, `npx vite build --config vite.config.mjs --outDir /tmp/crewos-ui-corrections-build --emptyOutDir`: passed; 903 modules transformed. Vite emitted its existing dependency warnings about ignored `use client` module directives.

The build output stayed in `/tmp`; `frontend/dist` was left available for the active mounted-browser review. I did not visually retest the changed UI in the mounted browser, so touch layout and focus presentation remain browser-visual checks.
