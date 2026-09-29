-- ============================================================
-- Prova POR EXECUÇÃO de que os SKUs religados por db/aplicar-religar-reposicao-15-skus.sql
-- entram na sugestão do motor — e de que o flag é A causa — sem gravar nada.
--
-- Uso:  bun run db:aplicar db/diagnostico/ensaio-motor-religados.sql --ensaio
--
-- Roda o motor de verdade (`gerar_pedidos_sugeridos_ciclo`, o mesmo que o cron chama) DUAS vezes
-- dentro da transação do executor:
--   A · controle negativo: desliga o flag do FCA.7090QT e roda → o FCA tem de ficar FORA
--       (e o motor tem de ter incluído ALGUM SKU, senão o "fora" é vácuo);
--   B · religa o flag e roda de novo → o FCA tem de ENTRAR.
-- A → B é sabotagem + controle na MESMA invocação: se só B rodasse, "FCA entrou" não distinguiria
-- "o flag era a causa" de "outra coisa mudou entre o diagnóstico e agora".
--
-- Termina SEMPRE em RAISE EXCEPTION rotulada: ENSAIO_OK (veredito positivo) ou ENSAIO_FALHOU. O
-- "erro" é o relatório — e, mesmo rodado SEM --ensaio, a exceção desfaz tudo (padrão do
-- docs/agent/database.md §1). O motor não tem efeito fora da transação (sem net.http/pg_notify/
-- dblink, nem nos triggers das tabelas em que ele grava — medido em 2026-09-29), então o rollback
-- não deixa rastro além de gap de sequence.
--
-- Veredito esperado em 2026-09-29: FCA.7090QT sugerido (saldo 1 <= ponto 3); WP01.3900QT fora
-- (saldo 6,2 > ponto 4 — entra quando cair). Se o WP01 aparecer, a leitura de estoque do
-- diagnóstico estava errada, e isso também é resposta.
-- ============================================================

-- ── A · controle negativo: flag desligado ⇒ FCA fora ──
UPDATE public.sku_parametros
   SET habilitado_reposicao_automatica = false
 WHERE empresa = 'OBEN' AND sku_codigo_omie = 12034226322;

CREATE TEMP TABLE _fase_a ON COMMIT DROP AS
SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);

DO $a$
DECLARE
  v_fca    numeric;
  v_skus_a int;
BEGIN
  SELECT skus_incluidos INTO v_skus_a FROM pg_temp._fase_a;
  IF coalesce(v_skus_a, 0) <= 0 THEN
    RAISE EXCEPTION 'ENSAIO_FALHOU: controle vacuo, o motor nao incluiu nenhum SKU na fase A (skus=%) --- fim ---',
      coalesce(v_skus_a::text, 'NULL');
  END IF;

  SELECT sum(i.qtde_final) INTO v_fca
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
   WHERE p.empresa = 'OBEN' AND p.data_ciclo = CURRENT_DATE
     AND i.sku_codigo_omie = '12034226322';
  IF v_fca IS NOT NULL THEN
    RAISE EXCEPTION 'ENSAIO_FALHOU: controle negativo, FCA.7090QT sugerido (% un) com o flag DESLIGADO --- fim ---', v_fca;
  END IF;
END
$a$;

-- ── B · flag ligado ⇒ FCA dentro ──
UPDATE public.sku_parametros
   SET habilitado_reposicao_automatica = true
 WHERE empresa = 'OBEN' AND sku_codigo_omie = 12034226322;

SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);

DO $b$
DECLARE
  v_skus_a int;
  v_fca    numeric;
  v_wp01   numeric;
  v_n      int;
  v_lista  text;
BEGIN
  SELECT skus_incluidos INTO v_skus_a FROM pg_temp._fase_a;

  SELECT sum(i.qtde_final) INTO v_fca
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
   WHERE p.empresa = 'OBEN' AND p.data_ciclo = CURRENT_DATE
     AND i.sku_codigo_omie = '12034226322';   -- CATALISADOR FCA.7090QT

  SELECT sum(i.qtde_final) INTO v_wp01
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
   WHERE p.empresa = 'OBEN' AND p.data_ciclo = CURRENT_DATE
     AND i.sku_codigo_omie = '8689775044';    -- WP01.3900QT

  SELECT count(DISTINCT i.sku_codigo_omie), string_agg(DISTINCT i.sku_codigo_omie, ',')
    INTO v_n, v_lista
    FROM public.pedido_compra_item i
    JOIN public.pedido_compra_sugerido p ON p.id = i.pedido_id
   WHERE p.empresa = 'OBEN' AND p.data_ciclo = CURRENT_DATE
     AND i.sku_codigo_omie IN ('12034226322','8689775044','12067285434','8689736464','8689733082',
                               '8689960103','8689774769','8689783623','8689717555','8689731064',
                               '8689791550','8689718356','8689723427','8689744108','8689723623');

  IF v_fca IS NULL OR v_fca <= 0 THEN
    RAISE EXCEPTION 'ENSAIO_FALHOU: FCA.7090QT fora da sugestao com o flag LIGADO (qtde=%) --- fim ---',
      coalesce(v_fca::text, 'NULL');
  END IF;

  RAISE EXCEPTION 'ENSAIO_OK: controle A (flag off) motor incluiu % SKUs, FCA fora; B (flag on) FCA=% un, WP01=%, religados na sugestao %/15 [%] --- fim ---',
    v_skus_a, v_fca, coalesce(v_wp01::text, 'fora'), v_n, v_lista;
END
$b$;
