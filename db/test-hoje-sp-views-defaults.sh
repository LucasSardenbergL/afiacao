#!/usr/bin/env bash
# REGRESSÃO — o "hoje" de 18 views e de 6 DEFAULTs de coluna é o de SÃO PAULO, seja qual for o fuso da
# SESSÃO (20260930230623_hoje_sp_views_defaults_classe_ii.sql — a fase 2 da classe (ii), o dia lido NU).
#
# A prod roda sessão UTC. Das 21:00 às 23:59 BRT o dia da sessão já é o seguinte, e as views liam
# CURRENT_DATE / now()::date / created_at::date nus: o aging passava o título que vence hoje para
# "vencido", as janelas de 90/180 dias da reposição andavam um dia, a recência da Caça ganhava +1, os
# DEFAULTs carimbavam amanhã. E a borda contra TIMESTAMPTZ (sku_leadtime_history.t2_data_faturamento)
# caía às 21:00 BRT o dia inteiro, porque `dia - '180 days'` é timestamp sem fuso.
#
# O que se prova, por view (V01-V18) e por DEFAULT (D01-D06), com os mesmos 4 asserts:
#   a — sob sessão UTC, às 21:00:00 BRT de D o resultado é o MESMO das 20:59:59 (o dia de SP não virou);
#   b — às 23:59:59 BRT de D, sessão UTC e sessão SP dão o MESMO resultado (fuso da sessão não importa);
#   c — CONTROLE POSITIVO: sob sessão UTC, à 00:00:00 BRT de D+1 o resultado MUDA (a view lê o relógio
#       controlado e a semente é sensível à virada — sem ele, a e b passariam por vacuidade);
#   d — o mesmo que (a) sob sessão SP: tem de ficar VERDE na sabotagem do gêmeo da sessão (o defeito só
#       aparece na sessão UTC), e só a sabotagem do UTC ESCRITO o derruba.
# Mais: P01-P24 (a predecessora de cada objeto bate o md5/texto EXATO da prod — o ensaio do predicado da
# PRÉ), K1/K2 (a trava), K3 (a ORDEM da trava é a dos leitores), Z0 (o pin), G1 (a PRÉ recusa predecessora
# divergente), G2/G4/G5 (a PÓS recusa texto adulterado, ACL mexido e security_invoker perdido) e G3
# (re-aplicar é seguro).
#
# ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) sem a GUC. `CURRENT_DATE` NÃO é
# função — nenhum sombreamento o alcança —, por isso o corpo antigo não entra na falsificação como tal:
# entra o GÊMEO controlável dele (`now()::date`, o dia truncado no fuso da SESSÃO).
#
# Rodar:   bash db/test-hoje-sp-views-defaults.sh > log 2>&1; echo $?
#          bash db/test-hoje-sp-views-defaults.sh --falsificar > log 2>&1
# matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5497}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="hoje-sp-views-defaults"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20260930230623_hoje_sp_views_defaults_classe_ii.sql"
FIX="$REPO_ROOT/db/fixtures/hoje-sp-views-defaults-predecessoras-prod-20260930.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
# Denominador: P01-P24 · K1 K2 K3 · Z0 · V01-V18 × a,b,c,d · D01-D06 × a,b,c,d · G1-G5.
TOTAL_ESPERADO=129

# As 18 views, na ordem da migration, e quantos sítios do relógio cada uma tem (a sabotagem do gêmeo da
# sessão exige exatamente esta contagem: uma troca que não pegou deixaria a suíte verde).
VIEWS="V01:fin_aging_pagar:16 V02:fin_aging_receber:16 V03:fin_fluxo_caixa_diario:2
       V04:v_caca_candidatos:3 V05:v_caca_compradores:2 V06:v_desconto_flat_condicional_ativo:4
       V07:v_fornecedor_lt_logistica_total:1 V08:v_grupo_comercial:6 V09:v_grupo_contas_receber:8
       V10:v_grupo_contas_receber_por_doc:1 V11:v_sku_aumento_vigente:1 V12:v_sku_candidatos_primeira_compra:2
       V13:v_sku_demanda_estatisticas:1 V14:v_sku_demanda_rajada:4 V15:v_sku_leadtime_estatisticas:2
       V16:v_sku_parametros_sugeridos:2 V17:v_sku_sigma_demanda:3 V18:v_sugestao_negociacao_ativa:2"
