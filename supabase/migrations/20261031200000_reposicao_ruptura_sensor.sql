-- ============================================================================================
-- Sensor de RUPTURA / fill-rate da Oben — nasce com denominador, antes do "segurar compra" (Frente C).
-- Spec: docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md §4 (Frente A, decisão 2 do founder).
-- Diário: docs/historico/oben-pme-pmr-frente-a.md. Prova PG17: db/test-reposicao-ruptura-sensor.sh.
--
-- MEDIDO em prod (psql-ro, 2026-10-31) antes de desenhar — três premissas do briefing não batem:
--   • 1.186 pedidos Oben em 90d vieram do Omie (importação); 1 nasceu no app. O gate ATP (`atp_decisoes`,
--     1 linha em 120d) NÃO é fronteira — a fronteira é a IMPORTAÇÃO do PV (`criar_pedidos_com_itens`).
--   • Não existe vínculo PV ↔ NF-e armazenado (`venda_items_history.raw_data` é o `det` da NF-e: sem
--     xPed/nIdPedido) ⇒ "item pedido × item faturado" não é derivável; o que se prova é "item pedido ×
--     estoque no instante da importação".
--   • Fonte de estoque = UNIÃO de duas posições (medido nos 361 SKUs com venda em 90d): `inventory_position`
--     'vendas' (sync 30 min; 281 positivos + 2 zeros confirmados, mas SEM linha para 78 — o Omie só lista
--     saldo ≠ 0 até o zeramento ser confirmado) e `sku_estoque_atual` 'OBEN' (sync 2h; traz ZERO explícito
--     para 20 desses 78). Preferência: linha fresca (≤ 48h) da 1ª, senão da 2ª, senão sem leitura (58).
--   • Não há histórico diário de saldo por SKU (só posição atual) ⇒ a leitura de prateleira nasce
--     persistida HOJE e cresce para a frente; o passado não se fabrica.
--
-- Duas leituras, dois writers, um por tabela (money-path: sinal nunca em jsonb multi-writer):
--   (A) `reposicao_ruptura_pedido_itens` — por ITEM de PV importado da Oben, gravado por TRIGGER no
--       INSERT de `order_items` (hash_payload 'omie_%'). Lê `inventory_position` (account 'vendas') no
--       instante: saldo ≥ quantidade ⇒ 'atendivel'; < ⇒ 'ruptura'; PV já 'faturado'/'cancelado' na
--       importação ⇒ 'indeterminado' (o Omie baixa o estoque no faturamento — o saldo lido pode já
--       descontar ESTE pedido); sem linha ou leitura > 48h ⇒ 'sem_leitura'. Fail-OPEN: o sensor nunca
--       trava a importação; a perda aparece em `cobertura_pct` (registrados / itens importados).
--   (B) `reposicao_ruptura_prateleira_diaria` — 1 linha/dia: SKUs com venda nos 90d anteriores
--       (NF-e, `venda_items_history`, devolução fora) × saldo hoje (≤ 0 = sem saldo; sem leitura
--       fresca = sem_leitura). Writer = `reposicao_ruptura_prateleira_registrar()` (owner-only) por
--       cron SQL-direto 10:10Z. Linha de base de 2026-10-31 (pré-voo): 39 de 361 SKUs sem saldo (10,8%),
--       51 sem leitura.
--   Views semanais `v_reposicao_ruptura_pedidos_semana` / `v_reposicao_ruptura_prateleira_semana`
--   (security_invoker=on) são o "quando medir": fill_rate_pct só com ≥ 20 linhas decididas na semana.
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261031200000_reposicao_ruptura_sensor.sql`
-- (sem BEGIN/COMMIT: a transação é do executor; o cron nasce com dono postgres — a postcondição exige).
-- ============================================================================================

-- ── 1. Fato por item de PV importado (writer único: o trigger) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_ruptura_pedido_itens (
  id                  bigserial PRIMARY KEY,
  empresa             text NOT NULL CONSTRAINT reposicao_ruptura_pedido_itens_empresa_ck CHECK (empresa = 'oben'),
  -- SET NULL: a exclusão do pedido não apaga a trilha (mesma escolha de atp_decisoes)
  sales_order_id      uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  order_item_id       uuid,
  omie_pedido_id      bigint,
  omie_codigo_produto bigint NOT NULL,
  omie_codigo_item    bigint,
  quantidade          numeric NOT NULL CONSTRAINT reposicao_ruptura_pedido_itens_qtd_ck
                        CHECK (quantidade > 0 AND quantidade < 1000000),
  status_pv           text NOT NULL,
  data_pedido         date,
  -- fatos lidos no instante (NULL = não havia leitura; nunca 0 fabricado)
  estoque_saldo       numeric CONSTRAINT reposicao_ruptura_pedido_itens_saldo_ck
                        CHECK (estoque_saldo IS NULL OR (estoque_saldo <> 'NaN' AND estoque_saldo > -1000000 AND estoque_saldo < 1000000)),
  estoque_lido_em     timestamptz,
  estoque_fonte       text CONSTRAINT reposicao_ruptura_pedido_itens_fonte_ck
                        CHECK (estoque_fonte IS NULL OR estoque_fonte IN ('inventory_position', 'sku_estoque_atual')),
  leitura             text NOT NULL CONSTRAINT reposicao_ruptura_pedido_itens_leitura_ck
                        CHECK (leitura IN ('atendivel', 'ruptura', 'indeterminado', 'sem_leitura')),
  registrado_em       timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A 1ª leitura do item vence (a reimportação só "repara" itens ausentes; se vier de novo, não regrava).
CREATE UNIQUE INDEX IF NOT EXISTS reposicao_ruptura_pedido_itens_chave_uq
  ON public.reposicao_ruptura_pedido_itens (sales_order_id, omie_codigo_produto, COALESCE(omie_codigo_item, 0));
CREATE INDEX IF NOT EXISTS idx_reposicao_ruptura_pedido_itens_registrado
  ON public.reposicao_ruptura_pedido_itens (empresa, registrado_em);

-- Leitura FRESCA do saldo de um SKU da Oben: inventory_position 'vendas' (30 min) tem preferência; sem linha
-- fresca lá, sku_estoque_atual 'OBEN' (2h, traz zero explícito); sem nenhuma, nenhuma linha (nunca 0).
CREATE OR REPLACE FUNCTION public._reposicao_ruptura_saldo_oben(p_sku bigint, p_corte timestamptz)
RETURNS TABLE (saldo numeric, lido_em timestamptz, fonte text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT ip.saldo, ip.synced_at, 'inventory_position'::text
    FROM public.inventory_position ip
   WHERE ip.account = 'vendas' AND ip.omie_codigo_produto = p_sku
     AND ip.saldo IS NOT NULL AND ip.saldo <> 'NaN'
     AND ip.synced_at IS NOT NULL AND ip.synced_at >= p_corte
  UNION ALL
  SELECT s.estoque_fisico, s.ultima_sincronizacao, 'sku_estoque_atual'::text
    FROM public.sku_estoque_atual s
   WHERE s.empresa = 'OBEN' AND s.sku_codigo_omie ~ '^[0-9]{1,18}$' AND s.sku_codigo_omie::bigint = p_sku
     AND s.estoque_fisico IS NOT NULL AND s.estoque_fisico <> 'NaN'
     AND s.ultima_sincronizacao IS NOT NULL AND s.ultima_sincronizacao >= p_corte
  ORDER BY 3 ASC  -- 'inventory_position' < 'sku_estoque_atual'
  LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION public.reposicao_ruptura_registrar_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_so      record;
  v_ip      record;
  v_leitura text;
  v_agora   timestamptz := clock_timestamp();
BEGIN
  SELECT account, status, order_date_kpi, omie_pedido_id, hash_payload
    INTO v_so
    FROM public.sales_orders
   WHERE id = NEW.sales_order_id;
  -- Só PV importado do Omie da Oben (hash 'omie_%'); pedido do app tem gate próprio (ATP).
  IF NOT FOUND OR v_so.account IS DISTINCT FROM 'oben'
     OR v_so.hash_payload IS NULL OR v_so.hash_payload NOT LIKE 'omie\_%' THEN
    RETURN NEW;
  END IF;
  -- Quantidade ilegível não é leitura: pula (a cobertura semanal mostra o buraco).
  IF NEW.omie_codigo_produto IS NULL OR NEW.quantity IS NULL OR NEW.quantity = 'NaN'
     OR NEW.quantity <= 0 OR NEW.quantity >= 1000000 THEN
    RAISE WARNING 'reposicao_ruptura_registrar_item: item % sem quantidade/sku legivel (qtd=%)', NEW.id, NEW.quantity;
    RETURN NEW;
  END IF;

  -- Leitura fresca (≤ 48h) na união das duas posições; sem linha = sem leitura (nunca 0).
  SELECT saldo, lido_em, fonte INTO v_ip
    FROM public._reposicao_ruptura_saldo_oben(NEW.omie_codigo_produto, v_agora - interval '48 hours');

  IF v_so.status IN ('faturado', 'cancelado') THEN
    v_leitura := 'indeterminado';
  ELSIF NOT FOUND THEN
    v_leitura := 'sem_leitura';
  ELSIF v_ip.saldo >= NEW.quantity THEN
    v_leitura := 'atendivel';
  ELSE
    v_leitura := 'ruptura';
  END IF;

  INSERT INTO public.reposicao_ruptura_pedido_itens
    (empresa, sales_order_id, order_item_id, omie_pedido_id, omie_codigo_produto, omie_codigo_item,
     quantidade, status_pv, data_pedido, estoque_saldo, estoque_lido_em, estoque_fonte, leitura, registrado_em)
  VALUES
    ('oben', NEW.sales_order_id, NEW.id, v_so.omie_pedido_id, NEW.omie_codigo_produto, NEW.omie_codigo_item,
     NEW.quantity, v_so.status, v_so.order_date_kpi,
     CASE WHEN FOUND THEN v_ip.saldo END,
     CASE WHEN FOUND THEN v_ip.lido_em END,
     CASE WHEN FOUND THEN v_ip.fonte END,
     v_leitura, v_agora)
  ON CONFLICT (sales_order_id, omie_codigo_produto, COALESCE(omie_codigo_item, 0)) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Fail-OPEN por desenho: telemetria nunca trava a importação de pedido (money-path). A perda não é
  -- muda — vai ao log e à cobertura_pct da view semanal.
  RAISE WARNING 'reposicao_ruptura_registrar_item: % (item %)', SQLERRM, NEW.id;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_reposicao_ruptura_registrar_item ON public.order_items;
CREATE TRIGGER trg_reposicao_ruptura_registrar_item
  AFTER INSERT ON public.order_items
  FOR EACH ROW
  WHEN (NEW.hash_payload IS NOT NULL AND NEW.hash_payload LIKE 'omie\_%')
  EXECUTE FUNCTION public.reposicao_ruptura_registrar_item();

-- ── 2. Leitura diária de prateleira (writer único: a função, por cron) ──────────────────────
CREATE TABLE IF NOT EXISTS public.reposicao_ruptura_prateleira_diaria (
  empresa                    text NOT NULL CONSTRAINT reposicao_ruptura_prateleira_empresa_ck CHECK (empresa = 'oben'),
  dia                        date NOT NULL,
  skus_com_venda_90d         integer NOT NULL CONSTRAINT reposicao_ruptura_prateleira_n_ck CHECK (skus_com_venda_90d > 0),
  skus_sem_saldo             integer NOT NULL CHECK (skus_sem_saldo >= 0),
  skus_sem_leitura           integer NOT NULL CHECK (skus_sem_leitura >= 0),
  valor_venda_90d            numeric NOT NULL CHECK (valor_venda_90d >= 0 AND valor_venda_90d < 1000000000),
  valor_venda_90d_sem_saldo  numeric NOT NULL CHECK (valor_venda_90d_sem_saldo >= 0),
  valor_venda_90d_sem_leitura numeric NOT NULL CHECK (valor_venda_90d_sem_leitura >= 0),
  estoque_lido_em            timestamptz,
  registrado_em              timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (empresa, dia)
);

-- Idempotente por (empresa, dia): a 1ª leitura do dia vence (ON CONFLICT DO NOTHING). Sem venda nos 90d
-- (implausível para a Oben) NÃO grava linha — ausente ≠ zero.
CREATE OR REPLACE FUNCTION public.reposicao_ruptura_prateleira_registrar(p_dia date DEFAULT NULL)
RETURNS TABLE (dia date, skus_com_venda_90d integer, skus_sem_saldo integer, skus_sem_leitura integer,
               valor_venda_90d numeric, valor_venda_90d_sem_saldo numeric, valor_venda_90d_sem_leitura numeric,
               estoque_lido_em timestamptz, gravou boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  v_dia   date := coalesce(p_dia, (now() AT TIME ZONE 'America/Sao_Paulo')::date);
  v_corte timestamptz := clock_timestamp() - interval '48 hours';
  v_n     integer;
BEGIN
  IF v_dia > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'reposicao_ruptura_prateleira_registrar: dia futuro (%)', v_dia USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.reposicao_ruptura_prateleira_diaria
    (empresa, dia, skus_com_venda_90d, skus_sem_saldo, skus_sem_leitura,
     valor_venda_90d, valor_venda_90d_sem_saldo, valor_venda_90d_sem_leitura, estoque_lido_em)
  SELECT 'oben', v_dia,
         count(*)::integer,
         (count(*) FILTER (WHERE e.saldo IS NOT NULL AND e.saldo <= 0))::integer,
         (count(*) FILTER (WHERE e.saldo IS NULL))::integer,
         coalesce(sum(v.valor), 0),
         coalesce(sum(v.valor) FILTER (WHERE e.saldo IS NOT NULL AND e.saldo <= 0), 0),
         coalesce(sum(v.valor) FILTER (WHERE e.saldo IS NULL), 0),
         max(e.lido_em)
    FROM (
      -- Demanda = SKUs com NF-e de venda nos 90 dias anteriores ao dia (grafia 'OBEN' da reposição).
      -- Devolução (CFOP x202) fora: na venda_items_history ela soma como positivo (financeiro.md).
      SELECT h.sku_codigo_omie, sum(h.valor_total) AS valor
        FROM public.venda_items_history h
       WHERE h.empresa = 'OBEN'
         AND h.sku_codigo_omie IS NOT NULL
         AND h.data_emissao >= v_dia - 90 AND h.data_emissao < v_dia
         AND coalesce(h.cfop, '') NOT IN ('1202', '2202', '5202', '6202')
         AND h.valor_total IS NOT NULL AND h.valor_total <> 'NaN' AND h.valor_total < 'Infinity' AND h.valor_total > 0
       GROUP BY h.sku_codigo_omie
    ) v
    -- Leitura fresca (≤ 48h) na união das duas posições; SKU que saiu da lista do Omie sem zeramento
    -- confirmado e sem zero explícito ⇒ sem_leitura, nunca "saldo 0".
    LEFT JOIN LATERAL public._reposicao_ruptura_saldo_oben(v.sku_codigo_omie, v_corte) e ON true
  HAVING count(*) > 0
  ON CONFLICT (empresa, dia) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY
    SELECT d.dia, d.skus_com_venda_90d, d.skus_sem_saldo, d.skus_sem_leitura,
           d.valor_venda_90d, d.valor_venda_90d_sem_saldo, d.valor_venda_90d_sem_leitura, d.estoque_lido_em, v_n > 0
      FROM public.reposicao_ruptura_prateleira_diaria d
     WHERE d.empresa = 'oben' AND d.dia = v_dia;
END
$fn$;

-- ── 3. "Quando medir": views semanais (semana = segunda-feira, horário de SP) ─────────────────
CREATE OR REPLACE VIEW public.v_reposicao_ruptura_pedidos_semana WITH (security_invoker=on) AS
WITH s AS (
  SELECT empresa,
         (date_trunc('week', registrado_em AT TIME ZONE 'America/Sao_Paulo'))::date AS semana,
         count(*)::integer AS itens_registrados,
         count(DISTINCT sales_order_id)::integer AS pedidos,
         (count(*) FILTER (WHERE leitura = 'atendivel'))::integer AS itens_atendiveis,
         (count(*) FILTER (WHERE leitura = 'ruptura'))::integer AS itens_ruptura,
         (count(*) FILTER (WHERE leitura = 'indeterminado'))::integer AS itens_indeterminados,
         (count(*) FILTER (WHERE leitura = 'sem_leitura'))::integer AS itens_sem_leitura
    FROM public.reposicao_ruptura_pedido_itens
   WHERE status_pv <> 'cancelado'
     AND registrado_em >= now() - interval '200 days'
   GROUP BY 1, 2
), imp AS (
  -- Denominador de COBERTURA: itens de PV importado da Oben na mesma semana (o trigger é fail-open).
  SELECT (date_trunc('week', oi.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS semana,
         count(*)::integer AS itens_importados
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = 'oben' AND so.hash_payload LIKE 'omie\_%' AND oi.hash_payload LIKE 'omie\_%'
     AND oi.created_at >= now() - interval '200 days'
   GROUP BY 1
)
SELECT s.empresa, s.semana, s.itens_registrados, imp.itens_importados, s.pedidos,
       s.itens_atendiveis, s.itens_ruptura, s.itens_indeterminados, s.itens_sem_leitura,
       -- fill-rate = atendíveis / decididos; só com ≥ 20 decididos (senão null, nunca 100% de 3 itens)
       CASE WHEN s.itens_atendiveis + s.itens_ruptura >= 20
            THEN round(100.0 * s.itens_atendiveis / (s.itens_atendiveis + s.itens_ruptura), 1) END AS fill_rate_pct,
       CASE WHEN imp.itens_importados > 0
            THEN round(100.0 * s.itens_registrados / imp.itens_importados, 1) END AS cobertura_pct
  FROM s
  LEFT JOIN imp USING (semana);

CREATE OR REPLACE VIEW public.v_reposicao_ruptura_prateleira_semana WITH (security_invoker=on) AS
SELECT empresa,
       date_trunc('week', dia)::date AS semana,
       count(*)::integer AS dias_lidos,
       max(dia) AS ultimo_dia,
       -- % de SKUs com venda (e leitura) sem saldo — média dos dias lidos da semana
       round(avg(100.0 * skus_sem_saldo / nullif(skus_com_venda_90d - skus_sem_leitura, 0)), 1) AS pct_skus_sem_saldo,
       round(avg(100.0 * valor_venda_90d_sem_saldo / nullif(valor_venda_90d - valor_venda_90d_sem_leitura, 0)), 1) AS pct_valor_sem_saldo,
       round(avg(100.0 * skus_sem_leitura / nullif(skus_com_venda_90d, 0)), 1) AS pct_skus_sem_leitura,
       max(skus_com_venda_90d) AS skus_com_venda_90d
  FROM public.reposicao_ruptura_prateleira_diaria
 GROUP BY 1, 2;

-- ── 4. RLS e privilégios: staff lê; ninguém escreve direto (só os 2 writers, owner) ───────────
ALTER TABLE public.reposicao_ruptura_pedido_itens      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_ruptura_prateleira_diaria ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reposicao_ruptura_pedido_itens, public.reposicao_ruptura_prateleira_diaria
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reposicao_ruptura_pedido_itens, public.reposicao_ruptura_prateleira_diaria
  TO authenticated, service_role;

DROP POLICY IF EXISTS reposicao_ruptura_pedido_itens_select_staff ON public.reposicao_ruptura_pedido_itens;
CREATE POLICY reposicao_ruptura_pedido_itens_select_staff ON public.reposicao_ruptura_pedido_itens
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)));

DROP POLICY IF EXISTS reposicao_ruptura_prateleira_select_staff ON public.reposicao_ruptura_prateleira_diaria;
CREATE POLICY reposicao_ruptura_prateleira_select_staff ON public.reposicao_ruptura_prateleira_diaria
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)));

REVOKE ALL ON public.v_reposicao_ruptura_pedidos_semana, public.v_reposicao_ruptura_prateleira_semana FROM PUBLIC, anon;
GRANT SELECT ON public.v_reposicao_ruptura_pedidos_semana, public.v_reposicao_ruptura_prateleira_semana TO authenticated, service_role;

-- Writers: só o owner (postgres — o trigger e o cron). As DUAS pontas (PUBLIC e anon) + nomeadas.
REVOKE ALL ON FUNCTION public.reposicao_ruptura_registrar_item() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._reposicao_ruptura_saldo_oben(bigint, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reposicao_ruptura_prateleira_registrar(date) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. Cron SQL-direto (sem net.http_post; nasce com dono postgres via db:aplicar) ──────────
SELECT cron.schedule(
  'reposicao-ruptura-prateleira-diario',
  '10 10 * * *',
  $cron$SELECT public.reposicao_ruptura_prateleira_registrar();$cron$
);

-- ── 6. Linha de base: a leitura de HOJE nasce com a migration (idempotente) ─────────────────
SELECT * FROM public.reposicao_ruptura_prateleira_registrar();

-- ── 7. Postcondição ─────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_t    text;
  v_user text;
  v_sched text;
  v_ativo boolean;
  v_cmd  text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['reposicao_ruptura_pedido_itens', 'reposicao_ruptura_prateleira_diaria'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v_t AND c.relkind = 'r' AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'P1 FALHOU: tabela % ausente ou sem RLS', v_t;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || v_t, 'INSERT') THEN
      RAISE EXCEPTION 'P2 FALHOU: % com anon lendo ou escrita aberta a authenticated/service_role', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['v_reposicao_ruptura_pedidos_semana', 'v_reposicao_ruptura_prateleira_semana'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v_t AND c.relkind = 'v'
                     AND ('security_invoker=on' = ANY(coalesce(c.reloptions, '{}'))
                          OR 'security_invoker=true' = ANY(coalesce(c.reloptions, '{}')))) THEN
      RAISE EXCEPTION 'P3 FALHOU: view % ausente ou sem security_invoker', v_t;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'P4 FALHOU: anon le %', v_t;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                 WHERE c.relname = 'order_items' AND t.tgname = 'trg_reposicao_ruptura_registrar_item' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'P5 FALHOU: trigger trg_reposicao_ruptura_registrar_item ausente em order_items';
  END IF;
  IF has_function_privilege('anon', 'public.reposicao_ruptura_prateleira_registrar(date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reposicao_ruptura_prateleira_registrar(date)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.reposicao_ruptura_prateleira_registrar(date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: reposicao_ruptura_prateleira_registrar executavel fora do owner';
  END IF;
  IF has_function_privilege('anon', 'public._reposicao_ruptura_saldo_oben(bigint, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._reposicao_ruptura_saldo_oben(bigint, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: _reposicao_ruptura_saldo_oben executavel fora do owner';
  END IF;
  SELECT username, schedule, active, command INTO v_user, v_sched, v_ativo, v_cmd
    FROM cron.job WHERE jobname = 'reposicao-ruptura-prateleira-diario';
  IF v_sched IS DISTINCT FROM '10 10 * * *' OR v_ativo IS NOT TRUE
     OR position('reposicao_ruptura_prateleira_registrar()' IN coalesce(v_cmd, '')) = 0 THEN
    RAISE EXCEPTION 'P7 FALHOU: cron reposicao-ruptura-prateleira-diario ausente/inativo/sem a funcao (schedule=%)', v_sched;
  END IF;
  IF v_user IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'P8 FALHOU: cron com dono % (esperado postgres)', v_user;
  END IF;
  RAISE NOTICE 'REPOSICAO-RUPTURA-SENSOR-OK';
END
$post$;
