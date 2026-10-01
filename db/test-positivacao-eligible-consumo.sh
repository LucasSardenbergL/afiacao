#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — positivação ao vivo (`_carteira_positivacao_for_owner`)           ║
# ║                                                                                ║
# ║  Bloco C — a elegibilidade é reaplicada no CONSUMO (comissão/positivação).     ║
# ║    FU3 do #1398: sem este teste, um refactor que solte um JOIN eleg reabre o   ║
# ║    vazamento em silêncio, e o efeito é comissão contando cliente mascarado.    ║
# ║  Bloco B — o mês é o de SÃO PAULO (relógio e ligação), seja qual for o fuso da ║
# ║    SESSÃO. A prod roda sessão UTC; até a 20260927133606 o que acontecia das    ║
# ║    21:00 às 23:59 BRT do último dia contava no mês seguinte. O bloco CRUZA a   ║
# ║    borda em pares de 1 s e roda sob `TimeZone=UTC` E `America/Sao_Paulo`.      ║
# ║  Bloco U — o UNIVERSO de pedidos é o canônico (4 status + não apagado) e a     ║
# ║    data é só order_date_kpi, como no mês congelado (20260927195430). Cada      ║
# ║    predicado tem um seed que SÓ ele exclui, com kpi no mês — sem kpi o pedido  ║
# ║    sairia de qualquer jeito e o assert passaria por vacuidade.                 ║
# ║  Bloco M — a migration sob o executor (transação única, como o db:aplicar): a  ║
# ║    PRE recusa corpo estranho e função ausente sem tocar em nada, a POS         ║
# ║    reprovada desfaz tudo (retrato corpo|config|ACL), a re-aplicação passa, e a ║
# ║    PRE TRAVA a linha da função (duas conexões, barreira observada).            ║
# ║                                                                                ║
# ║  ⏰ Relógio: tudo roda num relógio CONTROLADO (`test.agora`). `public.now()` é  ║
# ║  um TRIPWIRE (SQLSTATE Z9T01): sem `test.agora` ele levanta exceção em vez de  ║
# ║  cair no relógio de parede.                                                    ║
# ║  Diários: docs/historico/positivacao-mes-sp-sob-sessao-utc.md                  ║
# ║           docs/historico/positivacao-universo-canonico.md                      ║
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
MIG_FUSO="$REPO_ROOT/supabase/migrations/20260927133606_positivacao_mes_sp_sessao_utc.sql"
MIG_UNIVERSO="$REPO_ROOT/supabase/migrations/20260927195430_positivacao_universo_canonico.sql"
# md5 EXATO do prosrc — a identidade que a PRE/POS da 20260927195430 usam
MD5_FUSO=8abdeac4db77dbdce16bfbd8fca4dbde       # o corpo de MIG_FUSO (= prod em 2026-09-27, medido)
MD5_UNIVERSO=f1a2bd9e48c7b2c22ff805a50ab524b2   # o corpo de MIG_UNIVERSO
# Denominador: quantos asserts a suíte EXECUTA (R0-R1 · C1-C10 · M1-M5 (8) · B0-B14 ×2 sessões ·
# U0-U5 · W1-W2). Asserts a menos — um bloco que não rodou — é vermelho: `FAIL=0` com PASS
# encolhido é a prova truncada que aprova tudo. As duas sabotagens de corpo ANTIGO pulam o bloco M.
TOTAL_ESPERADO=58
M_ASSERTS=8

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
# IDs do bloco U: U0 mes · U1 positivados · U2 receita · U3 novos · U4 a_positivar · U5 elig/compr
# Os vermelhos de B e U foram conferidos por um oráculo independente em Python (diário).
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="corpo_pre_fix:BU2,BU9,BU11,BS4,BS11,U1,U2,U3:BS2,BS9,BU1,BS1,C1
              corpo_2606:BU3,BU4,BU10,BU11,BS3,BS4,BS10,BS11,U1,U2,U3,U4,U5:BU1,BU2,BU8,BU9,BS2,BS9,BU12,BS12,C1
              a_positivar_id_errado:BU6,BS6,BU13,BS13,U4:BU3,BS3,BU10,BS10,U1,U2
              contato_cast_na_sessao:BU2,BU9:BS2,BS9,BU4,BU11,U2
              mes_em_utc:BU1,BS1,BU4,BS4:BU8,BS8,BU11,BS11,R0,U0
              fim_fechado:BU2,BS2:BU9,BS9
              inicio_aberto:BU9,BS9:BU2,BS2
              primeira_por_max:BU5,BS5,BU12,BS12,U3:BU3,BS3,BU10,BS10,U1,U2
              primeira_so_no_mes:BU12,BS12,U3:BU5,BS5,BU10,BS10,U1,U2
              data_por_created_at:BU4,BS4,BU11,BS11,U2:BU2,BS2,BU9,BS9
              fallback_de_volta:BU3,BU4,BU10,BU11,BS3,BS4,BS10,BS11,U1,U2,U3,U4:BU2,BS2,BU9,BS9,BU12,BS12
              literal_antiga_3_status:U1,U2,U3,U4,U5:BU4,BS4,BU11,C3
              sem_deleted_at:U1,U2,U3,U4,U5:BU4,BS11,C3
              sem_cancelado:U1,U2,U3,U4,U5:BU4,C3
              sem_rascunho:U1,U2,U3,U4,U5:BU4,C3
              sem_pendente:U1,U2,U3,U4,U5:BU4,C3
              allowlist_faturado:U1,U2,U3,U4,U5:BU4,BS4,C3
              relogio_desligado:R0,U0
              hora_de_parede:R0,U0
              sem_pin:R0!TRIPWIRE:U0,BU1
              eligible_removido:C1,C3:BU3,U1
              gate_master_removido:C9
              pre_sem_trava:M4:M4c,M1,M2a,M3a,M5
              pre_aceita_qualquer:M2a,M2b:M1,M3a,M4,M5
              pre_ausente_segue:M5:M1,M2a,M3a,M4
              pos_sem_wrappers:M3a,M3b:M1,M2a,M4,M5"
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
    # Os recortes de diagnóstico abaixo levam `|| true` DENTRO das chaves: sob `pipefail`, um
    # `grep` sem linha para casar (ou morto por SIGPIPE do `head`) derrubaria o laço inteiro pelo
    # `set -e`, e as sabotagens seguintes nem rodariam — foi assim que a 1ª rodada da matriz de
    # 2026-09-27 perdeu o `pos_sem_wrappers` e o recibo.
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      { grep -E 'FALHOU|ERRO|ERROR|APLICAVEL' "$log" || true; } | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    # A rodada tem de TERMINAR, com o denominador inteiro: um vermelho declarado seguido de um erro
    # que mata o script (set -e) deixaria o resto sem rodar, e o vermelho sozinho não prova que o
    # restante seguia verde (achado do Codex, adversarial 2026-09-27). As duas sabotagens de corpo
    # antigo pulam o bloco M por desenho.
    esperado_n=$TOTAL_ESPERADO
    case "$sab" in corpo_pre_fix|corpo_2606) esperado_n=$((TOTAL_ESPERADO - M_ASSERTS)) ;; esac
    recibo="$(grep -E '^RESULTADO: [0-9]+ ok / [0-9]+ fail$' "$log" | tail -1 || true)"
    if [ -z "$recibo" ]; then
      echo "  ❌ $sab — a rodada NÃO terminou (sem RESULTADO): vermelho de rodada truncada não é dente"
      { grep -E 'ERROR|ERRO|FATAL|❌' "$log" || true; } | tail -2 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    n_ok="${recibo#RESULTADO: }"; n_ok="${n_ok%% *}"
    n_fail="${recibo##*/ }"; n_fail="${n_fail%% *}"
    if [ $((n_ok + n_fail)) -ne "$esperado_n" ]; then
      echo "  ❌ $sab — a rodada executou $((n_ok + n_fail)) asserts, esperado $esperado_n"
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
                                 { grep 'ERRO_DE_EXECUCAO' "$log" || true; } | head -2 | sed 's/^/       /'; }
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
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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
curto() { printf '%s' "$1" | tr '\n' ' ' | head -c 200; }
campo() { [ -n "$1" ] && printf '%s' "$1" | cut -d'|' -f"$2"; }

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
-- tipos conferidos na prod via psql-ro (2026-09-27): created_at/started_at/deleted_at
-- timestamptz, order_date_kpi/visit_date date. São os tipos que decidem se há fuso na comparação.
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, status text, total numeric,
  order_date_kpi date, created_at timestamptz DEFAULT now(), deleted_at timestamptz
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
# ZONA 2 — AS MIGRATIONS REAIS (Lei #1), na cadeia da prod: origem → fuso → universo. A de fuso e
#   a de universo rodam em TRANSAÇÃO ÚNICA (-1), como o `db:aplicar`: é o que faz a POS reprovada
#   desfazer o CREATE. Aplicar aqui é também o ensaio das PRE e POS.
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG_ORIGEM" >/dev/null
echo "migration aplicada: $(basename "$MIG_ORIGEM")"
if [ "$SABOTAGEM" != corpo_pre_fix ]; then
  P -1 -q -f "$MIG_FUSO" >/dev/null
  echo "migration aplicada: $(basename "$MIG_FUSO") (PRE e POS passaram)"
