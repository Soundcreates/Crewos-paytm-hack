export function createJobController({ repositories, now, parseJson, HttpError, requireRole, sendJson }) {
  return {
    async handle({ path, method, context, response }) {
      const retryMatch = path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
      if (retryMatch && method === 'POST') {
        requireRole(context, 'manager');
        const result = await repositories.operations.updateBackgroundJobByIdAndOrgIdAndStatus(
          now(),
          now(),
          retryMatch[1],
          context.org.id,
        );
        if (result.changes !== 1) throw new HttpError(409, 'Only failed jobs can be retried.');
        sendJson(response, 202, { retried: true });
        return true;
      }

      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (method !== 'GET' || (path !== '/api/jobs' && !jobMatch)) return false;

      requireRole(context, 'manager');
      if (jobMatch) {
        const job = await repositories.operations.findBackgroundJobSummaryByOrgAndId(context.org.id, jobMatch[1]);
        if (!job) throw new HttpError(404, 'Job not found.');
        sendJson(response, 200, { ...job, result: parseJson(job.result, null) });
        return true;
      }

      const jobs = await repositories.operations.listBackgroundJobSummariesByOrg(context.org.id);
      sendJson(response, 200, jobs.map((job) => ({ ...job, result: parseJson(job.result, null) })));
      return true;
    },
  };
}