DEFAULTS="D01:farmer_agenda:agenda_date D02:fornecedor_cadeia_logistica:valido_desde
          D03:priority_score_log:score_date D04:sku_embalagem_equivalencia:vigente_desde
          D05:sugestao_negociacao_paralela:data_geracao D06:sugestao_negociacao_paralela:valido_ate"

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas as
# sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar vermelhos por
# RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro de execução —
# sabotagem que não aplicou, SQL quebrado, saída vazia, tripwire — NÃO mata mutante e reprova a
# falsificação; a única exceção é declarada POR ASSERT (`ID!MARCA`: sem_pin, cujo vermelho esperado É o
# tripwire no assert que lê pelo pin).
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  # Uma por view (o GÊMEO da sessão: vermelha em a/b/c, verde em d) e por DEFAULT (vermelha em a/b; o c dos
  # DEFAULTs é valor absoluto que o gêmeo também acerta — quem o derruba é o relógio de parede). Candidatos
  # (V12) e parâmetros (V16) leem OUTRAS views da leva, já consertadas: a saída delas muda à 00:00 de SP
  # pelas filhas mesmo com o relógio próprio sabotado — o c não discrimina ali; a e b sim.
  SABOTAGENS="sessao_fin_aging_pagar:V01a,V01b,V01c:V01d
              sessao_fin_aging_receber:V02a,V02b,V02c:V02d
              sessao_fin_fluxo_caixa_diario:V03a,V03b,V03c:V03d
              sessao_v_caca_candidatos:V04a,V04b,V04c:V04d
              sessao_v_caca_compradores:V05a,V05b,V05c:V05d
              sessao_v_desconto_flat_condicional_ativo:V06a,V06b,V06c:V06d
              sessao_v_fornecedor_lt_logistica_total:V07a,V07b,V07c:V07d
              sessao_v_grupo_comercial:V08a,V08b,V08c:V08d
              sessao_v_grupo_contas_receber:V09a,V09b,V09c:V09d
              sessao_v_grupo_contas_receber_por_doc:V10a,V10b,V10c:V10d
              sessao_v_sku_aumento_vigente:V11a,V11b,V11c:V11d
              sessao_v_sku_candidatos_primeira_compra:V12a,V12b:V12d
              sessao_v_sku_demanda_estatisticas:V13a,V13b,V13c:V13d
              sessao_v_sku_demanda_rajada:V14a,V14b,V14c:V14d
              sessao_v_sku_leadtime_estatisticas:V15a,V15b,V15c:V15d
              sessao_v_sku_parametros_sugeridos:V16a,V16b:V16d
              sessao_v_sku_sigma_demanda:V17a,V17b,V17c:V17d
              sessao_v_sugestao_negociacao_ativa:V18a,V18b,V18c:V18d
              default_sessao_agenda_date:D01a,D01b:D01c,D01d
              default_sessao_valido_desde:D02a,D02b:D02c,D02d
              default_sessao_score_date:D03a,D03b:D03c,D03d
              default_sessao_vigente_desde:D04a,D04b:D04c,D04d
              default_sessao_data_geracao:D05a,D05b:D05c,D05d
              default_sessao_valido_ate:D06a,D06b:D06c,D06d
              leadtime_borda_ingenua:V15b:V15a,V15c,V15d
              aging_de_parede:V01c:V01a,V01b,V01d
              aging_em_utc_escrito:V01a,V01c,V01d:V01b
              score_date_de_parede:D03a,D03c,D03d:D03b
              sem_pin:Z0!TRIPWIRE:V01a,V02a
              sem_trava:K1,K2:P01,P02
              trava_na_ordem_errada:K3:K1,K2
              pre_removida:G1:G2,G3
              pos_removida:G2,G4,G5:G1,G3"
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
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Leitura com sessão MONTADA: fuso e relógio entram pelo pacote de conexão (PGOPTIONS), que vence o pin do
# banco. `2>&1`: o erro vira o VALOR lido, e o assert o classifica como execução.
Ler() {   # <TimeZone> <test.agora> <sql>
  PGOPTIONS="-c TimeZone=$1 -c test.agora=$2" Pq -q -c "$3" 2>&1 || true
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
# Impressões digitais de uma leitura (`linhas:md5`): as duas têm de ser válidas para o veredito contar.
digital() { printf '%s' "$1" | grep -Eq '^[0-9]+:[0-9a-f]{32}$'; }
iguais() {   # <id> <descrição> <v1> <v2>
  if ! digital "$3" || ! digital "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" = "$4" ]; then ok "$1" "$2 (${3%%:*} linhas)"; else bad "$1" "$2 — [$3] ≠ [$4]"; fi
}
diferentes() {   # <id> <descrição> <v1> <v2>
  if ! digital "$3" || ! digital "$4"; then
    erro_exec "$1" "$2 — leitura inválida: [$(printf '%s | %s' "$3" "$4" | tr '\n' ' ' | head -c 220)]"
  elif [ "$3" != "$4" ]; then ok "$1" "$2 (${3%%:*} → ${4%%:*} linhas)"; else bad "$1" "$2 — não mudou na virada: [$3]"; fi
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
# RELÓGIO CONTROLADO — criado ANTES dos objetos: a view e o DEFAULT amarram o `now()` no CREATE/ALTER
# (pelo search_path de quem cria). `public.now()` lê a GUC `test.agora` e é TRIPWIRE: sem ela levanta
# Z9T01 em vez de cair no relógio de parede.
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

# ══════════════════════════════════════════════════════════════════════════════
# AS PREDECESSORAS — o que a prod tinha em 2026-09-30, da fixture (o snapshot perdeu as barras invertidas
# dos literais de regex, e um re-dump pós-apply traria as consertadas). Carregadas com `public` antes de
# `pg_catalog`: as views de Caça leem now() e se amarram ao controlado — o deparse sai o mesmo `now()`.
# P01-P18: o md5 EXATO de cada view, sob o search_path em que a migration roda aqui, é o medido na prod;
# P19-P24: o texto de cada DEFAULT (pg_get_expr) é o da prod. É o ensaio do predicado da PRÉ-condição.
# ══════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIX"
# O ACL de PROD nas 18 views (psql-ro, 2026-09-30): anon/authenticated/service_role com tudo, e 4 delas sem
# SELECT para anon. O snapshot vem SEM privilégios — sem isto a foto do ACL na PRÉ e a POS6 comparariam
# NULL com NULL, e o predicado que estreia na prod nunca teria sido exercido aqui.
P -q -c "GRANT ALL ON public.fin_aging_pagar, public.fin_aging_receber, public.fin_fluxo_caixa_diario, public.v_caca_candidatos,
  public.v_caca_compradores, public.v_desconto_flat_condicional_ativo, public.v_fornecedor_lt_logistica_total,
  public.v_grupo_comercial, public.v_grupo_contas_receber, public.v_grupo_contas_receber_por_doc, public.v_sku_aumento_vigente,
  public.v_sku_candidatos_primeira_compra, public.v_sku_demanda_estatisticas, public.v_sku_demanda_rajada,
  public.v_sku_leadtime_estatisticas, public.v_sku_parametros_sugeridos, public.v_sku_sigma_demanda,
  public.v_sugestao_negociacao_ativa TO anon, authenticated, service_role;
  REVOKE SELECT ON public.v_sku_candidatos_primeira_compra, public.v_sku_demanda_estatisticas, public.v_sku_demanda_rajada,
  public.v_sku_sigma_demanda FROM anon;"
MD5_PROD="fin_aging_pagar:2d02bd1acd7a9a8aa48f18d0ee6691f3 fin_aging_receber:28e6654b9a0f7b4a1b35ab9bd906afa3
          fin_fluxo_caixa_diario:33398b163ad8d20a8380f23776d27fe3
          v_caca_candidatos:b90a93708c25bc47179d858a729256d0
          v_caca_compradores:cd931d3bc04ed42f8c9d6b2650121b90
          v_desconto_flat_condicional_ativo:ead12cfd33d772255eb6e5b23704b2e8
          v_fornecedor_lt_logistica_total:ed557e9f9f59fb99f73eddfdec42b131
          v_grupo_comercial:4f46e679984cc08fe923a29fc10f1932
          v_grupo_contas_receber:0eabf4bd91c081fb9145bb1ff7ccbd38
          v_grupo_contas_receber_por_doc:7cc116d7e46519514a2ec5dfce2f9aa3
          v_sku_aumento_vigente:1030e9629dca90d57b9a01c442ef8068
          v_sku_candidatos_primeira_compra:e7e0fe5a21deb5f8a57bc92a94fb5add
          v_sku_demanda_estatisticas:c7709f8bf2895a3d5fa3d27fb1cf3392
          v_sku_demanda_rajada:0b33fed6f59248e67fe4f69e827d4385
          v_sku_leadtime_estatisticas:c79f588df7d2730bed30538a42990824
          v_sku_parametros_sugeridos:7ab48641a711d5a335ae88941a1537e5
          v_sku_sigma_demanda:f6070e0a25bce59593ee5e00cfa5814b
          v_sugestao_negociacao_ativa:d65d940ac9384ddf86c4c8d6987eb704"
Exec() { PGOPTIONS="-c search_path=public,pg_catalog,pg_temp" Pq -c "$1" 2>&1 || true; }
n=0
for par in $MD5_PROD; do
  n=$((n+1)); nome="${par%%:*}"; md5="${par#*:}"
  eq "$(printf 'P%02d' "$n")" "$nome predecessora = prod" \
    "$(Exec "SELECT md5(pg_get_viewdef('public.$nome'::regclass, true))")" "$md5"
done
expr_default() {   # <tabela> <coluna>
  Exec "SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = 'public.$1'::regclass AND a.attname = '$2'"
}
DIA_SESSAO="CURRENT""_DATE"   # a agulha partida: o texto antigo do DEFAULT, sem citá-lo inteiro
for item in $DEFAULTS; do
  n=$((n+1)); resto="${item#*:}"; tab="${resto%%:*}"; col="${resto#*:}"
  esperado="$DIA_SESSAO"; [ "$col" = valido_ate ] && esperado="($DIA_SESSAO + '14 days'::interval)"
  eq "$(printf 'P%02d' "$n")" "$tab.$col predecessor = prod" "$(expr_default "$tab" "$col")" "$esperado"
done

# ══════════════════════════════════════════════════════════════════════════════
# K — A TRAVA. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a transação aberta: o
# instante em que, sem trava, outra transação recriaria a view (ou trocaria o DEFAULT) e o replace a
# apagaria em silêncio. B tenta mexer com lock_timeout e tem de ser BARRADA (55P03). As mexidas de B não
# têm efeito (security_invoker igual; SET STATISTICS -1 é o valor que já está): o que se mede é se ela
# CONSEGUE o lock. sem_trava: a sessão A roda só a pré-condição.
# K1 sonda fin_aging_pagar, que nenhuma outra view desta leva lê (o deparse da PRÉ trava as relações que
# cada view lê — AcquireRewriteLocks —, e uma view lida por outra seria barrada com ou sem a trava); K2
# sonda priority_score_log, que nenhuma view lê.
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
PGOPTIONS="-c search_path=public,pg_catalog" "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove \
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
eq K1 "com A parada após a pré-condição, B não mexe na view" \
  "$(barra "ALTER VIEW public.fin_aging_pagar SET (security_invoker = on)")" BARROU
eq K2 "... nem na tabela de um DEFAULT" \
  "$(barra "ALTER TABLE public.priority_score_log ALTER COLUMN score_date SET STATISTICS -1")" BARROU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true
# K3: a ORDEM das views na trava é a dos LEITORES (medida no PG17 com o schema da prod: um leitor de
# v_oportunidade_economica_hoje trava v_sku_aumento_vigente antes de v_sku_parametros_sugeridos; um de
# v_sku_parametros_sugeridos trava rajada, lead time, sigma e só então as netas). Outra ordem = deadlock com
# a tela ou o cron que lê a cadeia no mesmo instante. trava_na_ordem_errada: aumento e parâmetros trocados.
python3 - "$MIG" "$SABOTAGEM" <<'PYK3' > "$TMPD/k3.txt"
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
ini, fim = s.find("DO $trava$"), s.find("$trava$;")
nomes = re.findall(r"ALTER VIEW public\.(\w+)", s[ini:fim])
if sys.argv[2] == "trava_na_ordem_errada":
    i, j = nomes.index("v_sku_aumento_vigente"), nomes.index("v_sku_parametros_sugeridos")
    nomes[i], nomes[j] = nomes[j], nomes[i]
esperado = ["v_sku_candidatos_primeira_compra", "v_sku_aumento_vigente", "v_sku_parametros_sugeridos",
            "v_sku_demanda_rajada", "v_sku_leadtime_estatisticas", "v_sku_sigma_demanda",
            "v_sku_demanda_estatisticas", "v_fornecedor_lt_logistica_total"]
print("ORDEM_DOS_LEITORES" if nomes[:8] == esperado and len(nomes) == 18 else "ORDEM:" + ",".join(nomes[:8]))
PYK3
eq K3 "a trava prende as views na ordem em que os leitores as prendem" "$(cat "$TMPD/k3.txt")" ORDEM_DOS_LEITORES

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL, com a PRÉ e a PÓS dela. Aplicada com `pg_catalog` DEPOIS de `public` para as
# views e os DEFAULTs amarrarem o now() controlado (na prod amarram o de pg_catalog: o texto do deparse é
# o mesmo, `now()`, e é por isso que o md5 da PÓS vale nos dois lugares).
# ══════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q --single-transaction -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (PRE e POS passaram)"

# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA assinatura de um
# embutido passa a vencê-lo — inclusive as que a view chama por sintaxe (`AT TIME ZONE` é `timezone(...)`).
# O snapshot tem uma (`public.set_config`, wrapper que só aceita `fin.%`). A guarda pergunta ao CATÁLOGO:
# das funções de `public` que sombreiam `pg_catalog`, de quais as 18 views e os 6 DEFAULTs DEPENDEM
# (pg_depend, o que ficou amarrado no CREATE/ALTER)? Tem de ser só o nosso now(). Controle POSITIVO: se
# não vê nem ele, está cega (e as views não leem o relógio controlado) — aborta.
NOMES_VIEWS="$(for item in $VIEWS; do r="${item#*:}"; printf "'%s'," "${r%%:*}"; done)"
sombra="$(Pq -c "SELECT COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(DISTINCT p.proname, ',') FILTER (WHERE p.proname <> 'now'), '')
  FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.refobjid AND d.refclassid = 'pg_proc'::regclass
 WHERE p.pronamespace = 'public'::regnamespace
   AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                AND c.proname = p.proname AND c.proargtypes = p.proargtypes)
   AND (   (d.classid = 'pg_rewrite'::regclass AND d.objid IN (
              SELECT r.oid FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class
               WHERE v.relnamespace = 'public'::regnamespace AND v.relname IN (${NOMES_VIEWS%,})))
        OR (d.classid = 'pg_attrdef'::regclass AND d.objid IN (
              SELECT ad.oid FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
               WHERE (ad.adrelid::regclass::text, a.attname) IN (('farmer_agenda','agenda_date'),
                 ('fornecedor_cadeia_logistica','valido_desde'), ('priority_score_log','score_date'),
                 ('sku_embalagem_equivalencia','vigente_desde'), ('sugestao_negociacao_paralela','data_geracao'),
                 ('sugestao_negociacao_paralela','valido_ate')))));")"
