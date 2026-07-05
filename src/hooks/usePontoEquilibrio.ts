// src/hooks/usePontoEquilibrio.ts
// F3 — Ponto de equilíbrio operacional na DRE (PEGN erro 7).
// Junta 12 snapshots de DRE (competência) + a classificação fixo/variavel/misto/nao_operacional
// (fin_dre_custo_tipo, master-only) e chama o helper PURO pontoEquilibrio. Overlay: NÃO reescreve
// a DRE nem o edge. A classificação é master-only (RLS) → v1 o card é master-gated na UI; widen p/
// staff via RPC SECURITY DEFINER é v2 (spec §7). fin_dre_custo_tipo não está nos tipos gerados →
// cast via unknown (padrão verbatim de useFunding.ts).
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  pontoEquilibrio,
  type MesDRE,
  type TipoCusto,
  type PontoEquilibrioResult,
} from '@/lib/financeiro/ponto-equilibrio-helpers';

const STALE = 5 * 60_000; // snapshot e classificação mudam raramente

export interface CustoTipoRow {
  company: string;
  categoria_codigo: string;
  tipo: TipoCusto;
  observacao: string | null;
}

/** Coerção defensiva do jsonb detalhamento.despesas → Record<codigo, number> (ausente ≠ zero: ignora não-finito). */
function coerceDespesas(d: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (d) {
    for (const [k, v] of Object.entries(d)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** Últimos 12 snapshots de DRE (competência), mapeados p/ MesDRE. */
function useSnapshotsTTM(company: string | null) {
  return useQuery({
    queryKey: ['dre_snapshots_ttm', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<MesDRE[]> => {
      const { data, error } = await supabase
        .from('fin_dre_snapshots')
        .select(
          'ano,mes,receita_bruta,deducoes,cmv,despesas_operacionais,despesas_administrativas,despesas_comerciais,despesas_financeiras,detalhamento',
        )
        .eq('company', company!)
        .eq('regime', 'competencia')
        .order('ano', { ascending: false })
        .order('mes', { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []).map((r): MesDRE => {
        const row = r as unknown as {
          ano: number;
          mes: number;
          receita_bruta: number | null;
          deducoes: number | null;
          cmv: number | null;
          despesas_operacionais: number | null;
          despesas_administrativas: number | null;
          despesas_comerciais: number | null;
          despesas_financeiras: number | null;
          detalhamento: { despesas?: Record<string, unknown> } | null;
        };
        return {
          ano: row.ano,
          mes: row.mes,
          receita_bruta: Number(row.receita_bruta ?? 0),
          deducoes_col: Number(row.deducoes ?? 0),
          despesas: coerceDespesas(row.detalhamento?.despesas),
          linha_cmv: Number(row.cmv ?? 0),
          linha_operacionais: Number(row.despesas_operacionais ?? 0),
          linha_administrativas: Number(row.despesas_administrativas ?? 0),
          linha_comerciais: Number(row.despesas_comerciais ?? 0),
          linha_financeiras: Number(row.despesas_financeiras ?? 0),
        };
      });
    },
  });
}

/** Linhas da classificação (company + _default, company vence). fin_dre_custo_tipo é master-only. */
function useClassificacaoRows(company: string | null) {
  return useQuery({
    queryKey: ['dre_custo_tipo', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<CustoTipoRow[]> => {
      // cast via unknown: tabela master-only fora dos tipos gerados (padrão de useFunding.ts).
      const client = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            in: (
              col: string,
              vals: string[],
            ) => Promise<{ data: CustoTipoRow[] | null; error: { message: string } | null }>;
          };
        };
      };
      const { data, error } = await client
        .from('fin_dre_custo_tipo')
        .select('company,categoria_codigo,tipo,observacao')
        .in('company', [company!, '_default']);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
  });
}

/** Resolve as linhas em Record<codigo, tipo> (company específico sobrepõe _default). */
function resolverClassificacao(rows: CustoTipoRow[], company: string | null): Record<string, TipoCusto> {
  const out: Record<string, TipoCusto> = {};
  for (const r of rows) if (r.company === '_default') out[r.categoria_codigo] = r.tipo;
  for (const r of rows) if (r.company === company) out[r.categoria_codigo] = r.tipo; // sobrepõe
  return out;
}

/** Hook principal: o resultado do ponto de equilíbrio (ou o motivo de degradação). */
export function usePontoEquilibrio(company: string | null) {
  const snaps = useSnapshotsTTM(company);
  const classif = useClassificacaoRows(company);
  const isLoading = snaps.isLoading || classif.isLoading;
  const error = snaps.error ?? classif.error;

  const data = useMemo<PontoEquilibrioResult | null>(() => {
    if (!snaps.data || !classif.data) return null;
    return pontoEquilibrio({
      meses: snaps.data,
      classificacao: resolverClassificacao(classif.data, company),
    });
  }, [snaps.data, classif.data, company]);

  return { data, isLoading, error, meses: snaps.data ?? [] };
}

export interface CategoriaClassificar {
  codigo: string;
  descricao: string;
  valorTTM: number;
  pctDespesas: number;
  tipo: TipoCusto | null;
  observacao: string | null;
}

/** Lista rankeada (maior valor primeiro) das categorias de despesa p/ o master classificar. */
export function useDreCategoriasClassificar(company: string | null): {
  categorias: CategoriaClassificar[];
  isLoading: boolean;
} {
  const snaps = useSnapshotsTTM(company);
  const classif = useClassificacaoRows(company);
  const cats = useQuery({
    queryKey: ['fin_categorias_desc', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('fin_categorias')
        .select('omie_codigo,descricao')
        .eq('company', company!);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const r of (data ?? []) as unknown as { omie_codigo: string; descricao: string | null }[]) {
        if (r.omie_codigo) out[r.omie_codigo] = r.descricao ?? '';
      }
      return out;
    },
  });

  const categorias = useMemo<CategoriaClassificar[]>(() => {
    if (!snaps.data) return [];
    const porCodigo = new Map<string, number>();
    for (const m of snaps.data) for (const [cod, v] of Object.entries(m.despesas)) porCodigo.set(cod, (porCodigo.get(cod) ?? 0) + v);
    const total = [...porCodigo.values()].reduce((a, b) => a + b, 0);
    const tipoDe = new Map<string, { tipo: TipoCusto; observacao: string | null }>();
    for (const r of classif.data ?? []) if (r.company === '_default') tipoDe.set(r.categoria_codigo, { tipo: r.tipo, observacao: r.observacao });
    for (const r of classif.data ?? []) if (r.company === company) tipoDe.set(r.categoria_codigo, { tipo: r.tipo, observacao: r.observacao });
    const descPorCod = cats.data ?? {};
    return [...porCodigo.entries()]
      .map(([codigo, valorTTM]) => ({
        codigo,
        descricao: descPorCod[codigo] ?? '',
        valorTTM,
        pctDespesas: total > 0 ? valorTTM / total : 0,
        tipo: tipoDe.get(codigo)?.tipo ?? null,
        observacao: tipoDe.get(codigo)?.observacao ?? null,
      }))
      .sort((a, b) => b.valorTTM - a.valorTTM);
  }, [snaps.data, classif.data, cats.data, company]);

  return { categorias, isLoading: snaps.isLoading || classif.isLoading || cats.isLoading };
}

/** Salva (upsert) a classificação de uma categoria. Master-only (RLS). updated_by/at pelo trigger. */
export function useSalvarDreClassificacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      company: string;
      categoria_codigo: string;
      tipo: TipoCusto;
      observacao?: string | null;
    }) => {
      const client = supabase as unknown as {
        from: (t: string) => {
          upsert: (
            values: Record<string, unknown>,
            options: { onConflict: string },
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
      const { error } = await client.from('fin_dre_custo_tipo').upsert(
        {
          company: vars.company,
          categoria_codigo: vars.categoria_codigo,
          tipo: vars.tipo,
          observacao: vars.observacao ?? null,
        },
        { onConflict: 'company,categoria_codigo' },
      );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['dre_custo_tipo', vars.company] });
      qc.invalidateQueries({ queryKey: ['fin_categorias_desc', vars.company] });
      toast.success('Classificação salva. Recalculando o ponto de equilíbrio…');
    },
    onError: (e) => {
      toast.error('Falha ao salvar classificação', {
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });
}
