// Tipos do AI Ops.
// Extraídos verbatim de src/pages/AIops.tsx (god-component split).

import type { Tables } from '@/integrations/supabase/types';

export interface Evidence {
  label: string;
  value: string;
  type: 'warning' | 'info' | 'critical';
}

/** Linha de `ai_decisions` com os dois jsonb já lidos pela borda (`decisaoDaLinha`). */
export type AIDecision = Omit<Tables<'ai_decisions'>, 'evidences' | 'customer_metrics'> & {
  evidences: Evidence[];
  customer_metrics: Record<string, number | null>;
};

export type CustomerProfileLite = Pick<
  Tables<'profiles'>,
  'user_id' | 'name' | 'document' | 'phone' | 'email' | 'customer_type'
>;
