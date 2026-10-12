import type { ProductCartItem } from '@/hooks/unifiedOrder/types';
import { csvTabelaElegivel } from '@/lib/tint/select-price';
import type { SubmitClient } from './types';

/**
 * Preflight do ORÇAMENTO para a fonte tint 'tabela' (fail-closed, 2026-10-12).
 *
 * O pedido cruza `tint_gate_revalida` no edge; o orçamento NÃO (insert direto em
 * `sales_orders`) — e é impresso/apresentado ao cliente antes da conversão. O CSV
 * legado < 50% do calculado é o preço SÓ DOS CORANTES (export sem a base): o balcão
 * novo já não o oferece, mas rascunho/carrinho montado antes da correção pode trazer
 * um item 'tabela' a centavos. Aqui revalidamos a ELEGIBILIDADE contra o estado atual
 * (CSV da canônica + motor), com a MESMA regra do gate (`csvTabelaElegivel`).
 *
 * Escopo: só a fonte 'tabela' (o buraco medido). O preço exato de cada fonte segue
 * validado no gate da conversão. Na dúvida (fórmula sem id, fora da canônica, motor
 * sem preço, erro de leitura) BLOQUEIA — reprecificar no balcão resolve.
 */

/** Pura: dado o CSV e o calculado atuais por fórmula, as cores cujo item 'tabela' não pode seguir. */
export function coresTabelaInvalida(
  itens: ProductCartItem[],
  csvPorFormula: Map<string, number | null>,
  calcPorFormula: Map<string, number | null>,
): string[] {
  const out: string[] = [];
  for (const c of itens) {
    if (c.tint_price_source !== 'tabela') continue;
    const cor = c.tint_cor_id || c.product.codigo;
    const id = c.tint_formula_id;
    if (!id || !csvPorFormula.has(id)) { out.push(cor); continue; }
    const calc = calcPorFormula.get(id) ?? null;
    // Motor sem preço também barra no gate (sem_preco_motor): nunca aceitar 'tabela' sem calc.
    if (calc == null || csvTabelaElegivel(csvPorFormula.get(id), calc) == null) out.push(cor);
  }
  return [...new Set(out)];
}

/** Devolve a mensagem de bloqueio, ou null quando nenhum item 'tabela' é inválido. */
export async function bloqueioTabelaTint(supabase: SubmitClient, itens: ProductCartItem[]): Promise<string | null> {
  const tabela = itens.filter((c) => c.tint_price_source === 'tabela');
  if (tabela.length === 0) return null;
  const ids = [...new Set(tabela.map((c) => c.tint_formula_id).filter((id): id is string => !!id))];

  const csvPorFormula = new Map<string, number | null>();
  const calcPorFormula = new Map<string, number | null>();
  try {
    if (ids.length > 0) {
      const { data, error } = await supabase
        .from('v_tint_formula_canonica')
        .select('id, preco_csv_legado')
        .in('id', ids);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.id) csvPorFormula.set(row.id, row.preco_csv_legado);
      }
      for (const id of ids) {
        const { data: preco, error: errPreco } = await supabase.rpc('get_tint_price', { p_formula_id: id });
        if (errPreco) throw errPreco;
        const precoFinal = (preco as { precoFinal?: unknown } | null)?.precoFinal;
        calcPorFormula.set(id, typeof precoFinal === 'number' ? precoFinal : null);
      }
    }
  } catch (e) {
    // PostgrestError não é instanceof Error — ler o .message direto.
    const msg = (e as { message?: string } | null)?.message ?? String(e);
    return `Não foi possível confirmar o preço de tabela das tintas (${msg}) — orçamento não salvo. Tente de novo.`;
  }

  const cores = coresTabelaInvalida(tabela, csvPorFormula, calcPorFormula);
  if (cores.length === 0) return null;
  return `Preço de tabela inválido para ${cores.join(', ')} (tabela antiga sem a base) — reprecifique a cor no balcão de tinta antes de salvar o orçamento.`;
}
