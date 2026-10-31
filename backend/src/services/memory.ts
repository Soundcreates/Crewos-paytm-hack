import { repositories } from '../../src/repositories/index.mjs';
import { enqueueJob, registerJobHandler } from '../../lib/jobs.mjs';
import { getLlmModel, getLlmProviderName } from '../../lib/llm-provider.mjs';
import { getSecret } from '../../lib/secrets.mjs';
import { embed } from '../../lib/ai.mjs';
import { id, now, transaction } from '../../lib/db.mjs';
import { buildMeetingMemoryBody, memoryRelevance } from 'solari-crew-core';

type UsageRecorder = (usage: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}) => Promise<unknown> | unknown;

interface MemoryRow {
  id: string;
  org_id: string;
  employee_id: string | null;
  kind: string;
  title: string;
  body: string;
  source: string;
  confidence: number;
  embedding: string | null;
  created_at: string;
  index_status: string;
  embedding_model: string | null;
  embedding_dimensions: number | null;
}

interface MemoryResult {
  id: string;
  employee_id: string | null;
  kind: string;
  title: string;
  body: string;
  source: string;
  confidence: number;
  created_at: string;
  index_status: string;
}

interface MemoryInput {
  memoryId?: string;
  orgId: string;
  employeeId?: string | null;
  kind?: string;
  title: string;
  body: string;
  source: string;
  confidence?: number;
  visibility?: 'org' | 'employee' | 'task' | 'team';
  taskIds?: string[];
  teamIds?: string[];
  expiresAt?: string | null;
}

interface MemoryQuery {
  orgId: string;
  employeeId?: string | null;
  taskId?: string | null;
  teamIds?: string[];
  query: string;
  limit?: number;
  apiKey?: string | null;
  onUsage?: UsageRecorder;
}

async function enforceMemoryAcl(orgId: string, rows: MemoryRow[], employeeId: string | null, taskId: string | null): Promise<MemoryRow[]> {
  const metadata = await repositories.knowledge.findMemoryAclByOrgIdAndIds(orgId, rows.map(row => row.id)) as Array<{memory_id:string;visibility:string;team_ids:string;task_ids:string;owner_employee_id:string|null;expires_at:string|null;source_type:string;source_id:string}>;
  const byId = new Map(metadata.map(item => [item.memory_id, item]));
  const nowMs = Date.now();
  const visible: MemoryRow[] = [];
  for (const row of rows) {
    const acl = byId.get(row.id);
    if (!acl) { visible.push(row); continue; } // legacy records retain their existing org/employee visibility.
    if (acl.expires_at && Date.parse(acl.expires_at) <= nowMs) continue;
    if (acl.visibility === 'employee' && (!employeeId || acl.owner_employee_id !== employeeId)) continue;
    if (acl.visibility === 'task' || acl.visibility === 'team') {
      if (acl.visibility === 'task') {
        let ids: unknown;
        try { ids = JSON.parse(acl.task_ids); } catch { continue; }
        if (!taskId || !Array.isArray(ids) || !ids.includes(taskId)) continue;
        const task = await repositories.foundation.findTaskByOrgAndId(orgId,taskId) as {owner_employee_id?:string}|undefined;
        if (!task || !employeeId || task.owner_employee_id!==employeeId) continue;
      }
      if (acl.visibility === 'team') {
        let teamIds: unknown;
        try { teamIds = JSON.parse(acl.team_ids); } catch { continue; }
        if (!employeeId || !Array.isArray(teamIds) || teamIds.length === 0) continue;
        const memberships = await repositories.foundation.verifyEmployeeTeamMemberships(orgId,employeeId,teamIds) as Array<{team_id:string}>;
        if (!memberships.some(membership => teamIds.includes(membership.team_id))) continue;
      }
      const source = acl.source_type === 'document' ? await repositories.knowledge.findOneDocumentByOrgIdAndId(orgId,acl.source_id)
        : ['workflow','workflow-failure'].includes(acl.source_type) ? await repositories.workflows.findOneWorkflowByIdAndOrgId(acl.source_id,orgId)
          : acl.source_type === 'meeting' ? await repositories.meetings.findOneMeetingByIdAndOrgId(acl.source_id,orgId) : null;
      if (!source) continue;
    }
    if (['org','employee','task','team'].includes(acl.visibility)) visible.push(row);
  }
  return visible;
}

