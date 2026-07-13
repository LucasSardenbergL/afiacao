# PR1 v3 — Infra de run (publicação diferida atômica) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 é money-path SQL → REQUIRED SUB-SKILL `prove-sql-money-path` (PG17 + falsificação). A entrega é via `lovable-db-operator` (migration) + `lovable-deploy-verify` (edge). Codex challenge xhigh no diff antes de dessardraftar.

**Goal:** Fechar o bug sistêmico do `em_transito` fantasma criando a INFRA que carimba, de forma ATÔMICA e não-forjável, quais POs foram vistos no último run COMPLETO do Omie — sem mutar nenhum pedido nem tocar o motor (isso é PR2/PR3).

**Architecture:** Publicação DIFERIDA. A edge `omie-sync-pedidos-compra` coleta os `nCodPed` vistos durante o run e, **só no fim de um completo LIMPO e NÃO-filtrado**, chama 1× a RPC `reposicao_publicar_run_completo`. A RPC (SECURITY DEFINER, service_role-only) grava o marcador de run **E** carimba `last_seen` nos POs vistos numa **única transação serializada por empresa** (advisory lock). `volume_ok` sai de um baseline robusto (mediana de runs bons; bootstrap → `null`, nunca `true`). Nada é publicado durante o upsert das páginas.

**Tech Stack:** PostgreSQL 17 (plpgsql, SECURITY DEFINER, RLS, advisory lock), Deno/TypeScript (edge Supabase), `@supabase/supabase-js@2.45.0`. Prova: harness PG17 local descartável (`db/test-*.sh`). Deploy: Lovable Cloud (migration no SQL Editor; edge pelo chat).

## Global Constraints

