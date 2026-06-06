# PostHog → erro de produção por e-mail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Erro de produção capturado pelo PostHog (autocapture + `captureException` no ErrorBoundary) → alerta "issue created/reopened" → webhook → edge `posthog-error-webhook` → RPC atômica (dedupe + anti-tempestade + insert) → `fornecedor_alerta` tipo `erro_app` → `dispatch-notifications` (reuso) → e-mail enxuto/PII-safe pro founder.

**Architecture:** O PostHog faz captura/agrupamento/replay. A gente constrói a ponte: helpers puros TS (espelhados no edge), uma edge defensiva que valida segredo e delega a uma RPC `SECURITY DEFINER` (dedupe+circuit-breaker+insert atômicos), e reusa o pipeline de e-mail existente sem editá-lo. Spec: `docs/superpowers/specs/2026-06-04-posthog-erro-email-design.md`.

**Tech Stack:** React 18 + Vite + TS (vitest), Supabase (Postgres + edge Deno), PostHog (`posthog-js ^1.226`), Lovable Cloud. Helpers puros espelhados verbatim no edge (Deno não importa de `src/`).

---

## File Structure

- `src/lib/posthog-error/sanitize-route.ts` (+ test) — `stripQueryString`.
- `src/lib/posthog-error/dedupe-key.ts` (+ test) — `buildDedupeKey`, `buildRollupKey`.
- `src/lib/posthog-error/parse-webhook.ts` (+ test) — `parsePosthogIssuePayload` (defensivo, sem PII).
- `src/lib/posthog-error/email-body.ts` (+ test) — `buildErroAppAlerta` (PII-safe).
- `src/lib/analytics.ts` (modify) — `captureException` helper.
- `src/components/ErrorBoundary.tsx` (modify) — chama `captureException` no `componentDidCatch`.
- `supabase/migrations/20260604170000_posthog_error_webhook.sql` (create) — tabela log + RPC + CHECK.
- `db/test-posthog-error-webhook.sql` (create) — asserts PG17 da RPC.
- `supabase/functions/posthog-error-webhook/index.ts` (create) — edge.
- `supabase/config.toml` (modify) — `verify_jwt=false` da edge.
- `vite.config.ts` (modify, OPCIONAL) — source maps best-effort.

---

## Task 1: Helpers `sanitize-route` + `dedupe-key`

**Files:**
- Create: `src/lib/posthog-error/sanitize-route.ts`, `src/lib/posthog-error/dedupe-key.ts`
- Test: `src/lib/posthog-error/__tests__/sanitize-route.test.ts`, `src/lib/posthog-error/__tests__/dedupe-key.test.ts`

- [ ] **Step 1: Testes (escrever primeiro, devem falhar)**

`__tests__/sanitize-route.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { stripQueryString } from '../sanitize-route';

describe('stripQueryString', () => {
  it('remove query string (que pode ter PII)', () => {
    expect(stripQueryString('/clientes/123?cpf=99999999999&nome=Joao')).toBe('/clientes/123');
  });
  it('remove fragmento', () => {
    expect(stripQueryString('/rota/x#secao')).toBe('/rota/x');
  });
  it('mantém path puro', () => {
    expect(stripQueryString('/financeiro/cockpit')).toBe('/financeiro/cockpit');
  });
  it('string vazia → vazia', () => {
    expect(stripQueryString('')).toBe('');
  });
  it('corta no primeiro de ? ou #', () => {
    expect(stripQueryString('/a?b#c')).toBe('/a');
    expect(stripQueryString('/a#b?c')).toBe('/a');
  });
});
```