interface VectorIndex {
  host: string;
  apiKey: string;
}

interface MemoryMetadata {
  employeeId?: string;
  visibility: 'employee' | 'org' | 'task' | 'team';
  teamIds?: string[];
  taskIds?: string[];
  kind: string;
  title: string;
  source: string;
  confidence: number;
  createdAt: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

interface PineconeMatch {
  id?: unknown;
  score?: unknown;
  metadata?: Record<string, unknown>;
}

interface PineconeQueryResult {
  matches?: PineconeMatch[];
}

interface RankedMemory extends MemoryResult {
  relevance: number;
}

function vectorIndex(): VectorIndex | null {
  const env = (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const host = env.PINECONE_INDEX_HOST?.trim();
  const apiKey = env.PINECONE_API_KEY;
  if (!host || !apiKey) return null;
  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PINECONE_INDEX_HOST must be an HTTPS index host.');
  return { host: url.origin, apiKey };
}

async function pineconeRequest<T = unknown>(index: VectorIndex, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${index.host}${path}`, {
    method: 'POST', headers: { 'Api-Key': index.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Pinecone request failed (${response.status}).`);
  return (response.status === 204 ? {} : await response.json()) as T;
}

function vectorMetadata(memory: Pick<MemoryInput, 'employeeId' | 'kind' | 'title' | 'source' | 'confidence'> & { createdAt: string }, embeddingModel: string, embeddingDimensions: number, acl?: {visibility:string;team_ids:string;task_ids:string}): MemoryMetadata {
  let teamIds: string[] = [], taskIds: string[] = [];
  try { teamIds=JSON.parse(acl?.team_ids || '[]'); } catch { teamIds=[]; }
  try { taskIds=JSON.parse(acl?.task_ids || '[]'); } catch { taskIds=[]; }
  return {
    ...(memory.employeeId ? { employeeId: memory.employeeId } : {}), visibility: acl?.visibility as MemoryMetadata['visibility'] || (memory.employeeId ? 'employee' : 'org'),
    ...(teamIds.length ? {teamIds} : {}), ...(taskIds.length ? {taskIds} : {}), kind: memory.kind ?? 'episodic', title: memory.title,
    source: memory.source, confidence: memory.confidence ?? 1, createdAt: memory.createdAt, embeddingModel, embeddingDimensions,
  };
}

async function upsertVectors(index: VectorIndex, orgId: string, vectors: Array<{ id: string; values: number[]; metadata: MemoryMetadata }>): Promise<unknown> {
  return pineconeRequest(index, '/vectors/upsert', { namespace: orgId, vectors });
}

async function validateKnownSource(orgId: string, source: string, body: string, title: string, kind: string): Promise<void> {
  if (source.startsWith('document:')) {
    const match = /^document:([^:]+):/.exec(source);
    const document = match && await repositories.knowledge.findOneDocumentByIdAndOrgIdSelectExtractedText(match[1], orgId);
    if (!document || !document.extracted_text.includes(body)) throw new Error('Document memory must quote text from a stored document in this organization.');
  } else if (source.startsWith('workflow-failure:')) {
    const match = /^workflow-failure:([^:]+)$/.exec(source);
    const workflow = match && await repositories.workflows.findOneWorkflowByIdAndOrgIdSelectStatusErrorGoal(match[1], orgId);
    const reason = String(workflow?.error || '').slice(0, 500);
    const attemptedRows = workflow && await repositories.workflows.findManyToolRunByOrgIdAndWorkflowIdSelectToolStatus(orgId, match![1]) as Array<{ tool: string; status: string }>;
    const attempted = (attemptedRows || []).map((step: { tool: string; status: string }) => `${step.tool} (${step.status})`).join('; ').slice(0, 1500);
    const expected = `Failed task: ${workflow?.goal || ''}\nOutcome: failed.\nReason: ${reason}${attempted ? `\nAttempted actions: ${attempted}` : ''}`.slice(0, 6000);
    if (!workflow || workflow.status !== 'failed' || !reason || kind !== 'episodic' || title !== workflow.goal.slice(0, 160) || body !== expected) {
      throw new Error('Failure memory requires a failed workflow with its recorded reason.');
    }
  } else if (source.startsWith('workflow:')) {
    const match = /^workflow:([^:]+)$/.exec(source);
    const workflow = match && await repositories.workflows.findOneWorkflowByIdAndOrgIdSelectStatusGoalResult(match[1], orgId);
    let result: { verified?: unknown; steps?: unknown[]; evaluation?: { score?: unknown; summary?: unknown } } | null;
    try { result = typeof workflow?.result === 'string' ? JSON.parse(workflow.result) as typeof result : workflow?.result as typeof result; }
    catch { result = null; }
    const evaluation = result?.evaluation;
    const evidence = Array.isArray(result?.steps) ? JSON.stringify(result.steps).slice(0, 5000) : '';
    const details = `${evaluation ? `Independent score: ${evaluation.score}. ${evaluation.summary}\n` : ''}Evidence: ${evidence}`;
    const expected = `Completed task: ${workflow?.goal || ''}\nOutcome: verified.\n${details}`.slice(0, 6000);
    if (!workflow || workflow.status !== 'completed' || result?.verified !== true || !Array.isArray(result.steps) || kind !== 'episodic' || title !== workflow.goal.slice(0, 160) || body !== expected) throw new Error('Workflow memory requires the completed task outcome and its recorded evidence.');
  } else if (source.startsWith('meeting:')) {
    const match = /^meeting:([^:]+)$/.exec(source);
    const meeting = match && await repositories.meetings.findOneMeetingByIdAndOrgIdSelectStatusTitleAgenda(match[1], orgId);
    const decisionData = meeting ? JSON.parse(meeting.decisions || '{}') : {};
    const messages = match && await repositories.workflows.findManyAgentMessageByOrgIdAndMeetingIdSelectBodyKindType(orgId, match[1]);
    const expected = meeting && buildMeetingMemoryBody({
      agenda: JSON.parse(meeting.agenda || '[]'),
      positions: decisionData.positions || [],
      decisions: decisionData.decisions || [],
      actions: decisionData.actions || [],
      messages: messages || [],
    });
    if (!meeting || meeting.status !== 'completed' || kind !== 'meeting' || title !== `Meeting: ${meeting.title}` || body !== expected) throw new Error('Meeting memory must match the recorded agenda, decisions, actions, and transcript.');
  }
}

function compactMemoryText(memory: Pick<MemoryInput, 'kind' | 'title' | 'body'>): string {
  const title = String(memory.title).replace(/\s+/g, ' ').trim();
  const body = String(memory.body).replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return `Type: ${memory.kind || 'episodic'}\nTitle: ${title}\n${body}`.slice(0, 8000);
}

export async function storeMemory({ memoryId: providedId, orgId, employeeId = null, kind = 'episodic', title, body, source, confidence = 1, visibility = employeeId ? 'employee' : 'org', taskIds = [], teamIds = [], expiresAt = null }: MemoryInput): Promise<MemoryResult | undefined> {
  if (!String(title ?? '').trim() || !String(body ?? '').trim() || !String(source ?? '').trim()) throw new Error('Memory needs a title, content, and a source.');
  const normalizedBody = String(body).trim().slice(0, 12000);
  const memoryId = providedId || id('mem');
  const timestamp = now();
  const memory = { id: memoryId, orgId, employeeId, kind, title: String(title).trim().slice(0, 200), body: normalizedBody, source: String(source).trim().slice(0, 500), confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), createdAt: timestamp };
  if (!['org','employee','task','team'].includes(visibility) || visibility === 'employee' && !employeeId || visibility === 'task' && (!Array.isArray(taskIds) || !taskIds.length || new Set(taskIds).size !== taskIds.length) || visibility === 'team' && (!Array.isArray(teamIds) || !teamIds.length || new Set(teamIds).size !== teamIds.length)) throw new Error('Memory visibility metadata is invalid.');
  if (['task','team'].includes(visibility) && !/^(document|workflow|workflow-failure|meeting):/.test(memory.source)) throw new Error('Scoped memory must reference an owned document, workflow, or meeting source.');
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error('Memory expiry must be in the future.');
  await transaction(async () => {
    await validateKnownSource(orgId, memory.source, normalizedBody, memory.title, kind);
    if (visibility === 'task') {
      const owned = await repositories.foundation.findTasksByOrgAndIds(orgId,taskIds) as Array<{id:string}>;
      if (owned.length !== taskIds.length) throw new Error('Task-scoped memory references a task outside this organization or a missing task.');
    }
    if (visibility === 'team') {
      const teams = await repositories.foundation.findTeamsByOrgAndIds(orgId,teamIds) as Array<{id:string}>;
      if (teams.length !== teamIds.length) throw new Error('Team-scoped memory references a team outside this organization or a missing team.');
    }
    await repositories.knowledge.insertMemory(memoryId, orgId, employeeId, kind, memory.title, normalizedBody, memory.source, memory.confidence, null, timestamp);
    await repositories.knowledge.insertMemoryAclMetadata(memoryId,orgId,visibility,JSON.stringify(teamIds),JSON.stringify(taskIds),memory.source.split(':',1)[0],memory.source.split(':')[1] || memory.source,null,employeeId,expiresAt,timestamp);
    await repositories.knowledge.setMemoryIndexState('pending', null, null, null, memoryId, orgId);
    await enqueueMemoryIndexJob(orgId, memoryId, `memory:index:${memoryId}`);
  });
  return (await repositories.knowledge.findOneMemoryById(memoryId));
}

