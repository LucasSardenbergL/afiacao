-- ============================================================================================
-- pedido_total_liquido_acervo — o cabeçalho do ACERVO vai de BRUTO a LÍQUIDO onde as LINHAS provam
-- ============================================================================================
-- POR QUÊ. Até o #2469 todo escritor gravava `sales_orders.subtotal`/`total` BRUTOS (Σ qtd·preço:
-- a ingestão lia `prod.desconto`, chave que a API do Omie não manda). O #2469 passou o pedido NOVO,
-- e o que o `sync-reprocess` relê, a LÍQUIDO pela régua. O acervo segue bruto, e quem COMPARA
-- períodos erra: presente líquido × passado bruto dá a um cliente com 10% de desconto uma "queda"
-- de 10% (`faturamento_90d × prev_90d` da `customer_metrics_mv`, `useTeamKpis` MTD × mês anterior).
-- Narrativa: docs/historico/total-liquido-do-pedido-e-a-base-que-compara.md.
--
-- O QUE CRIA.
--   · `pedido_total_liquido_classificar(p_corte, p_ids)` — a CLASSE de cada pedido Omie (STABLE).
--     `p_ids` NULL = todos; array vazio = nenhum.
--   · `pedido_total_liquido_relatorio(p_corte)` — por conta×classe e por conta×mês, com o
--     denominador do mês: líquido provado, sem desconto, convertível, não apurado, sem prova (STABLE).
--   · `pedido_total_liquido_converter(...)` — ENSAIO (`p_aplicar => false`) ou escrita de UM lote.
--   · `pedido_total_liquido_conversoes` — registro append-only de cada pedido convertido (lote,
--     total antes/depois, corte). É a trilha para auditar e para desfazer um lote.
--
-- A REGRA (precisão > recall: na dúvida o pedido fica como está e aparece no relatório).
--   convertível ⇔ todas as linhas têm `desconto_valor` apurado e são sãs (qtd > 0, preço ≥ 0,
--     desconto ≥ 0 e ≤ base + ½ centavo, os três finitos; líquido do pedido ≥ 0), o cabeçalho está
--     no padrão da ingestão Omie (total finito ≥ 0, subtotal = total, discount = 0), o total AINDA
--     é o bruto (|total − round(Σ qtd·preço, 2)| ≤ 0,01), NÃO é o líquido
--     (|total − round(Σ (qtd·preço − desconto_valor), 2)| > 0,01) e o cabeçalho não foi reescrito
--     desde `p_corte` (`updated_at < p_corte`);
--   grava total = subtotal = round(Σ (qtd·preço − desconto_valor), 2) — arredonda UMA vez, no
--     fim, como `apurarSubtotalPedido` (_shared/omie-pedido.ts); `discount` segue 0.
-- A tolerância de 0,01 é o float do bruto legado no TS (medido 2026-09-14: 7 pedidos colacor a
-- exatamente 0,01 de `round(Σ, 2)`, nenhum além). Com desconto de até ~2 centavos o total cabe nas
-- DUAS tolerâncias: `ambiguo`, não se toca. Sem desconto não há o que converter (`sem_desconto`).
--
-- O CORTE — por que o cabeçalho reescrito depois dele NÃO se converte (achado da 2ª opinião).
-- A regra acima confia que `desconto_valor` e o cabeçalho descrevem a MESMA revisão do pedido.
-- Isso vale para cabeçalho escrito por quem gravava BRUTO (a v1.6 e anteriores): o total bruto é
-- a soma das mesmas linhas, e o desconto delas veio do mesmo payload (ingestão) ou do ERP atual com
-- a base conferida (backfill). Deixa de valer quando o cabeçalho é reescrito DEPOIS: o reprocess
-- v1.7 grava o líquido do ERP, mas não atualiza `desconto_valor` se só o desconto mudou; a edição
-- pelo app grava bruto carregando o `desconto_valor` antigo. Nos dois casos converter aplicaria um
-- desconto VENCIDO. `p_corte` é um instante em que a v1.6 ainda servia (medido no ledger de deploy,
-- antes do deploy da v1.7): cabeçalho com `updated_at` a partir dele vira `tocado_pos_corte`.
--
-- O LOTE. Escopo explícito (`p_contas`, `p_mes_de`, `p_mes_ate`); com `p_exigir_mes_completo` (o
-- default) um conta×mês só converte quando não tem pedido `nao_apurado` nem `linha_invalida` —
-- converter meio mês cria base mista dentro do mesmo período, e isso distorce comparação até
-- inverter o sinal. `p_limite` é TETO QUE RECUSA: escopo com mais convertíveis que o limite não
-- grava nada (money-path.md §8 — teto que trunca fabrica completude).
--
-- CONCORRÊNCIA. Os escritores do agregado (`criar_pedidos_com_itens`, `reconciliar_pedidos_omie`,
-- `aplicar_edicao_pedido_omie`) travam o PAI com FOR UPDATE. O conversor trava os pais do lote com
-- `FOR UPDATE SKIP LOCKED` — nunca espera, então não entra em deadlock com a ordem de lock deles;
-- pedido em uso fica para a próxima rodada — e só escreve no statement seguinte ao lock, que
-- re-classifica com snapshot novo (READ COMMITTED) e reescreve só o total que acabou de ler. O
-- backfill não trava o pai, mas só escreve NULL → valor. Duas conversões ao mesmo tempo: advisory
-- lock de transação, a segunda recusa com 55P03.
--
-- COERÊNCIA. `trg_pedido_venda_coerencia_cab` (CONSTRAINT deferida, ENABLE ALWAYS) roda
-- `pedido_venda_exigir_coerencia` para todo pai atualizado, no COMMIT. Ela não olha total, mas um
-- pedido que já estivesse incoerente derrubaria o lote INTEIRO com 23514. O conversor roda a MESMA
-- função antes de escrever, pula e reporta quem ela recusaria. Medido 2026-09-14: 0 incoerentes.
--
-- O QUE NÃO FAZ. Não toca o G5 de `criar_pedidos_com_itens` nem as RPCs de reconciliação; não
-- apura `desconto_valor` (é do backfill, edge `omie-desconto-backfill`); não mexe em linha nem em
-- `items`. ⚠️ Não aplique antes do deploy das edges v1.7 do #2469 (`omie-vendas-sync`,
-- `sync-reprocess`) + a drenagem das chamadas v1.6 em curso: o reprocess v1.6 recalcula BRUTO.
--
-- ACL. As funções são SECURITY INVOKER, fechadas para PUBLIC/anon/authenticated (as duas pontas,
-- database.md); `service_role` executa, como em `desconto_backfill_aplicar`. A tabela tem RLS sem
-- policy e é append-only para `service_role`. O `db:aplicar` roda como `postgres`, o dono.
--
-- Prova: db/test-pedido-total-liquido-acervo.sh (PG17, com falsificação). Gêmeo sem envelope para
-- o `db:aplicar`: db/aplicar-pedido-total-liquido-rpc.sql (paridade de corpo provada no harness).
-- ============================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pedido_total_liquido_conversoes (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lote           uuid        NOT NULL,
  sales_order_id uuid        NOT NULL,
  account        text        NOT NULL,
  mes            date        NOT NULL,
  total_antes    numeric     NOT NULL,
  total_depois   numeric     NOT NULL,
  corte          timestamptz NOT NULL,
  convertido_em  timestamptz NOT NULL DEFAULT now(),
  -- A conversão só DESCONTA: o depois é finito, ≥ 0 e menor que o antes. Fecha os três lados do
  -- numeric (NaN > 0 é TRUE; `< 'Infinity'` é o que barra NaN e Infinity).
  CONSTRAINT pedido_total_liquido_conversoes_valores CHECK (
        total_antes  >= 0 AND total_antes  < 'Infinity'::numeric
    AND total_depois >= 0 AND total_depois < 'Infinity'::numeric
    AND total_depois < total_antes
  )
);

