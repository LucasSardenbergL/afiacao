#!/usr/bin/env bash
# REGRESSÃO — a família data_ciclo lê o dia de SÃO PAULO, seja qual for o fuso da SESSÃO, e grava o corte em
# HORA DE SP (20261001023000_hoje_sp_familia_data_ciclo.sql — a fase 3 da classe (ii), o dia lido NU).
#
# A prod roda sessão UTC. Das 21:00 às 23:59 BRT o dia da sessão já é o seguinte: o DEFAULT de p_data_ciclo
# abria o ciclo de AMANHÃ (e a RPC do motor expirava os pendentes de HOJE), as 2 views "_hoje" tiravam a
# campanha que termina hoje, os leitores de data_ciclo contavam um dia a mais. E `(data + hora)::timestamptz`
# convertia o corte no fuso da sessão: o corte das 10:00 de SP ficava gravado às 07:00.
#
# O que se prova, com os mesmos 4 asserts por objeto (instantes D = qua 12/03/2025):
#   a — sob sessão UTC, às 21:00:00 BRT de D o resultado é o MESMO das 20:59:59 (o dia de SP não virou);
#   b — às 23:59:59 BRT de D, sessão UTC e sessão SP dão o MESMO resultado;
#   c — CONTROLE POSITIVO: sob sessão UTC, à 00:00:00 BRT de D+1 o resultado MUDA (o objeto lê o relógio
#       controlado e a semente vira na meia-noite de SP — sem ele, a e b passariam por vacuidade);
#   d — o (a) sob sessão SP: fica VERDE com o gêmeo da sessão sabotado (o defeito só aparece em UTC).
# Objetos: V1 v_promocao_avaliacao_hoje · V2 v_oportunidade_economica_hoje · F1 ciclo_oportunidade_do_dia
# (DEFAULT, o único exercido em prod) · F3 gerar_pedidos_sugeridos_ciclo (DEFAULT: o ciclo e os pendentes de
# HOJE) · F4 aplicar_promocoes_no_ciclo (DEFAULT + a view) · F5 _data_health_compute · F6 reposicao_pos_candidatos
# · F7 atualizar_parametros_numericos_skus (a janela do em trânsito) · DEF o DEFAULT de pedido_compra_sugerido.
# data_ciclo. E F2: o corte em hora de SP (a oportunidade às 18:00, o normal no horario_corte_pedido).
# Mais: P01-P11 (cada predecessora e as 18 dependências batem o md5 EXATO da prod — o ensaio do predicado da
# PRÉ), K1-K4 (a trava e a ORDEM dos leitores), Z0 (o pin), G1-G7 (a PRÉ e a PÓS recusam o que devem).
#
# ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) sem a GUC. Views e DEFAULTs de
# parâmetro o amarram no CREATE (search_path com `public` antes de `pg_catalog`); os CORPOS das 7 funções
# resolvem nomes ao executar, pelo proconfig — a prova põe `public` antes de `pg_catalog` neles (o mesmo
# expediente da 20260929001651). `CURRENT_DATE` não é função — nenhum sombreamento o alcança —, por isso o
# texto antigo entra na falsificação pelo GÊMEO controlável (`now()` truncado no fuso da SESSÃO).
#
# Rodar:   bash db/test-hoje-sp-data-ciclo.sh > log 2>&1; echo $?
#          bash db/test-hoje-sp-data-ciclo.sh --falsificar > log 2>&1
# matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5531}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="hoje-sp-data-ciclo"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261001023000_hoje_sp_familia_data_ciclo.sql"
FIX="$REPO_ROOT/db/fixtures/hoje-sp-data-ciclo-prod-20261001.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
# Denominador: P01-P11 · K1-K4 · Z0 · G1-G7 · V1,V2 × a,b,c,d · F1,F3..F7 × a,b,c,d · F2a,F2b,F2c · DEF a,b,c,d.
TOTAL_ESPERADO=62

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas as
# sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar vermelhos por
# RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro de execução —
# sabotagem que não aplicou, SQL quebrado, saída vazia, tripwire — NÃO mata mutante e reprova a
# falsificação; a única exceção é declarada POR ASSERT (`ID!MARCA`).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sessao_v_promocao_avaliacao_hoje:V1a,V1b,V1c:V1d
              sessao_v_oportunidade_economica_hoje:V2a,V2b,V2c:V2d
              promocao_de_parede:V1c:V1a,V1b,V1d
              promocao_em_utc_escrito:V1a,V1c,V1d:V1b
              default_sessao_ciclo_oportunidade_do_dia:F1a,F1b,F1c:F1d
              default_sessao_gerar_pedidos_sugeridos_ciclo:F3a,F3b,F3c:F3d
              default_sessao_aplicar_promocoes_no_ciclo:F4a,F4b,F4c:F4d
              corte_na_sessao_oportunidade:F2a:F2b,F2c
              corte_na_sessao_normal:F2b:F2a,F2c
              sessao_data_health:F5a,F5b,F5c:F5d
              sessao_pos_candidatos:F6a,F6b,F6c:F6d
              sessao_param_auto:F7a,F7b,F7c:F7d
              default_sessao_coluna_data_ciclo:DEFa,DEFb:DEFc,DEFd
              sem_pin:Z0!TRIPWIRE:V1a,F1a
              sem_trava:K1,K2,K3:P01,P02
              trava_na_ordem_errada:K4:K1,K2,K3
              pre_removida:G1,G6:G2,G3
              pos_removida:G2,G4,G5,G7:G1,G3,G6"
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
             grep -Eq "(^|[^A-Za-z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    # Erro de execução só vale NO assert que o declarou (`ID!MARCA`); em qualquer outro, reprova — senão a
    # exceção de um assert viraria licença para a suíte inteira.
    intrusos=""
    for id in $(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' | sort -u || true); do
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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Leitura com sessão MONTADA: fuso e relógio entram pelo pacote de conexão (PGOPTIONS), que vence o pin do
# banco. `2>&1`: o erro vira o VALOR lido, e o assert o classifica como execução. Cada leitura que ESCREVE
# (as RPCs) roda numa transação que volta atrás — a semente é a mesma para todo instante.
Ler() {   # <TimeZone> <test.agora> <sql...> — os <sql> rodam em sequência entre BEGIN e ROLLBACK
  local tz="$1" agora="$2" args=()
  shift 2
  for s in "$@"; do args+=(-c "$s"); done
  # client_min_messages=warning: o NOTICE de um DROP ... IF EXISTS dentro de uma RPC não pode virar parte do VALOR.
  PGOPTIONS="-c TimeZone=$tz -c test.agora=$agora -c client_min_messages=warning" Pq -q -c "BEGIN" "${args[@]}" -c "ROLLBACK" 2>&1 || true
}

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
invalido() { case "$1" in ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*) return 0 ;; *) return 1 ;; esac; }
# Um VALOR que é erro (psql, tripwire) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço de
# falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  if invalido "$3"; then erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi
}
iguais() {   # <id> <descrição> <v1> <v2>
  if invalido "$3" || invalido "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (=${3:0:60})"; else bad "$1" "$2 — [$3] ≠ [$4]"; fi
}
diferentes() {   # <id> <descrição> <v1> <v2>
  if invalido "$3" || invalido "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" != "$4" ]; then ok "$1" "$2 (${3:0:40} → ${4:0:40})"; else bad "$1" "$2 — não mudou na virada: [$3]"; fi
}
# Roda um arquivo SQL numa transação que VOLTA ATRÁS, como função: 'PASSOU' se não levantou nada;
# 'NEGOU' se levantou a SQLSTATE e a marca ESPERADAS; qualquer outro erro sai como ERRO (o `eq` o lê como
# execução, não como dente). É o que põe a PRÉ e a PÓS da migration à prova sem deixar rastro no banco.
# shellcheck disable=SC2016  # $f$ e $tenta$ são dollar-quotes do SQL gerado, não expansão do shell
Tenta() {   # <arquivo com o SQL> <sqlstate> <marca>
  local f="$TMPD/tenta.$RANDOM.sql"
  {
    printf 'BEGIN;\n'
    printf 'CREATE FUNCTION pg_temp.tenta(p_sql text, p_estado text, p_marca text) RETURNS text LANGUAGE plpgsql AS $f$\n'
    printf 'BEGIN\n  EXECUTE p_sql;\n  RETURN %s;\nEXCEPTION WHEN OTHERS THEN\n' "'PASSOU'"
    printf '  IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN %s; END IF;\n  RAISE;\nEND $f$;\n' "'NEGOU'"
    printf 'SELECT pg_temp.tenta($tenta$'
    cat "$1"
    printf '$tenta$, %s, %s);\nROLLBACK;\n' "'$2'" "'$3'"
  } > "$f"
  PGOPTIONS="-c search_path=public,pg_catalog -c test.agora=2025-03-12T15:00:00Z" Pq -q -f "$f" 2>&1 || true
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única). O snapshot traz as tabelas-base
# com os TIPOS da prod (é o que decide se há fuso numa comparação, e o que o deparse imprime).
# ══════════════════════════════════════════════════════════════════════════════
rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q -c "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — criado ANTES dos objetos: views e DEFAULTs amarram o `now()` no CREATE (pelo
# search_path de quem cria). `public.now()` lê a GUC `test.agora` e é TRIPWIRE: sem ela levanta Z9T01 em
# vez de cair no relógio de parede. O snapshot traz `public.set_config` (wrapper que só aceita `fin.%`):
# com `public` antes de `pg_catalog` nos corpos, atualizar_parametros_numericos_skus o chamaria no lugar
# do embutido — na prod o embutido vence (pg_catalog implícito primeiro). Sai daqui; a guarda de sombra
# abaixo exige que o único nome sombreado do que se prova seja o now().
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
DROP FUNCTION IF EXISTS public.set_config(text, text, boolean);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# A PROD VIVA — da fixture: a deriva de colunas do snapshot, as 18 dependências e as PREDECESSORAS.
# P01-P02: o md5 EXATO de cada view; P03-P09: o de cada função (prosrc E argumentos — o DEFAULT mora em
# proargdefaults); P10: o DEFAULT da coluna; P11: as 18 dependências. É o ensaio do predicado da PRÉ.
# O ACL de PROD nas 9 (o snapshot vem SEM privilégios: sem isto a foto do ACL na PRÉ e a POS6 comparariam
# o default com o default, e o predicado que estreia na prod nunca teria sido exercido aqui).
# ══════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIX" >/dev/null
P -q <<'SQL'
GRANT ALL ON public.v_promocao_avaliacao_hoje, public.v_oportunidade_economica_hoje TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.aplicar_promocoes_no_ciclo(text, date), public.ciclo_oportunidade_do_dia(text, date),
  public.gerar_pedidos_oportunidade_ciclo(text, date, text[]), public.gerar_pedidos_sugeridos_ciclo(text, date),
  public.atualizar_parametros_numericos_skus(text, uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._data_health_compute(), public.reposicao_pos_candidatos(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._data_health_compute() TO service_role;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;
SQL
Exec() { PGOPTIONS="-c search_path=public,pg_catalog,pg_temp" Pq -c "$1" 2>&1 || true; }
eq P01 "v_promocao_avaliacao_hoje predecessora = prod" \
  "$(Exec "SELECT md5(pg_get_viewdef('public.v_promocao_avaliacao_hoje'::regclass, true))")" 31ddcf3daee2072fef041ad9aa500f5f
eq P02 "v_oportunidade_economica_hoje predecessora = prod" \
  "$(Exec "SELECT md5(pg_get_viewdef('public.v_oportunidade_economica_hoje'::regclass, true))")" 829878aba7c46d25fedee3a35022fdd4
FUNCS_PROD="aplicar_promocoes_no_ciclo(text,date):9a6de552bec25dbce3333679ef1b971d:27bd7c84c6235fdc1817854344876972
            ciclo_oportunidade_do_dia(text,date):9a6de552bec25dbce3333679ef1b971d:7cdcfdb9161482ff739cfcd4468e8a3c
            gerar_pedidos_oportunidade_ciclo(text,date,text[]):b474180b587175bb4adbdeac31edad90:c4a1306ee04559cf097abfd6fe19f5f5
            gerar_pedidos_sugeridos_ciclo(text,date):9a6de552bec25dbce3333679ef1b971d:ec2c33db40ce3394c711768713efda7b
            _data_health_compute():d41d8cd98f00b204e9800998ecf8427e:a136ea5345a29ee720e7e3ab6c5820d3
            atualizar_parametros_numericos_skus(text,uuid):c2f2e23354fbab735c9539a5775904f2:e475a9bbca943a5a1b34150b93522668
            reposicao_pos_candidatos(text):12d784009ff4c40b62383656a968dcc8:645733d1f4d2f7b835de6632cfc4a588"
n=2
for item in $FUNCS_PROD; do
  n=$((n+1)); alvo="${item%%:*}"; resto="${item#*:}"
  eq "$(printf 'P%02d' "$n")" "$alvo predecessora = prod (argumentos:corpo)" \
    "$(Exec "SELECT md5(pg_get_function_arguments(p.oid)) || ':' || md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.$alvo'::regprocedure")" "$resto"
done
DIA_SESSAO="CURRENT""_DATE"   # a agulha partida: o texto antigo do DEFAULT, sem citá-lo inteiro
eq P10 "DEFAULT de pedido_compra_sugerido.data_ciclo predecessor = prod" \
  "$(Exec "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
           WHERE d.adrelid = 'public.pedido_compra_sugerido'::regclass AND a.attname = 'data_ciclo'")" "$DIA_SESSAO"
DEPS_PROD="vw_pcp_malha_itens:1de81628e4f55fb27b2af3ff302cbeb6 vw_pcp_malha_componentes:d17181a51f37d1f589704418133b5cf0
           v_pcp_malha_oben_cand:93d00923a24310b0617ff6ecf09dec94 v_pcp_malha_oben:a183742127714a2fe4cfa43925242aab
           v_venda_items_history_efetivo:728d3582b0a216ed156fe05161523b4f v_sku_demanda_efetiva:93f3c839567e938c2d5e408f8348b01d
           v_sku_leadtime_history_normal:42fc15377615784762a874ebef881340 v_fornecedor_lt_logistica_total:1405d96cc9817129839f73a64fb647c6
           v_sku_demanda_estatisticas:f05c5621d0254b746c6ada8cb0c9d22a v_sku_leadtime_efetivo:a7b935a8d6592398bf32bb9299fbe385
           v_sku_classificacao_abc_xyz:bbd226bde630f124b44616583857488d v_sku_demanda_rajada:91fce84224800a53021d3022d297aac2
           v_sku_leadtime_estatisticas:3dc951377dd8c0da5d23a95a7ea3deef v_sku_lt_teorico:d34c922f36efd5becc245ce197b130fb
           v_sku_sigma_demanda:7be1b6b1f09c0943ed20b70a91f49ea4 v_promocao_item_efetivo:add2921c4111cd808b263083dedd2d60
           v_sku_aumento_vigente:3d12ee0c70206f5cd2fe47cab60e0779 v_sku_parametros_sugeridos:cb7f8b8b2286ca815c0a76ea8aa412de"
dep_ok=0; dep_div=""
for par in $DEPS_PROD; do
  nome="${par%%:*}"; md5="${par#*:}"
  vivo="$(Exec "SELECT md5(pg_get_viewdef('public.$nome'::regclass, true))")"
  if [ "$vivo" = "$md5" ]; then dep_ok=$((dep_ok+1)); else dep_div="$dep_div $nome"; fi
done
eq P11 "as 18 dependências vivas = prod (md5 EXATO)${dep_div:+ — divergem:$dep_div}" "$dep_ok" 18

# ══════════════════════════════════════════════════════════════════════════════
# K — A TRAVA. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a transação aberta: o
# instante em que, sem trava, outra transação recriaria um objeto e o replace a apagaria em silêncio. B
# tenta com lock_timeout e tem de ser BARRADA (55P03). As mexidas de B não têm efeito: o que se mede é se
# ela CONSEGUE o lock. sem_trava: a sessão A roda só a pré-condição.
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
barra() {   # <sql> — 'BARROU' se B tomou lock_timeout (55P03); 'PASSOU' se conseguiu; o resto é ERRO
  PGOPTIONS="-c lock_timeout=1500" Pq -q -c "
    CREATE FUNCTION pg_temp.barra(p_sql text) RETURNS text LANGUAGE plpgsql AS \$f\$
    BEGIN
      EXECUTE p_sql;
      RETURN 'PASSOU';
    EXCEPTION WHEN lock_not_available THEN
      RETURN 'BARROU';
    END \$f\$;
    SELECT pg_temp.barra(\$q\$$1\$q\$);" 2>&1 || true
}
eq K1 "com A parada após a pré-condição, B não mexe em v_promocao_avaliacao_hoje" \
  "$(barra "ALTER VIEW public.v_promocao_avaliacao_hoje SET (security_invoker = on)")" BARROU
eq K2 "... nem lê pedido_compra_sugerido (ACCESS EXCLUSIVE: o SET DEFAULT sem subida de modo no meio)" \
  "$(barra "LOCK TABLE public.pedido_compra_sugerido IN ACCESS SHARE MODE")" BARROU
eq K3 "... nem recria uma das 7 funções" \
  "$(barra "ALTER FUNCTION public.ciclo_oportunidade_do_dia(text, date) VOLATILE")" BARROU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true
# K4: a ORDEM da trava é a dos LEITORES (medida no catálogo e nos corpos): aplicar_promocoes_no_ciclo lê
# v_promocao_avaliacao_hoje ANTES da tabela; gerar_pedidos_oportunidade_ciclo apaga na tabela ANTES de ler
# v_oportunidade_economica_hoje. Outra ordem = deadlock com um deles. trava_na_ordem_errada: tabela primeiro.
python3 - "$MIG" "$SABOTAGEM" <<'PYK4' > "$TMPD/k4.txt"
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
ini, fim = s.find("DO $trava$"), s.find("$trava$;")
alvos = re.findall(r"(?:ALTER VIEW|LOCK TABLE) public\.(\w+)", s[ini:fim])
if sys.argv[2] == "trava_na_ordem_errada":
    alvos.insert(0, alvos.pop(alvos.index("pedido_compra_sugerido")))
esperado = ["v_promocao_avaliacao_hoje", "pedido_compra_sugerido", "v_oportunidade_economica_hoje"]
print("ORDEM_DOS_LEITORES" if alvos == esperado else "ORDEM:" + ",".join(alvos))
PYK4
eq K4 "a trava prende view, tabela e view na ordem em que os leitores as prendem" "$(cat "$TMPD/k4.txt")" ORDEM_DOS_LEITORES

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL, com a PRÉ e a PÓS dela. Aplicada com `pg_catalog` DEPOIS de `public` para as
# views e os DEFAULTs amarrarem o now() controlado (na prod amarram o de pg_catalog: o texto do deparse é
# o mesmo, `now()`, e é por isso que o md5 da PÓS vale nos dois lugares).
# ══════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q --single-transaction -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"

# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA assinatura de um
# embutido passa a vencê-lo. A guarda pergunta ao CATÁLOGO: das funções de `public` que sombreiam
# `pg_catalog`, de quais as 2 views e as 7 funções (os DEFAULTs de parâmetro) DEPENDEM? Tem de ser só o
# nosso now(). Controle POSITIVO: se não vê nem ele, está cega — aborta.
sombra="$(Pq -c "SELECT COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname <> 'now'), '')
  FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                AND c.proname = p.proname AND c.proargtypes = p.proargtypes)
   AND (   (d.classid = 'pg_rewrite'::regclass AND d.objid IN (
              SELECT r.oid FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class
               WHERE v.relnamespace = 'public'::regnamespace
                 AND v.relname IN ('v_promocao_avaliacao_hoje', 'v_oportunidade_economica_hoje')))
        OR (d.classid = 'pg_proc'::regclass AND d.objid IN (
              SELECT f.oid FROM pg_proc f WHERE f.pronamespace = 'public'::regnamespace
                 AND f.proname IN ('aplicar_promocoes_no_ciclo', 'ciclo_oportunidade_do_dia',
                                   'gerar_pedidos_oportunidade_ciclo', 'gerar_pedidos_sugeridos_ciclo')))
        OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (
              SELECT ad.oid FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
               WHERE ad.adrelid = 'public.pedido_compra_sugerido'::regclass AND a.attname = 'data_ciclo')));")"
