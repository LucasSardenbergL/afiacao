#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA O DENTE de db/audit-grants-tabelas-fechadas.ts (o audit de prod).        ║
# ║                                                                                ║
# ║  Sobe um PG17 descartável, cria uma tabela FECHADA conforme um contrato de      ║
# ║  teste, e roda o audit REAL (o mesmo binário que aponta para prod) com PSQL_RO  ║
# ║  redirecionado para este PG. Nada de reimplementar a lógica no shell: o que     ║
# ║  está sob teste é o executável inteiro — query, parser da saída e exit code.    ║
# ║                                                                                ║
# ║   (A) fechada (só SELECT p/ authenticated) → limpo, exit 0                      ║
# ║   (B) GRANT INSERT a authenticated         → DRIFT_PROD, exit 1                 ║
# ║   (C) REVOKE INSERT                        → acusação SOME, exit 0  ← dente     ║
# ║   (D) GRANT INSERT,UPDATE,DELETE           → NAO_APLICADA (não DRIFT), exit 1   ║
# ║   (E) GRANT MAINTAIN (PG17)                → DRIFT_PROD, exit 1                 ║
# ║   (F) GRANT SELECT a anon                  → acusa anon (permitido [])          ║
# ║   (G) GRANT REFERENCES a anon              → DRIFT_PROD nomeando REFERENCES     ║
# ║   (H) GRANT TRIGGER a authenticated        → DRIFT_PROD nomeando TRIGGER        ║
# ║   (I) revoga tudo                          → volta ao limpo, exit 0  ← dente    ║
# ║   (J) saída com 1 privilégio ENGOLIDO      → exit 2, NÃO exit 0      ← dente    ║
# ║   (K) saída sem a linha VER|               → exit 2 (sem denominador)           ║
# ║                                                                                ║
# ║  A allowlist entra por AUTHZ_GRANTS_TEST_JSON — o contrato real do repo não é   ║
# ║  tocado, e o teste não quebra quando product_costs/omie_products mudarem.       ║
# ║                                                                                ║
# ║  LOCALE: herdado do ambiente (default C). A lição #1483 é sobre o grep do       ║
# ║  SHELL, não sobre o banco — por isso as asserções casam CÓDIGO ASCII em caixa   ║
# ║  fixa, sem -i, e este harness deve passar tanto sob LC_ALL=C quanto sob         ║
# ║  LC_ALL=pt_BR.UTF-8. Rode nos dois:                                            ║
# ║    LC_ALL=C           bash db/test-audit-grants-tabelas-fechadas.sh ; echo $?   ║
# ║    LC_ALL=pt_BR.UTF-8 bash db/test-audit-grants-tabelas-fechadas.sh ; echo $?   ║
# ║                                                                                ║
# ║  Pré-req: brew install postgresql@17 · bun no PATH.                             ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-audit-grants.XXXXXX")"
DATA="$TMPD/data"
OUT="$TMPD/audit-saida.txt"
WRAP="$TMPD/psql-ro-fake"
WRAP_PERDA="$TMPD/psql-ro-fake-perda"
WRAP_SEM_VER="$TMPD/psql-ro-fake-sem-ver"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
command -v bun >/dev/null || { echo "bun ausente no PATH"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

echo "── setup: PG${PGVER} em :$PORT · locale do shell LC_ALL=$LC_ALL ──"
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q "$@"; }

# Wrapper que o audit invoca como se fosse o psql-ro de prod (repassa os args ao psql local).
cat > "$WRAP" <<WRAPEOF
#!/usr/bin/env bash
exec "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "\$@"
WRAPEOF
chmod +x "$WRAP"

