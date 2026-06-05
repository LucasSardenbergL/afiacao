import type { TarefaCategoria, TarefaEstado } from './types';

// ---------------------------------------------------------------------------
// Cadência / comprovação — tipos literais
// ---------------------------------------------------------------------------
export type TarefaTemplateCadencia = 'diaria' | 'dias_uteis' | 'semanal' | 'dias_especificos';
export type TarefaTipoComprovacao = 'nenhuma' | 'foto' | 'leitura' | 'foto_e_leitura';
export type TarefaAuditoriaStatus =
  | 'nao_requer'
  | 'dispensada'
  | 'pendente'
  | 'aprovada'
  | 'reprovada';

// ---------------------------------------------------------------------------
// TarefaTemplate — espelha `tarefa_templates` no banco
// ---------------------------------------------------------------------------
export interface TarefaTemplate {
  id: string;
  descricao: string;
  categoria: TarefaCategoria;
  area: string;
  empresa: string;
  assigned_to: string;
  customer_user_id: string | null;
  cadencia: TarefaTemplateCadencia;
  /** 0 = domingo … 6 = sábado */
  dias_semana: number[] | null;
  /** HH:MM:SS (time do Postgres) */
  janela_inicio: string | null;
  janela_fim: string | null;
  tolerancia_dias: number;
  requer_comprovacao: boolean;
  tipo_comprovacao: TarefaTipoComprovacao;
  leitura_min: number | null;
  leitura_max: number | null;
  leitura_unidade: string | null;
  alto_risco: boolean;
  /** 0–100 */
  amostra_auditoria_pct: number;
  reincidente_limite: number;
  supervisor_user_id: string | null;
  ativo: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// TarefaInstancia — estende TarefaEstado com campos novos da Fase 2
//
// Os campos abaixo são retornados por v_tarefas_estado após o BLOCO B/C
// do Milestone 1. Campos da Fase 1 já estão em TarefaEstado.
// ---------------------------------------------------------------------------
export interface TarefaInstancia extends TarefaEstado {
  /** UUID do template de origem (null para tarefas manuais). */
  template_id: string | null;
  /** Copiado do template na materialização; false para tarefas manuais. */
  requer_comprovacao: boolean;
  /** Derivado da view: `auditoria_status = 'pendente'` */
  requer_auditoria: boolean;
  auditoria_status: TarefaAuditoriaStatus;
  auditoria_motivo: string | null;
  tipo_comprovacao: TarefaTipoComprovacao | null;
  /** Faixa de leitura denormalizada do template na instância (UI-3) — sem gap de RLS de cobertura. */
  leitura_min: number | null;
  leitura_max: number | null;
  leitura_unidade: string | null;
  /** Leitura numérica anexada na conclusão */
  comprovacao_leitura: number | null;
  /** Timestamptz de quando a prova foi enviada */
  comprovacao_em: string | null;
  /** URL assinada (ou path) da foto no bucket tarefa-comprovacoes */
  comprovacao_url: string | null;
  /** Janela de prazo intradiária (HH:MM:SS) */
  janela_fim: string | null;
  supervisor_user_id: string | null;
}
