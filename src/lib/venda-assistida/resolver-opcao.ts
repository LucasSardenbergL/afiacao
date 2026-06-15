import {
  precoLitroPreparado,
  type EmbalagemPreco,
  type PrecoPreparado,
} from './preco-preparado';
import type { EstadoVenda } from './resolver-estado';

/**
 * Resolve estado + preço COERENTES de uma opção de venda assistida — Fatia 1/2.
 *
 * Fecha o **P0.2 do Codex**: preço e disponibilidade têm que vir das MESMAS embalagens. O preço de
 * SELLABLE_NOW é calculado SÓ sobre embalagens EM ESTOQUE — então "em estoque agora" nunca mostra o
 * R$/L de uma embalagem indisponível. Sem isso, uma embalagem grande barata sem estoque dava o preço
 * e uma pequena cara em estoque dava o "em estoque" → preço incoerente.
 */

export interface EmbalagemComEstoque extends EmbalagemPreco {
  /** Saldo indicativo (cache ~10min — não é promessa dura). */
  estoque: number;
}

export interface ResolverOpcaoInput {
  /** Existe vínculo boletim↔SKU confirmado pra a base (casamento). */
  temSkuConfirmado: boolean;
  /** O boletim tem catalisador (catalisador_codigo presente)? */
  temCatalisador: boolean;
  /** catalisador_proporcao_pct do boletim. */
  proporcaoPct: number | null;
  /** Embalagens da base (preço-do-cliente + litros + estoque). */
  baseEmbalagens: EmbalagemComEstoque[];
  /** Embalagens do catalisador; **[] quando o catalisador não está mapeado** (sem casamento). */
  catalisadorEmbalagens: EmbalagemComEstoque[];
}

export interface OpcaoResolvida {
  estado: EstadoVenda;
  preco: PrecoPreparado;
}

const emEstoque = (e: EmbalagemComEstoque): boolean =>
  Number.isFinite(e.estoque) && e.estoque > 0;

export function resolverOpcaoVenda(input: ResolverOpcaoInput): OpcaoResolvida {
  // Sem casamento → não há produto vendável; só alternativa técnica.
  if (!input.temSkuConfirmado) {
    return { estado: 'TECHNICAL_ONLY', preco: { status: 'incomplete', motivo: 'sem vínculo boletim↔SKU' } };
  }

  const catalisadorParam = (embs: EmbalagemComEstoque[]): EmbalagemComEstoque[] | null =>
    input.temCatalisador ? embs : null;

  // SELLABLE_NOW: o preço tem que FECHAR sobre embalagens EM ESTOQUE (preço == disponibilidade).
  // Se o motor retorna 'ok' sobre o conjunto em-estoque, então a base (e o catalisador obrigatório)
  // estão em estoque E precificados — coerente por construção.
  const precoEmEstoque = precoLitroPreparado({
    baseEmbalagens: input.baseEmbalagens.filter(emEstoque),
    temCatalisador: input.temCatalisador,
    catalisadorEmbalagens: catalisadorParam(input.catalisadorEmbalagens.filter(emEstoque)),
    proporcaoPct: input.proporcaoPct,
  });
  if (precoEmEstoque.status === 'ok') {
    return { estado: 'SELLABLE_NOW', preco: precoEmEstoque };
  }

  // ORDERABLE: estimativa de ENCOMENDA pela maior embalagem geral (pode ser 'ok' ou "sob consulta").
  const precoEncomenda = precoLitroPreparado({
    baseEmbalagens: input.baseEmbalagens,
    temCatalisador: input.temCatalisador,
    catalisadorEmbalagens: catalisadorParam(input.catalisadorEmbalagens),
    proporcaoPct: input.proporcaoPct,
  });
  return { estado: 'ORDERABLE', preco: precoEncomenda };
}
