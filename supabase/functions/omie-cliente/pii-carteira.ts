// Onda D, fatia 4b-2: a PII do cliente Omie (documento, e-mail, telefone, endereço, IE) só vai para
// quem tem o cliente na carteira/cobertura, e para a gestão. A identidade (razão, fantasia, cidade, UF,
// vendedor) é aberta, como nas views mascaradas do banco (decisão (c) da onda D).
//
// Quem decide a carteira é o BANCO, não esta edge: o índice é `v_perfil_contato.contato_visivel`, lido com
// o JWT do chamador (mesma regra de `private.clientes_contato_visiveis`), e a gestão é
// `pode_ver_carteira_completa`. Aqui só ficam as decisões puras, testáveis sem rede.
//
// Fail-closed em tudo: erro de leitura, código Omie sem vínculo local, vínculo sem perfil → mascarado.

import { normalizarDocumento } from "../_shared/cnpj-alfanumerico.ts";

/** Campos de PII que a resposta de `pesquisar_clientes`/`consultar_cliente` carrega. */
export const CAMPOS_PII_OMIE = [
  "cnpj_cpf",
  "email",
  "telefone",
  "endereco",
  "endereco_numero",
  "complemento",
  "bairro",
  "cep",
  "inscricao_estadual",
] as const;

/** Devolve o cliente com a PII zerada para `null` e `contato_visivel` explícito. Não muta a entrada. */
export function aplicarVisibilidade<T extends Record<string, unknown>>(
  cliente: T,
  visivel: boolean,
): T & { contato_visivel: boolean } {
  if (visivel) return { ...cliente, contato_visivel: true };
  const copia: Record<string, unknown> = { ...cliente };
  for (const campo of CAMPOS_PII_OMIE) {
    if (campo in copia) copia[campo] = null;
  }
  return { ...(copia as T), contato_visivel: false };
}

/**
 * Códigos Omie cujo contato o chamador pode ver.
 *  - `vinculos`: pares (código Omie → user_id local) da conta consultada;
 *  - `visiveis`: user_ids com `contato_visivel = true` para o chamador.
 * Um código é visível se ALGUM user vinculado a ele está na carteira/cobertura (cliente com 2 cadastros).
 */
export function codigosVisiveis(
  vinculos: ReadonlyArray<{ omie_codigo_cliente: number | null; user_id: string | null }>,
  visiveis: ReadonlySet<string>,
): Set<number> {
  const out = new Set<number>();
  for (const v of vinculos) {
    if (v.omie_codigo_cliente == null || v.user_id == null) continue;
    if (visiveis.has(v.user_id)) out.add(Number(v.omie_codigo_cliente));
  }
  return out;
}

/** O único caminho operacional aceito por `consultar_cliente`: o endereço na impressão do pedido. */
export type AcessoOperacional = { objeto_tipo: "pedido"; objeto_id: string; motivo: "impressao_pedido" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida o `operacional` do body. Qualquer outra forma → `null` (sem exceção operacional). */
export function lerAcessoOperacional(bruto: unknown): AcessoOperacional | null {
  if (!bruto || typeof bruto !== "object") return null;
  const o = bruto as Record<string, unknown>;
  if (o.objeto_tipo !== "pedido" || o.motivo !== "impressao_pedido") return null;
  if (typeof o.objeto_id !== "string" || !UUID.test(o.objeto_id)) return null;
  return { objeto_tipo: "pedido", objeto_id: o.objeto_id, motivo: "impressao_pedido" };
}

/**
 * A exceção operacional só abre o cadastro Omie que É o cliente do pedido: o documento devolvido pela
 * `contato_cliente_operacional` (que já gravou o ledger) tem de casar com o `cnpj_cpf` da Omie.
 * Documento ausente em qualquer ponta → não abre (ausente ≠ casou).
 */
export function documentoDoPedidoCasa(
  linhasRpc: ReadonlyArray<{ document?: string | null; cnpj?: string | null }>,
  cnpjCpfOmie: string | null | undefined,
): boolean {
  if (!cnpjCpfOmie) return false;
  const alvo = normalizarDocumento(cnpjCpfOmie);
  if (alvo.length !== 11 && alvo.length !== 14) return false;
  return linhasRpc.some((l) =>
    [l.document, l.cnpj].some((d) => typeof d === "string" && d !== "" && normalizarDocumento(d) === alvo)
  );
}