case "$sombra" in
  'now|') echo "guarda de sombra: views e DEFAULTs dependem só do now() controlado entre os nomes sombreados (controle positivo visto)" ;;
  now\|*) echo "❌ as views/DEFAULTs amarraram mais que o now() a public: [${sombra#*|}] — a prova rodaria outra semântica"; exit 1 ;;
  *) echo "❌ guarda cega: views e DEFAULTs não dependem do public.now() — não leem o relógio controlado [$sombra]"; exit 1 ;;
esac

# Os G rodam AQUI, sobre o estado limpo pós-migration e ANTES de qualquer sabotagem de corpo: eles re-executam a
# migration, e uma view sabotada faria a PRÉ acusar (com razão) predecessora divergente.
echo "── G: a PRÉ e a PÓS da migration, postas à prova (numa transação que volta atrás)"
# G1: uma predecessora DIVERGENTE (outra mudança chegou antes) — a migration tem de abortar na PRÉ. A
# divergência: fin_aging_pagar volta ao texto da prod com um literal trocado (colunas iguais).
# G2: a migration com o texto de uma view ADULTERADO — a PÓS tem de recusar (o md5 não é o desta).
# G3: re-aplicar a migration inteira sobre ela mesma passa (a PRÉ aceita "já esta").
python3 - "$MIG" "$FIX" "$TMPD" "$SABOTAGEM" <<'PYG'
import sys
mig, fix, tmpd, sab = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
m = open(mig, encoding="utf-8").read()
f = open(fix, encoding="utf-8").read()

