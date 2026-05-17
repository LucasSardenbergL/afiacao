import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { PersonaSource } from '@/lib/dashboard/persona-detect';

const STORAGE_KEY = 'dashboardPersonaOverride';

interface DashboardPersonaCtx {
  persona: Persona;
  source: PersonaSource;
  override: Persona | null;
  setOverride: (p: Persona) => void;
  clearOverride: () => void;
}

const Ctx = createContext<DashboardPersonaCtx | null>(null);

export function useDashboardPersonaContext(): DashboardPersonaCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardPersonaContext deve ser usado dentro de DashboardPersonaProvider');
  return v;
}

export function DashboardPersonaProvider({
  resolved,
  children,
}: {
  /** Persona resolvida pelo hook usePersona considerando o override atual. */
  resolved: { persona: Persona; source: PersonaSource };
  children: ReactNode;
}) {
  const [override, setOverrideState] = useState<Persona | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && typeof raw === 'string' ? (raw as Persona) : null;
  });

  const setOverride = (p: Persona) => {
    setOverrideState(p);
    localStorage.setItem(STORAGE_KEY, p);
  };

  const clearOverride = () => {
    setOverrideState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const value = useMemo<DashboardPersonaCtx>(() => ({
    persona: resolved.persona,
    source: resolved.source,
    override,
    setOverride,
    clearOverride,
  }), [resolved.persona, resolved.source, override]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
