// Leitura de `omie_products.estoque` nas edges — ausente ≠ zero.
//
// Desde o #4087 (`omie-vendas-sync` v1.45) o estoque de um produto pode ficar `null`: quando o Omie
// não manda `nSaldo`, a edge deixa de gravar 0 e o produto fica sem ser tocado. Os leitores das
// edges convertiam esse `null` em 0 (`?? 0`, `|| 0`) e, com isso:
//   · `recommend` descartava o produto como "sem estoque";
//   · `analyze-unified-order` dizia à IA "Estoque:0" e tratava a conta como a de MENOR estoque.
// Este módulo é o único lugar onde essas edges interpretam a coluna. Testes:
// `estoque-desconhecido_test.ts`.

import { numeroExplicito } from "./pos-estoque.ts";

/** Estoque como número conhecido, ou `null` quando desconhecido (nunca 0 fabricado). */
export function lerEstoque(v: unknown): number | null {
  return numeroExplicito(v);
}

export type ClasseEstoque = "positivo" | "desconhecido" | "zero";

/** `zero` cobre o zero REAL e o saldo negativo: os dois significam "sem saldo disponível". */
export function classificarEstoque(v: unknown): ClasseEstoque {
  const n = lerEstoque(v);
  if (n === null) return "desconhecido";
  return n > 0 ? "positivo" : "zero";
}

/** Só o saldo SABIDAMENTE ≤ 0 tira o produto da recomendação. Desconhecido continua candidato. */
export function semSaldoConhecido(v: unknown): boolean {
  return classificarEstoque(v) === "zero";
}

/** Trecho do catálogo enviado à IA: o número quando conhecido, "estoque desconhecido" quando não. */
export function rotuloEstoquePrompt(v: unknown): string {
  const n = lerEstoque(v);
  return n === null ? "estoque desconhecido" : `Estoque:${n}`;
}

/** Rótulo curto para log/notas do item ("est: …"). */
export function rotuloEstoqueCurto(v: unknown): string {
  const n = lerEstoque(v);
  return n === null ? "desconhecido" : String(n);
}

const PRIORIDADE: Record<ClasseEstoque, number> = { positivo: 0, desconhecido: 1, zero: 2 };

/**
 * Escolha de conta entre o produto que a IA escolheu (`atual`) e o equivalente na outra conta.
 *
 * Regra (o `null` não vence nem perde como se fosse 0):
 *   1. saldo conhecido > 0 primeiro — é o único que garante que há o que vender;
 *   2. desconhecido depois — pode ter saldo, mas não dá para afirmar;
 *   3. zero real (ou negativo) por último — sabidamente sem saldo.
 * Entre duas contas com saldo conhecido > 0 vale a regra antiga: a de MENOR saldo (esvazia o lote
 * menor primeiro). Empate em qualquer nível mantém a escolha da IA.
 */
export function escolherContaPorEstoque(atual: unknown, outra: unknown): "atual" | "outra" {
  const ca = classificarEstoque(atual);
  const co = classificarEstoque(outra);
  if (PRIORIDADE[co] !== PRIORIDADE[ca]) return PRIORIDADE[co] < PRIORIDADE[ca] ? "outra" : "atual";
  if (ca === "positivo") return (lerEstoque(outra) as number) < (lerEstoque(atual) as number) ? "outra" : "atual";
  return "atual";
}