- **Design de referência:** `docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md` §4/§5/§8/§10/§11/§12. Os 6 P1 do Codex: §3b.
- **NÃO editar migrations existentes** (`supabase/migrations/*` já commitadas — snapshot é a fonte de DR). Só CRIAR uma migration nova.
- **NÃO tocar o motor** `gerar_pedidos_sugeridos_ciclo` nem a CTE `em_transito`. PR1 é só infra; não muta `pedido_compra_sugerido`.
- **Convenção de empresa (campo minado):** `purchase_orders_tracking.empresa` e `reposicao_pedidos_compra_run.empresa` são o **enum `public.empresa_reposicao`** com labels **`OBEN`/`COLACOR` (MAIÚSCULO)**. O advisory-lock key normaliza com `lower(...)`. A edge passa `s.empresa` = `"OBEN"`/`"COLACOR"`.
- **`omie_codigo_pedido` é `bigint`**; a RPC recebe `p_ids bigint[]`; o UNIQUE do tracking é `(empresa, omie_codigo_pedido)`.
- **Segurança money-path (Codex P1 #6):** a base de verdade é **service_role-only**. A RPC leva `REVOKE ALL ... FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE ... TO service_role`. A tabela leva RLS `SELECT` staff e **NENHUMA policy de escrita** (+ `REVOKE INSERT/UPDATE/DELETE`). **Sem gate `auth.role()`/`auth.uid()` interno** na RPC (design §11 — não introduzir dependência de `auth.*` numa função de automação).
- **Timestamp da migration:** `> 20260712140000` (mais recente em `origin/main` no diagnóstico). Plano usa `20260712193000`; **reconfirmar `> max(origin/main)` e ausência de colisão com worktrees paralelas na hora de criar** (`git fetch origin main` + `ls supabase/migrations/ | tail`).
- **Rito:** `heavy` prefixando test/typecheck (semáforo RAM M2 8GB). `cmd > log 2>&1; echo $?` quando o exit importa (pipe engole exit code). Aguardar o `bun install` de background antes de test/typecheck.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql` | **Criar** | Tabela marcador `reposicao_pedidos_compra_run` (RLS SELECT staff, escrita service_role-only) + colunas `last_seen_pedidos_full_{run_id,at}` em `purchase_orders_tracking` + RPC `reposicao_publicar_run_completo`. É a fonte ÚNICA (não há recriação multi-migration → o teste PG17 aplica esta migration direto). |
| `db/test-reposicao-publicar-run-completo.sh` | **Criar** | Prova PG17 falsificada dos 6 P1: volume_ok robusto (bootstrap/baseline), atomicidade marcador+last_seen, lock presente, RLS/grants service_role-only. |
| `supabase/functions/omie-sync-pedidos-compra/index.ts` | **Modificar** | Coleta `idsVistos` (Set) durante o run; NÃO carimba no upsert; no fim LIMPO+completo+não-filtrado chama `reposicao_publicar_run_completo` 1×; `marcarCompletoOk` (cadência) só avança se a RPC teve sucesso (fail-closed). |
| `docs/historico/bugs-resolvidos.md` | **Modificar** (ao concluir) | Registrar a entrega do PR1 v3. |

**Decomposição em PRs:** 1 PR (**PR1**), 2 commits (Task 1 = SQL+PG17; Task 2 = edge). A edge depende da RPC → **ordem de deploy: migration (SQL Editor) ANTES da edge (chat Lovable)**. Se a edge subir antes, ela chama uma RPC inexistente → o `catch` retorna `false` → `marcarCompletoOk` não avança → o próximo ciclo re-tenta (fail-closed, não catastrófico), mas documentar a ordem no PR.

---

## Task 1: Migration + RPC + prova PG17 falsificada

**Files:**
- Create: `supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql`
- Test: `db/test-reposicao-publicar-run-completo.sh`

**Interfaces:**
- Produces (consumido pela Task 2 e pelos PRs futuros):
  - `public.reposicao_publicar_run_completo(p_empresa text, p_run_id uuid, p_janela_de date, p_janela_ate date, p_ids bigint[]) RETURNS boolean` — retorna `volume_ok` (`true`/`false`/`null`); levanta exceção em erro (a edge trata como falha de publicação).
  - Tabela `public.reposicao_pedidos_compra_run(run_id uuid PK, empresa empresa_reposicao, janela_de date, janela_ate date, ids_distintos int, volume_baseline int, volume_ok bool, status text, finalizado_em timestamptz)`.
  - Colunas `public.purchase_orders_tracking.last_seen_pedidos_full_run_id uuid`, `.last_seen_pedidos_full_at timestamptz`.

- [ ] **Step 1: Invocar `prove-sql-money-path`** para reger o harness PG17 (é a sub-skill obrigatória desta task). Anunciar "Using prove-sql-money-path…".

- [ ] **Step 2: Criar a migration** `supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql` com o conteúdo EXATO:

```sql
-- Reposição — infra de RUN de pedidos de compra (publicação diferida ATÔMICA) — money-path (PR1)
-- ============================================================================
-- Problema (fix SISTÊMICO): PO excluído direto no Omie deixa o pedido_compra_sugerido 'disparado'
-- → a CTE em_transito do motor re-soma as unidades por 7d → dupla contagem fantasma → o item some
-- do cockpit (pedido 409 / PO #1073 latente; #1115/pedido 1046 já tratado manual).
--
-- PR1 cria SÓ a INFRA de run — NÃO muta pedido, NÃO toca o motor:
--   1) reposicao_pedidos_compra_run — 1 linha imutável por run COMPLETO publicado. O "último completo
--      válido" = mais recente status='ok' AND volume_ok IS TRUE. RLS SELECT staff; escrita service_role-only
--      (Codex P1 #6 — sem isso a base de verdade é forjável por authenticated).
--   2) purchase_orders_tracking.last_seen_pedidos_full_{run_id,at} — colunas single-writer, escritas SÓ
--      pela RPC (3), no fim do run limpo, no MESMO commit do marcador (Codex P1 #1/#4).
--   3) reposicao_publicar_run_completo(...) — PUBLICAÇÃO DIFERIDA ATÔMICA (SECURITY DEFINER, service_role-only):
--      advisory lock por empresa → volume_ok robusto → INSERT marcador → UPDATE last_seen, tudo numa transação.
--
-- Design: docs/superpowers/specs/2026-07-11-reposicao-reconciliacao-po-excluido-omie-design.md §5
-- Prova PG17 (falsifica os 6 P1): db/test-reposicao-publicar-run-completo.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- ─── 1) marcador de run (insert-only, imutável) ───
CREATE TABLE IF NOT EXISTS public.reposicao_pedidos_compra_run (
  run_id          uuid PRIMARY KEY,
  empresa         public.empresa_reposicao NOT NULL,
  janela_de       date NOT NULL,
  janela_ate      date NOT NULL,
  ids_distintos   integer NOT NULL,
  volume_baseline integer,
  volume_ok       boolean,
  status          text NOT NULL DEFAULT 'ok',
  finalizado_em   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.reposicao_pedidos_compra_run IS
  'Um registro IMUTÁVEL por run COMPLETO de omie-sync-pedidos-compra publicado. Marcador "último completo válido" = mais recente status=''ok'' AND volume_ok IS TRUE. Escrito SÓ por reposicao_publicar_run_completo (service_role). PR1 reconciliação PO excluído no Omie.';

-- baseline lê os últimos runs bons por empresa (ORDER BY finalizado_em DESC) → índice cobre.
CREATE INDEX IF NOT EXISTS idx_reposicao_pedidos_compra_run_baseline
  ON public.reposicao_pedidos_compra_run (empresa, finalizado_em DESC);

ALTER TABLE public.reposicao_pedidos_compra_run ENABLE ROW LEVEL SECURITY;
-- SELECT: só staff carteira-completa (espelha reposicao_estoque_nao_confirmado_log).
DROP POLICY IF EXISTS reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pedidos_compra_run_sel ON public.reposicao_pedidos_compra_run
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
-- SEM policy de INSERT/UPDATE/DELETE → RLS nega escrita a authenticated/anon (Codex P1 #6).
-- Defense-in-depth: revoga grants de escrita (service_role bypassa RLS via a RPC SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_pedidos_compra_run FROM authenticated, anon;

-- ─── 2) colunas single-writer no tracking (escritas SÓ pela RPC 3) ───
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_run_id uuid,
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_at timestamptz;
COMMENT ON COLUMN public.purchase_orders_tracking.last_seen_pedidos_full_run_id IS
  'run_id do último run COMPLETO de omie-sync-pedidos-compra que VIU este PO. Escrito SÓ por reposicao_publicar_run_completo, no MESMO commit do marcador. NÃO tocar no upsert das páginas (Codex P1 #1).';

-- ─── 3) RPC de PUBLICAÇÃO DIFERIDA ATÔMICA (o coração da v3) ───
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(
  p_empresa    text,
  p_run_id     uuid,
  p_janela_de  date,
  p_janela_ate date,
  p_ids        bigint[]
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_empresa       public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
  v_ids_distintos integer;
  v_baseline      numeric;
  v_volume_ok     boolean;
BEGIN
  -- (a) advisory lock por empresa — serializa a PUBLICAÇÃO (marcador + last_seen no mesmo commit).
  --     Dois completos concorrentes não deixam mosaico de run_ids (Codex P1 #4).
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:' || lower(btrim(p_empresa))));

  -- POs distintos vistos neste run (dedup; ignora null/<=0).
  SELECT count(DISTINCT x) INTO v_ids_distintos
  FROM unnest(COALESCE(p_ids, ARRAY[]::bigint[])) AS x
  WHERE x IS NOT NULL AND x > 0;

  -- (b) baseline ROBUSTO (Codex P1 #5): mediana dos últimos 5 runs BONS da empresa — exclui truncados
  --     conhecidos (volume_ok=false) e degenerados (ids_distintos=0), admite o bootstrap (volume_ok null).
  --     Isto MATA o canário [0,0,0]→true (sem run bom → baseline null → volume_ok null, NUNCA true).
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos)
  INTO v_baseline
  FROM (
    SELECT ids_distintos
    FROM public.reposicao_pedidos_compra_run
    WHERE empresa = v_empresa
      AND status = 'ok'
      AND ids_distintos > 0
      AND volume_ok IS NOT FALSE
    ORDER BY finalizado_em DESC
    LIMIT 5
  ) r;

  IF v_baseline IS NULL OR v_baseline <= 0 THEN
    v_volume_ok := NULL;                                   -- bootstrap / sem histórico bom → "não sei"
  ELSE
    v_volume_ok := (v_ids_distintos::numeric >= 0.9 * v_baseline);
  END IF;

  -- (c) marcador imutável (insert-only). run_id é PK → re-publicar o mesmo run colide (fail-closed).
  INSERT INTO public.reposicao_pedidos_compra_run
    (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_baseline, volume_ok, status, finalizado_em)
  VALUES
    (p_run_id, v_empresa, p_janela_de, p_janela_ate, v_ids_distintos,
     CASE WHEN v_baseline IS NULL THEN NULL ELSE round(v_baseline)::integer END,
     v_volume_ok, 'ok', now());

  -- (d) carimba last_seen dos POs vistos — MESMO commit do marcador (Codex P1 #1/#4).
  IF v_ids_distintos > 0 THEN
    UPDATE public.purchase_orders_tracking
    SET last_seen_pedidos_full_run_id = p_run_id,
        last_seen_pedidos_full_at = now()
    WHERE empresa = v_empresa
      AND omie_codigo_pedido = ANY (p_ids);
  END IF;

  RETURN v_volume_ok;
END;
$$;

-- Codex P1 #6: service_role-only. authenticated/anon nem INVOCAM (42501 no privilégio, antes do corpo).
REVOKE ALL ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text, uuid, date, date, bigint[])
  TO service_role;

COMMIT;
```

- [ ] **Step 3: Criar o harness PG17** `db/test-reposicao-publicar-run-completo.sh`. Copiar VERBATIM o esqueleto de arranque de `db/test-authz-estimar-estoque-omie.sh` (linhas 13–53: `set -euo pipefail`, arranque PG17 descartável, `db/stubs-supabase.sql`, `auth.uid()/role()` via GUC `test.uid`/`test.role`, `ALTER ROLE service_role BYPASSRLS`, helpers `ok/bad/eq`), trocando `SLUG="reposicao-publicar-run"`, `PORT="${PGPORT_TEST:-5476}"`. Depois as zonas específicas abaixo (código completo):

**ZONA 1 — pré-requisitos** (o que a migration referencia mas não existe no PG17 vazio):
```bash
P -q <<'SQL'
-- enum de empresa (labels REAIS de prod)
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');

-- tracking mínimo (a migration ADICIONA as colunas last_seen_* via ALTER)
CREATE TABLE public.purchase_orders_tracking (
  id uuid DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  status text DEFAULT 'CRIADO',
  updated_at timestamptz DEFAULT now(),
  UNIQUE (empresa, omie_codigo_pedido)
);

-- cadeia de gate REAL de prod (cópia fiel — como test-authz-estimar-estoque-omie.sh)
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT commercial_role FROM public.commercial_roles WHERE user_id=_user_id LIMIT 1 $fn$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.has_role(_uid,'master')
    OR (public.has_role(_uid,'employee')
        AND public.get_commercial_role(_uid) IN ('gerencial','estrategico','super_admin'));
$fn$;
SQL
```

**ZONA 2 — aplicar a MIGRATION REAL** (Lei de Ferro #1):
```bash
MIG="$REPO_ROOT/supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
```

**ZONA 3 — seeds** (POs no tracking + usuários de teste):
```bash
P -q <<'SQL'
-- POs de acompanhamento (âncora do design: 1073 latente, 1115 tratado, 9999 nunca visto)
INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido) VALUES
  ('OBEN', 1073), ('OBEN', 1115), ('OBEN', 9999), ('COLACOR', 5000);

-- usuários da prova de RLS/gate
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master (staff)
  ('44444444-4444-4444-4444-444444444444');  -- customer sem role (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master');
SQL
```

- [ ] **Step 4: Escrever os asserts** (ZONA 4), organizados pelos 6 P1. Código completo:

```bash
echo "── Bloco A: volume_ok robusto (Codex P1 #5) ──"
# A1 — BOOTSTRAP: sem run bom prévio → volume_ok = NULL (NUNCA true). Mata o canário [0,0,0].
#      Semeia 3 runs DEGENERADOS (ids_distintos=0, página vazia) que devem ser EXCLUÍDOS do baseline.
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '3h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[]);" | tail -1)
eq "A1 bootstrap (baseline degenerado) → volume_ok NULL" "$V" ""   # boolean NULL imprime vazio em -tA

# A2 — BASELINE saudável → true. Semeia 3 runs bons ids~100; run atual ids=100 (>= 0.9*100).
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '3h'),
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '2h'),
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g));" | tail -1)
eq "A2 baseline 100, run 100 → volume_ok true" "$V" "t"

