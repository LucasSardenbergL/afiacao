#!/usr/bin/env bash
# REGRESSÃO — o "hoje/semana/mês/trimestre" é o de SÃO PAULO, seja qual for o
# fuso da SESSÃO (20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql).
#
# A prod roda sessão UTC. Das 21:00 às 23:59 BRT o relógio da sessão já está
# no dia seguinte, e 4 objetos truncavam esse relógio ao calendário:
#   Bloco R — radar_kpis(): `virou_cliente_mes` desde o início do mês de SP.
#   Bloco F — fin_projecao_13_semanas(): a semana 0 é a semana CORRENTE de SP,
#     com os títulos em aberto dela (money-path: projeção de caixa).
#   Bloco D — v_des_pedidos_em_transito / v_des_posicao_trimestre_ao_vivo: o
#     trimestre atual, os dias restantes e a faixa DES que o pedido em trânsito
#     ajuda a alcançar (money-path: desconto do fornecedor).
# Cada bloco CRUZA a borda de propósito, em pares de 1 s (20:59:59 · 21:00:00 ·
# 23:59:59 BRT · 00:00:00 do dia seguinte), e roda sob `TimeZone=UTC` E
# `America/Sao_Paulo`: sob sessão SP o defeito não aparece, então só a rodada
# UTC o pega.
#
# ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) sem a
# GUC. `CURRENT_DATE` NÃO é função — nenhum sombreamento o alcança —, por isso
# o corpo antigo das views e da projeção (que usava CURRENT_DATE) não entra na
# falsificação como tal: entra o GÊMEO controlável dele, o `now()` truncado no
# fuso da sessão. O corpo antigo do radar (`date_trunc('month', now())`) entra
# como é.
#
# Rodar:   bash db/test-fuso-sp-relogio-sessao.sh > log 2>&1; echo $?
#          bash db/test-fuso-sp-relogio-sessao.sh --falsificar > log 2>&1
# matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5496}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="fuso-sp-relogio-sessao"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql"
# Os predecessores: as RPCs saem das migrations que as definiram por último (= prod, conferido por
# md5 EXATO em P1/P2); as views — as 2 recriadas e a dependente do check-in — não têm CREATE no
# repo e saem da fixture capturada da prod (P3-P5).
MIG_RADAR="$REPO_ROOT/supabase/migrations/20260612130000_radar_rpcs_contato.sql"
MIG_FIN="$REPO_ROOT/supabase/migrations/20260512101121_a96fa007-f688-4c3a-8cd9-43f9d88e5505.sql"
FIX_VIEWS="$REPO_ROOT/db/fixtures/des-views-predecessoras-prod-20260927.sql"
# Denominador: P1-P5 · K1 K2 · R0 F0 D0 · RG FG · V1 · (T0 R1-R4 F1-F5 D1-D10) ×2 sessões.
TOTAL_ESPERADO=53

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO (todos) e os que TÊM de continuar verdes (rodados e verdes). Vermelho
# por erro de execução — sabotagem que não aplicou, SQL quebrado, saída vazia, tripwire — NÃO
# mata mutante e reprova a falsificação; a única exceção é declarada POR ASSERT (`ID!MARCA`:
# sem_pin, cujo vermelho esperado É o tripwire nos asserts que leem pelo pin).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# IDs por sessão: <R|F|D><U|S><n> — U = sessão UTC, S = sessão SP.
#   R1-R4: radar às 20:59:59 · 21:00:00 · 23:59:59 BRT do último dia do mês · 00:00:00 do dia 1
#   F1-F4: projeção no domingo às 20:59:59 · 21:00:00 · 23:59:59 BRT · segunda 00:00:00; F5 = cauda
#   D1-D4 (em trânsito) e D5-D8 (posição): último dia do trimestre, mesmos 4 instantes; D9 = dia comum;
#   D10 = o desconto projetado do check-in (a view dependente real) às 23:59:59 BRT do último dia
# K1/K2: com a sessão A parada entre a pré-condição e o CREATE OR REPLACE, B não mexe na função/view
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="corpo_pre_fix:RU1,RU2,RU3:RS1,RS2,RS3,RU4,RS4,R0
              radar_mes_em_utc:RU1,RS1,RU2,RS2,RU3,RS3:RU4,RS4
              radar_borda_aberta:RU1,RS1,RU2,RS2,RU3,RS3:RU4,RS4
              radar_de_parede:R0:F0,D0
              semana_na_sessao:FU2,FU3,FU5:FS2,FS3,FS5,FU1,FU4
              semana_em_utc:FU2,FS2,FU3,FS3,FU5,FS5:FU1,FS1,FU4,FS4
              semana_de_parede:F0:R0,D0
              transito_na_sessao:DU2,DU3,DU6,DU7,DU10:DS2,DS3,DS6,DS7,DS10,DU9
              posicao_na_sessao:DU6,DU7,DU9:DU2,DU3,DU10,DS6,DS7,DS9
              trimestre_de_parede:D0:R0,F0
              relogio_desligado_rpcs:R0,F0:D0
              relogio_desligado_views:D0:R0,F0
              sem_pin:R0!TRIPWIRE,F0!TRIPWIRE,D0!TRIPWIRE,V1!TRIPWIRE
              sem_trava:K1,K2:P1,P2
              gate_radar_removido:RG:FG
              gate_fin_removido:FG:RG"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
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
    faltou=""; sobrou=""; ids_erro=""
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"; ids_erro="$ids_erro $id"
             grep -Eq "(^|[^A-Z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    # Erro de execução só vale NO assert que o declarou (`ID!MARCA`); em qualquer outro, reprova —
    # senão a exceção de um assert viraria licença para a suíte inteira (achado do Codex).
    intrusos=""
    for id in $(grep -oE '[A-Z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u || true); do
      case " $ids_erro " in *" $id "*) ;; *) intrusos="$intrusos $id" ;; esac
    done
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$intrusos" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$intrusos" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO fora do declarado em:${intrusos} — vermelho que não é do assert não mata mutante"
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
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Leitura com sessão MONTADA: fuso, relógio e usuário entram pelo pacote de conexão (PGOPTIONS), que
# vence o pin do banco. `2>&1`: o erro vira o VALOR lido, e o `eq` o classifica como execução.
Ler() {   # <TimeZone> <test.agora> <test.uid> <sql>
  PGOPTIONS="-c TimeZone=$1 -c test.agora=$2 -c test.uid=$3" Pq -c "$4" 2>&1 || true
}

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

