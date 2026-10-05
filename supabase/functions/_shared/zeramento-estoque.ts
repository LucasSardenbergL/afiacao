// Lógica PURA do "zero com dono" dos espelhos de estoque (inventory_position.saldo e
// omie_products.estoque) — compartilhada pelos dois writers periódicos de posição: o
// omie-analytics-sync (syncInventory: vendas, colacor_vendas, servicos) e o sync-reprocess
// (reprocessInventory: oben). Testes: zeramento-estoque_test.ts. I/O: zeramento-estoque-io.ts.
// Diário: docs/historico/estoque-dono-unico.md.
//
// Por quê: o ListarPosEstoque padrão (cExibeTodos "N") só lista saldo ≠ 0 — quem esgota SAI da
// lista e nenhum writer de posição gravava o zero (posições congeladas por meses, lidas sem filtro
// de frescor pelo motor de compra: a WP07 ficou sem sugestão desde 27/08 com estoque 0 no Omie).
//
// A regra: a AUSÊNCIA numa listagem completa só DESCOBRE candidatos; o zero é autorizado por uma
// CONFIRMAÇÃO explícita (cExibeTodos "S" + lista_produtos) que devolve o saldo 0 do próprio
// produto. A listagem paginada não é um retrato — um produto que esgota entre a página 1 e a 2
// desloca a seguinte, e um POSITIVO some do conjunto sem que guarda alguma de tamanho perceba
// (contraexemplo do Codex no desenho, 2026-10-05). Na confirmação, ausente ≠ zero: código que não
// volta com saldo explícito fica desconhecido e não é tocado.
import { codigoExplicito, numeroExplicito } from "./pos-estoque.ts";
import { buildProductIdMap } from "./product-idmap.ts";

/**
 * Acima de max(MIN, ⌈FRACAO × listados⌉) candidatos a listagem é suspeita: nada é confirmado. Abaixo
 * dele TODOS são confirmados — sem teto por rodada: com o zero confirmado, um teto não protege de
 * zero falso (o positivo zerado por engano volta na listagem principal da rodada seguinte), e um
 * teto "N mais velhos" deixaria os eternamente-desconhecidos (produto inativo/excluído no Omie)
 * ocupando as vagas toda rodada. É guarda de custo, não de correção.
 */
const LIMITE_ANOMALIA_MIN = 50;
const LIMITE_ANOMALIA_FRACAO = 0.25;
/** Códigos por lote de confirmação. A resposta é PAGINADA (um produto tem uma entrada por local). */
export const CONFIRMACAO_POR_CHAMADA = 50;
/** Páginas por lote de confirmação; lote que não termina nelas fica inteiro desconhecido. */
export const MAX_PAGINAS_CONFIRMACAO = 5;

// Os rótulos de inventory_position que espelham a MESMA conta Omie (mesmas credenciais, mesma data,
// mesmo escopo): o omie-analytics-sync grava `vendas`/`colacor_vendas`, o sync-reprocess `oben`/`colacor`.
// Uma confirmação vale para todos — senão o zero de um espelho fica escondido na eleição por synced_at
// do motor e do ATP enquanto o outro, congelado e mais recente, não for corrigido.
const ESPELHOS: Readonly<Record<string, readonly string[]>> = {
  vendas: ["vendas", "oben"],
  oben: ["oben", "vendas"],
  colacor_vendas: ["colacor_vendas", "colacor"],
  colacor: ["colacor", "colacor_vendas"],
};

export function espelhosDaMesmaConta(account: string): string[] {
  return [...(ESPELHOS[account] ?? [account])];
}

export type CompletudeListagem = { completa: true } | { completa: false; motivo: string };

export interface LinhaPosicaoLocal {
  /** Rótulo de inventory_position (vendas, oben, colacor_vendas, servicos). */
  account: string;
  omie_codigo_produto: number | string | null;
  saldo: unknown;
  cmc: unknown;
  preco_medio: unknown;
  synced_at: string | null;
}

