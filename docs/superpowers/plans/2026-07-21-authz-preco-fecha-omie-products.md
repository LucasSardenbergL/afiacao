# Fechar a escrita em `omie_products` — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tirar o preço de tabela (`omie_products.valor_unitario`) e o `TRUNCATE` do catálogo do alcance do role `employee`, sem quebrar leitura nem o sync.

**Architecture:** Uma migration que revoga o privilégio de escrita de `PUBLIC`/`anon`/`authenticated`, devolve `GRANT SELECT` a `authenticated`, e substitui a policy `FOR ALL` por uma única policy de `SELECT` com o gate de hoje reproduzido byte a byte. Nenhuma policy de escrita: os únicos writers são 6 edges com `service_role`, que bypassa RLS e tem grant próprio. Prova em PG17 descartável com baseline pré-migration, controle positivo e falsificação.

**Tech Stack:** PostgreSQL 17 local (`/opt/homebrew/opt/postgresql@17`), bash, `db/stubs-supabase.sql`, `psql-ro` para pré-flight/validação em prod.

## Global Constraints

- **Idioma:** pt-BR em código, comentários, commits e PR.
- **Migration é imutável depois de committada** (hook `migration-immutability-guard.sh`). Correção vira arquivo novo em `db/`.
- **Nunca `SET LOCAL`** em harness psql — em autocommit vira `WARNING` e roda como superuser, que bypassa RLS (#1434). Sempre `SET ROLE` + guard de `current_user`.
- **Migration aplicada com `-f`, nunca `-c` com heredoc** — o psql descarta o stdin em silêncio e a falsificação passa a medir o objeto original (2026-07-19, Fatia 5B).
- **Assert nunca ancora em string vazia** — estados têm de ser mutuamente distinguíveis (#1380).
- **`cmd | tail` engole o exit code** → `> log 2>&1; echo $?`.
- **Comandos pesados prefixados com `heavy`** (semáforo de RAM da M2 8GB).
- Timestamp da migration: **`20260727120000`** (maior em qualquer branch remota é `20260726160000`).
- Nome da policy nova: **`omie_products_select_staff`**. Nome da antiga a remover: **`"Staff can manage products"`**.

---

### Task 1: A migration

**Files:**
- Create: `supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql`

**Interfaces:**
- Consumes: nada (primeira tarefa).
- Produces: a migration que as Tasks 2–4 aplicam com `P -q -f "$MIG"`. A policy criada chama-se `omie_products_select_staff`; a removida, `"Staff can manage products"`.

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql`:

```sql
-- Fecha a ESCRITA em public.omie_products — o preço de tabela sai do alcance do `employee`.
--
-- ESTADO MEDIDO EM PROD (psql-ro, 2026-07-21):
--   · UMA policy, FOR ALL, para {authenticated}:
--       "Staff can manage products"
--         USING/WITH CHECK ( SELECT (has_role((SELECT auth.uid()),'master')
--                                 OR has_role((SELECT auth.uid()),'employee')) )
--     => qualquer employee (hoje 2 vendedoras, ambas commercial_role=farmer) da UPDATE em
--        valor_unitario, o PRECO DE TABELA.
--   · relacl: authenticated=arwdDxtm E anon=arwdDxtm. O `D` e TRUNCATE, que NAO passa por RLS:
--     trocar policy nao revoga GRANT. Sem REVOKE, o mesmo employee apaga os 7.966 SKUs.
--   · 7.966 linhas; 1.942 com valor_unitario=0; 6.024 positivos.
--
-- WRITERS (enumerados no codigo, 2026-07-21): omie-vendas-sync, omie-analytics-sync,
-- sync-reprocess, tint-omie-sync, omie-sync-metadados, omie-sync-status-produtos — TODAS edges
-- com SERVICE_ROLE_KEY. service_role bypassa RLS e tem grant proprio, entao revogar de
-- authenticated/anon NAO toca o sync. Nenhum writer roda como `authenticated`.
-- A unica funcao SQL que escreve, tint_marcar_bases_mixmachine, e SECURITY DEFINER (bypassa RLS)
-- e nao toca valor_unitario.
--
-- NAO HA UI DE EDICAO DE PRECO: todos os hits de valor_unitario em src/ sao leitura. O unico
-- onUpdate(...,'valor_unitario',...) e de sales_order_items (item do pedido), outra tabela.
--
-- ESCOPO: escrita. A LEITURA fica IDENTICA a de hoje (master OR employee), inclusive o wrap de
-- InitPlan. Nao ha policy de escrita de proposito — nem employee nem master escrevem via API.
-- private.cap_preco_escrever(uuid) existe em prod e e master-only; se um dia houver UI de
-- correcao manual pelo master, o caminho e GRANT UPDATE + policy com ela. Ate la, YAGNI.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDICAO — aborta se aparecer policy que este desenho nao conhece.
-- Policies permissivas combinam com OR: se uma sessao paralela criou outra policy, o
-- DROP+CREATE daqui a deixaria VIVA e o gate NAO fecharia. Idempotente nos dois sentidos —
-- na 1a rodada so a antiga existe, na 2a so a nova.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  v_desconhecidas int;
  v_nomes         text;
BEGIN
  SELECT count(*), COALESCE(string_agg(policyname, ', '), '')
    INTO v_desconhecidas, v_nomes
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename  = 'omie_products'
    AND policyname NOT IN ('Staff can manage products', 'omie_products_select_staff');

  IF v_desconhecidas <> 0 THEN
    RAISE EXCEPTION
      'precondicao FALHOU: % policy(s) inesperada(s) em omie_products (%). Permissivas combinam com OR — fechar so as conhecidas NAO fecha o gate. Reconcilie antes de aplicar.',
      v_desconhecidas, v_nomes;
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. GRANTS. Trocar policy NAO mexe em GRANT, e TRUNCATE/REFERENCES/TRIGGER nao passam por RLS.
--    REVOKE de PUBLIC e no-op util aqui: o Supabase concede por NOME (default privilege).
--    service_role NAO e tocado — e o writer.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.omie_products FROM PUBLIC;
REVOKE ALL ON TABLE public.omie_products FROM anon;
REVOKE ALL ON TABLE public.omie_products FROM authenticated;

-- SELECT volta para authenticated porque a RLS e que decide QUEM le (policy abaixo).
-- Sem o grant, a negacao viria do PRIVILEGIO, a policy nunca seria exercida e o assert de RLS
-- viraria tautologia — o P3 da rodada 2 do Codex no #1488.
GRANT SELECT ON TABLE public.omie_products TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. POLICIES. A FOR ALL sai; entra UMA de leitura com o gate IDENTICO ao de hoje.
--    Escrita fica sem policy de proposito (ver cabecalho).
--    Schema qualificado p/ nao depender do search_path do SQL Editor; o objeto resultante e o
--    mesmo (policies guardam a expressao por OID depois de criadas — licao #1427).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage products" ON public.omie_products;
DROP POLICY IF EXISTS omie_products_select_staff  ON public.omie_products;

CREATE POLICY omie_products_select_staff ON public.omie_products
  FOR SELECT
  TO authenticated
  USING ((SELECT (public.has_role((SELECT auth.uid()), 'master'::public.app_role)
               OR public.has_role((SELECT auth.uid()), 'employee'::public.app_role))));

ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

COMMENT ON POLICY omie_products_select_staff ON public.omie_products IS
  'Leitura do catalogo por staff (master OR employee) — gate IDENTICO ao da policy "Staff can manage products" que substituiu. A diferenca e a ESCRITA: aquela era FOR ALL e deixava qualquer employee reescrever valor_unitario (o preco de tabela) e dar TRUNCATE. Escrita agora e exclusiva de service_role (as 6 edges de sync); nao ha policy de escrita.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ASSERTS DE APLICACAO — dentro da transacao; qualquer um falha, tudo volta.
--    Nao substituem o harness (db/test-authz-preco-omie-products.sh); pegam o caso em que a
--    PROD divergiu do que este arquivo assumiu.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_antigas    int;
  v_n_policies int;
  v_rls        boolean;
BEGIN
  SELECT count(*) INTO v_antigas
  FROM pg_policies
  WHERE schemaname='public' AND tablename='omie_products'
    AND policyname = 'Staff can manage products';
  IF v_antigas <> 0 THEN
    RAISE EXCEPTION 'A1 FALHOU: a policy antiga sobreviveu — permissivas combinam com OR, o gate nao fechou';
  END IF;

  SELECT count(*) INTO v_n_policies
  FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';
  IF v_n_policies <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava exatamente 1 policy em omie_products, encontrei %', v_n_policies;
  END IF;

  IF has_table_privilege('authenticated','public.omie_products','TRUNCATE') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated ainda tem TRUNCATE (nao passa por RLS — apagaria os 7.966 SKUs)';
  END IF;

  IF has_table_privilege('authenticated','public.omie_products','INSERT')
     OR has_table_privilege('authenticated','public.omie_products','UPDATE')
     OR has_table_privilege('authenticated','public.omie_products','DELETE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated ainda tem escrita em omie_products';
  END IF;

  IF has_table_privilege('anon','public.omie_products','SELECT')
     OR has_table_privilege('anon','public.omie_products','TRUNCATE') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon ainda tem privilegio em omie_products';
  END IF;

  IF NOT has_table_privilege('authenticated','public.omie_products','SELECT') THEN
    RAISE EXCEPTION 'A6 FALHOU: authenticated perdeu SELECT — a policy nunca seria exercida e o gate viraria tautologia';
  END IF;

  IF NOT has_table_privilege('service_role','public.omie_products','INSERT')
     OR NOT has_table_privilege('service_role','public.omie_products','UPDATE') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role perdeu escrita — as 6 edges de sync do Omie quebrariam';
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid='public.omie_products'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'A8 FALHOU: RLS desabilitada em omie_products';
  END IF;

  RAISE NOTICE 'omie_products fechada: 1 policy (SELECT staff), authenticated sem escrita, anon zerado, service_role intacto';
END
$post$;

COMMIT;
```

- [ ] **Step 2: Verificar que o arquivo é sintaticamente válido (não aplica ainda)**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && /opt/homebrew/opt/postgresql@17/bin/psql --version && test -f supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql && echo "ARQUIVO OK"
```
Expected: versão do psql 17.x seguida de `ARQUIVO OK`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql
git commit -m "feat(authz): migration fecha escrita em omie_products — preço de tabela master-only [money-path]"
```

---

### Task 2: Harness — stubs espelhando prod + baseline pré-migration

**Files:**
- Create: `db/test-authz-preco-omie-products.sh`

**Interfaces:**
- Consumes: `supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql` (Task 1), `db/stubs-supabase.sql`.
- Produces: as funções bash `guard_role`, `le`, `escreve`, `escreve_service`, `eq`, `ok`, `bad`, e as variáveis `$M` (master), `$F` (farmer), `$CU` (customer) que as Tasks 3 e 4 usam.

Este é o passo onde o teste pode mentir de forma mais cara: um stub **menos permissivo que a prod inventa segurança que não existe**. Os `GRANT` abaixo reproduzem o `relacl` real (`arwdDxtm` para anon E authenticated).

- [ ] **Step 1: Escrever o cabeçalho, setup do PG17 e os stubs**

Criar `db/test-authz-preco-omie-products.sh`:

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2016  # os comandos passados a `falsifica` sao strings avaliadas DEPOIS da
#                              sabotagem: a expansao TEM de ser adiada, entao aspas simples e o
#                              desenho, nao um descuido.
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  Fecha a ESCRITA em omie_products — prova PG17 de 20260727120000                      ║
# ║   bash db/test-authz-preco-omie-products.sh > log 2>&1; echo "exit=$?"                ║
# ║  (NAO pipe pra tail — engole o exit != 0.)                                             ║
# ║                                                                                        ║
# ║  DISCIPLINA APLICADA (licoes caras do repo):                                           ║
# ║   · BASELINE PRE-MIGRATION: provo que o farmer ESCREVE em valor_unitario ANTES. Sem    ║
# ║     isso, "nao escreve depois" e indistinguivel de "o UPDATE esta quebrado" (#1488).   ║
# ║   · CONTROLE POSITIVO: service_role executa o MESMO UPDATE na MESMA linha, com exito,  ║
# ║     na mesma rodada. Sem ele, "ninguem escreve nada" passaria como sucesso.            ║
# ║   · A LEITURA TEM DE SOBREVIVER: fechar escrita apagando o catalogo do staff seria     ║
# ║     regressao, nao sucesso.                                                            ║
# ║   · SET ROLE (nao SET LOCAL — em autocommit vira WARNING e roda como superuser, que    ║
# ║     BYPASSA RLS e deixa a zona inteira falso-verde), + guard de current_user.          ║
# ║   · Estados de escrita MUTUAMENTE DISTINGUIVEIS (OK/RLS0/DENIED), nunca string vazia   ║
# ║     (#1380: assert que compara com "" passa ate sem gate nenhum).                      ║
# ║   · migration aplicada com -f, NUNCA -c com heredoc (o psql descarta o stdin em        ║
# ║     silencio e a falsificacao passa a medir o objeto original).                        ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="precoomie"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260727120000_authz_preco_fecha_omie_products.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

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
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

M='11111111-1111-1111-1111-111111111111'   # master
F='22222222-2222-2222-2222-222222222222'   # farmer   (employee + commercial_role=farmer) = Regina/Tatyana
CU='66666666-6666-6666-6666-666666666666'  # customer (nao-staff)

# guard: se o SET ROLE nao pegar, TODA a zona de RLS roda como superuser (bypassa) e fica
# falso-verde. Aborta em vez de "passar". Chamado por `le` e `escreve` antes de cada medicao.
guard_role() { # $1=uid
  local got
  got="$(Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT current_user;" | tail -1)"
  [ "$got" = "authenticated" ] || { echo "ABORT: SET ROLE nao pegou (current_user=$got)"; exit 9; }
}

# Tenta escrever valor_unitario do SKU P1 como <uid>. Devolve TRES estados mutuamente
# distinguiveis — nunca string vazia (#1380):
#   OK     = escreveu (grant presente E policy permitiu)
#   RLS0   = grant presente, mas a RLS barrou (0 linhas)
#   DENIED = o PRIVILEGIO negou (42501) — o REVOKE mordeu
# O CTE forca linha de resultado mesmo quando o UPDATE afeta 0 (senao viria vazio).
escreve() { # $1=uid  $2=valor
  local out
  guard_role "$1"
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET test.uid='$1'; SET ROLE authenticated;
            WITH u AS (UPDATE public.omie_products SET valor_unitario=$2 WHERE codigo='P1' RETURNING 1)
            SELECT count(*)::text FROM u;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    *1)                    echo "OK" ;;
    *0)                    echo "RLS0" ;;
    *)                     echo "INESPERADO:$out" ;;
  esac
}

# Le o catalogo como <uid>. Mesma disciplina de `escreve`: estados distinguiveis, nunca vazio.
#   <n>    = leu n linhas (grant presente E policy permitiu)
#   DENIED = o PRIVILEGIO negou (42501) — util na S3, onde o REVOKE de SELECT e a sabotagem
le() { # $1=uid
  local out
  guard_role "$1"
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET test.uid='$1'; SET ROLE authenticated;
            SELECT count(*)::text FROM public.omie_products;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    ''|*[!0-9]*)           echo "INESPERADO:$out" ;;
    *)                     echo "$out" ;;
  esac
}

# CONTROLE POSITIVO: o MESMO UPDATE, na MESMA linha, como service_role. Tem de dar OK sempre —
# se der outra coisa, a negacao do farmer nao prova gate, prova ambiente quebrado.
escreve_service() { # $1=valor
  local out
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q -tA \
        -c "SET ROLE service_role;
            WITH u AS (UPDATE public.omie_products SET valor_unitario=$1 WHERE codigo='P1' RETURNING 1)
            SELECT count(*)::text FROM u;" 2>&1)" || true
  case "$out" in
    *"permission denied"*) echo "DENIED" ;;
    *1)                    echo "OK" ;;
    *0)                    echo "RLS0" ;;
    *)                     echo "INESPERADO:$out" ;;
  esac
}

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — STUBS ESPELHANDO A PROD (money-path.md: "espelhe a PROD, nao o design")
# A policy e os GRANTs sao VERBATIM de pg_policies / relacl em prod (psql-ro, 2026-07-21).
# Stub menos permissivo que a prod inventa seguranca que nao existe.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid PRIMARY KEY, commercial_role public.commercial_role NOT NULL);

CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_uid AND ur.role=_role);
$f$;

-- VERBATIM de prod (2026-07-21) — master-only. Nao e usada por esta migration (opcao (i) do
-- spec §3.2), mas fica no stub porque o Codex vai perguntar por ela e porque a falsificacao S5
-- prova que ela NAO foi acidentalmente ligada ao caminho de escrita.
CREATE FUNCTION private.cap_preco_escrever(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$f$;

-- Colunas relevantes de prod (20 no total; aqui as que o gate e os asserts tocam)
CREATE TABLE public.omie_products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo         text NOT NULL,
  descricao      text NOT NULL,
  valor_unitario numeric NOT NULL DEFAULT 0,
  estoque        numeric DEFAULT 0,
  ativo          boolean NOT NULL DEFAULT true,
  account        text NOT NULL DEFAULT 'oben',
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

-- relacl REAL da prod: arwdDxtm p/ anon E authenticated (o D e TRUNCATE, que ignora RLS)
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.omie_products TO anon, authenticated, service_role;

-- a policy VERBATIM de pg_policies (2026-07-21): FOR ALL, {authenticated}, com wrap de InitPlan
CREATE POLICY "Staff can manage products" ON public.omie_products
  FOR ALL TO authenticated
  USING      ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));

INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('66666666-6666-6666-6666-666666666666','customer');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('22222222-2222-2222-2222-222222222222','farmer');

INSERT INTO public.omie_products(codigo, descricao, valor_unitario) VALUES
  ('P1','Produto 1 — o alvo dos UPDATEs', 100),
  ('P2','Produto 2',  50),
  ('P3','Produto 3',  40);
SQL
```

- [ ] **Step 2: Acrescentar a Zona 2 (baseline pré-migration)**

Anexar ao mesmo arquivo:

```bash
# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — BASELINE PRE-MIGRATION
# Prova que o DETECTOR enxerga o mundo VIVO. Sem isto, "farmer nao escreve" depois seria
# indistinguivel de "o UPDATE esta quebrado" (licao #1488).
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 2: baseline PRE-migration (o buraco existe mesmo?) ==="
eq "B1 farmer ESCREVE valor_unitario hoje (O BURACO)"  "$(escreve "$F" 999)"  "OK"
eq "B2 master escreve hoje"                            "$(escreve "$M" 998)"  "OK"
eq "B3 customer NAO escreve (gate de identidade ja ok)" "$(escreve "$CU" 997)" "RLS0"
eq "B4 farmer LE o catalogo hoje"                      "$(le "$F")" "3"
eq "B5 master LE o catalogo hoje"                      "$(le "$M")" "3"
eq "B6 authenticated TEM TRUNCATE antes (o D do arwdDxtm)" "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','TRUNCATE');")" "t"
eq "B7 anon TEM SELECT antes"                          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','SELECT');")" "t"
eq "B8 anon TEM UPDATE antes"                          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','UPDATE');")" "t"
eq "B9 existe 1 policy (a FOR ALL)"                    "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "1"
eq "B10 CONTROLE POSITIVO: service_role escreve"       "$(escreve_service 100)" "OK"
```

- [ ] **Step 3: Rodar o baseline e conferir que passa**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && heavy bash db/test-authz-preco-omie-products.sh > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t2.log 2>&1; echo "exit=$?"; cat /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t2.log
```
Expected: `exit=0`, com 10 linhas `OK` (B1–B10) e **zero** `FAIL`. **B1 tem de vir `OK`** — se vier `RLS0` ou `DENIED`, o stub não reproduziu o buraco de prod e todo o resto do harness seria teatro.

- [ ] **Step 4: Commit**

```bash
git add db/test-authz-preco-omie-products.sh
git commit -m "test(authz): harness PG17 — stubs de prod + baseline provando que o farmer escreve preço hoje"
```

---

### Task 3: Harness — aplicar a migration e provar o fechamento

**Files:**
- Modify: `db/test-authz-preco-omie-products.sh` (anexar Zonas 3 e 4)

**Interfaces:**
- Consumes: `le`, `escreve`, `escreve_service`, `eq`, `$M`, `$F`, `$CU`, `$MIG` (Task 2).
- Produces: a variável `BASE_PASS` (contagem de asserts verdes) que a Task 4 usa para confirmar que o baseline estava verde antes de falsificar.

- [ ] **Step 1: Anexar Zona 3 (aplica a migration, com prova de idempotência)**

```bash
# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — APLICA A MIGRATION REAL (-f, nunca -c com heredoc)
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 3: aplica 20260727120000 ==="
P -q -f "$MIG" >/dev/null
echo "  aplicada"
P -q -f "$MIG" >/dev/null   # idempotencia: a 2a aplicacao nao pode abortar
echo "  reaplicada (idempotente)"
```

- [ ] **Step 2: Anexar Zona 4 (asserts pós-migration)**

```bash
# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — O FECHAMENTO
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 4: pos-migration ==="
# — catalogo —
eq "A1 policy antiga morreu"        "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products' AND policyname='Staff can manage products';")" "0"
eq "A2 exatamente 1 policy"         "$(Pq -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "1"
eq "A2b e ela e FOR SELECT"         "$(Pq -c "SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename='omie_products';")" "SELECT"
eq "A3 authenticated SEM TRUNCATE"  "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','TRUNCATE');")" "f"
eq "A4a authenticated SEM UPDATE"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','UPDATE');")" "f"
eq "A4b authenticated SEM INSERT"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','INSERT');")" "f"
eq "A4c authenticated SEM DELETE"   "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','DELETE');")" "f"
eq "A5a anon SEM SELECT"            "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','SELECT');")" "f"
eq "A5b anon SEM TRUNCATE"          "$(Pq -c "SELECT has_table_privilege('anon','public.omie_products','TRUNCATE');")" "f"
eq "A6 authenticated MANTEM SELECT (anti-tautologia)" "$(Pq -c "SELECT has_table_privilege('authenticated','public.omie_products','SELECT');")" "t"
eq "A7a service_role MANTEM UPDATE" "$(Pq -c "SELECT has_table_privilege('service_role','public.omie_products','UPDATE');")" "t"
eq "A7b service_role MANTEM INSERT" "$(Pq -c "SELECT has_table_privilege('service_role','public.omie_products','INSERT');")" "t"
eq "A8 RLS habilitada"              "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_products'::regclass;")" "t"

