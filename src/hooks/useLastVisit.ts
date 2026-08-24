import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { track } from '@/lib/analytics';

const STORAGE_KEY = 'dashboardLastVisit';
const MIN_SESSION_MS = 5 * 60 * 1000; // 5min — evita F5 anular deltas
const TIMEOUT_DELTA_MS = 3000; // teto de espera do delta antes de emitir mesmo assim

export interface UseLastVisitReturn {
  lastVisitIso: string | null;
  minutesSinceLastVisit: number | null;
  /** A leitura da visita anterior terminou? `false` = delta ainda não confiável. */
  visitaResolvida: boolean;
}

export interface RegistroVisitaContexto {
  persona: string;
  companySelection: string;
}

export interface ContextoVisualizacaoDashboard {
  persona: string;
  personaSource: string;
  companyMode: 'all' | 'single';
  companyId: string | number;
}

/** Por que esta execução gravou — ou desistiu. */
type MotivoTentativa =
  | 'gravou'
  | 'sessao_curta'
  | 'sem_usuario'
  | 'ja_gravado'
  | 'lente_ativa'
  | 'sem_token';

interface PayloadVisita {
  user_id: string;
  visited_at: string;
  session_minutes: number;
  persona: string;
  company_selection: string;
}

/**
 * LEITURA da visita anterior (híbrido server + localStorage).
 *
 * Montado 3× no dashboard (DashboardBody, DeltasStrip, useBriefDeltas) — por isso
 * é SÓ leitura: react-query deduplica a query, mas escrita duplicada geraria 3
 * linhas por visita. Quem escreve é `useRegistrarVisitaDashboard`, 1 chamador só.
 *
 * `range(0, 0)` = linha MAIS recente. A visita atual só vira linha no fim da
 * sessão, então no mount a linha mais recente já é a anterior. (O `range(1, 1)`
 * original vinha do spec, que assumia escrita no mount — off-by-one: devolvia a
 * penúltima visita.)
 */
