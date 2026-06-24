// Helpers PUROS da camada de CRM da carteira (timeline + SLA).
// Sem dependências de React/Supabase — fáceis de testar isoladamente (vitest).
// Consumidos por: src/components/customer360 (timeline) e src/components/farmer (fila de SLA).

/** Canais normalizados pela view `v_cliente_interacoes` (coluna `canal`). */
export type CanalInteracao =
  | 'ligacao'
  | 'whatsapp'
  | 'visita'
  | 'tarefa'
  | 'mensagem_pedido';

/** "kind" consumido pelo ActivityColumn do Customer360 (ícone + agrupamento visual). */
export type KindInteracao = 'call' | 'message' | 'visit' | 'task';

const LABEL_POR_CANAL: Record<CanalInteracao, string> = {
  ligacao: 'Ligação',
  whatsapp: 'WhatsApp',
  visita: 'Visita',
  tarefa: 'Tarefa',
  mensagem_pedido: 'Mensagem do pedido',
};

const TONE_POR_CANAL: Record<CanalInteracao, string> = {
  ligacao: 'text-status-info',
  whatsapp: 'text-status-success',
  visita: 'text-status-warning',
  tarefa: 'text-muted-foreground',
  mensagem_pedido: 'text-status-info',
};

const KIND_POR_CANAL: Record<CanalInteracao, KindInteracao> = {
  ligacao: 'call',
  whatsapp: 'call',
  visita: 'visit',
  tarefa: 'task',
  mensagem_pedido: 'message',
};

export function canalToLabel(canal: CanalInteracao): string {
  return LABEL_POR_CANAL[canal] ?? 'Interação';
}

export function canalToTone(canal: CanalInteracao): string {
  return TONE_POR_CANAL[canal] ?? 'text-muted-foreground';
}

export function canalToKind(canal: CanalInteracao): KindInteracao {
  return KIND_POR_CANAL[canal] ?? 'message';
}

/** Rótulo humano para "dias sem contato" da fila de SLA. `null` = nunca contatado. */
export function formatDiasSemContato(dias: number | null): string {
  if (dias === null) return 'Nunca contatado';
  if (dias <= 0) return 'Hoje';
  return dias === 1 ? '1 dia' : `${dias} dias`;
}