# — comportamento: e aqui que o fechamento se prova, nao no catalogo —
echo "  --- comportamento ---"
eq "A9 farmer NAO escreve mais (O FECHO)"  "$(escreve "$F" 111)"  "DENIED"
eq "A10 master TAMBEM nao escreve (opcao (i) do spec, distingue da (ii))" "$(escreve "$M" 222)" "DENIED"
eq "A11 farmer AINDA LE (leitura preservada)" "$(le "$F")"  "3"
eq "A12 master AINDA LE"                      "$(le "$M")"  "3"
eq "A13 customer segue sem ler"               "$(le "$CU")" "0"

# — CONTROLE POSITIVO: sem isto, A9/A10 passariam num mundo onde NADA funciona —
eq "A14 CONTROLE POSITIVO: service_role escreve a MESMA linha" "$(escreve_service 333)" "OK"
eq "A14b e o valor mudou de verdade"  "$(Pq -c "SELECT valor_unitario::int FROM public.omie_products WHERE codigo='P1';")" "333"

echo
echo "=== BASELINE: ${PASS} OK / ${FAIL} FAIL ==="
[ "$FAIL" -eq 0 ] || { echo "BASELINE VERMELHO -- nao faz sentido falsificar"; exit 1; }
BASE_PASS=$PASS
```

- [ ] **Step 3: Rodar e conferir**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && heavy bash db/test-authz-preco-omie-products.sh > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t3.log 2>&1; echo "exit=$?"; cat /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t3.log
```
Expected: `exit=0`, `BASELINE: 30 OK / 0 FAIL` (10 do B + 20 do A). Conferir explicitamente que **A9 e A10 vieram `DENIED`** (não `RLS0` — `RLS0` significaria que o grant sobreviveu e só a policy barrou, que é um fechamento mais fraco do que o desenhado).

