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
    # A linha que EXPLICA: o `heavy` que desiste da fila sai 1 sem rodar o vitest (medido
    # 2026-09-28 — o juiz antigo, "saiu 1", contava isso como o detector caindo).
    local dica
    dica="$(printf '%s\n' "$out" | command grep -m1 -F 'heavy: timeout' || printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -1)"
    printf '        saida: %s\n' "$(printf '%s' "$dica" | cut -c1-160)"
    falhas=$((falhas+1))
  fi
}

# nao_aplicou <rótulo> — a sabotagem NÃO entrou: é falha da PROVA, com nome próprio, e o `espera`
# não roda. Rodá-lo sobre o código íntegro dava "FALHA … exit=0 (esperado 1)", que se lê como furo
# no GATE — foi assim que o F4 ficou 22 dias morto sem ninguém ver (a Parte F, #2334, duplicou o
# trecho-âncora) e o F1 virou vácuo com a 20260927172443
# (docs/historico/provas-db-mortas-fora-do-nucleo.md).
nao_aplicou() {
  printf '  [%s] FALHA %-40s a SABOTAGEM NAO APLICOU (a premissa da prova mudou; ver a mensagem acima)\n' "$LOC" "$1"
  falhas=$((falhas+1))
}

echo "== falsificação da Parte E (EXECUTE de função) — locale $LOC =="

# C0 — canário: sem sabotagem, verde. Sem ele, um harness quebrado "passa" mostrando vermelho.
espera "C0 canario authz:check" 0 "" bun run authz:check

# F1 — o REVOKE some da migration-âncora que faz DROP+CREATE. É o vetor EXATO que a Parte E
#      existe para pegar, na forma que ele de fato tem neste repo (recriação DENTRO da âncora),
#      e o teste que separa "o gate existe" de "o gate segura o caso real".
#      Some também de cada migration POSTERIOR que re-fecha a função: desde a 20260927172443 (hoje
#      SP: CREATE OR REPLACE + REVOKE FROM PUBLIC, anon), tirar só o da âncora deixa o estado FINAL
#      fechado — o gate fica verde com razão, e a sabotagem vira vácuo. Os re-fechos são DECLARADOS;
#      um novo reprova com nome próprio ("PREMISSA DO F1 MUDOU") em vez de passar por furo no gate.
if python3 - <<'PY'
import glob, os, re, sys
fn = 'get_ultimos_precos_cliente'
ancora = '20260704120000_preco_por_tier.sql'
refechos = ['20260927172443_hoje_sp_sessao_utc_precos_piso.sql']
pat = re.compile(r'REVOKE\s+(?:EXECUTE|ALL)[^;]*' + fn + r'[^;]*;')
depois = sorted(os.path.basename(m) for m in glob.glob('supabase/migrations/*.sql')
                if os.path.basename(m) > ancora and pat.search(open(m).read()))
if depois != refechos:
    sys.exit('PREMISSA DO F1 MUDOU: re-fechos de %s depois da ancora = %s; declarados = %s' % (fn, depois, refechos))
for a in [ancora] + refechos:
    p = 'supabase/migrations/' + a
    novo, n = pat.subn('-- revoke removido (sabotagem)', open(p).read())
    if n != 1:
        sys.exit('sabotagem F1 casou %d REVOKE(s) em %s (esperado 1)' % (n, a))
    open(p, 'w').write(novo)
PY
then
  espera "F1 REVOKE removido da ancora"      1 "FUNCAO_RECRIADA_SEM_FECHO" bun run authz:check
  espera "F1 nomeia o ARQUIVO certo"         1 "20260704120000_preco_por_tier.sql" bun run authz:check
  espera "F1 nomeia a FUNCAO certa"          1 "public.get_ultimos_precos_cliente" bun run authz:check
else
  nao_aplicou "F1"
fi
restaurar

# F2 — migration NOVA que reabre uma função fechada por privilégio para `anon`.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
GRANT EXECUTE ON FUNCTION public.tint_calc_preco_final(text, text, text, text, uuid, numeric) TO anon;
SQL
espera "F2 GRANT a anon -> erro"           1 "FUNCAO_REABERTURA" bun run authz:check
espera "F2 nomeia o arquivo novo"          1 "29991231000001_sabotagem_funcao.sql" bun run authz:check
restaurar

# F3 — migration NOVA com DROP+CREATE e sem REVOKE: a função renasce com o default privilege.
#      Alvo é uma função do ACKNOWLEDGED_SENSITIVE, e não do AUTHZ_MANIFEST, DE PROPÓSITO: a
#      Parte A julga a última definição de toda função do manifest, então recriar uma delas com
#      corpo de fixture ficaria vermelha pelo GATE AUSENTE — e a contraprova F3b, que precisa do
#      verde, nunca conseguiria ficar verde. A falha ensinou o isolamento: para provar a Parte E,
#      a sabotagem tem de ser invisível para A/B/C/D.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
DROP FUNCTION IF EXISTS public.tint_calc_preco_final(text, text, text, text, uuid, numeric);
CREATE FUNCTION public.tint_calc_preco_final(a text, b text, c text, d text, e uuid, f numeric)
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
SQL
espera "F3 DROP+CREATE sem REVOKE -> erro"  1 "FUNCAO_RECRIADA_SEM_FECHO" bun run authz:check
espera "F3 nomeia a FUNCAO certa"          1 "public.tint_calc_preco_final" bun run authz:check
restaurar

