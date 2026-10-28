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

/**
 * 1º cliente de um `ListarClientes` por documento, com o desfecho decidido num lugar só (as duas
 * leituras da edge, `buscar_cliente_por_documento` e a reconsulta do `criar_cliente_afiacao`):
 *   · EOF do Omie ("Não existem registros") ou página vazia → `undefined` (ausência);
 *   · resposta sem `clientes_cadastro` em array (`{}`, `{"error":…}`, objeto no lugar da lista) → LANÇA
 *     `OMIE_RESPOSTA_MALFORMADA` — virava "não existe" e liberava cadastro sobre falsa ausência;
 *   · qualquer outro erro → relança.
 * A reconsulta do criar_cliente_afiacao lia o EOF como falha e devolvia success:false: cliente novo
 * nunca era cadastrado na Afiação (Codex 2026-10-27).
 */
export async function primeiroClientePorDocumento<T>(chamar: () => Promise<unknown>): Promise<T | undefined> {
  let resposta: unknown;
  try {
    resposta = await chamar();
  } catch (erro) {
    if (buscaPorDocumentoNaoAchou(erro)) return undefined;
    throw erro;
  }
  const lista = (resposta as { clientes_cadastro?: unknown } | null | undefined)?.clientes_cadastro;
  if (!Array.isArray(lista)) {
    throw new Error("OMIE_RESPOSTA_MALFORMADA: ListarClientes sem clientes_cadastro em lista — não dá pra afirmar ausência");
  }
  return lista[0] as T | undefined;
}
