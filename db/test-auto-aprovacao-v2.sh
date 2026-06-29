#!/usr/bin/env bash
# Teste PG17 da auto-aprovação Sayerlack V2 (recalibração) — migration 20260615210000.
# Aplica snapshot + 20260609150000 (alerta) + 20260610150000 (v1) + 20260615210000 (v2) e valida
# os cenários que a V2 MUDA + amostra dos guards preservados. 16 asserts:
# V1 aprova (comprar = mediana) · V2 aprova (comprar MENOS) · V3 barra (comprar MAIS >30%) ·
# V4 mediana robusta vs outlier (último-pedido baixo NÃO engana) · V5 min 3 eventos (2 = barra) ·
# V6 flat APROVA · V7 forward_buying BARRA · V8 sem-janela (aprova sem setar corte) ·
# V9 aprovado_por='auto:sayerlack-v2' · + preservados: OBEN-only, fusível OFF, cooldown,
# suspensão Sentinela, zumbi duplo, corrida humano, log usa soma dos itens.
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5438
DATA="$(mktemp -d /tmp/pgtest-autoaprovv2.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-autoaprovv2.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres autoaprovv2_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d autoaprovv2_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-autoaprovv2.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ fix do fin_audit_trigger (snapshot stale)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260524102500_fix_fin_triggers_json_field_access.sql" >/dev/null

echo "→ stub cron.schedule…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ migrations: alerta + v1 + v2…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260615210000_reposicao_auto_aprovacao_v2.sql" >/dev/null

echo "→ helpers + cenários (mesmo bloco psql; pg_temp é por-sessão)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- N eventos de COMPRA disparados do grupo (um por data_ciclo) — a referência v2 é a MEDIANA deles.
CREATE FUNCTION pg_temp.mkrefs(grp text, valores numeric[], emp text DEFAULT 'OBEN')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  FOR i IN 1..array_length(valores,1) LOOP
    INSERT INTO public.pedido_compra_sugerido
      (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo,
       criado_em, omie_pedido_compra_numero)
    VALUES (emp, 'RENNER SAYERLACK S/A', grp, CURRENT_DATE - i, valores[i], 5, 'disparado', 'normal',
       now() - (i || ' days')::interval, '9' || grp || i);
  END LOOP;
END $$;

