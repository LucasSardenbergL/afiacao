# Última Execução em Botões de Ação Global — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo botão de ação global (sincronizar/importar/recalcular) mostra "última execução: quando · quem · status", cobrindo cliques manuais E execuções automáticas de cron, começando por `/admin/analytics-sync`.

**Architecture:** Tabela genérica `acoes_execucoes` (RLS staff-only fail-closed) com dois escritores exclusivos por slug: frontend (`useMutationComRegistro`, para loops client-side) e edge (`_shared/registro-execucao.ts`, para actions single-shot com cron). Leitura via `useUltimaExecucao` + caption `<UltimaExecucao acao>`.

**Tech Stack:** React 18 + TS 5.8 strict, @tanstack/react-query, Supabase (PostgREST + edge Deno), date-fns 3 + ptBR, vitest, harness PG17 local (`db/test-*.sh`).

**Spec:** `docs/superpowers/specs/2026-07-18-ultima-execucao-acoes-design.md`

## Global Constraints

- Código, comentários, commits e PR em **pt-BR**.
- TS **strict**; `bun run typecheck` (nunca `tsc` cru); testes com `bun run test` (vitest); comandos pesados prefixados **`heavy`**.
- Tabela `acoes_execucoes` ainda NÃO existe em `src/integrations/supabase/types.ts` (regen é do Lovable) → acesso via cast estrutural `supabase as unknown as {...}` (idioma de `useCarteiraSaude.ts:18`). **Proibido `any` solto.**
- Slugs de ação: `<area>.<acao>` snake_case pt-BR (espelha convenção do `track()`). **Um escritor por slug** (frontend OU edge, nunca ambos).
- Registro é observabilidade: **fail-open** em TODOS os caminhos de gravação (falha de registro nunca bloqueia a ação real; `logger.warn` no frontend, `console.warn` na edge).
- Migration: arquivo NOVO em `supabase/migrations/` (nunca editar existentes); grants revogam `anon` **por nome**; policies usam o idioma de produção `has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)` (copiado de `sync_state` via psql-ro).
- Arquivo novo em `src/` precisa de dono no `src/lib/modulos/manifesto.ts` (senão `manifesto.gate` falha SÓ no CI).
- Commits frequentes; mensagens em pt-BR com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migration `acoes_execucoes` + prova PG17

**Files:**
- Create: `supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql`
- Create: `db/test-acoes-execucoes.sh` (modelado em `db/test-tactical-plans-rls-split.sh`)

**Interfaces:**
- Produces: tabela `public.acoes_execucoes` com colunas `id uuid`, `acao text`, `origem text ('manual'|'automatica')`, `executado_por uuid null`, `executado_por_nome text null`, `iniciado_em timestamptz`, `finalizado_em timestamptz null`, `status text ('executando'|'sucesso'|'erro')`, `detalhes jsonb null`. Tasks 3 e 5 gravam/leem exatamente essas colunas.

- [ ] **Step 1: Escrever a migration**

Criar `supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql`:

```sql
-- Registro genérico de execuções de ações globais (sincronizar/importar/recalcular).
-- Alimenta a caption <UltimaExecucao> em botões de ação (spec 2026-07-18-ultima-execucao-acoes-design.md).
-- Escritores: frontend staff (RLS, origem='manual') e edges via service_role (bypassa RLS;
-- origem conforme authorizeCronOrStaff). Regra: cada slug de acao tem UM escritor.
create table public.acoes_execucoes (
  id uuid primary key default gen_random_uuid(),
  acao text not null,
  origem text not null default 'manual' check (origem in ('manual', 'automatica')),
  executado_por uuid references auth.users (id) on delete set null,
  executado_por_nome text,
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  status text not null default 'executando' check (status in ('executando', 'sucesso', 'erro')),
  detalhes jsonb
);

create index acoes_execucoes_acao_idx on public.acoes_execucoes (acao, iniciado_em desc);

alter table public.acoes_execucoes enable row level security;

-- Staff lê tudo (mesmo idioma das tabelas operacionais, ex.: sync_state).
create policy "Staff le execucoes"
  on public.acoes_execucoes
  for select
  using (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role));

-- Staff registra a PRÓPRIA execução manual (edges gravam via service_role, que bypassa RLS).
create policy "Staff registra execucao propria"
  on public.acoes_execucoes
  for insert
  with check (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
    and origem = 'manual'
  );

-- Staff fecha a PRÓPRIA execução (status/finalizado_em/detalhes).
create policy "Staff fecha execucao propria"
  on public.acoes_execucoes
  for update
  using (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
  )
  with check (
    (has_role(auth.uid(), 'master'::app_role) or has_role(auth.uid(), 'employee'::app_role))
    and executado_por = auth.uid()
  );

-- DELETE: sem policy — ninguém apaga via PostgREST.

-- Grants: REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito do Supabase) —
-- revogar POR NOME (armadilha do CLAUDE.md; incidente #1375).
revoke all on public.acoes_execucoes from public, anon, authenticated;
grant select, insert, update on public.acoes_execucoes to authenticated;
grant all on public.acoes_execucoes to service_role;
```

- [ ] **Step 2: Escrever o harness PG17 que FALHA sem a migration**

Criar `db/test-acoes-execucoes.sh` (executável). Estrutura completa:

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — acoes_execucoes (última execução de ações globais)              ║
# ║  migration: 20260722100000_acoes_execucoes_ultima_execucao.sql                ║
# ║  Rode:  bash db/test-acoes-execucoes.sh > /tmp/t.log 2>&1; echo $?            ║
# ║                                                                                ║
# ║  Prova: staff insere/fecha SÓ a própria execução manual (alheia→42501,        ║
# ║  origem automatica→42501); customer/anon não leem nem escrevem; service_role  ║
# ║  bypassa (edges); delete sem policy → 0 linhas; status inválido → 23514.      ║
# ║  Falsifica: troca a policy de INSERT por with check(true) → alheia passa.     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5475}"
SLUG="acoes-execucoes"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha prod (psql-ro: rolbypassrls=t)
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos que a PROD já tem (enum, user_roles, has_role, users) ──
P -q <<SQL
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS \$f\$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
\$f\$;
INSERT INTO auth.users (id, email) VALUES
  ('$MASTER', 'master@t'), ('$STAFF_E', 'staff@t'), ('$CUST_C', 'cust@t');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER', 'master'), ('$STAFF_E', 'employee'), ('$CUST_C', 'customer');
SQL

# ── ZONA 2: a migration REAL ──
P -q -f "$REPO_ROOT/supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql"

echo "═══ asserts ═══"

# A1: service_role (edge) insere automática — bypassa RLS
eq "A1 service_role insere automatica" "$(Pq <<'SQL'
SET ROLE service_role;
INSERT INTO public.acoes_execucoes (acao, origem, status)
VALUES ('teste.cron', 'automatica', 'sucesso') RETURNING 'inseriu';
SQL
)" "inseriu"

# A2: staff insere a própria execução manual
eq "A2 staff insere propria manual" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
INSERT INTO public.acoes_execucoes (acao, executado_por, executado_por_nome)
VALUES ('teste.manual', '$MASTER', 'Lucas') RETURNING 'inseriu';
SQL
)" "inseriu"

