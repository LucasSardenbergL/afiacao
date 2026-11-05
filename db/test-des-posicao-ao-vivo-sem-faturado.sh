#!/usr/bin/env bash
# REGRESSÃO — sem faturado confirmado do GoodData, a posição ao vivo do DES é NULL, não trânsito
# (20261105091216_des_posicao_ao_vivo_sem_faturado_e_nula.sql).
#
# v_des_posicao_trimestre_ao_vivo somava `COALESCE(s.fat_bruto_valor, 0) + trânsito`. Sem snapshot no
# trimestre a "posição" era só pedido em trânsito, e a faixa (des_determinar_faixa) e o gap saíam dela
# (prod 2026-11-05: OBEN T4/26 = 297.966,59 só de trânsito, 3 estrelas). Sem snapshot e sem trânsito,
# posição 0 e gap = meta inteira. A migration devolve NULL nas 5 colunas derivadas quando o faturado é
# NULL, e o gap também quando a meta é NULL (GREATEST(0, 0 − posição) virava 0 = "meta atingida").
#   Bloco P — fidelidade: o predecessor (fixture da prod) dá o md5 da prod; o instalado, o da PÓS,
#     sob os dois search_path.
#   Bloco B — B0/B1/B2: o predecessor EXECUTADO mostra o defeito (sem isso o N passaria vazio).
#   Bloco N — sem faturado: cada uma das 5 colunas NULL (um assert por coluna — cada guarda falsifica
#     sozinha), o trânsito preservado, a linha só-meta e o snapshot com faturado NULL.
#   Bloco Z — faturado ZERO é fato: posição 0,00 (não NULL), com e sem trânsito.
#   Bloco M — meta NULL: posição e faixa valem; só o gap é NULL.
#   Bloco V — as linhas com faturado e meta saem idênticas às do predecessor (23 colunas, nos dois
#     sentidos); as 18 colunas não-derivadas, idênticas em TODAS as linhas; chaves presentes e únicas;
#     nomes/tipos/ordem das colunas iguais.
#   Bloco D — v_des_desconto_por_checkin (dependente, corpo da prod): sem faturado a linha do check-in
#     some (faixa NULL); com faturado ela existe com o padrão da faixa e o percentual esperados.
#   Bloco S — security_invoker preservado: cliente autenticado lê 0 linhas, master lê as 7.
#   Bloco K — o envelope: trava, PRÉ (aborta sobre uma 3ª versão viva), PÓS (aborta replace sem o
#     WITH; aborta corpo que não é o do md5) e reaplicar é seguro.
#
# Stubs: as views de cima (v_des_snapshot_mais_recente, v_des_pedidos_em_transito, v_des_checkin_atual)
# entram como TABELAS com nome, colunas e tipos da prod (psql-ro, 2026-11-05) — é só isso que o deparse
# imprime, e o P1 prova que basta (md5 da prod). des_determinar_faixa é o corpo da prod, verbatim.
#
# Rodar:   bash db/test-des-posicao-ao-vivo-sem-faturado.sh > log 2>&1; echo $?
# Provar dente:  bash db/test-des-posicao-ao-vivo-sem-faturado.sh --falsificar
# md5 do corpo novo (para a PRE/PÓS da migration):  bash db/test-des-posicao-ao-vivo-sem-faturado.sh --md5
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5540}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="des-posicao-ao-vivo-sem-faturado"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG="$REPO_ROOT/supabase/migrations/20261105091216_des_posicao_ao_vivo_sem_faturado_e_nula.sql"
FIX_PRED="$REPO_ROOT/db/fixtures/des-posicao-ao-vivo-prod-20261105.sql"
# A dependente, com o corpo que a prod tem (md5 879fe737… = o desta migration, psql-ro 2026-11-05).
MIG_CHECKIN="$REPO_ROOT/supabase/migrations/20260929002059_des_desconto_total_maximo_por_faixa.sql"
MD5_PROD_PRED=f299f9060f0cbc1eee2c0cad49955a6c   # psql-ro, 2026-11-05
MD5_ESTE=02a508694f2f52bd170887a549593cba
# Denominador: P1 B0 B1 B2 C0 · K1 · K2-K5 · P2 P3 · N1-N8 · Z1 Z2 · M1 · V1-V4 · D1 D2 · S1-S3
TOTAL_ESPERADO=32

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE.
# O controle roda PRIMEIRO, na mesma invocação: uma suíte que já falha sozinha aprovaria todas
# as sabotagens por vermelhidão constante. Cada sabotagem declara os asserts que TÊM de ficar
# vermelhos por RESULTADO e os que TÊM de continuar verdes (rodados e verdes). Vermelho por erro
# de execução — sabotagem que não aplicou, SQL quebrado, saída vazia — NÃO mata mutante.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
#   pos_c_coalesce    a conservadora volta a COALESCE(fat, 0) + trânsito (o predecessor, só ela)
#   pos_o_coalesce    idem, a otimista
#   faixa_c_coalesce  idem, a faixa conservadora (a dependente do check-in volta a ter a linha)
#   faixa_o_coalesce  idem, a faixa otimista
#   gap_sem_fat       o gap perde a guarda do faturado (volta a meta − trânsito)
#   gap_sem_meta      o gap perde a guarda da meta (meta NULL volta a dar gap 0 = "atingida")
#   zero_vira_nulo    a guarda larga demais: faturado 0 também vira NULL (fato tratado como ausência)
#   vizinha_alterada  outra coluna muda junto (a troca não foi cirúrgica)
#   sem_invoker       o replace sem o WITH: a view lê como dono — o md5 NÃO vê (P2/P3 verdes)
#   sem_trava, sem_pre, pos_sem_invoker, pos_sem_md5, pre_sem_este — o envelope, 1 camada por vez
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="pos_c_coalesce:N1,V2:N2,N3,N4,N5,N7,Z1,Z2,M1,V1,V3,V4,D1,D2
              pos_o_coalesce:N2,V2:N1,N3,N4,N5,N7,Z1,Z2,M1,V1,D1
              faixa_c_coalesce:N3,V2,D1:N1,N2,N4,N5,N7,Z1,Z2,M1,V1,D2
              faixa_o_coalesce:N4,V2:N1,N2,N3,N5,N7,Z1,Z2,M1,V1,D1
              gap_sem_fat:N5,N7,V2:N1,N2,N3,N4,N8,Z1,Z2,M1,V1,D1
              gap_sem_meta:M1,V2:N1,N2,N3,N4,N5,N7,Z1,Z2,V1,D1
              zero_vira_nulo:Z1,Z2,V1:N1,N2,N3,N4,N5,N7,M1
              vizinha_alterada:N6,V1,V2:N1,N2,N3,N4,N5,Z1,Z2,M1
              sem_invoker:S1,S2:P2,P3,N1,N2,N3,N4,N5,V1,S3
              sem_trava:K1:K2,K3,K4,K5
              sem_pre:K2:K1,K3,K4,K5
              pos_sem_invoker:K3:K1,K2,K4,K5
              pos_sem_md5:K4:K1,K2,K3,K5
              pre_sem_este:K5:K1,K2,K3,K4"
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
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$intrusos" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$intrusos" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO em: ${intrusos}— vermelho que não é do assert não mata mutante"
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
MODO_MD5=""
[ "${1:-}" = "--md5" ] && MODO_MD5=1
SABOTAGEM="${SABOTAGEM:-}"
case "$SABOTAGEM" in
  ""|pos_c_coalesce|pos_o_coalesce|faixa_c_coalesce|faixa_o_coalesce|gap_sem_fat|gap_sem_meta) ;;
  zero_vira_nulo|vizinha_alterada|sem_invoker) ;;
  sem_trava|sem_pre|pos_sem_invoker|pos_sem_md5|pre_sem_este) ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac

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
# Leitura: `2>&1` faz o erro virar o VALOR lido, e o `eq` o classifica como execução.
Exec() { PGOPTIONS="-c search_path=pg_catalog,public,pg_temp" Pq -c "$1" 2>&1 || true; }
# Leitura como usuário do app: papel `authenticated` + o uid na GUC que o auth.uid() do stub lê.
Como() { PGOPTIONS="-c role=authenticated -c test.uid=$1" Pq -c "$2" 2>&1 || true; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth TO authenticated;
SQL

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

MASTER=11111111-1111-1111-1111-111111111111
CLIENTE=22222222-2222-2222-2222-222222222222
# Negativo: capturar a SQLSTATE e a marca ESPERADAS e relançar o resto. A sentinela ('NEGOU') não é
# texto que o código emita. `pg_temp` vive só na conexão: o auxiliar nasce na MESMA chamada que o usa.
Nega() {   # <sql> <sqlstate> <marca> [<opções extras de conexão>]
  PGOPTIONS="${4:-}" Pq -q -c "
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
# O envelope por inteiro, como o `db:aplicar` o roda: uma transação, psql -f, ON_ERROR_STOP — mas
# terminando em ROLLBACK. PASSOU = aplicou inteira · NEGOU = abortou com P0001 e a marca esperada.
Aplica() {   # <arquivo> <marca da negação> [<preparo, na MESMA transação, antes do arquivo>]
  local arq="$1" marca="$2" preparo="${3:-}" out rc=0
  out="$( { printf '\\set VERBOSITY verbose\nBEGIN;\n'
            if [ -n "$preparo" ]; then printf '\\i %s\n' "$preparo"; fi
            printf '\\i %s\nROLLBACK;\n' "$arq"; } \
          | P -qAt 2>&1 )" || rc=$?
  if [ "$rc" -eq 0 ]; then echo PASSOU
  elif printf '%s' "$out" | grep -q "P0001: $marca"; then echo NEGOU
  else printf 'rc=%s psql: %s' "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | head -c 300)"
  fi
}

