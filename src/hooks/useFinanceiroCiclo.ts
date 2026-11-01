// Leituras da aba "Ciclo" (master-only). Fatos das views v_ciclo_* lidos por RPC SECURITY DEFINER com gate
// master (fin_ciclo_*; a view sob RLS por linha estourava o statement_timeout). Regra no helper puro.
// Erro de leitura LANÇA (react-query expõe `error`) — nunca vira lista vazia.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { normalizarResumo, num, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { normalizarGiro, type GiroSku } from '@/lib/financeiro/ciclo-giro-helpers';
import { normalizarCustoCapital, type CustoCapital } from '@/lib/financeiro/ciclo-desconto-helpers';
import { filaCiclo, retryDelayCiclo } from '@/lib/financeiro/ciclo-fila';
import {
  normalizarSemanaPedidos, normalizarSemanaPrateleira, type SemanaPedidos, type SemanaPrateleira,
} from '@/lib/financeiro/ruptura-sensor-helpers';
import { ESTOQUE_ACCOUNT, cmvTtmFechado, diaSp, somarDias, type PontoEstoque } from '@/lib/financeiro/regua-ciclo-helpers';
import { somarSaldoAberto } from '@/services/financeiroService';

export function hojeSp(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

export function useCicloResumo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'resumo'],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<ResumoCliente[]> => filaCiclo(async () => {
      const linhas = await fetchAllPages(
        (de, ate) =>
          supabase.rpc('fin_ciclo_cliente_resumo').select('*')
            .order('company', { ascending: true })
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate),
        'v_ciclo_cliente_resumo',
      );
      // Linha sem omie_codigo_cliente é descartada (sem chave não há cliente; evita a chave -1 do normalizador).
      return linhas.filter((l) => num(l.omie_codigo_cliente) !== null).map(normalizarResumo);
    }),
  });
}

export type CoorteMes = {
  company: Company; mes: string; valorVencido: number; valorPago: number; valorEmAberto: number;
  pctValorPago: number | null; prazoConcedido: number | null; prazoReal: number | null; atraso: number | null; mesParcial: boolean;
};

export function useCicloCoorte() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'coorte'],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<CoorteMes[]> => filaCiclo(async () => {
      // .rpc() set-returning também é capado em 1.000 linhas pelo PostgREST → paginar sempre.
      const data = await fetchAllPages(
        (de, ate) =>
          supabase.rpc('fin_ciclo_empresa_coorte').select('*')
            .order('company', { ascending: true }).order('mes_vencimento', { ascending: true })
            .range(de, ate),
        'fin_ciclo_empresa_coorte',
      );
      // Linha com dinheiro/chave ausente é DESCARTADA (nunca default fabricado): as 3 colunas vêm de coalesce(…,0) na view.
      const out: CoorteMes[] = [];
      for (const r of data) {
        const valorVencido = num(r.valor_vencido_no_mes);
        const valorPago = num(r.valor_pago);
        const valorEmAberto = num(r.valor_em_aberto);
        if (valorVencido === null || valorPago === null || valorEmAberto === null) continue;
        out.push({
          company: r.company as Company,
          mes: String(r.mes_vencimento),
          valorVencido, valorPago, valorEmAberto,
          pctValorPago: num(r.pct_valor_pago),
          prazoConcedido: num(r.prazo_concedido_pond),
          prazoReal: num(r.prazo_real_pond_pagas),
          atraso: num(r.atraso_pond_pagas),
          mesParcial: r.mes_parcial === true,
        });
      }
      return out;
    }),
  });
}

export type ReceitaTtm = { porDia: number | null; mesesComDado: number };

/** Receita por competência TTM (12 meses cheios anteriores ao corrente) / 365, por empresa.
 *  `mesesComDado` = meses DISTINTOS da janela com valor_total não-nulo; 0 → porDia null (nunca 0). */
