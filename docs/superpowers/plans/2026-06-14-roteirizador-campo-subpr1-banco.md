# Redesign "Visitas em campo" — Sub-PR 1 (Banco/RPCs) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a fundação de dados do redesign: uma RPC que traz a **carteira de uma cidade** cruzada por nome **normalizado** (corrige o "zero clientes" por acento) já com a **recência da última visita**, e subir o teto da RPC de prospects de 200 → 2000 (corrige o "só 50 de 600").

**Architecture:** Duas funções SQL `SECURITY DEFINER` numa única migration, gate `pode_ver_carteira_completa` avaliado 1× no topo. Cruzamento de cidade via função imutável `norm_cidade()` (remove acento/caixa por `translate`, sem depender da extensão `unaccent`). Recência por `LEFT JOIN` em `route_visits.check_in_at`. Validação por harness PG17 local (executa de verdade — PL/pgSQL é late-bound) + prova por falsificação. Apply MANUAL no SQL Editor do Lovable.

**Tech Stack:** PostgreSQL 17 (harness local `db/test-*.sh`), Supabase/Lovable (apply manual), skill `lovable-db-operator`.

**Spec:** [docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md](../specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md) — pontos A, C (banco) e E (recência).

---

## File Structure

- **Create** `supabase/migrations/20260614160000_roteirizador_campo_banco.sql` — `norm_cidade()` + `carteira_por_municipio()` + `CREATE OR REPLACE radar_prospects_para_rota()` com teto 2000. (Timestamp > o último, `20260614140000`; o Task 3 reconfirma colisão multi-sessão.)
- **Create** `db/test-roteirizador-campo-banco.sh` — harness PG17: schema mínimo + seed + asserts (carteira A1–A5, prospects-teto B1–B2, gate G1).
- **Não tocar** as migrations existentes (baseline reconhecido pelo ecossistema Lovable).

---

## Task 1: Migration + teste PG17 (verde)

**Files:**
- Create: `supabase/migrations/20260614160000_roteirizador_campo_banco.sql`
- Test: `db/test-roteirizador-campo-banco.sh`

- [ ] **Step 1: Escrever a migration**

`supabase/migrations/20260614160000_roteirizador_campo_banco.sql`:

```sql
-- =============================================================================
-- REDESIGN "VISITAS EM CAMPO" — Sub-PR 1 (banco): carteira por município
-- normalizada (+ recência) e teto dos prospects 200→2000.
-- Spec: docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate de ambas as RPCs: gestor/master via pode_ver_carteira_completa, avaliado
-- 1× no topo (não por-linha — lição #792). SECURITY DEFINER bypassa RLS.
-- =============================================================================

-- 1) Normalização de cidade: lower + trim + remove acentos PT por translate
--    (IMMUTABLE, sem depender da extensão unaccent). Os dois lados do cruzamento
--    (addresses.city texto-livre e radar_empresas.municipio_nome RFB) passam por aqui.
CREATE OR REPLACE FUNCTION public.norm_cidade(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(translate(
    COALESCE(t,''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
    'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'
  )));
$$;

-- 2) Carteira (clientes existentes) de um município, casada por nome normalizado +
--    UF, com a recência da última visita (route_visits.check_in_at de QUALQUER
--    vendedor = cobertura real do cliente). 1 endereço por cliente (is_default 1º).
CREATE OR REPLACE FUNCTION public.carteira_por_municipio(p_municipio_codigo text)
RETURNS TABLE(
  user_id uuid, name text, phone text,
  street text, number text, neighborhood text, city text, state text, zip_code text, complement text,
  business_hours_open text, business_hours_close text,
  ultima_visita timestamptz, dias_desde_visita integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_nome text;
  v_uf   text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_municipio_codigo IS NULL OR btrim(p_municipio_codigo) = '' THEN
    RAISE EXCEPTION 'municipio_codigo obrigatório';
  END IF;

  -- Resolve (nome, uf) RFB do código pela MESMA fonte dos prospects (radar_empresas,
  -- via índice em municipio_codigo). Município sem empresas no Radar → sem carteira.
  SELECT re.municipio_nome, re.uf INTO v_nome, v_uf
    FROM public.radar_empresas re
   WHERE re.municipio_codigo = p_municipio_codigo
   LIMIT 1;
  IF v_nome IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH alvo AS (
    SELECT a.user_id, a.street, a.number, a.neighborhood, a.city, a.state,
           a.zip_code, a.complement, a.is_default
      FROM public.addresses a
     WHERE public.norm_cidade(a.city) = public.norm_cidade(v_nome)
       AND upper(btrim(a.state)) = upper(btrim(v_uf))
  ),
  ende AS (
    SELECT DISTINCT ON (user_id)
           user_id, street, number, neighborhood, city, state, zip_code, complement
      FROM alvo
     ORDER BY user_id, is_default DESC NULLS LAST
  ),
  ult AS (
    SELECT rv.customer_user_id, max(rv.check_in_at) AS ultima
      FROM public.route_visits rv
     WHERE rv.customer_user_id IN (SELECT e.user_id FROM ende e)
       AND rv.check_in_at IS NOT NULL
     GROUP BY rv.customer_user_id
  )
  SELECT e.user_id, p.name, p.phone,
         e.street, e.number, e.neighborhood, e.city, e.state, e.zip_code, e.complement,
         p.business_hours_open, p.business_hours_close,
         u.ultima,
         CASE WHEN u.ultima IS NULL THEN NULL
              ELSE floor(extract(epoch FROM (now() - u.ultima)) / 86400)::int END
    FROM ende e
    JOIN public.profiles p ON p.user_id = e.user_id
    LEFT JOIN ult u ON u.customer_user_id = e.user_id
   WHERE COALESCE(p.is_employee, false) = false;
END $$;

-- 3) Teto dos prospects 200 → 2000 (mesmo corpo da 20260613230000, só o LIMIT muda).
--    ⚠️ Task 3 compara a def VIVA de prod antes de aplicar (apply manual diverge).
CREATE OR REPLACE FUNCTION public.radar_prospects_para_rota(
  p_municipio_codigo text,
  p_limit            integer DEFAULT 30
) RETURNS TABLE(
  cnpj text, razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text,
  prospeccao_status text,
  lat double precision, lng double precision, geocode_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_municipio_codigo IS NULL OR btrim(p_municipio_codigo) = '' THEN
    RAISE EXCEPTION 'municipio_codigo obrigatório';
  END IF;

  RETURN QUERY
  SELECT re.cnpj, re.razao_social, re.nome_fantasia,
         re.logradouro, re.numero, re.complemento, re.bairro,
         re.municipio_nome, re.uf, re.cep,
         re.telefone1, re.telefone2,
         re.prospeccao_status,
         re.lat, re.lng, re.geocode_status
    FROM public.radar_empresas re
   WHERE re.municipio_codigo = p_municipio_codigo
     AND re.ja_cliente = false
     AND re.prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa')
   ORDER BY (re.prospeccao_status = 'a_contatar') DESC,
            re.data_abertura DESC NULLS LAST,
            re.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 2000));
END $$;

-- 4) Travas: só authenticated invoca; o gate interno confere gestor/master.
REVOKE ALL ON FUNCTION public.norm_cidade(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.norm_cidade(text) TO authenticated;
REVOKE ALL ON FUNCTION public.carteira_por_municipio(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.carteira_por_municipio(text) TO authenticated;
REVOKE ALL ON FUNCTION public.radar_prospects_para_rota(text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.radar_prospects_para_rota(text,integer) TO authenticated;

-- 5) Validação pós-apply (colar junto; esperar funcoes_3=3)
SELECT 'ROTEIRIZADOR CAMPO BANCO OK' AS status,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('norm_cidade','carteira_por_municipio','radar_prospects_para_rota')) AS funcoes_3;
```

- [ ] **Step 2: Escrever o teste PG17**

`db/test-roteirizador-campo-banco.sh`:

```bash
#!/usr/bin/env bash
# PG17: valida a migration 20260614160000 (carteira por município normalizada +
# recência; teto prospects 2000; gate). Executa de verdade (PL/pgSQL é late-bound).
#  A1 casa apesar do acento (DIVINOPOLIS sem acento vs DIVINÓPOLIS RFB)
#  A2 casa com caixa diferente
#  A3 NÃO casa homônimo de OUTRA uf
#  A4 NÃO traz staff (is_employee=true)
#  A5 recência: cliente visitado há ~10d => 10; nunca visitado => NULL
#  B1 teto: 250 prospects 'a_contatar' com p_limit alto => 250 (>200 antigo)
#  B2 p_limit pequeno respeitado (50 => 50)
#  G1 gate: pode_ver_carteira_completa=false => EXCEPTION 'forbidden'
set -euo pipefail
export LC_ALL=C LANG=C
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ pg17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55478
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260614160000_roteirizador_campo_banco.sql"

echo "=== schema mínimo + stubs + seed ==="
"${P[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
-- gate por GUC: 'on' habilita; qualquer outra coisa (ou unset) nega.
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('test.gate', true) IS NOT DISTINCT FROM 'on' $$;

CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_codigo text, municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text, data_abertura date,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  ja_cliente boolean NOT NULL DEFAULT false,
  lat double precision, lng double precision, geocode_status text);
CREATE INDEX idx_re_muni ON public.radar_empresas (municipio_codigo);

CREATE TABLE public.addresses (
  user_id uuid NOT NULL, street text, number text, neighborhood text,
  city text NOT NULL, state text NOT NULL, zip_code text, complement text,
  is_default boolean DEFAULT false);
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY, name text, phone text, is_employee boolean,
  business_hours_open text, business_hours_close text);
CREATE TABLE public.route_visits (
  customer_user_id uuid NOT NULL, check_in_at timestamptz);

-- município RFB: DIVINÓPOLIS/MG (cod 3122306). Inclui 1 empresa só pra resolver nome/uf.
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, prospeccao_status, ja_cliente)
  VALUES ('00000000000001','3122306','DIVINÓPOLIS','MG','a_contatar',false);

-- 250 prospects 'a_contatar' no município (teto B1/B2)
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, prospeccao_status, ja_cliente, data_abertura)
  SELECT lpad((100+g)::text,14,'0'),'3122306','DIVINÓPOLIS','MG','a_contatar',false, date '2020-01-01'+g
  FROM generate_series(1,250) g;

-- clientes:
-- u1 city sem acento 'Divinopolis' MG (A1) + visita há 10d (A5)
-- u2 city caixa alta 'DIVINÓPOLIS' MG (A2) sem visita (A5 NULL)
-- u3 'Divinópolis' SP homônimo outra uf (A3) — NÃO casa
-- u4 'Divinopolis' MG mas is_employee=true (A4) — NÃO casa
INSERT INTO public.addresses (user_id, street, city, state, is_default) VALUES
  ('00000000-0000-0000-0000-0000000000u1'::uuid,'Rua A','Divinopolis','MG',true),
  ('00000000-0000-0000-0000-0000000000u2'::uuid,'Rua B','DIVINÓPOLIS','mg',true),
  ('00000000-0000-0000-0000-0000000000u3'::uuid,'Rua C','Divinópolis','SP',true),
  ('00000000-0000-0000-0000-0000000000u4'::uuid,'Rua D','Divinopolis','MG',true);
INSERT INTO public.profiles (user_id, name, is_employee) VALUES
  ('00000000-0000-0000-0000-0000000000u1'::uuid,'Cliente Um',false),
  ('00000000-0000-0000-0000-0000000000u2'::uuid,'Cliente Dois',false),
  ('00000000-0000-0000-0000-0000000000u3'::uuid,'Cliente Tres',false),
  ('00000000-0000-0000-0000-0000000000u4'::uuid,'Func Quatro',true);
INSERT INTO public.route_visits (customer_user_id, check_in_at) VALUES
  ('00000000-0000-0000-0000-0000000000u1'::uuid, now() - interval '10 days');
SQL

echo "=== aplica a migration ==="
"${P[@]}" -f "$MIG" | grep -E "ROTEIRIZADOR CAMPO BANCO|funcoes_3" || true

echo "=== asserts ==="
"${P[@]}" <<'SQL'
SET test.gate='on';
-- carteira
SELECT CASE WHEN count(*)=2 THEN 'A1A2A4 OK' ELSE 'A1A2A4 FAIL n='||count(*) END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE WHEN bool_and(user_id <> '00000000-0000-0000-0000-0000000000u3'::uuid) THEN 'A3 OK' ELSE 'A3 FAIL' END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE WHEN bool_and(user_id <> '00000000-0000-0000-0000-0000000000u4'::uuid) THEN 'A4b OK' ELSE 'A4b FAIL' END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE
    WHEN (SELECT dias_desde_visita FROM public.carteira_por_municipio('3122306')
            WHERE user_id='00000000-0000-0000-0000-0000000000u1'::uuid) BETWEEN 9 AND 11
     AND (SELECT dias_desde_visita FROM public.carteira_por_municipio('3122306')
            WHERE user_id='00000000-0000-0000-0000-0000000000u2'::uuid) IS NULL
    THEN 'A5 OK' ELSE 'A5 FAIL' END;
-- prospects teto
SELECT CASE WHEN count(*)=250 THEN 'B1 OK' ELSE 'B1 FAIL n='||count(*) END
  FROM public.radar_prospects_para_rota('3122306', 1000);
SELECT CASE WHEN count(*)=50 THEN 'B2 OK' ELSE 'B2 FAIL n='||count(*) END
  FROM public.radar_prospects_para_rota('3122306', 50);
SQL

echo "=== G1 gate nega não-gestor ==="
"${P[@]}" <<'SQL'
SET test.gate='off';
DO $$ BEGIN
  PERFORM * FROM public.carteira_por_municipio('3122306');
  RAISE NOTICE 'G1 FAIL: deveria ter barrado';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%forbidden%' THEN RAISE NOTICE 'G1 OK';
  ELSE RAISE NOTICE 'G1 FAIL: %', SQLERRM; END IF;
END $$;
SQL

echo "=== resultado ==="
echo "(o runner do Task 1 confere que não há 'FAIL' no output acima)"
```