# Recortes da migration (e das fixtures) em arquivo. Nos modos mig/parte1 a sabotagem de ENVELOPE
# ativa corta a camada dela; as trocas <de> <para> <n> têm de ocorrer exatamente n× — uma troca
# que não pegou deixaria a suíte verde (e o laço, que exige vermelho no assert certo, acusa).
gerar() {   # <modo: mig|parte1|view|pred|checkin> <saída> [<de> <para> <n> ...]
  python3 - "$MIG" "$FIX_PRED" "$MIG_CHECKIN" "$SABOTAGEM" "$@" <<'PYGEN' || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM): gerar $1"; exit 9; }
import sys
mig_path, pred_path, chk_path, sab, modo, out = sys.argv[1:7]
trocas = sys.argv[7:]
mig = open(mig_path, encoding="utf-8").read()

def trecho(s, ini_txt, fim_txt):
    i = s.find(ini_txt)
    if i < 0 or s.find(ini_txt, i + 1) >= 0:
        sys.exit("trecho ausente ou repetido: %r" % ini_txt)
    j = s.find(fim_txt, i)
    if j < 0:
        sys.exit("fim não achado: %r" % fim_txt)
    return i, j + len(fim_txt)

def corta(s, ini_txt, fim_txt):
    i, j = trecho(s, ini_txt, fim_txt)
    return s[:i] + s[j:]

