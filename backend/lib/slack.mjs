import { repositories } from '../src/repositories/index.mjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { id, now, transaction } from './db.mjs';
import { decryptSecret, encryptSecret } from './secrets.mjs';
import { enqueueJob, registerJobHandler } from './jobs.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const admin = context => ['owner','admin'].includes(context?.org?.role);
const manager = role => ['owner','admin','manager'].includes(role);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const origin = () => {
  const url = new URL(process.env.APP_ORIGIN || 'http://localhost:4173');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Slack requires an HTTPS APP_ORIGIN in production.');
  return url.origin;
};

export function verifySlackRequest(raw, timestamp, signature, secret = process.env.SLACK_SIGNING_SECRET, timeMs = Date.now()) {
  if (!secret || !/^\d{10}$/.test(String(timestamp || '')) || Math.abs(timeMs / 1000 - Number(timestamp)) > 300) return false;
  if (!/^v0=[a-f0-9]{64}$/.test(String(signature || ''))) return false;
  const expected = `v0=${createHmac('sha256',secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected),Buffer.from(signature));
}

async function slackApi(method, token, body) {
  const response = await fetch(`https://slack.com/api/${method}`,{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=utf-8'},body:JSON.stringify(body),
  });
  if (response.status === 429) throw Object.assign(new Error('Slack rate limited delivery.'),{retryAfterMs:Math.min(3600000,Math.max(1,Number(response.headers.get('retry-after')) || 30))*1000});
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw Object.assign(new Error(`Slack ${method} failed: ${String(payload.error || response.status).slice(0,80)}`),{permanent:['invalid_auth','token_revoked','account_inactive','channel_not_found','not_in_channel'].includes(payload.error)});
  return payload;
}

