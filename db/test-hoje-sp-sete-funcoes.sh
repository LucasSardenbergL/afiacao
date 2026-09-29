#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — o "hoje" de SP em 7 funções, seja qual for o fuso da SESSÃO        ║
# ║  (20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql)                           ║
# ║                                                                                ║
# ║  Classe (ii): o dia da sessão lido fora de date_trunc (`current_date`, e o     ║
# ║  instante que vira data por `::date`) em corpos que não mencionam SP. A prod   ║
# ║  roda sessão UTC; das 21:00 às 23:59 BRT o dia da sessão já é o seguinte.      ║
# ║    T fin_period_lock_trigger  (trava contábil do mapeamento DRE)               ║
# ║    G get_regua_preco          (janela de 180 dias do preço)                    ║
# ║    L listar_pedidos_a_separar (data exibida + janela de 60 dias)               ║
# ║    R radar_atribuir_tarefa    (due_date = hoje + N)                            ║
# ║    O sincronizar_ativo_omie_para_reposicao (eventos_outlier.data_evento)       ║
# ║    C trg_campanha_gera_alerta (alerta de campanha cancelada na vigência)       ║
# ║    V vendas_sync_semear_janela (guarda anti-futuro do date_to)                 ║
# ║                                                                                ║
# ║  Bloco B — a borda do DIA de SP (D = 28/02/2025, último dia de um mês que a    ║
# ║    trava contábil tem fechado), em 4 instantes: tA 20:59:59 · tB 21:00:00 ·    ║
# ║    tC 23:59:59 BRT de D · tD 00:00:00 BRT de D+1 — sob `TimeZone=UTC` E        ║
# ║    `America/Sao_Paulo`. Sob sessão SP o corpo antigo passa: só a UTC o pega.   ║
# ║  ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) e só   ║
# ║    as 7 funções ganham `pg_catalog` DEPOIS de `public`. `current_date` é       ║
# ║    palavra-chave: o relógio não o alcança. A sabotagem "de volta" escreve a    ║
# ║    DEFINIÇÃO dele, `now()::date`; o literal é pego pelo R0 (sem `test.agora`   ║
# ║    a função tem de bater no tripwire) — exceto no radar, cujo dedupe já lê     ║
# ║    now(): lá quem pega o literal é o bloco B.                                  ║
# ║  Limite declarado: o `ORDER BY` do picking (3º uso do instante do pedido) só   ║
# ║    ordena — a leitura aqui reordena a saída; quem o prova é o D1 (forma).      ║
# ║  Diário: docs/historico/hoje-da-sessao-nu-funcoes-e-skills.md                  ║
# ║                                                                                ║
# ║  rode: bash db/test-hoje-sp-sete-funcoes.sh > log 2>&1; echo "exit=$?"          ║
# ║        bash db/test-hoje-sp-sete-funcoes.sh --falsificar > log 2>&1            ║
# ║  matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8  ║
# ║  (lc_messages do servidor; o cliente fica em LC_ALL=C: todo grep aqui é ASCII) ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5700}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="hoje-sp-sete-funcoes"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG_NOVA="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
FIXTURE="$REPO_ROOT/db/fixtures/hoje-sp-sete-funcoes-predecessoras-prod-20260929.sql"
# Denominador: quantos asserts a suíte EXECUTA (H1-H2 · X1a-X3s · D1 · R1 · R0×7 · R2 · A1 ·
# B0+7 ×2 sessões · W×7). Asserts a menos — um bloco que não rodou — é vermelho: `FAIL=0` com PASS
# encolhido é a prova truncada que aprova tudo.
TOTAL_ESPERADO=41

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE (o contrato de
# db/test-hoje-sp-sessao-utc-precos-piso.sh). O controle roda PRIMEIRO, na mesma invocação; cada
# sabotagem declara os asserts que TÊM de ficar vermelhos por RESULTADO e os que TÊM de continuar
# verdes; o filho tem de chegar ao fim com todos os asserts; todo ERRO_DE_EXECUCAO tem de estar
# declarado (`ID!MARCA`); a marca da sabotagem tem de aparecer.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# IDs do bloco B: B<U|S><função> — U = sessão UTC, S = sessão SP.
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="current_date_de_volta:D1,BUT,BUG,BUL,BUR,BUO,BUC,BUV:BST,BSG,BSL,BSR,BSO,BSC,BSV,R0T,R0G,R0L,R0R,R0O,R0C,R0V,H1
              current_date_literal:R0T,R0G,R0L,R0O,R0C,R0V,BUR,BSR:D1,H1,R1
              hoje_em_utc:D1,BUT,BUG,BUL,BUR,BUO,BUC,BUV,BST,BSG,BSL,BSR,BSO,BSC,BSV:R0T,R0G,R0L,R0R,R0O,R0C,R0V
              hora_de_parede:D1,R0T,R0G,R0L,R0O,R0C,R0V:R0R,R1
              relogio_desligado:R0T,R0G,R0L,R0R,R0O,R0C,R0V:R1,D1
              sem_pin:R2!TRIPWIRE:R0T,R0R,BUT,BST,BUR,BSR,WT,WR
              regua_so_cliente:BUG:BSG,BUL,R0G
              regua_so_comparaveis:BUG:BSG,BUL,R0G
              picking_so_data:BUL:BSL,BUG,R0L
              picking_so_janela:BUL:BSL,BUG,R0L
              picking_so_filtro_pedido:BUL:BSL,BUG,R0L
              omie_so_inativado:BUO:BSO,BUC,R0O
              omie_so_reativado:BUO:BSO,BUC,R0O
              acl_anon_aberta:A1:WG,WL,WR,WV
              pre_cega:X1a,X1b:X2,X3,X3s
              pre_sem_reaplicacao:X2:X1a,X1b,X3,X3s
              sem_grant_authenticated:X3:X3s,X1a,X1b,X2
              revoke_sem_anon:X3s:X3,X1a,X1b,X2"
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
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que os 7 corpos leem e escrevem, com as colunas, os tipos e os NOT
# NULL da prod (pg_attribute via psql-ro, 2026-09-29 — o information_schema esconde do claude_ro a
# coluna sem privilégio). As tabelas nascem ANTES do relógio controlado: o `DEFAULT now()` delas
# amarra o pg_catalog.now() no CREATE e nunca toca o tripwire.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
-- em prod o recorte é outro; aqui basta um papel que passa (master) e um que não passa
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE
AS $function$ SELECT public.has_role(_uid, 'master'::public.app_role) $function$;
CREATE SCHEMA private;
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE
AS $function$ SELECT public.has_role(_uid, 'master'::public.app_role) $function$;
CREATE FUNCTION private.regua_num_finito(x numeric) RETURNS boolean LANGUAGE sql IMMUTABLE
AS $function$ SELECT x IS NOT NULL AND x <> 'NaN'::numeric AND x NOT IN ('Infinity'::numeric, '-Infinity'::numeric) $function$;
-- o piso não é o que está sob prova (sem cmc não há piso): a régua devolve o MERCADO, que é o que a janela decide
CREATE FUNCTION private.regua_piso_calc(p_cmc numeric, p_aliquota numeric, p_prazo_dias numeric[], p_taxa numeric)
RETURNS TABLE(piso numeric, prazo_aplicado boolean) LANGUAGE sql STABLE AS $function$ SELECT NULL::numeric, false $function$;

CREATE TABLE public.fin_categoria_dre_mapping (id uuid NOT NULL DEFAULT gen_random_uuid(), company text NOT NULL, omie_codigo text NOT NULL);
CREATE TABLE public.fin_fechamentos (id uuid NOT NULL DEFAULT gen_random_uuid(), company text NOT NULL, ano integer NOT NULL,
  mes integer NOT NULL, status text NOT NULL DEFAULT 'aberto', aprovado_em timestamptz);
CREATE TABLE public.fin_period_overrides (id uuid NOT NULL DEFAULT gen_random_uuid(), company text NOT NULL, ano integer NOT NULL,
  mes integer NOT NULL, opened_by uuid NOT NULL, expires_at timestamptz NOT NULL, closed_at timestamptz);
CREATE TABLE public.inventory_position (id uuid NOT NULL DEFAULT gen_random_uuid(), omie_codigo_produto bigint NOT NULL,
  product_id uuid, cmc numeric DEFAULT 0, account text NOT NULL DEFAULT 'vendas');
CREATE TABLE public.company_config (id uuid NOT NULL DEFAULT gen_random_uuid(), key text NOT NULL, value text NOT NULL);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, customer_user_id uuid NOT NULL, items jsonb NOT NULL, total numeric NOT NULL,
  status text NOT NULL, created_at timestamptz NOT NULL, account text NOT NULL, deleted_at timestamptz, order_date_kpi date);
