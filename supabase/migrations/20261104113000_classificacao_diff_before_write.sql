-- Migration: a classificação de fornecedores só escreve a linha cuja classificação MUDOU (plano v5, lote 10 — D3,
-- fatia 1). Plano: docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md. Diário:
-- docs/historico/classificacao-diff-before-write.md. Prova executada: db/test-fornecedores-classificacao.sh (bloco D).
-- ⚠️ NÃO auto-aplica (nome custom). Apply do founder, colando o arquivo INTEIRO no SQL Editor do Lovable (decisão
-- dele nesta entrega: "Abrir sem aplicar"). Leva BEGIN/COMMIT: nada fica meio-aplicado se PRE ou PÓS abortar.
--
-- Evidência (psql-ro, 2026-11-04 10:59Z; contadores desde o restart de 2026-10-31 10:33Z): 102.492 updates em
-- 17.459 linhas. O cron `classificar-fornecedores-nightly` (job 139, 07:15 UTC) chama aplicar_exclusao_fornecedores(),
-- que chama esta função, e ela reescrevia TODAS as linhas todo dia (updated_at = now() incondicional) — ~70 mil dos
-- 102 mil. O resto vem do upsert de tags do omie-analytics-sync (tags_omie + tags_synced_at), que fica como está:
-- tags_synced_at é a confirmação por linha da sincronização.
--
-- O QUE MUDA: a régua é a MESMA, calculada para toda linha (CTE `regua`); o UPDATE só toca a linha cuja tupla
-- (is_fornecedor, tem_venda_real, excluir_da_carteira) é DIFERENTE da calculada. Consequências:
--   • updated_at passa a ser "a última vez que a classificação da linha mudou" (como já era no reverter). Nenhum
--     leitor o usa como prova de execução — varredura de src/, supabase/functions/, db/, views e de todo prosrc de
--     prod (_data_health_compute não lê a tabela; os leitores só filtram excluir_da_carteira). A prova de que a
--     classificação RODOU é do cron (cron.job_run_details do job 139) e do retorno, não do carimbo da linha.
--   • retorno: `classificados` segue o total de linhas avaliadas (antes, o ROW_COUNT do UPDATE que tocava todas);
--     `alterados` (novo) = linhas escritas; `excluidos` igual.
--   • guarda de corrida: a régua lê o snapshot do início do comando. Se as tags de uma linha mudarem DURANTE o
--     comando (upsert do sync), o UPDATE espera o lock e reavalia o WHERE contra a versão nova — sem a guarda, as
--     flags calculadas sobre as tags VELHAS seriam gravadas por cima (o trigger já re-derivou is_fornecedor das
--     novas; a corrida chegaria a excluir da carteira um cliente que deixou de ser fornecedor). A versão anterior
--     não tinha o risco porque o SET relia cc.tags_omie da versão nova. Com a guarda, a linha fica para a próxima
--     execução (o trigger já deixou is_fornecedor certo).
--
-- PRESERVA: assinatura, RETURNS jsonb, plpgsql, SECURITY DEFINER, search_path=public e o ACL (CREATE OR REPLACE
-- mantém o proacl; a pós-condição o relê).
--
-- COMO APLICA: TRAVA (ALTER sem efeito: prende a função desde ANTES da leitura, senão outra sessão troca o corpo
-- entre a PRE e o CREATE e é apagada com a PÓS aprovando) → PRE (md5 do prosrc vivo ∈ {predecessor de prod
-- medido, este}) → CREATE OR REPLACE → PÓS: md5, atributos e ACL relidos do catálogo + a função EXECUTADA numa
-- subtransação desfeita (PL/pgSQL é late-bound: o CREATE passar não prova que ela roda). Re-aplicar é no-op.

BEGIN;

DO $trava$
BEGIN
  IF to_regprocedure('public.classificar_clientes_fornecedores()') IS NOT NULL THEN
    ALTER FUNCTION public.classificar_clientes_fornecedores() VOLATILE;   -- a volatilidade VIVA (provolatile = v)
  END IF;
END $trava$;

DO $pre$
DECLARE
  c_pred CONSTANT text := 'c99d2afabff27f52fc5a45d9ddfabd88';  -- md5(prosrc) de prod, psql-ro 2026-11-04 (= 20261001014100)
  c_este CONSTANT text := '4f0e049fadb53f42660f36434117e8dc';  -- md5(prosrc) do corpo abaixo
  v_md5  text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.classificar_clientes_fornecedores()');
  IF v_md5 IS NULL OR v_md5 NOT IN (c_pred, c_este) THEN
    RAISE EXCEPTION 'PRE: corpo vivo da classificar (md5 %) não é o predecessor medido (%) nem este (%) — alguém o recriou depois do pré-voo; refaça sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_classificados int;
  v_alterados     int;
  v_excluidos     int;
