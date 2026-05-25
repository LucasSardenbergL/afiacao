// Tipos do módulo de notificações.
// Extraídos verbatim de src/pages/AdminNotificacoes.tsx (god-component split).

export type Severidade = 'info' | 'atencao' | 'urgente';

export type AlertaRow = {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  tipo: string;
  severidade: Severidade;
  titulo: string;
  mensagem: string | null;
  status: string | null;
  tentativas: number | null;
  criado_em: string;
  notificado_em: string | null;
  gmail_message_id: string | null;
  calendar_evento_id: string | null;
  erro_notificacao: string | null;
  metadata: Record<string, unknown> | null;
  data_evento: string | null;
};

export interface ChartDatum {
  dia: string;
  notificado: number;
  pendente: number;
  falha: number;
}
