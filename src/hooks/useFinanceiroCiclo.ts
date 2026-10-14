// Leituras da aba "Ciclo" (master-only). Fatos das views v_ciclo_*; regra no helper puro.
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
          supabase.from('v_ciclo_cliente_resumo' as never).select('*')
            .order('company', { ascending: true })
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: ResumoClienteRow[] | null; error: unknown }>,
        'v_ciclo_cliente_resumo',
      );
      return linhas.map(normalizarResumo);
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
      const { data, error } = await supabase.from('v_ciclo_empresa_coorte' as never).select('*')
        .order('company', { ascending: true }).order('mes_vencimento', { ascending: true });
      if (error) throw error;
      // `?? 0` seguro: a view usa coalesce(…, 0) nestas 3 colunas (zero REAL de soma); error já lançou.
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
        company: r.company as Company,
        mes: String(r.mes_vencimento),
        valorVencido: num(r.valor_vencido_no_mes) ?? 0,
        valorPago: num(r.valor_pago) ?? 0,
        valorEmAberto: num(r.valor_em_aberto) ?? 0,
        pctValorPago: num(r.pct_valor_pago),
        prazoConcedido: num(r.prazo_concedido_pond),
        prazoReal: num(r.prazo_real_pond_pagas),
        atraso: num(r.atraso_pond_pagas),
        mesParcial: r.mes_parcial === true,
      }));
    },
  });
}

/** Receita por competência TTM (12 meses fechados) / 365, por empresa. Sem linha → null. */
export function useReceitaDiariaTtm() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'receita-ttm'],
    queryFn: async (): Promise<Record<Company, number | null>> => {
      const hoje = hojeSp();
      const [a, m] = hoje.split('-').map(Number);
      const fimExclusivo = a * 100 + m; // mês corrente (excluído)
      const inicio = (a - 1) * 100 + m; // mesmo mês do ano anterior (incluído)
      const linhas = await fetchAllPages<Record<string, unknown>>(
        (de, ate) =>
          supabase.from('fin_dre_competencia_base' as never).select('company, ano, mes, categoria_codigo, valor_total')
            .eq('origem', 'CR')
            .order('company', { ascending: true }).order('ano', { ascending: true })
            .order('mes', { ascending: true }).order('categoria_codigo', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
        'fin_dre_competencia_base/ciclo-ttm',
      );
      const soma: Record<Company, number | null> = { oben: null, colacor: null, colacor_sc: null };
      for (const l of linhas) {
        const ano = num(l.ano);
        const mes = num(l.mes);
        if (ano === null || mes === null) continue;
        const ym = ano * 100 + mes;
        if (ym < inicio || ym >= fimExclusivo) continue;
        const c = l.company as Company;
        const v = num(l.valor_total);
        if (!ALL_COMPANIES.includes(c) || v === null) continue;
        soma[c] = (soma[c] ?? 0) + v;
      }
      const out = { ...soma };
      for (const c of ALL_COMPANIES) out[c] = soma[c] === null ? null : (soma[c] as number) / 365;
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
          supabase.from('v_ciclo_cr_titulos' as never).select('*')
            .eq('company', company as string).eq('omie_codigo_cliente', cliente as number)
            .order('data_vencimento', { ascending: false })
            .order('omie_codigo_lancamento', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
        'v_ciclo_cr_titulos/cliente',
      );
      // `valor`/`prazoConcedido` ?? 0 seguros: a view filtra valor_documento>0 finito e datas NOT NULL.
      return linhas.map((r) => ({
        lancamento: num(r.omie_codigo_lancamento) ?? -1,
        documento: typeof r.numero_documento === 'string' ? r.numero_documento : null,
        emissao: String(r.data_emissao), vencimento: String(r.data_vencimento),
        baixa: typeof r.data_baixa === 'string' ? r.data_baixa : null,
        valor: num(r.valor_documento) ?? 0, saldo: num(r.saldo), situacao: String(r.situacao),
        prazoConcedido: num(r.prazo_concedido_dias) ?? 0,
        prazoReal: num(r.prazo_real_dias), atraso: num(r.atraso_dias), diasVencido: num(r.dias_vencido),
      }));
    },
  });
}
