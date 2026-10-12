// Lógica PURA da inativação de quem SUMIU do cadastro do Omie (excluído/recriado lá).
// Testes: ausentes_test.ts. I/O: index.ts (`inativarAusentes`).
//
// Por quê: o upsert do metadados só toca quem VEIO na listagem — produto excluído no Omie ficava
// `ativo=true` para sempre (4 cadastros colacor, 2026-10-02→12: 10 dias no wizard de venda e o
// check `vendas_familia_ausente` da Sentinela stale até o founder inativar à mão).
//
// A regra (mesmo desenho de _shared/zeramento-estoque.ts): a AUSÊNCIA numa listagem COMPLETA só
// DESCOBRE candidatos. A listagem paginada não é um retrato — um produto excluído no Omie entre a
// página 1 e a 2 desloca a seguinte e um produto VIVO some do conjunto sem que guarda alguma de
// tamanho perceba. A confirmação aqui é TEMPORAL: só inativa quem estiver ausente em DOIS runs
// completos consecutivos (o deslize é aleatório; pular o MESMO produto duas vezes exige outra
// exclusão no instante certo nas duas varreduras). Custo aceito: ~1 dia a mais até inativar.
//
// Precisão > recall: inativar dispara `sincronizar_ativo_omie_para_reposicao()`, que DESLIGA a
// reposição automática e NÃO a religa se o produto voltar — falso positivo é pegajoso. Qualquer
// dúvida (listagem incompleta, código inválido, run anterior velho, teto) ⇒ não inativa nada.
import { varreduraTruncada } from "../_shared/omie-paginacao.ts";
import { avaliarCompletudeListagem, type CompletudeListagem } from "../_shared/zeramento-estoque.ts";

export type { CompletudeListagem };

/** Linha dedicada (1 escritor: esta edge) que guarda os ausentes do run anterior. */
export const ENTITY_AUSENTES = "products_metadados_ausentes";

/**
 * O conjunto do run anterior só confirma se tiver entre MIN e MAX de idade. Cron diário ⇒ o par
 * válido é "ontem e hoje". O MIN barra dois retries/cliques no mesmo dia (mesma janela de deslize,
 * não é confirmação independente); o MAX barra pular um dia (run do meio abortou ou não rodou).
 * Codex no desenho (2026-10-12): duas ausências seguidas não podem ser dois retries colados.
 */
export const MIN_IDADE_ANTERIOR_MS = 6 * 60 * 60 * 1000;
export const MAX_IDADE_ANTERIOR_MS = 30 * 60 * 60 * 1000;

/**
 * Acima de max(MIN, ⌈FRACAO × ativos⌉) ausentes a listagem é suspeita: nada é inativado. Churn real
 * medido: 4 numa recriação em lote (colacor, 2227 ativos). 2%/10 dá oben 20, colacor 45.
 */
export const LIMITE_AUSENTES_MIN = 10;
export const LIMITE_AUSENTES_FRACAO = 0.02;

export function limiteAusentes(nAtivos: number): number {
  return Math.max(LIMITE_AUSENTES_MIN, Math.ceil(nAtivos * LIMITE_AUSENTES_FRACAO));
}

