// Slug de acoes_execucoes desta tela. Escritor: frontend (useMutationComRegistro) —
// o cron tint-marcar-bases-diario roda OUTRA ação (tint_marcar_bases_mixmachine), sem
// sobreposição com o sync de produtos. Um escritor por slug (CLAUDE.md §Design System).
export const ACOES_TINT_IMPORT = {
  sincronizarProdutos: "tint_import.sincronizar_produtos",
} as const;
