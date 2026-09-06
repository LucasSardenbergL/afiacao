-- ============================================================================
-- valor_total_portal_provado — o total PROVADO pelo portal ganha casa própria
-- ============================================================================
-- Achado B2 do spec 2026-09-06-selo-preco-disparo-omie-design.md §9.3, confirmado pelo
-- challenge do Codex (2026-09-06). `pedido_compra_sugerido.valor_total` carregava DUAS
-- grandezas distintas sob um nome só:
--   (a) DERIVADO — Σ(valor_linha) dos itens. É o que o gate de mínimo compara antes do
--       envio, o que o e-mail ao fornecedor mostra e o que é coerente com o payload do
--       Omie (nQtde × nValUnit, item a item — o Omie NÃO recebe o total do cabeçalho);
--   (b) PROVADO — `data.value` do Efetivar do portal Sayerlack: o que o fornecedor de fato
--       cobrou. No #2459 as duas discordaram em R$ 13,06 (3,37%) — frete, arredondamento
--       do fornecedor ou desconto de linha; a origem segue em aberto (captura-custo.ts §24).
--
-- Sob um nome só, (b) sobrescrevia (a) e depois era sobrescrito de volta por qualquer um dos
-- CINCO escritores do derivado (reposicao_persistir_qtde_inteira, remover_itens_pedido_sugerido,
-- pedido_compra_split, aplicar_promocoes_no_ciclo, a edição inline do PedidoRow). O provado
-- sobrevivia por ACIDENTE, e seu único rastro durável era `portal_resposta.captura_custo.
-- checksum.total_json` — jsonb multi-writer que o próprio código rotula "NÃO autoritativa"
-- (CLAUDE.md: sinal money-path nunca em jsonb multi-writer → coluna dedicada + 1 escritor).
--
-- Esta migration:
--   1. cria as colunas do provado (valor + quando + PROTOCOLO — timestamp sozinho não diz
--      QUAL compra externa foi comprovada, e um envio posterior reescreve portal_protocolo);
--   2. reescreve `sayerlack_aplicar_custo_portal` para gravar o provado nas colunas novas E
--      RECALCULAR o derivado sobre TODOS os itens persistidos, na MESMA transação.
--
-- O passo 2 é a correção que o Codex exigiu: trocar só a coluna de destino deixaria o
-- cabeçalho OBSOLETO — a RPC reescreve preco_unitario/valor_linha dos itens, então quem
-- para de manter valor_total deixa o derivado apontando para o mundo de antes. Com os
-- números do #2459 isso produziria valor_total=387,83 sobre itens que somam 374,77.
--
-- Assinatura PRESERVADA (bigint, jsonb, numeric): entre o apply desta migration e o deploy
-- da edge nova, a edge no ar continua funcionando — array não-vazio segue o mesmo caminho.
-- Aplicar o BANCO ANTES da edge.
--
-- SQLSTATEs (classe CP = Custo do Portal; a edge casa a MARCA, não "lançou algo"):
--   CP001  payload inválido — não-array, item sem id, preço/valor/total não finitos ou ≤ 0.
--          Array VAZIO deixou de ser CP001: prova válida em que nenhum preço mudou é prova,
--          e `derivarCustos` pula item por `sem_mudanca`. Recusá-la descartava o dado do
--          fornecedor por não haver o que atualizar.
--   CP002  PO Omie JÁ EXISTE — recusa idempotente (o custo não pode mais mudar).
--   CP003  pedido não elegível — inexistente ou status_envio_portal ≠ 'sucesso_portal'.
--   CP004  itens divergentes — id repetido, item de OUTRO pedido, id inexistente.
--   CP005  derivado INDETERMINADO — item sem valor_linha, ou pedido sem item. Ausente ≠ zero:
--          `COALESCE(sum(...), 0)` fabricaria um total que alimentaria o gate de mínimo.
--          Fail-closed: nada é gravado, nem o provado.
--
-- Prova: db/test-sayerlack-custo-portal-cas.sh (PG17 descartável, falsificação por defesa).
-- Apply MANUAL (Lovable: SQL Editor → cola → Run).
-- ============================================================================

BEGIN;

ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado           numeric,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_em        timestamptz,
  ADD COLUMN IF NOT EXISTS valor_total_portal_provado_protocolo text;

COMMENT ON COLUMN public.pedido_compra_sugerido.valor_total_portal_provado IS
  'Total PROVADO pelo portal do fornecedor (data.value do Efetivar Sayerlack) — o que o fornecedor cobrou. NÃO é Σ(valor_linha): pode incluir frete/arredondamento/desconto. Escritor ÚNICO: sayerlack_aplicar_custo_portal. Compare com valor_total (derivado) para medir divergência; NUNCA COALESCE um no outro.';
COMMENT ON COLUMN public.pedido_compra_sugerido.valor_total_portal_provado_em IS
  'Quando o total provado foi gravado (mesma transação da prova).';
COMMENT ON COLUMN public.pedido_compra_sugerido.valor_total_portal_provado_protocolo IS
  'portal_protocolo vigente no instante da prova — identifica QUAL compra externa foi comprovada. Um envio posterior reescreve portal_protocolo; esta coluna não.';
