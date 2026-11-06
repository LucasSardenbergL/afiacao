#!/usr/bin/env bash
# Teste PG17 da migration 20261105160000 (D10 do plano v7): o cron da fin-cashflow-engine passa a
# fazer UMA chamada por empresa com `cenarios: [realista, otimista, pessimista]`.
#
# O que se prova (pg_cron não roda no PG local → cron.schedule é stub que grava em cron.job):
#   A. sem atestação da edge no ledger      → PRE FALHOU e os jobs antigos (FOREACH) ficam intactos
#   B. atestação mais recente = v2.2        → PRE FALHOU (a v2.2 ignora `cenarios`: só o realista)
#   C. v2.2 antiga + v2.3 mais recente      → aplica, POSTCONDICAO_OK, 3 jobs com a chamada única
#   D. reaplicar                            → idempotente, mesmo estado
#   E. v2.3 antiga + v2.2 mais recente      → PRE FALHOU (vale a ÚLTIMA atestação, não "alguma")
#   F. ledger v2.3 + janela viva v2.2 nova  → PRE FALHOU (rollback que o coletor ainda não copiou)
#   G. empate em observado_em               → vence o maior request_id (v2.2 → PRE FALHOU)
#
# --falsificar: roda os casos na migration ORIGINAL (controle, tem de ficar verde NESTA invocação) e
# depois numa cópia sabotada por vez — cada sabotagem tem de deixar a suíte VERMELHA:
#   1. sem o bloco $pre$           → A/B/E aplicariam com a edge velha
#   2. colacor agendada como oben  → P4 da postcondição
#   3. só 2 cenários no corpo      → P4 da postcondição
#   4. pré-condição por "existe"   → E (aceita v2.3 antiga com v2.2 por cima)
#   5. só o ledger, sem janela viva → F
#   6. desempate invertido          → G
#
# Uso: bash db/test-fin-cashflow-cron-carga-unica.sh [--falsificar]
# Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_ANTIGA="$REPO_ROOT/supabase/migrations/20261020120100_fin_cashflow_snapshot_cron_escalonado.sql"
MIG_NOVA="$REPO_ROOT/supabase/migrations/20261105160000_fin_cashflow_cron_carga_unica.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5471
TMPD="$(mktemp -d /tmp/pgtest-cashflow-cron.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL="${LC_ALL:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD" -l "$TMPD/pg.log" -w start >/dev/null

BANCO_SEQ=0
novo_banco() {
  BANCO_SEQ=$((BANCO_SEQ + 1))
  DB="cashflow_cron_$BANCO_SEQ"
  "$PGBIN/createdb" -p "$PORT" -h "$TMPD" -U postgres "$DB"
  P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active, username)
    VALUES (v_id, p_jobname, p_schedule, p_command, true, current_user);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'segredo-de-teste');
-- Mesmas colunas da prod (\d deploy_atestacoes, 2026-11-05).
CREATE TABLE public.deploy_atestacoes (
  request_id bigint NOT NULL, observado_em timestamptz NOT NULL, edge text NOT NULL,
  versao text NOT NULL, fonte text NOT NULL, via text NOT NULL, registrado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, observado_em)
);
-- Janela viva: na prod lê net._http_response; aqui, uma tabela com a MESMA assinatura de retorno.
CREATE TABLE public.janela_viva_stub (request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text);
CREATE FUNCTION public.deploy_atestacoes_janela_viva()
RETURNS TABLE(request_id bigint, observado_em timestamptz, edge text, versao text, fonte text, via text)
LANGUAGE sql STABLE AS $$ SELECT * FROM public.janela_viva_stub $$;
SQL
  # Estado de partida = o da prod: os 3 jobs escalonados com FOREACH por cenário.
  P -v ON_ERROR_STOP=1 -q -f "$MIG_ANTIGA" >/dev/null
}
P() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }

