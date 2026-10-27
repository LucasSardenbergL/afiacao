-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — histórico de receitas: tint_receita_versoes (append-only) + captura diária
--
-- DECISÃO DO FOUNDER (2026-10-26, opção "H1"): ter histórico das cores/receitas e das alterações.
-- O que existia (medido 2026-10-26 via psql-ro):
--   * tint_formula_itens é SOBRESCRITO pelo promote — não guarda versão anterior;
--   * tint_staging_* é podado pelo cron tint-staging-purge-diario (05:23 UTC): >30 dias, preserva
--     só a latest por chave → a história de mudança anterior a ~26/09 já se perdeu;
--   * tint_sync_errors guarda tudo, mas só de rejeição.
-- Volume: em 30 dias, 7.047 chegadas de staging para 1.647 chaves, só 27 MUDANÇAS reais de receita
-- (5.373 reenvios idênticos). Semente: 130.185 versões, ~38 MB de itens, 7 s de leitura.
--
-- O QUE ENTRA:
--   1. public.tint_receita_versoes — uma linha por EVENTO de uma chave-fonte
--      (cor_id, cod_produto, id_base, subcolecao, personalizada — a MESMA chave do _formulas_latest
--      do promote; subcolecao NULL normalizada para ''):
--        'receita'           receita nova ou diferente da anterior (hash de embalagem+volume+itens),
--                            ou a chave VOLTOU depois de uma saída;
--        'saiu_da_fonte'     a chave sumiu do último snapshot de chaves COMPLETO e aplicado
--                            (tint_keys_snapshots; chave de 4 partes sem subcoleção, igual ao promote);
--        'staging_arquivado' cópia INTEGRAL de uma linha de staging removida fora do purge
--                            (staging_linha = to_jsonb da linha, itens = linhas completas).
--      APPEND-ONLY por trigger (UPDATE/DELETE/TRUNCATE abortam) — histórico não se reescreve.
--   2. public.tint_receita_versoes_capturar() — lê staging, grava só TRANSIÇÕES; idempotente
--      (re-rodar não grava nada). Não escreve em nenhuma outra tabela e não toca o promote.
--   3. cron tint-receita-versoes-diario às 05:03 UTC, 20 min antes do purge. Janela = desde a
--      última versão gravada − 2 dias: um dia (ou 29) perdido não perde nada, porque o purge só
--      remove linhas superadas com >30 dias.
--   4. A semente: a primeira chamada roda aqui mesmo (janela aberta → todo o staging atual).
--
-- O QUE NÃO PROVA: versão anterior a 17/06 (staging mais antigo) e mudanças que o purge já levou.
-- Preço (preco_final) é gravado na versão, mas NÃO entra no hash — mudança só de preço não é
-- versão de receita.
-- Prova executada: db/test-tint-receita-versoes.sh (PG17).
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- ── Guarda: re-aplicar este arquivo depois de uma versão futura da captura NÃO pode revertê-la ──
DO $guarda_captura$
DECLARE
  c_captura constant text := 'e38959678d3e27424f39a617450c2018';
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.tint_receita_versoes_capturar()');
  IF v_md5 IS NOT NULL AND v_md5 <> c_captura THEN
    RAISE EXCEPTION 'receita-versoes ABORTADA: tint_receita_versoes_capturar() já existe com outro corpo (md5 %, este %) — uma versão posterior seria revertida', v_md5, c_captura;
  END IF;
END
$guarda_captura$;

