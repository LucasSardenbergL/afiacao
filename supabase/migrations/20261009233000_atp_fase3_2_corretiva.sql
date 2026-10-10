-- ============================================================
-- ATP/reserva de estoque — FASE 3.2: correções do challenge Codex RETROATIVO da 3.1
-- [money-path] · Programa Cabreúva Pista B (docs/historico/programa-cabreuva-colacor.md)
-- Depende da 3.1 (20261009120000), APLICADA em prod em 2026-10-09 (db:aplicar
-- #299, validador 42/42). Pré-flight 2026-10-09: os 3 corpos que este arquivo
-- recria são byte-iguais ao repo (reservar_estoque da 1.1, liberar_reserva_checkout
-- da 1, atp_reservas_pendentes da 3.1).
--
-- O challenge (gpt-6-astra xhigh, rodado DEPOIS do apply da 3.1 — Caminho B)
-- recomendou fase corretiva. Esta fase fecha o LOTE BARATO; os dois achados que
-- pedem desenho (#1 retry que firma quantidade ≠ do PV; #3 DELETE antes da
-- confirmação) ficam registrados no histórico como próxima fase.
--
--  #2  O write-once da 3.1 protege o ELO, não o STATUS: a substituição do
--      reservar_estoque e o liberar_reserva_checkout soltavam reserva de PV
--      CONFIRMADO (o estoque do pedido vivo voltava ao ATP). E o gate lê o PID
--      ANTES do lock do checkout, então uma confirmação concorrente não era
--      vista. ⇒ as duas portas passam a preservar a reserva firme, com a
--      conferência feita SOB o lock do checkout (o mesmo que o atp_confirmar_pv
--      toma). "Firme" = o mesmo predicado do cálculo: par próprio OU o EXISTS
--      legado pelo vínculo.
--  #5  O sinal saldo_embute_faturamento podia dizer true sobre saldo que o
--      próprio ATP recusa (contas divergentes, datado no futuro) e sobre
--      canônica que já regrediu. ⇒ fora disso vira NULL (indecidível).
--  #6  O CHECK do par aceitava conta preenchida com PID nulo (`NULL > 0` é
--      NULL, e CHECK aceita NULL). Defeito da 3.1, sem writer que o produza. ⇒
--      o ramo "preenchido" exige `omie_pedido_id IS NOT NULL`.
--  #7  A PRE da 3.1 não cobre as funções que ela CRIA, e md5 do corpo não vê
--      os atributos (SECURITY DEFINER, volatilidade, search_path). ⇒ a PRE
--      daqui mede corpo+atributos de tudo que recria. E como esta fase muda
--      atp_reservas_pendentes (guardada pela PRE da 3.1), re-aplicar a 3.1 por
--      cima dela passa a ABORTAR — a sobrescrita silenciosa que o #7 descreve.
--
-- Nenhum caller do app ou das edges chama reservar_estoque/liberar_reserva_checkout
-- direto (só o atp_gate_pedido chama o reservar). O 22023 novo chega à edge como
-- classe SEM override (_shared/atp-gate.ts) — reenviar ou forçar backorder não
-- muda o fato de o PV já existir.
--
-- No SQL Editor/MCP: entre BEGIN; … COMMIT;. Pelo db:aplicar: sem envelope.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0) TRAVA → PRE. md5 de corpo+atributos ∈ {predecessor medido em prod, este}.
-- ────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.reservar_estoque(text,uuid,jsonb,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.reservar_estoque(text, uuid, jsonb, integer) VOLATILE;
  END IF;
  IF to_regprocedure('public.liberar_reserva_checkout(uuid,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.liberar_reserva_checkout(uuid, text, text) VOLATILE;
  END IF;
  IF to_regprocedure('public.atp_reservas_pendentes(integer)') IS NOT NULL THEN
    ALTER FUNCTION public.atp_reservas_pendentes(integer) STABLE;
  END IF;
END
$trava$;

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(p.prosrc || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || COALESCE(p.proconfig::text, ''))
              FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES
        ('public.reservar_estoque(text,uuid,jsonb,integer)', '4a0c99bfee4944e3b37cd0d961e0c6e1', '5fe65f8bb3f4c0cc9c0c77a09cbdca86'),
        ('public.liberar_reserva_checkout(uuid,text,text)',  '1fba6179336e84b5a3dceed2717af8f0', '551e21229425a71a1ea0c2a6b2d36ce0'),
        ('public.atp_reservas_pendentes(integer)',           '02d9e702c6aa0890d86431b0a234a8a7', '6f44d06f8fd0888a12a6d33b950c83e0')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 corpo+atributos %) não é o da 3.1 nem o desta migration — alguém o recriou depois do pré-voo de 2026-10-09; NÃO sobrescrever sem revisar', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- ────────────────────────────────────────────────────────────
-- 1) #6 — o CHECK do par: o ramo "preenchido" exige o PID NÃO nulo.
--    Trocado na MESMA transação (nenhuma linha em prod viola a forma nova —
--    conferido 2026-10-09).
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.estoque_reservas DROP CONSTRAINT IF EXISTS estoque_reservas_pv_par_check;
ALTER TABLE public.estoque_reservas ADD CONSTRAINT estoque_reservas_pv_par_check
  CHECK (
    (omie_pedido_id IS NULL AND omie_account IS NULL)
    OR (omie_pedido_id IS NOT NULL AND omie_pedido_id > 0
        AND omie_account IS NOT NULL AND btrim(omie_account) <> '')
  );

