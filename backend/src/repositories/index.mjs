import { createAuthRepository } from './auth-repository.mjs';
import { createWorkflowsRepository } from './workflows-repository.mjs';
import { createAnalyticsRepository } from './analytics-repository.mjs';
import { createIntegrationsRepository } from './integrations-repository.mjs';
import { createPoliciesRepository } from './policies-repository.mjs';
import { createEmployeesRepository } from './employees-repository.mjs';
import { createSimulationsRepository } from './simulations-repository.mjs';
import { createMeetingsRepository } from './meetings-repository.mjs';
import { createSystemRepository } from './system-repository.mjs';
import { createOperationsRepository } from './operations-repository.mjs';
import { createKnowledgeRepository } from './knowledge-repository.mjs';
import { createSlackRepository } from './slack-repository.mjs';
import { createChiefRepository } from './chief-repository.mjs';
import { createFoundationRepository } from './foundation-repository.mjs';
import { all, get, run } from '../../lib/db.mjs';

export function createApplicationRepositories(database) {
  return {
    auth: createAuthRepository(database),
    workflows: createWorkflowsRepository(database),
    analytics: createAnalyticsRepository(database),
    integrations: createIntegrationsRepository(database),
    policies: createPoliciesRepository(database),
    employees: createEmployeesRepository(database),
    simulations: createSimulationsRepository(database),
    meetings: createMeetingsRepository(database),
    system: createSystemRepository(database),
    operations: createOperationsRepository(database),
    knowledge: createKnowledgeRepository(database),
    slack: createSlackRepository(database),
    chief: createChiefRepository(database),
    foundation: createFoundationRepository(database),
  };
}

export const repositories = createApplicationRepositories({ all, get, run });
