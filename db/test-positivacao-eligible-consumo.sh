#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — positivação ao vivo (`_carteira_positivacao_for_owner`)           ║
# ║                                                                                ║
# ║  Bloco C — a elegibilidade é reaplicada no CONSUMO (comissão/positivação).     ║
# ║    FU3 do #1398: sem este teste, um refactor que solte um JOIN eleg reabre o   ║
# ║    vazamento em silêncio, e o efeito é comissão contando cliente mascarado.    ║
# ║  Bloco B — o mês é o de SÃO PAULO nos dois eixos timestamptz (ligação e        ║
# ║    pedido sem order_date_kpi), seja qual for o fuso da SESSÃO. A prod roda     ║
# ║    sessão UTC; até a 20260927133606 o que acontecia das 21:00 às 23:59 BRT do  ║
# ║    último dia contava no mês seguinte. O bloco CRUZA a borda de propósito, em  ║
# ║    pares de 1 s, e roda sob `TimeZone=UTC` E `America/Sao_Paulo`: sob sessão   ║
# ║    SP o corpo antigo passa, então só a rodada UTC o pega.                      ║
# ║                                                                                ║
# ║  ⏰ Relógio: tudo roda num relógio CONTROLADO (`test.agora`). `public.now()` é  ║
# ║  um TRIPWIRE (SQLSTATE Z9T01): sem `test.agora` ele levanta exceção em vez de  ║
# ║  cair no relógio de parede. Antes, o seed usava `date_trunc('month', now())`   ║
# ║  no fuso da sessão e a prova reprovava sozinha no dia 1, 00:00-02:59 UTC.      ║
# ║  Diário: docs/historico/positivacao-mes-sp-sob-sessao-utc.md                   ║
# ║                                                                                ║
# ║  rode: bash db/test-positivacao-eligible-consumo.sh > log 2>&1; echo "exit=$?" ║
# ║        bash db/test-positivacao-eligible-consumo.sh --falsificar > log 2>&1    ║
# ║  matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8  ║
# ║  (lc_messages do servidor; o cliente fica em LC_ALL=C: todo grep aqui é ASCII) ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5472}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="positivacao-eligible"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG_ORIGEM="$REPO_ROOT/supabase/migrations/20260525210000_viewas_rpcs_for.sql"
MIG_NOVA="$REPO_ROOT/supabase/migrations/20260927133606_positivacao_mes_sp_sessao_utc.sql"
# Denominador: quantos asserts a suíte EXECUTA (R0-R1 · C1-C10 · B0-B14 ×2 sessões · W1-W2).
# Asserts a menos — um bloco que não rodou — é vermelho: `FAIL=0` com PASS encolhido é a prova
# truncada que aprova tudo.
TOTAL_ESPERADO=44

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO (todos) e os que TÊM de continuar verdes (rodados e verdes). Vermelho
# por erro de execução — sabotagem que não aplicou, SQL quebrado, saída vazia, tripwire — NÃO
# mata mutante e reprova a falsificação; a única exceção é declarada (`ID!MARCA`: sem_pin, cujo
# vermelho esperado É o tripwire).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# IDs do bloco B: B<U|S><n> — U = sessão UTC, S = sessão SP; 1-7 = t_fev, 8-14 = t_mar
#   (1/8 mes · 2/9 contatados · 3/10 positivados · 4/11 receita · 5/12 novos · 6/13 a_positivar
#    · 7/14 total_eligible/compradores)
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="corpo_pre_fix:BU2,BU4,BU9,BU11:BS2,BS4,BS9,BS11,BU1,BU8
              contato_cast_na_sessao:BU2,BU9:BS2,BS9,BU4,BU11
              pedido_cast_na_sessao:BU3,BU4,BU5,BU10,BU11,BU12:BS4,BS11,BU2,BU9
              mes_em_utc:BU1,BS1:BU8,BS8,R0
              fim_fechado:BU2,BS2:BU9,BS9
              inicio_aberto:BU9,BS9:BU2,BS2
              primeira_por_max:BU5,BS5,BU12,BS12:BU3,BS3,BU10,BS10
              kpi_sem_precedencia:BU4,BS4,BU11,BS11:BU2,BS2
              relogio_desligado:R0
              hora_de_parede:R0
              sem_pin:R0!TRIPWIRE
              eligible_removido:C1,C3
              gate_master_removido:C9"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migrations reais, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
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
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""; erro_declarado=0
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"; erro_declarado=1
             grep -Eq "(^|[^A-Z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    exec_err=0
    [ "$erro_declarado" -eq 0 ] && grep -q 'ERRO_DE_EXECUCAO' "$log" && exec_err=1
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ "$exec_err" -eq 0 ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ "$exec_err" -eq 1 ] && { echo "  ❌ $sab — houve ERRO DE EXECUÇÃO: vermelho que não é do assert não mata mutante"
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
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro (psql, tripwire) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço
# de falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as 9 tabelas que a migration lê; colunas conferidas)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.carteira_assignments (
  customer_user_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  eligible boolean NOT NULL DEFAULT true
);
-- tipos conferidos na prod via psql-ro (2026-09-27): created_at/started_at timestamptz,
-- order_date_kpi/visit_date date. São os tipos que decidem se há fuso na comparação.
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, status text, total numeric,
  order_date_kpi date, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, farmer_id uuid, started_at timestamptz
);
CREATE TABLE public.route_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, visited_by uuid, visit_date date
);
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid, farmer_id uuid,
  revenue_potential numeric, churn_risk numeric, recover_score numeric,
  days_since_last_purchase numeric, priority_score numeric, avg_repurchase_interval numeric
);
CREATE TABLE public.profiles (user_id uuid, name text, razao_social text);
-- lidas pelo mixgap (mesma migration). Colunas e TIPOS conferidos na prod via psql-ro —
-- `omie_codigo_produto` é bigint, não text: um stub adivinhado quebraria o JOIN e o teste
-- provaria o mundo que eu quis, não o que existe.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, product_id uuid, omie_codigo_produto bigint,
  sales_order_id uuid, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, familia text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_association_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  antecedent_product_ids text[], consequent_product_ids text[],
  confidence numeric, lift numeric, sample_size integer, created_at timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1): a de origem (positivação + mixgap + wrappers)
