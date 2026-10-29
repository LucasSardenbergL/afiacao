// Identidade do cliente devolvido por um lookup do Omie (ListarClientes com `clientesFiltro.cnpj_cpf`). O Omie
// devolve o 1º registro da página; a edge só pode tratá-lo como o cliente pedido se o documento dele for o
// MESMO — senão (filtro parcial, letras ignoradas num CNPJ alfanumérico, registro sem documento) o lead sairia
// da fila, ou o pedido iria, com o código de OUTRA empresa. Codex ALTO 2026-10-20 (criar_cliente de vendas);
// desde 2026-10-21 em `_shared` para as duas edges: criar_cliente/buscar_cliente (omie-vendas-sync) e
// criar_cliente_afiacao/buscar_cliente_por_documento (omie-sync). Diário docs/historico/radar-cnpj-alfanumerico.md.
import { documentoParaCadastro } from "./cnpj-alfanumerico.ts";

/**
 * `pedido` é o documento JÁ normalizado que foi ao filtro (saída de `documentoParaCadastro`).
 * `retornado` é o `cnpj_cpf` cru do registro do Omie (com ou sem máscara, maiúsculo ou não).
 * O retorno passa pela MESMA gramática estrita da entrada: com o só-dígitos do `normalizarDocumento`,
 * um `123ABC45678909` devolvido virava `12345678909` e casava com o pedido — o código de OUTRO cliente
 * passava (Codex retroativo do #3311, 2026-10-27). Não-string, vazio, letra fora do rótulo, caractere fora
 * do alfabeto: tudo é "não confere" (não se afirma identidade sem documento legível).
 */
export function lookupDevolveuOMesmoDocumento(pedido: string, retornado: unknown): boolean {
  if (typeof retornado !== "string") return false;
  let r: string;
  try {
    r = documentoParaCadastro(retornado);
  } catch {
    return false;
  }
  return r === pedido; // documentoParaCadastro lança sem dígito (DOC_SEM_DIGITO): r nunca é vazio
}
