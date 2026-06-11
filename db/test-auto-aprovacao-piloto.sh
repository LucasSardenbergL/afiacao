#!/usr/bin/env bash
# Teste PG17 da auto-aprovação Sayerlack (piloto de veto) — migration 20260610150000.
# Aplica snapshot + 20260609150000 (alerta, base verbatim) + 20260610150000 e valida 24
# asserts. 15 originais (aprova elegível c/ e-mail INFORMATIVO; idempotência; fusível OFF;
# fusível religado; delta>max; grupo sem ref; ref stale>90d; item inválido; ajustado_humano;
# cooldown; suspensão Sentinela; ciclo não-normal; fora-de-janela; zumbi duplo; corrida humano)
# + 9 dos fixes do Codex challenge xhigh (2026-06-11): P1.1 OBEN-only · P1.2 valor pela soma
# dos ITENS (mismatch cabeçalho) · P1.3 modo_promocao · P1.4 referência agregada colapsa split
# · P1.5 delta_max '30'=3000% desliga · P1.6 raio cumulativo (máx 1/grupo) · P2.7 cooldown de
# PORTAL · P2.8 corte '24:00' desliga · P2.11 NaN/Infinity em item.
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

echo "→ helpers de fixture…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- referência de COMPRA do grupo (disparada, dias_atras dias atrás). A função soma valor_total
-- das compras reais do grupo na data_ciclo mais recente — esta linha é essa referência.
CREATE FUNCTION pg_temp.mkref(grp text, val numeric, dias_atras int DEFAULT 2, emp text DEFAULT 'OBEN')
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE pid bigint;
BEGIN
  INSERT INTO public.pedido_compra_sugerido
    (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo,
     criado_em, omie_pedido_compra_numero)
  VALUES (emp, 'RENNER SAYERLACK S/A', grp, CURRENT_DATE - dias_atras, val, 5, 'disparado', 'normal',
     now() - (dias_atras || ' days')::interval, '9' || grp)
  RETURNING id INTO pid;
  RETURN pid;
END $$;

-- candidato pendente + 1 item. item_val permite mismatch cabeçalho≠itens (default = igual).
CREATE FUNCTION pg_temp.mk(grp text, val numeric, st text DEFAULT 'pendente_aprovacao',
  tc text DEFAULT 'normal', promo boolean DEFAULT false, emp text DEFAULT 'OBEN', item_val numeric DEFAULT NULL)
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
  VALUES (pid, '1', 'SKU ' || grp, 1, 1, iv, iv, CASE WHEN promo THEN 'forward_buying' ELSE NULL END);
  RETURN pid;
END $$;