# A3: staff NÃO insere execução em nome de OUTRO → 42501
eq "A3 staff insere alheia -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.manual', '$STAFF_E');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A4: staff NÃO insere origem automatica via PostgREST → 42501
eq "A4 staff origem automatica -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por, origem) VALUES ('teste.manual', '$MASTER', 'automatica');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A5: customer NÃO insere → 42501
eq "A5 customer insere -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$CUST_C', false);
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.manual', '$CUST_C');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A6: customer não LÊ nada (RLS filtra) → 0
eq "A6 customer select -> 0 linhas" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$CUST_C', false);
SELECT count(*) FROM public.acoes_execucoes;
SQL
)" "0"

# A7: anon sem grant → permission denied (42501)
eq "A7 anon select -> 42501" "$(Pq <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM public.acoes_execucoes;
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A8: staff FECHA a própria execução (executando -> sucesso)
eq "A8 staff fecha propria -> 1 linha" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
WITH u AS (
  UPDATE public.acoes_execucoes
  SET status = 'sucesso', finalizado_em = now(), detalhes = '{"n": 1}'::jsonb
  WHERE acao = 'teste.manual' AND executado_por = '$MASTER' AND status = 'executando'
  RETURNING 1
) SELECT count(*) FROM u;
SQL
)" "1"

# A9: staff NÃO fecha execução alheia (do service, executado_por null) → 0 linhas
eq "A9 staff fecha alheia -> 0 linhas" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
WITH u AS (
  UPDATE public.acoes_execucoes SET status = 'erro'
  WHERE acao = 'teste.cron'
  RETURNING 1
) SELECT count(*) FROM u;
SQL
)" "0"

# A10: staff NÃO deleta (sem policy) → 0 linhas
eq "A10 staff delete -> 0 linhas" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
WITH d AS (DELETE FROM public.acoes_execucoes RETURNING 1) SELECT count(*) FROM d;
SQL
)" "0"

# A11: status fora do domínio → 23514 (check)
eq "A11 status invalido -> 23514" "$(Pq <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, status) VALUES ('teste.check', 'rodando');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-23514';
SQL
)" "barrou-23514"

# A12: staff employee LÊ tudo (as 2 linhas inseridas)
eq "A12 staff le tudo" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$STAFF_E', false);
SELECT count(*) FROM public.acoes_execucoes;
SQL
)" "2"

echo "═══ FALSIFICAÇÃO (sabota a policy de INSERT → A3 tem que PASSAR a inserir) ═══"
P -q <<'SQL'
DROP POLICY "Staff registra execucao propria" ON public.acoes_execucoes;
CREATE POLICY "sabotada" ON public.acoes_execucoes FOR INSERT WITH CHECK (true);
SQL
eq "F1 sabotagem detectável (alheia agora INSERE)" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false);
INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.sabotagem', '$STAFF_E') RETURNING 'inseriu';
SQL
)" "inseriu"

echo ""
echo "═══ resultado: $PASS ✅ · $FAIL ❌ ═══"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 3: Rodar o harness e exigir verde**

