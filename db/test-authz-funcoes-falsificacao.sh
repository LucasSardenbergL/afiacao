#!/usr/bin/env bash
# test-authz-funcoes-falsificacao.sh — o DENTE da Parte E do `authz:check` (EXECUTE de função).
# =============================================================================================
# Sabota o contrato e exige VERMELHO pelo MOTIVO CERTO, ponta a ponta (exit code do comando de
# CI, não de uma função exportada). Os testes vitest cobrem o núcleo; este harness cobre o que
# eles não alcançam: que `bun run authz:check` de fato SAI 1 e que a mensagem nomeia o arquivo.
#
# Irmão de db/test-authz-reescrita-falsificacao.sh, e herda as duas regras aprendidas na carne:
#  1. `restaurar()` usa `git checkout --`. Com trabalho NÃO COMMITADO em scripts/, isso APAGA o
#     trabalho. Por isso o guard aborta antes.
#  2. A asserção casa CÓDIGO ASCII em caixa fixa via `command grep -qF`: sem `-i`, sem regex, e
#     `command` para não pegar o shim `ugrep` (que dobra acento em TODO locale). Sob
#     `pt_BR.UTF-8`, `grep -qi` casaria `Ã`↔`ã` e a asserção passaria a valer o ramo errado
#     (#1483). Rode nos DOIS locales: LOCALE_ALVO=C e LOCALE_ALVO=pt_BR.UTF-8.
#
# ⚠️ Os códigos da Parte E CONTÊM os da Parte C como substring (`FUNCAO_REABERTURA` ⊃
#    `REABERTURA`). Aqui isso não confunde porque toda asserção casa o código COM o prefixo — o
#    que NÃO vale ao contrário: quem procurar `REABERTURA` casaria os dois.
#
# Uso:  bash db/test-authz-funcoes-falsificacao.sh              # locale C (default)
#       LOCALE_ALVO=pt_BR.UTF-8 bash db/test-authz-funcoes-falsificacao.sh
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
  rm -f supabase/migrations/29991231000001_sabotagem_funcao.sql
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
    printf '  [%s] OK    %-40s exit=%s %s\n' "$LOC" "$rot" "$rc" "${cod:-—}"
  else
    printf '  [%s] FALHA %-40s exit=%s (esperado %s) codigo=%s\n' "$LOC" "$rot" "$rc" "$exp" "$ok_cod"
    falhas=$((falhas+1))
  fi
}

echo "== falsificação da Parte E (EXECUTE de função) — locale $LOC =="

# C0 — canário: sem sabotagem, verde. Sem ele, um harness quebrado "passa" mostrando vermelho.
espera "C0 canario authz:check" 0 "" bun run authz:check

# F1 — o REVOKE some da migration-âncora que faz DROP+CREATE. É o vetor EXATO que a Parte E
#      existe para pegar, na forma que ele de fato tem neste repo (recriação DENTRO da âncora),
#      e o teste que separa "o gate existe" de "o gate segura o caso real".
python3 - <<'PY'
import re
p='supabase/migrations/20260704120000_preco_por_tier.sql'; s=open(p).read()
novo=re.sub(r'REVOKE\s+(?:EXECUTE|ALL)[^;]*get_ultimos_precos_cliente[^;]*;', '-- revoke removido (sabotagem)', s)
assert novo != s, 'sabotagem F1 nao casou nada — o harness ficaria verde por vacuidade'
open(p,'w').write(novo)
PY
espera "F1 REVOKE removido da ancora"      1 "FUNCAO_RECRIADA_SEM_FECHO" bun run authz:check
espera "F1 nomeia o ARQUIVO certo"         1 "20260704120000_preco_por_tier.sql" bun run authz:check
espera "F1 nomeia a FUNCAO certa"          1 "public.get_ultimos_precos_cliente" bun run authz:check
restaurar

# F2 — migration NOVA que reabre uma função fechada por privilégio para `anon`.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
GRANT EXECUTE ON FUNCTION public.tint_calc_preco_final(text, text, text, text, uuid, numeric) TO anon;
SQL
espera "F2 GRANT a anon -> erro"           1 "FUNCAO_REABERTURA" bun run authz:check
espera "F2 nomeia o arquivo novo"          1 "29991231000001_sabotagem_funcao.sql" bun run authz:check
restaurar