- [ ] **Step 3: Rodar o teste (verde)**

Run: `heavy bash db/test-roteirizador-campo-banco.sh > /tmp/campo-banco.log 2>&1; echo "exit=$?"`
Depois: `grep -E "OK|FAIL|exit=" /tmp/campo-banco.log`
Expected: `exit=0` e todas as linhas `A1A2A4 OK`, `A3 OK`, `A4b OK`, `A5 OK`, `B1 OK`, `B2 OK`, `G1 OK` — nenhum `FAIL`.
(⚠️ redirect + `echo $?`, nunca `| tail` — o pipe engole o exit code.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260614160000_roteirizador_campo_banco.sql db/test-roteirizador-campo-banco.sh
git commit -m "feat(roteirizador): carteira por município normalizada (+recência) e teto prospects 2000

Sub-PR 1 do redesign 'Visitas em campo'. norm_cidade() imutável corrige o
'zero clientes' por acento; carteira_por_municipio() traz a recência de
route_visits; radar_prospects_para_rota teto 200->2000. PG17 verde.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Prova por falsificação (o teste tem poder de detecção)

> Sabotar de propósito e exigir VERMELHO — senão o teste é teatro (lição CLAUDE.md). Nada commitado aqui; tudo revertido ao fim.

- [ ] **Step 1: Sabotar o filtro de UF e exigir A3 FAIL**

Edite `...20260614160000_roteirizador_campo_banco.sql`: comente a linha `AND upper(btrim(a.state)) = upper(btrim(v_uf))` (vira `-- AND ...`).
Run: `bash db/test-roteirizador-campo-banco.sh > /tmp/sab1.log 2>&1; echo "exit=$?"; grep -E "A3" /tmp/sab1.log`
Expected: `A3 FAIL` (sem o filtro de UF, o homônimo `u3` de SP passa a casar) — prova que o filtro é load-bearing.
Reverta a linha (descomente).

- [ ] **Step 2: Sabotar o gate e exigir G1 FAIL**

Edite a migration: troque o `IF NOT COALESCE(public.pode_ver_carteira_completa(...` da `carteira_por_municipio` por `IF false THEN` (desliga o gate).
Run: `bash db/test-roteirizador-campo-banco.sh > /tmp/sab2.log 2>&1; echo "exit=$?"; grep -E "G1" /tmp/sab2.log`
Expected: `G1 FAIL: deveria ter barrado` — prova que o gate é o que barra.
Reverta (restaure o `IF NOT COALESCE(...`).

- [ ] **Step 3: Reconfirmar verde após reverter**

Run: `bash db/test-roteirizador-campo-banco.sh > /tmp/campo-banco.log 2>&1; echo "exit=$?"; grep -c "FAIL" /tmp/campo-banco.log`
Expected: `exit=0` e `0` (zero ocorrências de FAIL). Se a migration ficou suja, `git checkout -- supabase/migrations/20260614160000_roteirizador_campo_banco.sql` e re-rode.

---

## Task 3: Apply manual no Lovable + validação + PR

> REQUIRED SUB-SKILL: `lovable-db-operator` (empacota o bloco do SQL Editor + validação + nota de PR + regenera o audit).

- [ ] **Step 1: Comparar a def VIVA de `radar_prospects_para_rota` antes de substituir**

Peça ao founder rodar no SQL Editor e colar de volta:
`SELECT pg_get_functiondef('public.radar_prospects_para_rota(text,integer)'::regprocedure);`
Compare com o corpo da seção 3 da migration. Se divergir além do `LIMIT` (ex.: prod tem outro filtro/coluna), **pare e reconcilie** — a última versão aplicada vence (apply manual diverge do repo).

- [ ] **Step 2: Reconfirmar que não há colisão de timestamp multi-sessão**

Run: `git fetch origin --quiet 2>&1 | tail -1; ls supabase/migrations/ | grep 202606141 | sort`
Se outra sessão criou `20260614160000_*`, renomeie esta para o próximo slot livre (ex.: `20260614170000`) e ajuste `MIG=` no teste.

- [ ] **Step 3: Founder aplica no SQL Editor**

Instrução rotulada "🟣 Lovable → SQL Editor → cola → Run": colar o conteúdo de `20260614160000_roteirizador_campo_banco.sql` (já inclui a query de validação no fim).
Expected (founder cola de volta): `ROTEIRIZADOR CAMPO BANCO OK | funcoes_3 = 3`.

- [ ] **Step 4: Smoke de cruzamento real (uma cidade conhecida)**

Peça ao founder rodar e colar: `SELECT count(*) FROM public.carteira_por_municipio('3122306');` (Divinópolis) e confirmar > 0 (era 0 com o `ilike`). Se vier 0, investigar a grafia real em `addresses` antes de seguir pro Sub-PR 2.

- [ ] **Step 5: Push + PR**

```bash
git push -u origin claude/roteirizador-campo-redesign
gh pr create --title "feat(roteirizador): banco do redesign campo — carteira normalizada + teto prospects" \
  --body "Sub-PR 1/4 do redesign 'Visitas em campo'. RPC carteira_por_municipio (corrige zero-clientes por acento, traz recência) + teto prospects 200->2000. ⚠️ migration manual aplicada no SQL Editor (funcoes_3=3). Spec/plano em docs/superpowers/. PG17 verde + prova por falsificação.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review

- **Spec coverage:** A (carteira normalizada) = `norm_cidade`+`carteira_por_municipio`; C-banco (teto) = `radar_prospects_para_rota` 2000; E-recência = `dias_desde_visita` por `route_visits`. ✓ Sub-PRs 2–4 (UF/filtros/virtualização, detalhe/curar, mapa) são planos separados, fora deste.
- **Placeholders:** nenhum — SQL e teste completos.
- **Type consistency:** `carteira_por_municipio` retorna `dias_desde_visita integer` / `ultima_visita timestamptz` — o Sub-PR 2/4 consome esses nomes. `radar_prospects_para_rota` mantém assinatura `(text,integer)` e colunas/ordem idênticas à 20260613230000 (só o `LIMIT` muda) → `CREATE OR REPLACE` não quebra os callsites.
- **Armadilhas cobertas:** gate 1× no topo; `REVOKE FROM PUBLIC, anon` + `GRANT authenticated`; teste EXECUTA (não só cria) + falsificação; comparar def viva antes do `CREATE OR REPLACE`; colisão de timestamp; redirect-não-pipe no runner.

---

## Notas de implementação (execução 2026-06-14)

Ajustes feitos ao codificar (o código real é a verdade; estes pontos divergem dos snippets acima):
1. **UUIDs do teste `u1–u4` → `b1–b4`** — `u` não é hexadecimal; o cast `::uuid` quebrava.
2. **`carteira_por_municipio` precisou de `#variable_conflict use_column`** logo após `AS $$` — em `RETURNS TABLE`, os nomes das colunas de saída (user_id, city, state…) viram variáveis e colidem com as colunas dos CTEs ("column reference ambiguous").
3. **Teste cria `authenticated`/`anon`** antes da migration — o PG17 local não tem os roles do Supabase (os `GRANT … TO authenticated` falhavam).
4. **Seed sem a empresa "resolvedora" extra** — ela também era `a_contatar`/não-cliente, então a RPC de prospects a contava (B1=251); os próprios 250 prospects já resolvem `(nome, uf)`.
5. **Sabotagem do gate (Task 2):** substituir a CONDIÇÃO inteira por `false` (`IF false THEN`), não o nome da função (vira `public.true`, erro de sintaxe que aborta antes do assert).

Resultado: PG17 verde (A1A2A4, A3, A4b, A5, B1, B2, G1) + falsificação confirmada.
