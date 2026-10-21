// Identidade do cliente devolvido por um lookup do Omie (ListarClientes com `clientesFiltro.cnpj_cpf`). O Omie
// devolve o 1º registro da página; a edge só pode tratá-lo como o cliente pedido se o documento dele for o
// MESMO — senão (filtro parcial, letras ignoradas num CNPJ alfanumérico, registro sem documento) o lead sairia
// da fila, ou o pedido iria, com o código de OUTRA empresa. Codex ALTO 2026-10-20 (criar_cliente de vendas);
// desde 2026-10-21 em `_shared` para as duas edges: criar_cliente/buscar_cliente (omie-vendas-sync) e
// criar_cliente_afiacao/buscar_cliente_por_documento (omie-sync). Diário docs/historico/radar-cnpj-alfanumerico.md.
import { normalizarDocumento } from "./cnpj-alfanumerico.ts";

/**
 * `pedido` é o documento JÁ normalizado que foi ao filtro (saída de `documentoParaCadastro`/`normalizarDocumento`).
 * `retornado` é o `cnpj_cpf` cru do registro do Omie (com ou sem máscara, maiúsculo ou não).
 * Vazio/ausente nunca confere (não se afirma identidade sem documento).
 */
export function lookupDevolveuOMesmoDocumento(pedido: string, retornado: unknown): boolean {
  const r = normalizarDocumento(retornado);
  return r.length > 0 && r === pedido; // r === pedido já implica pedido não-vazio
}
