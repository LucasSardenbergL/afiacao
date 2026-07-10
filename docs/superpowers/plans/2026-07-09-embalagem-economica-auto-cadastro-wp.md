# Embalagem econômica — auto-cadastro dos pares QT+GL de todos os WP (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda cor de concentrado WP.3900 com QT+GL ativos no Omie aparece sozinha na tela Embalagem econômica, sem SQL manual — via função de sincronização insert-only + cron diário + botão + backfill.

**Architecture:** Uma função SQL `SECURITY DEFINER` deriva os pares QT+GL de `omie_products` (Oben) e preenche `sku_embalagem_equivalencia` (insert-only, idempotente). Um cron diário a mantém em dia; um botão na tela força na hora; o backfill na migração destrava os 11 pares faltantes no apply. A tela já lê a tabela — nenhuma mudança na query. Advisory puro (nenhum WP passa pelo motor de compra).

**Tech Stack:** PostgreSQL 17 (plpgsql), Supabase (RLS, pg_cron), React 18 + TS strict, @tanstack/react-query, sonner, shadcn/ui.

## Global Constraints

- **Deploy Lovable = 3 camadas MANUAIS.** Migration custom NÃO auto-aplica (falha silenciosa). Fonte versionada vai em `db/embalagem-auto-cadastro-wp.sql` (vira o bloco pra colar no SQL Editor). **NUNCA** criar/editar arquivo em `supabase/migrations/` (é snapshot de DR).
- **Money-path adjacente** (a tabela é lida pelo motor): prova em **PG17 local com falsificação** obrigatória antes de entregar (`db/test-embalagem-auto-cadastro-wp.sh`).
- **Gate cron-or-staff:** com usuário logado, exige staff; cron (`auth.uid()=NULL`) passa. **NUNCA** gatear por `auth.role()='service_role'` (mata cron SQL-local — lição `reposicao.md`). PG17 stuba `auth.uid()=NULL` para o caso cron.
- **Escopo travado:** só `^WP[0-9]+\.[0-9]+(QT|GL) `, `account='oben'`, `ativo=true`, cor com QT **e** GL. Nada mais.
- **Insert-only:** nunca UPDATE/DELETE de cadastro. Valores fixos: `unidade_base='QT'`, `fator_para_base` QT=1/GL=4, `fornecedor_nome='Sayerlack'`, `criado_por='auto:embalagem-wp'`.
- **Idioma:** PT-BR em código/rotas/commits. **Toast:** só `sonner`. **Status colors:** `text-status-*`.
- **Testes:** `heavy bun run test` (vitest canônico), `heavy bun run typecheck`, `bun run lint`. `| tail` engole exit code — use `> log 2>&1; echo $?`.

---

### Task 1: Função de sincronização + audit log + gate authz, provada em PG17

**Files:**
- Create: `db/embalagem-auto-cadastro-wp.sql`
- Create: `db/test-embalagem-auto-cadastro-wp.sh`

**Interfaces:**
- Produces: `public.reposicao_sincronizar_embalagem_wp(p_empresa text DEFAULT 'oben') RETURNS jsonb` — retorna `{empresa, cores_elegiveis, linhas_inseridas}`. Cadastra em `sku_embalagem_equivalencia` os pares faltantes; loga em `reposicao_embalagem_sync_log`.
- Produces: tabela `public.reposicao_embalagem_sync_log(id, empresa, executado_em, disparado_por, cores_elegiveis, linhas_inseridas, detalhes)`.

- [ ] **Step 1: Escrever o harness PG17 (falha: função ainda não existe)**

Create `db/test-embalagem-auto-cadastro-wp.sh` (baseado em `db/test-reposicao-consolidacao-demanda.sh`):

