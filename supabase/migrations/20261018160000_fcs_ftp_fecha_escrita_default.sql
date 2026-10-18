-- FU4-F (pós-B) — Fecha a ESCRITA default do Supabase que sobrou em public.farmer_client_scores e
-- public.farmer_tactical_plans depois das B do #3072 (20261014120100) e do #3084 (20261015120100).
--
-- As B fecharam só a LEITURA da margem (REVOKE SELECT de tabela + GRANT SELECT por coluna). O resto do
-- default da plataforma ficou. Medido por psql-ro após o apply das B (2026-10-18):
--   farmer_client_scores  anon=awdDxtm  authenticated=awdDxtm   (+ 3 policies de escrita: own OR gestor)
--   farmer_tactical_plans anon=Dxtm     authenticated=Dxtm      (sem policy de escrita)
-- Dois riscos reais: (1) fcs_update_own_or_gestor deixa a dona dar UPDATE na própria linha, INCLUSIVE em
-- gross_margin_pct — escrita cega que corrompe o número que quem tem cap_custo_ler vê pela
-- get_scores_margem até o próximo calculate-scores; (2) TRUNCATE não passa por RLS: um authenticated
-- qualquer apaga as duas tabelas inteiras.
--
-- Writers legítimos (medido em prod + repo, 2026-10-18) — nenhum escreve como anon/authenticated:
--   · fcs: edges calculate-scores e scoring-recalc-client (SERVICE_ROLE_KEY); RPCs SECURITY DEFINER
--     reconcile_score_owner_from_carteira, cleanup_orphan_score_on_carteira_delete,
--     aplicar_exclusao_fornecedores; apply_score_updates (invoker, sem EXECUTE para authenticated/anon).
--   · ftp: RPCs SECURITY DEFINER criar_plano_tatico, registrar_resultado_plano, expirar_planos_taticos.
--   · o front não escreve em nenhuma das duas pela API (só via essas RPCs).
--
-- ⚠️  POR QUE fcs MANTÉM UPDATE DE UMA COLUNA E A POLICY DE UPDATE (não é sobra, é carga):
--   farmer_recomendacoes_substituir e farmer_bundle_recomendacoes_substituir são SECURITY INVOKER,
--   chamadas pelo browser como authenticated, e travam as linhas de score do lote com
--   `SELECT … FOR SHARE` (bloco 6-ter — o lock causal contra a troca de dono concorrente).
--   No Postgres, FOR SHARE exige privilégio UPDATE em >=1 coluna (sem ele: 42501 e a geração de
--   recomendações quebra) e aplica o USING da policy de UPDATE como FILTRO (sem a policy, o FOR SHARE
--   não trava linha nenhuma — em silêncio — e a corrida que o 6-ter fecha reabre).
--   Por isso: UPDATE só de (updated_at), e a policy fica com o MESMO USING (escopo da trava) e
--   WITH CHECK (false) — o UPDATE real de authenticated passa a ser recusado pela RLS (42501,
--   "new row violates row-level security policy"); o FOR SHARE não avalia WITH CHECK. Provado em PG17
--   (db/test-fcs-ftp-escrita-fechada.sh), com falsificação. DROPAR a policy = trava no-op silenciosa.
--
-- As policies fcs_insert_own_or_gestor / fcs_delete_own_or_gestor ficam (sem privilégio, inertes):
-- DROP é DDL destrutivo e sai do envelope; o alarme contra um GRANT devolvido é o authz:grants:prod.
--
-- Quem NÃO é afetado: service_role (BYPASSRLS; mantém o ACL), claude_ro, postgres (dono das RPCs
-- SECURITY DEFINER). SELECT por coluna das B intacto (este arquivo não revoga SELECT).
--
-- Idempotente (re-rodar revoga e concede o mesmo). Sem BEGIN/COMMIT: aplicar com
-- `bun run db:aplicar <este arquivo>`; no SQL Editor, envolver em BEGIN; … COMMIT;.

DO $pre$
BEGIN
  IF to_regclass('public.farmer_client_scores') IS NULL OR to_regclass('public.farmer_tactical_plans') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: farmer_client_scores ou farmer_tactical_plans ausente';
  END IF;
  -- As B precisam estar aplicadas: este arquivo é o complemento delas (sem a B, o SELECT de tabela segue
  -- aberto e o fecho de escrita daria a falsa impressão de tabela fechada).
  IF has_table_privilege('authenticated', 'public.farmer_client_scores', 'SELECT')
     OR has_table_privilege('authenticated', 'public.farmer_tactical_plans', 'SELECT') THEN
    RAISE EXCEPTION 'PRE FALHOU: authenticated tem SELECT de TABELA - aplique as B (20261014120100, 20261015120100) antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.farmer_client_scores'::regclass AND attname = 'updated_at'
                    AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRE FALHOU: farmer_client_scores.updated_at ausente - a coluna da trava FOR SHARE';
  END IF;
  -- A policy é a que dá o ESCOPO da trava FOR SHARE: sem ela (ou sem USING) o lock vira no-op.
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.farmer_client_scores'::regclass
                    AND polname = 'fcs_update_own_or_gestor' AND polcmd = 'w' AND polqual IS NOT NULL) THEN
    RAISE EXCEPTION 'PRE FALHOU: policy fcs_update_own_or_gestor (FOR UPDATE com USING) ausente';
  END IF;