case "$sombra" in
  'now|') echo "guarda de sombra: views e DEFAULTs dependem só do now() controlado entre os nomes sombreados (controle positivo visto)" ;;
  now\|*) echo "❌ views/DEFAULTs amarraram mais que o now() a public: [${sombra#*|}] — a prova rodaria outra semântica"; exit 1 ;;
  *) echo "❌ guarda cega: views e DEFAULTs não dependem do public.now() — não leem o relógio controlado [$sombra]"; exit 1 ;;
esac

# Os G rodam AQUI, sobre o estado limpo pós-migration e ANTES de qualquer sabotagem: eles re-executam a
# migration, e um objeto sabotado faria a PRÉ acusar (com razão) predecessor divergente.
echo "── G: a PRÉ e a PÓS da migration, postas à prova (numa transação que volta atrás)"
# G1: view predecessora DIVERGENTE — a PRÉ aborta. G2: o texto de uma view ADULTERADO — a PÓS recusa.
# G3: re-aplicar passa. G4: o ACL de uma FUNÇÃO mexido no meio — a POS6 vê. G5: view recriada sem
# security_invoker — a POS4 vê. G6: função predecessora DIVERGENTE (outro corpo) — a PRÉ aborta.
# G7: uma função instalada com o DEFAULT antigo (a lista de argumentos é parte da identidade) — a POS2 vê.
python3 - "$MIG" "$FIX" "$TMPD" "$SABOTAGEM" <<'PYG'
import sys
mig, fix, tmpd, sab = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
m = open(mig, encoding="utf-8").read()
f = open(fix, encoding="utf-8").read()

