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
# --falsify: sabota o SCRIPT (em CÓPIA no tmp; o versionado nunca é tocado) e exige que o caso que
# acusa cada sabotagem saia com o exit|marca PREVISTO dela. Sabotagem que ninguém pega = asserção sem dente.
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

P() { "$PGBIN/psql" -X -p "$PORT" -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
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
exec "$PGBIN/psql" -X -p $PORT -h "$PGSOCK" -U postgres -d postgres -v ON_ERROR_STOP=1 "\$@"
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
# `via_caiu` acumula os casos em que a VIA não respondeu (≠ respondeu OUTRA coisa). `semear` só usa
# o Postgres — nunca o script sob sabotagem — então seed falhado é infraestrutura por construção.
via_caiu=""
rodar() {
  local cen="$1"; shift
  semear "$cen" >/dev/null 2>&1 || {
    out="SEED_FALHOU"; rc=99; via_caiu="${via_caiu}${cen}/SEED_FALHOU "; return; }
  out="$(AFIACAO_PSQL="$TMP/psql-ro" FECHO_MAPA_FONTE="$TMP/mapa.ts" \
         bash "$ALVO" "$@" 2>&1)"; rc=$?
}

erros=0
# `SO_CASO` roda UM caso isolado (a falsificação julga só o caso que acusa a sabotagem); `n_rodados`
# prova que ele existiu — filtro com nome errado rodaria zero casos e se leria como "verde".
SO_CASO=""; n_rodados=0
# caso <nome> <cenario> <exit-esperado> <marcador> <descricao> [marcador-PROIBIDO] [-- args...]
caso() {
  [ -n "$SO_CASO" ] && [ "$1" != "$SO_CASO" ] && return 0
  n_rodados=$((n_rodados + 1))
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
  via_caiu=""
  n_rodados=0; out=""; rc=""
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
  if [ -n "$via_caiu" ]; then
    echo "  ❌ VIA_NAO_OBSERVAVEL: cenário(s) sem resposta nenhuma — $via_caiu"
    echo "     Isto NÃO é divergência de contrato: o Postgres efêmero não respondeu."
    exit 2
  fi
  [ "$erros" -eq 0 ] && echo "  tudo bateu: 13 cenários" || echo "  ❌ $erros divergência(s) acima"
  [ "$erros" -eq 0 ] || exit 1
  exit 0
fi

# ── falsificação: cada sabotagem DECLARA o caso que a acusa e o desfecho PREVISTO dele ──────────
# O juiz de antes contava a sabotagem se QUALQUER dos 13 casos ficasse vermelho — e uma sabotagem
# que só QUEBRA o SQL derruba todos para exit 2 ("a consulta a net._http_response falhou"): era
# dente sem nenhum assert ter julgado nada. Agora cada `sabotar` nomeia o caso-alvo e o `exit|marca`
# que ele TEM de devolver sob a sabotagem, e o caso roda ISOLADO, contra um baseline íntegro da
# mesma invocação. → docs/historico/falsificacao-exit-nao-e-dente.md · referência:
# monitor-deploy-pr-eval.sh (caso-alvo isolado: tem de passar íntegro e falhar pelo previsto).
# Locale: este eval fixa LC_ALL=C no topo (o Postgres recusa subir sob o herdado), então o locale do
# chamador não alcança o juiz; as marcas são ASCII de caixa fixa de qualquer forma (#1483).
echo "== edges-pendentes-sql --falsify — sabota o script e exige o vermelho PREVISTO =="
ORIG=$(cat "$ALVO_REAL")

# CONTROLE VERDE na MESMA invocação, ANTES da 1ª sabotagem. Sem ele, uma suíte sempre-vermelha
# (Postgres meio subido, fixture quebrada) aprovaria as sabotagens de uma vez: cada uma "pegaria" um
# vermelho que já existia. → docs/historico/falsificacao-sem-linha-de-base.md
executar_casos > "$TMP/controle.out" 2>&1
if [ "$erros" -ne 0 ] || [ -n "$via_caiu" ] || [ "$n_rodados" -lt 13 ]; then
  if [ -n "$via_caiu" ]; then
    echo "  ❌ VIA_NAO_OBSERVAVEL: o controle nem chegou a ter resposta — $via_caiu"
    echo "     Nenhuma sabotagem foi tentada, e NADA foi provado (≠ 'o contrato mudou')."
  else
    echo "  [XX ] CONTROLE VERMELHO com o script ÍNTEGRO ($erros divergência(s), $n_rodados caso(s)) — nenhuma sabotagem foi tentada:"
  fi
  cat "$TMP/controle.out"
  [ -n "$via_caiu" ] && exit 2
  exit 1
fi
echo "  [ok ] controle: os $n_rodados cenários passam com o script íntegro"

# via_viva — a via de prova ainda responde? Sonda POSITIVA fim-a-fim com o script JÁ RESTAURADO:
# semeia o caminho feliz e exige a marca conhecida de volta. Irmã da `via_viva` do
# `sonda-veredito-401-eval.sh`, e pelo mesmo motivo: vermelho por AUSÊNCIA de resposta não prova o
# mesmo que vermelho por resposta DIVERGENTE, e creditar a sabotagem pelo primeiro aprova 100% das
# sabotagens seguintes sem ter olhado nenhuma.
VIA_MOTIVO=""
via_viva() {
  local o r
  semear eco_com_fonte_batendo >/dev/null 2>&1 || {
    VIA_MOTIVO="a semeadura falhou — o Postgres efêmero morreu no meio do laço."; return 1; }
  o=$(AFIACAO_PSQL="$TMP/psql-ro" FECHO_MAPA_FONTE="$TMP/mapa.ts" bash "$ALVO" edge-a 2>&1); r=$?
  if [ "$r" -ne 0 ]; then
    VIA_MOTIVO="o script ÍNTEGRO saiu $r no caminho feliz: ${o:0:160}"; return 1
  fi
  case "$o" in
    *NO_AR*) return 0 ;;
    *) VIA_MOTIVO="o script ÍNTEGRO deixou de confirmar o caminho feliz: ${o:0:160}"; return 1 ;;
  esac
}
via_caida() { # via_sab nome — a via caiu? então exit 2 nomeando a causa (nunca "pegada")
  printf '  ❌ VIA_NAO_OBSERVAVEL: a via caiu durante a sabotagem "%s".\n' "$2"
  printf '     %s\n' "$VIA_MOTIVO"
  printf '     cenário(s) sem resposta: %s\n' "$1"
  printf '     As %s sabotagem(ns) já julgadas valem; as seguintes NÃO foram tentadas.\n' "$julgadas"
  echo   "     Isto NÃO é 'o contrato mudou' e NÃO se conserta editando a sabotagem."
  exit 2
}
# bate <exit> <saída> <exit|marca previsto> → 0 só se o exit E a marca batem. `case` do shell.
bate() {
  [ "$1" = "${3%%|*}" ] || return 1
  case "$2" in *"${3#*|}"*) return 0 ;; esac
  return 1
}