CREATE TABLE public.order_items (id uuid NOT NULL DEFAULT gen_random_uuid(), sales_order_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  product_id uuid, quantity numeric NOT NULL, unit_price numeric);
CREATE TABLE public.picking_tasks (id uuid NOT NULL DEFAULT gen_random_uuid(), sales_order_id uuid);
CREATE TABLE public.radar_empresas (cnpj text NOT NULL, razao_social text, nome_fantasia text, municipio_nome text, uf text, telefone1 text);
CREATE TABLE public.tarefas (id uuid NOT NULL DEFAULT gen_random_uuid(), descricao text NOT NULL, categoria text NOT NULL,
  customer_user_id uuid, assigned_to uuid NOT NULL, created_by uuid NOT NULL, empresa text NOT NULL, modo text NOT NULL,
  due_date date, interacao_tipo text, auto_satisfy_mode text NOT NULL DEFAULT 'off', status text NOT NULL DEFAULT 'aberta',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_products (id uuid NOT NULL DEFAULT gen_random_uuid(), omie_codigo_produto bigint NOT NULL, descricao text NOT NULL,
  valor_unitario numeric NOT NULL DEFAULT 0, ativo boolean NOT NULL DEFAULT true, familia text, account text NOT NULL DEFAULT 'oben');
CREATE TABLE public.sku_parametros (id uuid NOT NULL DEFAULT gen_random_uuid(), empresa text NOT NULL, sku_codigo_omie bigint NOT NULL,
  sku_descricao text, habilitado_reposicao_automatica boolean DEFAULT false);
CREATE TABLE public.eventos_outlier (id bigserial PRIMARY KEY, empresa text NOT NULL, sku_codigo_omie text NOT NULL, sku_descricao text,
  tipo text NOT NULL, severidade text NOT NULL, data_evento date NOT NULL, detalhes jsonb, status text NOT NULL DEFAULT 'pendente');
CREATE TABLE public.promocao_campanha (id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, nome text NOT NULL,
  tipo_origem text NOT NULL, data_inicio date NOT NULL, data_fim date NOT NULL, estado text NOT NULL DEFAULT 'rascunho',
  data_corte_pedido date, CONSTRAINT ck_periodo_coerente CHECK (data_fim >= data_inicio));
CREATE TABLE public.fornecedor_alerta (id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text, tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info', titulo text NOT NULL, mensagem text, campanha_id bigint, data_evento timestamptz,
  status text DEFAULT 'pendente_notificacao');
CREATE TABLE public.vendas_sync_cursor (account text NOT NULL, date_from date NOT NULL, date_to date NOT NULL, next_page integer,
  completed_at timestamptz, UNIQUE (account, date_from, date_to));
SQL

# ── helpers de arquivo (python, contagem EXATA de cada padrão: troca que não pegou é erro) ──
extrair() {   # <arquivo> <marcador de início> <saída> — o bloco CREATE … $function$; VERBATIM
  python3 - "$1" "$2" "$3" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read(); marca = sys.argv[2]
ini = s.find(marca); fim = s.find('$function$;', ini) if ini >= 0 else -1
if ini < 0 or fim < 0 or s.count(marca) != 1:
    sys.exit('marcador ausente ou ambiguo em %s: %r' % (sys.argv[1], marca))
open(sys.argv[3], 'w', encoding='utf-8').write(s[ini:fim + len('$function$;')] + '\n')
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

T=fin_period_lock_trigger; G=get_regua_preco; L=listar_pedidos_a_separar; R=radar_atribuir_tarefa
O=sincronizar_ativo_omie_para_reposicao; C=trg_campanha_gera_alerta; V=vendas_sync_semear_janela
SIG_T="public.$T()"; SIG_G="public.$G(uuid,uuid,numeric,numeric,numeric[])"; SIG_L="public.$L(text)"
SIG_R="public.$R(text,integer)"; SIG_O="public.$O()"; SIG_C="public.$C()"; SIG_V="public.$V(date,date,text[])"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — OS PREDECESSORES, da fixture VERBATIM da prod (Lei #1: nada de stub da lógica), com o ACL
# de prod: as 4 RPCs fechadas a PUBLIC/anon e abertas a authenticated/service_role; a trava contábil
# só para service_role; os 2 gatilhos de reposição/campanha com o default (PUBLIC), como na prod. E
# os 3 gatilhos, com a definição de prod (pg_get_triggerdef).
#   H1: o md5 EXATO de cada predecessor instalado é o medido na prod — as constantes da PRE.
#   H2: onde há CREATE no repo, a fixture é ele módulo comentário (a deriva medida é só `--`).
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$FIXTURE"
P -q <<SQL
REVOKE ALL ON FUNCTION $SIG_G, $SIG_L, $SIG_R, $SIG_V FROM PUBLIC;
GRANT EXECUTE ON FUNCTION $SIG_G, $SIG_L, $SIG_R, $SIG_V TO authenticated, service_role;
REVOKE ALL ON FUNCTION $SIG_T FROM PUBLIC;
GRANT EXECUTE ON FUNCTION $SIG_T TO service_role;
CREATE TRIGGER trg_period_lock BEFORE DELETE OR UPDATE ON public.fin_categoria_dre_mapping
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();
CREATE TRIGGER trg_campanha_alerta AFTER INSERT OR UPDATE OF estado ON public.promocao_campanha
  FOR EACH ROW EXECUTE FUNCTION trg_campanha_gera_alerta();
CREATE TRIGGER tr_sincronizar_ativo_omie AFTER UPDATE OF ativo ON public.omie_products
  FOR EACH ROW WHEN ((old.ativo IS DISTINCT FROM new.ativo)) EXECUTE FUNCTION sincronizar_ativo_omie_para_reposicao();
SQL
V_H1=$(Pq -c "SELECT count(*) FILTER (WHERE md5(p.prosrc) = x.md5) || '/' || count(*)
  FROM (VALUES ('$SIG_T','34996f6165e69db0e65fbce70b0862fa'), ('$SIG_G','a125d14b19197bac9c98e2b8f33d2422'),
               ('$SIG_L','a0e5ef170f650b7ebe51b96eba32f0e6'), ('$SIG_R','24799f0029fac5792ab2798e8fed1c93'),
               ('$SIG_O','041603ce75f1122d483073d5a1187bf8'), ('$SIG_C','8b4deafcc3a9dee8971e04f30f2dc831'),
               ('$SIG_V','4954c2eb57b40dcf3030b023aad959ba')) x(sig, md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(x.sig);" 2>&1 || true)
eq H1 "os 7 predecessores da fixture = os corpos de prod (md5 exato, psql-ro 2026-09-29)" "$V_H1" "7/7"
V_H2=$(python3 - "$REPO_ROOT" "$FIXTURE" <<'PY' 2>&1 || true
import re, sys
raiz, fixture = sys.argv[1], sys.argv[2]
origem = {'fin_period_lock_trigger': '20260524102500_fix_fin_triggers_json_field_access.sql',
          'get_regua_preco': '20260723150000_authz_custo_fu4f_fase2_regua.sql',
          'listar_pedidos_a_separar': '20260604120000_picking_bridge.sql',
          'radar_atribuir_tarefa': '20260613190000_radar_fatia3.sql',
          'vendas_sync_semear_janela': '20260726140000_vendas_sync_semear_janela_v2.sql'}
def corpo(txt, nome):
    ini = [m.start() for m in re.finditer(r'CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?' + nome + r'\s*\(', txt, re.I)][-1]
    m = re.search(r'\bAS\s+(\$[A-Za-z_]*\$)', txt[ini:], re.I)
    a = ini + m.end(); return txt[a:txt.index(m.group(1), a)]
sem = lambda s: re.sub(r'\s+', ' ', re.sub(r'--[^\n]*', '', s)).strip()
fx = open(fixture, encoding='utf-8').read()
iguais = sum(sem(corpo(open(f'{raiz}/supabase/migrations/{arq}', encoding='utf-8').read(), n)) == sem(corpo(fx, n)) for n, arq in origem.items())
print(f'{iguais}/{len(origem)}')
PY
)
eq H2 "onde há CREATE no repo, a fixture é a última definição dele módulo comentário" "$V_H2" "5/5"

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
    sabotar_arquivo "$MIG_X1" "IF r.vivo IS NOT NULL AND r.vivo NOT IN" "IF false AND r.vivo IS NOT NULL AND r.vivo NOT IN" 1 ;;
  # a PRE que não reconhece o próprio corpo: re-aplicar (idempotência do envelope) abortaria
  pre_sem_reaplicacao) MIG_X2="$TMPD/mig_x2.sql"
    sabotar_arquivo "$MIG_X2" "'24799f0029fac5792ab2798e8fed1c93', '2cec8056bf553b87d6329394c1f30779')" \
      "'24799f0029fac5792ab2798e8fed1c93', 'sabotado')" 1 ;;
  # sem o GRANT: onde a função NASCE aqui sem default ACL, authenticated (o staff pelo PostgREST)
  # ficaria sem EXECUTE — vermelha no X3; no X3s o default do Supabase já dá a porta
  sem_grant_authenticated) MIG_X3="$TMPD/mig_x3.sql"
    sabotar_arquivo "$MIG_X3" " TO authenticated, service_role;" " TO service_role;" 4 ;;
  # o REVOKE só de PUBLIC: com o default ACL do Supabase a função nasce com EXECUTE DIRETO a anon,
  # que um REVOKE de PUBLIC não tira — vermelha no X3s; no X3 (sem default) anon nunca teve a porta
  revoke_sem_anon) MIG_X3="$TMPD/mig_x3.sql"
    sabotar_arquivo "$MIG_X3" " FROM PUBLIC, anon;" " FROM PUBLIC;" 4 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# X — OS CAMINHOS DECLARADOS DA MIGRATION: deriva ABORTA (numa RPC e num gatilho), função ausente
# NASCE com o fecho PORTA_GATE (sem e com o default ACL do Supabase), re-aplicar é seguro. X1/X3
# rodam numa transação que volta atrás; o apply de verdade e a re-aplicação usam `psql -1` — a
# transação única do executor (db:aplicar).
# ══════════════════════════════════════════════════════════════════════════════
echo "── caminhos da migration ──"
deriva() {   # <id> <descrição> <função> <de> <para>
  local id="$1" descr="$2" fn="$3" pred tmp out rc=0
  pred="$(mktemp "$TMPD/pred.XXXXXX")"; tmp="$(mktemp "$TMPD/deriva.XXXXXX")"
  if ! { extrair "$FIXTURE" "CREATE OR REPLACE FUNCTION public.$fn(" "$pred" && trocar "$pred" "$tmp" "$4" "$5" 1; }; then
    erro_exec "$id" "$descr — a deriva não se aplicou ao predecessor"; return 0
  fi
  out="$(P -q 2>&1 <<SQL
BEGIN;
\i $tmp
\i $MIG_X1
ROLLBACK;
SQL
)" || rc=$?
  # Casamento nativo do bash (sem pipe): o veredito não depende de pipefail nem de quem sai primeiro.
  if [ "$rc" -ne 0 ] && [[ $out == *"PRE FALHOU: o corpo vivo de public.$fn("* ]]; then
    ok "$id" "$descr"
  elif [ "$rc" -eq 0 ]; then
    bad "$id" "$descr — a migration APLICOU sobre o corpo derivado: a PRE deixou passar"
  else
    erro_exec "$id" "$descr — falhou, mas não pela PRE da função derivada (${#out} bytes; saída inteira abaixo)"
    printf '%s\n' "$out" | sed 's/^/     ↳ /'
  fi
}
deriva X1a "corpo vivo do radar derivado (teto 91 dias) → a PRE aborta" "$R" \
  "LEAST(COALESCE(p_dias_retomada, 7), 90)" "LEAST(COALESCE(p_dias_retomada, 7), 91)"
deriva X1b "corpo vivo do gatilho de campanha derivado (severidade) → a PRE aborta" "$C" \
  "'promocao_suspensa', 'urgente'" "'promocao_suspensa', 'alta'"

# Nascimento: as 7 AUSENTES (os gatilhos saem antes, senão o DROP da função não passa); a migration
# as cria. Em DOIS mundos (parecer Codex no irmão): sem default ACL, é o GRANT que dá a porta a
# authenticated (X3); com o default ACL do Supabase (medido em prod: funções de public → EXECUTE a
# anon/authenticated/service_role) a RPC nasce com EXECUTE DIRETO a anon, e é o REVOKE nominal de
# anon que fecha (X3s). O aborto da POS é VEREDITO, não erro de execução.
nascimento() {   # <id> <descrição> <DDL a rodar antes, na mesma transação — ou vazio>
  local id="$1" descr="$2" antes="$3" out rc=0 v
  out="$(P -q -tA -F '|' 2>&1 <<SQL
BEGIN;
$antes
DROP TRIGGER trg_period_lock ON public.fin_categoria_dre_mapping;
DROP TRIGGER trg_campanha_alerta ON public.promocao_campanha;
DROP TRIGGER tr_sincronizar_ativo_omie ON public.omie_products;
DROP FUNCTION $SIG_T, $SIG_G, $SIG_L, $SIG_R, $SIG_O, $SIG_C, $SIG_V;
\i $MIG_X3
SELECT '$id', f.a, f.p, f.u, f.dono, f.n FROM (
  SELECT string_agg(has_function_privilege('anon', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) FILTER (WHERE x.rpc) AS a,
         string_agg(has_function_privilege('public', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) FILTER (WHERE x.rpc) AS p,
         string_agg(has_function_privilege('authenticated', x.oid, 'EXECUTE')::text, ',' ORDER BY x.n) FILTER (WHERE x.rpc) AS u,
         string_agg(DISTINCT pg_get_userbyid(x.proowner), ',') AS dono, count(*) AS n
    FROM (SELECT o.n, p.oid, p.proowner, o.rpc FROM (VALUES (1,'$SIG_G',true),(2,'$SIG_L',true),(3,'$SIG_R',true),(4,'$SIG_V',true),
            (5,'$SIG_T',false),(6,'$SIG_O',false),(7,'$SIG_C',false)) o(n, sig, rpc)
          JOIN pg_proc p ON p.oid = to_regprocedure(o.sig)) x) f;
ROLLBACK;
SQL
)" || rc=$?
  v="$(printf '%s\n' "$out" | grep "^$id|" || true)"
  if [ "$rc" -eq 0 ]; then
    eq "$id" "$descr" "$v" "$id|false,false,false,false|false,false,false,false|true,true,true,true|postgres|7"
  elif [[ $out =~ POS[0-9]\ FALHOU ]]; then
    bad "$id" "$descr — a migration abortou ao nascer: $(printf '%s' "$out" | grep -o 'POS[0-9] FALHOU[^—]*' | head -1)"
  else
    erro_exec "$id" "$descr — falhou, mas não pela POS: $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
  fi
}
nascimento X3 "as 7 AUSENTES, cluster sem default ACL: as 4 RPCs nascem PORTA_GATE (anon/PUBLIC não, authenticated sim), dono postgres" ""
nascimento X3s "as 7 AUSENTES com o default ACL do Supabase (EXECUTE direto a anon): o mesmo contrato" \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"

rc=0; out="$(P -1 -q -f "$MIG_NOVA" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] || [[ $out != *'POS OK:'* ]]; then
  echo "❌ INFRA: a migration nova não aplicou (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"; exit 1
fi
echo "migration aplicada: $(basename "$MIG_NOVA") (PRE e POS passaram, transação única)"

rc=0; out="$(P -1 -q -f "$MIG_X2" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && [[ $out == *'POS OK:'* ]]; then
  ok X2 "re-aplicar a migration sobre ela mesma é seguro (a PRE reconhece o próprio corpo)"
elif [ "$rc" -ne 0 ] && [[ $out == *'PRE FALHOU'* ]]; then
  bad X2 "a re-aplicação ABORTOU na PRE — a migration não é idempotente"
else
  erro_exec X2 "re-aplicação sem veredito (rc=$rc): $(printf '%s' "$out" | tr '\n' ' ' | head -c 200)"
fi

# ── SABOTAGEM de CORPO (só no modo --falsificar) — no BANCO, recriando a função a partir do bloco da
# migration nova com o trecho trocado; o repo nunca é tocado. Cada padrão tem de ocorrer exatamente
# n× no corpo. Vem DEPOIS do X2 (a re-aplicação desfaria a sabotagem) e ANTES do relógio (o CREATE
# OR REPLACE traria o search_path de prod).
sabotar() {   # <função> <de> <para> <n> [<de> <para> <n> ...]
  local fn="$1" bloco sab; shift
  bloco="$(mktemp "$TMPD/bloco.XXXXXX")"; sab="$(mktemp "$TMPD/sab.XXXXXX")"
  if ! { extrair "$MIG_NOVA" "CREATE OR REPLACE FUNCTION public.$fn(" "$bloco" && trocar "$bloco" "$sab" "$@"; }; then
    echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9
  fi
  P -q -f "$sab" >/dev/null
}
HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
PED="(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date"
todas_com() {   # <expressão no lugar do hoje de SP> — as 7, cada uma com a contagem exata do seu corpo
  sabotar "$T" "$HOJE" "$1" 1; sabotar "$G" "$HOJE" "$1" 2; sabotar "$L" "$HOJE" "$1" 1
  sabotar "$R" "$HOJE" "$1" 1; sabotar "$O" "$HOJE" "$1" 2; sabotar "$C" "$HOJE" "$1" 1; sabotar "$V" "$HOJE" "$1" 1
}
case "$SABOTAGEM" in
  ""|pre_cega|pre_sem_reaplicacao|sem_grant_authenticated|revoke_sem_anon) ;;
  # o defeito de volta, na forma que o relógio controlado alcança: `now()::date` É o current_date
  # (a data do início da transação no fuso da SESSÃO); o instante do pedido volta a `::date` da sessão
  current_date_de_volta) todas_com "now()::date"; sabotar "$L" "$PED" "so.created_at::date" 3 ;;
  # o literal, exatamente o token de cada predecessor: o corpo volta a SER o predecessor (D1 verde)
  current_date_literal) sabotar "$T" "$HOJE" "current_date" 1; sabotar "$G" "$HOJE" "current_date" 2
    sabotar "$L" "$HOJE" "current_date" 1 "$PED" "so.created_at::date" 3; sabotar "$R" "$HOJE" "current_date" 1
    sabotar "$O" "$HOJE" "CURRENT_DATE" 2; sabotar "$C" "$HOJE" "CURRENT_DATE" 1; sabotar "$V" "$HOJE" "current_date" 1 ;;
  # o hoje em UTC, qualquer que seja a sessão: vermelha nas DUAS sessões
  hoje_em_utc) todas_com "(now() AT TIME ZONE 'UTC')::date" ;;
  # o hoje tirado do relógio de parede, que o controlado não intercepta
  hora_de_parede) todas_com "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date" ;;
  # não sabotam corpo: pulam o ALTER do search_path / o pin do relógio, logo abaixo
  relogio_desligado|sem_pin) ;;
  # UM sítio por vez nas funções com mais de um (a camada que fica verde é redundante ou inalcançada)
  regua_so_cliente) sabotar "$G" "so.order_date_kpi >= $HOJE - interval '180 days';" "so.order_date_kpi >= now()::date - interval '180 days';" 1 ;;
  regua_so_comparaveis) sabotar "$G" "so.order_date_kpi >= $HOJE - interval '180 days'
  )" "so.order_date_kpi >= now()::date - interval '180 days'
  )" 1 ;;
  picking_so_data) sabotar "$L" "COALESCE(so.order_date_kpi, $PED) AS data" "COALESCE(so.order_date_kpi, so.created_at::date) AS data" 1 ;;
  picking_so_janela) sabotar "$L" ">= $HOJE - 60" ">= now()::date - 60" 1 ;;
  picking_so_filtro_pedido) sabotar "$L" "AND COALESCE(so.order_date_kpi, $PED) >=" "AND COALESCE(so.order_date_kpi, so.created_at::date) >=" 1 ;;
  omie_so_inativado) sabotar "$O" "'sku_inativado_omie', 'atencao', $HOJE" "'sku_inativado_omie', 'atencao', now()::date" 1 ;;
  omie_so_reativado) sabotar "$O" "'sku_reativado_omie', 'info', $HOJE" "'sku_reativado_omie', 'info', now()::date" 1 ;;
  # o ACL reaberto para anon (o gate do corpo passa a ser a única barreira)
  acl_anon_aberta) P -q -c "GRANT EXECUTE ON FUNCTION $SIG_G, $SIG_L, $SIG_R, $SIG_V TO anon;" ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
