#!/usr/bin/env bash
# pg-harness.sh — resolve o PGBIN do PostgreSQL 17 para as provas `db/test-*.sh`.
# ============================================================================
# NÃO é executável: é `source`-ado pelo script de prova, que continua fazendo o
# seu próprio `initdb` + `pg_ctl` numa porta própria. Este helper resolve UMA
# coisa — ONDE estão os binários — e some.
#
# ## Por que ele existe
#
# As 289 provas nasceram no laptop e traziam `PGBIN="/opt/homebrew/opt/..."`
# hardcoded (medido 2026-09-07: 268 arquivos com a linha idêntica). Isso as
# prendia ao macOS+Homebrew e as mantinha FORA do CI — e é justamente onde moram
# as provas das classes que só um banco de verdade pega: TOCTOU/guard fora da
# escrita, PL/pgSQL late-bound, `security_invoker` omitido em CREATE OR REPLACE
# VIEW. O caminho obrigatório do merge não executava uma linha de SQL.
#
# ## Fail-CLOSED, com resposta POSITIVA
#
# A tentação é degradar: "PG17 ausente → pula o teste". Isso transformaria o
# gate em teatro — banco ausente aprovaria TUDO, que é a assinatura de
# `ausente ≠ zero` aplicada ao CI. Aqui a ausência é ERRO (exit 1).
#
# E não basta `command -v`/`-x` (CLAUDE.md, "sonda ausente"): um `initdb`
# presente-porém-de-outra-versão passa no teste de existência e produz um
# veredito sobre o Postgres errado. A checagem é POSITIVA — pergunta a versão
# ao binário e exige que a major seja 17. Precedente no próprio `ci.yml`: o
# runner trazia shellcheck 0.9.0 contra 0.11.0 do laptop e o gate reprovava PR
# sadio. "Gate cuja VERDADE depende da versão do runner não é gate, é sorteio."
#
# Prod é PostgreSQL 17.6 (medido via psql-ro em 2026-09-07); o laptop é 17.10.
#
# ## Uso
#
#   REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   . "$REPO_ROOT/db/lib/pg-harness.sh"     # exporta PGBIN
#   "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
#
# Override explícito (fura a busca, mas NÃO a conferência de versão):
#   PGBIN_OVERRIDE=/caminho/para/bin bash db/test-x.sh

PGVER="${PGVER:-17}"

# Confere que o diretório tem um initdb EXECUTÁVEL cuja major é a esperada.
# Retorna 0 e ecoa o caminho; 1 caso contrário. `initdb --version` imprime
# "initdb (PostgreSQL) 17.10" — a major é o 1º campo numérico.
_pgh_major_confere() {
  local dir="$1" saida major
  [ -n "$dir" ] && [ -x "$dir/initdb" ] || return 1
  saida="$("$dir/initdb" --version 2>/dev/null)" || return 1
  major="$(printf '%s\n' "$saida" | grep -oE '[0-9]+' | sed -n 1p)"
  [ "$major" = "$PGVER" ] || return 1
  return 0
}

_pgh_resolve() {
  local cand dir
  # A ordem importa: override explícito > caminhos canônicos por plataforma >
  # o que estiver no PATH. Cada candidato passa pela MESMA conferência de major.
  for cand in \
    "${PGBIN_OVERRIDE:-}" \
    "/opt/homebrew/opt/postgresql@${PGVER}/bin" \
    "/usr/local/opt/postgresql@${PGVER}/bin" \
    "/usr/lib/postgresql/${PGVER}/bin" \
    "/usr/pgsql-${PGVER}/bin"
  do
    if _pgh_major_confere "$cand"; then printf '%s\n' "$cand"; return 0; fi
  done
  # Último recurso: um initdb no PATH — ainda sujeito à conferência de major.
  if dir="$(command -v initdb 2>/dev/null)"; then
    dir="$(dirname "$dir")"
    if _pgh_major_confere "$dir"; then printf '%s\n' "$dir"; return 0; fi
  fi
  return 1
}