```bash
#!/usr/bin/env bash
# Harness PG17 do AUTO-CADASTRO de embalagem WP (QT+GL) — prova que a função
# pareia todo WP.3900 com QT+GL ativos no Omie e preenche sku_embalagem_equivalencia
# (insert-only, idempotente), com gate cron-or-staff. Money-path adjacente: asserts
# positivos + negativos + authz + FALSIFICAÇÃO. Spec: docs/superpowers/specs/2026-07-09-…-design.md
# Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443; DATA="$(mktemp -d /tmp/pgtest-embwp.XXXXXX)/data"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-embwp.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres embwp_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d embwp_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-embwp.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"; rm -f "$RR"

echo "→ stub cron.schedule (pg_cron ausente no PG17 local)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS cron;
CREATE OR REPLACE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
SQL

echo "→ seed omie_products (14 WP QT+GL ativos) + WP99 (GL inativo) + WP98 (só QT) + 3 pares pré-cadastrados…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- omie_products: colunas mínimas (o snapshot tem defaults nas demais)
INSERT INTO omie_products (omie_codigo_produto, codigo, descricao, unidade, ativo, account) VALUES
  (1001,'P1001','WP01.3900QT CONCENTRADO PRETO','L',true,'oben'),
  (1002,'P1002','WP01.3900GL CONCENTRADO PRETO','L',true,'oben'),
  (1041,'P1041','WP04.3900QT CONCENTRADO AZUL','L',true,'oben'),
  (1042,'P1042','WP04.3900GL CONCENTRADO AZUL','L',true,'oben'),
  (1121,'P1121','WP12.3900QT CONCENTRADO CINZA','L',true,'oben'),
  (1122,'P1122','WP12.3900GL CONCENTRADO CINZA','L',true,'oben'),
  (1991,'P1991','WP99.3900QT CONCENTRADO TESTE','L',true,'oben'),
  (1992,'P1992','WP99.3900GL CONCENTRADO TESTE','L',false,'oben'),   -- GL INATIVO → cor NÃO entra
  (1981,'P1981','WP98.3900QT CONCENTRADO SOZINHO','L',true,'oben'),  -- só QT → NÃO entra
  (1123,'P1123','WP12.3900GL CONCENTRADO CINZA','L',true,'colacor'); -- outra conta → ignorado
-- 1 par pré-cadastrado (WP04) c/ grupo conhecido, p/ provar REUSO de grupo
INSERT INTO sku_embalagem_equivalencia (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base, fornecedor_nome, ativo, criado_por) VALUES
  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','1041','QT',1,'Sayerlack',true,'founder'),
  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','1042','QT',4,'Sayerlack',true,'founder');
-- staff e não-staff p/ o gate (has_role real lê user_roles)
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');
INSERT INTO user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');
SQL

echo "→ aplica a migração candidata (cria tabela+função+cron; RODA O BACKFILL no fim)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/embalagem-auto-cadastro-wp.sql" >/dev/null

echo "→ A. backfill cadastrou WP01+WP12 (novos) e manteve WP04; WP99/WP98/colacor fora…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE n_grupos int; n_wp04_grupo uuid; n_wp99 int; n_wp98 int; n_col int;
BEGIN
  SELECT count(DISTINCT grupo_id) INTO n_grupos FROM sku_embalagem_equivalencia WHERE empresa='oben' AND ativo;
  IF n_grupos <> 3 THEN RAISE EXCEPTION 'FAIL A1: esperava 3 grupos (WP01,WP04,WP12), veio %', n_grupos; END IF;
  -- REUSO: WP04 mantém o grupo original
  SELECT grupo_id INTO n_wp04_grupo FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1041';
  IF n_wp04_grupo <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' THEN RAISE EXCEPTION 'FAIL A2: WP04 trocou de grupo %', n_wp04_grupo; END IF;
  SELECT count(*) INTO n_wp99 FROM sku_embalagem_equivalencia WHERE sku_codigo_omie IN ('1991','1992');
  IF n_wp99 <> 0 THEN RAISE EXCEPTION 'FAIL A3: WP99 (GL inativo) entrou (%)', n_wp99; END IF;
  SELECT count(*) INTO n_wp98 FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1981';
  IF n_wp98 <> 0 THEN RAISE EXCEPTION 'FAIL A4: WP98 (só QT) entrou'; END IF;
  SELECT count(*) INTO n_col FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1123';
  IF n_col <> 0 THEN RAISE EXCEPTION 'FAIL A5: par colacor entrou'; END IF;
END $$;
SQL
echo "   ✓ A"

echo "→ B. fator/unidade: WP01 QT=1, GL=4, unidade_base=QT…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE f_qt numeric; f_gl numeric; u text;
BEGIN
  SELECT fator_para_base, unidade_base INTO f_qt, u FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1001';
  SELECT fator_para_base INTO f_gl FROM sku_embalagem_equivalencia WHERE sku_codigo_omie='1002';
  IF f_qt <> 1 OR f_gl <> 4 OR u <> 'QT' THEN RAISE EXCEPTION 'FAIL B: WP01 QT=% GL=% u=%', f_qt, f_gl, u; END IF;
END $$;
SQL
echo "   ✓ B"

echo "→ C. idempotência: 2ª chamada (contexto cron, auth.uid()=NULL) insere 0…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  r := reposicao_sincronizar_embalagem_wp('oben');
  IF (r->>'linhas_inseridas')::int <> 0 THEN RAISE EXCEPTION 'FAIL C: 2ª run inseriu % (esperado 0)', r->>'linhas_inseridas'; END IF;
END $$;
SQL
echo "   ✓ C"

echo "→ D. authz: não-staff → 42501; staff → ok; cron(NULL) → ok…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
-- não-staff
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '22222222-2222-2222-2222-222222222222'::uuid $$;
DO $$
BEGIN
  PERFORM reposicao_sincronizar_embalagem_wp('oben');
  RAISE EXCEPTION 'FAIL D1: não-staff NÃO foi barrado';
EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- esperado
END $$;
-- staff
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;
DO $$ BEGIN PERFORM reposicao_sincronizar_embalagem_wp('oben'); END $$;  -- não lança
-- cron (volta pro NULL do stub base)
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN PERFORM reposicao_sincronizar_embalagem_wp('oben'); END $$;  -- não lança
SQL
echo "   ✓ D"

echo "→ E. audit log gravou runs…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM reposicao_embalagem_sync_log WHERE empresa='oben';
  IF n < 1 THEN RAISE EXCEPTION 'FAIL E: sem linha de audit'; END IF;
END $$;
SQL
echo "   ✓ E"

echo "✅ TODOS OS ASSERTS VERDES"
```