# Wrappers DESONESTOS: o mesmo psql, com a saída MUTILADA de duas formas plausíveis (psql truncado,
# psqlrc filtrando, pipe quebrado). Existem para provar que o audit REPROVA em vez de ler medição
# incompleta como "nada divergente" — o falso-verde perfeito. `sed` (e não `grep -v`) porque grep
# que não casa nada sai 1 e o erro viria do execFileSync, dando o exit certo pelo motivo errado.
cat > "$WRAP_PERDA" <<WRAPEOF
#!/usr/bin/env bash
exec "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "\$@" | sed '/|MAINTAIN|/d'
WRAPEOF
chmod +x "$WRAP_PERDA"
cat > "$WRAP_SEM_VER" <<WRAPEOF
#!/usr/bin/env bash
exec "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove "\$@" | sed '/^VER|/d'
WRAPEOF
chmod +x "$WRAP_SEM_VER"

# Roles do Supabase + a tabela no estado FECHADO do contrato.
P <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.zz_fechada_test (id int primary key, v text);
ALTER TABLE public.zz_fechada_test ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.zz_fechada_test FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.zz_fechada_test TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.zz_fechada_test TO service_role;
SQL

TEST_JSON='{"public.zz_fechada_test":{"fechadaPor":"20260101000000_x.sql","permitido":{"anon":[],"authenticated":["SELECT"]},"motivo":"tabela sintética do harness"}}'

# `|| ec=$?` é obrigatório: sob `set -e`, um audit que sai 1 (o caso que QUEREMOS) mataria o
# harness antes da asserção, e o teste passaria a nunca reprovar.
WRAP_ATUAL="$WRAP"   # trocado nos cenários J/K para um wrapper de saída MUTILADA
run_audit() {
  local ec=0
  PSQL_RO="$WRAP_ATUAL" AUTHZ_GRANTS_TEST_JSON="$TEST_JSON" \
    bun "$REPO_ROOT/db/audit-grants-tabelas-fechadas.ts" > "$OUT" 2>&1 || ec=$?
  echo "$ec"
}