#   e a que a corrige — que traz a PRÉ-condição (o corpo vivo tem de ser o predecessor revisado)
#   e a POS-condição (corpo, dono, ACL). Aplicar aqui é também o ensaio das duas.
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG_ORIGEM" >/dev/null
echo "migration aplicada: $(basename "$MIG_ORIGEM")"
if [ "$SABOTAGEM" != corpo_pre_fix ]; then
  P -q -f "$MIG_NOVA" >/dev/null
  echo "migration aplicada: $(basename "$MIG_NOVA") (PRE e POS passaram)"
fi

# ── SABOTAGEM (só no modo --falsificar) — no BANCO, recriando a função com o trecho trocado; o
# repo nunca é tocado. Cada padrão tem de ocorrer exatamente n× no corpo: uma troca que não pegou
# deixaria a suíte verde (e o laço, que exige vermelho no assert certo, acusa em vez de aprovar).
sabotar() {   # <migration> <função> <de> <para> <n> [<de> <para> <n> ...]
  local mig="$1" fn="$2" tmp
  shift 2
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$mig" "$fn" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, fn, out, trocas = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
s = open(mig, encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE FUNCTION public." + fn + "(")
fim = s.find("$$;", ini) if ini >= 0 else -1
if ini < 0 or fim < 0:
    print("   função " + fn + " não delimitada em " + mig, file=sys.stderr); sys.exit(1)
bloco = s[ini:fim + 3]
for i in range(0, len(trocas), 3):
    de, para, n = trocas[i], trocas[i + 1], int(trocas[i + 2])
    if bloco.count(de) != n:
        print("   padrão ocorre %dx, esperado %d: %r" % (bloco.count(de), n, de), file=sys.stderr); sys.exit(1)
    bloco = bloco.replace(de, para)
open(out, "w", encoding="utf-8").write(bloco + "\n")
PYSAB
  P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
F=_carteira_positivacao_for_owner
LIG_INI="(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= mes_inicio"
LIG_FIM="(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date < mes_fim"
PED_SP="(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date"
MES_SP="(now() AT TIME ZONE 'America/Sao_Paulo')"
case "$SABOTAGEM" in
  "") ;;
  # o corpo de 20260525210000, sem a correção: a migration nova não foi aplicada (acima)
  corpo_pre_fix) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  # a ligação volta a ser comparada pelo cast implícito da sessão
  contato_cast_na_sessao) sabotar "$MIG_NOVA" "$F" "$LIG_INI" "fc.started_at >= mes_inicio" 1 \
                                                   "$LIG_FIM" "fc.started_at < mes_fim" 1 ;;
  # o pedido sem kpi volta a virar date no fuso da sessão
  pedido_cast_na_sessao) sabotar "$MIG_NOVA" "$F" "$PED_SP" "so.created_at::date" 1 ;;
  # o mês calculado em UTC: às 02:59:59Z de 01/03 (23:59:59 BRT de 28/02) já seria março
  mes_em_utc) sabotar "$MIG_NOVA" "$F" "$MES_SP" "(now() AT TIME ZONE 'UTC')" 2 ;;
  # borda do fim fechada: a ligação de 01/03 00:00 BRT entraria em fevereiro
  fim_fechado) sabotar "$MIG_NOVA" "$F" "$LIG_FIM" "(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date <= mes_fim" 1 ;;
  # borda do início aberta: a ligação de 01/03 00:00 BRT sairia de março
  inicio_aberto) sabotar "$MIG_NOVA" "$F" "$LIG_INI" "(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date > mes_inicio" 1 ;;
  # "novo cliente" pela ÚLTIMA compra, não pela primeira: R (fev e mar) viraria novo em março
  primeira_por_max) sabotar "$MIG_NOVA" "$F" "min(pv.d) AS primeira" "max(pv.d) AS primeira" 1 ;;
  # o created_at passa na frente do KPI: Z1 (kpi fev, criado em mar) e Z2 (kpi mar, criado 28/02 BRT) trocam de mês
  kpi_sem_precedencia) sabotar "$MIG_NOVA" "$F" "COALESCE(so.order_date_kpi, $PED_SP)" "COALESCE($PED_SP, so.order_date_kpi)" 1 ;;
  # o mês tirado do relógio de parede, que o controlado não intercepta
  hora_de_parede) sabotar "$MIG_NOVA" "$F" "$MES_SP" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')" 2 ;;
  # não sabotam função: pulam o ALTER do search_path / o pin do relógio, logo abaixo
  relogio_desligado|sem_pin) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  # o refactor distraído que este teste existe para pegar: a CTE eleg sem o filtro
  eligible_removido) sabotar "$MIG_NOVA" "$F" " AND ca.eligible = true" "" 1 ;;
  # o gate master-only do "ver como" removido
  gate_master_removido) sabotar "$MIG_ORIGEM" get_minha_positivacao_for \
    "IF NOT has_role(auth.uid(),'master'::app_role) THEN RAISE EXCEPTION 'forbidden: master only'; END IF;" "" 1 ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — `public.now()` lê a GUC `test.agora` e é um TRIPWIRE: sem ela, levanta
