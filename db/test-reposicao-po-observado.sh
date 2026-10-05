#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — observação do conjunto aberto que o motor contou (PR0 da baixa   ║
# ║  de PO · 20261005131331_reposicao_po_observado_pelo_motor.sql)                 ║
# ║                                                                                ║
# ║  I  a migration aplica com a postcondição OK (I0) e re-aplicar é seguro (I1)    ║
# ║  A  a RPC grava run + itens (A1); o banco recusa excluído que contribui (A2) e  ║
# ║     contado sem SKU (A3); p_itens NULL / objeto e run_id ausente → 22023        ║
# ║     (A6 A6o A7); a retenção de 14 d apaga o velho (A4) e preserva o recente e   ║
# ║     a outra empresa (A5)                                                       ║
# ║  R  RLS: authenticated sem papel e customer veem 0 (R1 R3); employee e master   ║
# ║     veem tudo (R2 R2m); anon é negado no GRANT (R4)                             ║
# ║  W  ninguém além da RPC escreve: staff leva 42501 no INSERT direto (W1)         ║
# ║  X  EXECUTE da RPC: anon e staff levam 42501 (X1 X2); service_role publica (X3) ║
# ║  P  a POSTCONDIÇÃO tem dente: cópias da migration com UM defeito cada abortam   ║
# ║     no predicado certo (P1-P8). O predicado de PUBLIC é implicado pelo de anon  ║
# ║     (todo papel herda PUBLIC): P7 é pego pelos dois, e não há sabotagem dele.  ║
# ║                                                                                ║
# ║  Duas camadas, falsificadas uma por vez: o COMPORTAMENTO é sabotado no BANCO,   ║
# ║  depois da migration real (a postcondição não vê); a POSTCONDIÇÃO é sabotada   ║
# ║  no ARQUIVO (a migration real segue aplicando; as cópias P deixam de abortar).  ║
# ║                                                                                ║
# ║  rode: bash db/test-reposicao-po-observado.sh > log 2>&1; echo "exit=$?"        ║
# ║        bash db/test-reposicao-po-observado.sh --falsificar > log 2>&1          ║
# ║  matriz: HARNESS_LC=C | pt_BR.UTF-8                                            ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5840}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="reposicao-po-observado"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261005131331_reposicao_po_observado_pelo_motor.sql"
# Denominador: I0 I1 · A1 A2 A3 A6 A6o A7 · R1 R2 R2m R3 R4 · W1 · X1 X2 X3 · A4 A5 · P1-P8.
# Asserts a menos — um bloco que não rodou — é vermelho.
TOTAL_ESPERADO=27

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE (o contrato de
# db/test-hoje-sp-sete-funcoes.sh). O controle roda PRIMEIRO, na mesma invocação; cada sabotagem
# declara os asserts que TÊM de ficar vermelhos por RESULTADO e os que TÊM de continuar verdes; o
# filho tem de chegar ao fim com todos os asserts; todo ERRO_DE_EXECUCAO tem de estar declarado
# (`ID!MARCA`); a marca da sabotagem tem de aparecer.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="check_excluido_fora:A2:A1,A3
              check_contado_fora:A3:A1,A2
              itens_nao_gravados:A1:A4,A5,X3
              sem_guarda_array:A6:A6o,A7
              sem_guarda_run_id:A7:A6,A6o
              retencao_fora:A4:A5
              retencao_apaga_tudo:A5:A4
              rls_desligada:R1,R3:R2,R2m,R4
              policy_aberta:R1,R3:R2,R2m,R4
              policy_sem_employee:R2:R2m,R1,R3
              sem_select_staff:R1,R2,R2m,R3:R4
              anon_le_item:R4:R1,R2,R3
              escrita_aberta_staff:W1:X1,X2
              rpc_aberta_anon:X1:X2,X3
              rpc_aberta_staff:X2:X1,X3
              rpc_sem_service_role:X3:X1,X2
              post_cega_fn_authenticated:P1:I0,I1,P2,P7
              post_cega_fn_anon:P2:I0,I1,P1,P7
              post_cega_tab_authenticated:P3:I0,I1,P8
              post_cega_md5:P4:I0,I1,P1
              post_cega_rls:P5:I0,I1,P6
              post_cega_check:P6:I0,I1,P5
              post_cega_tab_anon:P8:I0,I1,P3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  # o filho rodou até o fim, com TODOS os asserts? (senão o vermelho pode ser de um aborto)
  completo() {
    local l ok_n fail_n
    l="$(grep -E '^RESULTADO: [0-9]+ ok / [0-9]+ fail$' "$1" | tail -1 || true)"
    [ -n "$l" ] || return 1
    ok_n="$(printf '%s' "$l" | awk '{print $2}')"; fail_n="$(printf '%s' "$l" | awk '{print $5}')"
    [ $((ok_n + fail_n)) -eq "$TOTAL_ESPERADO" ]
  }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 && completo "$LOGDIR/controle.log"; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO ou incompleto — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL|INFRA' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    if ! completo "$log"; then
      echo "  ❌ $sab — o filho NÃO chegou ao fim com os $TOTAL_ESPERADO asserts: o vermelho pode ser de um aborto"
      tail -5 "$log" | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""; nao_declarado=""
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"
             grep -Eq "(^|[^A-Za-z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    while IFS= read -r id_err; do
      [ -n "$id_err" ] || continue
      case ",${verm}," in *",${id_err}!"*) ;; *) nao_declarado="$nao_declarado $id_err" ;; esac
    done < <(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' || true)
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$nao_declarado" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$nao_declarado" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO não declarado em:${nao_declarado} (vermelho que não é do assert não mata mutante)"
                                   grep 'ERRO_DE_EXECUCAO' "$log" | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

# ── helpers de arquivo (python, contagem EXATA de cada padrão: troca que não pegou é erro) ──
extrair() {   # <arquivo> <marcador de início> <saída> — o bloco CREATE … $fn$; VERBATIM
  python3 - "$1" "$2" "$3" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read(); marca = sys.argv[2]
ini = s.find(marca); fim = s.find('$fn$;', ini) if ini >= 0 else -1
if ini < 0 or fim < 0 or s.count(marca) != 1:
    sys.exit('marcador ausente ou ambiguo em %s: %r' % (sys.argv[1], marca))
open(sys.argv[3], 'w', encoding='utf-8').write(s[ini:fim + len('$fn$;')] + '\n')
PY
}
trocar() {    # <entrada> <saída> <de> <para> <n> [<de> <para> <n> ...]
  local src="$1" dst="$2"; shift 2
  python3 - "$src" "$dst" "$@" <<'PY'
import sys
src, dst, trocas = sys.argv[1], sys.argv[2], sys.argv[3:]
s = open(src, encoding='utf-8').read()
for i in range(0, len(trocas), 3):
    de, para, n = trocas[i], trocas[i + 1], int(trocas[i + 2])
    if s.count(de) != n:
        sys.exit('padrao ocorre %dx, esperado %d: %r' % (s.count(de), n, de))
    s = s.replace(de, para)
open(dst, 'w', encoding='utf-8').write(s)
PY
}

# ══════════════════════════════════════════════════════════════════════════════
# SABOTAGEM DE ARQUIVO (só no modo --falsificar): enfraquece UM predicado da postcondição. A
# migration real continua aplicando (o ACL/RLS/corpo dela estão certos); as cópias P, derivadas
# deste arquivo, deixam de abortar — é o dente da postcondição que se mede.
# ══════════════════════════════════════════════════════════════════════════════
MIG_EFETIVA="$MIG"
sabotar_arquivo() {   # <de> <para> <n> [...]
  trocar "$MIG" "$TMPD/mig.sql" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  MIG_EFETIVA="$TMPD/mig.sql"
  echo "SABOTAGEM ativa: $SABOTAGEM"
}
case "$SABOTAGEM" in
  post_cega_fn_authenticated)  sabotar_arquivo "OR has_function_privilege('authenticated', v_fn, 'EXECUTE')" "OR false" 1 ;;
  post_cega_fn_anon)           sabotar_arquivo "OR has_function_privilege('anon', v_fn, 'EXECUTE')" "OR false" 1 ;;
  post_cega_tab_authenticated) sabotar_arquivo "IF v_priv <> 'SELECT' AND has_table_privilege('authenticated', v_tab, v_priv) THEN" "IF false THEN" 1 ;;
  post_cega_tab_anon)          sabotar_arquivo "IF has_table_privilege('anon', v_tab, v_priv) THEN" "IF false THEN" 1 ;;
  post_cega_md5)               sabotar_arquivo "FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM '" "FROM pg_proc p WHERE p.oid = v_fn) IS NULL AND 'x' <> '" 1 ;;
  post_cega_rls)               sabotar_arquivo "AND c.relrowsecurity" "" 1 ;;
  post_cega_check)             sabotar_arquivo ")) <> 3 THEN" ")) < 0 THEN" 1 ;;
