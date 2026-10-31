/** SQL access for the auth domain. Business logic should call these named operations. */
export function createAuthRepository({ all, get, run }) {
  return {
    findOneUserByAuthUserId: (...params) =>
      get(
        "SELECT id,name,email FROM users WHERE auth_user_id=?",
        ...params,
      ),
    findOneUserByEmailAndId: (...params) =>
      get(
        "SELECT id FROM users WHERE email=? AND id<>?",
        ...params,
      ),
    updateUserById: (...params) =>
      run(
        "UPDATE users SET email=?,name=? WHERE id=?",
        ...params,
      ),
    findOneUserByEmail: (...params) =>
      get(
        "SELECT id,name,email,auth_user_id FROM users WHERE email=?",
        ...params,
      ),
    updateUserByIdAndAuthUserId: (...params) =>
      run(
        "UPDATE users SET auth_user_id=? WHERE id=? AND auth_user_id IS NULL",
        ...params,
      ),
    findOneUserById: (...params) =>
      get(
        "SELECT id,name,email,auth_user_id FROM users WHERE id=?",
        ...params,
      ),
    insertUser: (...params) =>
      run(
        "INSERT INTO users(id,name,email,password_salt,password_hash,auth_user_id,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        ...params,
      ),
    insertOrganization: (...params) =>
      run(
        "INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)",
        ...params,
      ),
    insertMembership: (...params) =>
      run(
        "INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)",
        ...params,
      ),
    deleteSignupIntentByEmail: (...params) =>
      run(
        "DELETE FROM signup_intents WHERE email=?",
        ...params,
      ),
    findOneSessionByTokenHashAndExpiresAt: (...params) =>
      get(
        "SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
        ...params,
      ),
    findOneUserByIdAndAuthUserId: (...params) =>
      get(
        "SELECT id,name,email FROM users WHERE id=? AND auth_user_id=?",
        ...params,
      ),
    findOneOrganizationByIdAndUserId: (...params) =>
      get(
        "SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE o.id=? AND m.user_id=?",
        ...params,
      ),
    findOneUserByIdSelectIdNameEmail: (...params) =>
      get(
        "SELECT id,name,email FROM users WHERE id=?",
        ...params,
      ),
    insertSession: (...params) =>
      run(
        "INSERT INTO sessions(token_hash,user_id,org_id,expires_at,created_at) VALUES(?,?,?,?,?)",
        ...params,
      ),
    findOneMembershipByUserIdAndOrgId: (...params) =>
      get(
        "SELECT role FROM memberships WHERE user_id=? AND org_id=?",
        ...params,
      ),
    findOneMembershipByOrgId: (...params) =>
      get(
        "SELECT user_id FROM memberships WHERE org_id=? ORDER BY created_at LIMIT 1",
        ...params,
      ),
    deleteSignupIntentByExpiresAt: (...params) =>
      run(
        "DELETE FROM signup_intents WHERE expires_at<=?",
        ...params,
      ),
    insertSignupIntent: (...params) =>
      run(
        "INSERT INTO signup_intents(email,name,organization,expires_at,created_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,organization=excluded.organization,expires_at=excluded.expires_at,created_at=excluded.created_at",
        ...params,
      ),
    findOneSignupIntentByEmailAndExpiresAt: (...params) =>
      get(
        "SELECT name,organization FROM signup_intents WHERE email=? AND expires_at>?",
        ...params,
      ),
    findOneMembershipByUserId: (...params) =>
      get(
        "SELECT 1 AS present FROM memberships WHERE user_id=?",
        ...params,
      ),
    findOneUserByEmailSelectId: (...params) =>
      get(
        "SELECT id FROM users WHERE email=?",
        ...params,
      ),
    insertUserWithIdNameEmail: (...params) =>
      run(
        "INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)",
        ...params,
      ),
    findManyMembershipByUserId: (...params) =>
      all(
        "SELECT m.org_id,m.role,o.name FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY m.created_at",
        ...params,
      ),
    findOneUserByEmailSelectAllFields: (...params) =>
      get(
        "SELECT * FROM users WHERE email=?",
        ...params,
      ),
    deleteSessionByTokenHash: (...params) =>
      run(
        "DELETE FROM sessions WHERE token_hash=?",
        ...params,
      ),
    findOneInvitationByTokenHashAndAcceptedAtAndExpiresAt: (...params) =>
      get(
        "UPDATE invitations SET accepted_at=? WHERE token_hash=? AND accepted_at IS NULL AND expires_at>? RETURNING org_id,email,role",
        ...params,
      ),
    findOneUserByEmailSelectIdNameEmail: (...params) =>
      get(
        "SELECT id,name,email FROM users WHERE email=?",
        ...params,
      ),
    insertMembershipWithOrgIdUserIdRole: (...params) =>
      run(
        "INSERT OR IGNORE INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)",
        ...params,
      ),
    updateSessionByTokenHashAndUserIdAndExpiresAt: (...params) =>
      run(
        "UPDATE sessions SET org_id=? WHERE token_hash=? AND user_id=? AND expires_at>?",
        ...params,
      ),
    findManyMembershipByUserIdSelectIdNameRole: (...params) =>
      all(
        "SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.org_id WHERE m.user_id=? ORDER BY m.created_at",
        ...params,
      ),
    findOneOrganizationByUserIdAndId: (...params) =>
      get(
        "SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=? AND o.id=?",
        ...params,
      ),
    updateSessionByTokenHash: (...params) =>
      run(
        "UPDATE sessions SET org_id=? WHERE token_hash=?",
        ...params,
      ),
    findOneMembershipByOrgIdSelectCount: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM memberships WHERE org_id=?",
        ...params,
      ),
    updateOrganizationById: (...params) =>
      run(
        "UPDATE organizations SET name=? WHERE id=?",
        ...params,
      ),
    findManyMembershipByOrgId: (...params) =>
      all(
        "SELECT u.id,u.name,u.email,m.role,m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY CASE m.role WHEN \"owner\" THEN 0 WHEN \"admin\" THEN 1 WHEN \"manager\" THEN 2 ELSE 3 END,u.name",
        ...params,
      ),
    findOneMembershipByOrgIdAndEmail: (...params) =>
      get(
        "SELECT id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND u.email=?",
        ...params,
      ),
    insertInvitation: (...params) =>
      run(
        "INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneMembershipByOrgIdAndUserId: (...params) =>
      get(
        "SELECT role FROM memberships WHERE org_id=? AND user_id=?",
        ...params,
      ),
    findOneMembershipByOrgIdAndRole: (...params) =>
      get(
        "SELECT user_id FROM memberships WHERE org_id=? AND role=?",
        ...params,
      ),
    updateMembershipByOrgIdAndUserId: (...params) =>
      run(
        "UPDATE memberships SET role=? WHERE org_id=? AND user_id=?",
        ...params,
      ),
    deleteMembershipByOrgIdAndUserId: (...params) =>
      run(
        "DELETE FROM memberships WHERE org_id=? AND user_id=?",
        ...params,
      ),
    findManyMembershipByOrgIdSelectIdNameRole: (...params) =>
      all(
        "SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=?",
        ...params,
      ),
    findOneMembershipByOrgIdAndUserIdSelectIdNameEmail: (...params) =>
      get(
        "SELECT u.id,u.name,u.email,m.role,o.name AS org_name FROM memberships m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id WHERE m.org_id=? AND m.user_id=?",
        ...params,
      ),
    insertOauthTicket: (...params) =>
      run(
        "INSERT INTO oauth_tickets(token_hash,purpose,org_id,payload,expires_at) VALUES(?,?,?,?,?)",
        ...params,
      ),
    findOneOauthTicketByTokenHashAndPurposeAndExpiresAt: (...params) =>
      get(
        "DELETE FROM oauth_tickets WHERE token_hash=? AND purpose='slack-oauth' AND expires_at>? RETURNING *",
        ...params,
      ),
    findOneOauthTicketByTokenHashAndPurposeAndOrgId: (...params) =>
      get(
        "DELETE FROM oauth_tickets WHERE token_hash=? AND purpose='slack-link' AND org_id=? AND expires_at>? RETURNING *",
        ...params,
      ),
    insertOauthTicketWithTokenHashPurposeOrgId: (...params) =>
      run(
        "INSERT INTO oauth_tickets(token_hash,purpose,org_id,user_id,expires_at) VALUES(?,?,?,?,?)",
        ...params,
      ),
  };
}