export function useReceitaDiariaTtm() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'receita-ttm', hojeSp().slice(0, 7)],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<Record<Company, ReceitaTtm>> => filaCiclo(async () => {
      const hoje = hojeSp();
      const [a, m] = hoje.split('-').map(Number);
      const fimExclusivo = a * 100 + m; // mês corrente (excluído)
      const inicio = (a - 1) * 100 + m; // mesmo mês do ano anterior (incluído)
      const linhas = await fetchAllPages(
        (de, ate) =>
          supabase.from('fin_dre_competencia_base').select('company, ano, mes, categoria_codigo, valor_total')
            .eq('origem', 'CR').gte('ano', a - 1)
            // chave única da view: (origem, company, ano, mes, categoria_codigo, categoria_descricao); as 2 últimas aceitam NULL
            .order('company', { ascending: true }).order('ano', { ascending: true })
            .order('mes', { ascending: true })
            .order('categoria_codigo', { ascending: true, nullsFirst: true })
            .order('categoria_descricao', { ascending: true, nullsFirst: true })
            .range(de, ate),
        'fin_dre_competencia_base/ciclo-ttm',
      );
      const soma: Record<Company, number | null> = { oben: null, colacor: null, colacor_sc: null };
      const meses: Record<Company, Set<number>> = { oben: new Set(), colacor: new Set(), colacor_sc: new Set() };
      for (const l of linhas) {
        const ano = num(l.ano);
        const mes = num(l.mes);
        if (ano === null || mes === null) continue;
        const ym = ano * 100 + mes;
        if (ym < inicio || ym >= fimExclusivo) continue;
        const c = l.company as Company;
        const v = num(l.valor_total);
        if (!ALL_COMPANIES.includes(c) || v === null) continue; // valor ausente não conta como mês com dado
        soma[c] = (soma[c] ?? 0) + v;
        meses[c].add(ym);
      }
      const out = {} as Record<Company, ReceitaTtm>;
      for (const c of ALL_COMPANIES) {
        const total = soma[c];
        out[c] = { porDia: total === null ? null : total / 365, mesesComDado: meses[c].size };
      }
      return out;
    }),
  });
}

export type TituloCliente = {
  lancamento: number; documento: string | null; emissao: string; vencimento: string; baixa: string | null;
  valor: number; saldo: number | null; situacao: string; prazoConcedido: number;
  prazoReal: number | null; atraso: number | null; diasVencido: number | null;
};

export function useCicloTitulosCliente(company: Company | null, cliente: number | null) {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'titulos', company, cliente],
    enabled: company !== null && cliente !== null,
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<TituloCliente[]> => filaCiclo(async () => {
      const linhas = await fetchAllPages(
        (de, ate) =>
          supabase.rpc('fin_ciclo_titulos_cliente', { p_company: company as string, p_cliente: cliente as number }).select('*')
            .order('data_vencimento', { ascending: false })
            .order('omie_codigo_lancamento', { ascending: true })
            .range(de, ate),
        'v_ciclo_cr_titulos/cliente',
      );
      // Título sem chave/valor/prazo concedido (a view garante, mas ausente ≠ zero) é DESCARTADO, nunca default fabricado.
      const out: TituloCliente[] = [];
      for (const r of linhas) {
        const lancamento = num(r.omie_codigo_lancamento);
        const valor = num(r.valor_documento);
        const prazoConcedido = num(r.prazo_concedido_dias);
        if (lancamento === null || valor === null || prazoConcedido === null) continue;
        out.push({
          lancamento,
          documento: typeof r.numero_documento === 'string' ? r.numero_documento : null,
          emissao: String(r.data_emissao), vencimento: String(r.data_vencimento),
          baixa: typeof r.data_baixa === 'string' ? r.data_baixa : null,
          valor, saldo: num(r.saldo), situacao: String(r.situacao), prazoConcedido,
          prazoReal: num(r.prazo_real_dias), atraso: num(r.atraso_dias), diasVencido: num(r.dias_vencido),
        });
      }
      return out;
    }),
  });
}

/** Giro de estoque por SKU (frente 3). Ordem estável = a da RPC (R$ parado desc, código) — paginação segura. */
export function useCicloGiroSku(company: Company) {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'giro-sku', company],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<GiroSku[]> => filaCiclo(async () => {
      // .rpc() set-returning é capado em 1.000 linhas (colacor tem ~1.460 SKUs com saldo) → paginar sempre.
      const linhas = await fetchAllPages(
        (de, ate) =>
          supabase.rpc('fin_ciclo_giro_sku', { p_company: company }).select('*')
            .order('valor_parado', { ascending: false, nullsFirst: false })
            .order('omie_codigo_produto', { ascending: true })
            .range(de, ate),
        'fin_ciclo_giro_sku',
      );
      return linhas.map(normalizarGiro).filter((l): l is GiroSku => l !== null);
    }),
  });
}