# exceção com SQLSTATE PRÓPRIO (Z9T01, não o P0001 do RAISE comum, que o C9 trataria como o
# "forbidden" do gate). SÓ a função sob teste ganha `pg_catalog` DEPOIS de `public` no search_path
# — é a única forma de um nome de usuário vencer um embutido (sem `pg_catalog` explícito ele é
# buscado PRIMEIRO). Os wrappers não leem relógio: delegam ao interno, que carrega o próprio.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora — a prova escapou do relógio controlado'
      USING ERRCODE = 'Z9T01';
  END IF;
  RETURN v::timestamptz;
END $f$;
SQL
# O ALTER muda o proconfig da função sob teste em relação à prod: confira o ORIGINAL antes (R1) e
# restaure-o no fim, para o smoke dos wrappers rodar sobre a função exatamente como a prod a vê.
CFG_ORIGINAL="$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public._carteira_positivacao_for_owner(uuid)'::regprocedure;")"
eq R1 "proconfig da função sob teste, antes do relógio" "$CFG_ORIGINAL" "search_path=public"
if [ "$SABOTAGEM" != relogio_desligado ]; then
  P -q -c "ALTER FUNCTION public._carteira_positivacao_for_owner(uuid) SET search_path = public, pg_catalog, pg_temp;"