PASS=0
FAIL=0
# esperar <rótulo> <exit esperado> <código que DEVE aparecer|-> <código que NÃO pode aparecer|->
#         [<trecho DELIMITADO que DEVE aparecer|->]
# O 4º argumento é o que separa "acusou" de "acusou a coisa certa": casar só a presença deixaria
# NAO_APLICADA e DRIFT_PROD indistinguíveis, e o operador aplicaria a correção errada.
# O 5º é a mesma exigência um nível abaixo: o código DRIFT_PROD sozinho não distingue QUAL
# privilégio vazou, então um cenário de REFERENCES ficaria verde com o audit acusando TRIGGER —
# ou acusando qualquer sobra por outro motivo. Ele casa a marca do RAMO, não "acusou algo".
esperar() {
  local rotulo="$1" ec_esperado="$2" deve="$3" nao_deve="$4" trecho="${5:--}" ec erro=""
  ec="$(run_audit)"
  [ "$ec" = "$ec_esperado" ] || erro="exit $ec (esperava $ec_esperado)"
  if [ "$deve" != "-" ] && ! command grep -q "$deve" "$OUT"; then erro="$erro | ausente: $deve"; fi
  if [ "$nao_deve" != "-" ] && command grep -q "$nao_deve" "$OUT"; then erro="$erro | presente indevido: $nao_deve"; fi
  if [ "$trecho" != "-" ] && ! command grep -q "$trecho" "$OUT"; then erro="$erro | ausente: $trecho"; fi
  if [ -z "$erro" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $rotulo"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $rotulo — $erro"; sed 's/^/     /' "$OUT"
  fi
}

echo "── cenários ──"
esperar "A: estado fechado → limpo (exit 0)" 0 - DRIFT_PROD

P -c "GRANT INSERT ON TABLE public.zz_fechada_test TO authenticated;"
esperar "B: GRANT INSERT → DRIFT_PROD (exit 1)" 1 DRIFT_PROD NAO_APLICADA

P -c "REVOKE INSERT ON TABLE public.zz_fechada_test FROM authenticated;"
esperar "C: revogado → acusação some (exit 0)" 0 - DRIFT_PROD

P -c "GRANT INSERT,UPDATE,DELETE ON TABLE public.zz_fechada_test TO authenticated;"
esperar "D: DML completo → NAO_APLICADA, não DRIFT_PROD (exit 1)" 1 NAO_APLICADA DRIFT_PROD

P -c "REVOKE INSERT,UPDATE,DELETE ON TABLE public.zz_fechada_test FROM authenticated;"
P -c "GRANT MAINTAIN ON TABLE public.zz_fechada_test TO authenticated;"
esperar "E: MAINTAIN (PG17) medido → DRIFT_PROD (exit 1)" 1 DRIFT_PROD NAO_APLICADA

P -c "REVOKE MAINTAIN ON TABLE public.zz_fechada_test FROM authenticated;"
P -c "GRANT SELECT ON TABLE public.zz_fechada_test TO anon;"
esperar "F: SELECT a anon (permitido vazio) → DRIFT_PROD (exit 1)" 1 DRIFT_PROD NAO_APLICADA

P -c "REVOKE SELECT ON TABLE public.zz_fechada_test FROM anon;"
# G e H são os privilégios que o contrato sempre aceitou DECLARAR e o audit nunca mediu (até
# 2026-08-27): GRANT à mão no SQL Editor não é migration, então o gate estático também não os vê.
# O 5º argumento casa o nome do privilégio no texto — sem ele os dois cenários passariam com o
# audit acusando qualquer OUTRA sobra, e a extensão pareceria provada sem estar.
P -c "GRANT REFERENCES ON TABLE public.zz_fechada_test TO anon;"
esperar "G: REFERENCES a anon → DRIFT_PROD nomeando REFERENCES (exit 1)" 1 DRIFT_PROD NAO_APLICADA \
  "anon tem REFERENCES"

P -c "REVOKE REFERENCES ON TABLE public.zz_fechada_test FROM anon;"
P -c "GRANT TRIGGER ON TABLE public.zz_fechada_test TO authenticated;"
esperar "H: TRIGGER a authenticated → DRIFT_PROD nomeando TRIGGER (exit 1)" 1 DRIFT_PROD NAO_APLICADA \
  "authenticated tem TRIGGER"

P -c "REVOKE TRIGGER ON TABLE public.zz_fechada_test FROM authenticated;"
esperar "I: tudo revogado → volta ao limpo (exit 0)" 0 - DRIFT_PROD

# J/K medem a GUARDA DE CARDINALIDADE, não o contrato: o banco está limpo nos dois, e o que muda é
# a saída do psql. J engole as linhas de UM privilégio — 1 tabela × 2 roles × 8 privilégios = 16
# linhas ROW| viram 14. Era exatamente o buraco do piso literal `5` (mínimo 10): 14 ≥ 10 saía
# `exit 0` e "✅ prod bate com o contrato" sobre uma medição incompleta. Com a conta EXATA sai 2.
WRAP_ATUAL="$WRAP_PERDA"
esperar "J: 1 privilégio engolido da saída → exit 2, não 0" 2 - DRIFT_PROD "medição inconsistente"

# K tira o denominador: sem VER| o audit não sabe se a query mediu 7 privilégios ou 8, e conferir
# cardinalidade contra um número desconhecido é teatro. Ausência de dado sai 2, não 0.
WRAP_ATUAL="$WRAP_SEM_VER"
esperar "K: saída sem a linha VER| → exit 2 (sem denominador)" 2 - DRIFT_PROD "VER|"
WRAP_ATUAL="$WRAP"

echo "──────────────"
echo "RESULTADO: $PASS ok / $FAIL fail  (locale LC_ALL=$LC_ALL)"
[ "$FAIL" = 0 ] || { echo "❌ VERMELHO"; exit 1; }
echo "✅ audit de prod com DENTE: acusa reabertura, distingue NAO_APLICADA de DRIFT_PROD, mede os 8 privilégios (REFERENCES/TRIGGER/MAINTAIN inclusive) e anon, reage à correção e REPROVA medição incompleta"