def bloco_view(texto, nome):
    ini = texto.find("CREATE OR REPLACE VIEW public." + nome + "\n")
    fim = texto.find(";\n", ini) + 1
    if ini < 0 or fim <= 0:
        sys.exit(nome + " não delimitada")
    return texto[ini:fim]

def bloco_funcao(texto, nome):
    ini = texto.find("CREATE OR REPLACE FUNCTION public." + nome + "(")
    fim = texto.find("$function$;\n", ini)
    if ini < 0 or fim < 0:
        sys.exit(nome + " não delimitada")
    return texto[ini:fim + len("$function$;")]

def sem(texto, tag):
    ini, fim = texto.find("DO $" + tag + "$"), texto.find("$" + tag + "$;")
    if ini < 0 or fim < 0:
        sys.exit("bloco $" + tag + "$ não achado")
    return texto[:ini] + texto[fim + len("$" + tag + "$;"):]

CONDS_PRE = ["IF r.vivo IS NOT NULL AND r.vivo <> r.predecessor AND r.vivo <> r.este THEN",
             "IF r.src_vivo IS NOT NULL\n       AND NOT"]
migracao = m
if sab == "pre_removida":
    for c in CONDS_PRE:
        if migracao.count(c) != 1:
            sys.exit("condição da PRÉ não achada 1x: " + c)
    migracao = migracao.replace(CONDS_PRE[0], "IF false THEN").replace(CONDS_PRE[1], "IF false\n       AND NOT")