MASTER=11111111-1111-1111-1111-111111111111
CLIENTE=22222222-2222-2222-2222-222222222222
# Negativo: capturar a SQLSTATE e a marca ESPERADAS e relançar o resto — outro erro sai como ERRO
# (o `eq` o lê como execução, não como dente). A sentinela ('NEGOU') não é texto que as funções
# emitam. `pg_temp` vive só na conexão: o auxiliar nasce na MESMA chamada que o usa.
Nega() {   # <sql> <sqlstate> <marca> [<opções extras>] — como CLIENTE, sessão SP, no instante do pin
  PGOPTIONS="-c TimeZone=America/Sao_Paulo -c test.agora=2025-02-15T15:00:00Z -c test.uid=$CLIENTE ${4:-}" Pq -q -c "
    CREATE FUNCTION pg_temp.nega(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS \$f\$
    BEGIN
      EXECUTE p_sql;
      RETURN 'PASSOU';
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN 'NEGOU'; END IF;
      RAISE;
    END \$f\$;
    SELECT pg_temp.nega(\$q\$$1\$q\$, '$2', '$3');" 2>&1 || true
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que os 4 objetos leem. Colunas e TIPOS conferidos na prod via psql-ro
# (2026-09-27) — são os tipos que decidem se há fuso numa comparação, e os que o deparse da view
# imprime (P3/P4 exigem o md5 da prod).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
-- A da prod mora em search_path=private (gestor/master); o stub basta para o gate: só master.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $function$ SELECT public.has_role(_uid, 'master'::public.app_role) $function$;

CREATE TABLE public.radar_ingest_state (
  mes_referencia text, status text, total_recebido integer, novos integer,
  iniciado_em timestamptz, finalizado_em timestamptz, erro text
);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, ultimo_lote text, ja_cliente boolean,
  prospeccao_status text, prospeccao_atualizado_em timestamptz
);

CREATE TABLE public.fin_contas_correntes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, saldo_atual numeric, ativo boolean
);
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, data_vencimento date,
  valor_documento numeric, valor_recebido numeric, status_titulo text
);
CREATE TABLE public.fin_contas_pagar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, data_vencimento date,
  valor_documento numeric, valor_pago numeric, status_titulo text
);

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text, data_ciclo date,
  horario_disparo_real timestamptz, valor_total numeric, status text, tipo_ciclo text
);
CREATE TABLE public.fornecedor_grupo_producao (
  id bigint PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text, lt_producao_dias integer
);
-- Na prod é VIEW (o snapshot GoodData mais recente por empresa/trimestre); para o deparse de
-- v_des_posicao_trimestre_ao_vivo só nome, colunas e tipos importam.
CREATE TABLE public.v_des_snapshot_mais_recente (
  id bigint, empresa text, ano integer, trimestre integer, data_referencia date,
  objetivo_valor numeric, fat_bruto_valor numeric, objetivo_qtde numeric, fat_bruto_qtde numeric,
  pedidos_abertos_valor numeric, pedidos_abertos_qtde numeric, criado_em timestamptz
);
CREATE TABLE public.des_meta_empresa (
  id bigint PRIMARY KEY, empresa text, ano integer, trimestre integer, meta_faturamento numeric,
  faixa_des_objetivo integer, observacoes text, criado_em timestamptz, atualizado_em timestamptz
);
-- O que a dependente real (v_des_desconto_por_checkin) lê. v_des_checkin_atual é VIEW na prod (o
-- check-in mais recente por empresa/trimestre, sem relógio); aqui basta a forma.
CREATE TABLE public.v_des_checkin_atual (
  empresa text, ano integer, trimestre integer, checkin_id bigint, data_avaliacao date, tipo text,
  avaliado_com text, avaliado_por text, codigo text, nome text, criterio_tipo text, atingido boolean,
  observacao_criterio text
);
CREATE TABLE public.des_contrato_versao (
  id bigint PRIMARY KEY, versao text, data_inicio_vigencia date, data_fim_vigencia date,
  observacoes text, criado_em timestamptz
);
CREATE TABLE public.des_criterio_qualitativo (
  id bigint PRIMARY KEY, contrato_versao_id bigint, codigo text, nome text, descricao text,
  ordem integer, tipo text, criado_em timestamptz
);
CREATE TABLE public.des_criterio_percentual (
  id bigint PRIMARY KEY, criterio_id bigint, faixa_id bigint, percentual numeric, criado_em timestamptz
);
-- Assinaturas da prod (com os DEFAULTs que a view usa ao chamar com menos argumentos). Nenhuma das
-- duas lê relógio na prod (conferido): corpo determinístico basta.
CREATE OR REPLACE FUNCTION public.des_data_faturamento_prevista(p_data_emissao date, p_grupo_codigo text, p_empresa text DEFAULT 'OBEN'::text)
RETURNS date LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$ SELECT p_data_emissao + 5 $function$;
CREATE OR REPLACE FUNCTION public.des_determinar_faixa(p_valor numeric, p_versao text DEFAULT '2026'::text)
RETURNS TABLE(faixa_id bigint, faixa_numero integer, estrelas integer, desconto_padrao_perc numeric, volume_min numeric, volume_max numeric)
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $function$
  SELECT CASE WHEN p_valor >= 6000 THEN 2 ELSE 1 END::bigint, CASE WHEN p_valor >= 6000 THEN 2 ELSE 1 END,
         1, CASE WHEN p_valor >= 6000 THEN 5.0 ELSE 2.0 END, 0::numeric, 999999::numeric
