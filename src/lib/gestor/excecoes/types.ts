// src/lib/gestor/excecoes/types.ts
// GestorBuddy — console de exceções (v1 determinístico). Tipos puros.

export type FrescorCarteira = 'fresh' | 'stale' | 'desatualizada';
export type GrupoKey = 'dados_quebrados' | 'clientes_risco' | 'confirmacoes_pendentes';
export type Severidade = 'critico' | 'aviso' | 'info';

export type AcaoExcecao =
  | { tipo: 'abrir_cliente'; clienteUserId: string }
  | { tipo: 'tarefa'; tarefaId: string; clienteUserId: string | null; candidatoId: string | null }
  | { tipo: 'rodar_agente' }
  | { tipo: 'nenhum' };

export interface LinhaExcecao {
  id: string;            // chave estável de render
  grupo: GrupoKey;
  titulo: string;
  detalhe: string | null;
  donoNome: string | null;       // vendedor dono (quando aplicável)
  severidade: Severidade;
  reciboFonte: string;           // 'ai_decisions' | 'data_health' | 'v_tarefas_estado'
  reciboFrescor: string | null;  // "calculada há 30h" | "há 2d" | null (fresco)
  acao: AcaoExcecao;
  badges: string[];              // ex.: ["também há tarefa pendente"]
}

export interface GrupoExcecao {
  key: GrupoKey;
  titulo: string;
  linhas: LinhaExcecao[];
}

export interface ConsoleExcecoes {
  grupos: GrupoExcecao[];   // só grupos não-vazios, em ordem de dependência
  totalLinhas: number;
  excedente: number;        // "+N exceções" cortadas pelo teto total
  vazio: boolean;           // true → empty-state honesto
}

// ── entradas normalizadas (vêm do hook, já com nomes resolvidos) ──────
export interface DecisaoRiscoInput {
  id: string;
  clienteUserId: string;
  clienteNome: string | null;
  donoNome: string | null;
  primaryReason: string;
  confidence: string;            // 'alta' | 'media' | 'baixa' (string crua da tabela)
  atrasoRelativo: number | null;
  faturamento90d: number | null;
  faturamentoPrev90d: number | null;
}
export interface SaudeCheckInput {
  source: string;
  domain: string;
  status: 'ok' | 'stale' | 'broken' | 'unknown';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  ageSeconds: number | null;
}
export interface TarefaGapInput {
  tarefaId: string;
  descricao: string;
  clienteUserId: string | null;
  donoNome: string | null;
  effectiveDue: string;          // 'yyyy-mm-dd'
  candidatoId: string | null;    // p/ ação Confirmar/Rejeitar (null se não houver)
}
export interface ExcecoesInput {
  decisoes: DecisaoRiscoInput[];
  decisoesMaxCreatedAtIso: string | null; // max(created_at) das pending → frescor
  saude: SaudeCheckInput[];
  tarefas: TarefaGapInput[];
  hojeSp: string;                // spBusinessDate(now) — 'yyyy-mm-dd'
  agoraIso: string;              // now ISO (idade do ai_decisions)
}

export interface ExcecoesCfg {
  capClientes: number;        // 5
  capTarefas: number;         // 3
  capWarnSaude: number;       // 3 (critical é ilimitado)
  totalMax: number;           // 10
  staleHoras: number;         // 24  (fresh < 24h)
  desatualizadaHoras: number; // 48  (stale 24-48h; > 48h = desatualizada)
}
export const EXCECOES_CFG_DEFAULT: ExcecoesCfg = {
  capClientes: 5, capTarefas: 3, capWarnSaude: 3, totalMax: 10, staleHoras: 24, desatualizadaHoras: 48,
};
