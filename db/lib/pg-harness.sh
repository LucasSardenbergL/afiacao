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
  major="$(printf '%s\n' "$saida" | grep -oE '[0-9]+' | head -1)"
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