- [ ] **Step 4: Commit**

```bash
git add db/test-authz-preco-omie-products.sh
git commit -m "test(authz): prova o fechamento — farmer e master DENIED, leitura preservada, service_role intacto"
```

---

### Task 4: Harness — falsificação

**Files:**
- Modify: `db/test-authz-preco-omie-products.sh` (anexar Zona 5)

**Interfaces:**
- Consumes: `BASE_PASS`, `le`, `escreve`, `escreve_service`, `$MIG`, `$M`, `$F` (Tasks 2–3).
- Produces: nada (última zona do harness).

Assert que sobrevive à sabotagem não tem dente. Cada sabotagem exige o vermelho **do assert que ela mira**, com o valor conferido — `exit != 0` não distingue "pegou o bug" de "o comando quebrou".

- [ ] **Step 1: Anexar a Zona 5**

```bash
# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "=== ZONA 5: falsificacao ==="
FALS=0
falsifica() { # $1=nome  $2=sql da sabotagem  $3=assert  $4=esperado_sabotado
  local got
  P -q -c "$2" >/dev/null 2>&1 || { echo "  FAIL [$1] a sabotagem nem aplicou"; FAIL=$((FAIL+1)); return; }
  got="$(eval "$3")"
  if [ "$got" = "$4" ]; then echo "  OK   [$1] o assert FICOU VERMELHO (veio [$got])"; FALS=$((FALS+1))
  else echo "  FAIL [$1] o assert NAO reagiu -- veio [$got], esperava a sabotagem produzir [$4]"; FAIL=$((FAIL+1)); fi
}

# S1: o REVOKE de TRUNCATE desfeito -> A3 tem de cair. Prova que o assert mede GRANT, nao
#     policy: trocar policy NUNCA revogaria TRUNCATE, que ignora RLS.
falsifica "S1 GRANT TRUNCATE de volta: A3 tem de cair" \
  "GRANT TRUNCATE ON public.omie_products TO authenticated;" \
  'Pq -c "SELECT has_table_privilege('"'"'authenticated'"'"','"'"'public.omie_products'"'"','"'"'TRUNCATE'"'"');"' "t"
P -q -c "REVOKE TRUNCATE ON public.omie_products FROM authenticated;" >/dev/null

# S2: A MAIS IMPORTANTE. A policy antiga de volta + o grant de UPDATE de volta -> A9 (farmer
#     nao escreve) tem de cair. Permissivas combinam com OR: se o DROP falhasse, o gate NAO
#     fecharia. Esta e a unica sabotagem que prova que o fecho e COMPORTAMENTAL, nao cosmetico
#     no pg_policies.
falsifica "S2 policy antiga + grant de volta: A9 tem de cair" \
  "GRANT UPDATE ON public.omie_products TO authenticated;
   CREATE POLICY \"Staff can manage products\" ON public.omie_products FOR ALL TO authenticated
     USING ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))))
     WITH CHECK ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));" \
  'escreve "$F" 444' "OK"
P -q -c "DROP POLICY \"Staff can manage products\" ON public.omie_products; REVOKE UPDATE ON public.omie_products FROM authenticated;" >/dev/null

# S3: o GRANT SELECT de volta OMITIDO -> A6 (anti-tautologia) E A11 (farmer ainda le) tem de cair.
#     Sem o grant, a negacao viria do privilegio e a policy nunca seria exercida.
falsifica "S3 sem GRANT SELECT: A11 (farmer le) tem de cair" \
  "REVOKE SELECT ON public.omie_products FROM authenticated;" \
  'le "$F"' "DENIED"
P -q -c "GRANT SELECT ON public.omie_products TO authenticated;" >/dev/null
eq "S3b leitura restaurada apos a sabotagem" "$(le "$F")" "3"

# S4: CONTROLE POSITIVO sabotado. Se service_role perder o grant, A14 tem de gritar -- senao
#     "ninguem escreve nada" passaria como sucesso e o harness estaria medindo ambiente morto.
falsifica "S4 service_role sem UPDATE: A14 tem de cair" \
  "REVOKE UPDATE ON public.omie_products FROM service_role;" \
  'escreve_service 555' "DENIED"
P -q -c "GRANT UPDATE ON public.omie_products TO service_role;" >/dev/null

# S5: a PRECONDICAO. Uma policy desconhecida (simulando sessao paralela) tem de ABORTAR a
#     migration -- senao o DROP+CREATE a deixaria viva e o gate nao fecharia.
echo "  --- S5: policy inesperada tem de ABORTAR a migration ---"
P -q -c "CREATE POLICY \"policy de outra sessao\" ON public.omie_products FOR ALL TO authenticated USING (true);" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then
  echo "  FAIL [S5] a migration APLICOU com policy desconhecida presente -- a precondicao nao dispara"
  FAIL=$((FAIL+1))
else
  echo "  OK   [S5] a migration ABORTOU (a precondicao tem dente)"
  FALS=$((FALS+1))
fi
P -q -c "DROP POLICY \"policy de outra sessao\" ON public.omie_products;" >/dev/null
P -q -f "$MIG" >/dev/null

echo
echo "════════════════════════════════════════════════════════════"
echo "  asserts verdes : ${BASE_PASS}"
echo "  falsificacoes  : ${FALS}/5"
echo "  FAIL           : ${FAIL}"
echo "════════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && [ "$FALS" -eq 5 ] || exit 1
echo "TUDO VERDE"
```

