// src/hooks/useEndividamento.ts
// F1 Módulo de Endividamento — camada de dados (react-query).
// As tabelas fin_dividas / fin_divida_parcelas / fin_divida_completude são master-only (RLS)
// e NÃO estão nos tipos gerados do Supabase → cast through unknown (padrão verbatim de useFunding.ts;
// shape mínimo por operação, sem `any` — o ESLint barra `any`).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Divida, Parcela, Company } from '@/lib/financeiro/endividamento-types';

const STALE = 60_000;

// ─── Shapes mínimos do client (cast através de unknown) ──────────────────────────

type SelectClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        order: (col: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
        maybeSingle: () => Promise<{ data: unknown | null; error: { message: string } | null }>;
      };
      in: (col: string, vals: string[]) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

type UpsertClient = {
  from: (table: string) => {
    upsert: (
      values: Record<string, unknown> | Record<string, unknown>[],
      options?: { onConflict: string },
    ) => Promise<{ error: { message: string } | null }>;
  };
};

type InsertDeleteClient = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>[]) => Promise<{ error: { message: string } | null }>;
    delete: () => {
      eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

// ─── Queries ─────────────────────────────────────────────────────────────────────

/** Dívidas de uma empresa (select * de fin_dividas, ordenado por credor). */
export function useDividas(company: Company | string) {
  return useQuery({
    queryKey: ['endividamento', company, 'dividas'],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Divida[]> => {
      const client = supabase as unknown as SelectClient;
      const { data, error } = await client
        .from('fin_dividas')
        .select('*')
        .eq('company', company)
        .order('credor');
      if (error) throw new Error(error.message);
      return (data ?? []) as Divida[];
    },
  });
}

/** Parcelas de um conjunto de dívidas (.in divida_id). Desabilitado sem ids. */
export function useParcelas(dividaIds: string[]) {
  return useQuery({
    queryKey: ['endividamento', 'parcelas', [...dividaIds].sort()],
    enabled: dividaIds.length > 0,
    staleTime: STALE,
    queryFn: async (): Promise<Parcela[]> => {
      const client = supabase as unknown as SelectClient;
      const { data, error } = await client
        .from('fin_divida_parcelas')
        .select('*')
        .in('divida_id', dividaIds);
      if (error) throw new Error(error.message);
      return (data ?? []) as Parcela[];
    },
  });
}

/** Completude do cadastro da empresa. Ausente → { completo: false } (fail-closed money-path). */
export function useCompletude(company: Company | string) {
  return useQuery({
    queryKey: ['endividamento', company, 'completude'],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<{ completo: boolean }> => {
      const client = supabase as unknown as SelectClient;
      const { data, error } = await client
        .from('fin_divida_completude')
        .select('completo')
        .eq('company', company)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const row = data as { completo?: boolean } | null;
      return { completo: row?.completo === true };
    },
  });
}

// ─── Mutations ─────────────────────────────────────────────────────────────────────

function invalidate(qc: ReturnType<typeof useQueryClient>, company: string) {
  qc.invalidateQueries({ queryKey: ['endividamento', company] });
  qc.invalidateQueries({ queryKey: ['endividamento', 'parcelas'] });
}

/** Insert (sem id) ou update (com id) de uma dívida. */
export function useUpsertDivida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (divida: Partial<Divida> & { company: Company }) => {
      const client = supabase as unknown as UpsertClient;
      const { error } = await client
        .from('fin_dividas')
        .upsert({ ...divida, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success('Dívida salva.');
    },
    onError: (e) => {
      toast.error('Falha ao salvar dívida', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

/** Exclui a dívida (as parcelas caem por FK cascade no banco). */
export function useDeleteDivida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; company: Company }) => {
      const client = supabase as unknown as InsertDeleteClient;
      const { error } = await client.from('fin_dividas').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success('Dívida excluída.');
    },
    onError: (e) => {
      toast.error('Falha ao excluir dívida', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

/** Substitui todas as parcelas de uma dívida: apaga as atuais e insere as novas. */
export function useReplaceParcelas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      dividaId,
      parcelas,
    }: {
      dividaId: string;
      company: Company;
      parcelas: Array<Omit<Parcela, 'id' | 'divida_id'>>;
    }) => {
      const client = supabase as unknown as InsertDeleteClient;
      const del = await client.from('fin_divida_parcelas').delete().eq('divida_id', dividaId);
      if (del.error) throw new Error(del.error.message);
      if (parcelas.length > 0) {
        const rows = parcelas.map((p) => ({ ...p, divida_id: dividaId }));
        const ins = await client.from('fin_divida_parcelas').insert(rows);
        if (ins.error) throw new Error(ins.error.message);
      }
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
    },
    onError: (e) => {
      toast.error('Falha ao salvar parcelas', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

/** Marca/desmarca o cadastro de endividamento da empresa como completo. */
export function useSetCompletude() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, completo }: { company: Company; completo: boolean }) => {
      const client = supabase as unknown as UpsertClient;
      const { error } = await client.from('fin_divida_completude').upsert(
        { company, completo, validado_em: new Date().toISOString() },
        { onConflict: 'company' },
      );
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      invalidate(qc, vars.company);
      toast.success(vars.completo ? 'Cadastro marcado como completo.' : 'Cadastro reaberto.');
    },
    onError: (e) => {
      toast.error('Falha ao atualizar completude', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}