export async function persistMeetingMemoryRecord({ orgId, title, body, source, confidence = 1 }: Pick<MemoryInput, 'orgId' | 'title' | 'body' | 'source' | 'confidence'>): Promise<string> {
  if (!String(title ?? '').trim() || !String(body ?? '').trim() || !String(source ?? '').trim()) throw new Error('Memory needs a title, content, and a source.');
  const memoryTitle = String(title).trim().slice(0, 200);
  const memoryBody = String(body).trim().slice(0, 12000);
  const memorySource = String(source).trim().slice(0, 500);
  const meetingId = /^meeting:([A-Za-z0-9_-]{1,200})$/.exec(memorySource)?.[1];
  if (!meetingId) throw new Error('Meeting memory needs a meeting source ID.');
  const memoryId = `mem_${meetingId}`;
  const score = Math.max(0, Math.min(1, Number(confidence) || 0));
  await transaction(async () => {
    await validateKnownSource(orgId, memorySource, memoryBody, memoryTitle, 'meeting');
    await repositories.knowledge.insertMemoryWithIdOrgIdEmployeeId(memoryId, orgId, null, 'meeting', memoryTitle, memoryBody, memorySource, score, null, now());
    const persisted = await repositories.knowledge.findOneMemoryByIdSelectIdOrgIdKind(memoryId);
    if (!persisted || persisted.org_id !== orgId || persisted.kind !== 'meeting' || persisted.title !== memoryTitle || persisted.body !== memoryBody || persisted.source !== memorySource) throw new Error('Meeting memory ID conflicts with another record.');
    await repositories.knowledge.setMemoryIndexState('pending', null, null, null, memoryId, orgId);
    await enqueueMemoryIndexJob(orgId, memoryId, `memory:index:${memoryId}`);
  });
  return memoryId;
}

