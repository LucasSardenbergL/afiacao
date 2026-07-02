import { useQuery } from '@tanstack/react-query';
import { format, subDays, subMonths } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';

/**
 * UTI de Contas — triagem de clientes críticos por 3 sinais independentes
 * (inspirado na "UTI de lojas" do turnaround da Pernambucanas).
 *
 * Critérios DETERMINÍSTICOS e visíveis na UI (nada de "score mágico"):
 *   1. Churn      — churn_risk ≥ 70 OU health_class = 'critico' (farmer_client_scores)
 *   2. Inadimplência — saldo em aberto vencido há 31+ dias > 0 (fin_contas_receber,
 *      casado por CNPJ/documento do profile — normalizado só-dígitos)
 *   3. Positivação — elegível e SEM pedido nos 2 meses mais recentes com snapshot
 *      (carteira_positivacao_snapshot)
 *
 * Entrada na UTI: ≥ 2 sinais ativos. 1 sinal: "em observação". Alta: 0 sinais.
 *
 * Money-path (ausente ≠ zero): sinal sem dado na fonte fica `null` ("sem dado"),
 * nunca vira `false` fabricado — cliente sem CNPJ no profile não ganha "adimplente"
 * de graça, e positivação com menos de 2 meses elegíveis de histórico não conclui nada.
 */

export type SinalUti = boolean | null;

export const UTI_CRITERIOS = {
  churnRiskMin: 70,
  diasVencidoMin: 31,
  mesesSemPedidoMin: 2,
  sinaisParaEntrar: 2,
} as const;

export interface UtiConta {
  customerUserId: string;
  farmerId: string;
  nome: string;
  documento: string | null;
  churnRisk: number | null;
  healthClass: string | null;
  diasSemComprar: number | null;
  /** R$ em aberto vencido há 31+ dias (0 quando sinal indisponível). */
  vencido31: number;
  /** Meses recentes elegíveis sem pedido (0–3; null = histórico insuficiente). */
  mesesSemPedido: number | null;
  sinalChurn: SinalUti;
  sinalInadimplencia: SinalUti;
  sinalPositivacao: SinalUti;
  sinaisAtivos: number;
  status: 'uti' | 'observacao';
}

export interface UtiFrescor {
  /** Último recálculo dos scores de carteira. */
  scoresCalculatedAt: string | null;
  /** Último sync de contas a receber concluído (fin_sync_log, status 'complete'). */
  receberSyncAt: string | null;
  /** Mês mais recente com snapshot de positivação (YYYY-MM-DD). */
  positivacaoMes: string | null;
}

export interface UtiContasResult {
  contas: UtiConta[];
  frescor: UtiFrescor;
}

const PAGE = 1000;

/** Pagina além da capa silenciosa de 1.000 linhas do PostgREST (ordem estável obrigatória). */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const normDoc = (d: string | null | undefined): string | null => {
  const clean = (d ?? '').replace(/\D/g, '');
  return clean.length >= 11 ? clean : null;
};

export interface ScoreRow {
  customer_user_id: string;
  farmer_id: string;
  health_score: number | null;
  health_class: string | null;
  priority_score: number | null;
  churn_risk: number | null;
  days_since_last_purchase: number | null;
  calculated_at: string | null;
}

export interface ProfileRow {
  user_id: string;
  name: string;
  razao_social: string | null;
  document: string | null;
  cnpj: string | null;
}

export interface TituloRow {
  cnpj_cpf: string | null;
  saldo: number | null;
}

export interface SnapshotRow {
  customer_user_id: string;
  mes: string;
  eligible: boolean;
  had_order_in_month: boolean;
}

/**
 * Cômputo puro dos sinais e do status UTI/observação (testável sem Supabase).
 * `titulos` já deve vir filtrado (em aberto + vencido 31+ + saldo > 0 — o filtro é do query).
 */