$function$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — criado ANTES dos objetos: a view amarra o `now()` no CREATE (pelo
# search_path de quem cria), a função o resolve em runtime (pelo proconfig). `public.now()` lê a
# GUC `test.agora` e é TRIPWIRE: sem ela levanta Z9T01 em vez de cair no relógio de parede.
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
# OS PREDECESSORES — o que a prod tinha em 2026-09-27. As RPCs saem, por extração, das migrations
# que as definiram por último; as views (as 2 recriadas e a dependente do check-in, que a migration
# NÃO toca), da fixture. P1-P5: o md5 EXATO de cada um, sob o search_path do executor
# (`db:aplicar`), tem de ser o medido na prod — é o ensaio do predicado da PRÉ-condição.
# ══════════════════════════════════════════════════════════════════════════════
extrair() {   # <migration> <função> → o bloco CREATE OR REPLACE FUNCTION … até o delimitador
  python3 - "$1" "$2" <<'PYEXT'
import sys, re
s = open(sys.argv[1], encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE FUNCTION public." + sys.argv[2] + "(")
if ini < 0:
    sys.exit("função " + sys.argv[2] + " não achada em " + sys.argv[1])
m = re.compile(r"AS\s+(\$[A-Za-z_]*\$)").search(s, ini)
fim = s.find(m.group(1), m.end()) if m else -1
if fim < 0:
    sys.exit("corpo de " + sys.argv[2] + " não delimitado")
fim = s.find(";", fim)
print(s[ini:fim + 1])
PYEXT
}
extrair "$MIG_RADAR" radar_kpis > "$TMPD/pre_radar.sql"
extrair "$MIG_FIN" fin_projecao_13_semanas > "$TMPD/pre_fin.sql"
P -q -f "$TMPD/pre_radar.sql" -f "$TMPD/pre_fin.sql" -f "$FIX_VIEWS"

Exec() { PGOPTIONS="-c search_path=pg_catalog,public,pg_temp" Pq -c "$1" 2>&1 || true; }
eq P1 "radar_kpis predecessor = prod" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.radar_kpis()'::regprocedure")" c4028f8393f3ef762010a4e415820b5b
eq P2 "fin_projecao_13_semanas predecessor = prod" \
  "$(Exec "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fin_projecao_13_semanas(text,numeric)'::regprocedure")" db2f947aa168b9ee6322dae95aca9a13
eq P3 "v_des_pedidos_em_transito predecessor = prod" \
  "$(Exec "SELECT md5(pg_get_viewdef('public.v_des_pedidos_em_transito'::regclass, true))")" 4168b3c6fba1eae62cc07cf93df47b74
eq P4 "v_des_posicao_trimestre_ao_vivo predecessor = prod" \
  "$(Exec "SELECT md5(pg_get_viewdef('public.v_des_posicao_trimestre_ao_vivo'::regclass, true))")" 2f58d2ac47fde5589e78398ea9edee3f
eq P5 "v_des_desconto_por_checkin (dependente, intocada) = prod" \
  "$(Exec "SELECT md5(pg_get_viewdef('public.v_des_desconto_por_checkin'::regclass, true))")" 1c8885b860f65f5c76b1fd5314b96e28

# ══════════════════════════════════════════════════════════════════════════════
# K — A TRAVA (achado do Codex). A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a
# transação aberta: o instante em que, sem trava, outra transação recriaria o objeto e este CREATE
# OR REPLACE a apagaria em silêncio. B tenta mexer na função e na view com lock_timeout e tem de ser
# BARRADA (55P03). A mexida de B é um ALTER sem efeito: o que se mede é se ela CONSEGUE o lock — e
# assim nada muda para o resto da prova. sem_trava: a sessão A roda só a pré-condição.
# O K2 sonda a view de POSIÇÃO, não a de trânsito — medido na falsificação: a própria pré-condição,
# ao deparsear a posição, trava as relações que ela lê (AcquireRewriteLocks segura AccessShareLock
# até o fim da transação), e a de trânsito é uma delas. Sondada, ela barraria B com ou sem a trava.
# ══════════════════════════════════════════════════════════════════════════════
python3 - "$MIG" "$TMPD/parte1.sql" "$SABOTAGEM" <<'PYP1'
import sys
mig, out, sab = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(mig, encoding="utf-8").read()
fim = s.find("$pre$;")
if fim < 0:
    sys.exit("fim da pré-condição ($pre$;) não achado em " + mig)
parte = s[:fim + len("$pre$;")]
if sab == "sem_trava":
    ini, fim_t = parte.find("DO $trava$"), parte.find("$trava$;")
    if ini < 0 or fim_t < 0:
        sys.exit("bloco $trava$ não achado")
    parte = parte[:ini] + parte[fim_t + len("$trava$;"):]
open(out, "w", encoding="utf-8").write(parte + "\n")
PYP1
mkfifo "$TMPD/a.in"
PGOPTIONS="-c search_path=public,pg_catalog" "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove \
  -v ON_ERROR_STOP=1 -qAt < "$TMPD/a.in" > "$TMPD/a.out" 2>&1 &
PID_A=$!
exec 7> "$TMPD/a.in"
printf 'BEGIN;\n\\i %s\n\\! touch %s\n' "$TMPD/parte1.sql" "$TMPD/a.pronta" >&7
# Espera COM TETO e com o ramo que diz "não consegui": a sessão morta ou lenta não vira "barrou".
for _ in $(seq 1 150); do
  [ -e "$TMPD/a.pronta" ] && break
  kill -0 "$PID_A" 2>/dev/null || break
  sleep 0.2
done
if [ ! -e "$TMPD/a.pronta" ]; then
  echo "❌ K: a sessão A não chegou ao fim da pré-condição — a trava não foi posta à prova"
  head -c 600 "$TMPD/a.out"; exit 1
fi
eq K1 "com A parada após a pré-condição, B não mexe na função" \
  "$(Nega "ALTER FUNCTION public.radar_kpis() VOLATILE" 55P03 '' '-c lock_timeout=1500')" NEGOU
eq K2 "... nem na view" \
  "$(Nega "ALTER VIEW public.v_des_posicao_trimestre_ao_vivo SET (security_invoker = on)" 55P03 '' '-c lock_timeout=1500')" NEGOU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1), com a PRÉ e a PÓS dela. Aplicada com `pg_catalog` DEPOIS de
# `public` para as views amarrarem o now() controlado (na prod elas amarram o de pg_catalog: o
# texto do deparse é o mesmo, `now()`). Sem a migration = corpo_pre_fix.
# ══════════════════════════════════════════════════════════════════════════════
MIG_PATH="-c search_path=public,pg_catalog"
[ "$SABOTAGEM" = relogio_desligado_views ] && MIG_PATH=""
if [ "$SABOTAGEM" != corpo_pre_fix ]; then
  PGOPTIONS="$MIG_PATH" P -q -f "$MIG" >/dev/null
  echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"
fi

# ── SABOTAGEM (só no modo --falsificar) — no BANCO, recriando o objeto com o trecho trocado; o
# repo nunca é tocado. Cada padrão tem de ocorrer exatamente n× no bloco: uma troca que não pegou
# deixaria a suíte verde (e o laço, que exige vermelho no assert certo, acusa em vez de aprovar).
sabotar() {   # <objeto: fn:<nome> | view:<nome>> <de> <para> <n> [<de> <para> <n> ...]
  local alvo="$1" tmp
  shift
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$MIG" "$alvo" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, alvo, out, trocas = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
s = open(mig, encoding="utf-8").read()
tipo, nome = alvo.split(":", 1)
if tipo == "fn":
    ini = s.find("CREATE OR REPLACE FUNCTION public." + nome + "(")
    fim = s.find("$function$;", ini) + len("$function$;") if ini >= 0 else -1
else:
    ini = s.find("CREATE OR REPLACE VIEW public." + nome + "\n")
    fim = s.find(";\n", ini) + 1 if ini >= 0 else -1
if ini < 0 or fim <= 0:
    print("   " + alvo + " não delimitado em " + mig, file=sys.stderr); sys.exit(1)
bloco = s[ini:fim]
for i in range(0, len(trocas), 3):
    de, para, n = trocas[i], trocas[i + 1], int(trocas[i + 2])
    if bloco.count(de) != n:
        print("   padrão ocorre %dx, esperado %d: %r" % (bloco.count(de), n, de), file=sys.stderr); sys.exit(1)
    bloco = bloco.replace(de, para)
open(out, "w", encoding="utf-8").write(bloco + "\n")
PYSAB
  PGOPTIONS="$MIG_PATH" P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
}
SP="now() AT TIME ZONE 'America/Sao_Paulo'"
MES_SP="date_trunc('month', now(), 'America/Sao_Paulo')"
GATE_RADAR="  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
"
GATE_FIN="  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
"
case "$SABOTAGEM" in
  "") ;;
  # o corpo de 20260612130000 (radar) e os corpos com CURRENT_DATE: a migration não foi aplicada
  corpo_pre_fix|relogio_desligado_rpcs|relogio_desligado_views|sem_pin|sem_trava) ;;
  # o mês de SP trocado pelo mês UTC ESCRITO: fuso explícito, mas o errado
  radar_mes_em_utc) sabotar fn:radar_kpis "$MES_SP" "date_trunc('month', now(), 'UTC')" 1 ;;
  # a borda do início do mês aberta: a conversão de 00:00:00 BRT do dia 1 sairia do mês
  # (o trecho sai de $MES_SP: um `date_trunc(` literal sem fechar seria chamada ilegível para o gate
  # das provas, que lê todo shell de db/)
  radar_borda_aberta) sabotar fn:radar_kpis "prospeccao_atualizado_em >= $MES_SP" "prospeccao_atualizado_em > $MES_SP" 1 ;;
  # o mês tirado do relógio de parede, que o controlado não intercepta
  radar_de_parede) sabotar fn:radar_kpis "$MES_SP" "date_trunc('month', clock_timestamp(), 'America/Sao_Paulo')" 1 ;;
  # o gêmeo controlável do CURRENT_DATE antigo: a semana truncada no fuso da SESSÃO
  semana_na_sessao) sabotar fn:fin_projecao_13_semanas "$SP" "now()" 1 ;;
  semana_em_utc) sabotar fn:fin_projecao_13_semanas "$SP" "now() AT TIME ZONE 'UTC'" 1 ;;
  semana_de_parede) sabotar fn:fin_projecao_13_semanas "$SP" "clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'" 1 ;;
  # uma camada por vez: só a view que AGRUPA o pedido no trimestre, ou só a que o EXIBE
  transito_na_sessao) sabotar view:v_des_pedidos_em_transito "$SP" "now()" 4 ;;
  posicao_na_sessao) sabotar view:v_des_posicao_trimestre_ao_vivo "$SP" "now()" 5 ;;
  trimestre_de_parede) sabotar view:v_des_pedidos_em_transito "$SP" "clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'" 4
                       sabotar view:v_des_posicao_trimestre_ao_vivo "$SP" "clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'" 5 ;;
  gate_radar_removido) sabotar fn:radar_kpis "$GATE_RADAR" "" 1 ;;
  gate_fin_removido) sabotar fn:fin_projecao_13_semanas "$GATE_FIN" "" 1 ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# SÓ as funções sob teste ganham `pg_catalog` DEPOIS de `public` — é a única forma de um nome de