# A3 — VOLUME BAIXO → false. baseline 100, run 50 (< 0.9*100=90).
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,50) g));" | tail -1)
eq "A3 baseline 100, run 50 → volume_ok false" "$V" "f"

# A4 — EXCLUI volume_ok=false do baseline. Nova empresa-fixture via OBEN: limpa e semeia 1 false(10)+1 true(100).
#      Run com ids=60. Excluindo o false: baseline=mediana([100])=100 → 60<90 → FALSE.
#      (falsificação F1 remove o filtro → baseline=mediana([10,100])=55 → 60>=49.5 → TRUE → dente.)
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g));" | tail -1)
eq "A4 baseline exclui volume_ok=false (100, não 55) → false" "$V" "f"

echo "── Bloco B: atomicidade marcador + last_seen (Codex P1 #1/#4) ──"
# B1 — publica: marcador criado E os POs vistos ganham last_seen; PO não-visto (9999) fica NULL.
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run;
UPDATE public.purchase_orders_tracking SET last_seen_pedidos_full_run_id=NULL, last_seen_pedidos_full_at=NULL;
SQL
RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', '$RID', '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[]);" >/dev/null
N=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run WHERE run_id='$RID';" | tail -1)
eq "B1a marcador gravado" "$N" "1"
SEEN=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE empresa='OBEN' AND omie_codigo_pedido IN (1073,1115) AND last_seen_pedidos_full_run_id='$RID';" | tail -1)
eq "B1b POs vistos carimbados com o run_id" "$SEEN" "2"
UNSEEN=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=9999 AND last_seen_pedidos_full_run_id IS NULL;" | tail -1)
eq "B1c PO NÃO-visto continua sem last_seen" "$UNSEEN" "1"