export interface LinhaEstoqueLocal {
  id: string | null;
  omie_codigo_produto: number | string | null;
  estoque: unknown;
  /** Versão da linha para o CAS (o trigger BEFORE UPDATE a avança em toda escrita). */
  updated_at: string | null;
}

export type Confirmacao =
  | { tipo: "zero"; cmc: number | null; precoMedio: number | null }
  | { tipo: "nao_zero" }
  | { tipo: "desconhecido"; motivo: string };

export interface PlanoCandidatos {
  aConfirmar: number[];
  /** Todos os candidatos descobertos — iguais a `aConfirmar` salvo quando a rodada é pulada. */
  candidatos: number;
  /** Motivo de NADA ter sido confirmado nesta rodada; null quando a confirmação segue. */
  pulado: string | null;
}

export interface AtualizacaoPosicao {
  account: string;
  omie_codigo_produto: number;
  casSyncedAt: string | null;
  set: { saldo: 0; cmc?: number; preco_medio?: number; synced_at?: string };
}

export interface AtualizacaoEstoque {
  id: string;
  omie_codigo_produto: number;
  casUpdatedAt: string;
  set: { estoque: 0 };
}

const codigoValido = codigoExplicito;

// `tamanhos` = itens CRUS de cada página não-vazia, na ordem. Página intermediária curta é buraco;
// última página CHEIA é evidência de continuação (o total declarado pode ter subestimado).
export function avaliarCompletudeListagem(tamanhos: number[], porPagina: number): CompletudeListagem {
  if (tamanhos.length === 0) return { completa: false, motivo: "nenhuma página lida" };
  for (let i = 0; i < tamanhos.length - 1; i++) {
    if (tamanhos[i] < porPagina) {
      return { completa: false, motivo: `página ${i + 1} veio com ${tamanhos[i]} de ${porPagina} antes da última` };
    }
  }
  if (tamanhos[tamanhos.length - 1] >= porPagina) {
    return { completa: false, motivo: `última página cheia (${porPagina}) — pode haver continuação` };
  }
  return { completa: true };
}

export function limiteAnomalia(nListados: number): number {
  return Math.max(LIMITE_ANOMALIA_MIN, Math.ceil(nListados * LIMITE_ANOMALIA_FRACAO));
}

// Candidatos = posição local (desta conta) com saldo ≠ 0 explícito OU estoque de catálogo (desta
// empresa, código resolvido sem ambiguidade) ≠ 0, cujo código NÃO veio na listagem. As posições
// vão primeiro, da mais velha para a mais nova (ordem determinística do lote de confirmação).
export function planejarCandidatos(args: {
  listados: ReadonlySet<number>;
  completude: CompletudeListagem;
  posicoesLocais: LinhaPosicaoLocal[];
  estoqueLocal: LinhaEstoqueLocal[];
}): PlanoCandidatos {
  const { listados, completude, posicoesLocais, estoqueLocal } = args;
  const porPosicao: Array<{ cod: number; synced: string }> = [];
  const vistos = new Set<number>();
  for (const l of posicoesLocais) {
    const cod = codigoValido(l.omie_codigo_produto);
    const saldo = numeroExplicito(l.saldo);
    if (cod === null || saldo === null || saldo === 0 || listados.has(cod) || vistos.has(cod)) continue;
    vistos.add(cod);
    porPosicao.push({ cod, synced: l.synced_at ?? "" }); // "" ordena antes de qualquer ISO: sem data = mais velho
  }
  porPosicao.sort((a, b) => (a.synced < b.synced ? -1 : a.synced > b.synced ? 1 : a.cod - b.cod));

  const idByCod = buildProductIdMap(estoqueLocal);
  const porEstoque: number[] = [];
  for (const l of estoqueLocal) {
    const cod = codigoValido(l.omie_codigo_produto);
    if (cod === null || l.id == null || idByCod.get(cod) !== String(l.id)) continue; // ambíguo ou perdedora
    const estoque = numeroExplicito(l.estoque);
    if (estoque === null || estoque === 0 || listados.has(cod) || vistos.has(cod)) continue;
    vistos.add(cod);
    porEstoque.push(cod);
  }
  porEstoque.sort((a, b) => a - b);

  const uniao = [...porPosicao.map((p) => p.cod), ...porEstoque];
  const candidatos = uniao.length;
  if (listados.size === 0) {
    return { aConfirmar: [], candidatos, pulado: "snapshot de posição vazio — ausência de tudo não é zero de tudo" };
  }
  if (!completude.completa) return { aConfirmar: [], candidatos, pulado: `listagem incompleta: ${completude.motivo}` };
  const limite = limiteAnomalia(listados.size);
  if (candidatos > limite) {
    return {
      aConfirmar: [],
      candidatos,
      pulado: `${candidatos} candidatos passa do limite de anomalia de ${limite} — listagem suspeita, nada confirmado`,
    };
  }
  return { aConfirmar: uniao, candidatos, pulado: null };
}