export type RupturaSensor = { pedidos: SemanaPedidos[]; prateleira: SemanaPrateleira[] };

/** Sensor de ruptura da Oben (migration 20261031200000): as duas views semanais, ordem estável por semana.
 *  Erro de leitura LANÇA; linha ilegível é descartada (ausente ≠ zero). Só a Oben tem o sensor. */
export function useRupturaSensor() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'ruptura-sensor'],
    retryDelay: retryDelayCiclo,
    // Cada view toma a PRÓPRIA vaga da fila (uma vaga com 2 leituras dentro furava o teto de 2 RPCs em voo —
    // o `CicloTab.carga.test` mede o pico).
    queryFn: async (): Promise<RupturaSensor> => {
      const [pedidos, prateleira] = await Promise.all([
        filaCiclo(() => fetchAllPages(
          (de, ate) =>
            supabase.from('v_reposicao_ruptura_pedidos_semana').select('*')
              .eq('empresa', 'oben').order('semana', { ascending: true }).range(de, ate),
          'v_reposicao_ruptura_pedidos_semana',
        )),
        filaCiclo(() => fetchAllPages(
          (de, ate) =>
            supabase.from('v_reposicao_ruptura_prateleira_semana').select('*')
              .eq('empresa', 'oben').order('semana', { ascending: true }).range(de, ate),
          'v_reposicao_ruptura_prateleira_semana',
        )),
      ]);
      return {
        pedidos: pedidos.map((r) => normalizarSemanaPedidos(r as Record<string, unknown>)).filter((s): s is SemanaPedidos => s !== null),
        prateleira: prateleira.map((r) => normalizarSemanaPrateleira(r as Record<string, unknown>)).filter((s): s is SemanaPrateleira => s !== null),
      };
    },
  });
}

// ── Régua honesta do card da empresa (Frente A, itens 2 e 3) ───────────────────────────────────────────
// Insumos do DSO point-in-time, do R$/dia do PME e do PME por estoque MÉDIO dos 90 d. Ausente ≠ zero em
// todos: insumo que falta vira null + motivo no helper puro (`regua-ciclo-helpers.ts`), nunca número.

export type ReguaEmpresa = {
  /** Σ CMV dos 12 meses fechados (DRE competência) — espelho do que a edge usa no PME. */
  cmvTtm: { valor: number | null; meses: number; motivo: string | null };
  /** Série diária (dia de SP) do estoque de giro gravada pelo snapshot do motor (engine v2.2+). */
  estoqueSerie: PontoEstoque[];
  /** Último sync da posição de estoque (inventory_position da conta da empresa); null = sem linha. */
  estoqueSyncEm: string | null;
  /** Cobertura de custo do estoque de giro (fin_estoque_giro_valor): % dos SKUs de giro com CMC. */
  custoCobertura: { pct: number | null; skusGiro: number | null; skusComCusto: number | null };
};

const JANELA_SERIE_DIAS = 90;

