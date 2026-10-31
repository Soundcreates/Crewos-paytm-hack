export interface WorkflowStepResult extends Record<string, unknown> {
  step: number;
}

export interface WorkflowProgress {
  goal: string;
  steps: WorkflowStepResult[];
  verified: false;
}

function hasCompletedStep(value: unknown): value is WorkflowStepResult {
  return value !== null && typeof value === 'object'
    && Number.isInteger((value as { step?: unknown }).step);
}

export function completedWorkflowSteps(result: unknown, stepIndex: unknown): WorkflowStepResult[] {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { value = null; }
  }
  const completed = Math.max(0, Math.trunc(Number(stepIndex) || 0));
  const steps = value !== null && typeof value === 'object'
    ? (value as { steps?: unknown }).steps
    : undefined;
  return Array.isArray(steps) ? steps.filter((step: unknown) => hasCompletedStep(step) && step.step < completed) : [];
}

export function workflowProgress(goal: string, steps: WorkflowStepResult[]): WorkflowProgress {
  return { goal, steps, verified: false };
}
