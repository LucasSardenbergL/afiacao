#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — o "hoje" de SP em get_ultimos_precos_cliente e                    ║
# ║  medir_abaixo_piso_tier, seja qual for o fuso da SESSÃO                        ║
# ║                                                                                ║
# ║  Família C da classe "data de SP medida no fuso da sessão" (current_date num   ║
# ║  corpo que raciocina em SP). A prod roda sessão UTC; até a 20260927172443, das ║
# ║  21:00 às 23:59 BRT o preço de partida aceitava pedido datado de AMANHÃ e a    ║
# ║  medição do piso perdia o dia mais antigo da janela.                           ║
# ║                                                                                ║
# ║  Bloco B — a BORDA DO DIA de SP, cruzada em pares de 1 s, sob `TimeZone=UTC` E ║
# ║    `America/Sao_Paulo`: sob sessão SP o corpo antigo passa, só a UTC o pega.   ║
# ║  ⏰ Relógio CONTROLADO (`test.agora`). `public.now()` é TRIPWIRE (Z9T01), e só  ║
# ║    as duas funções sob teste ganham `pg_catalog` DEPOIS de `public`.           ║
# ║    `current_date` é palavra-chave: lê o início da transação direto e ignora o  ║
# ║    search_path, então o relógio controlado NÃO o intercepta. Por isso a        ║
# ║    sabotagem "current_date de volta" escreve a DEFINIÇÃO dele, `now()::date`   ║
# ║    (a data do início da transação no fuso da sessão), que o relógio alcança; e ║
# ║    o literal é pego pelo R0, que chama cada RPC SEM `test.agora` e exige o     ║
# ║    tripwire (parecer Codex, desenho 2026-09-27).                               ║
# ║  Diário: docs/historico/positivacao-mes-sp-sob-sessao-utc.md                   ║
# ║                                                                                ║
# ║  rode: bash db/test-hoje-sp-sessao-utc-precos-piso.sh > log 2>&1; echo "exit=$?"║
# ║        bash db/test-hoje-sp-sessao-utc-precos-piso.sh --falsificar > log 2>&1  ║
# ║  matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8  ║
# ║  (lc_messages do servidor; o cliente fica em LC_ALL=C: todo grep aqui é ASCII) ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5400}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="hoje-sp-precos-piso"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG_GUPC_ORIGEM="$REPO_ROOT/supabase/migrations/20260704120000_preco_por_tier.sql"
MIG_MAPT_ORIGEM="$REPO_ROOT/supabase/migrations/20260718190000_authz_capability_matrix_e2.sql"
MIG_NOVA="$REPO_ROOT/supabase/migrations/20260927172443_hoje_sp_sessao_utc_precos_piso.sql"
# Denominador: quantos asserts a suíte EXECUTA (H1-X3 · D/L · R · A1-A6 · B0-M2 ×2 sessões · W1-W2).
# Asserts a menos — um bloco que não rodou — é vermelho: `FAIL=0` com PASS encolhido é a prova
# truncada que aprova tudo.
TOTAL_ESPERADO=49

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Três exigências
# além do modelo (db/test-positivacao-eligible-consumo.sh), pelo parecer do Codex:
#   · o filho tem de CHEGAR AO FIM com todos os asserts (linha RESULTADO com o total): um filho que
#     imprime "R0 FALHOU" e depois aborta num comando SQL não prova nada;
#   · todo ERRO_DE_EXECUCAO do log tem de estar DECLARADO (`ID!MARCA`) — vermelho por erro não mata
#     mutante, e o modelo deixava passar qualquer erro quando havia UM declarado;
#   · a marca da sabotagem tem de aparecer (sabotagem que não aplicou não é dente).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# IDs do bloco B: B<U|S><campo> — U = sessão UTC, S = sessão SP; P1-P5 = produtos em t1
# (01/03 23:59:59 BRT), Q1-Q5 = os mesmos em t2 (02/03 00:00:00 BRT), M1/M2 = medir em t1/t2.
# Esperados de cada sabotagem conferidos antes por um oráculo independente em Python.
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="current_date_de_volta:BUP1,BUP2,BUP3,BUM1,D1,D2:BSP1,BSP2,BSP3,BSM1,BUQ1,BUQ2,BUQ3,BUM2,BUP4,BUP5,R0g,R0m,R2g,R2m
              current_date_literal:R0g,R0m:D1,D2,R1g,R1m
              hoje_em_utc:BUP1,BUP2,BUP3,BUM1,BSP1,BSP2,BSP3,BSM1,D1,D2:BUQ1,BUQ2,BUQ3,BSQ1,BSQ2,BSQ3,BUM2,BSM2,R0g,R0m,R2g,R2m
              hora_de_parede:R0g,R0m,D1,D2:R1g,R1m
              relogio_desligado:R0g,R0m:R1g,R1m,D1,D2
              sem_pin:R2g!TRIPWIRE,R2m!TRIPWIRE,A2!TRIPWIRE,A4!TRIPWIRE:R0g,R0m,BUP1,BSP1,BUM1,BSM1,W1,W2
              fim_aberto:BUP1,BUP4,BUQ1,BUQ2,BUQ3,BSP1,BSP4,BSQ1,BSQ2,BSQ3,R2g,D1:BUP3,BUQ4,BSP3,BSQ4,BUM1,BUM2,R0g,D2
              filtro_futuro_removido:BUP5,BUQ5,BSP5,BSQ5,R0g,R2g,D1:BUM1,BSM1,R0m,D2
              kpi_sem_precedencia:BUP2,BUP3,BUP5,BUQ2,BUQ3,BUQ5,BUM1,BUM2,BSP2,BSP3,BSP5,BSQ2,BSQ3,BSQ5,BSM1,BSM2,D1,D2:BUP1,BUP4,BUQ1,BUQ4,BSP1,BSP4,BSQ1,BSQ4,R0g,R0m
              janela_aberta:BUM1,BUM2,BSM1,BSM2,R2m,D2:BUP1,BSP1,R0m,D1
              gate_staff_removido:A1,D1:A2,A3,A5,D2
              gate_custo_removido:A3,D2:A4,A1,A6,D1
              acl_anon_aberta:A5,A6:A1,A2,A3,A4
              literal_com_traco:L1,D1:D2
              pre_cega:X1g,X1m:X2,X3
              pre_sem_reaplicacao:X2:X1g,X1m,X3
              sem_grant_authenticated:X3:X1g,X1m,X2"
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

  echo "══ CONTROLE (migrations reais, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
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
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

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
# (Conjunto vazio legítimo nunca chega vazio: as consultas o escrevem como AUSENTE/VAZIO.)
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que os dois corpos leem. Colunas e TIPOS conferidos na prod via
# psql-ro (2026-09-27): created_at/deleted_at/synced_at timestamptz, order_date_kpi date,
# omie_codigo_produto bigint, omie_numero_pedido text; resolve_markup_policy(text,bigint,text,text)
# → TABLE(piso_markup numeric, meta_markup numeric); private.cap_custo_ler(uuid) → boolean.
# Sem DEFAULT now() nas colunas: o seed escreve todo instante LITERAL (o tripwire não é tocado).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE SCHEMA private;
-- stub da capability de custo: o master tem, o employee não (em prod o recorte é outro; aqui
-- basta um papel que passa e um que não passa, com o gate do corpo sendo o de prod)
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $function$ SELECT public.has_role(_uid, 'master'::public.app_role) $function$;

CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, customer_user_id uuid, status text, order_date_kpi date,
  created_at timestamptz, deleted_at timestamptz, account text, omie_numero_pedido text
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, customer_user_id uuid,
  product_id uuid, omie_codigo_produto bigint, unit_price numeric, quantity numeric, created_at timestamptz
);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, cmc numeric, synced_at timestamptz);
CREATE TABLE public.cliente_tier_preco (company text, customer_user_id uuid, tier text);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, familia text);
-- piso 0 → o piso é o próprio cmc: preço 99 contra cmc 100 dá folga unitária 1
CREATE FUNCTION public.resolve_markup_policy(p_company text, p_omie_codigo_produto bigint, p_familia text, p_tier text)
RETURNS TABLE(piso_markup numeric, meta_markup numeric) LANGUAGE sql STABLE
AS $function$ SELECT 0::numeric, 10::numeric $function$;
SQL

# ── helpers de arquivo (python, contagem EXATA de cada padrão: troca que não pegou é erro) ──
extrair() {   # <migration> <marcador de início> <saída> — o bloco CREATE … $function$; VERBATIM
  python3 - "$1" "$2" "$3" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read(); marca = sys.argv[2]
ini = s.find(marca); fim = s.find('$function$;', ini) if ini >= 0 else -1
if ini < 0 or fim < 0 or s.count(marca) != 1:
    sys.exit('marcador ausente ou ambiguo em %s: %r' % (sys.argv[1], marca))
bloco = s[ini:fim + len('$function$;')]
# a de origem do gupc é `CREATE FUNCTION` (vinha depois de um DROP); no banco da prova ela ainda não existe
bloco = bloco.replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 1)
open(sys.argv[3], 'w', encoding='utf-8').write(bloco + '\n')
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
# ZONA 2 — OS PREDECESSORES, extraídos VERBATIM das migrations de origem (Lei #1: nada de stub da
# lógica), com o ACL de prod (postgres, authenticated, service_role; sem anon/PUBLIC). O H1 prova
# que o repo é a prod: o md5 normalizado deles tem de ser o medido por psql-ro — as mesmas
# constantes que a PRE da migration nova aceita.
# ══════════════════════════════════════════════════════════════════════════════
PRED_G="$TMPD/pred_gupc.sql"; PRED_M="$TMPD/pred_mapt.sql"
extrair "$MIG_GUPC_ORIGEM" 'CREATE FUNCTION public.get_ultimos_precos_cliente(' "$PRED_G"
extrair "$MIG_MAPT_ORIGEM" 'CREATE OR REPLACE FUNCTION public.medir_abaixo_piso_tier(' "$PRED_M"
P -q -f "$PRED_G"; P -q -f "$PRED_M"
P -q <<'SQL'
REVOKE ALL ON FUNCTION public.get_ultimos_precos_cliente(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.medir_abaixo_piso_tier(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(integer) TO authenticated, service_role;
SQL
MD5N="md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))"
V=$(Pq -c "SELECT $MD5N FROM pg_proc p WHERE p.oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure;" 2>&1 || true)
eq H1g "predecessor do gupc (repo) = corpo de prod (md5 normalizado, psql-ro 2026-09-27)" "$V" "b8b3798d64e6bdbd8708eef7afc46222"
V=$(Pq -c "SELECT $MD5N FROM pg_proc p WHERE p.oid = 'public.medir_abaixo_piso_tier(integer)'::regprocedure;" 2>&1 || true)
eq H1m "predecessor do medir (repo) = corpo de prod (md5 normalizado, psql-ro 2026-09-27)" "$V" "78b1d60f0fca7d9580b131eafdd55bb0"

# ── sabotagens de ARQUIVO: cópias da migration nova usadas SÓ nas provas de caminho (X1-X3) ──
MIG_X1="$MIG_NOVA"; MIG_X2="$MIG_NOVA"; MIG_X3="$MIG_NOVA"
sabotar_arquivo() {   # <destino> <de> <para> <n> [...] — cópia de MIG_NOVA com as trocas
  local dst="$1"; shift
  trocar "$MIG_NOVA" "$dst" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
case "$SABOTAGEM" in
  # a PRE que não aborta nunca: deriva concorrente seria apagada em silêncio
  pre_cega) MIG_X1="$TMPD/mig_x1.sql"
    sabotar_arquivo "$MIG_X1" "IF v_norm IS NOT NULL AND v_norm NOT IN" "IF false AND v_norm IS NOT NULL AND v_norm NOT IN" 1 ;;
  # a PRE que não reconhece o próprio corpo: re-aplicar (idempotência do envelope) abortaria
  pre_sem_reaplicacao) MIG_X2="$TMPD/mig_x2.sql"
    sabotar_arquivo "$MIG_X2" \
      "'b8b3798d64e6bdbd8708eef7afc46222', '8d36e4875df012383a1d360789ce6f3d'" "'b8b3798d64e6bdbd8708eef7afc46222', 'sabotado'" 1 \
      "'78b1d60f0fca7d9580b131eafdd55bb0', 'cce088ac976a1c0d1c01ba070bf10ed1'" "'78b1d60f0fca7d9580b131eafdd55bb0', 'sabotado'" 1 ;;
  # sem o GRANT: onde a função NASCE aqui, authenticated (o staff pelo PostgREST) ficaria sem EXECUTE
  sem_grant_authenticated) MIG_X3="$TMPD/mig_x3.sql"
    sabotar_arquivo "$MIG_X3" \
      "GRANT EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) TO authenticated;" "" 1 \
      "GRANT EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(integer) TO authenticated;" "" 1 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# X — OS CAMINHOS DECLARADOS DA MIGRATION (parecer Codex): deriva ABORTA, função ausente NASCE com o
