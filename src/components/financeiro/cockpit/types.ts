// Tipos do Cockpit financeiro.
// Extraídos verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import type { Database } from '@/integrations/supabase/types';

export type FinConfiabilidadeRow = Database['public']['Tables']['fin_confiabilidade']['Row'];
export type FinProjecaoSemana = Database['public']['Functions']['fin_projecao_13_semanas']['Returns'][number];
export type InadimplenteRow = { nome: string; cnpj: string; total_vencido: number; qtd_titulos: number };
