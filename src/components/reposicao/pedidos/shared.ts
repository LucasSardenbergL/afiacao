import { format } from 'date-fns';
import type { StatusEnvioPortal } from './types';

export function getEstoqueZoneClass(estoque: number, minimo: number, pp: number): string {
  if (estoque < minimo) return 'text-status-error font-semibold';
  if (estoque <= pp) return 'text-status-warning font-semibold';
  return 'text-status-success';
}

export const EMPRESA = 'OBEN';

export const statusMeta: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className?: string }> = {
  pendente_aprovacao: { label: 'Pendente', variant: 'secondary', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  aprovado_aguardando_disparo: { label: 'Aprovado', variant: 'secondary', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  bloqueado_guardrail: { label: 'Bloqueado', variant: 'destructive' },
  disparado: { label: 'Disparado', variant: 'secondary', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  disparado_simulado: { label: 'Disparo simulado', variant: 'secondary', className: 'bg-muted text-muted-foreground border-border' },
  falha_envio: { label: 'Falha no envio', variant: 'destructive' },
  cancelado: { label: 'Cancelado', variant: 'outline' },
  cancelado_humano: { label: 'Cancelado (vazio)', variant: 'outline' },
  expirado_sem_aprovacao: { label: 'Expirado sem aprovação', variant: 'secondary', className: 'bg-muted text-muted-foreground border-border' },
  // PR5: pedido pai de um split — não tem mais itens próprios, foi dividido em filhos.
  split_em_filhos: { label: 'Dividido', variant: 'secondary', className: 'bg-status-purple-bg text-status-purple-foreground border-status-purple/30' },
};

export function formatBRL(v: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v ?? 0));
}

export function formatTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'HH:mm');
  } catch {
    return '—';
  }
}

/* ─── Feedback do disparo (compartilhado entre o botão "Disparar" e o "Aprovar e disparar") ─── */
export interface RespostaDisparo {
  disparados?: number | null;
  falhas?: number | null;
  aguardando_portal_sayerlack?: number | null;
}

// Traduz a resposta da edge disparar-pedidos-aprovados num toast.
// O disparo do portal Sayerlack é assíncrono (202 + processamento em background):
// nesse caso a mensagem diz "iniciado", NUNCA "enviado" — o terminal (sucesso/falha)
// aparece na linha do pedido, que atualiza sozinha.
export function interpretarRespostaDisparo(
  data: RespostaDisparo | null | undefined,
  pedidoId: number,
): { tone: 'success' | 'error' | 'info'; message: string } {
  const ok = data?.disparados ?? 0;
  const fail = data?.falhas ?? 0;
  const aguardandoPortal = data?.aguardando_portal_sayerlack ?? 0;
  if (ok > 0) {
    return { tone: 'success', message: `Pedido #${pedidoId} disparado e registrado no Omie` };
  }
  if (aguardandoPortal > 0) {
    return { tone: 'success', message: `Pedido #${pedidoId}: envio ao portal Sayerlack iniciado — acompanhe o status na lista (atualiza sozinho)` };
  }
  if (fail > 0) {
    return { tone: 'error', message: `Pedido #${pedidoId}: falha ao disparar` };
  }
  return { tone: 'info', message: `Pedido #${pedidoId}: nada a disparar` };
}

/* ─── Conciliação inline (Fase 3 · 3b) ─── */
//
// O pedido cai num estado de conciliação quando o disparo ao portal Sayerlack termina
// AMBÍGUO. Dois estados, com risco DIFERENTE de PO duplicado no fornecedor:
//
//  - aceito_portal_sem_protocolo → o portal aceitou mas não devolveu o número.
//    O pedido quase-certamente JÁ EXISTE no fornecedor; conciliar (só registrar o
//    protocolo) é de baixo risco.
//  - indeterminado_requer_conciliacao → AMBÍGUO; o pedido pode ou NÃO existir no
//    portal. Conciliar às cegas pode duplicar → exige conferir no portal ANTES.
//
// Estados de erro genuíno (no fluxo portal-first o portal falhou ANTES de obter
// protocolo, então NÃO há PO no fornecedor) → reenviar é seguro (retry de verdade).
// Estados de sucesso / em-trânsito → reenviar duplicaria; não oferecer reset.

