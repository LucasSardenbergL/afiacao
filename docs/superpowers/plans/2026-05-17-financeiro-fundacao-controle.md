# Financeiro Fundação — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar as 5 fundações internas do módulo Financeiro do Afiação — audit trail, travamento de período com override, DRE por competência, gate de mapping de categoria, reconciliação intercompany cruzada — destravando confiança contábil "ponta do lápis" sem depender de integrações externas.

**Architecture:** Híbrida. Triggers Postgres pro que precisa ser tamper-evident (audit + travamento + gate). Edge Functions TypeScript pro que tem lógica derivada (DRE competência, IC reconcile, suggest mapping). UI React+shadcn pra surfacing.

**Tech Stack:** Postgres 15 (Supabase), Deno (Edge Functions), TypeScript, React 18, Tailwind, shadcn/ui, vitest. Spec de referência: [docs/superpowers/specs/2026-05-17-financeiro-fundacao-controle-design.md](../specs/2026-05-17-financeiro-fundacao-controle-design.md).

**Schema real verificado:** colunas usam `company` (não `empresa_id`), `data_movimento` (não `data_movimentacao`), `fin_fechamentos.ano+mes` (não `periodo`), `fin_categoria_dre_mapping.omie_codigo` (não `categoria_id`). Status de fechamento aprovado é `status='fechado' AND aprovado_em IS NOT NULL`.

**Cronograma de fases (cada fase = 1 PR shippable):**
1. **Phase 0** — Setup compartilhado (1 commit)
2. **Phase 1** — Audit Trail (~12 tarefas, 1 PR)
3. **Phase 2** — Travamento + Override (~14 tarefas, 1 PR)
4. **Phase 3** — DRE Competência (~10 tarefas, 1 PR)
5. **Phase 4** — Gate de Mapping (~12 tarefas, 1 PR)
6. **Phase 5** — IC Reconciliação (~16 tarefas, 1 PR)

Cada fase fecha com `bun lint && bun build && bun test` verde + commit final + marker `[PR-READY: Phase X]`.

---

## Phase 0: Setup compartilhado

### Task 0.1: Criar `lib/financeiro/error-handler.ts` (usado por phases 2, 4)

**Files:**
- Create: `src/lib/financeiro/error-handler.ts`
- Test: `src/lib/financeiro/__tests__/error-handler.test.ts`

- [ ] **Step 1: Criar teste falhando**

Arquivo: `src/lib/financeiro/__tests__/error-handler.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { parsePostgresFinanceiroError } from '../error-handler';

describe('parsePostgresFinanceiroError', () => {
  it('detects PERIOD_LOCKED (P0001)', () => {
    const err = {
      code: 'P0001',
      message: 'PERIOD_LOCKED: Período 03/2026 da empresa colacor está fechado em 2026-03-31. Use override de emergência.',
    };
    const parsed = parsePostgresFinanceiroError(err);
    expect(parsed.kind).toBe('period_locked');
    expect(parsed.empresa).toBe('colacor');
    expect(parsed.periodo).toBe('03/2026');
  });

  it('detects MAPPING_INCOMPLETE (P0002)', () => {
    const err = {
      code: 'P0002',
      message: 'MAPPING_INCOMPLETE: 3 categorias sem mapeamento DRE: [{"id":"123","nome":"Honorários"}]',
    };
    const parsed = parsePostgresFinanceiroError(err);
    expect(parsed.kind).toBe('mapping_incomplete');
    expect(parsed.count).toBe(3);
    expect(parsed.pendentes).toEqual([{ id: '123', nome: 'Honorários' }]);
  });

  it('returns kind=unknown for other errors', () => {
    const parsed = parsePostgresFinanceiroError({ code: '23505', message: 'duplicate key' });
    expect(parsed.kind).toBe('unknown');
  });

  it('handles null/undefined gracefully', () => {
    expect(parsePostgresFinanceiroError(null).kind).toBe('unknown');
    expect(parsePostgresFinanceiroError(undefined).kind).toBe('unknown');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/lib/financeiro/__tests__/error-handler.test.ts
```

Expected: FAIL (`Cannot find module '../error-handler'`)

- [ ] **Step 3: Implementar `error-handler.ts`**

Arquivo: `src/lib/financeiro/error-handler.ts`

```typescript
export type FinanceiroErrorKind =
  | 'period_locked'
  | 'mapping_incomplete'
  | 'unknown';

export type FinanceiroError =
  | { kind: 'period_locked'; empresa: string; periodo: string; lastClosed: string; raw: unknown }
  | { kind: 'mapping_incomplete'; count: number; pendentes: Array<{ id: string; nome: string }>; raw: unknown }
  | { kind: 'unknown'; raw: unknown };

export function parsePostgresFinanceiroError(err: unknown): FinanceiroError {
  if (!err || typeof err !== 'object') return { kind: 'unknown', raw: err };
  const e = err as { code?: string; message?: string };

  if (e.code === 'P0001' && e.message?.startsWith('PERIOD_LOCKED:')) {
    const m = e.message.match(
      /PERIOD_LOCKED: Período (\d{2}\/\d{4}) da empresa (\S+) está fechado em (\d{4}-\d{2}-\d{2})/,
    );
    if (m) {
      return { kind: 'period_locked', periodo: m[1], empresa: m[2], lastClosed: m[3], raw: err };
    }
  }

  if (e.code === 'P0002' && e.message?.startsWith('MAPPING_INCOMPLETE:')) {
    const countMatch = e.message.match(/(\d+) categorias sem mapeamento/);
    const jsonMatch = e.message.match(/\[.*\]/);
    let pendentes: Array<{ id: string; nome: string }> = [];
    if (jsonMatch) {
      try {
        pendentes = JSON.parse(jsonMatch[0]);
      } catch {
        // mantém vazio se parse falhar
      }
    }
    return {
      kind: 'mapping_incomplete',
      count: countMatch ? Number(countMatch[1]) : pendentes.length,
      pendentes,
      raw: err,
    };
  }

  return { kind: 'unknown', raw: err };
}
```

- [ ] **Step 4: Rodar teste e ver passar**

```bash
bun test src/lib/financeiro/__tests__/error-handler.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/error-handler.ts src/lib/financeiro/__tests__/error-handler.test.ts
git commit -m "feat(financeiro): parser de erros P0001/P0002 para foundation"
```

---

## Phase 1: Audit Trail Genérico

### Task 1.1: Criar migration com `fin_audit_log` table

**Files:**
- Create: `supabase/migrations/20260518000000_fin_audit_log.sql`

- [ ] **Step 1: Criar arquivo da migration**

```sql
-- ============================================================
-- Audit Trail Genérico para módulo Financeiro
-- Tabela única, escrita exclusivamente por trigger SECURITY DEFINER.
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_audit_log (
  id              bigserial PRIMARY KEY,
  table_name      text NOT NULL,
  row_id          text NOT NULL,
  op              text NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
  changed_fields  jsonb NOT NULL,
  changed_by      uuid REFERENCES auth.users(id),
  changed_at      timestamptz NOT NULL DEFAULT now(),
  company         text,
  origem          text NOT NULL DEFAULT 'manual'
                  CHECK (origem IN ('manual','omie_sync','edge_fn','override_emergencia','cron','trigger')),
  period_ref      date,
  override_justificativa text
);

CREATE INDEX IF NOT EXISTS fin_audit_log_table_row_idx
  ON fin_audit_log (table_name, row_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS fin_audit_log_company_period_idx
  ON fin_audit_log (company, period_ref, changed_at DESC);

CREATE INDEX IF NOT EXISTS fin_audit_log_user_idx
  ON fin_audit_log (changed_by, changed_at DESC);

COMMENT ON TABLE fin_audit_log IS
  'Trilha de auditoria do módulo financeiro. Escrita exclusivamente pelo trigger fin_audit_trigger via SECURITY DEFINER.';
```

- [ ] **Step 2: Aplicar migration local**

```bash
bunx supabase db reset --linked  # se ambiente linked
# OU em projeto local:
bunx supabase db push
```

Expected: migration aplica sem erro. Em ambiente staging usar `supabase db push`.

- [ ] **Step 3: Verificar criação via psql**

```bash
bunx supabase db execute "SELECT count(*) FROM fin_audit_log"
```

Expected: `0` (tabela existe, vazia)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518000000_fin_audit_log.sql
git commit -m "feat(financeiro): tabela fin_audit_log + índices"
```

### Task 1.2: Criar RLS na `fin_audit_log`

**Files:**
- Modify: `supabase/migrations/20260518000000_fin_audit_log.sql`

- [ ] **Step 1: Adicionar policies ao fim do arquivo da migration**

Append em `supabase/migrations/20260518000000_fin_audit_log.sql`:

```sql

-- RLS: leitura para staff, escrita bloqueada (só trigger escreve via SECURITY DEFINER)
ALTER TABLE fin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_audit_log_select_staff ON fin_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee','master')
    )
  );

-- Nenhuma policy de INSERT/UPDATE/DELETE — bloqueado por padrão com RLS habilitado.
-- O trigger fin_audit_trigger é SECURITY DEFINER e contorna RLS legitimamente.
```

- [ ] **Step 2: Re-aplicar migration**

```bash
bunx supabase db push
```

Expected: sucesso.

- [ ] **Step 3: Validar que escrita direta é negada**

```bash
bunx supabase db execute "
  SET ROLE authenticated;
  INSERT INTO fin_audit_log (table_name, row_id, op, changed_fields)
  VALUES ('test','1','INSERT','{}'::jsonb);
"
```

Expected: erro `new row violates row-level security policy`.

- [ ] **Step 4: Commit (amend se ainda local)**

```bash
git add supabase/migrations/20260518000000_fin_audit_log.sql
git commit -m "feat(financeiro): RLS de leitura staff em fin_audit_log"
```

### Task 1.3: Criar função trigger `fin_audit_trigger()`

**Files:**
- Create: `supabase/migrations/20260518000100_fin_audit_trigger.sql`

- [ ] **Step 1: Criar arquivo**

```sql
-- ============================================================
-- Função genérica de audit trigger
-- ============================================================

CREATE OR REPLACE FUNCTION fin_audit_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed jsonb := '{}'::jsonb;
  v_origem  text  := COALESCE(current_setting('fin.origem', true), 'manual');
  v_justif  text  := current_setting('fin.override_justificativa', true);
  v_period  date;
  v_row_id  text;
  v_company text;
BEGIN
  -- Diff de campos modificados (UPDATE)
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(
      key,
      jsonb_build_object('before', o_val, 'after', n_val)
    )
    INTO v_changed
    FROM (
      SELECT o.key,
             o.value AS o_val,
             n.value AS n_val
        FROM jsonb_each(to_jsonb(OLD)) o
        JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
       WHERE o.value IS DISTINCT FROM n.value
    ) diffs;
    IF v_changed IS NULL THEN
      -- UPDATE sem mudança real (raro mas possível) — não loga
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    v_changed := to_jsonb(NEW);
  ELSE -- DELETE
    v_changed := to_jsonb(OLD);
  END IF;

  -- row_id como text (suporta uuid, bigint, etc.)
  v_row_id := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'id',
    'unknown'
  );

  -- company: as tabelas financeiras usam 'company'; eliminações usam 'empresa_origem'
  v_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company',
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'empresa_origem'
  );

  -- period_ref: data-chave por tabela
  v_period := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'         THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'           THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'          THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping'  THEN current_date
    WHEN 'fin_orcamento'              THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes),
                                            1)
    WHEN 'fin_fechamentos'            THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes),
                                            1)
    WHEN 'fin_eliminacoes_intercompany' THEN current_date
    ELSE current_date
  END;

  INSERT INTO fin_audit_log (
    table_name, row_id, op, changed_fields,
    changed_by, company, origem, period_ref, override_justificativa
  ) VALUES (
    TG_TABLE_NAME,
    v_row_id,
    TG_OP,
    v_changed,
    auth.uid(),
    v_company,
    v_origem,
    v_period,
    v_justif
  );

  RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION fin_audit_trigger() IS
  'Trigger genérico de auditoria do módulo financeiro. Lê fin.origem e fin.override_justificativa do contexto da sessão.';
```

- [ ] **Step 2: Aplicar migration**

```bash
bunx supabase db push
```

Expected: sucesso.

- [ ] **Step 3: Smoke test isolado da função (sem trigger ainda)**

```bash
bunx supabase db execute "
  -- Cria uma tabela dummy só pra validar a função em isolamento
  CREATE TEMP TABLE test_audit_t (id bigserial PRIMARY KEY, company text, valor numeric, data_emissao date);
  -- Não anexa trigger porque é tabela temporária; valida apenas a definição
  SELECT proname, prosrc IS NOT NULL FROM pg_proc WHERE proname='fin_audit_trigger';
"
```

Expected: linha `fin_audit_trigger | t`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518000100_fin_audit_trigger.sql
git commit -m "feat(financeiro): função fin_audit_trigger() genérica"
```

### Task 1.4: Anexar trigger nas 6 tabelas auditadas

**Files:**
- Create: `supabase/migrations/20260518000200_fin_audit_attach.sql`

- [ ] **Step 1: Criar arquivo de attach**

```sql
-- ============================================================
-- Anexa fin_audit_trigger às tabelas financeiras críticas
-- ============================================================

DROP TRIGGER IF EXISTS trg_audit ON fin_contas_receber;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_contas_receber
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_contas_pagar;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_contas_pagar
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_categoria_dre_mapping;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_categoria_dre_mapping
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_orcamento;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_orcamento
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_fechamentos;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_fechamentos
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_eliminacoes_intercompany;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eliminacoes_intercompany
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

Expected: sucesso.

- [ ] **Step 3: Validar trigger existe nas 6 tabelas**

```bash
bunx supabase db execute "
  SELECT event_object_table, trigger_name
    FROM information_schema.triggers
   WHERE trigger_name = 'trg_audit'
   ORDER BY event_object_table;
"
```

Expected: 6 linhas com `trg_audit` em cada uma das tabelas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518000200_fin_audit_attach.sql
git commit -m "feat(financeiro): anexa fin_audit_trigger nas 6 tabelas auditadas"
```

