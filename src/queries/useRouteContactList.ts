import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeCityKey, cityKeyEquals } from '@/lib/whatsapp/route-city';
import { resolvePrepForWorkday } from '@/lib/whatsapp/route-schedule';
import type { RouteScheduleRow, RouteOverrideRow } from '@/lib/whatsapp/route-schedule';
import { buildContactList } from '@/lib/whatsapp/contact-list';
import type { ContactCandidate, ContactConfig, ScoredCandidate } from '@/lib/whatsapp/contact-list';
import { spBusinessDate } from '@/lib/time/sp-day';
import { derivarSinaisContato, type ContatoLog, type OutcomeStatus, type SinaisContato } from '@/lib/route/route-outcome';
import { logger } from '@/lib/logger';
import { useImpersonation } from '@/contexts/ImpersonationContext';

interface VisitScoreRow {
  customer_user_id: string;
  farmer_id: string | null;
  city: string | null;
  visit_score: number | null;
}
interface MetricRow {
  customer_user_id: string | null;
  ticket_medio_90d: number | null;
  intervalo_medio_dias: number | null;
  dias_desde_ultima_compra: number | null;
  is_cold_start: boolean | null;
}
interface RouteConfigRow {
  win_back_reserva_pct: number;
  cold_start_piso_dia: number;
  capacidade_ligacoes_dia: number;
  cadencia_min_dias: number;
}
interface ProfileRow {
  user_id: string;
  name: string | null;
  razao_social: string | null;
  phone: string | null;
}

export interface RouteContactItem extends ScoredCandidate {
  name: string;
  phone: string | null;
  farmerName: string | null;
  // sinais de contato p/ badges (derivados de route_contact_log)
  ultimoContatoRealHaDias: number | null;
  semRespostaRecenteN: number;
  cadenciaBloqueadaPor: 'real' | 'sem_resposta_esgotada' | null;
  jaConvertidoNaRota: boolean;
}
export interface DailyStats { ligados: number; atenderam: number; fecharam: number; }
export interface RouteContactListData {
  callQueue: RouteContactItem[];
  whatsappQueue: RouteContactItem[];
  resolvidosQueue: RouteContactItem[];   // convertidos na rota (saíram da callQueue por fechou_hoje)
  excluidos: ScoredCandidate[];
  routeDate: string | null;
  dailyOnly: boolean;
  cidades: string[];
  dailyStats: DailyStats;
  cadenciaIndisponivel: boolean;          // true se a leitura do log falhou (fail-open)
}

// margem média da empresa (v1 — spec §6.5 q2; calibrar no piloto/codex)
const MARGEM_MEDIA_V1 = 0.22;
const PAGE = 1000;
const IN_CHUNK = 200;

// route_* ainda não estão no types.ts gerado → cast (mesmo padrão de useWhatsappInbox).
type PgRes = { data: unknown; error: { message: string } | null };
interface RouteBuilder {
  select: (cols: string) => RouteBuilder;
  eq: (col: string, val: unknown) => RouteBuilder;
  in: (col: string, vals: unknown[]) => RouteBuilder;
  gte: (col: string, val: unknown) => RouteBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => RouteBuilder;
  range: (from: number, to: number) => RouteBuilder;
  maybeSingle: () => PromiseLike<PgRes>;
  then: PromiseLike<PgRes>['then'];
}
function routeFrom(table: string): RouteBuilder {
  return (supabase as unknown as { from: (t: string) => RouteBuilder }).from(table);
}

interface ContactLogRow { customer_user_id: string; status: string; created_at: string; data_rota: string; }
const LOG_SEL = 'customer_user_id, status, created_at, data_rota';

/** Pagina uma query de route_contact_log (re-monta o builder por página até receber < PAGE). */
async function paginarLog(build: (from: number) => PromiseLike<PgRes>, sink: ContactLogRow[]): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const res = await build(from);
    if (res.error) throw new Error(res.error.message);
    // data null SEM error = malformada, não fim (classe #1338→#1564): tratá-la como fim
    // encerrava o log parcial SEM ligar o fail-open do chamador (que só dispara no throw)
    // — a cadência saía calculada de histórico incompleto.
    if (res.data == null) throw new Error('route_contact_log: data null sem error — malformada, não é fim');
    const got = res.data as ContactLogRow[];
    sink.push(...got);
    if (got.length < PAGE) break;
  }
}

/**
 * Lê route_contact_log dos clientes da fila (canal 'ligacao') em 2 queries PAGINADAS — evita `.or()`
 * com template (regra anti-injeção do lint) E o cap de 1000 do PostgREST: (A) opt_out FULL-history
 * (sticky) + (B) cadência na janela 90d. Filtra canal='ligacao' (exclui WhatsApp/status legado do
 * PR2b). NÃO é "todos os logs" — só os clientes da fila. Lança em erro de DB (chamador faz fail-open).
 */
