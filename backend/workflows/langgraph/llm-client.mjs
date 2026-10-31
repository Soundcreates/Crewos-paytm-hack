import { getLlmModel, getLlmProviderLabel, requestLlm } from '../../lib/llm-provider.mjs';

export async function callLlmTools({ apiKey, model, messages, tools, onUsage }) {
  const selectedModel = model || getLlmModel('chat') || 'openai/gpt-4o-mini';
  const response = await requestLlm('chat/completions', {
    apiKey,
    body: {
      model: selectedModel,
      max_tokens: 4096,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : { tool_choice: 'none' }),
    },
    timeoutMs: 60000,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
    throw Object.assign(new Error(`${getLlmProviderLabel()} tool-calling request failed (${response.status})${detail ? `: ${detail}` : ''}. Check the selected model's tool-calling support and provider configuration.`), { code: 'provider_request_failed', httpStatus: response.status });
  }
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) throw new Error(`${getLlmProviderLabel()} returned neither a final answer nor a tool call.`);
  const usage = payload.usage;
  if (usage && onUsage) await onUsage({
    model: payload.model || selectedModel,
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
  });
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}