esac

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro (psql) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 300)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}
# valor de um SQL no banco prove (stdout+stderr: um erro vira texto e o eq o classifica)
val() { Pdb prove -q -tA 2>&1 || true; }

STAFF='a0000000-0000-4000-8000-000000000001'    # employee
MASTER='a0000000-0000-4000-8000-000000000002'   # master
CLIENTE='c0000000-0000-4000-8000-000000000003'  # customer
SEMPAPEL='d0000000-0000-4000-8000-000000000004' # authenticated sem linha em user_roles
RUN_A1='11111111-1111-1111-1111-111111111111'
FN='public.reposicao_po_observado_publicar(jsonb, jsonb)'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — banco-MOLDE com o que a PROD já tem (lido por psql-ro em 2026-10-05): enum, user_roles,
# has_role (corpo do snapshot), USAGE em auth e o ACL DEFAULT do schema public. ⚠️ O ALTER DEFAULT
# PRIVILEGES não é enfeite: é o que dá TRABALHO REAL aos REVOKE por nome da migration — sem ele,
# anon/authenticated já nasceriam sem privilégio e os asserts de ACL passariam por vacuidade.
# ══════════════════════════════════════════════════════════════════════════════
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres molde
Pdb molde -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb molde -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL DEFAULT 'customer'
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- Sondas da prova (fora da migration): devolvem a SQLSTATE como VALOR para o assert comparar exato.
-- _prova_contar só converte 42501 (a negação que se mede); qualquer outro erro sobe e vira ERRO_DE_EXECUCAO.
CREATE OR REPLACE FUNCTION public._prova_contar(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN v::text;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN 'SQLSTATE:42501';
END $f$;
-- _prova_sqlstate/_prova_valor devolvem QUALQUER SQLSTATE como valor: o assert compara EXATO, então um
-- erro inesperado reprova por resultado (≠ do `WHEN OTHERS THEN 'OK'`, que aprovaria).
CREATE OR REPLACE FUNCTION public._prova_sqlstate(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;
CREATE OR REPLACE FUNCTION public._prova_valor(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, 'NULL');
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;

-- ACL default do schema public em prod (pg_default_acl do postgres): tabela → ALL, função → EXECUTE.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER ROLE service_role BYPASSRLS;"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
Pdb prove -q <<SQL
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$STAFF', 'employee'), ('$MASTER', 'master'), ('$CLIENTE', 'customer');
SQL

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# I — a migration (real, ou com a postcondição sabotada) aplica e re-aplica
# ══════════════════════════════════════════════════════════════════════════════
aplicar() {   # <db> <arquivo> → "OK" | "SEM_NOTICE" | "ERRO: <1ª linha de erro>"
  local out
  if out="$(Pdb "$1" -f "$2" 2>&1)"; then
    if printf '%s' "$out" | grep -q 'POSTCONDICAO OK'; then echo "OK"; else echo "SEM_NOTICE"; fi
  else
    echo "ERRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR|FATAL' | head -c 240)"
  fi
}
eq I0 "a migration aplica e a postcondição confirma" "$(aplicar prove "$MIG_EFETIVA")" "OK"
eq I1 "re-aplicar é seguro (idempotente)" "$(aplicar prove "$MIG_EFETIVA")" "OK"

# ══════════════════════════════════════════════════════════════════════════════
# SABOTAGEM DE COMPORTAMENTO (só no modo --falsificar) — no BANCO, depois da migration real: a
# postcondição já passou e não vê; quem tem de ver é o assert de comportamento.
# ══════════════════════════════════════════════════════════════════════════════
sabotar_sql() { Pdb prove -q -c "$1" >/dev/null || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }; echo "SABOTAGEM ativa: $SABOTAGEM"; }
sabotar_corpo() {   # <de> <para> <n> [...] — recria a RPC a partir do bloco VERBATIM do arquivo
  extrair "$MIG" "CREATE OR REPLACE FUNCTION public.reposicao_po_observado_publicar" "$TMPD/bloco.sql" \
    || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  trocar "$TMPD/bloco.sql" "$TMPD/sab.sql" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  Pdb prove -q -f "$TMPD/sab.sql" >/dev/null || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  echo "SABOTAGEM ativa: $SABOTAGEM"
}
POL_RUN='"reposicao_po_observado_run_select_staff" ON public.reposicao_po_observado_run'
POL_ITEM='"reposicao_po_observado_item_select_staff" ON public.reposicao_po_observado_item'
case "$SABOTAGEM" in
  ""|post_cega_*) ;;
  check_excluido_fora)  sabotar_sql "ALTER TABLE public.reposicao_po_observado_item DROP CONSTRAINT reposicao_po_observado_item_excluido_nao_contribui" ;;
  check_contado_fora)   sabotar_sql "ALTER TABLE public.reposicao_po_observado_item DROP CONSTRAINT reposicao_po_observado_item_contado_tem_sku" ;;
  itens_nao_gravados)   sabotar_corpo "FROM jsonb_array_elements(p_itens) AS i;" "FROM jsonb_array_elements(p_itens) AS i WHERE false;" 1 ;;
  sem_guarda_array)     sabotar_corpo "IF jsonb_typeof(p_itens) IS DISTINCT FROM 'array' THEN" "IF false THEN" 1 ;;
  sem_guarda_run_id)    sabotar_corpo "IF v_run_id IS NULL THEN" "IF false THEN" 1 ;;
  retencao_fora)        sabotar_corpo "concluido_em < now() - interval '14 days'" "false" 1 ;;
  retencao_apaga_tudo)  sabotar_corpo "concluido_em < now() - interval '14 days'" "true" 1 ;;
  rls_desligada)        sabotar_sql "ALTER TABLE public.reposicao_po_observado_run DISABLE ROW LEVEL SECURITY; ALTER TABLE public.reposicao_po_observado_item DISABLE ROW LEVEL SECURITY" ;;
  policy_aberta)        sabotar_sql "DROP POLICY $POL_RUN; CREATE POLICY $POL_RUN FOR SELECT USING (true); DROP POLICY $POL_ITEM; CREATE POLICY $POL_ITEM FOR SELECT USING (true)" ;;
  policy_sem_employee)  sabotar_sql "DROP POLICY $POL_RUN; CREATE POLICY $POL_RUN FOR SELECT USING (public.has_role((SELECT auth.uid()), 'master'::public.app_role)); DROP POLICY $POL_ITEM; CREATE POLICY $POL_ITEM FOR SELECT USING (public.has_role((SELECT auth.uid()), 'master'::public.app_role))" ;;
  sem_select_staff)     sabotar_sql "REVOKE SELECT ON public.reposicao_po_observado_run FROM authenticated; REVOKE SELECT ON public.reposicao_po_observado_item FROM authenticated" ;;
  anon_le_item)         sabotar_sql "GRANT SELECT ON public.reposicao_po_observado_item TO anon" ;;
  escrita_aberta_staff) sabotar_sql "GRANT INSERT ON public.reposicao_po_observado_item TO authenticated; CREATE POLICY sabotagem_insert ON public.reposicao_po_observado_item FOR INSERT WITH CHECK (true)" ;;
  rpc_aberta_anon)      sabotar_sql "GRANT EXECUTE ON FUNCTION $FN TO anon" ;;
  rpc_aberta_staff)     sabotar_sql "GRANT EXECUTE ON FUNCTION $FN TO authenticated" ;;
  rpc_sem_service_role) sabotar_sql "REVOKE EXECUTE ON FUNCTION $FN FROM service_role" ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# p_run completo e válido (só o run_id varia): sem a guarda, a publicação PASSARIA — é o que dá dente aos A6/A7.