```bash
chmod +x db/test-acoes-execucoes.sh
bash db/test-acoes-execucoes.sh > /tmp/acoes-exec.log 2>&1; echo "exit=$?"
tail -20 /tmp/acoes-exec.log
```
Esperado: `exit=0`, 13 ✅ (A1–A12 + F1), 0 ❌. (`| tail` engoliria o exit code — por isso o log + `echo $?`.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql db/test-acoes-execucoes.sh
git commit -m "feat(banco): tabela acoes_execucoes p/ 'última execução' de ações globais (provada PG17)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Tipos + `rotuloUltimaExecucao` (lógica pura do caption, TDD)

**Files:**
- Create: `src/components/execucoes/tipos.ts`
- Create: `src/components/execucoes/rotulo.ts`
- Test: `src/components/execucoes/__tests__/rotulo.test.ts`

**Interfaces:**
- Produces:
  - `interface AcaoExecucao { id: string; acao: string; origem: "manual" | "automatica"; executado_por: string | null; executado_por_nome: string | null; iniciado_em: string; finalizado_em: string | null; status: "executando" | "sucesso" | "erro"; detalhes: Record<string, unknown> | null }`
  - `function rotuloUltimaExecucao(execucao: AcaoExecucao | null, agora: Date): { texto: string; tom: "muted" | "andamento" | "erro" }`
- Consumes: nada (puro).

- [ ] **Step 1: Escrever os testes que falham**

`src/components/execucoes/__tests__/rotulo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rotuloUltimaExecucao } from "../rotulo";
import type { AcaoExecucao } from "../tipos";

const AGORA = new Date("2026-07-18T15:00:00-03:00");

function execucao(parcial: Partial<AcaoExecucao>): AcaoExecucao {
  return {
    id: "1",
    acao: "analytics_sync.recalcular_custos",
    origem: "manual",
    executado_por: "u1",
    executado_por_nome: "Lucas",
    iniciado_em: "2026-07-18T13:00:00-03:00",
    finalizado_em: "2026-07-18T13:05:00-03:00",
    status: "sucesso",
    detalhes: null,
    ...parcial,
  };
}

describe("rotuloUltimaExecucao", () => {
  it("sem execução → Nunca executada", () => {
    expect(rotuloUltimaExecucao(null, AGORA)).toEqual({ texto: "Nunca executada", tom: "muted" });
  });

  it("executando recente → em andamento com tempo relativo", () => {
    const r = rotuloUltimaExecucao(
      execucao({ status: "executando", iniciado_em: "2026-07-18T14:55:00-03:00", finalizado_em: null }),
      AGORA,
    );
    expect(r.tom).toBe("andamento");
    expect(r.texto).toMatch(/^Em andamento \(há 5 minutos\)$/);
  });

  it("executando há mais de 2h → interrompida?", () => {
    const r = rotuloUltimaExecucao(
      execucao({ status: "executando", iniciado_em: "2026-07-18T07:00:00-03:00", finalizado_em: null }),
      AGORA,
    );
    expect(r.tom).toBe("muted");
    expect(r.texto).toBe("Iniciada há cerca de 8 horas (interrompida?)");
  });

  it("sucesso manual → tempo relativo do FIM + nome + ✓", () => {
    const r = rotuloUltimaExecucao(execucao({}), AGORA);
    expect(r.tom).toBe("muted");
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · Lucas · ✓");
  });

  it("sucesso automática → rotula automática", () => {
    const r = rotuloUltimaExecucao(
      execucao({ origem: "automatica", executado_por: null, executado_por_nome: null }),
      AGORA,
    );
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · automática · ✓");
  });

  it("erro → falhou em tom de erro", () => {
    const r = rotuloUltimaExecucao(execucao({ status: "erro" }), AGORA);
    expect(r.tom).toBe("erro");
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · Lucas · falhou");
  });

  it("manual sem nome (lookup falhou) → omite o segmento do executor", () => {
    const r = rotuloUltimaExecucao(execucao({ executado_por_nome: null }), AGORA);
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · ✓");
  });

  it("sucesso sem finalizado_em (legado) → cai no iniciado_em", () => {
    const r = rotuloUltimaExecucao(execucao({ finalizado_em: null, iniciado_em: "2026-07-18T13:05:00-03:00" }), AGORA);
    expect(r.texto).toContain("há");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/components/execucoes/__tests__/rotulo.test.ts > /tmp/rotulo.log 2>&1; echo "exit=$?"; tail -15 /tmp/rotulo.log
```
Esperado: FAIL (`Cannot find module '../rotulo'` ou equivalente).

- [ ] **Step 3: Implementar tipos + rotulo**

`src/components/execucoes/tipos.ts`:

```ts
// Tipos do registro de execuções de ações globais (tabela acoes_execucoes).
// A tabela ainda não está no types.ts gerado (regen é do Lovable) — o shape canônico é este.
export interface AcaoExecucao {
  id: string;
  acao: string;
  origem: "manual" | "automatica";
  executado_por: string | null;
  executado_por_nome: string | null;
  iniciado_em: string;
  finalizado_em: string | null;
  status: "executando" | "sucesso" | "erro";
  detalhes: Record<string, unknown> | null;
}

export const ULTIMA_EXECUCAO_QUERY_KEY = "ultima-execucao";
```

`src/components/execucoes/rotulo.ts`:

```ts
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { AcaoExecucao } from "./tipos";

/** Execução 'executando' além disso é tratada como abandonada (aba fechada no meio). */
const LIMITE_ANDAMENTO_MS = 2 * 60 * 60 * 1000;

export interface RotuloExecucao {
  texto: string;
  tom: "muted" | "andamento" | "erro";
}

/** Rótulo humano da última execução de uma ação global (puro — testável sem render). */
export function rotuloUltimaExecucao(execucao: AcaoExecucao | null, agora: Date): RotuloExecucao {
  if (!execucao) return { texto: "Nunca executada", tom: "muted" };

  const relativo = (iso: string) =>
    formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });

  if (execucao.status === "executando") {
    const decorrido = agora.getTime() - new Date(execucao.iniciado_em).getTime();
    if (decorrido < LIMITE_ANDAMENTO_MS) {
      return { texto: `Em andamento (${relativo(execucao.iniciado_em)})`, tom: "andamento" };
    }
    return { texto: `Iniciada ${relativo(execucao.iniciado_em)} (interrompida?)`, tom: "muted" };
  }

  const quando = relativo(execucao.finalizado_em ?? execucao.iniciado_em);
  const quem = execucao.origem === "automatica" ? "automática" : execucao.executado_por_nome;
  const marca = execucao.status === "sucesso" ? "✓" : "falhou";
  const partes = [quando, ...(quem ? [quem] : []), marca];
  return {
    texto: `Última execução: ${partes.join(" · ")}`,
    tom: execucao.status === "erro" ? "erro" : "muted",
  };
}
```

Nota: `formatDistanceToNow` ignora o `agora` — os testes usam datas fixas relativas ao relógio real? NÃO: os testes acima passam `AGORA` fixo mas a lib usa `Date.now()`. Para determinismo, `rotuloUltimaExecucao` deve usar `formatDistance(new Date(iso), agora, ...)` em vez de `formatDistanceToNow`:

```ts
import { formatDistance } from "date-fns";
// dentro da função:
const relativo = (iso: string) =>
  formatDistance(new Date(iso), agora, { addSuffix: true, locale: ptBR });
```

Usar SEMPRE `formatDistance(data, agora)` — é o que torna a função pura e os testes determinísticos.

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/components/execucoes/__tests__/rotulo.test.ts > /tmp/rotulo.log 2>&1; echo "exit=$?"; tail -15 /tmp/rotulo.log
```
Esperado: PASS (8 testes). Se algum texto relativo divergir (ex.: "cerca de"), ajustar a EXPECTATIVA do teste ao output real do date-fns ptBR — nunca hackear a implementação.

- [ ] **Step 5: Commit**

```bash
git add src/components/execucoes/tipos.ts src/components/execucoes/rotulo.ts src/components/execucoes/__tests__/rotulo.test.ts
git commit -m "feat(execucoes): tipos + rótulo puro da última execução (TDD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `useUltimaExecucao` + `useMutationComRegistro` (TDD)

**Files:**
- Create: `src/components/execucoes/useUltimaExecucao.ts`
- Create: `src/components/execucoes/useMutationComRegistro.ts`
- Test: `src/components/execucoes/__tests__/useMutationComRegistro.test.tsx`

**Interfaces:**
- Consumes: `AcaoExecucao`, `ULTIMA_EXECUCAO_QUERY_KEY` (Task 2); `supabase` de `@/integrations/supabase/client`; `useAuth` de `@/contexts/AuthContext`; `logger` de `@/lib/logger`.
- Produces:
  - `function useUltimaExecucao(acao: string | string[]): UseQueryResult<AcaoExecucao | null>`
  - `function useMutationComRegistro<TData, TVariables = void>(opcoes: Omit<UseMutationOptions<TData, Error, TVariables>, "mutationFn"> & { acao: string; mutationFn: (variables: TVariables) => Promise<TData>; detalhes?: (data: TData) => Record<string, unknown> }): UseMutationResult<TData, Error, TVariables>`

- [ ] **Step 1: Escrever o teste que falha (fail-open é o coração)**

`src/components/execucoes/__tests__/useMutationComRegistro.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const inserts: Array<Record<string, unknown>> = [];
const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
let falharInsert = false;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => {
      if (tabela === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { name: "Lucas" }, error: null }),
            }),
          }),
        };
      }
      // acoes_execucoes
      return {
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            single: () => {
              if (falharInsert) return Promise.resolve({ data: null, error: { message: "RLS" } });
              inserts.push(linha);
              return Promise.resolve({ data: { id: "reg-1" }, error: null });
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updates.push({ id, patch });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u-master" } }),
}));

import { useMutationComRegistro } from "../useMutationComRegistro";

function criarWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  falharInsert = false;
});

describe("useMutationComRegistro", () => {
  it("sucesso: abre registro, roda a mutation, fecha com sucesso + detalhes", async () => {
    const { result } = renderHook(
      () =>
        useMutationComRegistro({
          acao: "teste.acao",
          mutationFn: async () => ({ importados: 7 }),
          detalhes: (d) => ({ importados: d.importados }),
        }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ acao: "teste.acao", executado_por: "u-master", origem: "manual" });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("reg-1");
    expect(updates[0].patch).toMatchObject({ status: "sucesso", detalhes: { importados: 7 } });
  });

  it("FAIL-OPEN: insert do registro falha e a ação real roda mesmo assim", async () => {
    falharInsert = true;
    const mutationFn = vi.fn(async () => "ok");
    const { result } = renderHook(
      () => useMutationComRegistro({ acao: "teste.acao", mutationFn }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe("ok");
    expect(updates).toHaveLength(0); // sem registro aberto, nada a fechar
  });

  it("erro na mutation: fecha registro com erro e re-lança (onError do caller ainda dispara)", async () => {
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useMutationComRegistro({
          acao: "teste.acao",
          mutationFn: async () => {
            throw new Error("quebrou");
          },
          onError,
        }),
      { wrapper: criarWrapper() },
    );

    result.current.mutate();
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toMatchObject({ status: "erro" });
    expect(String((updates[0].patch as { detalhes: { erro: string } }).detalhes.erro)).toContain("quebrou");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/components/execucoes/__tests__/useMutationComRegistro.test.tsx > /tmp/umcr.log 2>&1; echo "exit=$?"; tail -15 /tmp/umcr.log
```
Esperado: FAIL (módulo `../useMutationComRegistro` inexistente).

- [ ] **Step 3: Implementar os dois hooks**

`src/components/execucoes/useUltimaExecucao.ts`:

```ts
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ULTIMA_EXECUCAO_QUERY_KEY, type AcaoExecucao } from "./tipos";

// acoes_execucoes ainda não está no types.ts gerado (regen é do Lovable) →
// cast estrutural mínimo, mesmo idioma do useCarteiraSaude.
interface SelectExecucoes {
  from(tabela: "acoes_execucoes"): {
    select(colunas: "*"): {
      in(coluna: "acao", valores: string[]): {
        order(coluna: "iniciado_em", opcoes: { ascending: boolean }): {
          limit(n: number): PromiseLike<{ data: AcaoExecucao[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
}

/** Última execução registrada entre um ou mais slugs de ação (linha mais recente). */
export function useUltimaExecucao(acao: string | string[]): UseQueryResult<AcaoExecucao | null> {
  const acoes = (Array.isArray(acao) ? acao : [acao]).slice().sort();
  return useQuery({
    queryKey: [ULTIMA_EXECUCAO_QUERY_KEY, ...acoes],
    queryFn: async () => {
      const cliente = supabase as unknown as SelectExecucoes;
      const { data, error } = await cliente
        .from("acoes_execucoes")
        .select("*")
        .in("acao", acoes)
        .order("iniciado_em", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}
```

`src/components/execucoes/useMutationComRegistro.ts`:

```ts
import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { logger } from "@/lib/logger";
import { ULTIMA_EXECUCAO_QUERY_KEY } from "./tipos";

interface EscritaExecucoes {
  from(tabela: "acoes_execucoes"): {
    insert(linha: Record<string, unknown>): {
      select(colunas: "id"): {
        single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(coluna: "id", valor: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Abre o registro da execução. FAIL-OPEN: qualquer falha → null (a ação real segue). */
async function iniciarRegistro(acao: string, userId: string | null): Promise<string | null> {
  try {
    let nome: string | null = null;
    if (userId) {
      const { data } = await supabase.from("profiles").select("name").eq("user_id", userId).maybeSingle();
      nome = (data as { name?: string } | null)?.name ?? null;
    }
    const cliente = supabase as unknown as EscritaExecucoes;
    const { data, error } = await cliente
      .from("acoes_execucoes")
      .insert({ acao, executado_por: userId, executado_por_nome: nome })
      .select("id")
      .single();
    if (error || !data) {
      logger.warn("registro de execução não abriu (fail-open)", { acao, erro: error?.message });
      return null;
    }
    return data.id;
  } catch (e) {
    logger.warn("registro de execução não abriu (fail-open)", { acao, erro: String(e) });
    return null;
  }
}

/** Fecha o registro. FAIL-OPEN: falha vira warn, nunca erro pro caller. */
async function fecharRegistro(
  registroId: string | null,
  status: "sucesso" | "erro",
  detalhes: Record<string, unknown> | null,
): Promise<void> {
  if (!registroId) return;
  try {
    const cliente = supabase as unknown as EscritaExecucoes;
    const { error } = await cliente
      .from("acoes_execucoes")
      .update({ status, finalizado_em: new Date().toISOString(), detalhes })
      .eq("id", registroId);
    if (error) logger.warn("registro de execução não fechou (fail-open)", { registroId, erro: error.message });
  } catch (e) {
    logger.warn("registro de execução não fechou (fail-open)", { registroId, erro: String(e) });
  }
}

type OpcoesMutationComRegistro<TData, TVariables> = Omit<
  UseMutationOptions<TData, Error, TVariables>,
  "mutationFn"
> & {
  /** Slug estável '<area>.<acao>' — o MESMO usado na caption <UltimaExecucao>. */
  acao: string;
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** Resumo pequeno gravado em acoes_execucoes.detalhes no sucesso (contagens etc.). */
  detalhes?: (data: TData) => Record<string, unknown>;
};

/**
 * Drop-in do useMutation para BOTÃO DE AÇÃO GLOBAL (sincronizar/importar/recalcular/gerar):
 * registra a execução em acoes_execucoes (abre 'executando', fecha 'sucesso'/'erro') e
 * invalida a caption <UltimaExecucao>. Convenção do CLAUDE.md §Design System.
 * Ação de UM registro (reenviar item X) NÃO usa isto — o estado vive no próprio registro.
 * Edge single-shot (com cron) registra server-side via _shared/registro-execucao.ts — nunca os dois.
 */
export function useMutationComRegistro<TData, TVariables = void>({
  acao,
  mutationFn,
  detalhes,
  ...opcoes
}: OpcoesMutationComRegistro<TData, TVariables>): UseMutationResult<TData, Error, TVariables> {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<TData, Error, TVariables>({
    ...opcoes,
    mutationFn: async (variables: TVariables) => {
      const registroId = await iniciarRegistro(acao, user?.id ?? null);
      try {
        const resultado = await mutationFn(variables);
        await fecharRegistro(registroId, "sucesso", detalhes?.(resultado) ?? null);
        return resultado;
      } catch (e) {
        await fecharRegistro(registroId, "erro", { erro: String(e).slice(0, 300) });
        throw e;
      } finally {
        queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] });
      }
    },
  });
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
heavy bun run test src/components/execucoes/__tests__/useMutationComRegistro.test.tsx > /tmp/umcr.log 2>&1; echo "exit=$?"; tail -15 /tmp/umcr.log
```
Esperado: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/components/execucoes/useUltimaExecucao.ts src/components/execucoes/useMutationComRegistro.ts src/components/execucoes/__tests__/useMutationComRegistro.test.tsx
git commit -m "feat(execucoes): useUltimaExecucao + useMutationComRegistro fail-open (TDD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Componente `<UltimaExecucao>` + manifesto

**Files:**
- Create: `src/components/execucoes/UltimaExecucao.tsx`
- Test: `src/components/execucoes/__tests__/UltimaExecucao.test.tsx`
- Modify: `src/lib/modulos/manifesto.ts` (módulo `plataforma`, array `codigo` — inserir `"src/components/execucoes/**"` em ordem alfabética entre os globs de `src/components/*`)

**Interfaces:**
- Consumes: `useUltimaExecucao` (Task 3), `rotuloUltimaExecucao` (Task 2), `Tooltip`/`TooltipTrigger`/`TooltipContent` de `@/components/ui/tooltip` (TooltipProvider já é global no App.tsx), `cn` de `@/lib/utils`.
- Produces: `function UltimaExecucao(props: { acao: string | string[]; className?: string }): JSX.Element | null`

- [ ] **Step 1: Teste (mocka o hook de dados; valida os 3 tons e o tooltip)**

`src/components/execucoes/__tests__/UltimaExecucao.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AcaoExecucao } from "../tipos";

const mockUseUltimaExecucao = vi.fn();
vi.mock("../useUltimaExecucao", () => ({
  useUltimaExecucao: (acao: string | string[]) => mockUseUltimaExecucao(acao),
}));

import { UltimaExecucao } from "../UltimaExecucao";

const BASE: AcaoExecucao = {
  id: "1",
  acao: "analytics_sync.recalcular_custos",
  origem: "manual",
  executado_por: "u1",
  executado_por_nome: "Lucas",
  iniciado_em: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  finalizado_em: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  status: "sucesso",
  detalhes: null,
};

describe("UltimaExecucao", () => {
  it("nunca executada", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: null, isLoading: false });
    render(<TooltipProvider><UltimaExecucao acao="x.y" /></TooltipProvider>);
    expect(screen.getByText("Nunca executada")).toBeTruthy();
  });

  it("sucesso mostra quem e ✓", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: BASE, isLoading: false });
    render(<TooltipProvider><UltimaExecucao acao="x.y" /></TooltipProvider>);
    expect(screen.getByText(/Lucas · ✓/)).toBeTruthy();
  });

  it("erro usa tom de erro (text-status-error)", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: { ...BASE, status: "erro" }, isLoading: false });
    const { container } = render(<TooltipProvider><UltimaExecucao acao="x.y" /></TooltipProvider>);
    expect(container.querySelector(".text-status-error")).toBeTruthy();
  });

  it("carregando → não renderiza nada", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<TooltipProvider><UltimaExecucao acao="x.y" /></TooltipProvider>);
    expect(container.textContent).toBe("");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
heavy bun run test src/components/execucoes/__tests__/UltimaExecucao.test.tsx > /tmp/ue.log 2>&1; echo "exit=$?"; tail -15 /tmp/ue.log
```
Esperado: FAIL (componente inexistente).

- [ ] **Step 3: Implementar o componente**

`src/components/execucoes/UltimaExecucao.tsx`:

```tsx
import { History } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useUltimaExecucao } from "./useUltimaExecucao";
import { rotuloUltimaExecucao } from "./rotulo";

const COR_POR_TOM = {
  muted: "text-muted-foreground",
  andamento: "text-primary",
  erro: "text-status-error",
} as const;

/**
 * Caption "última execução" de um botão de ação global. Par do useMutationComRegistro
 * (ou do registro server-side via _shared/registro-execucao.ts) — mesma acao/slug.
 * Aceita array quando o card tem 2+ botões da mesma família (mostra a mais recente).
 */
export function UltimaExecucao({ acao, className }: { acao: string | string[]; className?: string }) {
  const { data: execucao, isLoading } = useUltimaExecucao(acao);
  if (isLoading) return null;

  const { texto, tom } = rotuloUltimaExecucao(execucao ?? null, new Date());
  const conteudo = (
    <span className={cn("inline-flex items-center gap-1 text-xs", COR_POR_TOM[tom], className)}>
      <History className="h-3 w-3 shrink-0" aria-hidden />
      {texto}
    </span>
  );

  if (!execucao) return conteudo;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{conteudo}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {format(new Date(execucao.finalizado_em ?? execucao.iniciado_em), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
        {" — "}
        <code className="font-mono">{execucao.acao}</code>
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 4: Registrar no manifesto (dono: plataforma)**

Em `src/lib/modulos/manifesto.ts`, no módulo `id: "plataforma"`, array `codigo`, adicionar em ordem junto aos outros `src/components/*`:

```ts
      "src/components/execucoes/**",
```

- [ ] **Step 5: Rodar testes (componente + gate do manifesto) e ver passar**

```bash
heavy bun run test src/components/execucoes/__tests__/UltimaExecucao.test.tsx src/lib/modulos > /tmp/ue.log 2>&1; echo "exit=$?"; tail -15 /tmp/ue.log
```
Esperado: PASS (4 testes do componente + gate do manifesto verde).

- [ ] **Step 6: Commit**

```bash
git add src/components/execucoes/UltimaExecucao.tsx src/components/execucoes/__tests__/UltimaExecucao.test.tsx src/lib/modulos/manifesto.ts
git commit -m "feat(execucoes): caption <UltimaExecucao> + dono no manifesto (plataforma)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Edge — `_shared/registro-execucao.ts` + wiring no dispatcher

**Files:**
- Create: `supabase/functions/_shared/registro-execucao.ts`
- Create: `supabase/functions/_shared/registro-execucao_test.ts`
- Modify: `supabase/functions/omie-analytics-sync/index.ts` (imports + cases `compute_costs`/`compute_association_rules`/`sync_all`, linhas ~1801–1820)

**Interfaces:**
- Consumes: `AuthResult` de `../_shared/auth.ts` (`{ ok: true; via: "cron" | "service_role" | "staff"; userId?: string }`); tabela `acoes_execucoes` (Task 1).
- Produces: `function comRegistro<T>(db: DbRegistro, acao: string, auth: { via: "cron" | "service_role" | "staff"; userId?: string }, fn: () => Promise<T>, detalhes?: (r: T) => Record<string, unknown>): Promise<T>`

- [ ] **Step 1: Escrever o teste Deno (código real, fake db)**

`supabase/functions/_shared/registro-execucao_test.ts`:

```ts
// Testa o CÓDIGO REAL de comRegistro (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/registro-execucao_test.ts
import { comRegistro, type DbRegistro } from "./registro-execucao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function fakeDb(opts: { falharInsert?: boolean } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const db: DbRegistro = {
    from: (tabela: string) => ({
      insert: (linha: Record<string, unknown>) => ({
        select: () => ({
          single: () => {
            if (opts.falharInsert) return Promise.resolve({ data: null, error: { message: "boom" } });
            inserts.push({ tabela, ...linha });
            return Promise.resolve({ data: { id: "reg-9" }, error: null });
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, id: string) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { name: "Lucas" }, error: null }),
        }),
      }),
    }),
  };
  return { db, inserts, updates };
}

Deno.test("staff → origem manual com executado_por e nome", async () => {
  const { db, inserts, updates } = fakeDb();
  const r = await comRegistro(db, "a.b", { via: "staff", userId: "u1" }, () => Promise.resolve(42));
  assertEquals(r, 42);
  assertEquals(inserts[0].origem, "manual");
  assertEquals(inserts[0].executado_por, "u1");
  assertEquals(inserts[0].executado_por_nome, "Lucas");
  assertEquals(updates[0].id, "reg-9");
  assertEquals(updates[0].patch.status, "sucesso");
});

Deno.test("cron → origem automatica sem executor", async () => {
  const { db, inserts } = fakeDb();
  await comRegistro(db, "a.b", { via: "cron" }, () => Promise.resolve(1));
  assertEquals(inserts[0].origem, "automatica");
  assertEquals(inserts[0].executado_por, null);
});

Deno.test("FAIL-OPEN: insert falha e fn roda mesmo assim", async () => {
  const { db, updates } = fakeDb({ falharInsert: true });
  const r = await comRegistro(db, "a.b", { via: "cron" }, () => Promise.resolve("ok"));
  assertEquals(r, "ok");
  assertEquals(updates.length, 0);
});

Deno.test("erro na fn → fecha com status erro e re-lança", async () => {
  const { db, updates } = fakeDb();
  let lancou = false;
  try {
    await comRegistro(db, "a.b", { via: "staff", userId: "u1" }, () => Promise.reject(new Error("quebrou")));
  } catch {
    lancou = true;
  }
  assertEquals(lancou, true);
  assertEquals(updates[0].patch.status, "erro");
});
```

- [ ] **Step 2: Implementar o helper**

`supabase/functions/_shared/registro-execucao.ts`:

```ts
// Registro server-side de execuções de ações globais (tabela acoes_execucoes) — o par
// edge do useMutationComRegistro do frontend. Usar em action SINGLE-SHOT que roda por
// clique (staff) E por cron: um único ponto grava as duas origens.
// FAIL-OPEN: registro é observabilidade — NUNCA derruba a ação real.
// Regra (CLAUDE.md §Design System): cada slug de acao tem UM escritor (edge OU frontend).

export interface DbRegistro {
  // Estrutural mínimo do supabase-js client (service_role) — só o que o registro usa.
  from(tabela: string): {
    insert(linha: Record<string, unknown>): {
      select(colunas: "id"): {
        single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(coluna: "id", valor: string): Promise<{ error: { message: string } | null }>;
    };
    select(colunas: "name"): {
      eq(coluna: "user_id", valor: string): {
        maybeSingle(): Promise<{ data: { name?: string } | null; error: { message: string } | null }>;
      };
    };
  };
}

type AuthOrigem = { via: "cron" | "service_role" | "staff"; userId?: string };

async function iniciar(db: DbRegistro, acao: string, auth: AuthOrigem): Promise<string | null> {
  try {
    const manual = auth.via === "staff";
    let nome: string | null = null;
    if (manual && auth.userId) {
      const { data } = await db.from("profiles").select("name").eq("user_id", auth.userId).maybeSingle();
      nome = data?.name ?? null;
    }
    const { data, error } = await db
      .from("acoes_execucoes")
      .insert({
        acao,
        origem: manual ? "manual" : "automatica",
        executado_por: manual ? (auth.userId ?? null) : null,
        executado_por_nome: nome,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.warn(`[registro-execucao] não abriu (fail-open): ${acao}`, error?.message);
      return null;
    }
    return data.id;
  } catch (e) {
    console.warn(`[registro-execucao] não abriu (fail-open): ${acao}`, e instanceof Error ? e.message : e);
    return null;
  }
}

async function fechar(
  db: DbRegistro,
  registroId: string | null,
  status: "sucesso" | "erro",
  detalhes: Record<string, unknown> | null,
): Promise<void> {
  if (!registroId) return;
  try {
    const { error } = await db
      .from("acoes_execucoes")
      .update({ status, finalizado_em: new Date().toISOString(), detalhes })
      .eq("id", registroId);
    if (error) console.warn(`[registro-execucao] não fechou (fail-open): ${registroId}`, error.message);
  } catch (e) {
    console.warn(`[registro-execucao] não fechou (fail-open): ${registroId}`, e instanceof Error ? e.message : e);
  }
}

/** Envolve uma ação single-shot com o registro início→fim (sucesso/erro re-lança). */
export async function comRegistro<T>(
  db: DbRegistro,
  acao: string,
  auth: AuthOrigem,
  fn: () => Promise<T>,
  detalhes?: (r: T) => Record<string, unknown>,
): Promise<T> {
  const registroId = await iniciar(db, acao, auth);
  try {
    const resultado = await fn();
    await fechar(db, registroId, "sucesso", detalhes ? detalhes(resultado) : null);
    return resultado;
  } catch (e) {
    await fechar(db, registroId, "erro", { erro: String(e).slice(0, 300) });
    throw e;
  }
}
```

- [ ] **Step 3: Rodar o teste Deno**

```bash
command -v deno >/dev/null && deno test supabase/functions/_shared/registro-execucao_test.ts || echo "deno ausente localmente — validar por revisão (CI não roda deno; padrão dos *_test.ts do _shared)"
```
Esperado com deno: `4 passed`. Sem deno: mensagem de skip (registrar no PR).

- [ ] **Step 4: Wiring no dispatcher de `omie-analytics-sync`**

Em `supabase/functions/omie-analytics-sync/index.ts`:

(a) Adicionar import junto aos existentes do `_shared` (topo do arquivo):

```ts
import { comRegistro } from "../_shared/registro-execucao.ts";
```

(b) Substituir os cases (região das linhas ~1801–1820):

```ts
      case "compute_costs":
        result = await comRegistro(
          supabaseAdmin, "analytics_sync.recalcular_custos", auth,
          () => computeCosts(supabaseAdmin),
          (r) => ({ updated: (r as { updated?: number }).updated ?? null }),
        );
        break;
      case "compute_association_rules":
        result = await comRegistro(
          supabaseAdmin, "analytics_sync.recalcular_regras", auth,
          () => computeAssociationRules(supabaseAdmin),
          (r) => {
            const a = r as { rules_generated?: number; total_transactions?: number };
            return { rules_generated: a.rules_generated ?? null, total_transactions: a.total_transactions ?? null };
          },
        );
        break;
      case "sync_all": {
        // customers SAIU do sync_all: agora tem cron dedicado (sync-customers-vendas-daily) que chama
        // a action sync_customers em BACKGROUND. Rodar customers síncrono aqui dava WORKER_RESOURCE_LIMIT
        // e RE-prendia sync_state.customers em 'running' a cada passada — clobberava o estado curado.
        const acct = account as OmieAccount;
        // orders REMOVIDO do sync_all (2026-06-24): syncOrdersIncremental foi aposentado (no-op que
        // poluía sales_price_history). A fonte de pedidos é a RPC criar_pedidos_com_itens (omie-vendas-sync).
        result = await comRegistro(supabaseAdmin, "analytics_sync.sync_completo", auth, async () => {
          const products = await syncProducts(supabaseAdmin, acct);
          const inventory = await syncInventory(supabaseAdmin, acct);
          // Motores registrados com os PRÓPRIOS slugs: o sync_all recalcula custos/regras DE VERDADE,
          // e a caption dos cards precisa refletir isso (a verdade é por slug).
          const costs = await comRegistro(
            supabaseAdmin, "analytics_sync.recalcular_custos", auth,
            () => computeCosts(supabaseAdmin),
            (r) => ({ updated: (r as { updated?: number }).updated ?? null }),
          );
          const assocRules = await comRegistro(
            supabaseAdmin, "analytics_sync.recalcular_regras", auth,
            () => computeAssociationRules(supabaseAdmin),
          );
          return { products, inventory, costs, assocRules };
        });
        break;
      }
```

Atenção: preservar os comentários existentes do case `sync_all` (história do WORKER_RESOURCE_LIMIT e do orders aposentado) — eles explicam POR QUE customers/orders não estão ali.

- [ ] **Step 5: Verificação estática da edge**

```bash
grep -n "comRegistro" supabase/functions/omie-analytics-sync/index.ts | head
bun lint > /tmp/lint.log 2>&1; echo "exit=$?"; tail -5 /tmp/lint.log
```
Esperado: 5 ocorrências de `comRegistro` (1 import + 4 usos); lint verde (edges entram no lint, não no typecheck do app).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/registro-execucao.ts supabase/functions/_shared/registro-execucao_test.ts supabase/functions/omie-analytics-sync/index.ts
git commit -m "feat(edge): registro server-side de execuções nos motores do analytics-sync (manual+cron)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Adoção na página `/admin/analytics-sync`

**Files:**
- Create: `src/components/analyticsSync/acoes.ts` (slugs)
- Modify: `src/components/analyticsSync/useAnalyticsSync.ts` (4 mutations de loop → `useMutationComRegistro`)
- Modify: `src/components/analyticsSync/ImportCards.tsx` (+caption nos 3 cards)
- Modify: `src/components/analyticsSync/EngineCards.tsx` (+caption nos 2 cards)
- Modify: `src/pages/AdminAnalyticsSync.tsx` (+caption do Sync Completo no header)
- Modify: `src/components/analyticsSync/__tests__/ImportCards.test.tsx` e `EngineCards.test.tsx` (mock da caption)

**Interfaces:**
- Consumes: `useMutationComRegistro`, `<UltimaExecucao>`, slugs.
- Produces: `export const ACOES_ANALYTICS_SYNC = { importarClientes, sincronizarEnderecos, importarPedidosRecentes, importarPedidosTodos, recalcularCustos, recalcularRegras, syncCompleto }` (strings).

- [ ] **Step 1: Slugs canônicos**

`src/components/analyticsSync/acoes.ts`:

```ts
// Slugs de acoes_execucoes desta página. Os de motor/sync_completo são GRAVADOS pela edge
// omie-analytics-sync (manual+cron) — o frontend só LÊ; os de importação (loops client-side)
// são gravados pelo useMutationComRegistro. Um escritor por slug (CLAUDE.md §Design System).
export const ACOES_ANALYTICS_SYNC = {
  importarClientes: "analytics_sync.importar_clientes",
  sincronizarEnderecos: "analytics_sync.sincronizar_enderecos",
  importarPedidosRecentes: "analytics_sync.importar_pedidos_recentes",
  importarPedidosTodos: "analytics_sync.importar_pedidos_todos",
  recalcularCustos: "analytics_sync.recalcular_custos",
  recalcularRegras: "analytics_sync.recalcular_regras",
  syncCompleto: "analytics_sync.sync_completo",
} as const;
```

- [ ] **Step 2: Migrar as 4 mutations de loop no `useAnalyticsSync.ts`**

Adicionar imports:

```ts
import { useMutationComRegistro } from "@/components/execucoes/useMutationComRegistro";
import { ACOES_ANALYTICS_SYNC } from "./acoes";
```

Trocar `useMutation` → `useMutationComRegistro` SOMENTE nestas 4 (as `syncMutation`/`computeCostsMutation`/`assocRulesMutation`/`updateConfigMutation` ficam como estão — as três primeiras são registradas pela edge; config não é ação global):

`bulkClientSyncMutation` (linha ~134):

```ts
  const bulkClientSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarClientes,
    detalhes: (d) => ({ importados: d.totalImported, ja_existiam: d.totalSkipped, erros: d.totalErrors }),
    mutationFn: async () => {
      // ... corpo EXATAMENTE como está hoje (loop de contas/páginas) ...
    },
    onSuccess: (data) => { /* toast atual inalterado */ },
    onError: (error) => { /* atual inalterado */ },
  });
