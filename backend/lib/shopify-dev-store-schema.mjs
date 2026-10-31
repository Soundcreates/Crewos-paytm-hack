export const shopifyDevStoreSchema = `
CREATE TABLE IF NOT EXISTS shopify_dev_store_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  voice_session_id TEXT NOT NULL, manager_user_id TEXT NOT NULL REFERENCES users(id),
  store_name TEXT NOT NULL, status TEXT NOT NULL, store_domain TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,voice_session_id),
  FOREIGN KEY(org_id,voice_session_id) REFERENCES sarvam_voice_sessions(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_shopify_dev_store_requests_org ON shopify_dev_store_requests(org_id,created_at);
`;

export const shopifyDevThemeSchema = `
CREATE TABLE IF NOT EXISTS shopify_dev_theme_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  store_request_id TEXT NOT NULL REFERENCES shopify_dev_store_requests(id),
  voice_session_id TEXT NOT NULL, manager_user_id TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, status TEXT NOT NULL, theme_id TEXT, preview_url TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,store_request_id),
  FOREIGN KEY(org_id,voice_session_id) REFERENCES sarvam_voice_sessions(org_id,id)
);
`;