export function montarContasUti(input: {
  scores: ScoreRow[];
  perfis: ProfileRow[];
  titulos: TituloRow[];
  snapshots: SnapshotRow[];
}): { contas: UtiConta[]; scoresCalculatedAt: string | null; positivacaoMes: string | null } {
  // Dedup do spine: um cliente pode ter score por mais de um farmer — fica o de maior prioridade.
  const porCliente = new Map<string, ScoreRow>();
  for (const s of input.scores) {
    const atual = porCliente.get(s.customer_user_id);
    if (!atual || (s.priority_score ?? 0) > (atual.priority_score ?? 0)) porCliente.set(s.customer_user_id, s);
  }

  const perfis = new Map<string, ProfileRow>();
  for (const p of input.perfis) perfis.set(p.user_id, p);

  // Vencido 31+ por documento normalizado (soma across empresas — exposição do grupo).
  const vencidoPorDoc = new Map<string, number>();
  for (const t of input.titulos) {
    const doc = normDoc(t.cnpj_cpf);
    if (!doc) continue;
    vencidoPorDoc.set(doc, (vencidoPorDoc.get(doc) ?? 0) + Number(t.saldo ?? 0));
  }

  // Snapshots por cliente, do mês mais recente pro mais antigo.
  const snapsPorCliente = new Map<string, SnapshotRow[]>();
  let positivacaoMes: string | null = null;
  for (const s of input.snapshots) {
    const list = snapsPorCliente.get(s.customer_user_id) ?? [];
    list.push(s);
    snapsPorCliente.set(s.customer_user_id, list);
    if (!positivacaoMes || s.mes > positivacaoMes) positivacaoMes = s.mes;
  }

  let scoresCalculatedAt: string | null = null;
  const contas: UtiConta[] = [];

  for (const [customerUserId, score] of porCliente) {
    if (score.calculated_at && (!scoresCalculatedAt || score.calculated_at > scoresCalculatedAt)) {
      scoresCalculatedAt = score.calculated_at;
    }

    const sinalChurn: SinalUti =
      score.churn_risk == null && score.health_class == null
        ? null
        : (score.churn_risk ?? 0) >= UTI_CRITERIOS.churnRiskMin || score.health_class === 'critico';

    const perfil = perfis.get(customerUserId);
    const doc = normDoc(perfil?.document) ?? normDoc(perfil?.cnpj);
    const vencido31 = doc ? (vencidoPorDoc.get(doc) ?? 0) : 0;
    const sinalInadimplencia: SinalUti = doc ? vencido31 > 0 : null;

    const snaps = (snapsPorCliente.get(customerUserId) ?? [])
      .filter((s) => s.eligible)
      .sort((a, b) => (a.mes < b.mes ? 1 : -1));
    let sinalPositivacao: SinalUti = null;
    let mesesSemPedido: number | null = null;
    if (snaps.length >= UTI_CRITERIOS.mesesSemPedidoMin) {
      mesesSemPedido = 0;
      for (const s of snaps) {
        if (s.had_order_in_month) break;
        mesesSemPedido += 1;
      }
      sinalPositivacao = mesesSemPedido >= UTI_CRITERIOS.mesesSemPedidoMin;
    }

    const sinaisAtivos = [sinalChurn, sinalInadimplencia, sinalPositivacao].filter((s) => s === true).length;
    if (sinaisAtivos === 0) continue;

    contas.push({
      customerUserId,
      farmerId: score.farmer_id,
      nome: perfil?.razao_social || perfil?.name || 'Cliente sem perfil',
      documento: doc,
      churnRisk: score.churn_risk,
      healthClass: score.health_class,
      diasSemComprar: score.days_since_last_purchase,
      vencido31,
      mesesSemPedido,
      sinalChurn,
      sinalInadimplencia,
      sinalPositivacao,
      sinaisAtivos,
      status: sinaisAtivos >= UTI_CRITERIOS.sinaisParaEntrar ? 'uti' : 'observacao',
    });
  }

  contas.sort((a, b) => b.sinaisAtivos - a.sinaisAtivos || b.vencido31 - a.vencido31 || (b.churnRisk ?? 0) - (a.churnRisk ?? 0));
  return { contas, scoresCalculatedAt, positivacaoMes };
}

export function useUtiContas(enabled: boolean) {
  return useQuery({
    queryKey: ['uti-contas'],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<UtiContasResult> => {
      const hoje = new Date();
      const corteVencido = format(subDays(hoje, UTI_CRITERIOS.diasVencidoMin), 'yyyy-MM-dd');
      const cortePositivacao = format(subMonths(hoje, 3), 'yyyy-MM-01');

      const [scores, titulos, snapshots, syncRes] = await Promise.all([
        fetchAll<ScoreRow>((from, to) =>
          supabase
            .from('farmer_client_scores')
            .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, days_since_last_purchase, calculated_at')
            .order('customer_user_id', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        ),
        fetchAll<TituloRow>((from, to) =>
          supabase
            .from('fin_contas_receber')
            .select('cnpj_cpf, saldo')
            .in('status_titulo', [...OPEN_TITLE_STATUSES])
            .lt('data_vencimento', corteVencido)
            .gt('saldo', 0)
            .order('id', { ascending: true })
            .range(from, to),
        ),
        fetchAll<SnapshotRow>((from, to) =>
          supabase
            .from('carteira_positivacao_snapshot')
            .select('customer_user_id, mes, eligible, had_order_in_month')
            .gte('mes', cortePositivacao)
            .order('id', { ascending: true })
            .range(from, to),
        ),
        supabase
          .from('fin_sync_log')
          .select('completed_at')
          .in('action', ['sync_contas_receber', 'sync_all'])
          .eq('status', 'complete')
          .order('completed_at', { ascending: false })
          .limit(1),
      ]);
      if (syncRes.error) throw new Error(syncRes.error.message);

      const ids = [...new Set(scores.map((s) => s.customer_user_id))];
      const profileChunks = await Promise.all(
        chunk(ids, 150).map((c) =>
          supabase.from('profiles').select('user_id, name, razao_social, document, cnpj').in('user_id', c),
        ),
      );
      const perfis: ProfileRow[] = [];
      for (const res of profileChunks) {
        if (res.error) throw new Error(res.error.message);
        perfis.push(...((res.data ?? []) as ProfileRow[]));
      }

      const { contas, scoresCalculatedAt, positivacaoMes } = montarContasUti({ scores, perfis, titulos, snapshots });

      return {
        contas,
        frescor: {
          scoresCalculatedAt,
          receberSyncAt: (syncRes.data?.[0]?.completed_at as string | null) ?? null,
          positivacaoMes,
        },
      };
    },
  });
}
