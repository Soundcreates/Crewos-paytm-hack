# Live acceptance tests

These tests exercise real Neon, OpenRouter, Pinecone, and Solari services using whatever
credentials are present in the environment. They are **not** part of `npm test`: they make
real network calls, can incur provider cost, and mutate live state (Neon rows, Solari
sessions), so they must stay opt-in.

Run them with:

```
npm run test:live
```

Each file checks for the environment variables it needs and skips (not fails) when they are
unset, so this is safe to run with a partially configured `.env`. A real failure here means
the configured credential/endpoint is reachable but misbehaving, not that it's absent.

## What is and isn't covered

- **Neon** (`neon.live.mjs`): live Postgres connectivity, Neon Auth reachability, a real
  `sign-up/email` + session-restore + sign-out round trip, and confirms the app's
  email-verification gate blocks workspace creation before the account is verified. It
  cannot complete the full signup → verified owner → invite → accept chain, because that
  needs a real inbox to click the verification link Neon Auth sends. Do that part manually
  through the UI with a real email address.
- **OpenRouter** (`openrouter.live.mjs`): a live planner completion and a live embedding
  call, asserting the embedding dimension matches `OPENROUTER_EMBEDDING_DIMENSIONS` when set.
- **Pinecone** (`pinecone.live.mjs`): a live upsert + query round trip in a disposable test
  namespace that the test deletes afterward.
- **Solari** (`solari.live.mjs`): a live profile list (read-only, free) plus a sandbox
  `echo` smoke test in a fresh environment that the test closes immediately after reading
  the result, to bound cost.
- **Jira** is not covered here: Jira Cloud OAuth is a three-legged, browser-interactive flow
  that needs a human to approve access on a real Atlassian account, so it can't be scripted.
  Connect it from Settings → Integrations once `ATLASSIAN_OAUTH_REDIRECT_URI` is set to this
  app's `/oauth/jira/callback` URL, then create/verify a Jira issue through an employee
  workflow by hand.

## One important Neon setup note

Neon Auth's trusted-origins check only accepts the app origin configured on the Neon side.
In this project that's `http://localhost:4173`, not `http://127.0.0.1:4173` — open the app at
`localhost`, not `127.0.0.1`, and set `APP_ORIGIN=http://localhost:4173` in `.env` (and your
deployed origin in production), or `sign-up`/`sign-in` calls fail with `INVALID_ORIGIN`.