async function readRaw(req) {
  const chunks=[]; let length=0;
  for await (const chunk of req) { length+=chunk.length; if(length>65536) fail(413,'Slack payload is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function slackSummary(context) {
  const installation = await repositories.slack.findOneSlackInstallationByOrgId(context.org.id);
  const linked = installation && await repositories.slack.findOneSlackUserByOrgIdAndTeamIdAndUserId(context.org.id, installation.team_id, context.user.id);
  return {available:Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_SIGNING_SECRET),connected:Boolean(installation),team:installation?.team_name,channels:parse(installation?.channel_ids,[]),linked:Boolean(linked)};
}

export function registerSlackJobs({createWorkflow,workflowTask,event}) {
  const processCommand=async (payload,job) => {
    const installation = await repositories.slack.findOneSlackInstallationByOrgIdAndTeamId(job.org_id, payload.teamId);
    if (!installation || !parse(installation.channel_ids,[]).includes(payload.channelId)) throw Object.assign(new Error('This Slack channel is no longer authorized.'),{permanent:true});
    const linked = await repositories.slack.findOneSlackUserByOrgIdAndTeamIdAndSlackUserId(job.org_id, payload.teamId, payload.slackUserId);
    if (!linked || !manager(linked.role)) throw Object.assign(new Error('Link a current CrewOS manager account before submitting work.'),{permanent:true});
    let text;
    if (payload.command === 'run') {
      const workflow = await createWorkflow(job.org_id,payload.employeeId,linked.user_id,payload.goal,null,{idempotencyKey:`slack:${job.id}`,origin:{type:'slack',teamId:payload.teamId,channelId:payload.channelId,userId:payload.slackUserId}});
      text = `Task ${workflow.id} accepted. ${origin()}/?task=${encodeURIComponent(workflow.id)}#tasks`;
      await enqueueJob(job.org_id,'slack.notify',{channelId:payload.channelId,text},`slack:accepted:${workflow.id}`);
      return {taskId:workflow.id};
    }
    const workflow = await repositories.workflows.findOneWorkflowByOrgIdAndIdSelectAllFields(job.org_id, payload.taskId);
    if (!workflow) throw Object.assign(new Error('Task not found in this workspace.'),{permanent:true});
    text = `Task ${workflow.id}: ${workflowTask(workflow).status}. ${origin()}/?task=${encodeURIComponent(workflow.id)}#tasks`;
    await enqueueJob(job.org_id,'slack.notify',{channelId:payload.channelId,text},`slack:status:${job.id}`);
    await event(job.org_id,'slack.status.requested',{workflowId:workflow.id},{user:{id:linked.user_id}});
    return {taskId:workflow.id};
  };
  registerJobHandler('slack.command',async (payload,job) => {
    try { return await processCommand(payload,job); }
    catch(error) {
      if (error.permanent || (error.status>=400 && error.status<500) || job.attempts>=8) await enqueueJob(job.org_id,'slack.notify',{channelId:payload.channelId,text:`CrewOS request ${job.id} could not be completed. A manager can review it at ${origin()}/#reports.`},`slack:command-failed:${job.id}`);
      throw error;
    }
  });
  registerJobHandler('slack.notify',async (payload,job) => {
    const installation = await repositories.slack.findOneSlackInstallationByOrgIdSelectAllFields(job.org_id);
    if (!installation || !parse(installation.channel_ids,[]).includes(payload.channelId)) return {skipped:true};
    // Plain text and disabled unfurls avoid expanding private URLs or evaluating
    // task/model output as Slack markup. Credentials never enter job payloads.
    const result = await slackApi('chat.postMessage',decryptSecret(installation.bot_token),{
      channel:payload.channelId,text:String(payload.text + (payload.path ? `\n${origin()}${payload.path}` : '')).slice(0,2500),mrkdwn:false,unfurl_links:false,unfurl_media:false,
      client_msg_id:job.id.replace(/^job_/,''),
    });
    return {timestamp:result.ts};
  });
}

export async function enqueueSlackWorkflowNotice(orgId,workflowId,kind,eventId) {
  if (!['workflow.completed','workflow.failed','workflow.cancelled','approval.requested','workflow.reconciliation_required'].includes(kind)) return;
  const workflow = await repositories.workflows.findOneWorkflowByOrgIdAndIdSelectIdStatusOrigin(orgId, workflowId);
  if (!workflow) return;
  const installation = await repositories.slack.findOneSlackInstallationByOrgIdSelectChannelIds(orgId);
  if (!installation) return;
  const source = parse(workflow.origin,{});
  const allowed = parse(installation.channel_ids,[]);
  const channels = source.type === 'slack' ? allowed.filter(channel => channel === source.channelId) : allowed;
  const artifacts = await repositories.workflows.findManyWorkflowArtifactByOrgIdAndWorkflowId(orgId, workflowId);
  const links = artifacts.map(artifact => `${artifact.external_id}${artifact.url ? `: ${artifact.url}` : ''}`).join('\n');
  const text = `CrewOS task ${workflowId}: ${kind === 'approval.requested' ? 'manager approval required' : workflow.status}.${links ? `\n${links}` : ''}`;
  for (const channelId of channels) await enqueueJob(orgId,'slack.notify',{channelId,text,path:`/?task=${encodeURIComponent(workflowId)}#tasks`},`slack:${eventId}:${workflow.step_index}:${channelId}`);
}

export async function handleSlackRequest(req,res,url,{currentContext,sendJson,readBody}) {
  const path=url.pathname;
  if (path === '/api/slack/commands' && req.method === 'POST') {
    const raw=await readRaw(req);
    if (!verifySlackRequest(raw,req.headers['x-slack-request-timestamp'],req.headers['x-slack-signature'])) fail(401,'Invalid Slack signature.');
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) fail(415,'Slack commands require form data.');
    const form=new URLSearchParams(raw.toString('utf8'));
    const teamId=form.get('team_id'),channelId=form.get('channel_id'),slackUserId=form.get('user_id');
    const installation=await repositories.slack.findOneSlackInstallationByTeamId(teamId);
    if (!installation) return sendJson(res,200,{response_type:'ephemeral',text:'Ask a CrewOS administrator to install this Slack workspace.'});
    if (!parse(installation.channel_ids,[]).includes(channelId)) return sendJson(res,200,{response_type:'ephemeral',text:'This channel is not approved in CrewOS integrations.'});
    const text=String(form.get('text') || '').trim();
    if (text === 'link') {
      const token=randomBytes(32).toString('base64url');
      await repositories.auth.insertOauthTicket(hash(token), 'slack-link', installation.org_id, JSON.stringify({teamId,slackUserId}), new Date(Date.now()+600000).toISOString());
      return sendJson(res,200,{response_type:'ephemeral',text:`Sign in to CrewOS and link your account: ${origin()}/?slack_link=${token}#integrations`});
    }
    const user=await repositories.slack.findOneSlackUserByOrgIdAndTeamIdAndSlackUserIdSelectRole(installation.org_id, teamId, slackUserId);
    if (!user || !manager(user.role)) return sendJson(res,200,{response_type:'ephemeral',text:'Run /crewos link and connect a CrewOS manager account first.'});
    const runMatch=/^run\s+(emp_[a-zA-Z0-9_-]+)\s+([\s\S]{1,2000})$/.exec(text);
    const statusMatch=/^status\s+(task_[a-zA-Z0-9_-]+)$/.exec(text);
    if (!runMatch && !statusMatch) return sendJson(res,200,{response_type:'ephemeral',text:'Use /crewos run <employee-id> <goal>, /crewos status <task-id>, or /crewos link.'});
    const job=await enqueueJob(installation.org_id,'slack.command',{teamId,channelId,slackUserId,...(runMatch ? {command:'run',employeeId:runMatch[1],goal:runMatch[2]} : {command:'status',taskId:statusMatch[1]})},`slack:inbound:${hash(Buffer.concat([Buffer.from(String(req.headers['x-slack-request-timestamp'])),raw]))}`);
    return sendJson(res,200,{response_type:'ephemeral',text:`CrewOS accepted request ${job.id}. Updates will appear in this channel.`});
  }
  if (path === '/oauth/slack/callback' && req.method === 'GET') {
    const state=url.searchParams.get('state') || '';
    const cookie=String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('crewos_slack_oauth='))?.split('=')[1];
    if (!state || cookie !== state) fail(400,'Invalid Slack OAuth state.');
    const ticket=await repositories.auth.findOneOauthTicketByTokenHashAndPurposeAndExpiresAt(hash(state), now());
    if (!ticket) fail(400,'Slack authorization expired or was already used.');
    const membership=await repositories.auth.findOneMembershipByOrgIdAndUserId(ticket.org_id, ticket.user_id);
    if (!admin({org:membership})) fail(403,'Administrator access was revoked.');
    if (url.searchParams.has('error')) fail(400,'Slack authorization was declined.');
    const response=await fetch('https://slack.com/api/oauth.v2.access',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:process.env.SLACK_CLIENT_ID || '',client_secret:process.env.SLACK_CLIENT_SECRET || '',code:url.searchParams.get('code') || '',redirect_uri:`${origin()}/oauth/slack/callback`})});
    const oauth=await response.json();
    if (!response.ok || !oauth.ok || !oauth.access_token || !oauth.team?.id || !['commands','chat:write'].every(scope => String(oauth.scope).split(',').includes(scope))) fail(502,'Slack did not grant the required bot permissions.');
    const existing=await repositories.slack.findOneSlackInstallationByTeamIdSelectOrgId(oauth.team.id);
    if (existing && existing.org_id !== ticket.org_id) fail(409,'This Slack workspace is already linked to another CrewOS workspace.');
    await repositories.slack.insertSlackInstallation(ticket.org_id, oauth.team.id, String(oauth.team.name || 'Slack'), encryptSecret(oauth.access_token), now(), now());
    res.writeHead(302,{location:'/#integrations','cache-control':'no-store','set-cookie':`crewos_slack_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`}); return res.end();
  }
  const context=await currentContext(req);
  if (!context) fail(401,'Sign in to continue.');
  if (path === '/api/slack' && req.method === 'GET') return sendJson(res,200,await slackSummary(context));
  if (path === '/api/slack/link' && req.method === 'POST') {
    const body=await readBody(req);
    await transaction(async () => {
      const ticket=await repositories.auth.findOneOauthTicketByTokenHashAndPurposeAndOrgId(hash(String(body.token || '')), context.org.id, now());
      if (!ticket) fail(400,'The Slack link is invalid, expired, or belongs to another workspace.');
      const payload=parse(ticket.payload,{});
      const installation=await repositories.slack.findOneSlackInstallationByOrgIdSelectTeamId(context.org.id);
      if (installation?.team_id !== payload.teamId) fail(409,'The Slack installation changed.');
      await repositories.slack.insertSlackUserByOrgId(payload.teamId, payload.slackUserId, context.org.id, context.user.id);
    });
    return sendJson(res,200,{linked:true});
  }
  if (!admin(context)) fail(403,'Administrator access is required.');
  if (path === '/api/slack/connect' && req.method === 'GET') {
    if (!(await slackSummary(context)).available) fail(503,'Configure Slack OAuth and signing credentials on the server.');
    const state=randomBytes(32).toString('base64url');
    await repositories.auth.insertOauthTicketWithTokenHashPurposeOrgId(hash(state), 'slack-oauth', context.org.id, context.user.id, new Date(Date.now()+600000).toISOString());
    const target=new URL('https://slack.com/oauth/v2/authorize');
    target.search=new URLSearchParams({client_id:process.env.SLACK_CLIENT_ID,scope:'commands,chat:write',redirect_uri:`${origin()}/oauth/slack/callback`,state}).toString();
    res.writeHead(302,{location:target.toString(),'cache-control':'no-store','set-cookie':`crewos_slack_oauth=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`}); return res.end();
  }
  if (path === '/api/slack' && req.method === 'PATCH') {
    const body=await readBody(req);
    if (!Array.isArray(body.channels) || body.channels.length>10 || body.channels.some(value => !/^[CG][A-Z0-9]{2,79}$/.test(value))) fail(400,'Supply up to ten Slack channel IDs.');
    const saved=await repositories.slack.updateSlackInstallationByOrgId(JSON.stringify([...new Set(body.channels)]), now(), context.org.id);
    if (!saved.changes) fail(409,'Connect Slack first.');
    return sendJson(res,200,await slackSummary(context));
  }
  if (path === '/api/slack' && req.method === 'DELETE') {
    await transaction(async () => { await repositories.slack.deleteSlackUserByOrgId(context.org.id); await repositories.slack.deleteSlackInstallationByOrgId(context.org.id); });
    return sendJson(res,200,{connected:false});
  }
  fail(404,'Slack route not found.');
}
