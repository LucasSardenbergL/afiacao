#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — M-18: DROP da quarentena _quarantine_omie_clientes_20260722        ║
# ║   bash db/test-drop-quarentena-omie-clientes.sh > "$SCRATCH/t.log" 2>&1; echo $?   ║
# ║                                                                                    ║
# ║  A migration REAL só dropa se a tabela for EXATAMENTE a do backup (count 6909 +    ║
# ║  md5 de conteúdo em UTC). A prova não carrega o dado de prod (fica fora do repo);  ║
# ║  ela troca as 2 CONSTANTES da trava por as de uma fixture, num espelho em tmpdir,  ║
# ║  e confere que a substituição tocou só elas. Asserts:                              ║
# ║    tabela igual ao "backup" → dropa · 1 linha a mais → TRAVA, nada dropado ·       ║
# ║    1 valor alterado (mesmo count) → TRAVA · sessão em outro fuso → mesmo veredito  ║
# ║    (SET LOCAL timezone) · re-colar com a tabela já dropada → no-op.                ║
# ║  FALSIFICAÇÃO: espelho SEM a trava dropa a tabela alterada (a trava tinha dente).  ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5534}"
SLUG="drop-quarentena"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261011120500_drop_quarentena_omie_clientes.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# fixture com o DDL medido em prod (ddl.sql do backup, sem os triggers) e 50 linhas determinísticas
semear() {
  P -q <<'SQL'
DROP TABLE IF EXISTS public._quarantine_omie_clientes_20260722;
CREATE TABLE public._quarantine_omie_clientes_20260722 (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  omie_codigo_cliente bigint NOT NULL, omie_codigo_cliente_integracao text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), omie_codigo_vendedor bigint, empresa_omie text NOT NULL DEFAULT 'colacor'::text);
ALTER TABLE public._quarantine_omie_clientes_20260722 ADD CONSTRAINT omie_clientes_pkey PRIMARY KEY (id);
ALTER TABLE public._quarantine_omie_clientes_20260722 ADD CONSTRAINT unique_user_omie UNIQUE (user_id);
INSERT INTO public._quarantine_omie_clientes_20260722 (id, user_id, omie_codigo_cliente, created_at, updated_at, empresa_omie)
  SELECT md5('id' || g)::uuid, md5('u' || g)::uuid, 1000 + g,
         timestamptz '2026-05-25 06:00:00+00' + make_interval(mins => g),
         timestamptz '2026-07-18 05:00:00+00' + make_interval(secs => g),
         (ARRAY['colacor','oben','colacor_sc'])[1 + g % 3]
    FROM generate_series(1, 50) g;
SQL
}
existe() { Pq -c "SELECT to_regclass('public._quarantine_omie_clientes_20260722') IS NOT NULL"; }

semear
FIX_MD5=$(Pq -q -c "SET timezone = 'UTC'" -c "SELECT md5(string_agg(t::text, E'\n' ORDER BY t.id)) FROM public._quarantine_omie_clientes_20260722 t")
[ -n "$FIX_MD5" ] || { echo "md5 da fixture vazio"; exit 1; }

# espelho com as constantes da fixture — e só elas mudam
sed -e "s/v_n <> 6909/v_n <> 50/" -e "s/8c050bbe3007457fc85a48b4d04a8459/$FIX_MD5/" "$MIG" > "$TMPD/mig.sql"
eq "S1 a substituição tocou exatamente 2 linhas (as constantes da trava)" "$(diff "$MIG" "$TMPD/mig.sql" | grep -c '^>')" 2
eq "S2 a trava de PROD (6909 + md5 do backup) está na migration real" "$(grep -c "v_n <> 6909 OR v_md5 IS DISTINCT FROM '8c050bbe3007457fc85a48b4d04a8459'" "$MIG")" 1
echo "═══ setup pronto (PG17 :$PORT) ═══"

echo "── asserts ──"
# A1: tabela IGUAL ao backup → dropa
P -q -f "$TMPD/mig.sql" >/dev/null
eq "A1 tabela igual ao backup → dropada" "$(existe)" f
# A2: re-colar com a tabela já dropada → no-op
if P -q -f "$TMPD/mig.sql" >/dev/null 2>&1; then ok "A2 re-colar depois do DROP é no-op"; else bad "A2 2ª colagem falhou"; fi

# A3: 1 linha A MAIS depois do backup → trava, nada dropado
semear
P -q -c "INSERT INTO public._quarantine_omie_clientes_20260722 (user_id, omie_codigo_cliente) VALUES (gen_random_uuid(), 1);"
R=$(P -q -f "$TMPD/mig.sql" 2>&1 || true)
case "$R" in *M18_TRAVA*) ok "A3 linha a mais → M18_TRAVA" ;; *) bad "A3 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
eq "A4 travou sem dropar" "$(existe)" t

# A5: mesmo count, 1 valor alterado → trava pelo md5
semear
P -q -c "UPDATE public._quarantine_omie_clientes_20260722 SET omie_codigo_vendedor = 7 WHERE omie_codigo_cliente = 1010;"
R=$(P -q -f "$TMPD/mig.sql" 2>&1 || true)
case "$R" in *M18_TRAVA*) ok "A5 mesmo count, valor alterado → M18_TRAVA (md5)" ;; *) bad "A5 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
eq "A6 travou sem dropar" "$(existe)" t

# A7: sessão em OUTRO fuso — o SET LOCAL timezone da migration mantém o md5 comparável
semear
R=$(PGTZ=America/Sao_Paulo P -q -f "$TMPD/mig.sql" 2>&1 || true)
eq "A7 sessão em America/Sao_Paulo ainda reconhece o backup e dropa" "$(existe)" f

# ═══ FALSIFICAÇÃO ═══
echo "── falsificação ──"
# F1: espelho SEM a trava → a tabela ALTERADA é dropada (a trava é o que segurava A5)
semear
P -q -c "UPDATE public._quarantine_omie_clientes_20260722 SET omie_codigo_vendedor = 7 WHERE omie_codigo_cliente = 1010;"
awk '/^DO \$pre\$/{pula=1} !pula{print} pula && /^\$pre\$;/{pula=0}' "$TMPD/mig.sql" > "$TMPD/sem-trava.sql"
if grep -q 'M18_TRAVA' "$TMPD/sem-trava.sql"; then bad "F1 o awk não removeu a trava — falsificação não rodou"; else
  P -q -f "$TMPD/sem-trava.sql" >/dev/null 2>&1 || true
  eq "F1 sem a trava a tabela alterada é dropada (A5 tinha dente)" "$(existe)" f
fi
# F2: espelho SEM o SET LOCAL timezone, sessão em outro fuso → a trava dispara à toa (A7 tinha dente)
semear
grep -v "^SET LOCAL timezone = 'UTC';" "$TMPD/mig.sql" > "$TMPD/sem-tz.sql"
if cmp -s "$TMPD/mig.sql" "$TMPD/sem-tz.sql"; then bad "F2 o grep não removeu o SET LOCAL"; else
  R=$(PGTZ=America/Sao_Paulo P -q -f "$TMPD/sem-tz.sql" 2>&1 || true)
  case "$R" in *M18_TRAVA*) ok "F2 sem o SET LOCAL timezone o md5 muda com o fuso e a trava dispara" ;; *) bad "F2 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