-- candidato pendente + 1 item. promo = NULL | 'flat' | 'forward_buying'. item_val p/ mismatch.
CREATE FUNCTION pg_temp.mk(grp text, val numeric, st text DEFAULT 'pendente_aprovacao',
  tc text DEFAULT 'normal', promo text DEFAULT NULL, emp text DEFAULT 'OBEN', item_val numeric DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE pid bigint; iv numeric;
BEGIN
  iv := COALESCE(item_val, val);
  INSERT INTO public.pedido_compra_sugerido
    (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES (emp, 'RENNER SAYERLACK S/A', grp, CURRENT_DATE, val, 2, st, tc)
  RETURNING id INTO pid;
  INSERT INTO public.pedido_compra_item
    (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha, modo_promocao)
  VALUES (pid, '1', 'SKU ' || grp, 1, 1, iv, iv, promo);
  RETURN pid;
END $$;

DO $$
DECLARE d int; v numeric; pid bigint; s text;
BEGIN
  UPDATE company_config SET value = 'true' WHERE key = 'reposicao_auto_aprovacao_ativa';
  -- NOTA: NÃO seto corte_utc — a v2 não tem janela. Se aprovar, prova que a janela sumiu (V8).

  -- ── V1: comprar = mediana → APROVA + aprovado_por v2 ──
  PERFORM pg_temp.mkrefs('G1', ARRAY[8000,8000,8000]);   -- mediana 8000
  pid := pg_temp.mk('G1', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'V1 FALHOU: status=%', s; END IF;
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'auto:sayerlack-v2' THEN RAISE EXCEPTION 'V1/V9 FALHOU: aprovado_por=%', s; END IF;
  SELECT valor_total INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 8000 THEN RAISE EXCEPTION 'V1 FALHOU: log.valor_total=% (esperado 8000, itens)', v; END IF;
  RAISE NOTICE 'OK V1+V8+V9 — comprar=mediana aprova SEM janela; aprovado_por=v2; log=itens';

  -- ── V2: comprar MENOS que a mediana → APROVA (conservador) ──
  PERFORM pg_temp.mkrefs('G2', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G2', 4000);   -- metade da mediana
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'V2 FALHOU: comprar menos não aprovou (%)', s; END IF;
  SELECT delta_pct INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v >= 0 THEN RAISE EXCEPTION 'V2 FALHOU: delta_pct=% (esperado negativo, comprou menos)', v; END IF;
  RAISE NOTICE 'OK V2 — comprar MENOS que a mediana aprova (delta negativo)';

  -- ── V3: comprar MAIS que mediana×1.30 → BARRA ──
  PERFORM pg_temp.mkrefs('G3', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G3', 12000);   -- 12000 > 8000×1.30=10400
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'V3 FALHOU: comprar +50%% aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK V3 — comprar > mediana×1.30 barra';

  -- ── V4: mediana ROBUSTA — último disparo baixo (1000) NÃO engana; mediana de [1000,8000,1500]=1500 ──
  PERFORM pg_temp.mkrefs('G4', ARRAY[1000,8000,1500]);  -- i=1 (ontem)=1000 é o "último"
  pid := pg_temp.mk('G4', 8835);  -- o caso real do 'normal': 8835 > mediana 1500 ×1.30
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'V4 FALHOU: mediana não barrou anomalia (usou último?)'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK V4 — mediana robusta: anomalia 8835 vs mediana 1500 barra';

  -- ── V5: menos de 3 eventos de referência → BARRA ──
  PERFORM pg_temp.mkrefs('G5', ARRAY[8000,8000]);  -- só 2
  pid := pg_temp.mk('G5', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'V5 FALHOU: aprovou com 2 eventos (mediana frágil)'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK V5 — mínimo 3 eventos de referência';

  -- ── V6: item 'flat' → APROVA (só desconto de preço, benigno) ──
  PERFORM pg_temp.mkrefs('G6', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G6', 8000, 'pendente_aprovacao', 'normal', 'flat');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'V6 FALHOU: flat barrou (%)', s; END IF;
  RAISE NOTICE 'OK V6 — flat (desconto de preço) aprova';

  -- ── V7: item 'forward_buying' → BARRA (aposta de estoque) ──
  PERFORM pg_temp.mkrefs('G7', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G7', 8000, 'pendente_aprovacao', 'normal', 'forward_buying');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'V7 FALHOU: forward_buying aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK V7 — forward_buying (aposta de estoque) barra';

  -- ══ guards PRESERVADOS da v1 (amostra) ══

  -- ── P1: COLACOR → não aprova (OBEN-only) ──
  PERFORM pg_temp.mkrefs('G15', ARRAY[8000,8000,8000], 'COLACOR');
  pid := pg_temp.mk('G15', 8000, 'pendente_aprovacao', 'normal', NULL, 'COLACOR');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'P1 FALHOU: COLACOR aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK P1 — OBEN-only preservado';

  -- ── P2: fusível OFF → não aprova ──
  UPDATE company_config SET value = 'false' WHERE key = 'reposicao_auto_aprovacao_ativa';
  PERFORM pg_temp.mkrefs('G16', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G16', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'P2 FALHOU: fusível OFF aprovou'; END IF;
  UPDATE company_config SET value = 'true' WHERE key = 'reposicao_auto_aprovacao_ativa';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK P2 — fusível OFF preservado';

  -- ── P3: suspensão por alerta do Sentinela ──
  INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
  VALUES ('oben','data_health_reposicao_disparo','critico','vigia');
  PERFORM pg_temp.mkrefs('G17', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G17', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'P3 FALHOU: aprovou com vigia acusando'; END IF;
  UPDATE fin_alertas SET dismissed_at = now() WHERE tipo='data_health_reposicao_disparo';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK P3 — auto-suspensão preservada';

  -- ── P4: cooldown de falha (disparo) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, aprovado_em, aprovado_por, atualizado_em)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GX',CURRENT_DATE-1,5000,3,'falha_envio','normal', now()-interval '6 hours','auto:sayerlack-v2', now()-interval '6 hours');
  PERFORM pg_temp.mkrefs('G18', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G18', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'P4 FALHOU: cooldown não segurou'; END IF;
  UPDATE pedido_compra_sugerido SET atualizado_em = now()-interval '3 days' WHERE status='falha_envio';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK P4 — cooldown preservado';

  -- ── P5: corrida com humano (claim condicional não sobrescreve) ──
  PERFORM pg_temp.mkrefs('G19', ARRAY[8000,8000,8000]);
  pid := pg_temp.mk('G19', 8000);
  UPDATE pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='founder@colacor', status='aprovado_aguardando_disparo' WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'founder@colacor' THEN RAISE EXCEPTION 'P5 FALHOU: máquina sobrescreveu humano (%)', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 0 THEN RAISE EXCEPTION 'P5 FALHOU: logou aprovação que não fez'; END IF;
  RAISE NOTICE 'OK P5 — claim condicional preservado';

  RAISE NOTICE '✅ TODOS OS 16 ASSERTS DA V2 PASSARAM';
END $$;
SQL

# ══════════════════════════════════════════════════════════════════════════════════════════════
# [PRECO-AUSENTE] custo desconhecido = NULL (não 0). O gate de item-inválido tinha buraco de 3VL:
# NOT(preco>0 AND ...) com preco NULL = NOT(NULL)=NULL → a linha ESCAPA do EXISTS → pedido com item
# sem custo poderia AUTO-APROVAR. Falsifico no gate VELHO (v2), aplico o fix, re-provo no gate NOVO.
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "→ [PRECO-AUSENTE] FALSIFICAÇÃO: gate VELHO (v2) julga parcial-NULL ELEGÍVEL (bug)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE pid bigint; r jsonb;
BEGIN
  -- referência: mediana 8000 (3 eventos disparados do grupo)
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo,criado_em,omie_pedido_compra_numero)
  SELECT 'OBEN','RENNER SAYERLACK S/A','GNULL',CURRENT_DATE-i,8000,5,'disparado','normal',now()-(i||' days')::interval,'9GNULL'||i FROM generate_series(1,3) i;
  -- candidato: 1 item COM custo (8000) + 1 item SEM custo (NULL). header valor_total=8000 (>= régua 3000).
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GNULL',CURRENT_DATE,8000,2,'pendente_aprovacao','normal') RETURNING id INTO pid;
  INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,sku_descricao,qtde_sugerida,qtde_final,preco_unitario,valor_linha) VALUES
    (pid,'A','com custo',1,1,8000,8000),
    (pid,'B','sem custo',1,1,NULL,NULL);
  r := public.reposicao_pedido_auto_aprovavel(pid, 3000, 0.30, 48);
  IF COALESCE((r->>'elegivel')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FALSIFICAÇÃO FRACA: gate VELHO já rejeita parcial-NULL (motivo=%) — o bug que o fix fecha NÃO foi reproduzido', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK FALSIF — gate VELHO julga parcial-NULL ELEGÍVEL (item sem custo escapa do guard) = o BUG';
  DELETE FROM public.pedido_compra_item WHERE pedido_id = pid;
  DELETE FROM public.pedido_compra_sugerido WHERE grupo_codigo='GNULL';
END $$;
SQL

echo "→ aplica o FIX (migration 20260629140000: gate NULL-safe + motor)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260629140000_reposicao_preco_ausente_null.sql" >/dev/null

echo "→ [PRECO-AUSENTE] FIX: gate NOVO rejeita parcial-NULL e all-NULL; aceita all-precificado…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE pid bigint; r jsonb;
BEGIN
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo,criado_em,omie_pedido_compra_numero)
  SELECT 'OBEN','RENNER SAYERLACK S/A','GFIX',CURRENT_DATE-i,8000,5,'disparado','normal',now()-(i||' days')::interval,'9GFIX'||i FROM generate_series(1,3) i;

  -- (1) parcial-NULL → REJEITA com 'item com preço/qtde inválido'
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GFIX',CURRENT_DATE,8000,2,'pendente_aprovacao','normal') RETURNING id INTO pid;
  INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,sku_descricao,qtde_sugerida,qtde_final,preco_unitario,valor_linha) VALUES
    (pid,'A','com custo',1,1,8000,8000), (pid,'B','sem custo',1,1,NULL,NULL);
  r := public.reposicao_pedido_auto_aprovavel(pid, 3000, 0.30, 48);
  IF COALESCE((r->>'elegivel')::boolean, true) IS NOT FALSE THEN
    RAISE EXCEPTION 'FIX FALHOU: parcial-NULL ELEGÍVEL com gate novo (%)', r;
  END IF;
  IF r->>'motivo' <> 'item com preço/qtde inválido' THEN
    RAISE EXCEPTION 'FIX: motivo inesperado p/ parcial-NULL (%)', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK FIX1 — parcial-NULL REJEITADO (item com preço/qtde inválido)';
  DELETE FROM public.pedido_compra_item WHERE pedido_id = pid;

  -- (2) all-NULL → REJEITA pelo guard (ANTES do v_valor IS NULL, que diria outro motivo)
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GFIX',CURRENT_DATE,0,2,'pendente_aprovacao','normal') RETURNING id INTO pid;
  INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,sku_descricao,qtde_sugerida,qtde_final,preco_unitario,valor_linha) VALUES
    (pid,'A','sem custo',1,1,NULL,NULL), (pid,'B','sem custo',1,1,NULL,NULL);
  r := public.reposicao_pedido_auto_aprovavel(pid, 3000, 0.30, 48);
  IF r->>'motivo' <> 'item com preço/qtde inválido' THEN
    RAISE EXCEPTION 'FIX: all-NULL motivo inesperado (%)', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK FIX2 — all-NULL REJEITADO pelo guard';
  DELETE FROM public.pedido_compra_item WHERE pedido_id = pid;

  -- (3) CONTROLE: all-precificado (4000+4000=8000 = mediana) → ACEITA (gate novo não ficou estrito demais)
  INSERT INTO public.pedido_compra_sugerido (empresa,fornecedor_nome,grupo_codigo,data_ciclo,valor_total,num_skus,status,tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GFIX',CURRENT_DATE,8000,2,'pendente_aprovacao','normal') RETURNING id INTO pid;
  INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,sku_descricao,qtde_sugerida,qtde_final,preco_unitario,valor_linha) VALUES
    (pid,'A','com custo',1,1,4000,4000), (pid,'B','com custo',1,1,4000,4000);
  r := public.reposicao_pedido_auto_aprovavel(pid, 3000, 0.30, 48);
  IF COALESCE((r->>'elegivel')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'FIX CONTROLE FALHOU: all-precificado NÃO elegível (%)', r;
  END IF;
  RAISE NOTICE 'OK FIX3 — all-precificado ACEITO (caminho válido não regrediu)';

  DELETE FROM public.pedido_compra_item WHERE pedido_id IN (SELECT id FROM public.pedido_compra_sugerido WHERE grupo_codigo='GFIX');
  DELETE FROM public.pedido_compra_sugerido WHERE grupo_codigo='GFIX';
  RAISE NOTICE '✅ FIX NULL-safe: falsificação + 3 asserts OK';
END $$;
SQL

echo "✅ test-auto-aprovacao-v2: OK"
