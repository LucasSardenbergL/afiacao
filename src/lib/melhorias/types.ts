// src/lib/melhorias/types.ts
// Tipos do canal interno de Melhorias (sugestões/problemas com triagem por IA).
// A edge function `melhoria-triagem` espelha os helpers que consomem estes tipos.

export type MelhoriaTipo = 'problema' | 'sugestao' | 'pergunta';
export type MelhoriaUrgencia = 'baixa' | 'media' | 'alta';
export type MelhoriaStatus = 'aberto' | 'em_andamento' | 'resolvido' | 'descartado';
export type MelhoriaTriagemStatus = 'pendente' | 'ok' | 'erro';
export type MelhoriaPapel = 'funcionario' | 'ia' | 'founder';

export const MELHORIA_MODULOS = [
  'vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'afiacao',
  'whatsapp', 'rota', 'tarefas', 'producao', 'governanca', 'outro',
] as const;
export type MelhoriaModulo = (typeof MELHORIA_MODULOS)[number];

/** Máximo de mensagens do funcionário por item (1 inicial + 5 réplicas). */
export const MAX_MENSAGENS_FUNCIONARIO = 6;

export interface MelhoriaItem {
  id: string;
  autor_user_id: string;
  empresa: string;
  rota_origem: string | null;
  tipo: MelhoriaTipo | null;
  urgencia: MelhoriaUrgencia | null;
  modulo: string | null;
  titulo: string | null;
  status: MelhoriaStatus;
  triagem_status: MelhoriaTriagemStatus;
  avaliacao_founder: string | null;
  resposta_founder: string | null;
  resolvido_em: string | null;
  created_at: string;
  updated_at: string;
}

export interface MelhoriaMensagem {
  id: string;
  item_id: string;
  autor_user_id: string | null;
  papel: MelhoriaPapel;
  conteudo: string;
  dados: MelhoriaDados | null;
  created_at: string;
}

/** Resultado das ferramentas de dados executadas pela edge (renderizado como tabela). */
export interface MelhoriaDados {
  tools: Array<{
    tool: 'clientes_por_produto' | 'produtos_relacionados';
    input: Record<string, unknown>;
    resultado: unknown;
  }>;
}

/** Output validado da tool `triar` da IA. */
export interface TriagemValidada {
  tipo: MelhoriaTipo;
  urgencia: MelhoriaUrgencia;
  modulo: MelhoriaModulo;
  titulo: string;
  resposta_ao_funcionario: string;
  avaliacao_founder: string;
}
