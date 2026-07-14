// Envio da proposta 1-toque (PR-4). Orquestra: cotação JÁ avaliada (travas) → edge
// whatsapp-send-template (ÚNICO caminho de envio — dedupe-first/opt-out/gate provados no PR-1)
// → orçamento `sales_orders status='orcamento'` com o ELO whatsapp_conversation_id (writer
// único que o funil do PR-3 espera). Money-path:
// - proposta travada NÃO passa daqui (guard na fronteira; botão desabilitado é só UX);
// - preços do orçamento = RECOTADOS agora (jamais ultimoPrecoRef da cesta, que é debug);
// - edge falhou → NADA gravado; mensagem saiu e INSERT falhou → ok com `orcamentoErro`
//   visível (não mentir que o envio falhou — o cliente JÁ recebeu);
// - 409 duplicate → nunca re-envia; auto-conserta orçamento órfão de um envio anterior.
// Supabase INJETADO (testável) — mesmo padrão de services/orderSubmission.

import { montarParamsProposta, type CotacaoProposta } from '@/lib/whatsapp/proposta-cotacao';

export const TEMPLATE_PROPOSTA = 'colacor_proposta_recompra';

/** 1 proposta por cliente×rota — retry legítimo (status failed) reusa a MESMA reserva na edge. */
export function dedupeKeyProposta(customerUserId: string, prazoIso: string): string {
  return `proposta:${customerUserId}:${prazoIso}`;
}

/** Subconjunto do client usado aqui (injeção → teste puro; cast no chamador, padrão routeFrom). */
export interface PropostaQueryChain {
  select(cols: string): PropostaQueryChain;
  eq(col: string, v: string): PropostaQueryChain;
  gte(col: string, v: string): PropostaQueryChain;
  limit(n: number): Promise<{ data: Array<{ id: string }> | null; error: { message: string } | null }>;
  maybeSingle(): Promise<{ data: { conversation_id: string } | null; error: { message: string } | null }>;
  insert(payload: Record<string, unknown>): PropostaQueryChain;
  single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
}
export interface SupabaseWhatsappProposta {
  functions: {
    invoke(name: string, opts: { body: Record<string, unknown> }): Promise<{ data: unknown; error: unknown }>;
  };
  from(table: string): PropostaQueryChain;
}

export interface EnviarPropostaParams {
  supabase: SupabaseWhatsappProposta;
  customerUserId: string;
  account: string;
  phoneE164: string;
  primeiroNome: string;
  prazo: { iso: string; label: string };
  cotacao: CotacaoProposta;
  createdBy: string;
  customerDocument: string | null;
}

export type EnviarPropostaResult =
  | { ok: true; conversationId: string; jaEnviada: boolean; orcamentoId: string | null; orcamentoErro: string | null }
  | { ok: false; motivo: 'travada' | 'edge'; detalhe: string };

interface EdgeErrorBody { error?: string; detail?: string }

/** Corpo real do erro da edge (FunctionsHttpError expõe a Response em `context`). */
async function lerCorpoErroEdge(err: unknown): Promise<EdgeErrorBody | null> {
  if (!err || typeof err !== 'object') return null;
  const e = err as { context?: { clone?: () => { json(): Promise<unknown> } } };
  const clone = e.context?.clone;
  if (typeof clone !== 'function') return null;
  try {
    const parsed = await clone.call(e.context).json();
    return parsed && typeof parsed === 'object' ? (parsed as EdgeErrorBody) : null;
  } catch {
    return null; // corpo não-JSON — fallback genérico
  }
}

