export function createTwilioWhatsappRepository({ all, get, run }) {
  return {
    connections: org => all('SELECT c.*,e.name AS employee_name,e.title AS employee_title FROM twilio_whatsapp_connections c JOIN employees e ON e.org_id=c.org_id AND e.id=c.employee_id WHERE c.org_id=?', org),
    connection: id => get("SELECT c.* FROM twilio_whatsapp_connections c WHERE c.id=? AND c.active=1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=c.org_id AND m.user_id=c.authorized_by AND m.role IN ('owner','admin','manager'))", id),
    existing: (account,sender) => get('SELECT * FROM twilio_whatsapp_connections WHERE account_sid=? AND sender=?',account,sender),
    salesAgents: org => all("SELECT * FROM employees WHERE org_id=? AND (lower(title) LIKE '%sales%' OR lower(department) LIKE '%sales%' OR lower(name) LIKE '%sales%') ORDER BY created_at,id",org),
    customerServiceAgents: org => all("SELECT * FROM employees WHERE org_id=? AND (lower(title) LIKE '%support%' OR lower(title) LIKE '%customer service%' OR lower(department) LIKE '%support%' OR lower(department) LIKE '%customer service%' OR lower(name) LIKE '%support%' OR lower(name) LIKE '%customer service%') ORDER BY created_at,id",org),
    assignments: connection => all(`SELECT ce.role,e.id,e.name,e.title,e.state FROM twilio_whatsapp_connection_employees ce JOIN employees e ON e.org_id=ce.org_id AND e.id=ce.employee_id WHERE ce.connection_id=? ORDER BY CASE ce.role WHEN 'sales' THEN 0 ELSE 1 END`,connection),
    bindEmployee: c => run(`INSERT INTO twilio_whatsapp_connection_employees(connection_id,org_id,employee_id,role,created_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,employee_id) DO UPDATE SET role=excluded.role`,c.connectionId,c.orgId,c.employeeId,c.role,c.at),
    reconnect: (org,id,employee,user) => run('UPDATE twilio_whatsapp_connections SET active=1,employee_id=?,authorized_by=? WHERE org_id=? AND id=?',employee,user,org,id),
    bind: c => run('INSERT INTO twilio_whatsapp_connections(id,org_id,employee_id,authorized_by,account_sid,sender,created_at) VALUES(?,?,?,?,?,?,?)', c.id,c.orgId,c.employeeId,c.userId,c.accountSid,c.sender,c.at),
    disable: (org,id) => run('UPDATE twilio_whatsapp_connections SET active=0 WHERE org_id=? AND id=?',org,id),
    messages: org => all(`SELECT m.*, w.status AS workflow_status,w.result AS workflow_result,w.employee_id AS workflow_employee_id,e.name AS workflow_employee_name,e.title AS workflow_employee_title FROM twilio_whatsapp_messages m LEFT JOIN workflows w ON w.id=m.workflow_id AND w.org_id=m.org_id LEFT JOIN employees e ON e.id=w.employee_id AND e.org_id=w.org_id WHERE m.org_id=? ORDER BY received_at DESC LIMIT 100`,org),
    message: (org,id) => get('SELECT * FROM twilio_whatsapp_messages WHERE org_id=? AND id=?',org,id),
    accept: m => run(`INSERT INTO twilio_whatsapp_messages(id,connection_id,org_id,message_sid,sender,body,received_at,opted_out) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_sid) DO NOTHING`,m.id,m.connectionId,m.orgId,m.sid,m.sender,m.body,m.at,m.optedOut?1:0),
    bySid: sid => get('SELECT * FROM twilio_whatsapp_messages WHERE message_sid=?',sid),
    link: (org,id,w) => run('UPDATE twilio_whatsapp_messages SET workflow_id=? WHERE org_id=? AND id=? AND workflow_id IS NULL',w,org,id),
    latest: (org,c,sender) => get('SELECT * FROM twilio_whatsapp_messages WHERE org_id=? AND connection_id=? AND sender=? ORDER BY received_at DESC,opted_out DESC,id DESC LIMIT 1',org,c,sender),
    claimReply: (org,id,body) => run("UPDATE twilio_whatsapp_messages SET reply_state='sending',reply_body=? WHERE org_id=? AND id=? AND reply_state='none'",body,org,id),
    finishReply: (org,id,state,sid) => run('UPDATE twilio_whatsapp_messages SET reply_state=?,reply_sid=? WHERE org_id=? AND id=?',state,sid,org,id),
  };
}
