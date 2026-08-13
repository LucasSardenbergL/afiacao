#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — cota de IA por usuário (20260803093000_ia_uso_cota.sql)        ║
# ║      bash db/test-ia-uso-cota.sh > /tmp/t.log 2>&1; echo "exit=$?"             ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Rode nos DOIS locales — falsificar num só não prova a asserção (#1483):       ║
# ║      bash db/test-ia-uso-cota.sh                                               ║
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-ia-uso-cota.sh                    ║
# ║  O postmaster SEMPRE sobe em C (aborta fora dele); quem varia é o locale do    ║
# ║  SHELL, que é onde a comparação de sentinela pode dobrar acento.               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="ia-uso-cota"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"

# O SHELL herda o locale sob teste; o POSTGRES roda sempre em C (via `env` inline).
export LC_ALL="${HARNESS_LOCALE:-C}" LANG="${HARNESS_LOCALE:-C}"
PGC=(env LC_ALL=C LANG=C)
echo "── locale do shell: $LC_ALL (postmaster sempre em C) ──"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "${PGC[@]}" "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"${PGC[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"${PGC[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"${PGC[@]}" "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# pg_cron não existe no PG local. O stub REGISTRA em cron.job (assim dá pra
# asserir o job criado) e o unschedule LEVANTA quando o job não existe — que é o
# comportamento do pg_cron real e o que o bloco DO/EXCEPTION da migration precisa
# engolir para ser idempotente.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  SELECT COALESCE(max(jobid), 0) + 1 INTO v_id FROM cron.job;
  INSERT INTO cron.job(jobid, schedule, command, jobname, active)
  VALUES (v_id, p_schedule, p_command, p_jobname, true);
  RETURN v_id;
END $f$;

CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_jobname) THEN
    RAISE EXCEPTION 'could not find valid entry for job %', p_jobname;
  END IF;
  DELETE FROM cron.job WHERE jobname = p_jobname;
  RETURN true;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260803093000_ia_uso_cota.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ══════════════════════════════════════════════════════════════════════════════
U1='11111111-1111-1111-1111-111111111111'
U2='22222222-2222-2222-2222-222222222222'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$U1'), ('$U2') ON CONFLICT DO NOTHING;

-- Funções de TESTE com limites pequenos: exercita a mesma lógica sem semear 20
-- linhas por assert. Os limites REAIS seguem provados pelos A1-A3.
INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia) VALUES
  ('teste-hora',    3,  50),
  ('teste-dia',     5,   5),
  ('teste-24h',     2,   2),
  ('trava-teste',  10,  10)
ON CONFLICT (funcao) DO NOTHING;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# ── A1-A3: o seed real das 3 edges entrou com os números do desenho ─────────
V=$(Pq -c "SELECT limite_hora||'/'||limite_dia FROM public.ia_uso_limite WHERE funcao='identify-tool';")
eq "A1 seed identify-tool" "$V" "20/60"
V=$(Pq -c "SELECT limite_hora||'/'||limite_dia FROM public.ia_uso_limite WHERE funcao='analyze-services';")
eq "A2 seed analyze-services" "$V" "20/50"
V=$(Pq -c "SELECT limite_hora||'/'||limite_dia FROM public.ia_uso_limite WHERE funcao='copilot-analyze';")
eq "A3 seed copilot-analyze" "$V" "600/2500"

# ── A4/A5: caminho feliz — permite E registra ───────────────────────────────
V=$(Pq -c "SELECT permitido||'|'||motivo||'|'||usado_hora||'|'||usado_dia FROM public.ia_consumir_cota('$U1','teste-hora');")
eq "A4 1a chamada permitida" "$V" "true|ok|1|1"
V=$(Pq -c "SELECT count(*) FROM public.ia_uso_evento WHERE user_id='$U1' AND funcao='teste-hora';")
eq "A5 evento GRAVADO" "$V" "1"

# ── A6: até o limite passa (limite 3: faltam a 2a e a 3a) ──────────────────
Pq -c "SELECT permitido FROM public.ia_consumir_cota('$U1','teste-hora');" >/dev/null
V=$(Pq -c "SELECT permitido||'|'||usado_hora FROM public.ia_consumir_cota('$U1','teste-hora');")
eq "A6 3a chamada (=limite) ainda passa" "$V" "true|3"