run_json() {  # <expressão SQL do run_id | ''> → jsonb de um run OBEN completo
  local rid=""
  if [ -n "$1" ]; then rid="'run_id', $1, "; fi
  printf "jsonb_build_object(%s'empresa', 'OBEN', 'iniciado_em', now(), 'concluido_em', now(), 'janela_de', current_date - 365, 'janela_ate', current_date + 120, 'filtros', '{\"lExibirPedidosEncerrados\":\"F\"}'::jsonb, 'varredura_completa', true, 'pendente_aplicado', true, 'pedidos_lidos', 2, 'versao_edge', 'v1.4-teste')" "$rid"
}
ITENS_A1="jsonb_build_array(
  jsonb_build_object('omie_codigo_pedido', 12000000001, 'seq_item', 0, 'numero_pedido', '1205', 'etapa', '15',
    'id_item', 12000000002, 'sku_codigo_omie', 8689791246, 'quantidade', 6, 'quantidade_recebida', 0,
    'contribuicao', 6, 'exclusao', null),
  jsonb_build_object('omie_codigo_pedido', 12000000009, 'seq_item', 0, 'numero_pedido', '1300', 'etapa', '15',
    'id_item', 12000000010, 'sku_codigo_omie', 8689791246, 'quantidade', 4, 'quantidade_recebida', 0,
    'contribuicao', 0, 'exclusao', 'dedup_app'))"