END
$pre$;

-- REVOKE de tabela também apaga o GRANT por coluna do MESMO privilégio — o GRANT da trava vem DEPOIS.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.farmer_client_scores FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.farmer_tactical_plans FROM anon, authenticated;

-- O mínimo que o FOR SHARE das duas RPCs invoker exige. Não grava nada: a policy abaixo recusa.
GRANT UPDATE (updated_at) ON public.farmer_client_scores TO authenticated;

ALTER POLICY fcs_update_own_or_gestor ON public.farmer_client_scores WITH CHECK (false);
COMMENT ON POLICY fcs_update_own_or_gestor ON public.farmer_client_scores IS
  'Escopo da trava FOR SHARE de farmer_recomendacoes_substituir/farmer_bundle_recomendacoes_substituir '
  '(USING = own OR cap_carteira_escrever). WITH CHECK (false): authenticated NAO grava - writers sao '
  'service_role e RPCs SECURITY DEFINER. Nao dropar: sem ela o FOR SHARE nao trava nada (20261018160000).';

DO $pos$
DECLARE
  v_r text;
  v_p text;
  v_t text;
  v_cols text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['public.farmer_client_scores', 'public.farmer_tactical_plans'] LOOP
    FOREACH v_r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_r, v_t, v_p) THEN
          RAISE EXCEPTION 'POS1 FALHOU: % segue com % de TABELA em %', v_r, v_p, v_t;
        END IF;
      END LOOP;
      -- has_table_privilege não vê GRANT de coluna: INSERT/REFERENCES por coluna também contam.
      IF has_any_column_privilege(v_r, v_t, 'INSERT') OR has_any_column_privilege(v_r, v_t, 'REFERENCES') THEN
        RAISE EXCEPTION 'POS2 FALHOU: % tem INSERT/REFERENCES por coluna em %', v_r, v_t;
      END IF;
    END LOOP;
  END LOOP;

  IF has_any_column_privilege('anon', 'public.farmer_client_scores', 'UPDATE')
     OR has_any_column_privilege('anon', 'public.farmer_tactical_plans', 'UPDATE')
     OR has_any_column_privilege('authenticated', 'public.farmer_tactical_plans', 'UPDATE') THEN
    RAISE EXCEPTION 'POS3 FALHOU: sobrou UPDATE por coluna fora do previsto';
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.farmer_client_scores'::regclass AND attnum > 0 AND NOT attisdropped
     AND has_column_privilege('authenticated', 'public.farmer_client_scores', attname, 'UPDATE');
  IF v_cols IS DISTINCT FROM 'updated_at' THEN
    RAISE EXCEPTION 'POS4 FALHOU: UPDATE de authenticated em fcs deveria ser so (updated_at), veio (%) - sem ele o FOR SHARE das RPCs de recomendacao da 42501', coalesce(v_cols, 'nenhuma');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policy
                  WHERE polrelid = 'public.farmer_client_scores'::regclass
                    AND polname = 'fcs_update_own_or_gestor' AND polcmd = 'w' AND polqual IS NOT NULL
                    AND pg_get_expr(polwithcheck, polrelid) = 'false') THEN
    RAISE EXCEPTION 'POS5 FALHOU: fcs_update_own_or_gestor sem USING ou com WITH CHECK diferente de false - a dona segue gravando a margem';
  END IF;

  -- O que as B fecharam segue fechado, e o que deixaram aberto segue aberto.
  IF has_column_privilege('authenticated', 'public.farmer_client_scores', 'gross_margin_pct', 'SELECT')
     OR has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'current_margin_pct', 'SELECT') THEN
    RAISE EXCEPTION 'POS6 FALHOU: authenticated le a margem';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.farmer_client_scores', 'customer_user_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.farmer_tactical_plans', 'customer_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS7 FALHOU: authenticated perdeu SELECT das colunas abertas - as telas quebrariam';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.farmer_client_scores', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.farmer_tactical_plans', 'SELECT') THEN
    RAISE EXCEPTION 'POS8 FALHOU: service_role perdeu privilegio - calculate-scores/scoring-recalc-client quebrariam';
  END IF;
END
$pos$;
