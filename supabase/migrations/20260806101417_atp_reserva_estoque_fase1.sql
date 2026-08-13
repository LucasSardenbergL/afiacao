-- ============================================================
-- ATP/reserva de estoque — FASE 1: fundação no banco [money-path]
-- Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
--
-- disponivel = saldo_confiavel − reservas_ativas − estoque_seguranca
--
-- Decisões (parecer Codex 2026-08-03, handoff da fase):
--  • FAIL-CLOSED: sem linha em inventory_position, synced_at defasado (>24h),
--    saldo NULL/negativo/NaN → saldo NÃO-confiável → disponivel = NULL e a
--    reserva é RECUSADA. Nunca fabricar disponibilidade (ausente ≠ zero).
--  • Pool fase 1 = 'oben' (empresa Oben): saldo eleito por FRESCOR entre
--    inventory_position.account IN ('vendas','oben') — padrão ESTOQUE_ACCOUNTS
--    do fin-valor-cockpit. Colacor entra em fase futura (decisão de produto).
--  • estoque_seguranca vem de sku_parametros (empresa 'OBEN'); parâmetro
--    ausente = colchão 0 (default de política — não é dado fabricado).
--  • 1 WRITER: escrita em estoque_reservas SÓ pelas RPCs SECURITY DEFINER
--    deste arquivo (authenticated fica sem privilégio de INSERT/UPDATE/DELETE).
--  • Reserva órfã: expira_em obrigatório; reserva vencida NÃO desconta no
--    cálculo; expirar_reservas_vencidas() marca vencidas (higiene observável).
--    Reconciliação completa (consumo pós-PV × sync Omie) é a fase 3.
--  • Janela conhecida (fase 3 fecha): entre o PV criado e o sync refletir o
--    saldo, a reserva 'consumida' não desconta e o saldo ainda não caiu.
--    Na fase 1 nada marca 'consumida' — estado reservado ao desenho da fase 2/3.
--  • Concorrência: pg_advisory_xact_lock por checkout e por SKU em ordem
--    determinística (deadlock-free) — 2 reservas simultâneas do mesmo saldo
--    serializam e a segunda é recusada. xact-lock vale aqui porque a reserva
--    é UMA chamada/transação (a restrição do lease do money-path §10 é para
--    estado que atravessa N chamadas HTTP).
--  • Recusa de NEGÓCIO = retorno jsonb {ok:false, recusas:[...]} (nunca vira
--    "[object Object]" no toast — money-path §12). Violação de CONTRATO/gate
--    = RAISE com SQLSTATE testável (22023 / 42501).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) Gate de capability: staff (employee/master) OU service_role
--    (service_role p/ engines/reconciliação da fase 3 — cron sem JWT de user)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.cap_estoque_reservar(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT auth.role()) = 'service_role'
    OR (
      _uid IS NOT NULL
      AND (
        public.has_role(_uid, 'master'::public.app_role)
        OR public.has_role(_uid, 'employee'::public.app_role)
      )
    ), false);
$function$;

