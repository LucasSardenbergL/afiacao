-- ============================================================
-- ATP/reserva de estoque — FASE 3.1: o elo reserva↔PV sobrevive ao DELETE
-- [money-path] · Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
-- Depende das fases 1 (20260806101417), 1.1 (20260806225052), 2 (20260807015000)
-- e 3 (20260808012000) — todas APLICADAS em produção (conferido via psql-ro em
-- 2026-10-09: coluna faturamento_observado_em, private.atp_reconciliar_job e o
-- cron 'atp-reconciliar' ativos). Pré-flight: os 4 corpos que este arquivo
-- recria são BYTE-A-BYTE iguais ao repo da fase 3 (pg_get_functiondef da prod ×
-- PG17 com as 4 migrations aplicadas, 2026-10-09).
--
-- PROBLEMA: a reserva só conhecia o pedido por estoque_reservas.sales_order_id,
-- que é FK ON DELETE SET NULL. O `excluir_pedido` (edge omie-vendas-sync) faz
-- DELETE da linha push de sales_orders — e faz o DELETE MESMO QUANDO o
-- CancelarPedido falhou no Omie (o erro remoto é engolido: "continuando exclusão
-- local"). Nesse caso pior: PV VIVO no Omie, reserva sem elo com pedido nenhum,
-- o predicado de PV firme (EXISTS em sales_orders) deixa de casar, a reserva
-- volta ao TTL e expira — o estoque do PV vivo volta a parecer livre.
-- A fase 3 não piorou isto (antes dela a reserva morria por TTL de qualquer
-- jeito), mas também não consertou.
--
-- CONSERTO:
--  (1) estoque_reservas ganha o PAR PRÓPRIO (omie_pedido_id, omie_account) —
--      não depende da linha push existir. WRITE-ONCE (trigger): nasce NULL,
--      recebe o PID uma vez, e nunca mais muda nem volta a NULL.
--  (2) UM writer: public.atp_confirmar_pv. Ela grava o write-back do PV em
--      sales_orders E carimba o par nas reservas ativas do pedido NA MESMA
--      TRANSAÇÃO — substitui o `.update()` solto que o edge fazia em
--      criarPedidoVenda (aquele `.update()` era o que tornava a reserva firme,
--      indiretamente, via EXISTS). Ninguém mais escreve o par: service_role não
--      tem UPDATE em estoque_reservas desde a fase 1.1 e nenhuma outra função
--      DEFINER o menciona (valida-atp-fase3-1.sql confere por catálogo).
--  (3) "PV firme" passa a ser: o par próprio preenchido OU o EXISTS legado em
--      sales_orders. A UNIÃO é deliberada: entre aplicar esta migration e
--      deployar o edge novo, o edge velho ainda grava só sales_orders — sem o
--      EXISTS, a reserva confirmada nessa janela voltaria ao TTL (regressão em
--      relação à fase 3). Os dois ramos significam a mesma coisa (PV confirmado);
--      o próprio só ACRESCENTA a sobrevivência ao DELETE.
--  (4) A reconciliação acha a linha CANÔNICA pelo par próprio quando ele
--      existe (a push pode ter sumido), e pelo vínculo só como fallback.
--      Reserva desvinculada com par próprio ENTRA na varredura e na fila humana
--      — é exatamente o caso que antes ficava cego.
--
-- ⚠️ ORDEM DE DEPLOY: migration ANTES do edge. O edge novo chama a RPC; se ela
--    não existir (PGRST202), ele cai no write-back legado com log de erro alto —
--    nunca deixa um PV criado no Omie sem write-back.
--
-- SOBRE O LOCK: ao contrário do job, a atp_confirmar_pv pode AUMENTAR o
-- reservado de um SKU — uma reserva ainda 'ativa' cujo expira_em já passou
-- (o job de TTL não rodou) deixa de ser ignorada pelo cálculo quando vira
-- firme. É o caso que a fase 3 registrou como gatilho ("se a reconciliação
-- passar a CRIAR ou AUMENTAR reserva, o lock volta a ser obrigatório"). Por isso
-- ela trava como o reservar_estoque: checkout(s) primeiro, depois SKUs em ordem
-- crescente, no MESMO namespace — mesma ordem global, sem ciclo, sem deadlock.
-- (Contar essa reserva é o honesto: o PV existe; se a unidade foi re-prometida
-- no intervalo, o disponível negativo é a informação verdadeira.)
--
-- NÃO entra (registrado de propósito — cada um é outra entrega):
--  • Consumo automático (frente A da 3.1). A âncora proposta — run de
--    `sync_estoque` em public.fin_sync_log — NÃO serve, medido em 2026-10-09:
--    aquela ação é do omie-vendas-sync e grava omie_products.estoque (2 páginas
--    por chamada), nunca inventory_position; e não registra run desde
--    2026-08-22. Quem escreve o pool oben hoje (omie-analytics-sync para
--    'vendas', sync-reprocess para 'oben') não deixa run durável com started_at.
--  • Mudar o excluir_pedido (DELETE local mesmo com CancelarPedido falho). Com
--    o par próprio, o ciclo deixa de ficar cego: a reserva segue firme e a
--    reconciliação só a libera quando a canônica disser 'cancelado'.
--  • O protocolo de lock do SYNC (P0 estrutural: inventory_position escrito
--    sem o advisory lock do SKU).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) O par próprio (sobrevive ao DELETE da linha push)
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.estoque_reservas
  ADD COLUMN IF NOT EXISTS omie_pedido_id bigint,
  ADD COLUMN IF NOT EXISTS omie_account text;

ALTER TABLE public.estoque_reservas DROP CONSTRAINT IF EXISTS estoque_reservas_pv_par_check;
ALTER TABLE public.estoque_reservas ADD CONSTRAINT estoque_reservas_pv_par_check
  CHECK (
    (omie_pedido_id IS NULL AND omie_account IS NULL)
    OR (omie_pedido_id > 0 AND omie_account IS NOT NULL AND btrim(omie_account) <> '')
  );

COMMENT ON COLUMN public.estoque_reservas.omie_pedido_id IS
  'PID do PV CONFIRMADO no Omie a que esta reserva pertence. Writer ÚNICO: '
  'public.atp_confirmar_pv (mesma transação do write-back em sales_orders). '
  'Write-once (trigger trg_estoque_reservas_pv_write_once). Sobrevive ao DELETE '
  'da linha push — é o elo com a linha canônica quando sales_order_id vira NULL.';
COMMENT ON COLUMN public.estoque_reservas.omie_account IS
  'Conta (sales_orders.account) do PV em omie_pedido_id — o par (conta, PID) acha '
  'a linha canônica. Mesmo writer e mesma regra write-once de omie_pedido_id.';

-- Varredura da reconciliação pelo par próprio.
CREATE INDEX IF NOT EXISTS idx_estoque_reservas_pv_ativa
  ON public.estoque_reservas (omie_account, omie_pedido_id)
  WHERE status = 'ativa' AND omie_pedido_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 2) WRITE-ONCE. O par só pode nascer NULL e passar de NULL a um valor, uma
