// 5.2 fatia 2 — "Aceitar o portal": regras da TELA (quando oferecer o botão), leitura da resposta da RPC
// `sayerlack_aceitar_portal` e o re-disparo pelo caminho de sempre (a importadora relê o portal e dispara pelo claim).
// Quem DECIDE é o banco (RPC sob FOR UPDATE); aqui só se evita oferecer o botão onde ele certamente seria recusado.
import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import type { PedidoSugerido } from './types';
import {
  corpoDoErroEdge, interpretarErroEdge, interpretarRespostaImportacao, respostaIndeterminada, statusDoErroEdge,
  type ResultadoTela,
} from './importar-portal';

/** Sem PO = null, vazio ou '0' (a mesma regra da varredura e do banco). */
function semPo(id: string | null | undefined): boolean {
  const v = (id ?? '').trim();
  return v === '' || v === '0';
}

/** Pedido do portal, sem PO, aguardando disparo, com divergência aberta e situação 1 (Aberto) ou 5 (Suspenso). */
export function podeOferecerAceitar(p: PedidoSugerido | null): boolean {
  if (!p) return false;
  const protocolo = (p.portal_protocolo ?? '').trim();
  return (
    p.empresa === 'OBEN' &&
    protocolo !== '' &&
    (p.status === 'aprovado_aguardando_disparo' || p.status === 'falha_envio') &&
    p.status_envio_portal === 'sucesso_portal' &&
    semPo(p.omie_pedido_compra_id) &&
    typeof p.portal_divergencia_aberta_id === 'number' &&
    (p.portal_situacao_codigo === '1' || p.portal_situacao_codigo === '5') &&
    (p.portal_situacao_protocolo ?? '') === protocolo
  );
}

export interface Diferenca { tipo: string; sku: string | null; app: unknown; portal: unknown }

function num(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: 4 }) : String(v);
}

/** Uma linha legível por diferença (o que o humano está aceitando). Tipo desconhecido aparece cru — nunca some. */
export function descreverDiferenca(d: Diferenca): string {
  const sku = d.sku ?? '';
  switch (d.tipo) {
    case 'quantidade': return `${sku}: quantidade ${num(d.app)} → ${num(d.portal)} (no portal)`;
    case 'sku_novo_no_portal': return `${sku}: entrou no portal (${num(d.portal)})`;
    case 'sku_fora_do_portal': return `${sku}: saiu do portal (era ${num(d.app)})`;
    case 'valor_item': return `${sku}: valor ${num(d.app)} → ${num(d.portal)}`;
    case 'valor_total': return `Total: ${num(d.app)} → ${num(d.portal)}`;
    case 'condicao': return `Condição: ${num(d.app)} → ${num(d.portal)}`;
    case 'item_sem_mapa_portal': return `${sku}: item do app sem SKU do portal`;
    case 'pedido_sem_itens': return 'Pedido do app sem itens';
    default: return `${d.tipo}${sku ? ` ${sku}` : ''}: ${num(d.app)} → ${num(d.portal)}`;
  }
}

/** `diferencas` da linha da divergência; forma inesperada = null (a tela diz que não conseguiu ler, nunca "nada"). */
export function lerDiferencas(v: unknown): Diferenca[] | null {
  if (!Array.isArray(v)) return null;
  const out: Diferenca[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object' || typeof (e as { tipo?: unknown }).tipo !== 'string') return null;
    const x = e as Record<string, unknown>;
    out.push({ tipo: x.tipo as string, sku: typeof x.sku === 'string' ? x.sku : null, app: x.app, portal: x.portal });
  }
  return out;
}

export interface LeituraAceita {
  itens: { sku: string; qtde: number; valor: number }[];
  total: number;
  condicao: string;
}

/**
 * A leitura da divergência = o que o pedido PASSA A SER (Codex código P1: sem retrato, o diff mostra só SKU/quantidade
 * e o preço e a condição aceitos ficariam invisíveis). Forma inesperada = null — a tela não deixa aceitar às cegas.
 */
