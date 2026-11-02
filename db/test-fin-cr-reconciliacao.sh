#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261102020000_fin_cr_reconciliacao_exclusoes.sql               ║
# ║  Título excluído no Omie sai do espelho SÓ com prova; título real nunca.      ║
# ║  Rode: bash db/test-fin-cr-reconciliacao.sh > /tmp/t.log 2>&1                 ║
# ║                                                                                ║
# ║  fin_cr_marcar_ausentes (ausência → candidato) e fin_cr_excluir_confirmados   ║
# ║  (prova da edge → tombstone + DELETE):                                         ║
# ║   B baixa · E estorno · X exclusão (marca → candidato → prova → apaga)        ║
# ║   D deslize se cura · R retry do MESMO run não vira candidato                  ║
# ║   P observação positiva no run vence a prova · N/S não-marcado e fechado      ║
# ║   não se apagam · T teto sem escrita · K falha no tombstone desfaz o DELETE   ║
# ║   I isolamento por empresa · A ACL/argumentos                                  ║
# ║  FALSIFICAÇÃO na MESMA invocação (5 sabotagens) com controle verde antes e     ║
# ║  depois; cada sabotagem tem de reprovar O SEU invariante (rótulo exigido).     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5487}"
SLUG="fin-cr-reconciliacao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C PGTZ=UTC

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(dirname "$DATA")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# Forma de PROD medida via psql-ro em 2026-11-02: PK uuid, UNIQUE(company, omie_codigo_lancamento),
# CHECK de company, status default 'ABERTO', updated_at default now() SEM trigger de updated_at; os dois
# triggers de prod (audit e period lock) pulam service_role — o stub do lock reproduz isso e BARRA o resto.
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  omie_codigo_lancamento bigint NOT NULL,
  omie_codigo_cliente bigint,
  status_titulo text DEFAULT 'ABERTO',
  data_emissao date,
  valor_documento numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (company, omie_codigo_lancamento)
);
CREATE TABLE public.fin_ic_matches (id serial PRIMARY KEY, cr_id uuid REFERENCES public.fin_contas_receber(id) ON DELETE SET NULL);
GRANT ALL ON public.fin_contas_receber, public.fin_ic_matches TO service_role, authenticated, anon;
CREATE FUNCTION public.lock_stub() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED: stub (role=%)', auth.role();
END $f$;
CREATE TRIGGER trg_period_lock BEFORE INSERT OR DELETE OR UPDATE ON public.fin_contas_receber
  FOR EACH ROW EXECUTE FUNCTION public.lock_stub();
SQL

MIG="$REPO_ROOT/supabase/migrations/20261102020000_fin_cr_reconciliacao_exclusoes.sql"
P -q -f "$MIG"
P -q -f "$MIG" >/dev/null 2>&1 && ok "L0 migration aplica 2× (idempotente)" || bad "L0 migration NÃO re-aplica"

# ── helpers (sempre como service_role, que é quem chama na edge) ──
SR="SET test.role='service_role'; SET ROLE service_role;"
T1="2026-11-02 08:20:00+00"; T2="2026-11-02 14:20:00+00"
VELHO="2026-11-01 00:00:00+00"   # updated_at dos títulos semeados: antes de qualquer run (não depende do relógio)
reset() { P -q -c "SET test.role='service_role'; TRUNCATE public.fin_ic_matches, public.fin_contas_receber_excluidos; DELETE FROM public.fin_contas_receber;"; }
# tit <empresa> <codigo> <status> [updated_at]
tit() { P -q -c "SET test.role='service_role'; INSERT INTO public.fin_contas_receber(company,omie_codigo_lancamento,status_titulo,data_emissao,updated_at) VALUES ('$1',$2,'$3','2026-10-01','${4:-$VELHO}');"; }
semeia_oben() { reset; for c in 1 2 3 4 5 6 7 8 9 10; do tit oben "$c" 'A VENCER'; done; }
# marcar <empresa> <vistos> <t0> → jsonb ou "ERRO:<msg>"
marcar() { { P -tA -q -c "$SR SELECT public.fin_cr_marcar_ausentes('$1','$2'::bigint[],'$3'::timestamptz);" 2>&1 || true; } | sed -n 's/.*ERROR:  *\(.*\)/ERRO:\1/p; /^{/p'; }
# excluir <empresa> <json-array> <t0>
excluir() { { P -tA -q -c "$SR SELECT public.fin_cr_excluir_confirmados('$1','$2'::jsonb,'$3'::timestamptz);" 2>&1 || true; } | sed -n 's/.*ERROR:  *\(.*\)/ERRO:\1/p; /^{/p'; }
EV='{"cliente":1,"emissao_de":"30/09/2026","emissao_ate":"02/10/2026","total_de_registros":0}'
conf() { local out="[" sep=""; for c in "$@"; do out="$out$sep{\"codigo\":$c,\"evidencia\":$EV}"; sep=","; done; echo "$out]"; }
existe() { Pq -c "SET test.role='service_role'; SELECT count(*) FROM public.fin_contas_receber WHERE company='$1' AND omie_codigo_lancamento=$2;"; }
marca()  { Pq -c "SET test.role='service_role'; SELECT coalesce(ausente_omie_desde::text,'NULL') FROM public.fin_contas_receber WHERE company='$1' AND omie_codigo_lancamento=$2;"; }
tomb()   { Pq -c "SELECT count(*) FROM public.fin_contas_receber_excluidos WHERE company='$1' AND omie_codigo_lancamento=$2;"; }
campo()  { printf '%s' "$1" | sed -n "s/.*\"$2\": *\([0-9]*\).*/\1/p"; }
cands()  { printf '%s' "$1" | grep -o '"codigo": *[0-9]*' | sed 's/.*: *//' | paste -sd, -; }