# ── A7/A8: a (limite+1) NEGA e NÃO grava ───────────────────────────────────
V=$(Pq -c "SELECT permitido||'|'||motivo||'|'||usado_hora||'|'||limite_hora FROM public.ia_consumir_cota('$U1','teste-hora');")
eq "A7 4a chamada NEGADA por hora" "$V" "false|hora|3|3"
V=$(Pq -c "SELECT count(*) FROM public.ia_uso_evento WHERE user_id='$U1' AND funcao='teste-hora';")
eq "A8 negada NAO gravou evento" "$V" "3"

# ── A9: libera_em_segundos coerente (>0 e <= 3600) ─────────────────────────
V=$(Pq -c "SELECT (libera_em_segundos > 0 AND libera_em_segundos <= 3600) FROM public.ia_consumir_cota('$U1','teste-hora');")
eq "A9 libera_em_segundos na janela da hora" "$V" "t"

# ── A10: isolamento entre usuários — a cota de U1 não afeta U2 ─────────────
V=$(Pq -c "SELECT permitido||'|'||usado_hora FROM public.ia_consumir_cota('$U2','teste-hora');")
eq "A10 cota e POR USUARIO" "$V" "true|1"

# ── A11 (MONEY-PATH): janela DESLIZANTE — evento >1h não conta na hora, mas
#     conta no dia. É o invariante que justificou log-de-evento em vez de bucket.
P -q <<SQL
UPDATE public.ia_uso_evento SET criado_em = now() - interval '2 hours'
 WHERE user_id='$U1' AND funcao='teste-hora';
SQL
V=$(Pq -c "SELECT permitido||'|'||usado_hora||'|'||usado_dia FROM public.ia_consumir_cota('$U1','teste-hora');")
eq "A11 evento de 2h NAO conta na hora, conta no dia" "$V" "true|1|4"

# ── A12/A13: limite DIÁRIO morde com a janela da hora limpa ────────────────
P -q <<SQL
INSERT INTO public.ia_uso_evento (user_id, funcao, criado_em)
SELECT '$U1','teste-dia', now() - interval '3 hours' - (g || ' minutes')::interval
  FROM generate_series(1,5) g;
SQL
V=$(Pq -c "SELECT permitido||'|'||motivo||'|'||usado_hora||'|'||usado_dia FROM public.ia_consumir_cota('$U1','teste-dia');")
eq "A12 limite do DIA morde com a hora limpa" "$V" "false|dia|0|5"
V=$(Pq -c "SELECT (libera_em_segundos > 3600 AND libera_em_segundos <= 86400) FROM public.ia_consumir_cota('$U1','teste-dia');")
eq "A13 libera_em_segundos na janela do dia" "$V" "t"

# ── A14 (MONEY-PATH): evento >24h não conta em NADA ────────────────────────
P -q <<SQL
INSERT INTO public.ia_uso_evento (user_id, funcao, criado_em)
SELECT '$U1','teste-24h', now() - interval '25 hours' - (g || ' minutes')::interval
  FROM generate_series(1,9) g;
SQL
V=$(Pq -c "SELECT permitido||'|'||usado_hora||'|'||usado_dia FROM public.ia_consumir_cota('$U1','teste-24h');")
eq "A14 evento de 25h nao conta em nada" "$V" "true|1|1"

# ── A15: FAIL-CLOSED — função sem linha em ia_uso_limite é NEGADA ──────────
V=$(Pq -c "SELECT permitido||'|'||motivo FROM public.ia_consumir_cota('$U1','edge-que-ninguem-configurou');")
eq "A15 fail-closed: sem limite = negado" "$V" "false|sem_limite"

