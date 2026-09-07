/**
 * Baseline da Parte F do `authz:check` — pares `migration → função` que revogam EXECUTE de
 * `anon`/`authenticated` SEM revogar de PUBLIC na mesma migration.
 *
 * ESTA BASELINE É JUSTIFICADA POR MEDIÇÃO, NÃO POR SILÊNCIO. Em 2026-08-22 (psql-ro, ref
 * fzvklzpomgnyikkfkzai) mediu-se `has_function_privilege('anon', oid, 'EXECUTE')` para as 18
 * funções que algum dia receberam `REVOKE … FROM anon` no repo: 17 deram **false** (fechadas de
 * verdade — alguma migration da linhagem emitiu o `FROM PUBLIC`, e `CREATE OR REPLACE` preservou
 * o ACL desde então) e 1 deu **true**. A que deu true — `public.omie_products_codigos_multi_conta`
 * — NÃO entra aqui: foi corrigida pela migration `20260907160103_revoke_public_sensor_multi_conta`.
 *
 * Ou seja: cada par abaixo é um `REVOKE` redundante sobre função JÁ fechada — inerte, não buraco.
 * Reescrever migration aplicada seria pior que inútil (o snapshot é a fonte de DR e o passado já
 * rodou), então o passivo fica declarado e a regra passa a valer para o que vier.
 *
 * NÃO ACRESCENTE PAR NOVO AQUI para calar o gate. Um par novo só é legítimo com a mesma evidência:
 * `has_function_privilege('anon', 'public.<f>(<args>)', 'EXECUTE') = false` medido em prod, com a
 * data no comentário. O caminho normal é emitir o `REVOKE … FROM PUBLIC` — idempotente e grátis.
 * O teste `baseline não apodrece` derruba entrada que deixou de existir ou de violar.
 */

/** Chave estável do par. ASCII, minúscula — os testes casam a CHAVE, não a mensagem. */
export function chaveRevokeSemPublic(file: string, funcao: string): string {
  return `${file}::${funcao.toLowerCase()}`;
}

/** Pares históricos, medidos `anon_exec = false` em prod em 2026-08-22 e RECONFERIDOS em
 * 2026-09-07 (as 8 seguem fechadas, PUBLIC ausente do `proacl` nas 8). */
const PARES: ReadonlyArray<readonly [string, string]> = [
  // 20260605140000 — RPCs de staff do parâmetro automático. A migration revoga só `anon` (mantém
  // `authenticated` DE PROPÓSITO: são chamadas do browser por staff, gate no corpo). PUBLIC medido
  // ausente do `proacl` em 2026-08-22, então o `FROM PUBLIC` omitido é inerte nas três.
  ['20260605140000_param_auto_wrapper_revert_cron.sql', 'public.despinar_parametro'],
  ['20260605140000_param_auto_wrapper_revert_cron.sql', 'public.reverter_parametro_auto'],
  ['20260605140000_param_auto_wrapper_revert_cron.sql', 'public.reverter_run_auto'],
  // 20260606170100 — classificação de fornecedores. As duas primeiras revogam anon+authenticated
  // e medem fechadas nas duas; a terceira revoga só `anon` e mantém `authenticated` (staff).
  ['20260606170100_fornecedores_classificacao_rpcs.sql', 'public.aplicar_exclusao_fornecedores'],
  ['20260606170100_fornecedores_classificacao_rpcs.sql', 'public.classificar_clientes_fornecedores'],
  ['20260606170100_fornecedores_classificacao_rpcs.sql', 'public.reverter_exclusao_fornecedor'],
  // 20260510235956 — as duas funções são DROP+CREATE (o CREATE reseta o ACL) com revoke nominal e
  // sem `FROM PUBLIC` em nenhum ponto do corpus. Prod mede as duas fechadas (`anon=nao`, PUBLIC
  // ausente do proacl) — o fecho veio de FORA do repo, o mesmo caso que a Parte E modela como
  // `fechadaPor: null`. Baselinadas pela medição, não pelo texto.
  ['20260510235956_a5ace125-5cbf-43df-940b-0d517b819a49.sql', 'public.auto_assign_user_role'],
  ['20260510235956_a5ace125-5cbf-43df-940b-0d517b819a49.sql', 'public.fin_consolidado_intercompany'],
];

// NÃO entram aqui, porque o gate os resolve sozinho por FIX-FORWARD (o `FROM PUBLIC` chegou numa
// migration POSTERIOR e o corpus ordenado enxerga isso):
//   · 20260820225840 → farmer_association_rules_substituir  (fechada pela 20260821200000)
//   · 20260821200000 → omie_products_codigos_multi_conta    (fechada pela 20260907160103)

export const REVOKE_SEM_PUBLIC_BASELINE: ReadonlySet<string> = new Set(
  PARES.map(([f, fn]) => chaveRevokeSemPublic(f, fn)),
);
