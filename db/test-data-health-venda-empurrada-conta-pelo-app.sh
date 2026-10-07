#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — vendas_empurradas_sem_gemeo: o texto diz que a venda empurrada CONTA pela linha do app
# ║      bash db/test-data-health-venda-empurrada-conta-pelo-app.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-data-health-venda-empurrada-conta-pelo-app.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-data-health-venda-empurrada-conta-pelo-app.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a cadeia REAL do data health (a de db/test-data-health-vendas-empurradas.sh, com a v2 aplicada
# ║  = a prod de hoje) e a migration REAL desta entrega (*_data_health_venda_empurrada_conta_pelo_app.sql):
# ║   · o corpo é o da v2 com EXATAMENTE as 2 trocas de texto (desfeitas, dão o md5 de prod da v2);
# ║   · numa órfã, o probable_cause diz que a venda conta pela linha do app, e o resto da linha do sensor
# ║     é idêntico ao da v2 (a detecção não muda);
# ║   · em clones: a PRE recusa corpo desconhecido, a POS tem dente, o REVOKE fecha um ACL aberto;
# ║   · reaplicar = no-op.
# ║  Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md (5.4, 6)
# ╚═══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5621}"
SLUG="venda-empurrada-conta-pelo-app"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ════════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o laço de db/test-gemeos-push-pull-contagem-unica.sh, verbatim no método: controle
# VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se
# (1) aplicou, (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado
# estava verde no controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# docs/historico/falsificacao-exit-nao-e-dente.md
# ════════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="troca_extra:A3 pre_sem_identidade:A6 pos_sem_dente:A7 sem_revoke:A8"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pd() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
-- O mesmo de db/test-data-health-vendas-empurradas.sh: auth.uid() lê test.uid e, sem ele, o `sub` de
-- request.jwt.claims (a POS da v2, aplicada no setup, simula uma sessão logada sem papel); papéis e
-- carteira como o wrapper get_data_health() da prod os chama.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('test.uid', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT public.has_role(_user_id, 'master') $f$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
sqlstate() { local s; s="$(grep -o -E '^[A-Z]+:  [0-9A-Z]{5}' | grep -o -E '[0-9A-Z]{5}$' | head -1 || true)"; printf '%s' "${s:-SEM_SQLSTATE}"; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, "w").write(s.replace(de, para))
PYSAB
}
md5_corpo() {  # $1 = arquivo → md5 do prosrc do _data_health_compute definido nele (o mesmo md5(prosrc) do PG)
  python3 - "$1" <<'PY'
import hashlib, sys
s = open(sys.argv[1], encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION public._data_health_compute(')
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
print(hashlib.md5(s[a:b].encode('utf-8')).hexdigest())
PY
}

# A cadeia REAL que a prod executou até a v2 (a mesma de db/test-data-health-vendas-empurradas.sh).
MIG_TRIO="$REPO_ROOT/supabase/migrations/20261001011500_data_health_vendas_empurradas_sem_gemeo.sql"
MIGS=(
  "$REPO_ROOT/supabase/migrations/20260918200000_data_health_sync_reprocess_saude.sql"
  "$REPO_ROOT/supabase/migrations/20260920210000_sync_reprocess_retry_nao_liquida_erro.sql"
  "$REPO_ROOT/supabase/migrations/20260920233000_sync_reprocess_degradado_so_das_vigiadas.sql"
  "$REPO_ROOT/supabase/migrations/20260922225500_data_health_portal_humano_critico_apos_24h.sql"
  "$MIG_TRIO"
)
MIG_V2="$REPO_ROOT/supabase/migrations/20261005150000_data_health_vendas_empurradas_v2.sql"
WRAPPER_PROD="$REPO_ROOT/db/fixtures/get-data-health-predecessora-prod-20261005.sql"
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_data_health_venda_empurrada_conta_pelo_app.sql" | sort | tail -1)"
for m in "${MIGS[@]}" "$MIG_V2" "$WRAPPER_PROD" "$MIG"; do
  [ -n "$m" ] && [ -f "$m" ] || { echo "❌ arquivo ausente: [$m] — a prova testaria o NADA"; exit 1; }
done

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
P -q -f "$REPO_ROOT/db/stubs-data-health-trio.sql"
# ACL do compute como em PROD (só postgres/service_role), ANTES da cadeia: CREATE OR REPLACE preserva.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint,
               freshness_basis text, message text, last_error text, probable_cause text,
               how_to_fix text, severity text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $stub$ SELECT NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::text,
                 NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $stub$;
REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
SQL
for m in "${MIGS[@]}"; do P -q -1 -f "$m" >/dev/null; done
P -q -1 -f "$WRAPPER_PROD" >/dev/null
P -q -1 -f "$MIG_V2" >/dev/null
# UMA órfã: linha do app empurrada há 10 dias, sem gêmeo (a forma do _semear_venda da prova da v2).
# Semeada ANTES do molde: prove (B) e molde (v2) leem os MESMOS dados — o A5 compara as duas linhas.
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account, omie_pedido_id, omie_numero_pedido, omie_payload, hash_payload,
                                 status, total, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'oben', 900000000001, '000000000000001',
        jsonb_build_object('cabecalho', jsonb_build_object('data_previsao',
          to_char((now() - interval '10 days') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'))),
        NULL, 'enviado', 100, now() - interval '10 days', now() - interval '10 days');
SQL
# MOLDE = a prod de hoje (v2 viva) + a órfã, SEM esta migration: os clones do A6–A8 partem daqui.
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T prove molde

MD5_V2="5ae67f7eec50058c67589a58081b7c7e"   # o compute de PROD hoje (= o "depois" da v2)
MD5_B="3fcf8a90df5f87182c035f4c3bc32083"                           # o desta versão (Task 2, Step 4)
# As 2 trocas, texto EXATO (velho = o da v2; novo = o desta migration).
cat > "$TMP/velho1.txt" <<'TXT'
    -- omie_pedido_id) so entra na positivacao quando o importador traz o GEMEO: outra linha, mesma
    -- (account, omie_pedido_id), omie_payload nulo, com order_date_kpi. Ao vivo e congelado contam SO o
    -- kpi, que a linha do app criada desde 25/05 nao tem. O importador pode PULAR um pedido e isso so
TXT
cat > "$TMP/novo1.txt" <<'TXT'
    -- omie_pedido_id) ganha order_date_kpi NO ENVIO (20261005220000: o trigger da linha do app deriva
    -- o dia de SP do write-back) e conta pela linha do app ate o importador trazer o GEMEO: outra
    -- linha, mesma (account, omie_pedido_id), omie_payload nulo, com order_date_kpi, que entao vira a
    -- venda. O importador pode PULAR um pedido e isso so
TXT
cat > "$TMP/velho2.txt" <<'TXT'
                || 'Omie. Enquanto o gemeo nao chega a venda fica fora da positivacao ao vivo E do mes '
                || 'congelado: os dois contam so order_date_kpi, que a linha do app criada desde 25/05 nao tem.' END,
TXT
cat > "$TMP/novo2.txt" <<'TXT'
                || 'Omie. Enquanto o gemeo nao chega a venda conta pela linha do app (valor e cliente do app, '
                || 'sem a confirmacao do Omie), na positivacao ao vivo e no congelado se o mes fechar assim; '
                || 'cancelada no Omie, ela segue contando ate a linha do app ser marcada cancelado.' END,
TXT

# ════════════════════════════════════════════════════════════════════════════════════════════════
# SABOTAGEM — sobre CÓPIAS da migration; o repo nunca é tocado. troca_extra troca o arquivo usado pela
# suíte inteira; as outras três, as cópias dos clones (A6–A8).
# ════════════════════════════════════════════════════════════════════════════════════════════════
MIG_USADA="$MIG"
case "${SABOTAGEM:-}" in
  "") ;;
  troca_extra)
    cp "$MIG" "$TMP/mig-b.sql"
    trocar "$TMP/mig-b.sql" "interval '6 days'" "interval '7 days'" \
      || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o limiar do broken não ocorre exatamente 1×"; exit 9; }
    # o erro que SÓ o A3 pega: uma troca a mais com o md5 recalculado (PRE e POS aceitam o corpo errado)
    novo_md5="$(md5_corpo "$TMP/mig-b.sql")"
    python3 - "$TMP/mig-b.sql" "$MD5_B" "$novo_md5" <<'PY'