BEGIN
  -- Diff-before-write: a régua vale para toda linha; só a linha cuja classificação mudou é escrita.
  WITH regua AS (
    SELECT cc.user_id, cc.tags_omie,
      EXISTS (
        SELECT 1 FROM unnest(cc.tags_omie) t
        WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
      ) AS is_fornecedor,
      EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.customer_user_id = cc.user_id
          AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
      ) AS tem_venda_real,
      (
        EXISTS (
          SELECT 1 FROM unnest(cc.tags_omie) t
          WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.sales_orders so
          WHERE so.customer_user_id = cc.user_id
            AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
        )
        AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)
      ) AS excluir_da_carteira
    FROM public.cliente_classificacao cc
  ),
  escrita AS (
    UPDATE public.cliente_classificacao cc SET
      is_fornecedor = r.is_fornecedor,
      tem_venda_real = r.tem_venda_real,
      excluir_da_carteira = r.excluir_da_carteira,
      updated_at = now()
    FROM regua r
    WHERE r.user_id = cc.user_id
      AND (cc.is_fornecedor, cc.tem_venda_real, cc.excluir_da_carteira)
          IS DISTINCT FROM (r.is_fornecedor, r.tem_venda_real, r.excluir_da_carteira)
      -- guarda de corrida: tags mudadas durante o comando → a régua desta linha é velha; fica para a próxima
      AND cc.tags_omie IS NOT DISTINCT FROM r.tags_omie
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM regua), (SELECT count(*) FROM escrita) INTO v_classificados, v_alterados;
  SELECT count(*) INTO v_excluidos FROM public.cliente_classificacao WHERE excluir_da_carteira;
  RETURN jsonb_build_object('classificados', v_classificados, 'alterados', v_alterados, 'excluidos', v_excluidos);
END $function$;

COMMENT ON COLUMN public.cliente_classificacao.updated_at IS
  'Carimbo da última ESCRITA de classificação na linha: classificar_clientes_fornecedores() (desde 20261104113000 só '
  'escreve quando alguma flag difere da régua) ou reverter_exclusao_fornecedor(). O trigger de tags re-deriva '
  'is_fornecedor sem carimbar. NÃO é a última execução da classificação — essa é do cron job 139.';

DO $pos$
DECLARE
  v_p   pg_catalog.pg_proc%ROWTYPE;
  v_acl text;
  v_r   jsonb;
  v_n   bigint;
BEGIN
  SELECT * INTO v_p FROM pg_catalog.pg_proc WHERE oid = 'public.classificar_clientes_fornecedores()'::regprocedure;
  IF md5(v_p.prosrc) IS DISTINCT FROM '4f0e049fadb53f42660f36434117e8dc' THEN
    RAISE EXCEPTION 'POS: o corpo vivo não é o desta migration (md5 %)', md5(v_p.prosrc);
  END IF;
  IF NOT v_p.prosecdef OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR v_p.prorettype <> 'jsonb'::regtype OR v_p.provolatile <> 'v' THEN
    RAISE EXCEPTION 'POS: atributos mudaram (secdef=% config=% ret=%)', v_p.prosecdef, v_p.proconfig, v_p.prorettype::regtype;
  END IF;
  IF has_function_privilege('anon', v_p.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_p.oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_p.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS: ACL mudou — %', v_p.proacl;
  END IF;
  -- late-bound: EXECUTA a função; o efeito é desfeito pelo ROLLBACK da subtransação (só a SQLSTATE-marca é engolida)
  BEGIN
    v_r := public.classificar_clientes_fornecedores();
    RAISE EXCEPTION USING ERRCODE = 'P0L10', MESSAGE = 'desfaz a execução de prova';
  EXCEPTION WHEN SQLSTATE 'P0L10' THEN NULL;
  END;
  -- sem igualdade com um count(*) daqui: em READ COMMITTED ele é OUTRO snapshot, e um upsert concorrente do sync
  -- reprovaria um apply correto (Codex). O retorno é coerente consigo mesmo e com a tabela não vazia.
  SELECT count(*) INTO v_n FROM public.cliente_classificacao;
  IF v_r IS NULL OR (v_r->>'classificados')::bigint IS NULL OR (v_r->>'alterados')::bigint IS NULL
     OR (v_r->>'excluidos')::bigint IS NULL
     OR (v_r->>'alterados')::bigint NOT BETWEEN 0 AND (v_r->>'classificados')::bigint
     OR (v_n > 0 AND (v_r->>'classificados')::bigint = 0) THEN
    RAISE EXCEPTION 'POS: a execução de prova devolveu % (a tabela tem % linhas)', v_r, v_n;
  END IF;
END $pos$;

COMMIT;