# usuário vencer um embutido (sem `pg_catalog` explícito ele é buscado PRIMEIRO).
if [ "$SABOTAGEM" != relogio_desligado_rpcs ]; then
  P -q -c "ALTER FUNCTION public.radar_kpis() SET search_path = public, pg_catalog, pg_temp;
           ALTER FUNCTION public.fin_projecao_13_semanas(text, numeric) SET search_path = public, pg_catalog, pg_temp;"
fi
# O pin: toda conexão nova nasce em 15/02/2025 15:00Z (sábado, meio de mês e de trimestre nos dois
# fusos). R0/F0/D0 leem por ele; os blocos por sessão trocam o instante no pacote de conexão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-02-15 15:00:00+00';"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (instantes LITERAIS; nenhum lê relógio)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$CLIENTE', 'customer');
-- Radar, fevereiro de 2025. A borda de baixo do mês de SP (01/02 00:00:00 BRT = 03:00:00Z) em par
-- de 1 s; Z é 31/01 às 22:00 BRT (01/02 01:00Z: fevereiro em UTC, janeiro em SP).
INSERT INTO public.radar_ingest_state (mes_referencia, status, novos) VALUES ('2025-02', 'complete', 7);
INSERT INTO public.radar_empresas VALUES
  ('X',  '2025-02', false, 'virou_cliente', '2025-02-28 23:00:00+00'),  -- 28/02 20:00 BRT
  ('Y',  '2025-02', false, 'virou_cliente', '2025-02-01 03:30:00+00'),  -- 01/02 00:30 BRT
  ('V',  '2025-02', false, 'virou_cliente', '2025-02-01 03:00:00+00'),  -- 01/02 00:00:00 BRT (entra)
  ('V2', '2025-02', false, 'virou_cliente', '2025-02-01 02:59:59+00'),  -- 31/01 23:59:59 BRT (fora)
  ('Z',  '2025-02', false, 'virou_cliente', '2025-02-01 01:00:00+00'),  -- 31/01 22:00 BRT (fora)
  ('N',  '2025-02', false, 'em_conversa',   '2025-02-15 15:00:00+00');
