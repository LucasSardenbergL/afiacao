#!/usr/bin/env bash
# sonda-veredito-401-eval.sh — EXECUTA o SQL gerado por `scripts/sonda-versao-sql.ts` num Postgres
# efêmero e julga a coluna `veredito`, cenário a cenário.
#
# POR QUE EXECUTA em vez de casar string: o ramo em teste decide por SEMÂNTICA DE NULL e por ORDEM
# de WHEN. `NULL > 0` não é falso, é NULL — o WHEN não dispara e a linha cai no vizinho, que pode
# ser o ramo confiante. Um teste textual ("o SQL contém 'INDETERMINADO'") prova que a string está
# no arquivo, não que o CASE a devolve: é a asserção que fica verde justamente quando a ordem dos
# ramos está errada. Aqui o veredito é lido do banco, não do código-fonte.
#
# O QUE ESTE EVAL GUARDA: um HTTP 401 na sonda é AMBÍGUO por construção —
#   (a) bundle PRÉ-SONDA, que ignorou {"probe":true}, caiu no gate JWT da edge e devolveu 401; ou
#   (b) CRON_SECRET ausente/errado no vault, e `authorizeCronOrStaff` recusou o header.
# Nos DOIS o corpo vem sem `versao` e o status é 401. Ler (b) como (a) manda o founder redeployar
# uma edge que já está no ar — família `ausente ≠ zero`, na dimensão CREDENCIAL, e irmão exato do
# guard temporal do #2079 (`verify-edge-eco.sh`), onde ler tick pré-merge como pendência produzia o
# mesmo falso negativo confiante. Medido em 2026-08-30 verificando o deploy de
# `generate-bundle-argument` (#2101): a ambiguidade é real e foi fechada À MÃO, fora da ferramenta,
# com uma consulta que o bloco não fazia. Depender de o operador lembrar é o mesmo recado que
# deixou a sentinela não-exclusiva passar (SKILL.md).
#
# Exit 0 = todos os cenários bateram. 1 = divergência. 2 = via de prova não observável (fail-CLOSED:
# sem Postgres o eval NÃO passa em silêncio — ausência de dado nunca vira aprovação).
#
# --falsify: sabota o GERADOR (em CÓPIA no tmp; o versionado nunca é tocado) e exige que cada
# sabotagem deixe ≥1 cenário VERMELHO. Sabotagem que ninguém pega = asserção sem dente.
set -uo pipefail
# `postmaster became multithreaded during startup` no macOS: o servidor recusa subir sob
# locale herdado. Mesmo `export` do harness db/test-*.sh, pelo mesmo motivo.
export LC_ALL=C LANG=C
cd "$(dirname "$0")" || exit 2

RAIZ_REPO=$(cd ../../../.. && pwd) || exit 2
FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

TMP=$(mktemp -d) || exit 2
PGDATA_DIR="$TMP/pgdata"
PGSOCK="$TMP/sock"
PORT=$(( 24000 + (RANDOM % 20000) ))

# ── via de prova: bun (gera o SQL) e um Postgres (executa o veredito) ────────────────────────────
# `command -v` NÃO basta — presente-porém-quebrada esvazia o guard igual. Cada via é confirmada por
# resposta POSITIVA antes de qualquer cenário rodar.
command -v bun >/dev/null 2>&1 || { echo "❌ VIA_NAO_OBSERVAVEL: bun ausente — o SQL não pode ser gerado."; exit 2; }

achar_pgbin() {
  local c
  for c in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin \
           /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin; do
    [ -x "$c/initdb" ] && [ -x "$c/pg_ctl" ] && { printf '%s' "$c"; return 0; }
  done
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"; return 0
  fi
  return 1
}
PGBIN=$(achar_pgbin) || {
  echo "❌ VIA_NAO_OBSERVAVEL: nenhum Postgres local (initdb/pg_ctl)."
  echo "   macOS: brew install postgresql@17 · Debian/Ubuntu: apt-get install -y postgresql"
  echo "   O eval NÃO degrada para 'ok': o veredito 401 só se prova EXECUTANDO."
  exit 2
}