```

`addressSyncMutation` (linha ~177):

```ts
  const addressSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.sincronizarEnderecos,
    detalhes: (d) => ({ criados: d.synced, ignorados: d.skipped, erros: d.errors, pendentes: d.totalNeeding }),
    mutationFn: async () => { /* corpo atual inalterado */ },
    onSuccess: /* atual */, onError: /* atual */,
  });
```

`bulkOrdersSyncMutation` (linha ~287):

```ts
  const bulkOrdersSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarPedidosTodos,
    detalhes: (d) => ({ pedidos: d.grandTotalSynced, itens: d.grandTotalItems, sem_cliente: d.grandTotalSkipped }),
    mutationFn: () => runOrdersSync(),
    onSuccess: /* atual */, onError: /* atual */,
  });
```

`recentOrdersSyncMutation` (linha ~302):

```ts
  const recentOrdersSyncMutation = useMutationComRegistro({
    acao: ACOES_ANALYTICS_SYNC.importarPedidosRecentes,
    detalhes: (d) => ({ pedidos: d.grandTotalSynced, itens: d.grandTotalItems }),
    mutationFn: () => { /* corpo atual (janela 180d) inalterado */ },
    onSuccess: /* atual */, onError: /* atual */,
  });
```

("corpo atual inalterado" = mover o corpo existente sem editar lógica; a ÚNICA mudança é o hook wrapper + `acao` + `detalhes`.)

- [ ] **Step 3: Captions nos cards**

`ImportCards.tsx` — adicionar imports:

```tsx
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { ACOES_ANALYTICS_SYNC } from "./acoes";
```

Em `ImportClientesCard`, dentro do `<CardHeader>`, logo APÓS o fechamento do `<div className="flex items-center justify-between">`:

```tsx
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.importarClientes} />
```

Em `ImportEnderecosCard`, idem:

```tsx
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.sincronizarEnderecos} />
```

Em `ImportPedidosCard`, idem (2 botões → array; a caption mostra a mais recente e o tooltip diz qual):

```tsx
        <UltimaExecucao
          acao={[ACOES_ANALYTICS_SYNC.importarPedidosRecentes, ACOES_ANALYTICS_SYNC.importarPedidosTodos]}
        />