export function useLastVisit(): UseLastVisitReturn {
  const { user } = useAuth();
  const [localSnapshot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  const { data: serverIso, isPending } = useQuery({
    queryKey: ['dashboard', 'previous-visit', user?.id],
    queryFn: async (): Promise<string | null> => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('dashboard_visits')
        .select('visited_at')
        .eq('user_id', user.id)
        .order('visited_at', { ascending: false })
        .range(0, 0) // mais recente = visita anterior (a atual grava no fim da sessão)
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

  // Sem usuário a query fica `enabled: false` — e em react-query v5 isso mantém
  // `isPending` true para sempre. Aí só existe o localStorage, que é síncrono:
  // já nasce resolvido.
  const visitaResolvida = !user?.id || !isPending;

  return { lastVisitIso, minutesSinceLastVisit, visitaResolvida };
}

/**
 * Emissão que sobrevive à morte do documento.
 *
 * `keepalive: true` é o ponto todo: sem ele o browser cancela a request em voo
 * quando a aba fecha. `sendBeacon` não serve — não deixa mandar os headers de
 * auth que o PostgREST exige.
 */
function emitirComKeepalive(payload: PayloadVisita, token: string): void {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/dashboard_visits`;
  void fetch(url, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      // falha silenciosa é o que escondeu o bug do #1934 — reporte sempre
      if (!res.ok) {
        track('dashboard.visita_erro', { code: String(res.status), message: 'keepalive_http' });
      }
    })
    .catch((erro: unknown) => {
      track('dashboard.visita_erro', { code: 'keepalive_network', message: String(erro) });
    });
}

/**
 * ESCRITA da visita — chamar UMA vez por dashboard (DashboardBody).
 *
 * Uma visita termina de dois jeitos e SÓ UM deles passa pelo React:
 *  - navegação in-app → unmount → cleanup do effect → client do supabase;
 *  - fechar a aba / recarregar / sair do site → o cleanup NUNCA roda. A única
 *    chance é `pagehide` (mais confiável que `beforeunload`, e o único que o
 *    Safari/iOS honra), com `fetch keepalive`.
 *
 * Grava no máximo uma vez por montagem (`gravadoRef`), e só se a sessão durou
 * ≥5min — o mesmo guard anti-F5 vale nos DOIS caminhos.
 *
 * `dashboard.visita_tentativa` sai em TODA execução, antes de qualquer
 * desistência, com `motivo` — sem isso "não gravou" e "não tentou" viram o
 * mesmo sintoma (tabela vazia). O campo `via` diz por qual caminho a visita
 * terminou: a saída por fecho de aba, que antes só dava para inferir por
 * `viewed − visita_tentativa`, agora é MEDIDA direto (`via='pagehide'`).
 */
export function useRegistrarVisitaDashboard(contexto: RegistroVisitaContexto): void {
  const { user, session } = useAuth();
  const mountedAtRef = useRef<number>(Date.now());
  const contextoRef = useRef(contexto);
  contextoRef.current = contexto;
  // O token vive em ref, NÃO nas deps do effect: um refresh de token re-rodaria
  // o effect, e o cleanup gravaria uma visita que não terminou.
  const tokenRef = useRef<string | undefined>(session?.access_token);
  tokenRef.current = session?.access_token;
  const gravadoRef = useRef(false);

  useEffect(() => {
    const decidirMotivo = (viaFechoDeAba: boolean, duracao: number): MotivoTentativa => {
      if (gravadoRef.current) return 'ja_gravado';
      if (duracao < MIN_SESSION_MS) return 'sessao_curta';
      // O fetch cru do pagehide NÃO passa pelo client embrulhado pelo
      // write-guard da lente "ver como" — o gate tem que ser aqui, na fonte.
      if (viaFechoDeAba && isLensActive()) return 'lente_ativa';
      if (!user?.id) return 'sem_usuario';
      // Sem token não dá para autenticar o fetch cru. Não queima a chance: se
      // ainda houver unmount, ele grava pelo client.
      if (viaFechoDeAba && !tokenRef.current) return 'sem_token';
      return 'gravou';
    };

    const gravar = (via: 'unmount' | 'pagehide') => {
      if (typeof window === 'undefined') return;

      const viaFechoDeAba = via === 'pagehide';
      const sessionDuration = Date.now() - mountedAtRef.current;
      const sessionMinutes = Math.floor(sessionDuration / 60_000);
      const motivo = decidirMotivo(viaFechoDeAba, sessionDuration);

      // Sensor de TENTATIVA — emitido ANTES de qualquer `return`.
      track('dashboard.visita_tentativa', {
        motivo,
        via,
        session_minutes: sessionMinutes,
        persona: contextoRef.current.persona,
        company_selection: contextoRef.current.companySelection,
      });

      if (motivo === 'ja_gravado' || motivo === 'sessao_curta') return;
      if (motivo === 'lente_ativa' || motivo === 'sem_token') return;

      gravadoRef.current = true;
      const now = new Date().toISOString();

      // local (sempre — inclusive sem usuário)
      localStorage.setItem(STORAGE_KEY, now);

      // server (best-effort, não bloqueia)
      if (motivo === 'sem_usuario' || !user?.id) return;
      const payload: PayloadVisita = {
        user_id: user.id,
        visited_at: now,
        session_minutes: sessionMinutes,
        persona: contextoRef.current.persona,
        company_selection: contextoRef.current.companySelection,
      };

      const token = tokenRef.current;
      if (viaFechoDeAba && token) {
        emitirComKeepalive(payload, token);
        return;
      }

      // `.then()` é OBRIGATÓRIO: o builder do PostgREST é um thenable PREGUIÇOSO
      // — o fetch mora DENTRO de then(), então `void builder.insert(...)` monta a
      // query e não manda NADA. Foi o que deixou a tabela vazia por 3 meses.
      void supabase
        .from('dashboard_visits')
        .insert(payload)
        .then(({ error }) => {
          // falha silenciosa é o que escondeu este bug — reporte sempre
          if (error) {
            track('dashboard.visita_erro', { code: error.code, message: error.message });
          }
        });
    };

    const aoEsconderPagina = () => gravar('pagehide');
    window.addEventListener('pagehide', aoEsconderPagina);
    return () => {
      window.removeEventListener('pagehide', aoEsconderPagina);
      gravar('unmount');
    };
  }, [user?.id]);
}

/**
 * Emite `dashboard.viewed` UMA vez, esperando a leitura da visita anterior.
 *
 * O effect com deps `[]` disparava no mount — antes da query resolver — e por
 * isso `time_since_last_visit_min` chegava nulo em 39 de 46 eventos. Esperar
 * enche o delta; o timeout existe porque trocar "propriedade nula" por "evento
 * ausente" seria pior: leitura travada ainda tem que emitir o `viewed`.
 *
 * `time_since_last_visit_resolvido` desambigua o null que sobrar: sem ele, um
 * nulo futuro volta a ser "não sei se é primeira visita ou se é a corrida".
 */
export function useTrackDashboardViewed(contexto: ContextoVisualizacaoDashboard): void {
  const { minutesSinceLastVisit, visitaResolvida } = useLastVisit();
  const contextoRef = useRef(contexto);
  contextoRef.current = contexto;
  const deltaRef = useRef(minutesSinceLastVisit);
  deltaRef.current = minutesSinceLastVisit;
  const disparadoRef = useRef(false);

  const disparar = useCallback((resolvido: boolean) => {
    if (disparadoRef.current) return;
    disparadoRef.current = true;
    const atual = contextoRef.current;
    track('dashboard.viewed', {
      persona: atual.persona,
      persona_source: atual.personaSource,
      company_mode: atual.companyMode,
      company_id: atual.companyId,
      time_since_last_visit_min: deltaRef.current,
      time_since_last_visit_resolvido: resolvido,
    });
  }, []);

  useEffect(() => {
    if (visitaResolvida) {
      disparar(true);
      return;
    }
    const id = setTimeout(() => disparar(false), TIMEOUT_DELTA_MS);
    return () => clearTimeout(id);
  }, [visitaResolvida, disparar]);
}
