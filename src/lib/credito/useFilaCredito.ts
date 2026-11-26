// Hooks da fila de crédito (crédito-IA PR 6a). Leitura gestor/master pela RLS; escrita só pelas
// RPCs do aprovador (credito_decidir_fila / credito_definir_enforcement — o servidor recusa o resto).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { fetchAllPages } from '@/lib/postgrest';
import { ordenarFila, type Empresa, type ItemFila, type Prontidao } from './fila';

// Tabelas/views novas ainda fora do types.ts gerado: cliente sem tipagem só aqui.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const EMPRESAS: Empresa[] = ['oben', 'colacor', 'colacor_sc'];

export interface FlagEnforcement {
  company: Empresa;
  ligado: boolean;
  versao: number;
  alterado_em: string | null;
  motivo: string | null;
}

export function useFilaCredito() {
  return useQuery({
    queryKey: ['credito', 'fila'],
    queryFn: async (): Promise<ItemFila[]> => {
      // A sombra cobre 14 d (≈ 180 pedidos hoje): paginação canônica (lança em página falha).
      const todos = await fetchAllPages<ItemFila>(
        (de, ate) =>
          db.from('credito_fila_v').select('*')
            .order('criado_em', { ascending: true }).order('item_id', { ascending: true })
            .range(de, ate),
        'credito_fila_v',
      );
      return ordenarFila(todos);
    },
    refetchInterval: 60_000,
  });
}

/** Contador do menu: solicitações EFETIVAS abertas. Erro → undefined (badge some, não vira 0). */
export function useContagemFilaCredito(enabled: boolean) {
  return useQuery({
    queryKey: ['credito', 'fila', 'contagem'],
    enabled,
    queryFn: async (): Promise<number> => {
      const { count, error } = await db
        .from('credito_fila_v')
        .select('item_id', { count: 'exact', head: true })
        .eq('origem', 'efetivo')
        .eq('status', 'aberta');
      if (error) throw error;
      if (typeof count !== 'number') throw new Error('contagem da fila não veio');
      return count;
    },
    refetchInterval: 60_000,
  });
}

export function useFlagsEnforcement() {
  return useQuery({
    queryKey: ['credito', 'enforcement'],
    queryFn: async (): Promise<FlagEnforcement[]> => {
      const { data, error } = await db
        .from('credito_enforcement')
        .select('company, ligado, versao, alterado_em, motivo')
        .order('company');
      if (error) throw error;
      return (data ?? []) as FlagEnforcement[];
    },
  });
}

export function useProntidao(company: Empresa) {
  return useQuery({
    queryKey: ['credito', 'prontidao', company],
    queryFn: async (): Promise<Prontidao> => {
      const { data, error } = await db.rpc('credito_enforcement_prontidao', { p_company: company });
      if (error) throw error;
      return data as Prontidao;
    },
  });
}

export function useSouAprovador() {
  return useQuery({
    queryKey: ['credito', 'sou-aprovador'],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await db.rpc('credito_sou_aprovador');
      if (error) throw error;
      return data === true;
    },
  });
}

export function useDecidirFila() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { solicitacaoId: string; autorizar: boolean; motivo: string; discordouDaIa: boolean }) => {
      const { error } = await db.rpc('credito_decidir_fila', {
        p_solicitacao_id: v.solicitacaoId,
        p_autorizar: v.autorizar,
        p_motivo: v.motivo.trim(),
        p_validade_horas: 24,
      });
      if (error) throw error;
      return v;
    },
    onSuccess: (v) => {
      track('credito.fila_decidir', { autorizar: v.autorizar, discordou_da_ia: v.discordouDaIa });
      toast.success(v.autorizar ? 'Pedido autorizado (vale 24 h para esta revisão)' : 'Pedido recusado');
      qc.invalidateQueries({ queryKey: ['credito'] });
    },
    onError: (e: Error) => toast.error(`Não foi possível decidir: ${e.message}`),
  });
}

export function useDefinirEnforcement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { company: Empresa; ligar: boolean; motivo: string }) => {
      const { error } = await db.rpc('credito_definir_enforcement', {
        p_company: v.company,
        p_ligar: v.ligar,
        p_motivo: v.motivo.trim(),
      });
      if (error) throw error;
      return v;
    },
    onSuccess: (v) => {
      track('credito.enforcement_definir', { company: v.company, ligar: v.ligar });
      toast.success(`Enforcement ${v.ligar ? 'LIGADO' : 'desligado'} na ${v.company}`);
      qc.invalidateQueries({ queryKey: ['credito'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