`__tests__/dedupe-key.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildDedupeKey, buildRollupKey } from '../dedupe-key';

describe('buildDedupeKey', () => {
  it('compõe project:issue:action', () => {
    expect(buildDedupeKey({ projectId: 'p1', issueId: 'i9', action: 'created' })).toBe('p1:i9:created');
  });
  it('nulos/ausentes viram _ (sem quebrar a chave)', () => {
    expect(buildDedupeKey({})).toBe('_:_:_');
    expect(buildDedupeKey({ issueId: 'i9' })).toBe('_:i9:_');
  });
  it('trim nos componentes', () => {
    expect(buildDedupeKey({ projectId: ' p ', issueId: 'i', action: 'reopened' })).toBe('p:i:reopened');
  });
});

describe('buildRollupKey', () => {
  it('mesma janela de 30min → mesma chave', () => {
    const a = buildRollupKey('2026-06-04T10:05:00.000Z');
    const b = buildRollupKey('2026-06-04T10:29:59.000Z');
    expect(a).toBe(b);
  });
  it('janelas diferentes → chaves diferentes', () => {
    const a = buildRollupKey('2026-06-04T10:05:00.000Z');
    const b = buildRollupKey('2026-06-04T10:35:00.000Z');
    expect(a).not.toBe(b);
  });
  it('prefixo rollup:', () => {
    expect(buildRollupKey('2026-06-04T10:05:00.000Z')).toMatch(/^rollup:\d+$/);
  });
});
```

- [ ] **Step 2: Implementar**

`sanitize-route.ts`:
```ts
/** Remove query string e fragmento de uma rota — eles podem conter PII (cpf, nome, etc.). */
export function stripQueryString(url: string): string {
  if (!url) return '';
  const qIdx = url.indexOf('?');
  const hIdx = url.indexOf('#');
  let end = url.length;
  if (qIdx >= 0) end = Math.min(end, qIdx);
  if (hIdx >= 0) end = Math.min(end, hIdx);
  return url.slice(0, end);
}
```

`dedupe-key.ts`:
```ts
const norm = (s: string | null | undefined): string => (s ?? '').toString().trim() || '_';

/** Chave de idempotência por issue do PostHog: project:issue:action. */
export function buildDedupeKey(parts: {
  projectId?: string | null;
  issueId?: string | null;
  action?: string | null;
}): string {
  return `${norm(parts.projectId)}:${norm(parts.issueId)}:${norm(parts.action)}`;
}

/** Chave do rollup anti-tempestade: 1 bucket por janela de 30min (determinístico, recebe o instante). */
export function buildRollupKey(nowIso: string): string {
  const ms = new Date(nowIso).getTime();
  const bucket = Math.floor(ms / (30 * 60 * 1000));
  return `rollup:${bucket}`;
}
```

- [ ] **Step 3: Rodar `heavy bun run test -- sanitize-route dedupe-key` → tudo passa. Commit.**
```bash
git add src/lib/posthog-error/sanitize-route.ts src/lib/posthog-error/dedupe-key.ts src/lib/posthog-error/__tests__/
git commit -m "feat(posthog-error): helpers sanitize-route + dedupe-key (TDD)"
```

---

## Task 2: Helpers `parse-webhook` + `email-body`

**Files:**
- Create: `src/lib/posthog-error/parse-webhook.ts`, `src/lib/posthog-error/email-body.ts`
- Test: `src/lib/posthog-error/__tests__/parse-webhook.test.ts`, `src/lib/posthog-error/__tests__/email-body.test.ts`

**Contexto:** o JSON exato do webhook do PostHog é INCERTO (confirmar no passo de descoberta, §12 do spec). O parser é DEFENSIVO: tenta caminhos comuns, nunca lança, e **não extrai PII** (stack/person/email ficam fora do `IssueInfo`).

- [ ] **Step 1: Testes (primeiro, devem falhar)**

