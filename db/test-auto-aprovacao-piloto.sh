#!/usr/bin/env bash
# Teste PG17 da auto-aprovação Sayerlack (piloto de veto) — migration 20260610150000.
# Aplica snapshot + 20260609150000 (alerta, base verbatim) + 20260610150000 e valida
# 15 asserts: aprova elegível (log + e-mail INFORMATIVO, não call-to-action), fusível
# OFF, delta>max, sem referência do grupo, referência stale >90d, item inválido,
# ajustado_humano, cooldown de falha, suspensão por alerta do Sentinela, ciclo
# não-normal, fora da janela de horário, idempotência, corrida com humano, delta por
# GRUPO (não por fornecedor), zumbi duplo (qtd_pendentes>1).
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5437
DATA="$(mktemp -d /tmp/pgtest-autoaprov.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-autoaprov.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres autoaprov_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d autoaprov_verify "$@"; }

RR="$(mktemp /tmp/snap-autoaprov.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ fix do fin_audit_trigger (snapshot stale tem a versão pré-20260524102500)…"
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
    INSERT INTO cron.job (jobid, jobname, schedule, command, active)
    VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ migrations: 20260609150000 (alerta) + 20260610150000 (auto-aprovação)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql" >/dev/null

echo "→ cenários + asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; v numeric; pid bigint; ref_id bigint; s text;
BEGIN
  -- ── setup: fusível ON, janela aberta (corte 23:59), referência de disparo do grupo G1 ──
  UPDATE company_config SET value = 'true'  WHERE key = 'reposicao_auto_aprovacao_ativa';
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';

  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em, omie_pedido_compra_numero)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE-2,8000,10,'disparado','normal', now()-interval '2 days','1234')
  RETURNING id INTO ref_id;

  -- ── B1: elegível → auto-aprova + log + e-mail INFORMATIVO (não call-to-action) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8400,10,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
  VALUES (pid,'111','SKU A',5,5,800,4000), (pid,'222','SKU B',4,4,1100,4400);

  PERFORM public.reposicao_alerta_pedido_minimo_tick();

  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B1 FALHOU: status=%, esperado aprovado_aguardando_disparo', s; END IF;
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'auto:sayerlack-v1' THEN RAISE EXCEPTION 'B1 FALHOU: aprovado_por=%', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 1 THEN RAISE EXCEPTION 'B1 FALHOU: % linhas de log, esperado 1', d; END IF;
  SELECT delta_pct INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 5.0 THEN RAISE EXCEPTION 'B1 FALHOU: delta_pct=%, esperado 5.0 (8400 vs 8000)', v; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 1 THEN RAISE EXCEPTION 'B1 FALHOU: % e-mails informativos, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 0 THEN RAISE EXCEPTION 'B1 FALHOU: call-to-action saiu junto do informativo'; END IF;
  RAISE NOTICE 'OK B1 — elegível auto-aprova: status + aprovado_por + log(delta 5%%) + informativo único';

  -- ── B2: idempotência — tick de novo não duplica nada ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log;
  IF d <> 1 THEN RAISE EXCEPTION 'B2 FALHOU: % logs, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'B2 FALHOU: % e-mails, esperado 1', d; END IF;
  RAISE NOTICE 'OK B2 — idempotência: tick repetido é no-op';

  -- ── B3: fusível OFF → NÃO aprova; e-mail call-to-action sai (fluxo atual) ──
  UPDATE company_config SET value = 'false' WHERE key = 'reposicao_auto_aprovacao_ativa';
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8200,8,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B3 FALHOU: fusível OFF aprovou (status=%)', s; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 1 THEN RAISE EXCEPTION 'B3 FALHOU: % call-to-action, esperado 1', d; END IF;
  UPDATE company_config SET value = 'true' WHERE key = 'reposicao_auto_aprovacao_ativa';
  RAISE NOTICE 'OK B3 — fusível OFF: comportamento atual intacto';

  -- ── B4: alerta já ativo + fusível religado → auto-aprova e manda informativo ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B4 FALHOU: status=%', s; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 2 THEN RAISE EXCEPTION 'B4 FALHOU: % informativos, esperado 2', d; END IF;
  RAISE NOTICE 'OK B4 — alerta ativo + fusível religado: aprova e informa (ramo NOT FOUND)';

  -- ── B5: delta > máx → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,12000,9,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B5 FALHOU: delta 50%% aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B5 — delta 50%% > máx 30%%: fica humano';

  -- ── B6: grupo SEM referência de disparo → não aprova (primeira compra é humana) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G9',CURRENT_DATE,8000,5,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B6 FALHOU: grupo sem referência aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B6 — delta por GRUPO: G9 sem disparo prévio fica humano (referência do G1 não vale)';

  -- ── B7: referência stale (>90d) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em, omie_pedido_compra_numero)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G8',CURRENT_DATE-100,8000,5,'disparado','normal', now()-interval '100 days','999');
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G8',CURRENT_DATE,8000,5,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B7 FALHOU: referência de 100d valeu'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B7 — referência stale (>90d) não vale';

  -- ── B8: item inválido (preço 0) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8100,2,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
  VALUES (pid,'333','SKU C',5,5,0,0);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B8 FALHOU: item preço-0 aprovou'; END IF;
  DELETE FROM pedido_compra_item WHERE pedido_id = pid;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B8 — item com preço 0 fica humano (guard de disparo barraria)';

  -- ── B9: ajustado_humano → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8050,2,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha, ajustado_humano)
  VALUES (pid,'444','SKU D',5,5,1610,8050,true);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B9 FALHOU: pedido ajustado por humano aprovou'; END IF;
  DELETE FROM pedido_compra_item WHERE pedido_id = pid;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B9 — ajuste humano = decisão humana';

  -- ── B10: cooldown de falha — auto-aprovado recente do fornecedor em falha_envio ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, aprovado_em, aprovado_por)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G7',CURRENT_DATE-1,5000,3,'falha_envio','normal', now()-interval '12 hours','auto:sayerlack-v1');
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8150,4,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B10 FALHOU: cooldown de falha não segurou'; END IF;
  UPDATE pedido_compra_sugerido SET atualizado_em = now() - interval '3 days'
  WHERE fornecedor_nome='RENNER SAYERLACK S/A' AND status='falha_envio';
  RAISE NOTICE 'OK B10 — falha recente de auto-aprovado suspende o fornecedor 48h';

  -- ── B11: alerta ativo do Sentinela (reposição) → suspende ──
  INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
  VALUES ('oben','data_health_reposicao_disparo','critico','vigia acusando');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B11 FALHOU: aprovou com o vigia acusando'; END IF;
  UPDATE fin_alertas SET dismissed_at = now() WHERE tipo='data_health_reposicao_disparo';
  RAISE NOTICE 'OK B11 — autonomia não roda com alerta ativo de reposição';

  -- ── B12: fora da janela de horário (corte já passou) → não aprova ──
  UPDATE company_config SET value = '00:01' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B12 FALHOU: aprovou fora da janela'; END IF;
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  RAISE NOTICE 'OK B12 — fora da janela (corte passou) espera o dia seguinte';

  -- ── B13: tipo_ciclo não-normal → não aprova ──
  UPDATE pedido_compra_sugerido SET tipo_ciclo = 'oportunidade_promo' WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B13 FALHOU: ciclo oportunidade aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET tipo_ciclo = 'normal' WHERE id = pid;
  RAISE NOTICE 'OK B13 — oportunidade/promoção é decisão humana';

  -- ── B14: zumbi duplo (2 pendentes da mesma identidade) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE-1,7900,4,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM pedido_compra_sugerido
  WHERE fornecedor_nome='RENNER SAYERLACK S/A' AND grupo_codigo='G1'
    AND status='aprovado_aguardando_disparo' AND aprovado_por='auto:sayerlack-v1'
    AND id IN (pid, (SELECT max(id) FROM pedido_compra_sugerido WHERE grupo_codigo='G1' AND status like 'pendente%'));
  IF d <> 0 THEN RAISE EXCEPTION 'B14 FALHOU: aprovou com identidade duplicada (zumbi)'; END IF;
  DELETE FROM pedido_compra_sugerido WHERE grupo_codigo='G1' AND status='pendente_aprovacao' AND data_ciclo=CURRENT_DATE-1;
  RAISE NOTICE 'OK B14 — identidade com 2 pendentes (zumbi) = estado anômalo, fica humano';

  -- ── B15: corrida com humano — pedido já aprovado entre avaliar e o claim ──
  -- Simulação: aprovação humana ANTES do tick; o claim (WHERE status=pendente) não toca.
  UPDATE pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='founder@colacor', status='aprovado_aguardando_disparo'
  WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'founder@colacor' THEN RAISE EXCEPTION 'B15 FALHOU: máquina sobrescreveu aprovação humana (%)', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 0 THEN RAISE EXCEPTION 'B15 FALHOU: logou aprovação que não fez'; END IF;
  RAISE NOTICE 'OK B15 — claim condicional: humano primeiro vence, sem log fantasma';

  RAISE NOTICE '✅ TODOS OS 15 ASSERTS DA AUTO-APROVAÇÃO PASSARAM';
END $$;
SQL

echo "✅ test-auto-aprovacao-piloto: OK"
