-- Reposição — RPC de SNAPSHOT ATÔMICO do "a caminho" (estoque_pendente_entrada) — FONTE ÚNICA.
-- =====================================================================================================
-- CONTEXTO (spec docs/superpowers/specs/2026-06-11-reposicao-fonte-unica-on-order.md, "Opção A endurecida"):
--   gerar_pedidos_sugeridos_ciclo decide comprar por estoque_efetivo = fisico + pendente_entrada (+ em_transito,
--   REMOVIDO no passo 3). O "a caminho" (pendente_entrada) é FONTE ÚNICA Omie = Σ saldo (nQtde−nQtdeRec) por SKU
--   sobre as POs abertas APROVADAS (etapa "15" OBEN, app+manual). A 1ª tentativa (keep-both: em_transito interno +
--   fonte Omie com de-dup) foi BLOQUEADA pelo Codex (em_transito conta qtde_final CHEIA vs saldo → overcount → ruptura).
--
-- ESTA RPC é o passo 1: aplica o snapshot por-SKU de forma ATÔMICA e é a ÚNICA dona da coluna estoque_pendente_entrada
--   (a edge omie-sync-estoque para de gravá-la no upsert do físico — passo 2). Recebe o porSku já derivado pelo helper
--   puro src/lib/reposicao/pendente-entrada-po.ts (fail-closed: a edge SÓ chama esta RPC quando a varredura COMPLETOU
--   E não houve `problemas`). SUBSTITUI (nunca +=) todo o pendente da empresa + grava o marcador `complete` na MESMA
--   transação. run_id monotônico (run velho não sobrescreve novo) + advisory lock (serializa cron×manual×bump).
--
-- INVARIANTES (Codex "Opção A endurecida"):
--   - Nunca +=: zera o pendente de TODO SKU da empresa fora do payload; seta os do payload (substituição absoluta).
--   - apply + marcador `complete` na MESMA transação (esta função plpgsql).
--   - run_id monotônico: p_run_id < último → SKIP (não toca estoque nem marcador).
--   - NÃO toca sku_estoque_atual.ultima_sincronizacao (= frescor do FÍSICO; o frescor do pendente vive no marcador).
--   - codints_aprovados gravados no marcador → a barreira fail-closed do passo 3 cruza os AFI-<id> recém-disparados
--     (fecha o caso de borda do run_id: full-sync de dados velhos não pode silenciosamente perder uma PO recém-criada).
--   - GUARD de completude (auto-challenge): exige meta.empty_page_reached='true' — payload vazio só zera tudo com
--     varredura confirmadamente completa (backstop contra payload vazio/parcial acidental zerar todo o a-caminho).
--
-- GATE: espelha o padrão do projeto (envio_portal_claim_ids) — libera service_role (uid NULL, caller do cron/edge),
--   exige staff (employee/master) só p/ usuário autenticado. SECURITY DEFINER + search_path fixo; REVOKE de
--   anon/authenticated/PUBLIC; GRANT só service_role. A edge usa SERVICE_ROLE_KEY (gate passa).
--
-- ⚠️ MONEY-PATH — validado em PG17 (db/test-aplicar-snapshot-pendente.sh). Codex adversarial xhigh é GATE antes do deploy.

