// src/lib/tarefas/voz/types.ts
import type { TarefaCategoria, TarefaModo, TarefaInteracaoTipo } from '../types';

/** Saída CRUA da IA (edge tarefa-extrair-voz) — só strings; NUNCA ids ou datas resolvidas. */
export interface TarefaExtraidaIA {
  evidence_text: string;
  descricao: string;
  categoria_palpite: TarefaCategoria | null;
  cliente_nome_falado: string | null;
  vendedora_nome_falado: string | null;
  raw_date_text: string | null;
  target_texto: string | null;
}

export interface ExtracaoVozIA {
  detectei_n: number;
  texto_nao_coberto: string | null;
  tarefas: TarefaExtraidaIA[];
}

export type StatusData = 'sem_data' | 'resolvida' | 'ambigua' | 'nao_resolvida' | 'passado';
export interface ResultadoData {
  modo: TarefaModo;
  due_date: string | null;          // yyyy-mm-dd
  interacao_tipo: TarefaInteracaoTipo | null;
  status: StatusData;
}

export type StatusMatch = 'unico' | 'ambiguo' | 'sem_match';

export interface ClienteCandidato {
  customer_user_id: string;   // '' se ainda não resolvido (cliente Omie sem perfil local)
  nome: string;
  /** Conta Omie do cliente — usado para derivar a empresa da tarefa. Opcional: candidatos locais podem não ter. */
  empresa_omie?: string | null;
}
export interface MatchCliente {
  customer_user_id: string | null;
  nome: string | null;
  status: StatusMatch;
  candidatos: ClienteCandidato[];
}

export interface VendedoraOpcao { user_id: string; nome: string; }
export interface MatchVendedora {
  user_id: string | null;
  nome: string | null;
  status: StatusMatch;
}

/** 1 card editável na revisão. */
export interface RascunhoVoz {
  evidence_text: string;
  descricao: string;
  categoria: TarefaCategoria;          // default 'outro' se a IA não cravou
  cliente_nome_falado: string | null;
  cliente: MatchCliente | null;        // null até a busca async rodar
  vendedora: MatchVendedora;
  data: ResultadoData;
  target_texto: string | null;
  /** Empresa associada ao card — derivada do cliente quando possível, fallback da prop global. */
  empresa: string;
}

/** Contexto para montar rascunhos a partir da extração da IA. */
export interface CtxMontarRascunhos {
  hojeSP: string;
  vendedoras: VendedoraOpcao[];
  /** Empresa padrão (fallback quando o cliente não tem empresa_omie). */
  empresaPadrao: string;
}