pre_ok = migracao

# G1: a view predecessora com um literal trocado (colunas iguais).
div = bloco_view(f, "v_promocao_avaliacao_hoje")
if div.count("'ativa'::text") != 1:
    sys.exit("literal da divergência não achado na predecessora")
open(tmpd + "/g1.sql", "w", encoding="utf-8").write(div.replace("'ativa'::text", "'ativa '::text") + "\n" + pre_ok)
# G6: a função predecessora com um corpo divergente (um comentário a mais).
fdiv = bloco_funcao(f, "ciclo_oportunidade_do_dia")
if fdiv.count("BEGIN\n") < 1:
    sys.exit("BEGIN da predecessora não achado")
open(tmpd + "/g6.sql", "w", encoding="utf-8").write(fdiv.replace("BEGIN\n", "BEGIN\n  -- outra mudança\n", 1) + "\n" + pre_ok)

pos_ok = sem(m, "post") if sab == "pos_removida" else m
b = bloco_view(pos_ok, "v_promocao_avaliacao_hoje")
if b.count("'ativa'::text") != 1:
    sys.exit("literal da adulteração não achado na migration")
open(tmpd + "/g2.sql", "w", encoding="utf-8").write(pos_ok.replace(b, b.replace("'ativa'::text", "'ativa '::text")))
open(tmpd + "/g3.sql", "w", encoding="utf-8").write(m)
if "DO $post$" in pos_ok:
    g4 = pos_ok.replace("DO $post$", "REVOKE EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) FROM authenticated;\nDO $post$", 1)