export type AcaoPortal =
  | { kind: 'conciliar'; warn: boolean } // warn=true → avisar risco de duplicar antes de conciliar
  | { kind: 'reenviar' } // erro genuíno sem PO criado → retry seguro
  | { kind: 'nenhuma' }; // sucesso / em-trânsito / nao_aplicavel → nenhuma ação destrutiva

const STATUS_CONCILIAVEIS_FRONT: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'aceito_portal_sem_protocolo',
  'indeterminado_requer_conciliacao',
]);

// Erros genuínos onde (no fluxo portal-first) NÃO há PO no fornecedor → reset seguro.
const STATUS_REENVIO_SEGURO_FRONT: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'erro_retentavel',
  'falha_envio_portal',
  'erro_nao_retentavel',
]);

// Decide a ação disponível no PortalDrawer p/ um status de envio ao portal.
// indeterminado_requer_conciliacao → conciliar com AVISO (risco de duplicar).
// aceito_portal_sem_protocolo → conciliar sem aviso (PO quase-certamente já existe).
export function decidirAcaoPortal(status: StatusEnvioPortal | null | undefined): AcaoPortal {
  const s = (status ?? 'nao_aplicavel') as StatusEnvioPortal;
  if (STATUS_CONCILIAVEIS_FRONT.has(s)) {
    return { kind: 'conciliar', warn: s === 'indeterminado_requer_conciliacao' };
  }
  if (STATUS_REENVIO_SEGURO_FRONT.has(s)) {
    return { kind: 'reenviar' };
  }
  return { kind: 'nenhuma' };
}

/* ─── "Precisa de atenção" — fila cross-ciclo (Fase 3 · 3c) ─── */
//
// Pedidos que EXIGEM ação humana, em QUALQUER ciclo (a lista "ciclo de hoje" não
// pega pedido travado de ciclo passado). Dois grupos:
//
//  - status='falha_envio' → o disparo ao Omie falhou (motivo em resposta_canal.erro).
//    Precisa re-disparar ou corrigir (ex.: SKU sem custo).
//  - status_envio_portal em {aceito_portal_sem_protocolo, indeterminado_requer_conciliacao,
//    falha_envio_portal, erro_nao_retentavel} → conciliação (PO pode existir no
//    fornecedor) + falhas duras do portal (definitiva / sem retry automático).
//
// NÃO inclui pendente_envio_portal/enviando_portal (drenados pelo motor de retry +
// já vigiados pelo Sentinela — incluí-los falsearia pedido em voo) nem erro_retentavel
// (o motor sayerlack-retry-orfaos re-tenta sozinho).
export const STATUS_PORTAL_PRECISA_ATENCAO: ReadonlySet<StatusEnvioPortal> = new Set<StatusEnvioPortal>([
  'aceito_portal_sem_protocolo',
  'indeterminado_requer_conciliacao',
  'falha_envio_portal',
  'erro_nao_retentavel',
]);

// Predicado puro: o pedido precisa de ação humana? (usado pela fila cross-ciclo da
// tela de pedidos — o chip "⚠ N precisam de atenção").
export function pedidoPrecisaAtencao(p: {
  status: string;
  status_envio_portal: StatusEnvioPortal | null | undefined;
}): boolean {
  if (p.status === 'falha_envio') return true;
  return STATUS_PORTAL_PRECISA_ATENCAO.has((p.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal);
}

/* ─── Portal B2B status meta ─── */
export const portalStatusMeta: Record<StatusEnvioPortal, { label: string; className: string }> = {
  nao_aplicavel: { label: '—', className: 'bg-muted text-muted-foreground border-border' },
  pendente_envio_portal: { label: 'Aguardando envio', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  enviando_portal: { label: 'Enviando…', className: 'bg-status-info/20 text-status-info border-status-info/40 animate-pulse' },
  erro_retentavel: { label: 'Retentável', className: 'bg-status-info/15 text-status-info border-status-info/30' },
  enviado_portal: { label: '✓ Enviado', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  sucesso_portal: { label: '✓ Enviado', className: 'bg-status-success/15 text-status-success border-status-success/30' },
  aceito_portal_sem_protocolo: { label: 'Sem protocolo', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  indeterminado_requer_conciliacao: { label: 'Requer conciliação', className: 'bg-status-warning/15 text-status-warning border-status-warning/30' },
  falha_envio_portal: { label: 'Falha', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  erro_nao_retentavel: { label: 'Falha definitiva', className: 'bg-destructive/15 text-destructive border-destructive/30' },
};