```

`EngineCards.tsx` — mesmos imports; em `CostEngineCard` após o div do header:

```tsx
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.recalcularCustos} />
```

Em `AssociationRulesCard`:

```tsx
        <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.recalcularRegras} />
```

`AdminAnalyticsSync.tsx` — import das mesmas duas; o bloco do header à direita vira coluna com a caption embaixo:

```tsx
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-3">
            {/* Select + Button "Sync Completo" EXATAMENTE como estão hoje */}
          </div>
          <UltimaExecucao acao={ACOES_ANALYTICS_SYNC.syncCompleto} />
        </div>
```

- [ ] **Step 4: Atualizar os testes dos cards (mock da caption — são componentes burros + caption com dados)**

No TOPO de `__tests__/ImportCards.test.tsx` e `__tests__/EngineCards.test.tsx` (antes dos describes):

```ts
vi.mock("@/components/execucoes/UltimaExecucao", () => ({
  UltimaExecucao: () => null,
}));
```

- [ ] **Step 5: Rodar a suíte inteira + typecheck**

```bash
heavy bun run test > /tmp/test.log 2>&1; echo "exit=$?"; tail -15 /tmp/test.log
heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"; tail -5 /tmp/tc.log
```
Esperado: ambos exit=0.

- [ ] **Step 6: Verificação visual (preview)**

```bash
# via preview_start (launch.json) — conferir /admin/analytics-sync:
# captions "Nunca executada" nos 5 cards + header (tabela ainda não existe em prod local? —
# em dev aponta pra prod: a query retorna erro 42P01 ATÉ a migration ser aplicada).
```
**Nota comportamental:** antes da migration aplicada em produção, `useUltimaExecucao` recebe erro (tabela não existe) → react-query fica `isError`, componente renderiza `rotuloUltimaExecucao(null)`? NÃO — com `isError`, `data` é `undefined` e o componente mostra "Nunca executada". Validar que a página NÃO quebra (é o comportamento fail-open de leitura desejado; a caption só fica verdadeira pós-migration). Se o erro poluir o console em loop, limitar: `retry: 1` no `useQuery` de `useUltimaExecucao`.

- [ ] **Step 7: Commit**

```bash
git add src/components/analyticsSync/ src/pages/AdminAnalyticsSync.tsx
git commit -m "feat(analytics-sync): última execução nos 5 cards + Sync Completo (manual+cron)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Convenção durável (CLAUDE.md) + histórico + gates finais