fi

# Recria <função> a partir do bloco CREATE dela em <migration>, com trocas exatas: cada padrão tem
# de ocorrer exatamente n× no corpo — uma troca que não pegou deixaria a suíte verde. O repo nunca
# é tocado. Devolve ≠0 em vez de seguir: o chamador decide se isso é INFRA ou sabotagem inaplicável.
recriar_de() {   # <migration> <função> [<de> <para> <n> ...]
  local mig="$1" fn="$2" tmp
  shift 2
  tmp="$(mktemp "$TMPD/fn.XXXXXX")"
  python3 - "$mig" "$fn" "$tmp" "$@" <<'PYSAB' || return 9
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
  P -q -f "$tmp" >/dev/null || return 9
  rm -f "$tmp"
}
sabotar() {   # <migration> <função> <de> <para> <n> [...] — sabotagem no BANCO, depois do apply
  recriar_de "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
# Sabotagem na MIGRATION (PRE/POS): o apply usa uma CÓPIA com o trecho trocado, em tmpdir.
MIG_UNIVERSO_EFETIVA="$MIG_UNIVERSO"
sabotar_migration() {   # <de> <para> <n>
  local copia="$TMPD/mig_universo_sabotada.sql"
  python3 - "$MIG_UNIVERSO" "$copia" "$1" "$2" "$3" <<'PYMIG' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
src, out, de, para, n = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
s = open(src, encoding="utf-8").read()
if s.count(de) != n:
    print("   padrão ocorre %dx, esperado %d: %r" % (s.count(de), n, de), file=sys.stderr); sys.exit(1)
open(out, "w", encoding="utf-8").write(s.replace(de, para))
PYMIG
  MIG_UNIVERSO_EFETIVA="$copia"
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
case "$SABOTAGEM" in
  # a PRE volta a só LER o corpo: outro aplicador pode commitar entre a leitura e o CREATE
  pre_sem_trava) sabotar_migration "  ALTER FUNCTION public._carteira_positivacao_for_owner(uuid) SET search_path = public;" "  NULL;" 1 ;;
  # a PRE aceita qualquer corpo vivo (a lista passa a conter o próprio md5 lido)
  pre_aceita_qualquer) sabotar_migration "v_md5 NOT IN ('8abdeac4db77dbdce16bfbd8fca4dbde'" "v_md5 NOT IN (v_md5, '8abdeac4db77dbdce16bfbd8fca4dbde'" 1 ;;
  # o idioma da 20260927133606: função ausente → a PRE sai sem travar nem conferir, e o CREATE a cria
  pre_ausente_segue) sabotar_migration "    RAISE EXCEPTION 'PRE FALHOU: _carteira_positivacao_for_owner(uuid) ausente" "    RETURN; RAISE EXCEPTION 'PRE FALHOU: _carteira_positivacao_for_owner(uuid) ausente" 1 ;;
  # a POS deixa de exigir o EXECUTE dos wrappers
  pos_sem_wrappers) sabotar_migration "       OR NOT pg_catalog.has_function_privilege('authenticated', to_regprocedure(v_wrapper), 'EXECUTE') THEN" "       OR false THEN" 1 ;;
