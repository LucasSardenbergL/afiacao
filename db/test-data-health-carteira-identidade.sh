#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260824091755_data_health_carteira_identidade_quarentena.sql
# ║  bash db/test-data-health-carteira-identidade.sh > /tmp/t.log 2>&1; echo $?   ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                                ║
# ║  Porta 5479 (o irmão carteira-rebuild usa 5471) pra rodar em paralelo.         ║
# ║                                                                                ║
# ║  O QUE PROVA: o Sentinela passa a enxergar a QUARENTENA DE IDENTIDADE da       ║
# ║  carteira — conflict (P1-c, #1943) e ambiguous (Fatia 2), que até 2026-08-24   ║
# ║  só existiam num console.warn de edge que ninguém lê.                          ║
# ║                                                                                ║
# ║  O assert que carrega o desenho é o A4 (`inactive`): o predicado é a NEGAÇÃO   ║
# ║  `IS DISTINCT FROM 'verified'`, igual à do consumidor (carteira-rebuild:177),  ║
# ║  então um estado SEM WRITER hoje já cai na sonda. F1 sabota isso trocando a    ║
# ║  negação por `IN ('conflict','ambiguous')` e exige que o A4 fique VERMELHO —   ║
# ║  é a prova de que a sonda não nasce cega para o estado que ainda não existe.   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="carteira-identidade-quarentena"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 - esperado [$3], veio [$2]"; fi; }
# Usado na falsificação: exige que o valor NÃO seja o esperado-correto (o assert tem de virar vermelho).
ne()  { if [ "$2" != "$3" ]; then ok "$1 (virou [$2], deixou de ser [$3])"; else bad "$1 - SABOTAGEM NAO DETECTADA: seguiu [$3]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: snapshot real (traz as 15 tabelas dos checks vizinhos
#          E a _data_health_compute ANTIGA — assim o CREATE OR REPLACE da migration
#          roda sobre a versão existente, igual à produção).
# ══════════════════════════════════════════════════════════════════════════════
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
[ -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" ] && P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -q -f "$RR" >/dev/null 2>&1 || {
  echo "!! snapshot falhou por completo — abortando (sem schema não há prova)"; exit 1; }
rm -f "$RR"

# O snapshot cria as matviews WITH NO DATA; a _data_health_compute lê customer_metrics_mv e
# uma matview não-populada ERRA em vez de devolver 0 linhas. Popula todas (tabelas vazias => rápido).
P -q <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, matviewname FROM pg_matviews WHERE NOT ispopulated LOOP
    BEGIN
      EXECUTE format('REFRESH MATERIALIZED VIEW %I.%I', r.schemaname, r.matviewname);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'matview % nao refreshou: %', r.matviewname, SQLERRM;
    END;
  END LOOP;
END $$;
SQL

# O snapshot está DEFASADO em relação ao watchdog v2 (20260814222000): faltam nele a tabela
# data_health_watchdog_estado e a função _data_health_episodio. Sem elas o A12 (que EXECUTA o
# watchdog — o teste late-bound que importa) morre com 42P01. Forma medida na PROD 2026-08-24.
P -q -f "$REPO_ROOT/db/prereq-watchdog-v2-20260824.sql"

BASE_CHECKS=$(Pq -c "SELECT count(*) FROM public._data_health_compute();" 2>/dev/null || echo "ERRO")
echo "snapshot aplicado; checks ANTES da migration: $BASE_CHECKS"
[ "$BASE_CHECKS" = "ERRO" ] && { echo "!! _data_health_compute não existe/não roda no snapshot"; exit 1; }


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260824091755_data_health_carteira_identidade_quarentena.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS. carteira_membership_ledger: FK user_id -> auth.users (ON DELETE
#          CASCADE) e CHECK source IN (backfill,trigger,rpc,sync).
# ══════════════════════════════════════════════════════════════════════════════
U1='aaaaaaaa-0000-0000-0000-000000000001'
U2='aaaaaaaa-0000-0000-0000-000000000002'
U3='aaaaaaaa-0000-0000-0000-000000000003'
U4='aaaaaaaa-0000-0000-0000-000000000004'
USERS=("$U1" "$U2" "$U3" "$U4")
P -q -c "INSERT INTO auth.users(id) VALUES ('$U1'),('$U2'),('$U3'),('$U4') ON CONFLICT DO NOTHING;"

# $1..$n = estados, na ordem U1,U2,U3,U4
semear_ledger() {
  P -q -c "TRUNCATE public.carteira_membership_ledger CASCADE;"
  local i=0
  for st in "$@"; do
    P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source, first_seen_at)
             VALUES ('${USERS[$i]}', '$st', 'sync', now());"
    i=$((i+1))
  done
}
st_ident()   { Pq -c "SELECT status   FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';"; }
sev_ident()  { Pq -c "SELECT severity FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';"; }
msg_ident()  { Pq -c "SELECT message  FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';"; }

echo "-- asserts --"

# ── A1: espelha a PROD de 2026-08-24 (7301/7301 verified) => NASCE VERDE
semear_ledger verified verified verified verified
eq "A1 todos verified => ok"   "$(st_ident)"  "ok"
eq "A1b severity verde        " "$(sev_ident)" "info"

# ── A2: 1 conflict (o evento do P1-c/#1943) => degrada
semear_ledger verified conflict verified verified
eq "A2 1 conflict => stale"     "$(st_ident)"  "stale"
eq "A2b severity degradada    " "$(sev_ident)" "warning"

# ── A3: 1 ambiguous (Fatia 2) => degrada igual
semear_ledger verified ambiguous verified verified
eq "A3 1 ambiguous => stale"    "$(st_ident)"  "stale"

# ── A4: ★ O ASSERT QUE CARREGA O DESENHO ★
#    'inactive' está no CHECK mas NÃO TEM WRITER hoje. O consumidor (carteira-rebuild:177)
#    já o quarantina por NEGAÇÃO. A sonda tem de enxergá-lo SEM ninguém editar a sonda no
#    dia em que um writer nascer. Uma lista IN ('conflict','ambiguous') reprova aqui — é
#    exatamente o que a falsificação F1 demonstra.
semear_ledger verified inactive verified verified
eq "A4 inactive (sem writer hoje) => stale" "$(st_ident)" "stale"

# ── A5: ledger VAZIO => ok, não 'broken' por omissão. Esta sonda mede QUARENTENA, não
#    frescor — frescor do rebuild é do carteira_rebuild. Assert explícito pra ninguém
#    "consertar" isso pra broken depois.
P -q -c "TRUNCATE public.carteira_membership_ledger CASCADE;"
eq "A5 ledger vazio => ok (quarentena, nao frescor)" "$(st_ident)" "ok"

# ── A6: a mensagem QUEBRA POR ESTADO — é o que gera a baseline pra uma faixa futura
semear_ledger conflict conflict ambiguous verified
eq "A6a quebra por estado" "$(Pq -c "SELECT message LIKE '%ambiguous=1, conflict=2%' FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")" "t"
eq "A6b conta os 3 nao-verified" "$(Pq -c "SELECT message LIKE '%: 3 membro(s) nao-verified%' FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")" "t"

# ── A7: ESTABILIDADE DE FINGERPRINT (20260814222000 confirma md5(source|status|severity|
#    message) em 2 avaliações antes de mandar e-mail => mensagem volátil NUNCA emite).
#    A mensagem VERMELHA não pode carregar o total do ledger, que cresce a cada membro novo.
semear_ledger verified conflict verified verified
FP1=$(Pq -c "SELECT md5(source||status||severity||message) FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")
P -q -c "INSERT INTO auth.users(id) VALUES ('aaaaaaaa-0000-0000-0000-00000000000f') ON CONFLICT DO NOTHING;"
P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source, first_seen_at)
         VALUES ('aaaaaaaa-0000-0000-0000-00000000000f', 'verified', 'sync', now());"
