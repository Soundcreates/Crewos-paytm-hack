import { isReadOnlyResearchTask } from '../utils/agent-context.mjs';

export async function defaultPlan(goal, spec, getDesktopEnvironmentId) {
  const url = String(goal).match(/https?:\/\/[^\s]+/i)?.[0];
  if (isReadOnlyResearchTask(goal) && (spec.tools.includes('tinyfish.search') || spec.tools.includes('solari.browser.open'))) {
    const query = String(goal).replace(/\s+/g, ' ').trim().slice(0, 500);
    let includeDomains;
    if (url) {
      try {
        includeDomains = [new URL(url).hostname];
      } catch {
        // Invalid links stay in the query text; search remains read-only.
      }
    }
    return [{
      tool: 'tinyfish.search',
      input: { query, purpose: query, ...(includeDomains ? { includeDomains } : {}) },
      expectation: 'Return ranked public search results with source titles, snippets, and URLs.',
    }];
  }

  if (url && spec.tools.includes('solari.browser.open')) {
    return [{
      tool: 'solari.browser.open',
      input: { url },
      expectation: 'Open the page in the persistent Solari browser session and return its title and body.',
    }];
  }

  if (/echo|hello|terminal|sandbox/i.test(goal)
    && spec.tools.includes('solari.sandbox.echo')
    && !(/desktop/i.test(goal) && spec.tools.includes('solari.desktop.exec'))) {
    return [{
      tool: 'solari.sandbox.echo',
      input: { message: /echo\s+([^\n]+)/i.exec(goal)?.[1]?.trim() || 'hello' },
      expectation: 'The sandbox returns the requested text.',
    }];
  }

  if (/echo|terminal|desktop|virtual machine|\bvm\b|command/i.test(goal)
    && spec.tools.includes('solari.desktop.exec')) {
    const environmentId = await getDesktopEnvironmentId(spec.orgId, spec.employeeId);
    if (environmentId) {
      return [{
        tool: 'solari.desktop.exec',
        input: { environmentId, command: 'echo', args: [/echo\s+([^\n]+)/i.exec(goal)?.[1]?.trim() || 'hello'] },
        expectation: 'The desktop command exits successfully and returns its output.',
      }];
    }
  }

  if (/refund/i.test(goal)) {
    if (!spec.tools.includes('payments.refund')) return [];
    const amountText = /(?:\$|\bUSD\s*)([\d,]+(?:\.\d+)?)/i.exec(goal)?.[1]
      ?? /([\d,]+(?:\.\d+)?)\s*(?:USD|dollars?)/i.exec(goal)?.[1]
      ?? '1000';
    const caseId = /\b(?:case|ticket)(?:\s+id)?\s*(?:is|no\.?|number|[:#])?\s*(?!(?:for|of|about)\b)([A-Za-z0-9_-]{1,100})\b/i.exec(goal)?.[1]
      || 'TASK-001';
    return [{
      tool: 'payments.refund',
      input: { amount: Number(amountText.replaceAll(',', '')), currency: 'USD', caseId },
      expectation: 'The simulated refund is recorded and read back from the ledger.',
    }];
  }

  if (spec.tools.includes('jira.create_issue')) {
    return [{
      tool: 'jira.create_issue',
      input: { title: goal.slice(0, 120), description: goal },
      expectation: 'A work item is created and can be read back.',
    }];
  }

  return [];
}
