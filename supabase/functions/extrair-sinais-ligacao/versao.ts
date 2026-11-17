// Marcador de versão da edge `extrair-sinais-ligacao`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: paga uma chamada ao LLM (Anthropic) e grava a análise de sinais da ligação em
// `farmer_calls.sinais_ligacao` com service-role — gravação que, com `status='extraido'`, enfileira
// o recálculo de score do cliente. Entrou no mapa no lote 5 do rescan do scanner Lovable Security
// (2026-11-17), junto com o gate de dono (`_shared/dono-pela-rls.ts`): sem `versao.ts`, o deploy
// desse conserto não seria julgável pelo `pendencias:deploy` (gate `sonda:nova`).
//
// Sondar o bundle ANTERIOR a este marcador é BARATO: `{"probe":true}` não traz `callId` nem
// `transcript` e cai no 400 "callId e transcript obrigatórios", antes do LLM e de qualquer escrita.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("extrair-sinais-ligacao");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-dono-pela-rls";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge paga uma chamada ao LLM e grava a análise de sinais da ligação em farmer_calls com service-role, o que enfileira recálculo de score do cliente";