case "$SABOTAGEM" in
  ""|pre_cega|pre_sem_reaplicacao|sem_grant_authenticated|revoke_sem_anon) ;;
  *) echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# D — A FORMA DO CORPO INSTALADO: cada corpo novo, com a expressão trocada de VOLTA pelo token do
# predecessor, tem de ter o md5 EXATO do predecessor ⇒ a troca é a ÚNICA diferença (gates, ACL de
# corpo, ORDER BY do picking: tudo o resto é o texto de prod).
# ══════════════════════════════════════════════════════════════════════════════
echo "── forma do corpo instalado ──"
H_SQL="(now() AT TIME ZONE ''America/Sao_Paulo'')::date"
P_SQL="(so.created_at AT TIME ZONE ''America/Sao_Paulo'')::date"
V_D1=$(Pq -c "SELECT count(*) FILTER (WHERE md5(x.volta) = x.pred) || '/' || count(*) FROM (
    SELECT replace(p.prosrc, '$H_SQL', 'current_date'), '34996f6165e69db0e65fbce70b0862fa' FROM pg_proc p WHERE p.oid = '$SIG_T'::regprocedure
    UNION ALL SELECT replace(p.prosrc, '$H_SQL', 'current_date'), 'a125d14b19197bac9c98e2b8f33d2422' FROM pg_proc p WHERE p.oid = '$SIG_G'::regprocedure
    UNION ALL SELECT replace(replace(p.prosrc, '$P_SQL', 'so.created_at::date'), '$H_SQL', 'current_date'), 'a0e5ef170f650b7ebe51b96eba32f0e6'
                FROM pg_proc p WHERE p.oid = '$SIG_L'::regprocedure
    UNION ALL SELECT replace(p.prosrc, '$H_SQL', 'current_date'), '24799f0029fac5792ab2798e8fed1c93' FROM pg_proc p WHERE p.oid = '$SIG_R'::regprocedure
    UNION ALL SELECT replace(p.prosrc, '$H_SQL', 'CURRENT_DATE'), '041603ce75f1122d483073d5a1187bf8' FROM pg_proc p WHERE p.oid = '$SIG_O'::regprocedure
    UNION ALL SELECT replace(p.prosrc, '$H_SQL', 'CURRENT_DATE'), '8b4deafcc3a9dee8971e04f30f2dc831' FROM pg_proc p WHERE p.oid = '$SIG_C'::regprocedure
    UNION ALL SELECT replace(p.prosrc, '$H_SQL', 'current_date'), '4954c2eb57b40dcf3030b023aad959ba' FROM pg_proc p WHERE p.oid = '$SIG_V'::regprocedure
  ) x(volta, pred);" 2>&1 || true)
