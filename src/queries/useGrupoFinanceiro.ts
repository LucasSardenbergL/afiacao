import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Recebível consolidado do grupo (lê as views v_grupo_contas_receber*).
 * As views vêm de produção e somam `saldo` em aberto (status NOT IN RECEBIDO/CANCELADO),
 * aging por data_vencimento, across as 3 empresas. Provadas em db/test-grupo-contas-receber.sh.
 *
 * Cast temporário até a regen de tipos (Task 4) — igual a useClienteGrupos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export interface GrupoFinanceiroResumo {
  total_aberto: number;
  a_vencer: number;
  venc_1_30: number;
  venc_31_60: number;
  venc_61_90: number;
  venc_90_mais: number;
  documentos_com_titulo: number;
}

export interface GrupoFinanceiroPorDoc {
  documento: string;
  company: string | null;
  nome_cliente: string | null;
  total_aberto: number;
  vencido: number;
}

export interface GrupoFinanceiro {
  resumo: GrupoFinanceiroResumo;
  porDoc: GrupoFinanceiroPorDoc[];
}

const ZERO: GrupoFinanceiroResumo = {
  total_aberto: 0, a_vencer: 0, venc_1_30: 0, venc_31_60: 0, venc_61_90: 0, venc_90_mais: 0,
  documentos_com_titulo: 0,
};

const num = (v: unknown) => Number(v ?? 0);

export function useGrupoFinanceiro(grupoId: string | undefined) {
  return useQuery({
    queryKey: ['grupo-financeiro', grupoId],
    enabled: !!grupoId,
    queryFn: async (): Promise<GrupoFinanceiro> => {
      const [resumoRes, porDocRes] = await Promise.all([
        db.from('v_grupo_contas_receber').select('*').eq('grupo_id', grupoId).maybeSingle(),
        db.from('v_grupo_contas_receber_por_doc').select('*').eq('grupo_id', grupoId).order('total_aberto', { ascending: false }),
      ]);
      if (resumoRes.error) throw resumoRes.error;
      if (porDocRes.error) throw porDocRes.error;

      const r = resumoRes.data as Record<string, unknown> | null;
      const resumo: GrupoFinanceiroResumo = r
        ? {
            total_aberto: num(r.total_aberto),
            a_vencer: num(r.a_vencer),
            venc_1_30: num(r.venc_1_30),
            venc_31_60: num(r.venc_31_60),
            venc_61_90: num(r.venc_61_90),
            venc_90_mais: num(r.venc_90_mais),
            documentos_com_titulo: num(r.documentos_com_titulo),
          }
        : ZERO;

      const porDoc: GrupoFinanceiroPorDoc[] = (porDocRes.data ?? [])
        .map((d: Record<string, unknown>) => ({
          documento: String(d.documento ?? ''),
          company: (d.company as string) ?? null,
          nome_cliente: (d.nome_cliente as string) ?? null,
          total_aberto: num(d.total_aberto),
          vencido: num(d.vencido),
        }))
        .filter((d: GrupoFinanceiroPorDoc) => d.total_aberto > 0 || d.company !== null);

      return { resumo, porDoc };
    },
  });
}