-- ── 1. A tabela ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tint_receita_versoes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account            text NOT NULL,
  store_code         text NOT NULL,
  cor_id             text NOT NULL,
  cod_produto        text NOT NULL,
  id_base            text NOT NULL,
  subcolecao         text NOT NULL DEFAULT '',
  personalizada      boolean NOT NULL,
  evento             text NOT NULL,
  nome_cor           text,
  id_embalagem       text,
  volume_final_ml    numeric,
  preco_final        numeric,
  itens              jsonb,
  receita_hash       text,
  staging_formula_id uuid,          -- SEM FK: o staging é podado; a versão sobrevive a ele
  sync_run_id        uuid,
  agent_version      text,
  snapshot_id        uuid,
  staging_linha      jsonb,
  motivo             text,
  recebido_em        timestamptz NOT NULL,   -- quando o FATO chegou (staging/snapshot created_at)
  capturado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tint_receita_versoes_evento_chk
    CHECK (evento IN ('receita', 'saiu_da_fonte', 'staging_arquivado')),
  CONSTRAINT tint_receita_versoes_receita_chk
    CHECK (evento <> 'receita' OR (itens IS NOT NULL AND receita_hash IS NOT NULL AND staging_formula_id IS NOT NULL)),
  CONSTRAINT tint_receita_versoes_saida_chk
    CHECK (evento <> 'saiu_da_fonte' OR snapshot_id IS NOT NULL),
  CONSTRAINT tint_receita_versoes_arquivo_chk
    CHECK (evento <> 'staging_arquivado'
           OR (staging_linha IS NOT NULL AND itens IS NOT NULL AND staging_formula_id IS NOT NULL AND motivo IS NOT NULL))
);

COMMENT ON TABLE public.tint_receita_versoes IS
  'Histórico APPEND-ONLY das receitas do tintométrico por chave-fonte: versões (receita), saídas da fonte (saiu_da_fonte) e cópias de staging arquivado. Escritor: tint_receita_versoes_capturar() (cron diário). Migration 20261026214720.';