esac

cfg_vivo() { Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public._carteira_positivacao_for_owner(uuid)');" 2>&1 || true; }
# O retrato INTEGRAL da função — corpo exato | proconfig | ACL —, ou "ausente". "Preservou" e
# "desfez" se provam com ele inteiro: só o corpo deixaria passar um toque ou um REVOKE que vazou.
retrato() { Pq -c "SELECT COALESCE((SELECT md5(p.prosrc) || '|' || COALESCE(array_to_string(p.proconfig, ';'), '') || '|' || COALESCE(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public._carteira_positivacao_for_owner(uuid)')), 'ausente');" 2>&1 || true; }
aplicar_universo() { P -1 -q -f "$MIG_UNIVERSO_EFETIVA" 2>&1; }
# De volta ao predecessor exatamente como a de fuso o deixa: corpo e proconfig do arquivo, ACL fechado.
restaurar_predecessor() {
  recriar_de "$MIG_FUSO" _carteira_positivacao_for_owner || { echo "INFRA: predecessor não restaurado"; exit 1; }
  P -q -c "REVOKE ALL ON FUNCTION public._carteira_positivacao_for_owner(uuid) FROM PUBLIC, anon, authenticated;"
  [ "$(retrato)" = "$retrato_pred" ] || { echo "INFRA: predecessor restaurado como [$(retrato)], esperado [$retrato_pred]"; exit 1; }
}

if [ "$SABOTAGEM" = corpo_pre_fix ] || [ "$SABOTAGEM" = corpo_2606 ]; then
  echo "bloco M e 20260927195430 PULADOS: a sabotagem é o corpo ANTIGO (a migration nova não entra)"
else
  # ════════════════════════════════════════════════════════════════════════════
  # BLOCO M — a migration sob o executor. Estado de partida: o PREDECESSOR (o corpo da de fuso).
  # ════════════════════════════════════════════════════════════════════════════
  echo "── M: a migration em transação única, como o db:aplicar ──"
  retrato_pred="$(retrato)"
  case "$retrato_pred" in
    "$MD5_FUSO|search_path=public|"*) ;;
    *) echo "INFRA: o estado de partida não é o predecessor [$retrato_pred]"; exit 1 ;;
  esac
  acl_pred="${retrato_pred##*|}"

  # M3 — a POS reprovada desfaz TUDO: o CREATE, o toque da PRE e o REVOKE. O EXECUTE do wrapper
  # sai das DUAS pontas (PUBLIC tem o default de fábrica): tirar só de authenticated deixaria a
  # POS7 verde por vacuidade.
  P -q -c "REVOKE EXECUTE ON FUNCTION public.get_minha_positivacao() FROM PUBLIC, authenticated;"
  saida="$(aplicar_universo || true)"
  case "$saida" in
    *"POS7 FALHOU"*)  ok M3a "wrapper sem EXECUTE: a POS reprova (POS7)" ;;
    *ERROR:*|*ERRO:*) erro_exec M3a "falhou por outro motivo: [$(curto "$saida")]" ;;
    *)                bad M3a "a migration PASSOU com o wrapper sem EXECUTE" ;;
  esac
  eq M3b "POS reprovada desfaz tudo (retrato corpo|config|ACL = o de antes)" "$(retrato)" "$retrato_pred"
  P -q -c "GRANT EXECUTE ON FUNCTION public.get_minha_positivacao() TO PUBLIC, authenticated;"

  # M2 — corpo ESTRANHO, como outra mudança que chegou antes. Corpo, proconfig E ACL diferentes do
  # que esta migration deixaria — config e ACL distintos de propósito: iguais aos do toque e do
  # REVOKE, um vazamento deles passaria por vacuidade (achado do Codex, adversarial 2026-09-27).
  recriar_de "$MIG_FUSO" _carteira_positivacao_for_owner "LIMIT 200" "LIMIT 199" 1 \
      "SET search_path = public" "SET search_path = public, pg_temp" 1 \
    || { echo "INFRA: corpo estranho não montado"; exit 1; }
  P -q -c "GRANT EXECUTE ON FUNCTION public._carteira_positivacao_for_owner(uuid) TO anon;"
  retrato_estranho="$(retrato)"
  case "$retrato_estranho" in
    "$MD5_FUSO|"*|"$MD5_UNIVERSO|"*|*"|search_path=public|"*|ausente|"") echo "INFRA: corpo estranho não é estranho [$retrato_estranho]"; exit 1 ;;
  esac
  saida="$(aplicar_universo || true)"
  case "$saida" in
    *"PRE FALHOU: o corpo vivo"*) ok M2a "corpo estranho: a PRE recusa" ;;
    *ERROR:*|*ERRO:*)             erro_exec M2a "falhou por outro motivo: [$(curto "$saida")]" ;;
    *)                            bad M2a "a migration PASSOU por cima de um corpo estranho" ;;
  esac
  eq M2b "corpo estranho preservado inteiro (retrato corpo|config|ACL)" "$(retrato)" "$retrato_estranho"
  restaurar_predecessor

  # M5 — função AUSENTE: a PRE aborta e nada nasce. Seguir sem a função, como fazia a PRE da
  # 20260927133606, pula a trava e reabre a janela (achado do Codex, adversarial 2026-09-27).
  P -q -c "DROP FUNCTION public._carteira_positivacao_for_owner(uuid);"
  saida="$(aplicar_universo || true)"
  case "$saida" in
    *"_carteira_positivacao_for_owner(uuid) ausente"*) v5="PRE_RECUSOU" ;;
    *ERROR:*|*ERRO:*)                                  v5="ERRO: $(curto "$saida")" ;;
    *)                                                 v5="APLICOU" ;;
  esac
  eq M5 "função ausente: a PRE aborta e nada é criado (veredito|retrato depois)" "$v5|$(retrato)" "PRE_RECUSOU|ausente"
  restaurar_predecessor

  # O apply de verdade, sobre o predecessor.
  saida="$(aplicar_universo)" || { printf '%s\n' "$saida"; echo "❌ a 20260927195430 NÃO aplicou sobre o predecessor"; exit 1; }
  echo "migration aplicada: $(basename "$MIG_UNIVERSO") (PRE e POS passaram)"

  # M1 — re-aplicar é seguro: a PRE aceita o próprio corpo e o retrato não muda.
  if saida="$(aplicar_universo)"; then v="$(retrato)"; else v="ERRO: $saida"; fi
  eq M1 "re-aplicação: a PRE aceita o próprio corpo e nada muda" "$v" "$MD5_UNIVERSO|search_path=public|$acl_pred"

  # M4 — a PRE TRAVA a linha da função antes de ler o corpo. Duas conexões, ordem OBSERVADA:
  #   C segura uma TRAVA DE LIBERAÇÃO (advisory de sessão) que só o orquestrador solta;
  #   A roda a PRE do arquivo numa transação aberta, sinaliza com um advisory de TRANSAÇÃO (some
  #     quando a transação acaba) e fica preso na trava de C — não sai sozinho, nem por timeout;
  #   B só é lançado quando vê o sinal de A, e tenta recriar a função com lock_timeout:
  #     `lock_not_available` é a prova de que ESPEROU (um CREATE livre termina em microssegundos,
  #     então 500 ms separa os dois casos com folga e não pesa nas rodadas do --falsificar).
  # Depois de B, o sinal de A ainda concedido prova que A seguia na transação durante a tentativa:
  # sem isso, "não bloqueou" poderia ser A que já tinha saído (achado do Codex, adversarial
  # 2026-09-27). Controle (M4c): recriar OUTRA função no mesmo instante não espera. B roda dentro
  # de BEGIN…ROLLBACK: se passar, não fica.
  pre_sql="$(awk '/^DO \$pre\$$/,/^\$pre\$;$/' "$MIG_UNIVERSO_EFETIVA")"
  case "$pre_sql" in
    *"PRE FALHOU"*)
      P -q -c "CREATE FUNCTION public.m4_controle(uuid) RETURNS int LANGUAGE sql AS 'SELECT 1';"
      esperar_advisory() {   # <objid> → 0 quando concedido; 1 se não aparecer em ~10 s
        local _i
        for _i in $(seq 1 100); do
          [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND granted;")" = 1 ] && return 0
          sleep 0.1
        done
        return 1
      }
      ( P -q -c "SELECT pg_advisory_lock(424243); SELECT pg_sleep(600);" ) > "$TMPD/m4-c.log" 2>&1 &
      m4_c=$!
      m4_a=""
      barreira=0
      if esperar_advisory 424243; then
        ( P -q <<SQL
BEGIN;
$pre_sql
SELECT pg_advisory_xact_lock(424242);
SELECT pg_advisory_xact_lock(424243);
ROLLBACK;
SQL
        ) > "$TMPD/m4-a.log" 2>&1 &
        m4_a=$!
        esperar_advisory 424242 && barreira=1
      fi
      tentar() {   # <CREATE concorrente> → M4_RESULTADO=BLOQUEADO | NAO_BLOQUEOU | erro
        P -tA 2>&1 <<SQL || true
BEGIN;
SET LOCAL lock_timeout = '500ms';
DO \$m4\$ BEGIN
  BEGIN
    EXECUTE \$cria\$ $1 \$cria\$;
    RAISE NOTICE 'M4_RESULTADO=NAO_BLOQUEOU';
  EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'M4_RESULTADO=BLOQUEADO';
  END;
END \$m4\$;
ROLLBACK;
SQL
      }
      if [ "$barreira" = 1 ]; then
        r4="$(tentar "CREATE OR REPLACE FUNCTION public._carteira_positivacao_for_owner(p_owner uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$f\$ BEGIN RETURN NULL; END \$f\$")"
        r4c="$(tentar "CREATE OR REPLACE FUNCTION public.m4_controle(uuid) RETURNS int LANGUAGE sql AS 'SELECT 2'")"
        if [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242 AND granted;")" != 1 ]; then
          r4="A SAIU DA TRANSACAO ANTES DO FIM DE B: $r4"; r4c="$r4"
        fi
      else
        r4="BARREIRA NAO OBSERVADA: $(head -c 200 "$TMPD/m4-a.log" 2>/dev/null) $(head -c 200 "$TMPD/m4-c.log")"; r4c="$r4"
      fi
      Pq -c "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid IN (424242, 424243) AND granted;" >/dev/null 2>&1 || true
      wait "$m4_c" 2>/dev/null || true
      if [ -n "$m4_a" ]; then wait "$m4_a" 2>/dev/null || true; fi
      P -q -c "DROP FUNCTION public.m4_controle(uuid);"
      case "$r4" in
        *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M4 "sem corrida válida: [$(curto "$r4")]" ;;
        *M4_RESULTADO=BLOQUEADO*)    ok M4 "a PRE trava a linha: um CREATE OR REPLACE concorrente espera" ;;
        *M4_RESULTADO=NAO_BLOQUEOU*) bad M4 "a PRE NÃO trava: outro aplicador recriou a função durante a PRE" ;;
        *)                           erro_exec M4 "sem veredito: [$(curto "$r4")]" ;;
      esac
      case "$r4c" in
        *"A SAIU DA TRANSACAO"*|*"BARREIRA NAO OBSERVADA"*) erro_exec M4c "sem corrida válida: [$(curto "$r4c")]" ;;
        *M4_RESULTADO=NAO_BLOQUEOU*) ok M4c "controle: recriar OUTRA função durante a PRE não espera" ;;
        *M4_RESULTADO=BLOQUEADO*)    bad M4c "a PRE trava mais que a linha da própria função" ;;
        *)                           erro_exec M4c "sem veredito: [$(curto "$r4c")]" ;;
      esac ;;
    *) erro_exec M4 "PRE não extraída de $(basename "$MIG_UNIVERSO_EFETIVA")"
       erro_exec M4c "PRE não extraída" ;;
  esac