# Cenários que dependem da regra — rodam no CONTROLE e em cada SABOTAGEM. Cada assert tem um RÓTULO
# curto; a falsificação exige que o rótulo do SEU invariante reprove (não basta "algo ficou vermelho").
cenarios() {
  echo "── B baixa (título 3 chega em B como RECEBIDO) ──"
  semeia_oben
  P -q -c "SET test.role='service_role'; UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=3;"
  r=$(marcar oben '{1,2,3,4,5,6,7,8,9,10}' "$T1")
  eq "B1 baixa: nenhum ausente" "$(campo "$r" ausentes)" "0"
  eq "B2 baixa: título segue no espelho" "$(existe oben 3)" "1"

  echo "── E estorno (título 11 volta ao aberto e chega em A) ──"
  semeia_oben; tit oben 11 'RECEBIDO'
  P -q -c "SET test.role='service_role'; UPDATE public.fin_contas_receber SET status_titulo='ATRASADO' WHERE omie_codigo_lancamento=11;"
  r=$(marcar oben '{1,2,3,4,5,6,7,8,9,10,11}' "$T1")
  eq "E1 estorno: nenhum ausente" "$(campo "$r" ausentes)" "0"

  echo "── X exclusão (7 some de A e B; run2 vira candidato; a edge prova; apaga) ──"
  semeia_oben
  P -q -c "SET test.role='service_role'; INSERT INTO public.fin_ic_matches(cr_id) SELECT id FROM public.fin_contas_receber WHERE omie_codigo_lancamento=7;"
  r=$(marcar oben '{1,2,3,4,5,6,8,9,10}' "$T1")
  eq "X1 run1 marca 1" "$(campo "$r" marcados)" "1"
  eq "X2 run1 não devolve candidato (ausência de 1 run não basta)" "$(cands "$r")" ""
  eq "X3 marca = t0 do run1" "$(marca oben 7)" "2026-11-02 08:20:00+00"
  r=$(marcar oben '{1,2,3,4,5,6,8,9,10}' "$T2")
  eq "X4 run2 devolve o candidato" "$(cands "$r")" "7"
  eq "X5 marcar NUNCA apaga" "$(existe oben 7)" "1"
  r=$(excluir oben "$(conf 7)" "$T2")
  eq "X6 prova → exclui 1" "$(campo "$r" excluidos)" "1"
  eq "X7 apagado do espelho" "$(existe oben 7)" "0"
  eq "X8 tombstone gravado" "$(tomb oben 7)" "1"
  eq "X9 tombstone guarda linha (id) e evidência" \
    "$(Pq -c "SELECT (linha->>'id' = cr_id::text AND linha->>'status_titulo'='A VENCER' AND evidencia->>'total_de_registros'='0')::text FROM public.fin_contas_receber_excluidos WHERE omie_codigo_lancamento=7;")" "true"
  eq "X10 FK do IC vira NULL" "$(Pq -c "SELECT count(*) FROM public.fin_ic_matches WHERE cr_id IS NULL;")" "1"
  eq "X11 os outros 9 intactos" "$(Pq -c "SET test.role='service_role'; SELECT count(*) FROM public.fin_contas_receber WHERE company='oben';")" "9"

  echo "── D deslize (4 some só no run1) ──"
  semeia_oben
  marcar oben '{1,2,3,5,6,7,8,9,10}' "$T1" >/dev/null
  r=$(marcar oben '{1,2,3,4,5,6,7,8,9,10}' "$T2")
  eq "D1 run2 limpou a marca" "$(marca oben 4)" "NULL"
  eq "D2 run2 sem candidato" "$(cands "$r")" ""

  echo "── R retry do MESMO run (mesmo t0) ──"
  semeia_oben
  marcar oben '{1,2,3,4,5,6,7,8,9}' "$T1" >/dev/null
  r=$(marcar oben '{1,2,3,4,5,6,7,8,9}' "$T1")
  eq "R1 retry com o mesmo t0 não vira candidato" "$(cands "$r")" ""
  r=$(excluir oben "$(conf 10)" "$T1")
  eq "R2 excluir no mesmo t0 da marca não apaga" "$(existe oben 10)" "1"

  echo "── P observação positiva neste run vence a prova ──"
  semeia_oben
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T1" >/dev/null
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T2" >/dev/null
  # a listagem do cliente achou o 7 e a edge o regravou (upsert) depois do t0 do run2
  P -q -c "SET test.role='service_role'; UPDATE public.fin_contas_receber SET updated_at='2026-11-02 14:21:00+00' WHERE omie_codigo_lancamento=7;"
  r=$(excluir oben "$(conf 7)" "$T2")
  eq "P1 regravado no run não é apagado" "$(existe oben 7)" "1"

  echo "── N/S não-marcado e fechado não se apagam, mesmo com 'prova' ──"
  semeia_oben
  r=$(excluir oben "$(conf 5)" "$T2")
  eq "N1 sem marca: não apaga" "$(existe oben 5)" "1"
  marcar oben '{1,2,3,4,5,6,7,8,9}' "$T1" >/dev/null
  P -q -c "SET test.role='service_role'; UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=10;"
  r=$(excluir oben "$(conf 10)" "$T2")
  eq "S1 fechado: não apaga" "$(existe oben 10)" "1"

  echo "── T teto (10 abertos, 6 ausentes > max(5,1)) ──"
  semeia_oben
  r=$(marcar oben '{1,2,3,4}' "$T1")
  case "$r" in *TETO*) ok "T1 RAISE com TETO";; *) bad "T1 esperava TETO, veio [$r]";; esac
  eq "T2 nada marcado" "$(Pq -c "SET test.role='service_role'; SELECT count(*) FROM public.fin_contas_receber WHERE ausente_omie_desde IS NOT NULL;")" "0"
  r=$(marcar oben '{1,2,3,4,5}' "$T1")
  eq "T3 5 ausentes (= piso do teto) passa" "$(campo "$r" marcados)" "5"

  echo "── K falha no tombstone desfaz o DELETE ──"
  semeia_oben
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T1" >/dev/null
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T2" >/dev/null
  P -q -c "REVOKE INSERT ON public.fin_contas_receber_excluidos FROM service_role;"
  r=$(excluir oben "$(conf 7)" "$T2")
  P -q -c "GRANT INSERT ON public.fin_contas_receber_excluidos TO service_role;"
  case "$r" in ERRO:*) ok "K1 excluir lança sem tombstone";; *) bad "K1 esperava erro, veio [$r]";; esac
  eq "K2 título continua no espelho" "$(existe oben 7)" "1"

  echo "── I isolamento por empresa ──"
  semeia_oben; tit colacor 7 'ATRASADO'
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T1" >/dev/null
  marcar oben '{1,2,3,4,5,6,8,9,10}' "$T2" >/dev/null
  excluir oben "$(conf 7)" "$T2" >/dev/null
  eq "I1 o código 7 da colacor não é tocado" "$(existe colacor 7)" "1"
  eq "I2 nem marcado" "$(marca colacor 7)" "NULL"
}