- [ ] **Step 2: Rodar o harness e confirmar que FALHA (função ausente)**

Run: `chmod +x db/test-embalagem-auto-cadastro-wp.sh && ./db/test-embalagem-auto-cadastro-wp.sh > /tmp/embwp.log 2>&1; echo "exit=$?"`
Expected: exit≠0, log com erro ao aplicar `db/embalagem-auto-cadastro-wp.sql` (arquivo não existe ainda) ou "function reposicao_sincronizar_embalagem_wp does not exist".

- [ ] **Step 3: Escrever a migração (tabela + função + grants)**

Create `db/embalagem-auto-cadastro-wp.sql`:

```sql
-- Auto-cadastro dos pares QT+GL dos concentrados WP.3900 na Embalagem econômica.
-- Fonte VERSIONADA → colar no SQL Editor do Lovable (migration custom NÃO auto-aplica).
-- NÃO editar supabase/migrations/. Advisory: nenhum WP passa pelo motor.
-- Prova: db/test-embalagem-auto-cadastro-wp.sql. Spec: docs/superpowers/specs/2026-07-09-…-design.md

-- 1) Audit log (staff-only na leitura; escrita só pela função SECURITY DEFINER)
CREATE TABLE IF NOT EXISTS public.reposicao_embalagem_sync_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa          text NOT NULL,
  executado_em     timestamptz NOT NULL DEFAULT now(),
  disparado_por    text NOT NULL,
  cores_elegiveis  int NOT NULL,
  linhas_inseridas int NOT NULL,
  detalhes         jsonb
);
ALTER TABLE public.reposicao_embalagem_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_embalagem_sync_log_staff_read ON public.reposicao_embalagem_sync_log;
CREATE POLICY reposicao_embalagem_sync_log_staff_read ON public.reposicao_embalagem_sync_log
  FOR SELECT USING (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role));

-- 2) Função de sincronização (insert-only, idempotente, gate cron-or-staff)
CREATE OR REPLACE FUNCTION public.reposicao_sincronizar_embalagem_wp(p_empresa text DEFAULT 'oben')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_disparado_por text;
  v_cores int := 0;
  v_linhas int := 0;
  v_ins int;
  r record;
  v_grupo uuid;
BEGIN
  -- Gate cron-or-staff: usuário logado exige staff; cron (auth.uid()=NULL) passa.
  -- NUNCA gatear por auth.role()='service_role' (mata cron SQL-local — reposicao.md §Outras frentes).
  IF v_uid IS NOT NULL
     AND NOT (has_role(v_uid,'employee'::app_role) OR has_role(v_uid,'master'::app_role)) THEN
    RAISE EXCEPTION 'não autorizado' USING ERRCODE = '42501';
  END IF;
  v_disparado_por := CASE WHEN v_uid IS NULL THEN 'cron' ELSE 'manual:'||v_uid::text END;

  FOR r IN
    WITH wp AS (
      SELECT substring(descricao FROM '^(WP[0-9]+\.[0-9]+)') AS cor,
             substring(descricao FROM '^WP[0-9]+\.[0-9]+([A-Z0-9]+)') AS sufixo,
             omie_codigo_produto
      FROM public.omie_products
      WHERE account = p_empresa AND ativo
        AND descricao ~ '^WP[0-9]+\.[0-9]+(QT|GL) '
    )
    SELECT cor,
           max(omie_codigo_produto) FILTER (WHERE sufixo='QT') AS qt,
           max(omie_codigo_produto) FILTER (WHERE sufixo='GL') AS gl
    FROM wp GROUP BY cor
    HAVING count(*) FILTER (WHERE sufixo='QT') = 1
       AND count(*) FILTER (WHERE sufixo='GL') = 1
  LOOP
    v_cores := v_cores + 1;
    -- Reusa o grupo da cor se já cadastrada; senão gera novo.
    SELECT grupo_id INTO v_grupo
    FROM public.sku_embalagem_equivalencia
    WHERE empresa = p_empresa AND ativo AND sku_codigo_omie IN (r.qt::text, r.gl::text)
    LIMIT 1;
    IF v_grupo IS NULL THEN v_grupo := gen_random_uuid(); END IF;

    -- Insere só as embalagens faltantes (idempotente; NOT EXISTS protege colisão).
    INSERT INTO public.sku_embalagem_equivalencia
      (empresa, grupo_id, sku_codigo_omie, unidade_base, fator_para_base, fornecedor_nome, ativo, criado_por)
    SELECT p_empresa, v_grupo, x.sku::text, 'QT', x.fator, 'Sayerlack', true, 'auto:embalagem-wp'
    FROM (VALUES (r.qt, 1::numeric), (r.gl, 4::numeric)) AS x(sku, fator)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sku_embalagem_equivalencia s
      WHERE s.empresa = p_empresa AND s.ativo AND s.sku_codigo_omie = x.sku::text
    );
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    v_linhas := v_linhas + v_ins;
  END LOOP;

  INSERT INTO public.reposicao_embalagem_sync_log (empresa, disparado_por, cores_elegiveis, linhas_inseridas)
  VALUES (p_empresa, v_disparado_por, v_cores, v_linhas);

  RETURN jsonb_build_object('empresa', p_empresa, 'cores_elegiveis', v_cores, 'linhas_inseridas', v_linhas);
END $$;

REVOKE ALL ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_sincronizar_embalagem_wp(text) TO authenticated, service_role;
```

