import { canTransitionTask, validateTaskContract } from 'solari-crew-core';

export function createTaskGraphService({ repository, transaction, lockOrganization, newId, timestamp, runtimeVersion = 'chief-dag-v1', maxDepth = 3, maxWidth = 12, maxAttempts = 5 }) {
  return {
    async create(input) {
      const task = { ...input, id:input.id || newId('task'), state:'queued', inputRefs:input.inputRefs || [] };
      if (!validateTaskContract(task)) throw Object.assign(new Error('Task contract is invalid.'),{code:'task_invalid'});
      return transaction(async () => {
        if (!await lockOrganization(task.orgId)) throw Object.assign(new Error('Organization not found.'),{code:'org_not_found'});
        let initialState='queued';
        const prior = await repository.findTaskByIdempotency(task.orgId,task.idempotencyKey);
        if (prior) {
          if (prior.goal !== task.goal || prior.capability !== task.capability || prior.owner_employee_id !== task.ownerEmployeeId || prior.input_refs !== JSON.stringify(task.inputRefs)) throw Object.assign(new Error('Task idempotency key conflicts with different task input.'),{code:'idempotency_conflict'});
          return prior;
        }
        if (task.parentTaskId) {
          const parent = await repository.findTaskByOrgAndId(task.orgId,task.parentTaskId);
          if (!parent) throw Object.assign(new Error('Parent task is not owned by this organization.'),{code:'task_tenant_mismatch'});
          if (['failed','cancelled'].includes(parent.state)) throw Object.assign(new Error('A failed or cancelled parent cannot accept a dependent task.'),{code:'task_dependency_failed'});
          if (parent.state!=='completed') initialState='waiting_dependency';
          const ancestry = await repository.findTaskRoot(task.orgId,task.parentTaskId);
          const stats = ancestry && await repository.findTaskGraphStats(task.orgId,ancestry.id);
          if (!ancestry || Number(ancestry.depth || 0) + 1 > maxDepth || Number(stats?.width || 0) >= maxWidth) throw Object.assign(new Error('Task DAG depth or width budget exceeded.'),{code:'task_budget_exceeded'});
          if (await repository.isDependencyReachable(task.orgId,task.id,task.parentTaskId)) throw Object.assign(new Error('Task dependency would create a cycle.'),{code:'task_cycle'});
        }
        const at = timestamp();
        await repository.insertTaskIfAbsent(task.id,task.orgId,task.workflowId || null,task.parentTaskId || null,task.ownerEmployeeId,task.capability,task.goal,JSON.stringify(task.inputRefs),JSON.stringify(task.successCriteria || []),initialState,task.priority ?? 50,task.idempotencyKey,task.correlationId || task.id,task.specVersion || 1,runtimeVersion,at,at);
        const saved = await repository.findTaskByIdempotency(task.orgId,task.idempotencyKey);
        if (!saved) throw new Error('Task was not persisted.');
        if (task.parentTaskId) await repository.insertTaskDependency(task.orgId,task.parentTaskId,saved.id,'completed',at);
        return saved;
      });
    },
    async transition({ orgId, taskId, expectedState, nextState, leaseGeneration, updates = {} }) {
      if (!canTransitionTask(expectedState,nextState)) throw Object.assign(new Error('Illegal task state transition.'),{code:'task_transition_invalid'});
      const current=await repository.findTaskByOrgAndId(orgId,taskId);
      if (!current) throw Object.assign(new Error('Task is not owned by this organization.'),{code:'task_tenant_mismatch'});
      if (expectedState==='running' && nextState==='retry' && Number(current.attempts)>=maxAttempts) throw Object.assign(new Error('Task retry budget is exhausted.'),{code:'task_retry_exhausted'});
      const leaseUpdates=['completed','failed','cancelled','retry','waiting_dependency','waiting_approval','waiting_external'].includes(nextState) ? {worker_id:null,lease_expires_at:null,...updates} : updates;
      const changed = await repository.transitionTaskFenced(orgId,taskId,expectedState,nextState,leaseGeneration,leaseUpdates,timestamp());
      if (!changed?.changes) throw Object.assign(new Error('Task state or lease generation changed.'),{code:'task_fence_conflict'});
      return repository.findTaskByOrgAndId(orgId,taskId);
    },
    async failExpired(orgId, limit=100) {
      const rows=await repository.findExpiredStandaloneTasks(orgId,timestamp(),limit);
      const changed=[];
      for (const task of rows) {
        try { changed.push(await this.transition({orgId,taskId:task.id,expectedState:task.state,nextState:'failed',leaseGeneration:Number(task.lease_generation),updates:{last_error:'Task deadline elapsed before execution.'}})); }
        catch (error) { if (error.code!=='task_fence_conflict' && error.code!=='task_transition_invalid') throw error; }
      }
      return changed;
    },
    async failDependencyBlocked(orgId, limit=100) {
      const rows=await repository.findFailedDependencyChildren(orgId,limit);
      const changed=[];
      for (const task of rows) {
        try { changed.push(await this.transition({orgId,taskId:task.id,expectedState:'waiting_dependency',nextState:'failed',leaseGeneration:Number(task.lease_generation),updates:{last_error:'A required dependency failed or was cancelled.'}})); }
        catch (error) { if (error.code!=='task_fence_conflict') throw error; }
      }
      return changed;
    },
    async unblockSatisfiedDependencies(orgId, limit=100) {
      const rows=await repository.findSatisfiedDependencyChildren(orgId,limit);
      const changed=[];
      for (const task of rows) {
        try { changed.push(await this.transition({orgId,taskId:task.id,expectedState:'waiting_dependency',nextState:'queued',leaseGeneration:Number(task.lease_generation)})); }
        catch (error) { if (error.code!=='task_fence_conflict') throw error; }
      }
      return changed;
    },
  };
}
