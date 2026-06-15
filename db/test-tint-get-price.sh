#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5455}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="tint-get-price"           # nomeia tmp/log deste harness
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Opção (a) MÍNIMO — stub só das tabelas/colunas que a migração toca:
# P -q <<'SQL'
# CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role text);
# CREATE TABLE IF NOT EXISTS public.[[tabela_que_a_migracao_le]] ( ... colunas usadas ... );
# SQL
#
# Opção (b) FIEL — aplica o snapshot inteiro (pega dependências reais; mais lento):
# RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
# sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
#   | grep -vE '^\\(un)?restrict ' > "$RR"
# P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
# P --single-transaction -q -f "$RR"; rm -f "$RR"
# ⚠️ snapshot pode estar STALE — se faltar coluna recente, ALTER TABLE ... ADD COLUMN IF NOT EXISTS antes.
#
P -q <<'SQL'
-- app_role + has_role + user_roles (gate de staff p/ a receita)
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_uid AND role=_role) $f$;

-- tabelas que a RPC lê (só as colunas usadas)
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, valor_unitario numeric, ativo boolean DEFAULT true);
CREATE TABLE public.tint_skus (id uuid PRIMARY KEY, omie_product_id uuid);
CREATE TABLE public.tint_corantes (id uuid PRIMARY KEY, descricao text, volume_total_ml numeric, omie_product_id uuid);
CREATE TABLE public.tint_formulas (id uuid PRIMARY KEY, sku_id uuid);
CREATE TABLE public.tint_formula_itens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), formula_id uuid, corante_id uuid, qtd_ml numeric, ordem int);
SQL


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260615200000_tint_get_price_base.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (semeie como postgres; conceda privilégio p/ os asserts de RLS)
# ══════════════════════════════════════════════════════════════════════════════
# Semeie como postgres (superuser ignora RLS e TEM privilégio). NÃO use SET ROLE service_role p/
# semear: BYPASSRLS ignora a RLS mas NÃO concede GRANT → "permission denied" na tabela.
# A migration do repo é --no-privileges (Supabase concede em runtime); aqui você concede p/ que os
# asserts de RLS (SET ROLE authenticated/anon) leiam — a RLS filtra por cima.
# ⚠️ a policy é avaliada com os privilégios do CALLER: se faz subselect noutra tabela (ex.: user_roles),
#    conceda SELECT nela TAMBÉM, senão a própria policy dá permission denied.
# P -q <<'SQL'
# INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
# INSERT INTO public.[[tabela]] (...) VALUES (...);
# GRANT SELECT ON public.[[tabela]], public.user_roles TO authenticated, anon;
# SQL
#
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- staff (employee)
  ('22222222-2222-2222-2222-222222222222');   -- cliente (sem role)
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee');

-- produtos Omie: base com preço, base ZERADA (PRD03657), corante com preço
INSERT INTO public.omie_products(id, valor_unitario) VALUES
  ('b0000000-0000-0000-0000-000000000001', 449.9),  -- base ok
  ('b0000000-0000-0000-0000-000000000002', 0),       -- base zerada (PRD03657)
  ('b0000000-0000-0000-0000-000000000003', 100);     -- corante (100/1000ml = 0,10/ml)