ATEST_SEQ=0
atestar() { # $1 = versao, $2 = minutos atrás, $3 = tabela (default: o ledger); request_id crescente
  ATEST_SEQ=$((ATEST_SEQ + 1))
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO ${3:-deploy_atestacoes} (request_id, observado_em, edge, versao, fonte, via)
    VALUES ($ATEST_SEQ, date_trunc('minute', now()) - interval '$2 minutes', 'fin-cashflow-engine', '$1', 'f', 'sonda')"
}

# Aplica a migration como o db:aplicar: transação única, ON_ERROR_STOP. Saída em $SAIDA, rc devolvido.
aplicar() { # $1 = arquivo
  set +e
  SAIDA="$(P -v ON_ERROR_STOP=1 --single-transaction -f "$1" 2>&1)"
  local rc=$?
  set -e
  return $rc
}

jobs_resumo() {
  P -At -c "SELECT string_agg(jobname || '|' || schedule || '|' ||
              (position('FOREACH' IN command) > 0)::text || '|' ||
              (position('''cenarios'', jsonb_build_array(''realista'', ''otimista'', ''pessimista'')' IN command) > 0)::text || '|' ||
              substring(command from '''company'', ''([a-z_]+)'''), ';' ORDER BY jobname) FROM cron.job"
}

FALHAS=0
caso() { # $1 = rótulo, $2 = veredito (ok|falha), $3 = detalhe
  if [ "$2" = ok ]; then echo "  ok    $1"; else echo "  FALHA $1 — $3"; FALHAS=$((FALHAS + 1)); fi
}

ANTIGO_ESPERADO="fin-cashflow-snapshot-diario|0 10 * * *|true|false|oben;fin-cashflow-snapshot-diario-colacor|5 10 * * *|true|false|colacor;fin-cashflow-snapshot-diario-colacor-sc|10 10 * * *|true|false|colacor_sc"
NOVO_ESPERADO="fin-cashflow-snapshot-diario|0 10 * * *|false|true|oben;fin-cashflow-snapshot-diario-colacor|5 10 * * *|false|true|colacor;fin-cashflow-snapshot-diario-colacor-sc|10 10 * * *|false|true|colacor_sc"

rodar_casos() { # $1 = migration nova (original ou sabotada); devolve o nº de falhas em FALHAS
  local mig="$1"
  FALHAS=0

  novo_banco
  if aplicar "$mig"; then caso "A sem atestação recusa" falha "aplicou"; else
    if [[ "$SAIDA" == *"PRE FALHOU"* ]] && [ "$(jobs_resumo)" = "$ANTIGO_ESPERADO" ]; then caso "A sem atestação recusa" ok
    else caso "A sem atestação recusa" falha "saída/jobs inesperados: $(jobs_resumo) :: ${SAIDA:0:200}"; fi
  fi

  novo_banco; atestar v2.2-serie-estoque-snapshot 60
  if aplicar "$mig"; then caso "B v2.2 recusa" falha "aplicou"; else
    if [[ "$SAIDA" == *"PRE FALHOU"* ]] && [ "$(jobs_resumo)" = "$ANTIGO_ESPERADO" ]; then caso "B v2.2 recusa" ok
    else caso "B v2.2 recusa" falha "saída/jobs inesperados: ${SAIDA:0:200}"; fi
  fi

  novo_banco; atestar v2.2-serie-estoque-snapshot 60; atestar v2.3-carga-unica-cenarios 5
  if aplicar "$mig" && [[ "$SAIDA" == *"POSTCONDICAO_OK"* ]] && [ "$(jobs_resumo)" = "$NOVO_ESPERADO" ]; then
    caso "C v2.3 aplica com 1 chamada por empresa" ok
    if aplicar "$mig" && [[ "$SAIDA" == *"POSTCONDICAO_OK"* ]] && [ "$(jobs_resumo)" = "$NOVO_ESPERADO" ] \
       && [ "$(P -At -c 'SELECT count(*) FROM cron.job')" = 3 ]; then caso "D reaplicar é idempotente" ok
    else caso "D reaplicar é idempotente" falha "${SAIDA:0:200}"; fi
  else
    caso "C v2.3 aplica com 1 chamada por empresa" falha "jobs=$(jobs_resumo) :: ${SAIDA:0:300}"
    caso "D reaplicar é idempotente" falha "C não aplicou"
  fi

  novo_banco; atestar v2.3-carga-unica-cenarios 60; atestar v2.2-serie-estoque-snapshot 5
  if aplicar "$mig"; then caso "E v2.2 por cima da v2.3 recusa" falha "aplicou"; else
    if [[ "$SAIDA" == *"PRE FALHOU"* ]]; then caso "E v2.2 por cima da v2.3 recusa" ok
    else caso "E v2.2 por cima da v2.3 recusa" falha "${SAIDA:0:200}"; fi
  fi

  novo_banco; atestar v2.3-carga-unica-cenarios 30; atestar v2.2-serie-estoque-snapshot 2 janela_viva_stub
  if aplicar "$mig"; then caso "F rollback na janela viva recusa" falha "aplicou"; else
    if [[ "$SAIDA" == *"PRE FALHOU"* ]]; then caso "F rollback na janela viva recusa" ok
    else caso "F rollback na janela viva recusa" falha "${SAIDA:0:200}"; fi
  fi

  novo_banco; atestar v2.3-carga-unica-cenarios 10; atestar v2.2-serie-estoque-snapshot 10 janela_viva_stub
  if aplicar "$mig"; then caso "G empate decide pelo request_id" falha "aplicou"; else
    if [[ "$SAIDA" == *"PRE FALHOU"* ]]; then caso "G empate decide pelo request_id" ok
    else caso "G empate decide pelo request_id" falha "${SAIDA:0:200}"; fi
  fi
  return 0
}

echo "→ migration original"
rodar_casos "$MIG_NOVA"
CONTROLE=$FALHAS

if [ "${1:-}" != "--falsificar" ]; then
  if [ "$CONTROLE" -eq 0 ]; then echo "TESTE_OK db/test-fin-cashflow-cron-carga-unica.sh (7 casos)"; exit 0; fi
  echo "TESTE_FALHOU ($CONTROLE caso(s))"; exit 1
fi

[ "$CONTROLE" -eq 0 ] || { echo "CONTROLE VERMELHO: a falsificação não prova nada com a suíte falhando no original"; exit 1; }

SAB="$TMPD/sabotada.sql"
sabotar() { # $1 = rótulo, $2 = programa perl aplicado ao arquivo
  perl -0pe "$2" "$MIG_NOVA" > "$SAB"
  if cmp -s "$SAB" "$MIG_NOVA"; then echo "SABOTAGEM INERTE: $1 (o arquivo não mudou)"; exit 1; fi
  echo "→ sabotagem: $1"
  rodar_casos "$SAB"
  if [ "$FALHAS" -eq 0 ]; then echo "FALSIFICACAO_FALHOU: '$1' passou verde"; exit 1; fi
  echo "  ✓ vermelha ($FALHAS caso(s))"
}
sabotar "sem o bloco \$pre\$" 's/DO \$pre\$.*?\$pre\$;//s'
sabotar "colacor agendada como oben" "s/('company', )'colacor'(, 'cenarios')/\$1'oben'\$2/"
# Sem /g: troca só a 1ª ocorrência (o corpo do job da oben; a postcondição usa aspas dobradas).
sabotar "só 2 cenários no corpo" "s/jsonb_build_array\('realista', 'otimista', 'pessimista'\)/jsonb_build_array('realista', 'otimista')/"
sabotar "pré-condição por existência" "s/WHERE edge = 'fin-cashflow-engine'\n   ORDER BY/WHERE edge = 'fin-cashflow-engine' AND versao = 'v2.3-carga-unica-cenarios'\n   ORDER BY/"
sabotar "só o ledger, sem janela viva" "s/    UNION ALL\n    SELECT request_id, edge, versao, observado_em FROM public.deploy_atestacoes_janela_viva\(\)\n//"
sabotar "desempate invertido" "s/request_id DESC\n   LIMIT 1;/request_id ASC\n   LIMIT 1;/"
echo "FALSIFICACAO_OK: controle verde e as 6 sabotagens vermelhas na mesma invocação"