# shellcheck disable=SC2329  # invocada indiretamente pelo `trap limpar EXIT` logo abaixo
limpar() {
  "$PGBIN/pg_ctl" -D "$PGDATA_DIR" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap limpar EXIT

mkdir -p "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres -E UTF8 --locale=C >"$TMP/initdb.log" 2>&1 || {
  echo "❌ VIA_NAO_OBSERVAVEL: initdb falhou. $(tail -3 "$TMP/initdb.log")"; exit 2; }
"$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PORT -k $PGSOCK -c listen_addresses=''" \
  -l "$TMP/pg.log" -w start >/dev/null 2>&1 || {
  echo "❌ VIA_NAO_OBSERVAVEL: o Postgres efêmero não subiu. $(tail -3 "$TMP/pg.log")"; exit 2; }

P() { "$PGBIN/psql" -p "$PORT" -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
# Sonda POSITIVA da via: servidor no ar E respondendo o valor certo.
[ "$(P -tAc 'SELECT 1' 2>/dev/null)" = "1" ] || {
  echo "❌ VIA_NAO_OBSERVAVEL: Postgres subiu mas não respondeu 'SELECT 1'."; exit 2; }

# ── stub de `net._http_response` (o que o pg_net materializa em prod) ────────────────────────────
P -q <<'SQL' || exit 2
CREATE SCHEMA net;
CREATE TABLE net._http_response (
  id           bigint PRIMARY KEY,
  status_code  int,
  content_type text,
  headers      jsonb,
  content      text,
  timed_out    boolean,
  error_msg    text,
  created      timestamptz NOT NULL DEFAULT now()
);
SQL

# ── repo-fixture: o gerador roda contra ele, não contra a árvore real ────────────────────────────
# Mantém o eval determinístico (o mapa de fingerprints do repo muda a cada deploy) e preserva o
# "cwd neutro" que o step do CI documenta: nada aqui lê `src/` nem o estado do repo de verdade.
FIX="$TMP/repo"
mkdir -p "$FIX/supabase/functions/edge-a" "$FIX/supabase/functions/_shared"
printf 'project_id = "refdementira000000ab"\n' > "$FIX/supabase/config.toml"
printf 'export const VERSAO = "v1.0-alfa";\n' > "$FIX/supabase/functions/edge-a/versao.ts"
FP_A=$(printf 'edge-a' | shasum -a 256 2>/dev/null | cut -d' ' -f1) \
  || FP_A=$(printf 'edge-a' | sha256sum | cut -d' ' -f1)
printf 'export const FONTE_SHA256: Record<string, string> = {\n  "edge-a": "%s",\n};\n' \
  "$FP_A" > "$FIX/supabase/functions/_shared/sonda-fingerprints.ts"

ID_SONDA=1000

# gera_sql <dir_do_gerador> — emite o BLOCO DE LEITURA (PASSO 2) com o JSON de ids já colado.
gera_sql() {
  local gdir="$1"
  cat > "$gdir/runner.ts" <<RUNNER
import { gerarSqlDaLeva } from './sonda-versao-sql';
process.stdout.write(gerarSqlDaLeva({ raiz: process.argv[2], edges: ['edge-a'] }));
RUNNER
  bun "$gdir/runner.ts" "$FIX" 2>"$TMP/gen.err" \
    | awk '/^-- PASSO 2 /{f=1} f' \
    | sed "s/jsonb_each_text('{}'::jsonb)/jsonb_each_text('{\"edge-a\": $ID_SONDA}'::jsonb)/"
}

# Cópia do gerador — a sabotagem do --falsify muta ESTA, nunca a versionada.
GER="$TMP/gerador"
mkdir -p "$GER"
cp "$RAIZ_REPO/scripts/sonda-versao-sql.ts" "$RAIZ_REPO/scripts/sonda-fingerprint.ts" "$GER/"

# ── cenários: o estado de `net._http_response` no instante da leitura ────────────────────────────
# `created` é sempre relativo a now(): janela fixa em timestamp literal envelheceria o eval.
semear() {
  local cen="$1"
  P -q -c "TRUNCATE net._http_response;" || return 1
  case "$cen" in
    velho_com_controle)   # 401 na sonda + tráfego de fundo saudável: o secret ESTÁ sendo aceito
      P -q <<SQL
INSERT INTO net._http_response (id, status_code, content, created)
  VALUES ($ID_SONDA, 401, '{"code":401,"message":"Missing authorization header"}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 40) g;
SQL
      ;;
    sem_controle)         # 401 e NADA mais: o controle não pode ser observado
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 401, '{\"code\":401}', now());"
      ;;
    controle_com_401_alheio)  # há 2xx, mas TAMBÉM 401 fora da leva ⇒ o secret é suspeito
      P -q <<SQL
