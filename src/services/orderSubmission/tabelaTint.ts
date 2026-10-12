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
 * Escopo: só a fonte 'tabela' (o buraco medido) — elegibilidade E valor: o
 * `unit_price` tem de bater com round2(ceil10(CSV) × (1 − desconto/100)), a mesma
 * conta do ramo 'tabela' do gate (tolerância 0,005). As demais fontes seguem
 * validadas só no gate da conversão. Na dúvida (fórmula sem id, fora da canônica —
 * inclusive id antigo de fórmula recanonizada, que o gate aceitaria com warning —,
 * motor sem preço, desconto inválido, erro de leitura) BLOQUEIA: reprecificar no
 * balcão resolve.
 */

const ceil10 = (v: number) => Math.ceil(v * 10) / 10;
const round2 = (v: number) => Math.floor(v * 100 + 0.5) / 100;

/** Valor esperado do item 'tabela' (espelho do gate), ou null se o desconto é inválido. */
function esperadoTabela(csv: number, descontoPct: unknown): number | null {
  const d = descontoPct == null ? 0 : descontoPct;
  if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d >= 100) return null;
  return round2(ceil10(csv) * (1 - d / 100));
}

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
    const csv = calc == null ? null : csvTabelaElegivel(csvPorFormula.get(id), calc);
    if (csv == null) { out.push(cor); continue; }
    // Valor: rótulo elegível não basta — o preço salvo tem de SER o da tabela (Codex P1).
    const esperado = esperadoTabela(csv, c.tint_discount_pct);
    if (esperado == null || !(Math.abs(c.unit_price - esperado) <= 0.005)) out.push(cor);
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
  return `Preço de tabela inválido para ${cores.join(', ')} (tabela antiga sem a base, ou valor diferente da tabela) — reprecifique a cor no balcão de tinta antes de salvar o orçamento.`;
}