COMMENT ON COLUMN public.pedido_compra_sugerido.valor_total IS
  'Total DERIVADO: Σ(pedido_compra_item.valor_linha). É o que o gate de valor mínimo compara e o que corresponde ao payload do Omie (nQtde × nValUnit). NÃO é o total cobrado pelo fornecedor — esse é valor_total_portal_provado.';

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
  v_atualizados integer := 0;
  v_omie        text;
  v_status      text;
  v_ids_distintos integer;
  v_sem_custo   integer;
  v_itens_total integer;
  v_derivado    numeric;
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
  -- Array VAZIO é legítimo: prova em que NENHUM preço mudou (todos pulados por 'sem_mudanca').
  -- O provado e o recálculo do derivado acontecem do mesmo jeito; só não há item a atualizar.
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

  -- (1) CAS no próprio UPDATE: só grava se AINDA não há PO Omie e o pedido está em sucesso_portal.
  -- O row-lock serializa contra quem grava omie_pedido_compra_numero nesta linha — trocar a COLUNA
  -- atribuída não afrouxa isso: o lock é da LINHA, e sob READ COMMITTED o predicado é reavaliado.
  -- O provado vai para coluna DEDICADA; `valor_total` (derivado) é recalculado no passo (3).
  UPDATE public.pedido_compra_sugerido p
     SET valor_total_portal_provado           = p_valor_total,
         valor_total_portal_provado_em        = now(),
         valor_total_portal_provado_protocolo = p.portal_protocolo
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
  IF v_n > 0 THEN
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
    GET DIAGNOSTICS v_atualizados = ROW_COUNT;
    IF v_atualizados <> v_n THEN
      -- Tudo-ou-nada: o RAISE desfaz também as colunas do provado do passo (1).
      RAISE EXCEPTION 'custo_portal: % itens no payload, % pertencem ao pedido % — nada gravado',
        v_n, v_atualizados, p_pedido_id USING ERRCODE = 'CP004';
    END IF;
  END IF;

  -- (3) o DERIVADO é remantido na MESMA transação, sobre TODOS os itens persistidos — não só os
  -- do payload. Sem este passo, trocar a coluna do passo (1) deixaria `valor_total` descrevendo
  -- os preços de ANTES da prova (Codex 2026-09-06: no #2459 seriam 387,83 sobre itens de 374,77).
  SELECT count(*), count(*) FILTER (WHERE valor_linha IS NULL), sum(valor_linha)
    INTO v_itens_total, v_sem_custo, v_derivado
    FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  -- CP005 — ausente ≠ zero. `COALESCE(sum(...), 0)` fabricaria o total que o gate de mínimo lê.
  IF v_itens_total = 0 OR v_sem_custo > 0 THEN
    RAISE EXCEPTION 'custo_portal: derivado indeterminado no pedido % (% itens, % sem valor_linha) — nada gravado',
      p_pedido_id, v_itens_total, v_sem_custo USING ERRCODE = 'CP005';
  END IF;
  UPDATE public.pedido_compra_sugerido SET valor_total = v_derivado WHERE id = p_pedido_id;

  RETURN v_atualizados;
END;
$function$;

COMMENT ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) IS
  'Custo do portal Sayerlack (edge enviar-pedido-portal-sayerlack, service_role): CAS omie IS NULL + sucesso_portal, itens tudo-ou-nada, total PROVADO em valor_total_portal_provado e DERIVADO recalculado em valor_total — mesma transação. SQLSTATE CP001..CP005.';

REVOKE ALL ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_custo_portal(bigint, jsonb, numeric) TO service_role;

-- O #2459 falhou com PGRST202 — a função EXISTIA em pg_proc, o schema cache do PostgREST é que
-- não a via. O reload costuma vir do event trigger do Supabase, mas depender disso é o que já
-- custou um envio cego: emitir o NOTIFY explicitamente é barato, idempotente e é a diferença
-- entre a captura gravar e continuar caindo em erro_rpc.
NOTIFY pgrst, 'reload schema';

-- Postcondição: colunas no ar, e a função é A NOVA (cita a coluna dedicada e o CP005) — não a
-- versão anterior, que gravava o provado por cima do derivado. Sem este último assert, colar
-- metade do bloco deixaria as colunas existindo e a função velha no ar, em silêncio.
DO $post$
DECLARE v_oid oid; v_def text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pedido_compra_sugerido'
         AND column_name IN ('valor_total_portal_provado', 'valor_total_portal_provado_em',
                             'valor_total_portal_provado_protocolo')) <> 3 THEN
    RAISE EXCEPTION 'POST FALHOU: as 3 colunas do total provado não existem — a RPC nova não teria onde gravar';
  END IF;
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sayerlack_aplicar_custo_portal'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_itens jsonb, p_valor_total numeric';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU: sayerlack_aplicar_custo_portal(bigint,jsonb,numeric) não existe — a edge cairia em erro_rpc em todo envio';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF v_def NOT LIKE '%valor_total_portal_provado%' OR v_def NOT LIKE '%CP005%' THEN
    RAISE EXCEPTION 'POST FALHOU: a função no ar é a versão ANTIGA (não cita valor_total_portal_provado/CP005) — o provado continuaria sobrescrevendo o derivado';
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
  RAISE NOTICE 'valor_total_portal_provado: 3 colunas no ar; RPC nova (CP005) SECDEF, search_path=public, anon/authenticated fechados, service_role executa';
END
$post$;

COMMIT;
