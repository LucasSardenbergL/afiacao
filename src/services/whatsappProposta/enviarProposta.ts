// Envio da proposta 1-toque (PR-4). Orquestra: cotação JÁ avaliada (travas) → edge
// whatsapp-send-template (ÚNICO caminho de envio — dedupe-first/opt-out/gate provados no PR-1)
// → orçamento `sales_orders status='orcamento'` com o ELO whatsapp_conversation_id (writer
// único que o funil do PR-3 espera). Money-path (endurecido pelo challenge Codex 2026-07-13):
// - proposta travada NÃO passa daqui (guard na fronteira; botão desabilitado é só UX), e as
//   invariantes de linha/total são REVALIDADAS aqui (defesa em profundidade — não confia só
//   em cotacao.travada);
// - preços do orçamento = RECOTADOS agora (jamais ultimoPrecoRef da cesta, que é debug);
// - edge falhou → NADA gravado; mensagem saiu e INSERT falhou → ok com `orcamentoErro`
//   visível (não mentir que o envio falhou — o cliente JÁ recebeu);
// - 409 duplicate: NUNCA re-envia. Send 'queued' = outra aba em voo → erro claro (não é
//   "já enviada" — Codex P1). Send sent/delivered/read sem orçamento → grava agora com
//   nota explícita de pós-retry (os preços são os da recotação ATUAL; a mensagem não cita
//   preços — Codex P1, mitigação mínima documentada);
// - idempotência do orçamento é ATÔMICA no banco: whatsapp_proposta_dedupe UNIQUE
//   (migration 050000) — INSERT direto; 23505 → reusar o existente (Codex P0: o padrão
//   SELECT-então-INSERT por conversa+status+janela criava 2 orçamentos sob concorrência).
// Supabase INJETADO (testável) — mesmo padrão de services/orderSubmission.

import { isValidUnitPrice } from '@/lib/pricing/mergeCustomerPrices';
import type { CotacaoProposta } from '@/lib/whatsapp/proposta-cotacao';
import { montarParamsProposta } from '@/lib/whatsapp/proposta-cotacao';

export const TEMPLATE_PROPOSTA = 'colacor_proposta_recompra';

/** 1 proposta por cliente×rota — retry legítimo (status failed) reusa a MESMA reserva na edge. */
export function dedupeKeyProposta(customerUserId: string, prazoIso: string): string {
  return `proposta:${customerUserId}:${prazoIso}`;
}

