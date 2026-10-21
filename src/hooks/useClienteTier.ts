import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { Tier } from '@/lib/pricing/precoPartida';

export type Conta = 'oben' | 'colacor';

export type TierPorConta = { oben: Tier | null; colacor: Tier | null };
export type MultConfig = { oben: Partial<Record<Tier, number>>; colacor: Partial<Record<Tier, number>> };

const ehTier = (t: string): t is Tier => t === 'A' || t === 'B' || t === 'C';

/**
 * Tier comercial A/B/C do cliente por conta (cliente_tier_preco). Staff-readable — o
 * badge orienta o vendedor. Ausência de tier na conta → null (comportamento vigente).
 * O types tipa `tier` como `string` (CHECK no banco) → estreita por `ehTier`; valor fora de
 * A/B/C vira ausente, nunca um tier inventado.
 */
export function useClienteTier(customerUserId: string | null | undefined) {
  return useQuery<TierPorConta>({
    queryKey: ['cliente-tier', customerUserId ?? null],
    enabled: !!customerUserId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cliente_tier_preco')
        .select('company, tier')
        .eq('customer_user_id', customerUserId as string);
      if (error) throw error;
      const out: TierPorConta = { oben: null, colacor: null };
      for (const row of data ?? []) {
        if ((row.company === 'oben' || row.company === 'colacor') && ehTier(row.tier)) out[row.company] = row.tier;
      }
      return out;
    },
  });
}

/**
 * Multiplicador de partida por conta×tier (tier_preco_config). Staff-readable: a partida
 * é função pura no browser do vendedor e precisa do mult. Valor inválido/ausente é
 * OMITIDO (nunca vira 0 — money-path: ausente ≠ zero; precoPartida degrada p/ tabela pura).
 */
export function useTierPrecoConfig() {
  return useQuery<MultConfig>({
    queryKey: ['tier-preco-config'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('tier_preco_config').select('company, tier, mult_partida');
      if (error) throw error;
      const out: MultConfig = { oben: {}, colacor: {} };
      for (const row of data ?? []) {
        if ((row.company !== 'oben' && row.company !== 'colacor') || !ehTier(row.tier)) continue;
        const m = Number(row.mult_partida);
        if (Number.isFinite(m) && m > 0) out[row.company][row.tier] = m;
      }
      return out;
    },
  });
}

export interface DefinirTierInput {
  company: Conta;
  customerUserId: string;
  tier: Tier;
  motivo?: string | null;
}

/**
 * Define/atualiza o tier de um cliente numa conta (upsert em cliente_tier_preco).
 * RLS exige pode_ver_carteira_completa (só gestor/master). `definido_por` vai no payload
 * mas é FORÇADO pelo trigger anti-forje no servidor (= auth.uid()) — o valor daqui é só
 * para satisfazer o NOT NULL; jamais é a fonte de verdade do autor. Sem sessão não há autor
 * (e a RLS recusaria): falha aqui, antes da rede.
 */
export function useDefinirTier() {
  const qc = useQueryClient();
  const { user } = useAuth(); // SEMPRE o usuário real (escrita/identidade) — nunca a lente "Ver como"
  return useMutation({
    mutationFn: async (input: DefinirTierInput) => {
      if (!user?.id) throw new Error('Sessão ausente: não há autor para definir o tier.');
      const row = {
        company: input.company,
        customer_user_id: input.customerUserId,
        tier: input.tier,
        motivo: input.motivo?.trim() || null,
        definido_por: user.id,
      };
      const { error } = await supabase.from('cliente_tier_preco').upsert(row, { onConflict: 'company,customer_user_id' });
      if (error) throw error;
    },
    onSuccess: (_data, input) => {
      qc.invalidateQueries({ queryKey: ['cliente-tier', input.customerUserId] });
    },
  });
}