# ══════════════════════════════════════════════════════════════════════════════
# A — a RPC (como o writer de verdade: service_role) e os CHECKs do banco
# ══════════════════════════════════════════════════════════════════════════════
# Instruções SEPARADAS de propósito: na mesma instrução, as contagens leriam o snapshot de ANTES da RPC.
v="$(val <<SQL
SET ROLE service_role;
SELECT public._prova_valor(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json "'$RUN_A1'::uuid"), $ITENS_A1)\$q\$);
SELECT count(*) FROM public.reposicao_po_observado_run WHERE run_id = '$RUN_A1';
SELECT count(*) FROM public.reposicao_po_observado_item WHERE run_id = '$RUN_A1';
SELECT coalesce(sum(contribuicao)::text, 'NULL') FROM public.reposicao_po_observado_item WHERE run_id = '$RUN_A1' AND exclusao IS NULL;
SQL
)"
eq A1 "a publicação grava run + itens e devolve a contagem (devolvido|runs|itens|contado)" "$(printf '%s' "$v" | tr '\n' '|')" "2|1|2|6"

v="$(val <<SQL
SELECT public._prova_sqlstate(\$q\$INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, contribuicao, exclusao, sku_codigo_omie, quantidade, quantidade_recebida)
  VALUES ('$RUN_A1', 12000000011, 0, 3, 'dedup_app', 8689791246, 3, 0)\$q\$);
