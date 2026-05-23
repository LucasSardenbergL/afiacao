// Query hooks da Importação Tintométrica (histórico + contagem de produtos).
// Extraídos de src/pages/TintImport.tsx (god-component split).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ACCOUNT } from './types';

export function useImportHistory() {
  return useQuery({
    queryKey: ['tint-import-history'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_importacoes')
        .select('*')
        .eq('account', ACCOUNT)
        .order('created_at', { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });
}

export function useTintProductCounts() {
  return useQuery({
    queryKey: ['tint-product-counts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('omie_products')
        .select('tint_type')
        .eq('is_tintometric', true)
        .eq('account', ACCOUNT);
      const bases = (data ?? []).filter(p => p.tint_type === 'base').length;
      const concentrados = (data ?? []).filter(p => p.tint_type === 'concentrado').length;
      return { bases, concentrados };
    },
    staleTime: 5 * 60 * 1000,
  });
}