- [ ] **Step 4: Rodar o harness e confirmar VERDE**

Run: `./db/test-embalagem-auto-cadastro-wp.sh > /tmp/embwp.log 2>&1; echo "exit=$?"`
Expected: exit=0, log termina com `✅ TODOS OS ASSERTS VERDES` (asserts A–E passam).

- [ ] **Step 5: FALSIFICAR — sabotar o filtro "ambos ativos" e exigir vermelho**

Temporariamente troque no `db/embalagem-auto-cadastro-wp.sql` a cláusula `WHERE account = p_empresa AND ativo` por `WHERE account = p_empresa` (remove o `AND ativo`).
Run: `./db/test-embalagem-auto-cadastro-wp.sh > /tmp/embwp-fals.log 2>&1; echo "exit=$?"`
Expected: exit≠0 com `FAIL A3` (WP99 de GL inativo passou a entrar). **Reverta a sabotagem** e confirme verde de novo (Step 4).

- [ ] **Step 6: FALSIFICAR — remover a proteção de idempotência e exigir vermelho**

Temporariamente remova o bloco `WHERE NOT EXISTS (...)` do INSERT.
Run: `./db/test-embalagem-auto-cadastro-wp.sh > /tmp/embwp-fals2.log 2>&1; echo "exit=$?"`
Expected: exit≠0 — o backfill duplica WP04 (viola `uniq_sku_emb_equiv_ativo`) ou o assert C acusa `linhas_inseridas<>0`. **Reverta** e confirme verde (Step 4).

