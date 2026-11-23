// DFC realizado (método direto) — lê `v_fin_fluxo_caixa_realizado` (master-only DENTRO da view;
// security_invoker). Erro de leitura LANÇA (react-query expõe `error`) — nunca vira demonstrativo vazio.
// Paginação canônica (`fetchAllPages`): o PostgREST capa em 1.000 linhas em silêncio.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { montarDFC, type DFC, type LinhaViewDFC } from '@/lib/financeiro/dfc-helpers';

// A view é nova e ainda não está no `types.ts` gerado: cliente mínimo, só com o que a consulta usa.
interface ConsultaView extends PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> {
  select(cols: string): ConsultaView;
  in(col: string, vs: string[]): ConsultaView;
  gte(col: string, v: string): ConsultaView;
  lte(col: string, v: string): ConsultaView;
  order(col: string, o: { ascending: boolean }): ConsultaView;
  range(de: number, ate: number): ConsultaView;
}
const db = supabase as unknown as { from(view: string): ConsultaView };

/** Número do banco → número. Coluna numérica NULL aqui seria defeito da view (SUM de linhas > 0). */
function num(v: unknown, onde: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`DFC: valor inválido em ${onde}`);
  return n;
}

export function normalizarLinhaDFC(r: Record<string, unknown>): LinhaViewDFC {
  const onde = `${String(r.company)}/${String(r.mes)}/${String(r.fluxo_linha)}`;
  return {
    company: String(r.company),
    mes: String(r.mes).slice(0, 10),
    fluxo_linha: String(r.fluxo_linha),
    atividade: String(r.atividade),
    entradas: num(r.entradas, onde),
    saidas: num(r.saidas, onde),
    liquido: num(r.liquido, onde),
    lancamentos: num(r.lancamentos, onde),
  };
}

export function useFinanceiroDFC(companies: string[], meses: string[]) {
  const de = meses[0];
  const ate = meses[meses.length - 1];
  return useQuery({
    queryKey: ['financeiro', 'dfc', [...companies].sort().join(','), de, ate],
    enabled: companies.length > 0 && meses.length > 0,
    queryFn: async (): Promise<DFC> => {
      const linhas = await fetchAllPages(
        (i, f) =>
          db.from('v_fin_fluxo_caixa_realizado')
            .select('company, mes, fluxo_linha, atividade, entradas, saidas, liquido, lancamentos')
            .in('company', companies)
            .gte('mes', de)
            .lte('mes', ate)
            .order('company', { ascending: true })
            .order('mes', { ascending: true })
            .order('fluxo_linha', { ascending: true })
            .range(i, f),
        'v_fin_fluxo_caixa_realizado',
      );
      return montarDFC(linhas.map(normalizarLinhaDFC), meses);
    },
  });
}