/** Subconjunto do client usado aqui (injeção → teste puro; cast no chamador, padrão routeFrom). */
export interface PropostaQueryChain {
  select(cols: string): PropostaQueryChain;
  eq(col: string, v: string): PropostaQueryChain;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
  insert(payload: Record<string, unknown>): PropostaQueryChain;
  single(): Promise<{ data: { id: string } | null; error: { message: string; code?: string } | null }>;
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
  | { ok: false; motivo: 'travada' | 'edge' | 'envio_em_andamento'; detalhe: string };

interface EdgeErrorBody {
  error?: string;
  detail?: string;
  existing?: { id?: string; status?: string; wa_message_id?: string | null };
}

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

/** Defesa em profundidade: revalida as invariantes money-path independentemente do avaliador. */
function violacaoInvariantes(cotacao: CotacaoProposta): string | null {
  if (cotacao.travada || cotacao.total === null || cotacao.render === null) return 'proposta travada';
  if (!(Number.isFinite(cotacao.total) && cotacao.total > 0)) return 'total inválido';
  for (const l of cotacao.linhas) {
    if (l.motivoTrava !== null) return `linha travada: ${l.nome}`;
    if (!isValidUnitPrice(l.preco)) return `preço inválido: ${l.nome}`;
    if (!(Number.isFinite(l.qtd) && l.qtd > 0)) return `quantidade inválida: ${l.nome}`;
  }
  return null;
}

export async function enviarProposta(params: EnviarPropostaParams): Promise<EnviarPropostaResult> {
  const { supabase, cotacao, prazo } = params;

  const violacao = violacaoInvariantes(cotacao);
  if (violacao) {
    const motivos = [
      ...cotacao.travasGerais,
      ...cotacao.linhas.filter(l => l.motivoTrava).map(l => `${l.nome}: ${l.motivoTrava}`),
    ];
    return { ok: false, motivo: 'travada', detalhe: motivos.join('; ') || violacao };
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
      // Já reservada/enviada pra esta rota — NUNCA re-envia daqui.
      const statusSend = corpo.existing?.status ?? null;
      if (statusSend === 'queued') {
        // Outra aba/tentativa está COM o envio em voo agora — não é "já enviada".
        return { ok: false, motivo: 'envio_em_andamento', detalhe: 'outro envio desta proposta está em andamento — aguarde alguns segundos e recote' };
      }
      if (statusSend === 'failed' || statusSend === null) {
        return { ok: false, motivo: 'edge', detalhe: 'o envio anterior desta proposta falhou — recote e envie de novo (a edge reutiliza a reserva)' };
      }
      // sent/delivered/read: mensagem JÁ foi. Auto-conserto: se o envio anterior gravou o
      // send mas não o orçamento (falha pós-envio), grava agora — com nota de pós-retry.
      const { data: send } = await supabase.from('whatsapp_template_sends')
        .select('conversation_id').eq('dedupe_key', dedupeKey).maybeSingle();
      const conversationId = (send as { conversation_id?: string } | null)?.conversation_id;
      if (!conversationId) {
        return { ok: false, motivo: 'edge', detalhe: 'proposta já enviada, mas o envio original não foi localizado (dedupe sem send legível)' };
      }
      const orc = await garantirOrcamento(params, conversationId, dedupeKey, { posRetry: true });
      return { ok: true, conversationId, jaEnviada: true, orcamentoId: orc.id, orcamentoErro: orc.erro };
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

  const orc = await garantirOrcamento(params, conversationId, dedupeKey, { posRetry: false });
  return { ok: true, conversationId, jaEnviada: false, orcamentoId: orc.id, orcamentoErro: orc.erro };
}

/** Grava o orçamento com o elo — idempotência ATÔMICA pela chave única da proposta
 * (whatsapp_proposta_dedupe UNIQUE, migration 050000): INSERT direto; 23505 → reusar. */
async function garantirOrcamento(
  params: EnviarPropostaParams,
  conversationId: string,
  dedupeKey: string,
  opts: { posRetry: boolean },
): Promise<{ id: string | null; erro: string | null }> {
  const { supabase, cotacao, prazo } = params;

  const items = cotacao.linhas.map(l => ({
    product_id: l.product_id,
    omie_codigo_produto: l.omie_codigo_produto,
    codigo: l.codigo,
    descricao: l.descricao ?? l.nome,
    unidade: l.unidade,
    quantidade: l.qtd,
    // violacaoInvariantes já barrou linha sem preço/qtd — aqui é sempre número válido
    valor_unitario: l.preco as number,
    valor_total: l.qtd * (l.preco as number),
  }));

  const notes = opts.posRetry
    ? `Proposta WhatsApp — entrega ${prazo.label} (orçamento registrado após reenvio: preços desta recotação; a mensagem enviada não citava preços)`
    : `Proposta WhatsApp — entrega ${prazo.label}`;

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
    notes,
    whatsapp_conversation_id: conversationId,
    whatsapp_proposta_dedupe: dedupeKey,
  }).select('id').single();

  if (!insErr && criado) return { id: criado.id, erro: null };

  if (insErr?.code === '23505') {
    // Outra aba/tentativa já gravou — reusar (idempotente, sem duplicar).
    const { data: existente, error: selErr } = await supabase.from('sales_orders')
      .select('id').eq('whatsapp_proposta_dedupe', dedupeKey).maybeSingle();
    const id = (existente as { id?: string } | null)?.id ?? null;
    if (id) return { id, erro: null };
    return { id: null, erro: `orçamento duplicado mas ilegível: ${selErr?.message ?? 'não encontrado'}` };
  }

  return { id: null, erro: insErr?.message ?? 'insert do orçamento falhou' };
}
