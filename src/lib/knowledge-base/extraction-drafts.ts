import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

/**
 * Mescla rascunhos do banco (persistidos) com resultados da sessão atual (memória).
 *
 * Regra de dedup por `documentId`:
 *  - MEMÓRIA GANHA — se o mesmo doc aparece nos dois, a versão da memória prevalece
 *    (é mais fresca: veio da extração que acabou de rodar nesta aba).
 *  - Ordem: memória primeiro, depois os exclusivos do banco.
 *
 * Isso garante que recarregar a página hidrata da base, mas não regride um resultado
 * recém-extraído pela extração da aba ativa.
 */
export function mesclarResultados(
  banco: ResultadoExtracao[],
  memoria: ResultadoExtracao[],
): ResultadoExtracao[] {
  // IDs que a memória já possui (memória tem prioridade)
  const idsMemoria = new Set(memoria.map((r) => r.documentId));

  // Banco: manter só os que a memória NÃO tem (evita dedup com o ganhador da memória)
  const bancoExclusivo = banco.filter((r) => !idsMemoria.has(r.documentId));

  // Memória primeiro, depois banco-exclusivo
  return [...memoria, ...bancoExclusivo];
}

/**
 * Filtra a lista de IDs da fila de aprovação, retornando APENAS os que ainda não possuem
 * rascunho `ready` no banco — ou seja, os que precisam de uma chamada à edge function.
 *
 * @param filaIds    IDs de todos os documentos da fila (useApprovalQueue)
 * @param draftsReadyIds  Set de documentId com `status='ready'` em `kb_extraction_drafts`
 */
export function docsParaExtrair(
  filaIds: string[],
  draftsReadyIds: Set<string>,
): string[] {
  return filaIds.filter((id) => !draftsReadyIds.has(id));
}
