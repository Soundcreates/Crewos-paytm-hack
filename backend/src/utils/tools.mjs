export function mcpToolKey(connectionId, toolName) {
  return `mcp.${connectionId}.${toolName}`;
}

export function sampleMcpSimulationInput(schema = {}) {
  const input = {};

  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    const field = schema.properties?.[key] || {};
    if (Object.hasOwn(field, 'const')) input[key] = field.const;
    else if (Array.isArray(field.enum) && field.enum.length) input[key] = field.enum[0];
    else if (Object.hasOwn(field, 'default')) input[key] = field.default;
    else if (field.type === 'string') input[key] = 'SIMULATION';
    else if (field.type === 'integer' || field.type === 'number') input[key] = Number.isFinite(field.minimum) ? field.minimum : 1;
    else if (field.type === 'boolean') input[key] = false;
    else if (field.type === 'array') input[key] = [];
    else if (field.type === 'object') input[key] = {};
  }

  return input;
}

export function plannerTool(tool) {
  if (!tool.mcpTool) return tool;

  const schema = tool.inputSchema || {};
  const properties = Object.fromEntries(
    Object.entries(schema.properties || {}).slice(0, 12).map(([key, value]) => [key.slice(0, 100), {
      ...(typeof value?.type === 'string' ? { type: value.type } : {}),
      ...(typeof value?.description === 'string' ? { description: value.description.slice(0, 120) } : {}),
      ...(Array.isArray(value?.enum) ? { enum: value.enum.slice(0, 8) } : {}),
    }]),
  );

  return {
    key: tool.key,
    label: tool.label,
    group: tool.group,
    description: String(tool.description || '').slice(0, 400),
    inputSchema: {
      type: 'object',
      properties,
      required: (Array.isArray(schema.required) ? schema.required : []).slice(0, 12),
      additionalProperties: schema.additionalProperties !== false,
    },
    externalMcpTool: tool.mcpTool,
  };
}
