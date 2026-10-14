import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import type { CompanySelection } from '@/contexts/CompanyContext';
import { mesesDaJanela, type Janela } from './crescimento-comparavel';


/**
 * Receita por competência (DRE, `origem = 'CR'`) por empresa, somada nos meses da janela. Serve de
 * régua para a COBERTURA dos pedidos do app — a fonte canônica de faturamento entre as BUs
 * (docs/agent/financeiro.md). Empresa sem linha no período fica FORA do mapa (ausente ≠ zero).
 * Paginada pelo canônico (`fetchAllPagesComMensagem`) com ordem total no grão da view; lança em
 * erro ou `data: null` sem error, e a página perdida é medida pela fonte.
 */
export async function fetchReceitaCompetencia(
  selection: CompanySelection,
  janela: Janela,
): Promise<Map<string, number>> {
  const meses = mesesDaJanela(janela);
  const alvo = new Set(meses.map((m) => `${m.ano}-${m.mes}`));
  const anos = [...new Set(meses.map((m) => m.ano))];
  const nums = [...new Set(meses.map((m) => m.mes))];
  const linhas = await fetchAllPagesComMensagem(
    (de, ate) => {
      let q = supabase
        .from('fin_dre_competencia_base')
        .select('company, ano, mes, valor_total')
        .eq('origem', 'CR')
        .in('ano', anos)
        .in('mes', nums);
      if (selection !== 'all') q = q.eq('company', selection);
      return q
        .order('company', { ascending: true })
        .order('ano', { ascending: true })
        .order('mes', { ascending: true })
        .order('categoria_codigo', { ascending: true })
        .order('categoria_descricao', { ascending: true })
        .range(de, ate);
    },
    'fin_dre_competencia_base/dashboard-receita',
    'fin_dre_competencia_base (CR)',
  );
  const out = new Map<string, number>();
  for (const r of linhas) {
    // `in(ano) × in(mes)` traz o produto cartesiano; só os pares da janela contam.
    if (r.company == null || r.ano == null || r.mes == null || !alvo.has(`${r.ano}-${r.mes}`)) continue;
    out.set(r.company, (out.get(r.company) ?? 0) + (r.valor_total ?? 0));
  }
  return out;
}
