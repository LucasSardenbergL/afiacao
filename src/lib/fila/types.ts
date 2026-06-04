// src/lib/fila/types.ts
// Formato comum de "ação sugerida" da fila do Meu Dia (G1). Forward-compatible
// com a futura tabela materializada `suggested_actions`.

export type CategoriaAcao = 'prazo' | 'certo' | 'esperado' | 'risco';
export type FonteAcao = 'tarefa' | 'rota' | 'whatsapp_pendente' | 'mixgap';
export type TipoValor = 'certo' | 'estimado' | 'sem_valor';
export type TipoCta = 'ligar' | 'whatsapp' | 'pedido' | 'tarefa' | 'abrir_cliente';

export type AcaoPayload =
  | { kind: 'tarefa'; tarefaId: string }
  | { kind: 'rota'; customerUserId: string; dataRota: string; bucket: string | null; valor: number | null }
  | { kind: 'mixgap'; customerUserId: string; familia: string }
  | { kind: 'whatsapp'; conversationId: string };

export interface AcaoSugerida {
  fonte: FonteAcao;
  /** id da entidade no motor de origem (tarefa.id, customer_user_id, conversation.id, etc.) */
  entidadeId: string;
  clienteUserId: string | null;
  clienteNome: string | null;
  telefone: string | null;
  /** verbo curto exibido no card: "Ligar", "Responder", "Oferecer", "Cobrar" */
  acao: string;
  titulo: string;
  /** "por que isto apareceu" — sempre presente (anti-dashboard-vazio) */
  motivo: string;
  categoria: CategoriaAcao;
  /** prioridade DENTRO da categoria, [0,1] */
  score: number;
  /** R$ estimado quando a fonte tem; null quando não há */
  valorEsperado: number | null;
  tipoValor: TipoValor;
  /** qual execução o botão "Fazer" dispara */
  cta: TipoCta;
  /** colapsa duplicatas do mesmo cliente+intenção entre fontes */
  dedupeKey: string;
  /** dados estruturais p/ o CTA de outcome chamar o motor de origem (Codex P1) */
  payload: AcaoPayload;
}