CREATE INDEX IF NOT EXISTS idx_pedido_total_liquido_conversoes_pedido
  ON public.pedido_total_liquido_conversoes (sales_order_id);
CREATE INDEX IF NOT EXISTS idx_pedido_total_liquido_conversoes_lote
  ON public.pedido_total_liquido_conversoes (lote);

ALTER TABLE public.pedido_total_liquido_conversoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pedido_total_liquido_conversoes FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.pedido_total_liquido_conversoes FROM service_role;
GRANT SELECT, INSERT ON TABLE public.pedido_total_liquido_conversoes TO service_role;

CREATE OR REPLACE FUNCTION public.pedido_total_liquido_classificar(
  p_corte timestamptz,
  p_ids   uuid[] DEFAULT NULL
)
RETURNS TABLE (
  sales_order_id uuid,
  account        text,
  mes            date,
  classe         text,
  total          numeric,
  bruto          numeric,
  liquido        numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH lin AS (
    SELECT oi.sales_order_id                                        AS so_id,
           count(*) FILTER (WHERE oi.desconto_valor IS NULL)        AS n_nao_apurada,
           -- `IS NOT TRUE` e não `NOT (...)`: um predicado NULL (preço ausente) conta como
           -- inválido. `NOT NULL` é NULL, e o FILTER o descartaria como se a linha fosse sã.
           -- `< 'Infinity'` fecha NaN e +Infinity de uma vez: em numeric, NaN ordena ACIMA de
           -- Infinity, e `'NaN' > 0` é TRUE (money-path.md §2).
           count(*) FILTER (WHERE (
                 oi.quantity   >  0 AND oi.quantity   < 'Infinity'::numeric
             AND oi.unit_price >= 0 AND oi.unit_price < 'Infinity'::numeric
           ) IS NOT TRUE)                                           AS n_base_invalida,
           count(*) FILTER (WHERE oi.desconto_valor IS NOT NULL AND (
                 oi.desconto_valor >= 0 AND oi.desconto_valor < 'Infinity'::numeric
             AND oi.desconto_valor <= oi.quantity * oi.unit_price + 0.005
           ) IS NOT TRUE)                                           AS n_desconto_invalido,
           sum(oi.quantity * oi.unit_price)                         AS bruto_cru,
           sum(oi.quantity * oi.unit_price - oi.desconto_valor)     AS liquido_cru,
           sum(oi.desconto_valor)                                   AS desconto_cru
      FROM public.order_items oi
     WHERE p_ids IS NULL OR oi.sales_order_id = ANY (p_ids)
     GROUP BY oi.sales_order_id
  ),
  cab AS (
    SELECT so.id                                                    AS so_id,
           so.account                                               AS conta,
           -- O mesmo dia que a `customer_metrics_mv` usa para janelar o faturamento. `::timestamp`
           -- para o date_trunc não passar por timestamptz e depender do TimeZone da sessão.
           date_trunc('month', COALESCE(so.order_date_kpi,
             (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp)::date AS mes,
           so.total                                                 AS total_atual,
           so.subtotal                                              AS subtotal_atual,
           so.discount                                              AS discount_atual,
           so.updated_at                                            AS atualizado_em
      FROM public.sales_orders so
     WHERE so.omie_pedido_id IS NOT NULL
       AND (p_ids IS NULL OR so.id = ANY (p_ids))
  ),
  medido AS (
    SELECT c.so_id, c.conta, c.mes, c.total_atual, c.subtotal_atual, c.discount_atual, c.atualizado_em,
           l.so_id IS NOT NULL                                      AS tem_linha,
           l.n_nao_apurada, l.n_base_invalida, l.n_desconto_invalido, l.desconto_cru,
           round(l.bruto_cru, 2)                                    AS bruto_r,
           round(l.liquido_cru, 2)                                  AS liquido_r
      FROM cab c
      LEFT JOIN lin l ON l.so_id = c.so_id
  )
  SELECT m.so_id,
         m.conta,
         m.mes,
         CASE
           WHEN NOT m.tem_linha
             THEN 'sem_linha'
           WHEN (m.total_atual >= 0 AND m.total_atual < 'Infinity'::numeric
                 AND m.subtotal_atual = m.total_atual AND m.discount_atual = 0) IS NOT TRUE
             THEN 'cabecalho_fora_do_padrao'
           WHEN m.n_base_invalida > 0 OR m.n_desconto_invalido > 0
             THEN 'linha_invalida'
           WHEN m.n_nao_apurada > 0
             THEN 'nao_apurado'
           -- Desconto de ½ centavo por linha sobre base de ½ centavo arredonda o pedido para −0,01
           -- no numeric (empate longe do zero); o TS daria −0. Total negativo não se publica.
           WHEN m.liquido_r < 0
             THEN 'linha_invalida'
           WHEN abs(m.total_atual - m.bruto_r) > 0.01 AND abs(m.total_atual - m.liquido_r) > 0.01
             THEN 'divergente'
           WHEN m.desconto_cru = 0
             THEN 'sem_desconto'
           WHEN abs(m.total_atual - m.bruto_r) <= 0.01 AND abs(m.total_atual - m.liquido_r) <= 0.01
             THEN 'ambiguo'
           WHEN abs(m.total_atual - m.bruto_r) <= 0.01 AND p_corte IS NOT NULL AND m.atualizado_em >= p_corte
             THEN 'tocado_pos_corte'
           WHEN abs(m.total_atual - m.bruto_r) <= 0.01
             THEN 'convertivel'
           ELSE 'ja_liquido'
         END,
         m.total_atual,
         m.bruto_r,
         m.liquido_r
    FROM medido m;
$fn$;

CREATE OR REPLACE FUNCTION public.pedido_total_liquido_relatorio(p_corte timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH c AS MATERIALIZED (
    SELECT * FROM public.pedido_total_liquido_classificar(p_corte, NULL)
  )
  SELECT jsonb_build_object(
    'medido_em',    now(),
    'corte',        p_corte,
    'pedidos_omie', (SELECT count(*) FROM c),
    'por_classe', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'conta', x.account, 'classe', x.classe, 'pedidos', x.n, 'soma_total', x.s
             ) ORDER BY x.account, x.classe), '[]'::jsonb)
        FROM (SELECT c.account, c.classe, count(*) AS n, sum(c.total) AS s
                FROM c GROUP BY c.account, c.classe) x
    ),
    -- `pedidos` é o DENOMINADOR do mês. `nao_apurado` NÃO quer dizer bruto: depois da v1.7 o
    -- reprocess reescreve o cabeçalho a líquido sem apurar a linha. Quer dizer "sem prova".
    'por_conta_mes', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'conta', z.account, 'mes', to_char(z.mes, 'YYYY-MM'),
               'pedidos', z.n, 'soma_total', z.s_total,
               'liquido_provado', z.n_ja_liquido, 'sem_desconto', z.n_sem_desconto,
               'convertivel', z.n_convertivel, 'soma_mudanca_convertivel', z.s_mudanca,
               'nao_apurado', z.n_nao_apurado, 'soma_total_nao_apurado', z.s_nao_apurado,
               'sem_prova_outros', z.n_outros,
               'apuracao_completa', (z.n_nao_apurado + z.n_linha_invalida = 0)
             ) ORDER BY z.account, z.mes DESC), '[]'::jsonb)
        FROM (SELECT c.account, c.mes,
                     count(*)                                                    AS n,
                     sum(c.total)                                                AS s_total,
                     count(*) FILTER (WHERE c.classe = 'ja_liquido')             AS n_ja_liquido,
                     count(*) FILTER (WHERE c.classe = 'sem_desconto')           AS n_sem_desconto,
                     count(*) FILTER (WHERE c.classe = 'convertivel')            AS n_convertivel,
                     -- Σ sobre conjunto vazio: nenhum pedido da classe no mês soma 0 de fato.
                     coalesce(sum(c.liquido - c.total) FILTER (WHERE c.classe = 'convertivel'), 0) AS s_mudanca,
                     count(*) FILTER (WHERE c.classe = 'nao_apurado')            AS n_nao_apurado,
                     coalesce(sum(c.total) FILTER (WHERE c.classe = 'nao_apurado'), 0) AS s_nao_apurado,
                     count(*) FILTER (WHERE c.classe = 'linha_invalida')         AS n_linha_invalida,
                     count(*) FILTER (WHERE c.classe IN ('linha_invalida', 'tocado_pos_corte', 'ambiguo',
                                                         'divergente', 'cabecalho_fora_do_padrao', 'sem_linha')) AS n_outros
                FROM c
               GROUP BY c.account, c.mes) z
    )
  );