-- ────────────────────────────────────────────────────────────
-- 2) #2 — reservar_estoque: a substituição não solta reserva firme.
--    Corpo da 1.1 (byte-igual à prod) + a guarda logo após os locks.
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

  -- FASE 3.2 (achado #2 do Codex retroativo da 3.1): a SUBSTITUIÇÃO abaixo
  -- solta TODAS as ativas do checkout — inclusive a de um PV já CONFIRMADO no
  -- Omie, que voltaria inteira ao ATP com o pedido vivo. Reserva firme só sai
  -- de 'ativa' pelo desfecho (reconciliação por cancelamento confirmado, ou
  -- atp_resolver_reserva, humana e auditada) — nunca por substituição.
  -- Conferido DEPOIS do lock do checkout: é o lock que o atp_confirmar_pv
  -- também toma, então o PID gravado por uma confirmação concorrente já está
  -- visível aqui (o gate lê o PID ANTES do lock — esta é a releitura sob trava).
  -- 22023 (sem override): reenviar/forçar backorder não muda o fato.
  IF EXISTS (
    SELECT 1 FROM public.estoque_reservas r
    WHERE r.checkout_id = p_checkout_id
      AND r.pool = p_pool
      AND r.status = 'ativa'
      AND (r.omie_pedido_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.sales_orders so
                      WHERE so.id = r.sales_order_id AND so.omie_pedido_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'checkout % já tem reserva de PV CONFIRMADO no Omie — não pode ser substituída (o desfecho dela é cancelamento confirmado ou resolução humana em atp_resolver_reserva)', p_checkout_id
      USING ERRCODE = '22023';
  END IF;

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
-- 3) #2 — liberar_reserva_checkout: reserva firme é preservada.
--    Corpo da fase 1 (byte-igual à prod) + a exclusão e a contagem.
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
  v_firmes integer;
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

  -- FASE 3.2 (achado #2 do Codex retroativo da 3.1): reserva de PV CONFIRMADO
  -- no Omie NÃO sai por aqui — liberar sem motivo, sem ator e sem trilha
  -- devolveria ao ATP estoque de pedido vivo. Ela fica 'ativa' e é contada em
  -- 'preservadas_firmes'; a saída dela é a atp_resolver_reserva (humana,
  -- auditada) ou a reconciliação por cancelamento confirmado.
  UPDATE public.estoque_reservas r
     SET status = 'liberada',
         motivo = COALESCE(p_motivo, 'liberacao pelo caller'),
         atualizado_em = now()
   WHERE r.checkout_id = p_checkout_id
     AND r.status = 'ativa'
     AND (p_pool IS NULL OR r.pool = p_pool)
     AND r.omie_pedido_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders so
                     WHERE so.id = r.sales_order_id AND so.omie_pedido_id IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT count(*) INTO v_firmes
  FROM public.estoque_reservas r
  WHERE r.checkout_id = p_checkout_id
    AND r.status = 'ativa'
    AND (p_pool IS NULL OR r.pool = p_pool);

  RETURN jsonb_build_object('ok', true, 'checkout_id', p_checkout_id, 'liberadas', v_n,
                            'preservadas_firmes', v_firmes);
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 4) #5 — a fila humana: o sinal só se pronuncia sobre saldo que o ATP aceita
--    e canônica ainda faturada. Mesma assinatura e colunas da 3.1 (REPLACE
--    preserva o ACL).
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
  ativa_ha_dias numeric,
  saldo_synced_at timestamptz,
  saldo_embute_faturamento boolean
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
         round((EXTRACT(epoch FROM (now() - r.created_at)) / 86400)::numeric, 1),
         d.saldo_synced_at,
         -- FASE 3.2 (achado #5): o sinal só se pronuncia sobre saldo que o
         -- PRÓPRIO ATP aceitaria (saldo_confiavel: fresco, não datado no futuro,
         -- contas do pool concordando) e com a canônica AINDA em 'faturado'
         -- (entre uma regressão e o próximo tick, o carimbo é velho). Fora
         -- disso é indecidível ⇒ NULL, nunca true nem false.
         CASE
           WHEN r.faturamento_observado_em IS NULL
             OR d.saldo_synced_at IS NULL
             OR d.saldo_confiavel IS DISTINCT FROM true
             OR k.status IS DISTINCT FROM 'faturado' THEN NULL
           ELSE d.saldo_synced_at >= r.faturamento_observado_em + interval '1 hour'
         END
  FROM public.estoque_reservas r
  LEFT JOIN public.sales_orders so ON so.id = r.sales_order_id
  LEFT JOIN LATERAL private.atp_canonico_da_reserva(r.id) k ON true
  LEFT JOIN LATERAL private.atp_disponivel(r.pool, r.omie_codigo_produto) d ON true
  WHERE r.status = 'ativa'
    AND (r.sales_order_id IS NOT NULL OR r.omie_pedido_id IS NOT NULL)
    AND r.created_at <= now() - make_interval(days => p_dias)
  ORDER BY r.faturamento_observado_em NULLS LAST, r.created_at;
END;
$function$;

-- ────────────────────────────────────────────────────────────
-- 5) PÓS — estrutural + privilégios. Aborta o apply se algo não pegou.
-- ────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_res oid := to_regprocedure('public.reservar_estoque(text,uuid,jsonb,integer)');
  v_lib oid := to_regprocedure('public.liberar_reserva_checkout(uuid,text,text)');
  v_pen oid := to_regprocedure('public.atp_reservas_pendentes(integer)');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.estoque_reservas'::regclass
                    AND conname = 'estoque_reservas_pv_par_check' AND convalidated
                    AND pg_get_constraintdef(oid) ~ 'omie_pedido_id IS NOT NULL') THEN
    RAISE EXCEPTION 'POS FALHOU: CHECK do par sem o ramo "PID não nulo"';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_res) !~ 'já tem reserva de PV CONFIRMADO' THEN
    RAISE EXCEPTION 'POS FALHOU: reservar_estoque sem a guarda de reserva firme';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_lib) !~ 'preservadas_firmes' THEN
    RAISE EXCEPTION 'POS FALHOU: liberar_reserva_checkout sem a preservação de reserva firme';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_pen) !~ 'saldo_confiavel IS DISTINCT FROM true' THEN
    RAISE EXCEPTION 'POS FALHOU: o sinal da fila não exige saldo confiável';
  END IF;
  -- os três seguem SECURITY DEFINER com search_path fixo (REPLACE não muda, mas
  -- é isto que o #7 diz que md5 de corpo não via)
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (v_res, v_lib, v_pen)
              AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION 'POS FALHOU: uma das funções perdeu SECURITY DEFINER ou o search_path';
  END IF;
  IF has_function_privilege('anon', v_res, 'EXECUTE')
     OR has_function_privilege('anon', v_lib, 'EXECUTE')
     OR has_function_privilege('anon', v_pen, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: anon com EXECUTE numa das funções recriadas';
  END IF;
END
$pos$;
