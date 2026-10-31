export function createChiefRepository({ all, get, run }) {
  return {
    findSessionByOrgId: (...params) => get('SELECT * FROM chief_sessions WHERE org_id=?', ...params),
    insertSession: (...params) => run('INSERT INTO chief_sessions(org_id,owner_id,status,stage,answers,document_ids,revision,generation_count,created_at,updated_at) VALUES(?,? ,\'active\',0,\'{}\',\'[]\',1,0,?,?) ON CONFLICT(org_id) DO NOTHING', ...params),
    updateSession: (...params) => run('UPDATE chief_sessions SET status=?,stage=?,answers=?,document_ids=?,revision=revision+1,updated_at=? WHERE org_id=? AND revision=?', ...params),
    reserveGeneration: (...params) => run("UPDATE chief_sessions SET generation_token=?,generation_started_at=?,generation_count=generation_count+1,updated_at=? WHERE org_id=? AND revision=? AND (generation_token IS NULL OR generation_started_at<?)", ...params),
    clearGeneration: (...params) => run('UPDATE chief_sessions SET generation_token=NULL,generation_started_at=NULL,updated_at=? WHERE org_id=? AND generation_token=?', ...params),
    insertProposal: (...params) => run('INSERT INTO chief_proposals(id,org_id,generation,status,role,draft,created_at,updated_at) VALUES(?,?,?,\'proposed\',?,?,?,?) ON CONFLICT(org_id,generation,role) DO NOTHING', ...params),
    listProposals: (...params) => all('SELECT * FROM chief_proposals WHERE org_id=? ORDER BY generation DESC,created_at,id', ...params),
    findGenerationRequest: (...params) => get('SELECT * FROM chief_generation_requests WHERE org_id=? AND request_key=?', ...params),
    insertGenerationRequest: (...params) => run('INSERT INTO chief_generation_requests(org_id,request_key,request_hash,generation,created_at) VALUES(?,?,?,?,?) ON CONFLICT(org_id,request_key) DO NOTHING', ...params),
    findProposalByOrgIdAndId: (...params) => get('SELECT * FROM chief_proposals WHERE org_id=? AND id=?', ...params),
    updateProposalDraft: (...params) => run("UPDATE chief_proposals SET draft=?,updated_at=? WHERE org_id=? AND id=? AND status='proposed'", ...params),
    updateProposalDraftIfUnmodified: (...params) => run("UPDATE chief_proposals SET draft=?,updated_at=? WHERE org_id=? AND id=? AND status='proposed' AND draft=?", ...params),
    claimProposal: (...params) => run("UPDATE chief_proposals SET status='hired',employee_id=?,updated_at=? WHERE org_id=? AND id=? AND status='proposed'", ...params),
    dismissProposal: (...params) => run("UPDATE chief_proposals SET status='dismissed',updated_at=? WHERE org_id=? AND id=? AND status='proposed'", ...params),
  };
}