cegas=0
julgadas=0
ULTIMO_MOTIVO=""; juiz_ok=1
# erro_de_shell <saída> → 0 se ela traz um erro de EXECUÇÃO do bash (`<script>: line N: …`): a marca
# pode ter vindo do PRÓPRIO diagnóstico (`${x?nenhuma sonda em}`), ou saído antes de o script morrer
# com o exit previsto (achados do Codex, 2026-09-27). Crash não é dente.
erro_de_shell() { local re=': line [0-9]+: '; [[ $1 =~ $re ]]; }
sabotar() { # nome de para caso-alvo exit|marca-prevista
  local nome="$1" de="$2" para="$3"
  # Busca no PRÓPRIO shell: sem pipe, sem fork, sem locale. NÃO devolver `printf | command grep -qF`
  # aqui — sob `set -o pipefail` o status do pipeline NÃO é o do grep: `grep -q` sai no PRIMEIRO
  # match e fecha o pipe, o `printf` (que ainda tinha bytes a escrever) morre de SIGPIPE e o
  # pipeline devolve 141 com o grep tendo ACHADO (`PIPESTATUS=141 0`). Este guard leria 141 como
  # "não achei" e acusaria alvo ausente com o alvo PRESENTE — reprovando o CI à toa e ensinando a
  # re-rodar, que apaga sinal. É corrida (só dispara se o `printf` não terminar antes), então
  # aparece como flake. Medido no eval IRMÃO (`sonda-veredito-401`, run 34116946335 na main,
  # 2026-09-07): 2 das 11 sabotagens acusaram alvo ausente com o texto BYTE-IDÊNTICO ao do run
  # que passou. Este guard era a mesma construção sobre um `$ORIG` do mesmo porte — mesmo risco.
  # `"$de"` entre aspas DENTRO do padrão casa LITERALMENTE: `?`/`*` do alvo não viram curinga.
  # Guardado por `scripts/test-guard-noop-sabotagem.sh` (roda o guard sob um leitor com a semântica
  # do GNU `grep -q`, que o BSD grep do macOS não tem). → docs/historico/evidencia-positiva-shell.md
  case "$ORIG" in
    *"$de"*) ;;
    *) printf '  [XX ] sabotagem NO-OP (alvo sumiu do script): %s\n' "$nome"; cegas=$((cegas + 1)); return ;;
  esac
  # Presente não basta: o alvo tem de aparecer EXATAMENTE 1 vez (sabotado só pela metade não prova).
  if ! printf '%s' "$ORIG" | python3 -c '
