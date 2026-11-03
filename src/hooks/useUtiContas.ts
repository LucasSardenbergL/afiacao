import { useQuery } from '@tanstack/react-query';
import { format, subDays, subMonths } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';
import { chaveDocumentoParaBusca } from '@/lib/omie/documento-cliente';

/**
 * UTI de Contas — triagem de clientes críticos por 3 sinais independentes
 * (inspirado na "UTI de lojas" do turnaround da Pernambucanas).
 *
 * Critérios DETERMINÍSTICOS e visíveis na UI (nada de "score mágico"):
 *   1. Churn      — churn_risk ≥ 70 OU health_class = 'critico' (farmer_client_scores)
 *   2. Inadimplência — saldo em aberto vencido há 31+ dias > 0 (fin_contas_receber,
 *      casado por (empresa, código Omie do cliente) → user via omie_customer_account_map,
 *      com o alias fiscal dobrado no canônico — o `cnpj_cpf` do título vem '' do Omie)
 *   3. Positivação — elegível e SEM pedido nos 2 meses mais recentes com snapshot
 *      (carteira_positivacao_snapshot)
 *
 * Entrada na UTI: ≥ 2 sinais ativos. 1 sinal: "em observação". Alta: 0 sinais.
 *
 * Money-path (ausente ≠ zero): sinal sem dado na fonte fica `null` ("sem dado"),
 * nunca vira `false` fabricado — título vencido sem dono unívoco suspende o "adimplente"
 * de todo mundo (pode ser de qualquer um), e positivação com menos de 2 meses elegíveis
 * de histórico não conclui nada. Histórico: docs/historico/uti-inadimplencia-por-codigo-omie.md
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
  /**
   * R$ em aberto vencido há 31+ dias. `null` = desconhecido (há título sem dono unívoco e
   * nada foi atribuído a este cliente). Com título sem dono, o valor positivo é PISO.
   */
  vencido31: number | null;
  /** Meses recentes elegíveis sem pedido (0–3; null = histórico insuficiente). */
  mesesSemPedido: number | null;
  sinalChurn: SinalUti;
  sinalInadimplencia: SinalUti;
  sinalPositivacao: SinalUti;
  sinaisAtivos: number;
  status: 'uti' | 'observacao';
}

interface UtiFrescor {
  /** Último recálculo dos scores de carteira. */
  scoresCalculatedAt: string | null;
  /** Último sync de contas a receber concluído (fin_sync_log, status 'complete'). */
  receberSyncAt: string | null;
  /** Mês mais recente com snapshot de positivação (YYYY-MM-DD). */
  positivacaoMes: string | null;
  /** Títulos vencidos 31+ que não casaram com UM cliente (sem vínculo ou ambíguo). */
  recebiveisSemCliente: RecebiveisSemCliente;
}

export interface RecebiveisSemCliente {
  titulos: number;
  saldo: number;
}