INSERT INTO net._http_response (id, status_code, content, created)
  VALUES ($ID_SONDA, 401, '{"code":401}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 40) g;
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT 500 + g, 401, '{"code":401}', now() - (g || ' minutes')::interval FROM generate_series(1, 3) g;
SQL
      ;;
    controle_velho)       # os 2xx existem, mas TODOS fora da janela ⇒ não provam o agora
      P -q <<SQL
INSERT INTO net._http_response (id, status_code, content, created)
  VALUES ($ID_SONDA, 401, '{"code":401}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT g, 200, '{"ok":true}', now() - interval '30 hours' FROM generate_series(1, 40) g;
SQL
      ;;
    controle_raso)        # tráfego recente ínfimo ⇒ população não informa; fail-closed
      P -q <<SQL
INSERT INTO net._http_response (id, status_code, content, created)
  VALUES ($ID_SONDA, 401, '{"code":401}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 2) g;
SQL
      ;;
    nao_401_segue_determinado)  # 404 não é ambíguo: a edge não está servida
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 404, '{\"code\":\"NOT_FOUND\"}', now());"
      ;;
    pre_sensor)           # 200 sem versao: ignorou o probe e RODOU o fluxo real
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 200, '{\"ok\":true}', now());"
      ;;
    sem_campo_fonte)      # 200 + probe + versao e SEM o campo `fonte`: bundle anterior ao #1998
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 200,
                 '{\"edge\":\"edge-a\",\"versao\":\"v1.0-alfa\",\"probe\":true}', now());"
      ;;
    fonte_nao_mapeada)    # o campo EXISTE valendo o sentinela: o bundle conhece `fonte` (>= #1998)
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 200,
                 '{\"edge\":\"edge-a\",\"versao\":\"v1.0-alfa\",\"fonte\":\"nao-mapeada\",\"probe\":true}', now());"
      ;;
    confirmado)           # eco completo: versao + fonte + probe + edge
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES ($ID_SONDA, 200,
                 '{\"edge\":\"edge-a\",\"versao\":\"v1.0-alfa\",\"fonte\":\"$FP_A\",\"probe\":true}', now());"
      ;;
    *) echo "cenário desconhecido: $cen" >&2; return 1 ;;
  esac
}

# veredito <cenario> <dir_gerador> — devolve a string do veredito da edge-a
veredito() {
  local cen="$1" gdir="$2"
  semear "$cen" >/dev/null 2>&1 || { echo "SEED_FALHOU"; return; }
  gera_sql "$gdir" > "$TMP/leitura.sql" 2>/dev/null
  [ -s "$TMP/leitura.sql" ] || { echo "SQL_VAZIO"; return; }
  P -tAF'|' -f "$TMP/leitura.sql" 2>"$TMP/psql.err" | awk -F'|' 'NF>1 {print $NF}' | head -1
}

