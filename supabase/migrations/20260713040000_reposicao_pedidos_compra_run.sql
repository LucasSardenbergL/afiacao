-- Reposição — infra de RUN de pedidos de compra (publicação diferida ATÔMICA) — money-path (PR1)
-- ============================================================================
-- Problema (fix SISTÊMICO): PO excluído direto no Omie deixa o pedido_compra_sugerido 'disparado'
-- → a CTE em_transito do motor re-soma as unidades por 7d → dupla contagem fantasma → o item some
-- do cockpit (pedido 409 / PO #1073 latente; #1115/pedido 1046 já tratado manual).
--
-- PR1 cria SÓ a INFRA de run — NÃO muta pedido, NÃO toca o motor:
--   1) reposicao_pedidos_compra_run — 1 linha imutável por run COMPLETO publicado. O "último completo
--      válido" = mais recente status='ok' AND volume_ok IS TRUE (por finalizado_em DESC = ordem de PUBLICAÇÃO
--      via clock_timestamp sob o lock). RLS SELECT staff; escrita service_role-only.
--   2) reposicao_po_last_seen — 1 linha por PO visto no último run VÁLIDO (empresa, omie_codigo_pedido) →
--      run_id + visto_em. Tabela DEDICADA service_role-only (Codex re-challenge 2026-07-12: as colunas em
--      purchase_orders_tracking eram staff-writable → um staff podia forjar "visto" e SUPRIMIR a prova por ID
--      do PR2, escondendo um fantasma). Aqui a base de verdade é single-writer REAL (só a RPC escreve).
--   3) reposicao_publicar_run_completo(...) — PUBLICAÇÃO DIFERIDA ATÔMICA (SECURITY DEFINER, service_role-only):
--      advisory lock por empresa → clock_timestamp (ordem total monotônica, sem relógio de worker) → volume_ok
--      robusto (baseline por MESMA largura de janela + últimos 10d) → INSERT marcador → UPSERT last_seen dos
--      POs vistos SÓ se o run é válido, com guard anti-regressão. Tudo numa transação.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5
-- Prova PG17 (falsifica os P1): db/test-reposicao-publicar-run-completo.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- ─── 1) marcador de run (insert-only, imutável) ───
CREATE TABLE IF NOT EXISTS public.reposicao_pedidos_compra_run (
  run_id          uuid PRIMARY KEY,
  empresa         public.empresa_reposicao NOT NULL,
  janela_de       date NOT NULL,
  janela_ate      date NOT NULL,
  ids_distintos   integer NOT NULL,
  volume_baseline integer,
  volume_ok       boolean,
  status          text NOT NULL DEFAULT 'ok',
  -- finalizado_em = clock_timestamp() capturado SOB o advisory lock → ordem total monotônica entre runs da
  -- mesma empresa (sem clock skew de worker, sem empate). O "último válido" (PR2) ordena por isto DESC.
  finalizado_em   timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.reposicao_pedidos_compra_run IS
  'Um registro IMUTÁVEL por run COMPLETO de omie-sync-pedidos-compra publicado. Marcador "último completo válido" = mais recente status=''ok'' AND volume_ok IS TRUE (por finalizado_em DESC). Escrito SÓ por reposicao_publicar_run_completo (service_role). PR1 reconciliação PO excluído no Omie.';

CREATE INDEX IF NOT EXISTS idx_reposicao_pedidos_compra_run_baseline
  ON public.reposicao_pedidos_compra_run (empresa, finalizado_em DESC);

ALTER TABLE public.reposicao_pedidos_compra_run ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
-- SEM policy de INSERT/UPDATE/DELETE → RLS nega escrita a authenticated/anon (base de verdade não-forjável).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_pedidos_compra_run FROM authenticated, anon;

-- ─── 2) last_seen por PO — tabela DEDICADA service_role-only (single-writer REAL) ───
CREATE TABLE IF NOT EXISTS public.reposicao_po_last_seen (
  empresa            public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  run_id             uuid NOT NULL,
  visto_em           timestamptz NOT NULL,
  PRIMARY KEY (empresa, omie_codigo_pedido)
);
COMMENT ON TABLE public.reposicao_po_last_seen IS
  'Último run VÁLIDO que VIU cada PO (empresa, omie_codigo_pedido → run_id, visto_em). Base do filtro de candidatos do PR2 (PO cujo run_id <> marcador atual = candidato). Escrito SÓ por reposicao_publicar_run_completo (service_role) — NÃO em purchase_orders_tracking, que é staff-writable (senão staff forjaria "visto" e suprimiria a prova por ID). visto_em = clock_timestamp do run publicador (guard anti-regressão).';