-- cenários no MESMO bloco psql (pg_temp.* é por-sessão; helpers e DO precisam da mesma conexão)
DO $$
DECLARE d int; v numeric; pid bigint; pai bigint; s text;
BEGIN
  UPDATE company_config SET value = 'true'  WHERE key = 'reposicao_auto_aprovacao_ativa';
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';

  -- ── B1: elegível → auto-aprova + log(valor itens, delta) + e-mail INFORMATIVO ──
  PERFORM pg_temp.mkref('G1', 8000);
  pid := pg_temp.mk('G1', 8400);          -- 1 item de 8400; ref 8000 → delta 5%
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B1 FALHOU: status=%', s; END IF;
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'auto:sayerlack-v1' THEN RAISE EXCEPTION 'B1 FALHOU: aprovado_por=%', s; END IF;
  SELECT delta_pct INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 5.0 THEN RAISE EXCEPTION 'B1 FALHOU: delta_pct=%, esperado 5.0', v; END IF;
  SELECT valor_total INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 8400 THEN RAISE EXCEPTION 'B1 FALHOU: log.valor_total=%, esperado 8400 (itens)', v; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 1 THEN RAISE EXCEPTION 'B1 FALHOU: % informativos, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 0 THEN RAISE EXCEPTION 'B1 FALHOU: call-to-action saiu junto'; END IF;
  RAISE NOTICE 'OK B1 — elegível auto-aprova: log usa valor dos ITENS, informativo único';

  -- ── B2: idempotência ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log;
  IF d <> 1 THEN RAISE EXCEPTION 'B2 FALHOU: % logs', d; END IF;
  RAISE NOTICE 'OK B2 — idempotência';

  -- ── B3: fusível OFF → não aprova, sai call-to-action ──
  UPDATE company_config SET value = 'false' WHERE key = 'reposicao_auto_aprovacao_ativa';
  PERFORM pg_temp.mkref('G2', 8000);
  pid := pg_temp.mk('G2', 8200);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B3 FALHOU: fusível OFF aprovou'; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 1 THEN RAISE EXCEPTION 'B3 FALHOU: % call-to-action', d; END IF;
  UPDATE company_config SET value = 'true' WHERE key = 'reposicao_auto_aprovacao_ativa';
  RAISE NOTICE 'OK B3 — fusível OFF';

  -- ── B4: alerta já ativo + fusível religado → aprova e informa (ramo NOT FOUND) ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B4 FALHOU: status=%', s; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 2 THEN RAISE EXCEPTION 'B4 FALHOU: % informativos, esperado 2', d; END IF;
  RAISE NOTICE 'OK B4 — fusível religado, ramo NOT FOUND informa';

  -- ── B5: delta > máx → não aprova ──
  PERFORM pg_temp.mkref('G3', 8000);
  pid := pg_temp.mk('G3', 12000);          -- delta 50%
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B5 FALHOU: delta 50%% aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B5 — delta > 30%%';

  -- ── B6: grupo sem referência de disparo → não aprova ──
  pid := pg_temp.mk('G9', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B6 FALHOU: grupo sem ref aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B6 — grupo sem referência fica humano';

  -- ── B7: referência stale (>90d) → não aprova ──
  PERFORM pg_temp.mkref('G8', 8000, 100);   -- ref de 100 dias atrás
  pid := pg_temp.mk('G8', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B7 FALHOU: ref de 100d valeu'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B7 — referência stale (>90d) não vale';

  -- ── B8: item inválido (preço 0) → não aprova ──
  PERFORM pg_temp.mkref('G4', 8000);
  pid := pg_temp.mk('G4', 8100);
  UPDATE pedido_compra_item SET preco_unitario = 0, valor_linha = 0 WHERE pedido_id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B8 FALHOU: item preço-0 aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B8 — item com preço 0 fica humano';

  -- ── B9: ajustado_humano → não aprova ──
  PERFORM pg_temp.mkref('G5', 8000);
  pid := pg_temp.mk('G5', 8050);
  UPDATE pedido_compra_item SET ajustado_humano = true WHERE pedido_id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B9 FALHOU: ajustado por humano aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B9 — ajuste humano = decisão humana';

  -- ── B10: cooldown de falha de DISPARO (status='falha_envio') ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, aprovado_em, aprovado_por, atualizado_em)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GX',CURRENT_DATE-1,5000,3,'falha_envio','normal', now()-interval '12 hours','auto:sayerlack-v1', now()-interval '12 hours');
  PERFORM pg_temp.mkref('G6', 8000);
  pid := pg_temp.mk('G6', 8150);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B10 FALHOU: cooldown de disparo não segurou'; END IF;
  UPDATE pedido_compra_sugerido SET atualizado_em = now() - interval '3 days' WHERE status='falha_envio';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B10 — cooldown de falha de disparo';

  -- ── B11: alerta ativo do Sentinela (reposição) → suspende ──
  INSERT INTO fin_alertas (company, tipo, severidade, mensagem)
  VALUES ('oben','data_health_reposicao_disparo','critico','vigia acusando');
  PERFORM pg_temp.mkref('G10', 8000);
  pid := pg_temp.mk('G10', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B11 FALHOU: aprovou com vigia acusando'; END IF;
  UPDATE fin_alertas SET dismissed_at = now() WHERE tipo='data_health_reposicao_disparo';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B11 — suspensão por alerta de reposição';

  -- ── B12: fora da janela (corte já passou) → não aprova ──
  UPDATE company_config SET value = '00:01' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  PERFORM pg_temp.mkref('G11', 8000);
  pid := pg_temp.mk('G11', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B12 FALHOU: aprovou fora da janela'; END IF;
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B12 — fora da janela';

  -- ── B13: tipo_ciclo não-normal → não aprova ──
  PERFORM pg_temp.mkref('G12', 8000);
  pid := pg_temp.mk('G12', 8000, 'pendente_aprovacao', 'oportunidade_promo');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B13 FALHOU: oportunidade aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B13 — ciclo não-normal é humano';

  -- ── B14: zumbi duplo (2 pendentes da mesma identidade) → não aprova ──
  PERFORM pg_temp.mkref('G13', 8000);
  pid := pg_temp.mk('G13', 8000);
  PERFORM pg_temp.mk('G13', 7900);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM pedido_compra_sugerido WHERE grupo_codigo='G13' AND aprovado_por='auto:sayerlack-v1';
  IF d <> 0 THEN RAISE EXCEPTION 'B14 FALHOU: aprovou com identidade duplicada'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE grupo_codigo='G13' AND status='pendente_aprovacao';
  RAISE NOTICE 'OK B14 — zumbi duplo fica humano';

  -- ── B15: corrida com humano — aprovado antes do tick → claim não sobrescreve ──
  PERFORM pg_temp.mkref('G14', 8000);
  pid := pg_temp.mk('G14', 8000);
  UPDATE pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='founder@colacor', status='aprovado_aguardando_disparo' WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'founder@colacor' THEN RAISE EXCEPTION 'B15 FALHOU: máquina sobrescreveu humano (%)', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 0 THEN RAISE EXCEPTION 'B15 FALHOU: logou aprovação que não fez'; END IF;
  RAISE NOTICE 'OK B15 — claim condicional, humano vence';

  -- ══ FIXES DO CODEX ══

  -- ── C1 (P1.1): pedido COLACOR Sayerlack → não aprova (piloto OBEN-only) ──
  PERFORM pg_temp.mkref('G15', 8000, 2, 'COLACOR');
  pid := pg_temp.mk('G15', 8000, 'pendente_aprovacao', 'normal', false, 'COLACOR');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C1 FALHOU: COLACOR auto-aprovou (deveria ser OBEN-only)'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C1 (P1.1) — COLACOR fica humano (OBEN-only)';

  -- ── C2 (P1.3): item em promoção (modo_promocao) → não aprova ──
  PERFORM pg_temp.mkref('G16', 8000);
  pid := pg_temp.mk('G16', 8000, 'pendente_aprovacao', 'normal', true);  -- promo=true
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C2 FALHOU: pedido promocional aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C2 (P1.3) — promoção é decisão humana';

  -- ── C3 (P1.4): referência colapsa SPLIT (pai 8000 → 2 filhos 4000); candidato 5200 ──
  -- contra agregado 8000 = 35% (bloqueia); contra UM filho 4000 seria 30% (passaria).
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G17',CURRENT_DATE-2,8000,10,'split_em_filhos','normal', now()-interval '2 days')
  RETURNING id INTO pai;
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em, split_parent_id, omie_pedido_compra_numero)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G17',CURRENT_DATE-2,4000,5,'disparado','normal', now()-interval '2 days', pai, '7001'),
         ('OBEN','RENNER SAYERLACK S/A','G17',CURRENT_DATE-2,4000,5,'disparado','normal', now()-interval '2 days', pai, '7002');
  pid := pg_temp.mk('G17', 5200);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C3 FALHOU: delta vs filho de split aprovou (devia colapsar p/ 8000)'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C3 (P1.4) — referência agregada colapsa split (5200 vs 8000 = 35%% bloqueia)';

  -- ── C4 (P1.6): raio cumulativo — 2º auto-aprovado do grupo não passa ──
  PERFORM pg_temp.mkref('G18', 8000);
  pid := pg_temp.mk('G18', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();   -- aprova o 1º
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'C4 setup FALHOU: 1º não aprovou (%)', s; END IF;
  pid := pg_temp.mk('G18', 8100);                          -- SKUs novos do mesmo grupo
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C4 FALHOU: 2º auto-aprovado do grupo passou (exposição cumulativa)'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C4 (P1.6) — máx 1 auto-aprovado não-disparado por grupo';

  -- ── C5 (P1.5): delta_max '30' (=3000%) → braço OFF (não aprova) ──
  UPDATE company_config SET value = '30' WHERE key = 'reposicao_auto_aprovacao_delta_max';
  PERFORM pg_temp.mkref('G19', 8000);
  pid := pg_temp.mk('G19', 90000);   -- delta gigante; com 3000% passaria
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C5 FALHOU: delta_max=30 (3000%%) ligou a automação'; END IF;
  UPDATE company_config SET value = '0.30' WHERE key = 'reposicao_auto_aprovacao_delta_max';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C5 (P1.5) — delta_max fora de (0,0.30] desliga o braço';

  -- ── C6 (P1.2): cabeçalho 3000 mas ITENS somam 8000 → usa itens (delta vs 8000 = 0%) ──
  PERFORM pg_temp.mkref('G20', 8000);
  pid := pg_temp.mk('G20', 3000, 'pendente_aprovacao', 'normal', false, 'OBEN', 8000);  -- item_val=8000
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'C6 FALHOU: não usou a soma dos itens (%)', s; END IF;
  SELECT valor_total INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 8000 THEN RAISE EXCEPTION 'C6 FALHOU: log gravou cabeçalho %, esperado 8000 (itens)', v; END IF;
  RAISE NOTICE 'OK C6 (P1.2) — valor pela soma dos itens, não pelo cabeçalho';

  -- ── C7 (P2.11): item com preço NaN → não aprova ──
  PERFORM pg_temp.mkref('G21', 8000);
  pid := pg_temp.mk('G21', 8000);
  UPDATE pedido_compra_item SET preco_unitario = 'NaN'::numeric WHERE pedido_id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C7 FALHOU: item NaN aprovou'; END IF;
  UPDATE pedido_compra_item SET preco_unitario = 100 WHERE pedido_id = pid;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C7 (P2.11) — item NaN rejeitado';

  -- ── C8 (P2.8): corte '24:00' (aceito pelo PostgreSQL como time) → braço OFF ──
  UPDATE company_config SET value = '24:00' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  PERFORM pg_temp.mkref('G22', 8000);
  pid := pg_temp.mk('G22', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C8 FALHOU: corte 24:00 ligou a automação'; END IF;
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK C8 (P2.8) — corte 24:00 inválido desliga o braço';

  -- ── C9 (P2.7): cooldown enxerga falha de PORTAL (status_envio_portal terminal) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, aprovado_em, aprovado_por, status_envio_portal, atualizado_em)
  VALUES ('OBEN','RENNER SAYERLACK S/A','GY',CURRENT_DATE-1,5000,3,'aprovado_aguardando_disparo','normal', now()-interval '6 hours','auto:sayerlack-v1','erro_nao_retentavel', now()-interval '6 hours');
  PERFORM pg_temp.mkref('G23', 8000);
  pid := pg_temp.mk('G23', 8000);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'C9 FALHOU: falha de portal não acionou cooldown'; END IF;
  RAISE NOTICE 'OK C9 (P2.7) — cooldown enxerga falha de portal';

  -- ── B-cron: cron agendado (base) ──
  SELECT count(*) INTO d FROM cron.job WHERE jobname='reposicao-alerta-pedido-minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'B-cron FALHOU: cron não agendado'; END IF;
  RAISE NOTICE 'OK B-cron — cron agendado';

  RAISE NOTICE '✅ TODOS OS 24 ASSERTS DA AUTO-APROVAÇÃO PASSARAM';
END $$;
SQL

echo "✅ test-auto-aprovacao-piloto: OK"
