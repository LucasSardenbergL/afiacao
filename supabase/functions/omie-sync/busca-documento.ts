// Desfecho do `catch` do `buscar_cliente_por_documento`. O `callOmieApi` desta edge lança `Erro Omie:
// <faultstring>` para QUALQUER faultstring, inclusive o EOF ("Não existem registros para a página"),
// que é como o Omie responde a uma busca vazia. Antes, todo erro virava `codigo_cliente: null`: um 503
// ou uma credencial recusada eram lidos como "o cliente não existe" e o front tentava
// `criar_cliente_afiacao` sobre uma falsa ausência (Codex retroativo do #3311, 2026-10-27).
// Agora só o EOF é ausência; transitório, permanente e indeterminado falham alto (500).
import { classificarFaultstring } from "../_shared/omie-falha.ts";

/** true só quando o erro é o EOF do Omie, a única falha que significa "não há cliente com esse documento". */
export function buscaPorDocumentoNaoAchou(erro: unknown): boolean {
  const texto = erro instanceof Error ? erro.message : String(erro);
  return classificarFaultstring(texto) === "fim_de_pagina";
}