$fn$;

CREATE OR REPLACE FUNCTION public.pedido_total_liquido_converter(
  p_aplicar             boolean,
  p_corte               timestamptz,
  p_contas              text[]  DEFAULT NULL,
  p_mes_de              date    DEFAULT NULL,
  p_mes_ate             date    DEFAULT NULL,
  p_limite              integer DEFAULT 5000,
  p_exigir_mes_completo boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mes_de         date := date_trunc('month', p_mes_de::timestamp)::date;
  v_mes_ate        date := date_trunc('month', p_mes_ate::timestamp)::date;
  v_lote           uuid := gen_random_uuid();
  v_escopo         jsonb;
  v_elegiveis      uuid[];
  v_n_elegiveis    integer;
  v_soma_prevista  numeric;
  v_por_mes        jsonb;
  v_bloqueados     jsonb;
  v_travados       uuid[];
  v_coerentes      uuid[] := '{}';
  v_incoerentes    uuid[] := '{}';
  v_id             uuid;
  v_n_alvo         integer;
  v_n_escritos     integer;
  v_n_registrados  integer;
  v_escritos       uuid[];
  v_soma_mudanca   numeric;
  v_escritos_mes   jsonb;
  v_ruins          integer;
BEGIN
  IF p_aplicar IS NULL OR p_exigir_mes_completo IS NULL THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_aplicar e p_exigir_mes_completo nao podem ser NULL'
      USING ERRCODE = '22023';
  END IF;
  IF p_corte IS NULL OR p_corte > now() THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_corte tem de ser um instante passado em que a v1.6 ainda servia (veio %)', p_corte
      USING ERRCODE = '22023';
  END IF;
  IF p_contas IS NOT NULL AND (cardinality(p_contas) = 0 OR NOT (p_contas <@ ARRAY['oben', 'colacor'])) THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_contas tem de ser NULL (todas) ou um subconjunto nao vazio de {oben, colacor} (veio %)', p_contas
      USING ERRCODE = '22023';
  END IF;
  IF v_mes_de IS NOT NULL AND v_mes_ate IS NOT NULL AND v_mes_de > v_mes_ate THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_mes_de (%) depois de p_mes_ate (%)', v_mes_de, v_mes_ate
      USING ERRCODE = '22023';
  END IF;
  -- NULL é recusado, não lido como "sem limite": `LIMIT NULL` no Postgres remove o limite.
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 50000 THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_limite fora de [1, 50000] (veio %)', p_limite
      USING ERRCODE = '22023';
  END IF;

  IF p_aplicar THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('pedido_total_liquido_converter')) THEN
      RAISE EXCEPTION 'pedido_total_liquido_converter: outra conversao esta em curso'
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  v_escopo := jsonb_build_object(
    'contas',              to_jsonb(p_contas),
    'mes_de',              to_char(v_mes_de, 'YYYY-MM'),
    'mes_ate',             to_char(v_mes_ate, 'YYYY-MM'),
    'exigir_mes_completo', p_exigir_mes_completo
  );

  WITH c AS MATERIALIZED (
    SELECT * FROM public.pedido_total_liquido_classificar(p_corte, NULL)
  ),
  mes_estado AS (
    SELECT c.account, c.mes,
           count(*) FILTER (WHERE c.classe = 'convertivel')    AS n_convertivel,
           count(*) FILTER (WHERE c.classe = 'nao_apurado')    AS n_nao_apurado,
           count(*) FILTER (WHERE c.classe = 'linha_invalida') AS n_linha_invalida
      FROM c
     GROUP BY c.account, c.mes
  ),
  no_escopo AS (
    SELECT m.*
      FROM mes_estado m
     WHERE (p_contas  IS NULL OR m.account = ANY (p_contas))
       AND (v_mes_de  IS NULL OR m.mes >= v_mes_de)
       AND (v_mes_ate IS NULL OR m.mes <= v_mes_ate)
  ),
  elegivel AS (
    SELECT c.*
      FROM c
      JOIN no_escopo m ON m.account = c.account AND m.mes = c.mes
     WHERE c.classe = 'convertivel'
       AND (NOT p_exigir_mes_completo OR m.n_nao_apurado + m.n_linha_invalida = 0)
  )
  SELECT (SELECT array_agg(e.sales_order_id ORDER BY e.sales_order_id) FROM elegivel e),
         (SELECT count(*) FROM elegivel),
         (SELECT sum(e.liquido - e.total) FROM elegivel e),
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', g.account, 'mes', to_char(g.mes, 'YYYY-MM'), 'pedidos', g.n,
                   'soma_total_atual', g.s_total, 'soma_liquido', g.s_liquido,
                   'soma_mudanca', g.s_liquido - g.s_total
                 ) ORDER BY g.account, g.mes DESC)
            FROM (SELECT e.account, e.mes, count(*) AS n, sum(e.total) AS s_total, sum(e.liquido) AS s_liquido
                    FROM elegivel e GROUP BY e.account, e.mes) g),
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', m.account, 'mes', to_char(m.mes, 'YYYY-MM'), 'convertivel', m.n_convertivel,
                   'nao_apurado', m.n_nao_apurado, 'linha_invalida', m.n_linha_invalida
                 ) ORDER BY m.account, m.mes DESC)
            FROM no_escopo m
           WHERE p_exigir_mes_completo
             AND m.n_convertivel > 0
             AND m.n_nao_apurado + m.n_linha_invalida > 0)
    INTO v_elegiveis, v_n_elegiveis, v_soma_prevista, v_por_mes, v_bloqueados;
  -- array_agg de nada é NULL — e NULL, para o classificador, quer dizer TODOS os pedidos.
  v_elegiveis := coalesce(v_elegiveis, '{}'::uuid[]);

  IF v_n_elegiveis > p_limite THEN
    IF p_aplicar THEN
      RAISE EXCEPTION 'pedido_total_liquido_converter: o escopo tem % convertiveis, acima do limite % — reduza o escopo ou suba o limite; nada foi gravado', v_n_elegiveis, p_limite
        USING ERRCODE = 'TL002';
    END IF;
    RETURN jsonb_build_object(
      'modo', 'ensaio', 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
      'excede_limite', true, 'elegiveis', v_n_elegiveis,
      'por_conta_mes', coalesce(v_por_mes, '[]'::jsonb),
      'meses_bloqueados', coalesce(v_bloqueados, '[]'::jsonb)
    );
  END IF;

  IF p_aplicar THEN
    -- SKIP LOCKED: pedido que um escritor está reescrevendo agora fica para a próxima rodada. Não
    -- esperar é o que impede deadlock com a ordem de lock dos escritores.
    SELECT array_agg(t.id ORDER BY t.id)
      INTO v_travados
      FROM (SELECT so.id
              FROM public.sales_orders so
             WHERE so.id = ANY (v_elegiveis)
             ORDER BY so.id
               FOR UPDATE SKIP LOCKED) t;
    v_travados := coalesce(v_travados, '{}'::uuid[]);
  ELSE
    v_travados := v_elegiveis;
  END IF;

  -- A mesma função que a trigger deferida roda no COMMIT: quem ela recusaria não entra no lote.
  FOREACH v_id IN ARRAY v_travados LOOP
    BEGIN
      PERFORM public.pedido_venda_exigir_coerencia(v_id);
      v_coerentes := v_coerentes || v_id;
    EXCEPTION WHEN check_violation THEN
      v_incoerentes := v_incoerentes || v_id;
    END;
  END LOOP;

  IF NOT p_aplicar THEN
    RETURN jsonb_build_object(
      'modo', 'ensaio', 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
      'excede_limite', false, 'elegiveis', v_n_elegiveis,
      'incoerentes', cardinality(v_incoerentes), 'amostra_incoerentes', to_jsonb(v_incoerentes[1:20]),
      -- Σ sobre nada elegível: a mudança prevista é 0 de fato.
      'soma_mudanca_prevista', coalesce(v_soma_prevista, 0),
      'por_conta_mes', coalesce(v_por_mes, '[]'::jsonb),
      'meses_bloqueados', coalesce(v_bloqueados, '[]'::jsonb)
    );
  END IF;

  -- Statement POSTERIOR ao lock: snapshot novo. `alvo` re-classifica quem está travado, e o
  -- UPDATE só reescreve o total que acabou de ler.
  WITH alvo AS (
    SELECT c.sales_order_id, c.account, c.mes, c.total, c.liquido
      FROM public.pedido_total_liquido_classificar(p_corte, v_coerentes) c
     WHERE c.classe = 'convertivel'
  ),
  escrito AS (
    UPDATE public.sales_orders so
       SET total    = a.liquido,
           subtotal = a.liquido
      FROM alvo a
     WHERE so.id = a.sales_order_id
       AND so.total = a.total
    RETURNING so.id AS sales_order_id, a.account, a.mes, a.total AS total_antes, a.liquido AS total_depois
  ),
  registrado AS (
    INSERT INTO public.pedido_total_liquido_conversoes
           (lote, sales_order_id, account, mes, total_antes, total_depois, corte)
    SELECT v_lote, e.sales_order_id, e.account, e.mes, e.total_antes, e.total_depois, p_corte
      FROM escrito e
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM alvo),
         (SELECT count(*) FROM escrito),
         (SELECT count(*) FROM registrado),
         (SELECT array_agg(e.sales_order_id ORDER BY e.sales_order_id) FROM escrito e),
         (SELECT sum(e.total_depois - e.total_antes) FROM escrito e),
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', m.account, 'mes', to_char(m.mes, 'YYYY-MM'), 'pedidos', m.n,
                   'soma_total_antes', m.s_antes, 'soma_total_depois', m.s_depois,
                   'soma_mudanca', m.s_depois - m.s_antes
                 ) ORDER BY m.account, m.mes DESC)
            FROM (SELECT e.account, e.mes, count(*) AS n,
                         sum(e.total_antes) AS s_antes, sum(e.total_depois) AS s_depois
                    FROM escrito e GROUP BY e.account, e.mes) m)
    INTO v_n_alvo, v_n_escritos, v_n_registrados, v_escritos, v_soma_mudanca, v_escritos_mes;
  v_escritos := coalesce(v_escritos, '{}'::uuid[]);

  -- Postcondição em statements POSTERIORES ao UPDATE: qualquer falha devolve o lote inteiro.
  IF v_n_escritos <> v_n_alvo OR v_n_registrados <> v_n_escritos THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: POSTCONDICAO alvo=% escritos=% registrados=% — nada foi gravado', v_n_alvo, v_n_escritos, v_n_registrados
      USING ERRCODE = 'TL001';
  END IF;

  SELECT count(*)
    INTO v_ruins
    FROM public.sales_orders so
    LEFT JOIN public.pedido_total_liquido_classificar(p_corte, v_escritos) c ON c.sales_order_id = so.id
   WHERE so.id = ANY (v_escritos)
     AND (c.sales_order_id IS NULL
          OR c.classe NOT IN ('ja_liquido', 'ambiguo')
          OR so.total    IS DISTINCT FROM c.liquido
          OR so.subtotal IS DISTINCT FROM c.liquido);
  IF v_ruins > 0 THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: POSTCONDICAO % pedido(s) escritos sem total = subtotal = liquido das linhas — nada foi gravado', v_ruins
      USING ERRCODE = 'TL001';
  END IF;

  RETURN jsonb_build_object(
    'modo', 'aplicado', 'lote', v_lote, 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
    'elegiveis',              v_n_elegiveis,
    'pulados_em_uso',         v_n_elegiveis - cardinality(v_travados),
    'incoerentes',            cardinality(v_incoerentes),
    'amostra_incoerentes',    to_jsonb(v_incoerentes[1:20]),
    'mudaram_sob_lock',       cardinality(v_coerentes) - v_n_alvo,
    'escritos',               v_n_escritos,
    -- Σ sobre nada escrito: a mudança foi 0 de fato.
    'soma_mudanca',           coalesce(v_soma_mudanca, 0),
    'escritos_por_conta_mes', coalesce(v_escritos_mes, '[]'::jsonb),
    'meses_bloqueados',       coalesce(v_bloqueados, '[]'::jsonb)
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.pedido_total_liquido_classificar(timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_total_liquido_relatorio(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamptz, text[], date, date, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_classificar(timestamptz, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_relatorio(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamptz, text[], date, date, integer, boolean) TO service_role;

DO $post$
DECLARE
  v_fn  text;
  v_oid regprocedure;
  v_tab regclass := to_regclass('public.pedido_total_liquido_conversoes');
  v_r   jsonb;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.pedido_total_liquido_classificar(timestamptz,uuid[])',
    'public.pedido_total_liquido_relatorio(timestamptz)',
    'public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)'
  ] LOOP
    v_oid := to_regprocedure(v_fn);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % nao existe — a migration nao pegou', v_fn;
    END IF;
    IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % e SECURITY DEFINER — escreveria como o dono, por cima de quem chama', v_fn;
    END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % executavel por PUBLIC/anon/authenticated — a conversao do acervo ficaria no PostgREST', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: service_role sem EXECUTE em % (controle positivo do REVOKE)', v_fn;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid IN (to_regprocedure('public.pedido_total_liquido_classificar(timestamptz,uuid[])'),
                              to_regprocedure('public.pedido_total_liquido_relatorio(timestamptz)'))
                AND p.provolatile <> 's') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: classificar/relatorio deixaram de ser STABLE — deixariam de ser incapazes de escrever';
  END IF;

  IF v_tab IS NULL OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tab) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: pedido_total_liquido_conversoes ausente ou sem RLS';
  END IF;
  IF has_table_privilege('anon', v_tab, 'SELECT') OR has_table_privilege('authenticated', v_tab, 'SELECT')
     OR has_table_privilege('anon', v_tab, 'TRUNCATE') OR has_table_privilege('authenticated', v_tab, 'TRUNCATE')
     OR has_table_privilege('service_role', v_tab, 'DELETE') OR has_table_privilege('service_role', v_tab, 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: pedido_total_liquido_conversoes aberta a anon/authenticated ou apagavel pelo service_role';
  END IF;
  IF NOT has_table_privilege('service_role', v_tab, 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: service_role sem INSERT no registro (controle positivo)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = v_tab AND k.conname = 'pedido_total_liquido_conversoes_valores'
                    AND k.convalidated) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: CHECK de valores do registro ausente ou NOT VALID';
  END IF;

  -- plpgsql é late-bound: o CREATE passa com SQL inválido. O ensaio EXECUTA o caminho de leitura
  -- inteiro sobre o dado real — função quebrada aborta a migration aqui, não no primeiro lote.
  v_r := public.pedido_total_liquido_converter(p_aplicar => false, p_corte => now());
  IF v_r->>'modo' IS DISTINCT FROM 'ensaio' OR jsonb_typeof(v_r->'por_conta_mes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o ensaio nao devolveu o formato esperado: %', left(v_r::text, 160);
  END IF;
  v_r := public.pedido_total_liquido_relatorio(now());
  IF jsonb_typeof(v_r->'por_conta_mes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o relatorio nao devolveu o formato esperado: %', left(v_r::text, 160);
  END IF;
END
$post$;

COMMIT;
