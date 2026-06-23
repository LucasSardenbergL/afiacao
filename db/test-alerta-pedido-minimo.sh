#!/usr/bin/env bash
# Teste PG17 do alerta "pedido Sayerlack atingiu o mínimo de faturamento (R$3k)" — PR1.
# Aplica schema-snapshot + a migration 20260609150000 e valida o tick em 11 asserts:
# transição (1 e-mail), anti-spam (tick 2×), valor cresce sem re-spam (valor_ultimo),
# aprovação resolve, re-arma com pedido novo, fornecedor fora do pattern, abaixo da régua,
# config inválida não explode, grupo NULL × '' não duplica, CHECK aceita o tipo novo.
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-alerta3k.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-alerta3k.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres alerta3k_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d alerta3k_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-alerta3k.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ stub cron.schedule (a migration agenda o tick; pg_cron não roda no PG local)…"
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

echo "→ aplica a migration 20260609150000 (alerta R\$3k)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql" >/dev/null

echo "→ cenários + asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; v numeric; pid bigint;
BEGIN
  -- ── A1: transição — pedido Sayerlack pendente ≥ régua → 1 alerta ativo + 1 e-mail ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','SAYERLACK DO BRASIL LTDA','G1',CURRENT_DATE,3200,5,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();

  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo WHERE resolvido_em IS NULL;
  IF d <> 1 THEN RAISE EXCEPTION 'A1 FALHOU: % alertas ativos, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND status='pendente_notificacao';
  IF d <> 1 THEN RAISE EXCEPTION 'A1 FALHOU: % e-mails enfileirados, esperado 1', d; END IF;
  RAISE NOTICE 'OK A1 — transição: 1 alerta ativo + 1 e-mail (CHECK aceita o tipo novo)';

  -- ── A2: anti-spam — tick de novo NÃO re-enfileira ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'A2 FALHOU: % e-mails, esperado 1 (anti-spam)', d; END IF;
  RAISE NOTICE 'OK A2 — anti-spam: tick repetido não re-enfileira';

  -- ── A3: valor cresce 3.2k→10k → valor_ultimo atualiza, SEM novo e-mail ──
  UPDATE pedido_compra_sugerido SET valor_total = 10000 WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT valor_ultimo INTO v FROM reposicao_alerta_pedido_minimo WHERE resolvido_em IS NULL;
  IF v <> 10000 THEN RAISE EXCEPTION 'A3 FALHOU: valor_ultimo=%, esperado 10000', v; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'A3 FALHOU: % e-mails, esperado 1', d; END IF;
  RAISE NOTICE 'OK A3 — valor cresce sem re-spam (valor_ultimo=10000)';

  -- ── A4: aprovação resolve (re-arma) ──
  UPDATE pedido_compra_sugerido SET status = 'aprovado_aguardando_disparo' WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo WHERE resolvido_em IS NULL;
  IF d <> 0 THEN RAISE EXCEPTION 'A4 FALHOU: % alertas ativos pós-aprovação, esperado 0', d; END IF;
  RAISE NOTICE 'OK A4 — aprovação resolve o alerta';

  -- ── A5: re-arma — pedido NOVO do mesmo fornecedor/grupo cruza a régua → e-mail NOVO ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','SAYERLACK DO BRASIL LTDA','G1',CURRENT_DATE,3100,4,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo WHERE resolvido_em IS NULL;
  IF d <> 1 THEN RAISE EXCEPTION 'A5 FALHOU: % ativos, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 2 THEN RAISE EXCEPTION 'A5 FALHOU: % e-mails, esperado 2 (re-armou)', d; END IF;
  RAISE NOTICE 'OK A5 — re-arma: pedido novo do grupo gera e-mail novo';

  -- ── A6: fornecedor fora do pattern não alerta ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','ACRE CAXIAS','',CURRENT_DATE,5000,3,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo a WHERE a.fornecedor_nome='ACRE CAXIAS';
  IF d <> 0 THEN RAISE EXCEPTION 'A6 FALHOU: fornecedor fora do pattern alertou'; END IF;
  RAISE NOTICE 'OK A6 — fornecedor fora do pattern não alerta';

  -- ── A7: Sayerlack abaixo da régua não alerta ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','SAYERLACK DO BRASIL LTDA','G2',CURRENT_DATE,2000,2,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo a WHERE a.grupo_codigo='G2' AND a.resolvido_em IS NULL;
  IF d <> 0 THEN RAISE EXCEPTION 'A7 FALHOU: pedido abaixo da régua alertou'; END IF;
  RAISE NOTICE 'OK A7 — abaixo da régua não alerta';

  -- ── A8: config inválida → tick vira no-op limpo (nada novo, nada explode) ──
  UPDATE company_config SET value = '0' WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 2 THEN RAISE EXCEPTION 'A8 FALHOU: config inválida gerou e-mail'; END IF;
  UPDATE company_config SET value = '3000' WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  RAISE NOTICE 'OK A8 — config inválida desliga o alerta sem erro';

  -- ── A9: grupo NULL × '' são a MESMA identidade (não duplica alerta/e-mail) ──
  -- (G2 de 2k continua pendente; criamos NULL 3500 e '' 3600 — devem virar UM alerta só.)
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','SAYERLACK DO BRASIL LTDA',NULL,CURRENT_DATE,3500,3,'pendente_aprovacao','normal'),
         ('OBEN','SAYERLACK DO BRASIL LTDA','',CURRENT_DATE,3600,3,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo a
  WHERE a.grupo_codigo='' AND a.resolvido_em IS NULL;
  IF d <> 1 THEN RAISE EXCEPTION 'A9 FALHOU: % alertas pra identidade NULL/vazio, esperado 1', d; END IF;
  SELECT valor_ultimo INTO v FROM reposicao_alerta_pedido_minimo a
  WHERE a.grupo_codigo='' AND a.resolvido_em IS NULL;
  IF v <> 3600 THEN RAISE EXCEPTION 'A9 FALHOU: valor_ultimo=% (esperado MAX=3600)', v; END IF;
  RAISE NOTICE 'OK A9 — grupo NULL e vazio = mesma identidade (1 alerta, MAX valor)';

  -- ── A10: resolve quando o valor CAI abaixo da régua ──
  UPDATE pedido_compra_sugerido SET valor_total = 2900
  WHERE fornecedor_nome='SAYERLACK DO BRASIL LTDA' AND COALESCE(grupo_codigo,'')='' AND status='pendente_aprovacao';
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_alerta_pedido_minimo a
  WHERE a.grupo_codigo='' AND a.resolvido_em IS NULL;
  IF d <> 0 THEN RAISE EXCEPTION 'A10 FALHOU: alerta não resolveu quando caiu da régua'; END IF;
  RAISE NOTICE 'OK A10 — valor caiu da régua → resolve (re-arma)';

  -- ── A11: cron agendado ──
  SELECT count(*) INTO d FROM cron.job WHERE jobname='reposicao-alerta-pedido-minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'A11 FALHOU: cron não agendado'; END IF;
  RAISE NOTICE 'OK A11 — cron reposicao-alerta-pedido-minimo agendado';

  RAISE NOTICE '✅ TODOS OS 11 ASSERTS DO ALERTA R$3K PASSARAM';
END $$;
SQL

echo "✅ test-alerta-pedido-minimo: OK"