- [ ] **Step 2: Rodar e conferir contagem e nomes**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && heavy bash db/test-authz-preco-omie-products.sh > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t4.log 2>&1; echo "exit=$?"; cat /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t4.log
```
Expected: `exit=0`, `falsificacoes : 5/5`, `FAIL : 0`, `TUDO VERDE`. Conferir que as **5 linhas de falsificação vieram `OK`** com os valores esperados — não basta o exit code.

- [ ] **Step 3: Rodar shellcheck (é gate do CI)**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && shellcheck db/test-authz-preco-omie-products.sh; echo "exit=$?"
```
Expected: `exit=0`. Se acusar `SC2016`/`SC2329`, os `disable` já estão no cabeçalho — qualquer outro achado se corrige.

- [ ] **Step 4: Commit**

```bash
git add db/test-authz-preco-omie-products.sh
git commit -m "test(authz): falsificação 5/5 — cada sabotagem exige o vermelho do assert que mira"
```

---

### Task 5: Query de validação pós-apply (para o founder colar no SQL Editor)

**Files:**
- Create: `db/valida-authz-preco-omie-products.sql`

**Interfaces:**
- Consumes: a migration da Task 1 (valida o estado que ela produz).
- Produces: arquivo que o founder cola no SQL Editor do Lovable depois de aplicar, e que eu rodo via `psql-ro`.

