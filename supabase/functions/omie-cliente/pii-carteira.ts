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

/** O que a exceção operacional da impressão abre: só o endereço de entrega (nada de e-mail, telefone, IE). */
export const CAMPOS_ENDERECO_OMIE = ["endereco", "endereco_numero", "complemento", "bairro", "cep"] as const;

/**
 * Devolve o cliente com a PII zerada para `null` e `contato_visivel` explícito. Não muta a entrada.
 * `nivel`: `true` = tudo (carteira/gestão) · `"endereco"` = só o endereço (impressão do pedido) · `false` = nada.
 * `contato_visivel` só é `true` no nível inteiro.
 */
export function aplicarVisibilidade<T extends Record<string, unknown>>(
  cliente: T,
  nivel: boolean | "endereco",
): T & { contato_visivel: boolean } {
  if (nivel === true) return { ...cliente, contato_visivel: true };
  const abre = new Set<string>(nivel === "endereco" ? CAMPOS_ENDERECO_OMIE : []);
  const copia: Record<string, unknown> = { ...cliente };
  for (const campo of CAMPOS_PII_OMIE) {
    if (campo in copia && !abre.has(campo)) copia[campo] = null;
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
 * Documento em forma ESTRITA: só pontuação de máscara é removida; sobra lixo → `null`. A normalização
 * tolerante reduziria um alfanumérico malformado aos mesmos 11 dígitos de um CPF (Codex P1).
 */
function documentoEstrito(d: string | null | undefined): string | null {
  if (typeof d !== "string") return null;
  const n = d.replace(/[.\-/\s]/g, "").toUpperCase();
  if (/^[0-9]{11}$/.test(n) || /^[0-9A-Z]{12}[0-9]{2}$/.test(n)) return normalizarDocumento(n) === n ? n : null;
  return null;
}

/**
 * A exceção operacional só abre o cadastro Omie que É o cliente do pedido (Codex P1: dois cadastros com o
 * mesmo documento). Exige, na MESMA linha devolvida pela `contato_cliente_operacional` (que já gravou o
 * ledger): o `customer_user_id` vinculado a ESTE código Omie (mapa fresco) E o documento casando, em forma
 * estrita, com o `cnpj_cpf` da Omie. Qualquer ponta ausente → não abre (ausente ≠ casou).
 */
export function pedidoEDesteCadastro(
  linhasRpc: ReadonlyArray<{ customer_user_id?: string | null; document?: string | null; cnpj?: string | null }>,
  cnpjCpfOmie: string | null | undefined,
  usuariosDoCodigo: ReadonlySet<string>,
): boolean {
  const alvo = documentoEstrito(cnpjCpfOmie);
  if (!alvo) return false;
  return linhasRpc.some((l) =>
    typeof l.customer_user_id === "string" && usuariosDoCodigo.has(l.customer_user_id) &&
    [l.document, l.cnpj].some((d) => documentoEstrito(d) === alvo)
  );
}
