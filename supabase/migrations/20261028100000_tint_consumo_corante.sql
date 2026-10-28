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

-- ── 6. RLS + ACL: staff lê; só a promoção (SECURITY DEFINER) escreve o fato ─────────────────────
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tint_consumo_preparacao', 'tint_consumo_corante', 'tint_consumo_planos', 'tint_consumo_extracoes',
                           'tint_consumo_extracao_lotes', 'tint_staging_preparacao_manifestos'] LOOP
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
              public.tint_consumo_extracoes, public.tint_consumo_extracao_lotes
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.tint_consumo_preparacao, public.tint_consumo_corante, public.tint_consumo_planos,
                public.tint_consumo_extracoes, public.tint_consumo_extracao_lotes TO authenticated, service_role;
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
                             'tint_consumo_extracoes', 'tint_consumo_extracao_lotes'] LOOP
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
