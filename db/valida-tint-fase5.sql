-- ═══════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY da 20260727120000_tint_fase5_desativa_geracao_legada.sql
-- Read-only. Cole no SQL Editor do Lovable DEPOIS de rodar os DOIS blocos.
-- (O Claude também roda isto sozinho via psql-ro — este arquivo é pra você
--  conferir por conta própria quando quiser.)
--
-- ⚠️ ESTE VALIDADOR É CÓDIGO DE AUTORIZAÇÃO E TEM DENTE PROVADO.
-- Lição #1490/#1501 ("o VALIDADOR mente, e ninguém o falsifica porque ele só
-- confere"): ele erra nas DUAS direções — falso negativo (varredura global que
-- reprova banco correto, ensinando a ignorar o vermelho) e falso positivo
-- (regex frouxo que aprova corpo errado). Por isso:
--   • todo predicado é ESCOPADO ao alvo (regclass/proname), nunca varredura;
--   • db/test-tint-fase5-desativacao.sh EXECUTA este arquivo contra banco BOM
--     (tem de dar tudo ✅) e contra banco SABOTADO (tem de REPROVAR).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ESTRUTURA: a migration pegou? ───────────────────────────────────────
WITH estrutura AS (
  SELECT
    (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
       FROM pg_attribute a
      WHERE a.attrelid = 'public.v_tint_formula_canonica'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped)                        AS cols,
    (SELECT c.reloptions @> ARRAY['security_invoker=on']
       FROM pg_class c
      WHERE c.oid = 'public.v_tint_formula_canonica'::regclass)         AS invoker,
    -- a coluna de proveniência existe?
    EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = 'public.tint_formulas'::regclass
               AND a.attname = 'desativada_motivo'
               AND a.attnum > 0 AND NOT a.attisdropped)                 AS tem_col,
    -- o CHECK existe E está VALIDADO? (NOT VALID passa despercebido: a
    -- constraint aparece em pg_constraint mas não protege o passado)
    (SELECT c.convalidated FROM pg_constraint c
      WHERE c.conrelid = 'public.tint_formulas'::regclass
        AND c.conname = 'tint_formulas_motivo_exige_desativacao')       AS check_ok,
    -- a view relaxou o CSV para o carimbo? Ancora na ESTRUTURA da expressão,
    -- e sobre a definição SEM COMENTÁRIOS (#1472/#1488: o `.` do regex do PG
    -- atravessa newline, então um comentário citando a string satisfaria o
    -- assert que deveria fiscalizá-lo).
    (SELECT regexp_replace(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true),
                           '--[^\n]*', '', 'g'))                        AS viewdef
)
SELECT
  CASE WHEN cols = 'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,'
                || 'subcolecao_id,personalizada,updated_at,is_sl,tem_receita,'
                || 'receita_valida,preco_csv_legado,preco_piso_legado'
       THEN '✅ 14 colunas na ordem certa (a Fase 5 não mexeu no shape)'
       ELSE '❌ ordem/nomes ERRADOS: ' || COALESCE(cols, '(view ausente)')
  END AS c1_shape,
  CASE WHEN invoker
       THEN '✅ security_invoker=on preservado'
       ELSE '❌ PERDEU security_invoker — a view lê como OWNER e bypassa RLS. NÃO deixe assim'
  END AS c2_rls,
  CASE WHEN tem_col THEN '✅ coluna desativada_motivo existe'
       ELSE '❌ coluna desativada_motivo AUSENTE — o BLOCO 1 não rodou' END AS c3_coluna,
  CASE WHEN check_ok IS TRUE THEN '✅ CHECK do carimbo existe e está VALIDADO'
       WHEN check_ok IS FALSE THEN '❌ CHECK existe mas é NOT VALID — rode o VALIDATE CONSTRAINT'
       ELSE '❌ CHECK tint_formulas_motivo_exige_desativacao AUSENTE' END AS c4_check,
  CASE WHEN viewdef ~ 'desativada_motivo\s*=\s*''fase5_geracao_legada'''
       THEN '✅ a view lê o carimbo da Fase 5'
       ELSE '❌ a view NÃO relaxou para o carimbo — o rótulo "Tabela (versão anterior)" sumiu de ~464k chaves' END AS c5_relax,
  -- O filtro de CANDIDATA a canônica NÃO pode ter sido relaxado: se foi, a
  -- geração desativada volta ao catálogo e a fase se anula.
  CASE WHEN viewdef ~ 'WHERE\s+\(?f\.desativada_em IS NULL'
        AND NOT (viewdef ~ 'f\.desativada_em IS NULL\s+OR\s+f\.desativada_motivo')
       THEN '✅ filtro de candidata a canônica intacto (a desativada NÃO volta ao catálogo)'
       ELSE '❌ o filtro de candidata foi relaxado — a geração 1 voltaria a ser servida no balcão' END AS c6_candidata
