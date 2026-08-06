# PR-1 Núcleo HSM (templates WhatsApp fora da janela de 24h) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o sender de templates HSM (360dialog/Meta Cloud API) com catálogo, idempotência por `dedupe_key`, respeito a opt-out e retorno de entrega (statuses) — a fundação que destrava proposta 1-toque, status transacional e o motor de disparo por rota.

**Architecture:** Helpers puros testados em `src/lib/whatsapp/` espelhados verbatim nas edges (Deno não importa de `src/`); catálogo `whatsapp_templates` + log `whatsapp_template_sends` no Postgres com RLS staff-read/master-write e escrita só por service_role; edge nova `whatsapp-send-template` (dedupe-first: reserva a chave ANTES do POST); edge `whatsapp-inbound` ganha parse de `value.statuses` com progressão monotônica de status.

**Tech Stack:** TypeScript strict, vitest (`bun run test`), Supabase edge functions (Deno), 360dialog Cloud API, PostgreSQL 17 local para prova de migration (skill `prove-sql-money-path`).

## Global Constraints

- Código/comentários/commits/PR em **pt-BR**; tabelas Supabase novas seguem o padrão do subsistema WhatsApp existente (`whatsapp_*`, colunas EN/PT como as irmãs).
- **Tabela nova SEMPRE com RLS** (CLAUDE.md); revogar escrita de `anon`/`authenticated` **por nome** (REVOKE FROM PUBLIC não os tira).
- Statuses em EN, consistentes com a Cloud API e com `whatsapp_messages.status` já gravado hoje (`sent`): `queued|sent|delivered|read|failed`.
- Parâmetro de body de template Meta **não pode ter newline/tab/4+ espaços** — sanitizar sempre (é por isso que `sanitizeTemplateParam` existe).
- A mensagem JÁ enviada ao cliente nunca falha o request por erro de persistência — logar alto e sinalizar (`persisted:false`), padrão do `whatsapp-send` atual.
- `heavy` prefixando test/typecheck (semáforo de RAM M2 8GB). `cmd | tail` engole exit code — usar `> log 2>&1; echo $?`.
- Migration NUNCA auto-aplica no Lovable — entregar bloco pro SQL Editor (skill `lovable-db-operator`) + validação pós-apply.

---

### Task 1: Helper puro — payload de template + sanitização

**Files:**
- Create: `src/lib/whatsapp/template-payload.ts`
- Test: `src/lib/whatsapp/template-payload.test.ts`

**Interfaces:**
- Produces: `sanitizeTemplateParam(raw: string): string`, `validateBodyParams(params: string[], expected: number): string | null`, `buildTemplatePayload(input: TemplatePayloadInput): Record<string, unknown>`, `renderTemplatePreview(corpoReferencia: string, bodyParams: string[]): string` — consumidos (espelhados) pela edge da Task 5.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/whatsapp/template-payload.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildTemplatePayload,
  renderTemplatePreview,
  sanitizeTemplateParam,
  validateBodyParams,
} from './template-payload';

describe('sanitizeTemplateParam', () => {
  it('troca newlines/tabs por vírgula-espaço e colapsa espaços (Meta rejeita \\n/\\t/4+ espaços)', () => {
    expect(sanitizeTemplateParam('3× Lixa 80\n2× Verniz PU\n1× Thinner')).toBe(
      '3× Lixa 80, 2× Verniz PU, 1× Thinner',
    );
    expect(sanitizeTemplateParam('a\tb')).toBe('a b');
    expect(sanitizeTemplateParam('a     b')).toBe('a b');
    expect(sanitizeTemplateParam('  x  ')).toBe('x');
  });
  it('CRLF não vira vírgula dupla', () => {
    expect(sanitizeTemplateParam('a\r\nb')).toBe('a, b');
  });
});

describe('validateBodyParams', () => {
  it('null quando contagem bate e nenhum param é vazio', () => {
    expect(validateBodyParams(['João', 'amanhã'], 2)).toBeNull();
  });
  it('erro quando contagem diverge do template', () => {
    expect(validateBodyParams(['só um'], 2)).toMatch(/2 parâmetro/);
  });
  it('erro quando um param fica vazio pós-sanitize', () => {
    expect(validateBodyParams(['João', '   '], 2)).toMatch(/vazio/);
  });
});

