-- O dia de SÃO PAULO no DEFAULT de route_visits.visit_date (classe ii do fuso, fase 3 — visitas).
--
-- A prod roda sessão UTC: das 21:00 às 23:59 BRT o dia da sessão já é o seguinte. Os 3 escritores de
-- route_visits (o check-in do planner, 2 caminhos em useRoutePlanner, e o de useVisitasAgendadas)
-- OMITEM visit_date: todo check-in nasce com o DEFAULT. Um check-in às 22h nascia com a data de AMANHÃ:
--   · o trigger reconcile_visita_agendada (scheduled_date <= NEW.visit_date) dava baixa na visita AGENDADA
--     para amanhã, que sumia da agenda antes de acontecer;
--   · _carteira_positivacao_for_owner e o edge carteira-positivacao-snapshot leem o MÊS de SP: o check-in
--     da noite do último dia do mês contava no mês seguinte.
-- Por que só agora: a fase 2 (20260930230623) adiou de propósito — os leitores eram MISTOS (o planner e
-- os KPIs de 30 dias liam o hoje UTC; o MTD e a positivação, o de SP), e trocar o DEFAULT sozinho movia
-- a divergência de lugar. Esta migration vai com o TypeScript da fase visitas (o planner, hojeISO, os
-- KPIs e os follow-ups passam a ler o dia de SP): a família inteira fala o mesmo dia.
-- Medido na prod (psql-ro, 2026-10-01): route_visits e visitas_agendadas têm 0 linhas — nenhuma linha a
-- corrigir; o conserto chega antes do primeiro uso.
--
-- Conserto: o fuso ESCRITO, ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date — o texto que o
-- Postgres devolve no pg_get_expr, o mesmo dos 6 DEFAULTs da fase 2. Metadado só: nenhuma linha muda.
--
-- Trava: ACCESS EXCLUSIVE já na entrada — é o lock que o ALTER COLUMN … SET DEFAULT toma (medido no
-- PG17: AccessExclusiveLock). Travar mais fraco e subir no ALTER seria upgrade de lock dentro da
-- transação (a lição da pedido_compra_sugerido na 20261001023000). Uma tabela só: não há ordem de
-- leitores a seguir. O executor tem lock_timeout de 15s; a tabela tem 0 linhas.
--
-- PRE: o DEFAULT vivo é o antigo (o dia da sessão) ou já este (re-aplicar é seguro); outro aborta.
-- POS: o DEFAULT instalado é o desta migration.
--
-- Prova: db/test-hoje-sp-visitas.sh (PG17 com o schema-snapshot da prod; relógio controlado cruzando
-- 21:00 BRT sob TimeZone=UTC e America/Sao_Paulo; o trigger reconcile_visita_agendada ponta a ponta) e
-- o mesmo script com --falsificar. Aplicação: bun run db:aplicar — a transação é do executor, por isso
-- não há BEGIN/COMMIT aqui. Reverter depois do commit = migration compensatória nova.


DO $trava$
BEGIN
  IF to_regclass('public.route_visits') IS NOT NULL THEN
    LOCK TABLE public.route_visits IN ACCESS EXCLUSIVE MODE;
  END IF;
END
$trava$;

DO $pre$
DECLARE
  v_vivo text;
BEGIN
  IF to_regclass('public.route_visits') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.route_visits não existe';
  END IF;
  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_vivo
    FROM pg_catalog.pg_attrdef d
    JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.route_visits'::regclass AND a.attname = 'visit_date';
  IF v_vivo IS DISTINCT FROM 'CURRENT' || '_DATE'
     AND v_vivo IS DISTINCT FROM '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date' THEN
    RAISE EXCEPTION 'PRE FALHOU: o DEFAULT de route_visits.visit_date vivo (%) não é o antigo nem o desta migration — reconcilie antes de aplicar', v_vivo;
  END IF;
END
$pre$;

ALTER TABLE public.route_visits ALTER COLUMN visit_date SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;

DO $post$
BEGIN
  IF (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        FROM pg_catalog.pg_attrdef d
        JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.route_visits'::regclass AND a.attname = 'visit_date')
     IS DISTINCT FROM '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date' THEN
    RAISE EXCEPTION 'POS1 FALHOU: o DEFAULT de route_visits.visit_date não é o desta migration';
  END IF;
END
$post$;
