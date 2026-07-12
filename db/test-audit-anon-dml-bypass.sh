#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA O DENTE de db/audit-anon-dml-bypass.sql (a query da guarda de prod).     ║
# ║  Uma guarda que sempre diz "limpo" por um bug é PIOR que nada (falsa segurança).║
# ║  Aqui: cria em PG17 local cenários PERIGOSOS (devem disparar) e SEGUROS (não),  ║
# ║  roda a MESMA query que o audit de prod usa, e FALSIFICA (corrige o perigoso →  ║
# ║  a detecção deve sumir). Pré-req: brew install postgresql@17.                    ║
# ║  Rode:  bash db/test-audit-anon-dml-bypass.sh ; echo $?                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="audit-anon-dml"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
# roda a MESMA query do audit de prod e devolve as linhas ofensoras (sem o prefixo HIT|)
audit_hits() {
  local raw ln
  raw="$(P -tA -f "$REPO_ROOT/db/audit-anon-dml-bypass.sql")"
  while IFS= read -r ln; do case "$ln" in HIT\|*) echo "${ln#HIT|}" ;; esac; done <<< "$raw"
}

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

echo "═══ cenários no public (2 perigosos, 2 seguros) ═══"
P -q <<'SQL'
CREATE TABLE public.t_rls   (id int primary key, v text);
CREATE TABLE public.t_norls (id int primary key, v text);
ALTER TABLE public.t_rls ENABLE ROW LEVEL SECURITY;              -- base COM rls; t_norls fica SEM (deliberado)

CREATE VIEW public.v_perigo1 AS SELECT id, v FROM public.t_rls;                                 -- atualizável + invoker OFF (default) → vetor1
CREATE VIEW public.v_perigo2 WITH (security_invoker=on) AS SELECT id, v FROM public.t_norls;    -- atualizável + invoker ON + base SEM rls → vetor2
CREATE VIEW public.v_seguro1 WITH (security_invoker=on) AS SELECT id, v FROM public.t_rls;      -- atualizável + invoker ON + base COM rls → seguro
CREATE VIEW public.v_seguro2 AS SELECT v, count(*) AS n FROM public.t_rls GROUP BY v;           -- NÃO-atualizável (agregação) → seguro

-- simula o default privilege do Supabase: DML a anon nas 4 (só as elegíveis devem disparar)
GRANT INSERT,UPDATE,DELETE ON public.v_perigo1, public.v_perigo2, public.v_seguro1, public.v_seguro2 TO anon;
SQL

echo "── (A) detecção: perigosos disparam, seguros não ──"
HITS="$(audit_hits)"
while IFS= read -r h; do [ -n "$h" ] && echo "    · $h"; done <<< "$HITS"
case "$HITS" in *"v_perigo1 | anon | INVOKER_OFF"*)  ok "detecta v_perigo1 (vetor1: invoker off)";; *) bad "NÃO detectou v_perigo1";; esac
case "$HITS" in *"v_perigo2 | anon | BASE_SEM_RLS"*) ok "detecta v_perigo2 (vetor2: base sem rls)";; *) bad "NÃO detectou v_perigo2";; esac
case "$HITS" in *v_seguro1*) bad "FALSO POSITIVO: v_seguro1 (invoker on + base rls é seguro)";; *) ok "ignora v_seguro1 (seguro)";; esac
case "$HITS" in *v_seguro2*) bad "FALSO POSITIVO: v_seguro2 (não-atualizável é seguro)";; *) ok "ignora v_seguro2 (seguro)";; esac

echo "── (B) FALSIFICAÇÃO: corrigir os perigosos deve zerar a detecção (dente) ──"
P -q -c "ALTER VIEW public.v_perigo1 SET (security_invoker=on);"   # corrige o vetor1
P -q -c "ALTER TABLE public.t_norls ENABLE ROW LEVEL SECURITY;"    # corrige o vetor2
HITS2="$(audit_hits)"
case "$HITS2" in *v_perigo1*) bad "F1: v_perigo1 persiste após invoker=on (vetor1 SEM dente)";; *) ok "F1: v_perigo1 some após invoker=on (vetor1 com dente)";; esac
case "$HITS2" in *v_perigo2*) bad "F2: v_perigo2 persiste após RLS na base (vetor2 SEM dente)";; *) ok "F2: v_perigo2 some após RLS na base (vetor2 com dente)";; esac
if [ -z "$HITS2" ]; then ok "F3: detecção zerada após corrigir ambos"; else bad "F3: ainda detecta: $HITS2"; fi

echo "──────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = 0 ] || { echo "❌ VERMELHO"; exit 1; }
echo "✅ guarda com DENTE: detecta os 2 vetores, ignora seguros, reage à correção"
