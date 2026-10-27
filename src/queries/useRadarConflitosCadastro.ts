import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { parsearConflito, type ConflitoCadastro } from '@/lib/radar/conflito-cadastro';
import type { RadarEmpresa } from '@/queries/useRadarLista';

// Conflitos de cadastro Radar×Omie guardados no SERVIDOR (migration 20261027160000). A tela lê daqui — o
// localStorage do lote deixa de ser a única evidência. Erro de leitura é `isError`, nunca "zero conflitos".
const CHAVE = ['radar', 'conflitos-cadastro'] as const;
const TETO = 1000;

/** Conflitos ABERTOS (todos os CNPJs) — o indicador "N CNPJs com pendência Omie". Ordem estável + range (G7). */
export function useRadarConflitosAbertos() {
  return useQuery({
    queryKey: [...CHAVE, 'abertos'],
    queryFn: async (): Promise<ConflitoCadastro[]> => {
      const { data, error } = await supabase
        .from('radar_cadastro_conflitos')
        .select('*')
        .is('resolvido_em', null)
        .order('id', { ascending: true })
        .range(0, TETO - 1);
      if (error) throw error;
      return (data ?? []).map((c) => parsearConflito(c));
    },
  });
}

/**
 * Conflitos (abertos E resolvidos) de um conjunto de CNPJs — a sobreposição do lote (um `divergente` local cujo
 * registro foi resolvido aparece como "conferido"; um item local ok com conflito aberto, como conflito).
 */
export function useRadarConflitosDosCnpjs(cnpjs: string[]) {
  const ordenados = [...new Set(cnpjs)].sort();
  return useQuery({
    queryKey: [...CHAVE, 'cnpjs', ordenados],
    enabled: ordenados.length > 0,
    queryFn: async (): Promise<ConflitoCadastro[]> => {
      const { data, error } = await supabase
        .from('radar_cadastro_conflitos')
        .select('*')
        .in('cnpj', ordenados)
        .order('id', { ascending: true })
        .range(0, TETO - 1);
      if (error) throw error;
      return (data ?? []).map((c) => parsearConflito(c));
    },
  });
}

/** Agrupa por CNPJ (a sobreposição e o indicador contam CNPJs distintos, não registros). */
export function porCnpj(conflitos: ConflitoCadastro[]): Map<string, ConflitoCadastro[]> {
  const m = new Map<string, ConflitoCadastro[]>();
  for (const c of conflitos) m.set(c.cnpj, [...(m.get(c.cnpj) ?? []), c]);
  return m;
}

/** O lead inteiro (para abrir a ficha de um conflito fora da fila — já-cliente, descartado, outra foto). */
export async function lerEmpresaRadar(cnpj: string): Promise<RadarEmpresa | null> {
  const { data, error } = await supabase.from('radar_empresas').select('*').eq('cnpj', cnpj).maybeSingle();
  if (error) throw error;
  return (data as RadarEmpresa | null) ?? null;
}

/**
 * "Conferi no Omie": encerra UM conflito com nota, pela versão que a tela VIU. Ocorrência nova registrada por
 * outra aba depois da leitura → RD004 (o servidor recusa; a tela relê). Resolver não corrige o vínculo.
 */
export function useRadarResolverConflito() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { conflito: ConflitoCadastro; nota: string }) => {
      const { error } = await supabase.rpc('radar_resolver_conflito_cadastro', {
        p_id: v.conflito.id,
        p_versao_vista: v.conflito.versao,
        p_nota: v.nota,
      });
      if (error) throw error;
    },
    onSuccess: (_r, v) => track('radar.conflito_cadastro_resolvido', { motivo: v.conflito.motivo, ocorrencias: v.conflito.ocorrencias }),
    onSettled: () => qc.invalidateQueries({ queryKey: [...CHAVE] }),
  });
}

/** RD004 = o conflito mudou (ou já foi resolvido) desde a leitura. */
export function ehConflitoMudou(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'RD004';
}
