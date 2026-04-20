// Type aliases for fin_* tables & views, plus shared shapes used across
// financeiroService.ts and financeiroV2Service.ts. Centralizing here avoids
// importing the heavy Database type in every consumer.

import type { Database } from "@/integrations/supabase/types";

type Tables = Database["public"]["Tables"];
type Views = Database["public"]["Views"];

// ── Tables ────────────────────────────────────────────────────────────────
export type FinContaCorrenteRow = Tables["fin_contas_correntes"]["Row"];
export type FinContaPagarRow = Tables["fin_contas_pagar"]["Row"];
export type FinContaReceberRow = Tables["fin_contas_receber"]["Row"];
export type FinDreSnapshotRow = Tables["fin_dre_snapshots"]["Row"];
export type FinMovimentacaoRow = Tables["fin_movimentacoes"]["Row"];
export type FinCategoriaRow = Tables["fin_categorias"]["Row"];
export type FinCategoriaDreMappingRow = Tables["fin_categoria_dre_mapping"]["Row"];
export type FinCategoriaDreMappingInsert = Tables["fin_categoria_dre_mapping"]["Insert"];
export type FinFechamentoRow = Tables["fin_fechamentos"]["Row"];
export type FinFechamentoInsert = Tables["fin_fechamentos"]["Insert"];
export type FinFechamentoUpdate = Tables["fin_fechamentos"]["Update"];
export type FinFechamentoLogRow = Tables["fin_fechamento_log"]["Row"];
export type FinFechamentoLogInsert = Tables["fin_fechamento_log"]["Insert"];
export type FinConciliacaoRow = Tables["fin_conciliacao"]["Row"];
export type FinConciliacaoUpdate = Tables["fin_conciliacao"]["Update"];
export type FinEliminacaoRow = Tables["fin_eliminacoes_intercompany"]["Row"];
export type FinEliminacaoInsert = Tables["fin_eliminacoes_intercompany"]["Insert"];
export type FinOrcamentoRow = Tables["fin_orcamento"]["Row"];
export type FinOrcamentoInsert = Tables["fin_orcamento"]["Insert"];
export type FinPermissaoRow = Tables["fin_permissoes"]["Row"];
export type FinPermissaoInsert = Tables["fin_permissoes"]["Insert"];
export type FinSyncLogRow = Tables["fin_sync_log"]["Row"];

// ── Views ─────────────────────────────────────────────────────────────────
export type FinAgingPagarView = Views["fin_aging_pagar"]["Row"];
export type FinAgingReceberView = Views["fin_aging_receber"]["Row"];
export type FinAnaliseCpDimensoesView = Views["fin_analise_cp_dimensoes"]["Row"];
export type FinAnaliseCrDimensoesView = Views["fin_analise_cr_dimensoes"]["Row"];

// Profile lookup (used to enrich permissões with display names)
export type ProfileNameLookup = Pick<Tables["profiles"]["Row"], "user_id" | "name">;