# ── A16: argumento nulo levanta a SQLSTATE esperada (22023) ────────────────
R=$(P -tA 2>&1 <<SQL
DO \$do\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.ia_consumir_cota(NULL, 'teste-hora');
    v_passou := true;
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;   -- 22023 = o erro ESPERADO
    WHEN OTHERS THEN RAISE;                   -- qualquer outro: RELANÇA
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A16_ACEITOU_NULO'; ELSE RAISE NOTICE 'SENT_A16_BARROU'; END IF;
END \$do\$;
SQL
)
case "$R" in
  *SENT_A16_BARROU*)       ok  "A16 user_id nulo rejeitado (22023)" ;;
  *SENT_A16_ACEITOU_NULO*) bad "A16 user_id nulo ACEITO" ;;
  *)                       bad "A16 resultado inesperado: $R" ;;
esac

# ── A17/A18: CHECKs da tabela de limites ──────────────────────────────────
R=$(P -tA 2>&1 <<'SQL'
DO $do$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia) VALUES ('x-invalido', 50, 10);
    v_passou := true;
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A17_ACEITOU'; ELSE RAISE NOTICE 'SENT_A17_BARROU'; END IF;
END $do$;
SQL
)
case "$R" in
  *SENT_A17_BARROU*)  ok  "A17 CHECK barra limite_dia < limite_hora (23514)" ;;
  *SENT_A17_ACEITOU*) bad "A17 CHECK NAO barrou limite_dia < limite_hora" ;;
  *)                  bad "A17 resultado inesperado: $R" ;;
esac

R=$(P -tA 2>&1 <<'SQL'
DO $do$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia) VALUES ('   ', 5, 5);
    v_passou := true;
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A18_ACEITOU'; ELSE RAISE NOTICE 'SENT_A18_BARROU'; END IF;
END $do$;
SQL
)
case "$R" in
  *SENT_A18_BARROU*)  ok  "A18 CHECK barra funcao vazia (23514)" ;;
  *SENT_A18_ACEITOU*) bad "A18 CHECK NAO barrou funcao vazia" ;;
  *)                  bad "A18 resultado inesperado: $R" ;;
esac

# ── A19: REVOKE de tabela — authenticated não LÊ (privilégio, 1a camada) ───
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $do$
DECLARE v_passou boolean := false; v_n bigint;
BEGIN
  BEGIN
    SELECT count(*) INTO v_n FROM public.ia_uso_evento;
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;   -- 42501 = o esperado
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A19_LEU'; ELSE RAISE NOTICE 'SENT_A19_BARROU'; END IF;
END $do$;
SQL
)
case "$R" in
  *SENT_A19_BARROU*) ok  "A19 REVOKE barra authenticated na tabela (42501)" ;;
  *SENT_A19_LEU*)    bad "A19 authenticated LEU ia_uso_evento" ;;
  *)                 bad "A19 resultado inesperado: $R" ;;
esac

# ── A20: RLS — mesmo COM privilégio, a RLS sem policy nega tudo (2a camada) ─
# Concede de propósito para isolar a camada: se a RLS não estivesse ligada,
# aqui apareceriam as linhas semeadas.
P -q -c "GRANT SELECT ON TABLE public.ia_uso_evento TO authenticated;"
V=$(Pq -c "SET ROLE authenticated; SELECT count(*) FROM public.ia_uso_evento;" | tail -1)
eq "A20 RLS sem policy: 0 linhas mesmo com GRANT" "$V" "0"
P -q -c "REVOKE ALL ON TABLE public.ia_uso_evento FROM authenticated;"

# ── A21: REVOKE de EXECUTE — authenticated não chama a RPC ────────────────
# Sem isto, um cliente chamaria a RPC com o user_id de OUTRO e queimaria a cota alheia.
R=$(P -tA 2>&1 <<SQL
SET ROLE authenticated;
DO \$do\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.ia_consumir_cota('$U1','teste-hora');
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A21_EXECUTOU'; ELSE RAISE NOTICE 'SENT_A21_BARROU'; END IF;
END \$do\$;
SQL
)
case "$R" in
  *SENT_A21_BARROU*)    ok  "A21 REVOKE barra EXECUTE de authenticated (42501)" ;;
  *SENT_A21_EXECUTOU*)  bad "A21 authenticated EXECUTOU a RPC" ;;
  *)                    bad "A21 resultado inesperado: $R" ;;
esac

