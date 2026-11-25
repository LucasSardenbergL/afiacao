import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerPerfilContato } from '@/lib/contato-cliente';

interface ProfileData {
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  customer_type: string | null;
  avatar_url: string | null;
  business_hours_open: string | null;
  business_hours_close: string | null;
  lunch_start: string | null;
  lunch_end: string | null;
  preferred_delivery_time: string | null;
}

export function useProfile(userId: string | undefined) {
  return useQuery({
    queryKey: ['profile', userId],
    queryFn: async () => {
      // Onda D: e-mail/telefone/documento pela view (self sempre visível; staff na lente "Ver como"
      // vê mascarado fora da carteira). O resto do perfil segue de profiles.
      const [{ data, error }, contato] = await Promise.all([
        supabase
          .from('profiles')
          .select('name, customer_type, avatar_url, business_hours_open, business_hours_close, lunch_start, lunch_end, preferred_delivery_time')
          .eq('user_id', userId!)
          .maybeSingle(),
        lerPerfilContato(userId!),
      ]);
      if (error) throw error;
      if (!data) return null;
      return { ...data, email: contato?.email ?? null, phone: contato?.phone ?? null, document: contato?.document ?? null } as ProfileData;
    },
    enabled: !!userId,
  });
}

/** Basic profile (name, customer_type, document) for Index page */
export function useBasicProfile(userId: string | undefined) {
  return useQuery({
    queryKey: ['profile', 'basic', userId],
    queryFn: async () => {
      const [{ data, error }, contato] = await Promise.all([
        supabase.from('profiles').select('name, customer_type').eq('user_id', userId!).single(),
        lerPerfilContato(userId!),
      ]);
      if (error) throw error;
      return { ...data, document: contato?.document ?? null } as { name: string; customer_type: string | null; document: string | null };
    },
    enabled: !!userId,
  });
}

/** Profile stats: address count, order count, tool count */
export function useProfileStats(userId: string | undefined) {
  return useQuery({
    queryKey: ['profile', 'stats', userId],
    queryFn: async () => {
      const [addrRes, orderRes, toolRes] = await Promise.all([
        supabase.from('addresses').select('*', { count: 'exact', head: true }).eq('user_id', userId!),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('user_id', userId!).eq('status', 'entregue'),
        supabase.from('user_tools').select('*', { count: 'exact', head: true }).eq('user_id', userId!),
      ]);
      return {
        addressCount: addrRes.count ?? 0,
        orderCount: orderRes.count ?? 0,
        toolCount: toolRes.count ?? 0,
      };
    },
    enabled: !!userId,
  });
}
