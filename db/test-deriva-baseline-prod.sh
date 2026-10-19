#!/usr/bin/env bash
# test-deriva-baseline-prod.sh — a deriva ACEITA tem DENTE no retrato REAL da prod (I2 · plano v2, item 5, (b))
# =====================================================================================================
# O auditor `deriva:corpo:prod` aceita, por baseline (db/deriva-corpo-baseline.json), funções cujo
# corpo vivo nenhuma migration explica: EDICAO_MANUAL e o último PATCH ALTERA pinam o corpo por md5 de
# TOKENS; os PATCH SO_CITA deixam o corpo pinado pelo último CREATE do repo. O harness do auditor
# (db/test-audit-deriva-corpo-prod.sh) prova as REGRAS com fixtures; este prova que cada identidade
# REAL da baseline está ligada à regra certa: muda 1 token do corpo dela no retrato da prod → o
# auditor sai 1 nomeando-a; muda só um comentário → segue 0 (o cosmético não reabre alarme).
#
# Sem máquina nova (parecer Codex de desenho, 2026-10-19, P2/9): o juiz é o auditor existente, pela
# injeção de dependências dele (`PSQL_RO`). A prod é lida UMA vez (a sonda inteira, numa transação
# REPEATABLE READ) e a captura é mutada por identidade — hex, md5 do detalhe E md5 da sonda agregada,
# que o parser cruza (`md5 da sonda e do detalhe divergem` seria "não medi", exit 2, não 1).
#
# Rode nos DOIS locales (a lição do #1483):
#   LC_ALL=C bash db/test-deriva-baseline-prod.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LC_ALL=pt_BR.UTF-8 bash db/test-deriva-baseline-prod.sh > /tmp/t.log 2>&1; echo "exit=$?"
# `--repo-local`: o repo é o CHECKOUT (migrations do working tree + baseline local), não origin/main — a
# visão PÓS-MERGE de um PR que acrescenta migration e mexe na baseline (o auditor lê origin/main).
# Precisa do psql-ro (Mac): sem ele NÃO mediu (exit 2) — nunca verde por ausência. Fora do CI.
set -euo pipefail

MODO_REPO="origin"
case "${1:-}" in
  "") ;;
  --repo-local) MODO_REPO="local" ;;
  *) echo "uso: $0 [--repo-local]" >&2; exit 2 ;;
esac
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL_REAL="${PSQL_RO:-$HOME/.config/afiacao/psql-ro}"
BASELINE="$REPO_ROOT/db/deriva-corpo-baseline.json"
AUDITOR="$REPO_ROOT/db/audit-deriva-corpo-prod.ts"
if [ ! -x "$PSQL_REAL" ]; then
  echo "psql-ro ausente em $PSQL_REAL — esta prova lê a PROD; sem ele não medi (exit 2)"; exit 2
fi
command -v bun >/dev/null || { echo "bun ausente — não medi (exit 2)"; exit 2; }
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/deriva-baseline.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT
CAP="$TMPD/captura.txt"; SQLCAP="$TMPD/captura.sql"; MUT="$TMPD/mutada.txt"
echo "== locale: ${LC_ALL:-?}"

# ── wrapper 1: CAPTURA (uma leitura da prod; o SQL recebido fica guardado) ───────────────────────────
cat > "$TMPD/psql-captura" <<WRAP
#!/usr/bin/env bash
printf '%s' "\${@: -1}" > "$SQLCAP"
"$PSQL_REAL" -v ON_ERROR_STOP=1 "\$@" | tee "$CAP"
exit "\${PIPESTATUS[0]}"
WRAP
# ── wrapper 2: REPLAY da captura mutada — só se o SQL for o MESMO da captura (outro universo não vale)
cat > "$TMPD/psql-replay" <<WRAP
#!/usr/bin/env bash
if [ "\${@: -1}" != "\$(cat "$SQLCAP")" ]; then echo "replay: o SQL mudou entre a captura e a rodada" >&2; exit 3; fi
cat "$MUT"
WRAP
chmod +x "$TMPD/psql-captura" "$TMPD/psql-replay"

# `--repo-local`: a fixture do auditor (AUTHZ_DERIVA_CORPO_TEST_JSON) nasce do checkout — migrations do
# working tree + baseline local — e vale para TODAS as rodadas (o SQL da sonda sai do mesmo modelo).
FIXTURE=""
if [ "$MODO_REPO" = "local" ]; then
  FIXTURE="$TMPD/fixture.json"
  REPO_ROOT="$REPO_ROOT" bun -e '
    const fs = require("node:fs");
    const root = process.env.REPO_ROOT; const dir = root + "/supabase/migrations";
    const migrations = fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort((a, b) => a.localeCompare(b, "en"))
      .map((nome) => ({ nome, sql: fs.readFileSync(dir + "/" + nome, "utf8") }));
    const baseline = JSON.parse(fs.readFileSync(root + "/db/deriva-corpo-baseline.json", "utf8"));
    fs.writeFileSync(process.argv[1], JSON.stringify({ migrations, baseline }));
    console.log("== repo LOCAL: " + migrations.length + " migrations do checkout + baseline local (visão pós-merge)");
  ' "$FIXTURE"
else
  echo "== repo: origin/main (como o auditor roda no /fecho)"
fi