export async function enviarProposta(params: EnviarPropostaParams): Promise<EnviarPropostaResult> {
  const { supabase, cotacao, prazo } = params;

  // Guard na fronteira: travada/total NULL jamais vira envio nem orçamento.
  if (cotacao.travada || cotacao.total === null) {
    const motivos = [
      ...cotacao.travasGerais,
      ...cotacao.linhas.filter(l => l.motivoTrava).map(l => `${l.nome}: ${l.motivoTrava}`),
    ];
    return { ok: false, motivo: 'travada', detalhe: motivos.join('; ') || 'proposta travada' };
  }

  const dedupeKey = dedupeKeyProposta(params.customerUserId, prazo.iso);
  const bodyParams = montarParamsProposta({
    primeiroNome: params.primeiroNome,
    prazoLabel: prazo.label,
    linhas: cotacao.linhas,
    crossSellOk: cotacao.crossSellOk,
  });

  const { data, error } = await supabase.functions.invoke('whatsapp-send-template', {
    body: {
      templateNome: TEMPLATE_PROPOSTA,
      phoneE164: params.phoneE164,
      dedupeKey,
      bodyParams,
      origem: 'proposta',
    },
  });

  if (error) {
    const corpo = await lerCorpoErroEdge(error);
    if (corpo?.error === 'duplicate') {
      // Já enviada pra esta rota — NUNCA re-envia. Auto-conserto: se o envio anterior
      // gravou o send mas não o orçamento (falha pós-envio), grava o orçamento agora.
      const { data: send } = await supabase.from('whatsapp_template_sends')
        .select('conversation_id').eq('dedupe_key', dedupeKey).maybeSingle();
      if (!send?.conversation_id) {
        return { ok: false, motivo: 'edge', detalhe: 'proposta já enviada, mas o envio original não foi localizado (dedupe sem send legível)' };
      }
      const orc = await garantirOrcamento(params, send.conversation_id);
      return { ok: true, conversationId: send.conversation_id, jaEnviada: true, orcamentoId: orc.id, orcamentoErro: orc.erro };
    }
    const detalhe = corpo?.error
      ? `${corpo.error}${corpo.detail ? ` — ${corpo.detail}` : ''}`
      : (error as { message?: string }).message ?? 'falha ao chamar a edge';
    return { ok: false, motivo: 'edge', detalhe };
  }

  const conversationId = (data as { conversationId?: string } | null)?.conversationId;
  if (!conversationId) {
    // Mensagem pode ter saído; sem o elo não há como gravar o orçamento — falha VISÍVEL.
    return { ok: true, conversationId: '', jaEnviada: false, orcamentoId: null, orcamentoErro: 'edge não retornou conversationId — orçamento não gravado' };
  }

  const orc = await garantirOrcamento(params, conversationId);
  return { ok: true, conversationId, jaEnviada: false, orcamentoId: orc.id, orcamentoErro: orc.erro };
}

/** Cria o orçamento com o elo se ainda não existe um desta conversa nas últimas 24h
 * (idempotência do caminho 409/retry — a janela casa com o dedupe por rota diária). */
async function garantirOrcamento(
  params: EnviarPropostaParams,
  conversationId: string,
): Promise<{ id: string | null; erro: string | null }> {
  const { supabase, cotacao, prazo } = params;

  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: existentes, error: exErr } = await supabase.from('sales_orders')
    .select('id')
    .eq('whatsapp_conversation_id', conversationId)
    .eq('status', 'orcamento')
    .gte('created_at', desde)
    .limit(1);
  if (exErr) return { id: null, erro: `verificação de orçamento falhou: ${exErr.message}` };
  if (existentes && existentes.length > 0) return { id: existentes[0].id, erro: null };

  const items = cotacao.linhas.map(l => ({
    product_id: l.product_id,
    omie_codigo_produto: l.omie_codigo_produto,
    codigo: l.codigo,
    descricao: l.descricao ?? l.nome,
    unidade: l.unidade,
    quantidade: l.qtd,
    // total===null já barrou acima; linha sem preço não chega aqui (travada)
    valor_unitario: l.preco as number,
    valor_total: l.qtd * (l.preco as number),
  }));

  const { data: criado, error: insErr } = await supabase.from('sales_orders').insert({
    customer_user_id: params.customerUserId,
    created_by: params.createdBy,
    items,
    subtotal: cotacao.total,
    total: cotacao.total,
    status: 'orcamento',
    account: params.account,
    customer_document: params.customerDocument,
    customer_phone: params.phoneE164,
    notes: `Proposta WhatsApp — entrega ${prazo.label}`,
    whatsapp_conversation_id: conversationId,
  }).select('id').single();

  if (insErr || !criado) return { id: null, erro: insErr?.message ?? 'insert do orçamento falhou' };
  return { id: criado.id, erro: null };
}
