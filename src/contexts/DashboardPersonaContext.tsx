import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { Persona } from '@/lib/dashboard/persona-config';
import type { PersonaSource } from '@/lib/dashboard/persona-detect';
import { usePersona } from '@/hooks/usePersona';

// Chave legada do override manual de persona. A troca manual foi APOSENTADA em favor
// da lente "Ver como" (impersonação read-only por pessoa real); limpamos a chave no
// boot pra um valor preso de versões antigas não vencer a inferência (inferPersona passo 1).
const LEGACY_OVERRIDE_KEY = 'dashboardPersonaOverride';

interface DashboardPersonaCtx {
  persona: Persona;
  source: PersonaSource;
}

const Ctx = createContext<DashboardPersonaCtx | null>(null);

export function useDashboardPersonaContext(): DashboardPersonaCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardPersonaContext deve ser usado dentro de DashboardPersonaProvider');
  return v;
}

export function DashboardPersonaProvider({ children }: { children: ReactNode }) {
  // A persona é resolvida só por display* (acesso real, ou do alvo na lente). Não há
  // mais override manual — a "troca de visão" é a lente. Limpa o resíduo do localStorage.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LEGACY_OVERRIDE_KEY);
    }
  }, []);

  const resolved = usePersona(null);

  const value = useMemo<DashboardPersonaCtx>(() => ({
    persona: resolved.persona,
    source: resolved.source,
  }), [resolved.persona, resolved.source]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