else:
    g4 = pos_ok + "\nREVOKE EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) FROM authenticated;\n"
open(tmpd + "/g4.sql", "w", encoding="utf-8").write(g4)
com = "  WITH (security_invoker = on)\n"
if b.count(com) != 1:
    sys.exit("WITH do security_invoker não achado 1x")
open(tmpd + "/g5.sql", "w", encoding="utf-8").write(pos_ok.replace(b, b.replace(com, "")))
fb = bloco_funcao(pos_ok, "ciclo_oportunidade_do_dia")
novo = "p_data_ciclo date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date"
if fb.count(novo) != 1:
    sys.exit("DEFAULT novo não achado 1x em ciclo_oportunidade_do_dia")
open(tmpd + "/g7.sql", "w", encoding="utf-8").write(pos_ok.replace(fb, fb.replace(novo, "p_data_ciclo date DEFAULT (now())::date")))
PYG
eq G1 "view predecessora divergente: a migration aborta na PRÉ" "$(Tenta "$TMPD/g1.sql" P0001 'PRE FALHOU')" NEGOU
eq G2 "texto de view adulterado: a PÓS recusa" "$(Tenta "$TMPD/g2.sql" P0001 'POS2 FALHOU')" NEGOU
eq G3 "re-aplicar a migration sobre ela mesma passa" "$(Tenta "$TMPD/g3.sql" P0001 'nunca')" PASSOU
eq G4 "ACL de função mexido no meio da migration: a PÓS recusa" "$(Tenta "$TMPD/g4.sql" P0001 'POS6 FALHOU')" NEGOU
eq G5 "view recriada sem security_invoker: a PÓS recusa" "$(Tenta "$TMPD/g5.sql" P0001 'POS4 FALHOU')" NEGOU
eq G6 "função predecessora divergente: a migration aborta na PRÉ" "$(Tenta "$TMPD/g6.sql" P0001 'PRE FALHOU')" NEGOU
eq G7 "função instalada com outro DEFAULT: a PÓS recusa" "$(Tenta "$TMPD/g7.sql" P0001 'POS2 FALHOU')" NEGOU

# ── SABOTAGEM (só no modo --falsificar) — no BANCO, recriando o objeto com o trecho trocado; o repo nunca
# é tocado. Cada padrão tem de ocorrer exatamente n× no bloco: uma troca que não pegou deixaria a suíte
# verde (e o laço, que exige vermelho no assert certo, acusa em vez de aprovar).
SP_DIA_VIEW="(now() AT TIME ZONE 'America/Sao_Paulo'::text)::date"
SP_DIA_CORPO="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
SP_DEFAULT="((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date"
# O GÊMEO controlável do texto antigo: o dia truncado no fuso da SESSÃO. Monta-se das peças (as agulhas
# inteiras não aparecem neste arquivo: os gates de prova leem todo shell de db/).
AGORA="now()"
GEMEO_DIA="(${AGORA})::date"
sabotar() {   # <view|funcao> <nome> <de> <para> <n> [<de> <para> <n> ...]
  local tipo="$1" nome="$2" tmp
  shift 2
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$MIG" "$tipo" "$nome" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, tipo, nome, out, trocas = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
s = open(mig, encoding="utf-8").read()
if tipo == "view":
    ini = s.find("CREATE OR REPLACE VIEW public." + nome + "\n")
    fim = s.find(";\n", ini) + 1 if ini >= 0 else -1
else:
    ini = s.find("CREATE OR REPLACE FUNCTION public." + nome + "(")
    fim = s.find("$function$;\n", ini) + len("$function$;") if ini >= 0 else -1
if ini < 0 or fim <= 0:
    print("   " + nome + " não delimitada em " + mig, file=sys.stderr); sys.exit(1)
bloco = s[ini:fim]
for i in range(0, len(trocas), 3):
    de, para, n = trocas[i], trocas[i + 1], int(trocas[i + 2])
    if bloco.count(de) != n:
        print("   padrão ocorre %dx, esperado %d: %r" % (bloco.count(de), n, de), file=sys.stderr); sys.exit(1)
    bloco = bloco.replace(de, para)
open(out, "w", encoding="utf-8").write(bloco + "\n")
PYSAB
  PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$tmp" >/dev/null
  rm -f "$tmp"
}
case "$SABOTAGEM" in
  "") ;;
  sem_pin|sem_trava|trava_na_ordem_errada|pre_removida|pos_removida) ;;   # agem mais adiante (pin, K, G)
  sessao_v_promocao_avaliacao_hoje)     sabotar view v_promocao_avaliacao_hoje "$SP_DIA_VIEW" "$GEMEO_DIA" 2 ;;
  sessao_v_oportunidade_economica_hoje) sabotar view v_oportunidade_economica_hoje "$SP_DIA_VIEW" "$GEMEO_DIA" 5 ;;
  # o dia tirado do relógio de parede, que o controlado não intercepta
  promocao_de_parede) sabotar view v_promocao_avaliacao_hoje "$SP_DIA_VIEW" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'::text)::date" 2 ;;
  # o fuso ESCRITO, mas o errado
  promocao_em_utc_escrito) sabotar view v_promocao_avaliacao_hoje "$SP_DIA_VIEW" "(now() AT TIME ZONE 'UTC'::text)::date" 2 ;;
  default_sessao_ciclo_oportunidade_do_dia)     sabotar funcao ciclo_oportunidade_do_dia "$SP_DEFAULT" "$GEMEO_DIA" 1 ;;
  default_sessao_gerar_pedidos_sugeridos_ciclo) sabotar funcao gerar_pedidos_sugeridos_ciclo "$SP_DEFAULT" "$GEMEO_DIA" 1 ;;
  default_sessao_aplicar_promocoes_no_ciclo)    sabotar funcao aplicar_promocoes_no_ciclo "$SP_DEFAULT" "$GEMEO_DIA" 1 ;;
  # o corte convertido no fuso da sessão (o texto antigo)
  corte_na_sessao_oportunidade)
    sabotar funcao gerar_pedidos_oportunidade_ciclo "((p_data_ciclo + TIME '18:00') AT TIME ZONE 'America/Sao_Paulo')" "(p_data_ciclo + TIME '18:00')::timestamptz" 1 ;;
  corte_na_sessao_normal)
    sabotar funcao gerar_pedidos_sugeridos_ciclo "((p_data_ciclo + MAX(sn.horario_corte_pedido)) AT TIME ZONE 'America/Sao_Paulo')" "(p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz" 1 ;;
  sessao_data_health)  sabotar funcao _data_health_compute "$SP_DIA_CORPO" "$GEMEO_DIA" 2 ;;
  sessao_pos_candidatos) sabotar funcao reposicao_pos_candidatos "$SP_DIA_CORPO" "$GEMEO_DIA" 1 ;;
  sessao_param_auto)   sabotar funcao atualizar_parametros_numericos_skus "$SP_DIA_CORPO" "$GEMEO_DIA" 1 ;;
  default_sessao_coluna_data_ciclo)
    PGOPTIONS="-c search_path=public,pg_catalog" P -q -c "ALTER TABLE public.pedido_compra_sugerido ALTER COLUMN data_ciclo SET DEFAULT $GEMEO_DIA;" >/dev/null ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# Os CORPOS resolvem nomes ao executar, pelo search_path do proconfig ('public, pg_temp' — pg_catalog