CREATE OR REPLACE FUNCTION public.aplicar_snapshot_pendente(
  p_empresa              text,
  p_pendente             jsonb,
  p_codints_aprovados    text[],
  p_codints_em_aprovacao text[],
  p_run_id               bigint,
  p_observed_at          timestamptz,
  p_meta                 jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa        text := upper(btrim(coalesce(p_empresa, '')));
  v_account        text;
  v_ultimo_run     bigint;
  v_skus_setados   int := 0;
  v_skus_zerados   int := 0;
  v_skus_sem_linha int := 0;
  v_codints        text[];
  v_codints_emaprov text[];
  v_n_pendente     int;
BEGIN
  -- Gate: service_role (uid NULL) passa; usuário autenticado precisa ser staff.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- Validações de entrada (fail-closed).
  IF v_empresa = '' THEN
    RAISE EXCEPTION 'empresa obrigatória' USING ERRCODE = '22023';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_id obrigatório' USING ERRCODE = '22023';
  END IF;
  IF p_pendente IS NULL OR jsonb_typeof(p_pendente) <> 'object' THEN
    RAISE EXCEPTION 'p_pendente deve ser objeto jsonb (recebido: %)', jsonb_typeof(p_pendente) USING ERRCODE = '22023';
  END IF;

  -- GUARD de completude: substituição absoluta só com varredura COMPLETA confirmada pela edge.
  IF coalesce(p_meta->>'empty_page_reached', '') <> 'true' THEN
    RAISE EXCEPTION 'snapshot recusado: meta.empty_page_reached <> true (varredura incompleta — recusado p/ não zerar o a-caminho)'
      USING ERRCODE = '22023';
  END IF;

  -- GUARD de saldo: nenhum valor do payload pode ser não-numérico ou <= 0 (helper já garante; defense-in-depth).
  IF EXISTS (
    SELECT 1 FROM jsonb_each(p_pendente) j
    WHERE jsonb_typeof(j.value) <> 'number' OR (j.value #>> '{}')::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'snapshot recusado: saldo inválido no payload (não-numérico ou <= 0)' USING ERRCODE = '22023';
  END IF;

  v_account := lower(v_empresa);  -- marcador: account = 'oben'

  -- Serializa applies concorrentes da mesma empresa (cron × manual × bump pós-disparo).
  PERFORM pg_advisory_xact_lock(hashtext('aplicar_snapshot_pendente:' || v_empresa));

  -- Monotonicidade: run velho NÃO sobrescreve novo.
  SELECT COALESCE((metadata->>'run_id')::bigint, 0) INTO v_ultimo_run
  FROM public.sync_state
  WHERE entity_type = 'reposicao_pendente_po' AND account = v_account;
  v_ultimo_run := COALESCE(v_ultimo_run, 0);

  IF p_run_id < v_ultimo_run THEN
    RETURN jsonb_build_object(
      'applied', false, 'skipped_reason', 'stale_run',
      'run_id', p_run_id, 'ultimo_run', v_ultimo_run
    );
  END IF;

  -- 1) Zera o pendente de TODO SKU da empresa fora do payload (substituição absoluta, nunca +=).
  WITH zerados AS (
    UPDATE public.sku_estoque_atual sea
       SET estoque_pendente_entrada = 0
     WHERE sea.empresa = v_empresa
       AND COALESCE(sea.estoque_pendente_entrada, 0) <> 0
       AND NOT (p_pendente ? sea.sku_codigo_omie)
    RETURNING 1
  )
  SELECT count(*) INTO v_skus_zerados FROM zerados;

  -- 2) Seta os do payload (UPSERT: cria linha só-pendente se o SKU nunca teve física sincronizada).
  --    ON CONFLICT toca SÓ estoque_pendente_entrada — NÃO mexe em estoque_fisico/ultima_sincronizacao/fonte_sync
  --    da linha existente (preserva o frescor do físico). Linha NOVA nasce com fisico=0, ultima_sincronizacao=NULL
  --    (honesto: físico nunca sincronizou → não polui o max() do check de frescor do físico).
  WITH up AS (
    INSERT INTO public.sku_estoque_atual
      (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao, fonte_sync)
    SELECT v_empresa, j.key, 0, (j.value #>> '{}')::numeric, NULL, 'snapshot_pendente_sem_fisico'
    FROM jsonb_each(p_pendente) j
    ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE
      SET estoque_pendente_entrada = EXCLUDED.estoque_pendente_entrada
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*)::int, count(*) FILTER (WHERE inserted)::int INTO v_skus_setados, v_skus_sem_linha FROM up;

  -- codints normalizados (distintos, sem vazio/NULL) → a barreira do passo 3 cruza com `metadata->'codints_*' ? ('AFI-'||id)`.
  v_codints := COALESCE(
    (SELECT array_agg(DISTINCT c) FROM unnest(coalesce(p_codints_aprovados, ARRAY[]::text[])) c
      WHERE c IS NOT NULL AND btrim(c) <> ''),
    ARRAY[]::text[]
  );
  -- [P1.2] codints de POs do app EM APROVAÇÃO (etapa-10): a barreira (3b) aborta enquanto a PO não virar etapa-15.
  v_codints_emaprov := COALESCE(
    (SELECT array_agg(DISTINCT c) FROM unnest(coalesce(p_codints_em_aprovacao, ARRAY[]::text[])) c
      WHERE c IS NOT NULL AND btrim(c) <> ''),
    ARRAY[]::text[]
  );
  v_n_pendente := (SELECT count(*)::int FROM jsonb_object_keys(p_pendente));

  -- 3) Marcador `complete` na MESMA transação (sync_state, UNIQUE (entity_type, account)).
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES (
    'reposicao_pendente_po', v_account, 'complete', p_observed_at, v_n_pendente,
    COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object(
      'run_id',                 p_run_id,
      'observed_at',            p_observed_at,
      'codints_aprovados',      to_jsonb(v_codints),
      'codints_em_aprovacao',   to_jsonb(v_codints_emaprov),
      'skus_com_pendente',      v_n_pendente,
      'skus_zerados',           v_skus_zerados,
      'skus_sem_linha_criados', v_skus_sem_linha
    ),
    now()
  )
  ON CONFLICT (entity_type, account) DO UPDATE SET
    status       = 'complete',
    last_sync_at = EXCLUDED.last_sync_at,
    total_synced = EXCLUDED.total_synced,
    metadata     = EXCLUDED.metadata,
    updated_at   = now();

  RETURN jsonb_build_object(
    'applied',                true,
    'run_id',                 p_run_id,
    'account',                v_account,
    'skus_com_pendente',      v_n_pendente,
    'skus_setados',           v_skus_setados,
    'skus_zerados',           v_skus_zerados,
    'skus_sem_linha_criados', v_skus_sem_linha,
    'codints_aprovados',      COALESCE(array_length(v_codints, 1), 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.aplicar_snapshot_pendente(text, jsonb, text[], text[], bigint, timestamptz, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.aplicar_snapshot_pendente(text, jsonb, text[], text[], bigint, timestamptz, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_snapshot_pendente(text, jsonb, text[], text[], bigint, timestamptz, jsonb) TO service_role;

-- Validação pós-apply (colar no SQL Editor do Lovable):
SELECT 'MIGRATION aplicar_snapshot_pendente OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'aplicar_snapshot_pendente') AS func_existe,
  (SELECT prosecdef FROM pg_proc WHERE proname = 'aplicar_snapshot_pendente') AS security_definer,
  has_function_privilege('service_role', 'public.aplicar_snapshot_pendente(text, jsonb, text[], text[], bigint, timestamptz, jsonb)', 'EXECUTE') AS service_role_exec,
  has_function_privilege('authenticated', 'public.aplicar_snapshot_pendente(text, jsonb, text[], text[], bigint, timestamptz, jsonb)', 'EXECUTE') AS authenticated_exec_deve_ser_false;