def bloco(texto, nome):
    ini = texto.find("CREATE OR REPLACE VIEW public." + nome + "\n")
    fim = texto.find(";\n", ini) + 1
    if ini < 0 or fim <= 0:
        sys.exit(nome + " não delimitada")
    return texto[ini:fim]

def sem(texto, tag):
    ini, fim = texto.find("DO $" + tag + "$"), texto.find("$" + tag + "$;")
    if ini < 0 or fim < 0:
        sys.exit("bloco $" + tag + "$ não achado")
    return texto[:ini] + texto[fim + len("$" + tag + "$;"):]

COND_PRE = "IF r.vivo IS NOT NULL AND r.vivo NOT IN (r.predecessor, r.este) THEN"
if sab == "pre_removida":
    if m.count(COND_PRE) != 1:
        sys.exit("condição da PRÉ não achada 1x")
    migracao = m.replace(COND_PRE, "IF false THEN")
else:
    migracao = m
divergente = bloco(f, "fin_aging_pagar")
if divergente.count("'PAGO'::text") != 1:
    sys.exit("literal da divergência não achado na predecessora")
divergente = divergente.replace("'PAGO'::text", "'PAGO '::text")
open(tmpd + "/g1.sql", "w", encoding="utf-8").write(divergente + "\n" + migracao)