`__tests__/parse-webhook.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parsePosthogIssuePayload } from '../parse-webhook';

describe('parsePosthogIssuePayload', () => {
  it('extrai de um shape com issue aninhada', () => {
    const r = parsePosthogIssuePayload({
      action: 'created',
      project_id: 'proj1',
      issue: { id: 'iss9', name: 'TypeError', description: 'x is undefined', url: 'https://us.posthog.com/i/9', first_seen: '2026-06-04T10:00:00Z' },
    });
    expect(r.issueId).toBe('iss9');
    expect(r.name).toBe('TypeError');
    expect(r.message).toBe('x is undefined');
    expect(r.issueUrl).toBe('https://us.posthog.com/i/9');
    expect(r.action).toBe('created');
    expect(r.projectId).toBe('proj1');
  });
  it('objeto vazio → tudo null, sem lançar', () => {
    const r = parsePosthogIssuePayload({});
    expect(r.issueId).toBeNull();
    expect(r.name).toBeNull();
  });
  it('raw não-objeto (string/null/number) → tudo null, sem lançar', () => {
    expect(() => parsePosthogIssuePayload('lixo' as unknown)).not.toThrow();
    expect(parsePosthogIssuePayload(null as unknown).issueId).toBeNull();
    expect(parsePosthogIssuePayload(42 as unknown).name).toBeNull();
  });
  it('NÃO vaza PII: stack/person/email do payload não entram no IssueInfo', () => {
    const r = parsePosthogIssuePayload({
      issue: { id: 'i', name: 'Err', stack: 'at Foo (/secret/path.ts:1)', exception_list: [{ stacktrace: 'x' }] },
      person: { email: 'cliente@empresa.com', properties: { cpf: '123' } },
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('cliente@empresa.com');
    expect(json).not.toContain('123');
    expect(json).not.toContain('stacktrace');
  });
  it('tenta caminhos alternativos (data.issue, title, message)', () => {
    const r = parsePosthogIssuePayload({ data: { issue: { fingerprint: 'fp1', title: 'Boom', message: 'kaboom' } } });
    expect(r.issueId).toBe('fp1');
    expect(r.name).toBe('Boom');
    expect(r.message).toBe('kaboom');
  });
});
```

`__tests__/email-body.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildErroAppAlerta } from '../email-body';

describe('buildErroAppAlerta', () => {
  it('monta titulo/mensagem/metadata com os campos seguros', () => {
    const out = buildErroAppAlerta({
      issueId: 'i9', name: 'TypeError', message: "Cannot read 'map' of undefined",
      issueUrl: 'https://us.posthog.com/i/9', firstSeen: '2026-06-04T10:00:00Z',
      action: 'created', projectId: 'p', rota: '/clientes/1?cpf=9',
    });
    expect(out.titulo).toBe('Erro no app: TypeError');
    expect(out.mensagem).toContain("Cannot read 'map' of undefined");
    expect(out.mensagem).toContain('Rota: /clientes/1');     // query string removida
    expect(out.mensagem).not.toContain('cpf=9');
    expect(out.mensagem).toContain('https://us.posthog.com/i/9');
    expect(out.metadata.erro).toBe('TypeError');
    expect(out.metadata.rota).toBe('/clientes/1');
  });
  it('campos null → omitidos, sem quebrar', () => {
    const out = buildErroAppAlerta({
      issueId: null, name: null, message: null, issueUrl: null,
      firstSeen: null, action: null, projectId: null, rota: null,
    });
    expect(out.titulo).toBe('Erro no app: Erro desconhecido');
    expect(out.mensagem.length).toBeGreaterThan(0);
    expect(out.metadata.erro).toBe('Erro desconhecido');
  });
  it('PII-safe: metadata só tem chaves técnicas seguras', () => {
    const out = buildErroAppAlerta({
      issueId: 'i', name: 'E', message: 'm', issueUrl: 'u',
      firstSeen: null, action: 'created', projectId: 'p', rota: '/x',
    });
    const keys = Object.keys(out.metadata);
    expect(keys.every((k) => ['erro', 'rota', 'primeira_vez'].includes(k))).toBe(true);
  });
});
```

- [ ] **Step 2: Implementar**

`parse-webhook.ts`:
```ts
export interface IssueInfo {
  issueId: string | null;
  name: string | null;
  message: string | null;
  issueUrl: string | null;
  firstSeen: string | null;
  action: string | null;
  projectId: string | null;
  /** best-effort: rota de uma ocorrência de exemplo, se o payload trouxer. Pode ser null no alerta issue-level. */
  rota?: string | null;
}

const pickStr = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};

/**
 * Parser DEFENSIVO do webhook de alerta do PostHog Error Tracking.
 * O JSON exato é incerto → tenta caminhos comuns, nunca lança, e NÃO extrai PII
 * (stack/person/email/properties ficam de fora por construção — só campos do issue).
 */
export function parsePosthogIssuePayload(raw: unknown): IssueInfo {
  const r: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  const asObj = (v: unknown): Record<string, unknown> =>
    (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : {};
  const data = asObj(r.data);
  const issue = asObj(r.issue ?? data.issue ?? data);

  return {
    issueId: pickStr(issue.id, r.issue_id, issue.fingerprint, r.id),
    name: pickStr(issue.name, issue.title, issue.exception_type, r.name),
    message: pickStr(issue.description, issue.message, issue.exception_message, r.message),
    issueUrl: pickStr(issue.url, issue.link, r.url, r.issue_url),
    firstSeen: pickStr(issue.first_seen, (issue as Record<string, unknown>).firstSeen, r.first_seen),
    action: pickStr(r.action, r.event, issue.status),
    projectId: pickStr(r.project_id, asObj(r.project).id, issue.project_id),
    rota: pickStr((asObj(r.properties) as Record<string, unknown>)['$pathname'], (asObj(r.properties) as Record<string, unknown>)['$current_url']),
  };
}
```