async function fetchContactLog(ids: string[]): Promise<Map<string, ContatoLog[]>> {
  const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const rows: ContactLogRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    // Os 2 ramos (opt_out full-history + cadência 90d) são independentes →
    // PARALELOS por chunk (eram seriais). O sink compartilhado é seguro
    // (single-thread) e o derivarSinaisContato não depende da ordem global
    // (já era intercalada por ramo na versão serial); o dedupe abaixo cobre.
    await Promise.all([
      paginarLog(from => routeFrom('route_contact_log').select(LOG_SEL).eq('canal', 'ligacao')
        .in('customer_user_id', chunk).eq('status', 'opt_out')
        .order('created_at', { ascending: true }).range(from, from + PAGE - 1) as PromiseLike<PgRes>, rows),
      paginarLog(from => routeFrom('route_contact_log').select(LOG_SEL).eq('canal', 'ligacao')
        .in('customer_user_id', chunk).gte('created_at', cutoff90)
        .order('created_at', { ascending: true }).range(from, from + PAGE - 1) as PromiseLike<PgRes>, rows),
    ]);
  }
  // dedup por (cliente|created_at|status) — opt_out recente aparece nas 2 queries
  const seen = new Set<string>();
  const byCustomer = new Map<string, ContatoLog[]>();
  for (const r of rows) {
    const k = `${r.customer_user_id}|${r.created_at}|${r.status}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const log: ContatoLog = { status: r.status as OutcomeStatus, dataNegocio: spBusinessDate(r.created_at), dataRota: r.data_rota };
    const arr = byCustomer.get(r.customer_user_id);
    if (arr) arr.push(log); else byCustomer.set(r.customer_user_id, [log]);
  }
  return byCustomer;
}

/**
 * #16-full: candidatos das cidades-alvo filtrados NO SERVIDOR pela coluna
 * persistida city_norm (migration 20260611150000 — generated column que
 * espelha a parte-cidade do normalizeCityKey; paridade TS×SQL provada pelo
 * harness db/test-city-norm-paridade.sh sobre as 221 cidades reais de prod +
 * shadow em produção com faltando_no_novo=0). É a FONTE da fila: o filtro
 * server é um SUPERSET seguro (só cidade, NUNCA UF) e quem julga a UF segue
 * sendo o cityKeyEquals no client — semântica assimétrica deliberada (cadastro
 * sem UF casa por cidade; DIVINOPOLIS/TO é excluída no client).
 * A 1ª página traz o count exato e as DEMAIS saem em PARALELO.
 */
async function fetchVisitScoresByCityNorm(cityNorms: string[], farmerId: string | null): Promise<VisitScoreRow[]> {
  const baseSelect = (withCount: boolean) => {
    let q = supabase
      .from('customer_visit_scores')
      .select('customer_user_id, farmer_id, city, visit_score', withCount ? { count: 'exact' } : undefined)
      .in('city_norm' as never, cityNorms);
    // Lente "Ver como": escopa à carteira do ALVO NO SERVIDOR. O master lê
    // customer_visit_scores sem o filtro de RLS → sem isto a rota traria TODAS
    // as carteiras (infiel ao alvo). Fora da lente farmerId=null → a RLS escopa
    // a vendedora real, comportamento INALTERADO.
    if (farmerId) q = q.eq('farmer_id', farmerId);
    return q.order('customer_user_id', { ascending: true });
  };

  const first = await baseSelect(true).range(0, PAGE - 1);
  if (first.error) throw first.error;
  // data null SEM error = malformada (classe #1338→#1564): o `?? []` sumia com até 1.000
  // candidatos por página e ninguém conferia out.length × total.
  if (first.data == null) throw new Error('customer_visit_scores: data null sem error — malformada, não é fim');
  const out: VisitScoreRow[] = [...(first.data as VisitScoreRow[])];
  const total = first.count ?? out.length;
  if (total > PAGE) {
    const ranges: Array<[number, number]> = [];
    for (let from = PAGE; from < total; from += PAGE) ranges.push([from, from + PAGE - 1]);
    const pages = await Promise.all(ranges.map(([f, t]) => baseSelect(false).range(f, t)));
    for (const p of pages) {
      if (p.error) throw p.error;
      if (p.data == null) throw new Error('customer_visit_scores: data null sem error — malformada, não é fim');
      out.push(...(p.data as VisitScoreRow[]));
    }
  }
  return out;
}

async function fetchMetrics(ids: string[]): Promise<MetricRow[]> {
  const out: MetricRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('customer_metrics_mv')
      .select('customer_user_id, ticket_medio_90d, intervalo_medio_dias, dias_desde_ultima_compra, is_cold_start')
      .in('customer_user_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as MetricRow[]));
  }
  return out;
}

async function fetchProfiles(ids: string[]): Promise<ProfileRow[]> {
  const out: ProfileRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id, name, razao_social, phone')
      .in('user_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw error;
    out.push(...((data ?? []) as ProfileRow[]));
  }
  return out;
}

export function useRouteContactList(workdayIso: string) {
  const { isImpersonating, effectiveUserId } = useImpersonation();
  // Na lente "Ver como", escopa a fila à carteira do ALVO (ver fetchVisitScoresByCityNorm).
  // Fora da lente: null → a RLS escopa a vendedora real, comportamento INALTERADO.
  const lensFarmerId = isImpersonating && effectiveUserId ? effectiveUserId : null;
  return useQuery<RouteContactListData>({
    queryKey: ['route-contact-list', workdayIso, lensFarmerId],
    staleTime: 60_000,
    queryFn: async () => {
      // 1) agenda + override + config → cidades D-1
      const [schedRes, ovrRes, cfgRes] = await Promise.all([
        routeFrom('route_schedule').select('weekday, city, uf, is_daily, ativo') as PromiseLike<PgRes>,
        routeFrom('route_calendar_override').select('data, cancela_rota') as PromiseLike<PgRes>,
        routeFrom('route_disparo_config')
          .select('win_back_reserva_pct, cold_start_piso_dia, capacidade_ligacoes_dia, cadencia_min_dias')
          .eq('id', true).maybeSingle(),
      ]);
      const sched = (schedRes.data ?? []) as RouteScheduleRow[];
      const ovr = (ovrRes.data ?? []) as RouteOverrideRow[];
      const cfgRow = (cfgRes.data ?? null) as RouteConfigRow | null;

      const prep = resolvePrepForWorkday(workdayIso, sched, ovr);
      const empty: RouteContactListData = {
        callQueue: [], whatsappQueue: [], resolvidosQueue: [], excluidos: [],
        routeDate: prep.routeDate, dailyOnly: prep.dailyOnly, cidades: prep.cities.map(c => c.city),
        dailyStats: { ligados: 0, atenderam: 0, fecharam: 0 }, cadenciaIndisponivel: false,
      };
      if (prep.cities.length === 0) return empty;

      // 2) candidatos das cidades-alvo — filtrados NO SERVIDOR por city_norm
      // (#16-full; ver fetchVisitScoresByCityNorm). O cityKeyEquals no client
      // abaixo é PERMANENTE: é ele que julga a UF (superset server → exato).
      const cityNorms = [...new Set(prep.cities.map(c => c.city))];
      const scores = await fetchVisitScoresByCityNorm(cityNorms, lensFarmerId);
      const candsFiltrados = scores.filter(r => {
        const ck = normalizeCityKey(r.city);
        return ck !== null && prep.cities.some(pc => cityKeyEquals(pc, ck));
      });
      // Dedupe por cliente: as páginas PARALELAS do fetch podem (raro) trazer
      // uma linha duplicada em shift de offset — cliente 2× na fila ocuparia
      // 2 slots de capacidade e geraria 2 ligações.
      const candByUser = new Map<string, VisitScoreRow>();
      for (const r of candsFiltrados) {
        if (!candByUser.has(r.customer_user_id)) candByUser.set(r.customer_user_id, r);
      }
      const cands0 = [...candByUser.values()];

      if (cands0.length === 0) return empty;

      // 3) métricas econômicas + perfis (nome/telefone) em lote
      const userIds = [...new Set(cands0.map(c => c.customer_user_id))];
      const farmerIds = [...new Set(cands0.map(c => c.farmer_id).filter((x): x is string => !!x))];
      const profileIds = [...new Set([...userIds, ...farmerIds])];

      // Métricas + perfis + log de contato dependem SÓ de userIds → 1 rodada
      // PARALELA (o log era um await separado DEPOIS de metrics/profiles).
      // O fail-open do log (erro → defaults, NÃO esconde cliente) é preservado
      // pelo catch inline — falha do log não derruba os outros dois.
      const hoje = spBusinessDate(new Date());
      // mesmo fallback da UI (RotaListaLigacao grava data_rota = routeDate ?? workday) — senão em dia
      // de diária (routeDate null) o convertido gravado com workday nunca casaria → some de "Resolvidos".
      const dataRotaFila = prep.routeDate ?? workdayIso;
      let cadenciaIndisponivel = false;
      const [metrics, profiles, logByCustomer] = await Promise.all([
        fetchMetrics(userIds),
        fetchProfiles(profileIds),
        fetchContactLog(userIds).catch((e) => {
          cadenciaIndisponivel = true;
          logger.warn('Leitura de route_contact_log falhou — cadência ao vivo indisponível', { error: e instanceof Error ? e.message : String(e) });
          return new Map<string, ContatoLog[]>();
        }),
      ]);
      const mByUser = new Map(metrics.map(m => [m.customer_user_id, m]));
      const pByUser = new Map(profiles.map(p => [p.user_id, p]));
      const sinaisByCustomer = new Map<string, SinaisContato>();
      for (const id of userIds) {
        sinaisByCustomer.set(id, derivarSinaisContato(logByCustomer.get(id) ?? [], hoje, dataRotaFila));
      }

      const cfg: ContactConfig = {
        winBackReservaPct: cfgRow?.win_back_reserva_pct ?? 0.2,
        coldStartPisoDia: cfgRow?.cold_start_piso_dia ?? 3,
        capacidadeLigacoes: cfgRow?.capacidade_ligacoes_dia ?? 40,
        cadenciaMinDias: cfgRow?.cadencia_min_dias ?? 3,
      };

      const candidates: ContactCandidate[] = cands0.map(r => {
        const m = mByUser.get(r.customer_user_id);
        const ck = normalizeCityKey(r.city) ?? { city: '', uf: '' };
        return {
          customerUserId: r.customer_user_id,
          farmerId: r.farmer_id,
          cityKey: ck,
          pConverte: Math.max(0, Math.min(1, (r.visit_score ?? 0) / 100)),
          ticketEsperado: m?.ticket_medio_90d ?? 0,
          margemPerc: MARGEM_MEDIA_V1,
          diasDesdeUltima: m?.dias_desde_ultima_compra ?? null,
          intervaloMedioDias: m?.intervalo_medio_dias ?? null,
          isColdStart: m?.is_cold_start ?? false,
          optOut: sinaisByCustomer.get(r.customer_user_id)?.optOut ?? false,
          contatadoHaDias: sinaisByCustomer.get(r.customer_user_id)?.contatadoHaDiasParaGate ?? null,
          fechouHoje: sinaisByCustomer.get(r.customer_user_id)?.jaConvertidoNaRota ?? false,
          janela24hAberta: false,   // WhatsApp 24h — fora do escopo do closed-loop de ligação
          margemNegativaConhecida: false,
        };
      });

      const result = buildContactList(candidates, cfg);
      const enrich = (s: ScoredCandidate): RouteContactItem => {
        const p = pByUser.get(s.customerUserId);
        const farmer = s.farmerId ? pByUser.get(s.farmerId) : undefined;
        const sinais = sinaisByCustomer.get(s.customerUserId);
        return {
          ...s,
          name: p?.razao_social || p?.name || s.customerUserId,
          phone: p?.phone ?? null,
          farmerName: farmer?.name ?? farmer?.razao_social ?? null,
          ultimoContatoRealHaDias: sinais?.ultimoContatoRealHaDias ?? null,
          semRespostaRecenteN: sinais?.semRespostaRecenteN ?? 0,
          cadenciaBloqueadaPor: sinais?.cadenciaBloqueadaPor ?? null,
          jaConvertidoNaRota: sinais?.jaConvertidoNaRota ?? false,
        };
      };

      // convertidos na rota → seção "Resolvidos hoje". Filtra pelo SINAL fechouHoje (não pelo motivoGate:
      // convertido+opt_out cai em 'opt_out' na ordem do gate, mas ainda fechou na rota — Codex).
      const resolvidosQueue = result.excluidos.filter(s => s.fechouHoje).map(enrich);

      // métrica do dia (turno do vendedor): clientes da fila contatados HOJE (dataNegocio === hoje)
      let ligados = 0, atenderam = 0, fecharam = 0;
      for (const logs of logByCustomer.values()) {
        const hojeRegs = logs.filter(l => l.dataNegocio === hoje);
        if (hojeRegs.length === 0) continue;
        ligados++;
        if (hojeRegs.some(l => l.status === 'respondido' || l.status === 'convertido')) atenderam++;
        if (hojeRegs.some(l => l.status === 'convertido')) fecharam++;
      }

      return {
        callQueue: result.callQueue.map(enrich),
        whatsappQueue: result.whatsappQueue.map(enrich),
        resolvidosQueue,
        excluidos: result.excluidos,
        routeDate: prep.routeDate,
        dailyOnly: prep.dailyOnly,
        cidades: prep.cities.map(c => c.city),
        dailyStats: { ligados, atenderam, fecharam },
        cadenciaIndisponivel,
      };
    },
  });
}