describe('buildTemplatePayload', () => {
  it('monta o payload Cloud API com components de body', () => {
    expect(
      buildTemplatePayload({ to: '5537999990000', templateName: 'colacor_status_pedido', bodyParams: ['João', '123'] }),
    ).toEqual({
      messaging_product: 'whatsapp',
      to: '5537999990000',
      type: 'template',
      template: {
        name: 'colacor_status_pedido',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João' },
              { type: 'text', text: '123' },
            ],
          },
        ],
      },
    });
  });
  it('omite components quando não há params', () => {
    const p = buildTemplatePayload({ to: '55', templateName: 't', bodyParams: [] }) as {
      template: Record<string, unknown>;
    };
    expect('components' in p.template).toBe(false);
  });
});

describe('renderTemplatePreview', () => {
  it('substitui {{1}}..{{n}} pelos params (preview legível pro inbox)', () => {
    expect(renderTemplatePreview('Olá, {{1}}! Pedido {{2}}: {{3}}.', ['Ana', '42', 'sai amanhã'])).toBe(
      'Olá, Ana! Pedido 42: sai amanhã.',
    );
  });
  it('placeholder sem param correspondente permanece visível (sinal de erro, não texto fabricado)', () => {
    expect(renderTemplatePreview('Oi {{1}} e {{2}}', ['Ana'])).toBe('Oi Ana e {{2}}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/whatsapp/template-payload.test.ts > /tmp/t1.log 2>&1; echo $?; tail -5 /tmp/t1.log`
Expected: exit ≠ 0, "Cannot find module './template-payload'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/whatsapp/template-payload.ts
// Payload de template HSM (Cloud API/360dialog). PURO/testável — espelhado verbatim
// na edge whatsapp-send-template (Deno não importa de src/).
// Meta rejeita body param com newline/tab/4+ espaços consecutivos → sanitize SEMPRE.

export interface TemplatePayloadInput {
  to: string; // dígitos E.164 sem '+'
  templateName: string;
  languageCode?: string;
  bodyParams: string[];
}

export function sanitizeTemplateParam(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[\n\r]+/g, ', ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function validateBodyParams(params: string[], expected: number): string | null {
  if (params.length !== expected) {
    return `template exige ${expected} parâmetro(s) de body; recebeu ${params.length}`;
  }
  const vazio = params.findIndex((p) => sanitizeTemplateParam(p).length === 0);
  if (vazio >= 0) return `parâmetro ${vazio + 1} vazio pós-sanitize`;
  return null;
}

export function buildTemplatePayload(input: TemplatePayloadInput): Record<string, unknown> {
  const params = input.bodyParams.map((t) => ({ type: 'text', text: sanitizeTemplateParam(t) }));
  const template: Record<string, unknown> = {
    name: input.templateName,
    language: { code: input.languageCode ?? 'pt_BR' },
  };
  if (params.length > 0) template.components = [{ type: 'body', parameters: params }];
  return { messaging_product: 'whatsapp', to: input.to, type: 'template', template };
}

export function renderTemplatePreview(corpoReferencia: string, bodyParams: string[]): string {
  return corpoReferencia.replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const idx = Number(n) - 1;
    const v = bodyParams[idx];
    return v === undefined ? m : sanitizeTemplateParam(v);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/whatsapp/template-payload.test.ts > /tmp/t1.log 2>&1; echo $?; tail -5 /tmp/t1.log`
Expected: exit 0, todos os testes PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/template-payload.ts src/lib/whatsapp/template-payload.test.ts
git commit -m "feat(whatsapp): helper puro de payload de template HSM (sanitize + build + preview)"
```

---

### Task 2: Helper puro — parse de statuses do webhook + progressão monotônica

**Files:**
- Modify: `src/lib/whatsapp/inbound.ts` (append no fim do arquivo)
- Test: `src/lib/whatsapp/inbound.test.ts` (append)

**Interfaces:**
- Consumes: nada de outras tasks.
- Produces: `parseStatusWebhook(payload: unknown): ParsedStatus[]` e `isStatusUpgrade(current: string | null, next: string): boolean` com `ParsedStatus = { waMessageId: string; status: 'sent'|'delivered'|'read'|'failed'; erro: string | null; waTimestamp: Date | null }` — espelhados na edge da Task 6.

- [ ] **Step 1: Write the failing test (append em `src/lib/whatsapp/inbound.test.ts`)**

```ts
// --- statuses (Task 2 do núcleo HSM) ---
import { isStatusUpgrade, parseStatusWebhook } from './inbound';

describe('parseStatusWebhook', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: 'wamid.A', status: 'delivered', timestamp: '1760000000', recipient_id: '5537999990000' },
                {
                  id: 'wamid.B',
                  status: 'failed',
                  timestamp: '1760000001',
                  errors: [{ code: 131047, title: 'Re-engagement message' }],
                },
              ],
            },
          },
        ],
      },
    ],
  };
  it('extrai id, status, erro e timestamp', () => {
    const out = parseStatusWebhook(payload);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ waMessageId: 'wamid.A', status: 'delivered', erro: null });
    expect(out[0].waTimestamp?.getTime()).toBe(1760000000 * 1000);
    expect(out[1]).toMatchObject({ waMessageId: 'wamid.B', status: 'failed' });
    expect(out[1].erro).toMatch(/131047/);
  });
  it('payload sem statuses → []', () => {
    expect(parseStatusWebhook({ entry: [{ changes: [{ value: { messages: [] } }] }] })).toEqual([]);
    expect(parseStatusWebhook(null)).toEqual([]);
  });
  it('status desconhecido é descartado (não inventa estado)', () => {
    const p = { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'warmed_up' }] } }] }] };
    expect(parseStatusWebhook(p)).toEqual([]);
  });
});

describe('isStatusUpgrade', () => {
  it('progride sent→delivered→read e nunca regride (webhooks chegam fora de ordem)', () => {
    expect(isStatusUpgrade('sent', 'delivered')).toBe(true);
    expect(isStatusUpgrade('read', 'delivered')).toBe(false);
    expect(isStatusUpgrade('delivered', 'delivered')).toBe(false);
    expect(isStatusUpgrade(null, 'sent')).toBe(true);
    expect(isStatusUpgrade('queued', 'sent')).toBe(true);
  });
  it('failed é terminal e sempre vence', () => {
    expect(isStatusUpgrade('read', 'failed')).toBe(true);
    expect(isStatusUpgrade('failed', 'delivered')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/whatsapp/inbound.test.ts > /tmp/t2.log 2>&1; echo $?; tail -5 /tmp/t2.log`
Expected: exit ≠ 0 — `parseStatusWebhook` não exportado.

- [ ] **Step 3: Write minimal implementation (append em `src/lib/whatsapp/inbound.ts`)**

```ts
// --- Statuses do webhook (retorno de entrega de mensagens OUT — núcleo HSM) ---
// Cloud API entrega value.statuses[] separado de value.messages[].
export interface ParsedStatus {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  erro: string | null;
  waTimestamp: Date | null;
}

const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

export function parseStatusWebhook(payload: unknown): ParsedStatus[] {
  const out: ParsedStatus[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const statuses = value?.statuses as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(statuses)) continue;
      for (const s of statuses) {
        const status = String(s.status ?? '');
        if (!KNOWN_STATUSES.has(status)) continue;
        const tsRaw = s.timestamp ? Number(s.timestamp) : NaN;
        const errors = s.errors as Array<{ code?: number; title?: string; message?: string }> | undefined;
        const e0 = errors?.[0];
        out.push({
          waMessageId: String(s.id ?? ''),
          status: status as ParsedStatus['status'],
          erro: e0 ? `${e0.code ?? ''} ${e0.title ?? e0.message ?? ''}`.trim() : null,
          waTimestamp: Number.isFinite(tsRaw) ? new Date(tsRaw * 1000) : null,
        });
      }
    }
  }
  return out.filter((x) => x.waMessageId);
}

// Progressão monotônica: webhooks chegam fora de ordem; nunca regredir status.
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

export function isStatusUpgrade(current: string | null, next: string): boolean {
  const cur = current ? (STATUS_RANK[current] ?? 0) : -1;
  const nxt = STATUS_RANK[next] ?? -1;
  return nxt > cur;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/whatsapp/inbound.test.ts > /tmp/t2.log 2>&1; echo $?; tail -5 /tmp/t2.log`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts
git commit -m "feat(whatsapp): parse de statuses do webhook + progressão monotônica (helper puro)"
```

---

### Task 3: Migration — catálogo `whatsapp_templates` + log `whatsapp_template_sends`

**Files:**
- Create: `supabase/migrations/20260713010000_whatsapp_templates_hsm.sql`

**Interfaces:**
- Produces: tabelas `whatsapp_templates(nome UNIQUE, categoria, idioma, corpo_referencia, num_body_params, ativo)` e `whatsapp_template_sends(template_nome→FK, conversation_id, phone_e164, body_params jsonb, dedupe_key UNIQUE, status, wa_message_id, erro, origem, disparado_por)` — consumidas pelas edges (Tasks 5-6).
- ⚠️ Ritual `lovable-db-operator`: a migration NÃO auto-aplica — gerar bloco pro SQL Editor + validação pós-apply no handoff (Task 8).

- [ ] **Step 1: Write the migration**

```sql
-- Núcleo HSM: catálogo de templates Meta aprovados + log de envio com idempotência.
-- Escrita nas duas tabelas é da EDGE (service_role); staff lê; master gerencia o catálogo.
-- Seed entra com ativo=false — o founder ativa após a Meta aprovar o template na 360dialog.

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL UNIQUE,                       -- nome EXATO aprovado na Meta/360dialog
  categoria text NOT NULL CHECK (categoria IN ('utility','marketing')),
  idioma text NOT NULL DEFAULT 'pt_BR',
  corpo_referencia text NOT NULL,                  -- corpo com {{1}}..{{n}} (preview no inbox)
  num_body_params smallint NOT NULL DEFAULT 0 CHECK (num_body_params BETWEEN 0 AND 10),
  ativo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_template_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_nome text NOT NULL REFERENCES public.whatsapp_templates(nome),
  conversation_id uuid REFERENCES public.whatsapp_conversations(id),
  phone_e164 text NOT NULL,
  body_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key text NOT NULL UNIQUE,                 -- idempotência: reservada ANTES do POST
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id text,
  erro text,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','proposta','status_pedido','rota')),
  disparado_por uuid,                              -- staff que disparou (null = automação)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wts_conversation ON public.whatsapp_template_sends(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wts_wa_message_id ON public.whatsapp_template_sends(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wts_pendentes ON public.whatsapp_template_sends(status, created_at) WHERE status IN ('queued','sent');

ALTER TABLE public.whatsapp_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_template_sends ENABLE ROW LEVEL SECURITY;

-- leitura: staff (employee/master). catálogo: master escreve. log: SÓ service_role escreve (edge).
CREATE POLICY "wt_staff_read" ON public.whatsapp_templates FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));
CREATE POLICY "wt_master_write" ON public.whatsapp_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role = 'master'));

CREATE POLICY "wts_staff_read" ON public.whatsapp_template_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = (select auth.uid()) AND ur.role IN ('employee','master')));

-- REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito) — revogar por nome (CLAUDE.md).
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_template_sends FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.whatsapp_templates FROM anon;

-- Seed (ativo=false até aprovação na Meta; wording final é do founder — brand-voice):
INSERT INTO public.whatsapp_templates (nome, categoria, idioma, corpo_referencia, num_body_params, ativo) VALUES
  ('colacor_proposta_recompra', 'marketing', 'pt_BR',
   'Olá, {{1}}! Preparamos sua reposição para a entrega de {{2}} na sua região: {{3}}. Quer que a gente já separe? Responda SIM ou fale com sua vendedora. Para não receber mais, responda PARAR.', 3, false),
  ('colacor_status_pedido', 'utility', 'pt_BR',
   'Olá, {{1}}! Atualização do seu pedido {{2}}: {{3}}.', 3, false)
ON CONFLICT (nome) DO NOTHING;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260713010000_whatsapp_templates_hsm.sql
git commit -m "feat(whatsapp): migration do núcleo HSM — catálogo de templates + log de envio idempotente"
```

---

### Task 4: Prova PG17 da migration (prove-sql — RLS + dedupe + falsificação)

**Files:**
- Create: `db/test-whatsapp-hsm.sh` (a partir do template dos `db/test-*.sh` existentes — invocar a skill `prove-sql-money-path` para montar o harness)

**Interfaces:**
- Consumes: a migration da Task 3 (aplicada REAL no PG17 local).
- Produces: prova executada de que (a) dedupe UNIQUE morde (23505), (b) CHECKs mordem (23514), (c) RLS: staff lê, não-staff não lê, authenticated NÃO escreve no log (42501), (d) FALSIFICAÇÃO: sabotar a UNIQUE → teste de duplicata fica VERMELHO.

- [ ] **Step 1: Montar o harness** — invocar `prove-sql-money-path`; o teste precisa: aplicar `20260528160000_route_fundacao.sql`? NÃO (independente). Pré-requisitos mínimos: `user_roles`, `whatsapp_conversations` (FK) — criar stubs mínimos no setup do harness (id uuid pk basta para a FK).
- [ ] **Step 2: Asserts positivos** — INSERT template + send ok; segundo INSERT com MESMO `dedupe_key` → capturar SQLSTATE `23505` (re-lançar o resto — nunca `WHEN OTHERS THEN 'OK'`).
- [ ] **Step 3: Asserts negativos** — categoria `'promo'` → `23514`; status `'zumbi'` → `23514`.
- [ ] **Step 4: RLS sob SET ROLE** — `SET ROLE authenticated` + GUC `request.jwt.claims` com uid staff → SELECT vê seed; uid sem role → 0 rows; INSERT no log como authenticated → `42501` (psql cru é superuser e bypassaria — o SET ROLE é obrigatório).
- [ ] **Step 5: FALSIFICAR** — reaplicar schema SEM a UNIQUE de `dedupe_key` (sed na cópia) → o assert de duplicata DEVE falhar; restaurar e ver verde.
- [ ] **Step 6: Commit**

```bash
git add db/test-whatsapp-hsm.sh
git commit -m "test(whatsapp): prova PG17 do núcleo HSM — dedupe, CHECKs, RLS sob SET ROLE, falsificação"
```

---

### Task 5: Edge `whatsapp-send-template` (dedupe-first, opt-out enforced)

**Files:**
- Create: `supabase/functions/whatsapp-send-template/index.ts`

**Interfaces:**
- Consumes: helpers das Tasks 1-2 (espelhados verbatim, com comentário de espelho como no `whatsapp-inbound` atual), tabelas da Task 3, `authorizeCronOrStaff` de `../_shared/auth.ts`.
- Produces: `POST {templateNome, phoneE164?|conversationId?, bodyParams: string[], dedupeKey, origem?}` → `200 {ok, waMessageId, conversationId, persisted}` | `409 {error:'duplicate'|'opt_out'|'window...'}` | `404 template` | `400 validação` | `502 send_failed`. Consumido pelos PRs 4/5/6 do programa.

- [ ] **Step 1: Write the edge (código completo)**

```ts
// Edge: whatsapp-send-template — envio de template HSM (fora da janela de 24h).
// Regras: (1) só staff/service_role (cron 403 — o motor de rota entra via service_role no PR do disparo);
// (2) opt_out NUNCA recebe template (LGPD); (3) idempotência dedupe-first: reserva a dedupe_key
// no banco ANTES do POST — retry legítimo só re-envia registro 'failed'.
// Espelhos de src/lib/whatsapp/template-payload.ts e inbound.ts (Deno não importa do src/).
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const D360_BASE = Deno.env.get("D360_BASE_URL")!;
const D360_KEY = Deno.env.get("D360_API_KEY")!;

// --- espelho de src/lib/whatsapp/template-payload.ts ---
function sanitizeTemplateParam(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/[\n\r]+/g, ", ").replace(/\t/g, " ").replace(/ {2,}/g, " ").trim();
}
function validateBodyParams(params: string[], expected: number): string | null {
  if (params.length !== expected) return `template exige ${expected} parâmetro(s) de body; recebeu ${params.length}`;
  const vazio = params.findIndex((p) => sanitizeTemplateParam(p).length === 0);
  if (vazio >= 0) return `parâmetro ${vazio + 1} vazio pós-sanitize`;
  return null;
}
function buildTemplatePayload(input: { to: string; templateName: string; languageCode?: string; bodyParams: string[] }): Record<string, unknown> {
  const params = input.bodyParams.map((t) => ({ type: "text", text: sanitizeTemplateParam(t) }));
  const template: Record<string, unknown> = { name: input.templateName, language: { code: input.languageCode ?? "pt_BR" } };
  if (params.length > 0) template.components = [{ type: "body", parameters: params }];
  return { messaging_product: "whatsapp", to: input.to, type: "template", template };
}
function renderTemplatePreview(corpoReferencia: string, bodyParams: string[]): string {
  return corpoReferencia.replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const idx = Number(n) - 1;
    const v = bodyParams[idx];
    return v === undefined ? m : sanitizeTemplateParam(v);
  });
}
// --- espelho de src/lib/whatsapp/inbound.ts (waPhoneCandidates) ---
function waPhoneCandidates(input: string | null | undefined): string[] {
  if (!input) return [];
  let d = String(input).replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length < 10) return [];
  const out = new Set<string>([d]);
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length === 9 && rest.startsWith("9")) out.add(ddd + rest.slice(1));
  else if (rest.length === 8 && /^[6-9]/.test(rest)) out.add(ddd + "9" + rest);
  return [...out];
}