migracao = sem(m, "post") if sab == "pos_removida" else m
b = bloco(migracao, "fin_aging_pagar")
if b.count("'PAGO'::text") != 1:
    sys.exit("literal da adulteração não achado na migration")
open(tmpd + "/g2.sql", "w", encoding="utf-8").write(migracao.replace(b, b.replace("'PAGO'::text", "'PAGO '::text")))
open(tmpd + "/g3.sql", "w", encoding="utf-8").write(m)

# G4: um REVOKE colado antes da PÓS — o ACL de uma view muda no meio da migration; a POS6 tem de ver.
migracao = sem(m, "post") if sab == "pos_removida" else m
if migracao.count("DO $post$") > 1:
    sys.exit("DO $post$ ambíguo")
if "DO $post$" in migracao:
    migracao = migracao.replace("DO $post$", "REVOKE SELECT ON public.fin_aging_pagar FROM anon;\nDO $post$")
else:
    migracao += "\nREVOKE SELECT ON public.fin_aging_pagar FROM anon;\n"
open(tmpd + "/g4.sql", "w", encoding="utf-8").write(migracao)

# G5: uma view recriada SEM o WITH (security_invoker) — o replace reseta a opção; a POS4 tem de ver.
migracao = sem(m, "post") if sab == "pos_removida" else m
b = bloco(migracao, "fin_aging_pagar")
com = "  WITH (security_invoker = on)\n"
if b.count(com) != 1:
    sys.exit("WITH do security_invoker não achado 1x em fin_aging_pagar")
open(tmpd + "/g5.sql", "w", encoding="utf-8").write(migracao.replace(b, b.replace(com, "")))
PYG
eq G1 "predecessora divergente: a migration aborta na PRÉ" "$(Tenta "$TMPD/g1.sql" P0001 'PRE FALHOU')" NEGOU
eq G2 "texto de view adulterado: a PÓS recusa" "$(Tenta "$TMPD/g2.sql" P0001 'POS2 FALHOU')" NEGOU
eq G3 "re-aplicar a migration sobre ela mesma passa" "$(Tenta "$TMPD/g3.sql" P0001 'nunca')" PASSOU
eq G4 "ACL mexido no meio da migration: a PÓS recusa" "$(Tenta "$TMPD/g4.sql" P0001 'POS6 FALHOU')" NEGOU
eq G5 "view recriada sem security_invoker: a PÓS recusa" "$(Tenta "$TMPD/g5.sql" P0001 'POS4 FALHOU')" NEGOU

