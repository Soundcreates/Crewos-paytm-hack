import { useEffect, useState } from 'react';
import { NAV } from './navigation.js';

// Public pages live on real paths; the signed-in app keeps its hash routes on "/".
export const PUBLIC_PATHS = { landing: '/', login: '/login', register: '/register', workspace: '/#voice' };
const NAVIGATE_EVENT = 'crewos:public-navigate';
const APP_HASH_PREFIXES = ['employee/', 'meeting/'];
const APP_HASH_ROUTES = new Set([...NAV.map(([key]) => key), 'overview', 'tasks', 'schedules', 'employees', 'probation', 'meetings', 'coworkers', 'office', 'memory', 'integrations', 'commerce', 'reports', 'settings', 'setup', 'chief', 'hire']);

export function publicPageFromPath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (path === PUBLIC_PATHS.login) return 'login';
  if (path === PUBLIC_PATHS.register) return 'register';
  return 'landing'; // "/" and "/landing" both show the marketing page, signed in or not.
}
export const publicPageNow = () => publicPageFromPath(location.pathname);

// True when the hash points into the workspace (for example "#tasks" or "#employee/42"),
// so a signed-out visitor following a deep link is asked to sign in instead of seeing marketing.
export function isAppHash(hash) {
  const key = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  if (!key) return false;
  return APP_HASH_ROUTES.has(key) || APP_HASH_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function navigatePublic(path, { replace = false, keepLocation = false } = {}) {
  const target = keepLocation ? path + location.search + location.hash : path;
  const current = location.pathname + location.search + location.hash;
  if (target !== current) history[replace ? 'replaceState' : 'pushState'](null, '', target);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  if (!keepLocation) window.scrollTo({ top: 0 });
}

export function usePublicPage() {
  const [page, setPage] = useState(publicPageNow);
  useEffect(() => {
    const update = () => setPage(publicPageNow());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return page;
}

// Client-side link for public paths. Modified clicks (new tab, etc.) fall through to the browser.
export function PublicLink({ to, onClick, children, ...props }) {
  function click(event) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigatePublic(to);
  }
  return <a href={to} onClick={click} {...props}>{children}</a>;
}