type Supa = ReturnType<typeof createClient>;

async function matchCustomer(supabase: Supa, fromPhone: string): Promise<string | null> {
  const cands = waPhoneCandidates(fromPhone);
  if (cands.length === 0) return null;
  const { data } = await supabase.from("profiles").select("user_id, phone").not("phone", "is", null);
  for (const p of (data ?? []) as Array<{ user_id: string; phone: string }>) {
    const pc = waPhoneCandidates(p.phone);
    if (pc.some((x) => cands.includes(x))) return p.user_id;
  }
  return null;
}

// find-or-create de conversa por telefone (mesma semântica do whatsapp-inbound).
async function resolveConversa(
  supabase: Supa,
  opts: { conversationId?: string; phoneE164?: string },
): Promise<{ id: string; phone_e164: string; opt_in_status: string } | { erro: string; status: number }> {
  if (opts.conversationId) {
    const { data, error } = await supabase.from("whatsapp_conversations")
      .select("id, phone_e164, opt_in_status").eq("id", opts.conversationId).maybeSingle();
    if (error || !data) return { erro: "conversa não encontrada", status: 404 };
    return data as { id: string; phone_e164: string; opt_in_status: string };
  }
  const phone = String(opts.phoneE164 ?? "");
  const phoneKey = waPhoneCandidates(phone)[0] ?? phone.replace(/\D/g, "");
  if (!phoneKey) return { erro: "telefone inválido", status: 400 };
  const { data: existing } = await supabase.from("whatsapp_conversations")
    .select("id, phone_e164, opt_in_status").eq("phone_key", phoneKey).maybeSingle();
  if (existing) return existing as { id: string; phone_e164: string; opt_in_status: string };
  const customerUserId = await matchCustomer(supabase, phone);
  let operatorId: string | null = null;
  if (customerUserId) {
    const { data: ca } = await supabase.from("carteira_assignments")
      .select("owner_user_id").eq("customer_user_id", customerUserId).limit(1).maybeSingle();
    operatorId = (ca as { owner_user_id?: string } | null)?.owner_user_id ?? null;
  }
  const { data: created, error: cErr } = await supabase.from("whatsapp_conversations").insert({
    phone_key: phoneKey, phone_e164: phone, customer_user_id: customerUserId,
    assigned_operator_id: operatorId, status: "aberta",
  }).select("id, phone_e164, opt_in_status").single();
  if (cErr || !created) return { erro: "falha ao criar conversa", status: 500 };
  return created as { id: string; phone_e164: string; opt_in_status: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;
  // Cron NÃO dispara template avulso — automação entra via service_role (motor de rota, PR posterior).
  if (auth.via === "cron") return json({ error: "forbidden", detail: "apenas staff ou service_role" }, 403);

  const body = await req.json().catch(() => ({}));
  const { templateNome, phoneE164, conversationId, dedupeKey } = body ?? {};
  const bodyParams: string[] = Array.isArray(body?.bodyParams) ? body.bodyParams.map(String) : [];
  const origem = ["manual", "proposta", "status_pedido", "rota"].includes(body?.origem) ? body.origem : "manual";
  if (!templateNome || !dedupeKey || (!phoneE164 && !conversationId)) {
    return json({ error: "templateNome, dedupeKey e (phoneE164 ou conversationId) obrigatórios" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: tpl, error: tErr } = await supabase.from("whatsapp_templates")
    .select("nome, categoria, idioma, corpo_referencia, num_body_params, ativo")
    .eq("nome", templateNome).maybeSingle();
  if (tErr || !tpl) return json({ error: "template não encontrado" }, 404);
  const t = tpl as { nome: string; idioma: string; corpo_referencia: string; num_body_params: number; ativo: boolean };
  if (!t.ativo) return json({ error: "template inativo (aguardando aprovação Meta?)" }, 409);

  const vErr = validateBodyParams(bodyParams, t.num_body_params);
  if (vErr) return json({ error: vErr }, 400);

  const conv = await resolveConversa(supabase, { conversationId, phoneE164 });
  if ("erro" in conv) return json({ error: conv.erro }, conv.status);
  // LGPD: opt_out NUNCA recebe proativo — nem template pago.
  if (conv.opt_in_status === "opt_out") return json({ error: "opt_out", detail: "cliente pediu PARAR" }, 409);

  // Idempotência dedupe-first: reserva ANTES do POST. Duplicata → 409 sem reenviar.
  // Registro anterior 'failed' → retry legítimo reutiliza a MESMA reserva.
  const insRes = await supabase.from("whatsapp_template_sends").insert({
    template_nome: t.nome, conversation_id: conv.id, phone_e164: conv.phone_e164,
    body_params: bodyParams, dedupe_key: dedupeKey, status: "queued", origem,
    disparado_por: auth.via === "staff" ? auth.userId : null,
  }).select("id").single();
  let sendId: string | null = (insRes.data as { id: string } | null)?.id ?? null;
  if (insRes.error) {
    const dup = insRes.error.code === "23505";
    if (!dup) return json({ error: "falha ao reservar envio", detail: insRes.error.message }, 500);
    const { data: existing } = await supabase.from("whatsapp_template_sends")
      .select("id, status, wa_message_id").eq("dedupe_key", dedupeKey).single();
    const ex = existing as { id: string; status: string; wa_message_id: string | null } | null;
    if (!ex || ex.status !== "failed") {
      return json({ error: "duplicate", detail: "dedupe_key já usada", existing: ex }, 409);
    }
    sendId = ex.id; // retry de envio que falhou: reusa a reserva
  }

  const to = conv.phone_e164.replace(/\D/g, "");
  const payload = buildTemplatePayload({ to, templateName: t.nome, languageCode: t.idioma, bodyParams });
  const resp = await fetch(`${D360_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "D360-API-KEY": D360_KEY },
    body: JSON.stringify(payload),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("[whatsapp-send-template] 360dialog erro", resp.status, result);
    await supabase.from("whatsapp_template_sends")
      .update({ status: "failed", erro: `HTTP ${resp.status} ${JSON.stringify(result).slice(0, 500)}` })
      .eq("id", sendId!);
    return json({ error: "send_failed", status: resp.status, detail: result }, 502);
  }

  const waId = (result as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id ?? null;
  const nowIso = new Date().toISOString();
  // Mensagem JÁ saiu: falha de persistência não falha o request (logar alto), padrão do whatsapp-send.
  const { error: updErr } = await supabase.from("whatsapp_template_sends")
    .update({ status: "sent", wa_message_id: waId, erro: null }).eq("id", sendId!);
  const preview = renderTemplatePreview(t.corpo_referencia, bodyParams);
  const { error: msgErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id: conv.id, wa_message_id: waId, direction: "out", type: "template",
    body: preview, status: "sent", sender_user_id: auth.via === "staff" ? auth.userId : null, wa_timestamp: nowIso,
  });
  const { error: convErr } = await supabase.from("whatsapp_conversations")
    .update({ last_message_at: nowIso, status: "aguardando_cliente" }).eq("id", conv.id);
  if (updErr || msgErr || convErr) {
    console.error("[whatsapp-send-template] persistência falhou (msg já enviada)", updErr, msgErr, convErr);
  }
  return json({ ok: true, wa_message_id: waId, conversationId: conv.id, persisted: !updErr && !msgErr && !convErr });
});
```

- [ ] **Step 2: Typecheck do repo (a edge é Deno; o typecheck do app não a cobre — validação é lint visual + deploy). Rodar mesmo assim para garantir que nada do src/ quebrou**

Run: `heavy bun run typecheck > /tmp/t5.log 2>&1; echo $?`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/whatsapp-send-template/index.ts
git commit -m "feat(whatsapp): edge whatsapp-send-template — HSM dedupe-first com opt-out enforced"
```

---

### Task 6: Edge `whatsapp-inbound` — processar `value.statuses` (retorno de entrega)

**Files:**
- Modify: `supabase/functions/whatsapp-inbound/index.ts`

**Interfaces:**
- Consumes: helpers da Task 2 (espelho), tabelas da Task 3.
- Produces: statuses do webhook atualizam `whatsapp_messages.status` e `whatsapp_template_sends.status/erro` com progressão monotônica.

- [ ] **Step 1: Adicionar o espelho + processamento**

Após `parseInboundWebhook` (espelho existente), adicionar o espelho de `parseStatusWebhook`/`isStatusUpgrade` (código da Task 2, sintaxe Deno idêntica). No handler, após o loop de `messages`, acrescentar dentro do MESMO `work` (waitUntil):

```ts
// Statuses (retorno de entrega das mensagens OUT — sent/delivered/read/failed).
const statuses = parseStatusWebhook(payload);
for (const s of statuses) {
  try {
    const { data: msg } = await supabase.from("whatsapp_messages")
      .select("id, status").eq("wa_message_id", s.waMessageId).maybeSingle();
    const m = msg as { id: string; status: string | null } | null;
    if (m && isStatusUpgrade(m.status, s.status)) {
      await supabase.from("whatsapp_messages").update({ status: s.status }).eq("id", m.id);
    }
    const { data: send } = await supabase.from("whatsapp_template_sends")
      .select("id, status").eq("wa_message_id", s.waMessageId).maybeSingle();
    const sd = send as { id: string; status: string } | null;
    if (sd && isStatusUpgrade(sd.status, s.status)) {
      await supabase.from("whatsapp_template_sends")
        .update({ status: s.status, erro: s.erro }).eq("id", sd.id);
    }
  } catch (e) {
    console.error("[whatsapp-inbound] processStatus", e);
  }
}
```

E ajustar a resposta final para `{ ok: true, received: messages.length, statuses: statuses.length }`.

- [ ] **Step 2: Rodar os testes do espelho src (garantem a lógica; o edge é cópia verbatim)**

Run: `heavy bunx vitest run src/lib/whatsapp/inbound.test.ts > /tmp/t6.log 2>&1; echo $?`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/whatsapp-inbound/index.ts
git commit -m "feat(whatsapp): inbound processa statuses do webhook (entrega/leitura/falha, monotônico)"
```

---

### Task 7: Doc durável do programa (benchmark → programa aprovado)

**Files:**
- Create: `docs/historico/programa-canal-whatsapp.md`
- Modify: `docs/historico/README.md` (1 linha no índice)

- [ ] **Step 1: Escrever o doc** — conteúdo: fontes do benchmark (links), tabela de gaps com evidência, parecer do Codex (síntese fiel + caminho do cru), programa PR-1..PR-6 + épicos com estados (PR-1 🔄 este PR), decisões de fronteira (não copiar: Pix, multi-agente, loja aberta; identidade B2B = contato+CNPJ+carteira; estados honestos de rota), e AÇÕES EXTERNAS do founder (submeter templates na 360dialog p/ aprovação Meta; ativar com `UPDATE whatsapp_templates SET ativo = true WHERE nome = '...'`).
- [ ] **Step 2: Commit**

```bash
git add docs/historico/programa-canal-whatsapp.md docs/historico/README.md
git commit -m "docs(whatsapp): programa Canal WhatsApp (benchmark Lu/Magalu) — gaps, parecer Codex e fases"
```

---

### Task 8: Verificação final + PR + handoff Lovable

- [ ] **Step 1:** `bun install` concluído? (worktree novo) → `ls node_modules/.bin/vitest >/dev/null 2>&1; echo $?` — se ≠0, aguardar o install em background do vigia.
- [ ] **Step 2:** Suite completa: `heavy bun run test > /tmp/test.log 2>&1; echo $?` e `heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?` e `bun lint > /tmp/lint.log 2>&1; echo $?` — todos exit 0.
- [ ] **Step 3:** Push + PR não-draft (`gh pr create`) com corpo: o que muda, prova PG17, handoff (🟣 migration SQL Editor via ritual `lovable-db-operator` · 💬 deploy das 2 edges pelo chat do Lovable · 📱 submeter/aprovar templates na 360dialog e ativar no catálogo · sem Publish).
- [ ] **Step 4:** Armar `scripts/pr-watch.sh <nº>` em background + PushNotification no desfecho.

---

## Arco do programa (contexto — não são tasks deste plano)

Espinha aprovada (founder, 2026-07-12; ordem do Codex gpt-5.6-sol endossada): **PR-1 núcleo HSM (este) → PR-2 fila respondeu→topo → PR-3 funil do canal → PR-4 proposta 1-toque (recotação Omie; prove-sql+Codex) → PR-5 status transacional v0 → PR-6 motor de disparo por rota (spec PR2b; prove-sql+Codex)**. Épicos: áudio→rascunho; pedido conversacional (KB + Flows dentro; autonomia por níveis); 2ª via boleto condicional. Cortado: Pix in-chat, orquestrador multi-agente, loja conversacional aberta. 1 entrega = 1 sessão (handoff entre PRs via `/handoff-sessao`).
