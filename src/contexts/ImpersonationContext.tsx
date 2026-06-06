import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabaseUnguarded } from '@/integrations/supabase/client';
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
  // A lente é master-only: um `target` só conta se o usuário REAL é master. Se isMaster
  // virar false (logout/troca de conta/revogação de papel ao vivo), a lente NÃO pode
  // continuar ativa — `isImpersonating` e `effectiveUserId` derivam de `lensActive`.
  const lensActive = isMaster && !!target;
  const effectiveUserId = resolveEffectiveUserId(realUserId, lensActive ? target : null);

  // Hard reload: no mount o `isMaster` ainda é false (auth assíncrono), então o init do
  // useState cai pra null e a impersonação se perderia. Quando o master é confirmado,
  // restaura do sessionStorage. Liga o guard ANTES de publicar o target (fecha a
  // micro-janela em que a UI já está na lente mas o guard ainda não ligou).
  useEffect(() => {
    if (isMaster && !target) {
      const persisted = loadPersistedTarget();
      if (persisted) {
        setLensActive(true);
        setTarget(persisted);
      }
    }
  }, [isMaster, target]);

  // Deixou de ser master com a lente ativa → derruba tudo (não deixa um não-master
  // herdar a lente). Cobre revogação de papel ao vivo / troca de sessão sem remount.
  useEffect(() => {
    if (!isMaster && target) {
      setLensActive(false);
      setTarget(null);
      persistTarget(null);
      setAuditId(null);
    }
  }, [isMaster, target]);

  // Guard global reflete `lensActive`. NÃO desliga no cleanup de cada mudança de target
  // (isso criava um flicker A→B com o guard off entre o cleanup e o novo setup) — só
  // sincroniza o estado atual. O desligamento real é no unmount (effect abaixo) e em
  // start/stop, que setam a flag direto.
  useEffect(() => {
    setLensActive(lensActive);
  }, [lensActive]);
  // Unmount do provider: garante o guard desligado (evita flag stale num remount).
  useEffect(() => () => setLensActive(false), []);

  const startImpersonation = useCallback(async (t: ImpersonationTarget, reason?: string) => {
    if (!isMaster) return;
    // Auditoria no client SEM guard: log_impersonation_start é write mutante. Se a lente
    // já estiver ativa (troca direta de alvo A→B pelo chip/banner), o guard de RPC a
    // bloquearia — por isso supabaseUnguarded. É bookkeeping do próprio master.
    const { data } = await (supabaseUnguarded as unknown as {
      rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
    }).rpc('log_impersonation_start', { p_target: t.id, p_reason: reason ?? null });
    setAuditId(typeof data === 'string' ? data : null);
    setLensActive(true); // guard ANTES do target — sem janela "UI na lente + guard off"
    setTarget(t);
    persistTarget(t);
    track('carteira.ver_como_iniciado', { grupo: t.grupo });
  }, [isMaster]);

  const stopImpersonation = useCallback(async () => {
    // O guard fica ATIVO durante o await (end_impersonation roda no client sem guard, não
    // é bloqueado). NÃO desligamos o guard explicitamente aqui: ao limpar o target, o
    // effect de `lensActive` desliga o guard SÓ DEPOIS de a UI sair da lente — sem janela
    // "guard off + UI ainda na lente". O try/finally garante a saída mesmo se a auditoria
    // lançar (senão a lente ficaria presa).
    try {
      if (auditId) {
        await (supabaseUnguarded as unknown as {
          rpc(fn: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
        }).rpc('end_impersonation', { p_audit_id: auditId });
      }
    } catch {
      /* falha de auditoria não pode travar a saída da lente */
    } finally {
      setAuditId(null);
      setTarget(null);
      persistTarget(null);
    }
  }, [auditId]);

  const value = useMemo(() => ({
    realUserId, target, effectiveUserId, isImpersonating: lensActive,
    startImpersonation, stopImpersonation,
  }), [realUserId, target, effectiveUserId, lensActive, startImpersonation, stopImpersonation]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useImpersonation(): ImpersonationContextType {
  const v = useContext(Ctx);
  if (!v) throw new Error('useImpersonation deve estar dentro de ImpersonationProvider');
  return v;
}
