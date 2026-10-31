export function browserInteractionWasMutating(input) {
  return (Array.isArray(input?.actions) ? input.actions : [])
    .some((action) => !['wait', 'assertText'].includes(action?.action));
}

export function applySimulationEvents(scenario) {
  const initialState = Object.fromEntries(
    Object.entries(scenario.initialState || {}).map(([key, value]) => [key, structuredClone(value)]),
  );
  const state = Object.fromEntries(
    Object.entries(initialState).map(([key, value]) => [key, structuredClone(value)]),
  );
  const toolFailuresByAction = {};
  const events = (scenario.events || []).map((event, index) => {
    if (typeof event === 'string') return { sequence: index + 1, description: event, delivered: true };
    if (event.type === 'tool.failure') {
      const targetTool = scenario.actions[event.actionIndex].tool;
      toolFailuresByAction[event.actionIndex] = { tool: targetTool, message: event.message };
      return {
        sequence: index + 1,
        type: event.type,
        actionIndex: event.actionIndex,
        tool: targetTool,
        message: event.message,
        simulated: true,
        scheduled: true,
      };
    }

    for (const [key, value] of Object.entries(event.patch)) {
      Object.defineProperty(state, key, {
        value: structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { sequence: index + 1, type: event.type, patch: structuredClone(event.patch), applied: true };
  });

  return { objective: scenario.objective || '', initialState, state, events, toolFailuresByAction };
}