# F3b — a CONTRAPROVA de F3: a MESMA migration com o REVOKE de volta tem de ficar VERDE. Sem ela,
#       F3 passaria mesmo que o detector acusasse toda migration que menciona a função — e o gate
#       viraria ruído que alguém desligaria no primeiro PR legítimo. Revoga das DUAS roles porque
#       esta função fecha por privilégio; revogar só de anon deixaria authenticated aberta.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
DROP FUNCTION IF EXISTS public.tint_calc_preco_final(text, text, text, text, uuid, numeric);
CREATE FUNCTION public.tint_calc_preco_final(a text, b text, c text, d text, e uuid, f numeric)
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.tint_calc_preco_final(text, text, text, text, uuid, numeric) FROM PUBLIC, anon, authenticated;
SQL
espera "F3b DROP+CREATE COM revoke -> verde" 0 "" bun run authz:check
restaurar

# F3c — e o REVOKE PARCIAL (só anon) NÃO basta para função que fecha por privilégio: é o
#       discriminante que separa esta parte de um detector que só procura a palavra REVOKE.
cat > supabase/migrations/29991231000001_sabotagem_funcao.sql <<'SQL'
DROP FUNCTION IF EXISTS public.tint_calc_preco_final(text, text, text, text, uuid, numeric);
CREATE FUNCTION public.tint_calc_preco_final(a text, b text, c text, d text, e uuid, f numeric)
RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.tint_calc_preco_final(text, text, text, text, uuid, numeric) FROM PUBLIC, anon;
SQL
espera "F3c REVOKE parcial -> ainda erro"   1 "FUNCAO_RECRIADA_SEM_FECHO" bun run authz:check
restaurar

# F4 — detector desligado: a allowlist vira decoração e os testes anti-inércia têm de cair.
#      Sem este, um detector quebrado deixaria TUDO verde e o silêncio pareceria cobertura.
#      A âncora é a ASSINATURA de `auditGrantsFuncoes`: o par `const out`/`const ordered` sozinho
#      passou a ocorrer 2× com a Parte F (`auditRevokeSemPublic`, #2334), e o `count == 1` reprovava
#      dizendo "não encontrou".
if python3 - <<'PY'
import sys
p = 'scripts/lib/authz-funcoes.ts'; s = open(p).read()
alvo = "  existingFiles?: Set<string>,\n): FuncaoFinding[] {\n  const out: FuncaoFinding[] = [];\n"
n = s.count(alvo)
if n != 1:
    sys.exit('sabotagem F4: o ponto de entrada casou %d vez(es) (esperado 1)' % n)
open(p, 'w').write(s.replace(alvo, alvo + "  if (migrations) return out; // SABOTAGEM\n", 1))
PY
then
  # A marca é o caminho `arquivo > describe` que o vitest só imprime na linha FAIL (as que passam
  # saem como `✓ describe > teste`, sem o arquivo): "vitest saiu 1" aceitaria qualquer quebra —
  # import que falha, outro describe — e não provaria que o DETECTOR desligado é o que caiu.
  espera "F4 detector desligado -> testes"   1 "authz-funcoes.test.ts > auditGrantsFuncoes" heavy bunx vitest run scripts/authz-funcoes.test.ts
else
  nao_aplicou "F4"
fi
restaurar

# F5 — a allowlist afrouxada em silêncio: `permitido.anon = true` numa entrada. O contrato diz que
#      NENHUMA função classificada é alcançável por anon (medido em prod), então mudar isso é
#      decisão de política e tem de passar por um teste vermelho, não por um diff discreto.
if python3 - <<'PY'
import sys
p = 'scripts/authz-funcoes-fechadas.ts'; s = open(p).read()
alvo = "const PORTA_FECHADA = { anon: false, authenticated: false } as const;"
n = s.count(alvo)
if n != 1:
    sys.exit('sabotagem F5: o ponto de entrada casou %d vez(es) (esperado 1)' % n)
open(p, 'w').write(s.replace(alvo, "const PORTA_FECHADA = { anon: true, authenticated: false } as const;", 1))
PY
then
  espera "F5 allowlist permite anon -> testes" 1 "authz-funcoes.test.ts > AUTHZ_FUNCOES_FECHADAS" heavy bunx vitest run scripts/authz-funcoes.test.ts
else
  nao_aplicou "F5"
fi
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
