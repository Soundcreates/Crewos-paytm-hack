export const scheduleSchema = `
CREATE TABLE IF NOT EXISTS work_schedules (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 employee_id TEXT NOT NULL REFERENCES employees(id), created_by TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, goal TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cron','interval')),
 cron TEXT, interval_minutes INTEGER, timezone TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
 next_run_at TEXT NOT NULL, last_run_at TEXT, last_workflow_id TEXT REFERENCES workflows(id), last_error TEXT,
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON work_schedules(status,next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_org ON work_schedules(org_id,status,created_at);
CREATE TABLE IF NOT EXISTS schedule_runs (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 schedule_id TEXT NOT NULL REFERENCES work_schedules(id), due_at TEXT NOT NULL,
 status TEXT NOT NULL, workflow_id TEXT REFERENCES workflows(id), error TEXT, created_at TEXT NOT NULL,
 UNIQUE(schedule_id,due_at)
);
CREATE INDEX IF NOT EXISTS idx_schedule_history ON schedule_runs(org_id,schedule_id,created_at);
`;
