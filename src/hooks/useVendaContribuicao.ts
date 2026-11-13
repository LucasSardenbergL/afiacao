import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  lerContribuicao, type Contribuicao, type Eixo, type Empresa, type Janela, type Ordem,
} from '@/lib/venda-cliente/contribuicao';

export interface FiltroContribuicao {
  janela: Janela;
  eixo: Eixo;
  empresa: Empresa | null;
  ordem: Ordem;
  limite: number;
  offset: number;
}

/**
 * Demonstrativo de contribuição (`venda_contribuicao`, só master). `useAuth()` = usuário REAL: é a
 * visão do founder, não lê pela lente "Ver como". O retorno `jsonb` passa pela borda `lerContribuicao`,
 * que lança em forma desconhecida — a tela mostra a falha, nunca um número fabricado.
 */
export function useVendaContribuicao(f: FiltroContribuicao) {
  const { user, isMaster } = useAuth();
  return useQuery({
    queryKey: ['venda-contribuicao', user?.id ?? 'anon', f.janela, f.eixo, f.empresa, f.ordem, f.limite, f.offset],
    enabled: isMaster,
    staleTime: 5 * 60_000,
    // SEM placeholderData: com keepPreviousData a tela mostrava o payload do eixo ANTERIOR sob o cabeçalho
    // do novo (Codex, revisão de código) — trocar filtro mostra o esqueleto, nunca número de outro escopo.
    queryFn: async (): Promise<Contribuicao> => {
      const { data, error } = await supabase.rpc('venda_contribuicao', {
        p_janela: f.janela,
        p_eixo: f.eixo,
        // a assinatura gerada não aceita null; omitir = DEFAULT NULL na RPC (todas as empresas)
        ...(f.empresa ? { p_empresa: f.empresa } : {}),
        p_ordem: f.ordem,
        p_limite: f.limite,
        p_offset: f.offset,
      });
      if (error) throw error;
      return lerContribuicao(data);
    },
  });
}
