-- Reposição — infra de RUN de pedidos de compra (publicação diferida ATÔMICA) — money-path (PR1)
-- ============================================================================
-- Problema (fix SISTÊMICO): PO excluído direto no Omie deixa o pedido_compra_sugerido 'disparado'
-- → a CTE em_transito do motor re-soma as unidades por 7d → dupla contagem fantasma → o item some
-- do cockpit (pedido 409 / PO #1073 latente; #1115/pedido 1046 já tratado manual).
--
-- PR1 cria SÓ a INFRA de run — NÃO muta pedido, NÃO toca o motor:
--   1) reposicao_pedidos_compra_run — 1 linha imutável por run COMPLETO publicado. O "último completo
--      válido" = mais recente status='ok' AND volume_ok IS TRUE (por seq DESC = ordem total lógica). A
--      ordem é um FENCING TOKEN da sequence reposicao_run_seq, alocado pela edge ANTES da 1ª página da
--      coleta (não no INSERT da publicação) → reflete a ordem de INÍCIO da coleta, não a de publicação.
--      Sem isso, um coletor que começou ANTES mas publica DEPOIS (paginação/429) recebia seq maior e
--      SUPRIMIA a prova por ID de um PO já excluído (Codex v3.3 P1). RLS SELECT staff; escrita service_role-only.
--   2) reposicao_po_last_seen — 1 linha por PO visto no último run VÁLIDO (empresa, omie_codigo_pedido) →
--      run_id + visto_seq. Tabela DEDICADA service_role-only (Codex re-challenge 2026-07-12: as colunas em
--      purchase_orders_tracking eram staff-writable → um staff podia forjar "visto" e SUPRIMIR a prova por ID
--      do PR2, escondendo um fantasma). Aqui a base de verdade é single-writer REAL (só a RPC escreve).
--   3) reposicao_alocar_run_seq() — aloca o fencing token (nextval) no INÍCIO da coleta. service_role-only.
--   4) reposicao_publicar_run_completo(...) — PUBLICAÇÃO DIFERIDA ATÔMICA (SECURITY DEFINER, service_role-only):
--      advisory lock por empresa → volume_ok robusto (baseline por MESMA largura de janela + últimos 10d;
--      ids=0 em run LIMPO = empresa vazia legítima → VÁLIDO) → INSERT marcador (seq = fencing token) → UPSERT
--      last_seen dos POs vistos SÓ se o run é válido, com guard anti-regressão por visto_seq. Tudo numa transação.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5
-- Prova PG17 (falsifica os P1): db/test-reposicao-publicar-run-completo.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- ─── 0) fencing token — ordem TOTAL lógica de INÍCIO da coleta (monotônica, única, nunca recua) ───
-- Alocada pela edge ANTES da 1ª página (via reposicao_alocar_run_seq); usada como seq do marcador e visto_seq
-- do last_seen. Assim a ordem entre runs concorrentes é a de INÍCIO da coleta — não a de publicação (Codex v3.3
-- P1: coletor que começa antes mas publica depois NÃO pode sobrescrever o sinal de um coletor mais novo).
CREATE SEQUENCE IF NOT EXISTS public.reposicao_run_seq;
REVOKE ALL ON SEQUENCE public.reposicao_run_seq FROM PUBLIC, anon, authenticated;

