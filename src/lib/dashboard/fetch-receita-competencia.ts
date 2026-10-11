import { supabase } from '@/integrations/supabase/client';
import type { CompanySelection } from '@/contexts/CompanyContext';
import { mesesDaJanela, type Janela } from './crescimento-comparavel';

const PAGE = 1000;

/**
 * Receita por competência (DRE, `origem = 'CR'`) por empresa, somada nos meses da janela. Serve de
 * régua para a COBERTURA dos pedidos do app — a fonte canônica de faturamento entre as BUs
 * (docs/agent/financeiro.md). Empresa sem linha no período fica FORA do mapa (ausente ≠ zero).
 * Paginada com ordem total no grão da view; lança em erro.
 */
export async function fetchReceitaCompetencia(
  selection: CompanySelection,
  janela: Janela,
): Promise<Map<string, number>> {
  const meses = mesesDaJanela(janela);
  const alvo = new Set(meses.map((m) => `${m.ano}-${m.mes}`));
  const anos = [...new Set(meses.map((m) => m.ano))];
  const nums = [...new Set(meses.map((m) => m.mes))];
  const out = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('fin_dre_competencia_base')
      .select('company, ano, mes, valor_total')
      .eq('origem', 'CR')
      .in('ano', anos)
      .in('mes', nums);
    if (selection !== 'all') q = q.eq('company', selection);
    const { data, error } = await q
      .order('company', { ascending: true })
      .order('ano', { ascending: true })
      .order('mes', { ascending: true })
      .order('categoria_codigo', { ascending: true })
      .order('categoria_descricao', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (data == null) throw new Error('fin_dre_competencia_base (CR): data null sem error — malformada, não é fim');
    for (const r of data) {
      // `in(ano) × in(mes)` traz o produto cartesiano; só os pares da janela contam.
      if (r.company == null || r.ano == null || r.mes == null || !alvo.has(`${r.ano}-${r.mes}`)) continue;
      out.set(r.company, (out.get(r.company) ?? 0) + (r.valor_total ?? 0));
    }
    if (data.length < PAGE) return out;
  }
}