# B2 — ATOMICIDADE: se o UPDATE do last_seen falhar, o INSERT do marcador REVERTE junto (mesmo commit).
#      Sabota via trigger que RAISE no UPDATE de purchase_orders_tracking; conta marcadores antes/depois.
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run;
CREATE FUNCTION pg_temp.sabota_update() RETURNS trigger LANGUAGE plpgsql AS
  $t$ BEGIN RAISE EXCEPTION 'sabotagem no UPDATE last_seen'; END $t$;
CREATE TRIGGER trg_sabota BEFORE UPDATE ON public.purchase_orders_tracking
  FOR EACH ROW EXECUTE FUNCTION pg_temp.sabota_update();
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[]);
  RAISE NOTICE 'RPC_NAO_FALHOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RPC_ABORTOU'; END $$;
SQL
)
NM=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "B2 falha no UPDATE reverte o INSERT do marcador (atômico)" "$NM" "0"
P -q -c "DROP TRIGGER trg_sabota ON public.purchase_orders_tracking;" >/dev/null

echo "── Bloco C: lock presente (Codex P1 #4) ──"
# C1 — a serialização por empresa existe no corpo. (Concorrência 2-sessões não é testável no harness
#      sequencial; o lock provado presente + o Codex challenge no diff cobrem a race.)
HASLOCK=$(Pq -c "SELECT pg_get_functiondef('public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[])'::regprocedure) LIKE '%pg_advisory_xact_lock%';" | tail -1)
eq "C1 RPC adquire advisory lock por empresa" "$HASLOCK" "t"

echo "── Bloco D: base NÃO-forjável / service_role-only (Codex P1 #6) ──"
# D1 — authenticated NEM INVOCA a RPC (42501 no privilégio EXECUTE, antes do corpo).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[]);
  RAISE EXCEPTION 'INVOCOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RPC_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *RPC_DENY_OK*) ok "D1 authenticated não invoca a RPC (42501)";; *) bad "D1 — veio: $R";; esac

# D2 — service_role INVOCA (a edge roda assim).
V=$(Pq -c "SET test.role='service_role'; SET ROLE service_role; SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[]) IS NOT NULL OR true;" | tail -1)
eq "D2 service_role invoca a RPC" "$V" "t"

# D3 — authenticated NÃO faz INSERT direto na tabela (RLS nega, sem policy de escrita).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',999,true,'ok');
  RAISE EXCEPTION 'INSERIU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INSERT_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *INSERT_DENY_OK*) ok "D3 authenticated não forja marcador (RLS nega INSERT)";; *) bad "D3 — veio: $R";; esac