import sys
de, para = sys.argv[1], sys.argv[2]
s = sys.stdin.read()
if s.count(de) != 1:
    sys.exit("o alvo aparece %d vez(es)" % s.count(de))
sys.stdout.write(s.replace(de, para, 1))
' "$de" "$para" > "$TMP/sabotado.sh" 2>"$TMP/aplica.err"; then
    printf '  [XX ] sabotagem AMBÍGUA (%s): %s\n' "$(tr '\n' ' ' < "$TMP/aplica.err")" "$nome"; cegas=$((cegas + 1)); ULTIMO_MOTIVO=NAO-APLICOU; return
  fi
  local caso="$4" prev="$5" err_sab via_sab rc_sab out_sab
  if ! bash -n "$TMP/sabotado.sh" 2>/dev/null; then
    printf '  [XX ] a sabotagem quebrou a SINTAXE do script (vermelho pelo motivo errado): %s\n' "$nome"
    cegas=$((cegas + 1)); ULTIMO_MOTIVO=SINTAXE; return
  fi
  # BASELINE do caso-alvo com o script ÍNTEGRO, na mesma invocação: ele passa, e o previsto NÃO o
  # descreve — senão "bateu o previsto" não distinguiria sabotagem de nada.
  SO_CASO="$caso"; executar_casos >"$TMP/base.out" 2>&1; SO_CASO=""
  if [ -n "$via_caiu" ] && ! via_viva; then via_caida "$via_caiu" "$nome"; fi
  if [ "$n_rodados" -ne 1 ] || [ "$erros" -ne 0 ]; then
    printf '  [XX ] o caso-alvo "%s" não passa ÍNTEGRO (rodaram %s): %s\n' "$caso" "$n_rodados" "$nome"
    cegas=$((cegas + 1)); ULTIMO_MOTIVO=CONTROLE; return
  fi
  if bate "$rc" "$out" "$prev"; then
    printf '  [XX ] o previsto [%s] já descreve o caso ÍNTEGRO "%s" — não discrimina: %s\n' "$prev" "$caso" "$nome"
    cegas=$((cegas + 1)); ULTIMO_MOTIVO=PREVISTO-NO-CONTROLE; return
  fi
  cp "$TMP/sabotado.sh" "$ALVO"; chmod +x "$ALVO"
  SO_CASO="$caso"; executar_casos >"$TMP/falsify.out" 2>&1; SO_CASO=""
  err_sab="$erros" via_sab="$via_caiu" rc_sab="$rc" out_sab="$out"
  # Restaura ANTES de julgar: `via_viva` precisa do script íntegro para ser sonda da VIA, e não
  # da sabotagem.
  printf '%s' "$ORIG" > "$ALVO"; chmod +x "$ALVO"
  if [ -n "$via_sab" ] && ! via_viva; then via_caida "$via_sab" "$nome"; fi
  if [ "$err_sab" -eq 0 ]; then
    printf '  [XX ] sabotagem PASSOU DESPERCEBIDA (%s seguiu verde): %s\n' "$caso" "$nome"; cegas=$((cegas + 1)); ULTIMO_MOTIVO=DESPERCEBIDA; return
  fi
  if erro_de_shell "$out_sab"; then
    printf '  [XX ] vermelho por ERRO DE SHELL (%s: o script MORREU — a marca não conta): %s\n        %s\n' \
      "$caso" "$nome" "$(printf '%s\n' "$out_sab" | command grep -m1 -E ': line [0-9]+: ' | cut -c1-160)"
    cegas=$((cegas + 1)); ULTIMO_MOTIVO=ERRO-DE-SHELL; return
  fi
  if ! bate "$rc_sab" "$out_sab" "$prev"; then
    printf '  [XX ] vermelho pelo motivo ERRADO (%s: previsto [%s], obtido exit=%s): %s\n        %s\n' \
      "$caso" "$prev" "$rc_sab" "$nome" "${out_sab:0:200}"
    cegas=$((cegas + 1)); ULTIMO_MOTIVO="MARCA exit=$rc_sab"; return
  fi
  julgadas=$((julgadas + 1)); ULTIMO_MOTIVO=CREDITADO
  printf '  [ok ] pegada por %s [%s]: %s\n' "$caso" "$prev" "$nome"
}

