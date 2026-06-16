export type TarefaCategoria = 'ligar' | 'oferecer' | 'preco' | 'whatsapp' | 'outro';
export type TarefaModo = 'data' | 'interacao';
export type TarefaInteracaoTipo = 'ligacao' | 'visita' | 'entrega';
export type TarefaAutoSatisfy = 'off' | 'interacao' | 'conteudo';
export type TarefaStatus = 'aberta' | 'concluida' | 'cancelada';
export type TarefaConclusaoOrigem = 'manual' | 'auto_interacao' | 'sugestao_confirmada' | 'whatsapp';

export interface TarefaEstado {
  id: string;
  descricao: string;
  categoria: TarefaCategoria;
  customer_user_id: string;
  assigned_to: string;
  created_by: string;
  empresa: string;
  modo: TarefaModo;
  due_date: string | null;
  interacao_tipo: TarefaInteracaoTipo | null;
  backstop_days: number;
  tolerancia_dias: number;
  adiada_para: string | null;
  motivo_adiamento: string | null;
  auto_satisfy_mode: TarefaAutoSatisfy;
  target_produto_id: string | null;
  target_texto: string | null;
  target_preco_centavos: number | null;
  status: TarefaStatus;
  concluida_em: string | null;
  concluida_por: string | null;
  conclusao_origem: TarefaConclusaoOrigem | null;
  nota_conclusao: string | null;
  escalado_em: string | null;
  // derivados (da view v_tarefas_estado):
  effective_due: string;
  responsavel_efetivo: string;
  atrasada: boolean;
  escalavel: boolean;
  tem_sugestao_pendente: boolean;
}

export interface TarefaCandidato {
  id: string;
  tarefa_id: string;
  source_type: 'farmer_call' | 'route_visit' | 'whatsapp' | 'quote';
  source_id: string | null;
  mode: 'interacao' | 'conteudo';
  confidence: number | null;
  motivo: string | null;
  matched_payload: { entity_type?: string; value?: string; context?: string } | null;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}
