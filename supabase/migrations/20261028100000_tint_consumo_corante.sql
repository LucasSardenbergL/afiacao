-- ============================================================
-- Giro de corante WP — Fase 1: consumo dosado por corante, cobertura derivada e plano de extração
--
-- POR QUÊ: o motor de compra pede os WP pela retirada do Omie, que mede LATA saindo, não corante
-- dosado. A Dnaxis registra cada dosagem (`vendas_item` do SayerSystem); esta migration recebe essas
-- preparações, converge o fato por corante e diz, com prova, QUAIS dias estão cobertos. Advisory:
-- nada aqui escreve em `sku_parametros` nem toca `gerar_pedidos_sugeridos_ciclo`.
--
-- Spec:  docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md
-- Plano: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md (Tasks 1 e 2; correções 1–11)
-- Prova: db/test-tint-consumo-corante.sh (PG17, controle + --falsificar, C e pt_BR.UTF-8)
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261028100000_tint_consumo_corante.sql`
-- (o executor fornece a transação; por isso o arquivo NÃO leva BEGIN/COMMIT). Idempotente: re-aplicar
-- é no-op (prova C6), inclusive o seed, que não pisa em capacidade já gravada.
-- ============================================================

-- ── 1. Constantes da política (a ÚNICA fonte; o conector não tem constante de política) ─────────
CREATE OR REPLACE FUNCTION public.tint_corante_constantes()
RETURNS TABLE (validade_dias int, lata_ml numeric, lata_l numeric, horizonte_dias int, frescor_dias int,
               cobertura_min_dias int, cobertura_plena_dias int, limite_ausencia numeric,
               regime_janela_dias int, regime_fator numeric, piso_dias int, janela_max_dias int,
               janela_inicial_dias int, lotes_alvo int, max_lotes_extracao int,
               revisita_recente_janela_dias int, revisita_recente_dias int, revisita_antiga_dias int,
               fila_max_pendentes int, plano_validade interval, compactacao_idade interval,
               relogio_tolerancia interval)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT 365, 810::numeric, 0.81::numeric, 180, 4,
         60, 180, 0.01::numeric,
         60, 2::numeric, 400, 35,
         7, 10, 20,
         35, 7, 30,
         6, interval '30 minutes', interval '2 days',
         interval '10 minutes'
$fn$;

-- ── 2. Capacidade do canister por corante (NULL = desconhecida; confirmada = o founder conferiu) ─
ALTER TABLE public.tint_corantes ADD COLUMN IF NOT EXISTS capacidade_canister_ml numeric NULL;
ALTER TABLE public.tint_corantes ADD COLUMN IF NOT EXISTS capacidade_confirmada boolean NOT NULL DEFAULT false;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_corantes_capacidade_canister_faixa') THEN
    ALTER TABLE public.tint_corantes ADD CONSTRAINT tint_corantes_capacidade_canister_faixa
      CHECK (capacidade_canister_ml IS NULL
             OR (capacidade_canister_ml > 0 AND capacidade_canister_ml < 'Infinity'));
  END IF;
  -- Confirmar exige saber a capacidade: least(810, NULL) = 810 liberaria a faixa com um canister desconhecido.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_corantes_capacidade_confirmada_conhecida') THEN
    ALTER TABLE public.tint_corantes ADD CONSTRAINT tint_corantes_capacidade_confirmada_conhecida
      CHECK (NOT capacidade_confirmada OR capacidade_canister_ml IS NOT NULL);
  END IF;
END
$c$;
-- 2.300 ml nos 14 WP (os corantes com produto Omie), NÃO confirmada: um canister mostrou
-- CanCapacity=400 no Color Link e o Lucas confere antes de liberar a recomendação.
UPDATE public.tint_corantes
   SET capacidade_canister_ml = 2300
 WHERE account = 'oben' AND omie_product_id IS NOT NULL
   AND capacidade_canister_ml IS NULL;  -- seed não pisa em capacidade já gravada

-- ── 3. Staging de preparações: sem cliente (LGPD), id bruto + código do corante, manifesto ───────
ALTER TABLE public.tint_staging_preparacoes ADD COLUMN IF NOT EXISTS rejeicao_motivo text NULL;
ALTER TABLE public.tint_staging_preparacao_itens ADD COLUMN IF NOT EXISTS codigo_corante text NULL;
ALTER TABLE public.tint_staging_preparacao_itens ADD COLUMN IF NOT EXISTS peso_especifico numeric NULL;
DO $c$
BEGIN
  -- Prod tem 0 linhas de staging de preparações (psql-ro, 2026-10-27): o CHECK valida na hora.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_staging_preparacoes_sem_cliente') THEN
    ALTER TABLE public.tint_staging_preparacoes ADD CONSTRAINT tint_staging_preparacoes_sem_cliente
      CHECK (cliente IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_staging_preparacoes_raw_sem_cliente') THEN
    ALTER TABLE public.tint_staging_preparacoes ADD CONSTRAINT tint_staging_preparacoes_raw_sem_cliente
      CHECK (raw_data IS NULL OR NOT (raw_data ? 'cliente'));
  END IF;
END
$c$;

CREATE TABLE IF NOT EXISTS public.tint_staging_preparacao_manifestos (
  sync_run_id     uuid PRIMARY KEY REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE,
  account         text NOT NULL,
  store_code      text NOT NULL,
  extracao_id     uuid NOT NULL,
  lote            int NOT NULL,
  total_lotes     int NOT NULL,
  modo            text NOT NULL CHECK (modo IN ('backfill', 'incremental', 'rescan', 'cura')),
  janela_desde    timestamptz NOT NULL,
  janela_ate      timestamptz NOT NULL,
  consultado_em   timestamptz NOT NULL,
  n_preparacoes   int NOT NULL CHECK (n_preparacoes >= 0),
  n_rejeitadas    int NOT NULL CHECK (n_rejeitadas >= 0),
  n_itens         int NOT NULL CHECK (n_itens >= 0),
  -- Faixa de ids do lote (ordem de bytes = a do Go): lotes da mesma extração não se sobrepõem.
  primeira_preparacao_id text NULL,
  ultima_preparacao_id   text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tint_staging_prep_manifesto_lote CHECK (1 <= lote AND lote <= total_lotes),
  CONSTRAINT tint_staging_prep_manifesto_faixa CHECK (
    (primeira_preparacao_id IS NULL) = (ultima_preparacao_id IS NULL)
    AND (primeira_preparacao_id IS NULL OR primeira_preparacao_id COLLATE "C" <= ultima_preparacao_id COLLATE "C")),
  CONSTRAINT tint_staging_prep_manifesto_janela CHECK (janela_desde < janela_ate),
  CONSTRAINT tint_staging_prep_manifesto_consulta CHECK (janela_ate <= consultado_em)
);

-- ── 4. O fato: cabeçalho por preparação (a versão sobrevive aos itens) + item por corante ─────────
-- Sem FK para tint_sync_runs: a poda de runs não pode apagar fato.
CREATE TABLE IF NOT EXISTS public.tint_consumo_preparacao (
  account          text NOT NULL,
  store_code       text NOT NULL,
  preparacao_id    text NOT NULL,
  data_dosagem     timestamptz NOT NULL,
  situacao         text NOT NULL CHECK (situacao IN ('valida', 'rejeitada')),
  motivo_rejeicao  text NULL,
  versao_fonte_em  timestamptz NOT NULL,
  run_criado_em    timestamptz NOT NULL,
  sync_run_id      uuid NOT NULL,
  PRIMARY KEY (account, store_code, preparacao_id),
  CONSTRAINT tint_consumo_preparacao_motivo CHECK ((situacao = 'rejeitada') = (motivo_rejeicao IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tint_consumo_preparacao_dosagem
  ON public.tint_consumo_preparacao (account, store_code, data_dosagem);

CREATE TABLE IF NOT EXISTS public.tint_consumo_corante (
  account                text NOT NULL,
  store_code             text NOT NULL,
  preparacao_id          text NOT NULL,
  ordem                  int NOT NULL CHECK (ordem BETWEEN 1 AND 6),
  id_corante_origem      text NOT NULL,
  codigo_corante_origem  text NULL,
  tint_corante_id        uuid NULL REFERENCES public.tint_corantes(id),
  -- Teto FÍSICO e permanente (correção 6): uma preparação não dosa mais que a maior embalagem (BH 18 L).
  qtd_ml                 numeric NOT NULL
                         CONSTRAINT tint_consumo_corante_qtd_faixa
                         CHECK (qtd_ml > 0 AND qtd_ml <= 18000 AND qtd_ml <> 'NaN'),
  peso_especifico        numeric NULL,
  data_dosagem           timestamptz NOT NULL,
  sync_run_id            uuid NOT NULL,
  run_criado_em          timestamptz NOT NULL,
  PRIMARY KEY (account, store_code, preparacao_id, ordem),
  FOREIGN KEY (account, store_code, preparacao_id)
    REFERENCES public.tint_consumo_preparacao (account, store_code, preparacao_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tint_consumo_corante_giro
  ON public.tint_consumo_corante (account, tint_corante_id, data_dosagem);

-- ── 5. Planos (o SERVIDOR emite o extracao_id), extrações (metadados IMUTÁVEIS) e lotes ──────────
-- A cobertura é DERIVADA das extrações completas (tint_consumo_cobertura_em). Compactar um plano
-- apaga a extração e os lotes em cascata.
CREATE TABLE IF NOT EXISTS public.tint_consumo_planos (
  extracao_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account       text NOT NULL,
  store_code    text NOT NULL,
  modo          text NOT NULL CHECK (modo IN ('backfill', 'incremental', 'rescan', 'cura')),
  janela_desde  timestamptz NOT NULL,
  janela_ate    timestamptz NOT NULL,
  criado_em     timestamptz NOT NULL,
  expira_em     timestamptz NOT NULL,
  CONSTRAINT tint_consumo_planos_janela CHECK (janela_desde < janela_ate)
);
CREATE INDEX IF NOT EXISTS idx_tint_consumo_planos_loja
  ON public.tint_consumo_planos (account, store_code, expira_em);

CREATE TABLE IF NOT EXISTS public.tint_consumo_extracoes (
  extracao_id    uuid PRIMARY KEY REFERENCES public.tint_consumo_planos(extracao_id) ON DELETE CASCADE,
  account        text NOT NULL,
  store_code     text NOT NULL,
  modo           text NOT NULL CHECK (modo IN ('backfill', 'incremental', 'rescan', 'cura')),
  janela_desde   timestamptz NOT NULL,
  janela_ate     timestamptz NOT NULL,
  consultado_em  timestamptz NOT NULL,
  total_lotes    int NOT NULL CHECK (total_lotes >= 1),
  criada_em      timestamptz NOT NULL,
  completa_em    timestamptz NULL,
  CONSTRAINT tint_consumo_extracoes_janela CHECK (janela_desde < janela_ate AND janela_ate <= consultado_em)
);
CREATE INDEX IF NOT EXISTS idx_tint_consumo_extracoes_completas
  ON public.tint_consumo_extracoes (account, store_code, janela_ate) WHERE completa_em IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tint_consumo_extracao_lotes (
  extracao_id    uuid NOT NULL REFERENCES public.tint_consumo_extracoes(extracao_id) ON DELETE CASCADE,
  lote           int NOT NULL CHECK (lote >= 1),
  sync_run_id    uuid NOT NULL UNIQUE,
  n_preparacoes  int NOT NULL,
  n_rejeitadas   int NOT NULL,
  n_itens        int NOT NULL,
  primeira_preparacao_id text NULL,
  ultima_preparacao_id   text NULL,
  promovido_em   timestamptz NOT NULL,
  PRIMARY KEY (extracao_id, lote),
  CONSTRAINT tint_consumo_extracao_lotes_faixa CHECK (
    (primeira_preparacao_id IS NULL) = (ultima_preparacao_id IS NULL)
    AND (primeira_preparacao_id IS NULL OR primeira_preparacao_id COLLATE "C" <= ultima_preparacao_id COLLATE "C"))
);

-- Recibo DURÁVEL de run aplicado (sem FK): a compactação apaga plano/extração/lotes, e um run reenfileirado
-- depois disso ainda tem de ser reconhecido como `ja_aplicado` (o staging dele já foi podado).
CREATE TABLE IF NOT EXISTS public.tint_consumo_runs_aplicados (
  sync_run_id  uuid PRIMARY KEY,
  extracao_id  uuid NOT NULL,
  lote         int NOT NULL,
  aplicado_em  timestamptz NOT NULL
);

-- ── 6. RLS + ACL: staff lê; só a promoção (SECURITY DEFINER) escreve o fato ─────────────────────
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_planos', 'tint_consumo_extracoes',
                           'tint_consumo_extracao_lotes', 'tint_consumo_runs_aplicados',
                           'tint_staging_preparacao_manifestos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                                              AND policyname = t || '_staff_le') THEN
      EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
        USING (public.has_role(auth.uid(), 'master'::public.app_role)
               OR public.has_role(auth.uid(), 'employee'::public.app_role))$p$, t || '_staff_le', t);
    END IF;
  END LOOP;
END
$rls$;

REVOKE ALL ON public.tint_consumo_preparacao, public.tint_consumo_corante, public.tint_consumo_planos,
              public.tint_consumo_extracoes, public.tint_consumo_extracao_lotes, public.tint_consumo_runs_aplicados
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tint_consumo_preparacao, public.tint_consumo_corante, public.tint_consumo_planos,
                public.tint_consumo_extracoes, public.tint_consumo_extracao_lotes, public.tint_consumo_runs_aplicados
  TO authenticated, service_role;
REVOKE ALL ON public.tint_staging_preparacao_manifestos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tint_staging_preparacao_manifestos TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.tint_staging_preparacao_manifestos TO service_role;

-- ── PÓS (Task 1) ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_t text;
  v_r text;
  v_p text;
BEGIN
  IF to_regprocedure('public.tint_corante_constantes()') IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: tint_corante_constantes ausente';
  END IF;
  FOREACH v_t IN ARRAY ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_planos',
                             'tint_consumo_extracoes', 'tint_consumo_extracao_lotes',
                             'tint_staging_preparacao_manifestos'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: tabela % ausente', v_t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || v_t)) THEN
      RAISE EXCEPTION 'POS FALHOU: RLS desligada em %', v_t;
    END IF;
  END LOOP;
  FOREACH v_t IN ARRAY ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_planos',
                             'tint_consumo_extracoes', 'tint_consumo_extracao_lotes',
                             'tint_consumo_runs_aplicados'] LOOP
    FOREACH v_r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      FOREACH v_p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(v_r, 'public.' || v_t, v_p) THEN
          RAISE EXCEPTION 'POS FALHOU: % tem % em %', v_r, v_p, v_t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_consumo_corante_qtd_faixa')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_staging_preparacoes_sem_cliente')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_staging_preparacoes_raw_sem_cliente')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_corantes_capacidade_canister_faixa') THEN
    RAISE EXCEPTION 'POS FALHOU: constraint da Task 1 ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tint_corantes
              WHERE account = 'oben' AND omie_product_id IS NOT NULL AND capacidade_canister_ml IS NULL) THEN
    RAISE EXCEPTION 'POS FALHOU: WP sem capacidade semeada';
  END IF;
END
$post$;


-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Task 2 — cobertura derivada, plano de extração, promoção, consumidor próprio, compactação
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 7. Cobertura DERIVADA (correção 9): a ilha mais recente da união das extrações completas ────
-- Dia coberto = dia SP INTEIRO dentro da ilha e >= o dia da 1ª dosagem promovida e >= o piso.
-- União por MÁXIMO ACUMULADO do `ate` (aninhados e encostados fundem; LAG(ate) não serve).
CREATE OR REPLACE FUNCTION public.tint_consumo_cobertura_em(p_agora timestamptz)
RETURNS TABLE (account text, store_code text, primeira_dosagem_dia date, ilha_desde timestamptz,
               ilha_ate timestamptz, primeiro_dia_coberto date, ultimo_dia_coberto date,
               lacuna_desde timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH base AS (
    SELECT ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - k.piso_dias) AS piso_dia,
           (((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - k.piso_dias)::timestamp
              AT TIME ZONE 'America/Sao_Paulo') AS piso
      FROM public.tint_corante_constantes() k
  ), ext AS (
    SELECT e.account, e.store_code, e.janela_desde AS d, e.janela_ate AS a
      FROM public.tint_consumo_extracoes e, base
     WHERE e.completa_em IS NOT NULL AND e.janela_ate > base.piso
  ), marc AS (
    SELECT x.*,
           CASE WHEN max(x.a) OVER (PARTITION BY x.account, x.store_code ORDER BY x.d, x.a
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) >= x.d
                THEN 0 ELSE 1 END AS nova
      FROM ext x
  ), grp AS (
    SELECT m.*, sum(m.nova) OVER (PARTITION BY m.account, m.store_code ORDER BY m.d, m.a
                                  ROWS UNBOUNDED PRECEDING) AS g
      FROM marc m
  ), ilhas AS (
    SELECT g.account, g.store_code, g.g, min(g.d) AS d, max(g.a) AS a
      FROM grp g GROUP BY g.account, g.store_code, g.g
  ), recente AS (
    SELECT DISTINCT ON (i.account, i.store_code) i.account, i.store_code, i.d, i.a
      FROM ilhas i ORDER BY i.account, i.store_code, i.a DESC
  ), primeira_ilha AS (
    SELECT DISTINCT ON (i.account, i.store_code) i.account, i.store_code, i.d, i.a
      FROM ilhas i ORDER BY i.account, i.store_code, i.d
  ), primeira AS (
    SELECT p.account, p.store_code, (min(p.data_dosagem) AT TIME ZONE 'America/Sao_Paulo')::date AS dia
      FROM public.tint_consumo_preparacao p GROUP BY p.account, p.store_code
  ), dias AS (
    SELECT r.account, r.store_code, pr.dia AS primeira_dia, r.d, r.a,
           greatest(CASE WHEN (r.d AT TIME ZONE 'America/Sao_Paulo')::time = time '00:00'
                         THEN (r.d AT TIME ZONE 'America/Sao_Paulo')::date
                         ELSE (r.d AT TIME ZONE 'America/Sao_Paulo')::date + 1 END,
                    pr.dia, base.piso_dia) AS pd,
           (r.a AT TIME ZONE 'America/Sao_Paulo')::date - 1 AS ud,
           CASE WHEN pi.d > base.piso THEN base.piso ELSE pi.a END AS buraco
      FROM recente r
      CROSS JOIN base
      JOIN primeira_ilha pi ON pi.account = r.account AND pi.store_code = r.store_code
      LEFT JOIN primeira pr ON pr.account = r.account AND pr.store_code = r.store_code
  )
  SELECT d.account, d.store_code, d.primeira_dia, d.d, d.a,
         CASE WHEN d.primeira_dia IS NULL OR d.pd > d.ud THEN NULL ELSE d.pd END,
         CASE WHEN d.primeira_dia IS NULL OR d.pd > d.ud THEN NULL ELSE d.ud END,
         CASE WHEN d.buraco < d.d THEN d.buraco END
    FROM dias d
$fn$;

-- ── 8. Plano de extração (o SERVIDOR decide as janelas e emite o extracao_id) ─────────────────
CREATE OR REPLACE FUNCTION public.tint_consumo_plano_extracao(p_account text, p_store_code text,
                                                              p_agora timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  k        record;
  c        record;
  v_hoje   date := (p_agora AT TIME ZONE 'America/Sao_Paulo')::date;
  v_mhoje  timestamptz := (p_agora AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo';
  v_piso   timestamptz;
  v_dens   bigint;
  v_w      int;
  v_dia    date;
  v_d      timestamptz;
  v_a      timestamptz;
  v_modo   text;
  v_id     uuid;
  v_jan    jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO k FROM public.tint_corante_constantes();
  v_piso := (v_hoje - k.piso_dias)::timestamp AT TIME ZONE 'America/Sao_Paulo';
  -- Dois planos simultâneos da mesma loja não emitem a mesma janela.
  PERFORM pg_advisory_xact_lock(hashtext('tint_consumo_plano:' || p_account || ':' || p_store_code));

  -- Admissão: uma extração em voo por loja.
  IF EXISTS (SELECT 1 FROM public.tint_consumo_planos pl
              WHERE pl.account = p_account AND pl.store_code = p_store_code AND pl.expira_em > p_agora
                AND NOT EXISTS (SELECT 1 FROM public.tint_consumo_extracoes e
                                 WHERE e.extracao_id = pl.extracao_id AND e.completa_em IS NOT NULL)) THEN
    RETURN jsonb_build_object('ok', true, 'janelas', '[]'::jsonb, 'max_lotes', k.max_lotes_extracao,
                              'motivo', 'em_andamento');
  END IF;
  IF (SELECT count(*) FROM public.tint_sync_runs sr
       WHERE sr.account = p_account AND sr.store_code = p_store_code
         AND sr.sync_type = 'preparations' AND sr.promocao_status = 'pendente') >= k.fila_max_pendentes THEN
    RETURN jsonb_build_object('ok', true, 'janelas', '[]'::jsonb, 'max_lotes', k.max_lotes_extracao,
                              'motivo', 'fila_cheia');
  END IF;

  -- Tamanho da janela pela densidade (maior nº de preparações num dia SP).
  SELECT max(n) INTO v_dens
    FROM (SELECT count(*) AS n FROM public.tint_consumo_preparacao p
           WHERE p.account = p_account AND p.store_code = p_store_code AND p.data_dosagem >= v_piso
           GROUP BY (p.data_dosagem AT TIME ZONE 'America/Sao_Paulo')::date) s;
  v_w := CASE WHEN v_dens IS NULL THEN k.janela_inicial_dias
              ELSE least(k.janela_max_dias, greatest(1, floor(k.lotes_alvo * 1000.0 / v_dens)::int)) END;

  SELECT * INTO c FROM public.tint_consumo_cobertura_em(p_agora) cb
   WHERE cb.account = p_account AND cb.store_code = p_store_code;

  -- 1ª janela: a frente.
  IF c.ilha_ate IS NULL THEN
    v_d := v_piso; v_modo := 'backfill';
  ELSE
    v_d := (c.ilha_ate AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo';
    v_modo := 'incremental';
  END IF;
  v_a := least(((v_d AT TIME ZONE 'America/Sao_Paulo')::date + v_w)::timestamp AT TIME ZONE 'America/Sao_Paulo', p_agora);
  IF v_d < v_a THEN
    INSERT INTO public.tint_consumo_planos (account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
    VALUES (p_account, p_store_code, v_modo, v_d, v_a, p_agora, p_agora + k.plano_validade)
    RETURNING extracao_id INTO v_id;
    v_jan := v_jan || jsonb_build_object('extracao_id', v_id, 'modo', v_modo, 'desde', v_d, 'ate', v_a);
  END IF;

  -- 2ª janela: cura do buraco mais antigo; sem buraco, a revisita do dia mais atrasado.
  v_d := NULL;
  IF c.lacuna_desde IS NOT NULL THEN
    v_d := (c.lacuna_desde AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo';
    v_a := least(((v_d AT TIME ZONE 'America/Sao_Paulo')::date + v_w)::timestamp AT TIME ZONE 'America/Sao_Paulo', p_agora);
    v_modo := 'cura';
  ELSIF c.primeiro_dia_coberto IS NOT NULL THEN
    SELECT s.dia INTO v_dia
      FROM (SELECT g.dia::date AS dia,
                   (SELECT max(e.consultado_em) FROM public.tint_consumo_extracoes e
                     WHERE e.account = p_account AND e.store_code = p_store_code AND e.completa_em IS NOT NULL
                       AND e.janela_desde <= (g.dia::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
                       AND e.janela_ate >= ((g.dia::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')) AS ult
              FROM generate_series(c.primeiro_dia_coberto::timestamp, c.ultimo_dia_coberto::timestamp,
                                   interval '1 day') g(dia)) s
     WHERE s.ult IS NULL
        OR s.ult < p_agora - make_interval(days => CASE WHEN s.dia >= v_hoje - k.revisita_recente_janela_dias
                                                        THEN k.revisita_recente_dias
                                                        ELSE k.revisita_antiga_dias END)
     ORDER BY (p_agora - make_interval(days => CASE WHEN s.dia >= v_hoje - k.revisita_recente_janela_dias
                                                    THEN k.revisita_recente_dias
                                                    ELSE k.revisita_antiga_dias END))
              - COALESCE(s.ult, '-infinity'::timestamptz) DESC,
              s.dia
     LIMIT 1;
    IF v_dia IS NOT NULL THEN
      v_d := v_dia::timestamp AT TIME ZONE 'America/Sao_Paulo';
      v_a := least((v_dia + v_w)::timestamp AT TIME ZONE 'America/Sao_Paulo', v_mhoje);
      v_modo := 'rescan';
    END IF;
  END IF;
  IF v_d IS NOT NULL AND v_d < v_a THEN
    INSERT INTO public.tint_consumo_planos (account, store_code, modo, janela_desde, janela_ate, criado_em, expira_em)
    VALUES (p_account, p_store_code, v_modo, v_d, v_a, p_agora, p_agora + k.plano_validade)
    RETURNING extracao_id INTO v_id;
    v_jan := v_jan || jsonb_build_object('extracao_id', v_id, 'modo', v_modo, 'desde', v_d, 'ate', v_a);
  END IF;

  RETURN jsonb_build_object('ok', true, 'janelas', v_jan, 'max_lotes', k.max_lotes_extracao, 'motivo', NULL);
END
$fn$;

-- ── 9. Promoção de UM lote (run `preparations`) ─────────────────────────────────────────────
-- Toda recusa (ok:false) sai ANTES da 1ª escrita: o tick não desfaz um retorno normal.
CREATE OR REPLACE FUNCTION public.tint_promote_preparacoes(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  k          record;
  r          record;
  m          record;
  pl         record;
  ex         record;
  v_np       int;
  v_nr       int;
  v_nd       int;
  v_ni       int;
  v_min      text;
  v_max      text;
  v_fora     boolean;
  v_ids      text[];
  v_itens    int;
  v_sem      int;
  v_lotes    int;
  v_completa boolean := false;
  v_falha    text;
BEGIN
  SELECT * INTO k FROM public.tint_corante_constantes();
  SELECT sr.id, sr.account, sr.store_code, sr.sync_type, sr.started_at INTO r
    FROM public.tint_sync_runs sr WHERE sr.id = p_run_id;
  IF r.id IS NULL OR r.sync_type IS DISTINCT FROM 'preparations' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'tipo_errado');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tint_consumo_runs_aplicados ra WHERE ra.sync_run_id = p_run_id) THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'ja_aplicado');
  END IF;
  SELECT * INTO m FROM public.tint_staging_preparacao_manifestos sm WHERE sm.sync_run_id = p_run_id;
  IF m.sync_run_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'sem_manifesto');
  END IF;

  -- Identidade: a extração foi emitida pelo plano desta loja, com esta janela.
  SELECT * INTO pl FROM public.tint_consumo_planos p WHERE p.extracao_id = m.extracao_id;
  IF pl.extracao_id IS NULL OR pl.account <> r.account OR pl.store_code <> r.store_code
     OR m.account <> r.account OR m.store_code <> r.store_code
     OR pl.modo <> m.modo OR pl.janela_desde <> m.janela_desde OR m.janela_ate > pl.janela_ate THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'extracao_nao_planejada');
  END IF;

  -- Coerência do lote.
  SELECT count(*) FILTER (WHERE s.rejeicao_motivo IS NULL), count(*) FILTER (WHERE s.rejeicao_motivo IS NOT NULL),
         count(DISTINCT s.preparacao_id), min(s.preparacao_id COLLATE "C"), max(s.preparacao_id COLLATE "C"),
         bool_or(s.data_preparacao IS NULL OR s.data_preparacao < m.janela_desde OR s.data_preparacao >= m.janela_ate)
    INTO v_np, v_nr, v_nd, v_min, v_max, v_fora
    FROM public.tint_staging_preparacoes s WHERE s.sync_run_id = p_run_id;
  SELECT count(*) INTO v_ni FROM public.tint_staging_preparacao_itens i WHERE i.sync_run_id = p_run_id;
  v_falha := CASE
    WHEN v_np <> m.n_preparacoes OR v_nr <> m.n_rejeitadas OR v_ni <> m.n_itens THEN 'contagem_divergente'
    WHEN v_nd <> v_np + v_nr THEN 'preparacao_duplicada'
    WHEN v_min IS DISTINCT FROM m.primeira_preparacao_id OR v_max IS DISTINCT FROM m.ultima_preparacao_id
      THEN 'preparacao_fora_da_faixa_do_lote'
    WHEN v_fora THEN 'dosagem_fora_da_janela'
    WHEN m.consultado_em > r.started_at + k.relogio_tolerancia THEN 'relogio_origem_adiantado'
    WHEN m.total_lotes > k.max_lotes_extracao THEN 'extracao_grande'
    WHEN EXISTS (SELECT 1 FROM public.tint_staging_preparacao_itens i
                   LEFT JOIN public.tint_staging_preparacoes s
                          ON s.id = i.staging_preparacao_id AND s.sync_run_id = p_run_id
                  WHERE i.sync_run_id = p_run_id
                    AND (s.id IS NULL OR s.rejeicao_motivo IS NOT NULL OR i.ordem IS NULL
                         OR i.ordem NOT BETWEEN 1 AND 6 OR i.qtd_ml IS NULL OR i.qtd_ml = 'NaN'
                         OR NOT (i.qtd_ml > 0 AND i.qtd_ml <= 18000))) THEN 'item_invalido'
    WHEN EXISTS (SELECT 1 FROM public.tint_staging_preparacao_itens i WHERE i.sync_run_id = p_run_id
                  GROUP BY i.staging_preparacao_id, i.ordem HAVING count(*) > 1) THEN 'item_invalido'
  END;
  IF v_falha IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', v_falha);
  END IF;

  -- Coerência da extração (metadados imutáveis; lotes 1..N disjuntos).
  SELECT * INTO ex FROM public.tint_consumo_extracoes e WHERE e.extracao_id = m.extracao_id FOR UPDATE;
  IF ex.extracao_id IS NOT NULL THEN
    v_falha := CASE
      WHEN ex.janela_ate <> m.janela_ate OR ex.consultado_em <> m.consultado_em OR ex.total_lotes <> m.total_lotes
        THEN 'extracao_divergente'
      WHEN m.lote > ex.total_lotes THEN 'lote_fora_da_faixa'
      WHEN EXISTS (SELECT 1 FROM public.tint_consumo_extracao_lotes l
                    WHERE l.extracao_id = m.extracao_id AND l.lote = m.lote) THEN 'lote_duplicado'
      WHEN m.primeira_preparacao_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM public.tint_consumo_extracao_lotes l
              WHERE l.extracao_id = m.extracao_id AND l.primeira_preparacao_id IS NOT NULL
                AND l.primeira_preparacao_id COLLATE "C" <= m.ultima_preparacao_id COLLATE "C"
                AND m.primeira_preparacao_id COLLATE "C" <= l.ultima_preparacao_id COLLATE "C")
        THEN 'lotes_sobrepostos'
    END;
    IF v_falha IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'motivo', v_falha);
    END IF;
  ELSE
    INSERT INTO public.tint_consumo_extracoes (extracao_id, account, store_code, modo, janela_desde, janela_ate,
                                               consultado_em, total_lotes, criada_em)
    VALUES (m.extracao_id, r.account, r.store_code, m.modo, m.janela_desde, m.janela_ate,
            m.consultado_em, m.total_lotes, clock_timestamp());
  END IF;

  -- Versão = (started_at, id) do run: a ORDEM DE CHEGADA (correção 3). Só as mais novas aplicam.
  SELECT array_agg(s.preparacao_id) INTO v_ids
    FROM public.tint_staging_preparacoes s
    LEFT JOIN public.tint_consumo_preparacao h
           ON h.account = r.account AND h.store_code = r.store_code AND h.preparacao_id = s.preparacao_id
   WHERE s.sync_run_id = p_run_id
     AND (h.preparacao_id IS NULL OR (h.run_criado_em, h.sync_run_id) < (r.started_at, r.id));
  v_ids := COALESCE(v_ids, '{}'::text[]);

  INSERT INTO public.tint_consumo_preparacao AS h (account, store_code, preparacao_id, data_dosagem, situacao,
                                                   motivo_rejeicao, versao_fonte_em, run_criado_em, sync_run_id)
  SELECT r.account, r.store_code, s.preparacao_id, s.data_preparacao,
         CASE WHEN s.rejeicao_motivo IS NULL THEN 'valida' ELSE 'rejeitada' END,
         s.rejeicao_motivo, m.consultado_em, r.started_at, r.id
    FROM public.tint_staging_preparacoes s
   WHERE s.sync_run_id = p_run_id AND s.preparacao_id = ANY (v_ids)
  ON CONFLICT (account, store_code, preparacao_id) DO UPDATE
     SET data_dosagem = EXCLUDED.data_dosagem, situacao = EXCLUDED.situacao,
         motivo_rejeicao = EXCLUDED.motivo_rejeicao, versao_fonte_em = EXCLUDED.versao_fonte_em,
         run_criado_em = EXCLUDED.run_criado_em, sync_run_id = EXCLUDED.sync_run_id;

  -- Apaga TODOS os itens das preparações aplicadas e insere os do run (edição na origem converge).
  DELETE FROM public.tint_consumo_corante cc
   WHERE cc.account = r.account AND cc.store_code = r.store_code AND cc.preparacao_id = ANY (v_ids);
  INSERT INTO public.tint_consumo_corante (account, store_code, preparacao_id, ordem, id_corante_origem,
                                           codigo_corante_origem, tint_corante_id, qtd_ml, peso_especifico,
                                           data_dosagem, sync_run_id, run_criado_em)
  SELECT r.account, r.store_code, s.preparacao_id, i.ordem, i.id_corante, i.codigo_corante,
         (SELECT tc.id FROM public.tint_corantes tc
           WHERE tc.account = r.account AND tc.id_corante_sayersystem = i.id_corante),
         i.qtd_ml, i.peso_especifico, s.data_preparacao, r.id, r.started_at
    FROM public.tint_staging_preparacao_itens i
    JOIN public.tint_staging_preparacoes s ON s.id = i.staging_preparacao_id AND s.sync_run_id = p_run_id
   WHERE i.sync_run_id = p_run_id AND s.rejeicao_motivo IS NULL AND s.preparacao_id = ANY (v_ids);
  GET DIAGNOSTICS v_itens = ROW_COUNT;
  SELECT count(*) INTO v_sem FROM public.tint_consumo_corante cc
   WHERE cc.account = r.account AND cc.store_code = r.store_code AND cc.sync_run_id = r.id
     AND cc.tint_corante_id IS NULL;

  INSERT INTO public.tint_consumo_extracao_lotes (extracao_id, lote, sync_run_id, n_preparacoes, n_rejeitadas,
                                                  n_itens, primeira_preparacao_id, ultima_preparacao_id,
                                                  promovido_em)
  VALUES (m.extracao_id, m.lote, p_run_id, m.n_preparacoes, m.n_rejeitadas, m.n_itens,
          m.primeira_preparacao_id, m.ultima_preparacao_id, clock_timestamp());
  INSERT INTO public.tint_consumo_runs_aplicados (sync_run_id, extracao_id, lote, aplicado_em)
  VALUES (p_run_id, m.extracao_id, m.lote, clock_timestamp());
  SELECT count(*) INTO v_lotes FROM public.tint_consumo_extracao_lotes l WHERE l.extracao_id = m.extracao_id;
  IF v_lotes = m.total_lotes THEN
    UPDATE public.tint_consumo_extracoes e SET completa_em = clock_timestamp()
     WHERE e.extracao_id = m.extracao_id AND e.completa_em IS NULL;
    v_completa := true;
  END IF;

  -- Retenção por estado (correção 5): o staging do run sai na mesma transação.
  DELETE FROM public.tint_staging_preparacao_itens i WHERE i.sync_run_id = p_run_id;
  DELETE FROM public.tint_staging_preparacoes s WHERE s.sync_run_id = p_run_id;
  DELETE FROM public.tint_staging_preparacao_manifestos sm WHERE sm.sync_run_id = p_run_id;

  RETURN jsonb_build_object('ok', true, 'acao', 'aplicado',
                            'preparacoes_aplicadas', cardinality(v_ids),
                            'preparacoes_ignoradas_mais_antigas', v_np + v_nr - cardinality(v_ids),
                            'itens', v_itens, 'itens_sem_ponte', v_sem, 'rejeitadas', v_nr,
                            'extracao', CASE WHEN v_completa THEN 'completa' ELSE 'incompleta' END);
END
$fn$;

-- ── 10. Compactação (correção 12): extração contida noutra, consultada depois, não acrescenta ───
-- Ordem estrita (consultado_em, largura, id): duas extrações idênticas nunca se apagam mutuamente.
CREATE OR REPLACE FUNCTION public.tint_consumo_compactar(p_agora timestamptz)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  k    record;
  v_n  int;
  v_n2 int;
BEGIN
  SELECT * INTO k FROM public.tint_corante_constantes();
  DELETE FROM public.tint_consumo_planos pl
   USING public.tint_consumo_extracoes e
   WHERE e.extracao_id = pl.extracao_id
     AND e.completa_em IS NOT NULL AND e.consultado_em < p_agora - k.compactacao_idade
     AND EXISTS (SELECT 1 FROM public.tint_consumo_extracoes o
                  WHERE o.account = e.account AND o.store_code = e.store_code AND o.completa_em IS NOT NULL
                    AND o.extracao_id <> e.extracao_id
                    AND o.janela_desde <= e.janela_desde AND o.janela_ate >= e.janela_ate
                    AND (o.consultado_em, o.janela_ate - o.janela_desde, o.extracao_id)
                        > (e.consultado_em, e.janela_ate - e.janela_desde, e.extracao_id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- Plano expirado há mais que a idade, sem extração completa: não certifica nada.
  DELETE FROM public.tint_consumo_planos pl
   WHERE pl.expira_em < p_agora - k.compactacao_idade
     AND NOT EXISTS (SELECT 1 FROM public.tint_consumo_extracoes e
                      WHERE e.extracao_id = pl.extracao_id AND e.completa_em IS NOT NULL);
  GET DIAGNOSTICS v_n2 = ROW_COUNT;
  RETURN v_n + v_n2;
END
$fn$;

-- ── 11. Consumidor próprio das preparações (correção 10) ──────────────────────────────────────
-- Mesmas regras do ramo de runs do tint_promocao_tick (status complete exigido, 3 tentativas com
-- backoff, ok:false = erro direto), com lock e cron PRÓPRIOS: preparação lenta não segura catálogo.
CREATE OR REPLACE FUNCTION public.tint_preparacoes_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_max_tentativas constant int := 3;
  v_run_id     uuid;
  v_status_run text;
  v_tent       int;
  v_res        jsonb;
  v_ok         boolean;
  v_msg        text;
  v_state      text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_preparacoes_tick')) THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'pulado_tick_concorrente');
  END IF;

  WITH fila AS (
    SELECT sr.id, sr.account, sr.store_code, COALESCE(sr.completed_at, sr.started_at) AS enfileirado_em,
           sr.promocao_proxima_em AS proxima_em
      FROM tint_sync_runs sr
     WHERE sr.promocao_status = 'pendente' AND sr.sync_type = 'preparations'
  ), cabeca AS (
    SELECT DISTINCT ON (f.account, f.store_code) f.*
      FROM fila f ORDER BY f.account, f.store_code, f.enfileirado_em, f.id
  )
  SELECT c.id INTO v_run_id
    FROM cabeca c
   WHERE c.proxima_em IS NULL OR c.proxima_em <= clock_timestamp()
   ORDER BY c.enfileirado_em, c.id
   LIMIT 1;

  IF v_run_id IS NULL THEN
    PERFORM public.tint_consumo_compactar(clock_timestamp());
    RETURN jsonb_build_object('ok', true, 'acao', 'fila_vazia');
  END IF;

  UPDATE tint_sync_runs sr
     SET promocao_tentativas = sr.promocao_tentativas + 1
   WHERE sr.id = v_run_id AND sr.promocao_status = 'pendente'
  RETURNING sr.promocao_tentativas, sr.status INTO v_tent, v_status_run;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'corrida_item_mudou', 'run_id', v_run_id);
  END IF;

  IF v_status_run IS DISTINCT FROM 'complete' THEN
    UPDATE tint_sync_runs
       SET promocao_status = 'erro', promocao_proxima_em = NULL,
           promocao_erro = 'run com status ' || COALESCE(v_status_run, 'NULL') ||
                           ' (esperado complete): ingestão não confirmada — não promovido'
     WHERE id = v_run_id;
    RETURN jsonb_build_object('ok', false, 'acao', 'erro_status_run', 'run_id', v_run_id, 'status', v_status_run);
  END IF;

  BEGIN
    PERFORM set_config('lock_timeout', '60s', true);
    v_res := public.tint_promote_preparacoes(v_run_id);
    v_ok  := COALESCE((v_res ->> 'ok')::boolean, false);
  EXCEPTION WHEN query_canceled OR others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    v_ok := NULL;
  END;

  IF v_ok THEN
    UPDATE tint_sync_runs
       SET promocao_status = 'promovido', promovido_em = clock_timestamp(),
           promocao_erro = NULL, promocao_proxima_em = NULL
     WHERE id = v_run_id;
    RETURN jsonb_build_object('ok', true, 'acao', 'promovido', 'run_id', v_run_id,
                              'tentativa', v_tent, 'resultado', v_res);
  ELSIF v_ok IS FALSE THEN
    UPDATE tint_sync_runs
       SET promocao_status = 'erro', promocao_proxima_em = NULL,
           promocao_erro = left('RPC tint_promote_preparacoes ok=false: ' || v_res::text, 2000)
     WHERE id = v_run_id;
    INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
    VALUES (v_run_id, 'promotion', NULL, 'promoção recusada pelo RPC tint_promote_preparacoes (ok=false)',
            jsonb_build_object('resultado', v_res, 'origem', 'tint_preparacoes_tick'));
    RETURN jsonb_build_object('ok', false, 'acao', 'erro_rpc', 'run_id', v_run_id, 'resultado', v_res);
  ELSE
    UPDATE tint_sync_runs
       SET promocao_erro = left(v_state || ': ' || v_msg, 2000),
           promocao_status = CASE WHEN v_tent >= v_max_tentativas THEN 'erro' ELSE 'pendente' END,
           promocao_proxima_em = CASE WHEN v_tent >= v_max_tentativas THEN NULL
                                      ELSE clock_timestamp() + interval '1 minute' * power(2, v_tent - 1) END
     WHERE id = v_run_id;
    INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
    VALUES (v_run_id, 'promotion', NULL, v_msg,
            jsonb_build_object('sqlstate', v_state, 'tentativa', v_tent,
                               'max_tentativas', v_max_tentativas, 'origem', 'tint_preparacoes_tick'));
    RETURN jsonb_build_object('ok', false,
                              'acao', CASE WHEN v_tent >= v_max_tentativas THEN 'erro_esgotou' ELSE 'erro_retry' END,
                              'run_id', v_run_id, 'tentativa', v_tent, 'sqlstate', v_state, 'erro', v_msg);
  END IF;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_preparacoes(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_consumo_plano_extracao(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_consumo_compactar(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_preparacoes_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tint_consumo_plano_extracao(text, text, timestamptz) TO service_role;

-- ── 12. O tick atual só passa a EXCLUIR preparações (um predicado; ordem dos outros intacta) ─────
-- TRAVA: ALTER sem efeito prende a função até o fim da transação, antes de ler o corpo.
DO $trava$
BEGIN
  ALTER FUNCTION public.tint_promocao_tick() VOLATILE;
END
$trava$;

-- PRE de dois ramos: predecessor revisado → aplica o patch; já é o corpo novo → só confere; outro → ABORTA.
DO $tick$
DECLARE
  v_pred  constant text := 'd0e3beb394c932ad1979da5efc910943';
  v_novo  constant text := 'e5f375b0bff05600fe66f3f6d79d513c';
  v_ancora_velha constant text := E'     WHERE sr.promocao_status = \'pendente\'\n    UNION ALL';
  v_ancora_nova  constant text := E'     WHERE sr.promocao_status = \'pendente\'\n'
                                  || E'       AND sr.sync_type IS DISTINCT FROM \'preparations\'\n    UNION ALL';
  v_md5   text := (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.tint_promocao_tick()'::regprocedure);
  v_def   text;
BEGIN
  IF v_md5 = v_pred THEN
    v_def := pg_get_functiondef('public.tint_promocao_tick()'::regprocedure);
    IF (length(v_def) - length(replace(v_def, v_ancora_velha, ''))) / length(v_ancora_velha) <> 1 THEN
      RAISE EXCEPTION 'PRE FALHOU: âncora do tint_promocao_tick não aparece exatamente 1x';
    END IF;
    EXECUTE replace(v_def, v_ancora_velha, v_ancora_nova);
  ELSIF v_md5 = v_novo THEN
    NULL;  -- re-apply: o corpo já é este
  ELSE
    RAISE EXCEPTION 'PRE FALHOU: tint_promocao_tick vivo (md5 %) não é o predecessor revisado nem este — outra sessão mexeu no tick; reconcilie antes', v_md5;
  END IF;
END
$tick$;
-- O REPLACE preserva o ACL; reafirmar o fechamento (idempotente) não depende disso.
REVOKE EXECUTE ON FUNCTION public.tint_promocao_tick() FROM PUBLIC, anon, authenticated;

-- ── 13. Cron do consumidor (statement_timeout no COMANDO: o SET na função não vale pro statement) ─
SELECT cron.unschedule('tint-preparacoes-tick')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-preparacoes-tick');
SELECT cron.schedule(
  'tint-preparacoes-tick',
  '15 seconds',
  $cron$ SET statement_timeout = '2min'; SELECT public.tint_preparacoes_tick(); $cron$
);

-- ── PÓS (Task 2) ─────────────────────────────────────────────────────────────────────────────
DO $post2$
DECLARE
  v_f text;
  v_r text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.tint_promocao_tick()'::regprocedure)
     <> 'e5f375b0bff05600fe66f3f6d79d513c' THEN
    RAISE EXCEPTION 'POS FALHOU: tint_promocao_tick não ficou com o corpo novo';
  END IF;
  FOREACH v_f IN ARRAY ARRAY['public.tint_promote_preparacoes(uuid)',
                             'public.tint_consumo_plano_extracao(text,text,timestamptz)',
                             'public.tint_consumo_compactar(timestamptz)',
                             'public.tint_preparacoes_tick()', 'public.tint_promocao_tick()'] LOOP
    IF to_regprocedure(v_f) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: função % ausente', v_f;
    END IF;
    FOREACH v_r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_r, v_f, 'EXECUTE') THEN
        RAISE EXCEPTION 'POS FALHOU: % executa %', v_r, v_f;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.tint_consumo_plano_extracao(text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: service_role sem EXECUTE no plano';
  END IF;
  IF to_regprocedure('public.tint_consumo_cobertura_em(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: tint_consumo_cobertura_em ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-preparacoes-tick') THEN
    RAISE EXCEPTION 'POS FALHOU: cron tint-preparacoes-tick ausente';
  END IF;
END
$post2$;
