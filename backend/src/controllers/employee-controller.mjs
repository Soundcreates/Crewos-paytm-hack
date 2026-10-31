export function createEmployeeController(dependencies) {
  const {
    repositories,
    HttpError,
    requireRole,
    cleanString,
    id,
    now,
    transaction,
    storeSpec,
    event,
    getEmployee,
    listEmployee,
    listEmployees,
    publicSpec,
    getEmployeeRuntimeSetup,
    getSecret,
    provisionEmployeeRuntimeSetup,
    lockEmployee,
    lockOrganization,
    enqueueJob,
    finalizeWorkflowSnapshot,
    runRequiredProbation,
    toolCatalog,
    checkPolicy,
    getJobId,
    pilotMode,
    deploymentEvidence,
    chiefEnabled = false,
    policyRevision,
    runtimeRevision,
    sendJson,
  } = dependencies;

  return {
    async handle({ path, method, response, body, context, org, user }) {
      if (path === '/api/employees' && method === 'GET') {
        const employees = await listEmployees(org.id, publicSpec);
        const withRuntime = await Promise.all(employees.map(async (employee) => ({
          ...employee,
          runtimeSetup: await getEmployeeRuntimeSetup(org.id, employee.id),
        })));
        sendJson(response, 200, withRuntime);
        return true;
      }

      if (path === '/api/employees' && method === 'POST') {
        requireRole(context, 'manager');
        const proposalId = body.chiefProposalId ? cleanString(body.chiefProposalId, 'Chief proposal', 120) : null;
        if (proposalId && !chiefEnabled) throw new HttpError(404, 'Chief proposals are disabled.');
        if (proposalId) {
          const existingProposal = await repositories.chief.findProposalByOrgIdAndId(org.id, proposalId);
          if (existingProposal?.status === 'hired' && existingProposal.employee_id) {
            sendJson(response, 200, await getEmployee(org.id, existingProposal.employee_id));
            return true;
          }
          if (!existingProposal || existingProposal.status !== 'proposed') throw new HttpError(409, 'This Chief proposal is no longer available.', 'chief_proposal_conflict');
        }
        const title = cleanString(body.title, 'Job title', 100);
        const name = cleanString(body.name, 'Employee name', 100);
        const department = cleanString(body.department || 'Operations', 'Department', 100);
        const employeeId = id('emp');
        const timestamp = now();
        const employee = {
          id: employeeId,
          name,
          title,
          department,
          avatar: cleanString(String(body.avatar || '◉'), 'Avatar', 20),
        };

        try { await transaction(async () => {
          await repositories.employees.insertEmployee(
            employeeId,
            org.id,
            name,
            title,
            department,
            'draft',
            employee.avatar,
            timestamp,
            timestamp,
          );
          const savedSpec = await storeSpec(org.id, employee, {
            identity: { name, title, departmentId: department, managerId: user.id, avatarId: employee.avatar },
            profileId: body.profileId,
            mission: body.mission,
            responsibilities: body.responsibilities,
            successMetrics: body.successMetrics,
            capabilities: body.capabilities,
            tools: body.tools,
            policies: body.policies,
            coworkers: body.coworkers,
            evaluationPolicy: body.evaluationPolicy,
            provenance: body.provenance,
          }, user.id);
          await repositories.employees.insertCoworker(
            id('cow'),
            org.id,
            employeeId,
            name,
            title,
            JSON.stringify(savedSpec.capabilities.map((capability) => capability.name)),
            body.mission || '',
            timestamp,
            timestamp,
          );
          if (proposalId) {
            const claimed = await repositories.chief.claimProposal(employeeId, timestamp, org.id, proposalId);
            if (!claimed.changes) throw new HttpError(409, 'This Chief proposal was already used. Refresh the proposal list before retrying.', 'chief_proposal_conflict');
            await event(org.id, 'employee.created', { employeeId, name, title, chiefProposalId: proposalId }, context, employeeId);
          }
        }); } catch (error) {
          // A concurrent retry may win the proposal claim. Return its employee so a
          // lost response remains replay-safe; the losing transaction has rolled back.
          if (proposalId) {
            const claimed = await repositories.chief.findProposalByOrgIdAndId(org.id, proposalId);
            if (claimed?.status === 'hired' && claimed.employee_id) {
              sendJson(response, 200, await getEmployee(org.id, claimed.employee_id));
              return true;
            }
          }
          throw error;
        }

        if (!proposalId) await event(org.id, 'employee.created', { employeeId, name, title }, context, employeeId);
        sendJson(response, 201, await getEmployee(org.id, employeeId));
        return true;
      }

      const employeeMatch = path.match(/^\/api\/employees\/([^/]+)$/);
      if (employeeMatch && method === 'GET') {
        sendJson(response, 200, await listEmployee(org.id, employeeMatch[1]));
        return true;
      }

      const setupMatch = path.match(/^\/api\/employees\/([^/]+)\/setup$/);
      if (setupMatch && method === 'POST') {
        requireRole(context, 'manager');
        const employee = await getEmployee(org.id, setupMatch[1]);
        if (employee.state === 'archived') throw new HttpError(409, 'Restore this employee before setting up their runtime.');
        const apiKey = await getSecret(org.id, 'solari');
        try {
          const result = await provisionEmployeeRuntimeSetup({
            orgId: org.id,
            employeeId: employee.id,
            employeeName: employee.name,
            userId: user.id,
            apiKey,
            onEvent: (kind, detail) => event(org.id, kind, detail, context, employee.id),
          });
          sendJson(response, result.created ? 201 : 200, { employeeId: employee.id, ...result });
          return true;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            error.status || error.httpStatus || 502,
            String(error.message || 'Could not set up this employee runtime.').slice(0, 300),
            error.code || 'employee_setup_failed',
          );
        }
      }

      const archiveMatch = path.match(/^\/api\/employees\/([^/]+)\/archive$/);
      if (((employeeMatch && method === 'DELETE') || (archiveMatch && method === 'POST'))) {
        requireRole(context, 'manager');
        const employeeId = (employeeMatch || archiveMatch)[1];
        const result = await transaction(async () => {
          const locked = await lockEmployee(org.id, employeeId);
          if (!locked) throw new HttpError(404, 'Employee not found.', 'not_found');
          const employee = await getEmployee(org.id, employeeId);
          const timestamp = now();
          await repositories.employees.updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenArchived(timestamp, employeeId, org.id);
          const cancelledWorkflowIds = (await repositories.workflows
            .findManyWorkflowByOrgIdAndEmployeeIdAndStatus(org.id, employeeId)).map((row) => row.id);
          const cancelled = await repositories.workflows.updateWorkflowByOrgIdAndEmployeeIdAndStatus(
            timestamp,
            timestamp,
            org.id,
            employeeId,
          );
          for (const workflowId of cancelledWorkflowIds) {
            const current=await repositories.foundation.findWorkflowExecutionGeneration(org.id,workflowId);
            const companion=await repositories.foundation.ensureWorkflowTaskCompanion(org.id,workflowId,timestamp);
            if (!companion || companion.owner_employee_id!==employeeId || current.employee_id!==employeeId) throw new HttpError(409,'The workflow task companion could not be validated.','workflow_task_link_missing');
            const taskSync=await repositories.foundation.syncWorkflowTaskState(org.id,workflowId,'cancelled',Number(current.lease_generation),null,null,timestamp);
            if (taskSync.changes!==1) throw new HttpError(409,'The archived employee task could not be fenced.','workflow_task_sync_conflict');
            const lock=await repositories.foundation.findExecutionLockByWorkflow(org.id,workflowId);
            if (lock) await repositories.foundation.releaseEmployeeExecutionLock(org.id,workflowId,lock.worker_id,lock.lease_generation);
          }
          if (employee.state !== 'archived') {
            await event(org.id, 'employee.archived', { employeeId, cancelledWorkflows: cancelled.changes }, context, employeeId);
          }
          return { employee: await getEmployee(org.id, employeeId), cancelledWorkflowIds };
        });

        await enqueueJob(org.id, 'runtime.cleanup', { employeeId }, `runtime:archive:${employeeId}:${result.employee.updated_at}`);
        for (const workflowId of result.cancelledWorkflowIds) {
          await event(org.id, 'workflow.cancelled', { reason: 'Employee archived.' }, context, employeeId, workflowId);
          await finalizeWorkflowSnapshot(org.id, workflowId);
        }
        sendJson(response, 200, result.employee);
        return true;
      }

      const restoreMatch = path.match(/^\/api\/employees\/([^/]+)\/restore$/);
      if (restoreMatch && method === 'POST') {
        requireRole(context, 'manager');
        const employee = await transaction(async () => {
          if (!await lockEmployee(org.id, restoreMatch[1])) throw new HttpError(404, 'Employee not found.');
          const current = await getEmployee(org.id, restoreMatch[1]);
          if (current.state !== 'archived') throw new HttpError(409, 'Only archived employees can be restored.');
          await repositories.employees.updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenDraft(now(), current.id, org.id);
          await event(org.id, 'employee.restored', { employeeId: current.id, state: 'draft' }, context, current.id);
          return getEmployee(org.id, current.id);
        });
        sendJson(response, 200, employee);
        return true;
      }

      const specMatch = path.match(/^\/api\/employees\/([^/]+)\/spec$/);
      if (specMatch && method === 'PUT') {
        requireRole(context, 'manager');
        const spec = await transaction(async () => {
          const locked = await lockEmployee(org.id, specMatch[1]);
          if (!locked) throw new HttpError(404, 'Employee not found.', 'not_found');
          const employee = await getEmployee(org.id, specMatch[1]);
          if (employee.state === 'archived') throw new HttpError(409, 'Archived employees cannot be edited.');
          return storeSpec(org.id, employee, body, user.id);
        });
        sendJson(response, 201, spec);
        return true;
      }

      const probationMatch = path.match(/^\/api\/employees\/([^/]+)\/probation$/);
      if (probationMatch && method === 'POST') {
        requireRole(context, 'manager');
        const employee = await getEmployee(org.id, probationMatch[1]);
        if (employee.state === 'archived') throw new HttpError(409, 'Archived employees cannot run probation.');
        const result = await runRequiredProbation({
          orgId: org.id,
          employee,
          userId: user.id,
          catalog: await toolCatalog(org.id),
          checkPolicy,
          jobId: getJobId(),
        });
        await event(
          org.id,
          result.passed ? 'simulation.passed' : 'simulation.failed',
          { runId: result.id, score: result.score, required: true },
          context,
          employee.id,
        );
        sendJson(response, 201, result);
        return true;
      }

      const deployMatch = path.match(/^\/api\/employees\/([^/]+)\/deploy$/);
      if (deployMatch && method === 'POST') {
        requireRole(context, 'manager');
        const employee = await transaction(async () => {
          await lockOrganization(org.id);
          if (!await lockEmployee(org.id, deployMatch[1])) throw new HttpError(404, 'Employee not found.');
          const current = await getEmployee(org.id, deployMatch[1]);
          if (current.state === 'archived' || !current.spec) throw new HttpError(409, 'Create or restore the employee spec first.');

          let accepted;
          if (pilotMode()) {
            accepted = await deploymentEvidence(org.id, current);
          } else {
            const eligible = await repositories.simulations
              .findOneSimulationRunByOrgIdAndEmployeeIdAndSpecVersion(org.id, current.id, current.spec.version);
            if (!eligible) throw new HttpError(409, 'Run and pass probation for the latest spec before deploying.');
            accepted = { evidence: [{ runId: eligible.id }], policyRevision: await policyRevision(org.id) };
          }

          await repositories.employees.insertEmployeeDeployment(
            id('deployment'),
            org.id,
            current.id,
            current.spec.version,
            runtimeRevision,
            accepted.policyRevision,
            JSON.stringify(accepted.evidence),
            user.id,
            now(),
          );
          await repositories.employees.updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenActive(now(), current.id, org.id);
          await event(org.id, 'employee.activated', {
            employeeId: current.id,
            specVersion: current.spec.version,
            evidence: accepted.evidence,
          }, context, current.id);
          return current;
        });
        sendJson(response, 200, await getEmployee(org.id, employee.id));
        return true;
      }

      const pauseMatch = path.match(/^\/api\/employees\/([^/]+)\/pause$/);
      if (pauseMatch && method === 'POST') {
        requireRole(context, 'manager');
        const employee = await getEmployee(org.id, pauseMatch[1]);
        if (employee.state === 'archived') throw new HttpError(409, 'Archived employees cannot be changed.');
        await repositories.employees.updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenPaused(now(), employee.id, org.id);
        await event(org.id, 'employee.paused', { employeeId: employee.id }, context, employee.id);
        sendJson(response, 200, await getEmployee(org.id, employee.id));
        return true;
      }

      return false;
    },
  };
}
