#!/usr/bin/env bash
# edges-pendentes-sql-eval.sh — EXECUTA o SQL de `.claude/skills/fecho/scripts/edges-pendentes.sh`
# num Postgres efêmero e julga a CLASSIFICAÇÃO que sai dele, cenário a cenário.
#
# POR QUE MORA AQUI e não na skill `fecho`: o `run.sh` desta pasta é o único agregador de evals
# que o CI roda (`bun run evals:deploy-verify`, blocking, mais a falsificação). Eval que não entra
# num runner do CI é falsificação que só roda à mão — ausência de dado
# (`docs/historico/falsificacao-fora-do-ci.md`). O assunto também é o mesmo dos vizinhos: o que
# está NO AR. A suíte de FORMA do script continua em `scripts/test-fecho-edges-pendentes.sh`.
#
# POR QUE EXECUTA em vez de casar string: desde 2026-09-05 o SQL tem CTE de vínculo, três classes
# em UNION ALL, `DISTINCT ON` e uma contagem que viaja na MESMA resposta. Nada disso é legível por
# grep: `NOT (x ? 'k')` com `x` NULL é NULL e não dispara o WHEN; um `JOIN` no lugar de `LEFT JOIN`
# some com a linha; uma CTE mal fechada só falha em runtime — e o script então cai em exit 2, que
# é fail-closed mas transforma TODA edge da janela em chip (o ruído que ele existe para cortar).
# O teste textual fica verde em todos esses casos.
#
# O QUE ESTE EVAL GUARDA, em uma frase: o script só pode APAGAR pendência com prova positiva, e só
# pode ATRIBUIR uma resposta a uma edge quando há vínculo — eco do slug ou `request_id` colado.
# Ausência de identidade nunca vira identidade presumida; e ausência de dado nunca vira "nenhuma
# sonda" quando a sonda respondeu (o defeito medido em prod nos request_ids 69377-69381).
#
# Exit 0 = todos os cenários bateram. 1 = divergência. 2 = via de prova não observável (fail-CLOSED:
# sem Postgres o eval NÃO passa em silêncio — ausência de dado nunca vira aprovação).
#
# --falsify: sabota o SCRIPT (em CÓPIA no tmp; o versionado nunca é tocado) e exige que cada
# sabotagem deixe ≥1 cenário VERMELHO. Sabotagem que ninguém pega = asserção sem dente.
set -uo pipefail
# `postmaster became multithreaded during startup` no macOS: o servidor recusa subir sob locale
# herdado. Mesmo `export` do harness db/test-*.sh, pelo mesmo motivo.
export LC_ALL=C LANG=C
cd "$(dirname "$0")" || exit 2

RAIZ_REPO=$(cd ../../../.. && pwd) || exit 2
ALVO_REAL="$RAIZ_REPO/.claude/skills/fecho/scripts/edges-pendentes.sh"
[ -f "$ALVO_REAL" ] || { echo "❌ VIA_NAO_OBSERVAVEL: alvo ausente: $ALVO_REAL"; exit 2; }

FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

TMP=$(mktemp -d) || exit 2
PGDATA_DIR="$TMP/pgdata"
PGSOCK="$TMP/sock"
PORT=$(( 24000 + (RANDOM % 20000) ))

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
  echo "   O eval NÃO degrada para 'ok': a classificação só se prova EXECUTANDO o SQL."
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
[ "$(P -tAc 'SELECT 1' 2>/dev/null)" = "1" ] || {
  echo "❌ VIA_NAO_OBSERVAVEL: Postgres subiu mas não respondeu 'SELECT 1'."; exit 2; }

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

# ── wrapper `psql-ro` de mentira ───────────────────────────────────────────────────────────────
# Imita o de prod inclusive no que ele tem de INCÔMODO: os dois `SET` da sessão read-only saem
# ANTES do resultado. Um alvo que exigisse a saída INTEIRA == "1" reprovaria o wrapper bom e
# nasceria travado em exit 2 — o defeito que a suíte de forma já guarda, aqui sob o banco real.
cat > "$TMP/psql-ro" <<WRAPPER
#!/usr/bin/env bash
echo SET; echo SET
exec "$PGBIN/psql" -p $PORT -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 "\$@"
WRAPPER
chmod +x "$TMP/psql-ro"

