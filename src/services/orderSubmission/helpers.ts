import type {
  AddressData,
  OmieCustomer,
  FormaPagamento,
  ServiceCartItem,
  UserTool,
} from '@/hooks/unifiedOrder/types';
import type { SubmitClient } from './types';

export const getToolName = (t: UserTool): string =>
  t.generated_name || t.custom_name || t.tool_categories?.name || 'Ferramenta';

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
      console.error('[orderSubmission] Failed to resolve customer phone:', e);
    }
  }
  return phone;
}
