import { supabase } from '@/integrations/supabase/client';
import type { ReguaPrecoResult } from './types';

export interface ExibicaoReguaPayload {
  account: string;
  customerUserId: string;
  productId: string;
  quantity: number;
  precoAtual: number;
  prazoDias: number[] | null;
  result: ReguaPrecoResult;
}

/**
 * Writers do closed-loop — FU4-F fase 2: RPC `SECURITY DEFINER`, não mais `.insert()` direto.
 *
 * ⚠️ POR QUE A TROCA ERA OBRIGATÓRIA (e não só uma preferência de estilo): a fase fecha a LEITURA
 * de `regua_preco_log` (as colunas piso_mc/cmc_usado/aliquota_usada são custo). Só trocar a policy
 * quebraria o log EM SILÊNCIO — o `.insert().select('id')` de antes exigia policy de SELECT para o
 * PostgREST devolver a linha; o Postgres passaria a ERRAR, e o `console.warn` abaixo engoliria o
 * erro. O outcome pararia de ser registrado sem nenhum sintoma visível.
 *
 * As RPCs também fecham o forjamento: `salesperson_id` é fixado em `auth.uid()` DENTRO do banco
 * (não é parâmetro), e as colunas de custo são apuradas lá — o cliente não as recebe mais, então
 * não teria como informá-las de forma confiável.
 *
 * Não estão nos tipos gerados (o Lovable só regenera no builder visual — NÃO editar à mão),
 * daí o cast mínimo no padrão do repo (cf. usePrecoCockpit `supabase.rpc as never`).
 */
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpcClient = supabase as unknown as RpcClient;

/** Registra a exibição qualificada ('pendente'). Falha de log NUNCA derruba o carrinho. */
export async function registrarExibicaoRegua(p: ExibicaoReguaPayload): Promise<string | null> {
  const r = p.result;
  const { data, error } = await rpcClient.rpc('registrar_exibicao_regua', {
    p_account: p.account,
    p_customer_user_id: p.customerUserId,
    p_product_id: p.productId,
    p_quantity: p.quantity,
    p_preco_atual: p.precoAtual,
    p_sinal_exibido: r.sinal,
    p_confianca: r.confianca,
    p_preco_referencia: r.precoReferencia,
    p_observed_gap_pct: r.observedGapPct,
    p_suggested_gap_pct: r.suggestedGapPct,
    p_cap_limitou: r.capLimitou,
    p_reason_codes: r.reasonCodes,
    // os dias vão junto p/ o servidor reproduzir EXATAMENTE o piso que gerou este sinal —
    // sem eles, o log gravaria o piso à vista e a evidência divergiria do que a tela mostrou.
    p_prazo_dias: p.prazoDias,
  });
  if (error) {
    console.warn('[regua] log exibição falhou (ignorado):', error);
    return null;
  }
  return typeof data === 'string' ? data : null;
}

/** Fecha o loop → 'aplicado'. O banco só aceita do PRÓPRIO vendedor que gerou o registro. */
export async function registrarAplicacaoRegua(logId: string, precoFinal: number): Promise<void> {
  const { error } = await rpcClient.rpc('registrar_aplicacao_regua', {
    p_log_id: logId,
    p_preco_final: precoFinal,
  });
  if (error) console.warn('[regua] log aplicação falhou (ignorado):', error);
}
