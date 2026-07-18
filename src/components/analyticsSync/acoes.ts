// Slugs de acoes_execucoes desta página. Os de motor/sync_completo são GRAVADOS pela edge
// omie-analytics-sync (manual+cron) — o frontend só LÊ; os de importação (loops client-side)
// são gravados pelo useMutationComRegistro. Um escritor por slug (CLAUDE.md §Design System).
export const ACOES_ANALYTICS_SYNC = {
  importarClientes: "analytics_sync.importar_clientes",
  sincronizarEnderecos: "analytics_sync.sincronizar_enderecos",
  importarPedidosRecentes: "analytics_sync.importar_pedidos_recentes",
  importarPedidosTodos: "analytics_sync.importar_pedidos_todos",
  recalcularCustos: "analytics_sync.recalcular_custos",
  recalcularRegras: "analytics_sync.recalcular_regras",
  syncCompleto: "analytics_sync.sync_completo",
} as const;
