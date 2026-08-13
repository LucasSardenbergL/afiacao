export const ORIGEM_LIGACAO = ['ligacao_sainte', 'ligacao_entrante'] as const;

/** Origem do pedido a partir da URL (sem CHECK no banco → validar aqui).
 *  Ligação é staff-only: customer SEMPRE 'web_customer'. Desconhecido → default da role. */
export function resolveOrigemFromUrl(raw: string | null, isCustomerMode: boolean): string {
  if (isCustomerMode) return 'web_customer';
  if (raw && (ORIGEM_LIGACAO as readonly string[]).includes(raw)) return raw;
  return 'web_staff';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Aceita só UUID (money-path: não passar lixo da URL pro insert). */
export function sanitizeAtendimentoId(raw: string | null): string | null {
  return raw && UUID_RE.test(raw) ? raw : null;
}

/** Decide a metadata da ponte a ser CONGELADA no envelope. Só aplica a metadata da
 *  ligação se a URL-customer == o cliente selecionado (anti-troca-de-cliente: uma ligação
 *  entrante de B durante o pedido de A NÃO contamina o pedido de A). Customer mode nunca
 *  herda ligação. Atendimento só se UUID válido. */
export function resolveBridgeMetadata(args: {
  urlCustomer: string | null;
  selectedCustomerUserId: string | null;
  urlOrigem: string | null;
  urlAtendimento: string | null;
  isCustomerMode: boolean;
}): { origem: string; atendimentoId: string | null } {
  const matches = !!args.urlCustomer && !!args.selectedCustomerUserId && args.urlCustomer === args.selectedCustomerUserId;
  return {
    origem: matches ? resolveOrigemFromUrl(args.urlOrigem, args.isCustomerMode) : (args.isCustomerMode ? 'web_customer' : 'web_staff'),
    atendimentoId: matches && !args.isCustomerMode ? sanitizeAtendimentoId(args.urlAtendimento) : null,
  };
}
