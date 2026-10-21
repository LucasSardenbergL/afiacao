// Tipos do módulo de notificações.
// Extraídos verbatim de src/pages/AdminNotificacoes.tsx (god-component split).

import type { Tables } from '@/integrations/supabase/types';

export type Severidade = 'info' | 'atencao' | 'urgente';

type ColunaAlerta =
  | 'id' | 'empresa' | 'fornecedor_nome' | 'tipo' | 'titulo' | 'mensagem' | 'status' | 'tentativas'
  | 'notificado_em' | 'gmail_message_id' | 'calendar_evento_id' | 'erro_notificacao' | 'metadata' | 'data_evento';

/** As colunas de `SELECT_COLUMNS`, com `severidade` estreitada e `criado_em` exigido pela borda. */
export type AlertaRow = Pick<Tables<'fornecedor_alerta'>, ColunaAlerta> & {
  severidade: Severidade;
  criado_em: string;
};

export interface ChartDatum {
  dia: string;
  notificado: number;
  pendente: number;
  falha: number;
}
