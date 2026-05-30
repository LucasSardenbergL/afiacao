import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeCityKey, cityKeyEquals } from '@/lib/whatsapp/route-city';
import { resolvePrepForWorkday } from '@/lib/whatsapp/route-schedule';
import type { RouteScheduleRow, RouteOverrideRow } from '@/lib/whatsapp/route-schedule';
import { buildContactList } from '@/lib/whatsapp/contact-list';
import type { ContactCandidate, ContactConfig, ScoredCandidate } from '@/lib/whatsapp/contact-list';

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
}
export interface RouteContactListData {
  callQueue: RouteContactItem[];
  whatsappQueue: RouteContactItem[];
  excluidos: ScoredCandidate[];
  routeDate: string | null;
  dailyOnly: boolean;
  cidades: string[];
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
  maybeSingle: () => PromiseLike<PgRes>;
  then: PromiseLike<PgRes>['then'];
}
function routeFrom(table: string): RouteBuilder {
  return (supabase as unknown as { from: (t: string) => RouteBuilder }).from(table);
}

/** Lê TODOS os customer_visit_scores com cidade (pagina o cap de 1000 do PostgREST). */
async function fetchAllVisitScores(): Promise<VisitScoreRow[]> {
  const out: VisitScoreRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('customer_visit_scores')
      .select('customer_user_id, farmer_id, city, visit_score')
      .not('city', 'is', null)
      .order('customer_user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as VisitScoreRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
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
  return useQuery<RouteContactListData>({
    queryKey: ['route-contact-list', workdayIso],
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
        callQueue: [], whatsappQueue: [], excluidos: [],
        routeDate: prep.routeDate, dailyOnly: prep.dailyOnly, cidades: prep.cities.map(c => c.city),
      };
      if (prep.cities.length === 0) return empty;

      // 2) candidatos das cidades-alvo (customer_visit_scores é city-aware + RLS por carteira)
      const allScores = await fetchAllVisitScores();
      const cands0 = allScores.filter(r => {
        const ck = normalizeCityKey(r.city);
        return ck !== null && prep.cities.some(pc => cityKeyEquals(pc, ck));
      });
      if (cands0.length === 0) return empty;

      // 3) métricas econômicas + perfis (nome/telefone) em lote
      const userIds = [...new Set(cands0.map(c => c.customer_user_id))];
      const farmerIds = [...new Set(cands0.map(c => c.farmer_id).filter((x): x is string => !!x))];
      const profileIds = [...new Set([...userIds, ...farmerIds])];

      const [metrics, profiles] = await Promise.all([fetchMetrics(userIds), fetchProfiles(profileIds)]);
      const mByUser = new Map(metrics.map(m => [m.customer_user_id, m]));
      const pByUser = new Map(profiles.map(p => [p.user_id, p]));

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
          optOut: false,            // opt-in real entra no PR2b (whatsapp_conversations.opt_in_status)
          contatadoHaDias: null,    // cadência ao vivo via route_contact_log entra no PR2c
          fechouHoje: false,
          janela24hAberta: false,
          margemNegativaConhecida: false,
        };
      });

      const result = buildContactList(candidates, cfg);
      const enrich = (s: ScoredCandidate): RouteContactItem => {
        const p = pByUser.get(s.customerUserId);
        const farmer = s.farmerId ? pByUser.get(s.farmerId) : undefined;
        return {
          ...s,
          name: p?.razao_social || p?.name || s.customerUserId,
          phone: p?.phone ?? null,
          farmerName: farmer?.name ?? farmer?.razao_social ?? null,
        };
      };

      return {
        callQueue: result.callQueue.map(enrich),
        whatsappQueue: result.whatsappQueue.map(enrich),
        excluidos: result.excluidos,
        routeDate: prep.routeDate,
        dailyOnly: prep.dailyOnly,
        cidades: prep.cities.map(c => c.city),
      };
    },
  });
}
