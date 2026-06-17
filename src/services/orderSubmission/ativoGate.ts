/**
 * Gate de ATIVO na fronteira de venda (oráculo puro; o edge `omie-vendas-sync` espelha esta
 * lógica inline em `assertOmieItemsAtivos` — Deno não importa de `src/`). Par do gate de PREÇO
 * do #903 (`assertOmieItemPricesValid`): produto desativado no Omie (`omie_products.ativo=false`)
 * NUNCA pode virar/alterar PV. Cobre as vias que furam o preflight de ativo do #897 (só no
 * wizard): conversão de orçamento (`SalesQuotes`, itens só com `omie_codigo_produto`) e edição.
 *
 * Semântica espelha o #894: SÓ `ativo === false` bloqueia. Ausente do espelho, `null` ou `true`
 * → liberado (a coluna tem default `true`; ausência = espelho desatualizado, NÃO evidência de
 * desativação → não bloquear venda legítima). Risco real: ~50–75% do espelho está inativo, e um
 * orçamento antigo pode carregar um produto desativado depois.
 */
export interface AtivoRow {
  omie_codigo_produto: number | string;
  ativo: boolean | null;
}

export interface ItemComCodigo {
  omie_codigo_produto?: number | string;
  descricao?: string;
}

/** Itens cujo produto está desativado no espelho (`ativo===false`), na ordem original, dedupe por
 *  código. Código não-finito é ignorado (NaN não é "desativado" — outra validação trata). */
export function itensDesativados(items: ItemComCodigo[], ativoRows: AtivoRow[]): ItemComCodigo[] {
  const inativos = new Set<number>();
  for (const r of ativoRows) {
    if (r.ativo === false) {
      const c = Number(r.omie_codigo_produto);
      if (Number.isFinite(c)) inativos.add(c);
    }
  }
  const vistos = new Set<number>();
  const out: ItemComCodigo[] = [];
  for (const it of items) {
    const cod = Number(it?.omie_codigo_produto);
    if (!Number.isFinite(cod) || vistos.has(cod)) continue;
    if (inativos.has(cod)) {
      vistos.add(cod);
      out.push(it);
    }
  }
  return out;
}

/** Mensagem pt-BR de rejeição (mesmo tom do `assertOmieItemPricesValid` do #903). */
export function itensDesativadosMessage(itens: ItemComCodigo[]): string {
  const nomes = itens
    .map((it) => it.descricao || (it.omie_codigo_produto != null ? String(it.omie_codigo_produto) : 'item sem nome'))
    .join(', ');
  return `Pedido rejeitado (produto desativado no Omie): ${nomes}. Reative o produto no Omie ou remova-o do pedido.`;
}
