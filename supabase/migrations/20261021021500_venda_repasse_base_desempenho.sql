-- 20261021021500_venda_repasse_base_desempenho.sql
-- ============================================================
-- BUG em prod (2026-10-21 ~02:13 UTC, painel do founder, aba Repasses): venda_repasse_candidatos() → HTTP 500
-- "canceling statement due to statement timeout" em 8,2–8,4 s (authenticated/authenticator: statement_timeout=8s).
--
-- Causa: private._venda_repasse_base (20261020233000) juntava a CTE das linhas com ela mesma (último dia por
-- GROUP BY e volta às linhas do dia). A fonte, private.venda_linhas_pedido, não é inlinada (tem SET
-- search_path) e o planner a estima em 1.000 linhas → nested loop sobre ~72k linhas. Reproduzido no PG17 com
-- volume de prod (72k linhas): lote 33,5 s, candidatos 29,4 s.
--
-- Correção: o último dia sai por janela (max() OVER PARTITION BY comprador, SKU) numa passada só. MESMA saída
-- (prova: db/test-venda-repasse.sh inteiro sobre este corpo + asserção de desempenho com volume de prod).
-- Só o corpo do helper muda: assinatura, volatilidade, SET, dono e ACL intactos (CREATE OR REPLACE preserva).
-- Molde: PRE (md5 medido em prod 2026-10-21 via psql-ro = f34e307f…, ou este corpo) → CREATE → PÓS (md5 + ACL).
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`. ⚠️ migration manual (Lovable não auto-aplica).

CREATE TEMP TABLE IF NOT EXISTS repasse_base_retrato (config text NOT NULL, acl text NOT NULL);
TRUNCATE pg_temp.repasse_base_retrato;

DO $pre$
DECLARE v_md5 text; v_cfg_antes text;
BEGIN
  IF to_regprocedure('private._venda_repasse_base(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE: private._venda_repasse_base ausente — aplique antes a 20261020233000';
  END IF;
  -- a config é lida ANTES da trava (que a escreve): deriva prévia de search_path não pode ser normalizada em
  -- silêncio pelo ALTER abaixo (Codex P2). Medido na prod 2026-10-21: search_path=public, pg_temp.
  SELECT coalesce(array_to_string(p.proconfig, ','), '-') INTO v_cfg_antes
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private._venda_repasse_base(uuid)');
  IF v_cfg_antes IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'PRE_CONFIG: _venda_repasse_base com config inesperada antes da trava: %', v_cfg_antes;
  END IF;
  -- trava a linha de pg_proc antes de medir (CREATE concorrente espera); reescreve o MESMO valor conferido acima
  ALTER FUNCTION private._venda_repasse_base(uuid) SET search_path = public, pg_temp;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private._venda_repasse_base(uuid)');
  IF v_md5 IS DISTINCT FROM 'f34e307fcfc5826a83f223d2244a1b9b' AND v_md5 IS DISTINCT FROM 'ef2a2e6ab2d35cfe8dd15e0f2cc5686e' THEN
    RAISE EXCEPTION 'PRE: _venda_repasse_base deriva — md5(prosrc)=% não é o medido na prod (f34e307f…) nem este corpo', v_md5;
  END IF;
  INSERT INTO pg_temp.repasse_base_retrato
    SELECT p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private._venda_repasse_base(uuid)');
END $pre$;

CREATE OR REPLACE FUNCTION private._venda_repasse_base(p_comprador uuid)
 RETURNS TABLE(comprador_id uuid, omie_codigo_produto bigint, data_ancora date, ultimo_preco numeric,
               qtd_ancora numeric, c_last numeric, c_now numeric, c_now_fresco boolean,
               status_defasagem text, motivo text, p_req numeric, alta_custo_perc numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- UMA passada sobre as linhas: o último dia sai por janela, sem juntar a CTE com ela mesma. A função de
  -- linhas não é inlinada (tem SET) e o planner a estima em 1.000 linhas; com a autojunção ele escolhia
  -- nested loop sobre ~72k linhas → 33 s no PG17 com volume de prod, 500 por statement_timeout (8 s) na prod.
  WITH l AS (
    SELECT x.comprador_id, x.omie_codigo_produto, x.quantidade, x.preco_unit_liquido, x.data_pedido,
           max(x.data_pedido) OVER (PARTITION BY x.comprador_id, x.omie_codigo_produto) AS dia
      FROM private.venda_linhas_pedido(((now() AT TIME ZONE 'America/Sao_Paulo')::date + 1)) x
     WHERE x.empresa = 'oben'
       AND (p_comprador IS NULL OR x.comprador_id = p_comprador)
  ),
  dia AS (
    SELECT l.comprador_id, l.omie_codigo_produto, l.dia,
           sum(l.quantidade) AS qtd,
           bool_and(l.preco_unit_liquido IS NOT NULL AND l.preco_unit_liquido >= 0
                    AND l.preco_unit_liquido < 1e9) AS completo,
           sum(l.preco_unit_liquido * l.quantidade) FILTER (WHERE l.preco_unit_liquido > 0) AS soma,
           sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido > 0) AS qtd_preco
      FROM l
     WHERE l.data_pedido = l.dia
     GROUP BY l.comprador_id, l.omie_codigo_produto, l.dia
  )
  SELECT d.comprador_id, d.omie_codigo_produto, d.dia, p.p_last, d.qtd, cl.cmc, cn.cmc,
         -- MESMO critério de frescor do guard sem_custo_atual_fresco (48h em _defasagem_item)
         (cn.cmc IS NOT NULL AND cn.synced_at IS NOT NULL AND cn.synced_at >= now() - make_interval(hours => 48)),
         e.status, e.motivo, e.p_req, e.alta_perc
    FROM dia d
    CROSS JOIN LATERAL (
      SELECT CASE WHEN d.completo AND d.qtd_preco > 0 THEN d.soma / d.qtd_preco END AS p_last
    ) p
    LEFT JOIN LATERAL (
      SELECT ip.cmc, ip.synced_at FROM public.inventory_position ip
       WHERE ip.omie_codigo_produto = d.omie_codigo_produto
         AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0   -- finito: Infinity não é custo (Codex código P1)
         AND ip.account = ANY (ARRAY['vendas','oben'])
       ORDER BY ip.synced_at DESC NULLS LAST
       LIMIT 1
    ) cn ON true
    LEFT JOIN LATERAL (
      SELECT cs.cmc FROM public.cmc_snapshot cs
       WHERE cs.omie_codigo_produto = d.omie_codigo_produto
         AND cs.account = ANY (ARRAY['vendas','oben'])
         AND private.regua_num_finito(cs.cmc) AND cs.cmc > 0
         AND cs.data_posicao BETWEEN d.dia - 7 AND d.dia + 7
       ORDER BY abs(cs.data_posicao - d.dia) ASC, cs.synced_at DESC
       LIMIT 1
    ) cl ON true
    CROSS JOIN LATERAL private._defasagem_item(
      true, false, d.dia, p.p_last, d.qtd, cl.cmc, cn.cmc, cn.synced_at, p.p_last, NULL::numeric) e
$function$;

DO $pos$
DECLARE v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
           || coalesce(array_to_string(p.proconfig, ','), '-'),
         coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
    INTO v_src, v_cfg, v_acl
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private._venda_repasse_base(uuid)');
  IF position('OVER (PARTITION BY x.comprador_id, x.omie_codigo_produto)' IN v_src) = 0 OR position('FROM ult u' IN v_src) > 0 THEN
    RAISE EXCEPTION 'POS_JANELA: _venda_repasse_base ainda junta a CTE com ela mesma';
  END IF;
  IF md5(v_src) IS DISTINCT FROM 'ef2a2e6ab2d35cfe8dd15e0f2cc5686e' THEN
    RAISE EXCEPTION 'POS: md5(prosrc)=% não é o corpo desta migration', md5(v_src);
  END IF;
  SELECT * INTO v_ret FROM pg_temp.repasse_base_retrato;
  IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: config/ACL mudou — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_cfg, v_acl;
  END IF;
  IF has_function_privilege('authenticated', 'private._venda_repasse_base(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'private._venda_repasse_base(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS_ACL_HELPER: _venda_repasse_base executável por anon/authenticated';
  END IF;
  RAISE NOTICE 'POS OK';
END $pos$;

DROP TABLE IF EXISTS pg_temp.repasse_base_retrato;