sabotar "a 3a classe (casamento por request_id) some do SQL" \
        "FROM bruto b JOIN vinculo v ON v.request_id = b.id" \
        "FROM bruto b JOIN vinculo v ON false" \
        vinculo_determina "1|nenhuma sonda em"
sabotar "o vinculo dispensa o eco de probe (id de cron vira prova de sonda)" \
        "WHERE (b.content::jsonb) ->> 'probe'  = 'true'
           AND (b.content::jsonb) ->> 'versao' IS NOT NULL
           AND COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" \
        "WHERE true" \
        vinculo_cron_recusado "0|NO_AR"
sabotar "o vinculo aceita linha que ecoa OUTRO slug (identidade fabricada)" \
        "AND COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge" \
        "AND true" \
        vinculo_contraditorio "0|NO_AR"
sabotar "a contagem de anonimas nunca acha nada (volta a 'nenhuma sonda')" \
        "AND NOT ((b.content::jsonb) ? 'edge')" \
        "AND false" \
        sonda_anonima "1|nenhuma sonda em"
sabotar "a contagem conta TAMBEM o que ja casa por eco (aviso que aparece sempre)" \
        "AND NOT ((b.content::jsonb) ? 'edge')" \
        "AND true" \
        eco_alheio_nao_conta "1|SONDA_ANONIMA"
# shellcheck disable=SC2016  # aspas simples: os padroes sao TEXTO LITERAL do alvo
sabotar "o ramo da anonima some da classificacao" \
        'elif [ -z "$servido" ] && [ "$n_anonimas" -gt 0 ]; then' \
        'elif false; then' \
        sonda_anonima "1|nenhuma sonda em"
# DERIVA entre as duas pontas: o SQL para de emitir a linha que o classificador le. Degradar
# para zero devolveria justamente a mensagem MENTIROSA de antes, entao o fail-closed e exit 2 —
# e a marca e a do ramo da DERIVA, nao a de "a consulta falhou" (que e o que um SQL quebrado da).
sabotar "o SQL para de emitir a linha #anonimas que o classificador le" \
        "       UNION ALL
       SELECT '#anonimas ' || n FROM anonimas;" \
        "       ;" \
        no_ar "2|nao devolveu a linha"
sabotar "o DISTINCT ON perde a ordem por created (resposta velha absolve)" \
        "ORDER BY edge, created DESC" \
        "ORDER BY edge, created ASC" \
        mais_recente_vence "0|NO_AR"
