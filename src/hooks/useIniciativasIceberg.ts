// src/hooks/useIniciativasIceberg.ts
// Painel Iceberg de iniciativas (programa "back to basics"): portfólio de
// iniciativas de melhoria com ganho esperado (pipeline maturando, "abaixo da
// linha d'água") × ganho recorrente comprovado ("acima"). O método: ganho só
// conta quando vira RECORRENTE com evidência registrada (CHECK no banco).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { Database } from '@/integrations/supabase/types';

export type IniciativaIceberg = Database['public']['Tables']['gov_iniciativas']['Row'];
export type NovaIniciativa = Omit<
  Database['public']['Tables']['gov_iniciativas']['Insert'],
  'id' | 'created_by' | 'created_at' | 'updated_at'
>;
export type PatchIniciativa = Omit<
  Database['public']['Tables']['gov_iniciativas']['Update'],
  'id' | 'created_by' | 'created_at' | 'updated_at'
>;

export const STATUS_INICIATIVA = {
  ideia: 'Ideia',
  em_execucao: 'Em execução',
  maturando: 'Maturando',
  recorrente: 'Recorrente',
  pausada: 'Pausada',
  cancelada: 'Cancelada',
} as const;
export type StatusIniciativa = keyof typeof STATUS_INICIATIVA;

export const ALAVANCA_INICIATIVA = {
  receita: 'Receita',
  margem: 'Margem',
  custo: 'Custo',
  caixa: 'Caixa',
  risco: 'Risco',
  outro: 'Outro',
} as const;

/** Status que compõem o pipeline "abaixo da linha d'água" (ganho ainda não comprovado). */
export const STATUS_PIPELINE: readonly StatusIniciativa[] = ['ideia', 'em_execucao', 'maturando'];

export interface ResumoIceberg {
  /**
   * R$/mês recorrente COMPROVADO (só status 'recorrente' com valor registrado).
   * null = há recorrentes mas NENHUMA com valor — sem dado não se fabrica R$0
   * (achado Codex P1); 0 só para conjunto vazio ou zeros de verdade.
   */
  recorrenteMensal: number | null;
  /** Recorrentes sem valor registrado — não somam (ausente ≠ zero), ficam contadas. */
  recorrentesSemValor: number;
  /** R$/mês esperado no pipeline. null = há pipeline mas nenhuma com estimativa. */
  pipelineMensal: number | null;
  /** Iniciativas de pipeline sem estimativa — não somam, ficam contadas. */
  pipelineSemEstimativa: number;
  porStatus: Record<StatusIniciativa, number>;
  total: number;
}

function isStatusIniciativa(s: string): s is StatusIniciativa {
  return Object.prototype.hasOwnProperty.call(STATUS_INICIATIVA, s);
}

/** Cômputo puro dos KPIs do iceberg (testável sem Supabase). */
export function resumirIceberg(iniciativas: IniciativaIceberg[]): ResumoIceberg {
  const porStatus = Object.fromEntries(
    Object.keys(STATUS_INICIATIVA).map((s) => [s, 0]),
  ) as Record<StatusIniciativa, number>;

  let somaRecorrente = 0;
  let recorrentesComValor = 0;
  let recorrentesSemValor = 0;
  let somaPipeline = 0;
  let pipelineComEstimativa = 0;
  let pipelineSemEstimativa = 0;

  for (const i of iniciativas) {
    if (!isStatusIniciativa(i.status)) continue; // status fora do vocabulário: não fabricar
    porStatus[i.status] += 1;

    if (i.status === 'recorrente') {
      if (i.ganho_recorrente_mensal != null) {
        somaRecorrente += i.ganho_recorrente_mensal;
        recorrentesComValor += 1;
      } else {
        recorrentesSemValor += 1;
      }
    } else if (STATUS_PIPELINE.includes(i.status)) {
      if (i.ganho_esperado_mensal != null) {
        somaPipeline += i.ganho_esperado_mensal;
        pipelineComEstimativa += 1;
      } else {
        pipelineSemEstimativa += 1;
      }
    }
  }

  // Bucket habitado sem NENHUM valor conhecido → null (não fabricar R$0).
  const recorrenteMensal =
    porStatus.recorrente > 0 && recorrentesComValor === 0 ? null : somaRecorrente;
  const totalPipeline = STATUS_PIPELINE.reduce((n, s) => n + porStatus[s], 0);
  const pipelineMensal = totalPipeline > 0 && pipelineComEstimativa === 0 ? null : somaPipeline;

  return {
    recorrenteMensal,
    recorrentesSemValor,
    pipelineMensal,
    pipelineSemEstimativa,
    porStatus,
    total: iniciativas.length,
  };
}

const PAGE = 1000;

/** Pagina além da capa silenciosa de 1.000 linhas do PostgREST (KPIs somam — nunca truncar). */
async function fetchIniciativas(): Promise<IniciativaIceberg[]> {
  const out: IniciativaIceberg[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('gov_iniciativas')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as IniciativaIceberg[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const QUERY_KEY = ['gov-iniciativas'] as const;

export function useIniciativasIceberg() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchIniciativas,
    staleTime: 60_000,
  });
}

export function useIniciativaMutations() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });

  const criar = useMutation({
    mutationFn: async (payload: NovaIniciativa) => {
      const { error } = await supabase
        .from('gov_iniciativas')
        .insert({ ...payload, created_by: user?.id ?? null });
      if (error) throw new Error(error.message);
    },
    onSettled: invalidate,
  });

  const atualizar = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: PatchIniciativa }) => {
      const { error } = await supabase.from('gov_iniciativas').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: invalidate,
  });

  const excluir = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('gov_iniciativas').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },
    onSettled: invalidate,
  });

  return { criar, atualizar, excluir };
}
