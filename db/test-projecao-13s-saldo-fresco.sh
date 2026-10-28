#!/usr/bin/env bash
# PROVA — fin_projecao_13_semanas: saldo de conta corrente ausente ou velho NÃO vira saldo inicial
# (20261028014827_projecao_13s_saldo_inicial_fresco_ou_nulo.sql). Money-path: a projeção alimenta a
# decisão de compra (CaixaCompraCard, piso das 13 semanas).
#
# Com p_saldo_inicial NULL, o saldo inicial é a soma das contas ativas do escopo SÓ quando todas são
# frescas (regra de classificarSaldoConta, src/lib/financeiro/saldo-contas.ts: fresca ⇔ minimo ≤
# saldo_data ≤ hoje, dias de SP, minimo = dia de SP de now() − 4 h); senão NULL, e o saldo_projetado
# das 13 semanas sai NULL com entradas/saídas/fluxo intactos. Com p_saldo_inicial informado, nada muda.
#
# ⏰ Relógio CONTROLADO (`test.agora`), como em db/test-fuso-sp-relogio-sessao.sh: `public.now()` lê a
# GUC e é TRIPWIRE sem ela; a função ganha `search_path = public, pg_catalog, pg_temp` SÓ depois do
# apply (a POS da migration confere o search_path de prod). As datas são de 2025 de propósito, longe
# do relógio de parede: a sabotagem que troca now() por clock_timestamp() cai em "tudo velho".
# Cada caso roda sob sessão TimeZone=UTC (U) e America/Sao_Paulo (S).
#
# Rodar:   bash db/test-projecao-13s-saldo-fresco.sh > log 2>&1; echo $?
#          bash db/test-projecao-13s-saldo-fresco.sh --falsificar > log 2>&1; echo $?
# matriz local: HARNESS_LC=C e HARNESS_LC=pt_BR.UTF-8 (lc_messages do banco de teste)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5871}"
SLUG="projecao-13s-saldo-fresco"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG="${MIG_OVERRIDE:-$REPO_ROOT/supabase/migrations/20261028014827_projecao_13s_saldo_inicial_fresco_ou_nulo.sql}"
MIG_PRED="$REPO_ROOT/supabase/migrations/20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql"
MD5_PRED=ec1db10e16e975e1a09224bede8c79f9   # prosrc de PROD em 2026-10-28 (psql-ro) = MIG_PRED
MD5_NOVO=dc22fe016ea307694ea1426cd75e011f   # prosrc desta migration (a 2ª testemunha confere o mesmo)

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: o controle roda PRIMEIRO, na mesma invocação (uma suíte que já falha sozinha
# aprovaria toda sabotagem). Cada sabotagem é aplicada num ESPELHO da migration (nunca em
# supabase/migrations/), com o md5 literal recalculado para o corpo sabotado — senão a POS a
# recusaria e o vermelho seria de execução, não de asserção. Formato: <sabotagem>:<vermelhos>:<verdes>
# (IDs de caso com sufixo U/S = sessão UTC/SP). Vermelho tem de ser por RESULTADO; ERRO_DE_EXECUCAO
# não mata mutante.
# ═══════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="corpo_antigo:C2U,C3U,C4U,C6U,C8U,C2S,C3S:C1U,C11U,C12U,C1S
              hoje_ou_ontem:C6U,C6S:C7U,C7S,C1U,C8U,C3U
              relogio_de_parede:C1U,C7U,C1S:C12U,C2U
              sem_nan:C5U,C5S:C1U,C3U,C17U
              sem_infinito:C17U,C18U:C1U,C5U
              zero_no_vazio:C2U,C2S:C1U,C3U
              soma_parcial:C3U,C4U,C6U,C8U:C1U,C2U
              sem_ativo:C1U,C1S:C12U,C2U
              sem_escopo:C9U,C9S:C11U,C10U,C12U
              dia_da_sessao:C16U:C16S,C15U,C15S,C1U
              sem_futuro:C8U,C16U,C16S:C1U,C6U
              sem_gate:G1,G3:G2,C1U
              data_nula_ignorada:C3U,C3S:C1U,C4U
              saldo_nulo_ignorado:C4U,C4S:C1U,C3U
              informado_ignorado:C12U,C12S:C1U,C13U
              pre_aceita_tudo:K1:P1,C1U"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""
    for x in ${verm//,/ }; do
      grep -Eq "(^|[^A-Z0-9])${x} FALHOU" "$log" || faltou="$faltou $x"
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    intrusos="$(grep -oE '[A-Z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "${intrusos// /}" ]; then
      echo "  ✅ $sab — vermelha em [${verm}], verde em [${verdes}]"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "${intrusos// /}" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO em: ${intrusos}— vermelho que não é do assert não mata mutante"
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

# ── A sabotagem vai num ESPELHO da migration, com o md5 literal do corpo recalculado ──────────────
if [ -n "$SABOTAGEM" ]; then
  python3 - "$MIG" "$TMPD/mig.sql" "$SABOTAGEM" "$MD5_NOVO" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys, re, hashlib
src, dst, sab, md5_novo = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
ini = s.find("AS $function$") + len("AS $function$")
fim = s.find("$function$", ini)
corpo = s[ini:fim]
def troca(c, a, b):
    if c.count(a) != 1:
        sys.exit("trecho ausente/ambíguo (%d): %r" % (c.count(a), a[:70]))
    return c.replace(a, b)
if sab == "corpo_antigo":
    i = corpo.find("  ELSE\n    -- Mesma regra"); f = corpo.find("      v_saldo := NULL;\n    END IF;\n  END IF;")
    if i < 0 or f < 0: sys.exit("bloco do ELSE não achado")
    f += len("      v_saldo := NULL;\n    END IF;\n  END IF;")
    corpo = corpo[:i] + ("  ELSE\n    IF p_company IS NOT NULL THEN\n"
        "      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo FROM fin_contas_correntes WHERE company = p_company AND ativo;\n"
        "    ELSE\n      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo FROM fin_contas_correntes WHERE ativo;\n"
        "    END IF;\n  END IF;") + corpo[f:]
elif sab == "hoje_ou_ontem":
    corpo = troca(corpo, "v_minimo := ((now() - interval '4 hours') AT TIME ZONE 'America/Sao_Paulo')::date;", "v_minimo := v_hoje - 1;")
elif sab == "relogio_de_parede":
    corpo = troca(corpo, "v_hoje := (now() AT", "v_hoje := (clock_timestamp() AT")
    corpo = troca(corpo, "v_minimo := ((now() -", "v_minimo := ((clock_timestamp() -")
elif sab == "sem_nan":
    corpo = troca(corpo, "'NaN'::numeric, ", "")
elif sab == "sem_infinito":
    corpo = troca(corpo, ", 'Infinity'::numeric, '-Infinity'::numeric", "")
elif sab == "zero_no_vazio":
    corpo = troca(corpo, "IF v_contas = 0 OR v_invalidas > 0 THEN", "IF v_invalidas > 0 THEN")
    corpo = troca(corpo, "           SUM(saldo_atual)\n", "           COALESCE(SUM(saldo_atual), 0)\n")
elif sab == "soma_parcial":
    corpo = troca(corpo, "           SUM(saldo_atual)\n",
                  "           SUM(saldo_atual) FILTER (WHERE saldo_data BETWEEN v_minimo AND v_hoje AND saldo_atual <> 'NaN'::numeric)\n")
    corpo = troca(corpo, "v_invalidas > 0 THEN", "v_invalidas = v_contas THEN")
elif sab == "sem_ativo":
    corpo = troca(corpo, "WHERE (p_company IS NULL OR company = p_company) AND ativo;", "WHERE (p_company IS NULL OR company = p_company);")
elif sab == "sem_escopo":
    corpo = troca(corpo, "WHERE (p_company IS NULL OR company = p_company) AND ativo;", "WHERE ativo;")
elif sab == "dia_da_sessao":
    corpo = troca(corpo, "v_hoje := (now() AT TIME ZONE 'America/Sao_Paulo')::date;", "v_hoje := now()::date;")
elif sab == "sem_futuro":
    corpo = troca(corpo, "saldo_data NOT BETWEEN v_minimo AND v_hoje", "saldo_data < v_minimo")
elif sab == "sem_gate":
    i = corpo.find("  IF auth.uid() IS NULL"); f = corpo.find("  END IF;\n", i)
    if i < 0 or f < 0: sys.exit("gate não achado")
    corpo = corpo[:i] + corpo[f + len("  END IF;\n"):]
elif sab == "data_nula_ignorada":
    corpo = troca(corpo, "WHERE saldo_data IS NULL OR saldo_atual IS NULL", "WHERE saldo_atual IS NULL")
elif sab == "saldo_nulo_ignorado":
    corpo = troca(corpo, "WHERE saldo_data IS NULL OR saldo_atual IS NULL\n                              OR ", "WHERE saldo_data IS NULL\n                              OR ")
elif sab == "informado_ignorado":
    corpo = troca(corpo, "IF p_saldo_inicial IS NOT NULL THEN", "IF false THEN")
elif sab == "pre_aceita_tudo":
    pass   # mexe fora do corpo: aplicada depois de remontar o arquivo (os índices são do original)
else:
    sys.exit("sabotagem desconhecida: " + sab)
novo = hashlib.md5(corpo.encode()).hexdigest()
s = s[:ini] + corpo + s[fim:]
if sab == "pre_aceita_tudo":
    if s.count("IF v_vivo IS NULL OR v_vivo NOT IN (") != 1: sys.exit("PRE não achada")
    s = s.replace("IF v_vivo IS NULL OR v_vivo NOT IN (", "IF false AND v_vivo NOT IN (")
else:
    if s.count(md5_novo) != 2: sys.exit("md5 literal do corpo não aparece 2x (PRE e POS)")
    s = s.replace(md5_novo, novo)
open(dst, "w", encoding="utf-8").write(s)
PYSAB
  MIG="$TMPD/mig.sql"
  echo "SABOTAGEM ativa: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Valor que é erro (psql, tripwire) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 220)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
# ── Pré-requisitos: o que a função lê. Tipos conferidos na prod via psql-ro (2026-10-28). ─────────
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE TABLE public.fin_contas_correntes (
  id integer PRIMARY KEY,
  company text NOT NULL CHECK (company = ANY (ARRAY['oben'::text, 'colacor'::text, 'colacor_sc'::text])),
  saldo_data date, saldo_atual numeric(15,2) DEFAULT 0, ativo boolean DEFAULT true
);
CREATE TABLE public.fin_contas_receber (company text, valor_documento numeric(15,2), valor_recebido numeric(15,2), data_vencimento date, status_titulo text);
CREATE TABLE public.fin_contas_pagar   (company text, valor_documento numeric(15,2), valor_pago numeric(15,2),     data_vencimento date, status_titulo text);
INSERT INTO public.user_roles VALUES ('11111111-1111-1111-1111-111111111111', 'employee');

-- Relógio controlado: TRIPWIRE sem a GUC.
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora — a prova escapou do relógio controlado' USING ERRCODE = 'Z9T01';
  END IF;
  RETURN v::timestamptz;
END $f$;
SQL
STAFF=11111111-1111-1111-1111-111111111111
CLIENTE=22222222-2222-2222-2222-222222222222

# ── Predecessor = PROD: o corpo da 20260927202603, com o ACL medido (authenticated, service_role) ──
python3 - "$MIG_PRED" > "$TMPD/pred.sql" <<'PYEXT'
import sys, re
s = open(sys.argv[1], encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE FUNCTION public.fin_projecao_13_semanas(")
m = re.compile(r"AS\s+(\$[A-Za-z_]*\$)").search(s, ini)
fim = s.find(m.group(1), m.end()) if (ini >= 0 and m) else -1
if fim < 0: sys.exit("predecessor não achado")
print(s[ini:s.find(";", fim) + 1])
PYEXT
ACL="REVOKE ALL ON FUNCTION public.fin_projecao_13_semanas(text, numeric) FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION public.fin_projecao_13_semanas(text, numeric) TO authenticated, service_role;"
P -q -f "$TMPD/pred.sql" -c "$ACL"
MD5Q="SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fin_projecao_13_semanas(text,numeric)'::regprocedure"
eq P1 "predecessor carregado = corpo de prod" "$(Pq -c "$MD5Q" 2>&1)" "$MD5_PRED"

# K1 — a PRE recusa corpo vivo desconhecido (deriva): a migration aborta inteira e não toca o corpo.
sed 's/^  v_week_end date;$/  v_week_end date; -- deriva/' "$TMPD/pred.sql" > "$TMPD/deriva.sql"
P -q -f "$TMPD/deriva.sql"
md5_deriva="$(Pq -c "$MD5Q")"
saida="$(P -q --single-transaction -f "$MIG" 2>&1 || true)"
depois="$(Pq -c "$MD5Q")"
if [ "$md5_deriva" = "$MD5_PRED" ]; then
  erro_exec K1 "a deriva não mudou o corpo — o caso não existe"
elif printf '%s' "$saida" | grep -q 'PRE FALHOU' && [ "$depois" = "$md5_deriva" ]; then
  ok K1 "PRE recusou o corpo em deriva e nada mudou"
else
  bad K1 "PRE deixou passar a deriva (corpo agora $depois) [$(printf '%s' "$saida" | tr '\n' ' ' | head -c 160)]"
fi
P -q -f "$TMPD/pred.sql"

# ── Apply como o `db:aplicar` (transação do executor), e re-apply (idempotente: a PRE aceita "este") ─
P -q --single-transaction -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"
if P -q --single-transaction -f "$MIG" >/dev/null 2>&1; then ok P4 "re-aplicar é idempotente"; else bad P4 "re-aplicar falhou"; fi
eq P2 "corpo vivo = o desta migration (md5 que a 2ª testemunha confere em prod)" "$(Pq -c "$MD5Q" 2>&1)" "$MD5_NOVO"
eq P3 "ACL preservado: EXECUTE anon|public|authenticated|service_role" \
  "$(Pq -c "SELECT string_agg(has_function_privilege(r, 'public.fin_projecao_13_semanas(text,numeric)'::regprocedure, 'EXECUTE')::text, '|' ORDER BY o)
             FROM (VALUES (1,'anon'),(2,'public'),(3,'authenticated'),(4,'service_role')) v(o, r)" 2>&1)" "false|false|true|true"
eq T1 "o 4 h da SQL é o HORAS_TOLERANCIA_SYNC_BASE do TS" \
  "$(grep -c '^export const HORAS_TOLERANCIA_SYNC_BASE = 4;$' "$REPO_ROOT/src/lib/financeiro/saldo-contas.ts" || true)|$(grep -c "now() - interval '4 hours'" "$REPO_ROOT/supabase/migrations/20261028014827_projecao_13s_saldo_inicial_fresco_ou_nulo.sql" || true)" "1|1"

# Só agora o relógio controlado alcança a função (public antes de pg_catalog). A guarda exige que o
# ÚNICO nome de public que sombreia pg_catalog seja o nosso now(); controle POSITIVO: tem de vê-lo.
P -q -c "ALTER FUNCTION public.fin_projecao_13_semanas(text, numeric) SET search_path = public, pg_catalog, pg_temp;"
eq V1 "só now() sombreia pg_catalog" "$(Pq -c "SELECT COALESCE(string_agg(DISTINCT p.proname, ',' ORDER BY p.proname), '') FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
      AND c.proname = p.proname AND c.proargtypes = p.proargtypes)" 2>&1)" "now"

# ── Fixture (2025, longe do relógio de parede). Qua 12/03/2025; SP = UTC−3. Semana 0 = seg 10/03. ──
P -q <<'SQL'
INSERT INTO public.fin_contas_correntes (id, company, saldo_data, saldo_atual, ativo) VALUES
  (1, 'oben',    '2025-03-12', 1000.00, true),
  (2, 'oben',    '2025-03-12', 2500.50, true),
  (3, 'oben',    '2025-01-01', 9999.00, false),   -- inativa e velha: fora do denominador
  (4, 'oben',    NULL,         NULL,    NULL),    -- ativo NULL: fora (= .eq('ativo', true) do TS)
  (5, 'colacor', '2025-03-12',  700.00, true);
INSERT INTO public.fin_contas_receber VALUES
  ('oben',    300.00, 100.00, '2025-03-13', 'A VENCER'),     -- semana 0: +200
  ('oben',     80.00, NULL,   '2025-04-15', 'VENCE HOJE'),   -- semana 5: +80
  ('oben',    999.00, 0,      '2025-03-14', 'RECEBIDO'),     -- fora (status)
  ('colacor',  50.00, 0,      '2025-03-25', 'A VENCER');     -- semana 2: +50
INSERT INTO public.fin_contas_pagar VALUES
  ('oben',    150.00, 0,      '2025-03-18', 'ATRASADO');     -- semana 1: −150
SQL

# Resumo das 13 linhas: n|n_saldo_nulo|1ª|min|última|Σentradas|Σsaídas|Σfluxo|1ª semana|última semana.
# Linhas faltando dão n<13; zero linhas viram vazio (ERRO_DE_EXECUCAO, nunca verde).
resumo() {
  printf "SELECT count(*) || '|' || count(*) FILTER (WHERE saldo_projetado IS NULL) || '|' ||
    COALESCE((array_agg(saldo_projetado ORDER BY semana_inicio))[1]::text, 'NULL') || '|' ||
    COALESCE(min(saldo_projetado)::text, 'NULL') || '|' ||
    COALESCE((array_agg(saldo_projetado ORDER BY semana_inicio DESC))[1]::text, 'NULL') || '|' ||
    sum(entradas_previstas) || '|' || sum(saidas_previstas) || '|' || sum(fluxo_liquido) || '|' ||
    min(semana_inicio) || '|' || max(semana_inicio)
  FROM public.fin_projecao_13_semanas(%s);" "$1"
}
# Um caso: <TimeZone> <agora> <setup SQL> <args> — setup como postgres, leitura como authenticated
# staff, tudo numa transação que reverte.
caso() {
  printf 'BEGIN;\n%s\nSET LOCAL ROLE authenticated;\n%s\nROLLBACK;\n' "$3" "$(resumo "$4")" |
    PGOPTIONS="-c TimeZone=$1 -c test.agora=$2 -c test.uid=$STAFF" Pq -q -f - 2>&1 || true
}

A=2025-03-12T13:00:00Z      # 10:00 SP — hoje 12/03, mínimo 12/03
B=2025-03-12T06:59:59Z      # 03:59:59 SP — mínimo ainda 11/03
C=2025-03-12T07:00:00Z      # 04:00:00 SP — mínimo 12/03
E=2025-03-12T01:00:00Z      # 22:00 SP de 11/03 — no UTC já é 12/03; hoje de SP = 11/03
SEM="2025-03-10|2025-06-02"
OBEN_OK="13|0|3700.50|3550.50|3630.50|280.00|150.00|130.00|$SEM"       # 3500.50 +200 −150 +80
OBEN_NULO="13|13|NULL|NULL|NULL|280.00|150.00|130.00|$SEM"
CONS_OK="13|0|4400.50|4250.50|4380.50|330.00|150.00|180.00|$SEM"       # 4200.50 +200 −150 +50 +80
CONS_NULO="13|13|NULL|NULL|NULL|330.00|150.00|180.00|$SEM"
VAZIO="13|13|NULL|NULL|NULL|0|0|0|$SEM"
INFORMADO0="13|0|200.00|50.00|130.00|280.00|150.00|130.00|$SEM"
NEG="13|0|-300.00|-450.00|-370.00|280.00|150.00|130.00|$SEM"           # 0 + (−500) +200 −150 +80
UPD="UPDATE public.fin_contas_correntes SET"

for S in U S; do
  if [ "$S" = U ]; then TZS=UTC; else TZS=America/Sao_Paulo; fi
  echo "── sessão TimeZone=$TZS ──"
  eq "C1$S"  "todas frescas → soma + fluxo"                  "$(caso $TZS $A "" "p_company => 'oben'")" "$OBEN_OK"
  eq "C2$S"  "sem conta ativa no escopo → NULL, não R\$ 0"    "$(caso $TZS $A "" "p_company => 'colacor_sc'")" "$VAZIO"
  eq "C3$S"  "1 conta com saldo_data NULL → NULL"            "$(caso $TZS $A "$UPD saldo_data = NULL WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C4$S"  "1 conta com saldo_atual NULL → NULL"           "$(caso $TZS $A "$UPD saldo_atual = NULL WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C5$S"  "1 conta com saldo NaN → NULL"                  "$(caso $TZS $A "$UPD saldo_atual = 'NaN' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C6$S"  "saldo de ontem às 04:00:00 SP → NULL"          "$(caso $TZS $C "$UPD saldo_data = '2025-03-11' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C7$S"  "saldo de ontem às 03:59:59 SP → número"        "$(caso $TZS $B "$UPD saldo_data = '2025-03-11' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_OK"
  eq "C8$S"  "saldo_data futuro → NULL"                      "$(caso $TZS $A "$UPD saldo_data = '2025-03-13' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C9$S"  "outra empresa velha não contamina o escopo"    "$(caso $TZS $A "$UPD saldo_data = '2025-03-01' WHERE id = 5;" "p_company => 'oben'")" "$OBEN_OK"
  eq "C10$S" "consolidado com 1 empresa velha → NULL"        "$(caso $TZS $A "$UPD saldo_data = '2025-03-01' WHERE id = 5;" "")" "$CONS_NULO"
  eq "C11$S" "consolidado todo fresco → soma"                "$(caso $TZS $A "" "")" "$CONS_OK"
  eq "C12$S" "p_saldo_inicial = 0 informado vence conta velha" "$(caso $TZS $A "$UPD saldo_data = '2025-03-01' WHERE id = 1;" "p_company => 'oben', p_saldo_inicial => 0")" "$INFORMADO0"
  eq "C13$S" "p_saldo_inicial NULL explícito = omitido"      "$(caso $TZS $A "$UPD saldo_data = '2025-03-01' WHERE id = 1;" "p_company => 'oben', p_saldo_inicial => NULL")" "$OBEN_NULO"
  eq "C14$S" "saldos frescos zero e negativo são número"     "$(caso $TZS $A "$UPD saldo_atual = 0 WHERE id = 1; $UPD saldo_atual = -500 WHERE id = 2;" "p_company => 'oben'")" "$NEG"
  eq "C15$S" "22h SP (já amanhã no UTC): saldo de hoje SP → número" "$(caso $TZS $E "$UPD saldo_data = '2025-03-11' WHERE id IN (1, 2);" "p_company => 'oben'")" "$OBEN_OK"
  eq "C16$S" "22h SP: saldo com o dia UTC (futuro em SP) → NULL" "$(caso $TZS $E "$UPD saldo_data = '2025-03-11' WHERE id = 2;" "p_company => 'oben'")" "$OBEN_NULO"
  # numeric(15,2) de prod não guarda ±Infinity: o guard é defensivo; o caso alarga a coluna na transação.
  eq "C17$S" "(defensivo) saldo +Infinity → NULL"            "$(caso $TZS $A "ALTER TABLE public.fin_contas_correntes ALTER COLUMN saldo_atual TYPE numeric; $UPD saldo_atual = 'Infinity' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
  eq "C18$S" "(defensivo) saldo -Infinity → NULL"            "$(caso $TZS $A "ALTER TABLE public.fin_contas_correntes ALTER COLUMN saldo_atual TYPE numeric; $UPD saldo_atual = '-Infinity' WHERE id = 1;" "p_company => 'oben'")" "$OBEN_NULO"
done

# ── Gate: negativo pela SQLSTATE + marca esperadas; o resto relança (vira ERRO_DE_EXECUCAO). ─────
nega() {   # <papel> <uid> <marca>
  PGOPTIONS="-c TimeZone=UTC -c test.agora=$A -c test.uid=$2" Pq -q <<SQL 2>&1 || true
CREATE FUNCTION pg_temp.nega(p_marca text) RETURNS text LANGUAGE plpgsql AS \$f\$
BEGIN
  PERFORM count(*) FROM public.fin_projecao_13_semanas('oben');
  RETURN 'PASSOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '42501' AND position(p_marca IN SQLERRM) > 0 THEN RETURN 'NEGOU'; END IF;
  RAISE;
END \$f\$;
SET ROLE $1;
SELECT pg_temp.nega('$3');
SQL
}
eq G1 "authenticated NÃO-staff → 42501 do gate"           "$(nega authenticated "$CLIENTE" 'requer perfil staff')" "NEGOU"
eq G2 "anon → 42501 do ACL"                                "$(nega anon "$STAFF" 'fin_projecao_13_semanas')" "NEGOU"
eq G3 "authenticated sem uid → 42501 do gate"             "$(nega authenticated "" 'requer perfil staff')" "NEGOU"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
