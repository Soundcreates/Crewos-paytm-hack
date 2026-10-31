import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState} from 'react';
import {LazyMotion, MotionConfig} from 'motion/react';

const loadMotionFeatures = () => import('./motion-features.js').then(module => module.default);
const Appearance = createContext(null);
const preferenceKey = 'crewos-theme';
const systemTheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
export function readAppearance() {
  try {
    const stored = localStorage.getItem(preferenceKey);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return systemTheme();
}
export function AppearanceProvider({children}) {
  const [theme, setTheme] = useState(readAppearance);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111215' : '#f3f4f6');
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateSystem = () => setTheme(readAppearance());
    const updateStorage = event => { if (event.key === preferenceKey || event.key === null) updateSystem(); };
    media.addEventListener('change', updateSystem);
    window.addEventListener('storage', updateStorage);
    return () => {
      media.removeEventListener('change', updateSystem);
      window.removeEventListener('storage', updateStorage);
    };
  }, []);
  const toggleTheme = useCallback(() => setTheme(current => {
    const next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(preferenceKey, next); } catch {}
    return next;
  }), []);
  const value = useMemo(() => ({theme, toggleTheme}), [theme, toggleTheme]);
  return <Appearance.Provider value={value}><LazyMotion features={loadMotionFeatures} strict><MotionConfig reducedMotion="user">{children}</MotionConfig></LazyMotion></Appearance.Provider>;
}
export function useAppearance() {
  const appearance = useContext(Appearance);
  if (!appearance) throw new Error('AppearanceProvider is required.');
  return appearance;
}