# ── SABOTAGEM (só no modo --falsificar) — no BANCO, recriando o objeto com o trecho trocado; o repo nunca
# é tocado. Cada padrão tem de ocorrer exatamente n× no bloco: uma troca que não pegou deixaria a suíte
# verde (e o laço, que exige vermelho no assert certo, acusa em vez de aprovar).
SP_DIA="(now() AT TIME ZONE 'America/Sao_Paulo'::text)::date"
sabotar_view() {   # <view> <de> <para> <n> [<de> <para> <n> ...]
  local nome="$1" tmp
  shift
  tmp="$(mktemp "$TMPD/sab.XXXXXX")"
  python3 - "$MIG" "$nome" "$tmp" "$@" <<'PYSAB' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
import sys
mig, nome, out, trocas = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
s = open(mig, encoding="utf-8").read()
ini = s.find("CREATE OR REPLACE VIEW public." + nome + "\n")
fim = s.find(";\n", ini) + 1 if ini >= 0 else -1
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
# O GÊMEO controlável do texto antigo: o dia truncado no fuso da SESSÃO. Monta-se das peças (as agulhas
# inteiras não aparecem neste arquivo: os gates de prova leem todo shell de db/).
AGORA="now()"
GEMEO_DIA="${AGORA}::date"
sabotar_gemeo() {   # <view> <sítios> — a view inteira volta a ler o dia da sessão
  local nome="$1" n="$2" args=()
  local borda_sp="(($SP_DIA - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text)"
  local seis_sp="((now() AT TIME ZONE 'America/Sao_Paulo'::text) - '6 mons'::interval)::date"
  local criado_sp="(so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date"
  case "$nome" in
    v_sku_leadtime_estatisticas) args=("$borda_sp" "($GEMEO_DIA - '180 days'::interval)" 2) ;;
    v_caca_candidatos) args=("$seis_sp" "(${AGORA} - '6 mons'::interval)::date" 1 "$criado_sp" "so.created_at::date" 1 "$SP_DIA" "$GEMEO_DIA" 1) ;;
    v_caca_compradores) args=("$criado_sp" "so.created_at::date" 1 "$SP_DIA" "$GEMEO_DIA" 1) ;;
    v_grupo_comercial) args=("$criado_sp" "so.created_at::date" 1 "$SP_DIA" "$GEMEO_DIA" 5) ;;
    *) args=("$SP_DIA" "$GEMEO_DIA" "$n") ;;
  esac
  sabotar_view "$nome" "${args[@]}"
}
sabotar_default() {   # <tabela> <coluna> — o DEFAULT volta a ler o dia da sessão (o gêmeo)
  local expr="$GEMEO_DIA"
  [ "$2" = valido_ate ] && expr="($GEMEO_DIA + '14 days'::interval)"
  PGOPTIONS="-c search_path=public,pg_catalog" P -q -c "ALTER TABLE public.$1 ALTER COLUMN $2 SET DEFAULT $expr;" >/dev/null
}
case "$SABOTAGEM" in
  "") ;;
  sem_pin|sem_trava|trava_na_ordem_errada|pre_removida|pos_removida) ;;   # agem mais adiante (pin, K, G)
  sessao_*)
    alvo="${SABOTAGEM#sessao_}"; achou=""
    for item in $VIEWS; do
      resto="${item#*:}"; nome="${resto%%:*}"; sitios="${resto#*:}"
      [ "$nome" = "$alvo" ] && { sabotar_gemeo "$nome" "$sitios"; achou=1; }
    done
    [ -n "$achou" ] || { echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9; } ;;
  default_sessao_*)
    alvo="${SABOTAGEM#default_sessao_}"; achou=""
    for item in $DEFAULTS; do
      resto="${item#*:}"; tab="${resto%%:*}"; col="${resto#*:}"
      [ "$col" = "$alvo" ] && { sabotar_default "$tab" "$col"; achou=1; }
    done
    [ -n "$achou" ] || { echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9; } ;;
  # a borda contra timestamptz trocada só no DIA (a troca ingênua): sob sessão UTC ela cai às 21:00 BRT
  leadtime_borda_ingenua)
    sabotar_view v_sku_leadtime_estatisticas "(($SP_DIA - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text)" "($SP_DIA - '180 days'::interval)" 2 ;;
  # o dia tirado do relógio de parede, que o controlado não intercepta
  aging_de_parede) sabotar_view fin_aging_pagar "$SP_DIA" "(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'::text)::date" 16 ;;
  # o fuso ESCRITO, mas o errado
  aging_em_utc_escrito) sabotar_view fin_aging_pagar "$SP_DIA" "(now() AT TIME ZONE 'UTC'::text)::date" 16 ;;
  # o DEFAULT tirado do relógio de parede: a e d (valor absoluto) e c (D+1) caem; b (UTC = SP) não
  score_date_de_parede)
    PGOPTIONS="-c search_path=public,pg_catalog" P -q -c "ALTER TABLE public.priority_score_log ALTER COLUMN score_date SET DEFAULT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'::text)::date;" >/dev/null ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

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
-- FINANCEIRO: um título a receber e um a pagar vencendo em D (a vencer em D, vencido 1-30 em D+1), e um
-- a receber vencido há um mês; o grupo comercial cujo membro é o CNPJ do cliente.
INSERT INTO public.fin_contas_receber (company, omie_codigo_lancamento, data_vencimento, valor_documento, status_titulo, cnpj_cpf, nome_cliente) VALUES
  ('oben', 900001, DATE '2025-03-12', 100, 'VENCE HOJE', '11.222.333/0001-81', 'Cliente do Grupo'),
  ('oben', 900002, DATE '2025-02-10', 50, 'ATRASADO', '11.222.333/0001-81', 'Cliente do Grupo');
INSERT INTO public.fin_contas_pagar (company, omie_codigo_lancamento, data_vencimento, valor_documento, status_titulo)
VALUES ('oben', 900003, DATE '2025-03-12', 200, 'VENCE HOJE');
INSERT INTO public.cliente_grupos (id, nome, ativo) VALUES ('0a000000-0000-0000-0000-00000000000a', 'Grupo da prova', true);
INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES ('0a000000-0000-0000-0000-00000000000a', '11222333000181');
-- VENDAS (Caça e grupo comercial): pedido às 10:00 BRT de D (o mesmo dia nos 2 fusos), às 22:00 BRT de D
-- (01:00Z de D+1: o created_at::date da sessão UTC já é D+1) e em 12/09/2024 12:00 BRT (a borda exata
-- do ativo_6m, D - 6 meses).
INSERT INTO public.profiles (user_id, name, cnpj, is_employee) VALUES
  ('0b000000-0000-0000-0000-000000000001', 'Cliente do Grupo', '11.222.333/0001-81', false),
  ('0b000000-0000-0000-0000-000000000002', 'Cliente Noturno', '22.333.444/0001-55', false),
  ('0b000000-0000-0000-0000-000000000003', 'Cliente de Seis Meses', '33.444.555/0001-66', false);
INSERT INTO public.sales_orders (id, customer_user_id, created_by, status, account, total, created_at) VALUES
  ('0c000000-0000-0000-0000-000000000001', '0b000000-0000-0000-0000-000000000001', '0b000000-0000-0000-0000-000000000001', 'faturado', 'oben', 1000, '2025-03-12 13:00:00+00'),
  ('0c000000-0000-0000-0000-000000000002', '0b000000-0000-0000-0000-000000000002', '0b000000-0000-0000-0000-000000000002', 'faturado', 'oben', 500, '2025-03-13 01:00:00+00'),
  ('0c000000-0000-0000-0000-000000000003', '0b000000-0000-0000-0000-000000000003', '0b000000-0000-0000-0000-000000000003', 'faturado', 'oben', 300, '2024-09-12 15:00:00+00');
-- REPOSIÇÃO. SKU 5001: vendas em D (a série de sigma a inclui só a partir de D+1), D-90 (sai da janela de
-- 90), D-179 (sai da série da rajada) e D-180 (sai das janelas de 180).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo) VALUES
  (5001, 'SKU-5001', 'Produto da prova', 'oben', 'FAM-PROVA', true),
  (5002, 'SKU-5002', 'Candidato da prova', 'oben', 'FAM-PROVA-2', true);
