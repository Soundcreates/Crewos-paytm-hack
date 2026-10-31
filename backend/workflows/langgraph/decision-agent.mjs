const SEARCH_TOOLS = new Set(['tinyfish.search']);
const BROWSER_TOOLS = new Set(['solari.browser.open', 'solari.browser.interact']);
const DESKTOP_TOOLS = new Set(['solari.desktop.exec']);
const ROUTE_DEFINITIONS = [
  { key: 'public_search', label: 'Public web search', description: 'Search open web, news, and research papers with TinyFish.' },
  { key: 'browser', label: 'Persistent browser', description: 'Use a saved browser profile for authenticated or interactive website tasks.' },
  { key: 'desktop', label: 'Employee desktop VM', description: 'Use this employee’s assigned desktop for GUI and desktop command tasks.' },
  { key: 'workspace_tools', label: 'Other employee tools', description: 'Use granted non-browser tools such as Jira, payments, or connected MCP tools.' },
];

function toolsForRoute(route, registry) {
  if (route === 'public_search') return registry.filter((tool) => SEARCH_TOOLS.has(tool.key));
  if (route === 'browser') return registry.filter((tool) => BROWSER_TOOLS.has(tool.key));
  if (route === 'desktop') return registry.filter((tool) => DESKTOP_TOOLS.has(tool.key));
  if (route === 'workspace_tools') return registry.filter((tool) => !SEARCH_TOOLS.has(tool.key) && !BROWSER_TOOLS.has(tool.key) && !DESKTOP_TOOLS.has(tool.key));
  return [];
}

export function availableTaskRoutes(registry) {
  return ROUTE_DEFINITIONS.map((route) => ({ ...route, tools: toolsForRoute(route.key, registry).map((tool) => tool.key) }))
    .filter((route) => route.tools.length > 0);
}

export function normalizeTaskRoute(value, availableRoutes) {
  const available = new Set(availableRoutes.map((route) => route.key));
  const selected = Array.isArray(value?.routes) ? [...new Set(value.routes.filter((route) => available.has(route)))].slice(0, 4) : [];
  if (!selected.length && available.has('workspace_tools')) selected.push('workspace_tools');
  const summary = typeof value?.summary === 'string' ? value.summary.trim().slice(0, 180) : '';
  return { routes: selected, summary: summary || (selected.length ? 'Selected the available tools that best fit this task.' : 'No available tool route matches this task.') };
}

export function filterToolsForTaskRoute(registry, routes = []) {
  if (!Array.isArray(routes) || !routes.length) return registry;
  const selected = new Set(routes);
  return registry.filter((tool) => [...selected].some((route) => toolsForRoute(route, [tool]).length > 0));
}

export function routeAllowsTool(toolKey, routes = []) {
  return filterToolsForTaskRoute([{ key: toolKey }], routes).length === 1;
}

export function fallbackTaskRoute(goal, availableRoutes) {
  const text = String(goal || '');
  const available = new Set(availableRoutes.map((route) => route.key));
  const routes = [];
  const searchIntent = /\b(?:research|search|find|look up|market demand|market analysis|competitor analysis|industry trends|public sources|research papers?)\b/i.test(text);
  const browserIntent = /\b(?:github|pull request|browser|website|web app|webpage|account portal|dashboard)\b/i.test(text)
    && /\b(?:open|navigate|click|fill|create|edit|update|submit|post|comment|review|interact|sign in|log in|upload|download|publish|list|check|inspect|summarize)\b/i.test(text);
  const desktopIntent = /\b(?:desktop|virtual machine|vm|gui|graphical interface|desktop app|terminal|shell|command line)\b/i.test(text);
  if (searchIntent && available.has('public_search')) routes.push('public_search');
  if (browserIntent && available.has('browser')) routes.push('browser');
  if (desktopIntent && available.has('desktop')) routes.push('desktop');
  if (!routes.length && available.has('workspace_tools')) routes.push('workspace_tools');
  const labels = routes.map((route) => ROUTE_DEFINITIONS.find((item) => item.key === route)?.label.toLowerCase());
  return {
    routes,
    summary: labels.length ? `Routed this task to ${labels.join(' and ')}.` : 'No employee tool route is available for this task.',
  };
}