--    vez. Apagar ou trocar o PID recriaria exatamente o ciclo cego que esta
--    fase fecha — e nenhum caminho legítimo precisa disso.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.estoque_reservas_pv_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.omie_pedido_id IS NOT NULL OR NEW.omie_account IS NOT NULL THEN
      RAISE EXCEPTION 'estoque_reservas: reserva nasce sem PV — o par (omie_account, omie_pedido_id) só é gravado por public.atp_confirmar_pv'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.omie_pedido_id IS NOT NULL
     AND (NEW.omie_pedido_id IS DISTINCT FROM OLD.omie_pedido_id
          OR NEW.omie_account IS DISTINCT FROM OLD.omie_account) THEN
    RAISE EXCEPTION 'estoque_reservas %: o par do PV é write-once (% / %) — não pode ser trocado nem apagado',
      OLD.id, OLD.omie_account, OLD.omie_pedido_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.estoque_reservas_pv_write_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.estoque_reservas_pv_write_once() FROM anon;
REVOKE ALL ON FUNCTION private.estoque_reservas_pv_write_once() FROM authenticated;

DROP TRIGGER IF EXISTS trg_estoque_reservas_pv_write_once ON public.estoque_reservas;
CREATE TRIGGER trg_estoque_reservas_pv_write_once
  BEFORE INSERT OR UPDATE OF omie_pedido_id, omie_account ON public.estoque_reservas
  FOR EACH ROW EXECUTE FUNCTION private.estoque_reservas_pv_write_once();

