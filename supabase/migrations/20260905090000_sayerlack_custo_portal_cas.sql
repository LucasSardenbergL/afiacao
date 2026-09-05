-- ============================================================================
-- sayerlack_aplicar_custo_portal — custo do portal em UMA transação, com CAS no banco
-- ============================================================================
-- Fecha o risco residual do #2168 (docs/historico/sayerlack-captura-custo-cega.md, "jaTemOmie é
-- snapshot em memória") apontado no challenge do Codex (2026-09-05). Antes, a edge
-- `enviar-pedido-portal-sayerlack` gravava `pedido_compra_item.preco_unitario`/`valor_linha`
-- item a item (`.update().eq('id').select('id')`) e depois `pedido_compra_sugerido.valor_total`,
-- gateada por `jaTemOmie` lido ANTES das escritas. Dois buracos:
--   (a) escrita PARCIAL entre itens — virava sensor `escrita_parcial`, mas o custo MISTO (novo +
--       antigo) ficava persistido e podia virar `nValUnit` do PO Omie;
--   (b) corrida com a criação do PO no Omie entre a leitura de `omie_pedido_compra_numero` e a
--       escrita — o custo trocava DEPOIS de o PO existir.
--
-- Esta RPC (SECURITY DEFINER; EXECUTE só de service_role — a edge chama com service role):
--   1. compare-and-set no PRÓPRIO UPDATE do pedido: `omie_pedido_compra_numero IS NULL AND
--      status_envio_portal = 'sucesso_portal'` (sem SELECT prévio — o row-lock do UPDATE serializa
--      contra o `disparar-pedidos-aprovados`, que grava o número do PO na mesma linha);
--   2. atualiza TODOS os itens do array jsonb `[{item_id, preco_unitario, valor_linha}]` num UPDATE
--      só, exigindo que cada um pertença ao pedido e que `ROW_COUNT` == tamanho do array — senão
--      RAISE com SQLSTATE própria e ROLLBACK de tudo (inclusive o `valor_total` do passo 1);
--   3. `valor_total` = total PROVADO (`data.value` do Efetivar), gravado no mesmo UPDATE do passo 1.
--
-- SQLSTATEs (classe CP = Custo do Portal; a edge casa a MARCA, não "lançou algo"):
--   CP001  payload inválido — array vazio/não-array, item sem id, preço/valor/total não finitos ou
--          ≤ 0 (money-path §2: fecha os TRÊS lados — NOT NULL, <> 'NaN', < 'Infinity'; `'NaN'::numeric`
--          e `'Infinity'::numeric` PASSAM em `> 0`).
--   CP002  PO Omie JÁ EXISTE — recusa idempotente (não é cegueira: o custo não pode mais mudar).
--   CP003  pedido não elegível — inexistente ou `status_envio_portal` ≠ 'sucesso_portal'.
--   CP004  itens divergentes — id repetido, item de OUTRO pedido, id inexistente (ROW_COUNT ≠ n).
--
-- Gate: `auth.uid() IS NOT NULL AND NOT staff` → 42501 (espelha `envio_portal_claim_ids`); com
-- service_role o uid é NULL e passa. O fecho REAL é o privilégio (REVOKE por NOME de anon/
-- authenticated — `REVOKE FROM PUBLIC` não os tira; CLAUDE.md). `CREATE OR REPLACE` preserva ACL;
-- os REVOKE/GRANT são reafirmados no fim por idempotência.
--
-- Prova: db/test-sayerlack-custo-portal-cas.sh (PG17 descartável, falsificação por defesa).
-- Apply MANUAL (Lovable: SQL Editor → cola → Run). Registro em scripts/authz-funcoes-fechadas.ts.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.sayerlack_aplicar_custo_portal(
  p_pedido_id   bigint,
  p_itens       jsonb,
  p_valor_total numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n           integer;
  v_afetadas    integer;
  v_omie        text;
  v_status      text;
  v_ids_distintos integer;
BEGIN
  -- Gate de papel (defesa em profundidade; a tranca é o privilégio).
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- CP001 — payload. Ausente ≠ zero: nada aqui degrada para default.
  IF p_pedido_id IS NULL OR p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'custo_portal: payload inválido (pedido=%, itens=%)',
      coalesce(p_pedido_id::text, 'null'), coalesce(jsonb_typeof(p_itens), 'null')
      USING ERRCODE = 'CP001';
  END IF;
  v_n := jsonb_array_length(p_itens);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'custo_portal: array de itens vazio' USING ERRCODE = 'CP001';
  END IF;
  -- Três lados: NULL, NaN ('NaN' = 'NaN' é TRUE em numeric), finitude (< Infinity) — e > 0.
  IF p_valor_total IS NULL OR p_valor_total = 'NaN'::numeric
     OR NOT (p_valor_total > 0 AND p_valor_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'custo_portal: valor_total não finito ou ≤ 0 (%)', coalesce(p_valor_total::text, 'null')
      USING ERRCODE = 'CP001';
  END IF;
  -- Cada item: id inteiro, preço e valor finitos e > 0. `(e->>'x')::numeric` de 'NaN' PASSA em `> 0`.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE jsonb_typeof(e) <> 'object'
        OR (e->>'item_id') IS NULL OR (e->>'item_id') !~ '^[0-9]+$'
        OR (e->>'preco_unitario') IS NULL OR (e->>'valor_linha') IS NULL
        OR (e->>'preco_unitario')::numeric = 'NaN'::numeric OR (e->>'valor_linha')::numeric = 'NaN'::numeric
        OR NOT ((e->>'preco_unitario')::numeric > 0 AND (e->>'preco_unitario')::numeric < 'Infinity'::numeric)
        OR NOT ((e->>'valor_linha')::numeric > 0 AND (e->>'valor_linha')::numeric < 'Infinity'::numeric)
  ) THEN
    RAISE EXCEPTION 'custo_portal: item com id/preço/valor inválido no payload' USING ERRCODE = 'CP001';
  END IF;
  -- CP004 (forma barata): id repetido no array — o UPDATE ... FROM só afeta a linha uma vez e a
  -- contagem já acusaria, mas o motivo fica explícito.
  SELECT count(DISTINCT (e->>'item_id')::bigint) INTO v_ids_distintos FROM jsonb_array_elements(p_itens) e;
  IF v_ids_distintos <> v_n THEN
    RAISE EXCEPTION 'custo_portal: item_id repetido no payload (% ids, % distintos)', v_n, v_ids_distintos
      USING ERRCODE = 'CP004';
  END IF;

  -- (1)+(3) CAS no próprio UPDATE: só grava se AINDA não há PO Omie e o pedido está em sucesso_portal.
  -- O row-lock serializa contra quem grava omie_pedido_compra_numero nesta linha.
  UPDATE public.pedido_compra_sugerido p
     SET valor_total = p_valor_total
   WHERE p.id = p_pedido_id
     AND p.omie_pedido_compra_numero IS NULL
     AND p.status_envio_portal = 'sucesso_portal';
  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  IF v_afetadas <> 1 THEN
    -- Diagnóstico (só para o SQLSTATE certo — a decisão já foi tomada pelo UPDATE acima).
    SELECT p.omie_pedido_compra_numero, p.status_envio_portal INTO v_omie, v_status
      FROM public.pedido_compra_sugerido p WHERE p.id = p_pedido_id;
    IF FOUND AND v_omie IS NOT NULL THEN
      RAISE EXCEPTION 'custo_portal: pedido % já tem PO Omie (%) — custo não muda mais', p_pedido_id, v_omie
        USING ERRCODE = 'CP002';
    END IF;
    RAISE EXCEPTION 'custo_portal: pedido % não elegível (status_envio_portal=%)',
      p_pedido_id, coalesce(v_status, 'inexistente') USING ERRCODE = 'CP003';
  END IF;

  -- (2) todos os itens num UPDATE só; pertencimento ao pedido no WHERE.
  UPDATE public.pedido_compra_item i
     SET preco_unitario = a.preco_unitario,
         valor_linha    = a.valor_linha
    FROM (
      SELECT (e->>'item_id')::bigint AS item_id,
             (e->>'preco_unitario')::numeric AS preco_unitario,
             (e->>'valor_linha')::numeric AS valor_linha
        FROM jsonb_array_elements(p_itens) e
    ) a
   WHERE i.id = a.item_id
     AND i.pedido_id = p_pedido_id;
  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  IF v_afetadas <> v_n THEN
    -- Tudo-ou-nada: o RAISE desfaz também o valor_total do passo (1).
    RAISE EXCEPTION 'custo_portal: % itens no payload, % pertencem ao pedido % — nada gravado',
      v_n, v_afetadas, p_pedido_id USING ERRCODE = 'CP004';
  END IF;

  RETURN v_afetadas;
END;
$function$;

COMMENT ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) IS
  'Custo do portal Sayerlack (edge enviar-pedido-portal-sayerlack, service_role): CAS omie IS NULL + sucesso_portal, itens tudo-ou-nada, valor_total provado. SQLSTATE CP001..CP004.';

REVOKE ALL ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO service_role;

-- Postcondição: a função existe, é SECDEF, tem search_path preso e NÃO é executável por anon/authenticated.
DO $post$
DECLARE v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_aplicar_custo_portal'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_itens jsonb, p_valor_total numeric';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_aplicar_custo_portal(bigint,jsonb,numeric) não existe — a edge cairia em erro_rpc em todo envio';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU: função não é SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proconfig::text LIKE '%search_path=public%') THEN
    RAISE EXCEPTION 'POST FALHOU: search_path não está preso em public';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: anon/authenticated ainda executam sayerlack_aplicar_custo_portal — REVOKE por nome não pegou';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU: service_role sem EXECUTE — a edge não conseguiria gravar custo';
  END IF;
  RAISE NOTICE 'sayerlack_aplicar_custo_portal: SECDEF, search_path=public, anon/authenticated fechados, service_role executa';
END
$post$;

COMMIT;