cenarios_acl() {
  echo "── A ACL e argumentos ──"
  local fm="public.fin_cr_marcar_ausentes(text,bigint[],timestamptz)" fe="public.fin_cr_excluir_confirmados(text,jsonb,timestamptz)" e
  eq "A1 anon sem EXECUTE (2 funções)" "$(Pq -c "SELECT has_function_privilege('anon','$fm','EXECUTE')::text||has_function_privilege('anon','$fe','EXECUTE')::text;")" "falsefalse"
  eq "A2 authenticated sem EXECUTE (2)" "$(Pq -c "SELECT has_function_privilege('authenticated','$fm','EXECUTE')::text||has_function_privilege('authenticated','$fe','EXECUTE')::text;")" "falsefalse"
  eq "A3 service_role com EXECUTE (2)" "$(Pq -c "SELECT has_function_privilege('service_role','$fm','EXECUTE')::text||has_function_privilege('service_role','$fe','EXECUTE')::text;")" "truetrue"
  e=$(P -tA -q -c "SET ROLE authenticated; SELECT public.fin_cr_excluir_confirmados('oben','[]',now());" 2>&1 || true)
  case "$e" in *"permission denied"*) ok "A4 authenticated barrado na execução";; *) bad "A4 veio [$e]";; esac
  e=$(P -tA -q -c "$SR SELECT public.fin_cr_marcar_ausentes('oben',NULL,now());" 2>&1 || true)
  case "$e" in *"argumento ausente"*) ok "A5 vistos NULL lança (ausente ≠ vazio)";; *) bad "A5 veio [$e]";; esac
  e=$(excluir oben '[{"codigo":"7","evidencia":{}}]' "$T2"; excluir oben '[{"codigo":7}]' "$T2")
  eq "A6 código não-numérico / sem evidência → recusa (2×)" "$(printf '%s\n' "$e" | grep -c 'sem codigo')" "2"
  e=$(P -tA -q -c "SET test.role='authenticated'; DELETE FROM public.fin_contas_receber;" 2>&1 || true)
  case "$e" in *PERIOD_LOCKED*) ok "A7 controle do stub: fora do service_role o lock barra";; *) bad "A7 veio [$e]";; esac
}

