-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY da 20260726160000_tint_canonica_piso_legado.sql
-- Read-only. Cole no SQL Editor do Lovable DEPOIS de rodar a migration.
-- (O Claude também roda isto sozinho via psql-ro — este arquivo é pra você
--  conferir por conta própria quando quiser.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ESTRUTURA: a migration pegou? ───────────────────────────────────────
WITH estrutura AS (
  SELECT
    (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
       FROM pg_attribute a
      WHERE a.attrelid = 'public.v_tint_formula_canonica'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped)                       AS cols,
    (SELECT c.reloptions @> ARRAY['security_invoker=on']
       FROM pg_class c
      WHERE c.oid = 'public.v_tint_formula_canonica'::regclass)        AS invoker,
    (SELECT (length(pg_get_functiondef(p.oid))
             - length(replace(pg_get_functiondef(p.oid), 'COALESCE(v_piso, v_calc)', '')))
            / length('COALESCE(v_piso, v_calc)')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'tint_gate_revalida') AS n_pisos
)
SELECT
  CASE WHEN cols = 'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,'
                || 'subcolecao_id,personalizada,updated_at,is_sl,tem_receita,'
                || 'receita_valida,preco_csv_legado,preco_piso_legado'
       THEN '✅ 14 colunas na ordem certa (a nova só ACRESCENTOU no fim)'
       ELSE '❌ ordem/nomes ERRADOS: ' || COALESCE(cols, '(view ausente)')
  END AS c1_shape,
  CASE WHEN invoker
       THEN '✅ security_invoker=on preservado'
       ELSE '❌ PERDEU security_invoker — a view passou a ler como OWNER e bypassa RLS. NÃO deixe assim'
  END AS c2_rls,
  CASE WHEN n_pisos = 2
       THEN '✅ o gate lê o piso nas 2 fontes (manual + legado)'
       ELSE '❌ gate não usa preco_piso_legado (ocorrências=' || COALESCE(n_pisos::text, '?') || ', esperado 2)'
  END AS c3_gate
FROM estrutura;

-- ── 2. INVARIANTES + DELTA no dado real ────────────────────────────────────
-- Restrito às ÚNICAS chaves onde a mudança poderia ter efeito hoje (as 756
-- personalizadas ativas com CSV). A view inteira custa caro (960k fórmulas) e
-- estoura o statement_timeout; este recorte roda em ~2s.
WITH chaves AS (
  SELECT DISTINCT f.account, f.sku_id, f.cor_id
    FROM public.tint_formulas f
   WHERE f.desativada_em IS NULL
     AND f.subcolecao_id IS NULL
     AND f.preco_final_sayersystem IS NOT NULL
), v AS (
  SELECT c.preco_csv_legado AS csv, c.preco_piso_legado AS piso
    FROM chaves k
    JOIN public.v_tint_formula_canonica c
      ON c.account = k.account AND c.sku_id = k.sku_id AND c.cor_id = k.cor_id
)
SELECT
  count(*) AS chaves_conferidas,
  CASE WHEN count(*) FILTER (WHERE (csv IS NULL) <> (piso IS NULL)) = 0
       THEN '✅ I1 ok: (csv NULL) ⟺ (piso NULL)'
       ELSE '❌ I1 QUEBRADO em ' || count(*) FILTER (WHERE (csv IS NULL) <> (piso IS NULL))
            || ' linha(s) — as 2 cópias da subquery do csv driftaram'
  END AS i1,
  CASE WHEN count(*) FILTER (WHERE csv IS NOT NULL AND piso IS NOT NULL AND piso < csv) = 0
       THEN '✅ I2 ok: piso >= csv'
       ELSE '❌ I2 QUEBRADO — o piso deixou de ser conservador'
  END AS i2,
  CASE WHEN count(*) FILTER (WHERE csv IS DISTINCT FROM piso) = 0
       THEN '✅ delta 0: nenhuma chave mudou de comportamento (é o esperado hoje)'
       ELSE '⚠️ ' || count(*) FILTER (WHERE csv IS DISTINCT FROM piso)
            || ' chave(s) com piso ≠ rótulo — passou a existir caso real, me avise'
  END AS delta
FROM v;