INSERT INTO public.tint_skus(id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001'),  -- sku base ok
  ('50000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002');   -- sku base zerada

INSERT INTO public.tint_corantes(id, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','Corante OK', 1000, 'b0000000-0000-0000-0000-000000000003'),  -- com custo
  ('c0000000-0000-0000-0000-000000000002','Corante sem Omie', 1000, NULL);                               -- sem custo

INSERT INTO public.tint_formulas(id, sku_id) VALUES
  ('f0000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001'),  -- f_ok: base ok
  ('f0000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000002'),  -- f_zero: base zerada
  ('f0000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000001'),  -- f_pura: base ok, sem corantes
  ('f0000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000001');   -- f_inc: base ok, corante incompleto

INSERT INTO public.tint_formula_itens(formula_id, corante_id, qtd_ml, ordem) VALUES
  -- f_ok: 1135,4ml × 0,10 = 113,54 → precoFinal = 449,90 + 113,54 = 563,44 (= CSV real medido em prod)
  ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001', 1135.4, 1),
  -- f_zero: tem corante, mas a base é zerada → precoFinal NULL
  ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-000000000001', 10, 1),
  -- f_inc: corante OK (10ml × 0,10 = 1,00) + corante sem custo (parcial → precoFinal NULL)
  ('f0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000001', 10, 1),
  ('f0000000-0000-0000-0000-000000000004','c0000000-0000-0000-0000-000000000002', 20, 2);

-- a RPC é SECURITY DEFINER (roda como owner, bypassa RLS das tabelas); basta EXECUTE p/ os asserts de staff
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid) TO authenticated, anon;
SQL


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (positivo / negativo-com-SQLSTATE / RLS) — ver assert-patterns.md
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
# POSITIVO:
#   V=$(Pq -c "SELECT status FROM public.[[...]] WHERE id='...';"); eq "A1 efeito" "$V" "aprovado"
# NEGATIVO (gate/CHECK rejeita — captura a SQLSTATE esperada e re-lança o resto):
#   R=$(P -tA 2>&1 <<'SQL' ... SQL )  ← 2>&1 ESSENCIAL: o RAISE NOTICE da sentinela sai no STDERR
#   ver references/assert-patterns.md (bloco DO ... EXCEPTION WHEN <sqlstate> ... WHEN OTHERS THEN RAISE)
# RLS (own-scope / staff / anon-deny):
#   OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.[[...]];" | tail -1)
#   eq "A2 own-scope" "$OWN" "1"
#
F_OK="f0000000-0000-0000-0000-000000000001"
F_ZERO="f0000000-0000-0000-0000-000000000002"
F_PURA="f0000000-0000-0000-0000-000000000003"
F_INC="f0000000-0000-0000-0000-000000000004"
UID_STAFF="11111111-1111-1111-1111-111111111111"
UID_CLI="22222222-2222-2222-2222-222222222222"
# comparações numéricas (= devolve t/f) p/ não depender da formatação do numeric->text

# P1 — base + corantes completos → precoFinal = base + corantes (o coração)
V=$(Pq -c "SELECT ((public.get_tint_price('$F_OK'::uuid)->>'precoFinal')::numeric = 563.44);")
eq "P1 precoFinal = base+corantes (563,44 = CSV real)" "$V" "t"
V=$(Pq -c "SELECT ((public.get_tint_price('$F_OK'::uuid)->>'custoBase')::numeric = 449.9);")
eq "P1b custoBase = preço da base" "$V" "t"
V=$(Pq -c "SELECT (public.get_tint_price('$F_OK'::uuid)->>'baseDisponivel');")
eq "P1c baseDisponivel = true" "$V" "true"
V=$(Pq -c "SELECT (public.get_tint_price('$F_OK'::uuid)->>'corantesCompletos');")
eq "P1d corantesCompletos = true" "$V" "true"

# P2 — base pura (sem corantes) → precoFinal = base
V=$(Pq -c "SELECT ((public.get_tint_price('$F_PURA'::uuid)->>'precoFinal')::numeric = 449.9);")
eq "P2 base pura → precoFinal = base" "$V" "t"
V=$(Pq -c "SELECT ((public.get_tint_price('$F_PURA'::uuid)->>'custoCorantes')::numeric = 0);")
eq "P2b base pura → custoCorantes = 0" "$V" "t"

# N1 — base zerada (PRD03657) → custoBase/precoFinal NULL (ausente != zero)
V=$(Pq -c "SELECT (public.get_tint_price('$F_ZERO'::uuid)->>'precoFinal') IS NULL;")
eq "N1 base zerada → precoFinal NULL (não vende só-corantes)" "$V" "t"
V=$(Pq -c "SELECT (public.get_tint_price('$F_ZERO'::uuid)->>'custoBase') IS NULL;")
eq "N1b base zerada → custoBase NULL (não fabrica 0)" "$V" "t"
V=$(Pq -c "SELECT (public.get_tint_price('$F_ZERO'::uuid)->>'baseDisponivel');")
eq "N1c base zerada → baseDisponivel false" "$V" "false"

# N2 — algum corante sem custo → corantesCompletos false, precoFinal NULL, custoCorantes parcial
V=$(Pq -c "SELECT (public.get_tint_price('$F_INC'::uuid)->>'precoFinal') IS NULL;")
eq "N2 corante incompleto → precoFinal NULL (não subfatura)" "$V" "t"
V=$(Pq -c "SELECT (public.get_tint_price('$F_INC'::uuid)->>'corantesCompletos');")
eq "N2b corante incompleto → corantesCompletos false" "$V" "false"
V=$(Pq -c "SELECT ((public.get_tint_price('$F_INC'::uuid)->>'custoCorantes')::numeric = 1.0);")
eq "N2c corante incompleto → custoCorantes mostra parcial (1,00)" "$V" "t"

# P3 — itensCorantes (a receita) só para staff (hardening preservado)
ST=$(Pq -c "SET test.uid='$UID_STAFF'; SET ROLE authenticated; SELECT jsonb_array_length(public.get_tint_price('$F_OK'::uuid)->'itensCorantes');" | tail -1)
eq "P3 staff vê a receita (itensCorantes)" "$ST" "1"
CL=$(Pq -c "SET test.uid='$UID_CLI'; SET ROLE authenticated; SELECT jsonb_array_length(public.get_tint_price('$F_OK'::uuid)->'itensCorantes');" | tail -1)
eq "P3b cliente NÃO vê a receita" "$CL" "0"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Padrão (ver assert-patterns.md p/ a versão completa, incl. sentinela anti-teatro):
#   1. sabota:   recria a policy/trigger/função NA VERSÃO FURADA
#   2. re-roda:  o MESMO assert do passo 4
#   3. exige:    que ele agora FALHE (se passar → assert fraco → conserte)
#   4. restaura: a versão verdadeira (cirurgicamente, só o que sabotou)
#
echo "── falsificação ──"

# F1 — SABOTA a base: recria a RPC na versão ANTIGA (custoBase=0, precoFinal=só corantes).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_cc numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN op.valor_unitario IS NOT NULL AND c.volume_total_ml>0
              THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) INTO v_cc
  FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id
  LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=p_formula_id;
  RETURN jsonb_build_object('custoBase',0,'precoFinal',v_cc,'baseDisponivel',true,'corantesCompletos',true);
