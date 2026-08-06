-- ============================================================
-- DROP da RPC ÓRFÃ omie_cliente_upsert_mapping(uuid,text,bigint,bigint)
--
-- CONTEXTO: resíduo do P0-B (identidade Omie por conta, 2026-07-05). Era o backfill do espelho
-- omie_clientes chamado pelo edge omie-vendas-sync. O /codex challenge mostrou que o upsert sob
-- unique_user_omie devolve 'contested' e BLOQUEIA pedido legítimo (2º bloqueio em série) → o chamador
-- foi removido e o repo ganhou um INVARIANTE que PROÍBE seu retorno
-- (src/__tests__/edge-money-path-invariants.test.ts:281, `.not.toMatch(/omie_cliente_upsert_mapping/)`).
-- A função ficou em prod como superfície de ESCRITA morta: SECURITY DEFINER, GRANT p/ service_role,
-- INSERT em omie_clientes. Levantada no inventário §4-bis do design do P0-B-bis (PR #1405).
--
-- ORFANDADE PROVADA (psql-ro + git grep na main, 2026-07-18) — com FALSIFICAÇÃO do método:
--   • banco: zero chamadores em rotinas (todo prokind), cron.job, RLS policy, default de coluna, trigger;
--   • código vivo (supabase/functions + src, fora o types.ts gerado): ZERO invocações — o único hit é a
--     asserção NEGATIVA do invariante acima;
--   • invocação DINÂMICA (`.rpc(var)`): só 2 sítios, ambos de domínio FECHADO por literal
--     (pcp-apontamento.ts → 3 fn_pcp_*; melhoria-triagem → mapa RPC_POR_TOOL de 2 nomes) — nenhum a alcança;
--   • FALSIFICAÇÃO: o MESMO método rodado contra seed_targets_faltantes (chamada por cron diário)
--     ENCONTRA o chamador (calculate-scores/index.ts:299). O método discrimina — "não achou" é significativo.
--     ⚠️ pg_stat_user_functions NÃO serve de prova aqui: track_functions='none' nesta instância, então
--     a órfã E a função viva aparecem ambas com zero. Descartado como evidência.
--
-- NÃO é um dos 6 writers da Fatia 4 do épico P0-B-bis — é dívida independente, dropável já.
-- REVERSÍVEL: o corpo íntegro está no bloco de rollback ao fim (comentado).
-- ============================================================

DROP FUNCTION IF EXISTS public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint);

-- Guard: falha ALTO se sobrou algum overload do mesmo nome (o DROP acima é por assinatura).
DO $$
DECLARE v_sobrou int;
BEGIN
  SELECT count(*) INTO v_sobrou
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'omie_cliente_upsert_mapping';

  IF v_sobrou > 0 THEN
    RAISE EXCEPTION 'omie_cliente_upsert_mapping ainda tem % overload(s) — DROP incompleto', v_sobrou;
  END IF;
END $$;

-- ============================================================
-- ROLLBACK (se precisar ressuscitar — corpo verbatim de pg_get_functiondef, prod 2026-07-18):
--
-- CREATE OR REPLACE FUNCTION public.omie_cliente_upsert_mapping(p_user_id uuid, p_empresa text, p_codigo_cliente bigint, p_codigo_vendedor bigint)
--  RETURNS text
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE v_existing_codigo bigint; v_owner uuid;
-- BEGIN
--   IF p_user_id IS NULL OR p_empresa IS NULL OR p_codigo_cliente IS NULL THEN
--     RAISE EXCEPTION 'omie_cliente_upsert_mapping: argumentos obrigatorios nulos' USING ERRCODE = '22004';
--   END IF;
--   SELECT omie_codigo_cliente INTO v_existing_codigo FROM public.omie_clientes
--     WHERE user_id = p_user_id AND empresa_omie = p_empresa;
--   IF FOUND THEN
--     IF v_existing_codigo = p_codigo_cliente THEN RETURN 'noop'; END IF;
--     RETURN 'contested';
--   END IF;
--   SELECT user_id INTO v_owner FROM public.omie_clientes
--     WHERE omie_codigo_cliente = p_codigo_cliente AND empresa_omie = p_empresa;
--   IF FOUND AND v_owner <> p_user_id THEN RETURN 'contested'; END IF;
--   INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente, omie_codigo_vendedor)
--     VALUES (p_user_id, p_empresa, p_codigo_cliente, p_codigo_vendedor);
--   RETURN 'inserted';
-- EXCEPTION WHEN unique_violation THEN RETURN 'contested';
-- END; $function$;
-- REVOKE ALL ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint) FROM PUBLIC, anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint) TO service_role;
-- ============================================================
