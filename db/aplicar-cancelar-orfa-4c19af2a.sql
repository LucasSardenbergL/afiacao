-- ============================================================
-- Cancela a linha do app 4c19af2a (pedido 10536 da OBEN, substituído no Omie pelo 10538),
-- pelo `db:aplicar` (SEM envelope)
-- Decisão do founder em 2026-10-01 (sessão sensor-orfa-continua), pela regra de 2026-09-30 do sensor
-- `vendas_empurradas_sem_gemeo` (migration 20261001011500): o órfão conhecido se resolve ANTES do
-- apply, e o sensor nasce verde.
-- ============================================================
-- Sintoma: a linha do app 4c19af2a (oben, omie 12070343474, nº 10536, R$ 314,40, empurrada em 06/04 e
-- respondida pelo Omie com "Pedido cadastrado com sucesso!") nunca ganhou o gêmeo do importador. Das 26
-- linhas empurradas, é a única sem gêmeo.
--
-- O que o banco mostrou (psql-ro, 2026-10-01), sem abrir o Omie:
--   1. o 10536 foi para o cadastro Omie 12008261284, um CNPJ que hoje está em
--      `omie_clientes_nao_vinculados`. Se o pedido ainda existe no Omie, o importador o PULA
--      (skippedNoClient), e semear abril de novo não traria o gêmeo;
--   2. no MESMO dia entrou no Omie o pedido nº 10538 (omie 12070361032), com os MESMOS 2 itens nas mesmas
--      quantidades e preços (8689717577 1 x 239,40 e 8689791806 1 x 75,00), para outro cadastro
--      (8819266269, vinculado a outro cliente do app). Ele foi faturado: NF-e 8291, R$ 314,40;
--   3. o importador trouxe o 10538 (linha 142e5f72, faturado, order_date_kpi 06/04): a venda JÁ conta;
--   4. um título manual (origem MANR) de R$ 314,40, que cita a NF 8291, está RECEBIDO no CNPJ do 10536.
-- O 10536 não virou venda; a venda é o 10538. Hoje ela conta 2x em abril, porque esta linha tem
-- order_date_kpi do backfill. É o ramo "cancelado/excluído" da regra: a linha do app vira 'cancelado'.
--
-- Muda SÓ `status` ('enviado' -> 'cancelado'). `notes` fica, porque é a observação que foi ao Omie. O
-- gatilho de cabeçalho (`pedido_venda_coerencia_cab`) só confere itens, e esta linha não tem
-- order_items. A única chamada a `CancelarPedido` é a ação `excluir_pedido` da `omie-vendas-sync`,
-- disparada pelo usuário: nenhum cron lê o status para falar com o Omie.
--
-- Fora de propósito: o congelado de abril (`carteira_positivacao_snapshot`) continua com o cliente desta
-- linha positivado por R$ 314,40. Decisão do founder (2026-10-01): mês fechado não se reescreve. A
-- ressalva está em docs/historico/venda-empurrada-sem-gemeo.md.
--
-- A pré-condição está ancorada no estado medido. Se a linha mudou, se o gêmeo apareceu ou se o 10538
-- deixou de ser a mesma venda faturada, aborta sem gravar. Idempotente: com a linha já 'cancelado', avisa
-- e não escreve, e a postcondição confere o mesmo estado final.

DO $pre$
DECLARE
  r           record;
  v_gemeos    int;
  v_subst     int;
  v_itens_app int;
  v_itens_sub int;
  v_dif       int;
