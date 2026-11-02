#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (o pg-harness resolve o PGBIN no Mac e no runner Linux do CI) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5474}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="telemetria-vitals"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── pré-requisitos que a migration referencia e não cria ──
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $$;
SQL

# ── a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20261102093527_telemetria_vitals.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# Idempotência: o founder/MCP pode re-colar.
P -q -f "$MIG"
echo "migration re-aplicada (idempotente)"

UID_A="11111111-1111-1111-1111-111111111111"
UID_B="22222222-2222-2222-2222-222222222222"
DEV_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
P -q <<SQL
INSERT INTO auth.users (id) VALUES ('$UID_A'), ('$UID_B') ON CONFLICT DO NOTHING;
-- FIEL A PROD: o ALTER DEFAULT PRIVILEGES de public dá arwdDxtm a authenticated/anon.
GRANT ALL ON public.telemetria_vitals TO authenticated, anon;
SQL

# Como o PostgREST traduz o `.upsert(..., { onConflict: 'user_id,metrica_id' })` do
# supabase-js: INSERT … ON CONFLICT (cols) DO UPDATE SET <cada coluna do payload> =
# EXCLUDED.<coluna>. O payload do cliente NÃO manda criado_em/atualizado_em.
upsert() { # upsert <uid_dono_da_linha> <metrica_id> <valor> [rota]
  echo "INSERT INTO public.telemetria_vitals
          (user_id, metrica_id, metrica, valor, classificacao, rota, navegacao, conexao, device_id, build_id)
        VALUES ('$1', '$2', 'inp', $3, 'bom', '${4:-/pedidos/:id}', 'navegacao', '4g', '$DEV_A', 'index-teste')
        ON CONFLICT (user_id, metrica_id) DO UPDATE SET
          metrica = EXCLUDED.metrica, valor = EXCLUDED.valor, classificacao = EXCLUDED.classificacao,
          rota = EXCLUDED.rota, navegacao = EXCLUDED.navegacao, conexao = EXCLUDED.conexao,
          device_id = EXCLUDED.device_id, build_id = EXCLUDED.build_id;"
}
como() { # como <uid> <sql>  — roda como authenticated com o GUC de impersonação
  P -q -c "SET test.uid='$1'; SET test.role='authenticated'; SET ROLE authenticated; $2"
}
como_v() { # como_v <uid> <sql> — idem, devolvendo só o valor (tuples-only)
  Pq -c "SET test.uid='$1'; SET test.role='authenticated'; SET ROLE authenticated; $2" | tail -1
}
# INSERT PURO (sem ON CONFLICT): o PostgREST aceita `.insert()` também. Precisa de
# assert próprio porque, no UPSERT, a policy de SELECT é aplicada à linha NOVA e
# barra sozinha a linha alheia — a de INSERT ficaria sem dente (falsificação F1).
insere() { # insere <uid_dono> <metrica_id>
  echo "INSERT INTO public.telemetria_vitals (user_id, metrica_id, metrica, valor, classificacao, rota, navegacao)
        VALUES ('$1', '$2', 'lcp', 10, 'bom', '/', 'navegacao');"
}
neg() { # neg <desc> <sqlstate> <uid> <sql>
  local desc="$1" state="$2" uid="$3" sql="$4"
  if como "$uid" "DO \$t\$ BEGIN
  $sql
  RAISE EXCEPTION 'ZZ_NAO_BARROU';
EXCEPTION
  WHEN $state THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;" >/dev/null 2>&1
  then ok "$desc (barrado com $state)"; else bad "$desc — NÃO barrou com $state"; fi
}
valor_de() { Pq -c "SELECT valor::text FROM public.telemetria_vitals WHERE user_id='$1' AND metrica_id='$2';"; }

echo "── POSITIVOS (controle verde) ──"
# P1: 1º envio (INSERT) sem criado_em — o DEFAULT passa pelo WITH CHECK da janela.
como "$UID_A" "$(upsert "$UID_A" v5-p1 120)" >/dev/null 2>&1 || true
eq "P1 1º envio do próprio usuário grava" "$(valor_de "$UID_A" v5-p1)" "120.0000"

# P2: 2º envio da MESMA instância (INP piorou) — UPSERT fica com o último valor, 1 linha só.
CRIADO_ANTES=$(Pq -c "SELECT criado_em FROM public.telemetria_vitals WHERE metrica_id='v5-p1';")
como "$UID_A" "$(upsert "$UID_A" v5-p1 480)" >/dev/null 2>&1 || true
eq "P2 upsert da mesma instância fica com o ÚLTIMO valor" "$(valor_de "$UID_A" v5-p1)" "480.0000"
eq "P3 continua 1 linha por instância" \
   "$(Pq -c "SELECT count(*) FROM public.telemetria_vitals WHERE metrica_id='v5-p1';")" "1"

