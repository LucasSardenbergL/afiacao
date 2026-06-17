import { supabase } from '@/integrations/supabase/client';
import type { ReguaPrecoResult } from './types';

export interface ExibicaoReguaPayload {
  account: string;
  customerUserId: string;
  productId: string;
  salespersonId: string;
  quantity: number;
  precoAtual: number;
  cmcUsado: number | null;
  result: ReguaPrecoResult;
}

// A tabela regua_preco_log foi aplicada via SQL Editor do Lovable; os tipos gerados
// (src/integrations/supabase/types.ts) ainda NÃO a conhecem (Lovable só regenera no
// builder visual — NÃO editar à mão). Cast mínimo no padrão do repo (cf. usePrecoCockpit
// `supabase.rpc as never`). Substituir por chamada tipada quando o Lovable regenerar.
type LogValues = Record<string, unknown>;
interface ReguaLogClient {
  from(table: string): {
    insert(values: LogValues): {
      select(columns: string): { single(): Promise<{ data: { id: string } | null; error: unknown }> };
    };
    update(values: LogValues): { eq(column: string, value: string): Promise<{ error: unknown }> };
  };
}
const logClient = supabase as never as ReguaLogClient;

/** INSERT 'pendente' da exibição qualificada. Falha de log NUNCA derruba o carrinho. */
export async function registrarExibicaoRegua(p: ExibicaoReguaPayload): Promise<string | null> {
  const r = p.result;
  const { data, error } = await logClient
    .from('regua_preco_log')
    .insert({
      account: p.account,
      customer_user_id: p.customerUserId,
      product_id: p.productId,
      salesperson_id: p.salespersonId,
      quantity: p.quantity,
      preco_atual: p.precoAtual,
      sinal_exibido: r.sinal,
      confianca: r.confianca,
      preco_referencia: r.precoReferencia,
      observed_gap_pct: r.observedGapPct,
      suggested_gap_pct: r.suggestedGapPct,
      piso_mc: r.pisoMC,
      cap_limitou: r.capLimitou,
      cmc_usado: p.cmcUsado,
      cmc_confianca: r.reasonCodes.includes('cmc_proxy') ? 'proxy' : 'real',
      reason_codes: r.reasonCodes,
      outcome_status: 'pendente',
      aplicou: false,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[regua] log exibição falhou (ignorado):', error);
    return null;
  }
  return data?.id ?? null;
}

/** UPDATE → 'aplicado' quando o vendedor clica Aplicar. */
export async function registrarAplicacaoRegua(logId: string, precoFinal: number): Promise<void> {
  const { error } = await logClient
    .from('regua_preco_log')
    .update({ preco_final: precoFinal, aplicou: true, outcome_status: 'aplicado', outcome_at: new Date().toISOString() })
    .eq('id', logId);
  if (error) console.warn('[regua] log aplicação falhou (ignorado):', error);
}
