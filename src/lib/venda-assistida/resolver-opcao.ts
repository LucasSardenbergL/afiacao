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
  /** Saldo indicativo (cache ~10min — não é promessa dura). `null` = não informado (≠ 0). */
  estoque: number | null;
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
  typeof e.estoque === 'number' && Number.isFinite(e.estoque) && e.estoque > 0;

/** Pode estar em estoque: saldo > 0 OU saldo não informado (ausente ≠ zero). */
const talvezEmEstoque = (e: EmbalagemComEstoque): boolean =>
  e.estoque === null || emEstoque(e);

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
  // STOCK_UNKNOWN (follow-up do #4087): o preço FECHARIA se as embalagens de saldo NÃO informado
  // estivessem disponíveis → não dá para dizer "Encomenda" (nem "Em estoque"): estado neutro. O preço
  // exibido é o MESMO da encomenda (só o rótulo muda — nada de preço novo). Se nem assim fecha, a
  // falta é REAL (saldo informado ≤ 0) → ORDERABLE.
  const fechariaComSaldoDesconhecido = precoLitroPreparado({
    baseEmbalagens: input.baseEmbalagens.filter(talvezEmEstoque),
    temCatalisador: input.temCatalisador,
    catalisadorEmbalagens: catalisadorParam(input.catalisadorEmbalagens.filter(talvezEmEstoque)),
    proporcaoPct: input.proporcaoPct,
  }).status === 'ok';
  if (fechariaComSaldoDesconhecido) return { estado: 'STOCK_UNKNOWN', preco: precoEncomenda };
  return { estado: 'ORDERABLE', preco: precoEncomenda };
}