SQL
)"
eq A2 "o banco recusa item EXCLUÍDO que contribui (23514)" "$v" "SQLSTATE:23514"

v="$(val <<SQL
SELECT public._prova_sqlstate(\$q\$INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, contribuicao, exclusao, sku_codigo_omie, quantidade, quantidade_recebida)
  VALUES ('$RUN_A1', 12000000012, 0, 3, NULL, NULL, 3, 0)\$q\$);
SQL
)"
eq A3 "o banco recusa item CONTADO sem SKU (23514)" "$v" "SQLSTATE:23514"

v="$(val <<SQL
SET ROLE service_role;
SELECT public._prova_sqlstate(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json "gen_random_uuid()"), NULL)\$q\$);
SQL
)"
eq A6 "p_itens NULL é recusado (22023) — sem a guarda, viraria run vazio publicado" "$v" "SQLSTATE:22023"

v="$(val <<SQL
SET ROLE service_role;
SELECT public._prova_sqlstate(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json "gen_random_uuid()"), '{}'::jsonb)\$q\$);
SQL
)"
eq A6o "p_itens objeto é recusado (22023)" "$v" "SQLSTATE:22023"

v="$(val <<SQL
SET ROLE service_role;
SELECT public._prova_sqlstate(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json ""), '[]'::jsonb)\$q\$);
SQL
)"
eq A7 "run_id ausente é recusado (22023)" "$v" "SQLSTATE:22023"

