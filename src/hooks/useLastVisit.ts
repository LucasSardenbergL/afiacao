import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

const STORAGE_KEY = 'dashboardLastVisit';
const MIN_SESSION_MS = 5 * 60 * 1000; // 5min — evita F5 anular deltas

export interface UseLastVisitReturn {
  lastVisitIso: string | null;
  minutesSinceLastVisit: number | null;
}

/**
 * Híbrido:
 * 1. Query server `dashboard_visits` pegando 2ª visita mais recente (antes da atual)
 * 2. localStorage como fallback offline / pre-deploy / sem auth
 * 3. Server wins quando ambos disponíveis (cross-device confiável)
 *
 * Escreve nova visita no unmount: server (best-effort) + local (sempre).
 * Só escreve se sessão durou ≥ 5min (F5 não apaga deltas).
 */
export function useLastVisit(): UseLastVisitReturn {
  const { user } = useAuth();
  const [localSnapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });
  const mountedAtRef = useRef<number>(Date.now());

  const { data: serverIso } = useQuery({
    queryKey: ['dashboard', 'previous-visit', user?.id],
    queryFn: async (): Promise<string | null> => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('dashboard_visits')
        .select('visited_at')
        .eq('user_id', user.id)
        .order('visited_at', { ascending: false })
        .range(1, 1) // segunda mais recente
        .maybeSingle();
      const row = data as { visited_at?: string } | null;
      return row?.visited_at ?? null;
    },
    enabled: !!user?.id,
    staleTime: Infinity, // só roda no mount
  });

  // Escreve no unmount se sessão duradoura
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      const sessionDuration = Date.now() - mountedAtRef.current;
      if (sessionDuration < MIN_SESSION_MS) return;

      const now = new Date().toISOString();
      const sessionMinutes = Math.floor(sessionDuration / 60_000);

      // local (sempre)
      localStorage.setItem(STORAGE_KEY, now);

      // server (best-effort, não bloqueia)
      if (user?.id) {
        void supabase
          .from('dashboard_visits')
          .insert({
            user_id: user.id,
            visited_at: now,
            session_minutes: sessionMinutes,
          });
      }
    };
  }, [user?.id]);

  const lastVisitIso = serverIso ?? localSnapshot;
  const minutesSinceLastVisit = lastVisitIso
    ? Math.floor((Date.now() - new Date(lastVisitIso).getTime()) / 60_000)
    : null;

  return { lastVisitIso, minutesSinceLastVisit };
}