# F3 — migration NOVA com DROP+CREATE e sem REVOKE: a função renasce com o default privilege.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
DROP FUNCTION IF EXISTS public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]);
CREATE FUNCTION public.get_regua_preco(p_a uuid, p_b uuid, p_c numeric, p_d numeric, p_e numeric[])
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
SQL
espera "F3 DROP+CREATE sem REVOKE -> erro"  1 "FUNCAO_RECRIADA_SEM_FECHO" bun run authz:check
restaurar

# F3b — a CONTRAPROVA de F3: a MESMA migration com o REVOKE de volta tem de ficar VERDE. Sem ela,
#       F3 passaria mesmo que o detector acusasse toda migration que menciona a função — e o gate
#       viraria ruído que alguém desligaria no primeiro PR legítimo.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
DROP FUNCTION IF EXISTS public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]);
CREATE FUNCTION public.get_regua_preco(p_a uuid, p_b uuid, p_c numeric, p_d numeric, p_e numeric[])
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) TO authenticated;
SQL
espera "F3b DROP+CREATE COM revoke -> verde" 0 "" bun run authz:check
restaurar

# F4 — detector desligado: a allowlist vira decoração e os testes anti-inércia têm de cair.
#      Sem este, um detector quebrado deixaria TUDO verde e o silêncio pareceria cobertura.
python3 - <<'PY'
p='scripts/lib/authz-funcoes.ts'; s=open(p).read()
alvo="  const out: FuncaoFinding[] = [];\n  const ordered = [...migrations]"
assert s.count(alvo)==1, 'sabotagem F4 nao encontrou o ponto de entrada'
open(p,'w').write(s.replace(alvo, "  const out: FuncaoFinding[] = [];\n  if (migrations) return out; // SABOTAGEM\n  const ordered = [...migrations]", 1))
PY
espera "F4 detector desligado -> testes"   1 "" heavy bunx vitest run scripts/authz-funcoes.test.ts
restaurar

# F5 — a allowlist afrouxada em silêncio: `permitido.anon = true` numa entrada. O contrato diz que
#      NENHUMA função classificada é alcançável por anon (medido em prod), então mudar isso é
#      decisão de política e tem de passar por um teste vermelho, não por um diff discreto.
python3 - <<'PY'
p='scripts/authz-funcoes-fechadas.ts'; s=open(p).read()
alvo="const PORTA_FECHADA = { anon: false, authenticated: false } as const;"
assert s.count(alvo)==1
open(p,'w').write(s.replace(alvo, "const PORTA_FECHADA = { anon: true, authenticated: false } as const;", 1))
PY
espera "F5 allowlist permite anon -> testes" 1 "" heavy bunx vitest run scripts/authz-funcoes.test.ts
restaurar

# F6 — só com psql-ro: o audit de PROD tem de acusar quando o contrato proíbe o que prod TEM.
#      Prova que ele mede o BANCO, e não repete a allowlist para si mesmo.
if [ -x "${PSQL_RO:-$HOME/.config/afiacao/psql-ro}" ]; then
  espera "C0 canario authz:funcoes:prod"   0 "" bun run authz:funcoes:prod
  # get_preco_cockpit TEM authenticated em prod (medido); declará-la fechada deve acender.
  AUTHZ_FUNCOES_TEST_JSON='{"public.get_preco_cockpit":{"fechadaPor":"20260615150000_cockpit_preco_fixes.sql","permitido":{"anon":false,"authenticated":false},"motivo":"sabotagem: declara fechada o que prod tem aberto"}}' \
    espera "F6 contrato mente -> audit acusa" 1 "FUNCAO_DRIFT_PROD" bun run authz:funcoes:prod
  espera "F6 authz:check NAO ve prod"       0 "" bun run authz:check
else
  echo "  [$LOC] PULADO F6 (prod): psql-ro ausente — audit de prod não roda no CI, e isso é o desenho."
fi

# C1 — canário final: restaurado, verde de novo. Prova que as sabotagens saíram.
espera "C1 canario final" 0 "" bun run authz:check

echo "== locale $LOC: $falhas falha(s) =="
exit $falhas