if modo in ("mig", "parte1"):
    s = mig
    if sab == "sem_trava":
        s = corta(s, "DO $trava$", "$trava$;\n")
    elif sab == "sem_pre":
        s = corta(s, "DO $pre$", "$pre$;\n")
    elif sab == "pos_sem_md5":
        s = corta(s, "  IF (SELECT md5(pg_catalog.pg_get_viewdef(", "  END IF;\n")
    elif sab == "pos_sem_invoker":
        s = corta(s, "  IF NOT EXISTS (\n    SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o", "  END IF;\n")
    elif sab == "pre_sem_este":
        de = "NOT IN ('f299f9060f0cbc1eee2c0cad49955a6c', '"
        i = s.find(de)
        if i < 0 or s.find(de, i + 1) >= 0:
            sys.exit("lista da PRE não achada")
        j = s.find("')", i)
        s = s[:i] + "NOT IN ('f299f9060f0cbc1eee2c0cad49955a6c" + s[j:]
    if modo == "parte1":   # a sessão A da trava roda ATÉ o fim da pré-condição e para
        fim = "$pre$;\n" if "$pre$;\n" in s else "$trava$;\n"
        s = s[:s.find(fim) + len(fim)]
elif modo == "view":
    i, j = trecho(mig, "CREATE OR REPLACE VIEW public.v_des_posicao_trimestre_ao_vivo\n", ";\n")
    s = mig[i:j]
elif modo == "pred":
    fx = open(pred_path, encoding="utf-8").read()
    i, j = trecho(fx, "CREATE VIEW public.v_des_posicao_trimestre_ao_vivo\n", ";\n")
    s = "CREATE OR REPLACE VIEW" + fx[i + len("CREATE VIEW"):j]
elif modo == "checkin":
    ck = open(chk_path, encoding="utf-8").read()
    i, j = trecho(ck, "CREATE OR REPLACE VIEW public.v_des_desconto_por_checkin\n", ";\n")
    s = ck[i:j]
else:
    sys.exit("modo desconhecido: " + modo)
for k in range(0, len(trocas), 3):
    de, para, n = trocas[k], trocas[k + 1], int(trocas[k + 2])
    if s.count(de) != n:
        sys.exit("padrão ocorre %dx, esperado %d: %r" % (s.count(de), n, de))
    s = s.replace(de, para)
open(out, "w", encoding="utf-8").write(s + "\n")
PYGEN
}

echo "═══ setup pronto (PG17 :$PORT, lc_messages=$HARNESS_LC) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: o que a view lê. Colunas e TIPOS conferidos na prod via psql-ro
# (2026-11-05) — são os que o deparse imprime (o P1 exige o md5 da prod).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- Na prod são VIEWS; para o deparse só nome, colunas e tipos importam — e o seed escolhe o estado.
CREATE TABLE public.v_des_snapshot_mais_recente (
  id bigint, empresa text, ano integer, trimestre integer, data_referencia date, objetivo_valor numeric,
  fat_bruto_valor numeric, objetivo_qtde numeric, fat_bruto_qtde numeric, pedidos_abertos_valor numeric,
  pedidos_abertos_qtde numeric, criado_em timestamptz
);
CREATE TABLE public.v_des_pedidos_em_transito (
  pedido_id bigint, empresa text, fornecedor_nome text, grupo_codigo text, data_ciclo date,
  horario_disparo_real timestamptz, valor_total numeric, status text, tipo_ciclo text, data_emissao date,
  data_faturamento_prevista date, ano_atual integer, trimestre_atual integer, inicio_trimestre date,
  fim_trimestre date, fatura_no_trimestre boolean, zona_confianca text
);
CREATE TABLE public.des_meta_empresa (
  id bigint PRIMARY KEY, empresa text, ano integer, trimestre integer, meta_faturamento numeric,
  faixa_des_objetivo integer, observacoes text, criado_em timestamptz, atualizado_em timestamptz
);
CREATE TABLE public.des_contrato_versao (
  id bigint PRIMARY KEY, versao text NOT NULL UNIQUE, data_inicio_vigencia date, data_fim_vigencia date,
  observacoes text, criado_em timestamptz
);
CREATE TABLE public.des_faixa_quantitativa (
  id bigint PRIMARY KEY, contrato_versao_id bigint REFERENCES public.des_contrato_versao(id),
  faixa_numero integer, estrelas integer, volume_min numeric, volume_max numeric,
  desconto_padrao_perc numeric, observacoes text, criado_em timestamptz
);
-- Para a dependente v_des_desconto_por_checkin (corpo da prod, 20260929002059).
CREATE TABLE public.v_des_checkin_atual (
  empresa text, ano integer, trimestre integer, checkin_id bigint, data_avaliacao date, tipo text,
  avaliado_com text, avaliado_por text, codigo text, nome text, criterio_tipo text, atingido boolean,
  observacao_criterio text
);
CREATE TABLE public.des_criterio_qualitativo (
  id bigint PRIMARY KEY, contrato_versao_id bigint NOT NULL REFERENCES public.des_contrato_versao(id),
  codigo text NOT NULL, nome text NOT NULL, descricao text, ordem integer NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('qualitativo', 'bonus')), criado_em timestamptz,
  UNIQUE (contrato_versao_id, codigo)
);
CREATE TABLE public.des_criterio_percentual (
  id bigint PRIMARY KEY, criterio_id bigint NOT NULL REFERENCES public.des_criterio_qualitativo(id),
  faixa_id bigint NOT NULL, percentual numeric NOT NULL, criado_em timestamptz,
  UNIQUE (criterio_id, faixa_id)
);

