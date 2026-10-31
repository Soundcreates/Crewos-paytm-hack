# Settings route correction

The route parser now accepts `settings` directly even though the Settings link is rendered separately from grouped navigation. This works in full and pilot mode; pilot still excludes `schedules`. Query-bearing Settings hashes remain on Settings, and unknown routes still fall back to Overview.

## Evidence

- `node --test test/frontend-auth-api.test.mjs`: 3 passed. Coverage iterates each visible grouped route in both modes, checks `#settings` and `#/settings` in both modes, Settings hashes with query parameters, pilot schedule exclusion, and unknown-route fallback.
- `npm run check:source`: passed.
- `git diff --check`: passed.
- `npm run build:ui`: passed; Vite transformed 903 modules. It emitted existing dependency warnings about ignored `use client` directives.
- The rebuilt `frontend/dist/index.html` points to `/assets/index-BOVpfUh8.js` and `/assets/index-Bi2cDmTX.css`; the Settings page chunk is `/assets/AdminPages-Dn1Jeuwg.js`.

The built assets are ready for mounted-browser checks of sidebar click, keyboard activation, direct hash loading, and browser back/forward. Those interactions were not exercised in this implementation turn.