# ACL do contrato, re-aplicar é seguro. X1/X3 rodam numa transação que volta atrás; o apply de
# verdade e a re-aplicação usam `psql -1` — a transação única do executor (db:aplicar).
# ══════════════════════════════════════════════════════════════════════════════
echo "── caminhos da migration ──"
deriva() {   # <id> <descrição> <predecessor> <função> <de> <para>
  local id="$1" descr="$2" pred="$3" fn="$4" tmp out rc=0
  tmp="$(mktemp "$TMPD/deriva.XXXXXX")"
  trocar "$pred" "$tmp" "$5" "$6" 1 || { erro_exec "$id" "$descr — a deriva não se aplicou ao predecessor"; return 0; }
  out="$(P -q 2>&1 <<SQL
BEGIN;
\i $tmp
\i $MIG_X1
ROLLBACK;
SQL
)" || rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "PRE FALHOU: o corpo vivo de public.$fn"; then
    ok "$id" "$descr"
  elif [ "$rc" -eq 0 ]; then
    bad "$id" "$descr — a migration APLICOU sobre o corpo derivado: a PRE deixou passar"
  else
    erro_exec "$id" "$descr — falhou, mas não pela PRE: $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
  fi
}
deriva X1g "corpo vivo do gupc derivado (unit_price >= 0) → a PRE aborta" "$PRED_G" get_ultimos_precos_cliente \
  "AND oi.unit_price > 0" "AND oi.unit_price >= 0"
deriva X1m "corpo vivo do medir derivado (total_itens + 0) → a PRE aborta" "$PRED_M" medir_abaixo_piso_tier \
  "count(*) AS total_itens" "count(*) + 0 AS total_itens"