- [ ] **Step 7: Commit**

```bash
git add db/embalagem-auto-cadastro-wp.sql db/test-embalagem-auto-cadastro-wp.sh
git commit -m "feat(reposicao): função de auto-cadastro de embalagem WP + prova PG17

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Cron diário + backfill (migração final empacotada)

**Files:**
- Modify: `db/embalagem-auto-cadastro-wp.sql` (append no fim)
- Modify: `db/test-embalagem-auto-cadastro-wp.sh` (o backfill já roda no apply; nenhuma mudança de assert)

**Interfaces:**
- Consumes: `public.reposicao_sincronizar_embalagem_wp(text)` (Task 1).
- Produces: cron `reposicao-embalagem-cadastro-wp-daily` (09:00 UTC); backfill executado no apply.

- [ ] **Step 1: Anexar cron + backfill ao fim do `db/embalagem-auto-cadastro-wp.sql`**

```sql

-- 3) Cron diário — 09:00 UTC (06:00 BRT), logo após o sync de catálogo (08:30 UTC).
-- cron.schedule por NOME é upsert (rodar de novo não duplica).
SELECT cron.schedule(
  'reposicao-embalagem-cadastro-wp-daily',
  '0 9 * * *',
  $$SELECT public.reposicao_sincronizar_embalagem_wp('oben')$$
);

-- 4) Backfill no apply — destrava imediatamente os pares faltantes (cadastra os 11).
SELECT public.reposicao_sincronizar_embalagem_wp('oben');
```

- [ ] **Step 2: Rodar o harness — o backfill no apply deve deixar tudo verde**

Run: `./db/test-embalagem-auto-cadastro-wp.sh > /tmp/embwp.log 2>&1; echo "exit=$?"`
Expected: exit=0, `✅ TODOS OS ASSERTS VERDES` (o `cron.schedule` usa o stub; o backfill roda e o assert A confirma os 3 grupos).

- [ ] **Step 3: Commit**

```bash
git add db/embalagem-auto-cadastro-wp.sql
git commit -m "feat(reposicao): cron diário + backfill do auto-cadastro de embalagem WP

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Botão "Sincronizar cadastro" na tela

**Files:**
- Modify: `src/pages/AdminReposicaoEmbalagem.tsx` (imports + header 176–184)

**Interfaces:**
- Consumes: RPC `reposicao_sincronizar_embalagem_wp` (Task 1) via `supabase.rpc`.

- [ ] **Step 1: Adicionar imports**

Em `src/pages/AdminReposicaoEmbalagem.tsx`, trocar a linha 8 e a 14, e ampliar os imports:

```tsx
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
```

E na linha dos ícones (14), acrescentar `RefreshCw`:

```tsx
import { Package, Info, RefreshCw } from 'lucide-react';
```

- [ ] **Step 2: Adicionar a mutation e o header com botão (dentro de `AdminReposicaoEmbalagem`)**

Substituir o corpo do componente `AdminReposicaoEmbalagem` (linhas 173–215) por:

```tsx
export default function AdminReposicaoEmbalagem() {
  const { grupos, limiar, isLoading, isError } = useEmbalagemConsulta(EMPRESA);
  const { isStaff } = useAuth();
  const queryClient = useQueryClient();

  const sincronizar = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('reposicao_sincronizar_embalagem_wp', { p_empresa: EMPRESA });
      if (error) throw error;
      return data as { cores_elegiveis: number; linhas_inseridas: number };
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['embalagem-consulta'] });
      toast.success('Cadastro sincronizado', {
        description: `${r.cores_elegiveis} cores conferidas · ${r.linhas_inseridas} novas embalagens cadastradas.`,
      });
    },
    onError: (e) =>
      toast.error('Erro ao sincronizar cadastro', {
        description: e instanceof Error ? e.message : 'Tente novamente.',
      }),
  });

  return (
    <div className="space-y-4 p-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display tracking-tight">Embalagem econômica</h1>
          <p className="text-muted-foreground text-sm">
            Compare embalagens (ex.: quart × galão) pelo menor custo por unidade-base. Para a compra manual dos concentrados,
            fora do ciclo automático de reposição.
          </p>
        </div>
        {isStaff && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => sincronizar.mutate()}
            disabled={sincronizar.isPending}
            title="Detecta no Omie os WP com quartinho e galão ativos e cadastra os pares que faltam"
          >
            <RefreshCw className={`w-4 h-4 mr-1.5 ${sincronizar.isPending ? 'animate-spin' : ''}`} />
            Sincronizar cadastro
          </Button>
        )}
      </div>

      <div className="rounded-md border bg-status-info/5 p-3 text-sm flex gap-2">
        <Info className="h-4 w-4 mt-0.5 text-status-info shrink-0" />
        <div>
          Os preços vêm do <strong>portal Sayerlack</strong> — você atualiza manualmente. A quantidade é sempre em{' '}
          <strong>unidade-base</strong> (a menor embalagem). A compra é feita no Omie; esta tela só recomenda{' '}
          <strong>qual embalagem</strong> sai mais barata.
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : isError ? (
        <div className="text-status-error text-sm">Erro ao carregar os grupos de embalagem. Tente recarregar a página.</div>
      ) : grupos.length === 0 ? (
        <EmptyState
          tone="operational"
          icon={Package}
          title="Nenhum grupo de embalagem cadastrado"
          description="Clique em Sincronizar cadastro para detectar os pares QT+GL ativos no Omie, ou confira se os produtos estão ativos lá."
        />
      ) : (
        <div className="space-y-3">
          {grupos.map((g) => (
            <GrupoCard key={g.grupo_id} grupo={g} limiar={limiar} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verificar tipos e lint**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"` — Expected: exit=0.
Run: `bun run lint > /tmp/lint.log 2>&1; echo "exit=$?"` — Expected: exit=0.

> ⚠️ Se o `supabase.rpc` reclamar que `reposicao_sincronizar_embalagem_wp` não existe nos tipos gerados (`src/integrations/supabase/types.ts` é gerado pós-deploy), use o mesmo cast que outras RPCs novas do repo usam: `supabase.rpc('reposicao_sincronizar_embalagem_wp' as never, { p_empresa: EMPRESA } as never)`. Confirme o padrão com `grep -rn "\.rpc('.*' as never" src/ | head`.

- [ ] **Step 4: Verificar no app rodando (o botão dispara e a lista atualiza)**