export interface UtiContasResult {
  contas: UtiConta[];
  frescor: UtiFrescor;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// CNPJ alfanumérico (RFB jul/2026): `chaveDocumentoParaBusca` é o `replace(/\D/g,'') + >= 11` de antes para o
// numérico e preserva as letras do válido (o inválido cai nos dígitos e segue sem chave).
// Só para EXIBIR o documento do profile — a dívida casa por código Omie, não por documento.
const normDoc = (d: string | null | undefined): string | null => {
  return chaveDocumentoParaBusca(d);
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
  company: string;
  omie_codigo_cliente: number | null;
  saldo: number | null;
}

/**
 * Cadastro Omie → user, lido da view `omie_customer_account_map_fresco` (vínculo tocado pelo sync
 * nos últimos 7 dias; UNIQUE (omie_codigo_cliente, account) na tabela). Vínculo velho = órfão.
 */
export interface VinculoRow {
  account: string | null;
  omie_codigo_cliente: number | null;
  user_id: string | null;
}

/**
 * customer_canonical_alias: o 2º cadastro Omie LEGÍTIMO do mesmo cliente do grupo
 * (docs/agent/database.md §5). `active` dobra no canônico; `conflict` = identidade ambígua.
 */
export interface AliasRow {
  alias_user_id: string;
  canonical_user_id: string;
  status: string;
}

/**
 * Resolve o dono de cada título vencido: (empresa, código Omie) → user → canônico.
 * Título sem código, sem vínculo, com mais de um dono ou dono em alias `conflict` não é
 * atribuído a ninguém — vai para `semCliente`, nunca para um cliente "provável".
 */
export function atribuirVencidos(input: {
  titulos: TituloRow[];
  vinculos: VinculoRow[];
  aliases: AliasRow[];
}): { vencidoPorCliente: Map<string, number>; semCliente: RecebiveisSemCliente; canonico: (userId: string) => string | null } {
  const donosPorCadastro = new Map<string, Set<string>>();
  for (const v of input.vinculos) {
    // Coluna de view é anulável no tipo: vínculo incompleto não prova dono (o título fica órfão).
    if (v.account == null || v.omie_codigo_cliente == null || v.user_id == null) continue;
    const chave = `${v.account}:${v.omie_codigo_cliente}`;
    const donos = donosPorCadastro.get(chave) ?? new Set<string>();
    donos.add(v.user_id);
    donosPorCadastro.set(chave, donos);
  }

  const aliasPorUser = new Map<string, AliasRow>();
  for (const a of input.aliases) aliasPorUser.set(a.alias_user_id, a);
  // null = identidade ambígua: alias em conflito, ou cadeia/ciclo (canônico que também é alias
  // vivo — o carteira-rebuild aborta nesse caso). Não dá para dizer de quem é a dívida.
  const aliasVivo = (userId: string) => {
    const a = aliasPorUser.get(userId);
    return a && a.status !== 'inactive' ? a : null;
  };
  const canonico = (userId: string): string | null => {
    const a = aliasVivo(userId);
    if (!a) return userId;
    if (a.status !== 'active' || aliasVivo(a.canonical_user_id)) return null;
    return a.canonical_user_id;
  };

  const vencidoPorCliente = new Map<string, number>();
  const semCliente: RecebiveisSemCliente = { titulos: 0, saldo: 0 };
  for (const t of input.titulos) {
    const saldo = t.saldo == null ? NaN : Number(t.saldo);
    const donos =
      t.omie_codigo_cliente == null ? undefined : donosPorCadastro.get(`${t.company}:${t.omie_codigo_cliente}`);
    const resolvidos = new Set([...(donos ?? [])].map(canonico));
    const dono = resolvidos.size === 1 ? [...resolvidos][0] : null;
    if (dono == null || !Number.isFinite(saldo)) {
      semCliente.titulos += 1;
      if (Number.isFinite(saldo)) semCliente.saldo += saldo;
      continue;
    }
    vencidoPorCliente.set(dono, (vencidoPorCliente.get(dono) ?? 0) + saldo);
  }
  return { vencidoPorCliente, semCliente, canonico };
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
  vinculos: VinculoRow[];
  aliases: AliasRow[];
  snapshots: SnapshotRow[];
}): {
  contas: UtiConta[];
  scoresCalculatedAt: string | null;
  positivacaoMes: string | null;
  recebiveisSemCliente: RecebiveisSemCliente;
} {
  // Vencido 31+ por cliente canônico (soma across empresas — exposição do grupo).
  const { vencidoPorCliente, semCliente, canonico } = atribuirVencidos(input);
  const atribuicaoCompleta = semCliente.titulos === 0;

  // Dedup do spine: UMA linha por identidade resolvida (alias fiscal ativo → canônico). Fica a
  // linha do próprio canônico; sem ela, a de maior prioridade (vale também entre farmers). O
  // cadastro-clone não tem compra própria (churn 100 é artefato do B-lite, não sinal), e duas
  // linhas da mesma identidade somariam a mesma dívida duas vezes na exposição.
  const porCliente = new Map<string, ScoreRow>();
  for (const s of input.scores) {
    const identidade = canonico(s.customer_user_id) ?? s.customer_user_id;
    const ehCanonico = (r: ScoreRow) => r.customer_user_id === identidade;
    const atual = porCliente.get(identidade);
    if (
      !atual ||
      (ehCanonico(s) && !ehCanonico(atual)) ||
      (ehCanonico(s) === ehCanonico(atual) && (s.priority_score ?? 0) > (atual.priority_score ?? 0))
    ) {
      porCliente.set(identidade, s);
    }
  }

  const perfis = new Map<string, ProfileRow>();
  for (const p of input.perfis) perfis.set(p.user_id, p);

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

  for (const score of porCliente.values()) {
    const customerUserId = score.customer_user_id;
    if (score.calculated_at && (!scoresCalculatedAt || score.calculated_at > scoresCalculatedAt)) {
      scoresCalculatedAt = score.calculated_at;
    }

    const sinalChurn: SinalUti =
      score.churn_risk == null && score.health_class == null
        ? null
        : (score.churn_risk ?? 0) >= UTI_CRITERIOS.churnRiskMin || score.health_class === 'critico';

    const perfil = perfis.get(customerUserId);
    const doc = normDoc(perfil?.document) ?? normDoc(perfil?.cnpj);
    // Dívida atribuída > 0 é fato (piso). Zero só é "adimplente" se TODO título vencido teve
    // dono unívoco — um órfão pode ser deste cliente. Alias em conflito: desconhecido.
    const dono = canonico(customerUserId);
    const atribuido = dono == null ? 0 : (vencidoPorCliente.get(dono) ?? 0);
    const conhecido = dono != null && (atribuido > 0 || atribuicaoCompleta);
    const vencido31 = conhecido ? atribuido : null;
    const sinalInadimplencia: SinalUti = conhecido ? atribuido > 0 : null;

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

  contas.sort(
    (a, b) =>
      b.sinaisAtivos - a.sinaisAtivos || (b.vencido31 ?? 0) - (a.vencido31 ?? 0) || (b.churnRisk ?? 0) - (a.churnRisk ?? 0),
  );
  return { contas, scoresCalculatedAt, positivacaoMes, recebiveisSemCliente: semCliente };
}

/** Leitura da UTI (o `queryFn`), exportada para ser provada contra um fake que filtra. */
export async function lerUtiContas(): Promise<UtiContasResult> {
  const hoje = new Date();
  // Vencido há 31+ dias: vencimento <= hoje-31 (o `lt` de antes exigia 32+).
  const corteVencido = format(subDays(hoje, UTI_CRITERIOS.diasVencidoMin), 'yyyy-MM-dd');
  const cortePositivacao = format(subMonths(hoje, 3), 'yyyy-MM-01');

  // Paginam pelo canônico (ordem estável obrigatória): página perdida LANÇA — truncaria
  // scores/títulos/snapshots da UTI — e é medida pela fonte.
  const [scores, titulos, aliases, snapshots, syncRes] = await Promise.all([
    fetchAllPagesComMensagem<ScoreRow>((from, to) =>
      supabase
        .from('farmer_client_scores')
        .select('customer_user_id, farmer_id, health_score, health_class, priority_score, churn_risk, days_since_last_purchase, calculated_at')
        .order('customer_user_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'farmer_client_scores/uti', 'farmer_client_scores'),
    fetchAllPagesComMensagem<TituloRow>((from, to) =>
      supabase
        .from('fin_contas_receber')
        .select('company, omie_codigo_cliente, saldo')
        .in('status_titulo', [...OPEN_TITLE_STATUSES])
        .lte('data_vencimento', corteVencido)
        .gt('saldo', 0)
        .order('id', { ascending: true })
        .range(from, to),
    'fin_contas_receber/uti-vencidos', 'fin_contas_receber'),
    // Todos os status: `conflict` também importa (identidade ambígua → desconhecido).
    fetchAllPagesComMensagem<AliasRow>((from, to) =>
      supabase
        .from('customer_canonical_alias')
        .select('alias_user_id, canonical_user_id, status')
        .order('alias_user_id', { ascending: true })
        .range(from, to),
    'customer_canonical_alias/uti', 'customer_canonical_alias'),
    fetchAllPagesComMensagem<SnapshotRow>((from, to) =>
      supabase
        .from('carteira_positivacao_snapshot')
        .select('customer_user_id, mes, eligible, had_order_in_month')
        .gte('mes', cortePositivacao)
        .order('id', { ascending: true })
        .range(from, to),
    'carteira_positivacao_snapshot/uti', 'carteira_positivacao_snapshot'),
    supabase
      .from('fin_sync_log')
      .select('completed_at')
      .in('action', ['sync_contas_receber', 'sync_all'])
      .eq('status', 'complete')
      .order('completed_at', { ascending: false })
      .limit(1),
  ]);
  if (syncRes.error) throw new Error(syncRes.error.message);

  // Vínculos só dos códigos com título vencido (≤ 3 contas por código → bem abaixo da capa).
  const codigos = [...new Set(titulos.map((t) => t.omie_codigo_cliente).filter((c): c is number => c != null))];
  const vinculoChunks = await Promise.all(
    chunk(codigos, 150).map((c, i) =>
      fetchAllPagesComMensagem<VinculoRow>((from, to) =>
        supabase
          .from('omie_customer_account_map_fresco')
          .select('account, omie_codigo_cliente, user_id')
          .in('omie_codigo_cliente', c)
          .order('id', { ascending: true })
          .range(from, to),
      `omie_customer_account_map_fresco/uti-${i}`, 'omie_customer_account_map_fresco'),
    ),
  );
  const vinculos = vinculoChunks.flat();

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

  const { contas, scoresCalculatedAt, positivacaoMes, recebiveisSemCliente } = montarContasUti({
    scores,
    perfis,
    titulos,
    vinculos,
    aliases,
    snapshots,
  });

  return {
    contas,
    frescor: {
      scoresCalculatedAt,
      receberSyncAt: (syncRes.data?.[0]?.completed_at as string | null) ?? null,
      positivacaoMes,
      recebiveisSemCliente,
    },
  };
}

export function useUtiContas(enabled: boolean) {
  return useQuery({
    queryKey: ['uti-contas'],
    enabled,
    staleTime: 60_000,
    queryFn: lerUtiContas,
  });
}
