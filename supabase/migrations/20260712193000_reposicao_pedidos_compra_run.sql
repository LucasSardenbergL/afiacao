-- Reposição — infra de RUN de pedidos de compra (publicação diferida ATÔMICA) — money-path (PR1)
-- ============================================================================
-- Problema (fix SISTÊMICO): PO excluído direto no Omie deixa o pedido_compra_sugerido 'disparado'
-- → a CTE em_transito do motor re-soma as unidades por 7d → dupla contagem fantasma → o item some
-- do cockpit (pedido 409 / PO #1073 latente; #1115/pedido 1046 já tratado manual).
--
-- PR1 cria SÓ a INFRA de run — NÃO muta pedido, NÃO toca o motor:
--   1) reposicao_pedidos_compra_run — 1 linha imutável por run COMPLETO publicado. O "último completo
--      válido" = mais recente status='ok' AND volume_ok IS TRUE. RLS SELECT staff; escrita service_role-only
--      (Codex P1 #6 — sem isso a base de verdade é forjável por authenticated).
--   2) purchase_orders_tracking.last_seen_pedidos_full_{run_id,at} — colunas single-writer, escritas SÓ
--      pela RPC (3), no fim do run limpo, no MESMO commit do marcador (Codex P1 #1/#4).
--   3) reposicao_publicar_run_completo(...) — PUBLICAÇÃO DIFERIDA ATÔMICA (SECURITY DEFINER, service_role-only):
--      advisory lock por empresa → volume_ok robusto → INSERT marcador → UPDATE last_seen, tudo numa transação.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5
-- Prova PG17 (falsifica os 6 P1): db/test-reposicao-publicar-run-completo.sh
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
  -- iniciado_em = quando a COLETA daquele run começou (atualidade do snapshot). O "último válido" que o
  -- PR2 vai consumir DEVE ordenar por iniciado_em DESC (não finalizado_em): um coletor VELHO que publica
  -- por último NÃO é o mais atual (Codex P1 #4 — publicação != atualidade da coleta).
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  finalizado_em   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.reposicao_pedidos_compra_run IS
  'Um registro IMUTÁVEL por run COMPLETO de omie-sync-pedidos-compra publicado. Marcador "último completo válido" = mais recente status=''ok'' AND volume_ok IS TRUE. Escrito SÓ por reposicao_publicar_run_completo (service_role). PR1 reconciliação PO excluído no Omie.';

-- baseline lê os últimos runs bons por empresa (ORDER BY finalizado_em DESC) → índice cobre.
CREATE INDEX IF NOT EXISTS idx_reposicao_pedidos_compra_run_baseline
  ON public.reposicao_pedidos_compra_run (empresa, finalizado_em DESC);

ALTER TABLE public.reposicao_pedidos_compra_run ENABLE ROW LEVEL SECURITY;
-- SELECT: só staff carteira-completa (espelha reposicao_estoque_nao_confirmado_log).
DROP POLICY IF EXISTS reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
-- SEM policy de INSERT/UPDATE/DELETE → RLS nega escrita a authenticated/anon (Codex P1 #6).
-- Defense-in-depth: revoga grants de escrita (service_role bypassa RLS via a RPC SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_pedidos_compra_run FROM authenticated, anon;

-- ─── 2) colunas single-writer no tracking (escritas SÓ pela RPC 3) ───
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_run_id uuid,
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_at timestamptz;
COMMENT ON COLUMN public.purchase_orders_tracking.last_seen_pedidos_full_run_id IS
  'run_id do último run COMPLETO de omie-sync-pedidos-compra que VIU este PO. Escrito SÓ por reposicao_publicar_run_completo, no MESMO commit do marcador. NÃO tocar no upsert das páginas (Codex P1 #1).';

-- ─── 3) RPC de PUBLICAÇÃO DIFERIDA ATÔMICA (o coração da v3) ───
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(
  p_empresa     text,
  p_run_id      uuid,
  p_janela_de   date,
  p_janela_ate  date,
  p_ids         bigint[],
  p_iniciado_em timestamptz
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
BEGIN
  -- (a) advisory lock por empresa — serializa a PUBLICAÇÃO (marcador + last_seen no mesmo commit), então dois
  --     completos concorrentes não INTERCALAM dentro da RPC. A atualidade entre eles é resolvida pelo guard
  --     temporal do UPDATE em (d): o coletor mais VELHO não sobrescreve o mais novo (Codex P1 #4). Resíduo
  --     TOLERADO: POs vistos só por um coletor disjunto concorrente ficam com o run_id dele — o PR2 (prova por
  --     ID via ConsultarPedCompra) barra qualquer dano; o PR2 consome o "último válido" por iniciado_em DESC.
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:' || lower(btrim(p_empresa))));

  -- POs distintos vistos neste run (dedup; ignora null/<=0).
  SELECT count(DISTINCT x) INTO v_ids_distintos
  FROM unnest(COALESCE(p_ids, ARRAY[]::bigint[])) AS x
  WHERE x IS NOT NULL AND x > 0;

  -- (b) baseline ROBUSTO (Codex P1 #5): mediana dos últimos 5 runs BONS da empresa — exclui truncados
  --     conhecidos (volume_ok=false) e degenerados (ids_distintos=0), admite o bootstrap (volume_ok null).
  --     Isto MATA o canário [0,0,0]→true (sem run bom → baseline null → volume_ok null, NUNCA true).
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos)
  INTO v_baseline
  FROM (
    SELECT ids_distintos
    FROM public.reposicao_pedidos_compra_run
    WHERE empresa = v_empresa
      AND status = 'ok'
      AND ids_distintos > 0
      AND volume_ok IS NOT FALSE
    ORDER BY finalizado_em DESC
    LIMIT 5
  ) r;

  IF v_baseline IS NULL OR v_baseline <= 0 THEN
    v_volume_ok := NULL;                                   -- bootstrap / sem histórico bom → "não sei"
  ELSE
    v_volume_ok := (v_ids_distintos::numeric >= 0.9 * v_baseline);
  END IF;

  -- (c) marcador imutável (insert-only). run_id é PK → re-publicar o mesmo run colide (fail-closed).
  --     SEMPRE grava (mesmo volume_ok null/false) — o histórico alimenta o baseline dos próximos runs.
  INSERT INTO public.reposicao_pedidos_compra_run
    (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_baseline, volume_ok, status, iniciado_em, finalizado_em)
  VALUES
    (p_run_id, v_empresa, p_janela_de, p_janela_ate, v_ids_distintos,
     CASE WHEN v_baseline IS NULL THEN NULL ELSE round(v_baseline)::integer END,
     v_volume_ok, 'ok', p_iniciado_em, now());

  -- (d) carimba last_seen dos POs vistos — SÓ quando o run é VÁLIDO (volume_ok=true), no MESMO commit do
  --     marcador (Codex P1 #1: run truncado/bootstrap NÃO publica sinal). Carimba com iniciado_em (atualidade
  --     da coleta) e NÃO regride — um coletor mais VELHO não sobrescreve um last_seen mais novo (Codex P1 #4).
  IF v_volume_ok IS TRUE THEN
    UPDATE public.purchase_orders_tracking
    SET last_seen_pedidos_full_run_id = p_run_id,
        last_seen_pedidos_full_at = p_iniciado_em
    WHERE empresa = v_empresa
      AND omie_codigo_pedido = ANY (p_ids)
      AND omie_codigo_pedido > 0
      AND (last_seen_pedidos_full_at IS NULL OR last_seen_pedidos_full_at < p_iniciado_em);
  END IF;

  -- Retorna volume_ok: SÓ `true` significa "run válido publicado" (o caller avança a cadência só então).
  RETURN v_volume_ok;
END;
$$;

-- Codex P1 #6: service_role-only. authenticated/anon nem INVOCAM (42501 no privilégio, antes do corpo).
REVOKE ALL ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[], timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[], timestamptz)
  TO service_role;

COMMIT;