-- Projeção: saldo 10000. Semana de SP 24/02-02/03: a receber ATRASADO de qua 26/02 e a pagar que
-- VENCE HOJE no domingo 02/03. Semana seguinte: a receber de qua 05/03.
INSERT INTO public.fin_contas_correntes (company, saldo_atual, ativo) VALUES ('OBEN', 10000, true);
INSERT INTO public.fin_contas_receber (company, data_vencimento, valor_documento, valor_recebido, status_titulo) VALUES
  ('OBEN', '2025-02-26', 1000, 0, 'ATRASADO'),
  ('OBEN', '2025-03-05',  500, 0, 'A VENCER');
INSERT INTO public.fin_contas_pagar (company, data_vencimento, valor_documento, valor_pago, status_titulo) VALUES
  ('OBEN', '2025-03-02',  300, 0, 'VENCE HOJE');
-- DES, 1º trimestre de 2025: snapshot GoodData de 05/03 com 5000 faturados; pedido Sayerlack
-- emitido em 10/03 (sem disparo: a data de emissão é a do ciclo), faturamento previsto 15/03,
-- 1000 — seguro (21 dias até 31/03 ≥ 8 × 1,4 × 1,2). Faixa 2 a partir de 6000.
INSERT INTO public.pedido_compra_sugerido VALUES
  (1, 'OBEN', 'RENNER SAYERLACK S/A', 'G1', '2025-03-10', NULL, 1000, 'aprovado', 'normal');