# ══════════════════════════════════════════════════════════════════════════════
# R — quem LÊ (RLS sob SET ROLE + GUC): só staff. Valor = "<runs>|<itens>" visíveis.
# ══════════════════════════════════════════════════════════════════════════════
ler_como() {  # <papel> <uid|''>
  val <<SQL
SET ROLE $1;
SET test.uid = '$2';
SELECT public._prova_contar('SELECT count(*) FROM public.reposicao_po_observado_run')
       || '|' || public._prova_contar('SELECT count(*) FROM public.reposicao_po_observado_item');
SQL
}
eq R1  "authenticated SEM papel não vê nada"   "$(ler_como authenticated "$SEMPAPEL")" "0|0"
eq R2  "employee vê o run e os itens"          "$(ler_como authenticated "$STAFF")"    "1|2"
eq R2m "master vê o run e os itens"            "$(ler_como authenticated "$MASTER")"   "1|2"
eq R3  "customer não vê nada"                  "$(ler_como authenticated "$CLIENTE")"  "0|0"
v="$(val <<SQL
SET ROLE anon;
SELECT public._prova_contar('SELECT count(*) FROM public.reposicao_po_observado_item');
SQL
)"
eq R4 "anon é negado no GRANT (42501), não filtrado pela RLS" "$v" "SQLSTATE:42501"

# ══════════════════════════════════════════════════════════════════════════════
# W/X — quem ESCREVE: só a RPC, e a RPC só por service_role
# ══════════════════════════════════════════════════════════════════════════════
v="$(val <<SQL
SET ROLE authenticated;
SET test.uid = '$STAFF';
SELECT public._prova_sqlstate(\$q\$INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, contribuicao, exclusao, sku_codigo_omie, quantidade, quantidade_recebida)
  VALUES ('$RUN_A1', 12000000013, 0, 1, NULL, 8689791246, 1, 0)\$q\$);
SQL
)"
eq W1 "staff não escreve direto na tabela (42501)" "$v" "SQLSTATE:42501"

publicar_como() {  # <papel> <uid|''>
  val <<SQL
SET ROLE $1;
SET test.uid = '$2';
SELECT public._prova_sqlstate(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json "gen_random_uuid()"), '[]'::jsonb)\$q\$);
SQL
}
eq X1 "anon não executa a RPC (42501)"          "$(publicar_como anon "")"                 "SQLSTATE:42501"
eq X2 "staff não executa a RPC (42501)"         "$(publicar_como authenticated "$STAFF")"  "SQLSTATE:42501"
eq X3 "service_role (a edge) publica"           "$(publicar_como service_role "")"         "OK"

# ══════════════════════════════════════════════════════════════════════════════
# A4/A5 — retenção de 14 dias no MESMO writer (por último: ela apaga runs)
# ══════════════════════════════════════════════════════════════════════════════
Pdb prove -q <<'SQL'
INSERT INTO public.reposicao_po_observado_run (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate,
  filtros, varredura_completa, pendente_aplicado, pedidos_lidos, versao_edge) VALUES
  ('22222222-2222-2222-2222-222222222222', 'OBEN',    now() - interval '20 days', now() - interval '20 days', current_date - 400, current_date - 20, '{}'::jsonb, true, true, 0, 'v1.4-teste'),
  ('44444444-4444-4444-4444-444444444444', 'OBEN',    now() - interval '13 days', now() - interval '13 days', current_date - 400, current_date - 13, '{}'::jsonb, true, true, 0, 'v1.4-teste'),
  ('55555555-5555-5555-5555-555555555555', 'COLACOR', now() - interval '20 days', now() - interval '20 days', current_date - 400, current_date - 20, '{}'::jsonb, true, true, 0, 'v1.4-teste');