/** Código Omie válido: inteiro seguro positivo (bigint do banco chega como number no JSON). */
export function codigoValido(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Completude da varredura do ListarProdutos DESTE run.
 * - `tamanhos`: itens crus de cada página não-vazia, na ordem (intermediária curta = buraco; última
 *   cheia = pode haver continuação que o laço não pediu, porque `total_de_paginas` é PISO).
 * - `codigosInvalidos`: itens listados sem `codigo_produto` utilizável. Um só já invalida: a linha
 *   local dele pareceria ausente e seria inativada por um defeito de PARSE.
 * - `unicos`: códigos VÁLIDOS DISTINTOS listados. Contar itens crus deixaria uma página repetida
 *   (deslize) fechar a soma enquanto omite produtos — Codex no desenho.
 * - `totalDeclarado`: o MAIOR `total_de_registros` visto no run. OBRIGATÓRIO: sem ele não há
 *   segundo sinal contra a página repetida ⇒ incompleta. únicos < declarado ⇒ truncada.
 */
export function avaliarCompletudeCatalogo(args: {
  tamanhos: number[];
  porPagina: number;
  codigosInvalidos: number;
  unicos: number;
  totalDeclarado: number | undefined;
}): CompletudeListagem {
  const base = avaliarCompletudeListagem(args.tamanhos, args.porPagina);
  if (!base.completa) return base;
  if (args.codigosInvalidos > 0) {
    return { completa: false, motivo: `${args.codigosInvalidos} item(ns) listado(s) sem codigo_produto válido` };
  }
  const declarado = Number(args.totalDeclarado ?? 0);
  if (!Number.isFinite(declarado) || declarado <= 0) {
    return { completa: false, motivo: "total_de_registros ausente — sem segundo sinal de completude" };
  }
  if (varreduraTruncada(args.unicos, declarado)) {
    return { completa: false, motivo: `${args.unicos} códigos únicos < total_de_registros declarado ${declarado}` };
  }
  return { completa: true };
}

/** Conjunto de ausentes gravado pelo run anterior (metadata da linha dedicada). */
export interface ConjuntoAnterior {
  codigos: unknown;
  run_at: unknown;
}

export type StatusAusentes = "complete" | "incompleta" | "teto_excedido";

export interface PlanoInativacao {
  status: StatusAusentes;
  /** Ativos locais ausentes da listagem deste run (vazio se não avaliou). */
  ausentes: number[];
  /** Ausentes neste run E no anterior válido — os únicos que podem ser inativados. */
  aInativar: number[];
  /** Conjunto a gravar para o próximo run confirmar; null = invalida a confirmação seguinte. */
  conjuntoNovo: number[] | null;
  motivo: string | null;
}

/** Lê o conjunto anterior só se for bem formado e recente; qualquer dúvida ⇒ vazio. */
export function conjuntoAnteriorValido(anterior: ConjuntoAnterior | null, agoraMs: number): Set<number> {
  if (!anterior || !Array.isArray(anterior.codigos) || typeof anterior.run_at !== "string") return new Set();
  const runMs = Date.parse(anterior.run_at);
  if (!Number.isFinite(runMs)) return new Set();
  const idade = agoraMs - runMs;
  if (idade < MIN_IDADE_ANTERIOR_MS || idade > MAX_IDADE_ANTERIOR_MS) return new Set();
  const out = new Set<number>();
  for (const c of anterior.codigos) {
    const cod = codigoValido(c);
    if (cod === null) return new Set(); // conjunto corrompido não confirma ninguém
    out.add(cod);
  }
  return out;
}

export function planejarInativacao(args: {
  completude: CompletudeListagem;
  listados: ReadonlySet<number>;
  ativosLocais: ReadonlyArray<unknown>;
  anterior: ConjuntoAnterior | null;
  agoraMs: number;
}): PlanoInativacao {
  const { completude, listados, ativosLocais, anterior, agoraMs } = args;
  const nada = (status: StatusAusentes, motivo: string, ausentes: number[] = []): PlanoInativacao => ({
    status,
    ausentes,
    aInativar: [],
    conjuntoNovo: null,
    motivo,
  });

  if (!completude.completa) return nada("incompleta", completude.motivo);
  if (listados.size === 0) return nada("incompleta", "listagem vazia — ausência de tudo não é exclusão de tudo");

  const vistos = new Set<number>();
  for (const raw of ativosLocais) {
    const cod = codigoValido(raw);
    if (cod === null) continue; // linha local sem código não é candidata (não há o que comparar)
    if (!listados.has(cod)) vistos.add(cod);
  }
  const ausentes = [...vistos].sort((a, b) => a - b);

  const limite = limiteAusentes(ativosLocais.length);
  if (ausentes.length > limite) {
    return nada(
      "teto_excedido",
      `${ausentes.length} ativos ausentes passa do teto de ${limite} (${ativosLocais.length} ativos) — listagem suspeita, nada inativado`,
      ausentes,
    );
  }

  const confirmados = conjuntoAnteriorValido(anterior, agoraMs);
  const aInativar = ausentes.filter((c) => confirmados.has(c));
  return { status: "complete", ausentes, aInativar, conjuntoNovo: ausentes, motivo: null };
}
