-- ╔════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ APPLY 2 de 2 — a conversão em si: o cabeçalho do acervo de BRUTO para LÍQUIDO.          ║
-- ║                                                                                        ║
-- ║ DEPENDE do apply 1 (`2026-10-05-pedido-total-liquido-excecao.sql`) estar em PRODUÇÃO —  ║
-- ║ e não acredita nisso, confere: sem a tabela de exceção e sem o conversor que a lê, este ║
-- ║ arquivo ABORTA antes de escrever.                                                      ║
-- ║                                                                                        ║
-- ║ ⚠️ ESTE ARQUIVO NÃO FOI ENSAIADO, e não podia ser: o ensaio do apply 1 faz ROLLBACK, ║
-- ║ então a tabela de exceção não existe em prod enquanto ele não for aplicado de verdade.  ║
-- ║ Rode `bun run db:aplicar <este> --ensaio` DEPOIS do apply 1 e antes do apply real — o   ║
-- ║ ensaio roda inteiro e reverte, e é ele que vale como pré-voo 🟢.                        ║
-- ║                                                                                        ║
-- ║ Previsão medida no ensaio do apply 1: 538 pedidos, soma da mudança −R$ 100.144,46.      ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════╝

-- A transacao e do `db:aplicar`: este arquivo NAO leva BEGIN;/COMMIT;.

DO $conv$
DECLARE
  v_fn        text := 'public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)';
  v_corte     timestamptz := '2026-09-14 20:09:13+00';
  v_de        date := '2025-09-01';
  v_ate       date := '2026-10-01';
  v_r         jsonb;
  v_escritos  int;
  v_antes     int;
  v_depois    int;
  v_incoer    int;
BEGIN
  -- ─── Pré-voo: o apply 1 pegou de verdade? ─────────────────────────────────────────────────
  IF to_regclass('public.pedido_total_liquido_excecao') IS NULL THEN
    RAISE EXCEPTION 'pre-voo: a tabela pedido_total_liquido_excecao NAO existe — o apply 1 nao foi '
                    'aplicado (ou foi so ensaiado, e o ensaio faz ROLLBACK)';
  END IF;
  IF to_regprocedure(v_fn) IS NULL THEN
    RAISE EXCEPTION 'pre-voo: % nao existe nesta base', v_fn;
  END IF;
  -- Ler o CATALOGO, não invocar: validação que executa o objeto mente nos dois sentidos.
  IF position('pedido_total_liquido_excecao' IN pg_get_functiondef(to_regprocedure(v_fn))) = 0 THEN
    RAISE EXCEPTION 'pre-voo: o conversor em producao NAO le a tabela de excecao — o apply 1 nao '
                    'trocou a funcao, e converter agora reproduz o gate antigo';
  END IF;
  IF (SELECT count(*) FROM public.pedido_total_liquido_excecao) = 0 THEN
    RAISE EXCEPTION 'pre-voo: a tabela de excecao esta VAZIA — sem lista, o gate bloqueia tudo e '
                    'esta conversao escreveria zero';
  END IF;

  -- ─── Sensor ANTES, na mesma transação: quantos pedidos a tela ainda nao explica ───────────
  SELECT count(*) INTO v_antes
    FROM (SELECT oi.sales_order_id,
                 sum(oi.quantity * oi.unit_price) AS bruto,
                 sum(oi.desconto_valor)           AS desconto
            FROM public.order_items oi
           GROUP BY oi.sales_order_id
          HAVING count(*) FILTER (WHERE oi.desconto_valor > 0) > 0) l
    JOIN public.sales_orders so ON so.id = l.sales_order_id
   WHERE round(l.bruto - l.desconto, 2) <> round(so.total, 2);

  -- ─── A conversão ──────────────────────────────────────────────────────────────────────────
  v_r        := public.pedido_total_liquido_converter(true, v_corte, NULL, v_de, v_ate);
  v_escritos := (v_r->>'escritos')::int;

  IF v_escritos IS NULL OR v_escritos <= 0 THEN
    RAISE EXCEPTION 'postcondicao: a conversao escreveu % pedidos — relatorio: %', v_escritos, v_r;
  END IF;

  -- ─── Sensor DEPOIS: o numero tem de CAIR, e cair pelo menos o que foi escrito ─────────────
  SELECT count(*) INTO v_depois
    FROM (SELECT oi.sales_order_id,
                 sum(oi.quantity * oi.unit_price) AS bruto,
                 sum(oi.desconto_valor)           AS desconto
            FROM public.order_items oi
           GROUP BY oi.sales_order_id
          HAVING count(*) FILTER (WHERE oi.desconto_valor > 0) > 0) l
    JOIN public.sales_orders so ON so.id = l.sales_order_id
   WHERE round(l.bruto - l.desconto, 2) <> round(so.total, 2);

  IF v_depois >= v_antes THEN
    RAISE EXCEPTION 'postcondicao: o sensor do cupom NAO melhorou — % brutos antes, % depois, com % '
                    'escritos. Escreveu sem consertar a tela e as duas coisas tinham de andar junto',
                    v_antes, v_depois, v_escritos;
  END IF;
  IF (v_antes - v_depois) IS DISTINCT FROM v_escritos THEN
    RAISE EXCEPTION 'postcondicao: a tela melhorou em % pedidos mas a conversao diz ter escrito % — '
                    'os dois numeros medem a MESMA coisa por caminhos diferentes e tem de bater',
                    v_antes - v_depois, v_escritos;
  END IF;

  -- ─── Sanidade de money-path: nenhum total convertido virou absurdo ────────────────────────
  -- O líquido tem de ficar em (0, bruto]. Total <= 0 ou acima do bruto e numero fabricado.
  SELECT count(*) INTO v_incoer
    FROM public.pedido_total_liquido_conversoes k
    JOIN public.sales_orders so ON so.id = k.sales_order_id
    JOIN (SELECT oi.sales_order_id, sum(oi.quantity * oi.unit_price) AS bruto
            FROM public.order_items oi GROUP BY oi.sales_order_id) b
      ON b.sales_order_id = so.id
   WHERE k.lote = (v_r->>'lote')::uuid
     AND (so.total <= 0 OR round(so.total, 2) > round(b.bruto, 2));
  IF v_incoer > 0 THEN
    RAISE EXCEPTION 'postcondicao: % pedido(s) deste lote ficaram com total fora de (0, bruto] — '
                    'numero fabricado, nao conversao', v_incoer;
  END IF;

  RAISE NOTICE 'CONVERSAO OK: % pedidos escritos | tela: % brutos -> % | soma da mudanca = % | lote %',
               v_escritos, v_antes, v_depois, v_r->>'soma_mudanca', v_r->>'lote';
END
$conv$;

SELECT 'FIM_APLICACAO_OK' AS marcador;