sabotar "a janela some do SQL (sondagem de ontem vira veredito de hoje)" \
        "AND created > now() - interval '\$JANELA'" \
        "AND true" \
        janela_respeitada "0|NO_AR"
# shellcheck disable=SC2016  # aspas simples: os padroes sao TEXTO LITERAL do alvo
sabotar "presenca vira prova: qualquer fonte servida absolve" \
        '[ "$servido" = "$esperado" ]' \
        '[ -n "$servido" ]' \
        mais_recente_vence "0|NO_AR"
# shellcheck disable=SC2016  # aspas simples: os padroes sao TEXTO LITERAL do alvo
sabotar "--request-ids com slug forasteiro passa calado (typo sem vinculo)" \
        'if ! command grep -Fxq -- "$_slug" "$tmp/alvos"; then' \
        'if false; then' \
        slug_forasteiro "1|nenhuma sonda em"

# CONTROLES NEGATIVOS DO JUIZ — o gate de reintrodução. Cada um é uma sabotagem que o juiz TEM de
# recusar, e o gate exige a RAZÃO do julgamento (não "não aplicou", "sintaxe" ou "controle"): uma
# recusa por outro motivo deixaria o gate verde com o juiz quebrado (achado do Codex, 2026-09-27).
#   marca: o `ORDER BY` com um parêntese a mais só QUEBRA o SQL — exit 2, o MESMO exit do fail-closed
#          da DERIVA do `#anonimas`; declarando a deriva, só a MARCA separa os dois exit 2.
#   shell: `${X?nenhuma sonda em}` no ramo da anônima mata o script com o exit 1 previsto e a marca só
#          no diagnóstico do bash — só a camada do erro de shell a separa.
# A via é conferida ANTES, com a mensagem nomeada: a saída do juiz abaixo vai para um arquivo (a
# recusa esperada não polui o log), e uma via que morresse lá dentro sairia exit 2 muda.
via_viva || via_caida "(antes do controle negativo)" "controle negativo do juiz"
juiz_negativo() { # razão-exigida  args do sabotar…
  local razao="$1" cegas_ok=$cegas julgadas_ok=$julgadas; shift
  ULTIMO_MOTIVO=""
  sabotar "$@" > "$TMP/juiz.out" 2>&1
  cegas=$cegas_ok; julgadas=$julgadas_ok
  case "$ULTIMO_MOTIVO" in
    CREDITADO) echo "  [XX ] controle negativo do juiz [$razao]: CREDITADO — o juiz perdeu a identidade"; juiz_ok=0 ;;
    *"$razao"*) echo "  [ok ] controle negativo do juiz: recusado pelo julgamento [$razao]" ;;
    *) echo "  [XX ] controle negativo do juiz [$razao]: recusado por OUTRO motivo [${ULTIMO_MOTIVO:-nenhum}] — o gate não exercitou o juiz"
       sed 's/^/        | /' "$TMP/juiz.out" | head -3; juiz_ok=0 ;;
  esac
}
juiz_negativo "MARCA exit=2" "juiz-negativo-marca: o ORDER BY ganha um parentese a mais (so quebra o SQL)" \
        "ORDER BY edge, created DESC" "ORDER BY edge, created DESC)" no_ar "2|nao devolveu a linha"
# shellcheck disable=SC2016  # aspas simples: os padroes sao TEXTO LITERAL do alvo
juiz_negativo "ERRO-DE-SHELL" "juiz-negativo-shell: o ramo da anonima morre com a marca no diagnostico" \
        'elif [ -z "$servido" ] && [ "$n_anonimas" -gt 0 ]; then' \
        'elif : "${FALHA_NAO_DEFINIDA_JUIZ_NEGATIVO?nenhuma sonda em}"; then' \
        sonda_anonima "1|nenhuma sonda em"

echo "--falsify: $cegas cegueira(s) em $((cegas + julgadas)) sabotagem(ns) (esperado: 0 em 11)"
[ "$cegas" -eq 0 ] && [ "$julgadas" -ge 11 ] && [ "$juiz_ok" = 1 ] || exit 1
exit 0