FP2=$(Pq -c "SELECT md5(source||status||severity||message) FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")
eq "A7 membro verified novo NAO muda o fingerprint vermelho" "$FP1" "$FP2"

# ── A8: metadados que o consumidor lê. age/expected NULL é o contrato de check por
#    CONTAGEM (a 20260815153218 desfez o validador que reprovava justamente isso).
META=$(Pq -c "SELECT domain||'|'||coalesce(age_seconds::text,'NULL')||'|'||coalesce(expected_max_age_seconds::text,'NULL')
              FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")
eq "A8 metadados (contagem, sem idade)" "$META" "carteira|NULL|NULL"

# ── A9: how_to_fix aponta a fase 2 (a ação que a sonda existe pra acionar)
eq "A9 remedio aponta a fase 2" "$(Pq -c "SELECT how_to_fix LIKE '%fase 2%' FROM public._data_health_compute() WHERE source='carteira_identidade_quarentena';")" "t"

# ── A10: não-regressão — ACRESCENTA um check, não substitui nenhum
eq "A10 nao-regressao: +1 check" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "$((BASE_CHECKS+1))"
eq "A10b vizinhos preservados" "$(Pq -c "SELECT count(*) FROM (
  SELECT 'carteira_scores' s UNION ALL SELECT 'carteira_rebuild' UNION ALL SELECT 'vendas_pedidos'
  UNION ALL SELECT 'custos_produtos' UNION ALL SELECT 'pedidos_compra_sync' UNION ALL SELECT 'alert_channel'
) t WHERE NOT EXISTS (SELECT 1 FROM public._data_health_compute() d WHERE d.source = t.s);")" "0"

# ── A11: PROMOÇÃO AO PUSH. sync.md: v_sources é a FONTE ÚNICA (filtra o compute E define o
#    esperado do dead-man). Sem isto o check existiria só no dashboard — trocar log-de-edge
#    por dashboard-que-ninguem-abre seria o mesmo bug com outra roupa.
eq "A11 no v_sources do watchdog (push)" "$(Pq -c "SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%carteira_identidade_quarentena%';")" "t"
eq "A11b no IN-list do heartbeat (resumo diario)" "$(Pq -c "SELECT pg_get_functiondef('public.fin_sync_heartbeat()'::regprocedure) LIKE '%carteira_identidade_quarentena%';")" "t"

# ── A12: LATE-BOUND. O watchdog é plpgsql: mexer no v_sources só falha ao EXECUTAR.
#    Rodar de verdade é o motivo nº 1 desta skill existir.
semear_ledger verified conflict verified verified
WDERR=$(P -q -c "SELECT public.data_health_watchdog();" 2>&1 >/dev/null) && WD=ok || WD=erro
[ "$WD" = "ok" ] || echo "  ...erro do watchdog: $(echo "$WDERR" | head -3)"
eq "A12 watchdog EXECUTA com o v_sources novo (late-bound)" "$WD" "ok"
eq "A12b o vigia gravou alerta do source novo" "$(Pq -c "SELECT count(*)>0 FROM public.fin_alertas WHERE tipo LIKE '%carteira_identidade_quarentena%';")" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota => exige VERMELHO => restaura.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"

# ── F1: ★ A FALSIFICAÇÃO CENTRAL ★ troca a NEGAÇÃO por uma LISTA de estados.
#    É a versão "óbvia" da sonda — e é cega para todo estado que ainda não existe.
#    O A4 (inactive) tem de ficar VERMELHO. Se não ficar, o A4 não tem dente e o
#    predicado por negação não estava sendo provado.
SAB1="$(mktemp /tmp/sab-ident1.XXXXXX.sql)"
sed -E "s/l\.identity_state IS DISTINCT FROM 'verified'/l.identity_state IN ('conflict','ambiguous')/g;
        s/l2\.identity_state IS DISTINCT FROM 'verified'/l2.identity_state IN ('conflict','ambiguous')/g" "$MIG" > "$SAB1"
grep -q "l.identity_state IN ('conflict','ambiguous')" "$SAB1" || { echo "!! F1 nao sabotou nada (padrao nao casou)"; exit 1; }
P -q -f "$SAB1"
semear_ledger verified inactive verified verified
ne "F1 lista fixa cega para 'inactive' => derruba A4" "$(st_ident)" "stale"
semear_ledger verified conflict verified verified
eq "F1b (a lista ainda pega conflict — a cegueira e SO no estado novo)" "$(st_ident)" "stale"
P -q -f "$MIG"   # restaura
semear_ledger verified inactive verified verified
eq "F1r restaurado: A4 volta a stale" "$(st_ident)" "stale"
rm -f "$SAB1"

# ── F2: troca `IS DISTINCT FROM` por `<>` — o furo NULL-blind do CLAUDE.md. A coluna é
#    NOT NULL hoje, então a sabotagem só é observável se a gente derrubar o NOT NULL:
#    é exatamente o ALTER futuro contra o qual o `IS DISTINCT FROM` é seguro barato.
P -q -c "ALTER TABLE public.carteira_membership_ledger ALTER COLUMN identity_state DROP NOT NULL;"
P -q -c "TRUNCATE public.carteira_membership_ledger CASCADE;"
P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source, first_seen_at) VALUES ('$U1', NULL, 'sync', now());"
eq "F2a real: identidade NULL cai na quarentena" "$(st_ident)" "stale"
SAB2="$(mktemp /tmp/sab-ident2.XXXXXX.sql)"
sed -E "s/l\.identity_state IS DISTINCT FROM 'verified'/l.identity_state <> 'verified'/g;
        s/l2\.identity_state IS DISTINCT FROM 'verified'/l2.identity_state <> 'verified'/g" "$MIG" > "$SAB2"