import sys
p, de, para = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PY
    MIG_USADA="$TMP/mig-b.sql"
    echo "⚠️  SABOTAGEM ATIVA em corpo de B (limiar do broken 6 → 7 dias, md5 recalculado) — a suíte abaixo DEVE ficar vermelha" ;;
  pre_sem_identidade|pos_sem_dente|sem_revoke) ;;   # nos clones (A6–A8)
  *) echo "❌ sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac

md5_vivo() { Pd "$1" -tA -c "SELECT md5(prosrc) || '|' || array_to_string(proconfig, '|') FROM pg_proc WHERE oid = 'public._data_health_compute()'::regprocedure;"; }
ler_sensor() { Pd "$1" -tA -c "SELECT $2 FROM public._data_health_compute() WHERE source = 'vendas_empurradas_sem_gemeo';"; }

echo "═══ migration desta entrega: $(basename "$MIG") ═══"
eq "A1 a migration aplica sobre a v2 e a postcondição passa" "$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)" "OK"
eq "A2 o corpo vivo é o desta versão (md5 do PG = md5 do arquivo) e o search_path é o de prod" \
   "$(md5_vivo prove)|$(md5_corpo "$MIG")" "$MD5_B|search_path=public, pg_temp|$MD5_B"
r3="$(python3 - "$MIG_USADA" "$MD5_V2" "$TMP" <<'PY'
import hashlib, sys
p, md5_v2, tmp = sys.argv[1:4]
s = open(p, encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION public._data_health_compute(')
a = s.index('AS $function$', i) + len('AS $function$')
b = s.index('$function$;', a)
corpo = s[a:b]
for n in ('1', '2'):
    velho = open(f'{tmp}/velho{n}.txt', encoding='utf-8').read()
    novo = open(f'{tmp}/novo{n}.txt', encoding='utf-8').read()
    if corpo.count(novo) != 1 or corpo.count(velho) != 0:
        print(f'troca{n}:novo={corpo.count(novo)},velho={corpo.count(velho)}')
        sys.exit(0)
    corpo = corpo.replace(novo, velho)
d = hashlib.md5(corpo.encode('utf-8')).hexdigest()
print('igual' if d == md5_v2 else 'difere:' + d)
PY
)" || r3="ERRO_PY"
eq "A3 desfazer as 2 trocas devolve o corpo de PROD da v2 (5ae67f7e…): nada além delas mudou" \
   "$(md5_corpo "$MIG_V2")|$r3" "$MD5_V2|igual"
eq "A4 numa órfã, o probable_cause diz que a venda CONTA pela linha do app (o texto velho saiu)" \
   "$(ler_sensor prove "(status <> 'ok')::text || '|' || (probable_cause LIKE '%conta pela linha do app%')::text || '|' || (probable_cause LIKE '%fica fora da positivacao%')::text")" \
   "true|true|false"
LINHA="md5(concat_ws('|', source, domain, status, expected_max_age_seconds, freshness_basis, message, last_error, how_to_fix, severity))"
eq "A5 o resto da linha do sensor (status, message, last_error, how_to_fix…) é idêntico ao da v2 para a mesma órfã" \
   "$([ "$(ler_sensor prove "$LINHA")" = "$(ler_sensor molde "$LINHA")" ] && echo igual || echo difere)" "igual"

echo "═══ em clones da prod de hoje (molde): PRE, POS, ACL ═══"
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pre
awk 'index($0,"CREATE OR REPLACE FUNCTION public._data_health_compute(")==1{f=1} f{print} f && /^\$function\$;$/{exit}' "$MIG_V2" > "$TMP/estranho.sql"
trocar "$TMP/estranho.sql" "  WITH checks AS (" "  WITH checks AS ( -- corpo estranho" \
  || { echo "❌ o início do corpo da v2 mudou de forma — o A6 não monta o caso"; exit 1; }
Pd pre -q -f "$TMP/estranho.sql" >/dev/null
estranho="$(md5_vivo pre)"
cp "$MIG_USADA" "$TMP/mig-pre.sql"
if [ "${SABOTAGEM:-}" = "pre_sem_identidade" ]; then
  trocar "$TMP/mig-pre.sql" "  IF v_md5 <> '5ae67f7eec50058c67589a58081b7c7e'" "  IF false AND v_md5 <> '5ae67f7eec50058c67589a58081b7c7e'" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na PRE"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em PRE (sem a identidade do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out6="$(Pd pre -q -1 -f "$TMP/mig-pre.sql" 2>&1 || true)"
case "$out6" in
  *"PRE FALHOU"*) r6="recusou" ;;
  *"POS OK"*) r6="aplicou" ;;
  *) r6="erro:$(printf '%s\n' "$out6" | sqlstate)" ;;
