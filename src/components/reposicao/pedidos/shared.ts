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
