// Leituras da aba "Ciclo" (master-only). Fatos das views v_ciclo_* lidos por RPC SECURITY DEFINER com gate
// master (fin_ciclo_*; a view sob RLS por linha estourava o statement_timeout). Regra no helper puro.
// Erro de leitura LANÇA (react-query expõe `error`) — nunca vira lista vazia.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { normalizarResumo, num, type ResumoCliente, type ResumoClienteRow } from '@/lib/financeiro/ciclo-cliente-helpers';
import { ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';

export function hojeSp(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

export function useCicloResumo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'resumo'],
    queryFn: async (): Promise<ResumoCliente[]> => {
      const linhas = await fetchAllPages<ResumoClienteRow>(
        (de, ate) =>
          supabase.rpc('fin_ciclo_cliente_resumo').select('*')
            .order('company', { ascending: true })
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ResumoClienteRow[] | null; error: unknown }>,
        'v_ciclo_cliente_resumo',
      );
      // Linha sem omie_codigo_cliente é descartada (sem chave não há cliente; evita a chave -1 do normalizador).
      return linhas.filter((l) => num(l.omie_codigo_cliente) !== null).map(normalizarResumo);
    },
  });
}

export type CoorteMes = {
  company: Company; mes: string; valorVencido: number; valorPago: number; valorEmAberto: number;
  pctValorPago: number | null; prazoConcedido: number | null; prazoReal: number | null; atraso: number | null; mesParcial: boolean;
};

export function useCicloCoorte() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'coorte'],
    queryFn: async (): Promise<CoorteMes[]> => {
      // .rpc() set-returning também é capado em 1.000 linhas pelo PostgREST → paginar sempre.
      const data = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.rpc('fin_ciclo_empresa_coorte').select('*')
            .order('company', { ascending: true }).order('mes_vencimento', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
        'fin_ciclo_empresa_coorte',
      );
      // Linha com dinheiro/chave ausente é DESCARTADA (nunca default fabricado): as 3 colunas vêm de coalesce(…,0) na view.
      const out: CoorteMes[] = [];
      for (const r of (data ?? []) as unknown as Record<string, unknown>[]) {
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
    },
  });
}

export type ReceitaTtm = { porDia: number | null; mesesComDado: number };

/** Receita por competência TTM (12 meses cheios anteriores ao corrente) / 365, por empresa.
 *  `mesesComDado` = meses DISTINTOS da janela com valor_total não-nulo; 0 → porDia null (nunca 0). */
export function useReceitaDiariaTtm() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'receita-ttm', hojeSp().slice(0, 7)],
    queryFn: async (): Promise<Record<Company, ReceitaTtm>> => {
      const hoje = hojeSp();
      const [a, m] = hoje.split('-').map(Number);
      const fimExclusivo = a * 100 + m; // mês corrente (excluído)
      const inicio = (a - 1) * 100 + m; // mesmo mês do ano anterior (incluído)
      const linhas = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.from('fin_dre_competencia_base').select('company, ano, mes, categoria_codigo, valor_total')
            .eq('origem', 'CR').gte('ano', a - 1)
            // chave única da view: (origem, company, ano, mes, categoria_codigo, categoria_descricao); as 2 últimas aceitam NULL
            .order('company', { ascending: true }).order('ano', { ascending: true })
            .order('mes', { ascending: true })
            .order('categoria_codigo', { ascending: true, nullsFirst: true })
            .order('categoria_descricao', { ascending: true, nullsFirst: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
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
    },
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
    queryFn: async (): Promise<TituloCliente[]> => {
      const linhas = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.rpc('fin_ciclo_titulos_cliente', { p_company: company as string, p_cliente: cliente as number }).select('*')
            .order('data_vencimento', { ascending: false })
            .order('omie_codigo_lancamento', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
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
    },
  });
}
