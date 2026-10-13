#!/usr/bin/env bash
# Prova PG17 da MITIGAÇÃO tint_reaplicar_snapshot_tick() (20261013180000) — money-path tintométrico.
#
# O que se prova: a função re-marca como `pendente` o snapshot de chaves APLICADO mais recente de
# cada (account, store_code), para que o `tint_promocao_tick` o re-aplique e o
# `tint_apply_keys_snapshot` volte a desativar as fórmulas de cor que a FONTE retirou. É mitigação
# temporária do #3051 (ver o cabeçalho da migration) e tem três guardas que são o conserto, não
# higiene: obsolescência de 36h, não-empilhar, e zerar `aplicacao_tentativas`.
#
#   bash db/test-tint-reaplicar-snapshot.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-tint-reaplicar-snapshot.sh   # tem de ficar VERMELHA
#   bash db/test-tint-reaplicar-snapshot.sh --falsificar       # controle verde + cada sabotagem no alvo dela
#
# ⚠️ A13 é REDUNDANTE com a postcondição P6 da própria migration, de propósito: P6 mora DENTRO do
# que ela verifica (é a mais fácil de enganar — `database.md` §1, "2ª testemunha"), e A13 é a
# testemunha de fora, comportamental: uma role NEUTRA, sem grant nenhum, não pode executar. Por
# isso a sabotagem `acl_aberta` é cobrada no `P6 FALHOU` (a migration ABORTA antes dos asserts),
# e não num `FAIL A13` — se um dia P6 sair, A13 continua pegando.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261013180000_tint_reaplicar_snapshot_cron.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<padrão que TEM de aparecer no log>
  SABOTAGENS="sem_guard_36h:FAIL_A8 sem_guard_pendente:FAIL_A7 pega_mais_antigo:FAIL_A4 sem_filtro_entity:FAIL_A10 sem_zerar_tentativas:FAIL_A5 acl_aberta:P6_FALHOU"
  LOGDIR="$(mktemp -d "/tmp/falsifica-reaplicar-snapshot.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -20 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; alvo="${par#*:}"; padrao="${alvo//_/ }"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $padrao"
    else
      echo "❌ $s: vermelho, mas não em [$padrao] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "── $n_sab sabotagens, $falhas fora do alvo ──"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5962}"
DATA="$(mktemp -d "/tmp/pgtest-reaplicar-snap.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  # cada uma remove UMA camada — a que ficar verde é redundante ou inalcançada
  sem_guard_36h)        sabotar "       AND ks.generated_at > now() - interval '36 hours'
" "" ;;
  sem_guard_pendente)   sabotar "    IF FOUND THEN" "    IF false THEN" ;;
  pega_mais_antigo)     sabotar "ORDER BY ks.account, ks.store_code, ks.generated_at DESC" "ORDER BY ks.account, ks.store_code, ks.generated_at ASC" ;;
  sem_filtro_entity)    sabotar "     WHERE ks.entity = 'formulas'
       AND ks.aplicacao_status = 'aplicado'" "     WHERE ks.aplicacao_status = 'aplicado'" ;;
  sem_zerar_tentativas) sabotar "           aplicacao_tentativas = 0,
" "" ;;
  acl_aberta)           sabotar "REVOKE ALL ON FUNCTION public.tint_reaplicar_snapshot_tick() FROM anon;" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# Esquema MÍNIMO (sem schema-snapshot: a função só toca tint_keys_snapshots — ~5 s/rodada).