Use o skill `run` ou o Claude Preview: subir o dev server, abrir `/admin/reposicao/embalagem`, clicar em **Sincronizar cadastro**, confirmar o toast "Cadastro sincronizado" e a lista recarregando. (Em dev aponta para o banco de prod — só cadastra pares faltantes, idempotente e advisory.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/AdminReposicaoEmbalagem.tsx
git commit -m "feat(reposicao): botão Sincronizar cadastro na Embalagem econômica

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Doc + handoff de deploy Lovable

**Files:**
- Modify: `docs/agent/reposicao.md` (§Embalagem econômica)

**Interfaces:** nenhuma (documentação).

- [ ] **Step 1: Anexar nota na §Embalagem econômica de `docs/agent/reposicao.md`**

Adicionar como novo bullet no fim do item "Embalagem econômica":

```markdown
  - (3) **Auto-cadastro dos pares (2026-07-09):** `reposicao_sincronizar_embalagem_wp('oben')` deriva de `omie_products` os `WP.3900` com QT+GL **ativos** e preenche `sku_embalagem_equivalencia` (insert-only, idempotente, `criado_por='auto:embalagem-wp'`, fator QT=1/GL=4). Cron `reposicao-embalagem-cadastro-wp-daily` (09:00 UTC, após o catálogo 08:30) + botão "Sincronizar cadastro" na tela + backfill no apply. Gate **cron-or-staff** (`auth.uid()` NULL-aware — NÃO `auth.role()`). Advisory (nenhum WP no motor). Produto novo no Omie só entra no nosso banco no sync de catálogo diário (`omie-sync-metadados-daily`, 08:30 UTC) — forçar via `/sales/products` (aba Oben, ⟳). **Dívida:** inativar perna no Omie NÃO desativa o cadastro (insert-only; some manual). Fonte `db/embalagem-auto-cadastro-wp.sql`, prova `db/test-embalagem-auto-cadastro-wp.sh`. Spec `2026-07-09-embalagem-economica-auto-cadastro-wp-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/agent/reposicao.md
git commit -m "docs(reposicao): registra auto-cadastro de embalagem WP

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Abrir PR + handoff de deploy (o founder aplica as 3 camadas)**

Criar PR (não-draft → auto-merge quando `validate` verde). Corpo do PR com o **checklist de deploy Lovable**:

```markdown
## Deploy (Lovable — 3 camadas manuais)

1. **Migração (SQL Editor):** colar `db/embalagem-auto-cadastro-wp.sql` inteiro e Run.
   Inclui o **backfill** → os 11 pares faltantes entram na hora.
   Validar:
   ```sql
   SELECT count(DISTINCT grupo_id) FROM sku_embalagem_equivalencia WHERE empresa='oben' AND ativo; -- esperado 14
   SELECT * FROM reposicao_embalagem_sync_log ORDER BY executado_em DESC LIMIT 1;
   SELECT jobname, schedule FROM cron.job WHERE jobname='reposicao-embalagem-cadastro-wp-daily'; -- 0 9 * * *
   ```
2. **Frontend (Publish):** publicar no editor Lovable (botão "Sincronizar cadastro").
3. **Edge:** nenhuma.
```

Armar `scripts/pr-watch.sh <nº>` em background; avisar no desfecho.

---

## Self-Review

**Spec coverage:**
- Função de sincronização (spec §5.1) → Task 1 ✓
- Audit log (§5.2) → Task 1 ✓
- Cron diário (§5.3) → Task 2 ✓
- Botão (§5.4) → Task 3 ✓
- Backfill no deploy (§5.5) → Task 2 ✓
- Regras/invariantes (§6: escopo WP.3900, ambos ativos, insert-only, fator 4) → Task 1 (asserts A,B; falsificação Step 5) ✓
- Authz cron-or-staff (§7) → Task 1 (assert D; grants) ✓
- Prova PG17 com falsificação (§8) → Task 1 Steps 5–6 ✓
- Deploy 3 camadas (§10) → Task 4 Step 3 ✓
- Nota reposicao.md (§9) → Task 4 ✓

**Simplificação vs spec:** o spec previa `colisoes[]` no retorno; a implementação usa `WHERE NOT EXISTS` + o reuso-de-grupo-por-cor, que torna colisão real impossível (SKU é único por cor) e a `uniq_sku_emb_equiv_ativo` é a rede. Retorno enxuto `{cores_elegiveis, linhas_inseridas}` — cobre toast e audit. Decisão registrada aqui.

**Placeholder scan:** sem TBD/TODO; todo código presente; comandos com expected output.

**Type consistency:** `reposicao_sincronizar_embalagem_wp(p_empresa text)` e retorno `{cores_elegiveis, linhas_inseridas}` idênticos em Task 1 (SQL), Task 2 (cron/backfill) e Task 3 (mutation). Cron `reposicao-embalagem-cadastro-wp-daily` idêntico em Task 2 e Task 4.
