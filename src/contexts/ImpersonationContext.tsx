import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { resolveEffectiveUserId, loadPersistedTarget, persistTarget } from '@/lib/impersonation/effective-user';
import { setLensActive } from '@/lib/impersonation/lens-write-guard';
import { track } from '@/lib/analytics';
import type { ImpersonationTarget } from '@/lib/impersonation/types';

interface ImpersonationContextType {
  realUserId: string | null;
  target: ImpersonationTarget | null;
  effectiveUserId: string | null;
  isImpersonating: boolean;
  startImpersonation: (t: ImpersonationTarget, reason?: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const Ctx = createContext<ImpersonationContextType | undefined>(undefined);

export function ImpersonationProvider({ children }: { children: ReactNode }) {
  const { user, isMaster } = useAuth();
  const [target, setTarget] = useState<ImpersonationTarget | null>(() => (isMaster ? loadPersistedTarget() : null));
  const [auditId, setAuditId] = useState<string | null>(null);

  const realUserId = user?.id ?? null;
  const effectiveUserId = resolveEffectiveUserId(realUserId, target);

  // Hard reload: no mount o `isMaster` ainda é false (auth assíncrono), então o
  // init do useState acima cai pra null e a impersonação se perderia. Quando o
  // master é confirmado, restaura do sessionStorage (continuidade entre reloads).
  // stopImpersonation limpa o sessionStorage antes deste efeito rodar, então não
  // re-restaura após "Sair".
  useEffect(() => {
    if (isMaster && !target) {
      const persisted = loadPersistedTarget();
      if (persisted) setTarget(persisted);
    }
  }, [isMaster, target]);

  // Sincronização defensiva do write-guard global: start/stopImpersonation já setam
  // a flag diretamente; este efeito cobre os casos em que `target` muda por outro
  // caminho (ex.: restauração do sessionStorage no F5).
  useEffect(() => {
    setLensActive(!!target);
    return () => setLensActive(false);
  }, [target]);

  const startImpersonation = useCallback(async (t: ImpersonationTarget, reason?: string) => {
    if (!isMaster) return;
    const { data } = await (supabase as unknown as {
      rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
    }).rpc('log_impersonation_start', { p_target: t.id, p_reason: reason ?? null });
    setAuditId(typeof data === 'string' ? data : null);
    setLensActive(true);
    setTarget(t);
    persistTarget(t);
    track('carteira.ver_como_iniciado', { grupo: t.grupo });
  }, [isMaster]);

  const stopImpersonation = useCallback(async () => {
    setLensActive(false);
    if (auditId) {
      await (supabase as unknown as {
        rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
      }).rpc('end_impersonation', { p_audit_id: auditId });
    }
    setAuditId(null);
    setTarget(null);
    persistTarget(null);
  }, [auditId]);

  const value = useMemo(() => ({
    realUserId, target, effectiveUserId, isImpersonating: !!target,
    startImpersonation, stopImpersonation,
  }), [realUserId, target, effectiveUserId, startImpersonation, stopImpersonation]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useImpersonation(): ImpersonationContextType {
  const v = useContext(Ctx);
  if (!v) throw new Error('useImpersonation deve estar dentro de ImpersonationProvider');
  return v;
}