`email-body.ts`:
```ts
import type { IssueInfo } from './parse-webhook';
import { stripQueryString } from './sanitize-route';

export interface ErroAppAlerta {
  titulo: string;
  mensagem: string;
  metadata: Record<string, unknown>;
}

/**
 * Monta o alerta PII-safe. NUNCA inclui stack, person, e-mail, query string ou
 * valores de cliente — o fornecedor_alerta é lido por employee no AlertaDrawer
 * e vai pro Gmail. O detalhe sensível fica no PostHog (login-gated), via issueUrl.
 */
export function buildErroAppAlerta(info: IssueInfo): ErroAppAlerta {
  const name = (info.name ?? 'Erro desconhecido').slice(0, 200);
  const msg = (info.message ?? '').slice(0, 500);
  const rota = info.rota ? stripQueryString(info.rota).slice(0, 200) : null;

  const linhas: string[] = [];
  if (msg) linhas.push(msg);
  if (rota) linhas.push(`Rota: ${rota}`);
  if (info.issueUrl) linhas.push(`Ver no PostHog (stack + replay): ${info.issueUrl}`);

  const metadata: Record<string, unknown> = { erro: name };
  if (rota) metadata.rota = rota;
  if (info.firstSeen) metadata.primeira_vez = info.firstSeen;

  return {
    titulo: `Erro no app: ${name}`,
    mensagem: linhas.join('\n') || '(sem detalhes — ver no PostHog)',
    metadata,
  };
}
```

- [ ] **Step 3: Rodar `heavy bun run test -- parse-webhook email-body` → passa. Commit.**
```bash
git add src/lib/posthog-error/parse-webhook.ts src/lib/posthog-error/email-body.ts src/lib/posthog-error/__tests__/
git commit -m "feat(posthog-error): parser defensivo (sem PII) + corpo PII-safe (TDD)"
```

---

## Task 3: `analytics.captureException` + fiação no `ErrorBoundary`

**Files:**
- Modify: `src/lib/analytics.ts`, `src/components/ErrorBoundary.tsx`
- Test: `src/components/__tests__/ErrorBoundary.test.tsx`

- [ ] **Step 1: `analytics.ts` — adicionar o helper** (após `track`, mesmo padrão):
```ts
/**
 * Captura uma exceção no PostHog Error Tracking. No-op se telemetria desligada
 * (DEV opt-out / sem token). Use no ErrorBoundary e em catch-blocks relevantes.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.captureException(error, context);
  } catch (e) {
    logger.warn('Falha ao capturar exceção no analytics', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
```

- [ ] **Step 2: Teste do ErrorBoundary (escrever, deve falhar)** `src/components/__tests__/ErrorBoundary.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

const captureException = vi.fn();
vi.mock('@/lib/analytics', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

function Boom(): JSX.Element { throw new Error('explodiu'); }

describe('ErrorBoundary', () => {
  beforeEach(() => captureException.mockClear());

  it('renderiza o fallback e reporta a exceção ao PostHog', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(getByText('Algo deu errado')).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureException.mock.calls[0];
    expect((err as Error).message).toBe('explodiu');
    expect(ctx).toHaveProperty('rota');
    expect(ctx).toHaveProperty('componentStack');
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: `ErrorBoundary.tsx` — fiar a captura** no `componentDidCatch` (manter o `console.error`):
```tsx
import { captureException } from '@/lib/analytics';
import { stripQueryString } from '@/lib/posthog-error/sanitize-route';
// ...
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Erro capturado:', error, errorInfo);
    captureException(error, {
      rota: stripQueryString(typeof window !== 'undefined' ? window.location.pathname : ''),
      componentStack: errorInfo.componentStack,
    });
  }
