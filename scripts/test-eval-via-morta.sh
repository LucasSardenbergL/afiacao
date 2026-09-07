#!/usr/bin/env bash
# test-eval-via-morta.sh — guarda o julgamento "sabotagem PEGADA" do `--falsify` dos evals que
# EXECUTAM SQL (hoje `sonda-veredito-401-eval.sh`).
#
# O DEFEITO QUE ESTE TESTE MATA (medido em 2026-09-07, com a via morta logo após o controle):
# o laço creditava a sabotagem sempre que a suíte ficasse VERMELHA — e vermelho tem duas origens
# que não se parecem em nada:
#   • o banco respondeu OUTRA coisa  ⇒ DADO: a asserção divergiu, a sabotagem foi pega;
#   • o banco não respondeu NADA     ⇒ AUSÊNCIA de dado: não se provou coisa alguma.
# Com o Postgres efêmero morto no meio do laço, TODA sabotagem seguinte herda um vermelho que já
# existia e sai `[ok] pegada`. Medido: `--falsify` imprimiu 11/11 pegadas e `0 cegueira(s)`,
# exit 0 — o gate mais rigoroso do repo aprovando sem ter olhado. É a mesma família do flake que
# o #2308 fechou (`ausente ≠ zero`), aqui na dimensão VIA DE PROVA em vez de SHELL.
#
# A correção que este teste guarda: `via_viva()` — sonda POSITIVA fim-a-fim (Postgres + bun + o
# caminho do SQL) com o gerador JÁ RESTAURADO. Vermelho + cenário sem veredito + via morta ⇒
# exit 2 nomeando a causa, em vez de `[ok] pegada`.
#
# Por que roda o eval de VERDADE num sandbox, e não um mock: o ponto em teste é justamente o que
# acontece quando a infraestrutura do eval morre. Mock de infraestrutura não tem como morrer.
#
# Exit 0 = o eval recusa aprovar com a via morta. 1 = voltou a aprovar (fail-OPEN).
# 2 = via de prova não observável (fail-CLOSED: sem bun/python3/Postgres o teste NÃO passa calado).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

EVAL_REL=".claude/skills/lovable-deploy-verify/evals/sonda-veredito-401-eval.sh"
[ -f "$EVAL_REL" ] || { echo "❌ VIA_NAO_OBSERVAVEL: não achei $EVAL_REL"; exit 2; }
for c in python3 bun; do
  command -v "$c" >/dev/null 2>&1 || { echo "❌ VIA_NAO_OBSERVAVEL: $c ausente."; exit 2; }
done

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# Sandbox: o eval resolve a raiz do repo como `dirname($0)/../../../..`. Recriar essa profundidade
# no tmp mantém a árvore VERSIONADA intocada — nenhuma cópia é criada dentro do repo.
SB="$TMP/root"
EVALDIR="$SB/.claude/skills/lovable-deploy-verify/evals"
mkdir -p "$SB/scripts" "$EVALDIR" || exit 2
cp scripts/sonda-versao-sql.ts scripts/sonda-fingerprint.ts "$SB/scripts/" || exit 2

# prepara <destino> <mutacoes...> — copia o eval aplicando mutações de texto (de→para em pares).
prepara() {
  local destino="$1"; shift
  cp "$EVAL_REL" "$destino" || return 1
  [ "$#" -eq 0 ] && return 0
  python3 - "$destino" "$@" <<'PY'
import sys
alvo, pares = sys.argv[1], sys.argv[2:]
s = open(alvo, encoding='utf-8').read()
for de, para in zip(pares[0::2], pares[1::2]):
    if de not in s:
        sys.stderr.write(f"ALVO_AUSENTE: {de[:60]}\n"); sys.exit(3)
    s = s.replace(de, para, 1)
open(alvo, 'w', encoding='utf-8').write(s)
PY
}

# A via morre LOGO DEPOIS do controle verde — o cenário realista, e o pior: o controle já atestou
# que a suíte não era sempre-vermelha, então nada mais desconfia.
MATA_VIA_DE='cegas=0
julgadas=0'
MATA_VIA_PARA='P() { return 1; }   # <<< a via de prova morre aqui, com o controle já verde
cegas=0
julgadas=0'
# Neutraliza SÓ o discriminador — a via segue morta. É a mutação que devolve o comportamento
# anterior à correção, e o que prova que `via_viva` é load-bearing (e não enfeite).
# shellcheck disable=SC2016  # padrão LITERAL a casar no arquivo: expandir seria o erro
TIRA_GUARD_DE='if [ -n "$via_sab" ] && ! via_viva; then'
TIRA_GUARD_PARA='if false; then'

rc=0
ok()   { printf '  ok    %s\n' "$1"; }
ruim() { printf '  FALHA %s\n' "$1"; rc=1; }

roda() { # <script> [--falsify] → ecoa "exit|saida"
  local sc="$1"; shift
  local out; out=$(bash "$sc" "$@" 2>&1); printf '%s|%s' "$?" "$out"
}