INSERT INTO public.fornecedor_grupo_producao VALUES (1, 'OBEN', 'RENNER SAYERLACK S/A', 'G1', 8);
INSERT INTO public.v_des_snapshot_mais_recente VALUES
  (1, 'OBEN', 2025, 1, '2025-03-05', 20000, 5000, 0, 0, 0, 0, '2025-03-05 12:00:00+00');
INSERT INTO public.des_meta_empresa (id, empresa, ano, trimestre, meta_faturamento, faixa_des_objetivo)
  VALUES (1, 'OBEN', 2025, 1, 10000, 2);
-- Check-in do 1º trimestre: 1 critério qualitativo atingido, que vale 0,5 pp na faixa 1 e 1,5 pp na
-- faixa 2. Desconto projetado = padrão da faixa + critério: 2,0 + 0,5 = 2,50 · 5,0 + 1,5 = 6,50.
INSERT INTO public.des_contrato_versao (id, versao) VALUES (1, '2026');
INSERT INTO public.des_criterio_qualitativo (id, contrato_versao_id, codigo, nome, ordem, tipo)
  VALUES (10, 1, 'C1', 'Critério 1', 1, 'qualitativo');
INSERT INTO public.des_criterio_percentual (id, criterio_id, faixa_id, percentual)
  VALUES (100, 10, 1, 0.5), (101, 10, 2, 1.5);
INSERT INTO public.v_des_checkin_atual (empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, codigo, nome, criterio_tipo, atingido)
  VALUES ('OBEN', 2025, 1, 1, '2025-03-20', 'mensal', 'C1', 'Critério 1', 'qualitativo', true);
SQL

Q_RADAR="SELECT (public.radar_kpis())->>'virou_cliente_mes'"
Q_FIN0="SELECT semana_inicio || '|' || entradas_previstas || '|' || saidas_previstas || '|' || saldo_projetado
          FROM public.fin_projecao_13_semanas('OBEN') ORDER BY semana_inicio LIMIT 1"
