-- ============================================================
-- ATP/reserva de estoque — FASE 1.1: hardening pós-challenge Codex [money-path]
-- Programa Cabreúva Pista B · corrige a fase 1 (20260806101417)
--
-- Origem: challenge adversarial /codex (gpt-5.6-sol, xhigh) de 2026-08-06,
-- retroativo à entrega do #1672 (que fechou pelo Caminho B com "REVISÃO
-- INDEPENDENTE PENDENTE"). Parecer cru em logs/codex-atp-fase1/parecer-codex.txt.
--
-- Cada correção abaixo foi MEDIDA contra a prod antes de entrar (psql-ro):
-- nenhuma tem gatilho hoje (0 linhas envenenadas, 0 divergência, 0 timestamp
-- futuro) e a tabela estoque_reservas está VAZIA sem nenhum consumidor. São
-- armas carregadas para a fase 2, não incêndio — por isso entram agora, que
-- é quando o custo de fechar é zero.
--
-- C1 — SALDO FINITO. numeric aceita 'Infinity' no PG17 e o guard antigo o
--      deixava passar: medido em prod, ('Infinity' <> 'NaN' AND 'Infinity' >= 0)
--      é TRUE, e Infinity − qualquer coisa segue Infinity ⇒ ATP infinito, toda
--      reserva aceita para sempre. Agora exige b.saldo < 'Infinity'.
-- C2 — ESTOQUE_SEGURANCA INVÁLIDO É FAIL-CLOSED, não colchão 0. 'NaN' >= 0 é
--      TRUE em numeric, então NaN passava o filtro; disponivel virava NaN e
--      'quantidade > NaN' é FALSE ⇒ a recusa NUNCA disparava. Negativo tinha o
--      mesmo defeito em menor grau (virava "ausente" e removia o colchão em
--      silêncio). Agora: parâmetro AUSENTE = colchão 0 (política, segue válido);
--      parâmetro PRESENTE e inválido = saldo não-confiável.
-- C3 — DIVERGÊNCIA ENTRE AS CONTAS DO POOL É FAIL-CLOSED. 'a linha mais fresca
--      vence' só é conservador enquanto 'vendas' e 'oben' forem espelho (medido
--      hoje: 809 SKUs nas duas contas, 0 saldos divergentes). No dia em que um
--      pipeline falhar pela metade, a mais fresca pode ser a MAIOR e publicar
--      estoque que não existe. Agora: 2+ saldos distintos entre as posições
--      frescas e válidas ⇒ não-confiável.
-- C4 — BOUND SUPERIOR DO synced_at. Só havia piso (>24h = stale). Um synced_at
--      no futuro (relógio adiantado, escrita malformada) mantinha o saldo
--      "confiável" por todo o tempo do desvio. Agora aceita no máximo 5min de
--      folga de relógio.
-- C5 — expira_em USA clock_timestamp(). now() é o timestamp de INÍCIO da
--      transação: depois de esperar no advisory lock mais que o TTL, a reserva
--      nascia JÁ VENCIDA e a RPC ainda devolvia ok:true — mentira de contrato
--      (o caller acha que segurou estoque e não segurou).
-- C6 — HONESTIDADE DO "1 WRITER". A fase 1 escreveu "escrita SÓ pelas RPCs" mas
--      deu GRANT ALL a service_role, que ainda por cima tem BYPASSRLS: qualquer
--      backend com a service key inseria direto, sem cálculo, sem lock e sem
--      all-or-nothing. Revogado o DML (SELECT fica); as RPCs seguem funcionando
--      porque são SECURITY DEFINER e tocam a tabela como OWNER, não como caller.
-- C7 — HIGIENE AGENDÁVEL. public.expirar_reservas_vencidas() exige staff OU
--      service_role, e pg_cron nativo roda SEM JWT — medido: auth.role() e
--      auth.uid() são NULL numa sessão sem claims, então o gate devolve false e
--      a função era INAGENDÁVEL (42501). Entrypoint privado sem gate de JWT,
--      executável só pelo owner, + o cron de 15 em 15 minutos.
--
-- NÃO entra nesta migration (registrado de propósito — ver o PR):
--  • O protocolo de lock do SYNC. Os advisory locks serializam as RESERVAS,
--    mas quem escreve inventory_position não participa: decidir com saldo 10 e
--    commitar depois que o sync zerou é oversell por construção. Fechar exige
--    que todo writer de posição tome a mesma trava (trigger) — desenho de fase
--    2/3, não patch.
--  • A janela PV→saldo. O TTL é a defesa ERRADA: o Omie só baixa o saldo no
--    faturamento, então a reserva morre antes do estoque cair e a mesma unidade
--    volta a parecer livre. O conserto é reserva ligada a pedido não expirar por
--    TTL — só existe quando a fase 2 popular sales_order_id.
--  • Reserva de um employee ser liberável por outro employee (modelo de
--    permissão staff do repo; virar decisão de produto da fase 2).
--  • lock_timeout nas RPCs: mudaria a recusa por contenção de "ok:false" para
--    erro 55P03 e quebraria o contrato que o harness prova. A borda do Supabase
--    (statement_timeout do PostgREST) já limita a espera.
--  • REVOKE dos roles sandbox_exec* (têm INSERT+SELECT por default privileges
--    do Lovable e BYPASSRLS): só alcançável por quem já tem o SQL Editor, que
--    já é postgres-level; mexer arrisca quebrar o tooling do founder.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1) Cálculo do ATP — C1 (finitude), C2 (colchão inválido fail-closed),
--    C3 (divergência entre contas), C4 (bound superior do synced_at)
--    Assinatura e colunas de retorno PRESERVADAS (CREATE OR REPLACE não
--    muda tipo de retorno; a ordem das 6 colunas é a mesma da fase 1).
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
    SELECT COALESCE(sum(r.quantidade), 0) AS reservado
    FROM public.estoque_reservas r
    WHERE r.pool = p_pool
      AND r.omie_codigo_produto = p_sku
      AND r.status = 'ativa'
      AND r.expira_em > now()
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
-- 2) reservar_estoque — C5: expira_em pelo relógio de PAREDE
--    Recriada INTEIRA (CREATE OR REPLACE substitui o corpo todo; transcrever a
--    versão da fase 1 com a única mudança do expira_em + o texto do detalhe).
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
        'detalhe', 'sem posição de estoque confiável (ausente, defasada >24h, datada no futuro, valor inválido, contas do pool divergentes ou estoque de segurança inválido)',
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

  -- C5: clock_timestamp(), NÃO now(). now() é o instante em que a TRANSAÇÃO
  -- começou; depois de esperar no advisory lock mais que o TTL, now()+TTL já
  -- está no passado e a reserva nasce vencida — devolvendo ok:true sem segurar
  -- nada. O relógio de parede é o único que mede o instante da ESCRITA.
  v_expira := clock_timestamp() + make_interval(mins => p_ttl_minutos);

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
-- 3) C7 — entrypoint de JOB sem dependência de JWT
--    pg_cron nativo roda sem claims: auth.role() e auth.uid() são NULL, o gate
--    devolve false e a RPC pública morre com 42501. Esta variante privada não
--    tem gate de JWT (é inalcançável por anon/authenticated: sem EXECUTE), e a
--    RPC pública passa a DELEGAR nela — 1 writer da lógica de expiração.
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

REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM anon;
REVOKE ALL ON FUNCTION private.expirar_reservas_vencidas_job() FROM authenticated;

CREATE OR REPLACE FUNCTION public.expirar_reservas_vencidas()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT private.cap_estoque_reservar(v_uid) THEN
    RAISE EXCEPTION 'Sem permissão para expirar reservas de estoque (staff apenas)'
      USING ERRCODE = '42501';
  END IF;

  RETURN private.expirar_reservas_vencidas_job();
END;
$function$;

REVOKE ALL ON FUNCTION public.expirar_reservas_vencidas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expirar_reservas_vencidas() FROM anon;
GRANT EXECUTE ON FUNCTION public.expirar_reservas_vencidas() TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 4) C6 — "1 WRITER" vira verdade: service_role perde o DML direto.
--    As 4 RPCs continuam escrevendo porque são SECURITY DEFINER e tocam a
--    tabela como OWNER (postgres), não como o caller. A policy FOR ALL vira
--    FOR SELECT para não anunciar uma escrita que não existe mais (service_role
--    tem BYPASSRLS, então a policy sempre foi decorativa — mas decoração que
--    mente é pior que ausência).
-- ────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.estoque_reservas FROM service_role;

DROP POLICY IF EXISTS "estoque_reservas_service_all" ON public.estoque_reservas;
DROP POLICY IF EXISTS "estoque_reservas_service_select" ON public.estoque_reservas;
CREATE POLICY "estoque_reservas_service_select"
  ON public.estoque_reservas
  FOR SELECT
  USING ((SELECT auth.role()) = 'service_role');

-- ────────────────────────────────────────────────────────────
-- 5) C7 (cont.) — agenda a higiene. Idempotente: desagenda antes de agendar.
--    15 em 15 min: a reserva vencida já não desconta no cálculo (o filtro é
--    expira_em, não status), então isto é observabilidade + saúde do índice
--    parcial WHERE status='ativa', não correção de número.
-- ────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('atp-expirar-reservas-vencidas');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- job ainda não existe: primeira aplicação
END $$;

SELECT cron.schedule(
  'atp-expirar-reservas-vencidas',
  '*/15 * * * *',
  $cron$SELECT private.expirar_reservas_vencidas_job()$cron$
);