ALTER TABLE public.reposicao_po_last_seen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_po_last_seen_sel ON public.reposicao_po_last_seen;
CREATE POLICY reposicao_po_last_seen_sel ON public.reposicao_po_last_seen
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_po_last_seen FROM authenticated, anon;

-- ─── 3) RPC de PUBLICAÇÃO DIFERIDA ATÔMICA (o coração da v3) ───
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(
  p_empresa    text,
  p_run_id     uuid,
  p_janela_de  date,
  p_janela_ate date,
  p_ids        bigint[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_empresa       public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
  v_ids_distintos integer;
  v_baseline      numeric;
  v_volume_ok     boolean;
  v_agora         timestamptz;
BEGIN
  -- (a) advisory lock por empresa — serializa a PUBLICAÇÃO. clock_timestamp() capturado APÓS o lock é
  --     estritamente crescente entre runs da mesma empresa (sem clock skew de worker, sem empate) → ordem
  --     total confiável (Codex P1 #4). Resíduo tolerado (PR2 barra via prova por ID): um coletor que COMEÇOU
  --     antes mas PUBLICA depois carimba com visto_em maior — precisaria de sequência-no-início da coleta.
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:' || lower(btrim(p_empresa))));
  v_agora := clock_timestamp();

  SELECT count(DISTINCT x) INTO v_ids_distintos
  FROM unnest(COALESCE(p_ids, ARRAY[]::bigint[])) AS x
  WHERE x IS NOT NULL AND x > 0;

  -- (b) baseline ROBUSTO: mediana dos últimos 5 runs BONS COMPARÁVEIS — mesma empresa, mesma LARGURA de janela
  --     (backfill manual ampliado tem +POs por design → NÃO envenena o baseline do completo normal; Codex),
  --     últimos 10 DIAS (um bootstrap anormal velho sai → quebra o latch permanente; Codex), status ok,
  --     ids>0 (exclui páginas vazias), volume_ok IS NOT FALSE (exclui truncados, admite bootstrap null).
  --     baseline null/<=0 → volume_ok null (bootstrap; MATA o canário [0,0,0]→true).
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos)
  INTO v_baseline
  FROM (
    SELECT ids_distintos
    FROM public.reposicao_pedidos_compra_run
    WHERE empresa = v_empresa
      AND status = 'ok'
      AND ids_distintos > 0
      AND volume_ok IS NOT FALSE
      AND (janela_ate - janela_de) = (p_janela_ate - p_janela_de)
      AND finalizado_em > now() - interval '10 days'
    ORDER BY finalizado_em DESC
    LIMIT 5
  ) r;

  IF v_baseline IS NULL OR v_baseline <= 0 THEN
    v_volume_ok := NULL;
  ELSE
    v_volume_ok := (v_ids_distintos::numeric >= 0.9 * v_baseline);
  END IF;

  -- (c) marcador imutável. finalizado_em = v_agora (ordem total sob o lock). SEMPRE grava (o histórico
  --     — inclusive bootstrap null — alimenta o baseline dos próximos runs comparáveis).
  INSERT INTO public.reposicao_pedidos_compra_run
    (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_baseline, volume_ok, status, finalizado_em)
  VALUES
    (p_run_id, v_empresa, p_janela_de, p_janela_ate, v_ids_distintos,
     CASE WHEN v_baseline IS NULL THEN NULL ELSE round(v_baseline)::integer END,
     v_volume_ok, 'ok', v_agora);

  -- (d) carimba last_seen dos POs vistos — SÓ quando o run é VÁLIDO (volume_ok=true), no MESMO commit do
  --     marcador (run truncado/bootstrap NÃO publica sinal — Codex P1 #1). visto_em = v_agora; guard
  --     anti-regressão no ON CONFLICT (um run mais antigo, visto_em menor, NÃO sobrescreve — Codex P1 #4).
  IF v_volume_ok IS TRUE THEN
    INSERT INTO public.reposicao_po_last_seen (empresa, omie_codigo_pedido, run_id, visto_em)
    SELECT v_empresa, x, p_run_id, v_agora
    FROM unnest(p_ids) AS x
    WHERE x IS NOT NULL AND x > 0
    ON CONFLICT (empresa, omie_codigo_pedido) DO UPDATE
      SET run_id = EXCLUDED.run_id, visto_em = EXCLUDED.visto_em
      WHERE public.reposicao_po_last_seen.visto_em < EXCLUDED.visto_em;
  END IF;

  -- Retorna volume_ok: SÓ `true` significa "run válido publicado" (o caller avança a cadência só então).
  RETURN v_volume_ok;
END;
$$;

-- service_role-only. authenticated/anon nem INVOCAM (42501 no privilégio, antes do corpo).
REVOKE ALL ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[])
  TO service_role;

COMMIT;
