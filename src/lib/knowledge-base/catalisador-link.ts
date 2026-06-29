/**
 * Helper puro + tipos para o casamento catalisador_codigo ↔ SKU Omie (venda assistida — Fatia 3).
 *
 * Contratos de backend (migration 20260629150000_kb_catalisador_links.sql, já em prod):
 *   - Tabela `kb_catalisador_links` (staff SELECT) — (catalisador_codigo_norm, account, omie_codigo_produto)
 *   - Fn `kb_normalizar_catalisador(text)` IMMUTABLE — UPPER + só alfanumérico
 *   - RPC `confirmar_catalisador_vinculo(p_catalisador_codigo text, p_skus jsonb)` → int (master)
 *   - RPC `desvincular_catalisador(p_account text, p_omie_codigo_produto bigint, p_expected_norm text)` → int (master)
 *
 * ⚠️ View/tabela/RPCs novas NÃO estão no types.ts gerado → cast `as never` nos callsites.
 */

/**
 * Espelha o SQL `public.kb_normalizar_catalisador`: UPPER + só alfanumérico.
 * ⚠️ TEM que casar byte-a-byte com a fn SQL — a chave GRAVADA (no confirmar) e a chave do
 * LOOKUP (no selo) passam por aqui; divergir vazaria/perderia o casamento (money-path).
 * `FC.6975` e `FC 6975` → `FC6975`. Multi-código/free-text → algo que não casa SKU → "sob consulta".
 */
export function normalizarCatalisador(codigo: string | null | undefined): string {
  return (codigo ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Chave estável do mapa de catalisador: `norm|conta` (conta minúscula). */
export function keyDeCatalisador(norm: string, account: string | null | undefined): string {
  return `${norm}|${(account ?? '').toLowerCase()}`;
}

/** Linha do merge kb_catalisador_links ↔ omie_products (codigo/descricao = null se SKU sumiu). */
export interface CatalisadorLink {
  catalisador_codigo_norm: string;
  account: string;
  omie_codigo_produto: number;
  codigo: string | null;
  descricao: string | null;
}
