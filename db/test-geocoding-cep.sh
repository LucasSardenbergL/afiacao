#!/usr/bin/env bash
# PG17: prova a migration de geocoding (Sub-PR 1) EXECUTANDO de verdade —
# PL/pgSQL é late-bound, CREATE passa mas a verdade só aparece em runtime.
#
# Parte 1 (Task 1): normalizar_cep + cep_geo/municipio_geo + RLS.
#   N1-N4 normalizar_cep: pontuação / espaço / vazio→NULL / null→NULL
#   C1    cep_geo rejeita CEP != 8 dígitos (CHECK)
#   C2    cep_geo rejeita precision fora do enum (CHECK)
#   R1/R3 authenticated LÊ cep_geo e municipio_geo (grant + policy USING true)
#   R2    anon NÃO lê cep_geo (sem grant → insufficient_privilege)
#
# Falha = vermelho (ON_ERROR_STOP + RAISE EXCEPTION nos asserts). Falsificar:
# sabotar o CHECK de precision → C2 deve ficar VERMELHO; reverter.
set -euo pipefail
export LC_ALL=C LANG=C
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ pg17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55491
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260615190000_geocoding_cep_geo.sql"

echo "=== roles mínimos (Supabase provê em prod) ==="
"${P[@]}" <<'SQL'
CREATE ROLE authenticated;
CREATE ROLE anon;
SQL

echo "=== aplica a migration REAL ==="
"${P[@]}" -f "$MIG" >/dev/null

echo "=== N: normalizar_cep ==="
"${P[@]}" <<'SQL'
DO $$ BEGIN
  IF normalizar_cep('35.500-000') IS DISTINCT FROM '35500000' THEN
    RAISE EXCEPTION 'N1 FAIL: % (esperado 35500000)', normalizar_cep('35.500-000'); END IF;
  RAISE NOTICE 'N1 OK (pontuação tirada)';
  IF normalizar_cep('  35500000 ') IS DISTINCT FROM '35500000' THEN RAISE EXCEPTION 'N2 FAIL'; END IF;
  RAISE NOTICE 'N2 OK (espaços tirados)';
  IF normalizar_cep('') IS NOT NULL THEN RAISE EXCEPTION 'N3 FAIL: vazio deveria ser NULL'; END IF;
  RAISE NOTICE 'N3 OK (vazio → NULL)';
  IF normalizar_cep(NULL) IS NOT NULL THEN RAISE EXCEPTION 'N4 FAIL: null deveria ser NULL'; END IF;
  RAISE NOTICE 'N4 OK (null → NULL)';
END $$;
SQL

echo "=== C: CHECKs do cep_geo (negativos) ==="
"${P[@]}" <<'SQL'
DO $$ BEGIN
  BEGIN
    INSERT INTO cep_geo(cep,lat,lng,source,precision) VALUES ('3550000',-20,-44,'t','street');
    RAISE EXCEPTION 'C1 FAIL: CEP de 7 dígitos foi aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'C1 OK (CEP != 8 díg rejeitado)';
  END;
  BEGIN
    INSERT INTO cep_geo(cep,lat,lng,source,precision) VALUES ('35500000',-20,-44,'t','bogus');
    RAISE EXCEPTION 'C2 FAIL: precision fora do enum foi aceita';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'C2 OK (precision inválida rejeitada)';
  END;
END $$;
SQL

echo "=== R: RLS/grants (positivo + negativo) ==="
"${P[@]}" <<'SQL'
-- seed como superuser (bypassa RLS) p/ provar leitura sob cada role.
-- nota: no PG17 nu, anon nasce sem grants; a prova é o MODELO de grant
-- (authenticated lê; anon não). O REVOKE FROM PUBLIC,anon é belt-and-suspenders
-- p/ a realidade do Supabase (ALTER DEFAULT PRIVILEGES dá grants amplos).
INSERT INTO cep_geo(cep,lat,lng,source,precision)
  VALUES ('35500000',-20.13,-44.88,'seed','postcode_centroid');
INSERT INTO municipio_geo(municipio_codigo,lat,lng,uf,nome)
  VALUES ('3122306',-20.13,-44.88,'MG','Divinópolis');

SET ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM cep_geo) <> 1 THEN RAISE EXCEPTION 'R1 FAIL'; END IF;
  RAISE NOTICE 'R1 OK (authenticated lê cep_geo)';
  IF (SELECT count(*) FROM municipio_geo) <> 1 THEN RAISE EXCEPTION 'R3 FAIL'; END IF;
  RAISE NOTICE 'R3 OK (authenticated lê municipio_geo)';
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM cep_geo;
  RAISE EXCEPTION 'R2 FAIL: anon conseguiu ler cep_geo';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R2 OK (anon barrado)';
END $$;
RESET ROLE;
SQL

echo "✅ Task 1 verde (normalizar_cep + cep_geo/municipio_geo + CHECKs + RLS)"