-- ─── 1) marcador de run (insert-only, imutável) ───
CREATE TABLE IF NOT EXISTS public.reposicao_pedidos_compra_run (
  run_id          uuid PRIMARY KEY,
  -- seq = fencing token (ordem de INÍCIO da coleta). Único global e monotônico (da MESMA sequence do alocador).
  -- Substitui wall-clock e o antigo GENERATED-no-INSERT (que ordenava por PUBLICAÇÃO, não por início — Codex
  -- v3.3 P1). A RPC passa o p_seq (alocado ANTES da coleta); o DEFAULT nextval só cobre inserts diretos (seeds/
  -- backfill de auditoria) — mesma sequence ⇒ sem colisão com os tokens da edge.
  seq             bigint NOT NULL DEFAULT nextval('public.reposicao_run_seq') UNIQUE,
  empresa         public.empresa_reposicao NOT NULL,
  janela_de       date NOT NULL,
  janela_ate      date NOT NULL,
  ids_distintos   integer NOT NULL,
  volume_baseline integer,
  volume_ok       boolean,
  status          text NOT NULL DEFAULT 'ok',
  -- finalizado_em = clock_timestamp() (auditoria + filtro de idade de 10d do baseline). NÃO é a chave de ordem.
  finalizado_em   timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.reposicao_pedidos_compra_run IS
  'Um registro IMUTÁVEL por run COMPLETO de omie-sync-pedidos-compra publicado. Marcador "último completo válido" = mais recente status=''ok'' AND volume_ok IS TRUE (por seq DESC). seq = fencing token de INÍCIO da coleta (reposicao_run_seq). Escrito SÓ por reposicao_publicar_run_completo (service_role). PR1 reconciliação PO excluído no Omie.';

-- "último válido" (PR2) e baseline ordenam por seq DESC dentro da empresa.
CREATE INDEX IF NOT EXISTS idx_reposicao_pedidos_compra_run_baseline
  ON public.reposicao_pedidos_compra_run (empresa, seq DESC);

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
  -- visto_seq = fencing token do run publicador (ordem de INÍCIO da coleta; guard anti-regressão). visto_em = auditoria.
  visto_seq          bigint NOT NULL,
  visto_em           timestamptz NOT NULL,
  PRIMARY KEY (empresa, omie_codigo_pedido)
);
COMMENT ON TABLE public.reposicao_po_last_seen IS
  'Último run VÁLIDO que VIU cada PO (empresa, omie_codigo_pedido → run_id, visto_seq). Base do filtro de candidatos do PR2 (PO cujo run_id <> marcador atual = candidato). Escrito SÓ por reposicao_publicar_run_completo (service_role) — NÃO em purchase_orders_tracking, que é staff-writable (senão staff forjaria "visto" e suprimiria a prova por ID). visto_seq = fencing token de INÍCIO da coleta (guard anti-regressão por ordem lógica, não por publicação nem wall-clock).';

ALTER TABLE public.reposicao_po_last_seen ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_po_last_seen_sel ON public.reposicao_po_last_seen;
CREATE POLICY reposicao_po_last_seen_sel ON public.reposicao_po_last_seen
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_po_last_seen FROM authenticated, anon;

-- ─── 3) alocador do fencing token — chamado pela edge no INÍCIO da coleta ───
CREATE OR REPLACE FUNCTION public.reposicao_alocar_run_seq()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT nextval('public.reposicao_run_seq'); $$;
REVOKE ALL ON FUNCTION public.reposicao_alocar_run_seq() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alocar_run_seq() TO service_role;