rc=0
out="$(P -q -tA -F '|' 2>&1 <<SQL
BEGIN;
DROP FUNCTION public.get_ultimos_precos_cliente(uuid);
DROP FUNCTION public.medir_abaixo_piso_tier(integer);
\i $MIG_X3
SELECT 'X3', f.a, f.p, f.u, f.dono FROM (
  SELECT string_agg(has_function_privilege('anon', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) AS a,
         string_agg(has_function_privilege('public', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) AS p,
         string_agg(has_function_privilege('authenticated', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) AS u,
         string_agg(pg_get_userbyid(x.proowner), ',' ORDER BY x.n) AS dono
    FROM (SELECT 1 AS n, oid, proowner FROM pg_proc WHERE oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure
          UNION ALL
          SELECT 2, oid, proowner FROM pg_proc WHERE oid = 'public.medir_abaixo_piso_tier(integer)'::regprocedure) x) f;
ROLLBACK;
SQL
)" || rc=$?
V="$(printf '%s\n' "$out" | grep '^X3|' || true)"
[ "$rc" -eq 0 ] || V="$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
eq X3 "função AUSENTE: a migration a cria com o contrato PORTA_GATE (anon/PUBLIC não, authenticated sim, dono postgres)" \
  "$V" "X3|false,false|false,false|true,true|postgres,postgres"

rc=0; out="$(P -1 -q -f "$MIG_NOVA" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q 'POS OK:'; then
  echo "❌ INFRA: a migration nova não aplicou (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"; exit 1
fi
echo "migration aplicada: $(basename "$MIG_NOVA") (PRE e POS passaram, transação única)"

rc=0; out="$(P -1 -q -f "$MIG_X2" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'POS OK:'; then
  ok X2 "re-aplicar a migration sobre ela mesma é seguro (a PRE reconhece o próprio corpo)"
elif [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'PRE FALHOU'; then
  bad X2 "a re-aplicação ABORTOU na PRE — a migration não é idempotente"
else
  erro_exec X2 "re-aplicação sem veredito (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
fi

# ── SABOTAGEM de CORPO (só no modo --falsificar) — no BANCO, recriando a função a partir do bloco da
# migration nova com o trecho trocado; o repo nunca é tocado. Cada padrão tem de ocorrer exatamente
# n× no corpo: uma troca que não pegou deixaria a suíte verde. Vem DEPOIS do X2 (a re-aplicação
# desfaria a sabotagem) e ANTES do relógio (o CREATE OR REPLACE traria o search_path de prod).
sabotar() {   # <função> <de> <para> <n> [<de> <para> <n> ...]
  local fn="$1" bloco sab; shift
  bloco="$(mktemp "$TMPD/bloco.XXXXXX")"; sab="$(mktemp "$TMPD/sab.XXXXXX")"
  extrair "$MIG_NOVA" "CREATE OR REPLACE FUNCTION public.$fn(" "$bloco" \
    && trocar "$bloco" "$sab" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  P -q -f "$sab" >/dev/null
}
G=get_ultimos_precos_cliente; M=medir_abaixo_piso_tier
EXPR_NOVA="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
PED_SP="(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date"
case "$SABOTAGEM" in
  ""|pre_cega|pre_sem_reaplicacao|sem_grant_authenticated) ;;
  # o defeito de volta, na forma que o relógio controlado alcança: `now()::date` É o current_date
  # (a data do início da transação no fuso da SESSÃO). Tem de ficar vermelha SÓ na sessão UTC, em t1.
  current_date_de_volta) sabotar "$G" "$EXPR_NOVA" "now()::date" 1; sabotar "$M" "$EXPR_NOVA" "now()::date" 1 ;;
  # o literal: escapa do relógio controlado — quem o pega é o R0 (o corpo volta a ser o predecessor: D1/D2 verdes)
  current_date_literal) sabotar "$G" "$EXPR_NOVA" "current_date" 1; sabotar "$M" "$EXPR_NOVA" "current_date" 1 ;;
  # o hoje em UTC, qualquer que seja a sessão: vermelha nas DUAS sessões em t1
  hoje_em_utc) sabotar "$G" "$EXPR_NOVA" "(now() AT TIME ZONE 'UTC')::date" 1
               sabotar "$M" "$EXPR_NOVA" "(now() AT TIME ZONE 'UTC')::date" 1 ;;
  # o hoje tirado do relógio de parede, que o controlado não intercepta
  hora_de_parede) sabotar "$G" "$EXPR_NOVA" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date" 1
                  sabotar "$M" "$EXPR_NOVA" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date" 1 ;;
  # não sabotam corpo: pulam o ALTER do search_path / o pin do relógio, logo abaixo
  relogio_desligado|sem_pin) ;;
  # o anti-futuro exclusivo: o pedido de HOJE sai do preço de partida
  fim_aberto) sabotar "$G" "<= $EXPR_NOVA" "< $EXPR_NOVA" 1 ;;
  # sem anti-futuro: o pedido de depois de amanhã (P5) vira preço de partida
  filtro_futuro_removido) sabotar "$G" " AND COALESCE(so.order_date_kpi, $PED_SP) <= $EXPR_NOVA" "" 1 ;;
  # a data do created_at passa na frente do KPI (nos 3 usos do gupc e no do medir)
  kpi_sem_precedencia) sabotar "$G" "COALESCE(so.order_date_kpi, $PED_SP)" "COALESCE($PED_SP, so.order_date_kpi)" 3
                       sabotar "$M" "COALESCE(so.order_date_kpi, $PED_SP)" "COALESCE($PED_SP, so.order_date_kpi)" 1 ;;
  # a janela do medir exclusiva: o dia mais antigo sai sempre
  janela_aberta) sabotar "$M" ">= $EXPR_NOVA - p_dias" "> $EXPR_NOVA - p_dias" 1 ;;
  # os gates removidos (o de staff do gupc; a capability de custo do medir)
  gate_staff_removido) sabotar "$G" "IF NOT (public.has_role(" "IF false AND NOT (public.has_role(" 1 ;;
  gate_custo_removido) sabotar "$M" "IF NOT (COALESCE(private.cap_custo_ler(" "IF false AND NOT (COALESCE(private.cap_custo_ler(" 1 ;;
  # o ACL reaberto para anon (o gate do corpo passa a ser a única barreira)
  acl_anon_aberta) P -q -c "GRANT EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) TO anon;
                            GRANT EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(integer) TO anon;" ;;
  # `--` dentro de literal: o limite declarado do normalizador passaria a valer
  literal_com_traco) sabotar "$G" "'forbidden: get_ultimos_precos_cliente exige staff'" "'forbidden: get_ultimos_precos_cliente -- exige staff'" 1 ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
case "$SABOTAGEM" in
  ""|pre_cega|pre_sem_reaplicacao|sem_grant_authenticated) ;;
  *) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# D/L — A FORMA DO CORPO INSTALADO. D: o corpo novo com a expressão trocada de VOLTA por
