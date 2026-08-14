-- Validacao pos-apply de 20260726170000_fu4f_fase3_carteira_margem_faixa.sql (FU4-F fase 3)
-- Cola no SQL Editor do Lovable, ou roda via ~/.config/afiacao/psql-ro -f db/valida-fu4f-fase3-carteira-margem-faixa.sql
--
-- LE CATALOGO, nunca INVOCA a funcao (licao do #1462): invocar exige EXECUTE e daria
-- falso-negativo sob a role read-only, que nao o tem. Todos os checks tem de vir `t`.
-- Qualquer `f` = a migration nao aplicou como desenhada -> NAO faca o Publish do frontend.
--
-- IMPRESSAO_DIGITAL=169677feb2e686d3e73ec31426c608b6
--   md5 do corpo (prosrc) com whitespace colapsado. E o que amarra "o que foi COLADO" a "o que
--   foi TESTADO": db/test-fu4f-fase3-carteira-margem-faixa.sh (assert L1) recalcula esta digital
--   contra a migration real num PG17 e falha se as duas divergirem. Mexeu na migration sem
--   regravar aqui -> vermelho no harness, nao na producao.
--
--   ⚠️ A digital cobre a CADEIA de migrations que recriam esta funcao, nao um arquivo so — e
--   mudou em 2026-08-13 (era 075209b91d13be52c58220f6ddc88521, o corpo do #1543). A fase 3c
--   (20260813234112_carteira_margem_faixa_motivo_gate_custo.sql) poe o campo `motivo` sob
--   `private.cap_custo_ler`, e isso ALTERA o prosrc. Os dois harnesses aplicam a cadeia inteira
--   e recalculam a digital: db/test-fu4f-fase3-carteira-margem-faixa.sh (L1) e
--   db/test-carteira-margem-faixa-motivo-gate.sh (G1). Quem recriar a funcao de novo regrava
--   aqui — senao este validador devolve `f` num banco CORRETO e para um deploy por falso alarme.
--   (O #1728 nao aparece nesta lista de proposito: COMMENT nao toca `prosrc`.)

SELECT
  -- ── existencia e forma ──────────────────────────────────────────────────────
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa') = 1   AS c1_existe,
  (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')       AS c2_security_definer,
  (SELECT p.provolatile = 's' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')       AS c3_stable,
  -- pg_temp POR ULTIMO (regra do FU7): antes de 'public' ele deixaria um objeto temporario
  -- do atacante sombrear a resolucao de nome dentro de uma funcao SECURITY DEFINER.
  (SELECT p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')       AS c4_search_path,

  -- ── ACL: `authenticated` MANTEM execute de proposito (o gate esta no CORPO) ──
  -- REVOKE de PUBLIC nao tira das roles nomeadas (grant explicito do Supabase) — por isso
  -- anon e checado em separado, e nao inferido do PUBLIC.
  has_function_privilege('anon', 'public.get_carteira_margem_faixa()', 'EXECUTE')
    = false                                                                        AS c5_anon_negado,
  has_function_privilege('public', 'public.get_carteira_margem_faixa()', 'EXECUTE')
    = false                                                                        AS c6_public_negado,
  has_function_privilege('authenticated', 'public.get_carteira_margem_faixa()', 'EXECUTE')
    = true                                                                         AS c7_authenticated_ok,

  -- ── os dois gates, por ESTRUTURA (nao por substring solta) ───────────────────
  -- O md5 do corpo inteiro e o assert forte: "OR true" enxertado num dos gates mudaria a
  -- digital. Os dois checks seguintes existem para DIAGNOSTICO — quando c10 falha, eles dizem
  -- QUAL gate sumiu, em vez de so "o corpo difere".
  (SELECT p.prosrc LIKE '%CASE WHEN v_pode_num THEN b.pct END%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')       AS c8_gate_projecao,
  (SELECT p.prosrc LIKE '%carteira_visivel_para(b.cid, v_uid)%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')       AS c9_gate_escopo,
  (SELECT md5(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa')
    = '169677feb2e686d3e73ec31426c608b6'                                           AS c10_corpo_identico_ao_testado,

  -- ── a dependencia que faz o custo NAO sair do servidor ───────────────────────
  -- Sem o helper aplicado (#1519), a funcao criaria bem e so quebraria em RUNTIME (plpgsql e
  -- late-bound) — silenciosamente, atras do hook.
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'private' AND p.proname = 'margem_cliente_agregada') = 1    AS c11_helper_existe;