-- ─── 4) RPC de PUBLICAÇÃO DIFERIDA ATÔMICA (o coração da v3) ───
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(
  p_empresa    text,
  p_run_id     uuid,
  p_seq        bigint,   -- fencing token alocado ANTES da coleta (reposicao_alocar_run_seq)
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
  -- (a) advisory lock por empresa — serializa a PUBLICAÇÃO (marcador + last_seen no mesmo commit). A ordem
  --     entre runs é o FENCING TOKEN p_seq (alocado no INÍCIO da coleta), monotônico e único — um coletor que
  --     começou antes tem seq MENOR mesmo publicando depois, então NÃO suprime o sinal de um coletor mais novo
  --     (Codex v3.3 P1). p_seq <= 0 é inválido (a edge sempre aloca > 0).
  IF p_seq IS NULL OR p_seq <= 0 THEN
    RAISE EXCEPTION 'reposicao_publicar_run_completo: p_seq inválido (%) — fencing token deve ser > 0', p_seq
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:' || lower(btrim(p_empresa))));
  v_agora := clock_timestamp();

  SELECT count(DISTINCT x) INTO v_ids_distintos
  FROM unnest(COALESCE(p_ids, ARRAY[]::bigint[])) AS x
  WHERE x IS NOT NULL AND x > 0;

  -- (b) baseline ROBUSTO: mediana dos últimos 5 runs BONS COMPARÁVEIS — mesma empresa, mesma LARGURA de janela
  --     (backfill manual ampliado tem +POs por design → NÃO envenena o baseline do completo normal; Codex),
  --     últimos 10 DIAS (um bootstrap anormal velho sai → quebra o latch permanente; Codex), status ok,
  --     ids>0 (exclui páginas vazias E o próprio caso empresa-vazia), volume_ok IS NOT FALSE (exclui truncados,
  --     admite bootstrap null). Ordena por seq DESC (ordem total lógica).
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
    ORDER BY seq DESC
    LIMIT 5
  ) r;

  -- (c) volume_ok:
  --   ids=0 num run LIMPO = empresa vazia legítima → VÁLIDO (a edge só chama a RPC em varredura_completa, então
  --     ids=0 aqui significa "vi o fim sem nenhum PO", NÃO truncamento). Sem isso, empresa esvaziada nunca
  --     produziria marcador válido e os fantasmas jamais viravam candidatos (Codex v3.2 P1). O único risco (uma
  --     coleta espúria de 0 páginas) é barrado pela prova por ID do PR2.
  --   senão: baseline null/<=0 → null (bootstrap; MATA o canário [0,0,0]→true); >=90% do baseline → true.
  IF v_ids_distintos = 0 THEN
    v_volume_ok := TRUE;
  ELSIF v_baseline IS NULL OR v_baseline <= 0 THEN
    v_volume_ok := NULL;
  ELSE
    v_volume_ok := (v_ids_distintos::numeric >= 0.9 * v_baseline);
  END IF;

  -- (d) marcador imutável. seq = p_seq (fencing token). SEMPRE grava (o histórico — inclusive bootstrap null —
  --     alimenta o baseline dos próximos runs comparáveis).
  INSERT INTO public.reposicao_pedidos_compra_run
    (run_id, seq, empresa, janela_de, janela_ate, ids_distintos, volume_baseline, volume_ok, status, finalizado_em)
  VALUES
    (p_run_id, p_seq, v_empresa, p_janela_de, p_janela_ate, v_ids_distintos,
     CASE WHEN v_baseline IS NULL THEN NULL ELSE round(v_baseline)::integer END,
     v_volume_ok, 'ok', v_agora);

  -- (e) carimba last_seen dos POs vistos — SÓ quando o run é VÁLIDO (volume_ok=true), no MESMO commit do
  --     marcador (run truncado/bootstrap NÃO publica sinal — Codex P1 #1). visto_seq = p_seq (fencing token);
  --     guard anti-regressão no ON CONFLICT: um run cujo fencing token é MENOR (começou a coletar antes, mesmo
  --     publicando depois) NÃO sobrescreve — a sequence é monotônica, sem empate nem recuo (Codex v3.3 P1 / P1#4).
  --     Em empresa-vazia (ids=0, volume_ok=true) o unnest é vazio → nada a carimbar; o marcador válido basta.
  IF v_volume_ok IS TRUE THEN
    INSERT INTO public.reposicao_po_last_seen (empresa, omie_codigo_pedido, run_id, visto_seq, visto_em)
    SELECT v_empresa, x, p_run_id, p_seq, v_agora
    FROM unnest(p_ids) AS x
    WHERE x IS NOT NULL AND x > 0
    ON CONFLICT (empresa, omie_codigo_pedido) DO UPDATE
      SET run_id = EXCLUDED.run_id, visto_seq = EXCLUDED.visto_seq, visto_em = EXCLUDED.visto_em
      WHERE public.reposicao_po_last_seen.visto_seq < EXCLUDED.visto_seq;
  END IF;

  -- Retorna volume_ok (true/false/null) para o marcador do PR2. A CADÊNCIA do cron (marcarCompletoOk) NÃO é
  -- gateada por isto — ela avança se a publicação teve SUCESSO (a RPC não deu erro), senão um run de baixo
  -- volume/vazio travaria o completo permanentemente (Codex v3.2 P1). O gate de sucesso vive na edge.
  RETURN v_volume_ok;
END;
$$;

-- service_role-only. authenticated/anon nem INVOCAM (42501 no privilégio, antes do corpo).
REVOKE ALL ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, bigint, date, date, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, bigint, date, date, bigint[])
  TO service_role;

COMMIT;
