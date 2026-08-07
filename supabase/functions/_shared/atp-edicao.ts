// ATP fase 2 — guard PURO da edição (alterar_pedido): detecta AUMENTO de
// exposição Oben (quantidade maior por SKU, ou SKU novo) comparando os itens
// NOVOS do payload com os itens ATUAIS da linha sales_orders.
//
// Fase 2 bloqueia o aumento (sem override na edição — a válvula é criar um
// pedido novo pelo balcão, onde reserva/backorder existem); reservar o DELTA
// é desenho da fase 3 (parecer Codex 2026-08-06). Redução/remoção passa.

export interface ItemQuantidade {
  omie_codigo_produto?: number | string | null;
  quantidade?: number | string | null;
}

export interface DeltaAumento {
  omie_codigo_produto: number;
  quantidade_atual: number;
  quantidade_nova: number;
}

export interface ResultadoDeltaEdicao {
  /** true quando algum SKU aumentou ou entrou SKU novo (exposição Oben cresceu) */
  aumentou: boolean;
  aumentos: DeltaAumento[];
  /** itens ilegíveis (sku/qtd não-numéricos ou ≤0) em qualquer lado — nunca
   *  entram na soma (qtd ilegível não fabrica base de comparação) */
  ilegiveis: number;
}

function somarPorSku(itens: ItemQuantidade[]): { mapa: Map<number, number>; ilegiveis: number } {
  const mapa = new Map<number, number>();
  let ilegiveis = 0;
  for (const item of itens) {
    const sku = Number(item?.omie_codigo_produto);
    const qtd = Number(item?.quantidade);
    if (!Number.isFinite(sku) || sku <= 0 || !Number.isFinite(qtd) || qtd <= 0) {
      ilegiveis++;
      continue;
    }
    mapa.set(sku, (mapa.get(sku) ?? 0) + qtd);
  }
  return { mapa, ilegiveis };
}

export function deltaEdicaoOben(
  itensAtuais: ItemQuantidade[] | null | undefined,
  itensNovos: ItemQuantidade[] | null | undefined,
): ResultadoDeltaEdicao {
  const atuais = somarPorSku(Array.isArray(itensAtuais) ? itensAtuais : []);
  const novos = somarPorSku(Array.isArray(itensNovos) ? itensNovos : []);
  const aumentos: DeltaAumento[] = [];
  for (const [sku, qtdNova] of novos.mapa) {
    const qtdAtual = atuais.mapa.get(sku) ?? 0;
    if (qtdNova > qtdAtual) {
      aumentos.push({ omie_codigo_produto: sku, quantidade_atual: qtdAtual, quantidade_nova: qtdNova });
    }
  }
  aumentos.sort((a, b) => a.omie_codigo_produto - b.omie_codigo_produto);
  return { aumentou: aumentos.length > 0, aumentos, ilegiveis: atuais.ilegiveis + novos.ilegiveis };
}
