export function createScheduleController({ schedules, sendJson }) {
  return {
    async handle({ path, method, response, body, context }) {
      if (path === '/api/schedules' && method === 'GET') {
        sendJson(response, 200, await schedules.list(context));
        return true;
      }
      if (path === '/api/schedules' && method === 'POST') {
        sendJson(response, 201, await schedules.create(context, body));
        return true;
      }
      const match = /^\/api\/schedules\/([A-Za-z0-9_-]+)(?:\/(runs|pause|resume))?$/.exec(path);
      if (!match) return false;
      const [, scheduleId, action] = match;
      if (action === 'runs' && method === 'GET') sendJson(response, 200, await schedules.history(context, scheduleId));
      else if (!action && method === 'PATCH') sendJson(response, 200, await schedules.update(context, scheduleId, body));
      else if (!action && method === 'DELETE') { await schedules.remove(context, scheduleId, body.revision); sendJson(response, 204, null); }
      else if (['pause', 'resume'].includes(action) && method === 'POST') sendJson(response, 200, await schedules.setStatus(context, scheduleId, action === 'pause' ? 'paused' : 'active', body.revision));
      else return false;
      return true;
    },
  };
}
