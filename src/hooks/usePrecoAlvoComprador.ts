import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerPrecoAlvoComprador, type PrecoAlvo } from '@/lib/venda-cliente/preco';

/**
 * Preço alvo AO VIVO dos repasses aprovados (Onda 3) — `venda_preco_alvo_comprador` (money-path).
 * A RPC é a autoridade da exibição: repasse revogado, vencido ou já alcançado some dela, e a ficha
 * então mostra só o último preço. Nunca devolve custo/markup/piso.
 *
 * `habilitado` = onda ligada no servidor E há linha `preco` E fora da lente "Ver como".
 */
export function usePrecoAlvoComprador(compradorId: string | null, habilitado: boolean): {
  alvos: PrecoAlvo[] | null;
  loading: boolean;
  erro: boolean;
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['venda-preco-alvo-comprador', compradorId],
    enabled: !!compradorId && habilitado,
    staleTime: 60_000,
    queryFn: async (): Promise<PrecoAlvo[]> => {
      const { data: raw, error } = await supabase.rpc('venda_preco_alvo_comprador', { p_comprador: compradorId! });
      if (error) throw error;
      return lerPrecoAlvoComprador(raw);
    },
  });
  // Erro na revalidação NÃO mantém o dado do cache na tela (repasse revogado seguiria visível — Codex P1).
  return { alvos: isError ? null : data ?? null, loading: habilitado && !!compradorId && isLoading, erro: isError };
}
