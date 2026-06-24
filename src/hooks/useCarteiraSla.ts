import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type HealthClass = 'saudavel' | 'estavel' | 'atencao' | 'critico';

export interface CarteiraSlaRow {
  customer_user_id: string;
  farmer_id: string | null;
  health_class: HealthClass;
  churn_risk: number | null;
  last_contact_at: string | null;
  dias_sem_contato: number | null;
  sla_dias: number;
  vencido: boolean;
  priority_score: number | null;
}

// Fila de "SLA de contato vencido" da carteira (view read-only v_carteira_sla).
// security_invoker=true → a RLS de farmer_client_scores já escopa por carteira;
// o vendedor vê a carteira dele, o gestor vê tudo.
//
// NOTA(tipos): v_carteira_sla é uma view nova; enquanto os tipos do Supabase não
// forem regenerados, o nome não consta no schema gerado → cast pontual em `.from`
// + `.returns<T>()`. TODO: remover o `as never` após regenerar types.ts.
export function useCarteiraSla() {
  return useQuery({
    queryKey: ['carteira-sla'],
    queryFn: async (): Promise<CarteiraSlaRow[]> => {
      const { data, error } = await supabase
        .from('v_carteira_sla' as never)
        .select(
          'customer_user_id, farmer_id, health_class, churn_risk, last_contact_at, dias_sem_contato, sla_dias, vencido, priority_score',
        )
        .order('priority_score', { ascending: false })
        .limit(200)
        .returns<CarteiraSlaRow[]>();
      if (error) throw error;
      return data ?? [];
    },
  });
}
