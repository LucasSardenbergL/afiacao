-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — o promote PARA de ressuscitar fórmula de cor que a FONTE retirou
-- [money-path]
--
-- O INCIDENTE (medido em prod via psql-ro, 2026-10-13):
--   Às 12:15 UTC havia 26.180 fórmulas ATIVAS cuja chave-fonte (cor|produto|base|personalizada)
--   NÃO está no snapshot de chaves mais recente da fonte — 6.545 cores. Todas as 26.180 eram a
--   canônica da chave na v_tint_formula_canonica e todas com receita_valida; 9.164 com base
--   disponível, ou seja com PREÇO FINAL no balcão (408 cores, 9 produtos). O app cotava cor que
--   o SayerSystem não tem mais. 3.052 das 3.099 chaves-fonte do watchdog S2 não aparecem em
--   NENHUM snapshot desde 2026-09-14: não é cor que "saiu e voltou", é cor retirada há semanas.
--
-- O MECANISMO (o ciclo diário):
--   1. O apply do snapshot (tint_apply_keys_snapshot, ~03:13) desativa a fórmula ausente da fonte
--      — desativada_em = now(), desativada_motivo NULL. Desativa 2.600 a 6.300 por dia.
--   2. Ao longo do dia, o promote (tint_promote_sync_run) é chamado a cada ~10 min. O
--      `_formulas_latest` relê o staging LATEST de TODAS as cores dos pares (produto, base) que o
--      run tocou, ACROSS TODOS OS RUNS — e o purge nunca apaga o latest. O staging antigo da cor
--      retirada volta a ser expandido, e o upsert faz `desativada_em = NULL`: REATIVA.
--   3. No dia seguinte o apply desativa de novo. Repete.
--   Medido: os promotes de 10:58 a 12:16 de 13/10 coincidem minuto a minuto com o updated_at das
--   26.180 fantasmas (10:53-12:15). A guarda de 24/09 (20260924120000) não cobre isto: ela protege
--   só a linha CARIMBADA pela Fase 5 (desativada_motivo NOT NULL), e registrou explicitamente que
--   "linha desativada pelo SNAPSHOT (motivo NULL) continua reativando como antes".
--
-- A DECISÃO: o snapshot é a declaração da própria FONTE sobre o catálogo dela num instante. Um
--   staging RECEBIDO ANTES do último snapshot aplicado, de uma chave que esse snapshot NÃO contém,
--   é estado SUPERADO — reexpandi-lo é promover o passado como presente. Essa linha sai do
--   _expand_uniq antes do upsert (mesmo ponto e mesmo padrão do filtro do tombstone de 24/09): não
--   reativa a oficial desativada e não cria oficial nova. As DEMAIS chaves do run promovem normal.
--
--   O CRITÉRIO É TEMPORAL, não só de presença — e é isso que impede o falso positivo:
--     · staging RECEBIDO DEPOIS do snapshot é evidência NOVA de que a cor existe (a fonte a
--       re-adicionou depois do retrato) → passa, mesmo ausente do snapshot.
--     · chave PRESENTE no snapshot → passa sempre, qualquer que seja a idade do staging.
--   Bloquear por presença pura atrasaria em até 24h toda cor NOVA da fonte (o snapshot é diário,
--   o promote é contínuo) — trocaria um furo de venda por um furo de catálogo.
--
--   RELÓGIO: os dois lados no relógio do SERVIDOR (staging.created_at × snapshot.created_at do
--   último chunk). O generated_at do snapshot é o relógio do CONECTOR; comparar relógios distintos
--   abriria uma faixa de skew em que a decisão dependeria de drift de clock.
--
--   SNAPSHOT DE REFERÊNCIA: o último APLICADO (aplicacao_status='aplicado') da mesma account/store.
--   Não o último recebido: o apply já validou completude (todos os chunk_index) e ordem; um snapshot
--   recebido mas não aplicado pode estar incompleto, e usá-lo apagaria do promote chaves que a fonte
--   tem. Sem snapshot aplicado nenhum (instalação nova), o filtro não age — comportamento anterior.
--
--   CHAVE: o mesmo formato de 4 partes do tint_apply_keys_snapshot (cor_id|cod_produto|
--   id_base_sayersystem|personalizada, ids SAYER via tint_produtos/tint_bases, SEM embalagem). Se os
--   dois divergirem, uma cor presente pareceria ausente — a prova casa as duas montagens.
--
-- O QUE NÃO FAZ: não desativa as fantasmas JÁ ATIVAS. Isso é papel do apply do snapshot, que roda
--   ~03:13 e é o único writer de desativação por ausência; duplicar a regra aqui seria uma 2ª cópia
--   do predicado. Depois do próximo apply, elas param de voltar. Contagem visível (nunca silencioso):
--   tint_sync_runs.metadata->>'fantasmas_fonte_barradas' + campo homônimo no retorno do RPC.
--
-- COMO APLICA: reescreve a partir do corpo VIVO (docs/agent/database.md § "Trocar o gate de uma RPC
--   grande") — pg_get_functiondef + 4 replace, cada um com guard que ABORTA se a âncora não casar
--   EXATAMENTE 1 vez; guard de no-op e pós-condição que relê o catálogo. Idempotente (re-apply =
--   NOTICE). `CREATE OR REPLACE` via EXECUTE preserva o ACL (REVOKE reemitido por cinto).
--   Pré-flight 2026-10-13: o corpo vivo é a v6 + 5b#1 (marca v_tombstones_fase5 presente; 1036 linhas).
--
-- APLICAR: bun run db:aplicar supabase/migrations/20261013150000_tint_promote_nao_ressuscita_fantasma.sql
-- Prova: db/test-tint-promote-fantasma.sh (PG17, corpo vivo do promote, falsificação).
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $mig$
DECLARE
  v_oid   oid;
  v_def   text;
  v_novo  text;
  v_marca constant text := 'v_fantasmas_fonte';
  a1 constant text := '  v_tombstones_fase5 int := 0;  -- 5b#1 (20260924120000)';
  n1 constant text := '  v_tombstones_fase5 int := 0;  -- 5b#1 (20260924120000)' || E'\n' ||
                      '  v_fantasmas_fonte int := 0;   -- (20261013150000)' || E'\n' ||
                      '  v_snap_id uuid;' || E'\n' ||
                      '  v_snap_recebido timestamptz;';
  a2 constant text := '  GET DIAGNOSTICS v_tombstones_fase5 = ROW_COUNT;';
  n2 constant text :=
    '  GET DIAGNOSTICS v_tombstones_fase5 = ROW_COUNT;' || E'\n' ||
    E'\n' ||
    '  -- (20261013150000) A FONTE RETIROU A COR: o staging LATEST que o _formulas_latest reexpande' || E'\n' ||
    '  -- (across TODOS os runs) pode ser de uma cor que o último snapshot de chaves APLICADO não' || E'\n' ||
    '  -- contém. Se esse staging foi RECEBIDO ANTES do snapshot, ele é estado superado: reexpandi-lo' || E'\n' ||
    '  -- reativava a fórmula que o apply acabara de desativar (26.180 fantasmas precificáveis em' || E'\n' ||
    '  -- 13/10). Staging recebido DEPOIS do snapshot é evidência nova de presença e passa; chave' || E'\n' ||
    '  -- presente no snapshot passa sempre. Relógio do SERVIDOR nos dois lados (created_at).' || E'\n' ||
    '  SELECT ks.snapshot_id, max(ks.created_at)' || E'\n' ||
    '    INTO v_snap_id, v_snap_recebido' || E'\n' ||
    '    FROM tint_keys_snapshots ks' || E'\n' ||
    '   WHERE ks.account = v_account AND ks.store_code = v_store AND ks.entity = ''formulas''' || E'\n' ||
    '     AND ks.aplicacao_status = ''aplicado''' || E'\n' ||
    '   GROUP BY ks.snapshot_id' || E'\n' ||
    '   ORDER BY max(ks.aplicado_em) DESC NULLS LAST, max(ks.created_at) DESC' || E'\n' ||
    '   LIMIT 1;' || E'\n' ||
    E'\n' ||
    '  IF v_snap_id IS NOT NULL THEN' || E'\n' ||
    '    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS' || E'\n' ||
    '    SELECT DISTINCT chave' || E'\n' ||
    '      FROM tint_keys_snapshots, jsonb_array_elements_text(keys) AS chave' || E'\n' ||
    '     WHERE snapshot_id = v_snap_id AND entity = ''formulas'';' || E'\n' ||
    '    CREATE INDEX ON _snap_fonte (chave);' || E'\n' ||
    E'\n' ||
    '    -- Chave no MESMO formato de 4 partes do tint_apply_keys_snapshot (sem embalagem).' || E'\n' ||
    '    DELETE FROM _expand_uniq eu' || E'\n' ||
    '    USING tint_staging_formulas sf, tint_produtos pr, tint_bases bs' || E'\n' ||
    '    WHERE sf.id = eu.staging_formula_id' || E'\n' ||
    '      AND sf.created_at < v_snap_recebido' || E'\n' ||
    '      AND pr.id = eu.produto_id' || E'\n' ||
    '      AND bs.id = eu.base_id' || E'\n' ||
    '      AND NOT EXISTS (' || E'\n' ||
    '            SELECT 1 FROM _snap_fonte s' || E'\n' ||
    '             WHERE s.chave = eu.cor_id || ''|'' || pr.cod_produto || ''|'' || bs.id_base_sayersystem || ''|''' || E'\n' ||
    '                             || (CASE WHEN eu.personalizada THEN ''true'' ELSE ''false'' END));' || E'\n' ||
    '    GET DIAGNOSTICS v_fantasmas_fonte = ROW_COUNT;' || E'\n' ||
    '  END IF;';
  a3 constant text := '''tombstones_fase5_preservados'', v_tombstones_fase5)';
  n3 constant text := '''tombstones_fase5_preservados'', v_tombstones_fase5, ''fantasmas_fonte_barradas'', v_fantasmas_fonte)';
  a4 constant text := '    ''tombstones_fase5_preservados'', v_tombstones_fase5,';
  n4 constant text := '    ''tombstones_fase5_preservados'', v_tombstones_fase5,' || E'\n' ||
                      '    ''fantasmas_fonte_barradas'', v_fantasmas_fonte,';
  v_ancoras text[] := ARRAY[a1, a2, a3, a4];
  v_novos   text[] := ARRAY[n1, n2, n3, n4];
  i int;
  v_n int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fantasma-fonte ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  v_def := pg_get_functiondef(v_oid);

  IF position(v_marca in v_def) > 0 THEN
    RAISE NOTICE 'fantasma-fonte já aplicada (marca % presente) — no-op', v_marca;
    RETURN;
  END IF;

  -- Pré-flight de versão: esta reescrita pressupõe a v6 + 5b#1. Outra versão viva = divergência
  -- repo×prod → PARE e compare com pg_get_functiondef antes de seguir.
  IF position('v_tombstones_fase5' in v_def) = 0 OR position('CREATE TEMP TABLE _fl_culpa' in v_def) = 0 THEN
    RAISE EXCEPTION 'fantasma-fonte ABORTADA: tint_promote_sync_run vivo NÃO é a v6 + 5b#1 (20260924120000)';
  END IF;
  -- As colunas que o filtro lê precisam existir: sem o apply assíncrono (aplicacao_status) não há
  -- como saber qual snapshot é completo, e o filtro apagaria chaves que a fonte tem.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='tint_keys_snapshots'
                    AND column_name='aplicacao_status') THEN
    RAISE EXCEPTION 'fantasma-fonte ABORTADA: tint_keys_snapshots.aplicacao_status ausente — sem ela o snapshot de referência não é confiável';
  END IF;

  v_novo := v_def;
  FOR i IN 1 .. array_length(v_ancoras, 1) LOOP
    v_n := (length(v_novo) - length(replace(v_novo, v_ancoras[i], ''))) / length(v_ancoras[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'fantasma-fonte ABORTADA: âncora % casou % vez(es) no corpo vivo (esperado 1): [%]', i, v_n, v_ancoras[i];
    END IF;
    v_novo := replace(v_novo, v_ancoras[i], v_novos[i]);
  END LOOP;

  IF v_novo = v_def THEN
    RAISE EXCEPTION 'fantasma-fonte ABORTADA: replace foi no-op';
  END IF;

  EXECUTE v_novo;

  -- Pós-condição lida do CATÁLOGO.
  v_def := pg_get_functiondef(v_oid);
  IF position('AND sf.created_at < v_snap_recebido' in v_def) = 0
     OR position('''fantasmas_fonte_barradas'', v_fantasmas_fonte)' in v_def) = 0
     OR position('''fantasmas_fonte_barradas'', v_fantasmas_fonte,' in v_def) = 0
     OR position('AND tf.desativada_motivo IS NOT NULL;' in v_def) = 0 THEN
    RAISE EXCEPTION 'fantasma-fonte ABORTADA: pós-condição falhou — corpo gravado não contém o filtro/contador (ou perdeu o filtro do tombstone)';
  END IF;
END $mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;

COMMIT;

SELECT 'tint_promote_sync_run fantasma-fonte OK' AS status;