**Files:**
- Modify: `CLAUDE.md` (§Design System, lista "Convenções de código novo" — 1 bullet)
- Modify: `docs/historico/auditoria-ux-redesign.md` (entrada curta ao final)

- [ ] **Step 1: Bullet no CLAUDE.md**

Adicionar à lista de convenções (§Design System), após o bullet de Toast/Skeleton/Empty:

```markdown
- Ação global (sincronizar/importar/recalcular/gerar): `useMutationComRegistro` + `<UltimaExecucao acao>` (`src/components/execucoes/`) — não `useMutation` cru; edge single-shot com cron registra server-side (`_shared/registro-execucao.ts`; 1 escritor por slug). Ação sobre UM registro: estado no próprio registro.
```

- [ ] **Step 2: Vigia de tamanho**

```bash
bun run claude:size > /tmp/size.log 2>&1; echo "exit=$?"; tail -3 /tmp/size.log
```
Esperado: exit=0. Se estourar: enxugar o bullet (mínimo viável: `- Ação global (sync/import/recalc): useMutationComRegistro + <UltimaExecucao> — 1 escritor por slug; edge c/ cron grava server-side.`).

- [ ] **Step 3: Entrada no histórico**

Ao final de `docs/historico/auditoria-ux-redesign.md`:

```markdown
## Última execução em ações globais (2026-07-18)

Todo botão de ação global (sincronizar/importar/recalcular) passa a mostrar "Última execução:
há X · quem · status" — pedido do founder a partir do print de `/admin/analytics-sync`.
Infra: tabela `acoes_execucoes` (RLS staff-only, provada em PG17 com falsificação) + primitivos
`useMutationComRegistro`/`<UltimaExecucao>` (`src/components/execucoes/`, plataforma) + registro
server-side na edge (`_shared/registro-execucao.ts`) para actions com cron — o clique manual e o
cron 2/2h do `compute-costs-daily` aparecem na MESMA caption (descoberta que definiu o design:
registrar só cliques mentiria). Convenção nova no CLAUDE.md §Design System; varredura dos demais
botões do app (tintImport, GestorExcecoes, AdminReposicaoPedidos, GerarCicloDialog…) é o PR2.
Spec: `docs/superpowers/specs/2026-07-18-ultima-execucao-acoes-design.md`.
```