-- Uma linha de staging vira no máximo uma versão (e no máximo um arquivo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tint_receita_versoes_staging
  ON public.tint_receita_versoes (staging_formula_id, evento)
  WHERE staging_formula_id IS NOT NULL;
-- Uma saída por chave por snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tint_receita_versoes_saida
  ON public.tint_receita_versoes (account, store_code, cor_id, cod_produto, id_base, subcolecao, personalizada, snapshot_id)
  WHERE evento = 'saiu_da_fonte';
CREATE INDEX IF NOT EXISTS idx_tint_receita_versoes_chave
  ON public.tint_receita_versoes (account, store_code, cor_id, cod_produto, id_base, subcolecao, personalizada, recebido_em DESC);
CREATE INDEX IF NOT EXISTS idx_tint_receita_versoes_receita_recebido
  ON public.tint_receita_versoes (recebido_em)
  WHERE evento = 'receita';

-- ── Append-only ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_receita_versoes_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'tint_receita_versoes e APPEND-ONLY: % recusado (historico nao se reescreve)', TG_OP
    USING ERRCODE = 'P0001';
END
$function$;

DROP TRIGGER IF EXISTS trg_tint_receita_versoes_append_only ON public.tint_receita_versoes;
CREATE TRIGGER trg_tint_receita_versoes_append_only
  BEFORE UPDATE OR DELETE ON public.tint_receita_versoes
  FOR EACH ROW EXECUTE FUNCTION public.tint_receita_versoes_append_only();
DROP TRIGGER IF EXISTS trg_tint_receita_versoes_append_only_trunc ON public.tint_receita_versoes;
CREATE TRIGGER trg_tint_receita_versoes_append_only_trunc
  BEFORE TRUNCATE ON public.tint_receita_versoes
  FOR EACH STATEMENT EXECUTE FUNCTION public.tint_receita_versoes_append_only();

-- ── RLS: staff lê; ninguém do PostgREST escreve (o escritor é SECURITY DEFINER, dono da tabela) ──
ALTER TABLE public.tint_receita_versoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view tint_receita_versoes" ON public.tint_receita_versoes;
CREATE POLICY "Staff can view tint_receita_versoes"
  ON public.tint_receita_versoes
  FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
-- TRUNCATE não passa por RLS: o grant default do Supabase (ALL a anon/authenticated) sai por inteiro.
REVOKE ALL ON public.tint_receita_versoes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tint_receita_versoes TO authenticated;

-- ── 2. A captura ────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_receita_versoes_capturar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_desde    timestamptz;
  v_ate      timestamptz := now() - interval '15 minutes';
  v_cand     bigint;
  v_receitas bigint;
  v_saidas   bigint := 0;
  v_n        bigint;
  v_snaps    jsonb := '[]'::jsonb;
  snap       record;
BEGIN
  -- Uma captura por vez (cron + chamada manual). Quem chega depois pula, não espera.
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_receita_versoes_capturar')) THEN
    RETURN jsonb_build_object('pulado', 'outra captura em curso');
  END IF;

  -- Janela: desde a última VERSÃO gravada − 2 dias (cobre commit tardio e dia sem cron). Sem
  -- versão nenhuma = semente: todo o staging. Reenvio idêntico não vira versão, então em período
  -- quieto a janela só ALARGA (no máximo os 30 dias que o purge deixa) — nunca encolhe demais.
  SELECT max(recebido_em) - interval '2 days' INTO v_desde
    FROM tint_receita_versoes WHERE evento = 'receita';
  v_desde := COALESCE(v_desde, '-infinity'::timestamptz);

  -- Candidatas: linhas de staging da janela com mais de 15 min (o conector manda itens em lotes)
  -- e itens COMPLETOS quando o nº foi declarado. Incompleta fica para a próxima captura.
  DROP TABLE IF EXISTS _trv_cand;
  CREATE TEMP TABLE _trv_cand ON COMMIT DROP AS
  SELECT s.id AS staging_formula_id, s.account, s.store_code, s.cor_id, s.cod_produto, s.id_base,
         COALESCE(s.subcolecao, '') AS subcolecao, s.personalizada, s.nome_cor, s.id_embalagem,
         s.volume_final_ml, s.preco_final, s.sync_run_id, sr.metadata->>'agent_version' AS agent_version,
         s.created_at AS recebido_em, it.itens,
         -- Hash = o que muda a DOSE: embalagem + volume + (corante, qtd). Ordenado por corante,
         -- não por slot (trocar de slot não é receita nova). trim_scale: 2.4645 = 2.46450.
         md5(COALESCE(s.id_embalagem, '∅') || '|' || COALESCE(trim_scale(s.volume_final_ml)::text, '∅')
             || '|' || it.assinatura) AS receita_hash
    FROM tint_staging_formulas s
    LEFT JOIN tint_sync_runs sr ON sr.id = s.sync_run_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('ordem', i.ordem, 'id_corante', i.id_corante, 'qtd_ml', i.qtd_ml)
                                ORDER BY i.ordem, i.id_corante), '[]'::jsonb) AS itens,
             COALESCE(string_agg(COALESCE(i.id_corante, '∅') || ':' || COALESCE(trim_scale(i.qtd_ml)::text, '∅'), ','
                                 ORDER BY i.id_corante, i.qtd_ml), '') AS assinatura,
             count(*) AS n
        FROM tint_staging_formula_itens i
       WHERE i.staging_formula_id = s.id
    ) it
   WHERE s.created_at >= v_desde AND s.created_at < v_ate
     AND s.cor_id IS NOT NULL AND s.cod_produto IS NOT NULL AND s.id_base IS NOT NULL
     AND (s.expected_item_count IS NULL OR s.expected_item_count = it.n)
     AND NOT EXISTS (SELECT 1 FROM tint_receita_versoes v
                      WHERE v.staging_formula_id = s.id AND v.evento = 'receita');
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  -- Sequência por chave = candidatas ∪ eventos JÁ gravados da mesma chave (âncora). Ordem
  -- (recebido_em, staging_formula_id) = a do DISTINCT ON do promote (created_at, id).
  -- Grava a candidata cujo anterior é: nada (1ª vez) ou outro hash. A saída tem hash NULL, então
  -- a chave que VOLTA é gravada mesmo com a receita idêntica — por isso IS DISTINCT FROM, não <>.
  INSERT INTO tint_receita_versoes
    (account, store_code, cor_id, cod_produto, id_base, subcolecao, personalizada, evento, nome_cor,
     id_embalagem, volume_final_ml, preco_final, itens, receita_hash, staging_formula_id, sync_run_id,
     agent_version, recebido_em)
  SELECT x.account, x.store_code, x.cor_id, x.cod_produto, x.id_base, x.subcolecao, x.personalizada,
         'receita', x.nome_cor, x.id_embalagem, x.volume_final_ml, x.preco_final, x.itens, x.receita_hash,
         x.staging_formula_id, x.sync_run_id, x.agent_version, x.recebido_em
    FROM (
      SELECT q.*,
             lag(q.evento)       OVER w AS evento_ant,
             lag(q.receita_hash) OVER w AS hash_ant
        FROM (
          SELECT c.*, true AS candidata, 'receita'::text AS evento FROM _trv_cand c
          UNION ALL
          SELECT v.staging_formula_id, v.account, v.store_code, v.cor_id, v.cod_produto, v.id_base,
                 v.subcolecao, v.personalizada, v.nome_cor, v.id_embalagem, v.volume_final_ml,
                 v.preco_final, v.sync_run_id, v.agent_version, v.recebido_em, v.itens, v.receita_hash,
                 false, v.evento
            FROM tint_receita_versoes v
           WHERE v.evento IN ('receita', 'saiu_da_fonte')
             AND EXISTS (SELECT 1 FROM _trv_cand c
                          WHERE c.account = v.account AND c.store_code = v.store_code
                            AND c.cor_id = v.cor_id AND c.cod_produto = v.cod_produto
                            AND c.id_base = v.id_base AND c.subcolecao = v.subcolecao
                            AND c.personalizada = v.personalizada)
        ) q
      WINDOW w AS (PARTITION BY q.account, q.store_code, q.cor_id, q.cod_produto, q.id_base,
                                q.subcolecao, q.personalizada
                   ORDER BY q.recebido_em, q.staging_formula_id NULLS FIRST)
    ) x
   WHERE x.candidata
     AND (x.evento_ant IS NULL OR x.hash_ant IS DISTINCT FROM x.receita_hash)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_receitas = ROW_COUNT;

  -- Saídas da fonte, por (account, store): o snapshot de chaves mais recente COMPLETO (todos os
  -- chunks presentes e aplicados — parcial apontaria saída falsa). Chave de 4 partes, sem
  -- subcoleção, igual ao tint_apply_keys_snapshot e ao filtro de fantasma do promote. Só conta
  -- versão recebida ANTES do snapshot (staging posterior é evidência nova de presença).
  FOR snap IN
    SELECT DISTINCT ON (k.account, k.store_code)
           k.account, k.store_code, k.snapshot_id, max(k.created_at) AS recebido
      FROM tint_keys_snapshots k
     WHERE k.entity = 'formulas'
     GROUP BY k.account, k.store_code, k.snapshot_id
    HAVING bool_and(k.aplicacao_status = 'aplicado')
       AND count(DISTINCT k.chunk_index) = max(k.total_chunks)
     ORDER BY k.account, k.store_code, max(k.generated_at) DESC, max(k.created_at) DESC
  LOOP
    DROP TABLE IF EXISTS _trv_snap;
    CREATE TEMP TABLE _trv_snap ON COMMIT DROP AS
    SELECT DISTINCT chave
      FROM tint_keys_snapshots, jsonb_array_elements_text(keys) AS chave
     WHERE snapshot_id = snap.snapshot_id AND entity = 'formulas';
    CREATE INDEX ON _trv_snap (chave);

    INSERT INTO tint_receita_versoes
      (account, store_code, cor_id, cod_produto, id_base, subcolecao, personalizada, evento, nome_cor,
       snapshot_id, motivo, recebido_em)
    SELECT u.account, u.store_code, u.cor_id, u.cod_produto, u.id_base, u.subcolecao, u.personalizada,
           'saiu_da_fonte', u.nome_cor, snap.snapshot_id,
           'chave ausente do snapshot de chaves aplicado', snap.recebido
      FROM (
        SELECT DISTINCT ON (v.cor_id, v.cod_produto, v.id_base, v.subcolecao, v.personalizada) v.*
          FROM tint_receita_versoes v
         WHERE v.account = snap.account AND v.store_code = snap.store_code
           AND v.evento IN ('receita', 'saiu_da_fonte')
         ORDER BY v.cor_id, v.cod_produto, v.id_base, v.subcolecao, v.personalizada,
                  v.recebido_em DESC, v.staging_formula_id DESC NULLS LAST
      ) u
     WHERE u.evento = 'receita'
       AND u.recebido_em < snap.recebido
       AND NOT EXISTS (SELECT 1 FROM _trv_snap s
                        WHERE s.chave = u.cor_id || '|' || u.cod_produto || '|' || u.id_base || '|'
                                        || CASE WHEN u.personalizada THEN 'true' ELSE 'false' END)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_saidas := v_saidas + v_n;
    v_snaps := v_snaps || jsonb_build_object('account', snap.account, 'store_code', snap.store_code,
                                             'snapshot_id', snap.snapshot_id, 'saidas', v_n);
  END LOOP;

  RETURN jsonb_build_object('desde', v_desde, 'ate', v_ate, 'candidatas', v_cand,
                            'receitas', v_receitas, 'saidas', v_saidas, 'snapshots', v_snaps);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.tint_receita_versoes_capturar() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_receita_versoes_append_only() FROM PUBLIC, anon, authenticated;