fi
# O pin do bloco C: TODA conexão nova nasce em 14/02/2025 15:00Z (meio do mês nos dois fusos) —
# cada P/Pq abre outra conexão, e é o banco que carrega o relógio para todas. O bloco B troca o
# instante na própria sessão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-02-14 15:00:00+00';"
fi

# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA
# assinatura de um embutido passaria a vencê-lo — inclusive as que o corpo chama por sintaxe
# (`AT TIME ZONE` é `timezone(...)`), que nenhum regex sobre o corpo enxergaria. Por isso a guarda
# exige que o ÚNICO nome de `public` que sombreia `pg_catalog` seja o nosso now(). Controle
# POSITIVO: ela tem de enxergá-lo — se não vê nem esse, está cega e aborta.
sombra="$(Pq -c "SELECT COALESCE(string_agg(s.proname, ',') FILTER (WHERE s.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(s.proname, ',' ORDER BY s.proname) FILTER (WHERE s.proname <> 'now'), '')
  FROM (SELECT DISTINCT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                        AND c.proname = p.proname AND c.proargtypes = p.proargtypes)) s;")"
case "$sombra" in
  'now|') echo "guarda de sombra: só now() sombreia pg_catalog (controle positivo visto)" ;;
  now\|*) echo "❌ o relógio controlado mudaria mais que o now(): public sombreia [${sombra#*|}]"; exit 1 ;;
  *) echo "❌ guarda cega: não enxergou nem o public.now() que acabou de ser criado [$sombra]"; exit 1 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED do bloco C: 4 clientes do MESMO vendedor, em 2 pares idênticos-menos-`eligible`.
#   COM pedido no mês:  aaaa (MASCARADO) · bbbb (elegível)  → exercita positivados/receita
#   SEM pedido no mês:  cccc (MASCARADO) · dddd (elegível)  → exercita a_positivar
#   O par sem-pedido existe porque `a_positivar` lista quem AINDA NÃO comprou: sem ele,
#   a lista sai vazia e o assert passaria por vacuidade (0=0), sem provar a máscara.
#   Datas LITERAIS no mês de SP do relógio controlado (14/02/2025); o R0 prova que a função
#   leu esse mesmo relógio — sem ele, o seed e a função poderiam estar em meses diferentes.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','employee');

INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', false),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','22222222-2222-2222-2222-222222222222', true);

-- pedido no mês do relógio só p/ aaaa e bbbb (mesmo valor) → só o elegível pode contar
INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','faturado', 1000, '2025-02-14'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','faturado', 1000, '2025-02-14');

INSERT INTO public.farmer_calls(customer_user_id, farmer_id, started_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', '2025-02-14 15:00:00+00'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', '2025-02-14 15:00:00+00');

-- score p/ os 4 (churn_risk 90 ≥ 60 → todos entrariam em recencia_critica sem a máscara)
INSERT INTO public.farmer_client_scores
  (customer_user_id, farmer_id, revenue_potential, churn_risk, recover_score,
   days_since_last_purchase, priority_score, avg_repurchase_interval) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','22222222-2222-2222-2222-222222222222', 5000, 90, 50, 200, 80, 30);