eq D1 "as 7 instaladas = predecessor + exatamente a troca do hoje (e do instante do pedido)" "$V_D1" "7/7"

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — `public.now()` lê a GUC `test.agora` e é um TRIPWIRE: sem ela, levanta
# exceção com SQLSTATE PRÓPRIO (Z9T01). SÓ as 7 funções sob teste ganham `pg_catalog` DEPOIS de
# `public` no search_path — é a única forma de um nome de usuário vencer um embutido.
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
# O ALTER muda o proconfig das 7 em relação à prod: confira o ORIGINAL antes (R1) e restaure-o no
# fim, para o smoke rodar sobre as funções exatamente como a prod as vê.
CFG_Q="SELECT string_agg(array_to_string(p.proconfig, ';'), ' | ' ORDER BY o.n)
         FROM (VALUES (1,'$SIG_T'),(2,'$SIG_G'),(3,'$SIG_L'),(4,'$SIG_R'),(5,'$SIG_O'),(6,'$SIG_C'),(7,'$SIG_V')) o(n, sig)
         JOIN pg_proc p ON p.oid = to_regprocedure(o.sig);"
CFG_PROD='search_path=public | search_path=public | search_path=public | search_path=public | search_path=public, pg_temp | search_path=public, pg_temp | search_path=""'
V_R1=$(Pq -c "$CFG_Q" 2>&1 || true)   # (V é o nome da função do semeador: nunca rascunho)
eq R1 "proconfig das 7, antes do relógio (o de prod)" "$V_R1" "$CFG_PROD"
if [ "$SABOTAGEM" != relogio_desligado ]; then
  for s in "$SIG_T" "$SIG_G" "$SIG_L" "$SIG_R" "$SIG_O" "$SIG_C" "$SIG_V"; do
    P -q -c "ALTER FUNCTION $s SET search_path = public, pg_catalog, pg_temp;"
  done
