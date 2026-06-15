/**
 * Tri-state do auto-cadastro de cliente por conta Omie (spec
 * 2026-06-06-preco-realtime-selectCustomer — Etapas 2b/3).
 *
 * O lookup de cliente por conta tem TRÊS desfechos, não dois:
 *   found  → código preenchido → não criar;
 *   absent → lookup respondeu "não existe" → criar;
 *   error  → o lookup FALHOU → ausência NÃO confirmada → NÃO criar às cegas
 *            (criar em cima de falha de leitura duplicaria no Omie um cliente
 *            que já existe). Nesse caso o preflight fail-closed do submit
 *            bloqueia a conta, se usada — com mensagem acionável.
 *
 * ⚠️ Limite conhecido (Etapa 2b pendente): este guard cobre falha do INVOKE
 * (rede, 5xx, throw). O edge `buscar_cliente` ainda MASCARA erro transitório/
 * rate-limit esgotado como `{ success: true, cliente: null }` — que daqui
 * parece "absent". Fechar esse canal exige o `throwOnTransient` do edge
 * (Etapa 2b do spec, aguardando deploy); até lá o re-check de existência do
 * próprio `criar_cliente` é o mitigante.
 */
export interface EnsureContaInput {
  /** Código do cliente naquela conta (null/undefined = não resolvido). */
  codigoExistente: number | null | undefined;
  /** Cliente tem CNPJ/CPF (sem documento não há como cadastrar). */
  temDocumento: boolean;
  /** O lookup daquela conta FALHOU (erro/reject — ausência não confirmada). */
  lookupFalhou: boolean;
}

export function deveCriarClienteNaConta({
  codigoExistente,
  temDocumento,
  lookupFalhou,
}: EnsureContaInput): boolean {
  if (codigoExistente) return false;
  if (!temDocumento) return false;
  if (lookupFalhou) return false;
  return true;
}
