#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — DROP da RPC órfã omie_cliente_upsert_mapping (money-path)       ║
# ║  Migration: supabase/migrations/20260718091409_drop_omie_cliente_upsert_...   ║
# ║  Rode:  bash db/test-drop-omie-cliente-upsert-mapping.sh > /tmp/t.log 2>&1    ║
# ║                                                                                ║
# ║  Prova: (1) a migration REMOVE a função; (2) é IDEMPOTENTE (re-colar não      ║
# ║  quebra na mão do founder); (3) NÃO toca dados de omie_clientes; e FALSIFICA  ║
# ║  o guard de overload — com um overload presente, a migration TEM de FALHAR.   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="drop-upsert-mapping"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup (PG17 :$PORT) ═══"

MIG="$REPO_ROOT/supabase/migrations/20260718091409_drop_omie_cliente_upsert_mapping_orfa.sql"
[ -f "$MIG" ] || { echo "migration não encontrada: $MIG"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — reproduzir o estado da PROD: a tabela + a função órfã (corpo verbatim)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.omie_clientes (
  user_id              uuid,
  empresa_omie         text DEFAULT 'colacor',
  omie_codigo_cliente  bigint,
  omie_codigo_vendedor bigint
);
CREATE UNIQUE INDEX unique_user_omie ON public.omie_clientes(user_id);

CREATE OR REPLACE FUNCTION public.omie_cliente_upsert_mapping(p_user_id uuid, p_empresa text, p_codigo_cliente bigint, p_codigo_vendedor bigint)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_existing_codigo bigint; v_owner uuid;
BEGIN
  IF p_user_id IS NULL OR p_empresa IS NULL OR p_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'omie_cliente_upsert_mapping: argumentos obrigatorios nulos' USING ERRCODE = '22004';
  END IF;
  SELECT omie_codigo_cliente INTO v_existing_codigo FROM public.omie_clientes
    WHERE user_id = p_user_id AND empresa_omie = p_empresa;
  IF FOUND THEN
    IF v_existing_codigo = p_codigo_cliente THEN RETURN 'noop'; END IF;
    RETURN 'contested';
  END IF;
  INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente, omie_codigo_vendedor)
    VALUES (p_user_id, p_empresa, p_codigo_cliente, p_codigo_vendedor);
  RETURN 'inserted';
EXCEPTION WHEN unique_violation THEN RETURN 'contested';
END; $function$;

-- dado de negócio que NÃO pode ser tocado pelo DROP
INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente)
VALUES ('11111111-1111-1111-1111-111111111111', 'colacor', 4242);
SQL

eq "pré-condição: função existe antes da migration" \
   "$(Pq -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='omie_cliente_upsert_mapping'")" "1"
eq "pré-condição: 1 linha de dado em omie_clientes" \
   "$(Pq -c "select count(*) from public.omie_clientes")" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplicar a migration REAL (Lei #1: a migration do repo, não uma cópia)
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 2 — apply da migration real ═══"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "migration aplicou sem erro"; else bad "migration FALHOU no apply"; fi

eq "a função ÓRFÃ sumiu" \
   "$(Pq -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='omie_cliente_upsert_mapping'")" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — NÃO-DANO: DROP FUNCTION não pode tocar dados nem a tabela
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 3 — não-dano ═══"
eq "omie_clientes continua existindo" \
   "$(Pq -c "select count(*) from information_schema.tables where table_schema='public' and table_name='omie_clientes'")" "1"
eq "o dado de negócio está intacto" \
   "$(Pq -c "select omie_codigo_cliente from public.omie_clientes where user_id='11111111-1111-1111-1111-111111111111'")" "4242"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — IDEMPOTÊNCIA: o founder pode re-colar sem quebrar
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 4 — idempotência (re-colar) ═══"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "2ª aplicação não quebra (IF EXISTS)"; else bad "2ª aplicação FALHOU — não é idempotente"; fi
if P -q -f "$MIG" >/dev/null 2>&1; then ok "3ª aplicação idem"; else bad "3ª aplicação FALHOU"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: com um OVERLOAD presente, o guard TEM de falhar (vermelho).
# Sem isto o `DO $$ … RAISE EXCEPTION` é teatro: nunca provado que dispara.
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 5 — FALSIFICAÇÃO do guard de overload ═══"
P -q <<'SQL'
-- overload de assinatura DIFERENTE: o DROP por assinatura NÃO o alcança
CREATE FUNCTION public.omie_cliente_upsert_mapping(p_user_id uuid, p_empresa text)
 RETURNS text LANGUAGE sql AS $f$ SELECT 'sobrevivi'::text $f$;
SQL

if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "FALSIFICAÇÃO FALHOU: a migration passou VERDE com overload sobrevivente — o guard é teatro"
else
  ok "guard DISPAROU (vermelho) com overload sobrevivente — detecta DROP incompleto"
fi

eq "o overload de fato sobreviveu ao DROP-por-assinatura (o guard é necessário)" \
   "$(Pq -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='omie_cliente_upsert_mapping'")" "1"

echo ""
echo "═══════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