async function enqueueMemoryIndexJob(orgId: string, memoryId: string, dedupeKey: string, forceReembed = false): Promise<void> {
  const payload = { memoryId, ...(forceReembed ? { forceReembed: true } : {}) };
  const job = await enqueueJob(orgId, 'memory.index', payload, dedupeKey);
  if (job?.status === 'completed' || job?.status === 'failed') {
    await enqueueJob(orgId, 'memory.index', payload, `memory:reindex:${id('memory-index')}:${memoryId}`);
  }
}

export async function indexPersistedMemory(memoryId: string, orgId: string, apiKey?: string | null, onUsage?: UsageRecorder, forceReembed = false): Promise<void> {
  const memory = await repositories.knowledge.findOneMemoryByIdAndOrgIdSelectAllFields(memoryId, orgId);
  if (!memory) return;
  let embedding: number[] | null = null;
  try {
    const index = vectorIndex();
    if (!index) throw new Error('Pinecone is not configured; memory indexing will retry.');
    const embeddingModel = getLlmModel('embedding');
    if (!embeddingModel) throw new Error('No embedding model is configured; memory indexing will retry.');
    embedding = (!forceReembed && storedEmbeddingForModel(memory as MemoryRow, embeddingModel))
      || await embed(compactMemoryText({ kind: memory.kind, title: memory.title, body: memory.body }), apiKey, onUsage);
    if (!embedding) throw new Error('Embedding provider unavailable; memory indexing will retry.');

    await repositories.knowledge.setMemoryIndexState('retry', JSON.stringify(embedding), embeddingModel, embedding.length, memoryId, orgId);
    if (!(await repositories.knowledge.findOneMemoryByIdAndOrgId(memoryId, orgId))) return;
    const aclRows=await repositories.knowledge.findMemoryAclByOrgIdAndIds(orgId,[memoryId]) as Array<{memory_id:string;visibility:string;team_ids:string;task_ids:string}>;
    await upsertVectors(index, orgId, [{
      id: memory.id,
      values: embedding,
      metadata: vectorMetadata({ employeeId: memory.employee_id || undefined, kind: memory.kind, title: memory.title, source: memory.source, confidence: memory.confidence, createdAt: memory.created_at }, embeddingModel, embedding.length,aclRows[0]),
    }]);
    if (!(await repositories.knowledge.findOneMemoryByIdAndOrgId(memoryId, orgId))) {
      await enqueueJob(orgId, 'memory.delete', { ids: [memoryId] }, `memory:orphan:${memoryId}`);
      return;
    }
    await repositories.knowledge.setMemoryIndexState('indexed', JSON.stringify(embedding), embeddingModel, embedding.length, memoryId, orgId);
  } catch (error) {
    await repositories.knowledge.setMemoryIndexState('retry', embedding ? JSON.stringify(embedding) : null, embedding ? getLlmModel('embedding') || null : null, embedding?.length || null, memoryId, orgId);
    throw error;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function rankedMemory(row: MemoryRow, relevance: number): RankedMemory {
  return {
    id: row.id,
    employee_id: row.employee_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    source: row.source,
    confidence: row.confidence,
    created_at: row.created_at,
    index_status: row.index_status,
    relevance,
  };
}

async function localCandidates(orgId: string, employeeId: string | null, query = ''): Promise<MemoryRow[]> {
  const terms=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0,8);
  const recent=await repositories.knowledge.findRecentMemoryCandidates(orgId, employeeId) as MemoryRow[];
  if (!terms.length) return recent;
  const relevant=await localLexicalCandidates(orgId,employeeId,terms);
  return [...new Map([...recent,...relevant].map(row => [row.id,row])).values()];
}

async function localLexicalCandidates(orgId: string, employeeId: string | null, terms: string[]): Promise<MemoryRow[]> {
  if (!terms.length) return [];
  return await repositories.knowledge.findMemoryCandidatesByTerms(orgId,employeeId,terms) as MemoryRow[];
}

function storedEmbedding(row: MemoryRow, embeddingModel: string | undefined, dimensions: number): number[] | null {
  if (!embeddingModel || row.embedding_model !== embeddingModel || row.embedding_dimensions !== dimensions) return null;
  try { const value: unknown = JSON.parse(row.embedding ?? 'null'); return Array.isArray(value) ? value as number[] : null; }
  catch { return null; }
}

function storedEmbeddingForModel(row: MemoryRow, embeddingModel: string | undefined): number[] | null {
  if (!embeddingModel || row.embedding_model !== embeddingModel) return null;
  try {
    const value: unknown = JSON.parse(row.embedding ?? 'null');
    return Array.isArray(value) && value.length === row.embedding_dimensions ? value as number[] : null;
  } catch {
    return null;
  }
}

export async function retrieveMemories({ orgId, employeeId = null, taskId = null, query, limit = 6, apiKey, onUsage }: MemoryQuery): Promise<RankedMemory[]> {
  const text = String(query ?? '').trim();
  if (!text) return [];
  const resultLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 6)));
  const vector = await embed(text, apiKey, onUsage).catch(() => null);
  const embeddingModel = getLlmModel('embedding');
  let index: VectorIndex | null = null;
  if (vector) {
    try { index = vectorIndex(); }
    catch { index = null; }
  }
  if (index && vector) {
    try {
      const response = await pineconeRequest<PineconeQueryResult>(index, '/query', {
        namespace: orgId, vector, topK: Math.min(100, Math.max(resultLimit, resultLimit * 4)), includeMetadata: true,
        ...(employeeId ? { filter: { $or: [{ employeeId: { $eq: employeeId } }, { visibility: { $eq: 'org' } }, { visibility: { $eq: 'task' } }, { visibility: { $eq: 'team' } }] } } : {}),
      });
      const matches = (Array.isArray(response.matches) ? response.matches : []).filter((match) =>
        match.metadata?.embeddingModel === embeddingModel && Number(match.metadata?.embeddingDimensions) === vector.length,
      );
      const ids = [...new Set(matches.map((match) => match.id).filter((value): value is string => typeof value === 'string'))];
      if (ids.length) {
        const remoteRows = await repositories.knowledge.findMemoriesByIds(orgId, ids) as MemoryRow[];
        if (remoteRows.length) {
          // A usable vector response may be supplemented by lexical matches, never by the
          // unconditional recent-memory window. Recent fallback is reserved for no-hit/offline cases.
          const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
          const lexicalRows = await localLexicalCandidates(orgId,employeeId,terms);
          const aclRows = await enforceMemoryAcl(orgId, [...lexicalRows, ...remoteRows], employeeId, taskId);
          const rowById = new Map(aclRows.map((row) => [row.id, row]));
          const remoteScores = new Map(matches.filter((match) => typeof match.id === 'string').map((match) => [match.id as string, Number(match.score) || 0]));
          return [...rowById.values()].map((row): RankedMemory | null => {
            if (employeeId && row.employee_id && row.employee_id !== employeeId) return null;
            const haystack = `${row.title} ${row.body}`.toLowerCase();
            const lexical = terms.length ? terms.reduce((count, term) => count + Number(haystack.includes(term)), 0) / terms.length : 0;
            const embedding = storedEmbedding(row, embeddingModel, vector.length);
            const semantic = remoteScores.has(row.id) ? remoteScores.get(row.id) ?? 0 : vector && embedding ? cosine(vector, embedding) : 0;
            return rankedMemory(row, memoryRelevance(row, semantic, lexical));
          }).filter((row): row is RankedMemory => Boolean(row && row.relevance > 0.05)).sort((a, b) => b.relevance - a.relevance).slice(0, resultLimit);
        }
      }
    } catch {
      // Keep local retrieval available if the configured vector index is temporarily unavailable.
    }
  }
  const rows = await enforceMemoryAcl(orgId, await localCandidates(orgId, employeeId, text), employeeId, taskId);
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  // ponytail: lexical overlap is the no-key fallback; use the configured embedding service when a vector index is needed at scale.
  return rows.map((row): RankedMemory => {
    const haystack = `${row.title} ${row.body}`.toLowerCase();
    const lexical = terms.length ? terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0) / terms.length : 0;
    const embedding = storedEmbedding(row, embeddingModel, vector?.length || 0);
    const semantic = vector && embedding ? cosine(vector, embedding) : 0;
    return rankedMemory(row, memoryRelevance(row, semantic, lexical, Boolean(vector && embedding)));
  }).filter((row) => row.relevance > 0.05).sort((a, b) => b.relevance - a.relevance).slice(0, resultLimit);
}

