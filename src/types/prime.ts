// Prime Colacor — tipos do domínio (PR-2 admin mínimo).
// Espelham a migration 20260711090000_prime_fundacao.sql (aplicada em prod).
// As tabelas prime_* ainda NÃO estão nos tipos gerados do Supabase — quando o
// types.ts for regenerado, migrar para Tables<'prime_planos'> etc. e apagar isto.
// Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7

export type PrimeAssinaturaStatus = 'ativa' | 'suspensa' | 'cancelada';

export type PrimeBeneficioTipo =
  | 'afiacao_dentes'
  | 'bonus_dentes'
  | 'desconto_abrasivo'
  | 'atendimento_tecnico'
  | 'prioridade_entrega'
  | 'prioridade_separacao'
  | 'coleta_rota';

/** Tipos que monetizam no extrato (exigem valor_tabela > 0 + referência Omie). */
export const PRIME_TIPOS_MONETIZAVEIS: readonly PrimeBeneficioTipo[] = [
  'afiacao_dentes',
  'desconto_abrasivo',
] as const;

export interface PrimePlano {
  id: string;
  nome: string;
  preco_mensal: number;
  franquia_dentes: number;
  /** Descritivo/copy dos benefícios (lista de strings). NÃO é sinal money-path. */
  beneficios: string[];
  ativo: boolean;
  created_at: string;
  updated_at: string;
}

export interface PrimeAssinatura {
  id: string;
  customer_user_id: string;
  plano_id: string;
  /** Congelado na adesão (grandfathering — imutável por trigger). */
  preco_contratado: number;
  /** Congelada na adesão (grandfathering — imutável por trigger). */
  franquia_dentes_contratada: number;
  status: PrimeAssinaturaStatus;
  data_inicio: string;
  data_fim: string | null;
  suspensa_em: string | null;
  observacao: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PrimeBeneficioUso {
  id: string;
  assinatura_id: string;
  tipo: PrimeBeneficioTipo;
  quantidade: number;
  /** NULL em operacional/bônus (ausente ≠ zero — nunca fabricar R$). */
  valor_tabela: number | null;
  /** R$/dente vigente na concessão (só afiacao_dentes). */
  preco_unitario_snapshot: number | null;
  /** Sempre dia 1 do mês (CHECK no banco). */
  competencia: string;
  /** Nº do pedido/NF Omie que lastreia (obrigatório em monetizável). */
  referencia: string | null;
  descricao: string | null;
  created_by: string;
  created_at: string;
  estornado_em: string | null;
  estornado_por: string | null;
}

/** Payload de INSERT em prime_beneficio_uso (colunas geradas ficam de fora). */
export interface PrimeBeneficioUsoInsert {
  assinatura_id: string;
  tipo: PrimeBeneficioTipo;
  quantidade: number;
  valor_tabela: number | null;
  preco_unitario_snapshot: number | null;
  competencia: string;
  referencia: string | null;
  descricao: string | null;
  created_by: string;
}

/** Linha da view v_prime_extrato_mensal (security_invoker). */
export interface PrimeExtratoMensal {
  assinatura_id: string;
  customer_user_id: string;
  status: PrimeAssinaturaStatus;
  competencia: string;
  /** Contrato — NUNCA "pago" (não há fato de pagamento na v1). */
  mensalidade_contratada: number;
  /** NULL quando não há registro monetizável no mês (≠ 0 fabricado). */
  monetizado_total: number | null;
  dentes_usados: number | null;
  dentes_bonus: number | null;
  franquia_total: number;
  dentes_restantes: number;
  dentes_excedentes: number;
  usos_operacionais: number;
  n_registros: number;
}

export const PRIME_TIPO_LABEL: Record<PrimeBeneficioTipo, string> = {
  afiacao_dentes: 'Afiação (dentes)',
  bonus_dentes: 'Bônus cross-sell (dentes)',
  desconto_abrasivo: 'Desconto abrasivo',
  atendimento_tecnico: 'Atendimento técnico',
  prioridade_entrega: 'Prioridade de entrega',
  prioridade_separacao: 'Prioridade de separação',
  coleta_rota: 'Coleta na rota',
};

export const PRIME_STATUS_LABEL: Record<PrimeAssinaturaStatus, string> = {
  ativa: 'Ativa',
  suspensa: 'Suspensa',
  cancelada: 'Cancelada',
};

/** Badge classes por status — tokens do DS v3 (nunca cor tailwind crua). */
export const PRIME_STATUS_CLASSES: Record<PrimeAssinaturaStatus, string> = {
  ativa: 'bg-status-success-bg text-status-success border-transparent',
  suspensa: 'bg-status-warning-bg text-status-warning border-transparent',
  cancelada: 'bg-muted text-muted-foreground border-transparent',
};

/**
 * R$/dente de tabela vigente (spec §1: preço de tabela da afiação R$1,20).
 * Default do form de concessão — o staff pode ajustar; o banco congela o snapshot
 * por linha (contrafactual auditável da época).
 */
export const PRECO_DENTE_TABELA = 1.2;

/** Teto do bônus cross-sell por concessão (spec §5 — CHECK no banco). */
export const BONUS_DENTES_TETO = 50;