fi

# ── SABOTAGEM DE CORPO (só no modo --falsificar) — no BANCO, recriando a função com o trecho
# trocado a partir da migration vigente; o repo nunca é tocado.
F=_carteira_positivacao_for_owner
LIG_INI="(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= mes_inicio"
LIG_FIM="(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date < mes_fim"
MES_SP="(now() AT TIME ZONE 'America/Sao_Paulo')"
KPI_D="so.order_date_kpi AS d"
UNIVERSO_4="so.status NOT IN ('cancelado','rascunho','pendente','orcamento')"
case "$SABOTAGEM" in
  # as de migration já agiram acima (a cópia sabotada foi o que o bloco M aplicou)
  ""|pre_sem_trava|pre_aceita_qualquer|pre_ausente_segue|pos_sem_wrappers) ;;
  # o corpo de 20260525210000 (nenhuma das duas correções) / o de 20260927133606 (= prod antes desta)
  corpo_pre_fix|corpo_2606) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  # a ligação volta a ser comparada pelo cast implícito da sessão
  contato_cast_na_sessao) sabotar "$MIG_UNIVERSO" "$F" "$LIG_INI" "fc.started_at >= mes_inicio" 1 \
                                                       "$LIG_FIM" "fc.started_at < mes_fim" 1 ;;
  # o mês calculado em UTC: às 02:59:59Z de 01/03 (23:59:59 BRT de 28/02) já seria março
  mes_em_utc) sabotar "$MIG_UNIVERSO" "$F" "$MES_SP" "(now() AT TIME ZONE 'UTC')" 2 ;;
  # borda do fim fechada: a ligação de 01/03 00:00 BRT entraria em fevereiro
  fim_fechado) sabotar "$MIG_UNIVERSO" "$F" "$LIG_FIM" "(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date <= mes_fim" 1 ;;
  # borda do início aberta: a ligação de 01/03 00:00 BRT sairia de março
  inicio_aberto) sabotar "$MIG_UNIVERSO" "$F" "$LIG_INI" "(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date > mes_inicio" 1 ;;
  # "novo cliente" pela ÚLTIMA compra: Q (fev e mar) viraria novo em março e deixaria de sê-lo em fev
  primeira_por_max) sabotar "$MIG_UNIVERSO" "$F" "min(pv.d) AS primeira" "max(pv.d) AS primeira" 1 ;;
  # "primeira compra" só dentro do mês: quem já comprava antes vira novo; receita/positivados intactos
  primeira_so_no_mes) sabotar "$MIG_UNIVERSO" "$F" "min(pv.d) AS primeira" "min(pv.d) FILTER (WHERE pv.d >= mes_inicio AND pv.d < mes_fim) AS primeira" 1 ;;
  # a data do pedido pela CRIAÇÃO, não pelo kpi: Z1 (kpi fev, criado mar) e Z2 trocam de mês
  data_por_created_at) sabotar "$MIG_UNIVERSO" "$F" "$KPI_D" "(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS d" 1 ;;
  # o fallback de created_at de volta (a regra de 20260927133606)
  fallback_de_volta) sabotar "$MIG_UNIVERSO" "$F" "$KPI_D" "COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS d" 1 ;;
  # a literal ANTIGA de 3 status (sem 'orcamento')
  literal_antiga_3_status) sabotar "$MIG_UNIVERSO" "$F" "$UNIVERSO_4" "so.status NOT IN ('cancelado','rascunho','pendente')" 1 ;;
  # a outra metade do contrato some
  sem_deleted_at) sabotar "$MIG_UNIVERSO" "$F" "      AND so.deleted_at IS NULL" "" 1 ;;
  # cada status da denylist tem seed próprio
  sem_cancelado) sabotar "$MIG_UNIVERSO" "$F" "$UNIVERSO_4" "so.status NOT IN ('rascunho','pendente','orcamento')" 1 ;;
  sem_rascunho)  sabotar "$MIG_UNIVERSO" "$F" "$UNIVERSO_4" "so.status NOT IN ('cancelado','pendente','orcamento')" 1 ;;
  sem_pendente)  sabotar "$MIG_UNIVERSO" "$F" "$UNIVERSO_4" "so.status NOT IN ('cancelado','rascunho','orcamento')" 1 ;;
  # a allowlist que escondia 10.281 pedidos reais (universo-pedidos.ts)
  allowlist_faturado) sabotar "$MIG_UNIVERSO" "$F" "$UNIVERSO_4" "so.status IN ('faturado')" 1 ;;
  # o mês tirado do relógio de parede, que o controlado não intercepta
  hora_de_parede) sabotar "$MIG_UNIVERSO" "$F" "$MES_SP" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')" 2 ;;
  # não sabotam função: pulam o ALTER do search_path / o pin do relógio, logo abaixo
  relogio_desligado|sem_pin) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  # o refactor distraído que este teste existe para pegar: a CTE eleg sem o filtro
  eligible_removido) sabotar "$MIG_UNIVERSO" "$F" " AND ca.eligible = true" "" 1 ;;
  # a lista nominal com o UUID do VENDEDOR no lugar do cliente: nomes e contagens seguem certos,
  # e o link do card levaria ao cliente errado (achado do Codex, adversarial 2026-09-27)
  a_positivar_id_errado) sabotar "$MIG_UNIVERSO" "$F" "SELECT s.customer_user_id," "SELECT uid AS customer_user_id," 1 ;;
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
eq R1 "proconfig da função sob teste, antes do relógio" "$(cfg_vivo)" "search_path=public"
if [ "$SABOTAGEM" != relogio_desligado ]; then
  P -q -c "ALTER FUNCTION public._carteira_positivacao_for_owner(uuid) SET search_path = public, pg_catalog, pg_temp;"