fi
# O pin: TODA conexão nova nasce em 01/03/2025 15:00Z (12:00 BRT: a data é a mesma nos dois fusos).
# O bloco B troca o instante na própria sessão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-03-01 15:00:00+00';"
fi

# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA
# assinatura de um embutido passaria a vencê-lo — inclusive as que o corpo chama por sintaxe
# (`AT TIME ZONE` é `timezone(...)`). A guarda exige que o ÚNICO nome de `public` que sombreia
# `pg_catalog` seja o nosso now(). Controle POSITIVO: se não vê nem esse, está cega e aborta.
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
# ZONA 3 — SEED. D = 28/02/2025 (SP). Borda do dia de SP: 01/03 00:00:00 BRT = 01/03 03:00:00Z.
#   T  oben com fevereiro/2025 FECHADO e aprovado: o último dia fechado é D. Um mapeamento DRE.
#   G  cliente CG, produto PG, conta oben: preços do cliente 11 (kpi 01/09/24 = D−180, a borda),
#      12 (02/09/24) e 13 (31/08/24, sempre fora); comparáveis (cliente CX, qtd 1 na banda de p_qty=1)
#      21/22/23 nas mesmas datas.
#   L  conta oben, sem picking: L1 sem kpi, criado 01/03 01:00Z (= 22:00 BRT de D: a data de SP é D);
#      L2 kpi 30/12/24 (= D−60, a borda); L3 kpi 27/02/25; L4 sem kpi, criado 30/12/24 01:00Z (=
#      29/12 22:00 BRT: fora da janela em SP, dentro se o instante virar data na sessão UTC).
#   R  CNPJ do radar; o master tem a carteira completa.
#   O  SKU 5001 ativo no Omie e com reposição automática ligada.
#   C  (criada no bloco B, uma campanha por instante: ativa, vigência 01/02 → D.)
#   V  (o cursor é limpo a cada chamada.)
# Esperado NAS DUAS SESSÕES (tA · tB · tC · tD), conferido à mão contra a regra de SP:
#   T TRAVADA ×3 · LIBERADA   G 12,11/21,22 ×3 · 12/22   R 07/03 ×3 · 08/03   O D/D ×3 · D+1/D+1
#   L (30/12, 27/02, 28/02) ×3 · (27/02, 28/02)   C 1 ×3 · 0   V RECUSADA ×3 · semeada
# O corpo antigo, sob sessão UTC, erra em tB e tC (o dia da sessão já é D+1) — e o L, em todo instante
# (o created_at::date do L1 é D+1 e o do L4 entra em tA).
# ══════════════════════════════════════════════════════════════════════════════
MASTER=33333333-3333-3333-3333-333333333333
EMPLOYEE=22222222-2222-2222-2222-222222222222
CG=c9000000-0000-0000-0000-000000000001
CX=c9000000-0000-0000-0000-000000000002
CL=c9000000-0000-0000-0000-000000000003
PG=a9000000-0000-0000-0000-000000000001
CNPJ=11111111000191
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'), ('$EMPLOYEE'), ('$CG'), ('$CX'), ('$CL');
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER', 'master'), ('$EMPLOYEE', 'employee');

