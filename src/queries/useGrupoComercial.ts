import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Comercial consolidado do grupo (lê a view v_grupo_comercial): faturamento + recência +
 * tendência por janela (90d vs 90d anterior), somando os documentos nas 3 empresas.
 * Tendência por janela (não intervalo pooled) — regra do Codex. Provada em db/test-grupo-comercial.sh.
 * Cast temporário até a regen de tipos (Task 4).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export interface GrupoComercial {
  documentos_com_compra: number;
  qtd_pedidos: number;
  ultima_compra: string | null;
  dias_desde_ultima: number | null;
  faturamento_total: number;
  fat_90d: number;
  fat_90d_anterior: number;
  media_mensal_6m: number;
}

const ZERO: GrupoComercial = {
  documentos_com_compra: 0, qtd_pedidos: 0, ultima_compra: null, dias_desde_ultima: null,
  faturamento_total: 0, fat_90d: 0, fat_90d_anterior: 0, media_mensal_6m: 0,
};

const num = (v: unknown) => Number(v ?? 0);

export function useGrupoComercial(grupoId: string | undefined) {
  return useQuery({
    queryKey: ['grupo-comercial', grupoId],
    enabled: !!grupoId,
    queryFn: async (): Promise<GrupoComercial> => {
      const { data, error } = await db
        .from('v_grupo_comercial')
        .select('*')
        .eq('grupo_id', grupoId)
        .maybeSingle();
      if (error) throw error;
      const r = data as Record<string, unknown> | null;
      if (!r) return ZERO;
      return {
        documentos_com_compra: num(r.documentos_com_compra),
        qtd_pedidos: num(r.qtd_pedidos),
        ultima_compra: (r.ultima_compra as string) ?? null,
        dias_desde_ultima: r.dias_desde_ultima == null ? null : num(r.dias_desde_ultima),
        faturamento_total: num(r.faturamento_total),
        fat_90d: num(r.fat_90d),
        fat_90d_anterior: num(r.fat_90d_anterior),
        media_mensal_6m: num(r.media_mensal_6m),
      };
    },
  });
}

/** Classifica a tendência do grupo pela janela (90d vs 90d anterior). Sem intervalo pooled. */
export function tendenciaGrupo(c: GrupoComercial): { label: string; tone: 'success' | 'warning' | 'error' | 'muted'; pct: number | null } {
  const { fat_90d, fat_90d_anterior } = c;
  if (fat_90d_anterior === 0 && fat_90d === 0) return { label: 'sem compras recentes', tone: 'muted', pct: null };
  if (fat_90d_anterior === 0) return { label: 'novo / retomando', tone: 'success', pct: null };
  const pct = (fat_90d - fat_90d_anterior) / fat_90d_anterior;
  if (fat_90d < 0.6 * fat_90d_anterior) return { label: 'caindo', tone: 'error', pct };
  if (fat_90d > 1.1 * fat_90d_anterior) return { label: 'subindo', tone: 'success', pct };
  return { label: 'estável', tone: 'muted', pct };
}
