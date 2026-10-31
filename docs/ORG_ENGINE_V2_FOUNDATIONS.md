# Organization Engine V2 foundations

V2 is independently disabled by default. Enable the foundation status/API surface only with `CREWOS_ORG_ENGINE_V2=true` and `CREWOS_ORG_ENGINE_V2_ORGS=<comma-separated org ids>`. This does not enable a task worker, provider adapter, or provider side effect. `CREWOS_CHIEF` retains its legacy behavior; when an organization is allowlisted for V2, legacy Chief writes return an explicit conflict and V2 onboarding owns those writes.

Migrations v18 through v21 are additive and forward-only. They preserve the v17 `chief-onboarding` migration, legacy workflows, tool runs, and checkpoint formats. `external_operations` references exactly one existing `tool_runs` record and cannot dispatch. `tool_runs` remains the effect, approval, retry, and reconciliation authority. The v20 employee lock serializes legacy workflow claims and their linked `crew_tasks`; v21 binds provider readiness/probation to a policy revision. Event dispatch records are a separate, effect-disabled inbox fan-out queue and do not enqueue legacy workflows.

## Rollback

1. Disable new dispatch first: set `CREWOS_ORG_ENGINE_V2=false`, remove affected orgs from `CREWOS_ORG_ENGINE_V2_ORGS`, disable subscriptions, and restart API/worker instances. This does not change `CREWOS_CHIEF`.
2. Fence dispatch leases and stop new claims. Drain active jobs to a terminal or explicitly fenced state before removing worker code; do not clear a lease while its worker may still be running. Keep inbox receipts and reconciliation workers alive during drain.
3. Preserve every uncertain `external_operations` / `tool_runs` record and reconcile its provider receipt before any retry. Do not convert uncertain writes to failed or pending as a rollback shortcut.
4. Revoke connection credentials through the scoped credential lifecycle. Retain inbox, outbox, approval, and operation history for audit and reconciliation.
5. Do not drop V2 tables or restore an old database snapshot as an effect rollback. SQL restore cannot undo provider effects; reconcile receipts and canonical remote state after recovery. The current tranche has no V2 provider dispatcher, so the event fan-out records only blocked outcomes and local fixture persistence remains simulation-only.

The local webhook fixture route is available only when `CREWOS_LOCAL_WEBHOOK_FIXTURES=true`, `NODE_ENV` is not production, and `CREWOS_LOCAL_WEBHOOK_FIXTURE_SECRET` is configured. It accepts only a connected simulation connection and marks ingested events simulated.
