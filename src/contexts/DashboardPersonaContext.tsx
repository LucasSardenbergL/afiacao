import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { PersonaSource } from '@/lib/dashboard/persona-detect';
import { usePersona } from '@/hooks/usePersona';

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

export function DashboardPersonaProvider({ children }: { children: ReactNode }) {
  const [override, setOverrideState] = useState<Persona | null>(() => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && typeof raw === 'string' ? (raw as Persona) : null;
  });

  // usePersona é chamado AQUI (abaixo do estado de override) pra que trocar de
  // persona re-renderize e recompute a resolução. Antes ele vivia no
  // DashboardShell (pai), então o setOverride do filho nunca re-rodava a
  // resolução → a troca só aparecia após reload.
  const resolved = usePersona(override);

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