Q_FIN_CAUDA="SELECT count(*) || '|' || max(semana_inicio) || '|' || (array_agg(saldo_projetado ORDER BY semana_inicio DESC))[1]
               FROM public.fin_projecao_13_semanas('OBEN')"
Q_TRANSITO="SELECT ano_atual || '|' || trimestre_atual || '|' || inicio_trimestre || '|' || fim_trimestre || '|' ||
                   fatura_no_trimestre || '|' || zona_confianca FROM public.v_des_pedidos_em_transito WHERE pedido_id = 1"
Q_POSICAO="SELECT count(*) || '|' ||
                  COALESCE(max(posicao_ao_vivo_conservadora) FILTER (WHERE ano = 2025 AND trimestre = 1)::text, 'nulo') || '|' ||
                  COALESCE(max(faixa_conservadora ->> 'faixa_numero') FILTER (WHERE ano = 2025 AND trimestre = 1), 'nulo') || '|' ||
                  max(dias_restantes) || '|' || max(calculado_em) || '|' || max(inicio_trimestre) || '|' || max(fim_trimestre)
             FROM public.v_des_posicao_trimestre_ao_vivo WHERE empresa = 'OBEN'"
Q_DIA="SELECT max(dias_restantes) || '|' || max(calculado_em) FROM public.v_des_posicao_trimestre_ao_vivo WHERE empresa = 'OBEN'"
Q_CHECKIN="SELECT faixa_numero || '|' || desconto_total_projetado FROM public.v_des_desconto_por_checkin
            WHERE empresa = 'OBEN' AND ano = 2025 AND trimestre = 1"

# ══════════════════════════════════════════════════════════════════════════════
# CONTROLES — o relógio é o CONTROLADO (R0/F0/D0 leem pelo pin, sessão SP: o corpo antigo acertaria
# aqui, então só um relógio fora de controle os derruba), os gates seguem de pé, o dependente lê.
# ══════════════════════════════════════════════════════════════════════════════
LerPin() { PGOPTIONS="-c TimeZone=America/Sao_Paulo -c test.uid=$MASTER" Pq -c "$1" 2>&1 || true; }
eq R0 "radar no pin (15/02): o mês de SP tem X, Y e V" "$(LerPin "$Q_RADAR")" 3
eq F0 "projeção no pin (sáb 15/02): a semana 0 começa na segunda 10/02" \
  "$(LerPin "SELECT min(semana_inicio) FROM public.fin_projecao_13_semanas('OBEN')")" 2025-02-10
eq D0 "em trânsito no pin: 1º trimestre de 2025" \
  "$(LerPin "SELECT ano_atual || '|' || trimestre_atual || '|' || inicio_trimestre || '|' || fim_trimestre FROM public.v_des_pedidos_em_transito WHERE pedido_id = 1")" \
  "2025|1|2025-01-01|2025-03-31"

eq RG "radar_kpis nega quem não é gestor/master" "$(Nega "SELECT public.radar_kpis()" P0001 forbidden)" NEGOU
eq FG "fin_projecao_13_semanas nega quem não é staff" "$(Nega "SELECT * FROM public.fin_projecao_13_semanas('OBEN')" 42501 'requer perfil staff')" NEGOU
eq V1 "o desconto projetado do check-in (dependente real) no pin: faixa 2, 5,0 + 1,5" \
  "$(LerPin "$Q_CHECKIN")" "2|6.50"