# As colunas e o CHECK são os de prod (information_schema, 2026-10-13).
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
-- role NEUTRA: não recebe grant nenhum. Serve para A13 ver a ponta PUBLIC do REVOKE.
CREATE ROLE role_neutra NOLOGIN;
-- ⚠️ ISTO É O QUE TORNA A SABOTAGEM `acl_aberta` ALCANÇÁVEL, e a 1ª versão da prova não tinha:
-- no PG cru, `anon` só tem EXECUTE VIA PUBLIC, então `REVOKE ... FROM anon` é no-op e remover
-- essa linha não quebrava nada (medido: suíte ficou VERDE). Em prod não é no-op — o Supabase dá
-- grant EXPLÍCITO a anon/authenticated (é a armadilha do CLAUDE.md: "REVOKE FROM PUBLIC NÃO tira
-- anon/authenticated"). Sem reproduzir o grant explícito aqui, a prova media outro ambiente.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
CREATE TABLE public.tint_keys_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id uuid,
  account text NOT NULL,
  store_code text NOT NULL,
  snapshot_id uuid NOT NULL,
  entity text NOT NULL,
  generated_at timestamptz NOT NULL,
  total_chunks int NOT NULL,
  chunk_index int NOT NULL,
  keys jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  aplicacao_status text CHECK (aplicacao_status IS NULL OR aplicacao_status IN ('pendente','aplicado','erro','descartado')),
  aplicacao_tentativas int NOT NULL DEFAULT 0,
  aplicacao_erro text,
  aplicacao_proxima_em timestamptz,
  aplicado_em timestamptz);
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
INSERT INTO cron.job VALUES (1, 'tint-promocao-tick', '15 seconds', 'SELECT public.tint_promocao_tick();', true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
SQL

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente: re-aplicar não pode estragar

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

limpa() { Pq -c "TRUNCATE public.tint_keys_snapshots;" >/dev/null; }
# semeia(snapshot_id, account, store, entity, horas_atras, status, tentativas, n_chunks)
semeia() {
  Pq -c "INSERT INTO public.tint_keys_snapshots
           (snapshot_id, account, store_code, entity, generated_at, total_chunks, chunk_index, keys,
            aplicacao_status, aplicacao_tentativas, aplicacao_erro, aplicacao_proxima_em, aplicado_em)
         SELECT '$1'::uuid, '$2', '$3', '$4', now() - interval '$5 hours', $8, g, '[\"k\"]'::jsonb,
                $(if [ "$6" = "NULL" ]; then echo NULL; else echo "'$6'"; fi), $7,
                'erro antigo', now(), now()
           FROM generate_series(0, $8 - 1) g;" >/dev/null
}
roda() { Pq -c "SELECT public.tint_reaplicar_snapshot_tick();"; }
st() { Pq -c "SELECT DISTINCT aplicacao_status FROM public.tint_keys_snapshots WHERE snapshot_id='$1'::uuid;"; }
campo() { Pq -c "SELECT DISTINCT COALESCE($2::text,'<null>') FROM public.tint_keys_snapshots WHERE snapshot_id='$1'::uuid;"; }
jget() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

A='aaaaaaaa-0000-0000-0000-00000000000a'
B='bbbbbbbb-0000-0000-0000-00000000000b'
C='cccccccc-0000-0000-0000-00000000000c'

# ── A1/A2: a migration montou função e cron ──────────────────────────────────────────────
eq A1 "$(Pq -c "SELECT to_regprocedure('public.tint_reaplicar_snapshot_tick()') IS NOT NULL;")" t
eq A2 "$(Pq -c "SELECT jobname||'|'||schedule||'|'||command||'|'||active FROM cron.job WHERE jobname='tint-reaplicar-snapshot-6h';")" \
      "tint-reaplicar-snapshot-6h|30 */6 * * *|SELECT public.tint_reaplicar_snapshot_tick();|true"

# ── A3/A4/A5/A6/A16: pega o APLICADO mais recente, e só ele ──────────────────────────────
limpa
semeia "$A" oben M01 formulas 2  aplicado 2 3    # recente
semeia "$B" oben M01 formulas 26 aplicado 0 3    # mais antigo (ainda dentro das 36h)
RES="$(roda)"
eq A3  "$(st "$A")" pendente
eq A4  "$(st "$B")" aplicado
eq A5  "$(campo "$A" aplicacao_tentativas)" 0
eq A6  "$(campo "$A" aplicacao_proxima_em)|$(campo "$A" aplicacao_erro)" "<null>|<null>"
eq A16 "$(printf '%s' "$RES" | jget chunks_marcados)" 3

# ── A7: não empilha quando já há pendente para o par ────────────────────────────────────
limpa
semeia "$A" oben M01 formulas 2  aplicado 0 3
semeia "$B" oben M01 formulas 1  pendente 0 3
RES="$(roda)"
eq A7 "$(st "$A")|$(printf '%s' "$RES" | jget snapshots_remarcados)|$(printf '%s' "$RES" | jget pares_saltados_por_pendente)" "aplicado|0|1"

# ── A8/A9: guard de obsolescência (36h) — negativo e controle POSITIVO do mesmo guard ────
limpa
semeia "$A" oben M01 formulas 40 aplicado 0 3
RES="$(roda)"
eq A8 "$(st "$A")|$(printf '%s' "$RES" | jget snapshots_remarcados)" "aplicado|0"
limpa
semeia "$A" oben M01 formulas 10 aplicado 0 3
roda >/dev/null
eq A9 "$(st "$A")" pendente

# ── A10: entity diferente de 'formulas' não é alvo ──────────────────────────────────────
limpa
semeia "$A" oben M01 catalogs 2 aplicado 0 3
RES="$(roda)"
eq A10 "$(st "$A")|$(printf '%s' "$RES" | jget snapshots_remarcados)" "aplicado|0"

# ── A11: dois pares (account, store_code) são independentes ─────────────────────────────
limpa
semeia "$A" oben     M01 formulas 2 aplicado 0 3
semeia "$B" colacor  M01 formulas 2 aplicado 0 3
RES="$(roda)"
eq A11 "$(st "$A")|$(st "$B")|$(printf '%s' "$RES" | jget snapshots_remarcados)" "pendente|pendente|2"

# ── A12: 2ª chamada seguida é no-op (o pendente que ela mesma criou a barra) ────────────
limpa
semeia "$A" oben M01 formulas 2 aplicado 0 3
roda >/dev/null
RES="$(roda)"
# 2ª chamada nao acha alvo nenhum (o unico ja virou pendente), logo saltados=0: quem prova o
# contador de salto e o A7, onde existe alvo APLICADO *e* um pendente do mesmo par.
eq A12 "$(st "$A")|$(printf '%s' "$RES" | jget snapshots_remarcados)|$(printf '%s' "$RES" | jget pares_saltados_por_pendente)" "pendente|0|0"

# ── A13: testemunha de FORA do ACL — role neutra não executa (ponta PUBLIC do REVOKE) ──
eq A13 "$(Pq -c "SELECT has_function_privilege('role_neutra','public.tint_reaplicar_snapshot_tick()','EXECUTE');")" f

# ── A14/A15: 'erro' e NULL não são alvo (limite (b) e era pré-fila) ─────────────────────
limpa
semeia "$A" oben M01 formulas 2 erro 3 3
RES="$(roda)"
eq A14 "$(st "$A")|$(printf '%s' "$RES" | jget snapshots_remarcados)" "erro|0"
limpa
semeia "$C" oben M01 formulas 2 NULL 0 3
RES="$(roda)"
# `st` usaria DISTINCT cru e NULL sai como string VAZIA no -qAt (indistinguível de "sem linha"):
# aqui o COALESCE do `campo` é o que torna o assert legível em vez de comparar com "".
eq A15 "$(campo "$C" aplicacao_status)|$(printf '%s' "$RES" | jget snapshots_remarcados)" "<null>|0"

echo "── PASS=$PASS FAIL=$FAIL ──"
[ "$FAIL" -eq 0 ] || exit 1
echo "TUDO VERDE: tint_reaplicar_snapshot_tick (20261013180000)"