INSERT INTO public.profiles(user_id, name, razao_social) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Mascarado A','MASCARADO A LTDA'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Elegivel B','ELEGIVEL B LTDA'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','Mascarado C','MASCARADO C LTDA'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','Elegivel D','ELEGIVEL D LTDA');
SQL

E_UID="22222222-2222-2222-2222-222222222222"
# `|| true`: um erro (o TRIPWIRE, por exemplo) vira o VALOR lido e cai no ERRO_DE_EXECUCAO do eq,
# em vez de o set -e matar a prova calada no meio.
Q() { Pq -c "SELECT (public._carteira_positivacao_for_owner('$E_UID'::uuid)->>'$1');" 2>&1 || true; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS do bloco C: cada agregado da comissão ignora o cliente mascarado
# ══════════════════════════════════════════════════════════════════════════════
echo "── relógio controlado ──"
# controle POSITIVO do relógio: sem ele, um relógio desligado deixaria a função no de parede e
# os asserts abaixo mediriam o mês em que a prova roda, não o do seed.
eq R0  "mes do bloco C = mês de SP do relógio controlado" "$(Q mes)" "2025-02-01"

echo "── consumo/comissão reaplica eligible ──"
# 4 clientes na carteira, 2 elegíveis → todo agregado tem de enxergar SÓ os 2
eq C1 "total_eligible = só os elegíveis (2 de 4)"  "$(Q total_eligible)"   "2"
eq C2 "positivados ignora o mascarado"             "$(Q positivados)"      "1"
eq C3 "receita_mtd NÃO soma o mascarado (money)"   "$(Q receita_mtd)"      "1000"
eq C4 "contatados_mtd ignora o mascarado"          "$(Q contatados_mtd)"   "1"
eq C5 "recencia_critica ignora os mascarados"      "$(Q recencia_critica)" "2"

# a_positivar é a LISTA NOMINAL entregue ao vendedor — o mascarado não pode ser nomeado.
# (cccc é mascarado E sem pedido: sem a máscara ele apareceria aqui.)
V=$(Pq -c "SELECT (public._carteira_positivacao_for_owner('$E_UID'::uuid)->'a_positivar')::text ILIKE '%MASCARADO%';" 2>&1 || true)
eq C6 "a_positivar NÃO nomeia mascarado"           "$V" "f"
V=$(Pq -c "SELECT jsonb_array_length(public._carteira_positivacao_for_owner('$E_UID'::uuid)->'a_positivar');" 2>&1 || true)
eq C7 "a_positivar lista só o elegível sem pedido" "$V" "1"

# gate de autorização das RPCs expostas (não é o foco, mas é a fronteira)
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT public.get_minha_positivacao() IS NOT NULL;" 2>&1 | tail -1 || true)
eq C8 "employee lê a PRÓPRIA positivação"          "$V" "t"
# ⚠️ NÃO sinalize "não barrou" com `RAISE EXCEPTION` genérico: ele levanta P0001, o MESMO
# SQLSTATE do `RAISE EXCEPTION 'forbidden: master only'` da RPC → o handler `WHEN raise_exception`
# capturaria o PRÓPRIO sentinel e o assert ficaria verde com o gate ESCANCARADO. (Achado Codex
# xhigh no #1416.) Use uma FLAG, que não colide com SQLSTATE nenhum — e só a MENSAGEM do gate
# conta como barrado: qualquer outro P0001 (um RAISE de relógio, de sabotagem) é relançado, em
# vez de virar "o gate barrou" por coincidência de código (achado do Codex, desenho 2026-09-27).
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$E_UID';
SET ROLE authenticated;
DO \$\$
DECLARE v_passou boolean := false; v_barrado boolean := false;
BEGIN
  BEGIN
    PERFORM public.get_minha_positivacao_for('33333333-3333-3333-3333-333333333333'::uuid);
    v_passou := true;                       -- chegou aqui = o gate deixou passar
  EXCEPTION
    WHEN raise_exception THEN               -- P0001: só o 'forbidden: master only' é o gate
      IF SQLERRM = 'forbidden: master only' THEN v_barrado := true; ELSE RAISE; END IF;
    WHEN OTHERS THEN RAISE;                 -- qualquer outro erro: relança
  END;
  IF v_barrado THEN RAISE NOTICE 'GATE_MASTER_OK';
  ELSIF v_passou THEN RAISE NOTICE 'GATE_ABERTO_BUG';
  END IF;
END \$\$;
SQL
)
case "$R" in
  *GATE_MASTER_OK*)  ok C9 "employee NÃO lê positivação de outro (master-only, pela mensagem do gate)" ;;
  *GATE_ABERTO_BUG*) bad C9 "gate ABERTO — employee leu positivação de outro" ;;
  *)                 erro_exec C9 "sem veredito do gate: $(printf '%s' "$R" | tr '\n' ' ' | head -c 200)" ;;
