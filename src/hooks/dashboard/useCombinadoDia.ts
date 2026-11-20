import { useQueries, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { track } from '@/lib/analytics';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { hojeSP } from '@/lib/dashboard/sp-date';
import { useCobrancaFila } from '@/hooks/useCobranca';
import { lerMinhasSugestoes } from '@/lib/venda-cliente/sugestoes';
import { cobrancasDoDia, recomprasDoDia, montarCombinado, type ItemCombinado } from '@/lib/dashboard/combinado-dia';

const ROLES_VENDEDOR = ['farmer', 'hunter', 'closer'] as const;

export interface CombinadoVendedora {
  id: string;
  nome: string;
  itens: ItemCombinado[];
  /** Fontes que NÃO foram lidas — a lista pode estar incompleta, e vazia não significa "nada a fazer". */
  fontesComErro: string[];
  carregando: boolean;
}

/** Vendedoras reais (commercial_roles) com nome — mesma régua do ranking. Lança em erro. */
function useVendedoras() {
  return useQuery({
    queryKey: ['combinado', 'vendedoras'],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ id: string; nome: string }[]> => {
      const { data: roles, error } = await supabase
        .from('commercial_roles')
        .select('user_id, commercial_role')
        .in('commercial_role', ROLES_VENDEDOR);
      if (error) throw new Error(error.message);
      if (roles == null) throw new Error('commercial_roles: data null sem error');
      const ids = [...new Set(roles.map((r) => r.user_id).filter(Boolean))];
      if (ids.length === 0) return [];
      const { data: profs, error: pErr } = await supabase.from('profiles').select('user_id, name').in('user_id', ids);
      const nomes = new Map<string, string>();
      if (!pErr) for (const p of profs ?? []) if (p.name) nomes.set(p.user_id, p.name);
      return ids
        .map((id) => ({ id, nome: nomes.get(id) ?? (pErr ? 'nome indisponível' : 'Sem nome') }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    },
  });
}

/**
 * O combinado do dia de cada vendedora: cobrança (Oben e Colacor, até 45 dias, dela) + recompra atrasada
 * (`get_venda_sugestoes_for`, master-only no banco). Cada fonte falha sozinha e é DECLARADA — nunca vira
 * "nada a combinar".
 */
export function useCombinadoDia(): { vendedoras: CombinadoVendedora[]; erroVendedoras: boolean; carregando: boolean } {
  const hoje = hojeSP();
  const vend = useVendedoras();
  const oben = useCobrancaFila('oben');
  const colacor = useCobrancaFila('colacor');
  const lista = vend.data ?? [];
  const recompra = useQueries({
    queries: lista.map((v) => ({
      queryKey: ['combinado', 'recompra', v.id],
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const { data, error } = await supabase.rpc('get_venda_sugestoes_for', { p_farmer: v.id });
        if (error) throw error;
        return lerMinhasSugestoes(data);
      },
    })),
  });

  const vendedoras = lista.map((v, k): CombinadoVendedora => {
    const rq = recompra[k];
    const fontesComErro: string[] = [];
    if (oben.isError) fontesComErro.push('cobrança Oben');
    if (colacor.isError) fontesComErro.push('cobrança Colacor');
    if (rq?.isError) fontesComErro.push('recompra');
    const fila = [...(oben.data ?? []), ...(colacor.data ?? [])];
    const cobrancas = cobrancasDoDia(fila, v.id, hoje);
    const recompras = recomprasDoDia(rq?.data?.compradores ?? []);
    return {
      id: v.id,
      nome: v.nome,
      itens: montarCombinado(cobrancas, recompras),
      fontesComErro,
      carregando: oben.isLoading || colacor.isLoading || !!rq?.isLoading,
    };
  });

  return { vendedoras, erroVendedoras: vend.isError, carregando: vend.isLoading };
}

/**
 * Sensor + lista datada no LEDGER (`combinado_dia`, migration 20261120200000): 1 linha por dia e vendedora,
 * `n_copias` soma as re-cópias. NUNCA lança (telemetria não quebra a tela); na lente "Ver como" não grava.
 */
export async function registrarCombinado(vendedoraId: string, itens: ItemCombinado[]): Promise<boolean> {
  if (isLensActive()) return false;
  const payload = itens.map((i) => ({
    tipo: i.tipo,
    empresa: i.empresa,
    cliente_ref: i.clienteRef,
    nome: i.nome,
    valor: i.valor,
  }));
  try {
    const { error } = await supabase.rpc('combinado_registrar', {
      p_vendedora: vendedoraId,
      p_itens: payload as unknown as Json,
    });
    if (error) throw error;
    return true;
  } catch (e) {
    // PostgrestError não é `instanceof Error`, mas tem `message`.
    const msg = (e as { message?: unknown } | null)?.message;
    const motivo = typeof msg === 'string' && msg !== '' ? msg.slice(0, 80) : 'erro sem mensagem';
    track('meu_dia.combinado_sensor_falhou', { motivo });
    console.warn(`[combinado] sensor não gravou (${motivo})`);
    return false;
  }
}
