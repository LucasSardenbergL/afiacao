// src/hooks/useAntecipacoes.ts
// F4 — camada de dados (react-query). fin_antecipacoes é master-only (RLS) e NÃO está nos tipos
// gerados → cast through unknown (molde verbatim de useEndividamento.ts; ESLint barra `any`).
// Soft delete: UPDATE deleted_at (nunca DELETE — preserva histórico de custo). Hurdle-sugestão
// derivada do F1 (fin_dividas.cet_aa ponderado pelo saldo devedor em aberto — fallback, P1-3).
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { sugerirHurdle } from '@/lib/financeiro/antecipacao-helpers';
import { saldoDevedorEmAberto } from '@/lib/financeiro/endividamento-helpers';
import { useDividas, useParcelas } from '@/hooks/useEndividamento';
import type { Antecipacao, Company, HurdleSugerido } from '@/lib/financeiro/antecipacao-types';

const STALE = 60_000;

// ─── Shapes mínimos do client (cast através de unknown, sem `any`) ──────────────────────────────
type SelectClient = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        order: (
          col: string,
          o?: { ascending?: boolean },
        ) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
};
type UpsertClient = {
  from: (t: string) => {
    upsert: (
      v: Record<string, unknown>,
      o?: { onConflict: string },
    ) => Promise<{ error: { message: string } | null }>;
  };
};
type UpdateClient = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/** Operações vivas (deleted_at IS NULL) de uma empresa, mais recentes primeiro. */
export function useAntecipacoes(company: Company | string) {
  return useQuery({
    queryKey: ['antecipacoes', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Antecipacao[]> => {
      const client = supabase as unknown as SelectClient;
      const { data, error } = await client
        .from('fin_antecipacoes')
        .select('*')
        .eq('company', company as string)
        .order('data_operacao', { ascending: false });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Antecipacao[]).filter((a) => a.deleted_at == null);
    },
  });
}

/** Insert (sem id) ou update (com id). Trigger cuida de created_by/updated_by/at. */
export function useUpsertAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (op: Partial<Antecipacao> & { company: Company }) => {
      const client = supabase as unknown as UpsertClient;
      const { error } = await client.from('fin_antecipacoes').upsert({ ...op }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] });
      toast.success('Operação salva.');
    },
    onError: (e) =>
      toast.error('Falha ao salvar operação', {
        description: e instanceof Error ? e.message : String(e),
      }),
  });
}

/** Soft delete: marca deleted_at (não apaga — preserva histórico de custo). */
export function useSoftDeleteAntecipacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; company: Company }) => {
      const client = supabase as unknown as UpdateClient;
      const { error } = await client
        .from('fin_antecipacoes')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['antecipacoes', v.company] });
      toast.success('Operação removida.');
    },
    onError: (e) =>
      toast.error('Falha ao remover operação', {
        description: e instanceof Error ? e.message : String(e),
      }),
  });
}

/** Hurdle-sugestão a partir do custo médio ponderado do CET das dívidas do F1 (fallback com unidade). */
export function useHurdleSugerido(company: Company | string): HurdleSugerido {
  const { data: dividas } = useDividas(company);
  const dividaIds = useMemo(() => (dividas ?? []).map((d) => d.id), [dividas]);
  const { data: parcelas } = useParcelas(dividaIds);
  return useMemo<HurdleSugerido>(() => {
    if (!dividas) return { valor: null, unidade: null, motivo: 'sem_dados' };
    return sugerirHurdle(
      dividas
        .filter((d) => d.ativo)
        .map((d) => ({ saldo: saldoDevedorEmAberto(d, parcelas ?? []), cet_aa: d.cet_aa })),
    );
  }, [dividas, parcelas]);
}