echo "== eval com a via de prova MORTA não pode aprovar sabotagem =="

# ── CONTROLE VERDE, na MESMA invocação e ANTES da 1ª mutação ─────────────────────────────────
# Sem ele, um sandbox quebrado (bun ausente, gerador que não compila, Postgres que não sobe)
# deixaria TODOS os casos abaixo "vermelhos como esperado" e o teste aprovaria a si mesmo.
# → docs/historico/falsificacao-sem-linha-de-base.md
prepara "$EVALDIR/eval.sh" || { echo "❌ VIA_NAO_OBSERVAVEL: não consegui preparar o sandbox."; exit 2; }
c0=$(roda "$EVALDIR/eval.sh"); c0_rc="${c0%%|*}"; c0_out="${c0#*|}"
if [ "$c0_rc" -eq 2 ]; then
  echo "❌ VIA_NAO_OBSERVAVEL: o eval não roda neste ambiente (exit 2) — o teste NÃO aprova calado."
  printf '%s\n' "$c0_out" | sed 's/^/     /' | head -5
  exit 2
fi
if [ "$c0_rc" -eq 0 ]; then ok "CONTROLE: o eval íntegro passa no sandbox (a suíte não é sempre-vermelha)"
else ruim "CONTROLE VERMELHO sem mutação nenhuma (exit $c0_rc) — nada abaixo prova coisa alguma"
     printf '%s\n' "$c0_out" | sed 's/^/     /' | head -8
     exit 1
fi

# ── os casos ─────────────────────────────────────────────────────────────────────────────────
# Marcador ASCII, caixa fixa: acento casa por acidente sob normalização Unicode (#1483).
MARCA="VIA_NAO_OBSERVAVEL"

if [ "$FALSIFICAR" = 0 ]; then
  prepara "$EVALDIR/eval.sh" "$MATA_VIA_DE" "$MATA_VIA_PARA" || exit 2

  r=$(roda "$EVALDIR/eval.sh" --falsify); r_rc="${r%%|*}"; r_out="${r#*|}"
  case "$r_rc:$r_out" in
    2:*"$MARCA"*) ok "S1 --falsify com a via morta ⇒ exit 2 nomeando $MARCA" ;;
    *) ruim "S1 --falsify com a via morta devia sair 2 com $MARCA; saiu $r_rc"
       printf '%s\n' "$r_out" | sed 's/^/     /' | head -6 ;;
  esac
  case "$r_out" in
    *"0 cegueira(s)"*) ruim "S2 o eval AINDA declarou '0 cegueira(s)' com a via morta (fail-OPEN)" ;;
    *) ok "S2 não declara '0 cegueira(s)': via morta não vira aprovação" ;;
  esac
  case "$r_out" in
    *"[ok ] pegada"*) ruim "S3 creditou sabotagem como PEGADA sem veredito nenhum" ;;
    *) ok "S3 nenhuma sabotagem foi creditada com a via morta" ;;
  esac

  r=$(roda "$EVALDIR/eval.sh"); r_rc="${r%%|*}"; r_out="${r#*|}"
  case "$r_rc:$r_out" in
    2:*"$MARCA"*) ok "S4 modo normal com a via morta ⇒ exit 2 (via), não 1 (divergência de contrato)" ;;
    *) ruim "S4 modo normal com a via morta devia sair 2 com $MARCA; saiu $r_rc"
       printf '%s\n' "$r_out" | sed 's/^/     /' | head -6 ;;
  esac

  [ "$rc" -eq 0 ] && echo "VERDE — via morta é recusada, não creditada" || echo "❌ o eval voltou a aprovar sem prova"
  exit "$rc"
fi

# ── falsificação: sem o discriminador, os casos acima TÊM de ficar vermelhos ──────────────────
echo "== falsificação: arranca o discriminador e exige que S1/S4 percam o dente =="
prepara "$EVALDIR/eval.sh" "$MATA_VIA_DE" "$MATA_VIA_PARA" "$TIRA_GUARD_DE" "$TIRA_GUARD_PARA" || {
  echo "  FALHA a mutação não achou o alvo — o teste ficaria verde por CEGUEIRA"; exit 1; }

r=$(roda "$EVALDIR/eval.sh" --falsify); r_rc="${r%%|*}"; r_out="${r#*|}"
case "$r_rc:$r_out" in
  2:*"$MARCA"*) ruim "S1 continuou VERDE sem o discriminador — a asserção não é sobre via_viva" ;;
  *) ok "S1 vira vermelho sem o discriminador (exit $r_rc) — via_viva é load-bearing" ;;
esac
case "$r_out" in
  *"0 cegueira(s)"*) ok "S2 sem o guard o eval VOLTA a aprovar 11/11 com a via morta (o defeito de origem)" ;;
  *) ruim "S2 não reproduziu o fail-OPEN original — a mutação não é o avesso da correção" ;;
esac

[ "$rc" -eq 0 ] && echo "VERDE — as asserções dependem mesmo do discriminador" || echo "❌ asserção sem dente"
exit "$rc"
