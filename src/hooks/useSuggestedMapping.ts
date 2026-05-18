import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type MappingSuggestion = {
  omie_codigo: string;
  categoria_nome: string;
  valor_periodo: number;
  sugestao: {
    linha_dre: string | null;
    confianca: 'alta' | 'media' | 'baixa';
    razao: string;
  };
};

export function useSuggestedMapping(company: string, ano: number, mes: number) {
  return useQuery({
    queryKey: ['fin_suggest_mapping', company, ano, mes],
    enabled: Boolean(company) && company !== '_default' && ano > 0 && mes > 0,
    queryFn: async (): Promise<MappingSuggestion[]> => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fin-suggest-mapping?company=${encodeURIComponent(company)}&ano=${ano}&mes=${mes}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { suggestions: MappingSuggestion[] };
      return json.suggestions;
    },
  });
}
