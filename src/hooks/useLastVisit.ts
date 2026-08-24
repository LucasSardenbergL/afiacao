import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';

const STORAGE_KEY = 'dashboardLastVisit';
const MIN_SESSION_MS = 5 * 60 * 1000; // 5min — evita F5 anular deltas

export interface UseLastVisitReturn {
  lastVisitIso: string | null;
  minutesSinceLastVisit: number | null;
}

export interface RegistroVisitaContexto {
  persona: string;
  companySelection: string;
}

/**
 * LEITURA da visita anterior (híbrido server + localStorage).
 *
 * Montado 3× no dashboard (DashboardBody, DeltasStrip, useBriefDeltas) — por isso
 * é SÓ leitura: react-query deduplica a query, mas escrita duplicada geraria 3
 * linhas por visita. Quem escreve é `useRegistrarVisitaDashboard`, 1 chamador só.
 *
 * `range(0, 0)` = linha MAIS recente. A visita atual só vira linha no unmount,
 * então no mount a linha mais recente já é a anterior. (O `range(1, 1)` original
 * vinha do spec, que assumia escrita no mount — off-by-one: devolvia a
 * penúltima visita.)
 */
export function useLastVisit(): UseLastVisitReturn {
  const { user } = useAuth();
  const [localSnapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  const { data: serverIso } = useQuery({
    queryKey: ['dashboard', 'previous-visit', user?.id],
    queryFn: async (): Promise<string | null> => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('dashboard_visits')
        .select('visited_at')
        .eq('user_id', user.id)
        .order('visited_at', { ascending: false })
        .range(0, 0) // mais recente = visita anterior (a atual grava no unmount)
        .maybeSingle();
      const row = data as { visited_at?: string } | null;
      return row?.visited_at ?? null;
    },
    enabled: !!user?.id,
    staleTime: Infinity, // só roda no mount
  });

  const lastVisitIso = serverIso ?? localSnapshot;
  const minutesSinceLastVisit = lastVisitIso
    ? Math.floor((Date.now() - new Date(lastVisitIso).getTime()) / 60_000)
    : null;

  return { lastVisitIso, minutesSinceLastVisit };
}

/**
 * ESCRITA da visita — chamar UMA vez por dashboard (DashboardBody).
 *
 * Grava no unmount se a sessão durou ≥5min: localStorage sempre, server quando
 * há usuário.
 *
 * Emite `dashboard.visita_tentativa` em TODA execução do cleanup (com `motivo`),
 * antes das desistências — sem isso, "não gravou" e "não tentou" são o mesmo
 * sintoma. Fechar a aba não roda cleanup, logo não emite: essa quarta saída só
 * é observável como `dashboard.viewed` − `dashboard.visita_tentativa`.
 */
export function useRegistrarVisitaDashboard(contexto: RegistroVisitaContexto): void {
  const { user } = useAuth();
  const mountedAtRef = useRef<number>(Date.now());
  const contextoRef = useRef(contexto);
  contextoRef.current = contexto;

  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      const sessionDuration = Date.now() - mountedAtRef.current;
      const sessionMinutes = Math.floor(sessionDuration / 60_000);

      // Sensor de TENTATIVA — emitido ANTES de qualquer `return`. O cleanup
      // tinha duas saídas MUDAS (sessão curta, sem usuário) que colapsavam com
      // a terceira (aba fechada — fora do alcance do hook: cleanup nem roda)
      // num sintoma único: tabela vazia. Só a quarta (banco recusa) emitia
      // sinal, então `dashboard_visits` vazio era indistinguível de "ninguém
      // ficou 5min". `motivo` separa "não gravou" de "não tentou"; e como
      // `dashboard.viewed` sai no MOUNT do mesmo DashboardShell, a diferença
      // viewed − visita_tentativa mede as saídas por fechar a aba / F5.
      const motivo =
        sessionDuration < MIN_SESSION_MS ? 'sessao_curta' : !user?.id ? 'sem_usuario' : 'gravou';
      track('dashboard.visita_tentativa', {
        motivo,
        session_minutes: sessionMinutes,
        persona: contextoRef.current.persona,
        company_selection: contextoRef.current.companySelection,
      });

      if (sessionDuration < MIN_SESSION_MS) return;

      const now = new Date().toISOString();

      // local (sempre)
      localStorage.setItem(STORAGE_KEY, now);

      // server (best-effort, não bloqueia)
      if (!user?.id) return;
      // `.then()` é OBRIGATÓRIO: o builder do PostgREST é um thenable PREGUIÇOSO
      // — o fetch mora DENTRO de then(), então `void builder.insert(...)` monta a
      // query e não manda NADA. Foi o que deixou a tabela vazia por 3 meses.
      void supabase
        .from('dashboard_visits')
        .insert({
          user_id: user.id,
          visited_at: now,
          session_minutes: sessionMinutes,
          persona: contextoRef.current.persona,
          company_selection: contextoRef.current.companySelection,
        })
        .then(({ error }) => {
          // falha silenciosa é o que escondeu este bug — reporte sempre
          if (error) {
            track('dashboard.visita_erro', { code: error.code, message: error.message });
          }
        });
    };
  }, [user?.id]);
}
