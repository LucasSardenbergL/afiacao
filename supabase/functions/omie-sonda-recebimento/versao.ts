// Marcador de versão da edge `omie-sonda-recebimento`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Sonda de DIAGNÓSTICO da reposição: lê, read-only, o contrato nativo do recebimento no Omie (NF↔PO). Não escreve nem no Omie nem no banco.
// Ficou sem sonda até 2026-10-14: sem ela, nenhum deploy desta edge tinha prova de estar no ar.
//
// O gate `authorizeCronOrStaff` já aceita `x-cron-secret`: a sonda vem depois dele e antes da primeira chamada ao Omie.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("omie-sonda-recebimento");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-sensor-inicial";

/** Efeito citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge chama o Omie (consultas de recebimento de NF, até 10 por disparo) na app_key da conta — chamada repetida do mesmo método arrisca o bloqueio REDUNDANT, que derruba os syncs vizinhos";