# P4: o upsert não move criado_em (o cliente não manda; mas nem um UPDATE explícito move).
como "$UID_A" "UPDATE public.telemetria_vitals SET criado_em = now() + interval '30 seconds'
               WHERE user_id='$UID_A' AND metrica_id='v5-p1';" >/dev/null 2>&1 || true
eq "P4 criado_em é do 1º envio (trigger segura)" \
   "$(Pq -c "SELECT criado_em FROM public.telemetria_vitals WHERE metrica_id='v5-p1';")" "$CRIADO_ANTES"
eq "P5 atualizado_em anda no upsert" \
   "$(Pq -c "SELECT atualizado_em > criado_em FROM public.telemetria_vitals WHERE metrica_id='v5-p1';")" "t"

# P6: o MESMO metrica_id de outro usuário é outra linha (chave é user_id+metrica_id).
como "$UID_B" "$(upsert "$UID_B" v5-p1 50)" >/dev/null 2>&1 || true
eq "P6 B grava a própria instância com o mesmo id" "$(valor_de "$UID_B" v5-p1)" "50.0000"
eq "P7 a linha de A segue intacta" "$(valor_de "$UID_A" v5-p1)" "480.0000"

echo "── NEGATIVOS (a defesa morde) ──"
neg "N1 A insere (INSERT puro) linha em nome de B" "insufficient_privilege" "$UID_A" "$(insere "$UID_B" v5-n1)"
neg "N1b A faz UPSERT de linha em nome de B" "insufficient_privilege" "$UID_A" "$(upsert "$UID_B" v5-n1b 10)"
neg "N2 anônimo (sem uid) insere" "insufficient_privilege" "" "$(upsert "$UID_A" v5-n2 10)"
neg "N3 metrica fora do vocabulário" "check_violation" "$UID_A" \
    "INSERT INTO public.telemetria_vitals (user_id, metrica_id, metrica, valor, classificacao, rota, navegacao)
     VALUES ('$UID_A', 'v5-n3', 'tbt', 1, 'bom', '/', 'navegacao');"
neg "N4 valor negativo" "check_violation" "$UID_A" "$(upsert "$UID_A" v5-n4 -1)"
neg "N5 criado_em fora da janela" "insufficient_privilege" "$UID_A" \
    "INSERT INTO public.telemetria_vitals (user_id, metrica_id, metrica, valor, classificacao, rota, navegacao, criado_em)
     VALUES ('$UID_A', 'v5-n5', 'lcp', 1, 'bom', '/', 'navegacao', now() - interval '2 hours');"

# Sem policy que deixe A ver/alterar a linha de B, o Postgres não ERRA — não enxerga.
# UPDATE SEM WHERE e com SET constante: não lê coluna, então a policy de SELECT NÃO
# entra — é o único ataque em que a de UPDATE responde sozinha (falsificação F4).
como "$UID_A" "UPDATE public.telemetria_vitals SET valor = 999;" >/dev/null 2>&1 || true
eq "N6 UPDATE sem WHERE de A não toca a linha de B" "$(valor_de "$UID_B" v5-p1)" "50.0000"
eq "N7 ...e só toca a própria" "$(valor_de "$UID_A" v5-p1)" "999.0000"
eq "N8 A não LÊ as linhas de B" \
   "$(como_v "$UID_A" "SELECT count(*) FROM public.telemetria_vitals WHERE user_id='$UID_B';")" "0"
eq "N9 sem policy de DELETE: A não apaga nem a própria" \
   "$(como_v "$UID_A" "WITH d AS (DELETE FROM public.telemetria_vitals RETURNING 1) SELECT count(*) FROM d;")" "0"

echo "── FALSIFICAÇÃO (sabota → exige VERMELHO → restaura) ──"
sabota_e_exige_vermelho() { # <desc> <sql-sabotagem> <assert-fn>
  local desc="$1" sql="$2"; shift 2
  local antes=$FAIL
  P -q -c "$sql" >/dev/null 2>&1
  "$@" >/dev/null 2>&1
  if [ "$FAIL" -gt "$antes" ]; then
    PASS=$((PASS+1)); FAIL=$antes; echo "  ✅ falsificação: $desc → assert ficou VERMELHO"
  else
    FAIL=$((antes+1)); echo "  ❌ falsificação: $desc → assert seguiu VERDE (sem dente)"
  fi
}
# Restaura a policy/trigger a partir da PRÓPRIA migration (idempotente), não de cópia à mão.
restaurar() { P -q -f "$MIG" >/dev/null 2>&1; }