REVOKE ALL ON FUNCTION private.cap_estoque_reservar(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.cap_estoque_reservar(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION private.cap_estoque_reservar(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 2) Tabela de reservas
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.estoque_reservas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- fase 1: só o pool 'oben' (contas Omie 'vendas'+'oben'); ampliar exige migration
  pool text NOT NULL CONSTRAINT estoque_reservas_pool_check CHECK (pool = 'oben'),
  omie_codigo_produto bigint NOT NULL,
  quantidade numeric NOT NULL CONSTRAINT estoque_reservas_qtd_check
    CHECK (quantidade > 0 AND quantidade <= 1000000),
  -- elo idempotente com o checkout (sales_orders.checkout_id é uuid)
  checkout_id uuid NOT NULL,
  -- elo com o pedido (fase 2 popula; SET NULL p/ nunca travar deleção legítima)
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ativa' CONSTRAINT estoque_reservas_status_check
    CHECK (status IN ('ativa', 'liberada', 'consumida', 'expirada')),
  expira_em timestamptz NOT NULL,
  motivo text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estoque_reservas_ativa
  ON public.estoque_reservas (pool, omie_codigo_produto) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS idx_estoque_reservas_checkout
  ON public.estoque_reservas (checkout_id);
CREATE INDEX IF NOT EXISTS idx_estoque_reservas_expira
  ON public.estoque_reservas (expira_em) WHERE status = 'ativa';
-- cinto de segurança da idempotência: no máx. 1 reserva ATIVA por item por checkout
CREATE UNIQUE INDEX IF NOT EXISTS estoque_reservas_checkout_item_ativa_uq
  ON public.estoque_reservas (checkout_id, pool, omie_codigo_produto) WHERE status = 'ativa';

-- RLS: staff lê; escrita de authenticated NÃO existe (nem policy, nem privilégio)
ALTER TABLE public.estoque_reservas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estoque_reservas_select_staff" ON public.estoque_reservas;
CREATE POLICY "estoque_reservas_select_staff"
  ON public.estoque_reservas
  FOR SELECT
  USING ((SELECT private.cap_estoque_reservar((SELECT auth.uid()))));

DROP POLICY IF EXISTS "estoque_reservas_service_all" ON public.estoque_reservas;
CREATE POLICY "estoque_reservas_service_all"
  ON public.estoque_reservas
  FOR ALL
  USING ((SELECT auth.role()) = 'service_role');

REVOKE ALL ON TABLE public.estoque_reservas FROM PUBLIC;
REVOKE ALL ON TABLE public.estoque_reservas FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.estoque_reservas FROM authenticated;
GRANT SELECT ON TABLE public.estoque_reservas TO authenticated;
GRANT ALL ON TABLE public.estoque_reservas TO service_role;

-- ────────────────────────────────────────────────────────────
-- 3) Cálculo interno do ATP (SEM gate próprio — REVOKE total abaixo;
--    só as RPCs gateadas deste arquivo a chamam, como owner)
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
  WITH linha AS (
    -- eleição por frescor entre as contas do pool (padrão ESTOQUE_ACCOUNTS do
    -- cockpit): a linha mais recente vence; empate → account em ordem estável
    SELECT ip.saldo, ip.synced_at
    FROM public.inventory_position ip
    WHERE ip.omie_codigo_produto = p_sku
      AND ip.account = ANY (CASE p_pool WHEN 'oben' THEN ARRAY['vendas','oben'] ELSE ARRAY[]::text[] END)
    ORDER BY ip.synced_at DESC NULLS LAST, ip.account
    LIMIT 1
  ),
  base AS (
    SELECT
      (SELECT l.saldo FROM linha l) AS saldo,
      (SELECT l.synced_at FROM linha l) AS synced_at
  ),
  calc AS (
    SELECT
      b.saldo,
      b.synced_at,
      -- FAIL-CLOSED: linha presente + sync ≤24h + saldo numérico são.
      -- NaN em numeric ordena ACIMA de tudo ('NaN'>=0 é true) → guard explícito.
      (b.synced_at IS NOT NULL
        AND b.synced_at > now() - interval '24 hours'
        AND b.saldo IS NOT NULL
        AND b.saldo <> 'NaN'::numeric
        AND b.saldo >= 0) AS confiavel
    FROM base b
  ),
  res AS (
    SELECT COALESCE(sum(r.quantidade), 0) AS reservado
    FROM public.estoque_reservas r
    WHERE r.pool = p_pool
      AND r.omie_codigo_produto = p_sku
      AND r.status = 'ativa'
      AND r.expira_em > now()
      AND (p_excluir_checkout IS NULL OR r.checkout_id <> p_excluir_checkout)
  ),
  seg AS (
    -- parâmetro ausente = sem colchão configurado (0) — default de política.
    -- Duplicata improvável de (empresa, sku): vence o colchão MAIOR (conservador).
    SELECT COALESCE((
      SELECT sp.estoque_seguranca
      FROM public.sku_parametros sp
      WHERE sp.empresa = (CASE p_pool WHEN 'oben' THEN 'OBEN' END)
        AND sp.sku_codigo_omie = p_sku
        AND sp.estoque_seguranca IS NOT NULL
        AND sp.estoque_seguranca >= 0
      ORDER BY sp.estoque_seguranca DESC
      LIMIT 1
    ), 0) AS seguranca
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
-- 4) Consulta de disponibilidade (leitura, sem efeito)
--    NÃO expõe cmc/custo nem saldo cru — só o disponível e o veredito.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atp_consultar(p_pool text, p_skus bigint[])
RETURNS TABLE (
  omie_codigo_produto bigint,
  disponivel numeric,
  confiavel boolean,
  motivo text,
  saldo_synced_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para consultar disponibilidade de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  IF p_pool IS DISTINCT FROM 'oben' THEN
    RAISE EXCEPTION 'Pool de estoque inválido: % — a fase 1 atende apenas ''oben''', COALESCE(p_pool, 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_skus IS NULL OR cardinality(p_skus) = 0 OR cardinality(p_skus) > 500 THEN
    RAISE EXCEPTION 'p_skus deve ter entre 1 e 500 códigos' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    s.sku,
    d.disponivel,
    d.saldo_confiavel,
    CASE WHEN NOT d.saldo_confiavel
         THEN 'saldo_indisponivel'::text
         ELSE NULL::text END,
    d.saldo_synced_at
  FROM unnest(p_skus) AS s(sku)
  CROSS JOIN LATERAL private.atp_disponivel(p_pool, s.sku, NULL) AS d;
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 5) Reservar (atômica, all-or-nothing, idempotente por checkout)
--    Re-chamada do MESMO checkout SUBSTITUI as reservas ativas dele
--    (estado-alvo do carrinho, não delta) — retry seguro.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reservar_estoque(
  p_pool text,
  p_checkout_id uuid,
  p_itens jsonb,
  p_ttl_minutos integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_total integer;
  v_distintos integer;
  v_invalidos integer;
  v_sku bigint;
  v_item record;
  v_calc record;
  v_recusas jsonb := '[]'::jsonb;
  v_reservas jsonb := '[]'::jsonb;
  v_expira timestamptz;
  v_id uuid;
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para reservar estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  IF p_pool IS DISTINCT FROM 'oben' THEN
    RAISE EXCEPTION 'Pool de estoque inválido: % — a fase 1 atende apenas ''oben''', COALESCE(p_pool, 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_checkout_id IS NULL THEN
    RAISE EXCEPTION 'p_checkout_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'p_itens deve ser um array JSON não-vazio de {omie_codigo_produto, quantidade}'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'p_itens excede o limite de 200 itens' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_minutos IS NULL OR p_ttl_minutos < 5 OR p_ttl_minutos > 240 THEN
    RAISE EXCEPTION 'p_ttl_minutos fora do intervalo [5, 240]: %', COALESCE(p_ttl_minutos::text, 'NULL')
      USING ERRCODE = '22023';
  END IF;

  -- Shape dos itens: sku e quantidade obrigatórios, quantidade > 0, sem duplicata
  SELECT count(*),
         count(DISTINCT x.omie_codigo_produto),
         count(*) FILTER (WHERE x.omie_codigo_produto IS NULL
                             OR x.quantidade IS NULL
                             OR x.quantidade <= 0
                             OR x.quantidade > 1000000)
    INTO v_total, v_distintos, v_invalidos
  FROM jsonb_to_recordset(p_itens) AS x(omie_codigo_produto bigint, quantidade numeric);

  IF v_invalidos > 0 THEN
    RAISE EXCEPTION 'p_itens contém item inválido (sku/quantidade ausente, quantidade fora de (0, 1000000])'
      USING ERRCODE = '22023';
  END IF;
  IF v_distintos <> v_total THEN
    RAISE EXCEPTION 'p_itens contém omie_codigo_produto duplicado — agregue as quantidades antes de chamar'
      USING ERRCODE = '22023';
  END IF;

  -- Serialização: lock do checkout primeiro, depois SKUs em ordem (deadlock-free)
  PERFORM pg_advisory_xact_lock(hashtextextended('atp:checkout:' || p_checkout_id::text, 0));
  FOR v_sku IN
    SELECT DISTINCT x.omie_codigo_produto
    FROM jsonb_to_recordset(p_itens) AS x(omie_codigo_produto bigint, quantidade numeric)
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:sku:' || p_pool || ':' || v_sku::text, 0));
  END LOOP;

  -- Decide TUDO antes de escrever (all-or-nothing sem depender de exception).
  -- O cálculo EXCLUI as reservas ativas do próprio checkout: a substituição
  -- devolve o que ele mesmo segurava antes de decidir.
  FOR v_item IN
    SELECT x.omie_codigo_produto AS sku, x.quantidade AS qtd
    FROM jsonb_to_recordset(p_itens) AS x(omie_codigo_produto bigint, quantidade numeric)
    ORDER BY x.omie_codigo_produto
  LOOP
    SELECT * INTO v_calc FROM private.atp_disponivel(p_pool, v_item.sku, p_checkout_id);
    IF NOT v_calc.saldo_confiavel THEN
      v_recusas := v_recusas || jsonb_build_object(
        'omie_codigo_produto', v_item.sku,
        'motivo', 'saldo_indisponivel',
        'detalhe', 'sem posição de estoque confiável (ausente, defasada >24h ou inválida)',
        'solicitado', v_item.qtd,
        'disponivel', NULL);
    ELSIF v_item.qtd > v_calc.disponivel THEN
      v_recusas := v_recusas || jsonb_build_object(
        'omie_codigo_produto', v_item.sku,
        'motivo', 'saldo_insuficiente',
        'solicitado', v_item.qtd,
        'disponivel', v_calc.disponivel);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_recusas) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'pool', p_pool,
      'checkout_id', p_checkout_id,
      'recusas', v_recusas);
  END IF;

  -- Substituição: libera as ativas anteriores deste checkout+pool e grava o estado-alvo
  UPDATE public.estoque_reservas
     SET status = 'liberada',
         motivo = 'substituida por nova reserva do mesmo checkout',
         atualizado_em = now()
   WHERE checkout_id = p_checkout_id
     AND pool = p_pool
     AND status = 'ativa';

  v_expira := now() + make_interval(mins => p_ttl_minutos);

  FOR v_item IN
    SELECT x.omie_codigo_produto AS sku, x.quantidade AS qtd
    FROM jsonb_to_recordset(p_itens) AS x(omie_codigo_produto bigint, quantidade numeric)
    ORDER BY x.omie_codigo_produto
  LOOP
    INSERT INTO public.estoque_reservas
      (pool, omie_codigo_produto, quantidade, checkout_id, status, expira_em, created_by)
    VALUES
      (p_pool, v_item.sku, v_item.qtd, p_checkout_id, 'ativa', v_expira, v_uid)
    RETURNING id INTO v_id;
    v_reservas := v_reservas || jsonb_build_object(
      'id', v_id,
      'omie_codigo_produto', v_item.sku,
      'quantidade', v_item.qtd,
      'expira_em', v_expira);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'pool', p_pool,
    'checkout_id', p_checkout_id,
    'reservas', v_reservas);
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 6) Liberar (cancelamento/abandono do checkout)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.liberar_reserva_checkout(
  p_checkout_id uuid,
  p_pool text DEFAULT NULL,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_n integer;
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para liberar reserva de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;
  IF p_checkout_id IS NULL THEN
    RAISE EXCEPTION 'p_checkout_id é obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_pool IS NOT NULL AND p_pool <> 'oben' THEN
    RAISE EXCEPTION 'Pool de estoque inválido: % — a fase 1 atende apenas ''oben''', p_pool
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('atp:checkout:' || p_checkout_id::text, 0));

  UPDATE public.estoque_reservas
     SET status = 'liberada',
         motivo = COALESCE(p_motivo, 'liberacao pelo caller'),
         atualizado_em = now()
   WHERE checkout_id = p_checkout_id
     AND status = 'ativa'
     AND (p_pool IS NULL OR pool = p_pool);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'checkout_id', p_checkout_id, 'liberadas', v_n);
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 7) Higiene: marca reservas vencidas (vencida já NÃO desconta no cálculo;
--    isto dá observabilidade e evita acúmulo de 'ativa' morta)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.expirar_reservas_vencidas()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_n integer;
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para expirar reservas de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.estoque_reservas
     SET status = 'expirada',
         motivo = 'expirada por TTL',
         atualizado_em = now()
   WHERE status = 'ativa'
     AND expira_em <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'expiradas', v_n);
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 8) Privilégios das RPCs públicas: EXECUTE só a authenticated (gate interno
--    barra customer com 42501) e service_role; anon/PUBLIC fora.
-- ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.atp_consultar(text, bigint[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atp_consultar(text, bigint[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.atp_consultar(text, bigint[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reservar_estoque(text, uuid, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reservar_estoque(text, uuid, jsonb, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.reservar_estoque(text, uuid, jsonb, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.liberar_reserva_checkout(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.liberar_reserva_checkout(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.liberar_reserva_checkout(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.expirar_reservas_vencidas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expirar_reservas_vencidas() FROM anon;
GRANT EXECUTE ON FUNCTION public.expirar_reservas_vencidas() TO authenticated, service_role;
