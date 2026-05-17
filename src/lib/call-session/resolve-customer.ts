import { supabase } from '@/integrations/supabase/client';

export interface ResolvedCustomer {
  /** UUID do profile do cliente; null se não encontrou match local */
  customerUserId: string | null;
  /** Telefone normalizado (dígitos apenas) — sempre preenchido pra fallback */
  phoneDialed: string;
}

/**
 * Busca em `profiles` por telefone normalizado e retorna o `user_id` do cliente.
 * Se não houver match, retorna `customerUserId: null` mas sempre preserva o
 * `phoneDialed` normalizado pra salvar em `farmer_calls.phone_dialed`.
 *
 * Vinculação posterior (operador clica "vincular cliente" na UI) pode atualizar
 * o registro depois — implementação futura no PR5.
 */
export async function resolveCustomerByPhone(rawPhone: string): Promise<ResolvedCustomer> {
  const phoneDialed = rawPhone.replace(/\D/g, '');

  if (!phoneDialed) {
    return { customerUserId: null, phoneDialed: '' };
  }

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id')
      // Match em regex normalizado (cobre formatos diversos no banco)
      .filter('phone', 'ilike', `%${phoneDialed.slice(-8)}%`)
      .maybeSingle();

    if (error || !data) {
      return { customerUserId: null, phoneDialed };
    }

    return { customerUserId: data.user_id, phoneDialed };
  } catch {
    return { customerUserId: null, phoneDialed };
  }
}