// Um pedido por lote de CONFIRMACAO_POR_CHAMADA códigos, na MESMA data de posição da listagem.
export function montarPedidosConfirmacao(codigos: number[], dataPosicao: string): Array<Record<string, unknown>> {
  const pedidos: Array<Record<string, unknown>> = [];
  for (let i = 0; i < codigos.length; i += CONFIRMACAO_POR_CHAMADA) {
    pedidos.push({
      nPagina: 1,
      nRegPorPagina: 100,
      dDataPosicao: dataPosicao,
      cExibeTodos: "S",
      lista_produtos: codigos.slice(i, i + CONFIRMACAO_POR_CHAMADA).map((c) => ({ nCodProd: c })),
    });
  }
  return pedidos;
}

// Veredito por código PEDIDO a partir dos itens devolvidos (todas as chamadas juntas). Zero só com
// TODAS as entradas do código (uma por local) em saldo 0 explícito. Um item de código ilegível pode
// ser o 2º local de qualquer pedido — com ele na resposta, nenhum zero vale. Código não pedido é
// "estranho" (o filtro não foi honrado): conta, mas não decide nada.
// `incompletos` = códigos de lote cuja paginação não terminou: as entradas que vieram não são todas.
export function interpretarConfirmacao(
  pedidos: number[],
  itens: unknown[],
  incompletos: ReadonlySet<number> = new Set(),
): { porCodigo: Map<number, Confirmacao>; estranhos: number } {
  const pedidosSet = new Set(pedidos);
  const entradas = new Map<number, Array<{ saldo: number | null; cmc: number | null; pm: number | null }>>();
  let ilegiveis = 0;
  let estranhos = 0;
  for (const it of itens) {
    const reg = (it ?? {}) as Record<string, unknown>;
    const cod = typeof it === "object" && it !== null ? codigoValido(reg.nCodProd) : null;
    if (cod === null) {
      ilegiveis++;
      continue;
    }
    if (!pedidosSet.has(cod)) {
      estranhos++;
      continue;
    }
    const lista = entradas.get(cod) ?? [];
    lista.push({ saldo: numeroExplicito(reg.nSaldo), cmc: numeroExplicito(reg.nCMC), pm: numeroExplicito(reg.nPrecoMedio) });
    entradas.set(cod, lista);
  }

  const porCodigo = new Map<number, Confirmacao>();
  for (const cod of pedidosSet) {
    if (incompletos.has(cod)) {
      porCodigo.set(cod, { tipo: "desconhecido", motivo: "confirmação incompleta (a paginação do lote não terminou)" });
      continue;
    }
    const lista = entradas.get(cod);
    if (!lista || lista.length === 0) {
      porCodigo.set(cod, { tipo: "desconhecido", motivo: "ausente da resposta de confirmação" });
      continue;
    }
    if (lista.some((e) => e.saldo === null)) {
      porCodigo.set(cod, { tipo: "desconhecido", motivo: "saldo não explícito na confirmação" });
      continue;
    }
    if (lista.some((e) => e.saldo !== 0)) {
      porCodigo.set(cod, { tipo: "nao_zero" });
      continue;
    }
    if (ilegiveis > 0) {
      porCodigo.set(cod, { tipo: "desconhecido", motivo: `${ilegiveis} item(ns) ilegível(is) na resposta de confirmação` });
      continue;
    }
    const cmc0 = lista[0].cmc;
    const cmc = cmc0 !== null && cmc0 > 0 && lista.every((e) => e.cmc === cmc0) ? cmc0 : null;
    const pm0 = lista[0].pm;
    const precoMedio = pm0 !== null && pm0 >= 0 && lista.every((e) => e.pm === pm0) ? pm0 : null;
    porCodigo.set(cod, { tipo: "zero", cmc, precoMedio });
  }
  return { porCodigo, estranhos };
}