export function lerLeitura(v: unknown): LeituraAceita | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const l = v as Record<string, unknown>;
  if (!Array.isArray(l.itens) || l.itens.length === 0 || typeof l.valor_total !== 'number' || typeof l.condicao !== 'string') return null;
  const itens: LeituraAceita['itens'] = [];
  for (const e of l.itens) {
    const x = e as Record<string, unknown> | null;
    if (!x || typeof x.sku_portal !== 'string' || typeof x.qtde_portal !== 'number' || typeof x.valor_mercadoria !== 'number') return null;
    itens.push({ sku: x.sku_portal, qtde: x.qtde_portal, valor: x.valor_mercadoria });
  }
  return { itens, total: l.valor_total, condicao: l.condicao };
}

const MOTIVOS: Record<string, string> = {
  pedido_nao_encontrado: 'O pedido não existe mais.',
  sem_protocolo_do_portal: 'O pedido não tem protocolo do portal Sayerlack.',
  tem_po: 'O pedido já tem pedido de compra no Omie — nada a aceitar.',
  status_nao_aceitavel: 'O pedido não está mais aguardando disparo.',
  portal_nao_confirmado: 'O portal não confirmou este pedido.',
  disparo_pendente: 'Há uma tentativa de disparo em aberto: o app confere no Omie antes. Tente de novo em alguns minutos.',
  situacao_nao_aceitavel: 'No portal o pedido não está Aberto nem Suspenso (ou a situação não foi lida). Releia o portal.',
  sem_divergencia: 'O pedido já não tem divergência com o portal.',
  divergencia_mudou: 'O portal mudou de novo desde que esta tela abriu. Reabra o pedido e confira as diferenças novas.',
  aguardando_releitura: 'O portal já foi aceito; falta reler o portal para disparar (botão abaixo).',
  po_no_espelho: 'Já existe pedido de compra no Omie com este protocolo (lançado à mão?). Vincule-o pelo importar antes.',
};

type DesfechoAceitar = 'aceito' | 'recusado' | 'erro';
export interface ResultadoAceitar { desfecho: DesfechoAceitar; mensagem: string }

/** Resposta da RPC. Sem contrato reconhecido = "não sei" — nunca "aceito": a tela manda reabrir para conferir. */
export function interpretarRespostaAceitar(data: unknown, erro: { code?: string; message?: string } | null): ResultadoAceitar {
  if (erro) {
    if (erro.code === '42501') return { desfecho: 'recusado', mensagem: 'Só staff aceita o pedido do portal.' };
    if (erro.code === '22023') return { desfecho: 'recusado', mensagem: 'Justificativa de 10 a 1000 caracteres.' };
    if (erro.code === '40001') return { desfecho: 'recusado', mensagem: 'O pedido mudou enquanto aceitava. Reabra e tente de novo.' };
    if (erro.code && /^(IP|CP|AP)0/.test(erro.code)) {
      return { desfecho: 'recusado', mensagem: `A leitura do portal não vira pedido no app (${erro.code}): ${erro.message ?? ''}`.trim() };
    }
    return { desfecho: 'erro', mensagem: `Sem resposta reconhecível do servidor (${erro.message ?? 'erro'}). Reabra o pedido para conferir.` };
  }
  const b = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (b?.aceito === true) return { desfecho: 'aceito', mensagem: 'Pedido atualizado com o que o portal mostra.' };
  if (b?.aceito === false && typeof b.motivo === 'string') {
    return { desfecho: 'recusado', mensagem: MOTIVOS[b.motivo] ?? `Aceite recusado (${b.motivo}).` };
  }
  return { desfecho: 'erro', mensagem: 'Sem resposta reconhecível do servidor. Reabra o pedido para conferir.' };
}

/** Re-disparo pelo caminho de sempre: a importadora RELÊ o portal, confere com o pedido aceito e dispara pelo claim. */
export async function redispararPeloPortal(protocolo: string): Promise<ResultadoTela> {
  try {
    const { data, error } = await supabase.functions.invoke('sayerlack-importar-pedido-portal', { body: { protocolo } });
    if (error) {
      const corpo = await corpoDoErroEdge(error);
      const msg = corpo ? null : await mensagemDoErroEdge(error);
      return interpretarErroEdge(corpo, statusDoErroEdge(error), msg, protocolo, error.message);
    }
    return interpretarRespostaImportacao(data, protocolo);
  } catch (e) {
    return respostaIndeterminada(protocolo, e instanceof Error ? e.message : null);
  }
}