```

- [ ] **Step 4: Rodar `heavy bun run test -- ErrorBoundary` → passa. `heavy bun run typecheck`. Commit.**
```bash
git add src/lib/analytics.ts src/components/ErrorBoundary.tsx src/components/__tests__/ErrorBoundary.test.tsx
git commit -m "feat(posthog-error): captureException no analytics + fiação no ErrorBoundary"
```

> ⚠️ NÃO ligar `capture_console_errors` no PostHog (config do painel, §5.2 do spec) — senão o `console.error` do boundary vira 2º `$exception`. O `console.error` fica só pra DEV.

---

## Task 4: Migration — tabela log + RPC atômica + CHECK

**Files:**
- Create: `supabase/migrations/20260604170000_posthog_error_webhook.sql`
- Create: `db/test-posthog-error-webhook.sql`

- [ ] **Step 1: Escrever a migration** (CHECK parte dos **9 valores atuais** = última migration `20260604140000_whatsapp_sla_digest.sql`, NÃO o snapshot stale):
```sql
-- ============================================================================
-- PostHog → erro de produção por e-mail: tabela de dedupe + RPC atômica + CHECK
-- Spec: docs/superpowers/specs/2026-06-04-posthog-erro-email-design.md
-- ⚠️ Migration MANUAL: colar no SQL Editor. APLICAR ANTES de habilitar o alerta no PostHog.
-- ============================================================================

create table if not exists public.posthog_error_webhook_log (
  id          bigint generated always as identity primary key,
  dedupe_key  text not null unique,
  issue_id    text,
  action      text,
  payload_raw text,
  alerta_id   bigint,
  criado_em   timestamptz not null default now()
);
alter table public.posthog_error_webhook_log enable row level security;
-- sem policies → só service_role/definer escrevem (padrão das tabelas de motor)

-- RPC atômica: dedupe + circuit breaker + insert numa única transação.
create or replace function public.enfileirar_erro_app(
  p_dedupe_key text,
  p_issue_id   text,
  p_action     text,
  p_payload_raw text,
  p_titulo     text,
  p_mensagem   text,
  p_metadata   jsonb,
  p_rollup_key text,
  p_lista_url  text,
  p_cap        int default 10
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_log_id    bigint;
  v_rollup_id bigint;
  v_count     int;
  v_alerta_id bigint;
begin
  -- 1. dedupe (atômico): grava a chave; se já existe, no-op (mata retry/reenvio)
  insert into public.posthog_error_webhook_log(dedupe_key, issue_id, action, payload_raw)
    values (p_dedupe_key, p_issue_id, p_action, left(coalesce(p_payload_raw,''), 8000))
    on conflict (dedupe_key) do nothing
    returning id into v_log_id;
  if v_log_id is null then
    return jsonb_build_object('status','deduped');
  end if;

  -- 2. circuit breaker: conta erro_app INDIVIDUAIS na janela de 30min (exclui rollups)
  select count(*) into v_count from public.fornecedor_alerta
    where tipo = 'erro_app'
      and coalesce(metadata->>'kind','') <> 'rollup'
      and criado_em > now() - interval '30 minutes';

  if v_count >= p_cap then
    -- tempestade: 1 rollup por janela (dedupado por rollup_key)
    insert into public.posthog_error_webhook_log(dedupe_key, action)
      values (p_rollup_key, 'rollup')
      on conflict (dedupe_key) do nothing
      returning id into v_rollup_id;
    if v_rollup_id is null then
      return jsonb_build_object('status','rollup_suprimido');  -- já há rollup nesta janela
    end if;
    insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem, metadata)
      values ('erro_app','oben','atencao','pendente_notificacao',
              'Tempestade de erros no app',
              'Muitos erros novos em 30 min. Veja a lista no PostHog: ' || coalesce(p_lista_url,'(sem link)'),
              jsonb_build_object('kind','rollup'))
      returning id into v_alerta_id;
    update public.posthog_error_webhook_log set alerta_id = v_alerta_id where id = v_rollup_id;
    return jsonb_build_object('status','rollup','alerta_id',v_alerta_id);
  end if;

  -- 3. alerta individual
  insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem, metadata)
    values ('erro_app','oben','atencao','pendente_notificacao',
            p_titulo, p_mensagem, coalesce(p_metadata,'{}'::jsonb))
    returning id into v_alerta_id;
  update public.posthog_error_webhook_log set alerta_id = v_alerta_id where id = v_log_id;
  return jsonb_build_object('status','enfileirado','alerta_id',v_alerta_id);
