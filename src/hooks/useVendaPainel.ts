import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { comNulo } from '@/lib/rpc-args';
import {
  lerCandidatosRepasse,
  lerPainelVenda,
  type CandidatoRepasse,
  type PainelVenda,
} from '@/lib/venda-cliente/painel';

// As 4 RPCs estão no types.ts desde a regeneração do Lovable de 2026-10-21. As duas de leitura
// devolvem `jsonb` (tipado `Json`): a forma é conferida em `lerPainelVenda`/`lerCandidatosRepasse`.

/**
 * Painel do founder (`venda_painel`, master). `useAuth()` = usuário REAL: o painel é do
 * founder, não lê pela lente "Ver como".
 */
export function useVendaPainel(de: string, ate: string) {
  const { user, isMaster } = useAuth();
  return useQuery({
    queryKey: ['venda-painel', user?.id ?? 'anon', de, ate],
    enabled: isMaster,
    staleTime: 60_000,
    queryFn: async (): Promise<PainelVenda> => {
      const { data, error } = await supabase.rpc('venda_painel', { p_de: de, p_ate: ate });
      if (error) throw error;
      return lerPainelVenda(data);
    },
  });
}

/**
 * Candidatos a repasse (Task 6: master + cap_custo_ler). `disponivel=false` quando a RPC ainda
 * não existe no banco — a aba mostra "ainda não instalado", não uma lista vazia.
 */
export function useRepasseCandidatos(disponivel: boolean) {
  const { user, isMaster } = useAuth();
  return useQuery({
    queryKey: ['venda-repasse-candidatos', user?.id ?? 'anon'],
    enabled: isMaster && disponivel,
    staleTime: 60_000,
    queryFn: async (): Promise<CandidatoRepasse[]> => {
      const { data, error } = await supabase.rpc('venda_repasse_candidatos');
      if (error) throw error;
      return lerCandidatosRepasse(data);
    },
  });
}

/** Nomes dos compradores (profiles), em lotes — a lista de candidatos só traz o id. */
export function useNomesCompradores(ids: string[]) {
  const chave = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ['venda-nomes-compradores', chave],
    enabled: chave.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const lotes: string[][] = [];
      for (let i = 0; i < chave.length; i += 100) lotes.push(chave.slice(i, i + 100));
      const respostas = await Promise.all(
        lotes.map((lote) => supabase.from('profiles').select('user_id, name, razao_social').in('user_id', lote)),
      );
      const nomes = new Map<string, string>();
      for (const { data, error } of respostas) {
        if (error) throw error;
        for (const p of data ?? []) {
          const nome = p.razao_social || p.name;
          if (p.user_id && nome) nomes.set(p.user_id, nome);
        }
      }
      return nomes;
    },
  });
}

export interface AprovarRepasseArgs {
  comprador: string;
  codigo: number;
  precoAlvo: number;
  validoAte: string;
  /** `repasse_atual.id` que a tela viu (controle de versão da RPC; null = trio sem histórico) */
  substitui: string | null;
}

export function useAprovarRepasse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: AprovarRepasseArgs): Promise<string> => {
      // `p_substitui` NULL = trio sem histórico (DEFAULT NULL na prod): vai explícito, como antes.
      const { data, error } = await supabase.rpc(
        'venda_aprovar_repasse',
        comNulo<'venda_aprovar_repasse', 'p_substitui'>({
          p_comprador: a.comprador,
          p_empresa: 'oben',
          p_codigo: a.codigo,
          p_preco_alvo: a.precoAlvo,
          p_valido_ate: a.validoAte,
          p_substitui: a.substitui,
        }),
      );
      if (error) throw error;
      if (!data) throw new Error('venda_aprovar_repasse não devolveu o id');
      return data;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['venda-repasse-candidatos'] }),
  });
}

export function useRevogarRepasse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.rpc('venda_revogar_repasse', { p_id: id });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['venda-repasse-candidatos'] }),
  });
}

/** Mensagem legível para as recusas conhecidas da RPC (marca no texto do erro do Postgres). */
export function mensagemErroRepasse(e: unknown): string {
  const msg = (e as { message?: string } | null)?.message ?? String(e);
  if (msg.includes('REPASSE_CONFLITO')) return 'Outra aprovação mudou este repasse desde a leitura — recarregue e confira.';
  if (msg.includes('REPASSE_ALVO_ABAIXO')) return 'O último preço praticado subiu: o alvo não fica mais acima dele.';
  if (msg.includes('REPASSE_ALVO_TETO')) return 'Alvo acima de 2× o último preço — confira a digitação.';
  if (msg.includes('REPASSE_SEM_ULTIMO')) return 'Sem último preço praticado provado para este comprador/SKU.';
  if (msg.includes('REPASSE_VALIDADE')) return 'Validade fora do intervalo (amanhã até 1 ano).';
  if (msg.includes('42501') || msg.includes('requer master')) return 'Só o master aprova repasses.';
  return msg;
}
