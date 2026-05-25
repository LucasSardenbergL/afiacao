// Colunas de seleção e helpers de tempo/data do módulo de notificações.
// Extraídos verbatim de src/pages/AdminNotificacoes.tsx (god-component split).

export const SELECT_COLUMNS =
  'id, empresa, fornecedor_nome, tipo, severidade, titulo, mensagem, status, tentativas, criado_em, notificado_em, gmail_message_id, calendar_evento_id, erro_notificacao, metadata, data_evento';

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.round(h / 24);
  return `há ${d}d`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