SQL
v="$(val <<SQL
SET ROLE service_role;
SELECT public._prova_valor(\$q\$SELECT public.reposicao_po_observado_publicar($(run_json "'33333333-3333-3333-3333-333333333333'::uuid"), '[]'::jsonb)\$q\$);
RESET ROLE;
SELECT count(*) FROM public.reposicao_po_observado_run WHERE run_id = '22222222-2222-2222-2222-222222222222';
SQL
)"
eq A4 "a publicação apaga o run OBEN de 20 dias (devolvido + restantes)" "$(printf '%s' "$v" | tr '\n' '|')" "0|0"
v="$(val <<'SQL'
SELECT count(*) FROM public.reposicao_po_observado_run
 WHERE run_id IN ('44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555',
                  '33333333-3333-3333-3333-333333333333');
SQL
)"
eq A5 "e preserva o OBEN de 13 dias, o COLACOR velho e o recém-publicado" "$v" "3"

# ══════════════════════════════════════════════════════════════════════════════
# P — a POSTCONDIÇÃO tem dente: cada cópia com UM defeito, aplicada num banco limpo (do molde),
# tem de ABORTAR no predicado certo. Derivadas da migration EFETIVA (com a sabotagem de arquivo,
# quando houver): é assim que a falsificação mede o dente da postcondição.
# ══════════════════════════════════════════════════════════════════════════════
postcond_recusa() {   # <id> <descrição> <fragmento esperado na mensagem> <de> <para>
  local id="$1" desc="$2" frag="$3" copia="$TMPD/copia-$1.sql" db out v
  db="p_$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  if ! trocar "$MIG_EFETIVA" "$copia" "$4" "$5" 1; then erro_exec "$id" "$desc — INFRA: defeito não aplicável à cópia"; return; fi
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde "$db"
  if out="$(Pdb "$db" -f "$copia" 2>&1)"; then
    v="APLICOU"
  elif printf '%s' "$out" | grep -q "POSTCONDICAO FALHOU: .*${frag}"; then
    v="RECUSOU"
  else
    v="ERRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR|FATAL' | head -c 240)"
  fi
  eq "$id" "$desc" "$v" "RECUSOU"
}
postcond_recusa P1 "sem o REVOKE de authenticated na RPC → aborta" "EXECUTE da RPC fora" \
  "REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM authenticated;"$'\n' ""
postcond_recusa P2 "sem o REVOKE de anon na RPC → aborta" "EXECUTE da RPC fora" \
  "REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM anon;"$'\n' ""
postcond_recusa P3 "sem o REVOKE de authenticated na tabela de itens → aborta" "authenticated tem" \
  "REVOKE ALL ON public.reposicao_po_observado_item FROM authenticated;"$'\n' ""
postcond_recusa P4 "corpo da RPC com 1 byte a mais (transcrição) → aborta" "corpo da RPC difere" \
  "  RETURN v_n;"$'\n' "  RETURN v_n ;"$'\n'
postcond_recusa P5 "sem RLS na tabela de itens → aborta" "sem RLS" \
  "ALTER TABLE public.reposicao_po_observado_item ENABLE ROW LEVEL SECURITY;"$'\n' ""
postcond_recusa P6 "CHECK do contado com outro nome (tabela de outra forma) → aborta" "CHECKs do item" \
  "CONSTRAINT reposicao_po_observado_item_contado_tem_sku"$'\n' "CONSTRAINT reposicao_po_observado_item_contado_outro"$'\n'
postcond_recusa P7 "sem o REVOKE de PUBLIC na RPC → aborta" "EXECUTE da RPC fora" \
  "REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM PUBLIC;"$'\n' ""
postcond_recusa P8 "sem o REVOKE de anon na tabela de runs → aborta" "anon tem" \
  "REVOKE ALL ON public.reposicao_po_observado_run FROM anon;"$'\n' ""

echo "RESULTADO: $PASS ok / $FAIL fail"
[ $((PASS + FAIL)) -eq "$TOTAL_ESPERADO" ] || { echo "❌ executou $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"; exit 1; }
[ "$FAIL" -eq 0 ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ test-reposicao-po-observado: OK ($PASS asserts)"
