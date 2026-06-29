import { keyDeSku, type CurrentSpec } from '@/lib/knowledge-base/spec-link';
import { montarBaseEmbalagens, type ProdutoLinhaOmie } from './montar-embalagens';
import { resolverOpcaoVenda, type OpcaoResolvida } from './resolver-opcao';

/**
 * Selo "preparado" por produto no wizard — Fatia 2 v1 da venda assistida.
 *
 * Resolve a opção de venda (estado + preço) de CADA boletim presente e espalha o
 * resultado pra cada SKU do boletim, devolvendo `Map<keyDeSku, OpcaoResolvida>` —
 * pronto pro lookup por produto no ProductItemForm (igual ao `specsByKey` da ficha).
 *
 * PURO/testável. Reusa o catálogo já carregado pelo wizard (sem query nova).
 * **v1:** catalisador sem casamento → `catalisadorEmbalagens: []` → o motor degrada
 * honesto a "sob consulta" (nunca fabrica preço).
 */

export type SeloTone = 'success' | 'warning' | 'muted';

export interface SeloDescricao {
  estadoLabel: string;
  estadoTone: SeloTone;
  /** false → preço "sob consulta" (motor devolveu incomplete). */
  temPreco: boolean;
  valorLitro: number | null;
}

export function montarSelosVendaAssistida(
  specs: CurrentSpec[],
  catalogByKey: Map<string, ProdutoLinhaOmie>,
  /** Preço-do-cliente (último praticado) POR CONTA: account (minúsculo) → omie_codigo_produto → preço. */
  customerPricesByAccount: Record<string, Record<number, number>>,
): Map<string, OpcaoResolvida> {
  // Agrupa os SKUs vinculados por boletim (kb_product_spec_id).
  const porBoletim = new Map<string, CurrentSpec[]>();
  for (const s of specs ?? []) {
    const arr = porBoletim.get(s.kb_product_spec_id);
    if (arr) arr.push(s);
    else porBoletim.set(s.kb_product_spec_id, [s]);
  }

  const selos = new Map<string, OpcaoResolvida>();
  for (const boletimSpecs of porBoletim.values()) {
    const ref = boletimSpecs[0];
    if (!ref) continue;

    // Embalagens da base = linhas do catálogo dos SKUs vinculados (ignora SKU fora do catálogo).
    // Preço-do-cliente POR CONTA: omie_codigo_produto colide entre Oben e Colacor (Omie accounts
    // separados) → nunca achatar num Record só; lê do mapa da conta de CADA SKU.
    const rows: ProdutoLinhaOmie[] = [];
    const pricesForBoletim: Record<number, number> = {};
    for (const s of boletimSpecs) {
      const row = catalogByKey.get(keyDeSku(s.account, s.omie_codigo_produto));
      if (!row) continue;
      rows.push(row);
      const p = customerPricesByAccount[(s.account ?? '').toLowerCase()]?.[s.omie_codigo_produto];
      if (typeof p === 'number') pricesForBoletim[s.omie_codigo_produto] = p;
    }
    // Boletim sem nenhuma embalagem conhecida → não emite selo (não polui com "sob consulta"
    // quando o problema é só dado de catálogo ausente, não falta de mapeamento).
    if (rows.length === 0) continue;

    const baseEmbalagens = montarBaseEmbalagens(rows, pricesForBoletim);
    const cod = ref.catalisador_codigo;
    const temCatalisador = typeof cod === 'string' && cod.trim() !== '';

    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true, // a view v_omie_product_current_spec é confirmed+approved
      temCatalisador,
      proporcaoPct: ref.catalisador_proporcao_pct,
      baseEmbalagens,
      catalisadorEmbalagens: [], // v1 — casamento do catalisador é fatia própria
    });

    for (const s of boletimSpecs) {
      selos.set(keyDeSku(s.account, s.omie_codigo_produto), opcao);
    }
  }
  return selos;
}

/** Descreve o selo (rótulo + tom + preço) de uma opção resolvida. Puro, sem formatação de moeda. */
export function descreverSelo(opcao: OpcaoResolvida): SeloDescricao {
  const estadoLabel =
    opcao.estado === 'SELLABLE_NOW'
      ? 'Em estoque'
      : opcao.estado === 'ORDERABLE'
        ? 'Encomenda'
        : 'Alternativa técnica';
  const estadoTone: SeloTone =
    opcao.estado === 'SELLABLE_NOW'
      ? 'success'
      : opcao.estado === 'ORDERABLE'
        ? 'warning'
        : 'muted';
  return {
    estadoLabel,
    estadoTone,
    temPreco: opcao.preco.status === 'ok',
    valorLitro: opcao.preco.status === 'ok' ? opcao.preco.valorLitroPreparado : null,
  };
}