END; $fn$;
SQL
V=$(Pq -c "SELECT ((public.get_tint_price('$F_OK'::uuid)->>'precoFinal')::numeric = 563.44);")
if [ "$V" = "f" ]; then ok "F1 base sabotada → P1 ficou vermelho (o assert pega a base)"; else bad "F1 sabotei a base e P1 seguiu verde → P1 é fraco"; fi
V=$(Pq -c "SELECT (public.get_tint_price('$F_ZERO'::uuid)->>'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F1b base sabotada → N1 ficou vermelho (base zerada deixou de ser NULL)"; else bad "F1b sabotei a base e N1 seguiu verde → N1 é fraco"; fi
P -q -f "$MIG"   # restaura

# F2 — SABOTA a blindagem do corante: precoFinal soma mesmo com corante incompleto.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_bp numeric; v_bd boolean; v_cb numeric; v_cc numeric;
BEGIN
  SELECT op.valor_unitario INTO v_bp FROM tint_formulas f
  LEFT JOIN tint_skus s ON s.id=f.sku_id LEFT JOIN omie_products op ON op.id=s.omie_product_id WHERE f.id=p_formula_id;
  v_bd := v_bp IS NOT NULL AND v_bp>0; v_cb := CASE WHEN v_bd THEN v_bp ELSE NULL END;
  SELECT COALESCE(SUM(CASE WHEN op.valor_unitario IS NOT NULL AND c.volume_total_ml>0
              THEN fi.qtd_ml*op.valor_unitario/c.volume_total_ml ELSE 0 END),0) INTO v_cc
  FROM tint_formula_itens fi LEFT JOIN tint_corantes c ON c.id=fi.corante_id
  LEFT JOIN omie_products op ON op.id=c.omie_product_id WHERE fi.formula_id=p_formula_id;
  -- SABOTADO: ignora corantesCompletos (soma mesmo faltando custo de corante)
  RETURN jsonb_build_object('precoFinal', CASE WHEN v_bd THEN v_cb+v_cc ELSE NULL END, 'corantesCompletos', false);
END; $fn$;
SQL
V=$(Pq -c "SELECT (public.get_tint_price('$F_INC'::uuid)->>'precoFinal') IS NULL;")
if [ "$V" = "f" ]; then ok "F2 blindagem sabotada → N2 ficou vermelho (o assert pega o corante)"; else bad "F2 sabotei a blindagem e N2 seguiu verde → N2 é fraco"; fi
P -q -f "$MIG"   # restaura


# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