- [ ] **Step 4: Gates finais completos**

```bash
heavy bun run typecheck > /tmp/g1.log 2>&1; echo "tc=$?"
bun lint > /tmp/g2.log 2>&1; echo "lint=$?"
heavy bun run test > /tmp/g3.log 2>&1; echo "test=$?"
bunx knip > /tmp/g4.log 2>&1; echo "knip=$?"; tail -5 /tmp/g4.log
```
Esperado: todos 0. knip pode acusar exports não usados se algo ficou órfão (ex.: `useUltimaExecucao` é usado pelo componente; `ULTIMA_EXECUCAO_QUERY_KEY` pelos dois hooks) — corrigir removendo export desnecessário, não silenciando.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/historico/auditoria-ux-redesign.md
git commit -m "docs: convenção 'última execução' em ações globais (CLAUDE.md + histórico)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: PR + watcher + handoff de deploy

**Files:** nenhum novo (push + PR).

- [ ] **Step 1: Push + PR (não-draft → auto-merge no verde)**

```bash
git push -u origin claude/ultimo-sincronismo-botoes-7cdcf8
gh pr create --title "feat(ux): 'última execução' em botões de ação global — fundação + /admin/analytics-sync" --body "$(cat <<'EOF'
## O quê
Todo botão de ação global (sincronizar/importar/recalcular) mostra **"Última execução: há X · quem · status"** — manual E automática (cron) na mesma caption. Fundação + adoção completa em `/admin/analytics-sync`.

- Tabela `acoes_execucoes` (RLS staff-only fail-closed) — **provada em PG17** (`db/test-acoes-execucoes.sh`: 13 asserts + falsificação).
- Primitivos `useMutationComRegistro` (fail-open) + `<UltimaExecucao acao>` em `src/components/execucoes/` (plataforma).
- Edge `omie-analytics-sync`: motores registram server-side (clique staff **e** cron `compute-costs-daily` 2/2h + `compute-association-rules-daily`) via `_shared/registro-execucao.ts`.
- Convenção nova no CLAUDE.md §Design System (1 escritor por slug; ação per-registro fica de fora).

## ⚠️ Deploy (3 camadas manuais — merge ≠ produção)
1. **Migration** `20260722100000_acoes_execucoes_ultima_execucao.sql` → SQL Editor (bloco no comentário a seguir).
2. **Edge** `omie-analytics-sync` → deploy pelo chat do Lovable.
3. **Publish** do frontend.
Sem (1), captions mostram "Nunca executada" e registros de clique falham em silêncio (fail-open por design — nada quebra).

## PR2 (varredura)
tintImport SyncCard · GestorExcecoes · AdminReposicaoPedidos · GerarCicloDialog · PrecoEmbalagemDialog — mapear cron sobreposto por botão.

Spec: `docs/superpowers/specs/2026-07-18-ultima-execucao-acoes-design.md` · Plano: `docs/superpowers/plans/2026-07-18-ultima-execucao-acoes.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Armar o watcher em background (obrigatório — CLAUDE.md §Merge)**