### Task 1.5: Smoke test SQL do audit trail

**Files:**
- Create: `supabase/tests/fin_audit_smoke.sql`

- [ ] **Step 1: Criar smoke test**

```sql
-- Smoke test: audit trail captura INSERT, UPDATE, DELETE
-- Rodar com: bunx supabase db execute < supabase/tests/fin_audit_smoke.sql
-- Cada bloco é BEGIN/ROLLBACK pra não deixar lixo.

BEGIN;
  -- INSERT
  INSERT INTO fin_categoria_dre_mapping (company, omie_codigo, dre_linha)
  VALUES ('_default', 'smoke_test_999', 'despesas_operacionais');

  -- UPDATE
  UPDATE fin_categoria_dre_mapping
     SET dre_linha = 'despesas_administrativas'
   WHERE omie_codigo = 'smoke_test_999';

  -- DELETE
  DELETE FROM fin_categoria_dre_mapping WHERE omie_codigo = 'smoke_test_999';

  -- Verificar que 3 entries de audit foram criadas
  SELECT op, COUNT(*) AS qtd
    FROM fin_audit_log
   WHERE table_name = 'fin_categoria_dre_mapping'
     AND (changed_fields->>'omie_codigo' = 'smoke_test_999'
          OR changed_fields->'omie_codigo'->>'after' = 'smoke_test_999'
          OR changed_fields->'omie_codigo'->>'before' = 'smoke_test_999')
   GROUP BY op
   ORDER BY op;
  -- Expected: DELETE 1, INSERT 1, UPDATE 1

ROLLBACK;
```

- [ ] **Step 2: Rodar e validar output**

```bash
bunx supabase db execute < supabase/tests/fin_audit_smoke.sql
```

Expected output: 3 linhas (DELETE=1, INSERT=1, UPDATE=1). Se vier diferente, o trigger não está disparando.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/fin_audit_smoke.sql
git commit -m "test(financeiro): smoke SQL do audit trail"
```

### Task 1.6: Marcar origem `omie_sync` na edge function

**Files:**
- Modify: `supabase/functions/omie-financeiro/index.ts`

- [ ] **Step 1: Localizar onde o cliente Supabase é criado e onde mutações começam**

Procurar pela linha que cria o client (`createClient(...)`) e o ponto de entrada do handler `serve(...)`.

- [ ] **Step 2: Adicionar helper de origem antes de qualquer mutação**

Inserir helper no topo do arquivo (após imports):

```typescript
async function setAuditOrigem(
  supabase: ReturnType<typeof createClient>,
  origem: 'omie_sync' | 'edge_fn' | 'cron',
) {
  // SET LOCAL precisa rodar dentro de transação. Para chamadas pontuais sem tx,
  // a alternativa é usar set_config(name, value, true).
  await supabase.rpc('set_config', {
    parameter: 'fin.origem',
    value: origem,
    is_local: false, // session-level (válido enquanto a conexão durar)
  } as never);
}
```

- [ ] **Step 3: Criar RPC `set_config` wrapper (se ainda não existir)**

Criar `supabase/migrations/20260518000300_set_config_rpc.sql`:

```sql
-- Wrapper de set_config exposto como RPC.
-- Permite que edge functions setem custom GUCs (ex: fin.origem) via supabase-js.
-- Apenas chaves do namespace 'fin.' são permitidas.

CREATE OR REPLACE FUNCTION public.set_config(
  parameter text,
  value text,
  is_local boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF parameter NOT LIKE 'fin.%' THEN
    RAISE EXCEPTION 'set_config: namespace não permitido: %', parameter;
  END IF;
  RETURN pg_catalog.set_config(parameter, value, is_local);
END $$;

REVOKE EXECUTE ON FUNCTION public.set_config(text, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.set_config(text, text, boolean) TO authenticated, service_role;
```

- [ ] **Step 4: Aplicar migration e chamar helper antes das mutações no omie-financeiro**

```bash
bunx supabase db push
```

Encontrar a função principal do handler que faz INSERT/UPDATE em `fin_contas_receber`/`fin_contas_pagar` e adicionar logo após criar o supabase client:

```typescript
// Antes de qualquer mutação na rota de sync:
await setAuditOrigem(supabase, 'omie_sync');
```

- [ ] **Step 5: Deploy edge function**

```bash
bunx supabase functions deploy omie-financeiro --no-verify-jwt
```

Expected: deploy success.

- [ ] **Step 6: Validar manualmente**

Acionar uma rota do omie-financeiro que sync CR/CP (via UI `/financeiro/sync` "Sync CR" da empresa de teste) e checar:

```bash
bunx supabase db execute "
  SELECT origem, COUNT(*) FROM fin_audit_log
   WHERE changed_at > now() - interval '5 minutes'
   GROUP BY origem;
"
```

Expected: pelo menos uma linha `omie_sync`.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/omie-financeiro/index.ts supabase/migrations/20260518000300_set_config_rpc.sql
git commit -m "feat(financeiro): marca origem='omie_sync' no audit durante sync Omie"
```

### Task 1.7: Hook `useAuditTrail`

**Files:**
- Create: `src/hooks/useAuditTrail.ts`
- Test: `src/hooks/__tests__/useAuditTrail.test.tsx`

- [ ] **Step 1: Criar teste falhando**

```typescript
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuditTrail } from '../useAuditTrail';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useAuditTrail', () => {
  it('returns disabled query when rowId is empty', () => {
    const { result } = renderHook(
      () => useAuditTrail({ tableName: 'fin_contas_receber', rowId: '' }),
      { wrapper },
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/hooks/__tests__/useAuditTrail.test.tsx
```

Expected: FAIL (`Cannot find module '../useAuditTrail'`)

- [ ] **Step 3: Implementar**

```typescript
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AuditEntry = {
  id: number;
  table_name: string;
  row_id: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_fields: Record<string, unknown>;
  changed_by: string | null;
  changed_at: string;
  company: string | null;
  origem: 'manual' | 'omie_sync' | 'edge_fn' | 'override_emergencia' | 'cron' | 'trigger';
  period_ref: string | null;
  override_justificativa: string | null;
};

export function useAuditTrail(params: { tableName: string; rowId: string; limit?: number }) {
  const { tableName, rowId, limit = 50 } = params;
  return useQuery({
    queryKey: ['fin_audit_log', tableName, rowId, limit],
    enabled: Boolean(tableName) && Boolean(rowId),
    queryFn: async (): Promise<AuditEntry[]> => {
      const { data, error } = await supabase
        .from('fin_audit_log')
        .select('*')
        .eq('table_name', tableName)
        .eq('row_id', rowId)
        .order('changed_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as AuditEntry[];
    },
  });
}
```

- [ ] **Step 4: Rodar teste**

```bash
bun test src/hooks/__tests__/useAuditTrail.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAuditTrail.ts src/hooks/__tests__/useAuditTrail.test.tsx
git commit -m "feat(financeiro): hook useAuditTrail consumindo fin_audit_log"
```

### Task 1.8: Helper `lib/financeiro/audit.ts` — formatação de diff

**Files:**
- Create: `src/lib/financeiro/audit.ts`
- Test: `src/lib/financeiro/__tests__/audit.test.ts`

- [ ] **Step 1: Criar teste**

```typescript
import { describe, it, expect } from 'vitest';
import { formatAuditDiff, formatAuditOrigem, formatAuditValue } from '../audit';

describe('formatAuditDiff', () => {
  it('formats UPDATE diff into ordered list', () => {
    const result = formatAuditDiff('UPDATE', {
      valor_documento: { before: 100, after: 150 },
      status_titulo: { before: 'ABERTO', after: 'PAGO' },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ field: 'valor_documento', before: 100, after: 150 });
  });

  it('formats INSERT as fields with after only', () => {
    const result = formatAuditDiff('INSERT', { id: 'abc', valor: 100 });
    expect(result.every(r => r.before === undefined)).toBe(true);
  });

  it('formats DELETE as fields with before only', () => {
    const result = formatAuditDiff('DELETE', { id: 'abc', valor: 100 });
    expect(result.every(r => r.after === undefined)).toBe(true);
  });
});

describe('formatAuditOrigem', () => {
  it('maps origem to user-facing label', () => {
    expect(formatAuditOrigem('omie_sync')).toBe('Sync Omie');
    expect(formatAuditOrigem('override_emergencia')).toBe('Override emergência');
    expect(formatAuditOrigem('manual')).toBe('Manual');
  });
});

describe('formatAuditValue', () => {
  it('formats numeric BRL', () => {
    expect(formatAuditValue(1234.5)).toBe('R$ 1.234,50');
  });
  it('formats null as em-dash', () => {
    expect(formatAuditValue(null)).toBe('—');
  });
  it('returns iso date as is', () => {
    expect(formatAuditValue('2026-05-17')).toBe('2026-05-17');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/lib/financeiro/__tests__/audit.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implementar**

```typescript
export type DiffRow = {
  field: string;
  before?: unknown;
  after?: unknown;
};

export function formatAuditDiff(
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  changedFields: Record<string, unknown>,
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const [field, val] of Object.entries(changedFields)) {
    if (op === 'UPDATE' && val && typeof val === 'object' && 'before' in val && 'after' in val) {
      const v = val as { before: unknown; after: unknown };
      rows.push({ field, before: v.before, after: v.after });
    } else if (op === 'INSERT') {
      rows.push({ field, after: val });
    } else if (op === 'DELETE') {
      rows.push({ field, before: val });
    }
  }
  return rows.sort((a, b) => a.field.localeCompare(b.field));
}

const ORIGEM_LABELS: Record<string, string> = {
  manual: 'Manual',
  omie_sync: 'Sync Omie',
  edge_fn: 'Serviço interno',
  override_emergencia: 'Override emergência',
  cron: 'Cron agendado',
  trigger: 'Trigger automático',
};

export function formatAuditOrigem(origem: string): string {
  return ORIGEM_LABELS[origem] ?? origem;
}

export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  }
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
```

- [ ] **Step 4: Rodar teste**

```bash
bun test src/lib/financeiro/__tests__/audit.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/audit.ts src/lib/financeiro/__tests__/audit.test.ts
git commit -m "feat(financeiro): helpers de formatação de audit diff"
```

### Task 1.9: Componente `AuditTrailDrawer`

**Files:**
- Create: `src/components/financeiro/AuditTrailDrawer.tsx`

- [ ] **Step 1: Criar componente**

```tsx
import { useAuditTrail, type AuditEntry } from '@/hooks/useAuditTrail';
import { formatAuditDiff, formatAuditOrigem, formatAuditValue } from '@/lib/financeiro/audit';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string;
  rowId: string;
  title?: string;
};

const ORIGEM_VARIANT: Record<AuditEntry['origem'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  manual: 'default',
  omie_sync: 'secondary',
  edge_fn: 'secondary',
  override_emergencia: 'destructive',
  cron: 'outline',
  trigger: 'outline',
};