INSERT INTO public.venda_items_history (empresa, data_emissao, sku_codigo_omie, sku_codigo, quantidade, valor_unitario, valor_total, cfop, nfe_chave_acesso, cliente_cnpj_cpf) VALUES
  ('OBEN', DATE '2025-03-12', 5001, 'SKU-5001', 10, 12, 120, '5102', 'NFE-D', NULL),
  ('OBEN', DATE '2024-12-12', 5001, 'SKU-5001', 7, 12, 84, '5102', 'NFE-D90', NULL),
  ('OBEN', DATE '2024-09-14', 5001, 'SKU-5001', 5, 12, 60, '5102', 'NFE-D179', NULL),
  ('OBEN', DATE '2024-09-13', 5001, 'SKU-5001', 3, 12, 36, '5102', 'NFE-D180', NULL),
-- SKU 5002, o candidato à 1ª compra: 1 NF nos 90 dias (AGUARDANDO_SEGUNDA_ORDEM), outra há 120 dias (2
-- meses e 2 NFs em 180); a NF de D faz dias_desde_ultima valer 0 em D e 1 em D+1.
  ('OBEN', DATE '2025-03-12', 5002, 'SKU-5002', 4, 20, 80, '5102', 'NFE-5002-A', '11222333000181'),
  ('OBEN', DATE '2024-11-12', 5002, 'SKU-5002', 6, 20, 120, '5102', 'NFE-5002-B', '22333444000155');
-- Lead time do 5001: t2 no INSTANTE da meia-noite de SP de D-180 (entra em D, sai em D+1) e às 22:00 BRT
-- de D-181 — a faixa de 3h que a borda ingênua (dia - 180 como timestamp, convertido na sessão UTC)
-- comia. Do 5002: 3 amostras (a média por SKU pede mínimo).
INSERT INTO public.sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, fornecedor_nome, t1_data_pedido, t2_data_faturamento, lt_bruto_dias_uteis, origem_compra) VALUES
  ('0d000000-0000-0000-0000-000000000001', 'OBEN', 5001, 'FORNECEDOR PROVA', '2024-09-01 12:00:00+00', '2024-09-13 03:00:00+00', 9, 'normal'),
  ('0d000000-0000-0000-0000-000000000002', 'OBEN', 5001, 'FORNECEDOR PROVA', '2024-09-01 12:00:00+00', '2024-09-13 01:00:00+00', 11, 'normal'),
  ('0d000000-0000-0000-0000-000000000011', 'OBEN', 5002, 'FORNECEDOR PROVA', '2025-01-02 12:00:00+00', '2025-01-10 15:00:00+00', 6, 'normal'),
  ('0d000000-0000-0000-0000-000000000012', 'OBEN', 5002, 'FORNECEDOR PROVA', '2025-01-20 12:00:00+00', '2025-01-28 15:00:00+00', 6, 'normal'),
  ('0d000000-0000-0000-0000-000000000013', 'OBEN', 5002, 'FORNECEDOR PROVA', '2025-02-05 12:00:00+00', '2025-02-13 15:00:00+00', 6, 'normal');
INSERT INTO public.fornecedor_habilitado_reposicao (empresa, fornecedor_nome, habilitado) VALUES ('OBEN', 'FORNECEDOR PROVA', true);
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie) VALUES ('OBEN', 5002);
-- Cadeia logística: etapa válida até D (some em D+1).
INSERT INTO public.fornecedor_cadeia_logistica (empresa, fornecedor_nome, ordem, etapa_codigo, descricao, lt_dias, lt_unidade, parceiro_nome, ativo, valido_ate, valido_desde)
VALUES ('OBEN', 'FORNECEDOR PROVA', 1, 'FRETE', 'Frete da prova', 4, 'uteis', 'Transportadora', true, DATE '2025-03-12', DATE '2025-01-01');
-- Sugestão de negociação nova, válida até D+5 (dias_ate_expirar muda na virada).
INSERT INTO public.sugestao_negociacao_paralela (empresa, sku_codigo_omie, motivo, status, data_geracao, valido_ate)
VALUES ('OBEN', '5001', 'combinacao_heuristica', 'nova', DATE '2025-03-01', DATE '2025-03-17');
-- Aumento anunciado com vigência em D-7 (sai da janela de 7 dias em D+1).
INSERT INTO public.fornecedor_aumento_anunciado (id, empresa, fornecedor_nome, nome, data_vigencia, estado)
VALUES (7001, 'OBEN', 'FORNECEDOR PROVA', 'Aumento da prova', DATE '2025-03-05', 'ativo');
INSERT INTO public.fornecedor_aumento_item (id, aumento_id, categoria_fornecedor, aumento_perc, confirmado, ativo)
VALUES (7101, 7001, 'CAT-PROVA', 5, true, true);
INSERT INTO public.categoria_aumento_familia_mapeamento (aumento_item_id, familia_omie) VALUES (7101, 'FAM-PROVA');
-- Campanha de desconto flat condicional ativa até D+3 (dias_restantes muda na virada).
INSERT INTO public.promocao_campanha (id, empresa, fornecedor_nome, nome, tipo_origem, estado, data_inicio, data_fim)
VALUES (8001, 'OBEN', 'FORNECEDOR PROVA', 'Flat da prova', 'desconto_flat_condicional', 'ativa', DATE '2025-03-01', DATE '2025-03-15');
SQL
# A matview do ranking vem do snapshot SEM dados; v_sugestao_negociacao_ativa a lê (LEFT JOIN). Ela não é
# objeto desta prova (fica fora da migration) — só precisa estar populada.
P -q -c "REFRESH MATERIALIZED VIEW private.mv_sku_ranking_negociacao_paralela;"

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