end;
$$;

-- só a edge (service_role) executa; no Supabase REVOKE FROM PUBLIC não basta
revoke execute on function public.enfileirar_erro_app(text,text,text,text,text,text,jsonb,text,text,int)
  from public, anon, authenticated;
grant execute on function public.enfileirar_erro_app(text,text,text,text,text,text,jsonb,text,text,int)
  to service_role;

-- estende o CHECK de tipo (9 valores atuais + erro_app)
alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla',
                  'erro_app','outro'));
```

- [ ] **Step 2: Escrever `db/test-posthog-error-webhook.sql`** (asserts PG17; rodar sobre o schema-snapshot + esta migration, base `db/verify-snapshot-replay.sh`):
```sql
-- Asserts da RPC enfileirar_erro_app. Requer a migration 20260604170000 aplicada.
DO $$
DECLARE r jsonb; n_alertas int; n_log int;
BEGIN
  -- limpa estado de teste
  delete from public.fornecedor_alerta where tipo='erro_app';
  delete from public.posthog_error_webhook_log;

  -- 1. enfileira individual
  r := public.enfileirar_erro_app('p:i1:created','i1','created','{}','Erro no app: A','msg A','{"erro":"A"}'::jsonb,'rollup:1','http://x',10);
  ASSERT r->>'status' = 'enfileirado', 'primeiro insert = enfileirado';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app';
  ASSERT n_alertas = 1, 'criou 1 alerta';

  -- 2. dedupe: MESMA chave não duplica
  r := public.enfileirar_erro_app('p:i1:created','i1','created','{}','x','x','{}'::jsonb,'rollup:1','http://x',10);
  ASSERT r->>'status' = 'deduped', 'mesma dedupe_key = deduped';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app';
  ASSERT n_alertas = 1, 'dedupe NÃO criou 2º alerta';

  -- 3. circuit breaker: com cap=2, o 3º vira rollup
  delete from public.fornecedor_alerta where tipo='erro_app';
  delete from public.posthog_error_webhook_log;
  PERFORM public.enfileirar_erro_app('p:a:created','a','created','{}','A','A','{}'::jsonb,'rollup:9','u',2);
  PERFORM public.enfileirar_erro_app('p:b:created','b','created','{}','B','B','{}'::jsonb,'rollup:9','u',2);
  r := public.enfileirar_erro_app('p:c:created','c','created','{}','C','C','{}'::jsonb,'rollup:9','u',2);
  ASSERT r->>'status' = 'rollup', '3º acima do cap=2 → rollup';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app' AND metadata->>'kind'='rollup';
  ASSERT n_alertas = 1, 'criou 1 rollup';

  -- 4. rollup suprimido: 4º na mesma janela não cria 2º rollup
  r := public.enfileirar_erro_app('p:d:created','d','created','{}','D','D','{}'::jsonb,'rollup:9','u',2);
  ASSERT r->>'status' = 'rollup_suprimido', '4º na mesma janela = rollup_suprimido';
  SELECT count(*) INTO n_alertas FROM public.fornecedor_alerta WHERE tipo='erro_app' AND metadata->>'kind'='rollup';
  ASSERT n_alertas = 1, 'continua 1 rollup só';

  -- 5. log preenchido + alerta_id no individual
  SELECT count(*) INTO n_log FROM public.posthog_error_webhook_log;
  ASSERT n_log >= 4, 'log tem as chaves processadas';

  RAISE NOTICE 'OK: enfileirar_erro_app (dedupe + circuit breaker + rollup)';
END $$;

-- 6. CHECK aceita erro_app, rejeita tipo inválido
DO $$
BEGIN
  PERFORM 1;
  BEGIN
    INSERT INTO public.fornecedor_alerta(tipo,empresa,severidade,status,titulo)
      VALUES ('tipo_que_nao_existe','oben','info','pendente_notificacao','x');
    ASSERT false, 'CHECK deveria rejeitar tipo inválido';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: CHECK rejeita tipo inválido e aceita erro_app';
