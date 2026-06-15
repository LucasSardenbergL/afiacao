/**
 * Helper puro + tipos para o casamento boletim técnico ↔ SKU Omie.
 *
 * Contratos de backend (já existem em produção — não criar migration):
 *   - View `v_omie_product_current_spec` (staff RLS)
 *   - RPC `buscar_skus_candidatos(p_termos: string[])` → SkuCandidato[]
 *   - RPC `confirmar_vinculo_boletim(p_kb_product_spec_id, p_skus)` → number
 *   - RPC `desvincular_boletim(p_account, p_omie_codigo_produto, p_expected_kb_product_spec_id)` → number
 *   - Tabela `omie_product_spec_links` (staff SELECT)
 *   - Tabela `omie_products` (staff SELECT)
 *
 * ⚠️ View e RPCs novas NÃO estão no types.ts gerado → usar cast `as never`
 * nos callsites (lição §10 CLAUDE.md — não editar types.ts).
 */

/** Ficha técnica atual de um SKU, derivada da view `v_omie_product_current_spec`. */
export interface CurrentSpec {
  account: string;
  omie_codigo_produto: number;
  kb_product_spec_id: string;
  product_code: string | null;
  product_name: string | null;
  supplier: string | null;
  product_category: string | null;
  rendimento_m2_por_litro: number | null;
  demaos_recomendadas: number | null;
  pot_life_horas: number | null;
  validade_dias: number | null;
  catalisador_codigo: string | null;
  catalisador_proporcao_pct: number | null;
  diluente_codigo: string | null;
  substrato: string[] | string | null;
  equipamentos_aplicacao: string[] | string | null;
  diferenciais_chave: string[] | string | null;
  uso_recomendado: string | null;
}

/** Linha retornada pela RPC `buscar_skus_candidatos`. */
export interface SkuCandidato {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

/**
 * Linha do merge omie_product_spec_links ↔ omie_products.
 * `codigo`/`descricao` = null quando o SKU existe no link mas não na tabela de produtos
 * (improvável em prod, mas tratado honestamente).
 */
export interface VinculoLinha {
  account: string;
  omie_codigo_produto: number;
  codigo: string | null;
  descricao: string | null;
}

/**
 * Chave estável para casar venda ↔ mapa ↔ merge admin.
 * account é case-insensitive (OBEN == oben).
 */
export function keyDeSku(
  account: string | null | undefined,
  cod: number,
): string {
  return `${(account ?? '').toLowerCase()}|${cod}`;
}

/** Campos da ficha técnica exibidos no detalhe, em ordem de relevância. */
export const FICHA_CAMPOS: (keyof CurrentSpec)[] = [
  'product_category',
  'rendimento_m2_por_litro',
  'demaos_recomendadas',
  'catalisador_codigo',
  'catalisador_proporcao_pct',
  'diluente_codigo',
  'pot_life_horas',
  'validade_dias',
  'substrato',
  'equipamentos_aplicacao',
  'diferenciais_chave',
  'uso_recomendado',
];
