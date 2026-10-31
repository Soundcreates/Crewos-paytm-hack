export function validatePublicBrowserTarget(value) {
  if (typeof value !== 'string') throw new Error('Only public HTTP or HTTPS URLs can be opened.');
  let target;
  try { target = new URL(value); } catch { throw new Error('Only public HTTP or HTTPS URLs can be opened.'); }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Only public HTTP or HTTPS URLs without embedded credentials can be opened.');
  return target;
}

export function validateBrowserActions(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 12) throw new Error('Browser interactions need 1 to 12 actions.');
  const fields = {
    click: ['action', 'selector', 'timeoutMs'],
    fill: ['action', 'selector', 'value', 'timeoutMs'],
    select: ['action', 'selector', 'value', 'timeoutMs'],
    press: ['action', 'selector', 'key', 'timeoutMs'],
    wait: ['action', 'selector', 'state', 'timeoutMs'],
    assertText: ['action', 'text', 'timeoutMs'],
  };
  let budget = 0;
  const validated = actions.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !fields[item.action]) throw new Error('Each browser action must be click, fill, select, press, wait, or assertText.');
    if (Object.keys(item).some((key) => !fields[item.action].includes(key))) throw new Error('Browser action contains an unsupported field.');
    const action = { ...item };
    if (action.action !== 'assertText') {
      if (typeof action.selector !== 'string' || !action.selector.trim() || action.selector.length > 500 || action.selector.includes('\0')) throw new Error('Browser selectors must be non-empty text up to 500 characters.');
    }
    if (action.action === 'fill' || action.action === 'select') {
      if (typeof action.value !== 'string' || action.value.length > 1000 || action.value.includes('\0')) throw new Error('Browser input values must be text up to 1,000 characters.');
    }
    if (action.action === 'press' && (typeof action.key !== 'string' || !action.key.trim() || action.key.length > 60 || action.key.includes('\0'))) throw new Error('Browser keys must be non-empty text up to 60 characters.');
    if (action.action === 'wait' && action.state !== undefined && !['attached', 'detached', 'visible', 'hidden'].includes(action.state)) throw new Error('Browser wait state must be attached, detached, visible, or hidden.');
    if (action.action === 'assertText' && (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 300 || action.text.includes('\0'))) throw new Error('Visible-text assertions need non-empty text up to 300 characters.');
    action.timeoutMs = action.timeoutMs ?? 3500;
    if (!Number.isInteger(action.timeoutMs) || action.timeoutMs < 100 || action.timeoutMs > 10000) throw new Error('Each browser action timeout must be from 100 to 10,000 milliseconds.');
    budget += action.timeoutMs;
    if (budget > 45000) throw new Error('Browser interaction timeout budget cannot exceed 45 seconds.');
    return action;
  });
  const lastMutationIndex = validated.reduce((last, action, index) => ['click', 'fill', 'select', 'press'].includes(action.action) ? index : last, -1);
  if (!validated.some((action, index) => action.action === 'assertText' && index > lastMutationIndex)) throw new Error('Include a visible-text assertion after the final browser change.');
  return validated;
}

export function verifySandboxEcho(input, output) {
  const expected = String(input?.message || 'hello').slice(0, 500);
  const stdout = String(output?.stdout ?? '');
  const observed = stdout.replace(/\r?\n$/, '');
  return { verified: output?.exitCode === 0 && observed === expected, evidence: { exitCode: output?.exitCode, stdout } };
}
