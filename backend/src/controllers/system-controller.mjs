export function createSystemController({
  repositories,
  now,
  pilotMode,
  isNeonAuthEnabled,
  chiefEnabled = false,
  isWorkerStopping,
  traceStep,
  sendJson,
}) {
  return {
    async handle({ path, method, response }) {
      if (path === '/api/config' && method === 'GET') {
        traceStep('http.route.dispatch', { handler: 'config', method, route: path });
        sendJson(response, 200, {
          authProvider: isNeonAuthEnabled ? 'neon' : 'local',
          pilotMode: pilotMode(),
          chiefEnabled,
        });
        return true;
      }

      if (path === '/api/ready' && method === 'GET') {
        try {
          await repositories.system.findOneSystemQuery();
          const worker = await repositories.operations.findOneServiceLeaseByNameAndExpiresAt(now());
          const ready = Boolean(worker) && !isWorkerStopping();
          sendJson(response, ready ? 200 : 503, { ready, database: true, worker: Boolean(worker) });
        } catch {
          sendJson(response, 503, { ready: false, database: false, worker: false });
        }
        return true;
      }

      if (path === '/api/health' && method === 'GET') {
        traceStep('http.route.dispatch', { handler: 'health', method, route: path });
        sendJson(response, 200, { ok: true, name: 'CrewOS', time: now() });
        return true;
      }

      return false;
    },
  };
}