-- ────────────────────────────────────────────────────────────
-- 3) Backfill: reservas cujo pedido JÁ tem PV recebem o par agora (é o mesmo
--    fato que o EXISTS legado já lia). Todas as situações, não só 'ativa': nas
--    encerradas é só rastro (o cálculo exige 'ativa'). Idempotente: só toca
--    quem ainda está sem par. Em prod (2026-10-09): 1 reserva, 'expirada'.
-- ────────────────────────────────────────────────────────────
UPDATE public.estoque_reservas r
   SET omie_pedido_id = so.omie_pedido_id,
       omie_account = so.account
  FROM public.sales_orders so
 WHERE so.id = r.sales_order_id
   AND so.omie_pedido_id > 0
   AND so.account IS NOT NULL
   AND btrim(so.account) <> ''
   AND r.omie_pedido_id IS NULL;

-- ────────────────────────────────────────────────────────────
-- 4) A linha CANÔNICA de uma RESERVA. Par próprio primeiro (a push pode ter
--    sido apagada); vínculo só como fallback (reserva confirmada pelo edge
--    velho, antes do deploy). Mesmo critério de canônica da fase 3:
--    (account, omie_pedido_id) com hash_payload preenchido — no máximo UMA
--    linha (uniq_sales_orders_omie_pedido_id). 0 linhas ⇒ nada age.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_canonico_da_reserva(p_reserva_id uuid)
RETURNS TABLE (canonico_id uuid, status text, omie_pedido_id bigint, account text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.id, c.status, c.omie_pedido_id, c.account
  FROM public.estoque_reservas r
  LEFT JOIN public.sales_orders push ON push.id = r.sales_order_id
  JOIN public.sales_orders c
    ON c.account = CASE WHEN r.omie_pedido_id IS NOT NULL THEN r.omie_account ELSE push.account END
   AND c.omie_pedido_id = COALESCE(r.omie_pedido_id, push.omie_pedido_id)
   AND c.hash_payload IS NOT NULL
  WHERE r.id = p_reserva_id
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION private.atp_canonico_da_reserva(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_canonico_da_reserva(uuid) FROM anon;
REVOKE ALL ON FUNCTION private.atp_canonico_da_reserva(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.atp_canonico_da_reserva(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 5) O cálculo — recriado INTEIRO (transcrição da fase 3, provada igual à
--    prod). A ÚNICA mudança é o predicado de PV firme no CTE `res`.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_disponivel(
  p_pool text,
  p_sku bigint,
  p_excluir_checkout uuid DEFAULT NULL
)
RETURNS TABLE (
  saldo numeric,
  saldo_synced_at timestamptz,
  saldo_confiavel boolean,
  reservado numeric,
  seguranca numeric,
  disponivel numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH pool_contas AS (
    SELECT CASE p_pool WHEN 'oben' THEN ARRAY['vendas','oben'] ELSE ARRAY[]::text[] END AS contas
  ),
  linha AS (
    -- eleição por frescor entre as contas do pool (padrão ESTOQUE_ACCOUNTS do
    -- cockpit): a linha mais recente vence; empate → account em ordem estável.
    -- Elege entre TODAS as linhas (não só as válidas) de propósito: se a mais
    -- fresca for inválida, o guard abaixo reprova o SKU inteiro (fail-closed)
    -- em vez de cair numa linha velha que por acaso passa.
    SELECT ip.saldo, ip.synced_at
    FROM public.inventory_position ip, pool_contas pc
    WHERE ip.omie_codigo_produto = p_sku
      AND ip.account = ANY (pc.contas)
    ORDER BY ip.synced_at DESC NULLS LAST, ip.account
    LIMIT 1
  ),
  frescas AS (
    -- posições do pool que passariam TODOS os guards por si só. Serve só para
    -- medir concordância entre contas (C3).
    SELECT ip.saldo
    FROM public.inventory_position ip, pool_contas pc
    WHERE ip.omie_codigo_produto = p_sku
      AND ip.account = ANY (pc.contas)
      AND ip.synced_at IS NOT NULL
      AND ip.synced_at > now() - interval '24 hours'
      AND ip.synced_at <= now() + interval '5 minutes'
      AND ip.saldo IS NOT NULL
      AND ip.saldo <> 'NaN'::numeric
      AND ip.saldo >= 0
      AND ip.saldo < 'Infinity'::numeric
  ),
  base AS (
    SELECT
      (SELECT l.saldo FROM linha l) AS saldo,
      (SELECT l.synced_at FROM linha l) AS synced_at,
      -- C3: 2+ saldos distintos entre posições frescas e válidas = as contas
      -- deixaram de ser espelho ⇒ não sabemos qual é a verdade ⇒ não prometer.
      (SELECT count(DISTINCT f.saldo) > 1 FROM frescas f) AS divergente
  ),
  seg AS (
    -- Parâmetro AUSENTE = sem colchão configurado (0) — default de política,
    -- não dado fabricado. Parâmetro PRESENTE mas inválido (NaN/Infinity/<0) =
    -- C2: não dá para calcular ⇒ o SKU vira não-confiável (nunca colchão 0,
    -- que removeria a proteção em silêncio).
    -- LIMIT 1 sem ORDER BY é seguro: prod tem UNIQUE(empresa, sku_codigo_omie),
    -- conferido via psql-ro — a duplicata que a fase 1 tratava é impossível.
    SELECT
      COALESCE((
        SELECT sp.estoque_seguranca
        FROM public.sku_parametros sp
        WHERE sp.empresa = (CASE p_pool WHEN 'oben' THEN 'OBEN' END)
          AND sp.sku_codigo_omie = p_sku
          AND sp.estoque_seguranca IS NOT NULL
          AND sp.estoque_seguranca <> 'NaN'::numeric
          AND sp.estoque_seguranca >= 0
          AND sp.estoque_seguranca < 'Infinity'::numeric
        LIMIT 1
      ), 0) AS seguranca,
      EXISTS (
        SELECT 1
        FROM public.sku_parametros sp
        WHERE sp.empresa = (CASE p_pool WHEN 'oben' THEN 'OBEN' END)
          AND sp.sku_codigo_omie = p_sku
          AND sp.estoque_seguranca IS NOT NULL
          AND NOT (
            sp.estoque_seguranca <> 'NaN'::numeric
            AND sp.estoque_seguranca >= 0
            AND sp.estoque_seguranca < 'Infinity'::numeric
          )
      ) AS seg_invalida
  ),
  calc AS (
    SELECT
      b.saldo,
      b.synced_at,
      -- FAIL-CLOSED. NaN em numeric ordena ACIMA de tudo ('NaN' >= 0 é true) e
      -- 'NaN' = 'NaN' é true, então o <> 'NaN' pega. Infinity também passaria o
      -- >= 0 — daí o bound de finitude (C1).
      (b.synced_at IS NOT NULL
        AND b.synced_at > now() - interval '24 hours'
        AND b.synced_at <= now() + interval '5 minutes'
        AND b.saldo IS NOT NULL
        AND b.saldo <> 'NaN'::numeric
        AND b.saldo >= 0
        AND b.saldo < 'Infinity'::numeric
        AND NOT b.divergente
        AND NOT s.seg_invalida) AS confiavel
    FROM base b CROSS JOIN seg s
  ),
  res AS (
    -- FASE 3 — reserva de PV FIRME desconta enquanto estiver 'ativa', SEM olhar
    -- expira_em (o Omie só baixa o saldo no faturamento; p90 medido de 324h).
    -- Quem a tira de 'ativa' é o desfecho — cancelamento confirmado (job) ou
    -- resolução humana auditada. Reserva pré-PV segue no TTL.
    -- FASE 3.1 — a ÚNICA mudança desta migration no cálculo: "PV firme" passa a
    -- ser o PAR PRÓPRIO da reserva (r.omie_pedido_id, gravado por
    -- atp_confirmar_pv, sobrevive ao DELETE da linha push) OU o EXISTS legado
    -- pelo vínculo (reserva confirmada pelo edge antigo, antes do deploy).
    SELECT COALESCE(sum(r.quantidade), 0) AS reservado
    FROM public.estoque_reservas r
    WHERE r.pool = p_pool
      AND r.omie_codigo_produto = p_sku
      AND r.status = 'ativa'
      AND (
        r.expira_em > now()
        OR r.omie_pedido_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.sales_orders so
          WHERE so.id = r.sales_order_id
            AND so.omie_pedido_id IS NOT NULL
        )
      )
      AND (p_excluir_checkout IS NULL OR r.checkout_id <> p_excluir_checkout)
  )
  SELECT
    c.saldo,
    c.synced_at,
    COALESCE(c.confiavel, false),
    r.reservado,
    s.seguranca,
    -- disponivel pode ser NEGATIVO (reservas+colchão > saldo após queda no sync):
    -- informação honesta p/ a reconciliação — não clampar em 0.
    CASE WHEN COALESCE(c.confiavel, false)
         THEN c.saldo - r.reservado - s.seguranca
         ELSE NULL END
  FROM calc c
  CROSS JOIN res r
  CROSS JOIN seg s;
$function$;

REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM anon;
REVOKE ALL ON FUNCTION private.atp_disponivel(text, bigint, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION private.atp_disponivel(text, bigint, uuid) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 6) A higiene por TTL — MESMO predicado do cálculo (se divergissem, a reserva
--    sairia de 'ativa' aqui e o cálculo pararia de contá-la).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.expirar_reservas_vencidas_job()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.estoque_reservas r
     SET status = 'expirada',
         motivo = 'expirada por TTL',
         atualizado_em = now()
   WHERE r.status = 'ativa'
     AND r.expira_em <= now()
     -- FASE 3.1: PV firme = par próprio (sobrevive ao DELETE) OU o EXISTS legado.
     AND r.omie_pedido_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.sales_orders so
       WHERE so.id = r.sales_order_id
         AND so.omie_pedido_id IS NOT NULL
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'expiradas', v_n);
END;
$function$;

REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM anon;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM authenticated;

-- ────────────────────────────────────────────────────────────
-- 7) A reconciliação — recriada INTEIRA. Mudanças em relação à fase 3:
--    • a canônica vem de atp_canonico_da_reserva(r.id) (par próprio primeiro);
--    • a população é "ativa E tem pedido" = vínculo OU par próprio — a reserva
--      cujo push foi apagado ENTRA (antes ficava de fora para sempre).
--    O resto (o que cada passo faz, o carimbo com clock_timestamp, a trilha) é
--    o da fase 3.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.atp_reconciliar_job()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_liberadas integer := 0;
  v_observadas integer := 0;
  v_rearmadas integer := 0;
  v_aguardando integer;
  v_presas integer;
BEGIN
  -- ── (a) LIBERAÇÃO por cancelamento CONFIRMADO no Omie (etapa 80 → 'cancelado'
  --        na linha canônica). deleted_at NÃO entra (o front o grava antes da
  --        confirmação remota) — e o DELETE da push também não: sem 'cancelado'
  --        na canônica, a reserva desvinculada segue ativa (PV pode estar vivo).
  WITH alvo AS (
    SELECT r.id, r.checkout_id, r.sales_order_id, k.account
    FROM public.estoque_reservas r
    CROSS JOIN LATERAL private.atp_canonico_da_reserva(r.id) k
    WHERE r.status = 'ativa'
      AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
      AND k.status = 'cancelado'
  ),
  upd AS (
    UPDATE public.estoque_reservas r
       SET status = 'liberada',
           motivo = 'reconciliacao: cancelamento confirmado no Omie',
           atualizado_em = now()
      FROM alvo a
     WHERE r.id = a.id
    RETURNING a.sales_order_id AS so_id, a.checkout_id AS ck, a.account AS acc
  ),
  trilha AS (
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, actor_user_id)
    SELECT DISTINCT u.so_id, u.ck, 'oben', COALESCE(u.acc, 'oben'),
           'liberado_por_cancelamento', 'reconciliacao', true, NULL::uuid
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_liberadas FROM upd;

  -- ── (b) OBSERVAÇÃO do faturamento. Só CARIMBA — não consome (ver fase 3,
  --        item B, e o "NÃO entra" deste cabeçalho).
  WITH alvo AS (
    SELECT r.id, r.checkout_id, r.sales_order_id, k.account
    FROM public.estoque_reservas r
    CROSS JOIN LATERAL private.atp_canonico_da_reserva(r.id) k
    WHERE r.status = 'ativa'
      AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
      AND r.faturamento_observado_em IS NULL
      AND k.status = 'faturado'
  ),
  upd AS (
    UPDATE public.estoque_reservas r
       SET faturamento_observado_em = clock_timestamp(),
           atualizado_em = now()
      FROM alvo a
     WHERE r.id = a.id
    RETURNING a.sales_order_id AS so_id, a.checkout_id AS ck, a.account AS acc
  ),
  trilha AS (
    INSERT INTO public.atp_decisoes
      (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, actor_user_id)
    SELECT DISTINCT u.so_id, u.ck, 'oben', COALESCE(u.acc, 'oben'),
           'faturamento_observado', 'reconciliacao', true, NULL::uuid
    FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_observadas FROM upd;

  -- ── (c) REARMA o carimbo quando o status canônico REGREDIU.
  UPDATE public.estoque_reservas r
     SET faturamento_observado_em = NULL,
         atualizado_em = now()
   WHERE r.status = 'ativa'
     AND r.faturamento_observado_em IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM private.atp_canonico_da_reserva(r.id) k
       WHERE k.status = 'faturado'
     );
  GET DIAGNOSTICS v_rearmadas = ROW_COUNT;

  -- ── Observabilidade (a reserva desvinculada com par próprio CONTA aqui).
  SELECT count(*) INTO v_aguardando
  FROM public.estoque_reservas r
  WHERE r.status = 'ativa' AND r.faturamento_observado_em IS NOT NULL;

  SELECT count(*) INTO v_presas
  FROM public.estoque_reservas r
  WHERE r.status = 'ativa'
    AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
    AND r.created_at <= now() - interval '7 days';

  RETURN jsonb_build_object(
    'ok', true,
    'liberadas_por_cancelamento', v_liberadas,
    'faturamentos_observados', v_observadas,
    'carimbos_rearmados', v_rearmadas,
    'aguardando_resolucao', v_aguardando,
    'ativas_ha_mais_de_7d', v_presas
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM anon;
REVOKE ALL ON FUNCTION private.atp_reconciliar_job() FROM authenticated;

-- ────────────────────────────────────────────────────────────
-- 8) A fila humana — mesma assinatura e colunas da fase 3. Mudanças: entra a
--    reserva DESVINCULADA com par próprio (status_vinculado vem NULL = a linha
--    push foi apagada — é o caso que mais precisa de olho humano), e o PID e a
--    canônica vêm do par próprio quando ele existe.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_reservas_pendentes(p_dias integer DEFAULT 0)
RETURNS TABLE (
  reserva_id uuid,
  sales_order_id uuid,
  omie_pedido_id bigint,
  omie_codigo_produto bigint,
  quantidade numeric,
  status_vinculado text,
  status_canonico text,
  faturamento_observado_em timestamptz,
  ativa_ha_dias numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT private.cap_estoque_reservar((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'Sem permissão para listar reservas de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  IF p_dias IS NULL OR p_dias < 0 THEN
    RAISE EXCEPTION 'p_dias deve ser >= 0' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT r.id, r.sales_order_id, COALESCE(r.omie_pedido_id, so.omie_pedido_id),
         r.omie_codigo_produto, r.quantidade,
         so.status, k.status, r.faturamento_observado_em,
         round((EXTRACT(epoch FROM (now() - r.created_at)) / 86400)::numeric, 1)
  FROM public.estoque_reservas r
  LEFT JOIN public.sales_orders so ON so.id = r.sales_order_id
  LEFT JOIN LATERAL private.atp_canonico_da_reserva(r.id) k ON true
  WHERE r.status = 'ativa'
    AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
    AND r.created_at <= now() - make_interval(days => p_dias)
  ORDER BY r.faturamento_observado_em NULLS LAST, r.created_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_reservas_pendentes(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_reservas_pendentes(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.atp_reservas_pendentes(integer) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 9) O WRITER ÚNICO do par: write-back do PV + carimbo das reservas, numa
--    transação. Substitui o `.update()` de criarPedidoVenda (edge
--    omie-vendas-sync), que deixava o estado intermediário "PV criado no Omie +
--    reserva por transicionar" e, no DELETE da push, perdia o elo.
--    Contrato preservado do write-back antigo: casa por (id, account) e exige
--    EXATAMENTE 1 linha — 0 linhas é exceção (P0002), e aí NADA é gravado
--    (nem o carimbo das reservas). Chamador: só o edge, como service_role.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_confirmar_pv(
  p_sales_order_id uuid,
  p_account text,
  p_omie_pedido_id bigint,
  p_omie_numero_pedido text,
  p_omie_payload jsonb,
  p_omie_response jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ck uuid;
  v_lock record;
  v_n_so integer;
  v_n_res integer;
BEGIN
  -- Defesa em profundidade: o EXECUTE já é só de service_role (REVOKE abaixo).
  -- Se um GRANT acidental abrir a função, staff/cliente ainda não carimbam PV.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'atp_confirmar_pv é exclusiva do edge (service_role)'
      USING ERRCODE = '42501';
  END IF;
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'p_sales_order_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_account IS NULL OR btrim(p_account) = '' THEN
    RAISE EXCEPTION 'p_account é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_omie_pedido_id IS NULL OR p_omie_pedido_id <= 0 THEN
    RAISE EXCEPTION 'p_omie_pedido_id inválido: %', p_omie_pedido_id USING ERRCODE = '22023';
  END IF;

  -- Serialização com reservar_estoque, na MESMA ordem global dele: checkout(s)
  -- primeiro, depois SKUs em ordem crescente, mesmo namespace. Ver cabeçalho
  -- ("SOBRE O LOCK") — aqui o reservado de um SKU pode SUBIR.
  FOR v_ck IN
    SELECT DISTINCT r.checkout_id
    FROM public.estoque_reservas r
    WHERE r.sales_order_id = p_sales_order_id AND r.status = 'ativa'
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:checkout:' || v_ck::text, 0));
  END LOOP;
  FOR v_lock IN
    SELECT DISTINCT r.pool, r.omie_codigo_produto AS sku
    FROM public.estoque_reservas r
    WHERE r.sales_order_id = p_sales_order_id AND r.status = 'ativa'
    ORDER BY r.omie_codigo_produto, r.pool
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:sku:' || v_lock.pool || ':' || v_lock.sku::text, 0));
  END LOOP;

  UPDATE public.sales_orders
     SET omie_pedido_id = p_omie_pedido_id,
         omie_numero_pedido = p_omie_numero_pedido,
         omie_payload = p_omie_payload,
         omie_response = p_omie_response,
         status = 'enviado'
   WHERE id = p_sales_order_id
     AND account = p_account;
  GET DIAGNOSTICS v_n_so = ROW_COUNT;
  IF v_n_so <> 1 THEN
    RAISE EXCEPTION 'write-back do PV % não casou exatamente 1 linha (id=%, account=%)',
      p_omie_pedido_id, p_sales_order_id, p_account
      USING ERRCODE = 'P0002';
  END IF;

  -- Carimba SÓ as ativas: reserva já encerrada (expirada/liberada/consumida)
  -- continua encerrada — o cálculo exige 'ativa' e a fase 3 já travou que
  -- expirada não ressuscita (assert A5). O trigger write-once barra PID trocado.
  UPDATE public.estoque_reservas r
     SET omie_pedido_id = p_omie_pedido_id,
         omie_account = p_account,
         atualizado_em = now()
   WHERE r.sales_order_id = p_sales_order_id
     AND r.status = 'ativa';
  GET DIAGNOSTICS v_n_res = ROW_COUNT;

  RETURN jsonb_build_object('ok', true,
                            'sales_order_id', p_sales_order_id,
                            'omie_pedido_id', p_omie_pedido_id,
                            'reservas_firmadas', v_n_res);
END;
$function$;

REVOKE ALL ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) TO service_role;