# ── A22: service_role EXECUTA (o grant que a edge usa de fato) ────────────
V=$(Pq -c "SET ROLE service_role; SELECT permitido FROM public.ia_consumir_cota('$U2','teste-hora');" | tail -1)
eq "A22 service_role executa a RPC" "$V" "t"

# ── A23: cron de purga registrado com o DELETE certo ─────────────────────
V=$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='ia-uso-evento-purga' AND command LIKE '%DELETE FROM public.ia_uso_evento%7 days%';")
eq "A23 cron de purga registrado" "$V" "1"

# ── A24: o advisory lock é REALMENTE adquirido ───────────────────────────
# Uma 2a conexão segura o MESMO lock; a RPC tem de BLOQUEAR (55P03 sob
# lock_timeout). Sem o lock, duas requisições simultâneas do mesmo usuário leem
# o mesmo contador e ambas passam — a corrida que a cota existe para fechar.
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q -c \
  "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${U1}:trava-teste', 0)); SELECT pg_sleep(8);" \
  >/dev/null 2>&1 &
LOCK_PID=$!
# Espera determinística (sem sleep cego): poll até o lock aparecer em pg_locks.
HELD=0
for _ in $(seq 1 100); do
  HELD=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory';")
  [ "$HELD" -ge 1 ] && break
  sleep 0.1
done
eq "A24a lock de teste adquirido pela 2a sessao" "$HELD" "1"

R=$(P -tA 2>&1 <<SQL
SET lock_timeout='1500ms';
DO \$do\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.ia_consumir_cota('$U1','trava-teste');
    v_passou := true;
  EXCEPTION
    WHEN lock_not_available THEN NULL;   -- 55P03 = bloqueou como devia
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_A24_SEM_LOCK'; ELSE RAISE NOTICE 'SENT_A24_SERIALIZOU'; END IF;
END \$do\$;
SQL
)
kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true
case "$R" in
  *SENT_A24_SERIALIZOU*) ok  "A24b RPC serializa por (usuario,funcao) via advisory lock" ;;
  *SENT_A24_SEM_LOCK*)   bad "A24b RPC NAO pegou o advisory lock — corrida aberta" ;;
  *)                     bad "A24b resultado inesperado: $R" ;;
esac

# ── A25: idempotência — re-aplicar NÃO desfaz ajuste manual do founder ────
P -q -c "UPDATE public.ia_uso_limite SET limite_hora=99, limite_dia=199 WHERE funcao='identify-tool';"
P -q -f "$MIG" >/dev/null
V=$(Pq -c "SELECT limite_hora||'/'||limite_dia FROM public.ia_uso_limite WHERE funcao='identify-tool';")
eq "A25 re-aplicar preserva ajuste manual" "$V" "99/199"
P -q -c "UPDATE public.ia_uso_limite SET limite_hora=20, limite_dia=60 WHERE funcao='identify-tool';"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem tem de matar o assert que ela mira) ──"

SAB="$(mktemp "/tmp/sabotagem-${SLUG}.XXXXXX.sql")"
# Sabota via sed SOBRE A MIGRATION REAL: garante que só o trecho mirado muda.
sabotar()   { sed -E "$1" "$MIG" > "$SAB"; cmp -s "$SAB" "$MIG" && { echo "  ❌ sed NAO casou nada — sabotagem inerte"; FAIL=$((FAIL+1)); return 1; }; P -q -f "$SAB" >/dev/null; }
restaurar() { P -q -f "$MIG" >/dev/null; }
dente()     { PASS=$((PASS+1)); echo "  ✅ $1 (sabotagem detectada)"; }
falso()     { FAIL=$((FAIL+1)); echo "  ❌ FALSIFICAÇÃO FRACA: $1 — sabotei e o comportamento nao mudou"; }

# ── F1 mira A7: gate da hora desligado ───────────────────────────────────
if sabotar 's/IF v_usado_hora >= v_limite_hora THEN/IF false THEN/'; then
  V=$(Pq -c "SELECT permitido FROM public.ia_consumir_cota('$U2','teste-hora');")
  if [ "$V" = "t" ]; then dente "F1 gate da hora"; else falso "F1 gate da hora"; fi
fi
restaurar