-- des_determinar_faixa: o corpo da PROD, verbatim (pg_get_functiondef, psql-ro 2026-11-05).
-- Valor abaixo da 1ª faixa (inclusive 0) não casa nenhuma: 0 linhas => a view dá faixa NULL.
CREATE OR REPLACE FUNCTION public.des_determinar_faixa(p_valor numeric, p_versao text DEFAULT '2026'::text)
 RETURNS TABLE(faixa_id bigint, faixa_numero integer, estrelas integer, desconto_padrao_perc numeric, volume_min numeric, volume_max numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    fq.id,
    fq.faixa_numero,
    fq.estrelas,
    fq.desconto_padrao_perc,
    fq.volume_min,
    fq.volume_max
  FROM des_faixa_quantitativa fq
  JOIN des_contrato_versao cv ON cv.id = fq.contrato_versao_id
  WHERE cv.versao = p_versao
    AND p_valor >= fq.volume_min
    AND (fq.volume_max IS NULL OR p_valor <= fq.volume_max)
  LIMIT 1;
$function$;

-- RLS como na prod: só staff lê as bases DES (a view, security_invoker, lê como quem chama).
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['v_des_snapshot_mais_recente', 'v_des_pedidos_em_transito', 'des_meta_empresa',
                           'des_contrato_versao', 'des_faixa_quantitativa', 'v_des_checkin_atual',
                           'des_criterio_qualitativo', 'des_criterio_percentual'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY staff_le ON public.%I FOR SELECT TO authenticated
                      USING (public.has_role(auth.uid(), 'master'::public.app_role)
                             OR public.has_role(auth.uid(), 'employee'::public.app_role))$p$, t);
  END LOOP;
END
$rls$;
SQL

# OS PREDECESSORES: a view como a prod a tem (fixture) e a dependente da prod sobre ela.
gerar pred "$TMPD/pred.sql"
P -q -f "$TMPD/pred.sql"
gerar checkin "$TMPD/checkin.sql"
P -q -f "$TMPD/checkin.sql"
P -q -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;"

Q_MD5="SELECT md5(pg_get_viewdef('public.v_des_posicao_trimestre_ao_vivo'::regclass, true))"

if [ -n "$MODO_MD5" ]; then
  gerar view "$TMPD/md5.sql"
  P -q -f "$TMPD/md5.sql"
  echo "MD5_ESTE (search_path do executor): $(Exec "$Q_MD5")"
  echo "MD5_ESTE (search_path padrão):      $(Pq -c "$Q_MD5")"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (antes da migration: o predecessor EXECUTADO é a linha de base do V).
#   Faixas 2026: id 11 = nº1 1★ [50.000; 99.999,99] · id 12 = nº2 2★ [100.000; 249.999,99] ·
#   id 13 = nº3 3★ [250.000; ∞). Abaixo de 50.000 (inclusive 0) não há faixa — como na prod.
#   Todas as linhas em 2026 T4, uma empresa por estado:
#     SEMSNAP  sem snapshot; trânsito seguro 297.966,59 (2 pedidos) + risco 10.000; meta 400.840,02
#     SOMETA   sem snapshot e sem trânsito; meta 400.840,02
#     NULOFAT  snapshot com fat_bruto_valor NULL (10/10); trânsito seguro 70.000 depois dele; meta 100.000
#     ZERO     snapshot fat 0 (05/10); sem trânsito; meta 100.000
#     ZEROTR   snapshot fat 0 (05/10); trânsito seguro 60.000 depois dele; meta 100.000
#     CHEIO    snapshot fat 103.068,74 (20/10); seguro 150.000 + risco 20.000 depois; 1 pedido de 5.000
#              ANTES do snapshot (já está no faturado — fica fora); meta 400.840,02
#     SEMMETA  snapshot fat 120.000 (20/10); sem trânsito; sem meta
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$CLIENTE', 'customer');
INSERT INTO public.des_contrato_versao (id, versao) VALUES (1, '2026');
INSERT INTO public.des_faixa_quantitativa (id, contrato_versao_id, faixa_numero, estrelas, volume_min, volume_max, desconto_padrao_perc) VALUES
  (11, 1, 1, 1,  50000,  99999.99, 0.50),
  (12, 1, 2, 2, 100000, 249999.99, 1.00),
  (13, 1, 3, 3, 250000,      NULL, 1.50);
INSERT INTO public.v_des_snapshot_mais_recente (id, empresa, ano, trimestre, data_referencia, objetivo_valor, fat_bruto_valor, pedidos_abertos_valor) VALUES
  (1, 'NULOFAT', 2026, 4, '2026-10-10', 500000, NULL,      NULL),
  (2, 'ZERO',    2026, 4, '2026-10-05', 500000, 0,         0),
  (3, 'ZEROTR',  2026, 4, '2026-10-05', 500000, 0,         0),
  (4, 'CHEIO',   2026, 4, '2026-10-20', 500000, 103068.74, 1000),
  (5, 'SEMMETA', 2026, 4, '2026-10-20', 500000, 120000,    0);
INSERT INTO public.v_des_pedidos_em_transito (pedido_id, empresa, valor_total, data_emissao, ano_atual, trimestre_atual, fatura_no_trimestre, zona_confianca) VALUES
  (101, 'SEMSNAP', 197966.59, '2026-10-15', 2026, 4, true,  'verde'),
  (102, 'SEMSNAP', 100000.00, '2026-10-16', 2026, 4, true,  'amarelo'),
  (103, 'SEMSNAP',  10000.00, '2026-10-17', 2026, 4, true,  'vermelho'),
  (104, 'SEMSNAP',   7000.00, '2026-10-18', 2026, 4, false, 'verde'),
  (201, 'NULOFAT',  70000.00, '2026-10-12', 2026, 4, true,  'verde'),
  (301, 'ZEROTR',   60000.00, '2026-10-07', 2026, 4, true,  'verde'),
  (401, 'CHEIO',   150000.00, '2026-10-22', 2026, 4, true,  'verde'),
  (402, 'CHEIO',    20000.00, '2026-10-23', 2026, 4, true,  'vermelho'),
  (403, 'CHEIO',     5000.00, '2026-10-19', 2026, 4, true,  'verde');
INSERT INTO public.des_meta_empresa (id, empresa, ano, trimestre, meta_faturamento, faixa_des_objetivo) VALUES
  (1, 'SEMSNAP', 2026, 4, 400840.02, 3),
  (2, 'SOMETA',  2026, 4, 400840.02, 3),
  (3, 'NULOFAT', 2026, 4, 100000,    2),
  (4, 'ZERO',    2026, 4, 100000,    2),
  (5, 'ZEROTR',  2026, 4, 100000,    2),
  (6, 'CHEIO',   2026, 4, 400840.02, 3);
-- Dependente: um critério qualitativo com 0,75 na faixa 13; check-ins de SEMSNAP e CHEIO.
INSERT INTO public.des_criterio_qualitativo (id, contrato_versao_id, codigo, nome, ordem, tipo) VALUES
  (101, 1, 'mix_produtos', 'Mix', 1, 'qualitativo');
INSERT INTO public.des_criterio_percentual (id, criterio_id, faixa_id, percentual) VALUES (1, 101, 13, 0.75);
INSERT INTO public.v_des_checkin_atual (empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, codigo, nome, criterio_tipo, atingido) VALUES
  ('SEMSNAP', 2026, 4, 1, '2026-11-01', 'projecao', 'mix_produtos', 'Mix', 'qualitativo', true),
  ('CHEIO',   2026, 4, 2, '2026-11-01', 'projecao', 'mix_produtos', 'Mix', 'qualitativo', true);
SQL

V="public.v_des_posicao_trimestre_ao_vivo"
# Uma coluna de uma linha, com NULL lido como 'NULO' (assert verde por ausência não passa).
Col() { Exec "SELECT COALESCE(($2)::text, 'NULO') FROM $V WHERE empresa = '$1'"; }
COLS_TODAS="empresa, ano, trimestre, gooddata_data_referencia, gooddata_objetivo, fat_bruto_confirmado,
  gooddata_pedidos_abertos, meta_pessoal, faixa_des_alvo, valor_em_transito_seguro, valor_em_transito_risco,
  valor_fora_trimestre, qtd_pedidos_no_trimestre, qtd_pedidos_fora_trimestre, posicao_ao_vivo_conservadora,
  posicao_ao_vivo_otimista, faixa_conservadora::jsonb, faixa_otimista::jsonb, gap_para_meta_pessoal,
  calculado_em, inicio_trimestre, fim_trimestre, dias_restantes"
COLS_FATO="empresa, ano, trimestre, gooddata_data_referencia, gooddata_objetivo, fat_bruto_confirmado,
  gooddata_pedidos_abertos, meta_pessoal, faixa_des_alvo, valor_em_transito_seguro, valor_em_transito_risco,
  valor_fora_trimestre, qtd_pedidos_no_trimestre, qtd_pedidos_fora_trimestre,
  calculado_em, inicio_trimestre, fim_trimestre, dias_restantes"
Q_COLUNAS="SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
             FROM pg_attribute a WHERE a.attrelid = '$V'::regclass AND a.attnum > 0 AND NOT a.attisdropped"

eq P1 "o predecessor (fixture) = o da prod: é o que a PRÉ reconhece" "$(Exec "$Q_MD5")" "$MD5_PROD_PRED"
eq B0 "predecessor EXECUTADO: sem snapshot, a posição é só o trânsito seguro (297.966,59) e dá 3★" \
  "$(Exec "SELECT posicao_ao_vivo_conservadora || '|' || (faixa_conservadora->>'estrelas') FROM $V WHERE empresa = 'SEMSNAP'")" "297966.59|3"
eq B1 "predecessor: só meta, sem nada — posição 0,00 e gap = meta inteira" \
  "$(Exec "SELECT posicao_ao_vivo_conservadora || '|' || gap_para_meta_pessoal FROM $V WHERE empresa = 'SOMETA'")" "0.00|400840.02"
eq B2 "predecessor: meta NULL vira gap 0 (= 'meta atingida')" "$(Col SEMMETA gap_para_meta_pessoal)" "0.00"
eq C0 "predecessor: a dependente tem a linha do check-in de SEMSNAP, com a faixa fabricada" \
  "$(Exec "SELECT count(*) FROM public.v_des_desconto_por_checkin WHERE empresa = 'SEMSNAP'")" 1
P -q -c "CREATE TABLE public.antes AS SELECT $COLS_TODAS FROM $V; CREATE TABLE public.antes_fato AS SELECT $COLS_FATO FROM $V;"
COLUNAS_ANTES="$(Exec "$Q_COLUNAS")"

# ══════════════════════════════════════════════════════════════════════════════
# K1 — A TRAVA. A sessão A roda a migration ATÉ o fim da pré-condição e PARA, com a transação
# aberta. B tenta mexer na view com lock_timeout e tem de ser BARRADA (55P03).
# ══════════════════════════════════════════════════════════════════════════════
gerar parte1 "$TMPD/parte1.sql"
mkfifo "$TMPD/a.in"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -qAt < "$TMPD/a.in" > "$TMPD/a.out" 2>&1 &
PID_A=$!
exec 7> "$TMPD/a.in"
printf 'BEGIN;\n\\i %s\n\\! touch %s\n' "$TMPD/parte1.sql" "$TMPD/a.pronta" >&7
for _ in $(seq 1 150); do
  [ -e "$TMPD/a.pronta" ] && break
  kill -0 "$PID_A" 2>/dev/null || break
  sleep 0.2
done
if [ ! -e "$TMPD/a.pronta" ]; then
  echo "❌ K: a sessão A não chegou ao fim da pré-condição — a trava não foi posta à prova"
  head -c 600 "$TMPD/a.out"; exit 1
fi
eq K1 "com A parada após a pré-condição, B não mexe na view" \
  "$(Nega "ALTER VIEW $V SET (security_invoker = on)" 55P03 '' '-c lock_timeout=1500')" NEGOU
printf 'ROLLBACK;\n\\q\n' >&7
exec 7>&-
wait "$PID_A" || true

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (Lei #1), numa transação só, como o `db:aplicar` a roda — com a
# dependente viva por cima (como na prod): o CREATE OR REPLACE tem de manter nomes/tipos/ordem.
# ══════════════════════════════════════════════════════════════════════════════
P -q -1 -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG") (trava, PRÉ e PÓS passaram)"

# ══════════════════════════════════════════════════════════════════════════════
# K2-K5 — O ENVELOPE, em transações que terminam em ROLLBACK (o estado segue o da migration).
# K3/K4 partem do PREDECESSOR vivo, para a PRÉ não ser a camada que barra.
# ══════════════════════════════════════════════════════════════════════════════
gerar mig "$TMPD/k_mig.sql"
gerar pred "$TMPD/k_pred.sql"
gerar view "$TMPD/k_terceira.sql" "::date AS dias_restantes" "::date + 0 AS dias_restantes" 1
gerar mig "$TMPD/k_sem_with.sql" "WITH (security_invoker = on)
AS" "AS" 1
gerar mig "$TMPD/k_corpo_errado.sql" "END AS posicao_ao_vivo_otimista" "END + 1 AS posicao_ao_vivo_otimista" 1
eq K2 "PRÉ: sobre uma 3ª versão viva (mudança concorrente), a migration aborta" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU' "$TMPD/k_terceira.sql")" NEGOU
eq K3 "PÓS: um replace SEM o WITH aborta (a view passaria a ler como dono)" \
  "$(Aplica "$TMPD/k_sem_with.sql" 'POS2 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K4 "PÓS: um corpo que não é o do md5 aborta" \
  "$(Aplica "$TMPD/k_corpo_errado.sql" 'POS1 FALHOU' "$TMPD/k_pred.sql")" NEGOU
eq K5 "reaplicar sobre ela mesma passa (a PRÉ aceita este)" \
  "$(Aplica "$TMPD/k_mig.sql" 'PRE FALHOU')" PASSOU

# ── SABOTAGEM da view (só no modo --falsificar) — no BANCO, recriando a view instalada com o trecho
# trocado; o repo nunca é tocado. As de envelope já entraram pelo `gerar` (K1-K5).
sabotar() { gerar view "$TMPD/sab.sql" "$@"; P -q -f "$TMPD/sab.sql"; }
NL=$'\n'
G_POS_C="CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::numeric${NL}       ELSE round(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric), 2)${NL}  END AS posicao_ao_vivo_conservadora"
G_POS_O="CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::numeric${NL}       ELSE round(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric), 2)${NL}  END AS posicao_ao_vivo_otimista"
F_C_ARG="des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric)) des_determinar_faixa"
F_O_ARG="des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric)) des_determinar_faixa"
G_GAP="CASE WHEN s.fat_bruto_valor IS NULL OR m.meta_faturamento IS NULL THEN NULL::numeric${NL}       ELSE round(GREATEST(0::numeric, m.meta_faturamento - (s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2)"
case "$SABOTAGEM" in
  pos_c_coalesce)   sabotar "$G_POS_C" "round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric), 2) AS posicao_ao_vivo_conservadora" 1 ;;
  pos_o_coalesce)   sabotar "$G_POS_O" "round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric), 2) AS posicao_ao_vivo_otimista" 1 ;;
  faixa_c_coalesce) sabotar "  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::json${NL}       ELSE (SELECT row_to_json(r.*) AS row_to_json${NL}               FROM (SELECT des_determinar_faixa.faixa_id," \
                            "  CASE WHEN false THEN NULL::json${NL}       ELSE (SELECT row_to_json(r.*) AS row_to_json${NL}               FROM (SELECT des_determinar_faixa.faixa_id," 2 \
                            "$F_C_ARG" "des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric)) des_determinar_faixa" 1 \
                            "$F_O_ARG" "des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric) + 0) des_determinar_faixa" 1 ;;
  faixa_o_coalesce) sabotar "  CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::json${NL}       ELSE (SELECT row_to_json(r.*) AS row_to_json${NL}               FROM (SELECT des_determinar_faixa.faixa_id," \
                            "  CASE WHEN false THEN NULL::json${NL}       ELSE (SELECT row_to_json(r.*) AS row_to_json${NL}               FROM (SELECT des_determinar_faixa.faixa_id," 2 \
                            "$F_O_ARG" "des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric)) des_determinar_faixa" 1 \
                            "$F_C_ARG" "des_determinar_faixa(s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric) + 0) des_determinar_faixa" 1 ;;
  gap_sem_fat)      sabotar "$G_GAP" "CASE WHEN m.meta_faturamento IS NULL THEN NULL::numeric${NL}       ELSE round(GREATEST(0::numeric, m.meta_faturamento - (COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2)" 1 ;;
  gap_sem_meta)     sabotar "$G_GAP" "CASE WHEN s.fat_bruto_valor IS NULL THEN NULL::numeric${NL}       ELSE round(GREATEST(0::numeric, COALESCE(m.meta_faturamento, 0::numeric) - (s.fat_bruto_valor + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2)" 1 ;;
  zero_vira_nulo)   sabotar "CASE WHEN s.fat_bruto_valor IS NULL THEN" "CASE WHEN COALESCE(s.fat_bruto_valor, 0::numeric) = 0::numeric THEN" 4 \
                            "CASE WHEN s.fat_bruto_valor IS NULL OR" "CASE WHEN COALESCE(s.fat_bruto_valor, 0::numeric) = 0::numeric OR" 1 ;;
  vizinha_alterada) sabotar "COALESCE(p.valor_em_transito_risco, 0::numeric) AS valor_em_transito_risco" "0::numeric AS valor_em_transito_risco" 1 ;;
  sem_invoker)      sabotar "WITH (security_invoker = on)${NL}AS" "AS" 1 ;;
  *) ;;