# ══════════════════════════════════════════════════════════════════════════════
# POR SESSÃO — os mesmos instantes sob TimeZone=UTC (a prod) e America/Sao_Paulo (o Mac).
# T0 é o controle POSITIVO da sessão: o fuso é o que foi pedido E muda a data de um instante fixo.
# ══════════════════════════════════════════════════════════════════════════════
for SESSAO in U S; do
  case "$SESSAO" in U) TZS=UTC; T0_ESP="UTC|2025-03-01" ;; S) TZS=America/Sao_Paulo; T0_ESP="America/Sao_Paulo|2025-02-28" ;; esac
  echo "── sessão $TZS ──"
  eq "T${SESSAO}0" "a sessão está em $TZS" \
    "$(Ler "$TZS" 2025-02-15T15:00:00Z "$MASTER" "SELECT current_setting('TimeZone') || '|' || (TIMESTAMPTZ '2025-03-01 00:00:00+00')::date")" "$T0_ESP"

  # Bloco R — 28/02/2025 (sexta) é o último dia do mês de SP.
  eq "R${SESSAO}1" "radar 28/02 20:59:59 BRT" "$(Ler "$TZS" 2025-02-28T23:59:59Z "$MASTER" "$Q_RADAR")" 3
  eq "R${SESSAO}2" "radar 28/02 21:00:00 BRT" "$(Ler "$TZS" 2025-03-01T00:00:00Z "$MASTER" "$Q_RADAR")" 3
  eq "R${SESSAO}3" "radar 28/02 23:59:59 BRT" "$(Ler "$TZS" 2025-03-01T02:59:59Z "$MASTER" "$Q_RADAR")" 3
  eq "R${SESSAO}4" "radar 01/03 00:00:00 BRT (mês novo, zero)" "$(Ler "$TZS" 2025-03-01T03:00:00Z "$MASTER" "$Q_RADAR")" 0

  # Bloco F — domingo 02/03/2025; a semana de SP é 24/02-02/03 até 23:59:59 BRT.
  eq "F${SESSAO}1" "projeção dom 20:59:59 BRT" "$(Ler "$TZS" 2025-03-02T23:59:59Z "$MASTER" "$Q_FIN0")" "2025-02-24|1000|300|10700"
  eq "F${SESSAO}2" "projeção dom 21:00:00 BRT" "$(Ler "$TZS" 2025-03-03T00:00:00Z "$MASTER" "$Q_FIN0")" "2025-02-24|1000|300|10700"
  eq "F${SESSAO}3" "projeção dom 23:59:59 BRT" "$(Ler "$TZS" 2025-03-03T02:59:59Z "$MASTER" "$Q_FIN0")" "2025-02-24|1000|300|10700"
  eq "F${SESSAO}4" "projeção seg 00:00:00 BRT (semana nova)" "$(Ler "$TZS" 2025-03-03T03:00:00Z "$MASTER" "$Q_FIN0")" "2025-03-03|500|0|10500"
  eq "F${SESSAO}5" "projeção dom 23:59:59 BRT: 13 semanas até 19/05, saldo final 11200" \
    "$(Ler "$TZS" 2025-03-03T02:59:59Z "$MASTER" "$Q_FIN_CAUDA")" "13|2025-05-19|11200"

  # Bloco D — 31/03/2025 (segunda) é o último dia do 1º trimestre de SP.
  eq "D${SESSAO}1" "em trânsito 31/03 20:59:59 BRT" "$(Ler "$TZS" 2025-03-31T23:59:59Z "$MASTER" "$Q_TRANSITO")" "2025|1|2025-01-01|2025-03-31|true|verde"
  eq "D${SESSAO}2" "em trânsito 31/03 21:00:00 BRT" "$(Ler "$TZS" 2025-04-01T00:00:00Z "$MASTER" "$Q_TRANSITO")" "2025|1|2025-01-01|2025-03-31|true|verde"
  eq "D${SESSAO}3" "em trânsito 31/03 23:59:59 BRT" "$(Ler "$TZS" 2025-04-01T02:59:59Z "$MASTER" "$Q_TRANSITO")" "2025|1|2025-01-01|2025-03-31|true|verde"
  eq "D${SESSAO}4" "em trânsito 01/04 00:00:00 BRT (trimestre novo)" "$(Ler "$TZS" 2025-04-01T03:00:00Z "$MASTER" "$Q_TRANSITO")" "2025|2|2025-04-01|2025-06-30|false|verde"
  eq "D${SESSAO}5" "posição 31/03 20:59:59 BRT: 5000 + 1000 em trânsito = faixa 2" "$(Ler "$TZS" 2025-03-31T23:59:59Z "$MASTER" "$Q_POSICAO")" "1|6000.00|2|0|2025-03-31|2025-01-01|2025-03-31"
  eq "D${SESSAO}6" "posição 31/03 21:00:00 BRT" "$(Ler "$TZS" 2025-04-01T00:00:00Z "$MASTER" "$Q_POSICAO")" "1|6000.00|2|0|2025-03-31|2025-01-01|2025-03-31"
  eq "D${SESSAO}7" "posição 31/03 23:59:59 BRT" "$(Ler "$TZS" 2025-04-01T02:59:59Z "$MASTER" "$Q_POSICAO")" "1|6000.00|2|0|2025-03-31|2025-01-01|2025-03-31"
  eq "D${SESSAO}8" "posição 01/04 00:00:00 BRT: o pedido vai para o 2º trimestre" "$(Ler "$TZS" 2025-04-01T03:00:00Z "$MASTER" "$Q_POSICAO")" "2|5000.00|1|90|2025-04-01|2025-04-01|2025-06-30"
  eq "D${SESSAO}9" "posição sex 14/03 22:00 BRT: 17 dias restantes, calculado em 14/03" "$(Ler "$TZS" 2025-03-15T01:00:00Z "$MASTER" "$Q_DIA")" "17|2025-03-14"
  eq "D${SESSAO}10" "desconto do check-in 31/03 23:59:59 BRT: o pedido em trânsito ainda leva à faixa 2" "$(Ler "$TZS" 2025-04-01T02:59:59Z "$MASTER" "$Q_CHECKIN")" "2|6.50"
done

echo "════════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL (esperados $TOTAL_ESPERADO)"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executou $PASS asserts, o denominador é $TOTAL_ESPERADO — bloco que não rodou é vermelho"
  exit 1
fi
[ "$FAIL" -eq 0 ]