# current_date tem de ser o predecessor (md5 normalizado) ⇒ a troca é a ÚNICA diferença.
# L: o normalizador não conhece literal ('a--b' ≡ 'a--c'); o limite só não pesa se nenhum literal
# dos dois corpos tiver `--` ou espaço duplo. O total de literais é o controle positivo do regex.
# ══════════════════════════════════════════════════════════════════════════════
echo "── forma do corpo instalado ──"
EXPR_NOVA_SQL="(now() AT TIME ZONE ''America/Sao_Paulo'')::date"
REV="md5(btrim(regexp_replace(replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '$EXPR_NOVA_SQL', 'current_date'), '\s+', ' ', 'g')))"
V=$(Pq -c "SELECT $REV FROM pg_proc p WHERE p.oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure;" 2>&1 || true)
eq D1 "gupc instalado = predecessor + exatamente a troca do hoje" "$V" "b8b3798d64e6bdbd8708eef7afc46222"
V=$(Pq -c "SELECT $REV FROM pg_proc p WHERE p.oid = 'public.medir_abaixo_piso_tier(integer)'::regprocedure;" 2>&1 || true)
eq D2 "medir instalado = predecessor + exatamente a troca do hoje" "$V" "78b1d60f0fca7d9580b131eafdd55bb0"
V=$(Pq -c "SELECT count(*) FILTER (WHERE m[1] ~ '(--|\s\s)') || '/' || count(*)
             FROM pg_proc p, regexp_matches(p.prosrc, '''([^'']*)''', 'g') m
            WHERE p.oid IN ('public.get_ultimos_precos_cliente(uuid)'::regprocedure, 'public.medir_abaixo_piso_tier(integer)'::regprocedure);" 2>&1 || true)
eq L1 "nenhum dos 28 literais dos dois corpos tem -- ou espaço duplo (o limite do normalizador não se aplica)" "$V" "0/28"

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — `public.now()` lê a GUC `test.agora` e é um TRIPWIRE: sem ela, levanta
# exceção com SQLSTATE PRÓPRIO (Z9T01, não o P0001 do RAISE comum nem o 42501 dos gates). SÓ as
# funções sob teste ganham `pg_catalog` DEPOIS de `public` no search_path — é a única forma de um
# nome de usuário vencer um embutido (sem `pg_catalog` explícito ele é buscado PRIMEIRO).
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
# O ALTER muda o proconfig das funções sob teste em relação à prod: confira o ORIGINAL antes (R1) e
# restaure-o no fim, para o smoke rodar sobre as funções exatamente como a prod as vê.
CFG_G="$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure;")"
CFG_M="$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.medir_abaixo_piso_tier(integer)'::regprocedure;")"
eq R1g "proconfig do gupc, antes do relógio (o de prod)" "$CFG_G" 'search_path=""'
eq R1m "proconfig do medir, antes do relógio (o de prod)" "$CFG_M" "search_path=public"
if [ "$SABOTAGEM" != relogio_desligado ]; then
  P -q -c "ALTER FUNCTION public.get_ultimos_precos_cliente(uuid) SET search_path = public, pg_catalog, pg_temp;"
  P -q -c "ALTER FUNCTION public.medir_abaixo_piso_tier(integer) SET search_path = public, pg_catalog, pg_temp;"
fi
# O pin: TODA conexão nova nasce em 01/03/2025 15:00Z (meio do dia nos dois fusos: a data é a mesma
# em UTC e em SP). O bloco B troca o instante na própria sessão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-03-01 15:00:00+00';"
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
# ZONA 3 — SEED no universo COMUM (status 'faturado', sem exclusão lógica): um seed fora dele
# devolveria vazio com o código certo E com o errado, e o assert passaria por vacuidade.
#   Borda do dia de SP: 02/03/2025 00:00:00 BRT = 02/03/2025 03:00:00Z. Relógio: t1 = 02:59:59Z
#   (01/03 23:59:59 BRT, hoje-SP = 01/03; o current_date da sessão UTC já é 02/03) · t2 = 03:00:00Z.
#   gupc — cliente CB (sem omie_numero_pedido: o medir não os vê; a gupc não lê a coluna):
#     P1 preço 10 kpi 01/03 e preço 20 kpi 02/03 — hoje e amanhã disputam o MESMO produto
#     P2 preço 5  kpi 02/03, criado em 27/02 — kpi de amanhã com criação no passado (precedência)
#     P3 preço 3  kpi 28/02, criado em 02/03 12:00Z — kpi passado com criação "amanhã" (precedência)
#        e preço 7 sem kpi, criado 02/03 03:00:00Z (= 02/03 00:00:00 BRT): o fallback de amanhã
#     P4 preço 9  sem kpi, criado 02/03 02:59:59Z (= 01/03 23:59:59 BRT): o fallback de hoje
#     P5 preço 1000 kpi 03/03, criado 26/02 — depois de amanhã: nunca aparece
#   medir — cliente CM, conta oben, tier A, cmc 100, piso 0, preço 99 ⇒ folga unitária 1, e a
#     quantidade em potências de 10 diz QUAIS itens entraram (p_dias = 10):
#     I1 kpi 19/02 ×1 · I2 kpi 20/02 ×10 · I3 sem kpi, 20/02 02:59:59Z (= 19/02 BRT) ×100 ·
#     I4 sem kpi, 20/02 03:00:00Z (= 20/02 BRT) ×1000 · I5 kpi 18/02 criado 25/02 ×10000 (fora) ·
#     I6 kpi 02/03 criado 10/02 ×100000 (sem teto: o futuro entra)
#   Esperado, NAS DUAS SESSÕES (oráculo Python independente):
#     t1 → 10@03-01 · AUSENTE · 3@02-28 · 9@03-01 · AUSENTE · medir oben/A:5/5:101111
#     t2 → 20@03-02 · 5@03-02 · 7@03-02 · 9@03-01 · AUSENTE · medir oben/A:3/3:101010
#   O corpo antigo (current_date), sob sessão UTC em t1: 20@03-02 · 5@03-02 · 7@03-02 · 9@03-01 ·
#   AUSENTE · medir 3/3:101010; sob sessão SP ele passa — é por isso que o bloco roda nas duas.
# ══════════════════════════════════════════════════════════════════════════════
MASTER=33333333-3333-3333-3333-333333333333
EMPLOYEE=22222222-2222-2222-2222-222222222222
CUSTOMER=55555555-5555-5555-5555-555555555555
CB=cb000000-0000-0000-0000-000000000001
CM=c3000000-0000-0000-0000-000000000001
prod() { printf 'a1000000-0000-0000-0000-00000000000%d' "$1"; }
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'), ('$EMPLOYEE'), ('$CUSTOMER'), ('$CB'), ('$CM');
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$MASTER', 'master'), ('$EMPLOYEE', 'employee'), ('$CUSTOMER', 'customer');