PASS=0; FAIL=0; OUT=""; RC=0
ok()  { PASS=$((PASS+1)); echo "  ok  $1"; }
xx()  { FAIL=$((FAIL+1)); echo "  XX  $1"; }
roda() { # roda <psql-wrapper> [flags do auditor...]
  local w="$1"; shift
  set +e
  OUT="$(AUTHZ_DERIVA_CORPO_TEST_JSON="$FIXTURE" PSQL_RO="$w" bun "$AUDITOR" "$@" 2>&1)"; RC=$?
  set -e
}

# ── A. CONTROLE: o auditor REAL, com a prod REAL, verde — e a captura existe ────────────────────────
roda "$TMPD/psql-captura"
if [ "$RC" = 0 ] && grep -qF '✅ deriva-corpo' <<<"$OUT" && [ -s "$CAP" ]; then
  ok "A  controle: auditor verde contra a prod ($(grep -oE 'EM_DIA=[0-9]+ · COSMETICO=[0-9]+ · ACEITA=[0-9]+' <<<"$OUT" || echo 'sem resumo'))"
else
  xx "A  controle VERMELHO/INCERTO (exit $RC) — abortando ANTES de mutar: sempre-vermelho aprovaria tudo"
  head -c 1500 <<<"$OUT"; exit 1
fi

# ── as identidades da baseline (NAO_MENSURAVEL fica de fora: não tem corpo a mutar) ─────────────────
NOMES="$(jq -r '.entradas[] | select(.classe != "NAO_MENSURAVEL") | .funcao' "$BASELINE" | sort -u)"
N="$(wc -l <<<"$NOMES" | tr -d ' ')"
[ "$N" -gt 0 ] || { xx "baseline sem identidade mensurável — não há o que provar"; exit 1; }
echo "== $N identidade(s) da baseline a provar"

# ── a mutação: hex do corpo + md5 do detalhe + md5 da sonda, coerentes entre si ─────────────────────
mutar() { # mutar <nome> <token|cosmetico> → escreve $MUT; falha se a captura não tem a função
  REPO_ROOT="$REPO_ROOT" bun -e '
    const fs = require("node:fs");
    const { md5Exato } = await import(process.env.REPO_ROOT + "/scripts/lib/migration-objects.ts");
    const [cap, nome, modo, out] = process.argv.slice(1);
    const sufixo = modo === "token" ? "\nSELECT 0;" : "\n-- comentario novo (cosmetico)\n";
    const troca = new Map(); let n = 0;
    const linhas = fs.readFileSync(cap, "utf8").split("\n").map((l) => {
      const c = l.split("|");
      if (c[0] === "fn" && c[1] === nome && c[5]) {
        const texto = Buffer.from(c[5], "hex").toString("utf8");
        if (md5Exato(texto) !== c[4]) { console.error("captura: hex nao reproduz o md5 de " + nome); process.exit(3); }
        const novo = texto + sufixo; const m = md5Exato(novo); troca.set(c[4], m); n++;
        return [c[0], c[1], c[2], c[3], m, Buffer.from(novo, "utf8").toString("hex")].join("|");
      }
      return l;
    }).map((l) => {
      const c = l.split("|");
      if (c[0] === "corpo" && c[1] === nome && troca.has(c[2])) { c[2] = troca.get(c[2]); return c.join("|"); }
      return l;
    });
    if (n === 0) { console.error("captura sem corpo para " + nome); process.exit(3); }
    fs.writeFileSync(out, linhas.join("\n"));
    console.log(n);
  ' "$CAP" "$1" "$2" "$MUT"
}

# ── B. por identidade: 1 token → exit 1 nomeando-a; só comentário → exit 0 ──────────────────────────
for nome in $NOMES; do
  k="$(mutar "$nome" token)" || { xx "B  $nome: a captura não tem o corpo — não mutei"; continue; }
  if cmp -s "$CAP" "$MUT"; then xx "B  $nome: mutação INERTE"; continue; fi
  roda "$TMPD/psql-replay" --sem-rede
  # a linha do auditor é `❌ [CLASSE] nome(args): …` — casar a CLASSE em caixa alta + o nome com parêntese, sem crase
  if [ "$RC" = 1 ] && grep -q "❌ \[[A-Z_]*\] $nome(" <<<"$OUT" && ! grep -qF '[INCERTO]' <<<"$OUT"; then
    ok "B  $nome: 1 token a mais em $k overload(s) → exit 1 nomeando-a"
  else
    xx "B  $nome: 1 token a mais devia sair 1 nomeando-a (saiu $RC)"; { grep '❌' <<<"$OUT" || head -c 600 <<<"$OUT"; } | sed 's/^/        /'
  fi
  mutar "$nome" cosmetico >/dev/null
  roda "$TMPD/psql-replay" --sem-rede
  if [ "$RC" = 0 ] && grep -qF '✅ deriva-corpo' <<<"$OUT"; then
    ok "C  $nome: só comentário → segue verde (cosmético não reabre alarme)"
  else
    xx "C  $nome: só comentário devia seguir 0 (saiu $RC)"; head -c 600 <<<"$OUT" | sed 's/^/        /'
  fi
done

# ── D. o replay recusa SQL de outro universo (a captura não vale para outra sonda) ──────────────────
printf '%s' "outro sql" > "$TMPD/outro.sql"
if OUTD="$(SQLCAP_X=1 bash -c 'printf "x" | "'"$TMPD"'/psql-replay" -c "outro sql"' 2>&1)"; then
  xx "D  o replay aceitou um SQL diferente do capturado"
else
  ok "D  o replay recusa SQL diferente do capturado ($(head -c 60 <<<"$OUTD"))"
fi

echo "═══ RESULTADO: $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ]