grep -q "l.identity_state <> 'verified'" "$SAB2" || { echo "!! F2 nao sabotou nada"; exit 1; }
P -q -f "$SAB2"
ne "F2b '<>' e NULL-blind => a linha NULL some da quarentena" "$(st_ident)" "stale"
P -q -f "$MIG"   # restaura
eq "F2r restaurado: NULL volta a contar" "$(st_ident)" "stale"
rm -f "$SAB2"
P -q -c "TRUNCATE public.carteira_membership_ledger CASCADE;"
P -q -c "ALTER TABLE public.carteira_membership_ledger ALTER COLUMN identity_state SET NOT NULL;"

# ── F3: remove o ramo inteiro (reintroduz o ponto cego que o #1943 deixou aberto).
SAB3="$(mktemp /tmp/sab-ident3.XXXXXX.sql)"
python3 - "$MIG" "$SAB3" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
txt = open(src, encoding="utf-8").read()
ini_marca = "    UNION ALL\n    -- [VIGIA identidade da carteira 2026-08-24"
fim_marca = "    ) q\n"
assert txt.count(ini_marca) == 1, f"ancora inicial: {txt.count(ini_marca)}"
assert txt.count(fim_marca) == 1, f"ancora final: {txt.count(fim_marca)}"
ini = txt.index(ini_marca)
fim = txt.index(fim_marca) + len(fim_marca)
open(dst, "w", encoding="utf-8").write(txt[:ini] + txt[fim:])
PY
grep -q "carteira_identidade_quarentena'::text" "$SAB3" && { echo "!! F3 nao removeu o ramo"; exit 1; }
P -q -f "$SAB3"
semear_ledger verified conflict verified verified
ne "F3 sem o ramo, o conflito volta a passar MUDO" "$(st_ident)" "stale"
ne "F3b contagem de checks cai" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "$((BASE_CHECKS+1))"
P -q -f "$MIG"   # restaura
eq "F3r restaurado: contagem volta" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "$((BASE_CHECKS+1))"
rm -f "$SAB3"

# ── F4: mantém o ramo mas TIRA o source do v_sources do watchdog — o check volta a ser
#    dashboard-only e nunca vira e-mail. É a sabotagem que prova que o A11 tem dente
#    (sem ela, "promovi ao push" seria afirmação sem teste).
SAB4="$(mktemp /tmp/sab-ident4.XXXXXX.sql)"
sed "s/^    'carteira_identidade_quarentena'\];/    'pedidos_compra_sync'];/" "$MIG" > "$SAB4"
P -q -f "$SAB4"
ne "F4 fora do v_sources => A11 vermelho (viraria dashboard-only)" \
   "$(Pq -c "SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%carteira_identidade_quarentena%';")" "t"
P -q -f "$MIG"   # restaura
eq "F4r restaurado: volta ao push" \
   "$(Pq -c "SELECT pg_get_functiondef('public.data_health_watchdog()'::regprocedure) LIKE '%carteira_identidade_quarentena%';")" "t"
rm -f "$SAB4"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
