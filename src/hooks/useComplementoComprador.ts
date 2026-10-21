import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerComplementoComprador, type FamiliaComplemento } from '@/lib/venda-cliente/complemento';

/**
 * SKUs de referência das famílias de "Oferecer também" (Onda 2) — `venda_complemento_comprador`.
 * Quem DECIDE quais famílias aparecem é o gerador (linhas `complemento` da lista do dia); esta
 * leitura só traz os produtos que "clientes parecidos compram" em cada uma.
 *
 * `habilitado` = onda ligada no servidor E há linha de complemento E fora da lente "Ver como"
 * (a RPC é por `auth.uid()` e o write-guard da lente bloqueia RPC fora de get_/list_).
 */
export function useComplementoComprador(compradorId: string | null, habilitado: boolean): {
  familias: FamiliaComplemento[] | null;
  loading: boolean;
  erro: boolean;
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['venda-complemento-comprador', compradorId],
    enabled: !!compradorId && habilitado,
    staleTime: 60_000,
    queryFn: async (): Promise<FamiliaComplemento[]> => {
      const { data: raw, error } = await supabase.rpc('venda_complemento_comprador', { p_comprador: compradorId! });
      if (error) throw error;
      return lerComplementoComprador(raw);
    },
  });
  // Erro na revalidação NÃO mantém o dado do cache na tela (SKU que a regra já não indica seguiria visível — mesma regra do preço, Codex P1).
  return { familias: isError ? null : data ?? null, loading: habilitado && !!compradorId && isLoading, erro: isError };
}