INSERT INTO public.fin_fechamentos(company, ano, mes, status, aprovado_em) VALUES ('oben', 2025, 2, 'fechado', '2025-02-10 12:00:00+00');
INSERT INTO public.fin_categoria_dre_mapping(company, omie_codigo) VALUES ('oben', '1.01.01');

INSERT INTO public.sales_orders(id, customer_user_id, items, total, status, created_at, account, deleted_at, order_date_kpi) VALUES
  ('9a000000-0000-0000-0000-000000000001', '$CG', '[]', 11, 'faturado', '2024-09-01 12:00:00+00', 'oben', NULL, '2024-09-01'),
  ('9a000000-0000-0000-0000-000000000002', '$CG', '[]', 12, 'faturado', '2024-09-02 12:00:00+00', 'oben', NULL, '2024-09-02'),
  ('9a000000-0000-0000-0000-000000000003', '$CG', '[]', 13, 'faturado', '2024-08-31 12:00:00+00', 'oben', NULL, '2024-08-31'),
  ('9a000000-0000-0000-0000-000000000004', '$CX', '[]', 21, 'faturado', '2024-09-01 12:00:00+00', 'oben', NULL, '2024-09-01'),
  ('9a000000-0000-0000-0000-000000000005', '$CX', '[]', 22, 'faturado', '2024-09-02 12:00:00+00', 'oben', NULL, '2024-09-02'),
  ('9a000000-0000-0000-0000-000000000006', '$CX', '[]', 23, 'faturado', '2024-08-31 12:00:00+00', 'oben', NULL, '2024-08-31');
INSERT INTO public.order_items(sales_order_id, customer_user_id, product_id, quantity, unit_price)
SELECT so.id, so.customer_user_id, '$PG', 1, so.total FROM public.sales_orders so WHERE so.id::text LIKE '9a%';

INSERT INTO public.sales_orders(id, customer_user_id, items, total, status, created_at, account, deleted_at, order_date_kpi) VALUES
  ('9b000000-0000-0000-0000-000000000001', '$CL', '[]', 1, 'faturado', '2025-03-01 01:00:00+00', 'oben', NULL, NULL),
  ('9b000000-0000-0000-0000-000000000002', '$CL', '[]', 2, 'faturado', '2024-12-30 12:00:00+00', 'oben', NULL, '2024-12-30'),
  ('9b000000-0000-0000-0000-000000000003', '$CL', '[]', 3, 'faturado', '2025-02-27 12:00:00+00', 'oben', NULL, '2025-02-27'),
  ('9b000000-0000-0000-0000-000000000004', '$CL', '[]', 4, 'faturado', '2024-12-30 01:00:00+00', 'oben', NULL, NULL);

INSERT INTO public.radar_empresas(cnpj, razao_social, nome_fantasia, municipio_nome, uf, telefone1)
VALUES ('$CNPJ', 'Movelaria Teste Ltda', 'Movelaria Teste', 'Curitiba', 'PR', '4133330000');

INSERT INTO public.omie_products(omie_codigo_produto, descricao, valor_unitario, ativo, familia, account) VALUES (5001, 'Verniz PU', 10, true, 'F', 'oben');
INSERT INTO public.sku_parametros(empresa, sku_codigo_omie, sku_descricao, habilitado_reposicao_automatica) VALUES ('oben', 5001, 'Verniz PU', true);
-- a campanha que a sonda R0C cancela (o INSERT dispara só o ramo 'ativa' do gatilho, que não lê o hoje)
INSERT INTO public.promocao_campanha(empresa, fornecedor_nome, nome, tipo_origem, data_inicio, data_fim, estado)
VALUES ('oben', 'RENNER SAYERLACK S/A', 'R0', 'fornecedor_impoe', '2025-02-01', '2025-02-28', 'ativa');
SQL
# Extrai o valor de uma linha `<tag>|valor` da saída; sem a linha, devolve a SAÍDA CRUA achatada —
# que o eq classifica (erro de psql/tripwire vira ERRO_DE_EXECUCAO com o texto à vista).
linha() { local v; v="$(printf '%s\n' "$2" | grep "^$1|" | cut -d'|' -f2 || true)"
          if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$2" | tr '\n' ' ' | head -c 300; fi; }

# As leituras de cada função num instante — um valor DECLARADO sempre (nunca a string vazia, que o
# eq trata como erro). Os desfechos que são exceções da própria regra (a trava, a guarda anti-futuro)
# viram VALOR por captura da SQLSTATE certa + a mensagem nossa (ASCII); qualquer outro erro relança.
LER_T="DO \$t\$ DECLARE v text; BEGIN
  BEGIN UPDATE public.fin_categoria_dre_mapping SET omie_codigo = omie_codigo WHERE company = 'oben'; v := 'LIBERADA';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'PERIOD_LOCKED:%' THEN v := 'TRAVADA'; ELSE RAISE; END IF; END;
  PERFORM set_config('teste.t', v, false); END \$t\$;
SELECT 'T', current_setting('teste.t');"
LER_G="SELECT 'G', coalesce((SELECT string_agg(e.x, ',' ORDER BY e.o) FROM jsonb_array_elements_text(q.j->'precos_cliente') WITH ORDINALITY e(x, o)), '-')
    || '/' || coalesce((SELECT string_agg(c->>'preco', ',' ORDER BY (c->>'preco')::numeric) FROM jsonb_array_elements(q.j->'comparaveis') c), '-')
  FROM (SELECT public.get_regua_preco('$CG'::uuid, '$PG'::uuid, 1, 100, NULL) AS j) q;"
LER_L="SELECT 'L', coalesce(string_agg(l.data::text, ',' ORDER BY l.data, l.total), 'VAZIO') FROM public.listar_pedidos_a_separar('oben') l;"
LER_R="DO \$r\$ DECLARE j jsonb; d date; BEGIN
  j := public.radar_atribuir_tarefa('$CNPJ', 7);
  SELECT t.due_date INTO d FROM public.tarefas t WHERE t.id = (j->>'id')::uuid;
  DELETE FROM public.tarefas;
  PERFORM set_config('teste.r', coalesce(d::text, 'SEM_TAREFA'), false); END \$r\$;
SELECT 'R', current_setting('teste.r');"
LER_O="DO \$o\$ DECLARE a text; b text; BEGIN
  UPDATE public.omie_products SET ativo = false WHERE omie_codigo_produto = 5001;
  UPDATE public.omie_products SET ativo = true WHERE omie_codigo_produto = 5001;
  SELECT string_agg(e.data_evento::text, ',') INTO a FROM public.eventos_outlier e WHERE e.tipo = 'sku_inativado_omie';
  SELECT string_agg(e.data_evento::text, ',') INTO b FROM public.eventos_outlier e WHERE e.tipo = 'sku_reativado_omie';
  DELETE FROM public.eventos_outlier;
  UPDATE public.sku_parametros SET habilitado_reposicao_automatica = true WHERE sku_codigo_omie = 5001;
  PERFORM set_config('teste.o', coalesce(a, 'NENHUM') || '/' || coalesce(b, 'NENHUM'), false); END \$o\$;
SELECT 'O', current_setting('teste.o');"
LER_C="DO \$c\$ DECLARE cid bigint; n int; BEGIN
  INSERT INTO public.promocao_campanha(empresa, fornecedor_nome, nome, tipo_origem, data_inicio, data_fim, estado)
  VALUES ('oben', 'RENNER SAYERLACK S/A', 'Camp teste', 'fornecedor_impoe', '2025-02-01', '2025-02-28', 'ativa') RETURNING id INTO cid;
  UPDATE public.promocao_campanha SET estado = 'cancelada' WHERE id = cid;
  SELECT count(*) INTO n FROM public.fornecedor_alerta a WHERE a.campanha_id = cid AND a.tipo = 'promocao_suspensa';
  PERFORM set_config('teste.c', n::text, false); END \$c\$;
SELECT 'C', current_setting('teste.c');"
LER_V="DO \$v\$ DECLARE j jsonb; v text; BEGIN
  DELETE FROM public.vendas_sync_cursor;
  BEGIN j := public.vendas_sync_semear_janela('2025-02-27', '2025-03-01', ARRAY['oben']); v := j->'contas'->0->>'desfecho';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'janela invalida: date_to (%) no futuro' THEN v := 'RECUSADA'; ELSE RAISE; END IF; END;
  PERFORM set_config('teste.v', coalesce(v, 'SEM_DESFECHO'), false); END \$v\$;
SELECT 'V', current_setting('teste.v');"

# ══════════════════════════════════════════════════════════════════════════════
# R — AS FUNÇÕES LEEM O RELÓGIO CONTROLADO. R0: cada uma, com o gate satisfeito e fixture elegível,
# chamada SEM `test.agora`, tem de bater no TRIPWIRE (Z9T01) — retorno normal quer dizer que ela tirou
# o hoje de outro lugar (current_date literal, relógio de parede, search_path sem o relógio). R2: com
# o pin, o VALOR usado é o do relógio controlado.
# ══════════════════════════════════════════════════════════════════════════════
echo "── relógio controlado ──"
sonda_relogio() {   # <comando SQL que exercita a função> — imprime RELOGIO_LIDO | RELOGIO_ESCAPOU (ou o erro)
  P -q -tA 2>&1 <<SQL || true
SET test.uid = '$MASTER';
SET test.agora = '';
DO \$s\$
DECLARE v_passou boolean := false; v_tripwire boolean := false;
BEGIN
  BEGIN
    EXECUTE \$q\$ $1 \$q\$;
    v_passou := true;                    -- chegou aqui = não leu o now() controlado
  EXCEPTION
    WHEN SQLSTATE 'Z9T01' THEN v_tripwire := true;
    WHEN OTHERS THEN RAISE;              -- qualquer outro erro: relança
  END;
  IF v_tripwire THEN RAISE NOTICE 'RELOGIO_LIDO';
  ELSIF v_passou THEN RAISE NOTICE 'RELOGIO_ESCAPOU';
  END IF;
END \$s\$;
SQL
}
veredito_relogio() {   # <id> <descrição> <saída da sonda>
  case "$3" in
    *RELOGIO_LIDO*)    ok "$1" "$2" ;;
    *RELOGIO_ESCAPOU*) bad "$1" "$2 — a função respondeu sem ler o relógio controlado" ;;
    *)                 erro_exec "$1" "$2 — sonda sem veredito: $(printf '%s' "$3" | tr '\n' ' ' | head -c 200)" ;;
  esac
}
veredito_relogio R0T "trava contábil lê o relógio controlado" \
  "$(sonda_relogio "UPDATE public.fin_categoria_dre_mapping SET omie_codigo = omie_codigo WHERE company = 'oben'")"