# ── mapa de fingerprints da "main" ─────────────────────────────────────────────────────────────
SHA_MAIN="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_VELHO="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
cat > "$TMP/mapa.ts" <<MAPA
export const FONTE_SHA256: Record<string, string> = {
  "edge-a": "$SHA_MAIN",
  "edge-b": "$SHA_MAIN",
};
MAPA

ID_SONDA=1000

# Cópia do script — a sabotagem do --falsify muta ESTA, nunca a versionada.
ALVO="$TMP/edges-pendentes.sh"
cp "$ALVO_REAL" "$ALVO"; chmod +x "$ALVO"

# ── cenários: o estado de `net._http_response` no instante da leitura ──────────────────────────
# `created` é sempre relativo a now(): janela fixa em timestamp literal envelheceria o eval.
ins() { # <id> <status> <corpo-json> [<offset-interval>]
  P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
           VALUES ($1, $2, \$j\$$3\$j\$, now() - interval '${4:-0 seconds}');"
}

semear() {
  local cen="$1"
  P -q -c "TRUNCATE net._http_response;" || return 1
  case "$cen" in
    eco_com_fonte_batendo)   # o caminho feliz: eco do slug + fonte igual à main
      ins $ID_SONDA 200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-a\",\"fonte\":\"$SHA_MAIN\"}" ;;
    eco_sem_fonte)           # bundle entre #1789 e #1998: ecoa o slug, não conhece `fonte`
      ins $ID_SONDA 200 '{"ok":true,"probe":true,"versao":"v1","edge":"edge-a"}' ;;
    anonima_sem_vinculo)     # bundle anterior ao #1789: respondeu e NÃO diz de quem é
      ins $ID_SONDA 200 '{"ok":true,"probe":true,"versao":"v1"}' ;;
    anonima_com_vinculo)     # a MESMA linha, agora com o request_id colado
      ins $ID_SONDA 200 '{"ok":true,"probe":true,"versao":"v1"}' ;;
    anonima_vinculo_no_ar)   # vínculo também ABSOLVE: anônima cuja `fonte` bate com a main
      ins $ID_SONDA 200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"fonte\":\"$SHA_MAIN\"}" ;;
    vinculo_para_cron)       # o id colado aponta para resposta de CRON (200, sem `probe`)
      ins $ID_SONDA 200 "{\"ok\":true,\"versao\":\"v1\",\"fonte\":\"$SHA_MAIN\"}" ;;
    vinculo_contraditorio)   # o id colado aponta para a resposta de OUTRA edge
      ins $ID_SONDA 200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-b\",\"fonte\":\"$SHA_MAIN\"}" ;;
    deploy_no_meio_da_janela) # velha BATE, nova não: o mais recente é que vale
      ins 900        200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-a\",\"fonte\":\"$SHA_MAIN\"}"  '3 hours'
      ins $ID_SONDA  200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-a\",\"fonte\":\"$SHA_VELHO\"}" '1 minute' ;;
    fora_da_janela)          # a única resposta é mais velha que o TTL ⇒ ausência de verdade
      ins $ID_SONDA 200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-a\",\"fonte\":\"$SHA_MAIN\"}" '30 hours' ;;
    corpo_nao_json)          # lixo alheio na janela não pode abortar a consulta inteira
      P -q -c "INSERT INTO net._http_response (id, status_code, content, created)
               VALUES (777, 200, 'nao sou json', now());" || return 1
      ins $ID_SONDA 200 "{\"ok\":true,\"probe\":true,\"versao\":\"v1\",\"edge\":\"edge-a\",\"fonte\":\"$SHA_MAIN\"}" ;;
    vazio) : ;;              # ninguém sondou: ausência de dado de verdade
    *) echo "cenário desconhecido: $cen" >&2; return 1 ;;
  esac
}

# rodar <cenario> [args extras do alvo...] — publica saída em $out e exit code em $rc
out=""; rc=0
rodar() {
  local cen="$1"; shift
  semear "$cen" >/dev/null 2>&1 || { out="SEED_FALHOU"; rc=99; return; }
  out="$(AFIACAO_PSQL="$TMP/psql-ro" FECHO_MAPA_FONTE="$TMP/mapa.ts" \
         bash "$ALVO" "$@" 2>&1)"; rc=$?
}

