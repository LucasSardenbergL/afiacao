#!/usr/bin/env bash
# test-audit-deriva-corpo-prod.sh — prova EXECUTADA do sensor `deriva:corpo:prod` num PG17 descartável.
# =====================================================================================================
#
# O sensor (`db/audit-deriva-corpo-prod.ts`) afirma, contra prod, que TODA função `public` definida em
# `supabase/migrations/` roda o corpo que o repo diz. Este harness o roda contra um banco de verdade,
# por um `psql-ro` FALSO que reproduz o real (sessão READ ONLY + os dois `SET` do psqlrc, que o `-q`
# do runner tem de calar), e exige:
#
#   A. CONTROLE verde no estado certo — se falhar, aborta: sabotagem sem controle na MESMA invocação
#      é teatro (sempre-vermelho aprovaria tudo; `docs/historico/falsificacao-sem-linha-de-base.md`).
#   B…M. cada SABOTAGEM com o CÓDIGO certo (ASCII, caixa fixa, `grep -F` sem `-i`) E o DENTE: desfeita
#      a sabotagem, o verde volta. Um cenário que "passa" sem o dente pode estar sempre vermelho.
#   D. mudança SÓ cosmética fica VERDE — o falso-positivo que desligaria o sensor na 1ª semana.
#   K. medição quebrada (saída truncada, psql caído, saída vazia, hex corrompido) sai 2, nunca 0 nem 1.
#
# Rode nos DOIS locales (a lição do #1483 — falsificar num só não prova a asserção):
#   LC_ALL=C bash db/test-audit-deriva-corpo-prod.sh
#   LC_ALL=pt_BR.UTF-8 bash db/test-audit-deriva-corpo-prod.sh
# O CI não roda `db/test-*.sh` (não tem PG17 nem bun no job de provas SQL): a evidência vai no PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

export LC_ALL="${LC_ALL:-C}"
export LANG="$LC_ALL"
PORT="${PGPORT_TEST:-5483}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/deriva-corpo.XXXXXX")"
DATA="$TMPD/data"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD" -w start >/dev/null
"$PGBIN/createdb" -h "$TMPD" -p "$PORT" -U postgres prove
P() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$TMPD" -p "$PORT" -U postgres -d prove "$@"; }

# ── o psql-ro FALSO: mesma forma do real (psqlrc com SET READ ONLY + statement_timeout) ─────────────
cat >"$TMPD/psqlrc" <<'EOF'
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SET statement_timeout = '30s';
\set QUIET on
EOF
WRAP="$TMPD/psql-ro-fake"
cat >"$WRAP" <<EOF
#!/usr/bin/env bash
exec env PSQLRC="$TMPD/psqlrc" "$PGBIN/psql" -h "$TMPD" -p "$PORT" -U postgres -d prove "\$@"
EOF
chmod +x "$WRAP"