export async function enqueueMemoryIndexBackfill(batchSize = 100): Promise<{ runId: string; queued: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Memory index batch size must be between 1 and 500.');
  const runId = id('memory-reindex');
  let afterId = '';
  let queued = 0;
  for (;;) {
    const targets = await repositories.knowledge.findManyMemoryIndexTargetsAfterId(afterId, batchSize) as Array<{ id: string; org_id: string }>;
    if (!targets.length) break;
    for (const target of targets) {
      await transaction(async () => {
        await repositories.knowledge.setMemoryIndexState('pending', null, null, null, target.id, target.org_id);
        await enqueueMemoryIndexJob(target.org_id, target.id, `memory:reindex:${runId}:${target.id}`, true);
      });
      queued += 1;
      afterId = target.id;
    }
  }
  return { runId, queued };
}

registerJobHandler('memory.index', async (payload, job) => {
  const apiKey = await getSecret(job.org_id, 'openrouter');
  const onUsage: UsageRecorder = ({ model, inputTokens, outputTokens, totalTokens }) =>
    repositories.analytics.insertProviderUsage(id('usage'), job.org_id, getLlmProviderName(), model, 'memory.embedding', inputTokens, outputTokens, totalTokens, now());
  await indexPersistedMemory(String(payload.memoryId), job.org_id, apiKey, onUsage, payload.forceReembed === true);
  return { indexed: true };
});

registerJobHandler('memory.delete',async (payload,job) => {
  const index=vectorIndex();
  if (!index) throw new Error('Pinecone is not configured; memory deletion will retry.');
  await pineconeRequest(index,'/vectors/delete',{namespace:job.org_id,ids:payload.ids});
  return {deleted:true};
});