esac
[ -n "$SABOTAGEM" ] && echo "→ SABOTAGEM ativa: $SABOTAGEM"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
eq P2 "instalada = a da PÓS (search_path do executor)" "$(Exec "$Q_MD5")" "$MD5_ESTE"
eq P3 "... e o mesmo md5 sob o search_path padrão" "$(Pq -c "$Q_MD5" 2>&1 || true)" "$MD5_ESTE"

# N — sem faturado confirmado: as 5 derivadas NULL, uma por assert.
eq N1 "SEMSNAP: posição conservadora NULL (não o trânsito)" "$(Col SEMSNAP posicao_ao_vivo_conservadora)" NULO
eq N2 "SEMSNAP: posição otimista NULL" "$(Col SEMSNAP posicao_ao_vivo_otimista)" NULO
eq N3 "SEMSNAP: faixa conservadora NULL (não 3★)" "$(Col SEMSNAP faixa_conservadora)" NULO
eq N4 "SEMSNAP: faixa otimista NULL" "$(Col SEMSNAP faixa_otimista)" NULO
eq N5 "SEMSNAP: gap NULL" "$(Col SEMSNAP gap_para_meta_pessoal)" NULO
eq N6 "SEMSNAP: o trânsito segue como fato (seguro|risco|fora|qtd no tri|qtd fora)" \
  "$(Exec "SELECT concat_ws('|', valor_em_transito_seguro, valor_em_transito_risco, valor_fora_trimestre, qtd_pedidos_no_trimestre, qtd_pedidos_fora_trimestre) FROM $V WHERE empresa = 'SEMSNAP'")" \
  "297966.59|10000.00|7000.00|3|1"
