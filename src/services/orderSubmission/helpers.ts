import type {
  AddressData,
  OmieCustomer,
  FormaPagamento,
  ServiceCartItem,
  UserTool,
} from '@/hooks/unifiedOrder/types';
import { logger } from '@/lib/logger';
import type { SubmitClient } from './types';

export const getToolName = (t: UserTool): string =>
  t.generated_name || t.custom_name || t.tool_categories?.name || 'Ferramenta';

/** Entrada do preflight de identidade por-conta do submit. */
export interface AccountIdentityCheck {
  hasOben: boolean;
  hasColacor: boolean;
  hasAfiacao: boolean;
  codigoCliente?: number | null;
  codigoClienteColacor?: number | null;
  codigoClienteAfiacao?: number | null;
}

/**
 * Preflight fail-closed: nomes das contas que TÊM itens mas NÃO têm um código de
 * cliente válido próprio (cada conta Omie tem código de cliente distinto — nunca
 * cair no código de outra conta). Vazio = todas as contas usadas têm identidade.
 * Código <= 0 ou ausente é inválido (não é código Omie real).
 */
export function missingAccountIdentities(input: AccountIdentityCheck): string[] {
  const valid = (c?: number | null): boolean => typeof c === 'number' && c > 0;
  const missing: string[] = [];
  if (input.hasOben && !valid(input.codigoCliente)) missing.push('Oben');
  if (input.hasColacor && !valid(input.codigoClienteColacor)) missing.push('Colacor');
  if (input.hasAfiacao && !valid(input.codigoClienteAfiacao)) missing.push('Afiação');
  return missing;
}

/**
 * Código Omie de cliente válido: número finito > 0. Mesma primitiva money-path do preflight
 * `missingAccountIdentities` — 0, negativo, NaN, ±Infinity e ausente são inválidos (ausente ≠
 * zero; nunca vai ao Omie). Type guard para estreitar o resultado (possivelmente `null`) de um
 * lookup em `omie_clientes`.
 */
export function isValidOmieClientCode(code: unknown): code is number {
  return typeof code === 'number' && Number.isFinite(code) && code > 0;
}

const OMIE_ACCOUNT_LABEL: Record<string, string> = {
  colacor: 'Colacor',
  oben: 'Oben',
  colacor_sc: 'Colacor SC',
};

/**
 * Mensagem pt-BR de fail-closed quando o cliente não tem identidade Omie na CONTA do pedido.
 * Cada conta Omie tem código de cliente próprio (`omie_clientes` tem UNIQUE (user_id, empresa_omie));
 * sem o código da conta certa não dá pra criar o PV sem arriscar o cliente errado. Cita a conta
 * (label conhecido, ou o próprio identificador como fallback).
 */
export function omieAccountIdentityMissingMessage(account: string): string {
  const label = OMIE_ACCOUNT_LABEL[account] ?? account;
  return `Cliente não cadastrado no Omie da conta ${label}. Sincronize/cadastre o cliente nessa conta antes de enviar o pedido.`;
}

export function findParcelaDesc(codigo: string, formas: FormaPagamento[]): string {
  const found = formas.find(f => f.codigo === codigo);
  return found?.descricao || codigo;
}

export function buildToolInfo(c: ServiceCartItem): string {
  const parts: string[] = [];
  parts.push(getToolName(c.userTool));
  const specs = c.userTool.specifications;
  if (specs && typeof specs === 'object') {
    const specEntries = Object.entries(specs).filter(([, v]) => v);
    if (specEntries.length > 0) {
      parts.push(specEntries.map(([k, v]) => `${k}: ${v}`).join(', '));
    }
  }
  if (c.notes) parts.push(c.notes);
  return parts.join(' | ');
}

export function formatCustomerAddress(
  selectedAddress: AddressData | undefined,
  customer: OmieCustomer,
): string | null {
  if (selectedAddress) {
    return `${selectedAddress.street}, ${selectedAddress.number}${selectedAddress.complement ? ' - ' + selectedAddress.complement : ''} – ${selectedAddress.neighborhood}, ${selectedAddress.city}/${selectedAddress.state} – CEP: ${selectedAddress.zipCode}`;
  }
  if (customer.endereco) {
    return `${customer.endereco}, ${customer.endereco_numero || 'S/N'}${customer.complemento ? ' - ' + customer.complemento : ''} – ${customer.bairro || ''}, ${customer.cidade || ''}/${customer.estado || ''} – CEP: ${customer.cep || ''}`;
  }
  return null;
}

export async function resolveCustomerPhone(
  supabase: SubmitClient,
  customer: OmieCustomer,
  customerUserId: string | null,
  fallbackUserId: string,
): Promise<string | null> {
  let phone = customer.telefone || null;
  const uid = customerUserId || fallbackUserId;
  if (uid) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('phone')
        .eq('user_id', uid)
        .maybeSingle();
      if (data?.phone) phone = data.phone;
    } catch (e) {
      logger.warn('Failed to resolve customer phone (using fallback)', {
        userId: uid,
        customerId: customer.codigo_cliente,
        error: e,
      });
    }
  }
  return phone;
}
