export function validateTaskOutcome(goal, steps, spec = {}) {
  const verified = (steps || []).filter(step => !step.skipped && step.evidence);
  if (!verified.length) throw Object.assign(new Error('The task produced no verified action evidence.'), {code:'outcome_unverified'});
  const jiraTask = (spec.tools || []).includes('jira.create_issue')
    && /\b(create|file|raise|submit|log|record|open|add)\b[\s\S]{0,120}\b(jira|issue|ticket|work item|bug)\b/i.test(goal);
  if (jiraTask && !verified.some(step => step.tool === 'jira.create_issue' && step.evidence.matched === true)) {
    throw Object.assign(new Error('The task requires a verified Jira issue matching the proposed fields.'), {code:'outcome_unverified'});
  }
  return { outcome:'verified', verified:true };
}