fi
# O pin do bloco C: TODA conexão nova nasce em 14/02/2025 15:00Z (meio do mês nos dois fusos) —
# cada P/Pq abre outra conexão, e é o banco que carrega o relógio para todas. Os blocos B e U
# trocam o instante na própria sessão.
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
  ('55555555-5555-5555-5555-555555555555'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','employee'),
  ('55555555-5555-5555-5555-555555555555','employee');

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
  *)                 erro_exec C9 "sem veredito do gate: $(curto "$R")" ;;
esac

# mixgap: função IRMÃ na mesma migration, com a MESMA CTE `eleg` filtrando eligible.
# Aqui só se prova que EXECUTA (plpgsql é late-bound: um SQL inválido passaria no CREATE
# e só quebraria em runtime). Provar a máscara nela exigiria semear association_rules —
# não coberto; a invariante dela está verificada por leitura, não por assert.
V=$(Pq -c "SELECT (public._carteira_mixgap_for_owner('$E_UID'::uuid)->>'total_com_gap');" 2>&1 || true)
eq C10 "mixgap EXECUTA (late-bound coberto)"       "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO B — A BORDA DO MÊS DE SP, cruzada de propósito. Outro dono (E2), 12 clientes elegíveis.
#   Borda: 01/03/2025 00:00:00 BRT = 01/03/2025 03:00:00Z. Pedidos em 'faturado' e não apagados:
#   o universo tem bloco próprio (U), e aqui só a DATA varia.
#   ligações (timestamptz): X1 28/02 22:30 e 22:45 BRT (repetida: conta 1) · X2 28/02 23:59:59
#     BRT · X3 01/03 00:00:00 BRT
#   visitas (date, sem fuso — controle do eixo que já era certo): W1 28/02 · W2 01/03
#   pedidos COM kpi e created_at em OUTRO mês de SP (a data é a do kpi, nunca a de criação):
#     Z1 kpi 28/02 criado em 15/03 = 1000 · Z1b kpi 20/02 = 10000 (2º pedido de Z1: conta 1)
#     Z2 kpi 01/03 criado 01/03 00:00Z (= 28/02 21:00 BRT) = 100000
#   Q RECOMPRA com kpi em dois meses: 10/02 = 10^8 e 10/03 = 10^9. Em março é positivado e NÃO é
#     novo (separa `novos` de `positivados`), e é a testemunha de min() × max() (achado do Codex,
#     desenho 2026-09-27: sem ele, `primeira_por_max` sobreviveria).
#   pedidos SEM kpi — desde a 20260927195430 NÃO contam (controles negativos do fallback que
#     saiu): Y1=1 · Y2=10 · Y3=100, nos instantes de X1/X2/X3, e o 1º pedido de R (28/02 23:00 BRT)
#     = 10^6. O 2º de R tem kpi 05/03 = 10^7: sem o fallback, R é novo em MARÇO.
#   scores/profiles para Y1..Y3, Z1, Z2, R, Q — a_positivar é conferida pelo PAR nome=UUID
#     completo: o card linka o cliente pelo UUID, e nome certo com UUID errado levaria ao
#     cliente errado.
#   A receita é soma de potências de 10: o valor diz QUAIS pedidos entraram, não só quantos.
#   Relógio: t_fev = 02:59:59Z (último segundo de fevereiro em SP) · t_mar = 03:00:00Z.
#   Esperado, NAS DUAS SESSÕES (oráculo independente em Python):
#     t_fev → 02-01 · contatados 3 · positivados 2 · receita 100011000 · novos 2 ·
#             a_positivar R,Y1,Y2,Y3,Z2 · 12/2
#     t_mar → 03-01 · contatados 2 · positivados 3 · receita 1010100000 · novos 2 ·
#             a_positivar Y1,Y2,Y3,Z1 · 12/3
#   Com o fallback de volta (o corpo de 20260927133606): t_fev 5 · 101011011 · 5 e
#   t_mar 4 · 1010100100 — Y1, Y2 e o 1º de R voltam a fevereiro, e Y3 a março.
# ══════════════════════════════════════════════════════════════════════════════
E2_UID="44444444-4444-4444-4444-444444444444"
c2() { printf 'e2c00000-0000-0000-0000-0000000000%02d' "$1"; }
P -q <<SQL
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible)
SELECT ('e2c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E2_UID', true
FROM generate_series(1, 12) i;

INSERT INTO public.farmer_calls(customer_user_id, farmer_id, started_at) VALUES
  ('$(c2 1)', '$E2_UID', '2025-03-01 01:30:00+00'),  -- X1 28/02 22:30 BRT
  ('$(c2 1)', '$E2_UID', '2025-03-01 01:45:00+00'),  -- X1 de novo, 22:45 BRT
  ('$(c2 2)', '$E2_UID', '2025-03-01 02:59:59+00'),  -- X2 28/02 23:59:59 BRT
  ('$(c2 3)', '$E2_UID', '2025-03-01 03:00:00+00');  -- X3 01/03 00:00:00 BRT

INSERT INTO public.route_visits(customer_user_id, visited_by, visit_date) VALUES
  ('$(c2 4)', '$E2_UID', '2025-02-28'),              -- W1
  ('$(c2 5)', '$E2_UID', '2025-03-01');              -- W2

INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi, created_at) VALUES
  ('$(c2 6)',  'faturado',          1, NULL,         '2025-03-01 01:30:00+00'),  -- Y1 (sem kpi)
  ('$(c2 7)',  'faturado',         10, NULL,         '2025-03-01 02:59:59+00'),  -- Y2 (sem kpi)
  ('$(c2 8)',  'faturado',        100, NULL,         '2025-03-01 03:00:00+00'),  -- Y3 (sem kpi)
  ('$(c2 9)',  'faturado',       1000, '2025-02-28', '2025-03-15 12:00:00+00'),  -- Z1
  ('$(c2 9)',  'faturado',      10000, '2025-02-20', '2025-02-20 12:00:00+00'),  -- Z1b
  ('$(c2 10)', 'faturado',     100000, '2025-03-01', '2025-03-01 00:00:00+00'),  -- Z2
  ('$(c2 11)', 'faturado',    1000000, NULL,         '2025-03-01 02:00:00+00'),  -- R, 28/02 23:00 BRT (sem kpi)
  ('$(c2 11)', 'faturado',   10000000, '2025-03-05', '2025-03-05 12:00:00+00'),  -- R, em março
  ('$(c2 12)', 'faturado',  100000000, '2025-02-10', '2025-02-10 12:00:00+00'),  -- Q, em fevereiro
  ('$(c2 12)', 'faturado', 1000000000, '2025-03-10', '2025-03-10 12:00:00+00');  -- Q, em março

INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, revenue_potential, churn_risk, priority_score)
SELECT ('e2c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E2_UID', 1000, 0, 10
FROM generate_series(6, 12) i;
INSERT INTO public.profiles(user_id, name) VALUES
  ('$(c2 6)', 'Y1'), ('$(c2 7)', 'Y2'), ('$(c2 8)', 'Y3'),
  ('$(c2 9)', 'Z1'), ('$(c2 10)', 'Z2'), ('$(c2 11)', 'R'), ('$(c2 12)', 'Q');
SQL

# a_positivar como "nome=UUID completo", ordenado por nome (collation C do cluster da prova)
APOS="(SELECT string_agg((e->>'nome') || '=' || (e->>'customer_user_id'), ',' ORDER BY e->>'nome')
         FROM jsonb_array_elements(r->'a_positivar') e)"

# Uma conexão por sessão. B0 é o controle POSITIVO da sessão: o TimeZone é o que foi setado E o
# cast ingênuo de uma data vira 00:00Z na sessão UTC e 03:00Z na de SP — prova que as duas rodadas
# são mundos diferentes (senão a rodada "SP" poderia ser UTC calada e as duas concordariam).
bloco_b() {   # <U|S> <TimeZone> <hh:mm esperado no cast ingênuo>
  local pfx="B$1" tz="$2" hhmm="$3" out l0 lf lm campos
  campos="r->>'mes', r->>'contatados_mtd', r->>'positivados', r->>'receita_mtd', r->>'novos_clientes_positivados',
          $APOS, (r->>'total_eligible') || '/' || (r->>'compradores_mtd')"
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
  echo "── bloco B sob sessão $tz ──"
  [ -n "$lf" ] && [ -n "$lm" ] || echo "     (saída da sessão $tz: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300))"
  eq "${pfx}0"  "sessão $tz: TimeZone e cast ingênuo de 01/03"  "$(campo "$l0" 2-3)" "$tz|$hhmm"
  eq "${pfx}1"  "t_fev (28/02 23:59:59 BRT): mes"                "$(campo "$lf" 2)" "2025-02-01"
  eq "${pfx}2"  "t_fev: contatados = X1 (2x), X2 + W1"          "$(campo "$lf" 3)" "3"
  eq "${pfx}3"  "t_fev: positivados = Z1 (2 pedidos), Q"        "$(campo "$lf" 4)" "2"
  eq "${pfx}4"  "t_fev: receita = 1000+10000+10^8 (sem kpi não entra)" "$(campo "$lf" 5)" "100011000"
  eq "${pfx}5"  "t_fev: novos = Z1, Q (1ª compra em fevereiro)"  "$(campo "$lf" 6)" "2"
  eq "${pfx}6"  "t_fev: a_positivar = nome=UUID de quem tem score e não comprou" "$(campo "$lf" 7)" \
                "R=$(c2 11),Y1=$(c2 6),Y2=$(c2 7),Y3=$(c2 8),Z2=$(c2 10)"
  eq "${pfx}7"  "t_fev: total_eligible/compradores"              "$(campo "$lf" 8)" "12/2"
  eq "${pfx}8"  "t_mar (01/03 00:00:00 BRT): mes"                "$(campo "$lm" 2)" "2025-03-01"
  eq "${pfx}9"  "t_mar: contatados = X3 + W2"                    "$(campo "$lm" 3)" "2"
  eq "${pfx}10" "t_mar: positivados = Z2, R, Q"                  "$(campo "$lm" 4)" "3"
  eq "${pfx}11" "t_mar: receita = 100000+10^7+10^9"              "$(campo "$lm" 5)" "1010100000"
  eq "${pfx}12" "t_mar: novos = Z2, R (Q comprou em fevereiro)"  "$(campo "$lm" 6)" "2"
  eq "${pfx}13" "t_mar: a_positivar (nome=UUID)"                 "$(campo "$lm" 7)" \
                "Y1=$(c2 6),Y2=$(c2 7),Y3=$(c2 8),Z1=$(c2 9)"
  eq "${pfx}14" "t_mar: total_eligible/compradores"              "$(campo "$lm" 8)" "12/3"
}
bloco_b U UTC "00:00"
bloco_b S America/Sao_Paulo "03:00"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO U — o UNIVERSO de pedidos, predicado a predicado. Outro dono (E3), 17 clientes elegíveis,
#   relógio 14/02/2025 15:00Z (meio do mês nos dois fusos), sessão UTC como a prod.
#   ADMISSÃO: V-FAT · V-IMP · V-SEP · V-ENV — um pedido em cada status VÁLIDO medido na prod
#     (1 · 10 · 100 · 1000). Uma allowlist, ou uma denylist larga demais, derruba algum deles.
#   EXCLUSÃO no mês: cada X-* tem UM pedido de fevereiro que SÓ o seu predicado exclui, COM kpi no
#     mês — sem kpi ele sairia de qualquer jeito e o assert passaria por vacuidade: cancelado 10^4
#     · rascunho 10^5 · pendente 10^6 · orcamento 10^7 · apagado 10^8 · e o sem kpi (created_at no
#     mês) 10^9. Cada X-* tem também uma compra VÁLIDA em dez/2024: vazando, vira positivado mas
#     nunca "novo" — o vazamento aparece na receita pela potência, sem o "novos" compensar.
#   EXCLUSÃO no histórico: cada N-* tem um pedido fora do universo em jan/2025 e uma compra válida
#     em fevereiro (2): o pedido excluído não pode roubar dele o "novo". N-CONTROLE tem a compra de
#     janeiro VÁLIDA — não é novo, e é o que prova que o "novos" enxerga o histórico.
#   Esperado (oráculo independente em Python): positivados 11 · receita 1125 · novos 10 ·
#     a_positivar = os 6 X-* (nome=UUID completo) · 17/11.
# ══════════════════════════════════════════════════════════════════════════════
E3_UID="55555555-5555-5555-5555-555555555555"
cu() { printf 'e3c00000-0000-0000-0000-0000000000%02d' "$1"; }
P -q <<SQL
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible)
SELECT ('e3c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E3_UID', true
FROM generate_series(1, 17) i;

INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi, created_at, deleted_at) VALUES
  -- admissão: um pedido em cada status válido
  ('$(cu 1)',  'faturado',           1, '2025-02-03', '2025-02-03 12:00:00+00', NULL),
  ('$(cu 2)',  'importado',         10, '2025-02-04', '2025-02-04 12:00:00+00', NULL),
  ('$(cu 3)',  'separacao',        100, '2025-02-05', '2025-02-05 12:00:00+00', NULL),
  ('$(cu 4)',  'enviado',         1000, '2025-02-06', '2025-02-06 12:00:00+00', NULL),
  -- exclusão no mês: a compra válida de dez/2024 e o pedido de fevereiro que só o predicado exclui
  ('$(cu 5)',  'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 5)',  'cancelado',      10000, '2025-02-07', '2025-02-07 12:00:00+00', NULL),
  ('$(cu 6)',  'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 6)',  'rascunho',      100000, '2025-02-07', '2025-02-07 12:00:00+00', NULL),
  ('$(cu 7)',  'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 7)',  'pendente',     1000000, '2025-02-07', '2025-02-07 12:00:00+00', NULL),
  ('$(cu 8)',  'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 8)',  'orcamento',   10000000, '2025-02-07', '2025-02-07 12:00:00+00', NULL),
  ('$(cu 9)',  'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 9)',  'faturado',   100000000, '2025-02-07', '2025-02-07 12:00:00+00', '2025-02-08 12:00:00+00'),
  ('$(cu 10)', 'faturado',           3, '2024-12-10', '2024-12-10 12:00:00+00', NULL),
  ('$(cu 10)', 'faturado',  1000000000, NULL,         '2025-02-12 15:00:00+00', NULL),
  -- exclusão no histórico: o pedido fora do universo de janeiro e a compra válida de fevereiro
  ('$(cu 11)', 'cancelado',          7, '2025-01-15', '2025-01-15 12:00:00+00', NULL),
  ('$(cu 11)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  ('$(cu 12)', 'rascunho',           7, '2025-01-15', '2025-01-15 12:00:00+00', NULL),
  ('$(cu 12)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  ('$(cu 13)', 'pendente',           7, '2025-01-15', '2025-01-15 12:00:00+00', NULL),
  ('$(cu 13)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  ('$(cu 14)', 'orcamento',          7, '2025-01-15', '2025-01-15 12:00:00+00', NULL),
  ('$(cu 14)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  ('$(cu 15)', 'faturado',           7, '2025-01-15', '2025-01-15 12:00:00+00', '2025-01-16 12:00:00+00'),
  ('$(cu 15)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  ('$(cu 16)', 'faturado',           7, NULL,         '2025-01-15 15:00:00+00', NULL),
  ('$(cu 16)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL),
  -- controle do "novo": a compra de janeiro é VÁLIDA
  ('$(cu 17)', 'faturado',           7, '2025-01-15', '2025-01-15 12:00:00+00', NULL),
  ('$(cu 17)', 'faturado',           2, '2025-02-15', '2025-02-15 12:00:00+00', NULL);

INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, revenue_potential, churn_risk, priority_score)
SELECT ('e3c00000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '$E3_UID', 1000, 0, 10
FROM generate_series(1, 17) i;
INSERT INTO public.profiles(user_id, name) VALUES
  ('$(cu 1)', 'V-FAT'), ('$(cu 2)', 'V-IMP'), ('$(cu 3)', 'V-SEP'), ('$(cu 4)', 'V-ENV'),
  ('$(cu 5)', 'X-CANC'), ('$(cu 6)', 'X-RASC'), ('$(cu 7)', 'X-PEND'), ('$(cu 8)', 'X-ORC'),
  ('$(cu 9)', 'X-DEL'), ('$(cu 10)', 'X-SEMKPI'),
  ('$(cu 11)', 'N-CANC'), ('$(cu 12)', 'N-RASC'), ('$(cu 13)', 'N-PEND'), ('$(cu 14)', 'N-ORC'),
  ('$(cu 15)', 'N-DEL'), ('$(cu 16)', 'N-SEMKPI'), ('$(cu 17)', 'N-CONTROLE');
SQL

saida_u="$(P -q -tA -F '|' 2>&1 <<SQL || true
SET TimeZone = 'UTC';
SET test.agora = '2025-02-14 15:00:00+00';
SELECT 'UNI', r->>'mes', r->>'positivados', r->>'receita_mtd', r->>'novos_clientes_positivados',
       $APOS, (r->>'total_eligible') || '/' || (r->>'compradores_mtd')
  FROM (SELECT public._carteira_positivacao_for_owner('$E3_UID'::uuid) AS r) s;
SQL
)"
lu="$(printf '%s\n' "$saida_u" | grep '^UNI|' || true)"
echo "── bloco U: o universo de pedidos ──"
[ -n "$lu" ] || echo "     (saída do bloco U: $(curto "$saida_u"))"
eq U0 "mes do bloco U = mês de SP do relógio da sessão"        "$(campo "$lu" 2)" "2025-02-01"
eq U1 "positivados = os 4 válidos + os 7 N-*"                  "$(campo "$lu" 3)" "11"
eq U2 "receita = 1+10+100+1000 + 7x2: nenhuma potência de X-*" "$(campo "$lu" 4)" "1125"
eq U3 "novos = os 4 válidos + os 6 N-* de histórico excluído"  "$(campo "$lu" 5)" "10"
eq U4 "a_positivar = os 6 X-* (nome=UUID completo)"            "$(campo "$lu" 6)" \
      "X-CANC=$(cu 5),X-DEL=$(cu 9),X-ORC=$(cu 8),X-PEND=$(cu 7),X-RASC=$(cu 6),X-SEMKPI=$(cu 10)"
eq U5 "total_eligible/compradores"                              "$(campo "$lu" 7)" "17/11"

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
eq W2 "get_minha_positivacao_for(E2) como master: carteira de E2" "$V" "12"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
