/** SQL access for the Slack domain. */
export function createSlackRepository({ all, get, run }) {
  return {
    findOneSlackInstallationByOrgId: (...params) =>
      get(
        "SELECT team_id,team_name,channel_ids FROM slack_installations WHERE org_id=?",
        ...params,
      ),
    findOneSlackUserByOrgIdAndTeamIdAndUserId: (...params) =>
      get(
        "SELECT slack_user_id FROM slack_users WHERE org_id=? AND team_id=? AND user_id=?",
        ...params,
      ),
    findOneSlackInstallationByOrgIdAndTeamId: (...params) =>
      get(
        "SELECT * FROM slack_installations WHERE org_id=? AND team_id=?",
        ...params,
      ),
    findOneSlackUserByOrgIdAndTeamIdAndSlackUserId: (...params) =>
      get(
        "SELECT s.user_id,m.role FROM slack_users s JOIN memberships m ON m.org_id=s.org_id AND m.user_id=s.user_id\n      WHERE s.org_id=? AND s.team_id=? AND s.slack_user_id=?",
        ...params,
      ),
    findOneSlackInstallationByOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM slack_installations WHERE org_id=?",
        ...params,
      ),
    findOneSlackInstallationByOrgIdSelectChannelIds: (...params) =>
      get(
        "SELECT channel_ids FROM slack_installations WHERE org_id=?",
        ...params,
      ),
    findOneSlackInstallationByTeamId: (...params) =>
      get(
        "SELECT org_id,channel_ids FROM slack_installations WHERE team_id=?",
        ...params,
      ),
    findOneSlackUserByOrgIdAndTeamIdAndSlackUserIdSelectRole: (...params) =>
      get(
        "SELECT m.role FROM slack_users s JOIN memberships m ON s.user_id=m.user_id AND s.org_id=m.org_id WHERE s.org_id=? AND s.team_id=? AND s.slack_user_id=?",
        ...params,
      ),
    findOneSlackInstallationByTeamIdSelectOrgId: (...params) =>
      get(
        "SELECT org_id FROM slack_installations WHERE team_id=?",
        ...params,
      ),
    insertSlackInstallation: (...params) =>
      run(
        "INSERT INTO slack_installations(org_id,team_id,team_name,bot_token,created_at,updated_at) VALUES(?,?,?,?,?,?)\n      ON CONFLICT(org_id) DO UPDATE SET team_id=excluded.team_id,team_name=excluded.team_name,bot_token=excluded.bot_token,channel_ids='[]',updated_at=excluded.updated_at",
        ...params,
      ),
    findOneSlackInstallationByOrgIdSelectTeamId: (...params) =>
      get(
        "SELECT team_id FROM slack_installations WHERE org_id=?",
        ...params,
      ),
    insertSlackUserByOrgId: (...params) =>
      run(
        "INSERT INTO slack_users(team_id,slack_user_id,org_id,user_id) VALUES(?,?,?,?)\n        ON CONFLICT(team_id,slack_user_id) DO UPDATE SET user_id=excluded.user_id WHERE slack_users.org_id=excluded.org_id",
        ...params,
      ),
    updateSlackInstallationByOrgId: (...params) =>
      run(
        "UPDATE slack_installations SET channel_ids=?,updated_at=? WHERE org_id=?",
        ...params,
      ),
    deleteSlackUserByOrgId: (...params) =>
      run(
        "DELETE FROM slack_users WHERE org_id=?",
        ...params,
      ),
    deleteSlackInstallationByOrgId: (...params) =>
      run(
        "DELETE FROM slack_installations WHERE org_id=?",
        ...params,
      ),
  };
}