esac
eq "A6 a PRE recusa um corpo vivo desconhecido e não o sobrescreve" "$r6|$(md5_vivo pre)" "recusou|$estranho"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde pos
cp "$MIG_USADA" "$TMP/mig-pos.sql"
trocar "$TMP/mig-pos.sql" "  WITH checks AS (" "  WITH checks AS ( -- corpo que nao e o desta versao" \
  || { echo "❌ o início do corpo mudou de forma — o A7 não monta o caso"; exit 1; }
if [ "${SABOTAGEM:-}" = "pos_sem_dente" ]; then
  trocar "$TMP/mig-pos.sql" "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o padrão não ocorre exatamente 1× na POS"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em POS (sem o md5 do corpo) — a suíte abaixo DEVE ficar vermelha"
fi
out7="$(Pd pos -q -1 -f "$TMP/mig-pos.sql" 2>&1 || true)"
case "$out7" in
  *"POSTCONDICAO FALHOU md5"*) r7="recusou:md5" ;;
  *"POSTCONDICAO FALHOU"*) r7="recusou:outro_motivo" ;;
  *"POS OK"*) r7="aplicou" ;;
  *) r7="erro:$(printf '%s\n' "$out7" | sqlstate)" ;;
esac
eq "A7 a POS recusa um corpo que não é o desta versão (md5)" "$r7" "recusou:md5"