INSERT INTO public.sales_orders(id, customer_user_id, status, order_date_kpi, created_at, deleted_at, account, omie_numero_pedido) VALUES
  ('0a000000-0000-0000-0000-000000000001', '$CB', 'faturado', '2025-03-01', '2025-03-01 12:00:00+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000002', '$CB', 'faturado', '2025-03-02', '2025-03-02 12:00:00+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000003', '$CB', 'faturado', '2025-03-02', '2025-02-27 12:00:00+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000004', '$CB', 'faturado', '2025-02-28', '2025-03-02 12:00:00+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000005', '$CB', 'faturado', NULL,         '2025-03-02 03:00:00+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000006', '$CB', 'faturado', NULL,         '2025-03-02 02:59:59+00', NULL, 'oben', NULL),
  ('0a000000-0000-0000-0000-000000000007', '$CB', 'faturado', '2025-03-03', '2025-02-26 12:00:00+00', NULL, 'oben', NULL);
INSERT INTO public.order_items(sales_order_id, customer_user_id, product_id, unit_price, quantity, created_at)
SELECT so.id, so.customer_user_id, v.produto::uuid, v.preco, 1, so.created_at
  FROM (VALUES (1, '$(prod 1)', 10), (2, '$(prod 1)', 20), (3, '$(prod 2)', 5), (4, '$(prod 3)', 3),
               (5, '$(prod 3)', 7), (6, '$(prod 4)', 9), (7, '$(prod 5)', 1000)) v(n, produto, preco)
  JOIN public.sales_orders so ON so.id = ('0a000000-0000-0000-0000-00000000000' || v.n)::uuid;

INSERT INTO public.sales_orders(id, customer_user_id, status, order_date_kpi, created_at, deleted_at, account, omie_numero_pedido) VALUES
  ('0b000000-0000-0000-0000-000000000001', '$CM', 'faturado', '2025-02-19', '2025-02-19 12:00:00+00', NULL, 'oben', 'PV-1'),
  ('0b000000-0000-0000-0000-000000000002', '$CM', 'faturado', '2025-02-20', '2025-02-20 12:00:00+00', NULL, 'oben', 'PV-2'),
  ('0b000000-0000-0000-0000-000000000003', '$CM', 'faturado', NULL,         '2025-02-20 02:59:59+00', NULL, 'oben', 'PV-3'),
  ('0b000000-0000-0000-0000-000000000004', '$CM', 'faturado', NULL,         '2025-02-20 03:00:00+00', NULL, 'oben', 'PV-4'),
  ('0b000000-0000-0000-0000-000000000005', '$CM', 'faturado', '2025-02-18', '2025-02-25 12:00:00+00', NULL, 'oben', 'PV-5'),
  ('0b000000-0000-0000-0000-000000000006', '$CM', 'faturado', '2025-03-02', '2025-02-10 12:00:00+00', NULL, 'oben', 'PV-6');
INSERT INTO public.order_items(sales_order_id, customer_user_id, product_id, omie_codigo_produto, unit_price, quantity, created_at)
SELECT so.id, so.customer_user_id, gen_random_uuid(), 100 + v.n, 99, v.qtd, so.created_at
  FROM (VALUES (1, 1), (2, 10), (3, 100), (4, 1000), (5, 10000), (6, 100000)) v(n, qtd)
  JOIN public.sales_orders so ON so.id = ('0b000000-0000-0000-0000-00000000000' || v.n)::uuid;
INSERT INTO public.inventory_position(omie_codigo_produto, account, cmc, synced_at)
SELECT 100 + n, 'vendas', 100, '2025-01-01 00:00:00+00' FROM generate_series(1, 6) n;
INSERT INTO public.omie_products(omie_codigo_produto, account, familia)
SELECT 100 + n, 'oben', 'F' FROM generate_series(1, 6) n;
INSERT INTO public.cliente_tier_preco(company, customer_user_id, tier) VALUES ('oben', '$CM', 'A');
SQL

# As duas leituras, sempre com resultado DECLARADO: produto ausente é AUSENTE e medição sem linha é
# VAZIO — nunca a string vazia, que o eq trata como erro de execução.
GUPC_Q="(SELECT string_agg(coalesce(g.v, 'AUSENTE'), '|' ORDER BY p.n)
           FROM (VALUES (1, '$(prod 1)'::uuid), (2, '$(prod 2)'::uuid), (3, '$(prod 3)'::uuid),
                        (4, '$(prod 4)'::uuid), (5, '$(prod 5)'::uuid)) p(n, id)
           LEFT JOIN (SELECT r.product_id, r.unit_price::text || '@' || r.ultimo_praticado_em::text AS v
                        FROM public.get_ultimos_precos_cliente('$CB'::uuid) r) g ON g.product_id = p.id)"
mapt_q() { printf "(SELECT coalesce(string_agg(m.company || '/' || coalesce(m.tier, '-') || ':' || m.itens_abaixo || '/' || m.total_itens || ':' || trim_scale(m.folga_negativa_reais)::text, ',' ORDER BY m.company, m.tier), 'VAZIO') FROM public.medir_abaixo_piso_tier(%s) m)" "$1"; }
MAPT_Q="$(mapt_q 10)"