veredito_relogio R0G "régua lê o relógio controlado" \
  "$(sonda_relogio "SELECT public.get_regua_preco('$CG'::uuid, '$PG'::uuid, 1, 100, NULL)")"
veredito_relogio R0L "picking lê o relógio controlado" "$(sonda_relogio "SELECT count(*) FROM public.listar_pedidos_a_separar('oben')")"
veredito_relogio R0R "radar lê o relógio controlado" "$(sonda_relogio "SELECT public.radar_atribuir_tarefa('$CNPJ', 7)")"
veredito_relogio R0O "gatilho do Omie lê o relógio controlado" \
  "$(sonda_relogio "UPDATE public.omie_products SET ativo = NOT ativo WHERE omie_codigo_produto = 5001")"
# (a campanha 'R0' é do seed: num CTE, o UPDATE não enxergaria a linha que o próprio INSERT criou)
veredito_relogio R0C "gatilho de campanha lê o relógio controlado" \
  "$(sonda_relogio "UPDATE public.promocao_campanha SET estado = 'cancelada' WHERE nome = 'R0'")"
veredito_relogio R0V "semeador de janela lê o relógio controlado" \
  "$(sonda_relogio "SELECT public.vendas_sync_semear_janela('2025-02-27', '2025-02-28', ARRAY['oben'])")"
eq R2 "radar no pin (01/03 12:00 BRT): hoje-SP = 01/03, retomada em 7 dias" "$(linha R "$(Pq -c "SET test.uid='$MASTER'; $LER_R" 2>&1 || true)")" "2025-03-08"

# ══════════════════════════════════════════════════════════════════════════════
# A — O ACL, como o PostgREST chama (SET ROLE anon): as 4 RPCs recusam anon ANTES do gate do corpo
# (pela mensagem de privilégio com o nome da função, presente em qualquer lc_messages). É o caminho
# de upgrade: o predecessor tinha o ACL de prod e o CREATE OR REPLACE o preserva.
# ══════════════════════════════════════════════════════════════════════════════
echo "── ACL ──"
# Três desfechos, todos VALOR: ACL (a recusa de privilégio que nomeia a função — em qualquer
# lc_messages), GATE (a mensagem EXATA do gate do corpo, nossa e ASCII: o ACL deixou passar) ou PASSOU.
# Qualquer outro erro relança. Com o ACL reaberto a anon, o veredito vira GATE: vermelho por resultado.
acl_anon() {   # <chamada> <nome da função> <mensagem exata do gate do corpo>
  P -q -tA 2>&1 <<SQL || true
SET ROLE anon;
DO \$a\$
BEGIN
  BEGIN
    PERFORM $1;
    RAISE NOTICE 'VEREDITO_PASSOU';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    IF SQLERRM = '$3' THEN RAISE NOTICE 'VEREDITO_GATE';
    ELSIF SQLSTATE = '42501' AND position('$2' IN SQLERRM) > 0 THEN RAISE NOTICE 'VEREDITO_ACL';
    ELSE RAISE; END IF;
  END;
END \$a\$;
SQL
}
v_acl=""
for trio in "public.get_regua_preco('$CG'::uuid, '$PG'::uuid, 1, 100, NULL)|$G|forbidden: regua_preco exige staff" \
            "public.listar_pedidos_a_separar('oben')|$L|forbidden: staff only" \
            "public.radar_atribuir_tarefa('$CNPJ', 7)|$R|forbidden: gestor/master only" \
            "public.vendas_sync_semear_janela('2025-02-27', '2025-02-28', ARRAY['oben'])|$V|Acesso negado: requer perfil staff"; do
  chamada="${trio%%|*}"; resto="${trio#*|}"
  s="$(acl_anon "$chamada" "${resto%%|*}" "${resto#*|}")"
  case "$s" in *VEREDITO_ACL*) v_acl="${v_acl:+$v_acl,}ACL" ;; *VEREDITO_GATE*) v_acl="${v_acl:+$v_acl,}GATE" ;;
    *VEREDITO_PASSOU*) v_acl="${v_acl:+$v_acl,}PASSOU" ;;
    *) v_acl="${v_acl:+$v_acl,}ERRO:$(printf '%s' "$s" | tr '\n' ' ' | head -c 80)" ;; esac
