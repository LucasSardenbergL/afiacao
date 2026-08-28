import { useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { identify, resetAnalytics, setActiveCompany } from '@/lib/analytics';
import { executarProbeTelemetria } from '@/lib/telemetria-probe';

/**
 * Sincroniza estado de auth + empresa ativa com o PostHog:
 *  - Quando user loga: identify(userId, {email, role}) + group por empresa
 *  - Quando user troca de empresa: re-set group
 *  - Quando user desloga: reset
 *  - Quando user loga: dispara o probe de CENSURA (attempt_id pareado, #1984/#2016)
 *
 * Monta uma vez no AppShellLayout. Sem render visual.
 *
 * O probe mora aqui, e não no `initAnalytics()` do App, porque o desenho pede
 * boot AUTENTICADO: a linha em `telemetria_probes` exige `user_id` (RLS
 * `auth.uid() = user_id`), e é a sessão logada que representa o parque real.
 */
export function AnalyticsIdentify() {
  const { user, role } = useAuth();
  const { activeCompany } = useCompany();
  const lastUserIdRef = useRef<string | null>(null);

  // Identify quando user muda
  useEffect(() => {
    if (user) {
      // Evita re-identify desnecessário (re-render do AuthContext)
      if (lastUserIdRef.current !== user.id) {
        identify(user.id, {
          email: user.email,
          role: role,
          name: (user.user_metadata as { name?: string } | undefined)?.name ?? null,
        });
        lastUserIdRef.current = user.id;
      }
    } else if (lastUserIdRef.current) {
      // Logout
      resetAnalytics();
      lastUserIdRef.current = null;
    }
  }, [user, role]);

  // Probe de censura de telemetria (#1984/#2016) — 1× por carga de página
  // autenticada. "Sessões distintas do mesmo aparelho", que é a condição de
  // conclusão da reconciliação, são exatamente cargas de página distintas.
  //
  // Deliberadamente separado do effect de identify: um `identify` que não
  // reidentifica (mesmo `user.id`) não deve suprimir o probe, e um probe que
  // falha não pode impedir o identify.
  useEffect(() => {
    if (!user?.id) return;
    void executarProbeTelemetria(user.id);
  }, [user?.id]);

  // Group por empresa ativa
  useEffect(() => {
    if (user && activeCompany) {
      setActiveCompany(activeCompany);
    }
  }, [user, activeCompany]);

  return null;
}