eq N7 "SOMETA (só meta): posição e gap NULL — não 0,00 e a meta inteira" \
  "$(Exec "SELECT COALESCE(posicao_ao_vivo_conservadora::text, 'NULO') || '|' || COALESCE(gap_para_meta_pessoal::text, 'NULO') FROM $V WHERE empresa = 'SOMETA'")" "NULO|NULO"
eq N8 "NULOFAT (snapshot com faturado NULL): posição e faixa NULL; o trânsito depois dele segue" \
  "$(Exec "SELECT COALESCE(posicao_ao_vivo_conservadora::text, 'NULO') || '|' || COALESCE(faixa_conservadora::text, 'NULO') || '|' || valor_em_transito_seguro FROM $V WHERE empresa = 'NULOFAT'")" "NULO|NULO|70000.00"

# Z — faturado ZERO é fato: posição conhecida.
eq Z1 "ZERO: posição 0,00 (não NULL), sem faixa, gap = meta" \
  "$(Exec "SELECT COALESCE(posicao_ao_vivo_conservadora::text, 'NULO') || '|' || COALESCE(faixa_conservadora->>'estrelas', 'NULO') || '|' || COALESCE(gap_para_meta_pessoal::text, 'NULO') FROM $V WHERE empresa = 'ZERO'")" "0.00|NULO|100000.00"