esac

# mixgap: função IRMÃ na mesma migration, com a MESMA CTE `eleg` filtrando eligible.
# Aqui só se prova que EXECUTA (plpgsql é late-bound: um SQL inválido passaria no CREATE
# e só quebraria em runtime). Provar a máscara nela exigiria semear association_rules —
# não coberto; a invariante dela está verificada por leitura, não por assert.
V=$(Pq -c "SELECT (public._carteira_mixgap_for_owner('$E_UID'::uuid)->>'total_com_gap');" 2>&1 || true)
eq C10 "mixgap EXECUTA (late-bound coberto)"       "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO B — A BORDA DO MÊS DE SP, cruzada de propósito. Outro dono (E2), 11 clientes elegíveis.
#   Borda: 01/03/2025 00:00:00 BRT = 01/03/2025 03:00:00Z. Fixtures no universo COMUM
#   (status 'faturado', sem exclusão lógica): um seed fora dele devolveria 0 com o código certo
#   E com o errado, e o assert passaria por vacuidade.
#   ligações (timestamptz): X1 28/02 22:30 e 22:45 BRT (repetida: conta 1) · X2 28/02 23:59:59
#     BRT · X3 01/03 00:00:00 BRT
#   visitas (date, sem fuso — controle do eixo que já era certo): W1 28/02 · W2 01/03
#   pedidos SEM kpi (created_at): Y1=1 · Y2=10 · Y3=100, nos instantes de X1/X2/X3
#   pedidos COM kpi, com created_at em OUTRO mês de SP (prova a PRECEDÊNCIA do kpi):
#     Z1 kpi 28/02 criado em 15/03 = 1000 · Z1b kpi 20/02 = 10000 (2º pedido de Z1: conta 1)
#     Z2 kpi 01/03 criado 01/03 00:00Z (= 28/02 21:00 BRT) = 100000
#   R, que RECOMPRA: 28/02 23:00 BRT sem kpi = 1000000 e kpi 05/03 = 10000000 — em março ele é
#     positivado mas NÃO é novo, o que separa `novos` de `positivados`
#   scores/profiles para Y1..Y3, Z1, Z2, R — a_positivar é conferida pelos NOMES
#   A receita é soma de potências de 10: o valor diz QUAIS pedidos entraram, não só quantos.
#   Relógio: t_fev = 02:59:59Z (último segundo de fevereiro em SP) · t_mar = 03:00:00Z.
#   Esperado, NAS DUAS SESSÕES (conferido por um oráculo independente em Python):
#     t_fev → 02-01 · contatados 3 · positivados 4 · receita 1011011 · novos 4 · Y3,Z2 · 11/4
#     t_mar → 03-01 · contatados 2 · positivados 3 · receita 10100100 · novos 2 · Y1,Y2,Z1 · 11/3
#   O corpo antigo, sob sessão UTC: t_fev 1 · 1 · 11000 · 1 e t_mar 4 · 5 · 11100111 · 5; sob
#   sessão SP ele passa — é por isso que o bloco roda nas duas.
# ══════════════════════════════════════════════════════════════════════════════
E2_UID="44444444-4444-4444-4444-444444444444"
c2() { printf 'e2c00000-0000-0000-0000-0000000000%02d' "$1"; }
P -q <<SQL
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible)
SELECT ('e2c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E2_UID', true
FROM generate_series(1, 11) i;

INSERT INTO public.farmer_calls(customer_user_id, farmer_id, started_at) VALUES
  ('$(c2 1)', '$E2_UID', '2025-03-01 01:30:00+00'),  -- X1 28/02 22:30 BRT
  ('$(c2 1)', '$E2_UID', '2025-03-01 01:45:00+00'),  -- X1 de novo, 22:45 BRT
  ('$(c2 2)', '$E2_UID', '2025-03-01 02:59:59+00'),  -- X2 28/02 23:59:59 BRT
  ('$(c2 3)', '$E2_UID', '2025-03-01 03:00:00+00');  -- X3 01/03 00:00:00 BRT

INSERT INTO public.route_visits(customer_user_id, visited_by, visit_date) VALUES
  ('$(c2 4)', '$E2_UID', '2025-02-28'),              -- W1
  ('$(c2 5)', '$E2_UID', '2025-03-01');              -- W2

INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi, created_at) VALUES
  ('$(c2 6)',  'faturado',        1, NULL,         '2025-03-01 01:30:00+00'),  -- Y1
  ('$(c2 7)',  'faturado',       10, NULL,         '2025-03-01 02:59:59+00'),  -- Y2
  ('$(c2 8)',  'faturado',      100, NULL,         '2025-03-01 03:00:00+00'),  -- Y3
  ('$(c2 9)',  'faturado',     1000, '2025-02-28', '2025-03-15 12:00:00+00'),  -- Z1
  ('$(c2 9)',  'faturado',    10000, '2025-02-20', '2025-02-20 12:00:00+00'),  -- Z1b
  ('$(c2 10)', 'faturado',   100000, '2025-03-01', '2025-03-01 00:00:00+00'),  -- Z2
  ('$(c2 11)', 'faturado',  1000000, NULL,         '2025-03-01 02:00:00+00'),  -- R, 28/02 23:00 BRT
  ('$(c2 11)', 'faturado', 10000000, '2025-03-05', '2025-03-05 12:00:00+00');  -- R, em março

INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, revenue_potential, churn_risk, priority_score)
SELECT ('e2c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E2_UID', 1000, 0, 10
FROM generate_series(6, 11) i;
INSERT INTO public.profiles(user_id, name) VALUES
  ('$(c2 6)', 'Y1'), ('$(c2 7)', 'Y2'), ('$(c2 8)', 'Y3'),
  ('$(c2 9)', 'Z1'), ('$(c2 10)', 'Z2'), ('$(c2 11)', 'R');
SQL

# Uma conexão por sessão. B0 é o controle POSITIVO da sessão: o TimeZone é o que foi setado E o
# cast ingênuo de uma data vira 00:00Z na sessão UTC e 03:00Z na de SP — prova que as duas rodadas
# são mundos diferentes (senão a rodada "SP" poderia ser UTC calada e as duas concordariam).
bloco_b() {   # <U|S> <TimeZone> <hh:mm esperado no cast ingênuo>
  local pfx="B$1" tz="$2" hhmm="$3" out l0 lf lm campos
  campos="r->>'mes', r->>'contatados_mtd', r->>'positivados', r->>'receita_mtd', r->>'novos_clientes_positivados',
          (SELECT string_agg(e->>'nome', ',' ORDER BY e->>'nome') FROM jsonb_array_elements(r->'a_positivar') e),
          (r->>'total_eligible') || '/' || (r->>'compradores_mtd')"
  out="$(P -q -tA -F '|' 2>&1 <<SQL || true
SET TimeZone = '$tz';
SELECT 'B0', current_setting('TimeZone'), to_char(('2025-03-01'::date)::timestamptz AT TIME ZONE 'UTC', 'HH24:MI');
SET test.agora = '2025-03-01 02:59:59+00';
SELECT 'FEV', $campos FROM (SELECT public._carteira_positivacao_for_owner('$E2_UID'::uuid) AS r) s;
SET test.agora = '2025-03-01 03:00:00+00';
SELECT 'MAR', $campos FROM (SELECT public._carteira_positivacao_for_owner('$E2_UID'::uuid) AS r) s;
SQL
)"
  l0="$(printf '%s\n' "$out" | grep '^B0|' || true)"
  lf="$(printf '%s\n' "$out" | grep '^FEV|' || true)"
  lm="$(printf '%s\n' "$out" | grep '^MAR|' || true)"
  campo() { [ -n "$1" ] && printf '%s' "$1" | cut -d'|' -f"$2"; }
  echo "── bloco B sob sessão $tz ──"
  [ -n "$lf" ] && [ -n "$lm" ] || echo "     (saída da sessão $tz: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300))"
  eq "${pfx}0"  "sessão $tz: TimeZone e cast ingênuo de 01/03"  "$(campo "$l0" 2-3)" "$tz|$hhmm"
  eq "${pfx}1"  "t_fev (28/02 23:59:59 BRT): mes"                "$(campo "$lf" 2)" "2025-02-01"
  eq "${pfx}2"  "t_fev: contatados = X1 (2x), X2 + W1"          "$(campo "$lf" 3)" "3"
  eq "${pfx}3"  "t_fev: positivados = Y1, Y2, Z1 (2 pedidos), R" "$(campo "$lf" 4)" "4"
  eq "${pfx}4"  "t_fev: receita = 1+10+1000+10000+1000000"      "$(campo "$lf" 5)" "1011011"
  eq "${pfx}5"  "t_fev: novos = os 4 (1ª compra em fevereiro)"   "$(campo "$lf" 6)" "4"
  eq "${pfx}6"  "t_fev: a_positivar = quem tem score e não comprou" "$(campo "$lf" 7)" "Y3,Z2"
  eq "${pfx}7"  "t_fev: total_eligible/compradores"              "$(campo "$lf" 8)" "11/4"
  eq "${pfx}8"  "t_mar (01/03 00:00:00 BRT): mes"                "$(campo "$lm" 2)" "2025-03-01"
  eq "${pfx}9"  "t_mar: contatados = X3 + W2"                    "$(campo "$lm" 3)" "2"
  eq "${pfx}10" "t_mar: positivados = Y3, Z2, R"                 "$(campo "$lm" 4)" "3"
  eq "${pfx}11" "t_mar: receita = 100+100000+10000000"           "$(campo "$lm" 5)" "10100100"
  eq "${pfx}12" "t_mar: novos = Y3, Z2 (R comprou em fevereiro)" "$(campo "$lm" 6)" "2"
  eq "${pfx}13" "t_mar: a_positivar"                             "$(campo "$lm" 7)" "Y1,Y2,Z1"
  eq "${pfx}14" "t_mar: total_eligible/compradores"              "$(campo "$lm" 8)" "11/3"
}
bloco_b U UTC "00:00"
bloco_b S America/Sao_Paulo "03:00"

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE — a função com o proconfig RESTAURADO (o da prod: sem o relógio controlado), chamada
# pelos DOIS wrappers como `authenticated`, cada um com a identidade que o gate exige. Prova que
# a função como a prod a vê executa (late-bound) e fixa o mês de SP a partir do relógio de verdade.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "ALTER FUNCTION public._carteira_positivacao_for_owner(uuid) SET search_path = public;"
echo "── smoke dos wrappers, proconfig restaurado ──"
MES_REAL="to_char(date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD')"
V=$(Pq -c "SET test.uid='$E2_UID'; SET ROLE authenticated; SELECT (public.get_minha_positivacao()->>'mes') = $MES_REAL;" 2>&1 | tail -1 || true)
eq W1 "get_minha_positivacao() como employee: mes = mês de SP do relógio real" "$V" "t"
V=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT public.get_minha_positivacao_for('$E2_UID'::uuid)->>'total_eligible';" 2>&1 | tail -1 || true)
eq W2 "get_minha_positivacao_for(E2) como master: carteira de E2" "$V" "11"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