-- ── 3. O cron diário (20 min antes do purge das 05:23 UTC) ──────────────────────────────────────
SELECT cron.unschedule('tint-receita-versoes-diario')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-receita-versoes-diario');
SELECT cron.schedule(
  'tint-receita-versoes-diario',
  '3 5 * * *',
  $cron$ SET statement_timeout = '10min'; SELECT public.tint_receita_versoes_capturar(); $cron$
);

-- ── 4. A semente ────────────────────────────────────────────────────────────────────────────────
SELECT public.tint_receita_versoes_capturar();

-- ── PÓS-CONDIÇÃO (relida do catálogo e da tabela) ───────────────────────────────────────────────
DO $post$
DECLARE
  v_n_staging bigint;
  v_n_versao  bigint;
BEGIN
  IF to_regclass('public.tint_receita_versoes') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tint_receita_versoes'::regclass) THEN
    RAISE EXCEPTION 'P1 FALHOU: tint_receita_versoes ausente ou sem RLS';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.tint_receita_versoes'::regclass AND NOT tgisinternal
         AND tgname IN ('trg_tint_receita_versoes_append_only', 'trg_tint_receita_versoes_append_only_trunc')) <> 2 THEN
    RAISE EXCEPTION 'P2 FALHOU: triggers append-only ausentes — o histórico poderia ser reescrito';
  END IF;
  IF has_function_privilege('anon', 'public.tint_receita_versoes_capturar()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_receita_versoes_capturar()', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.tint_receita_versoes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.tint_receita_versoes', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.tint_receita_versoes', 'SELECT') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated executam a captura ou escrevem na tabela';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-receita-versoes-diario'
                  AND active AND schedule = '3 5 * * *'
                  AND command LIKE '%public.tint_receita_versoes_capturar()%') THEN
    RAISE EXCEPTION 'P4 FALHOU: cron tint-receita-versoes-diario ausente, inativo ou com comando errado';
  END IF;
  -- A semente pegou: nenhuma chave do staging (itens completos, >15 min) ficou sem versão.
  SELECT count(*) INTO v_n_staging
    FROM tint_staging_formulas s
   WHERE s.cor_id IS NOT NULL AND s.cod_produto IS NOT NULL AND s.id_base IS NOT NULL
     AND s.created_at < now() - interval '15 minutes'
     AND (s.expected_item_count IS NULL
          OR s.expected_item_count = (SELECT count(*) FROM tint_staging_formula_itens i WHERE i.staging_formula_id = s.id))
     AND NOT EXISTS (SELECT 1 FROM tint_receita_versoes v
                      WHERE v.evento = 'receita' AND v.account = s.account AND v.store_code = s.store_code
                        AND v.cor_id = s.cor_id AND v.cod_produto = s.cod_produto AND v.id_base = s.id_base
                        AND v.subcolecao = COALESCE(s.subcolecao, '') AND v.personalizada = s.personalizada);
  IF v_n_staging > 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: semente incompleta — % linha(s) de staging com chave sem versão', v_n_staging;
  END IF;
  SELECT count(*) INTO v_n_versao FROM tint_receita_versoes WHERE evento = 'receita';
  RAISE NOTICE 'receita-versoes OK: % chaves com versão', v_n_versao;
END
$post$;