# implícito PRIMEIRO): o now() deles seria o de parede. Aqui `public` vem antes, e o tripwire pega todo
# corpo que ler o relógio sem test.agora (feito DEPOIS da sabotagem, que recria a função e reseta o SET).
P -q <<'SQL'
ALTER FUNCTION public.aplicar_promocoes_no_ciclo(text, date) SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public.ciclo_oportunidade_do_dia(text, date) SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public.gerar_pedidos_oportunidade_ciclo(text, date, text[]) SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public.gerar_pedidos_sugeridos_ciclo(text, date) SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public._data_health_compute() SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public.atualizar_parametros_numericos_skus(text, uuid) SET search_path = public, pg_catalog, pg_temp;
ALTER FUNCTION public.reposicao_pos_candidatos(text) SET search_path = public, pg_catalog, pg_temp;
SQL

# O pin: toda conexão nova nasce em 12/03/2025 15:00Z (12:00 BRT, o mesmo dia nos dois fusos). Z0 lê por
# ele; os blocos por sessão trocam o instante no pacote de conexão.
if [ "$SABOTAGEM" != sem_pin ]; then
  P -q -c "ALTER DATABASE prove SET test.agora = '2025-03-12 15:00:00+00';"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (datas e instantes LITERAIS; nenhuma semente lê relógio). D = qua 12/03/2025. Cada linha
# nasce para ENTRAR em D e SAIR em D+1, ou mudar de valor na virada — é o que dá dente ao controle (c).
# `session_replication_role = replica`: sem gatilhos nem FKs (a semente não é o objeto sob prova).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
SET session_replication_role = replica;
-- Produtos (com tipo_produto: o motor recusa rodar sem o sinal de classificação) e o fornecedor, com o
-- corte cadastrado às 10:00 (hora de SP).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, account, descricao, familia, ativo, tipo_produto) VALUES
  (5101, 'SKU-5101', 'oben', 'Produto do aumento', 'FAM-AUMENTO', true, '00'),
  (5102, 'SKU-5102', 'oben', 'Produto da promocao', 'FAM-PROMO', true, '00'),
  (5103, 'SKU-5103', 'oben', 'Produto em transito', 'FAM-TRANSITO', true, '00'),
  (5104, 'SKU-5104', 'oben', 'Produto do motor', 'FAM-MOTOR', true, '00');
INSERT INTO public.fornecedor_habilitado_reposicao (empresa, fornecedor_nome, habilitado, horario_corte_pedido, lt_logistica_dias)
VALUES ('OBEN', 'FORNECEDOR CICLO', true, '10:00', 7);
-- 5101: o aumento (demanda > 0 dá a quantidade da oportunidade; as vendas dão o preço do EOQ); 5102: a
-- promoção; 5104: abaixo do ponto de pedido — o motor normal o compra. 5101 e 5102 fora do motor.
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                                   habilitado_reposicao_automatica, tipo_reposicao, demanda_media_diaria, classe_abc, ativo) VALUES
  ('OBEN', 5101, 'Produto do aumento', 'FORNECEDOR CICLO', 3, 5, false, 'manual', 2, 'A', true),
  ('OBEN', 5102, 'Produto da promocao', 'FORNECEDOR CICLO', 3, 5, false, 'manual', 1, 'A', true),
  ('OBEN', 5104, 'Produto do motor', 'FORNECEDOR CICLO', 3, 5, true, 'automatica', 0.5, 'A', true);
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
  ('OBEN', '5104', 1, 0, 'ListarPosEstoque'),
  ('OBEN', '5103', 2, 0, 'ListarPosEstoque');