# F1 — INSERT sem o `auth.uid() = user_id`: o INSERT puro do N1 deixa de ser barrado.
f1() { neg "F1" "insufficient_privilege" "$UID_A" "$(insere "$UID_B" v5-f1)"; }
sabota_e_exige_vermelho "WITH CHECK do INSERT sem dono" \
"DROP POLICY \"telemetria_vitals_user_insert\" ON public.telemetria_vitals;
 CREATE POLICY \"telemetria_vitals_user_insert\" ON public.telemetria_vitals FOR INSERT WITH CHECK (true);" f1
restaurar

# F2 — sem policy de UPDATE: o 2º envio da instância (P2) não atualiza.
f2() { como "$UID_A" "$(upsert "$UID_A" v5-p1 900)" >/dev/null 2>&1 || true
       eq "F2" "$(valor_de "$UID_A" v5-p1)" "900.0000"; }
sabota_e_exige_vermelho "policy de UPDATE removida" \
"DROP POLICY \"telemetria_vitals_user_update\" ON public.telemetria_vitals;" f2
restaurar

# F3 — sem a policy de SELECT própria: prova a afirmação do cabeçalho da migration
# (o ON CONFLICT DO UPDATE exige que a linha existente passe a policy de SELECT).
f3() { como "$UID_A" "$(upsert "$UID_A" v5-p1 901)" >/dev/null 2>&1 || true
       eq "F3" "$(valor_de "$UID_A" v5-p1)" "901.0000"; }
sabota_e_exige_vermelho "policy de SELECT própria removida" \
"DROP POLICY \"telemetria_vitals_user_read\" ON public.telemetria_vitals;" f3
restaurar

# F4 — UPDATE com USING aberto: o UPDATE sem WHERE de A passa a alterar a linha de B.
f4() { como "$UID_A" "UPDATE public.telemetria_vitals SET valor = 777;" >/dev/null 2>&1 || true
       eq "F4" "$(valor_de "$UID_B" v5-p1)" "50.0000"; }
sabota_e_exige_vermelho "UPDATE com USING (true)" \
"DROP POLICY \"telemetria_vitals_user_update\" ON public.telemetria_vitals;
 CREATE POLICY \"telemetria_vitals_user_update\" ON public.telemetria_vitals FOR UPDATE USING (true) WITH CHECK (true);" f4
restaurar
P -q -c "UPDATE public.telemetria_vitals SET valor = 50 WHERE user_id='$UID_B' AND metrica_id='v5-p1';" >/dev/null

# F5 — sem o trigger de carimbo: o UPDATE do cliente move criado_em (P4 fica vermelho).
f5() { como "$UID_A" "UPDATE public.telemetria_vitals SET criado_em = now() + interval '30 seconds'
                      WHERE user_id='$UID_A' AND metrica_id='v5-p1';" >/dev/null 2>&1 || true
       eq "F5" "$(Pq -c "SELECT criado_em FROM public.telemetria_vitals WHERE metrica_id='v5-p1' AND user_id='$UID_A';")" "$CRIADO_ANTES"; }
sabota_e_exige_vermelho "trigger de carimbo removido" \
"DROP TRIGGER trg_telemetria_vitals_carimbar ON public.telemetria_vitals;" f5
restaurar

# F6 — a postcondição morde: um arquivo que perdeu uma policy, aplicado sobre a
# tabela sem ela, tem de ABORTAR (A2), não terminar em silêncio. Controle: o mesmo
# arquivo sem a policy aplica LIMPO enquanto a policy ainda existe? Não — a A2 conta
# 4 policies e a existente segue lá, então ele PASSA (é o controle verde de f6).
SEM_POLICY="$(mktemp /tmp/mig-sem-policy.XXXXXX)"
sed '/DROP POLICY IF EXISTS "telemetria_vitals_user_read"/,/USING (auth.uid() = user_id);/d' "$MIG" > "$SEM_POLICY"
f6() { if P -q -f "$SEM_POLICY" >/dev/null 2>&1; then ok "F6 arquivo sem a policy aplicou"; else bad "F6 postcondição abortou"; fi; }
f6 >/dev/null
eq "F6-controle: arquivo sem a policy aplica enquanto a policy ainda existe" "$FAIL" "0"
sabota_e_exige_vermelho "policy de SELECT ausente → postcondição A2 aborta a aplicação" \
"DROP POLICY \"telemetria_vitals_user_read\" ON public.telemetria_vitals;" f6
rm -f "$SEM_POLICY"
restaurar

# ── controle pós-falsificação: o estado restaurado volta a passar ──
eq "C1 após restaurar, a linha de B segue 50" "$(valor_de "$UID_B" v5-p1)" "50.0000"
eq "C2 após restaurar, 4 policies" \
   "$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename='telemetria_vitals';")" "4"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