BEGIN
  SELECT so.status, so.account, so.omie_pedido_id, so.total, so.deleted_at,
         so.omie_payload IS NOT NULL AS do_app
    INTO r
    FROM public.sales_orders so
   WHERE so.id = '4c19af2a-97d2-4d41-bcef-ae5b32543a01'
     FOR UPDATE;  -- serializa contra o importador (cron de 2 em 2 h por conta)
  IF NOT FOUND THEN
    RAISE EXCEPTION '[PRE] a linha 4c19af2a sumiu - nada a cancelar; reveja antes de aplicar';
  END IF;

  IF r.status = 'cancelado' THEN
    RAISE NOTICE '[PRE] JA APLICADO: a linha 4c19af2a ja esta cancelado. Nada a escrever.';
  ELSIF r.status <> 'enviado' OR r.account <> 'oben' OR r.omie_pedido_id <> 12070343474
        OR r.total <> 314.40 OR r.deleted_at IS NOT NULL OR NOT r.do_app THEN
    RAISE EXCEPTION '[PRE] a linha 4c19af2a nao esta como foi medida (status %, conta %, omie %, total %, apagada %, do app %) - NAO cancele as cegas',
      r.status, r.account, r.omie_pedido_id, r.total, r.deleted_at IS NOT NULL, r.do_app;
  END IF;

  -- o gêmeo do 10536 continua ausente: se o importador passou a conhecer o pedido, a regra é outra
  SELECT count(*) INTO v_gemeos
    FROM public.sales_orders t
   WHERE t.account = 'oben' AND t.omie_pedido_id = 12070343474 AND t.omie_payload IS NULL;
  IF v_gemeos <> 0 THEN
    RAISE EXCEPTION '[PRE] o gemeo do 10536 apareceu (% linha(s)) - o importador conhece o pedido; NAO cancele', v_gemeos;
  END IF;

  -- a venda continua contada pelo 10538: faturado, R$ 314,40, kpi 06/04
  SELECT count(*) INTO v_subst
    FROM public.sales_orders s
   WHERE s.account = 'oben' AND s.omie_pedido_id = 12070361032 AND s.omie_payload IS NULL
     AND s.status = 'faturado' AND s.total = 314.40 AND s.deleted_at IS NULL
     AND s.order_date_kpi = DATE '2026-04-06';
  IF v_subst <> 1 THEN
    RAISE EXCEPTION '[PRE] esperava 1 linha do 10538 faturado (R$ 314,40, kpi 06/04), achei % - sem ela a venda deixaria de contar; NAO cancele', v_subst;
  END IF;

  -- e é a MESMA venda: os itens do payload enviado = os itens importados do 10538
  WITH app AS (
    SELECT (d->'produto'->>'codigo_produto')::bigint AS prod,
           (d->'produto'->>'quantidade')::numeric    AS qtd,
           (d->'produto'->>'valor_unitario')::numeric AS preco
      FROM public.sales_orders so
     CROSS JOIN LATERAL jsonb_array_elements(so.omie_payload->'det') d
     WHERE so.id = '4c19af2a-97d2-4d41-bcef-ae5b32543a01'),
  sub AS (
    SELECT oi.omie_codigo_produto AS prod, oi.quantity::numeric AS qtd, oi.unit_price::numeric AS preco
      FROM public.order_items oi
      JOIN public.sales_orders s ON s.id = oi.sales_order_id
     WHERE s.account = 'oben' AND s.omie_pedido_id = 12070361032 AND s.omie_payload IS NULL)
  SELECT (SELECT count(*) FROM app),
         (SELECT count(*) FROM sub),
         (SELECT count(*) FROM (TABLE app EXCEPT ALL TABLE sub) x)
       + (SELECT count(*) FROM (TABLE sub EXCEPT ALL TABLE app) y)
    INTO v_itens_app, v_itens_sub, v_dif;
  IF v_itens_app <> 2 OR v_itens_sub <> 2 OR v_dif <> 0 THEN
    RAISE EXCEPTION '[PRE] os itens do 10536 (%) e do 10538 (%) nao sao a mesma venda (% diferenca(s)) - NAO cancele',
      v_itens_app, v_itens_sub, v_dif;
  END IF;
END
$pre$;

UPDATE public.sales_orders
   SET status = 'cancelado'
 WHERE id = '4c19af2a-97d2-4d41-bcef-ae5b32543a01'
   AND status = 'enviado';

DO $post$
DECLARE
  r       record;
  v_subst int;
  v_univ  int;
BEGIN
  SELECT so.status, so.account, so.omie_pedido_id, so.total, so.deleted_at,
         so.omie_payload IS NOT NULL AS do_app, so.order_date_kpi
    INTO r
    FROM public.sales_orders so
   WHERE so.id = '4c19af2a-97d2-4d41-bcef-ae5b32543a01';
  IF NOT FOUND OR r.status IS DISTINCT FROM 'cancelado' THEN
    RAISE EXCEPTION '[POS] a linha 4c19af2a nao ficou cancelado (status %) - nada foi gravado', r.status;
  END IF;
  IF r.account <> 'oben' OR r.omie_pedido_id <> 12070343474 OR r.total <> 314.40
     OR r.deleted_at IS NOT NULL OR NOT r.do_app OR r.order_date_kpi IS DISTINCT FROM DATE '2026-04-06' THEN
    RAISE EXCEPTION '[POS] a linha 4c19af2a mudou alem do status - nada foi gravado';
  END IF;

  -- o 10538 segue intacto: a venda continua contada uma vez
  SELECT count(*) INTO v_subst
    FROM public.sales_orders s
   WHERE s.account = 'oben' AND s.omie_pedido_id = 12070361032 AND s.omie_payload IS NULL
     AND s.status = 'faturado' AND s.total = 314.40 AND s.deleted_at IS NULL
     AND s.order_date_kpi = DATE '2026-04-06';
  IF v_subst <> 1 THEN
    RAISE EXCEPTION '[POS] o 10538 nao esta mais faturado com R$ 314,40 (achei % linha(s)) - nada foi gravado', v_subst;
  END IF;

  -- a linha saiu do universo do sensor (o mesmo predicado da 20261001011500)
  SELECT count(*) INTO v_univ
    FROM public.sales_orders a
   WHERE a.id = '4c19af2a-97d2-4d41-bcef-ae5b32543a01'
     AND a.omie_payload IS NOT NULL
     AND a.omie_pedido_id IS NOT NULL
     AND a.status NOT IN ('cancelado','rascunho','pendente','orcamento')
     AND a.deleted_at IS NULL;
  IF v_univ <> 0 THEN
    RAISE EXCEPTION '[POS] a linha 4c19af2a ainda esta no universo do sensor - nada foi gravado';
  END IF;
END
$post$;