FROM estrutura;

-- ── 2. EFEITO: o que mudou, e bate com o esperado? ─────────────────────────
-- Baseline psql-ro 2026-07-21: geração '1' ativas 464.007 · alvo 463.995 ·
-- preservar 12 (as 4 cores ACR MAX x 3 embalagens).
SELECT
  count(*) FILTER (WHERE f.desativada_motivo = 'fase5_geracao_legada')      AS carimbadas,
  count(*) FILTER (WHERE f.desativada_em IS NULL)                          AS gen1_ainda_ativas,
  CASE WHEN count(*) FILTER (WHERE f.desativada_em IS NULL) BETWEEN 1 AND 60
       THEN '✅ sobrou a ordem de grandeza das 12 exclusivas (ACR MAX)'
       WHEN count(*) FILTER (WHERE f.desativada_em IS NULL) = 0
       THEN '❌ ZERO da geração 1 ativas — as cores exclusivas SUMIRAM do catálogo'
       ELSE '⚠️ sobraram mais que o esperado — a desativação pode ter sido parcial' END AS e1_preservadas,
  -- Nenhuma linha ATIVA pode carregar carimbo (o CHECK garante; isto confirma).
  CASE WHEN count(*) FILTER (WHERE f.desativada_em IS NULL AND f.desativada_motivo IS NOT NULL) = 0
       THEN '✅ nenhuma linha ativa carimbada' ELSE '❌ carimbo órfão em linha ativa' END AS e2_orfaos
FROM public.tint_formulas f
JOIN public.tint_subcolecoes s
  ON s.id = f.subcolecao_id AND s.account = f.account
 AND s.id_subcolecao_sayersystem = '1'
WHERE f.sku_id IS NOT NULL;

-- ── 3. O QUE NÃO PODE TER MUDADO: invariantes da view ──────────────────────
-- I1 e I2 são verdadeiros POR CONSTRUÇÃO na expressão nova
-- (GREATEST(csv, COALESCE(max_ativo, csv))); estas contagens confirmam em
-- PROD, sobre o dado real, que a construção se sustenta.
-- ⚠️ Query PESADA (varre a canônica inteira, ~495k). Rode sozinha.
SELECT
  count(*)                                                                   AS linhas_canonica,
  count(*) FILTER (WHERE preco_csv_legado  IS NOT NULL)                      AS com_csv,
  count(*) FILTER (WHERE preco_piso_legado IS NOT NULL)                      AS com_piso,
  CASE WHEN count(*) FILTER (WHERE (preco_csv_legado IS NULL) <> (preco_piso_legado IS NULL)) = 0
       THEN '✅ I1 vale: (csv NULL) ⟺ (piso NULL)'
       ELSE '❌ I1 VIOLADO em ' || count(*) FILTER (WHERE (preco_csv_legado IS NULL) <> (preco_piso_legado IS NULL))::text || ' linha(s)' END AS i1,
  CASE WHEN count(*) FILTER (WHERE preco_csv_legado IS NOT NULL AND preco_piso_legado < preco_csv_legado) = 0
       THEN '✅ I2 vale: piso >= csv'
       ELSE '❌ I2 VIOLADO em ' || count(*) FILTER (WHERE preco_csv_legado IS NOT NULL AND preco_piso_legado < preco_csv_legado)::text || ' linha(s)' END AS i2,
  -- NO-OP no preço: estas duas somas têm de bater com o baseline capturado
  -- ANTES do apply. É a prova EMPÍRICA da alegação central do desenho — sem
  -- ela, "a Fase 5 não mexe no preço" é argumento, não medição.
  round(sum(preco_csv_legado),  2)                                           AS soma_csv_COMPARE_BASELINE,
  round(sum(preco_piso_legado), 2)                                           AS soma_piso_COMPARE_BASELINE
FROM public.v_tint_formula_canonica;

-- ── 4. AS 12 EXCLUSIVAS: continuam servidas no balcão? ─────────────────────
-- Escopado às 4 cores ACR MAX do baseline. Precisão > recall: se alguma sumiu
-- da canônica, o balcão perdeu uma cor vendável.
SELECT c.cor_id, c.nome_cor, count(*) AS linhas_na_canonica,
       CASE WHEN count(*) = 3 THEN '✅ 3 embalagens servidas'
            ELSE '⚠️ esperado 3 embalagens, veio ' || count(*)::text END AS status
FROM public.v_tint_formula_canonica c
WHERE c.cor_id IN ('035Y - ACR MAX BS','082P - ACR MAX BS',
                   '128L - ACR MAX BS','23.2429.CK.JO20 - ACR MAX')
GROUP BY c.cor_id, c.nome_cor
ORDER BY c.cor_id;