INSERT INTO public.venda_items_history (empresa, data_emissao, sku_codigo_omie, sku_codigo, quantidade, valor_unitario, valor_total, cfop, nfe_chave_acesso) VALUES
  ('OBEN', DATE '2025-03-03', 5101, 'SKU-5101', 10, 20, 200, '5102', 'NFE-5101-A'),
  ('OBEN', DATE '2025-02-14', 5101, 'SKU-5101', 12, 20, 240, '5102', 'NFE-5101-B'),
  ('OBEN', DATE '2025-01-20', 5101, 'SKU-5101', 8, 20, 160, '5102', 'NFE-5101-C');
-- A campanha: vigente de D-10 a D (data_fim = D: some à 00:00 de SP de D+1), com corte de pedido em D e
-- pedido de oportunidade permitido; um item flat do 5102.
INSERT INTO public.promocao_campanha (id, empresa, fornecedor_nome, nome, tipo_origem, estado, data_inicio, data_fim,
                                      data_corte_pedido, permite_pedido_oportunidade)
VALUES (8101, 'OBEN', 'FORNECEDOR CICLO', 'Campanha da prova', 'oficial_mensal', 'ativa', DATE '2025-03-02', DATE '2025-03-12', DATE '2025-03-12', true);
INSERT INTO public.promocao_item (id, campanha_id, sku_codigo_fornecedor, sku_codigo_omie, desconto_perc, ativo, confirmado)
VALUES (8111, 8101, 'F-5102', '5102', 10, true, true);
-- O aumento: vigência em D+1 (D é a véspera), na família do 5101.
INSERT INTO public.fornecedor_aumento_anunciado (id, empresa, fornecedor_nome, nome, data_vigencia, estado)
VALUES (7201, 'OBEN', 'FORNECEDOR CICLO', 'Aumento da prova', DATE '2025-03-13', 'ativo');
INSERT INTO public.fornecedor_aumento_item (id, aumento_id, categoria_fornecedor, aumento_perc, confirmado, ativo)
VALUES (7211, 7201, 'CAT-PROVA', 8, true, true);
INSERT INTO public.categoria_aumento_familia_mapeamento (aumento_item_id, familia_omie) VALUES (7211, 'FAM-AUMENTO');
-- Pedidos sugeridos: 9301 e 9401 pendentes NORMAIS do ciclo de HOJE (D) — a RPC do motor os expira se abrir
-- o ciclo D+1; 9401 tem o item 5102, que a promoção flat alcança. 9501: o ciclo mais antigo de pé, D-3 (a
-- frescura da sugestão). 9601: disparado em D-7 (idade 7 em D, 8 em D+1). 9701: aprovado em D-7 com 4
-- unidades do 5103 a caminho (dentro da janela de 7 dias em D, fora em D+1).
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, tipo_ciclo, omie_pedido_compra_id) VALUES
  (9301, 'OBEN', 'FORNECEDOR CICLO', DATE '2025-03-12', 'pendente_aprovacao', 'normal', NULL),
  (9401, 'OBEN', 'FORNECEDOR CICLO', DATE '2025-03-12', 'pendente_aprovacao', 'normal', NULL),
  (9501, 'OBEN', 'FORNECEDOR CICLO', DATE '2025-03-09', 'concluido_recebido', 'normal', NULL),
  (9601, 'OBEN', 'FORNECEDOR CICLO', DATE '2025-03-05', 'disparado', 'normal', '9601'),
  (9701, 'OBEN', 'FORNECEDOR CICLO', DATE '2025-03-05', 'aprovado_aguardando_disparo', 'normal', NULL);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario, valor_linha) VALUES
  (9401, '5102', 10, 10, 50, 500),
  (9701, '5103', 4, 4, 30, 120);
-- O marcador do sync de POs (a âncora dos candidatos) e a linha de log do run de parâmetros (a posição do
-- 5103 = físico 2 + a caminho 4 → compra 20 − 6 = 14; sem o a caminho, 18).
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, status, volume_ok, finalizado_em)
VALUES ('0e000000-0000-0000-0000-000000000001', 'OBEN', DATE '2025-01-01', DATE '2025-03-12', 1, 'ok', true, '2025-03-12 12:00:00+00');
INSERT INTO public.reposicao_param_auto_log (run_id, empresa, sku_codigo_omie, status, ponto_pedido_antes, ponto_pedido_depois,
                                             estoque_maximo_antes, estoque_maximo_depois)
VALUES ('0e000000-0000-0000-0000-0000000000f7', 'OBEN', '5103', 'aplicado', 10, 10, 20, 20);
SQL
# _data_health_compute lê a matview de métricas de cliente — ela vem do snapshot SEM dados.
P -q -c "REFRESH MATERIALIZED VIEW private.customer_metrics_mv;"

# ══════════════════════════════════════════════════════════════════════════════
# CONTROLES E BLOCOS
# ══════════════════════════════════════════════════════════════════════════════
T1='2025-03-12T23:59:59Z'   # 20:59:59 BRT de D
T2='2025-03-13T00:00:00Z'   # 21:00:00 BRT de D — o UTC já é D+1
T3='2025-03-13T02:59:59Z'   # 23:59:59 BRT de D
T4='2025-03-13T03:00:00Z'   # 00:00:00 BRT de D+1
UTC=UTC; SPZ=America/Sao_Paulo
digital_de() {   # <view> — a impressão digital de uma leitura
  printf "SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.%s t" "$1"
}
bloco() {   # <id> <descrição> <sql...> — os 4 asserts nos 4 instantes, sob UTC e SP
  local id="$1" desc="$2" u1 u2 u3 u4 s1 s2 s3
  shift 2
  u1="$(Ler "$UTC" "$T1" "$@")"; u2="$(Ler "$UTC" "$T2" "$@")"; u3="$(Ler "$UTC" "$T3" "$@")"; u4="$(Ler "$UTC" "$T4" "$@")"
  s1="$(Ler "$SPZ" "$T1" "$@")"; s2="$(Ler "$SPZ" "$T2" "$@")"; s3="$(Ler "$SPZ" "$T3" "$@")"
  iguais "${id}a" "$desc: 21:00:00 BRT = 20:59:59 (sessão UTC)" "$u2" "$u1"
  iguais "${id}b" "$desc: sessão UTC = sessão SP às 23:59:59 BRT" "$u3" "$s3"
  diferentes "${id}c" "$desc: vira à 00:00:00 BRT de D+1 (sessão UTC)" "$u3" "$u4"
  iguais "${id}d" "$desc: 21:00:00 BRT = 20:59:59 (sessão SP)" "$s2" "$s1"
}

