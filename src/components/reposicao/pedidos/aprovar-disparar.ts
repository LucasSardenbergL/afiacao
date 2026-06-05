// Trilha de aprovação canônica da Reposição: APROVAR = DISPARAR NA HORA.
//
// Único ponto que encapsula a sequência "aprovar e disparar" — antes inline no
// useDetalhesModal.aprovarMutation e divergente nos caminhos inline (PedidoRow do
// ciclo) e em lote (useCicloHoje), que só faziam UPDATE status='aprovado_aguardando_disparo'
// e ESPERAVAM o cron de corte (o operador achava que tinha disparado; o pedido ficava parado).
//
// Sequência:
//   1. RPC aprovar_pedido_sugerido (flip de status + carimbo de quem aprovou).
//   2. Se a aprovação falha (erro de transporte OU { error } no jsonb de retorno) → curto-circuito,
//      NÃO dispara, retorna erro.
//   3. Invoca a edge disparar-pedidos-aprovados { empresa, pedido_id }.
//      Best-effort: a falha do disparo NÃO reverte a aprovação — o cron de corte (rede de
//      segurança) pega depois e o motor de retry */15 cobre falha transitória do portal.
//      Aprovar e disparar são estados distintos (codex).
//   4. Traduz a resposta da edge com interpretarRespostaDisparo (helper puro existente).
//
// Idempotência do disparo já é tratada upstream (cCodIntPed no Omie + claim do portal):
// re-disparar um pedido já disparado é seguro.
import { supabase as defaultClient } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import { interpretarRespostaDisparo, type RespostaDisparo } from './shared';

export interface AprovarDispararParams {
  pedidoId: number;
  empresa: string;
  usuario: string;
}

export interface AprovarDispararResult {
  ok: boolean;
  tipo: 'success' | 'info' | 'warning' | 'error';
  mensagem: string;
}

// Cliente mínimo injetável (testabilidade). O default é o supabase real.
type AprovarDispararClient = Pick<typeof defaultClient, 'rpc' | 'functions'>;

// Extrai um erro de negócio do jsonb retornado pelo RPC (Returns: Json).
// O RPC pode sinalizar falha de regra de negócio devolvendo { error: '...' } no payload,
// além do erro de transporte do PostgREST.
function erroDoJsonb(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error?: unknown }).error;
    if (e == null) return null;
    return typeof e === 'string' ? e : JSON.stringify(e);
  }
  return null;
}

export async function aprovarEDisparar(
  { pedidoId, empresa, usuario }: AprovarDispararParams,
  client: AprovarDispararClient = defaultClient,
): Promise<AprovarDispararResult> {
  // 1. Aprovação (flip de status). Falha aqui = não dispara.
  const { data: rpcData, error: rpcError } = await client.rpc('aprovar_pedido_sugerido', {
    p_pedido_id: pedidoId,
    p_usuario: usuario,
  });
  if (rpcError) {
    logger.error('Erro ao aprovar pedido (RPC)', { error: rpcError, pedidoId });
    return { ok: false, tipo: 'error', mensagem: `Erro ao aprovar: ${rpcError.message}` };
  }
  const erroNegocio = erroDoJsonb(rpcData);
  if (erroNegocio) {
    logger.error('Aprovação recusada pela regra de negócio (jsonb error)', { erro: erroNegocio, pedidoId });
    return { ok: false, tipo: 'error', mensagem: `Erro ao aprovar: ${erroNegocio}` };
  }

  // 2. APROVAR = DISPARAR NA HORA. Best-effort: falha do disparo não reverte a aprovação.
  try {
    const { data: dd, error: de } = await client.functions.invoke('disparar-pedidos-aprovados', {
      body: { empresa, pedido_id: pedidoId },
    });
    if (de) throw de;
    const feedback = interpretarRespostaDisparo(dd as RespostaDisparo, pedidoId);
    // feedback.tone === 'info' ("nada a disparar") é DE PROPÓSITO um desfecho ok:true:
    // a aprovação valeu e re-disparar algo já enviado é idempotente (no-op seguro).
    // Só feedback.tone === 'error' (disparados:0 + falhas>0, ex.: rejeição do Omie) é
    // falha síncrona do disparo — propagada como { ok:true, tipo:'error' } (aprovado, mas o
    // envio falhou; o lote conta isso como erro, não como sucesso).
    return { ok: true, tipo: feedback.tone, mensagem: feedback.message };
  } catch (e) {
    logger.error('Pedido aprovado, mas o disparo imediato falhou (cron de corte assume)', { error: e, pedidoId });
    return {
      ok: true,
      tipo: 'warning',
      mensagem:
        'Pedido aprovado. O envio automático não saiu agora — será reprocessado pela rede de segurança (ou use "Disparar").',
    };
  }
}