rc=0
uma_linha_por_edge() { # cenario — o CROSS JOIN do controle não pode multiplicar a leva
  local cen="$1" n
  semear "$cen" >/dev/null 2>&1 || { printf '  [XX ] %-26s seed falhou\n' "uma_linha_por_edge"; rc=1; return; }
  gera_sql "$GER" > "$TMP/leitura.sql" 2>/dev/null
  n=$(P -tAF'|' -f "$TMP/leitura.sql" 2>/dev/null | command grep -c . || true)
  if [ "$n" != "1" ]; then
    printf '  [XX ] %-26s a leva de 1 edge devolveu %s linha(s) — o controle multiplicou a projeção\n' \
      "uma_linha_por_edge" "$n"; rc=1; return
  fi
  printf '  [ok ] %-26s 1 edge ⇒ 1 linha: o CROSS JOIN do controle não duplica o relatório\n' "uma_linha_por_edge"
}

caso() { # nome cenario marcador_esperado descricao [marcador_PROIBIDO]
  local nome="$1" cen="$2" esp="$3" desc="$4" proibido="${5:-}" got
  got=$(veredito "$cen" "$GER")
  case "$got" in
    *"$esp"*) ;;
    *) printf '  [XX ] %-26s veredito=%s\n        esperava conter "%s" — %s\n' "$nome" "${got:-<vazio>}" "$esp" "$desc"
       rc=1; return ;;
  esac
  if [ -n "$proibido" ]; then
    case "$got" in
      *"$proibido"*) printf '  [XX ] %-26s veredito trouxe a marca PROIBIDA "%s": %s\n' "$nome" "$proibido" "$got"
                     rc=1; return ;;
    esac
  fi
  printf '  [ok ] %-26s %s\n' "$nome" "$desc"
}

# ── os cenários ─────────────────────────────────────────────────────────────────────────────────
# Marcadores em ASCII puro e caixa fixa: `grep`/`case` com acento dobrado por normalização Unicode
# casa por acidente, e um marcador que casa sempre é asserção sem dente (#1483).
executar_casos() {
  rc=0
  caso velho_com_controle       velho_com_controle       "BUNDLE VELHO (pre-sonda)" \
    "401 com o secret PROVADO bom por tráfego de fundo ⇒ veredito determinado"
  caso sem_controle             sem_controle             "INDETERMINADO" \
    "401 sem controle observável ⇒ NUNCA 'bundle velho'" "BUNDLE VELHO (pre-sonda)"
  caso controle_com_401_alheio  controle_com_401_alheio  "INDETERMINADO" \
    "401 alheio na janela ⇒ o secret é suspeito, veredito se recusa" "BUNDLE VELHO (pre-sonda)"
  caso controle_velho           controle_velho           "INDETERMINADO" \
    "2xx todos fora da janela ⇒ não provam o AGORA" "BUNDLE VELHO (pre-sonda)"
  caso controle_raso            controle_raso            "INDETERMINADO" \
    "tráfego recente abaixo do piso ⇒ população não informa" "BUNDLE VELHO (pre-sonda)"
  caso nao_401_segue_determinado nao_401_segue_determinado "NADA executou" \
    "404 NÃO é ambíguo: segue determinado, o 401 não contaminou os outros 4xx"
  caso pre_sensor               pre_sensor               "PRE-SENSOR" \
    "200 sem versao continua no ramo do fluxo real"
  caso sem_campo_fonte          sem_campo_fonte          "PRE_SONDA_FONTE" \
    "corpo SEM o campo fonte ⇒ bundle inteiro anterior ao #1998, NUNCA 'parcial'" "DEPLOY PARCIAL"
  caso fonte_nao_mapeada        fonte_nao_mapeada        "DEPLOY PARCIAL" \
    "campo PRESENTE valendo nao-mapeada ⇒ aí sim faltou o mapa no deploy" "PRE_SONDA_FONTE"
  caso confirmado               confirmado               "DEPLOY CONFIRMADO" \
    "eco completo segue confirmando — o ramo novo não roubou o caminho feliz"
  uma_linha_por_edge confirmado
}