```bash
scripts/pr-watch.sh <nº do PR>
```
(Bash `run_in_background: true`.) No desfecho: PushNotification (mergeado/conflito/CI vermelho). Exit 6 = estado DESCONHECIDO → `gh pr view <nº>` antes de reportar.

- [ ] **Step 3: Handoff pro founder (no chat, com título de chip se aplicável)**

Entregar: (a) bloco SQL da migration pronto pro SQL Editor + query de validação pós-apply (`select count(*) from pg_policies where tablename='acoes_execucoes';` → 3); (b) prompt de deploy da edge pro chat do Lovable; (c) lembrete do Publish; (d) teste de fumaça: clicar "Recalcular Custos" e ver a caption virar "Em andamento" → "há menos de um minuto · Lucas · ✓"; esperar o próximo tick do cron (2/2h) e ver "· automática".

---

## Self-Review (executado na escrita do plano)

1. **Spec coverage:** tabela+RLS (T1) ✓ · primitivos (T2-T4) ✓ · edge manual+cron (T5) ✓ · adoção 5 cards+header (T6) ✓ · convenção CLAUDE.md (T7) ✓ · prova PG17 c/ falsificação (T1) ✓ · vitest fail-open (T3) ✓ · Deno test (T5) ✓ · handoff 3 camadas (T8) ✓ · PR2 documentado (T7/T8) ✓.
2. **Placeholders:** os "corpo atual inalterado" da T6 são instruções de PRESERVAÇÃO de código existente (o executor tem o arquivo aberto), não lacunas de design — as mudanças reais estão todas explícitas.
3. **Type consistency:** `AcaoExecucao`/`ULTIMA_EXECUCAO_QUERY_KEY` (T2) usados em T3/T4; `comRegistro`/`DbRegistro` (T5) coerentes com `AuthResult` de `auth.ts`; slugs idênticos entre `acoes.ts` (T6) e edge (T5) — conferidos string a string.