// O que escrever para cada zero confirmado, com o CAS da VERSÃO lida (synced_at da posição,
// updated_at do catálogo): o UPDATE só pega se ninguém escreveu a linha depois da leitura. Versão,
// não valor — igualdade numérica via número JS recusaria para sempre um numeric com mais casas. Posição: só o saldo, sempre; o synced_at avança só se a confirmação
// trouxe um cmc utilizável — ele é o frescor do CUSTO para quem lê o cmc (get_defasagem_cliente
// recusa cmc com mais de 48 h), e um zero inferido sem custo não pode rejuvenescer custo velho.
// cmc/preco_medio entram no SET só se MUDARAM (UPDATE OF cmc dispara o ledger mesmo com valor igual).
export function planejarEscritaConfirmada(args: {
  posicoesLocais: LinhaPosicaoLocal[];
  estoqueLocal: LinhaEstoqueLocal[];
  confirmacoes: Map<number, Confirmacao>;
  nowIso: string;
}): { posicoes: AtualizacaoPosicao[]; estoque: AtualizacaoEstoque[] } {
  const { posicoesLocais, estoqueLocal, confirmacoes, nowIso } = args;
  const posicoes: AtualizacaoPosicao[] = [];
  const vistosPos = new Set<string>();
  for (const l of posicoesLocais) {
    const cod = codigoValido(l.omie_codigo_produto);
    const saldo = numeroExplicito(l.saldo);
    const chave = `${l.account}:${cod}`;
    if (cod === null || saldo === null || saldo === 0 || vistosPos.has(chave)) continue;
    const conf = confirmacoes.get(cod);
    if (conf?.tipo !== "zero") continue;
    vistosPos.add(chave);
    const set: AtualizacaoPosicao["set"] = { saldo: 0 };
    if (conf.cmc !== null) {
      if (conf.cmc !== numeroExplicito(l.cmc)) set.cmc = conf.cmc;
      if (conf.precoMedio !== null && conf.precoMedio !== numeroExplicito(l.preco_medio)) set.preco_medio = conf.precoMedio;
      set.synced_at = nowIso;
    }
    posicoes.push({ account: l.account, omie_codigo_produto: cod, casSyncedAt: l.synced_at ?? null, set });
  }

  const idByCod = buildProductIdMap(estoqueLocal);
  const estoque: AtualizacaoEstoque[] = [];
  const vistosEst = new Set<number>();
  for (const l of estoqueLocal) {
    const cod = codigoValido(l.omie_codigo_produto);
    if (cod === null || l.id == null || idByCod.get(cod) !== String(l.id) || vistosEst.has(cod)) continue;
    const valor = numeroExplicito(l.estoque);
    // Sem updated_at não há versão para o CAS: fora (nunca UPDATE cego).
    if (valor === null || valor === 0 || l.updated_at == null || confirmacoes.get(cod)?.tipo !== "zero") continue;
    vistosEst.add(cod);
    estoque.push({ id: String(l.id), omie_codigo_produto: cod, casUpdatedAt: l.updated_at, set: { estoque: 0 } });
  }
  return { posicoes, estoque };
}