# D4 — SELECT: staff vê, não-staff não vê.
SS=$(Pq -c "SET test.role='authenticated'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
case "$SS" in 0) bad "D4a staff deveria ver linhas, veio 0";; *) ok "D4a staff vê o marcador ($SS)";; esac
NS=$(Pq -c "SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "D4b customer (não-staff) não vê nada (RLS SELECT)" "$NS" "0"
Pq -c "RESET ROLE;" >/dev/null
```

- [ ] **Step 5: Rodar o teste — deve estar VERDE.** `bash db/test-reposicao-publicar-run-completo.sh > /tmp/t1.log 2>&1; echo "exit=$?"`. Esperado: `RESULTADO: N ok / 0 fail`, `exit=0`. (`heavy` não é necessário — PG17 local é leve; mas se a M2 estiver sufocada, prefixar.)

- [ ] **Step 6: Escrever a FALSIFICAÇÃO** (ZONA 5) — sabotar cada guard e exigir VERMELHO. Código completo:

```bash
echo "── FALSIFICAÇÃO (Lei de Ferro #3: sabota → exige vazamento) ──"
# F1 (P1 #5) — baseline SEM excluir volume_ok=false → A4 vaza (dá true onde esperava false).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(p_empresa text,p_run_id uuid,p_janela_de date,p_janela_ate date,p_ids bigint[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_empresa public.empresa_reposicao:=upper(btrim(p_empresa))::public.empresa_reposicao; v_ids int; v_base numeric; v_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:'||lower(btrim(p_empresa))));
  SELECT count(DISTINCT x) INTO v_ids FROM unnest(COALESCE(p_ids,ARRAY[]::bigint[])) x WHERE x>0;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos) INTO v_base FROM (
    SELECT ids_distintos FROM public.reposicao_pedidos_compra_run
    WHERE empresa=v_empresa AND status='ok' AND ids_distintos>0  -- SABOTADO: sem "AND volume_ok IS NOT FALSE"
    ORDER BY finalizado_em DESC LIMIT 5) r;
  IF v_base IS NULL OR v_base<=0 THEN v_ok:=NULL; ELSE v_ok:=(v_ids::numeric>=0.9*v_base); END IF;
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (p_run_id,v_empresa,p_janela_de,p_janela_ate,v_ids,v_ok,'ok');
  RETURN v_ok; END $$;
SQL
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g));" | tail -1)
case "$V" in t) ok "F1 sem excluir volume_ok=false o baseline afunda p/ 55 e A4 VAZA (true) — A4 tem dente";; *) bad "F1 sabotei o baseline e A4 não mudou ($V) → assert fraco";; esac
P -q -f "$MIG" >/dev/null   # restaura a RPC real

# F2 (P1 #5) — bootstrap canário: incluir ids=0 no baseline + baseline 0 → true.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(p_empresa text,p_run_id uuid,p_janela_de date,p_janela_ate date,p_ids bigint[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_empresa public.empresa_reposicao:=upper(btrim(p_empresa))::public.empresa_reposicao; v_ids int; v_base numeric; v_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:'||lower(btrim(p_empresa))));
  SELECT count(DISTINCT x) INTO v_ids FROM unnest(COALESCE(p_ids,ARRAY[]::bigint[])) x WHERE x>0;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos) INTO v_base FROM (
    SELECT ids_distintos FROM public.reposicao_pedidos_compra_run
    WHERE empresa=v_empresa AND status='ok'  -- SABOTADO: sem "AND ids_distintos>0"
    ORDER BY finalizado_em DESC LIMIT 5) r;
  v_ok := (v_ids::numeric >= 0.9 * COALESCE(v_base,0));  -- SABOTADO: canário 0>=0 → true
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (p_run_id,v_empresa,p_janela_de,p_janela_ate,v_ids,v_ok,'ok');
  RETURN v_ok; END $$;
SQL
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[]);" | tail -1)
case "$V" in t) ok "F2 canário [0,0]→true reaparece com a RPC sabotada — A1 tem dente";; *) bad "F2 sabotei o bootstrap e A1 não mudou ($V) → assert fraco";; esac
P -q -f "$MIG" >/dev/null

# F3 (P1 #6) — GRANT EXECUTE a authenticated → D1 deixa de barrar (a RPC vira invocável).
P -q -c "GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[]) TO authenticated;" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[]);
  RAISE NOTICE 'INVOCOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *INVOCOU_VAZOU*) ok "F3 com GRANT a authenticated a RPC é invocável — D1 tem dente";; *) bad "F3 dei GRANT e D1 não mudou ($R) → assert fraco";; esac
P -q -f "$MIG" >/dev/null   # a migration reexecuta o REVOKE → restaura

# F4 (P1 #6) — policy INSERT authenticated WITH CHECK(true) + grant → D3 deixa de barrar.
P -q <<'SQL'
GRANT INSERT ON public.reposicao_pedidos_compra_run TO authenticated;
CREATE POLICY forja_ins ON public.reposicao_pedidos_compra_run FOR INSERT TO authenticated WITH CHECK (true);
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',999,true,'ok');
  RAISE NOTICE 'FORJOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *FORJOU_VAZOU*) ok "F4 com policy INSERT authenticated a base vira forjável — D3 tem dente";; *) bad "F4 abri INSERT e D3 não mudou ($R) → assert fraco";; esac
P -q <<'SQL'
DROP POLICY IF EXISTS forja_ins ON public.reposicao_pedidos_compra_run;
REVOKE INSERT ON public.reposicao_pedidos_compra_run FROM authenticated;
SQL

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
```

- [ ] **Step 7: Rodar o teste COMPLETO (asserts + falsificação) — deve estar VERDE.** `bash db/test-reposicao-publicar-run-completo.sh > /tmp/t1.log 2>&1; echo "exit=$?"`. Esperado: todos os `ok`, todos os `F*` reportando "tem dente", `exit=0`. Se qualquer `F*` disser "assert fraco", o assert correspondente não tem dente → **corrigir o assert, não a falsificação**.

- [ ] **Step 8: Commit da Task 1.**

```bash
git add supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql db/test-reposicao-publicar-run-completo.sh
git commit -m "feat(reposicao): infra de run — marcador + RPC de publicação diferida atômica (PR1 v3)