# ══════════════════════════════════════════════════════════════════════════════
# R — AS FUNÇÕES LEEM O RELÓGIO CONTROLADO. R0 (parecer Codex): cada RPC, com o gate satisfeito e
# fixture elegível, chamada SEM `test.agora`, tem de bater no TRIPWIRE (Z9T01) — retorno normal
# quer dizer que ela tirou o hoje de outro lugar (current_date literal, relógio de parede, search
# path sem o relógio), e o veredito não depende da data real da máquina. R2: com o pin, o VALOR
# usado é o do relógio controlado.
# ══════════════════════════════════════════════════════════════════════════════
echo "── relógio controlado ──"
sonda_relogio() {   # <FROM da chamada> — imprime RELOGIO_LIDO | RELOGIO_ESCAPOU (ou o erro)
  P -q -tA 2>&1 <<SQL || true
SET test.uid = '$MASTER';
SET test.agora = '';
DO \$r\$
DECLARE v_passou boolean := false; v_tripwire boolean := false;
BEGIN
  BEGIN
    PERFORM count(*) FROM $1;
    v_passou := true;                    -- chegou aqui = não leu o now() controlado
  EXCEPTION
    WHEN SQLSTATE 'Z9T01' THEN v_tripwire := true;
    WHEN OTHERS THEN RAISE;              -- qualquer outro erro: relança
  END;
  IF v_tripwire THEN RAISE NOTICE 'RELOGIO_LIDO';
  ELSIF v_passou THEN RAISE NOTICE 'RELOGIO_ESCAPOU';
  END IF;
END \$r\$;
SQL
}
veredito_relogio() {   # <id> <descrição> <saída da sonda>
  case "$3" in
    *RELOGIO_LIDO*)    ok "$1" "$2" ;;
    *RELOGIO_ESCAPOU*) bad "$1" "$2 — a função respondeu sem ler o relógio controlado" ;;
    *)                 erro_exec "$1" "$2 — sonda sem veredito: $(printf '%s' "$3" | tr '\n' ' ' | head -c 200)" ;;
  esac
}
veredito_relogio R0g "gupc lê o relógio controlado (sem test.agora bate no tripwire)" \
  "$(sonda_relogio "public.get_ultimos_precos_cliente('$CB'::uuid)")"
veredito_relogio R0m "medir lê o relógio controlado (sem test.agora bate no tripwire)" \
  "$(sonda_relogio "public.medir_abaixo_piso_tier(10)")"
V=$(Pq -c "SET test.uid='$MASTER'; SELECT $GUPC_Q;" 2>&1 || true)
eq R2g "gupc no pin (01/03 12:00 BRT): hoje-SP = 01/03" "$V" "10@2025-03-01|AUSENTE|3@2025-02-28|9@2025-03-01|AUSENTE"
V=$(Pq -c "SET test.uid='$MASTER'; SELECT $MAPT_Q;" 2>&1 || true)
eq R2m "medir no pin: janela [19/02, ∞)" "$V" "oben/A:5/5:101111"

# ══════════════════════════════════════════════════════════════════════════════
# A — A FRONTEIRA: os gates do corpo e o ACL, como o PostgREST chama (SET ROLE). A 42501 do gate e
# a 42501 do ACL têm o MESMO SQLSTATE: o veredito separa pela MENSAGEM exata do gate (nossa, ASCII)
# e pelo nome da função na recusa do ACL (presente em qualquer lc_messages); qualquer outro erro é
# relançado. Um sinal por FLAG, nunca por RAISE do próprio teste (achado Codex no #1416).
# ══════════════════════════════════════════════════════════════════════════════
echo "── gates e ACL ──"
veredito() {   # <papel> <uid ou vazio> <FROM da chamada> <mensagem exata do gate> <nome da função>
  P -q -tA 2>&1 <<SQL || true
SET test.uid = '$2';
SET ROLE $1;
DO \$v\$
DECLARE v_passou boolean := false; v_gate boolean := false; v_acl boolean := false;
BEGIN
  BEGIN
    PERFORM count(*) FROM $3;
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM = '$4' THEN v_gate := true;
      ELSIF position('$5' IN SQLERRM) > 0 THEN v_acl := true;
      ELSE RAISE; END IF;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_gate THEN RAISE NOTICE 'VEREDITO_GATE';
  ELSIF v_acl THEN RAISE NOTICE 'VEREDITO_ACL';
  ELSIF v_passou THEN RAISE NOTICE 'VEREDITO_PASSOU';
  END IF;
END \$v\$;
SQL
}
espera() {   # <id> <descrição> <veredito esperado: GATE|ACL> <saída>
  case "$4" in
    *VEREDITO_"$3"*) ok "$1" "$2" ;;
    *VEREDITO_GATE*|*VEREDITO_ACL*|*VEREDITO_PASSOU*)
      bad "$1" "$2 — veio $(printf '%s' "$4" | grep -o 'VEREDITO_[A-Z]*' | head -1)" ;;
    *) erro_exec "$1" "$2 — sem veredito: $(printf '%s' "$4" | tr '\n' ' ' | head -c 200)" ;;
  esac
}
MSG_G='forbidden: get_ultimos_precos_cliente exige staff'
MSG_M='forbidden: medir_abaixo_piso_tier exige capability de custo'
espera A1 "customer NÃO lê os últimos preços (barrado pelo gate de staff)" GATE \
  "$(veredito authenticated "$CUSTOMER" "public.get_ultimos_precos_cliente('$CB'::uuid)" "$MSG_G" get_ultimos_precos_cliente)"
V=$(Pq -c "SET test.uid='$EMPLOYEE'; SET ROLE authenticated; SELECT count(*) FROM public.get_ultimos_precos_cliente('$CB'::uuid);" 2>&1 || true)
eq A2 "employee lê os últimos preços como authenticated (3 produtos no pin)" "$V" "3"
espera A3 "employee NÃO lê a medição do piso (barrado pela capability de custo)" GATE \
  "$(veredito authenticated "$EMPLOYEE" "public.medir_abaixo_piso_tier(10)" "$MSG_M" medir_abaixo_piso_tier)"
V=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.medir_abaixo_piso_tier(10);" 2>&1 || true)
eq A4 "master lê a medição do piso como authenticated (1 grupo)" "$V" "1"
espera A5 "anon NÃO executa o gupc (barrado pelo ACL, antes do gate)" ACL \
  "$(veredito anon "" "public.get_ultimos_precos_cliente('$CB'::uuid)" "$MSG_G" get_ultimos_precos_cliente)"
espera A6 "anon NÃO executa o medir (barrado pelo ACL, antes do gate)" ACL \
  "$(veredito anon "" "public.medir_abaixo_piso_tier(10)" "$MSG_M" medir_abaixo_piso_tier)"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO B — A BORDA DO DIA DE SP, cruzada de propósito, uma conexão por sessão. B0 é o controle
