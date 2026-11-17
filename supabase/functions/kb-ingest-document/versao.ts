// Marcador de versão da edge `kb-ingest-document`.
// Classificador da sonda (compartilhado): `_shared/sonda-versao.ts`.
//
// Efeito desta edge: baixa o PDF do documento, paga embedding na OpenAI, insere `kb_chunks` e grava
// `kb_documents.status` (`ready`/`error`) — tudo com service-role. Entrou no mapa no lote 5 do
// rescan do scanner Lovable Security (2026-11-17), junto com o gate de dono
// (`_shared/dono-pela-rls.ts`): sem `versao.ts`, o deploy desse conserto não seria julgável pelo
// `pendencias:deploy` (gate `sonda:nova`).
//
// Sondar o bundle ANTERIOR a este marcador é BARATO: `{"probe":true}` não traz `documentId` e cai no
// 400 "documentId required", antes de qualquer leitura, embedding ou escrita.

export { classificarSonda, erroSondaAmbigua } from "../_shared/sonda-versao.ts";
import { criarRespostaSonda } from "../_shared/sonda-versao.ts";

/** Resposta da sonda desta edge, com a identidade embutida (ver `criarRespostaSonda`). */
export const respostaSonda = criarRespostaSonda("kb-ingest-document");

/** Atualize a cada mudança relevante de comportamento — é o que distingue bundle novo de velho. */
export const VERSAO = "v1.0-dono-pela-rls";

/** Efeito caro citado no 400 de `probe` ambíguo. */
export const EFEITO =
  "esta edge paga embedding na OpenAI, insere kb_chunks e grava o status do documento da base de conhecimento com service-role";