erros=0
# caso <nome> <cenario> <exit-esperado> <marcador> <descricao> [marcador-PROIBIDO] [-- args...]
caso() {
  local nome="$1" cen="$2" esp_rc="$3" marca="$4" desc="$5" proibido="${6:-}"; shift 6 2>/dev/null || shift $#
  [ "${1:-}" = "--" ] && shift
  rodar "$cen" "$@"
  if [ "$rc" != "$esp_rc" ]; then
    printf '  [XX ] %-26s exit=%s (esperado %s) — %s\n        %s\n' "$nome" "$rc" "$esp_rc" "$desc" "${out:0:200}"
    erros=$((erros + 1)); return
  fi
  case "$out" in
    *"$marca"*) ;;
    *) printf '  [XX ] %-26s saída sem "%s" — %s\n        %s\n' "$nome" "$marca" "$desc" "${out:0:200}"
       erros=$((erros + 1)); return ;;
  esac
  if [ -n "$proibido" ]; then
    case "$out" in
      *"$proibido"*) printf '  [XX ] %-26s saída trouxe a marca PROIBIDA "%s"\n        %s\n' "$nome" "$proibido" "${out:0:200}"
                     erros=$((erros + 1)); return ;;
    esac
  fi
  printf '  [ok ] %-26s %s\n' "$nome" "$desc"
}

# Marcadores em ASCII puro e caixa fixa: `case` com acento dobrado por normalização Unicode casa
# por acidente, e um marcador que casa sempre é asserção sem dente (#1483).
executar_casos() {
  erros=0
  caso no_ar eco_com_fonte_batendo 0 "NO_AR" \
    "eco do slug + fonte igual a main ⇒ prova positiva, sem chip" "" -- edge-a
  caso pre_sonda_fonte eco_sem_fonte 1 "PRE_SONDA_FONTE" \
    "ecoa o slug e nao conhece 'fonte' ⇒ pendencia PROVADA (bundle pre-#1998)" "nenhuma sonda em" -- edge-a
  caso sonda_anonima anonima_sem_vinculo 1 "SONDA_ANONIMA" \
    "respondeu SEM eco de slug ⇒ indeterminado que NAO alega ausencia" "nenhuma sonda em" -- edge-a
  caso vinculo_determina anonima_com_vinculo 1 "PRE_SONDA_FONTE" \
    "com o request_id colado a anonima vira veredito" "SONDA_ANONIMA" \
    -- edge-a --request-ids "edge-a=$ID_SONDA"
  caso vinculo_absolve anonima_vinculo_no_ar 0 "NO_AR" \
    "o vinculo tambem ABSOLVE quando a fonte servida bate" "" \
    -- edge-a --request-ids "edge-a=$ID_SONDA"
  caso vinculo_cron_recusado vinculo_para_cron 1 "SEM_PROVA" \
    "id apontando para resposta de CRON (sem 'probe') nao vira prova de sonda" "NO_AR" \
    -- edge-a --request-ids "edge-a=$ID_SONDA"
  caso vinculo_contraditorio vinculo_contraditorio 1 "SEM_PROVA" \
    "id cuja resposta ecoa OUTRO slug e recusado: identidade nao se fabrica" "NO_AR" \
    -- edge-a --request-ids "edge-a=$ID_SONDA"
  caso mais_recente_vence deploy_no_meio_da_janela 1 "DESATUALIZADA" \
    "deploy no meio da janela: a resposta VELHA que batia nao absolve" "NO_AR" -- edge-a
  caso janela_respeitada fora_da_janela 1 "nenhuma sonda em" \
    "resposta anterior ao TTL nao prova o agora, e nao ha anonima" "SONDA_ANONIMA" -- edge-a
  caso lixo_nao_aborta corpo_nao_json 0 "NO_AR" \
    "corpo nao-JSON alheio na janela nao derruba a consulta" "" -- edge-a
  caso ausencia_de_verdade vazio 1 "nenhuma sonda em" \
    "ninguem sondou ⇒ a mensagem de ausencia continua existindo" "SONDA_ANONIMA" -- edge-a
  # o seed ecoa `edge-b`: resposta COM eco nao e anonima. Sem esta trava o aviso apareceria em
  # toda janela (a janela e cheia de cron alheio) e viraria ruido que ninguem le.
  caso eco_alheio_nao_conta vinculo_contraditorio 1 "nenhuma sonda em" \
    "resposta que ecoa OUTRO slug nao entra na contagem de anonimas" "SONDA_ANONIMA" -- edge-a
  caso slug_forasteiro vazio 3 "SLUG_FORA_DA_LEVA" \
    "--request-ids com slug fora da leva e recusado antes de consultar nada" "" \
    -- edge-a --request-ids "edge-aa=$ID_SONDA"
}

