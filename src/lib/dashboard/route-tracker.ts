import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const STORAGE_KEY = 'dashboardRouteCounts';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** Prefixos conhecidos que mapeiam pra personas operacionais. */
export const TRACKED_PREFIXES = [
  '/admin/reposicao',
  '/admin/estoque',
  '/recebimento',
  '/financeiro',
  '/tintometrico',
  '/sales',
] as const;

export type TrackedPrefix = typeof TRACKED_PREFIXES[number];

export type RouteCounts = Record<string, { count: number; lastSeenIso: string }>;

/** Classifica um pathname em um dos prefixos conhecidos, ou null se não rastreado. */
export function classifyPath(pathname: string): TrackedPrefix | null {
  for (const prefix of TRACKED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

function readStorage(): RouteCounts {
  // Guarda na dependência real (localStorage), não em `window`. São equivalentes
  // no browser/SSR, mas divergem em runtimes onde `localStorage` existe sem `window`
  // (ex: runner nativo do bun nos testes). Ver §5 / bun-setup.ts.
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RouteCounts) : {};
  } catch {
    return {};
  }
}

function pruneExpired(counts: RouteCounts): RouteCounts {
  const now = Date.now();
  const result: RouteCounts = {};
  for (const [prefix, entry] of Object.entries(counts)) {
    const age = now - new Date(entry.lastSeenIso).getTime();
    if (age <= TTL_MS) result[prefix] = entry;
  }
  return result;
}

function writeStorage(counts: RouteCounts): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    /* quota/private mode — silenciar */
  }
}

export function getRouteCounts(): RouteCounts {
  return pruneExpired(readStorage());
}

export function incrementRouteVisit(pathname: string): void {
  const prefix = classifyPath(pathname);
  if (!prefix) return;
  const current = pruneExpired(readStorage());
  const existing = current[prefix];
  current[prefix] = {
    count: (existing?.count ?? 0) + 1,
    lastSeenIso: new Date().toISOString(),
  };
  writeStorage(current);
}

export function clearRouteCounts(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/** Hook montado no AppShell que incrementa contagem em cada navegação. */
export function useRouteTracker(): void {
  const location = useLocation();
  useEffect(() => {
    incrementRouteVisit(location.pathname);
  }, [location.pathname]);
}
