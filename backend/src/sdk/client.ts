interface Cookie {
  value: string;
  secure: boolean;
}

interface ClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function env(): Record<string, string | undefined> {
  return (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class CrewOSError extends Error {
  status: number;
  code: unknown;

  constructor(message: string, status: number, code?: unknown) {
    super(message);
    this.name = 'CrewOSError';
    this.status = status;
    this.code = code;
  }
}

export class CrewOSClient {
  readonly baseUrl: string;
  readonly origin: string;
  readonly fetch: typeof fetch;
  readonly cookies = new Map<string, Cookie>();
  authProvider: string | null = null;

  constructor({ baseUrl = env().CREWOS_URL || 'http://127.0.0.1:4173', fetchImpl = fetch }: ClientOptions = {}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('CrewOS URL must use HTTP or HTTPS.');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.origin = url.origin;
    this.fetch = fetchImpl;
  }

  get cookie(): string {
    return [...this.cookies].filter(([, cookie]) => !cookie.secure || this.origin.startsWith('https:')).map(([name, cookie]) => `${name}=${cookie.value}`).join('; ');
  }

  rememberCookies(headers: Headers & { getSetCookie?: () => string[] }): void {
    const cookies = headers.getSetCookie?.() || [headers.get('set-cookie')].filter((value): value is string => Boolean(value));
    for (const cookie of cookies) {
      const [pair, ...attributes] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const maxAge = attributes.map((attribute) => /^\s*max-age=(-?\d+)/i.exec(attribute)?.[1]).find(Boolean);
      const expires = attributes.map((attribute) => /^\s*expires=(.+)/i.exec(attribute)?.[1]).find(Boolean);
      if (maxAge !== undefined && Number(maxAge) <= 0 || expires && Date.parse(expires) <= Date.now()) this.cookies.delete(name);
      else this.cookies.set(name, { value, secure: attributes.some((attribute) => /^\s*secure\s*$/i.test(attribute)) });
    }
  }

  async request(path: string, { method = 'GET', body, headers = {} }: RequestOptions = {}): Promise<unknown> {
    const response = await this.fetch(new URL(path, `${this.baseUrl}/`), {
      method,
      headers: { origin: this.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    this.rememberCookies(response.headers);
    const data: unknown = response.status === 204 ? null : response.headers.get('content-type')?.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);
    if (!response.ok) {
      const error = record(data);
      throw new CrewOSError(String(error?.message || `Request failed (${response.status}).`), response.status, error?.code);
    }
    const receipt=record(data);
    if (response.status === 202 && typeof receipt?.jobId === 'string') return this.waitForJob(receipt.jobId);
    return data;
  }

  async waitForJob(id: string, timeoutMs = 900000): Promise<unknown> {
    const deadline=Date.now()+timeoutMs;
    while (Date.now()<deadline) {
      const job=record(await this.request(`/api/jobs/${encodeURIComponent(id)}`));
      if (job?.status === 'completed') return job.result;
      if (job?.status === 'failed') throw new CrewOSError(String(job.error || 'The background operation failed.'),422,'job_failed');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new CrewOSError(`Job ${id} is still running. Poll /api/jobs/${id} to resume waiting.`,408,'job_pending');
  }

  async login({ email, password }: { email: string; password: string }): Promise<unknown> {
    const config = record(await this.request('/api/config'));
    this.authProvider = String(config?.authProvider || 'local');
    if (this.authProvider === 'neon') await this.request('/api/auth/neon/sign-in/email', { method: 'POST', body: { email, password } });
    const result = await this.request('/api/auth/login', { method: 'POST', body: this.authProvider === 'neon' ? { email } : { email, password } });
    if (!this.cookies.has('crewos_session')) throw new CrewOSError('Login succeeded but the session cookie was not returned.', 500, 'missing_session');
    return result;
  }

  me(): Promise<unknown> { return this.request('/api/auth/me'); }

  async logout(): Promise<void> {
    let error: unknown;
    if (this.authProvider === 'neon') {
      try { await this.request('/api/auth/neon/sign-out', { method: 'POST', body: {} }); }
      catch (failure) { error = failure; }
    }
    try { await this.request('/api/auth/logout', { method: 'POST', body: {} }); }
    catch (failure) { error ||= failure; }
    this.cookies.clear();
    this.authProvider = null;
    if (error) throw error;
  }

  employees(): Promise<unknown> { return this.request('/api/employees'); }
  createEmployee(employee: unknown): Promise<unknown> { return this.request('/api/employees', { method: 'POST', body: employee }); }
  workflows(): Promise<unknown> { return this.request('/api/workflows'); }
  async createWorkflow({ employeeId, goal, idempotencyKey }: { employeeId: string; goal: string; idempotencyKey?:string }): Promise<unknown> { const result=record(await this.request('/api/workflows', { method: 'POST', body: { employeeId, goal },headers:idempotencyKey ? {'idempotency-key':idempotencyKey} : {} })); return {...result,id:result?.taskId || result?.id}; }
  workflow(id: string): Promise<unknown> { return this.request(`/api/workflows/${encodeURIComponent(id)}`); }
  simulations(): Promise<unknown> { return this.request('/api/simulations'); }
  runSimulation(id: string, { employeeId }: { employeeId: string }): Promise<unknown> { return this.request(`/api/simulations/${encodeURIComponent(id)}/run`, { method: 'POST', body: { employeeId } }); }
  runRequiredProbation(employeeId:string): Promise<unknown> { return this.request(`/api/employees/${encodeURIComponent(employeeId)}/probation`,{method:'POST',body:{},headers:{prefer:'respond-async'}}); }
  approveWorkflow(id:string,approvalId:string,approved:boolean,note=''): Promise<unknown> { return this.request(`/api/workflows/${encodeURIComponent(id)}/approve`,{method:'POST',body:{approvalId,approved,note}}); }
  refunds(): Promise<unknown> { return this.request('/api/refunds'); }
  schedules(): Promise<unknown> { return this.request('/api/schedules'); }
  createSchedule(schedule: unknown): Promise<unknown> { return this.request('/api/schedules', { method: 'POST', body: schedule }); }
  updateSchedule(id: string, schedule: unknown): Promise<unknown> { return this.request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: schedule }); }
  scheduleRuns(id: string): Promise<unknown> { return this.request(`/api/schedules/${encodeURIComponent(id)}/runs`); }
  pauseSchedule(id: string, revision: number): Promise<unknown> { return this.request(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: 'POST', body: { revision } }); }
  resumeSchedule(id: string, revision: number): Promise<unknown> { return this.request(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: 'POST', body: { revision } }); }
  deleteSchedule(id: string, revision: number): Promise<unknown> { return this.request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision } }); }
}