if ! PGBIN="$(_pgh_resolve)"; then
  echo "ERRO: PostgreSQL ${PGVER} não encontrado (initdb com major ${PGVER})." >&2
  echo "  macOS: brew install postgresql@${PGVER} pgvector" >&2
  echo "  Debian/Ubuntu: apt-get install -y postgresql-${PGVER}  (repo PGDG)" >&2
  echo "  Ou aponte PGBIN_OVERRIDE=/caminho/para/bin (a major ainda é conferida)." >&2
  exit 1
fi
export PGBIN

# macOS/Homebrew: as fórmulas versionadas mantêm share/ e lib/ dentro do Cellar,
# e o initdb do keg procura em /opt/homebrew/{share,lib}/postgresql@N. Sem esta
# cópia, `initdb` falha por não achar os arquivos de suporte. É específico do
# Homebrew — em Linux (PGDG) os caminhos já estão certos e o bloco não roda.
if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  _pgh_cellar="$(brew --prefix "postgresql@${PGVER}" 2>/dev/null || true)"
  if [ -n "$_pgh_cellar" ] && [ -d "$_pgh_cellar" ]; then
    mkdir -p "/opt/homebrew/share/postgresql@${PGVER}" "/opt/homebrew/lib/postgresql@${PGVER}"
    cp -Rn "$_pgh_cellar"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
    cp -Rn "$_pgh_cellar"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
  fi
  unset _pgh_cellar
fi

# ── Espera por CONDIÇÃO entre duas sessões (receita E17; docs/historico/ci-provas-sql-espera-por-condicao.md) ──
# pgh_segura_sql APP_B N TETO [CONDIÇÃO] — bloco SQL para a sessão A, dentro da transação que segura a trava:
# em vez de `pg_sleep(fixo)`, A segura até ver N sessões com application_name LIKE 'APP_B%' esperando
# Lock (e, se dada, CONDIÇÃO SQL verdadeira), ou até todas as B que ela viu terem saído sem esperar, ou o
# TETO (segundos — o sleep fixo de antes). O veredito (quantas B ela viu em Lock na saída) fica em
# pg_temp.pgh_espera, para a prova que quiser afirmar "B esperou" pela boca de quem segurou a trava.
# `RESET ROLE` antes do laço: sob um papel sem pg_read_all_stats o pg_stat_activity esconde o estado das
# outras sessões, o laço só sairia no teto e a prova ficaria verde sem ganho (a ARMADILHA do lote 1).
# `pg_stat_clear_snapshot()` a cada volta: sem ele a transação vê a MESMA foto do pg_stat_activity.
pgh_segura_sql() {
  local cond="${4:-true}"
  cat <<SQL
RESET ROLE;
CREATE TEMP TABLE IF NOT EXISTS pgh_espera (n int);
DO \$pgh_segura\$
DECLARE t0 timestamptz := clock_timestamp(); viu boolean := false; n int; tem int;
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    SELECT count(*) FILTER (WHERE wait_event_type = 'Lock'), count(*) INTO n, tem
      FROM pg_stat_activity WHERE application_name LIKE '$1%' AND pid <> pg_backend_pid();
    EXIT WHEN n >= $2 AND ($cond);
    IF tem > 0 THEN viu := true; ELSIF viu THEN EXIT; END IF;
    EXIT WHEN clock_timestamp() - t0 > interval '$3 seconds';
    PERFORM pg_sleep(0.01);
  END LOOP;
  INSERT INTO pg_temp.pgh_espera VALUES (n);
END \$pgh_segura\$;
SQL
}
# pgh_espera_segurar APP_A PID_A CMD… — o shell espera (teto 5 s) a sessão A (application_name APP_A)
# ENTRAR no laço de pgh_segura_sql, i.e. já com a trava na mão, antes de soltar a B. Substitui o
# `sleep 0.3..0.7` fixo entre lançar A e lançar B. CMD… é o psql da prova (ex.: P -tA -q). Sai cedo se A
# morreu (PID_A). Sem efeito no veredito: se A nunca chegar, B entra como entrava depois do sleep.
pgh_espera_segurar() {
  local app="$1" pid="$2" i; shift 2
  for i in $(seq 1 250); do
    [ "$("$@" -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$app' AND state = 'active' AND query LIKE '%pgh_segura%'")" = 1 ] && return 0
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.02; : "$i"
  done
}