# POSITIVO da sessão: o TimeZone é o que foi setado E o cast ingênuo de uma data vira 00:00Z na
# sessão UTC e 03:00Z na de SP — prova que as duas rodadas são mundos diferentes (senão a rodada
# "SP" poderia ser UTC calada e as duas concordariam).
# ══════════════════════════════════════════════════════════════════════════════
bloco_b() {   # <U|S> <TimeZone> <hh:mm esperado no cast ingênuo>
  local pfx="B$1" tz="$2" hhmm="$3" out rc=0 l0 lg1 lm1 lg2 lm2
  out="$(P -q -tA -F '|' 2>&1 <<SQL
SET TimeZone = '$tz';
SET test.uid = '$MASTER';
SELECT 'B0', current_setting('TimeZone'), to_char(('2025-03-01'::date)::timestamptz AT TIME ZONE 'UTC', 'HH24:MI');
SET test.agora = '2025-03-02 02:59:59+00';
SELECT 'G1', $GUPC_Q;
SELECT 'M1', $MAPT_Q;
SET test.agora = '2025-03-02 03:00:00+00';
SELECT 'G2', $GUPC_Q;
SELECT 'M2', $MAPT_Q;
SQL
)" || rc=$?
  l0="$(printf '%s\n' "$out" | grep '^B0|' || true)"
  lg1="$(printf '%s\n' "$out" | grep '^G1|' || true)"; lm1="$(printf '%s\n' "$out" | grep '^M1|' || true)"
  lg2="$(printf '%s\n' "$out" | grep '^G2|' || true)"; lm2="$(printf '%s\n' "$out" | grep '^M2|' || true)"
  campo() { [ -n "$1" ] && printf '%s' "$1" | cut -d'|' -f"$2"; }
  echo "── bloco B sob sessão $tz ──"
  [ "$rc" -eq 0 ] || echo "     (psql saiu $rc na sessão $tz: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300))"
  eq "${pfx}0"  "sessão $tz: TimeZone e cast ingênuo de 01/03"                  "$(campo "$l0" 2-3)"  "$tz|$hhmm"
  eq "${pfx}P1" "t1 (01/03 23:59:59 BRT) · P1: o de hoje vence, o de amanhã fica fora" "$(campo "$lg1" 2)" "10@2025-03-01"
  eq "${pfx}P2" "t1 · P2: kpi de amanhã (criado no passado) não aparece"          "$(campo "$lg1" 3)" "AUSENTE"
  eq "${pfx}P3" "t1 · P3: kpi passado vence; o fallback de 00:00:00 BRT é amanhã" "$(campo "$lg1" 4)" "3@2025-02-28"
  eq "${pfx}P4" "t1 · P4: o fallback de 23:59:59 BRT é hoje"                      "$(campo "$lg1" 5)" "9@2025-03-01"
  eq "${pfx}P5" "t1 · P5: depois de amanhã nunca aparece"                         "$(campo "$lg1" 6)" "AUSENTE"
  eq "${pfx}Q1" "t2 (02/03 00:00:00 BRT) · P1: o de 02/03 virou hoje e vence"     "$(campo "$lg2" 2)" "20@2025-03-02"
  eq "${pfx}Q2" "t2 · P2: o kpi de 02/03 entra"                                   "$(campo "$lg2" 3)" "5@2025-03-02"
  eq "${pfx}Q3" "t2 · P3: o fallback de 00:00:00 BRT entra e vence"               "$(campo "$lg2" 4)" "7@2025-03-02"
  eq "${pfx}Q4" "t2 · P4: segue o de 01/03"                                       "$(campo "$lg2" 5)" "9@2025-03-01"
  eq "${pfx}Q5" "t2 · P5: ainda amanhã"                                           "$(campo "$lg2" 6)" "AUSENTE"
  eq "${pfx}M1" "t1 · medir: janela [19/02, ∞) = I1,I2,I3,I4,I6"                   "$(campo "$lm1" 2)" "oben/A:5/5:101111"
  eq "${pfx}M2" "t2 · medir: janela [20/02, ∞) = I2,I4,I6"                         "$(campo "$lm2" 2)" "oben/A:3/3:101010"
}
bloco_b U UTC "00:00"
bloco_b S America/Sao_Paulo "03:00"

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE — as funções com o proconfig RESTAURADO (o da prod: sem o relógio controlado), chamadas como
# `authenticated` com a identidade que cada gate exige. Prova que as funções como a prod as vê
# executam (late-bound; com search_path '' qualquer nome não qualificado quebraria) no relógio de
# verdade. O seed é todo de 2025, então o resultado não depende da data em que a prova roda.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "ALTER FUNCTION public.get_ultimos_precos_cliente(uuid) SET search_path = '';"
P -q -c "ALTER FUNCTION public.medir_abaixo_piso_tier(integer) SET search_path = public;"
[ "$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure;")" = "$CFG_G" ] \
  && [ "$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.medir_abaixo_piso_tier(integer)'::regprocedure;")" = "$CFG_M" ] \
  || { echo "❌ INFRA: o proconfig não voltou ao de prod — o smoke mediria outra função"; exit 1; }
echo "── smoke, proconfig de prod restaurado ──"
V=$(Pq -c "SET test.uid='$EMPLOYEE'; SET ROLE authenticated; SELECT $GUPC_Q;" 2>&1 || true)
eq W1 "gupc como employee, relógio real: tudo de 2025 é passado" "$V" "20@2025-03-02|5@2025-03-02|7@2025-03-02|9@2025-03-01|1000@2025-03-03"
V=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT $(mapt_q 100000);" 2>&1 || true)
eq W2 "medir como master, relógio real, janela de 100000 dias: os 6 itens" "$V" "oben/A:6/6:111111"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
