import { supabase } from '@/integrations/supabase/client';

export interface ResolvedCustomer {
  /** UUID do profile do cliente; null se não encontrou match local */
  customerUserId: string | null;
  /** Telefone normalizado (dígitos apenas) — sempre preenchido pra fallback */
  phoneDialed: string;
  /** Nome do contato (se identificado via customer_contacts) — PR-CONTACTS */
  contactName?: string;
  /** Cargo do contato (dono/gerente/comprador/etc) — PR-CONTACTS */
  contactCargo?: string;
}

/**
 * Busca telefone primeiro em `customer_contacts` (PR-CONTACTS — mais específico,
 * inclui nome+cargo do contato), depois fallback em `profiles.phone`.
 *
 * Se não houver match em nenhum, retorna `customerUserId: null` mas sempre
 * preserva o `phoneDialed` normalizado pra salvar em `farmer_calls.phone_dialed`.
 *
 * Vinculação posterior (operador clica "vincular cliente" na UI) pode atualizar
 * o registro depois.
 */
export async function resolveCustomerByPhone(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');

  if (!phoneDialed) {
    return { customerUserId: null, phoneDialed: '' };
  }

  const last8 = phoneDialed.slice(-8);

  try {
    // 1. Tenta customer_contacts primeiro (mais específico — tem nome+cargo)
     
    const { data: contact } = await supabase.from('customer_contacts')
      .select('customer_user_id, nome, cargo')
      .filter('phone', 'ilike', `%${last8}%`)
      .order('is_primary', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contact?.customer_user_id) {
      return {
        customerUserId: contact.customer_user_id,
        phoneDialed,
        contactName: contact.nome ?? undefined,
        contactCargo: contact.cargo ?? undefined,
      };
    }

    // 2. Fallback pra profiles.phone (legado pré-PR-CONTACTS)
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('user_id')
      .filter('phone', 'ilike', `%${last8}%`)
      .maybeSingle();

    if (error || !profile) {
      return { customerUserId: null, phoneDialed };
    }

    return { customerUserId: profile.user_id, phoneDialed };
  } catch {
    return { customerUserId: null, phoneDialed };
  }
}