# ── F2 mira A15: fail-closed do limite ausente desligado ─────────────────
if sabotar 's/^  IF NOT FOUND THEN/  IF false THEN/'; then
  V=$(Pq -c "SELECT permitido FROM public.ia_consumir_cota('$U1','outra-edge-nao-configurada');")
  if [ "$V" = "t" ]; then dente "F2 fail-closed sem_limite"; else falso "F2 fail-closed sem_limite"; fi
fi
restaurar

# ── F3 mira A11: janela da hora vira 24h (exatamente o furo do bucket) ───
# U1/teste-hora tem 3 eventos de 2h atrás + 1 recente: sob a janela sabotada os
# 4 contam como "da hora" e o limite 3 passa a morder onde não devia.
if sabotar "s/interval '1 hour'\\)::integer/interval '24 hours')::integer/"; then
  V=$(Pq -c "SELECT permitido FROM public.ia_consumir_cota('$U1','teste-hora');")
  if [ "$V" = "f" ]; then dente "F3 janela deslizante da hora"; else falso "F3 janela deslizante da hora"; fi
fi
restaurar

# ── F4 mira A24b: advisory lock removido ────────────────────────────────
if sabotar 's/^  PERFORM pg_advisory_xact_lock/  -- PERFORM pg_advisory_xact_lock/'; then
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q -c \
    "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('${U2}:trava-teste', 0)); SELECT pg_sleep(8);" \
    >/dev/null 2>&1 &
  LOCK_PID=$!
  for _ in $(seq 1 100); do
    HELD=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory';")
    [ "$HELD" -ge 1 ] && break
    sleep 0.1
  done
  R=$(P -tA 2>&1 <<SQL
SET lock_timeout='1500ms';
DO \$do\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.ia_consumir_cota('$U2','trava-teste');
    v_passou := true;
  EXCEPTION
    WHEN lock_not_available THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_F4_SEM_LOCK'; ELSE RAISE NOTICE 'SENT_F4_SERIALIZOU'; END IF;
END \$do\$;
SQL
)
  kill "$LOCK_PID" 2>/dev/null || true
  wait "$LOCK_PID" 2>/dev/null || true
  case "$R" in
    *SENT_F4_SEM_LOCK*) dente "F4 advisory lock" ;;
    *)                  falso "F4 advisory lock" ;;
  esac
fi
restaurar

# ── F5 mira A21: EXECUTE liberado para authenticated ────────────────────
P -q -c "GRANT EXECUTE ON FUNCTION public.ia_consumir_cota(uuid, text) TO authenticated;"
R=$(P -tA 2>&1 <<SQL
SET ROLE authenticated;
DO \$do\$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.ia_consumir_cota('$U1','teste-hora');
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SENT_F5_EXECUTOU'; ELSE RAISE NOTICE 'SENT_F5_BARROU'; END IF;
END \$do\$;
SQL
)
case "$R" in
  *SENT_F5_EXECUTOU*) dente "F5 REVOKE de EXECUTE" ;;
  *)                  falso "F5 REVOKE de EXECUTE" ;;
esac
restaurar

# ── F6 mira A20: policy permissiva fura a RLS ───────────────────────────
P -q <<'SQL'
GRANT SELECT ON TABLE public.ia_uso_evento TO authenticated;
CREATE POLICY sabotagem_tudo_liberado ON public.ia_uso_evento FOR SELECT TO authenticated USING (true);
SQL
V=$(Pq -c "SET ROLE authenticated; SELECT (count(*) > 0) FROM public.ia_uso_evento;" | tail -1)
if [ "$V" = "t" ]; then dente "F6 RLS sem policy"; else falso "F6 RLS sem policy"; fi
P -q <<'SQL'
DROP POLICY sabotagem_tudo_liberado ON public.ia_uso_evento;
REVOKE ALL ON TABLE public.ia_uso_evento FROM authenticated;
SQL
restaurar
rm -f "$SAB"

# ── A26: pós-restauro, a migration real voltou inteira ──────────────────
V=$(Pq -c "SELECT permitido||'|'||motivo FROM public.ia_consumir_cota('$U1','edge-que-ninguem-configurou');")
eq "A26 pos-restauro: fail-closed de volta" "$V" "false|sem_limite"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