export function AuditTrailDrawer({ open, onOpenChange, tableName, rowId, title }: Props) {
  const { data, isLoading, error } = useAuditTrail({ tableName, rowId });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{title ?? 'Histórico de alterações'}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {tableName} · {rowId}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {isLoading && (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          )}

          {error && (
            <div className="text-status-error text-sm">
              Falha ao carregar histórico: {String((error as Error).message ?? error)}
            </div>
          )}

          {!isLoading && data?.length === 0 && (
            <div className="text-muted-foreground text-sm">Sem alterações registradas.</div>
          )}

          {data?.map(entry => {
            const diff = formatAuditDiff(entry.op, entry.changed_fields);
            return (
              <div key={entry.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant={ORIGEM_VARIANT[entry.origem]}>{formatAuditOrigem(entry.origem)}</Badge>
                    <span className="font-mono">{entry.op}</span>
                  </div>
                  <span className="text-muted-foreground tabular-nums">
                    {format(new Date(entry.changed_at), 'dd/MM/yyyy HH:mm:ss')}
                  </span>
                </div>

                {entry.override_justificativa && (
                  <div className="rounded bg-status-warning-bg/40 p-2 text-xs">
                    <strong>Justificativa:</strong> {entry.override_justificativa}
                  </div>
                )}

                <ul className="text-sm space-y-1">
                  {diff.map(row => (
                    <li key={row.field} className="grid grid-cols-[140px_1fr] gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.field}</span>
                      <span>
                        {entry.op === 'UPDATE' ? (
                          <>
                            <span className="line-through text-muted-foreground">{formatAuditValue(row.before)}</span>
                            {' → '}
                            <span>{formatAuditValue(row.after)}</span>
                          </>
                        ) : entry.op === 'INSERT' ? (
                          <span>{formatAuditValue(row.after)}</span>
                        ) : (
                          <span className="line-through">{formatAuditValue(row.before)}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Garantir build OK**

```bash
bun build
```

Expected: build success. Se erro de tipo em `Sheet`, conferir imports do shadcn (`src/components/ui/sheet.tsx`).

- [ ] **Step 3: Commit**

```bash
git add src/components/financeiro/AuditTrailDrawer.tsx
git commit -m "feat(financeiro): AuditTrailDrawer componente"
```

### Task 1.10: Plugar botão "Histórico" em CR e CP

**Files:**
- Modify: `src/pages/FinanceiroDashboard.tsx` (ou a tela onde CR/CP têm row actions)

- [ ] **Step 1: Identificar a tela de listagem CR/CP**

```bash
grep -rln "fin_contas_receber\|fin_contas_pagar" src/pages/ src/components/ | head -10
```

Expected: confirma `FinanceiroDashboard.tsx` (e/ou `CockpitDrillDown.tsx`).

- [ ] **Step 2: Adicionar state + botão por linha**

Em `src/pages/FinanceiroDashboard.tsx`, no topo do componente:

```tsx
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';
import { History } from 'lucide-react';

// dentro do componente:
const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);
```

Em cada linha da tabela CR (procurar o `<TableCell>` de "Ações"):

```tsx
<Button
  size="icon"
  variant="ghost"
  className="h-7 w-7"
  onClick={() => setAuditTarget({
    table: 'fin_contas_receber',
    id: cr.id,
    title: `CR ${cr.numero_documento ?? cr.id.slice(0, 8)}`,
  })}
  aria-label="Histórico"
>
  <History className="h-3.5 w-3.5" />
</Button>
```

Mesmo para CP, com `table: 'fin_contas_pagar'`.

No final do componente, antes do `</>` de fechamento:

```tsx
{auditTarget && (
  <AuditTrailDrawer
    open
    onOpenChange={(open) => !open && setAuditTarget(null)}
    tableName={auditTarget.table}
    rowId={auditTarget.id}
    title={auditTarget.title}
  />
)}
```

- [ ] **Step 3: Build + lint**

```bash
bun lint && bun build
```

Expected: 0 errors. Warnings de `any` pré-existentes OK.

- [ ] **Step 4: Smoke manual**

Subir dev (`bun dev`), abrir `/financeiro/dashboard`, clicar no botão de histórico de qualquer CR/CP — drawer abre, lista vazia (ou com entries de sync recentes).

- [ ] **Step 5: Commit**

```bash
git add src/pages/FinanceiroDashboard.tsx
git commit -m "feat(financeiro): botão Histórico em CR/CP abre AuditTrailDrawer"
```

### Task 1.11: Plugar botão "Histórico" em Mapping, Orçamento, Fechamento

**Files:**
- Modify: `src/pages/FinanceiroMapping.tsx`
- Modify: `src/pages/FinanceiroOrcamento.tsx`
- Modify: `src/pages/FinanceiroFechamento.tsx`

- [ ] **Step 1: Replicar o padrão da Task 1.10 nas 3 telas**

Para cada uma:
- Importar `AuditTrailDrawer` e `History`
- Adicionar `useState<{ table: string; id: string; title: string } | null>` no topo
- Adicionar botão `<Button size="icon" variant="ghost">` em cada linha
- Adicionar `<AuditTrailDrawer ...>` no final

Mappings:
- `FinanceiroMapping.tsx` → `table: 'fin_categoria_dre_mapping'`, title: `Mapping ${row.omie_codigo}`
- `FinanceiroOrcamento.tsx` → `table: 'fin_orcamento'`, title: `Orçamento ${row.dre_linha} ${row.ano}/${row.mes}`
- `FinanceiroFechamento.tsx` → `table: 'fin_fechamentos'`, title: `Fechamento ${row.company} ${row.ano}/${row.mes}`

- [ ] **Step 2: Build + lint**

```bash
bun lint && bun build
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/FinanceiroMapping.tsx src/pages/FinanceiroOrcamento.tsx src/pages/FinanceiroFechamento.tsx
git commit -m "feat(financeiro): Histórico em Mapping/Orçamento/Fechamento"
```

### Task 1.12: Build/lint/test geral + marker fim de fase

- [ ] **Step 1: Pipeline completa**

```bash
bun lint && bun build && bun test
```

Expected: lint sem erros novos, build verde, tests verdes.

- [ ] **Step 2: Smoke manual completo do audit**

- Abrir `/financeiro/dashboard`, editar uma CR (mudança qualquer salvável) → reabrir histórico, vê entry `UPDATE`
- Em `/financeiro/mapping`, criar mapping novo → vê entry `INSERT` com origem `Manual`
- Em `/financeiro/sync`, disparar sync de CR de teste → entries com origem `Sync Omie`

- [ ] **Step 3: Commit final + marker**

```bash
git add -A
git commit --allow-empty -m "ship(financeiro): [PR-READY: Phase 1] Audit Trail completo"
```

`[PR-READY: Phase 1]` — Audit Trail. Pronto pra abrir PR. Próximo executor (subagent ou humano) decide se faz PR agora ou se acumula.

---

## Phase 2: Travamento de Período + Override

### Task 2.1: Migration `fin_period_overrides` + RLS

**Files:**
- Create: `supabase/migrations/20260518001000_fin_period_overrides.sql`

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- Janelas de override de período fechado
-- ============================================================

CREATE TABLE IF NOT EXISTS fin_period_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company         text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ano             integer NOT NULL,
  mes             integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  opened_by       uuid NOT NULL REFERENCES auth.users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  justificativa   text NOT NULL,
  acao_planejada  text NOT NULL,
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS fin_period_overrides_active_idx
  ON fin_period_overrides (company, ano, mes, expires_at)
  WHERE closed_at IS NULL;

ALTER TABLE fin_period_overrides ENABLE ROW LEVEL SECURITY;

-- Leitura: staff. Escrita: só pela edge function (service_role) ou master direto.
CREATE POLICY fin_period_overrides_select_staff ON fin_period_overrides
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()
              AND role IN ('employee','master'))
  );

CREATE POLICY fin_period_overrides_insert_master ON fin_period_overrides
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'master')
  );

CREATE POLICY fin_period_overrides_update_self ON fin_period_overrides
  FOR UPDATE USING (opened_by = auth.uid())
  WITH CHECK (opened_by = auth.uid());

COMMENT ON TABLE fin_period_overrides IS
  'Janelas de 15 min de override de período fechado, abertas por master via fin-period-override.';
```

- [ ] **Step 2: Aplicar e verificar**

```bash
bunx supabase db push
bunx supabase db execute "SELECT count(*) FROM fin_period_overrides"
```

Expected: 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260518001000_fin_period_overrides.sql
git commit -m "feat(financeiro): tabela fin_period_overrides + RLS"
```

### Task 2.2: Função `fin_period_lock_trigger()`

**Files:**
- Create: `supabase/migrations/20260518001100_fin_period_lock_trigger.sql`

- [ ] **Step 1: Criar migration**

```sql
-- ============================================================
-- Trigger de travamento: rejeita mutações em período fechado.
-- Bypass: override ativo (15 min, master) OU GUC fin.bypass_lock = 'true'.
-- ============================================================

CREATE OR REPLACE FUNCTION fin_period_lock_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_date date;
  v_target_company text;
  v_last_closed_year int;
  v_last_closed_month int;
  v_last_closed_date date;
  v_has_override boolean;
  v_bypass text := current_setting('fin.bypass_lock', true);
BEGIN
  -- Bypass explícito de migração/seed: rota administrativa só.
  IF v_bypass = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_target_company := COALESCE(
    (CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'company'
  );

  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_contas_pagar'          THEN COALESCE((NEW).data_emissao, (OLD).data_emissao)
    WHEN 'fin_movimentacoes'         THEN COALESCE((NEW).data_movimento, (OLD).data_movimento)
    WHEN 'fin_categoria_dre_mapping' THEN current_date  -- mapping novo é current_date, sempre passa
    WHEN 'fin_orcamento'             THEN make_date(
                                            COALESCE((NEW).ano, (OLD).ano),
                                            COALESCE((NEW).mes, (OLD).mes), 1)
  END;

  -- INSERT em mapping (criar novo) sempre passa
  IF TG_TABLE_NAME = 'fin_categoria_dre_mapping' AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Sem data ou sem company: deixa passar (não temos como bloquear)
  IF v_target_date IS NULL OR v_target_company IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Último fechamento aprovado
  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company
     AND status = 'fechado'
     AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN
    RETURN COALESCE(NEW, OLD);  -- nenhuma aprovação ainda, libera
  END IF;

  -- último fechamento cobre até o último dia do mês
  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN
    RETURN COALESCE(NEW, OLD);  -- período aberto, libera
  END IF;

  -- Período fechado → checa override ativo do usuário atual
  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now()
       AND closed_at IS NULL
       AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date),
    v_target_company,
    v_last_closed_date
    USING ERRCODE = 'P0001';
END $$;

COMMENT ON FUNCTION fin_period_lock_trigger() IS
  'Trigger BEFORE de travamento de período. Bypass: override ativo (master) OU fin.bypass_lock=true.';
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Validar função existe**

```bash
bunx supabase db execute "SELECT proname FROM pg_proc WHERE proname='fin_period_lock_trigger'"
```

Expected: 1 linha.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518001100_fin_period_lock_trigger.sql
git commit -m "feat(financeiro): função fin_period_lock_trigger() com bypass por override"
```

### Task 2.3: Anexar trigger nas 5 tabelas

**Files:**
- Create: `supabase/migrations/20260518001200_fin_period_lock_attach.sql`

- [ ] **Step 1: Criar attach**

```sql
DROP TRIGGER IF EXISTS trg_period_lock ON fin_contas_receber;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_contas_receber
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_contas_pagar;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_contas_pagar
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_movimentacoes;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_movimentacoes
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_categoria_dre_mapping;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_categoria_dre_mapping
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_orcamento;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_orcamento
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Validar 5 triggers**

```bash
bunx supabase db execute "
  SELECT event_object_table FROM information_schema.triggers
   WHERE trigger_name='trg_period_lock'
   ORDER BY event_object_table;
"
```

Expected: 5 linhas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518001200_fin_period_lock_attach.sql
git commit -m "feat(financeiro): anexa trg_period_lock nas 5 tabelas mutáveis"
```

### Task 2.4: Smoke test do travamento

**Files:**
- Create: `supabase/tests/fin_period_lock_smoke.sql`

- [ ] **Step 1: Criar smoke**

```sql
-- Smoke: travamento bloqueia edit em período fechado
-- Pré-requisito: existir 1 fechamento 'fechado' com aprovado_em IS NOT NULL
-- pra empresa colacor em ano/mes anteriores

BEGIN;
  -- Garantir um fechamento aprovado de 2025-01 pra colacor
  INSERT INTO fin_fechamentos (company, ano, mes, status, aprovado_em, aprovado_por)
  VALUES ('colacor', 2025, 1, 'fechado', now(), '00000000-0000-0000-0000-000000000001'::uuid)
  ON CONFLICT (company, ano, mes, versao) DO UPDATE
    SET status='fechado', aprovado_em=now();

  -- Tentar inserir CR em 2025-01-15: deve falhar com P0001
  DO $$
  BEGIN
    BEGIN
      INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, data_emissao, valor_documento)
      VALUES ('colacor', 999999, '2025-01-15', 100);
      RAISE EXCEPTION 'EXPECTED_FAILURE: travamento não disparou';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      RAISE NOTICE 'OK: travamento disparou conforme esperado: %', SQLERRM;
    END;
  END $$;

  -- Inserir em 2026-01-15 (período aberto): deve passar
  INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, data_emissao, valor_documento)
  VALUES ('colacor', 999998, '2026-01-15', 100);
  SELECT 'OK: insert em período aberto passou' AS resultado;

ROLLBACK;
```

- [ ] **Step 2: Rodar**

```bash
bunx supabase db execute < supabase/tests/fin_period_lock_smoke.sql
```

Expected: NOTICE `OK: travamento disparou` e a linha `OK: insert em período aberto passou`.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/fin_period_lock_smoke.sql
git commit -m "test(financeiro): smoke do travamento de período"
```

### Task 2.5: Edge function `fin-period-override`

**Files:**
- Create: `supabase/functions/fin-period-override/index.ts`

- [ ] **Step 1: Criar edge fn**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type OverridePayload = {
  company: 'oben' | 'colacor' | 'colacor_sc';
  ano: number;
  mes: number;
  justificativa: string;
  acao_planejada: string;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Resolve user id (precisa ser master)
  let userId: string | null = null;
  if (auth.via === 'staff' && auth.userId) {
    userId = auth.userId;
    const { data: role } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle();
    if (role?.role !== 'master') {
      return new Response(JSON.stringify({ error: 'apenas master pode abrir override' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } else if (auth.via !== 'cron' && auth.via !== 'service_role') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: OverridePayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!payload.company || !payload.ano || !payload.mes || !payload.justificativa?.trim() || !payload.acao_planejada?.trim()) {
    return new Response(JSON.stringify({ error: 'company, ano, mes, justificativa e acao_planejada são obrigatórios' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('fin_period_overrides')
    .insert({
      company: payload.company,
      ano: payload.ano,
      mes: payload.mes,
      opened_by: userId,
      justificativa: payload.justificativa.trim(),
      acao_planejada: payload.acao_planejada.trim(),
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    override_id: data.id,
    expires_at: data.expires_at,
    opened_at: data.opened_at,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Deploy**

```bash
bunx supabase functions deploy fin-period-override
```

Expected: deploy success.

- [ ] **Step 3: Smoke via curl (com JWT master)**

```bash
TOKEN="<JWT_master_de_teste>"
curl -X POST "${SUPABASE_URL}/functions/v1/fin-period-override" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"company":"colacor","ano":2025,"mes":1,"justificativa":"smoke","acao_planejada":"validar deploy"}'
```

Expected: 200 com `{ override_id, expires_at, opened_at }`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/fin-period-override/index.ts
git commit -m "feat(financeiro): edge function fin-period-override (master, 15min)"
```

### Task 2.6: Hook `usePeriodOverride`

**Files:**
- Create: `src/hooks/usePeriodOverride.ts`
- Test: `src/hooks/__tests__/usePeriodOverride.test.tsx`

- [ ] **Step 1: Teste falhando**

```typescript
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePeriodOverride } from '../usePeriodOverride';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePeriodOverride', () => {
  it('exports openOverride and activeOverride', () => {
    const { result } = renderHook(() => usePeriodOverride('colacor'), { wrapper });
    expect(typeof result.current.openOverride).toBe('function');
    expect('activeOverride' in result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/hooks/__tests__/usePeriodOverride.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implementar**

```typescript
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ActiveOverride = {
  id: string;
  company: string;
  ano: number;
  mes: number;
  opened_at: string;
  expires_at: string;
  justificativa: string;
  acao_planejada: string;
};

export function usePeriodOverride(company: string) {
  const qc = useQueryClient();

  const activeOverride = useQuery<ActiveOverride | null>({
    queryKey: ['fin_period_overrides', 'active', company],
    enabled: Boolean(company),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_period_overrides')
        .select('*')
        .eq('company', company)
        .is('closed_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as ActiveOverride | null) ?? null;
    },
  });

  const openOverride = useMutation({
    mutationFn: async (input: { ano: number; mes: number; justificativa: string; acao_planejada: string }) => {
      const { data, error } = await supabase.functions.invoke('fin-period-override', {
        body: { company, ...input },
      });
      if (error) throw error;
      return data as { override_id: string; expires_at: string; opened_at: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_period_overrides', 'active', company] });
    },
  });

  return { activeOverride: activeOverride.data ?? null, openOverride };
}
```

- [ ] **Step 4: Rodar teste**

```bash
bun test src/hooks/__tests__/usePeriodOverride.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePeriodOverride.ts src/hooks/__tests__/usePeriodOverride.test.tsx
git commit -m "feat(financeiro): hook usePeriodOverride"
```

### Task 2.7: Componente `PeriodOverrideModal`

**Files:**
- Create: `src/components/financeiro/PeriodOverrideModal.tsx`

- [ ] **Step 1: Criar componente**

```tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePeriodOverride } from '@/hooks/usePeriodOverride';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company: string;
  ano: number;
  mes: number;
  onOverrideOpened?: () => void;
};

export function PeriodOverrideModal({ open, onOpenChange, company, ano, mes, onOverrideOpened }: Props) {
  const { isMaster } = useAuth();
  const { openOverride } = usePeriodOverride(company);
  const [justificativa, setJustificativa] = useState('');
  const [acaoPlanejada, setAcaoPlanejada] = useState('');

  if (!isMaster) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permissão insuficiente</DialogTitle>
            <DialogDescription>
              Apenas usuários master podem abrir override de período fechado. Peça pra quem tem permissão.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const submit = async () => {
    if (justificativa.trim().length < 10 || acaoPlanejada.trim().length < 10) {
      toast.error('Justificativa e ação planejada precisam ter pelo menos 10 caracteres.');
      return;
    }
    try {
      await openOverride.mutateAsync({ ano, mes, justificativa, acao_planejada: acaoPlanejada });
      toast.success(`Override aberto por 15 min — ${String(mes).padStart(2, '0')}/${ano} de ${company}`);
      setJustificativa('');
      setAcaoPlanejada('');
      onOpenChange(false);
      onOverrideOpened?.();
    } catch (err) {
      toast.error(`Falha ao abrir override: ${String((err as Error).message ?? err)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override de emergência</DialogTitle>
          <DialogDescription>
            Abre uma janela de 15 min pra editar lançamentos do período fechado <strong>{String(mes).padStart(2,'0')}/{ano}</strong> da empresa <strong>{company}</strong>. Toda mudança é gravada no audit com sua justificativa.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="justificativa">Justificativa (mín. 10 chars)</Label>
            <Textarea
              id="justificativa"
              value={justificativa}
              onChange={e => setJustificativa(e.target.value)}
              placeholder="Ex: lançamento de R$X esquecido pela contabilidade externa, NF 1234"
              rows={3}
            />
          </div>
          <div>
            <Label htmlFor="acao">Ação planejada (mín. 10 chars)</Label>
            <Input
              id="acao"
              value={acaoPlanejada}
              onChange={e => setAcaoPlanejada(e.target.value)}
              placeholder="Ex: inserir CP de Honorários R$2.500 em 15/01"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="destructive" onClick={submit} disabled={openOverride.isPending}>
            {openOverride.isPending ? 'Abrindo…' : 'Abrir override (15 min)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Build**

```bash
bun build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/financeiro/PeriodOverrideModal.tsx
git commit -m "feat(financeiro): PeriodOverrideModal (master, justificativa obrigatória)"
```

### Task 2.8: Indicador de override ativo no AppShell topbar

**Files:**
- Create: `src/components/financeiro/ActiveOverrideBadge.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Criar badge**

```tsx
import { useCompany } from '@/contexts/CompanyContext';
import { usePeriodOverride } from '@/hooks/usePeriodOverride';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expirado';
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function ActiveOverrideBadge() {
  const { company } = useCompany();
  const { activeOverride } = usePeriodOverride(company);
  const [, force] = useState(0);

  useEffect(() => {
    if (!activeOverride) return;
    const t = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [activeOverride]);

  if (!activeOverride) return null;

  return (
    <Badge variant="destructive" className="gap-1.5">
      <ShieldAlert className="h-3 w-3" />
      Override {String(activeOverride.mes).padStart(2, '0')}/{activeOverride.ano} · {formatRemaining(activeOverride.expires_at)}
    </Badge>
  );
}
```

- [ ] **Step 2: Plugar no topbar do AppShell**

Em `src/components/AppShell.tsx`, procurar o topbar (perto do `<CompanySwitcher />` ou `<ThemeToggle />`) e inserir antes do CompanySwitcher:

```tsx
import { ActiveOverrideBadge } from '@/components/financeiro/ActiveOverrideBadge';

// no JSX:
<ActiveOverrideBadge />
```

- [ ] **Step 3: Build + smoke**

```bash
bun build && bun dev
```

Abre app, sem override visível. Depois abrir um override via fila/modal (próximo task tem o gancho) — badge aparece com countdown.

- [ ] **Step 4: Commit**

```bash
git add src/components/financeiro/ActiveOverrideBadge.tsx src/components/AppShell.tsx
git commit -m "feat(financeiro): ActiveOverrideBadge no topbar"
```

### Task 2.9: Capturar P0001 em mutações de CR/CP e abrir modal

**Files:**
- Create: `src/components/financeiro/PeriodLockGuard.tsx`
- Modify: `src/pages/FinanceiroDashboard.tsx` (e qualquer outra que mute CR/CP)

- [ ] **Step 1: Criar wrapper de tratamento**

```tsx
import { useState, useCallback } from 'react';
import { parsePostgresFinanceiroError, type FinanceiroError } from '@/lib/financeiro/error-handler';
import { PeriodOverrideModal } from './PeriodOverrideModal';
import { toast } from 'sonner';

export function usePeriodLockHandler() {
  const [target, setTarget] = useState<{ company: string; ano: number; mes: number } | null>(null);

  const handle = useCallback((err: unknown, fallback: { company: string }): boolean => {
    const parsed = parsePostgresFinanceiroError(err);
    if (parsed.kind === 'period_locked') {
      const [mm, yyyy] = parsed.periodo.split('/');
      setTarget({ company: parsed.empresa, ano: Number(yyyy), mes: Number(mm) });
      toast.error(`Período ${parsed.periodo} fechado. Abrindo modal de override.`);
      return true;
    }
    return false;
  }, []);

  const modal = target ? (
    <PeriodOverrideModal
      open
      onOpenChange={(open) => !open && setTarget(null)}
      company={target.company}
      ano={target.ano}
      mes={target.mes}
      onOverrideOpened={() => setTarget(null)}
    />
  ) : null;

  return { handle, modal };
}
```

- [ ] **Step 2: Plugar em uma mutação de exemplo (CR edit)**

Em `FinanceiroDashboard.tsx` ou onde existe `updateCR.mutateAsync`:

```tsx
import { usePeriodLockHandler } from '@/components/financeiro/PeriodLockGuard';

// no componente:
const lockHandler = usePeriodLockHandler();

// em qualquer mutationFn de CR/CP/orçamento/mapping:
try {
  await updateMutation.mutateAsync(input);
} catch (err) {
  if (!lockHandler.handle(err, { company })) {
    toast.error(`Erro: ${String((err as Error).message ?? err)}`);
  }
}

// no JSX raiz da página:
{lockHandler.modal}
```

- [ ] **Step 3: Build**

```bash
bun build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/financeiro/PeriodLockGuard.tsx src/pages/FinanceiroDashboard.tsx
git commit -m "feat(financeiro): PeriodLockGuard captura P0001 e abre modal"
```

### Task 2.10: Histórico de overrides no cockpit

**Files:**
- Create: `src/components/financeiro/PeriodOverrideHistory.tsx`
- Modify: `src/pages/FinanceiroCockpit.tsx`

- [ ] **Step 1: Criar componente**

```tsx
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';

type OverrideRow = {
  id: string;
  company: string;
  ano: number;
  mes: number;
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
  justificativa: string;
  acao_planejada: string;
};

export function PeriodOverrideHistory() {
  const { data, isLoading } = useQuery({
    queryKey: ['fin_period_overrides', 'history'],
    queryFn: async (): Promise<OverrideRow[]> => {
      const { data, error } = await supabase
        .from('fin_period_overrides')
        .select('*')
        .order('opened_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as OverrideRow[];
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlert className="h-4 w-4" /> Overrides recentes (30 dias)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Carregando…</div>}
        {!isLoading && data?.length === 0 && (
          <div className="text-sm text-muted-foreground">Nenhum override nos últimos 30 dias.</div>
        )}
        <ul className="space-y-3">
          {data?.map(o => {
            const isActive = !o.closed_at && new Date(o.expires_at) > new Date();
            return (
              <li key={o.id} className="rounded border p-2 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono">
                    {o.company} · {String(o.mes).padStart(2, '0')}/{o.ano}
                  </span>
                  <Badge variant={isActive ? 'destructive' : 'outline'}>
                    {isActive ? 'ativo' : 'expirado'}
                  </Badge>
                </div>
                <div className="text-muted-foreground tabular-nums">
                  {format(new Date(o.opened_at), 'dd/MM HH:mm')} → {format(new Date(o.expires_at), 'HH:mm')}
                </div>
                <div><strong>Por quê:</strong> {o.justificativa}</div>
                <div><strong>Ação:</strong> {o.acao_planejada}</div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Plugar no cockpit**

Em `src/pages/FinanceiroCockpit.tsx`, achar o grid de cards laterais e adicionar:

```tsx
import { PeriodOverrideHistory } from '@/components/financeiro/PeriodOverrideHistory';

// no grid:
<PeriodOverrideHistory />
```

- [ ] **Step 3: Build + smoke**

```bash
bun build && bun dev
```

Abrir `/financeiro/cockpit` — card visível.

- [ ] **Step 4: Commit**

```bash
git add src/components/financeiro/PeriodOverrideHistory.tsx src/pages/FinanceiroCockpit.tsx
git commit -m "feat(financeiro): PeriodOverrideHistory no cockpit"
```

### Task 2.11: Pipeline + marker fim de fase

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test
```

- [ ] **Step 2: Smoke manual**

- Tentar editar uma CR antiga de período fechado → toast vermelho + modal abre
- Abrir override (master) → badge no topbar com countdown
- Editar a mesma CR de novo → passa
- Auditar a mudança: tem `origem='override_emergencia'` + justificativa

- [ ] **Step 3: Commit marker**

```bash
git commit --allow-empty -m "ship(financeiro): [PR-READY: Phase 2] Travamento + Override"
```

---

## Phase 3: DRE por Competência

### Task 3.1: ALTER `fin_dre_snapshots` — unique inclui regime

**Files:**
- Create: `supabase/migrations/20260518002000_dre_unique_with_regime.sql`

- [ ] **Step 1: Criar migration**

```sql
-- O unique original era (company, ano, mes). Agora cada (regime) é uma linha distinta.
ALTER TABLE fin_dre_snapshots DROP CONSTRAINT IF EXISTS fin_dre_snapshots_company_ano_mes_key;
ALTER TABLE fin_dre_snapshots
  ADD CONSTRAINT fin_dre_snapshots_company_ano_mes_regime_key
  UNIQUE (company, ano, mes, regime);

-- Garantir que registros existentes têm regime explícito
UPDATE fin_dre_snapshots SET regime = 'caixa' WHERE regime IS NULL;
ALTER TABLE fin_dre_snapshots ALTER COLUMN regime SET NOT NULL;
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Validar**

```bash
bunx supabase db execute "
  SELECT conname FROM pg_constraint
   WHERE conrelid = 'fin_dre_snapshots'::regclass AND contype='u';
"
```

Expected: 1 linha `fin_dre_snapshots_company_ano_mes_regime_key`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518002000_dre_unique_with_regime.sql
git commit -m "feat(financeiro): unique (company,ano,mes,regime) em fin_dre_snapshots"
```

### Task 3.2: ALTER `fin_fechamentos` — FKs para snapshots por regime

**Files:**
- Create: `supabase/migrations/20260518002100_fechamento_dual_snapshots.sql`

- [ ] **Step 1: Criar migration**

```sql
ALTER TABLE fin_fechamentos
  ADD COLUMN IF NOT EXISTS snapshot_dre_caixa_id uuid REFERENCES fin_dre_snapshots(id),
  ADD COLUMN IF NOT EXISTS snapshot_dre_competencia_id uuid REFERENCES fin_dre_snapshots(id);

-- Backfill: linha existente snapshot_dre_id vira snapshot_dre_caixa_id
UPDATE fin_fechamentos
   SET snapshot_dre_caixa_id = snapshot_dre_id
 WHERE snapshot_dre_caixa_id IS NULL
   AND snapshot_dre_id IS NOT NULL;

COMMENT ON COLUMN fin_fechamentos.snapshot_dre_caixa_id IS
  'Snapshot DRE regime caixa congelado no momento do fechamento.';
COMMENT ON COLUMN fin_fechamentos.snapshot_dre_competencia_id IS
  'Snapshot DRE regime competência congelado. NULL para fechamentos pré-migration.';
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260518002100_fechamento_dual_snapshots.sql
git commit -m "feat(financeiro): colunas snapshot_dre_{caixa,competencia}_id em fechamentos"
```

### Task 3.3: Branch `calcular_dre_competencia` na edge `omie-financeiro`

**Files:**
- Modify: `supabase/functions/omie-financeiro/index.ts`

- [ ] **Step 1: Identificar função `calcularDRE` ou equivalente**

```bash
grep -n "calcular_dre\|calcularDRE\|calcular_dre_caixa" supabase/functions/omie-financeiro/index.ts | head -20
```

Reportar linha encontrada na implementação.

- [ ] **Step 2: Refatorar `calcularDRE` para aceitar `regime`**

Localizar a função que hoje calcula DRE (provavelmente agrupa por `data_recebimento`/`data_pagamento`). Mudar para aceitar parâmetro `regime: 'caixa' | 'competencia'` e usar a data correspondente.

Pseudocódigo da mudança:

```typescript
type Regime = 'caixa' | 'competencia';

async function calcularDRE(supabase, company: string, ano: number, mes: number, regime: Regime) {
  const dataCol = regime === 'caixa' ? 'data_recebimento' : 'data_emissao';
  const dataColCP = regime === 'caixa' ? 'data_pagamento' : 'data_emissao';
  const statusFilter = regime === 'caixa' ? "status_titulo IN ('RECEBIDO','PARCIAL','LIQUIDADO')" : "1=1";

  // Query existente, mas com dataCol/dataColCP/statusFilter parametrizados
  // ...

  // upsert por (company, ano, mes, regime)
  await supabase.from('fin_dre_snapshots').upsert({
    company, ano, mes, regime,
    // ...resto dos campos
  }, { onConflict: 'company,ano,mes,regime' });
}
```

- [ ] **Step 3: Rota `calcular_dre` chama ambos regimes**

Procurar o switch/case principal do handler e ajustar a rota `calcular_dre`:

```typescript
if (action === 'calcular_dre') {
  await calcularDRE(supabase, company, ano, mes, 'caixa');
  await calcularDRE(supabase, company, ano, mes, 'competencia');
  return jsonResponse({ ok: true, regimes_calculados: ['caixa', 'competencia'] });
}
```

- [ ] **Step 4: Deploy**

```bash
bunx supabase functions deploy omie-financeiro
```

- [ ] **Step 5: Smoke via UI `/financeiro/sync` → "Calcular DRE"**

Após rodar, validar:

```bash
bunx supabase db execute "
  SELECT regime, COUNT(*) FROM fin_dre_snapshots
   WHERE company='colacor' AND ano=2026 AND mes=4
   GROUP BY regime;
"
```

Expected: 2 linhas (caixa, competencia) com count=1.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/omie-financeiro/index.ts
git commit -m "feat(financeiro): calcular_dre roda regimes caixa e competência"
```

### Task 3.4: Atualizar `financeiroV2Service.fecharPeriodo` pra gravar ambos snapshots

**Files:**
- Modify: `src/services/financeiroV2Service.ts` (ou onde o fechamento é chamado)

- [ ] **Step 1: Localizar função de fechamento**

```bash
grep -n "fecharPeriodo\|snapshot_dre_id\|calcular_dre" src/services/financeiroV2Service.ts | head
```

- [ ] **Step 2: Atualizar pra aguardar cálculo e gravar ambos FKs**

Substituir o trecho que invoca o sync por:

```typescript
// Aguarda ambos regimes serem calculados
await invokeFinanceiroSync({ action: 'calcular_dre', company, ano, mes });

// Carrega os 2 snapshots criados
const { data: snaps } = await supabase
  .from('fin_dre_snapshots')
  .select('id, regime')
  .eq('company', company).eq('ano', ano).eq('mes', mes);

const caixaId = snaps?.find(s => s.regime === 'caixa')?.id;
const compId = snaps?.find(s => s.regime === 'competencia')?.id;

await supabase.from('fin_fechamentos').update({
  snapshot_dre_caixa_id: caixaId,
  snapshot_dre_competencia_id: compId,
  // resto dos campos do update existente
}).eq('id', fechamentoId);
```

- [ ] **Step 3: Build**

```bash
bun build
```

- [ ] **Step 4: Commit**

```bash
git add src/services/financeiroV2Service.ts
git commit -m "feat(financeiro): fecharPeriodo grava snapshots de caixa e competência"
```

### Task 3.5: Hook `useFinanceiroRegime` (toggle global)

**Files:**
- Create: `src/hooks/useFinanceiroRegime.ts`
- Test: `src/hooks/__tests__/useFinanceiroRegime.test.tsx`

- [ ] **Step 1: Teste**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFinanceiroRegime } from '../useFinanceiroRegime';

describe('useFinanceiroRegime', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to competencia', () => {
    const { result } = renderHook(() => useFinanceiroRegime());
    expect(result.current.regime).toBe('competencia');
  });

  it('persists to localStorage when changed', () => {
    const { result } = renderHook(() => useFinanceiroRegime());
    act(() => result.current.setRegime('caixa'));
    expect(result.current.regime).toBe('caixa');
    expect(localStorage.getItem('financeiroRegime')).toBe('caixa');
  });

  it('reads existing localStorage value', () => {
    localStorage.setItem('financeiroRegime', 'caixa');
    const { result } = renderHook(() => useFinanceiroRegime());
    expect(result.current.regime).toBe('caixa');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun test src/hooks/__tests__/useFinanceiroRegime.test.tsx
```

- [ ] **Step 3: Implementar**

```typescript
import { useEffect, useState, useCallback } from 'react';

export type DreRegime = 'caixa' | 'competencia';
const KEY = 'financeiroRegime';

const subscribers = new Set<() => void>();

function read(): DreRegime {
  if (typeof window === 'undefined') return 'competencia';
  const v = localStorage.getItem(KEY);
  return v === 'caixa' || v === 'competencia' ? v : 'competencia';
}

export function useFinanceiroRegime() {
  const [regime, setLocal] = useState<DreRegime>(read);

  useEffect(() => {
    const sync = () => setLocal(read());
    subscribers.add(sync);
    return () => { subscribers.delete(sync); };
  }, []);

  const setRegime = useCallback((next: DreRegime) => {
    localStorage.setItem(KEY, next);
    subscribers.forEach(s => s());
  }, []);

  return { regime, setRegime };
}
```

- [ ] **Step 4: Rodar teste**

```bash
bun test src/hooks/__tests__/useFinanceiroRegime.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useFinanceiroRegime.ts src/hooks/__tests__/useFinanceiroRegime.test.tsx
git commit -m "feat(financeiro): hook useFinanceiroRegime com persist + broadcast"
```

### Task 3.6: Componente `RegimeToggle`

**Files:**
- Create: `src/components/financeiro/RegimeToggle.tsx`

- [ ] **Step 1: Criar**

```tsx
import { useFinanceiroRegime } from '@/hooks/useFinanceiroRegime';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export function RegimeToggle() {
  const { regime, setRegime } = useFinanceiroRegime();
  return (
    <ToggleGroup
      type="single"
      value={regime}
      onValueChange={(v) => v === 'caixa' || v === 'competencia' ? setRegime(v) : null}
      className="h-8"
      size="sm"
      aria-label="Regime DRE"
    >
      <ToggleGroupItem value="caixa" aria-label="Caixa">Caixa</ToggleGroupItem>
      <ToggleGroupItem value="competencia" aria-label="Competência">Competência</ToggleGroupItem>
    </ToggleGroup>
  );
}
```

- [ ] **Step 2: Confirmar shadcn ToggleGroup existe**

```bash
ls src/components/ui/toggle-group.tsx
```

Se não existir:

```bash
bunx shadcn-ui@latest add toggle-group
```

- [ ] **Step 3: Build**

```bash
bun build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/financeiro/RegimeToggle.tsx src/components/ui/toggle-group.tsx 2>/dev/null
git commit -m "feat(financeiro): RegimeToggle componente"
```

### Task 3.7: Plugar `RegimeToggle` no Cockpit e Dashboard

**Files:**
- Modify: `src/pages/FinanceiroCockpit.tsx`
- Modify: `src/pages/FinanceiroDashboard.tsx`

- [ ] **Step 1: Importar e renderizar no header das duas telas**

```tsx
import { RegimeToggle } from '@/components/financeiro/RegimeToggle';

// no JSX do header da página (próximo ao título):
<div className="flex items-center gap-3">
  <h1 className="text-3xl font-display">Cockpit Financeiro</h1>
  <RegimeToggle />
</div>
```

- [ ] **Step 2: Substituir uso de `fin_dre_snapshots` pelo regime atual**

Procurar todas as queries que filtram `fin_dre_snapshots` e adicionar `eq('regime', regime)`:

```bash
grep -n "fin_dre_snapshots" src/pages/FinanceiroCockpit.tsx src/pages/FinanceiroDashboard.tsx src/services/*.ts
```

Pra cada match, adicionar filtro. Exemplo:

```tsx
const { regime } = useFinanceiroRegime();
const { data: dre } = useQuery({
  queryKey: ['fin_dre', company, ano, mes, regime],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('fin_dre_snapshots')
      .select('*')
      .eq('company', company).eq('ano', ano).eq('mes', mes)
      .eq('regime', regime)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
});
```

- [ ] **Step 3: Adicionar badge "Regime: X" perto dos cards DRE**

Em cada card DRE relevante:

```tsx
<Badge variant="outline" className="ml-2">
  Regime: {regime === 'caixa' ? 'Caixa' : 'Competência'}
</Badge>
```

- [ ] **Step 4: Labels contextuais**

Substituir labels hardcoded:

- "Recebimentos" → `regime === 'caixa' ? 'Recebimentos' : 'Faturamento'`
- "Pagamentos" → `regime === 'caixa' ? 'Pagamentos' : 'Despesas incorridas'`

- [ ] **Step 5: Build + smoke**

```bash
bun build && bun dev
```

Abrir cockpit, alternar toggle, ver DRE mudar e badge atualizar.

- [ ] **Step 6: Commit**

```bash
git add src/pages/FinanceiroCockpit.tsx src/pages/FinanceiroDashboard.tsx
git commit -m "feat(financeiro): RegimeToggle + filtro por regime em DRE cockpit/dashboard"
```

### Task 3.8: Backfill — calcular competência pros fechamentos retroativos

**Files:**
- Create: `scripts/financeiro/backfill-dre-competencia.ts`

- [ ] **Step 1: Criar script**

```typescript
// Uso: bun run scripts/financeiro/backfill-dre-competencia.ts
// Lê todos fin_fechamentos sem snapshot_dre_competencia_id e dispara o cálculo.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

async function main() {
  const { data: fechamentos, error } = await supabase
    .from('fin_fechamentos')
    .select('id, company, ano, mes')
    .is('snapshot_dre_competencia_id', null);
  if (error) throw error;

  console.log(`${fechamentos?.length ?? 0} fechamentos sem snapshot competência`);

  for (const f of fechamentos ?? []) {
    console.log(`Calculando ${f.company} ${f.ano}/${f.mes}…`);
    const { error: invErr } = await supabase.functions.invoke('omie-financeiro', {
      body: { action: 'calcular_dre', company: f.company, ano: f.ano, mes: f.mes },
    });
    if (invErr) { console.error('falhou', invErr); continue; }

    const { data: snap } = await supabase
      .from('fin_dre_snapshots')
      .select('id')
      .eq('company', f.company).eq('ano', f.ano).eq('mes', f.mes).eq('regime', 'competencia')
      .maybeSingle();
    if (snap?.id) {
      await supabase.from('fin_fechamentos').update({ snapshot_dre_competencia_id: snap.id }).eq('id', f.id);
      console.log('  → backfill OK');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Rodar (após Phase 3 estar feita)**

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/financeiro/backfill-dre-competencia.ts
```

Expected: lista N fechamentos, processa um a um, log "backfill OK" pra cada.

- [ ] **Step 3: Commit**

```bash
git add scripts/financeiro/backfill-dre-competencia.ts
git commit -m "chore(financeiro): script de backfill de DRE competência"
```

### Task 3.9: Pipeline + marker

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test
```

- [ ] **Step 2: Smoke**

- Cockpit: toggle entre regimes → DRE muda visivelmente; labels contextuais mudam
- Fechar período → 2 snapshots gravados (validar via DB)

- [ ] **Step 3: Marker**

```bash
git commit --allow-empty -m "ship(financeiro): [PR-READY: Phase 3] DRE por Competência"
```

---

## Phase 4: Gate de Categoria Não-Mapeada

### Task 4.1: Função e trigger `fin_check_mapping_complete_trigger()`

**Files:**
- Create: `supabase/migrations/20260518003000_fin_mapping_gate_trigger.sql`

- [ ] **Step 1: Criar migration**

```sql
CREATE OR REPLACE FUNCTION fin_check_mapping_complete_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pendentes jsonb;
  v_target_date date;
BEGIN
  -- só verifica na transição para aprovado (status='fechado' AND aprovado_em vira NOT NULL)
  IF (NEW.status <> 'fechado' OR NEW.aprovado_em IS NULL)
     OR (OLD.status = 'fechado' AND OLD.aprovado_em IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_target_date := make_date(NEW.ano, NEW.mes, 1);

  WITH categorias_periodo AS (
    SELECT DISTINCT categoria_codigo AS omie_codigo, categoria_descricao AS nome
      FROM fin_contas_receber
     WHERE company = NEW.company
       AND data_emissao >= v_target_date
       AND data_emissao < (v_target_date + interval '1 month')
       AND COALESCE(valor_documento, 0) > 0
       AND categoria_codigo IS NOT NULL
    UNION
    SELECT DISTINCT categoria_codigo, categoria_descricao
      FROM fin_contas_pagar
     WHERE company = NEW.company
       AND data_emissao >= v_target_date
       AND data_emissao < (v_target_date + interval '1 month')
       AND COALESCE(valor_documento, 0) > 0
       AND categoria_codigo IS NOT NULL
  ),
  pendentes AS (
    SELECT cp.omie_codigo, cp.nome
      FROM categorias_periodo cp
      LEFT JOIN fin_categoria_dre_mapping m
        ON (m.company = NEW.company OR m.company = '_default')
       AND m.omie_codigo = cp.omie_codigo
     WHERE m.id IS NULL
  )
  SELECT jsonb_agg(jsonb_build_object('id', omie_codigo, 'nome', nome))
    INTO v_pendentes FROM pendentes;

  IF v_pendentes IS NOT NULL AND jsonb_array_length(v_pendentes) > 0 THEN
    RAISE EXCEPTION 'MAPPING_INCOMPLETE: % categorias sem mapeamento DRE: %',
      jsonb_array_length(v_pendentes), v_pendentes::text
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mapping_gate ON fin_fechamentos;
CREATE TRIGGER trg_mapping_gate
  BEFORE UPDATE ON fin_fechamentos
  FOR EACH ROW EXECUTE FUNCTION fin_check_mapping_complete_trigger();

COMMENT ON FUNCTION fin_check_mapping_complete_trigger() IS
  'Bloqueia aprovação de fechamento (status=fechado E aprovado_em vira NOT NULL) se houver categoria sem mapping com valor>0.';
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Validar trigger existe**

```bash
bunx supabase db execute "SELECT trigger_name FROM information_schema.triggers WHERE event_object_table='fin_fechamentos'"
```

Expected: incluir `trg_mapping_gate` (e `trg_audit`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518003000_fin_mapping_gate_trigger.sql
git commit -m "feat(financeiro): gate de mapping completo no fechamento"
```

### Task 4.2: Edge function `fin-suggest-mapping`

**Files:**
- Create: `supabase/functions/fin-suggest-mapping/index.ts`

- [ ] **Step 1: Criar**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'cmv'
  | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'receitas_financeiras'
  | 'outras_receitas' | 'outras_despesas' | 'impostos';

type Suggestion = {
  omie_codigo: string;
  categoria_nome: string;
  valor_periodo: number;
  sugestao: { linha_dre: DreLinha | null; confianca: 'alta' | 'media' | 'baixa'; razao: string };
};

const KEYWORDS: Array<[RegExp, DreLinha]> = [
  [/honor|advog|contador|consultor/i, 'despesas_administrativas'],
  [/aluguel|condom[íi]nio|iptu/i, 'despesas_administrativas'],
  [/sal[áa]rio|folha|enc(argo|argos)|inss|fgts/i, 'despesas_administrativas'],
  [/marketing|propaganda|publicidade|google ads|facebook|meta ads/i, 'despesas_comerciais'],
  [/frete|transporte|combust[íi]vel|pedágio/i, 'despesas_comerciais'],
  [/juros|tarifa banc[áa]ria|iof/i, 'despesas_financeiras'],
  [/rendimento|aplica[çc][ãa]o/i, 'receitas_financeiras'],
  [/icms|pis|cofins|iss|irpj|csll|simples nacional/i, 'impostos'],
  [/cmv|mercador|insumo|mat[ée]ria.prima/i, 'cmv'],
];

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const company = url.searchParams.get('company');
  const ano = Number(url.searchParams.get('ano'));
  const mes = Number(url.searchParams.get('mes'));

  if (!company || !ano || !mes) {
    return new Response(JSON.stringify({ error: 'company, ano, mes obrigatórios' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const startDate = `${ano}-${String(mes).padStart(2,'0')}-01`;
  const endDate = new Date(ano, mes, 0).toISOString().slice(0, 10);

  // Categorias do período sem mapping
  const { data: pendentes, error: pendErr } = await supabase.rpc('fin_categorias_sem_mapping', {
    p_company: company, p_start: startDate, p_end: endDate,
  });
  if (pendErr) {
    return new Response(JSON.stringify({ error: pendErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Existing mappings de outras empresas pra heurística #1
  const { data: mappings } = await supabase
    .from('fin_categoria_dre_mapping')
    .select('company, omie_codigo, dre_linha');

  const byCodigo = new Map<string, { dre_linha: DreLinha; company: string }[]>();
  for (const m of (mappings ?? []) as Array<{ company: string; omie_codigo: string; dre_linha: DreLinha }>) {
    if (!byCodigo.has(m.omie_codigo)) byCodigo.set(m.omie_codigo, []);
    byCodigo.get(m.omie_codigo)!.push({ dre_linha: m.dre_linha, company: m.company });
  }

  const suggestions: Suggestion[] = ((pendentes ?? []) as Array<{
    omie_codigo: string; categoria_nome: string; valor_periodo: number;
  }>).map(p => {
    // #1 outra empresa mapeou esse omie_codigo?
    const matchesByCode = byCodigo.get(p.omie_codigo)?.filter(m => m.company !== company);
    if (matchesByCode && matchesByCode.length > 0) {
      const top = matchesByCode[0];
      return {
        ...p,
        sugestao: {
          linha_dre: top.dre_linha,
          confianca: 'alta',
          razao: `Empresa ${top.company} mapeou esta categoria como ${top.dre_linha}`,
        },
      };
    }

    // #3 heurística de keyword
    for (const [rx, linha] of KEYWORDS) {
      if (rx.test(p.categoria_nome)) {
        return {
          ...p,
          sugestao: { linha_dre: linha, confianca: 'baixa', razao: `Keyword '${rx.source}' sugere ${linha}` },
        };
      }
    }

    return {
      ...p,
      sugestao: { linha_dre: null, confianca: 'baixa', razao: 'Sem sugestão automática' },
    };
  });

  return new Response(JSON.stringify({ suggestions }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Criar RPC helper de query**

Criar `supabase/migrations/20260518003100_rpc_categorias_sem_mapping.sql`:

```sql
CREATE OR REPLACE FUNCTION public.fin_categorias_sem_mapping(
  p_company text, p_start date, p_end date
) RETURNS TABLE (omie_codigo text, categoria_nome text, valor_periodo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH cat AS (
    SELECT categoria_codigo AS omie_codigo,
           categoria_descricao AS categoria_nome,
           SUM(COALESCE(valor_documento,0)) AS valor
      FROM fin_contas_receber
     WHERE company = p_company AND data_emissao BETWEEN p_start AND p_end
       AND categoria_codigo IS NOT NULL
     GROUP BY 1, 2
    UNION ALL
    SELECT categoria_codigo, categoria_descricao, SUM(COALESCE(valor_documento,0))
      FROM fin_contas_pagar
     WHERE company = p_company AND data_emissao BETWEEN p_start AND p_end
       AND categoria_codigo IS NOT NULL
     GROUP BY 1, 2
  ), aggregated AS (
    SELECT omie_codigo, MAX(categoria_nome) AS categoria_nome, SUM(valor) AS valor_periodo
      FROM cat GROUP BY omie_codigo
  )
  SELECT a.omie_codigo, a.categoria_nome, a.valor_periodo
    FROM aggregated a
    LEFT JOIN fin_categoria_dre_mapping m
      ON (m.company = p_company OR m.company = '_default')
     AND m.omie_codigo = a.omie_codigo
   WHERE m.id IS NULL
     AND a.valor_periodo > 0
   ORDER BY a.valor_periodo DESC;
$$;

GRANT EXECUTE ON FUNCTION public.fin_categorias_sem_mapping(text, date, date)
  TO authenticated, service_role;
```

- [ ] **Step 3: Aplicar + deploy**

```bash
bunx supabase db push
bunx supabase functions deploy fin-suggest-mapping
```

- [ ] **Step 4: Smoke**

```bash
TOKEN="<JWT_staff>"
curl "${SUPABASE_URL}/functions/v1/fin-suggest-mapping?company=colacor&ano=2026&mes=4" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected: 200 com array `suggestions`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/fin-suggest-mapping/index.ts supabase/migrations/20260518003100_rpc_categorias_sem_mapping.sql
git commit -m "feat(financeiro): edge function fin-suggest-mapping + RPC helper"
```

### Task 4.3: Hook `useSuggestedMapping`

**Files:**
- Create: `src/hooks/useSuggestedMapping.ts`

- [ ] **Step 1: Criar**

```typescript
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type MappingSuggestion = {
  omie_codigo: string;
  categoria_nome: string;
  valor_periodo: number;
  sugestao: {
    linha_dre: string | null;
    confianca: 'alta' | 'media' | 'baixa';
    razao: string;
  };
};

export function useSuggestedMapping(company: string, ano: number, mes: number) {
  return useQuery({
    queryKey: ['fin_suggest_mapping', company, ano, mes],
    enabled: Boolean(company) && ano > 0 && mes > 0,
    queryFn: async (): Promise<MappingSuggestion[]> => {
      const { data, error } = await supabase.functions.invoke('fin-suggest-mapping', {
        body: null,
        method: 'GET',
        // Para edge fn com query string, usar URL absoluta via fetch:
      });
      if (error) throw error;
      return (data as { suggestions: MappingSuggestion[] }).suggestions;
    },
  });
}
```

> Nota: supabase-js não suporta GET com query string nativamente. Em vez disso, usar fetch direto:

```typescript
import { supabase } from '@/integrations/supabase/client';

export function useSuggestedMapping(company: string, ano: number, mes: number) {
  return useQuery({
    queryKey: ['fin_suggest_mapping', company, ano, mes],
    enabled: Boolean(company) && ano > 0 && mes > 0,
    queryFn: async (): Promise<MappingSuggestion[]> => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fin-suggest-mapping?company=${company}&ano=${ano}&mes=${mes}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json() as { suggestions: MappingSuggestion[] };
      return json.suggestions;
    },
  });
}
```

- [ ] **Step 2: Build**

```bash
bun build
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSuggestedMapping.ts
git commit -m "feat(financeiro): hook useSuggestedMapping"
```

### Task 4.4: Banner de categorias pendentes no `FinanceiroMapping`

**Files:**
- Modify: `src/pages/FinanceiroMapping.tsx`

- [ ] **Step 1: Adicionar banner + tabela de sugestões**

No topo do componente, abaixo do header:

```tsx
import { useSuggestedMapping } from '@/hooks/useSuggestedMapping';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';

// estado de período-alvo
const now = new Date();
const [targetAno] = useState(now.getFullYear());
const [targetMes] = useState(now.getMonth() + 1);

const { data: suggestions = [] } = useSuggestedMapping(company, targetAno, targetMes);

// ...no JSX:
{suggestions.length > 0 && (
  <Alert variant="default" className="border-status-warning bg-status-warning-bg">
    <AlertTriangle className="h-4 w-4" />
    <AlertTitle>{suggestions.length} categorias sem mapeamento</AlertTitle>
    <AlertDescription>
      Afetam R$ {suggestions.reduce((s, x) => s + Number(x.valor_periodo), 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} no período {String(targetMes).padStart(2,'0')}/{targetAno}.
      <Button
        variant="link" className="ml-2 h-auto p-0"
        onClick={() => document.getElementById('suggestions-table')?.scrollIntoView()}
      >
        Ver sugestões →
      </Button>
    </AlertDescription>
  </Alert>
)}

{suggestions.length > 0 && (
  <Card id="suggestions-table" className="mt-4">
    <CardHeader>
      <CardTitle>Sugestões automáticas</CardTitle>
    </CardHeader>
    <CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Categoria</TableHead>
            <TableHead>Valor no período</TableHead>
            <TableHead>Sugestão</TableHead>
            <TableHead>Confiança</TableHead>
            <TableHead>Ação</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {suggestions.map(s => (
            <TableRow key={s.omie_codigo}>
              <TableCell className="font-mono text-xs">{s.omie_codigo} — {s.categoria_nome}</TableCell>
              <TableCell className="tabular-nums">R$ {Number(s.valor_periodo).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</TableCell>
              <TableCell>{s.sugestao.linha_dre ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell>
                <Badge variant={s.sugestao.confianca === 'alta' ? 'default' : 'outline'}>
                  {s.sugestao.confianca}
                </Badge>
              </TableCell>
              <TableCell>
                {s.sugestao.linha_dre && (
                  <Button
                    size="sm" variant="outline"
                    onClick={() => aplicarSugestao(s.omie_codigo, s.sugestao.linha_dre!)}
                  >
                    Aplicar
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button
        className="mt-3"
        onClick={() => aplicarTodasAltaConfianca()}
        disabled={!suggestions.some(s => s.sugestao.confianca === 'alta')}
      >
        Aplicar todas de alta confiança
      </Button>
    </CardContent>
  </Card>
)}
```

Adicionar `aplicarSugestao` e `aplicarTodasAltaConfianca`:

```tsx
const qc = useQueryClient();

const aplicarSugestao = async (omie_codigo: string, dre_linha: string) => {
  const { error } = await supabase.from('fin_categoria_dre_mapping').insert({
    company, omie_codigo, dre_linha,
  });
  if (error) {
    toast.error(`Falha ao aplicar: ${error.message}`);
  } else {
    toast.success(`Mapping aplicado: ${omie_codigo} → ${dre_linha}`);
    qc.invalidateQueries({ queryKey: ['fin_suggest_mapping'] });
    qc.invalidateQueries({ queryKey: ['fin_categoria_dre_mapping'] });
  }
};

const aplicarTodasAltaConfianca = async () => {
  const alta = suggestions.filter(s => s.sugestao.confianca === 'alta' && s.sugestao.linha_dre);
  if (alta.length === 0) return;
  const { error } = await supabase.from('fin_categoria_dre_mapping').insert(
    alta.map(s => ({ company, omie_codigo: s.omie_codigo, dre_linha: s.sugestao.linha_dre! }))
  );
  if (error) {
    toast.error(`Falha em bulk: ${error.message}`);
  } else {
    toast.success(`${alta.length} mappings aplicados`);
    qc.invalidateQueries({ queryKey: ['fin_suggest_mapping'] });
    qc.invalidateQueries({ queryKey: ['fin_categoria_dre_mapping'] });
  }
};
```

- [ ] **Step 2: Build + smoke**

```bash
bun build && bun dev
```

Abrir `/financeiro/mapping`, ver banner + tabela se houver pendências.

- [ ] **Step 3: Commit**

```bash
git add src/pages/FinanceiroMapping.tsx
git commit -m "feat(financeiro): banner + sugestões automáticas no Mapping"
```

### Task 4.5: Bloqueio na aprovação do `FinanceiroFechamento`

**Files:**
- Modify: `src/pages/FinanceiroFechamento.tsx`
- Use: `src/lib/financeiro/error-handler.ts` (Phase 0)

- [ ] **Step 1: Capturar P0002 na chamada de aprovar**

Procurar a função que aprova fechamento (provavelmente `aprovarFechamento` ou similar). Envelopar:

```tsx
import { parsePostgresFinanceiroError } from '@/lib/financeiro/error-handler';
import { useNavigate } from 'react-router-dom';

const navigate = useNavigate();
const [mappingPendentes, setMappingPendentes] = useState<Array<{id: string; nome: string}>>([]);

const aprovar = async (fech) => {
  try {
    await aprovarMutation.mutateAsync(fech);
    toast.success('Fechamento aprovado');
  } catch (err) {
    const parsed = parsePostgresFinanceiroError(err);
    if (parsed.kind === 'mapping_incomplete') {
      setMappingPendentes(parsed.pendentes);
    } else {
      toast.error(`Falha: ${String((err as Error).message ?? err)}`);
    }
  }
};
```

- [ ] **Step 2: Modal listando pendentes**

```tsx
<Dialog open={mappingPendentes.length > 0} onOpenChange={(o) => !o && setMappingPendentes([])}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Não foi possível aprovar</DialogTitle>
      <DialogDescription>
        {mappingPendentes.length} categorias do período não têm mapeamento DRE. Resolva no Mapeamento antes de aprovar.
      </DialogDescription>
    </DialogHeader>
    <ul className="max-h-64 overflow-y-auto text-sm space-y-1">
      {mappingPendentes.map(p => (
        <li key={p.id} className="font-mono text-xs">{p.id} — {p.nome}</li>
      ))}
    </ul>
    <DialogFooter>
      <Button variant="ghost" onClick={() => setMappingPendentes([])}>Cancelar</Button>
      <Button onClick={() => navigate('/financeiro/mapping')}>Ir para Mapeamento</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 3: Build + smoke**

```bash
bun build && bun dev
```

Tentar aprovar fechamento com categoria pendente → modal abre com lista.

- [ ] **Step 4: Commit**

```bash
git add src/pages/FinanceiroFechamento.tsx
git commit -m "feat(financeiro): bloqueio de aprovação com modal de pendências"
```

### Task 4.6: Pipeline + marker

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test
```

- [ ] **Step 2: Smoke**

- Criar categoria nova (via Omie ou manual) sem mapeamento → aparece no banner
- Tentar aprovar fechamento → bloqueado com lista
- Aplicar bulk de alta confiança → mappings criados → aprovação passa

- [ ] **Step 3: Marker**

```bash
git commit --allow-empty -m "ship(financeiro): [PR-READY: Phase 4] Gate de Mapping"
```

---

## Phase 5: Reconciliação Intercompany Cruzada

### Task 5.1: Migration `fin_ic_matches`

**Files:**
- Create: `supabase/migrations/20260518004000_fin_ic_matches.sql`

- [ ] **Step 1: Criar tabela + índices + RLS**

```sql
CREATE TABLE IF NOT EXISTS fin_ic_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_origem  text NOT NULL CHECK (empresa_origem IN ('oben','colacor','colacor_sc')),
  empresa_destino text NOT NULL CHECK (empresa_destino IN ('oben','colacor','colacor_sc')),
  cr_id           uuid REFERENCES fin_contas_receber(id) ON DELETE SET NULL,
  cp_id           uuid REFERENCES fin_contas_pagar(id) ON DELETE SET NULL,
  valor_origem    numeric(15,2),
  valor_destino   numeric(15,2),
  diff_valor      numeric(15,2) GENERATED ALWAYS AS (COALESCE(valor_origem,0) - COALESCE(valor_destino,0)) STORED,
  diff_dias       integer,
  status          text NOT NULL CHECK (status IN (
    'auto_matched','manual_matched',
    'divergencia_valor','divergencia_data',
    'sem_contrapartida','duplicidade_possivel',
    'desconsiderado'
  )),
  matched_at      timestamptz NOT NULL DEFAULT now(),
  resolvido_por   uuid REFERENCES auth.users(id),
  resolvido_em    timestamptz,
  observacao      text,
  CHECK (empresa_origem <> empresa_destino),
  CHECK (cr_id IS NOT NULL OR cp_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fin_ic_matches_status_idx ON fin_ic_matches (status, matched_at DESC);
CREATE INDEX IF NOT EXISTS fin_ic_matches_cr_idx ON fin_ic_matches (cr_id) WHERE cr_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_ic_matches_cp_idx ON fin_ic_matches (cp_id) WHERE cp_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_ic_matches_cr_unique ON fin_ic_matches (cr_id) WHERE cr_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_ic_matches_cp_unique ON fin_ic_matches (cp_id) WHERE cp_id IS NOT NULL;

ALTER TABLE fin_ic_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_ic_matches_select_staff ON fin_ic_matches
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('employee','master'))
  );

CREATE POLICY fin_ic_matches_update_staff ON fin_ic_matches
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role IN ('employee','master'))
  );
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260518004000_fin_ic_matches.sql
git commit -m "feat(financeiro): tabela fin_ic_matches + RLS"
```

### Task 5.2: Tabela de CNPJs das empresas do grupo

**Files:**
- Create: `supabase/migrations/20260518004100_company_cnpjs.sql`

- [ ] **Step 1: Criar tabela mapeando empresa → CNPJs**

```sql
CREATE TABLE IF NOT EXISTS company_cnpjs (
  company text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  cnpj    text NOT NULL,
  cnpj_normalized text GENERATED ALWAYS AS (regexp_replace(cnpj, '[^0-9]', '', 'g')) STORED,
  nome_fantasia text,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_cnpjs_normalized_idx ON company_cnpjs (cnpj_normalized);

ALTER TABLE company_cnpjs ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_cnpjs_select_authenticated ON company_cnpjs FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY company_cnpjs_master_write ON company_cnpjs FOR ALL
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='master'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_roles WHERE user_id=auth.uid() AND role='master'));

COMMENT ON TABLE company_cnpjs IS 'CNPJs das empresas do grupo, usado por fin-ic-reconcile pra cruzar IC.';
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Inserir CNPJs reais (ação do dono)**

```bash
bunx supabase db execute "
  -- Substituir XX.XXX.XXX/XXXX-XX pelos CNPJs reais
  INSERT INTO company_cnpjs (company, cnpj, nome_fantasia) VALUES
    ('colacor',    '00.000.000/0000-00', 'Colacor Indústria'),
    ('oben',       '00.000.000/0000-00', 'Oben Comercial'),
    ('colacor_sc', '00.000.000/0000-00', 'Colacor SC')
  ON CONFLICT (company) DO UPDATE SET cnpj=EXCLUDED.cnpj, nome_fantasia=EXCLUDED.nome_fantasia, updated_at=now();
"
```

> Pausa: o dono precisa preencher os CNPJs reais antes do reconcile rodar. Sem isso, função retorna 0 matches (não quebra).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518004100_company_cnpjs.sql
git commit -m "feat(financeiro): tabela company_cnpjs pra reconciliação IC"
```

### Task 5.3: Edge function `fin-ic-reconcile`

**Files:**
- Create: `supabase/functions/fin-ic-reconcile/index.ts`

- [ ] **Step 1: Criar**

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VALOR_TOLERANCIA = 0.01;
const DATA_TOLERANCIA_DIAS = 5;

type CR = {
  id: string; company: string; cnpj_cpf: string | null;
  valor_documento: number; data_emissao: string | null;
};
type CP = {
  id: string; company: string; cnpj_cpf: string | null;
  valor_documento: number; data_emissao: string | null;
};

function normalizeCnpj(s: string | null): string {
  return (s ?? '').replace(/[^0-9]/g, '');
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000));
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1. CNPJs do grupo
  const { data: cnpjs } = await supabase.from('company_cnpjs').select('company, cnpj_normalized');
  if (!cnpjs || cnpjs.length === 0) {
    return new Response(JSON.stringify({ ok: true, msg: 'sem CNPJs configurados', matches: 0 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const cnpjToCompany = new Map<string, string>();
  for (const c of cnpjs as Array<{company:string;cnpj_normalized:string}>) {
    cnpjToCompany.set(c.cnpj_normalized, c.company);
  }
  const groupCnpjs = Array.from(cnpjToCompany.keys());

  // 2. CR com cnpj do grupo (cliente é uma das outras empresas)
  const { data: crsRaw } = await supabase
    .from('fin_contas_receber')
    .select('id, company, cnpj_cpf, valor_documento, data_emissao');
  const crs = (crsRaw ?? []) as CR[];
  const crsIC = crs.filter(c => groupCnpjs.includes(normalizeCnpj(c.cnpj_cpf)));

  // 3. CP com cnpj do grupo (fornecedor é uma das outras empresas)
  const { data: cpsRaw } = await supabase
    .from('fin_contas_pagar')
    .select('id, company, cnpj_cpf, valor_documento, data_emissao');
  const cps = (cpsRaw ?? []) as CP[];
  const cpsIC = cps.filter(p => groupCnpjs.includes(normalizeCnpj(p.cnpj_cpf)));

  // Bucket CP por (company_origem do CR + CNPJ destino) pra match O(1)
  type CPKey = string;
  const cpsByKey = new Map<CPKey, CP[]>();
  for (const cp of cpsIC) {
    const empresaDestino = cnpjToCompany.get(normalizeCnpj(cp.cnpj_cpf));  // empresa do fornecedor = origem
    if (!empresaDestino) continue;
    const key = `${empresaDestino}:${cp.company}`;  // origem da venda : destino (que é a empresa do CP)
    if (!cpsByKey.has(key)) cpsByKey.set(key, []);
    cpsByKey.get(key)!.push(cp);
  }

  const upserts: Array<Record<string, unknown>> = [];

  for (const cr of crsIC) {
    const empresaDestino = cnpjToCompany.get(normalizeCnpj(cr.cnpj_cpf));
    if (!empresaDestino) continue;
    const key = `${cr.company}:${empresaDestino}`;
    const candidates = cpsByKey.get(key) ?? [];

    const exact = candidates.filter(cp =>
      Math.abs(cp.valor_documento - cr.valor_documento) <= VALOR_TOLERANCIA
      && cr.data_emissao && cp.data_emissao
      && daysBetween(cr.data_emissao, cp.data_emissao) <= DATA_TOLERANCIA_DIAS
    );

    if (exact.length === 1) {
      upserts.push({
        empresa_origem: cr.company, empresa_destino: empresaDestino,
        cr_id: cr.id, cp_id: exact[0].id,
        valor_origem: cr.valor_documento, valor_destino: exact[0].valor_documento,
        diff_dias: cr.data_emissao && exact[0].data_emissao ? daysBetween(cr.data_emissao, exact[0].data_emissao) : null,
        status: 'auto_matched',
      });
    } else if (exact.length > 1) {
      upserts.push({
        empresa_origem: cr.company, empresa_destino: empresaDestino,
        cr_id: cr.id, valor_origem: cr.valor_documento, status: 'duplicidade_possivel',
        observacao: `${exact.length} CPs candidatos`,
      });
    } else {
      // tenta diff de valor (5%) com data ok
      const looseValor = candidates.filter(cp =>
        Math.abs(cp.valor_documento - cr.valor_documento) / cr.valor_documento <= 0.05
        && cr.data_emissao && cp.data_emissao
        && daysBetween(cr.data_emissao, cp.data_emissao) <= DATA_TOLERANCIA_DIAS
      );
      if (looseValor.length === 1) {
        upserts.push({
          empresa_origem: cr.company, empresa_destino: empresaDestino,
          cr_id: cr.id, cp_id: looseValor[0].id,
          valor_origem: cr.valor_documento, valor_destino: looseValor[0].valor_documento,
          diff_dias: cr.data_emissao && looseValor[0].data_emissao ? daysBetween(cr.data_emissao, looseValor[0].data_emissao) : null,
          status: 'divergencia_valor',
        });
        continue;
      }
      // tenta diff de data 6-30d com valor exato
      const looseData = candidates.filter(cp =>
        Math.abs(cp.valor_documento - cr.valor_documento) <= VALOR_TOLERANCIA
        && cr.data_emissao && cp.data_emissao
        && daysBetween(cr.data_emissao, cp.data_emissao) > DATA_TOLERANCIA_DIAS
        && daysBetween(cr.data_emissao, cp.data_emissao) <= 30
      );
      if (looseData.length === 1) {
        upserts.push({
          empresa_origem: cr.company, empresa_destino: empresaDestino,
          cr_id: cr.id, cp_id: looseData[0].id,
          valor_origem: cr.valor_documento, valor_destino: looseData[0].valor_documento,
          diff_dias: cr.data_emissao && looseData[0].data_emissao ? daysBetween(cr.data_emissao, looseData[0].data_emissao) : null,
          status: 'divergencia_data',
        });
        continue;
      }
      upserts.push({
        empresa_origem: cr.company, empresa_destino: empresaDestino,
        cr_id: cr.id, valor_origem: cr.valor_documento, status: 'sem_contrapartida',
      });
    }
  }

  // CPs sem contrapartida CR (não foram referenciados em nenhum upsert)
  const usedCpIds = new Set(upserts.map(u => u.cp_id).filter(Boolean));
  for (const cp of cpsIC) {
    if (usedCpIds.has(cp.id)) continue;
    const empresaOrigem = cnpjToCompany.get(normalizeCnpj(cp.cnpj_cpf));
    if (!empresaOrigem) continue;
    upserts.push({
      empresa_origem: empresaOrigem, empresa_destino: cp.company,
      cp_id: cp.id, valor_destino: cp.valor_documento, status: 'sem_contrapartida',
    });
  }

  // Upsert idempotente: chave é (cr_id) ou (cp_id) unique
  // Usamos delete-then-insert por simplicidade (idempotência sobre status auto_matched/sem_contrapartida)
  // Mantemos manual_matched/desconsiderado intocados (não sobrescreve resolução humana)
  await supabase.from('fin_ic_matches')
    .delete()
    .in('status', ['auto_matched','divergencia_valor','divergencia_data','sem_contrapartida','duplicidade_possivel']);

  if (upserts.length > 0) {
    const { error: insErr } = await supabase.from('fin_ic_matches').insert(upserts);
    if (insErr) {
      return new Response(JSON.stringify({ error: insErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, total_matches: upserts.length }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
```

- [ ] **Step 2: Deploy**

```bash
bunx supabase functions deploy fin-ic-reconcile
```

- [ ] **Step 3: Cron schedule**

Criar `supabase/migrations/20260518004200_fin_ic_cron.sql`:

```sql
-- Agendar reconcile diário às 6h
SELECT cron.schedule(
  'fin-ic-reconcile-diario',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/fin-ic-reconcile',
    headers := jsonb_build_object('x-cron-secret', current_setting('app.settings.cron_secret'))
  )
  $$
);
```

> Pré-requisito: GUCs `app.settings.supabase_url` e `app.settings.cron_secret` devem estar setados na instância (já padrão se outros crons rodam). Validar:

```bash
bunx supabase db execute "SELECT current_setting('app.settings.cron_secret', true)"
```

Se vazio, setar via `ALTER DATABASE ... SET app.settings.cron_secret = '...'` ou painel Supabase.

- [ ] **Step 4: Aplicar migration de cron**

```bash
bunx supabase db push
```

- [ ] **Step 5: Smoke on-demand**

```bash
TOKEN="<JWT_staff>"
curl -X POST "${SUPABASE_URL}/functions/v1/fin-ic-reconcile" \
  -H "Authorization: Bearer ${TOKEN}"
```

Expected: `{ ok: true, total_matches: N }`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/fin-ic-reconcile/index.ts supabase/migrations/20260518004200_fin_ic_cron.sql
git commit -m "feat(financeiro): fin-ic-reconcile edge fn + cron diário"
```

### Task 5.4: Refatorar RPC `fin_consolidado_intercompany` pra usar `fin_ic_matches`

**Files:**
- Create: `supabase/migrations/20260518004300_fin_consolidado_v2.sql`

- [ ] **Step 1: Identificar definição atual**

```bash
grep -rn "fin_consolidado_intercompany" supabase/migrations/ | head
```

- [ ] **Step 2: Substituir corpo da função**

```sql
CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(
  p_ano integer, p_mes integer
) RETURNS TABLE (
  conta text,
  total_bruto numeric,
  eliminacoes numeric,
  total_consolidado numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH dre_all AS (
    SELECT 'receita_bruta'::text AS conta, COALESCE(SUM(receita_bruta),0) AS total
      FROM fin_dre_snapshots WHERE ano=p_ano AND mes=p_mes AND regime='competencia'
    UNION ALL
    SELECT 'cmv', COALESCE(SUM(cmv),0) FROM fin_dre_snapshots WHERE ano=p_ano AND mes=p_mes AND regime='competencia'
    UNION ALL
    SELECT 'despesas_operacionais', COALESCE(SUM(despesas_operacionais),0) FROM fin_dre_snapshots WHERE ano=p_ano AND mes=p_mes AND regime='competencia'
    UNION ALL
    SELECT 'resultado_liquido', COALESCE(SUM(resultado_liquido),0) FROM fin_dre_snapshots WHERE ano=p_ano AND mes=p_mes AND regime='competencia'
  ),
  ic_elim AS (
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('auto_matched','manual_matched') THEN valor_origem ELSE 0 END), 0) AS valor_elim
    FROM fin_ic_matches m
    JOIN fin_contas_receber cr ON cr.id = m.cr_id
    WHERE EXTRACT(YEAR FROM cr.data_emissao)=p_ano
      AND EXTRACT(MONTH FROM cr.data_emissao)=p_mes
  )
  SELECT
    d.conta,
    d.total AS total_bruto,
    CASE
      WHEN d.conta='receita_bruta' THEN -(SELECT valor_elim FROM ic_elim)
      WHEN d.conta='cmv' THEN (SELECT valor_elim FROM ic_elim)
      ELSE 0
    END AS eliminacoes,
    d.total +
      CASE
        WHEN d.conta='receita_bruta' THEN -(SELECT valor_elim FROM ic_elim)
        WHEN d.conta='cmv' THEN (SELECT valor_elim FROM ic_elim)
        ELSE 0
      END AS total_consolidado
  FROM dre_all d;
$$;

GRANT EXECUTE ON FUNCTION public.fin_consolidado_intercompany(integer, integer) TO authenticated;
```

- [ ] **Step 2: Aplicar**

```bash
bunx supabase db push
```

- [ ] **Step 3: Smoke**

```bash
bunx supabase db execute "SELECT * FROM fin_consolidado_intercompany(2026, 4)"
```

Expected: 4 linhas (receita_bruta, cmv, despesas_operacionais, resultado_liquido) com eliminacoes preenchidas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260518004300_fin_consolidado_v2.sql
git commit -m "feat(financeiro): fin_consolidado_intercompany usa fin_ic_matches"
```

### Task 5.5: Hook `useIcMatches`

**Files:**
- Create: `src/hooks/useIcMatches.ts`

- [ ] **Step 1: Criar**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type IcMatch = {
  id: string;
  empresa_origem: string;
  empresa_destino: string;
  cr_id: string | null;
  cp_id: string | null;
  valor_origem: number | null;
  valor_destino: number | null;
  diff_valor: number;
  diff_dias: number | null;
  status:
    | 'auto_matched' | 'manual_matched'
    | 'divergencia_valor' | 'divergencia_data'
    | 'sem_contrapartida' | 'duplicidade_possivel' | 'desconsiderado';
  matched_at: string;
  observacao: string | null;
};

export function useIcMatches(filterStatus?: IcMatch['status']) {
  return useQuery({
    queryKey: ['fin_ic_matches', filterStatus ?? 'all'],
    queryFn: async (): Promise<IcMatch[]> => {
      let q = supabase.from('fin_ic_matches').select('*').order('matched_at', { ascending: false }).limit(500);
      if (filterStatus) q = q.eq('status', filterStatus);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as IcMatch[];
    },
  });
}

export function useResolveIcMatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; status: IcMatch['status']; observacao?: string }) => {
      const { error } = await supabase
        .from('fin_ic_matches')
        .update({
          status: input.status,
          observacao: input.observacao ?? null,
          resolvido_por: (await supabase.auth.getUser()).data.user?.id,
          resolvido_em: new Date().toISOString(),
        })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_ic_matches'] }),
  });
}

export function useReconcileIcNow() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('fin-ic-reconcile', { body: {} });
      if (error) throw error;
      return data;
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useIcMatches.ts
git commit -m "feat(financeiro): hooks de IC matches + resolve + reconcile"
```

### Task 5.6: Página `FinanceiroIntercompanyFila`

**Files:**
- Create: `src/pages/FinanceiroIntercompanyFila.tsx`
- Modify: `src/App.tsx` (adicionar rota lazy)

- [ ] **Step 1: Criar página**

```tsx
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useIcMatches, useResolveIcMatch, useReconcileIcNow, type IcMatch } from '@/hooks/useIcMatches';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';

const STATUS_LABELS: Record<IcMatch['status'], string> = {
  auto_matched: 'Auto',
  manual_matched: 'Manual',
  divergencia_valor: 'Diff valor',
  divergencia_data: 'Diff data',
  sem_contrapartida: 'Sem par',
  duplicidade_possivel: 'Duplicidade',
  desconsiderado: 'Ignorado',
};

const STATUS_VARIANT: Record<IcMatch['status'], 'default'|'secondary'|'destructive'|'outline'> = {
  auto_matched: 'default', manual_matched: 'default',
  divergencia_valor: 'destructive', divergencia_data: 'destructive',
  sem_contrapartida: 'destructive', duplicidade_possivel: 'destructive',
  desconsiderado: 'outline',
};

export default function FinanceiroIntercompanyFila() {
  const [tab, setTab] = useState<IcMatch['status'] | 'all'>('divergencia_valor');
  const { data, isLoading } = useIcMatches(tab === 'all' ? undefined : tab);
  const resolve = useResolveIcMatch();
  const reconcile = useReconcileIcNow();

  const handleReconcile = async () => {
    try {
      const r = await reconcile.mutateAsync();
      toast.success(`Reconciliado: ${(r as any).total_matches} matches`);
    } catch (err) {
      toast.error(`Falha: ${String((err as Error).message ?? err)}`);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-display">Fila de Reconciliação IC</h1>
        <Button onClick={handleReconcile} disabled={reconcile.isPending} size="sm" variant="outline">
          <RefreshCw className="mr-2 h-4 w-4" />
          {reconcile.isPending ? 'Reconciliando…' : 'Reconciliar agora'}
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as IcMatch['status'] | 'all')}>
        <TabsList>
          <TabsTrigger value="divergencia_valor">Diff valor</TabsTrigger>
          <TabsTrigger value="divergencia_data">Diff data</TabsTrigger>
          <TabsTrigger value="sem_contrapartida">Sem par</TabsTrigger>
          <TabsTrigger value="duplicidade_possivel">Duplicidade</TabsTrigger>
          <TabsTrigger value="auto_matched">OK</TabsTrigger>
          <TabsTrigger value="all">Tudo</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{data?.length ?? 0} registros</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && <div className="text-sm text-muted-foreground">Carregando…</div>}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Origem → Destino</TableHead>
                    <TableHead>Valor origem</TableHead>
                    <TableHead>Valor destino</TableHead>
                    <TableHead>Diff</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data ?? []).map(m => (
                    <TableRow key={m.id}>
                      <TableCell className="font-mono text-xs">{m.empresa_origem} → {m.empresa_destino}</TableCell>
                      <TableCell className="tabular-nums">{m.valor_origem?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">{m.valor_destino?.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">{m.diff_valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</TableCell>
                      <TableCell><Badge variant={STATUS_VARIANT[m.status]}>{STATUS_LABELS[m.status]}</Badge></TableCell>
                      <TableCell className="space-x-1">
                        {m.status !== 'manual_matched' && m.status !== 'desconsiderado' && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: m.id, status: 'manual_matched' })}>Aprovar</Button>
                            <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: m.id, status: 'desconsiderado' })}>Ignorar</Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: Registrar rota em `App.tsx`**

```tsx
// adicionar lazy import
const FinanceiroIntercompanyFila = lazy(() => import('@/pages/FinanceiroIntercompanyFila'));

// dentro do <Routes>:
<Route path="/financeiro/intercompany/fila" element={<FinanceiroIntercompanyFila />} />
```

- [ ] **Step 3: Link na `FinanceiroIntercompany`**

Em `src/pages/FinanceiroIntercompany.tsx`, adicionar badge + link:

```tsx
import { useIcMatches } from '@/hooks/useIcMatches';
import { Link } from 'react-router-dom';

const { data: divergencias } = useIcMatches('divergencia_valor');
const { data: semPar } = useIcMatches('sem_contrapartida');
const totalPendentes = (divergencias?.length ?? 0) + (semPar?.length ?? 0);

// no header da página:
{totalPendentes > 0 && (
  <Link to="/financeiro/intercompany/fila">
    <Badge variant="destructive">{totalPendentes} pendências IC</Badge>
  </Link>
)}
```

- [ ] **Step 4: Build + smoke**

```bash
bun build && bun dev
```

Abrir `/financeiro/intercompany/fila`, validar tabs e ações.

- [ ] **Step 5: Commit**

```bash
git add src/pages/FinanceiroIntercompanyFila.tsx src/App.tsx src/pages/FinanceiroIntercompany.tsx
git commit -m "feat(financeiro): página de fila IC + link"
```

### Task 5.7: Aviso de IC pendente em `FinanceiroFechamento`

**Files:**
- Modify: `src/pages/FinanceiroFechamento.tsx`

- [ ] **Step 1: Adicionar aviso quando há divergência IC no período**

```tsx
import { useIcMatches } from '@/hooks/useIcMatches';
import { AlertTriangle } from 'lucide-react';

const { data: ic } = useIcMatches('divergencia_valor');
const icSem = useIcMatches('sem_contrapartida');
const totalIc = (ic?.length ?? 0) + (icSem.data?.length ?? 0);

// no JSX do header de cada fechamento:
{totalIc > 0 && (
  <div className="flex items-center gap-2 text-xs text-status-warning">
    <AlertTriangle className="h-3 w-3" />
    {totalIc} pendências IC — <Link to="/financeiro/intercompany/fila" className="underline">resolver</Link>
  </div>
)}
```

- [ ] **Step 2: Build**

```bash
bun build
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/FinanceiroFechamento.tsx
git commit -m "feat(financeiro): aviso de IC pendente no Fechamento"
```

### Task 5.8: Pipeline + marker fim de fase

- [ ] **Step 1: Pipeline**

```bash
bun lint && bun build && bun test
```

- [ ] **Step 2: Smoke**

- Configurar CNPJs reais via SQL (Task 5.2 step 3)
- Rodar `fin-ic-reconcile` on-demand (botão na fila)
- Ver fila populada
- Aprovar uma divergência → status muda
- Recalcular consolidado → vê eliminação

- [ ] **Step 3: Marker final**

```bash
git commit --allow-empty -m "ship(financeiro): [PR-READY: Phase 5] IC Reconciliação"
```

---

## Phase 6: Documentação e Encerramento

### Task 6.1: Atualizar `FINANCEIRO_CONFIABILIDADE.md`

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md`

- [ ] **Step 1: Mover itens de "❌ Não Implementado" pra "✅ MVP Operacional"**

Itens a migrar:
- **DRE por Competência** → ✅ MVP (com toggle no cockpit)
- **Trilha de auditoria** → ✅ MVP (genérica, drawer por linha)
- **Travamento de período fechado** → ✅ MVP (hard block + override 15 min)
- **Eliminação intercompany por par cruzado** → ✅ MVP (fila de divergências)
- **Bloqueio de fechamento por categoria não-mapeada** → ✅ MVP

- [ ] **Step 2: Adicionar seção "Configurações Necessárias"**

```markdown
## Configurações Necessárias (one-time)

1. CNPJs das 3 empresas em `company_cnpjs` — sem isso, IC reconcile retorna 0 matches
2. Cron `fin-ic-reconcile-diario` agendado às 6h (validar com `SELECT * FROM cron.job`)
3. Mappings de categoria revisados pra cada empresa — Banner amarelo no `/financeiro/mapping` lista pendências
```

- [ ] **Step 3: Commit**

```bash
git add docs/FINANCEIRO_CONFIABILIDADE.md
git commit -m "docs(financeiro): atualiza confiabilidade pós-fundação"
```

### Task 6.2: Pipeline final + commit de encerramento

- [ ] **Step 1: Pipeline geral**

```bash
bun lint && bun build && bun test
```

Expected: tudo verde.

- [ ] **Step 2: Commit de encerramento**

```bash
git commit --allow-empty -m "ship(financeiro): [COMPLETE] Fundação Tier 1 entregue (5 fases)"
```

---

## Definição de Pronto (toda a fundação)

- ✅ Audit trail genérico cobrindo 6 tabelas + drawer UI
- ✅ Travamento de período + override 15 min + badge no topbar + histórico no cockpit
- ✅ DRE caixa e competência com toggle no cockpit + dashboard, snapshots duplos no fechamento
- ✅ Gate de categoria não-mapeada bloqueando aprovação + banner com sugestões + bulk de alta confiança
- ✅ Reconciliação IC com auto-match, fila de divergências, RPC consolidado usando matches
- ✅ `bun lint && bun build && bun test` verdes
- ✅ Docs `FINANCEIRO_CONFIABILIDADE.md` atualizadas