if [ "$FALSIFY" = 0 ]; then
  echo "== sonda-veredito-401 — 401 é ambíguo: bundle velho × CRON_SECRET inválido =="
  executar_casos
  [ "$rc" -eq 0 ] && echo "  tudo bateu: 10 vereditos + cardinalidade" || echo "  ❌ divergência(s) acima"
  exit "$rc"
fi

# ── falsificação: cada sabotagem precisa deixar ≥1 cenário VERMELHO ──────────────────────────────
echo "== sonda-veredito-401 --falsify — sabota o gerador e exige vermelho =="
ORIG=$(cat "$GER/sonda-versao-sql.ts")
cegas=0
sabotar() { # nome de para
  local nome="$1" de="$2" para="$3"
  if ! printf '%s' "$ORIG" | command grep -qF "$de"; then
    printf '  [XX ] sabotagem NO-OP (alvo sumiu do gerador): %s\n' "$nome"; cegas=$((cegas + 1)); return
  fi
  printf '%s' "$ORIG" | python3 -c '
import sys
de, para = sys.argv[1], sys.argv[2]
sys.stdout.write(sys.stdin.read().replace(de, para))
' "$de" "$para" > "$GER/sonda-versao-sql.ts"
  executar_casos >"$TMP/falsify.out" 2>&1
  if [ "$rc" -ne 0 ]; then
    printf '  [ok ] pegada: %s\n' "$nome"
  else
    printf '  [XX ] sabotagem PASSOU DESPERCEBIDA: %s\n' "$nome"; cegas=$((cegas + 1))
  fi
  printf '%s' "$ORIG" > "$GER/sonda-versao-sql.ts"
}

sabotar "401 volta a cair no ramo generico >=400 (o falso 'bundle velho' que motivou tudo)" \
        "l.status_code = 401" "false"
sabotar "fail-closed vira fail-open: o fallback do 401 vira veredito confiante" \
        "'INDETERMINADO — 401" "'BUNDLE VELHO (pre-sonda) — 401"
sabotar "controle deixa de excluir a PROPRIA leva (a sonda avaliza a si mesma)" \
        "AND NOT EXISTS (SELECT 1 FROM ids i2 WHERE i2.request_id = r.id)" ""
sabotar "piso do controle zerado: uma unica resposta 2xx ja 'prova' o secret" \
        "const PISO_CONTROLE_CREDENCIAL = 10;" "const PISO_CONTROLE_CREDENCIAL = 0;"
sabotar "401 alheio na janela deixa de desqualificar o controle" \
        "AND c.recusas_recentes = 0" ""
sabotar "janela do controle esticada: 2xx de anteontem 'provam' o agora" \
        "now() - interval '6 hours'" "now() - interval '100 years'"
sabotar "controle nao chega na projecao (CROSS JOIN removido)" \
        " CROSS JOIN controle_credencial c" ""
# As duas abaixo guardam a SEPARACAO das causas de "sem fingerprint no ar". Ela e semantica de
# ORDEM de WHEN + semantica de `?` sobre jsonb, e as duas so aparecem EXECUTANDO: um teste textual
# ve as duas strings no arquivo e fica verde mesmo com o ramo inalcancavel.
sabotar "campo ausente volta a ser lido como DEPLOY PARCIAL (o defeito de 2026-09-05)" \
        "WHEN NOT (l.corpo ? 'fonte')" "WHEN false"
sabotar "o COALESCE que fundia ausente com nao-mapeada volta" \
        "WHEN NOT (l.corpo ? 'fonte')" "WHEN COALESCE(l.corpo ->> 'fonte', 'nao-mapeada') = 'nao-mapeada'"

echo "--falsify: $cegas cegueira(s) (esperado: 0)"
[ "$cegas" -eq 0 ] || exit 1
exit 0