echo "═══ CONTROLE (migration real) ═══"
cenarios; cenarios_acl
CONTROLE_FAIL=$FAIL

# ── FALSIFICAÇÃO: cada sabotagem re-aplica as funções a partir de uma CÓPIA da migration (o arquivo do repo
# nunca é tocado) e exige que o assert DO SEU invariante (rótulo) reprove; depois a real volta. ──
sabota() {   # sabota <rótulo-exigido> <âncora> <substituto> [<âncora> <substituto> …]
  local rotulo="$1" cop="$TMPD/sabotada.sql" saida
  shift
  python3 -I - "$MIG" "$cop" "$@" <<'PY'
import sys
src, dst, *pares = sys.argv[1:]
s = open(src).read()
for old, new in zip(pares[::2], pares[1::2]):
    if s.count(old) != 1:
        sys.exit(f"ANCORA NAO UNICA ({s.count(old)}): {old!r}")
    s = s.replace(old, new)
open(dst, "w").write(s.split("DO $post$")[0])
PY
  P -q -f "$cop"
  local antes_pass=$PASS antes_fail=$FAIL
  saida=$(cenarios 2>&1 || true)
  PASS=$antes_pass; FAIL=$antes_fail
  [ -n "${PROVA_VERBOSE:-}" ] && printf '%s\n' "$saida" | sed "s/^/    [sab $rotulo] /" >&2
  if printf '%s\n' "$saida" | grep -q "❌ $rotulo"; then ok "FALS [$rotulo] reprova com a sabotagem"; else bad "FALS [$rotulo] ficou VERDE com a sabotagem — a prova não morde"; fi
  P -q -f "$MIG" >/dev/null
}

echo "═══ FALSIFICAÇÃO ═══"
if [ "$CONTROLE_FAIL" -ne 0 ]; then
  bad "controle vermelho — falsificação abortada (sabotar sem controle verde é teatro)"
else
  sabota "X2" "     AND r.ausente_omie_desde < p_inicio_run
     AND NOT" "     AND r.ausente_omie_desde <= p_inicio_run
     AND NOT"
  sabota "P1" "     AND r.updated_at < p_inicio_run;" "     ;"
  # N1 tem DUAS defesas: a guarda de marca E o NOT NULL de excluidos.ausente_omie_desde (o INSERT do
  # tombstone de um não-marcado falha e desfaz o DELETE). A sabotagem neutraliza as duas.
  sabota "N1" "     AND r.ausente_omie_desde < p_inicio_run
     AND r.updated_at" "     AND r.updated_at" \
    "  SELECT r.company, r.omie_codigo_lancamento, r.id, to_jsonb(r), r.ausente_omie_desde, v.evid" \
    "  SELECT r.company, r.omie_codigo_lancamento, r.id, to_jsonb(r), coalesce(r.ausente_omie_desde, p_inicio_run), v.evid"
  sabota "T1" "IF v_ausentes > v_teto THEN" "IF false THEN"
  sabota "X8" "    JOIN public.fin_contas_receber r ON r.id = v.id;" "    JOIN public.fin_contas_receber r ON r.id = v.id WHERE false;"
  echo "═══ CONTROLE de novo (real re-aplicada) ═══"
  antes=$FAIL; cenarios >/dev/null
  if [ "$FAIL" -eq "$antes" ]; then ok "controle pós-falsificação verde"; else bad "controle pós-falsificação VERMELHO"; fi
fi

echo "═══ resultado: $PASS ok · $FAIL falha(s) ═══"
[ "$FAIL" -eq 0 ] && echo "PROVA_FIN_CR_RECONCILIACAO_OK"
[ "$FAIL" -eq 0 ]