if [ "$FALSIFY" = 0 ]; then
  echo "== edges-pendentes-sql — classificação do Passo 3 do /fecho, EXECUTANDO o SQL =="
  executar_casos
  [ "$erros" -eq 0 ] && echo "  tudo bateu: 13 cenários" || echo "  ❌ $erros divergência(s) acima"
  [ "$erros" -eq 0 ] || exit 1
  exit 0
fi

# ── falsificação: cada sabotagem precisa deixar ≥1 cenário VERMELHO ────────────────────────────
echo "== edges-pendentes-sql --falsify — sabota o script e exige vermelho =="
ORIG=$(cat "$ALVO_REAL")
cegas=0
sabotar() { # nome de para
  local nome="$1" de="$2" para="$3"
  if ! printf '%s' "$ORIG" | command grep -qF -- "$de"; then
    printf '  [XX ] sabotagem NO-OP (alvo sumiu do script): %s\n' "$nome"; cegas=$((cegas + 1)); return
  fi
  printf '%s' "$ORIG" | python3 -c '
import sys
de, para = sys.argv[1], sys.argv[2]
sys.stdout.write(sys.stdin.read().replace(de, para))
' "$de" "$para" > "$ALVO"
  chmod +x "$ALVO"
  executar_casos >"$TMP/falsify.out" 2>&1
  if [ "$erros" -ne 0 ]; then
    printf '  [ok ] pegada: %s\n' "$nome"
  else
    printf '  [XX ] sabotagem PASSOU DESPERCEBIDA: %s\n' "$nome"; cegas=$((cegas + 1))
  fi
  printf '%s' "$ORIG" > "$ALVO"; chmod +x "$ALVO"
}

sabotar "a 3a classe (casamento por request_id) some do SQL" \
        "FROM bruto b JOIN vinculo v ON v.request_id = b.id" \
        "FROM bruto b JOIN vinculo v ON false"
sabotar "o vinculo dispensa o eco de probe (id de cron vira prova de sonda)" \
        "WHERE (b.content::jsonb) ->> 'probe'  = 'true'
           AND (b.content::jsonb) ->> 'versao' IS NOT NULL
           AND COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" \
        "WHERE true"
sabotar "o vinculo aceita linha que ecoa OUTRO slug (identidade fabricada)" \
        "AND COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" \
        "AND true"
sabotar "a contagem de anonimas nunca acha nada (volta a 'nenhuma sonda')" \
        "AND NOT ((b.content::jsonb) ? 'edge')" \
        "AND false"
sabotar "a contagem conta TAMBEM o que ja casa por eco (aviso que aparece sempre)" \
        "AND NOT ((b.content::jsonb) ? 'edge')" \
        "AND true"
sabotar "o ramo da anonima some da classificacao" \
        'elif [ -z "$servido" ] && [ "$n_anonimas" -gt 0 ]; then' \
        'elif false; then'
# DERIVA entre as duas pontas: o SQL para de emitir a linha que o classificador le. Degradar
# para zero devolveria justamente a mensagem MENTIROSA de antes, entao o fail-closed e exit 2.
sabotar "o SQL para de emitir a linha #anonimas que o classificador le" \
        "       UNION ALL
       SELECT '#anonimas ' || n FROM anonimas;" \
        "       ;"
sabotar "o DISTINCT ON perde a ordem por created (resposta velha absolve)" \
        "ORDER BY edge, created DESC" \
        "ORDER BY edge, created ASC"
sabotar "a janela some do SQL (sondagem de ontem vira veredito de hoje)" \
        "AND created > now() - interval '\$JANELA'" \
        "AND true"
sabotar "presenca vira prova: qualquer fonte servida absolve" \
        '[ "$servido" = "$esperado" ]' \
        '[ -n "$servido" ]'
sabotar "--request-ids com slug forasteiro passa calado (typo sem vinculo)" \
        'if ! command grep -Fxq -- "$_slug" "$tmp/alvos"; then' \
        'if false; then'

echo "--falsify: $cegas cegueira(s) (esperado: 0)"
[ "$cegas" -eq 0 ] || exit 1
exit 0
