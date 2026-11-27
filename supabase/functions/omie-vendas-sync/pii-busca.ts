// Onda D, fatia 4b-3: a busca de cliente do Novo Pedido (`listar_clientes`) devolvia documento, telefone e
// endereço de QUALQUER cliente Omie antes da seleção. Agora vale a regra da `omie-cliente` v1.13
// (`_shared/pii-carteira.ts`): a identidade (razão, fantasia, cidade, UF, vendedor) é aberta; a PII só vai
// para quem tem o cliente na carteira/cobertura, e para a gestão.
//
// Fora da carteira o vendedor ainda precisa vender: ao SELECIONAR o cliente, o front pede `revelar_cliente`,
// que abre o cadastro pela exceção operacional `novo_pedido` (a `contato_cliente_operacional` grava o ledger
// com o JWT de quem chama). Aqui só as decisões puras, testáveis sem rede. Fail-closed em tudo.

import { aplicarVisibilidade, pedidoEDesteCadastro } from "../_shared/pii-carteira.ts";

/**
 * Além da PII comum (`CAMPOS_PII_OMIE`), a linha da busca carrega o nome da pessoa de contato e a razão/fantasia
 * FISCAL (que só existem quando a razão traz o CPF do titular de MEI). Fora da carteira: contato `null` e as
 * fiscais removidas. Não muta a entrada.
 */
export function mascararLinhaBusca<T extends Record<string, unknown>>(
  linha: T,
  visivel: boolean,
): T & { contato_visivel: boolean } {
  const m = aplicarVisibilidade(linha, visivel) as Record<string, unknown>;
  if (!visivel) {
    if ("contato" in m) m.contato = null;
    delete m.razao_fiscal;
    delete m.fantasia_fiscal;
  }
  return m as T & { contato_visivel: boolean };
}

/** Lê o `codigo_cliente` do body de `revelar_cliente`: inteiro positivo, ou `null` (recusa). */
export function lerCodigoRevelar(bruto: unknown): number | null {
  const n = typeof bruto === "number" ? bruto : typeof bruto === "string" && /^[0-9]+$/.test(bruto) ? Number(bruto) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type DecisaoRevelar =
  | { abre: true; via: "carteira" | "excecao" }
  | { abre: false; motivo: "sem_vinculo" | "cadastro_divergente" };

/**
 * Fora da carteira, a exceção `novo_pedido` só abre o cadastro Omie que É o cliente local registrado no ledger:
 * o `customer_user_id` devolvido pela RPC vinculado a ESTE código (mapa fresco) E o documento local casando,
 * em forma estrita, com o `cnpj_cpf` da Omie (mesma prova da impressão do pedido). Ausente ≠ casou.
 */
export function decidirRevelacao(p: {
  naCarteira: boolean;
  usuariosDoCodigo: ReadonlySet<string>;
  linhasRpc: ReadonlyArray<{ customer_user_id?: string | null; document?: string | null; cnpj?: string | null }>;
  cnpjCpfOmie: string | null | undefined;
}): DecisaoRevelar {
  if (p.naCarteira) return { abre: true, via: "carteira" };
  if (p.usuariosDoCodigo.size === 0) return { abre: false, motivo: "sem_vinculo" };
  return pedidoEDesteCadastro(p.linhasRpc, p.cnpjCpfOmie, p.usuariosDoCodigo)
    ? { abre: true, via: "excecao" }
    : { abre: false, motivo: "cadastro_divergente" };
}