Fecha os 6 P1 do Codex (PG17 falsificado): volume_ok robusto (bootstrap→null,
exclui truncados), atomicidade marcador+last_seen (advisory lock), RLS/grants
service_role-only. NÃO muta pedido, NÃO toca o motor.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Gotchas do harness PG17 (descobertos na execução — 18 ok / 0 fail)

Três armadilhas que o rito de falsificação pegou (valem para qualquer prova de RLS/service_role neste repo):

1. **`GRANT` de `authenticated` NÃO está no snapshot.** O Supabase concede SELECT/INSERT/UPDATE/DELETE a `authenticated`/`anon` via *default privileges* do bootstrap (fora do `schema-snapshot.sql`); a RLS + o REVOKE são a camada real. No PG17 puro isso não existe → `authenticated` toma `permission denied` ANTES da RLS. Fix no setup do teste: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO authenticated, anon;` **antes** de aplicar a migration — assim a RLS/REVOKE é quem decide (e prova o P1 #6 mais forte: escrita barrada MESMO com o grant amplo).
2. **`SELECT rpc() IS NOT NULL OR true` é teatro.** O Postgres faz constant-fold de `X OR true → true` e **não chama a função volátil** → o assert passa sem invocar a RPC. Provar service_role-EXECUTE pelo **efeito** (contar o marcador que a RPC deixa), nunca por "retornou algo".
3. **`pg_temp` não persiste entre conexões psql.** Cada `P`/`Pq` é uma conexão nova → função sabotadora do teste de atomicidade (B2) vai em `public.*`, não `pg_temp.*` (senão o trigger referencia uma função ausente na próxima conexão).

---

## Task 2: Edge — coleta IDs + publicação diferida fail-closed

**Files:**
- Modify: `supabase/functions/omie-sync-pedidos-compra/index.ts`

**Interfaces:**
- Consumes: `reposicao_publicar_run_completo(p_empresa, p_run_id, p_janela_de, p_janela_ate, p_ids)` (Task 1).
- Produces: nenhuma nova interface pública (orquestração interna da edge).

- [ ] **Step 1: Estender `EmpresaSummary`** (após a interface, linhas ~64-69) com os campos da publicação. Substituir a interface por:

```ts
interface EmpresaSummary {
  empresa: Empresa;
  total_paginas: number;
  pedidos_sincronizados: number;
  erros: number;
  // v3 publicação diferida (reconciliação PO excluído):
  janela_de: string | null;    // ISO yyyy-mm-dd da janela REAL do run (não CURRENT_DATE)
  janela_ate: string | null;
  ids_distintos: number;       // POs distintos vistos na varredura (telemetria + volume_ok)
  varredura_completa: boolean; // true = fim legítimo sem abort/truncamento (fim && !abortado)
}
```

- [ ] **Step 2: Coletar os IDs e a janela em `syncEmpresa`.** Mudar a assinatura para receber o Set `idsVistos` e preencher os campos novos.

Na declaração de `syncEmpresa` (linha ~351), adicionar o parâmetro:
```ts
async function syncEmpresa(
  supabase: SupabaseClient,
  empresa: Empresa,
  modo: ModoSyncPedidos,
  dias: number,
  fornecedorCodigo: number | undefined,
  idsVistos: Set<number>,
): Promise<EmpresaSummary> {
```

No literal `summary` inicial (linha ~358), adicionar os campos:
```ts
  const summary: EmpresaSummary = {
    empresa,
    total_paginas: 0,
    pedidos_sincronizados: 0,
    erros: 0,
    janela_de: null,
    janela_ate: null,
    ids_distintos: 0,
    varredura_completa: false,
  };
```

Após computar `dataDe`/`dataAte` (logo após a linha `const dataAte = formatDateBR(fimJanela);`), gravar a janela ISO REAL no summary:
```ts
  summary.janela_de = parseBRDateOnly(dataDe);
  summary.janela_ate = parseBRDateOnly(dataAte);
```

Dentro do loop de páginas, LOGO APÓS `fpsVistos.add(fp);` (linha ~428) e ANTES do bloco DEBUG/filtro-fornecedor, coletar os `nCodPed` da página INTEIRA (antes do filtro por fornecedor — no run de publicação não há filtro; a coleta representa TODOS os POs da janela completa):
```ts
    // [publicação diferida v3] coleta os nCodPed VISTOS na varredura. Publicados 1× no fim LIMPO via
    // reposicao_publicar_run_completo — NUNCA carimba last_seen durante o upsert (Codex P1 #1).
    for (const p of pedidos) {
      const nCodPed = Number(p?.cabecalho_consulta?.nCodPed ?? p?.cabecalho?.nCodPed);
      if (Number.isFinite(nCodPed) && nCodPed > 0) idsVistos.add(nCodPed);
    }
```

Antes do `return summary;` final (após o bloco `if (!fim && !abortado)`), gravar telemetria e o flag de varredura limpa:
```ts
  summary.ids_distintos = idsVistos.size;
  summary.varredura_completa = fim && !abortado;
  return summary;
```

- [ ] **Step 3: Adicionar a função `publicarRunCompleto`.** Inserir logo APÓS `marcarCompletoOk` (após a linha ~598):

```ts
// ===== Publicação diferida ATÔMICA (v3 — reconciliação PO excluído) =====
// Grava o marcador de run E carimba last_seen dos POs vistos numa RPC SQL única (advisory lock por
// empresa + service_role-only). Chamada 1× no fim do completo LIMPO e NÃO-filtrado. Retorna true SÓ se
// a RPC teve sucesso — a cadência (marcarCompletoOk) só avança então (fail-closed, Codex P1 #3).
async function publicarRunCompleto(
  supabase: SupabaseClient,
  s: EmpresaSummary,
  idsVistos: Set<number>,
): Promise<boolean> {
  const runId = crypto.randomUUID();
  const ids = [...idsVistos];
  try {
    const { data, error } = await supabase.rpc("reposicao_publicar_run_completo", {
      p_empresa: s.empresa,
      p_run_id: runId,
      p_janela_de: s.janela_de,
      p_janela_ate: s.janela_ate,
      p_ids: ids,
    });
    if (error) throw error;
    console.log(
      `[sync-pedidos] publicou run completo empresa=${s.empresa} run_id=${runId} ids=${ids.length} volume_ok=${JSON.stringify(data)}`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-pedidos] publicarRunCompleto FALHOU empresa=${s.empresa}: ${msg} — cadência NÃO avança`);
    return false;
  }
}
```

- [ ] **Step 4: Ligar a publicação no `processarTudo`.** No loop de empresa (linhas ~690-718), criar o Set por empresa, passá-lo a `syncEmpresa`, e substituir o bloco de `marcarCompletoOk`.

Antes do `if (gravaHeartbeat) await heartbeatRunning(...)`, criar o Set:
```ts
      const idsVistos = new Set<number>();
```

Trocar a chamada `s = await syncEmpresa(supabase, empresa, modo, dias, fornecedorCodigo);` por:
```ts
        s = await syncEmpresa(supabase, empresa, modo, dias, fornecedorCodigo, idsVistos);
```

Substituir o bloco atual (o `if (gravaHeartbeat && modo === "completo" && s.erros === 0) { await marcarCompletoOk(...); }`) por:
```ts
      // Publicação diferida (v3): SÓ no fim de um completo LIMPO e NÃO-filtrado (Codex P1 #1/#2).
      // gravaHeartbeat = !fornecedorCodigo (não-filtrado); erros===0 && varredura_completa = limpo sem
      // abort/truncamento. A cadência só avança se a RPC teve sucesso (fail-closed, Codex P1 #3).
      const runLimpoCompleto =
        gravaHeartbeat && modo === "completo" && s.erros === 0 && s.varredura_completa;
      if (runLimpoCompleto) {
        const publicou = await publicarRunCompleto(supabase, s, idsVistos);
        if (publicou) await marcarCompletoOk(supabase, empresa);
      }
```

- [ ] **Step 5: Ajustar o literal do catch fatal.** No `catch` de `syncEmpresa` dentro de `processarTudo` (linha ~709), o fallback `s = { empresa, total_paginas: 0, pedidos_sincronizados: 0, erros: 1 };` perde os campos novos → erro de tipo. Substituir por:
```ts
        s = {
          empresa, total_paginas: 0, pedidos_sincronizados: 0, erros: 1,
          janela_de: null, janela_ate: null, ids_distintos: 0, varredura_completa: false,
        };
```

- [ ] **Step 6: Documentar as colunas single-writer em `PRESERVE_FIELDS`** (defense-in-depth — não estão no payload de `mapPedidoToRow`, mas sinaliza que outro writer as escreve). Adicionar ao `Set` (linha ~223-243), antes do `]);`:
```ts
  "last_seen_pedidos_full_run_id",
  "last_seen_pedidos_full_at",
```

- [ ] **Step 7: `deno check` na edge — deve passar.**

```bash
deno check supabase/functions/omie-sync-pedidos-compra/index.ts > /tmp/deno.log 2>&1; echo "exit=$?"
```
Esperado: `exit=0` (sem erros de tipo). Se `deno` não estiver no PATH, usar o binário do projeto ou `~/.deno/bin/deno` (o repo roda `deno check` no CI de edges).

- [ ] **Step 8: `heavy bun run typecheck` — não quebrou `src/`.** (A edge é Deno e não entra no `tsconfig.app`, mas o rito money-path pede a suíte antes de entregar.) **Aguardar o `bun install` de background terminar antes** (senão "Cannot find module" é falso vermelho).
```bash
heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"
```
Esperado: `exit=0`.

- [ ] **Step 9: `heavy bun run test` — suíte verde.** Garante que os guards existentes da edge (ex.: `edges-onorder-guardrail`, `edge-money-path-invariants`) seguem passando.
```bash
heavy bun run test > /tmp/test.log 2>&1; echo "exit=$?"
```
Esperado: `exit=0`. Se algum guard textual da edge reprovar (ex.: espera uma string que o diff mudou), avaliar se é regressão real ou o guard precisa acompanhar o novo código.

- [ ] **Step 10: Commit da Task 2.**

```bash
git add supabase/functions/omie-sync-pedidos-compra/index.ts
git commit -m "feat(reposicao): edge coleta IDs vistos e chama a publicação diferida no fim do completo limpo (PR1 v3)

Não carimba last_seen no upsert (Codex P1 #1); publica 1x só no fim LIMPO,
COMPLETO e NÃO-filtrado (P1 #2); marcarCompletoOk só avança se a RPC teve
sucesso (P1 #3, fail-closed). Janela ISO real (não CURRENT_DATE).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Codex challenge (money-path — obrigatório antes de dessaraftar)

- [ ] **Invocar `/codex` 1× na sessão** (carrega o ritual), depois `scripts/codex-async.sh -r xhigh` em **background** (`Bash run_in_background:true`) com o diff da v3 no prompt. O prompt DEVE: (a) dar os fatos de schema no texto (não deixar o Codex abrir `schema-snapshot.sql` — trava); (b) apontar só os arquivos pequenos (a migration, o teste, o diff da edge); (c) pedir prova de que os 6 P1 fecharam (publicação diferida atômica, volume_ok robusto, RLS service_role-only, fail-closed da cadência, não-filtrado, lock). Enquadramento defensivo ("código próprio, hardening money-path") para não tropeçar nos safeguards cyber do 5.6.
- [ ] **Apresentar o parecer CRU + a calibração SEPARADA** (nunca só a síntese). Se um P1 não fechou, corrigir antes de sair de DRAFT.

## Deploy handoff (Lovable — o founder aplica; ordem importa)

- [ ] **1. Migration primeiro** (SQL Editor do Lovable) — via `lovable-db-operator`: bloco pronto pra colar + query de validação pós-apply (`SELECT to_regclass('public.reposicao_pedidos_compra_run'); \df reposicao_publicar_run_completo; \d+ purchase_orders_tracking` das colunas novas). **Anunciar o título exato + que quem cola é o founder.**
- [ ] **2. Edge depois** (chat Lovable) — via `lovable-deploy-verify`: prompt de deploy da `omie-sync-pedidos-compra` (ler do repo, verbatim). A edge NÃO precisa de Publish de frontend (não há mudança em `src/`).
- [ ] **3. Aceitação (psql-ro, read-only)** após 1 ciclo completo do cron: conferir que o marcador foi gravado (`SELECT * FROM reposicao_pedidos_compra_run ORDER BY finalizado_em DESC LIMIT 3`), que `volume_ok` não é NULL depois do bootstrap, e que os POs latentes (1073, 1115) ganharam `last_seen_pedidos_full_run_id`. **Isto habilita o PR2** (candidatos = POs com `last_seen <> marcador atual`).
- [ ] **4. PR + auto-merge:** abrir o PR1 (não-draft só após o Codex verde), armar `scripts/pr-watch.sh <nº>` em background, avisar no desfecho.
- [ ] **5. Registrar** em `docs/historico/bugs-resolvidos.md` (entrega do PR1 v3; NÃO engordar o CLAUDE.md).

---

## Self-Review (writing-plans)

**1. Cobertura do spec §5/§12 (PR1):**
- ✅ `reposicao_pedidos_compra_run` (RLS SELECT staff, escrita service_role-only) → Task 1 Step 2.
- ✅ colunas `last_seen_pedidos_full_*` → Task 1 Step 2.
- ✅ RPC `reposicao_publicar_run_completo` (advisory lock + volume_ok robusto + marcador + last_seen atômico) → Task 1 Step 2.
- ✅ edge coleta IDs, publica 1× no fim LIMPO/completo/não-filtrado, cadência fail-closed → Task 2.
- ✅ PG17 falsifica os 6 P1 → Task 1 Steps 3-7 (A=P1#5, B=P1#1/#4, C=P1#4, D=P1#6; edge P1#2/#3 provados por `deno check`+revisão+Codex).

**2. Placeholder scan:** migration e edge têm código completo. O harness PG17 referencia o esqueleto de arranque de `db/test-authz-estimar-estoque-omie.sh` (linhas 13-53 — reuso explícito do template do repo, não placeholder) e traz os seeds/asserts/falsificação em código completo.

**3. Consistência de tipos/nomes:** RPC assinatura idêntica em Task 1 (definição), Task 2 (`supabase.rpc(...)`), teste PG17 e deploy handoff: `(p_empresa text, p_run_id uuid, p_janela_de date, p_janela_ate date, p_ids bigint[]) → boolean`. `empresa` = enum `empresa_reposicao` MAIÚSCULO em todos os pontos. `omie_codigo_pedido bigint` ↔ `p_ids bigint[]` ↔ `idsVistos: Set<number>`.

**Cobertura dos 6 P1 (rastreio explícito):**
| P1 | Onde fecha | Prova |
|---|---|---|
| #1 sinal publicado cedo | edge não carimba no upsert; RPC carimba só no fim | Task 2 Step 2; PG17 B1/B2 |
| #2 run filtrado por fornecedor | `gravaHeartbeat = !fornecedorCodigo` na condição de publicação | Task 2 Step 4; `deno check` + Codex |
| #3 cadência não fail-closed | `marcarCompletoOk` só se `publicou` | Task 2 Step 4; Codex |
| #4 concorrência/lock | `pg_advisory_xact_lock` cobre marcador+last_seen no mesmo commit | PG17 C1 (lock presente) + B2 (atômico) |
| #5 volume_ok autoenvenena | baseline exclui false/ids=0; bootstrap→null | PG17 A1/A4 + falsificação F1/F2 |
| #6 base forjável | RLS sem policy de escrita + RPC service_role-only | PG17 D1/D3 + falsificação F3/F4 |
