#!/usr/bin/env bash
# test-hooks-sessionstart.sh — os 2 hooks de SessionStart emitem JSON VÁLIDO
# em qualquer circunstância (hook com stdout inválido é ignorado pelo harness,
# ou pior, polui o boot da sessão — o contrato é: sempre JSON parseável).
#
# Uso: bash scripts/test-hooks-sessionstart.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOKS="$here/../.claude/hooks"
fail=0

echo "── pos-compact-ptbr.sh ──"
out="$(bash "$HOOKS/pos-compact-ptbr.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null 2>&1; then
  echo "  ok    JSON válido com hookEventName=SessionStart"
else
  echo "  FAIL  saída não é o JSON esperado: $out"; fail=1
fi
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "pt-BR"; then
  echo "  ok    contexto reforça pt-BR"
else
  echo "  FAIL  contexto sem o reforço de pt-BR"; fail=1
fi

echo "── vigia-worktree.sh ──"
# num diretório SEM package.json: não dispara install e deve emitir JSON válido ('{}' ou aviso)
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
out="$(cd "$tmp" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "  ok    JSON válido fora de worktree (sem package.json)"
else
  echo "  FAIL  saída inválida fora de worktree: $out"; fail=1
fi
# num diretório COM package.json e SEM node_modules: precisa avisar (e disparar install em bg)
mkdir -p "$tmp/wt"; echo '{}' > "$tmp/wt/package.json"
out="$(cd "$tmp/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' | grep -q "node_modules AUSENTE"; then
  echo "  ok    avisa node_modules ausente (e dispara install em background)"
else
  echo "  FAIL  não avisou node_modules ausente: $out"; fail=1
fi

echo "── vigia-worktree.sh: bloco 4 (semáforo heavy) ──"
# Sandbox git PRÓPRIO deste bloco, dentro do $tmp já trapado acima (nunca toca
# ~/.local/bin real nem /tmp/afiacao-heavy-slots — há ~40 worktrees/sessões
# reais usando). origin/main tem VERSAO-MAIN, a worktree de teste tem
# VERSAO-LOCAL — só com essa divergência dá pra provar o estado "em voo"
# (instalado == worktree local, ≠ origin/main).
HI="$here/heavy-install.sh"
hv="$tmp/heavy4"
git init -q --bare "$hv/upstream"
git init -q "$hv/wt"
git -C "$hv/wt" remote add origin "$hv/upstream"
mkdir -p "$hv/wt/scripts"
cp "$HI" "$hv/wt/scripts/heavy-install.sh"; chmod +x "$hv/wt/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho VERSAO-MAIN\n' > "$hv/wt/scripts/heavy.sh"
git -C "$hv/wt" add -A
git -C "$hv/wt" -c user.email=t@t -c user.name=t commit -qm base
git -C "$hv/wt" push -q origin HEAD:main
git -C "$hv/wt" fetch -q origin
printf '#!/usr/bin/env bash\necho VERSAO-LOCAL\n' > "$hv/wt/scripts/heavy.sh"
export AFIACAO_HEAVY_DEST="$hv/bin/heavy"

# ── sincronizado → silêncio (nenhuma menção a heavy) ──────────────────────────
bash "$hv/wt/scripts/heavy-install.sh" >/dev/null 2>&1
out="$(cd "$hv/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && ! printf '%s' "$ctx" | grep -qi heavy; then
  echo "  ok    sincronizado → silêncio quanto ao heavy"
else
  echo "  FAIL  sincronizado deveria ficar em silêncio: $out"; fail=1
fi

# ── divergente → avisa ────────────────────────────────────────────────────────
printf '#!/usr/bin/env bash\necho OUTRACOISA\n' > "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && printf '%s' "$ctx" | grep -q "DIVERGENTE"; then
  echo "  ok    divergente → avisa"
else
  echo "  FAIL  divergente deveria avisar: $out"; fail=1
fi

# ── ausente → avisa ───────────────────────────────────────────────────────────
rm -f "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && printf '%s' "$ctx" | grep -q "NÃO instalado"; then
  echo "  ok    ausente → avisa"
else
  echo "  FAIL  ausente deveria avisar: $out"; fail=1
fi

# ── não consegui verificar → avisa ISSO, NUNCA "divergente" ───────────────────
# origin/main ilegível (repo git sem o remote/branch main): uma das 4 causas
# do exit 3. Duas condições, cada uma fechando um falso-verde medido:
#   • "FALTA DE DADO" é literal ESCRITO PELO HOOK, só no ramo `*)` (o
#     heavy-install.sh nunca emite essa string) — grep sem -i, caixa fixa.
#     Sabotar o `case` trocando o ramo `1)` por `1|*)` faz rc=3 cair no ramo
#     de "divergente" — mas a mensagem ainda contém "NÃO CONSEGUI VERIFICAR"
#     (essa vem do $st, produzida pelo heavy-install.sh). Com grep -qi
#     "não consegui verificar" (o teste antigo), sob LC_ALL=C o -i não dobra
#     Ã↔ã (bytes multibyte UTF-8 tratados como opacos pelo casefold em C) e a
#     asserção falha — correto — mas sob LC_ALL=pt_BR.UTF-8 o -i dobra e ela
#     passa mesmo com o ramo errado (falso verde medido, dependente de
#     locale). "FALTA DE DADO" é ASCII puro e exclusivo do ramo certo: não
#     ambíguo em nenhum locale, e só aparece se o CÓDIGO tomou o ramo `*)`.
#   • "git fetch origin" só chega em $ctx se o hook capturar STDERR (2>&1) —
#     é a dica que o heavy-install.sh manda por lá quando a fonte é ilegível.
#     Sabotar de volta para 2>/dev/null zera $st, mas a frase-catch-all do
#     hook (com o default "${st:-sem detalhe...}") ainda contém "FALTA DE
#     DADO" sozinha — só a exigência do fragmento exclusivo de stderr pega
#     essa sabotagem.
git init -q "$hv/semmain"
mkdir -p "$hv/semmain/scripts"
cp "$HI" "$hv/semmain/scripts/heavy-install.sh"; chmod +x "$hv/semmain/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho SEMMAIN\n' > "$hv/semmain/scripts/heavy.sh"
printf 'outro\n' > "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/semmain" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 \
   && printf '%s' "$ctx" | grep -q "FALTA DE DADO" \
   && printf '%s' "$ctx" | grep -q "git fetch origin" \
   && ! printf '%s' "$ctx" | grep -q "DIVERGENTE"; then
  echo "  ok    não consegui verificar → avisa isso (nunca 'divergente')"
else
  echo "  FAIL  origin/main ilegível deveria avisar 'não consegui verificar', nunca 'divergente': $out"; fail=1
fi

# ── em voo (--daqui) → silêncio ────────────────────────────────────────────────
bash "$hv/wt/scripts/heavy-install.sh" --daqui >/dev/null 2>&1
out="$(cd "$hv/wt" && bash "$HOOKS/vigia-worktree.sh" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && ! printf '%s' "$ctx" | grep -qi heavy; then
  echo "  ok    em voo (--daqui) → silêncio"
else
  echo "  FAIL  em voo deveria ficar em silêncio: $out"; fail=1
fi

unset AFIACAO_HEAVY_DEST

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