/** 4 leituras por empresa, em SÉRIE dentro de uma vaga da filaCiclo (pico de 1 leitura por vaga). */
export function useReguaCiclo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'regua', hojeSp()],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<Record<Company, ReguaEmpresa>> => filaCiclo(async () => {
      const hoje = hojeSp();
      const [anoHoje] = hoje.split('-').map(Number);
      const dre = await fetchAllPages(
        (de, ate) =>
          supabase.from('fin_dre_snapshots').select('company, ano, mes, cmv')
            .eq('regime', 'competencia').gte('ano', anoHoje - 2)
            .order('company', { ascending: true }).order('ano', { ascending: true }).order('mes', { ascending: true })
            .range(de, ate),
        'fin_dre_snapshots/ciclo-regua',
      );
      const inicioSerie = `${somarDias(hoje, -(JANELA_SERIE_DIAS - 1))}T00:00:00-03:00`; // 90 datas, hoje inclusive
      const snaps = await fetchAllPages(
        (de, ate) =>
          supabase.from('fin_projecao_snapshots').select('company, snapshot_at, estoque_valor, estoque_fonte, estoque_cobertura_ok')
            .eq('cenario', 'realista').gte('snapshot_at', inicioSerie)
            .order('snapshot_at', { ascending: true }).order('id', { ascending: true })
            .range(de, ate),
        'fin_projecao_snapshots/ciclo-regua',
      );
      const out = {} as Record<Company, ReguaEmpresa>;
      for (const c of ALL_COMPANIES) {
        const linhasDre = dre
          .filter((l) => l.company === c)
          .map((l) => ({ ano: num(l.ano) ?? -1, mes: num(l.mes) ?? -1, cmv: num(l.cmv) }))
          .filter((l) => l.ano > 0 && l.mes > 0);
        // O ÚLTIMO snapshot do dia (de SP) decide o dia — inclusive quando ele veio SEM fonte: um snapshot das 20h
        // sem estoque não pode ser "ressuscitado" pelo das 10h (Codex, 2026-10-31). Dia cujo último não tem
        // fonte/valor fica descoberto (ausente ≠ zero).
        const ultimoDoDia = new Map<string, (typeof snaps)[number]>();
        for (const r of snaps) {
          if (r.company !== c || typeof r.snapshot_at !== 'string') continue;
          ultimoDoDia.set(diaSp(r.snapshot_at), r); // snaps vêm ascendentes por (snapshot_at, id)
        }
        const serie: PontoEstoque[] = [];
        for (const [dia, r] of ultimoDoDia) {
          if (r.estoque_fonte == null) continue;
          const valor = num(r.estoque_valor);
          if (valor === null) continue;
          serie.push({ dia, valor, coberturaOk: r.estoque_cobertura_ok === true });
        }
        const sync = await supabase.from('inventory_position').select('synced_at')
          .eq('account', ESTOQUE_ACCOUNT[c]).order('synced_at', { ascending: false }).limit(1);
        if (sync.error) throw new Error(`inventory_position/${c}: ${sync.error.message}`);
        const syncEm = sync.data?.[0]?.synced_at;
        // Set-returning (1 linha agregada por empresa): paginado mesmo assim — a capa de 1.000 do PostgREST vale
        // para .rpc() e o gate exige o canônico (fetchAllPages LANÇA com telemetria na página perdida).
        const giroLinhas = await fetchAllPages(
          (de, ate) => supabase.rpc('fin_estoque_giro_valor', { p_company: c })
            .order('valor_giro', { ascending: true }).range(de, ate),
          `fin_estoque_giro_valor/${c}`,
        ).catch((e: unknown) => { throw new Error(`fin_estoque_giro_valor/${c}: ${e instanceof Error ? e.message : String(e)}`); });
        const g = giroLinhas[0];
        out[c] = {
          cmvTtm: cmvTtmFechado(linhasDre, hoje),
          estoqueSerie: serie,
          estoqueSyncEm: typeof syncEm === 'string' ? syncEm : null,
          custoCobertura: {
            pct: g ? num(g.cobertura_pct) : null, skusGiro: g ? num(g.skus_giro) : null, skusComCusto: g ? num(g.skus_giro_com_custo) : null,
          },
        };
      }
      return out;
    }),
  });
}

/** Carteira ABERTA de CR (a vencer + vencido, saldo) por empresa — a base do DSO. Lê em série numa vaga. */
export function useCrAbertoTotal() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'cr-aberto', hojeSp()],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<Record<Company, number>> => filaCiclo(async () => {
      const out = {} as Record<Company, number>;
      for (const c of ALL_COMPANIES) out[c] = await somarSaldoAberto('fin_contas_receber', c);
      return out;
    }),
  });
}

/**
 * Custo do dinheiro por empresa (Frente B, PR3): `fin_funding_inputs.custo_capital_mensal` pela RPC gateada
 * (master). Erro LANÇA; empresa sem CET vem com `custoMensal: null` — o painel mostra "—", nunca 0.
 */
export function useCicloCustoCapital() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'custo-capital'],
    retryDelay: retryDelayCiclo,
    // RPC set-returning pagina pelo canônico (3 linhas hoje, mas a capa de 1.000 do PostgREST é silenciosa).
    queryFn: (): Promise<CustoCapital[]> => filaCiclo(async () => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('fin_ciclo_custo_capital').select('*').order('company', { ascending: true }).range(de, ate),
        'fin_ciclo_custo_capital',
      );
      return linhas.map((r) => normalizarCustoCapital(r as Record<string, unknown>)).filter((c): c is CustoCapital => c !== null);
    }),
  });
}