**Lê catálogo, nunca invoca** (#1462: invocar exige `EXECUTE` e falha sob `psql-ro` — o sucesso da migration se apresentando como falha dela; e um falso negativo empurra para re-aplicar algo que está são).

- [ ] **Step 1: Escrever a validação**

Criar `db/valida-authz-preco-omie-products.sql`:

```sql
-- Validacao pos-apply de 20260727120000_authz_preco_fecha_omie_products.sql
-- Cola no SQL Editor do Lovable, ou roda via ~/.config/afiacao/psql-ro -f db/valida-authz-preco-omie-products.sql
-- LE CATALOGO, nunca invoca funcao (#1462) -> mesmo resultado de qualquer role.
-- Todos os checks tem de vir `t`. Qualquer `f` = a migration nao aplicou como desenhada.

SELECT
  -- policies: exatamente 1, de SELECT, e a antiga morta
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products') = 1                     AS c1_uma_policy,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products'
       AND policyname='Staff can manage products') = 0                                AS c2_antiga_morta,
  (SELECT cmd FROM pg_policies
     WHERE schemaname='public' AND tablename='omie_products') = 'SELECT'               AS c3_e_select,

  -- o gate de LEITURA continua o de antes (master OR employee) — escopado ao alvo, nao varredura
  (SELECT qual ILIKE '%master%' AND qual ILIKE '%employee%'
     FROM pg_policies WHERE schemaname='public' AND tablename='omie_products')         AS c4_gate_leitura_intacto,

  -- grants: escrita fechada p/ authenticated, anon zerado, SELECT preservado, service_role vivo
  NOT has_table_privilege('authenticated','public.omie_products','TRUNCATE')           AS c5_sem_truncate,
  NOT has_table_privilege('authenticated','public.omie_products','UPDATE')             AS c6_sem_update,
  NOT has_table_privilege('authenticated','public.omie_products','INSERT')             AS c7_sem_insert,
  NOT has_table_privilege('authenticated','public.omie_products','DELETE')             AS c8_sem_delete,
  NOT has_table_privilege('anon','public.omie_products','SELECT')                      AS c9_anon_zerado,
  has_table_privilege('authenticated','public.omie_products','SELECT')                 AS c10_select_preservado,
  has_table_privilege('service_role','public.omie_products','UPDATE')                  AS c11_sync_vivo,

  -- RLS ligada
  (SELECT relrowsecurity FROM pg_class WHERE oid='public.omie_products'::regclass)     AS c12_rls_on;
```

- [ ] **Step 2: Rodar contra PROD e confirmar que REPROVA hoje**

Este é o controle negativo da própria validação: a migration ainda **não** foi aplicada, então uma validação com dente tem de acusar. Uma validação que passa num banco onde a mudança não entrou não vale nada (#1490).

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && ~/.config/afiacao/psql-ro -f db/valida-authz-preco-omie-products.sql > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/valida-antes.log 2>&1; echo "exit=$?"; cat /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/valida-antes.log
```
Expected: `exit=0` (a query roda), mas com **`f` em c2, c3, c5, c6, c7, c8, c9** — porque hoje a policy é `FOR ALL` e os grants estão abertos. `c1`, `c4`, `c10`, `c11`, `c12` já vêm `t` hoje (há 1 policy, o gate menciona master/employee, e os grants de leitura/sync existem). Se **tudo** vier `t`, a validação não tem dente e precisa ser endurecida antes de entregar.

- [ ] **Step 3: Commit**

```bash
git add db/valida-authz-preco-omie-products.sql
git commit -m "chore(authz): validação pós-apply lendo catálogo — reprova em prod hoje (controle negativo)"
```

---

### Task 6: Gates do CI

**Files:** nenhum (só execução)

**Interfaces:**
- Consumes: tudo das Tasks 1–5.
- Produces: evidência de verde para o PR.

Regra: o commit espera **todos** os gates que o CI roda, não os que parecem relevantes ao diff. O diff aqui é SQL + bash + markdown, mas `knip` e `manifesto.gate` já quebraram por diffs "que não tocam TS".

- [ ] **Step 1: Rodar os gates, cada um em log próprio no scratchpad**

`/tmp` é compartilhado entre as ~30 worktrees — log com nome genérico colide e você lê a saída de outra sessão.

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && S=/private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad && heavy bun run typecheck > $S/g-typecheck.log 2>&1; echo "typecheck=$?"; heavy bun run lint > $S/g-lint.log 2>&1; echo "lint=$?"; heavy bun run test > $S/g-test.log 2>&1; echo "test=$?"; shellcheck db/test-authz-preco-omie-products.sh > $S/g-shellcheck.log 2>&1; echo "shellcheck=$?"
```
Expected: `typecheck=0`, `lint=0`, `test=0`, `shellcheck=0`. **Confirmar que cada comando terminou** — `heavy` é fila, e um processo enfileirado não é um gate verde (ausência de sinal ≠ aprovação).

- [ ] **Step 2: Se algum falhar, corrigir e re-rodar antes de seguir**

Não prosseguir para o Codex com gate vermelho.

---

### Task 7: Codex adversarial (rodada 1)

**Files:**
- Create: nenhum permanente; o parecer cru fica no arquivo que `codex-async.sh` produz.

**Interfaces:**
- Consumes: migration (Task 1), harness (Tasks 2–4), validação (Task 5), spec.
- Produces: lista de achados que a Task 8 endereça.

- [ ] **Step 1: Disparar o Codex em background**

Transporte por `scripts/codex-async.sh` com `run_in_background: true` — nunca `codex exec` cru em foreground. Modelo `gpt-5.6-sol`, reasoning `xhigh` (adversarial money-path).

**Não deixar o Codex abrir `supabase/schema-snapshot.sql`** (~36k linhas, trava). Os fatos de schema vão no próprio prompt.

O prompt deve conter: o estado medido em prod (policy, relacl, triggers, writers), a decisão (i) vs (ii) e por quê, a migration inteira, o harness inteiro, e o pedido explícito de atacar: (a) caminhos de escrita não enumerados, (b) asserts sem dente, (c) a precondição, (d) o que quebra em produção que o PG17 não vê, (e) se o fechamento de `anon` tem efeito colateral.

Enquadramento defensivo explícito ("código próprio, hardening") — os safeguards cyber do 5.6 podem pausar challenge legítimo de segurança.

- [ ] **Step 2: Enquanto roda, não bloquear a sessão**

O script tem hard-stop de 20min e preflight de auth. Seguir com outra coisa e integrar o parecer quando terminar.

- [ ] **Step 3: Apresentar o parecer CRU + a calibração SEPARADA**

O founder tem de distinguir o que o **Codex** escreveu do que é **decisão minha** de escopo. Mostrar o arquivo cru, e rotular a calibração como minha.

---

### Task 8: Endereçar os achados + rodada 2 do Codex

**Files:**
- Modify: conforme os achados.

**Interfaces:**
- Consumes: parecer da Task 7.
- Produces: migration e harness endurecidos.

- [ ] **Step 1: Para cada achado, decidir: aceitar, rebaixar ou recusar — com justificativa escrita**

Finding sem prova (trigger + linha + efeito) rebaixa, não bloqueia.

⚠️ **Ao endurecer um gate, todo assert que dependia do gate antigo vira suspeito** (#1488, medido 3× na mesma sessão). Se um achado levar a apertar mais alguma coisa, reler os asserts que mediam o estado anterior — eles podem ter virado tautologia sem nada no exit code avisar.

- [ ] **Step 2: Re-rodar o harness completo após cada mudança**

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && heavy bash db/test-authz-preco-omie-products.sh > /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t8.log 2>&1; echo "exit=$?"; tail -8 /private/tmp/claude-501/-Users-lucassardenberg-Projetos-afiacao--claude-worktrees-kind-hawking-5ccae9/fb50c7c7-5aab-4a9e-b948-c92b22361be9/scratchpad/t8.log
```
Expected: `exit=0`, `TUDO VERDE`, `falsificacoes : 5/5` (ou mais, se um achado adicionar sabotagem).

- [ ] **Step 3: Rodada 2 do Codex sobre as correções**

Mesmo transporte. O alvo é o diff das correções, não o trabalho inteiro de novo.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(authz): endurece migration e harness com os achados da rodada 1 do Codex"
```

⚠️ **Antes do `git add -A`**: confirmar que `mutcheck` não está rodando em background. Ele sabota `src/` in-place enquanto executa, e um `git add -A` nessa janela commitaria uma sabotagem de mutation testing num helper money-path. Conferir com `git diff --name-only src/` vazio.

---

### Task 9: PR draft

**Files:** nenhum

**Interfaces:**
- Consumes: tudo.
- Produces: o PR.

- [ ] **Step 1: RE-conferir colisão imediatamente antes de criar o PR**

A checagem do início da sessão **não vale mais** — o auto-merge fecha PR em minutos (2026-07-21: 4 PRs de margem em 46min; o #1525 viveu 6min).

Run:
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && git fetch origin main -q && git log --oneline origin/main -5 && gh pr list --state open --limit 30 --json number,title --jq '.[] | "\(.number) \(.title)"' && for b in $(git branch -r --format='%(refname:short)' | command grep -v HEAD); do git ls-tree --name-only "$b" supabase/migrations/ 2>/dev/null | command grep -E "20260727"; done | sort -u
```
Expected: nenhuma outra branch com migration `20260727*`, e nenhum PR novo tocando `omie_products`. Se houver colisão, renumerar a migration e re-rodar o harness (o path está hardcoded em `$MIG`).

- [ ] **Step 2: Criar o PR como DRAFT**

Draft segura o auto-merge. O corpo deve conter, além do desenho:

- **A migration é MANUAL** — o founder aplica no SQL Editor do Lovable. Merge na `main` ≠ produção.
- O bloco SQL pronto para colar.
- A query de validação pós-apply.
- **As duas notas de honestidade do spec §1.1 e §1.2**: (a) `get_skus_margem_positiva` não existe em prod, então o oráculo de custo é **prospectivo** — isto desbloqueia o #1520, não estanca vazamento em curso; (b) "já aconteceu?" é **irrespondível** — não há trilha, e `updated_at` guarda só o último toque.
- O parecer cru do Codex + a calibração rotulada como minha.
- Que não há `Publish` de frontend (nenhuma mudança em `src/`).

- [ ] **Step 3: Armar o watcher**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/kind-hawking-5ccae9 && scripts/pr-watch.sh <nº>
```
Com `run_in_background: true`. **Exit 6 ≠ 5**: 6 = não consegui consultar (estado DESCONHECIDO) → confirmar com `gh pr view <nº>` antes de avisar. Reportar "não mergeou" num exit 6 é falso negativo.

- [ ] **Step 4: Avisar o founder**

Comando com `cd <path do worktree>` antes, e o checklist de aplicação manual.

---

## Self-Review

**Spec coverage:**

| Spec | Task |
|---|---|
| §1 o problema (policy + TRUNCATE) | Task 1 (cabeçalho da migration documenta o estado medido) |
| §1.1 correção de escopo (oráculo prospectivo) | Task 9 Step 2 (corpo do PR) |
| §1.2 "já aconteceu?" irrespondível | Task 9 Step 2 (corpo do PR) |
| §2 investigação (writers, UI, funções SQL) | Task 1 (cabeçalho), Task 2 (stubs espelhando prod) |
| §2.1 as 13 views / `selfservice_catalogo` | chip separado (fora deste plano, por desenho) |
| §3.1 por que não gatear só a coluna | Task 1 (cabeçalho da migration) |
| §3.2 opção (i) vs (ii) | Task 1 (cabeçalho), Task 3 A10 (prova que master também é negado — o assert que distingue (i) de (ii)) |
| §3.3 leitura preservada | Task 3 A11/A12/A13, Task 4 S3 |
| §3.4 armadilhas evitadas | Task 1 (comentários), Task 2 (stub com relacl real) |
| §4 a migration (precondição, grants, policies, A1–A8) | Task 1 |
| §5.1 baseline pré-migration B1–B8 | Task 2 Step 2 (virou B1–B10) |
| §5.2 asserts pós A9–A12 | Task 3 Step 2 (virou A1–A14b) |
| §5.3 controle positivo | Task 3 A14/A14b, Task 4 S4 |
| §5.4 falsificação F1–F4 | Task 4 (virou S1–S5, com S5 novo: a precondição) |
| §6 fora de escopo | Task 9 Step 2 (declarado no PR) |
| §7 entrega (Codex, PR, apply manual) | Tasks 6–9 |

Sem gaps.

**Placeholder scan:** nenhum `TBD`/`TODO`/"similar à Task N". Todo passo de código traz o código completo.

**Type consistency:** `omie_products_select_staff` é o nome da policy em Task 1 (criação), Task 3 (A2/A2b), Task 4 (S2/S5) e Task 5 (c1–c3). `guard_role`/`le`/`escreve`/`escreve_service` definidas na Task 2 e usadas com a mesma assinatura nas Tasks 3–4. Estados `OK`/`RLS0`/`DENIED` consistentes. `$MIG` aponta para o mesmo caminho em todas as tasks.

**Desvios do spec, deliberados:**
- §5.1 previa 8 baselines; viraram **10** (acrescentei `B3 customer não escreve`, que prova que o gate de identidade já funcionava antes, e `B8 anon TEM UPDATE`, que dimensiona o que o REVOKE fecha).
- §5.4 previa 4 falsificações; viraram **5** — a nova é **S5, a precondição**, que o spec descreve em §4 mas não tinha sabotagem própria. Sem ela, a precondição seria código não-provado num arquivo money-path.
