#!/usr/bin/env bash
# test-authz-reescrita-falsificacao.sh — o DENTE da Parte D do `authz:check`.
# =============================================================================================
# Sabota o contrato e exige VERMELHO pelo MOTIVO CERTO, ponta a ponta (exit code do comando de
# CI, não de uma função exportada). Os testes vitest cobrem o núcleo; este harness cobre o que
# eles não alcançam: que `bun run authz:check` de fato SAI 1 e que a mensagem nomeia o arquivo.
#
# Por que existe: a crítica do §1 de docs/historico/sentinela-authz-controle-nao-mencao.md ao
# bloco `DO $pos$` foi que ele "executou uma vez" e não protege nenhuma migration futura. Uma
# falsificação rodada só na sessão que a escreveu tem o mesmo defeito.
#
# ⚠️ DUAS regras aprendidas na carne, ambas nesta ordem por um motivo:
#  1. `restaurar()` usa `git checkout --`. Com trabalho NÃO COMMITADO em scripts/, isso APAGA o
#     trabalho — aconteceu na 1ª execução desta falsificação. Por isso o guard aborta antes.
#  2. A asserção casa CÓDIGO ASCII em caixa fixa via `command grep -qF`: sem `-i`, sem regex, e
#     `command` para não pegar o shim `ugrep` (que dobra acento em TODO locale). Sob
#     `pt_BR.UTF-8`, `grep -qi` casaria `Ã`↔`ã` e a asserção passaria a valer o ramo errado
#     (#1483). Rode nos DOIS locales: LOCALE_ALVO=C e LOCALE_ALVO=pt_BR.UTF-8.
#
# Uso:  bash db/test-authz-reescrita-falsificacao.sh              # locale C (default)
#       LOCALE_ALVO=pt_BR.UTF-8 bash db/test-authz-reescrita-falsificacao.sh
# Exit: 0 = toda sabotagem ficou vermelha pelo motivo certo · N = N asserções falharam · 2 = setup
set -uo pipefail
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$W" || exit 2
LOC="${LOCALE_ALVO:-C}"
export LC_ALL="$LOC" LANG="$LOC"
falhas=0

if [ -n "$(git status --porcelain -- scripts/ db/)" ]; then
  echo "ABORTADO: ha trabalho nao commitado em scripts/ ou db/ — commite antes (restaurar() usa git checkout)."
  exit 2
fi

restaurar() {
  git checkout -- scripts/ supabase/migrations/ 2>/dev/null
  rm -f supabase/migrations/29991231000000_sabotagem.sql
}
trap restaurar EXIT

# espera <rótulo> <exit esperado> <código ASCII esperado, ou vazio> <comando...>
espera() {
  local rot="$1" exp="$2" cod="$3"; shift 3
  local out rc ok_cod=0
  out=$("$@" 2>&1); rc=$?
  if [ -z "$cod" ]; then ok_cod=1
  elif printf '%s' "$out" | command grep -qF "$cod"; then ok_cod=1
  fi
  if [ "$rc" = "$exp" ] && [ "$ok_cod" = 1 ]; then
    printf '  [%s] OK    %-34s exit=%s %s\n' "$LOC" "$rot" "$rc" "${cod:-—}"
  else
    printf '  [%s] FALHA %-34s exit=%s (esperado %s) codigo=%s\n' "$LOC" "$rot" "$rc" "$exp" "$ok_cod"
    falhas=$((falhas+1))
  fi
}

echo "== falsificação da Parte D — locale $LOC =="

# C0 — canário: sem sabotagem, verde. Sem ele, um harness quebrado "passa" mostrando vermelho.
espera "C0 canario authz:check" 0 "" bun run authz:check

# F1 — entrada removida da baseline: a reescrita volta a ser ERRO, nomeando arquivo e função.
#      É o teste que separa "a baseline existe" de "a baseline é o que segura o erro".
python3 - <<'PY'
p='scripts/authz-reescritas-conhecidas.ts'; s=open(p).read()
i=s.index("    arquivo: '20260814022626"); j=s.index('  },', i)+5
open(p,'w').write(s[:i-2]+s[j:])
PY
espera "F1 baseline sem a 20260814022626" 1 "REESCRITA_VIVA_NAO_MEDIDA" bun run authz:check
espera "F1 nomeia o ARQUIVO certo"        1 "20260814022626_reposicao_po_inexistente_antes_de.sql" bun run authz:check
espera "F1 nomeia a FUNCAO certa"         1 "public.reposicao_pos_candidatos" bun run authz:check
restaurar

# F2 — detector desligado: a baseline vira decoração e o teste anti-decoração tem de cair.
#      Sem este, um detector quebrado deixaria TUDO verde e o silêncio pareceria cobertura.
python3 - <<'PY'
p='scripts/lib/authz-reescrita.ts'; s=open(p).read()
alvo="  const vazio: ReescritaViva = { detectada: false, alvos: [], indeterminado: false };"
open(p,'w').write(s.replace(alvo, alvo+"\n  if (sqlRaw) return vazio; // SABOTAGEM", 1))
PY
espera "F2 detector desligado -> testes"   1 "" bunx vitest run scripts/authz-gate-check.test.ts
restaurar

# F3 — migration NOVA reescrevendo função do manifest: o caso que o gate existe para pegar.
cat > supabase/migrations/29991231000000_sabotagem.sql <<'SQL'
DO $r$
DECLARE v_def text := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
BEGIN
  EXECUTE replace(v_def, 'private.cap_compras_ler', 'true OR private.cap_compras_ler');
END $r$;
SQL
espera "F3 migration nova -> erro"         1 "REESCRITA_VIVA_NAO_MEDIDA" bun run authz:check
espera "F3 nomeia o arquivo novo"          1 "29991231000000_sabotagem.sql" bun run authz:check
restaurar

# F4 — só com psql-ro: md5 sabotado tem de acender no audit de prod, e NÃO no CI (que não vê prod).
if [ -x "${PSQL_RO:-$HOME/.config/afiacao/psql-ro}" ]; then
  espera "C0 canario audit:prod"           0 "" bun run authz:audit:prod
  python3 - <<'PY'
p='scripts/authz-reescritas-conhecidas.ts'; s=open(p).read()
open(p,'w').write(s.replace("632964445c40e792ca62d945aeb2e85e","00000000000000000000000000000000"))
PY
  espera "F4 md5 sabotado -> audit:prod"   1 "MD5_DIVERGIU" bun run authz:audit:prod
  espera "F4 authz:check NAO ve o md5"     0 "" bun run authz:check
  restaurar
else
  echo "  [$LOC] PULADO F4 (md5/prod): psql-ro ausente — audit de prod não roda no CI, e isso é o desenho."
fi

# C1 — canário final: restaurado, verde de novo. Prova que as sabotagens saíram.
espera "C1 canario final" 0 "" bun run authz:check

echo "== locale $LOC: $falhas falha(s) =="
exit $falhas