eq Z2 "ZEROTR: faturado 0 + 60.000 de trânsito = 60.000,00, 1★, faltam 40.000,00" \
  "$(Exec "SELECT COALESCE(posicao_ao_vivo_conservadora::text, 'NULO') || '|' || COALESCE(faixa_conservadora->>'estrelas', 'NULO') || '|' || COALESCE(gap_para_meta_pessoal::text, 'NULO') FROM $V WHERE empresa = 'ZEROTR'")" "60000.00|1|40000.00"

# M — meta NULL: só o gap fica desconhecido.
eq M1 "SEMMETA: posição 120.000,00 e 2★ valem; gap NULL (não 0 = 'atingida')" \
  "$(Exec "SELECT COALESCE(posicao_ao_vivo_conservadora::text, 'NULO') || '|' || COALESCE(faixa_conservadora->>'estrelas', 'NULO') || '|' || COALESCE(gap_para_meta_pessoal::text, 'NULO') FROM $V WHERE empresa = 'SEMMETA'")" "120000.00|2|NULO"

# V — o resto não mudou.
Q_DIF="SELECT count(*) FROM (
         (SELECT * FROM public.antes WHERE empresa IN ('CHEIO', 'ZERO', 'ZEROTR')
          EXCEPT ALL SELECT $COLS_TODAS FROM $V WHERE empresa IN ('CHEIO', 'ZERO', 'ZEROTR'))
         UNION ALL
         (SELECT $COLS_TODAS FROM $V WHERE empresa IN ('CHEIO', 'ZERO', 'ZEROTR')
          EXCEPT ALL SELECT * FROM public.antes WHERE empresa IN ('CHEIO', 'ZERO', 'ZEROTR'))) d"
