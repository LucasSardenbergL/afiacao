// Marcador de versão da edge `fin-suggest-mapping`.
// Classificador da sonda (money-path, compartilhado): `_shared/sonda-versao.ts`.
//
// Sugere o mapeamento de categorias Omie → linha da DRE. Leitura pura: não escreve.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar
// (plano de melhorias 2026-09-05, §0.4 Lote C — as 4 do financeiro de leitura).
//
// O gate desta edge já é `authorizeCronOrStaff` (cópia inline do `_shared/auth.ts`), que aceita o
// `x-cron-secret`: a sonda vem DEPOIS dele, sem gate próprio. O front chama por GET com query
// string; a sonda é um POST com corpo, então o fluxo real não muda.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("fin-suggest-mapping");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.1-gate-auth-canonico";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge lê as categorias e os lançamentos do mês para sugerir o mapeamento da DRE; não escreve, mas a sugestão orienta a classificação contábil";