"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres -T molde acl
Pd acl -q -c "GRANT EXECUTE ON FUNCTION public._data_health_compute() TO PUBLIC, anon, authenticated;"
cp "$MIG_USADA" "$TMP/mig-acl.sql"
if [ "${SABOTAGEM:-}" = "sem_revoke" ]; then
  trocar "$TMP/mig-acl.sql" "REVOKE EXECUTE ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;" "" \
    || { echo "❌ SABOTAGEM NÃO APLICÁVEL — o REVOKE não ocorre exatamente 1×"; exit 9; }
  echo "⚠️  SABOTAGEM ATIVA em REVOKE do compute — a suíte abaixo DEVE ficar vermelha"
fi
r8="$(Pd acl -q -1 -f "$TMP/mig-acl.sql" >/dev/null 2>&1 && echo OK || echo FALHOU)"
vaz8="$(Pd acl -tA -c "SELECT count(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
                         WHERE has_function_privilege(r.papel, 'public._data_health_compute()', 'EXECUTE');")"
eq "A8 com o EXECUTE aberto (deriva de ACL), aplicar a migration o fecha para PUBLIC/anon/authenticated" "$r8|$vaz8" "OK|0"

antes9="$(md5_vivo prove)"
r9="$(P -q -1 -f "$MIG_USADA" >/dev/null 2>&1 && echo OK || echo FALHOU)"
eq "A9 reaplicar é no-op (a PRE aceita esta versão; o corpo não muda)" \
   "$r9|$([ "$(md5_vivo prove)" = "$antes9" ] && echo igual || echo mudou)" "OK|igual"

echo
echo "PASS=${PASS}  FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
