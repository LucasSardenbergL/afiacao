import { useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { identify, resetAnalytics, setActiveCompany } from '@/lib/analytics';

/**
 * Sincroniza estado de auth + empresa ativa com o PostHog:
 *  - Quando user loga: identify(userId, {email, role}) + group por empresa
 *  - Quando user troca de empresa: re-set group
 *  - Quando user desloga: reset
 *
 * Monta uma vez no AppShellLayout. Sem render visual.
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

  // Group por empresa ativa
  useEffect(() => {
    if (user && activeCompany) {
      setActiveCompany(activeCompany);
    }
  }, [user, activeCompany]);

  return null;
}