done
eq A1 "anon NÃO executa nenhuma das 4 RPCs (barrado pelo ACL, antes do gate)" "$v_acl" "ACL,ACL,ACL,ACL"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO B — A BORDA DO DIA DE SP, cruzada de propósito, uma conexão por sessão. B0 é o controle
# POSITIVO da sessão: o TimeZone é o que foi setado E o cast ingênuo de uma data vira 00:00Z na sessão
# UTC e 03:00Z na de SP — prova que as duas rodadas são mundos diferentes.
# ══════════════════════════════════════════════════════════════════════════════
INSTANTES="2025-02-28T23:59:59Z 2025-03-01T00:00:00Z 2025-03-01T02:59:59Z 2025-03-01T03:00:00Z"
bloco_b() {   # <U|S> <TimeZone> <hh:mm esperado no cast ingênuo>
  local pfx="B$1" tz="$2" hhmm="$3" out rc=0 t f v lista
  local sql="SET TimeZone = '$tz';
SET test.uid = '$MASTER';
SELECT 'B0', current_setting('TimeZone') || '|' || to_char(('2025-03-01'::date)::timestamptz AT TIME ZONE 'UTC', 'HH24:MI');"
  for t in $INSTANTES; do
    sql="$sql
SET test.agora = '$t';
$LER_T
$LER_G
$LER_L
$LER_R
$LER_O
$LER_C
$LER_V"
  done
  out="$(P -q -tA -F '|' 2>&1 <<<"$sql")" || rc=$?
  echo "── bloco B sob sessão $tz ──"
  [ "$rc" -eq 0 ] || echo "     (psql saiu $rc na sessão $tz: $(printf '%s' "$out" | tr '\n' ' ' | head -c 300))"
  eq "${pfx}0" "sessão $tz: TimeZone e cast ingênuo de 01/03" "$(printf '%s\n' "$out" | grep '^B0|' | cut -d'|' -f2-3 || true)" "$tz|$hhmm"
  for f in T G L R O C V; do
    lista="$(printf '%s\n' "$out" | grep "^$f|" | cut -d'|' -f2 | paste -sd ';' - || true)"
    # 4 leituras ou nenhuma prova: um psql que parou no meio devolve a lista truncada — o erro vai à vista
    [ "$(printf '%s\n' "$out" | grep -c "^$f|" || true)" -eq 4 ] || lista="ERRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR' | head -c 200)"
    case "$f" in
      T) v="TRAVADA;TRAVADA;TRAVADA;LIBERADA";                     d="trava contábil do último dia fechado" ;;
      G) v="12,11/21,22;12,11/21,22;12,11/21,22;12/22";              d="régua: janela de 180 dias (cliente/comparáveis)" ;;
      L) v="2024-12-30,2025-02-27,2025-02-28;2024-12-30,2025-02-27,2025-02-28;2024-12-30,2025-02-27,2025-02-28;2025-02-27,2025-02-28"
                                                                     d="picking: data exibida e janela de 60 dias" ;;
      R) v="2025-03-07;2025-03-07;2025-03-07;2025-03-08";            d="radar: retomada em 7 dias" ;;
      O) v="2025-02-28/2025-02-28;2025-02-28/2025-02-28;2025-02-28/2025-02-28;2025-03-01/2025-03-01"
                                                                     d="Omie: data do evento (inativado/reativado)" ;;
      C) v="1;1;1;0";                                                d="campanha cancelada no último dia: alerta" ;;
      V) v="RECUSADA;RECUSADA;RECUSADA;semeada";                     d="semeador: date_to = 01/03" ;;
    esac
    eq "${pfx}$f" "$d — tA·tB·tC·tD sob $tz" "$lista" "$v"
  done
}
bloco_b U UTC "00:00"
bloco_b S America/Sao_Paulo "03:00"

# ══════════════════════════════════════════════════════════════════════════════
# SMOKE — as 7 com o proconfig RESTAURADO (o da prod: sem o relógio controlado), no relógio de
# verdade. Prova que as funções como a prod as vê executam (late-bound; com search_path '' qualquer
# nome não qualificado quebraria). O seed é todo de 2024/2025: os valores lidos aqui não dependem do
# dia em que a prova roda (nenhuma janela de 60/180 dias do relógio real alcança o seed).
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "ALTER FUNCTION $SIG_T SET search_path = public; ALTER FUNCTION $SIG_G SET search_path = public;
         ALTER FUNCTION $SIG_L SET search_path = public; ALTER FUNCTION $SIG_R SET search_path = public;
         ALTER FUNCTION $SIG_O SET search_path = public, pg_temp; ALTER FUNCTION $SIG_C SET search_path = public, pg_temp;
         ALTER FUNCTION $SIG_V SET search_path = '';"
[ "$(Pq -c "$CFG_Q")" = "$CFG_PROD" ] || { echo "❌ INFRA: o proconfig não voltou ao de prod — o smoke mediria outra função"; exit 1; }
echo "── smoke, proconfig de prod restaurado ──"
fsmoke() { linha "$3" "$(Pq -F '|' -c "SET test.uid='$2'; SET ROLE authenticated; $1" 2>&1 || true)"; }   # <sql> <uid> <tag>
fmaster() { linha "$2" "$(Pq -F '|' -c "SET test.uid='$MASTER'; $1" 2>&1 || true)"; }                       # <sql> <tag>
eq WT "trava contábil no relógio real: fevereiro/2025 já passou, o mapeamento é livre" "$(fmaster "$LER_T" T)" "LIBERADA"
eq WG "régua como employee (authenticated), relógio real: o seed de 2024 está fora dos 180 dias" "$(fsmoke "$LER_G" "$EMPLOYEE" G)" "-/-"
eq WL "picking como employee, relógio real: nada do seed está nos últimos 60 dias" "$(fsmoke "$LER_L" "$EMPLOYEE" L)" "VAZIO"
eq WR "radar como master (authenticated), relógio real: cria a tarefa" \
  "$(fsmoke "SELECT 'R', (public.radar_atribuir_tarefa('$CNPJ', 7))->>'deduped';" "$MASTER" R)" "false"
eq WO "gatilho do Omie no relógio real: um evento por transição" \
  "$(fmaster "$LER_O" O | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}/DATA/g')" "DATA/DATA"
eq WC "campanha de 2025 cancelada no relógio real: fora da vigência, sem alerta" "$(fmaster "$LER_C" C)" "0"
# a última rodada do bloco B deixou uma janela aberta no cursor: sem limpar, o semeador responderia ja_pendente_outra
P -q -c "DELETE FROM public.vendas_sync_cursor;"
eq WV "semeador como employee (authenticated, search_path ''), janela passada: semeada" \
  "$(fsmoke "SELECT 'V', (public.vendas_sync_semear_janela('2025-01-01', '2025-01-02', ARRAY['oben']))->'contas'->0->>'desfecho';" "$EMPLOYEE" V)" "semeada"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