END $$;
```

- [ ] **Step 3: Validar em PG17 local** (adaptar `db/verify-snapshot-replay.sh`: prelude + snapshot + esta migration + o test). Confirmar todos os `RAISE NOTICE OK`. Commit.
```bash
git add supabase/migrations/20260604170000_posthog_error_webhook.sql db/test-posthog-error-webhook.sql
git commit -m "feat(posthog-error): migration tabela log + RPC atômica + CHECK erro_app (PG17 validado)"
```

---

## Task 5: Edge `posthog-error-webhook` + config.toml

**Files:**
- Create: `supabase/functions/posthog-error-webhook/index.ts`
- Modify: `supabase/config.toml`

**Contexto:** Deno não importa de `src/` → os helpers são **espelhados inline verbatim**. A edge valida segredo (header, constant-time), parseia defensivo, monta PII-safe, chama a RPC via service_role.

- [ ] **Step 1: `config.toml` — declarar a edge sem JWT** (adicionar bloco):
```toml
[functions.posthog-error-webhook]
verify_jwt = false
```

- [ ] **Step 2: `supabase/functions/posthog-error-webhook/index.ts`:**
```ts
// posthog-error-webhook: recebe alerta "issue created/reopened" do PostHog Error Tracking,
// valida segredo, e delega à RPC enfileirar_erro_app (dedupe + anti-tempestade + insert atômico).
// Helpers ESPELHADOS verbatim de src/lib/posthog-error/* (Deno não importa de src).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('POSTHOG_WEBHOOK_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-posthog-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---- helpers espelhados de src/lib/posthog-error/* ----
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function stripQueryString(url: string): string {
  if (!url) return '';
  const q = url.indexOf('?'), h = url.indexOf('#');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return url.slice(0, end);
}
const norm = (s: string | null | undefined) => (s ?? '').toString().trim() || '_';
function buildDedupeKey(p: { projectId?: string | null; issueId?: string | null; action?: string | null }): string {
  return `${norm(p.projectId)}:${norm(p.issueId)}:${norm(p.action)}`;
}
function buildRollupKey(nowIso: string): string {
  return `rollup:${Math.floor(new Date(nowIso).getTime() / (30 * 60 * 1000))}`;
}
interface IssueInfo {
  issueId: string | null; name: string | null; message: string | null; issueUrl: string | null;
  firstSeen: string | null; action: string | null; projectId: string | null; rota?: string | null;
}
const pickStr = (...vals: unknown[]): string | null => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v;
  return null;
};
function parsePosthogIssuePayload(raw: unknown): IssueInfo {
  const r: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  const data = asObj(r.data); const issue = asObj(r.issue ?? data.issue ?? data);
  const props = asObj(r.properties);
  return {
    issueId: pickStr(issue.id, r.issue_id, issue.fingerprint, r.id),
    name: pickStr(issue.name, issue.title, issue.exception_type, r.name),
    message: pickStr(issue.description, issue.message, issue.exception_message, r.message),
    issueUrl: pickStr(issue.url, issue.link, r.url, r.issue_url),
    firstSeen: pickStr(issue.first_seen, (issue as Record<string, unknown>).firstSeen, r.first_seen),
    action: pickStr(r.action, r.event, issue.status),
    projectId: pickStr(r.project_id, asObj(r.project).id, issue.project_id),
    rota: pickStr(props['$pathname'], props['$current_url']),
  };
}
function buildErroAppAlerta(info: IssueInfo): { titulo: string; mensagem: string; metadata: Record<string, unknown> } {
  const name = (info.name ?? 'Erro desconhecido').slice(0, 200);
  const msg = (info.message ?? '').slice(0, 500);
  const rota = info.rota ? stripQueryString(info.rota).slice(0, 200) : null;
  const linhas: string[] = [];
  if (msg) linhas.push(msg);
  if (rota) linhas.push(`Rota: ${rota}`);
  if (info.issueUrl) linhas.push(`Ver no PostHog (stack + replay): ${info.issueUrl}`);
  const metadata: Record<string, unknown> = { erro: name };
  if (rota) metadata.rota = rota;
  if (info.firstSeen) metadata.primeira_vez = info.firstSeen;
  return { titulo: `Erro no app: ${name}`, mensagem: linhas.join('\n') || '(sem detalhes — ver no PostHog)', metadata };
}
// ---- fim helpers ----

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: corsHeaders });

  // auth: segredo no header, constant-time
  const provided = req.headers.get('x-posthog-webhook-secret') ?? '';
  if (!WEBHOOK_SECRET || !constantTimeEqual(provided, WEBHOOK_SECRET)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let raw: unknown = null;
  let rawText = '';
  try { rawText = await req.text(); raw = JSON.parse(rawText); } catch { raw = null; }
  console.log('[posthog-error-webhook] payload:', rawText.slice(0, 2000)); // modo descoberta

  const info = parsePosthogIssuePayload(raw);
  const nowIso = new Date().toISOString();
  const dedupeKey = buildDedupeKey({ projectId: info.projectId, issueId: info.issueId, action: info.action });
  const rollupKey = buildRollupKey(nowIso);
  const { titulo, mensagem, metadata } = buildErroAppAlerta(info);
  // lista de issues do PostHog p/ o rollup (deriva da issueUrl ou usa o host)
  const listaUrl = info.issueUrl ? info.issueUrl.replace(/\/issues?\/.*/i, '/error_tracking') : 'https://us.posthog.com';

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await supabase.rpc('enfileirar_erro_app', {
    p_dedupe_key: dedupeKey,
    p_issue_id: info.issueId,
    p_action: info.action,
    p_payload_raw: rawText.slice(0, 8000),
    p_titulo: titulo,
    p_mensagem: mensagem,
    p_metadata: metadata,
    p_rollup_key: rollupKey,
    p_lista_url: listaUrl,
    p_cap: 10,
  });

  if (error) {
    console.error('[posthog-error-webhook] RPC falhou:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true, result: data }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 3: `deno check` na edge** (paridade dos helpers com `src/`). `heavy bun run typecheck` (front intacto). Commit.
```bash
git add supabase/functions/posthog-error-webhook/index.ts supabase/config.toml
git commit -m "feat(posthog-error): edge posthog-error-webhook (auth header + parse + RPC) + verify_jwt=false"
```

> ⚠️ Os helpers inline na edge devem bater **verbatim** com `src/lib/posthog-error/*`. Se mudar um, mudar o outro.

---

## Task 6 (OPCIONAL, best-effort): Source maps pro PostHog no build

**Files:** Modify: `vite.config.ts`

Beneficia o stack **no PostHog** (não o e-mail). Guardado por env → no-op se ausente. Se o build do Lovable não cooperar, deixar para depois (o e-mail nunca promete stack des-minificado).

- [ ] **Step 1:** adicionar o plugin oficial de source maps do PostHog ao `vite.config.ts`, condicionado a `process.env.POSTHOG_CLI_TOKEN` (ou equivalente). Confirmar o nome do plugin atual na doc do PostHog antes (pode ser `@posthog/sourcemap` / posthog-cli pós-build). Se inviável no Lovable, registrar como deferido e seguir.
- [ ] **Step 2:** `heavy bun run build` local não quebra (plugin no-op sem token). Commit.

---

## Pós-tasks (não são código — checklist de rollout do founder, §11 do spec)

1. **Migration** (Task 4) no SQL Editor → validar tabela + RPC + CHECK (10 valores).
2. **Deploy** da edge `posthog-error-webhook` (chat do Lovable, verbatim) + setar secret `POSTHOG_WEBHOOK_SECRET`.
3. **Capturar 1 payload real** (PostHog "Test function" → webhook.site OU o log da edge) → ajustar `parsePosthogIssuePayload`/template se o shape divergir.
4. **Habilitar** no PostHog: Exception autocapture (console errors OFF) + alerta "issue created/reopened" → Webhook (URL + header `x-posthog-webhook-secret`).
5. **Publish** do front (captura no ErrorBoundary).

## Self-review do plano
- **Cobertura do spec:** captura (T3), ponte/edge (T5), RPC/dedupe/rollup (T4), e-mail PII-safe (T2), helpers (T1-2), source maps (T6), rollout (pós-tasks). ✅
- **Sem placeholders:** código completo em cada step (só T6 é best-effort por depender do build do Lovable, marcado).
- **Consistência de tipos:** `IssueInfo` (T2) usado em `email-body` (T2) e na edge (T5, espelhado); assinatura da RPC (T4) bate com o `.rpc()` da edge (T5, 10 params). ✅