# Z0: lida SEM instante no pacote de conexão (vale o pin), a view dá o mesmo que no instante do pin.
LerPin() { Pq -q -c "$1" 2>&1 || true; }
iguais Z0 "v_promocao_avaliacao_hoje pelo pin = no instante do pin" \
  "$(LerPin "$(digital_de v_promocao_avaliacao_hoje)")" "$(Ler "$UTC" '2025-03-12T15:00:00Z' "$(digital_de v_promocao_avaliacao_hoje)")"

echo "── a (21:00 = 20:59:59, UTC) · b (UTC = SP às 23:59:59) · c (muda à 00:00 de SP) · d (a, sob SP)"
bloco V1 "v_promocao_avaliacao_hoje" "$(digital_de v_promocao_avaliacao_hoje)"
bloco V2 "v_oportunidade_economica_hoje" "$(digital_de v_oportunidade_economica_hoje)"
# F1: o DEFAULT exercido — o cron 08:05 e o botão da tela Oportunidades chamam SEM data.
bloco F1 "ciclo_oportunidade_do_dia('OBEN') sem data: executou|motivo" \
  "SELECT executou || '|' || motivo FROM public.ciclo_oportunidade_do_dia('OBEN')"
# F3: o motor sem data abre o ciclo de HOJE e NÃO expira os pendentes de hoje (o defeito do botão noturno).
bloco F3 "gerar_pedidos_sugeridos_ciclo('OBEN') sem data: ciclo|pendentes de D expirados" \
  "DO \$\$ BEGIN PERFORM public.gerar_pedidos_sugeridos_ciclo('OBEN'); END \$\$" \
  "SELECT (SELECT max(data_ciclo) FROM public.reposicao_motor_run) || '|' ||
          (SELECT count(*) FROM public.pedido_compra_sugerido WHERE id IN (9301, 9401) AND status = 'expirado_sem_aprovacao')"
# F4: a promoção que termina HOJE entra no ciclo de HOJE às 21h (view e DEFAULT no mesmo dia).
bloco F4 "aplicar_promocoes_no_ciclo('OBEN') sem data: itens flat aplicados" \
  "SELECT itens_flat_aplicados FROM public.aplicar_promocoes_no_ciclo('OBEN')"
# F5: a frescura da sugestão de compra — o ciclo mais novo de pé é D-3 (os de D saem nesta transação).
bloco F5 "_data_health_compute(): status|idade da sugestão de compra" \
  "SET LOCAL session_replication_role = replica" \
  "DELETE FROM public.pedido_compra_sugerido WHERE data_ciclo > DATE '2025-03-09'" \
  "SELECT status || '|' || age_seconds FROM public._data_health_compute() WHERE source = 'reposicao_sugestoes'"
# F6: a idade do PO disparado em D-7 e a janela de 7 dias.
bloco F6 "reposicao_pos_candidatos('OBEN'): idade|na janela de 7 dias" \
  "SELECT idade_dias || '|' || na_janela_7d FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id = 9601"
# F7: a posição do 5103 conta o a caminho de D-7 enquanto o dia de SP é D.
bloco F7 "atualizar_parametros_numericos_skus(run): compra depois (posição com o a caminho)" \
  "DO \$\$ BEGIN PERFORM public.atualizar_parametros_numericos_skus('OBEN', '0e000000-0000-0000-0000-0000000000f7'); END \$\$" \
  "SELECT qtde_compra_depois FROM public.reposicao_param_auto_log WHERE run_id = '0e000000-0000-0000-0000-0000000000f7'"
# DEF: a linha que OMITE data_ciclo, inserida e desfeita em cada instante.
bloco DEF "pedido_compra_sugerido.data_ciclo DEFAULT" \
  "SET LOCAL session_replication_role = replica" \
  "INSERT INTO public.pedido_compra_sugerido (empresa) VALUES ('OBEN') RETURNING data_ciclo"

echo "── F2: o corte em HORA DE SP (a data é explícita: aqui só a conversão do instante está em jogo)"
corte() {   # <TimeZone> <sql do motor> <filtro do pedido novo>
  Ler "$1" "$T1" "DO \$\$ BEGIN PERFORM $2; END \$\$" \
    "SELECT string_agg(DISTINCT to_char(horario_corte_planejado AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI'), ',')
       FROM public.pedido_compra_sugerido WHERE $3"
}
eq F2a "oportunidade de D gerada sob sessão UTC: corte às 18:00 de SP" \
  "$(corte "$UTC" "public.gerar_pedidos_oportunidade_ciclo('OBEN', DATE '2025-03-12')" "tipo_ciclo LIKE 'oportunidade_%'")" "2025-03-12 18:00"
eq F2b "ciclo normal de D gerado sob sessão UTC: corte às 10:00 de SP (o cadastro do fornecedor)" \
  "$(corte "$UTC" "public.gerar_pedidos_sugeridos_ciclo('OBEN', DATE '2025-03-12')" "tipo_ciclo = 'normal' AND id NOT IN (9301, 9401, 9501, 9601, 9701)")" "2025-03-12 10:00"
eq F2c "o mesmo ciclo normal sob sessão SP (controle: o corte não depende do fuso da sessão)" \
  "$(corte "$SPZ" "public.gerar_pedidos_sugeridos_ciclo('OBEN', DATE '2025-03-12')" "tipo_ciclo = 'normal' AND id NOT IN (9301, 9401, 9501, 9601, 9701)")" "2025-03-12 10:00"

echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$PASS" -ne "$TOTAL_ESPERADO" ] && [ "$FAIL" -eq 0 ]; then
  echo "❌ $PASS asserts executados, esperados $TOTAL_ESPERADO — a prova foi TRUNCADA (FAIL=0 com PASS encolhido não é verde)"
  exit 1
fi
[ "$FAIL" -eq 0 ]
