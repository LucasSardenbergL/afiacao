// Identidade do cliente devolvido pelo lookup anti-duplicata do `criar_cliente` (ListarClientes com
// `clientesFiltro.cnpj_cpf`). O Omie devolve o 1º registro da página; a edge só pode tratá-lo como "já
// existe" se o documento dele for o MESMO que foi pedido — senão (filtro parcial, letras ignoradas num
// CNPJ alfanumérico, registro sem documento) o lead sairia da fila com o código de OUTRA empresa.
// Codex ALTO 2026-10-20 · diário docs/historico/radar-cnpj-alfanumerico.md.
import { normalizarDocumento } from "../_shared/cnpj-alfanumerico.ts";

/**
 * `pedido` é o documento JÁ normalizado que foi ao filtro (saída de `documentoParaCadastro`/`normalizarDocumento`).
 * `retornado` é o `cnpj_cpf` cru do registro do Omie (com ou sem máscara, maiúsculo ou não).
 * Vazio/ausente nunca confere (não se afirma identidade sem documento).
 */
export function lookupDevolveuOMesmoDocumento(pedido: string, retornado: unknown): boolean {
  const r = normalizarDocumento(retornado);
  return r.length > 0 && pedido.length > 0 && r === pedido;
}
