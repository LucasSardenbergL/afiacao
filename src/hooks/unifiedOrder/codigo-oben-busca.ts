/**
 * Código Oben a partir da resposta do `omie-vendas-sync` action `buscar_cliente`.
 *
 * O contrato da action é ANINHADO: `{ success, cliente: { codigo_cliente, codigo_vendedor,
 * razao_social, cnpj_cpf } | null }` (o `criar_cliente` e o `buscar_cliente_por_documento` do
 * omie-sync é que são planos). O fluxo de pedido por IA lia `data.codigo_cliente` — campo que essa
 * action NUNCA devolve —, então até o lookup bem-sucedido virava `codigo_cliente: 0` e o pedido Oben
 * travava no preflight fail-closed do submit (Codex retroativo do #3311: resposta válida com 777 → 0).
 *
 * Fail-closed: `error` do invoke (5xx, OMIE_LOOKUP_DIVERGENTE/AMBIGUO/INDETERMINADO, rede) ou código
 * que não seja inteiro positivo → `null`. Nunca fabrica código; quem decide bloquear é o preflight.
 */
export interface BuscarClienteInvokeResult {
  data: unknown;
  error: unknown;
}

export function codigoObenDoBuscarCliente({ data, error }: BuscarClienteInvokeResult): number | null {
  if (error) return null;
  if (typeof data !== 'object' || data === null) return null;
  const cliente = (data as { cliente?: unknown }).cliente;
  if (typeof cliente !== 'object' || cliente === null) return null;
  const codigo = (cliente as { codigo_cliente?: unknown }).codigo_cliente;
  return typeof codigo === 'number' && Number.isSafeInteger(codigo) && codigo > 0 ? codigo : null;
}