# Z0: lida SEM instante no pacote de conexão (vale o pin), a view dá o mesmo que no instante do pin.
LerPin() { Pq -q -c "$1" 2>&1 || true; }
iguais Z0 "fin_aging_receber pelo pin = no instante do pin" \
  "$(LerPin "$(digital_de fin_aging_receber)")" "$(Ler "$UTC" '2025-03-12T15:00:00Z' "$(digital_de fin_aging_receber)")"

echo "── views: a (21:00 = 20:59:59, UTC) · b (UTC = SP às 23:59:59) · c (muda à 00:00 de SP) · d (a, sob SP)"
for item in $VIEWS; do
  id="${item%%:*}"; resto="${item#*:}"; nome="${resto%%:*}"
  q="$(digital_de "$nome")"
  u1="$(Ler "$UTC" "$T1" "$q")"; u2="$(Ler "$UTC" "$T2" "$q")"; u3="$(Ler "$UTC" "$T3" "$q")"; u4="$(Ler "$UTC" "$T4" "$q")"
  s1="$(Ler "$SPZ" "$T1" "$q")"; s2="$(Ler "$SPZ" "$T2" "$q")"; s3="$(Ler "$SPZ" "$T3" "$q")"
  iguais "${id}a" "$nome: 21:00:00 BRT = 20:59:59 (sessão UTC)" "$u2" "$u1"
  iguais "${id}b" "$nome: sessão UTC = sessão SP às 23:59:59 BRT" "$u3" "$s3"
  diferentes "${id}c" "$nome: vira à 00:00:00 BRT de D+1 (sessão UTC)" "$u3" "$u4"
  iguais "${id}d" "$nome: 21:00:00 BRT = 20:59:59 (sessão SP)" "$s2" "$s1"
done

echo "── DEFAULTs: a linha que OMITE a coluna, inserida e desfeita em cada instante"
# As colunas obrigatórias de cada tabela, com valores literais; o INSERT volta atrás (BEGIN/ROLLBACK).
insere() {   # <tabela> <coluna>
  case "$1" in
    farmer_agenda) printf "INSERT INTO public.farmer_agenda (farmer_id, customer_user_id) VALUES ('0b000000-0000-0000-0000-000000000001', '0b000000-0000-0000-0000-000000000002') RETURNING %s" "$2" ;;
    fornecedor_cadeia_logistica) printf "INSERT INTO public.fornecedor_cadeia_logistica (empresa, fornecedor_nome, ordem, etapa_codigo, descricao, lt_dias) VALUES ('OBEN', 'FORNECEDOR D', 2, 'X', 'default', 1) RETURNING %s" "$2" ;;
    priority_score_log) printf "INSERT INTO public.priority_score_log (customer_user_id, farmer_id) VALUES ('0b000000-0000-0000-0000-000000000001', '0b000000-0000-0000-0000-000000000002') RETURNING %s" "$2" ;;
    sku_embalagem_equivalencia) printf "INSERT INTO public.sku_embalagem_equivalencia (empresa, sku_codigo_omie, unidade_base, fator_para_base) VALUES ('OBEN', '9999', 'UN', 1) RETURNING %s" "$2" ;;
    sugestao_negociacao_paralela) printf "INSERT INTO public.sugestao_negociacao_paralela (empresa, sku_codigo_omie, motivo) VALUES ('OBEN', '9999', 'combinacao_heuristica') RETURNING %s" "$2" ;;
  esac
}
LerDefault() {   # <TimeZone> <instante> <tabela> <coluna>
  PGOPTIONS="-c TimeZone=$1 -c test.agora=$2 -c session_replication_role=replica" \
    Pq -q -c "BEGIN" -c "$(insere "$3" "$4")" -c "ROLLBACK" 2>&1 || true
}
for item in $DEFAULTS; do
  id="${item%%:*}"; resto="${item#*:}"; tab="${resto%%:*}"; col="${resto#*:}"
  d='2025-03-12'; d1='2025-03-13'
  [ "$col" = valido_ate ] && { d='2025-03-26'; d1='2025-03-27'; }
  eq "${id}a" "$tab.$col: linha das 21:00:00 BRT (sessão UTC) nasce com o dia de SP" "$(LerDefault "$UTC" "$T2" "$tab" "$col")" "$d"
  iguais_def_u="$(LerDefault "$UTC" "$T3" "$tab" "$col")"; iguais_def_s="$(LerDefault "$SPZ" "$T3" "$tab" "$col")"
  if invalido "$iguais_def_u" || invalido "$iguais_def_s"; then
    erro_exec "${id}b" "$tab.$col: leitura inválida [$iguais_def_u | $iguais_def_s]"
  elif [ "$iguais_def_u" = "$iguais_def_s" ]; then ok "${id}b" "$tab.$col: sessão UTC = sessão SP às 23:59:59 BRT (=$iguais_def_u)"
  else bad "${id}b" "$tab.$col: sessão UTC [$iguais_def_u] ≠ sessão SP [$iguais_def_s] às 23:59:59 BRT"; fi
  eq "${id}c" "$tab.$col: à 00:00:00 BRT de D+1 (sessão UTC) já é D+1" "$(LerDefault "$UTC" "$T4" "$tab" "$col")" "$d1"
  eq "${id}d" "$tab.$col: linha das 21:00:00 BRT (sessão SP) nasce com o dia de SP" "$(LerDefault "$SPZ" "$T2" "$tab" "$col")" "$d"
done


echo
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$PASS" -ne "$TOTAL_ESPERADO" ] && [ "$FAIL" -eq 0 ]; then
  echo "❌ $PASS asserts executados, esperados $TOTAL_ESPERADO — a prova foi TRUNCADA (FAIL=0 com PASS encolhido não é verde)"
  exit 1
fi
[ "$FAIL" -eq 0 ]