# ── as migrations da fixture (o "repo") ────────────────────────────────────────────────────────────
MIG="$TMPD/mig"
mkdir -p "$MIG"
cat >"$MIG/20260101000000_base.sql" <<'EOF'
CREATE OR REPLACE FUNCTION public.f(p_x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE OR REPLACE FUNCTION public.g() RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  -- comentário de repo
  RETURN 'ação';
END;
$$;
CREATE OR REPLACE FUNCTION public.h() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;
CREATE OR REPLACE FUNCTION public.k(p int) RETURNS text LANGUAGE sql AS $$ SELECT 'k-int' $$;
CREATE OR REPLACE FUNCTION public.k(p text) RETURNS text LANGUAGE sql AS $$ SELECT 'k-text' $$;
CREATE OR REPLACE FUNCTION public.d() RETURNS int LANGUAGE sql AS $$ SELECT 4 $$;
CREATE OR REPLACE FUNCTION public.p() RETURNS text LANGUAGE sql AS $$ SELECT 'antes' $$;
CREATE OR REPLACE FUNCTION public._sub() RETURNS int LANGUAGE sql AS $$ SELECT 5 $$;
EOF
cat >"$MIG/20260102000000_v2.sql" <<'EOF'
CREATE OR REPLACE FUNCTION public.f(p_x integer) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;
DROP FUNCTION IF EXISTS public.d();
EOF
cat >"$MIG/20260103000000_patch.sql" <<'EOF'
DO $mig$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.p()'::regprocedure);
  EXECUTE replace(v_def, '''antes''', '''depois''');
END $mig$;
EOF
for m in "$MIG"/*.sql; do P -f "$m"; done

# O JSON de entrada do sensor: as migrations + a baseline (o patch de `p` conciliado como ALTERA, com o
# corpo que o BANCO tem agora). `extra` acrescenta migrations sem aplicá-las (a que chegou e não pegou).
montar_json() { # montar_json <saida.json> <declara_q: sim|nao> [migration extra...]
  local saida="$1" declara_q="$2"
  shift 2
  P -tA -c "SELECT encode(convert_to(prosrc, 'UTF8'), 'hex') || '|' || md5(prosrc) FROM pg_proc WHERE proname = 'p'" >"$TMPD/p.hex"
  REPO_ROOT="$REPO_ROOT" bun -e '
    const fs = require("node:fs");
    const { md5DeTokens } = await import(process.env.REPO_ROOT + "/scripts/lib/deriva-corpo.ts");
    const { md5Exato } = await import(process.env.REPO_ROOT + "/scripts/lib/migration-objects.ts");
    const [saida, declaraQ, pHex, ...arqs] = process.argv.slice(1);
    const [hex, md5Banco] = fs.readFileSync(pHex, "utf8").trim().split("|");
    const texto = Buffer.from(hex, "hex").toString("utf8");
    if (md5Exato(texto) !== md5Banco) { console.error("fixture: o texto de p() nao reproduz o md5 do banco"); process.exit(3); }
    const entradas = [{ funcao: "p", identidade: "", classe: "PATCH", patch: "20260103000000_patch.sql", efeito: "ALTERA",
      md5: md5Banco, md5Tokens: md5DeTokens(texto), motivo: "fixture", desde: "2026-09-26" }];
    if (declaraQ === "sim") entradas.push({ funcao: "q", identidade: "", classe: "NAO_MENSURAVEL", motivo: "fixture", desde: "2026-09-26" });
    const migrations = arqs.map((a) => ({ nome: a.split("/").pop(), sql: fs.readFileSync(a, "utf8") }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "en"));
    fs.writeFileSync(saida, JSON.stringify({ migrations, baseline: { formato: "deriva-corpo-baseline/1", entradas } }));
  ' "$saida" "$declara_q" "$TMPD/p.hex" "$MIG"/*.sql "$@"
}
JSON="$TMPD/entrada.json"
montar_json "$JSON" nao

# ── utilitários de veredito ──────────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
OUT=""
RC=0
roda() { # roda <json> [psql-ro] — captura o exit e a saída (stdout+stderr) do sensor
  local json="$1" psql="${2:-$WRAP}"
  set +e
  OUT="$(AUTHZ_DERIVA_CORPO_TEST_JSON="$json" PSQL_RO="$psql" bun "$REPO_ROOT/db/audit-deriva-corpo-prod.ts" 2>&1)"
  RC=$?
  set -e
}
esperar() { # esperar <rótulo> <exit> <deve conter|-> <não deve conter|->
  local rot="$1" rc="$2" deve="$3" nao="$4" ok=1
  [ "$RC" = "$rc" ] || ok=0
  if [ "$deve" != "-" ] && ! grep -qF -- "$deve" <<<"$OUT"; then ok=0; fi
  if [ "$nao" != "-" ] && grep -qF -- "$nao" <<<"$OUT"; then ok=0; fi
  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1))
    echo "  ok  $rot"
  else
    FAIL=$((FAIL + 1))
    echo "  XX  $rot (exit $RC, esperado $rc; deve='$deve' nao='$nao')"
    head -c 1500 <<<"$OUT" | sed 's/^/        /'
  fi
}

echo "== locale: $LC_ALL"

# A. CONTROLE — sem ele, nenhuma sabotagem abaixo prova nada.
roda "$JSON"
esperar "A  controle verde no estado certo" 0 "✅ deriva-corpo" "[INCERTO]"
if [ "$FAIL" != 0 ]; then
  echo "controle verde FALHOU — abortando antes de sabotar (vermelho sem linha de base é teatro)"
  exit 1
fi

# B. revert por ordem de colagem: a versão ANTERIOR de f volta a prod.
P -c 'CREATE OR REPLACE FUNCTION public.f(p_x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;'
roda "$JSON"
esperar "B  revert de f(integer) → CORPO_ANTERIOR" 1 "[CORPO_ANTERIOR] f(integer):" "✅"
P -c 'CREATE OR REPLACE FUNCTION public.f(p_x integer) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;'
roda "$JSON"
esperar "B' dente: f restaurada → verde" 0 "✅ deriva-corpo" "[CORPO_ANTERIOR]"

# C. edição manual de um LITERAL (o caso detectar_skus_sem_grupo).
P -c "CREATE OR REPLACE FUNCTION public.g() RETURNS text LANGUAGE plpgsql AS \$\$
BEGIN
  -- comentário de repo
  RETURN 'acao';
END;
\$\$;"
roda "$JSON"
esperar "C  literal editado em g() → SEM_PAR" 1 "[SEM_PAR] g():" "✅"

# D. mudança SÓ cosmética (sem comentário, outra quebra de linha) → VERDE.
P -c "CREATE OR REPLACE FUNCTION public.g() RETURNS text LANGUAGE plpgsql AS \$\$ BEGIN RETURN 'ação'; END; \$\$;"
roda "$JSON"
esperar "D  g() só cosmética → verde (COSMETICO)" 0 "✅ deriva-corpo" "[SEM_PAR]"

# E. função viva some de prod.
P -c 'DROP FUNCTION public.h();'
roda "$JSON"
esperar "E  h() dropada à mão → AUSENTE" 1 "[AUSENTE] h():" "✅"
P -c 'CREATE OR REPLACE FUNCTION public.h() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;'
roda "$JSON"
esperar "E' dente: h() recriada → verde" 0 "✅ deriva-corpo" "[AUSENTE]"

# F. função APOSENTADA (DROP commitado) recriada à mão com o último corpo — o falso-verde do Codex.
P -c 'CREATE OR REPLACE FUNCTION public.d() RETURNS int LANGUAGE sql AS $$ SELECT 4 $$;'
roda "$JSON"
esperar "F  d() ressuscitada → RESSUSCITADA" 1 "[RESSUSCITADA] d():" "✅"
P -c 'DROP FUNCTION public.d();'
roda "$JSON"
esperar "F' dente: d() de novo ausente → verde" 0 "✅ deriva-corpo" "[RESSUSCITADA]"

# G. corpos TROCADOS entre overloads — casar por corpo sem identidade aprovaria.
P -c "CREATE OR REPLACE FUNCTION public.k(p int) RETURNS text LANGUAGE sql AS \$\$ SELECT 'k-text' \$\$;
      CREATE OR REPLACE FUNCTION public.k(p text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'k-int' \$\$;"
roda "$JSON"
esperar "G  overloads trocados → SEM_PAR em k(integer)" 1 "[SEM_PAR] k(integer):" "✅"
esperar "G  … e em k(text)" 1 "[SEM_PAR] k(text):" "✅"
P -c "CREATE OR REPLACE FUNCTION public.k(p int) RETURNS text LANGUAGE sql AS \$\$ SELECT 'k-int' \$\$;
      CREATE OR REPLACE FUNCTION public.k(p text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'k-text' \$\$;"
roda "$JSON"
esperar "G' dente: overloads no lugar → verde" 0 "✅ deriva-corpo" "[SEM_PAR]"

# H. overload que nenhuma migration declara.
P -c 'CREATE OR REPLACE FUNCTION public.f(p_x text) RETURNS int LANGUAGE sql AS $$ SELECT 9 $$;'
roda "$JSON"
esperar "H  f(text) fora do repo → OVERLOAD_FORA_DO_REPO" 1 "[OVERLOAD_FORA_DO_REPO] f(text):" "✅"
P -c 'DROP FUNCTION public.f(text);'
roda "$JSON"
esperar "H' dente: sem o overload extra → verde" 0 "✅ deriva-corpo" "[OVERLOAD_FORA_DO_REPO]"

# I. patch por âncora REVERTIDO: p() volta ao último CREATE (sem a baseline, sairia EM_DIA).
P -c "CREATE OR REPLACE FUNCTION public.p() RETURNS text LANGUAGE sql AS \$\$ SELECT 'antes' \$\$;"
roda "$JSON"
esperar "I  patch de p() revertido → PATCH_AUSENTE" 1 "[PATCH_AUSENTE] p():" "✅"
P -f "$MIG/20260103000000_patch.sql"
roda "$JSON"
esperar "I' dente: patch reaplicado → verde" 0 "✅ deriva-corpo" "[PATCH_AUSENTE]"

# J. um 2º patch chega ao repo e não pega em prod: o 1º aceito não o absolve.
cat >"$TMPD/20260104000000_patch2.sql" <<'EOF'
DO $mig$ BEGIN EXECUTE replace(pg_get_functiondef('public.p()'::regprocedure), '''depois''', '''depois2'''); END $mig$;
EOF
montar_json "$TMPD/entrada-patch2.json" nao "$TMPD/20260104000000_patch2.sql"
roda "$TMPD/entrada-patch2.json"
esperar "J  2º patch sem conciliação → PATCH_NAO_CONCILIADO" 1 "[PATCH_NAO_CONCILIADO] p():" "✅"

# L. última versão sem corpo comparável (RETURN do SQL padrão): não declarada ⇒ 2; declarada ⇒ 0.
cat >"$TMPD/20260105000000_q.sql" <<'EOF'
CREATE OR REPLACE FUNCTION public.q() RETURNS int LANGUAGE sql RETURN 7;
EOF
P -f "$TMPD/20260105000000_q.sql"
montar_json "$TMPD/entrada-q.json" nao "$TMPD/20260105000000_q.sql"
roda "$TMPD/entrada-q.json"
esperar "L  q() sem corpo e não declarada → 2 (não medi ≠ bate)" 2 "[INCERTO]" "✅"
montar_json "$TMPD/entrada-q-decl.json" sim "$TMPD/20260105000000_q.sql"
roda "$TMPD/entrada-q-decl.json"
esperar "L' q() declarada NAO_MENSURAVEL → verde" 0 "✅ deriva-corpo" "[INCERTO]"
P -c 'DROP FUNCTION public.q();'

# M. prod troca o corpo textual por SQL padrão (prosqlbody) numa função que o repo declara com $$.
P -c 'CREATE OR REPLACE FUNCTION public.h() RETURNS int LANGUAGE sql RETURN 3;'
roda "$JSON"
esperar "M  h() sem prosrc comparável → SEM_CORPO_TEXTUAL" 1 "[SEM_CORPO_TEXTUAL] h():" "✅"
P -c 'CREATE OR REPLACE FUNCTION public.h() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$;'
roda "$JSON"
esperar "M' dente: h() de volta → verde" 0 "✅ deriva-corpo" "[SEM_CORPO_TEXTUAL]"

# K. medição QUEBRADA — sempre 2, nunca 0 nem 1.
falso() { # falso <nome> <corpo do script> — um psql-ro que se comporta mal
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"$TMPD/$1"
  chmod +x "$TMPD/$1"
}
falso trunca "\"$WRAP\" \"\$@\" | sed '\$d'"
roda "$JSON" "$TMPD/trunca"
esperar "K1 saída truncada (sem a última linha) → 2" 2 "[INCERTO]" "✅"
falso caido 'echo "psql: error: connection to server failed" >&2; exit 2'
roda "$JSON" "$TMPD/caido"
esperar "K2 psql-ro caído → 2" 2 "[INCERTO]" "✅"
falso vazio 'exit 0'
roda "$JSON" "$TMPD/vazio"
esperar "K3 saída vazia com exit 0 → 2" 2 "[INCERTO]" "✅"
falso corrompe "\"$WRAP\" \"\$@\" | awk -F'|' 'BEGIN { OFS = \"|\" } \$1 == \"fn\" && \$2 == \"g\" { \$6 = (substr(\$6, 1, 1) == \"0\" ? \"1\" : \"0\") substr(\$6, 2) } { print }'"
roda "$JSON" "$TMPD/corrompe"
esperar "K4 hex corrompido em trânsito → 2" 2 "[INCERTO]" "✅"

# Z. e o verde de novo no fim — o banco saiu das sabotagens no estado certo.
roda "$JSON"
esperar "Z  controle final verde" 0 "✅ deriva-corpo" "[INCERTO]"

echo "== $PASS ok · $FAIL falha(s) · locale $LC_ALL"
[ "$FAIL" = 0 ]