eq V1 "com faturado e meta (CHEIO, ZERO, ZEROTR): as 23 colunas idênticas ao predecessor, nos dois sentidos" \
  "$(Exec "SELECT (SELECT count(*) FROM public.antes WHERE empresa IN ('CHEIO', 'ZERO', 'ZEROTR')) || '|' || ($Q_DIF)")" "3|0"
Q_DIF_FATO="SELECT count(*) FROM (
         (SELECT * FROM public.antes_fato EXCEPT ALL SELECT $COLS_FATO FROM $V)
         UNION ALL
         (SELECT $COLS_FATO FROM $V EXCEPT ALL SELECT * FROM public.antes_fato)) d"
Q_DERIVADAS_MUDARAM="SELECT string_agg(a.empresa, ',' ORDER BY a.empresa) FROM public.antes a JOIN $V n USING (empresa, ano, trimestre)
   WHERE (a.posicao_ao_vivo_conservadora, a.posicao_ao_vivo_otimista, a.faixa_conservadora, a.faixa_otimista, a.gap_para_meta_pessoal)
         IS DISTINCT FROM (n.posicao_ao_vivo_conservadora, n.posicao_ao_vivo_otimista, n.faixa_conservadora::jsonb, n.faixa_otimista::jsonb, n.gap_para_meta_pessoal)"
eq V2 "as derivadas mudaram EXATAMENTE nas linhas sem faturado ou sem meta" \
  "$(Exec "SELECT COALESCE(($Q_DERIVADAS_MUDARAM), 'NENHUMA')")" "NULOFAT,SEMMETA,SEMSNAP,SOMETA"
eq V3 "as 18 colunas não-derivadas idênticas em TODAS as linhas; 7 chaves, únicas" \
  "$(Exec "SELECT ($Q_DIF_FATO) || '|' || count(*) || '|' || count(DISTINCT (empresa, ano, trimestre)) FROM $V")" "0|7|7"
eq V4 "nomes, tipos e ordem das 23 colunas iguais aos do predecessor" "$(Exec "$Q_COLUNAS")" "$COLUNAS_ANTES"

# D — a dependente (corpo da prod) reage à faixa: some sem faturado, fica com faturado.
eq D1 "check-in de SEMSNAP sai da v_des_desconto_por_checkin (faixa desconhecida, nada a projetar)" \
  "$(Exec "SELECT count(*) FROM public.v_des_desconto_por_checkin WHERE empresa = 'SEMSNAP'")" 0
eq D2 "check-in de CHEIO segue: faixa nº3, padrão 1,50 + 0,75 do critério = 2,25 projetado" \
  "$(Exec "SELECT faixa_numero || '|' || desconto_padrao || '|' || desconto_total_projetado FROM public.v_des_desconto_por_checkin WHERE empresa = 'CHEIO'")" "3|1.50|2.25"

# S — security_invoker preservado.
eq S1 "security_invoker segue ligado" \
  "$(Exec "SELECT COALESCE(bool_or(lower(o) IN ('security_invoker=on', 'security_invoker=true'))::text, 'NULO')
           FROM pg_class c, unnest(c.reloptions) o WHERE c.oid = '$V'::regclass")" true
eq S2 "cliente autenticado não lê nenhuma linha (a RLS das bases vale através da view)" \
  "$(Como "$CLIENTE" "SELECT count(*) FROM $V")" 0
eq S3 "master lê as 7 (o 0 do S2 não é view vazia)" "$(Como "$MASTER" "SELECT count(*) FROM $V")" 7

echo "════════════════════════════════════════"
echo "PASS=$PASS FAIL=$FAIL (esperados $TOTAL_ESPERADO)"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ executou $PASS asserts, o denominador é $TOTAL_ESPERADO — bloco que não rodou é vermelho"
  exit 1
fi
[ "$FAIL" -eq 0 ]
