# SLA de resposta do WhatsApp — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Indicador + alerta de "tempo sem resposta" no WhatsApp, escopado por vendedora dona do cliente (card na Meu Dia + badge na sidebar + selo no inbox + painel de supervisão), com digest diário por e-mail pro founder.

**Architecture:** SQL é a fonte única — uma função `whatsapp_minutos_uteis` (minutos de expediente) + uma view `v_whatsapp_sla` (conversa esperando → desde quando, quantos minutos, nível). O front só lê e exibe (Realtime já ligado + refetch 30s). Digest = cron SQL local → `fornecedor_alerta` → `dispatch-notifications`. **2 fases:** F1 (função+view+telas, sem edge) e F2 (digest+e-mail).

**Tech Stack:** Postgres (plpgsql, views security_invoker), Supabase, React 18 + TS + React Query, vitest, Tailwind tokens `status-*`, PostgreSQL 17 local pra validar SQL.

**Referências:** spec `docs/superpowers/specs/2026-06-04-whatsapp-sla-resposta-design.md` · padrão de hook `src/queries/useWhatsappInbox.ts` · stop-keyword `src/lib/whatsapp/stop-keyword.ts` · responsável efetivo `supabase/migrations/20260528132000_tarefas_bloco_c.sql:6-31` · `fornecedor_alerta` CHECK `20260528133000_tarefas_bloco_d.sql:18` · harness PG17 `db/verify-snapshot-replay.sh`.

> **⚠️ Aplicação de migration é MANUAL** (Lovable não aplica migration custom). Os blocos SQL vão pro SQL Editor (ritual `lovable-db-operator`). Edge `dispatch-notifications` (só F2) edita-se pelo chat do Lovable.

---

## Estrutura de arquivos

**Criar:**
- `supabase/migrations/20260604130000_whatsapp_sla.sql` — F1: `wa_is_stop_keyword`, `whatsapp_minutos_uteis`, view `v_whatsapp_sla`, seed de config.
- `supabase/migrations/20260604140000_whatsapp_sla_digest.sql` — F2: `whatsapp_sla_digest_log`, `whatsapp_sla_digest_tick`, cron, extensão do CHECK de `fornecedor_alerta.tipo`.
- `db/test-whatsapp-sla.sql` — seed + asserts pra rodar em PG17 local.
- `src/lib/whatsapp/sla-format.ts` (+ `src/lib/whatsapp/__tests__/sla-format.test.ts`).
- `src/queries/useWhatsappSla.ts`.
- `src/components/whatsapp/SlaBadge.tsx`.
- `src/components/whatsapp/SlaCardMeuDia.tsx`.
- `src/pages/WhatsappSlaSupervisao.tsx`.

**Modificar:**
- `src/pages/WhatsappInbox.tsx` — selo de tempo na lista de conversas.
- `src/components/dashboard/FarmerDashboardV2.tsx` — montar o card de Meu Dia.
- `src/components/AppShell.tsx` — badge na sidebar + item de menu da supervisão.
- `src/App.tsx` — rota `/whatsapp/sla`.

---

## FASE 1 — Função + view + telas (sem edge, sem e-mail)

### Task 1: Helper TS de formatação (`sla-format.ts`)

**Files:**
- Create: `src/lib/whatsapp/sla-format.ts`
- Test: `src/lib/whatsapp/__tests__/sla-format.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/whatsapp/__tests__/sla-format.test.ts
import { describe, it, expect } from 'vitest';
import { formatSlaWait, slaNivelClasses } from '../sla-format';

describe('formatSlaWait', () => {
  it('zero e negativo → "0 min"', () => {
    expect(formatSlaWait(0)).toBe('0 min');
    expect(formatSlaWait(-5)).toBe('0 min');
    expect(formatSlaWait(NaN)).toBe('0 min');
  });
  it('abaixo de 1h → minutos', () => {
    expect(formatSlaWait(18)).toBe('18 min');
    expect(formatSlaWait(59)).toBe('59 min');
    expect(formatSlaWait(18.9)).toBe('18 min'); // floor
  });
  it('1h ou mais → "Hh" / "HhMM"', () => {
    expect(formatSlaWait(60)).toBe('1h');
    expect(formatSlaWait(65)).toBe('1h05');
    expect(formatSlaWait(125)).toBe('2h05');
    expect(formatSlaWait(130)).toBe('2h10');
  });
});

describe('slaNivelClasses', () => {
  it('mapeia nível → classes de status', () => {
    expect(slaNivelClasses('vermelho')).toContain('text-status-error');
    expect(slaNivelClasses('amarelo')).toContain('text-status-warning');
    expect(slaNivelClasses('verde')).toContain('text-status-success');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test src/lib/whatsapp/__tests__/sla-format.test.ts`
Expected: FAIL ("Cannot find module '../sla-format'").

- [ ] **Step 3: Implementar**

```ts
// src/lib/whatsapp/sla-format.ts
export type SlaNivel = 'verde' | 'amarelo' | 'vermelho';

/** Minutos → "18 min" / "1h" / "1h05". <=0 ou inválido → "0 min". */
export function formatSlaWait(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos <= 0) return '0 min';
  const m = Math.floor(minutos);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, '0')}`;
}

/** Classes Tailwind de status por nível (tokens do design system; nunca text-emerald-*). */
export function slaNivelClasses(nivel: SlaNivel): string {
  switch (nivel) {
    case 'vermelho': return 'text-status-error bg-status-error-bg';
    case 'amarelo': return 'text-status-warning bg-status-warning-bg';
    default: return 'text-status-success bg-status-success-bg';
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test src/lib/whatsapp/__tests__/sla-format.test.ts`
Expected: PASS (todos os casos).

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/sla-format.ts src/lib/whatsapp/__tests__/sla-format.test.ts
git commit -m "feat(whatsapp-sla): helper puro de formatação de tempo + cor por nível"
```

---

### Task 2: SQL — `wa_is_stop_keyword` + `whatsapp_minutos_uteis`

**Files:**
- Create: `supabase/migrations/20260604130000_whatsapp_sla.sql` (parte 1 — funções)
- Create: `db/test-whatsapp-sla.sql` (parte 1 — asserts da função)

- [ ] **Step 1: Escrever os asserts da função (teste que falha)**

```sql
-- db/test-whatsapp-sla.sql  (rodar num PG17 que já tem a migration aplicada)
-- ===== Função de minutos-úteis: expediente seg-sex 07:30-17:30 America/Sao_Paulo =====
DO $$
BEGIN
  -- mesmo instante / invertido → 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T12:00:00-03','2026-06-04T12:00:00-03') = 0, 'mesmo instante';
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T13:00:00-03','2026-06-04T12:00:00-03') = 0, 'invertido';
  -- 09:00 → 09:30 numa quinta = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T09:00:00-03','2026-06-04T09:30:00-03') = 30, '30 min dentro do expediente';
  -- 17:00 → 18:00 (sexta): só conta até 17:30 = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-05T17:00:00-03','2026-06-05T18:00:00-03') = 30, 'clamp no fim do expediente';
  -- 06:00 → 08:00 (quinta): só conta de 07:30 = 30 min
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T06:00:00-03','2026-06-04T08:00:00-03') = 30, 'clamp no início do expediente';
  -- atravessa a noite: qui 17:00 → sex 08:00 = 30 (qui 17:00-17:30) + 30 (sex 07:30-08:00) = 60
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T17:00:00-03','2026-06-05T08:00:00-03') = 60, 'atravessa a noite';
  -- só fim de semana: sáb 09:00 → dom 18:00 = 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-06T09:00:00-03','2026-06-07T18:00:00-03') = 0, 'fim de semana = 0';
  -- inteiro fora do expediente: qui 19:00 → qui 22:00 = 0
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T19:00:00-03','2026-06-04T22:00:00-03') = 0, 'fora do expediente';
  -- sex 17:00 → seg 08:00: sex 30 (17:00-17:30) + fim de semana 0 + seg 30 (07:30-08:00) = 60
  ASSERT public.whatsapp_minutos_uteis('2026-06-05T17:00:00-03','2026-06-08T08:00:00-03') = 60, 'pula o fim de semana';
  -- dia útil cheio: qui 07:30 → qui 17:30 = 600
  ASSERT public.whatsapp_minutos_uteis('2026-06-04T07:30:00-03','2026-06-04T17:30:00-03') = 600, 'dia cheio = 600';
  RAISE NOTICE 'OK: whatsapp_minutos_uteis (10 asserts)';
END $$;
-- ===== stop-keyword =====
DO $$
BEGIN
  ASSERT public.wa_is_stop_keyword('PARAR') = true, 'PARAR';
  ASSERT public.wa_is_stop_keyword('  sair ') = true, 'sair com espaço';
  ASSERT public.wa_is_stop_keyword('CANCELAR!') = true, 'CANCELAR com pontuação';
  ASSERT public.wa_is_stop_keyword('quero parar de receber promoção') = false, 'parar numa frase';
  ASSERT public.wa_is_stop_keyword('qual o preço?') = false, 'pergunta real';
  ASSERT public.wa_is_stop_keyword(NULL) = false, 'null';
  RAISE NOTICE 'OK: wa_is_stop_keyword (6 asserts)';
END $$;
```

- [ ] **Step 2: Rodar e ver falhar (funções não existem)**

Boot PG17 + schema-snapshot, depois roda o teste:
```bash
# (segue o padrão de db/verify-snapshot-replay.sh; só não aplica a migration ainda)
psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql
```
Expected: FAIL ("function public.whatsapp_minutos_uteis(...) does not exist").

- [ ] **Step 3: Implementar as funções na migration**

```sql
-- supabase/migrations/20260604130000_whatsapp_sla.sql  (PARTE 1)
-- ============================================================================
-- SLA de resposta do WhatsApp — funções base
-- ============================================================================

-- stop-keyword: espelha src/lib/whatsapp/stop-keyword.ts (lista canônica).
-- Só dispara quando a mensagem É a palavra (1 token), não numa frase.
create or replace function public.wa_is_stop_keyword(p_body text)
returns boolean
language sql
immutable
as $$
  select case
    when p_body is null then false
    else trim(upper(regexp_replace(p_body, '[^A-Za-z ]', '', 'g')))
         in ('PARAR','SAIR','STOP','CANCELAR','DESCADASTRAR')
  end;
$$;

-- minutos de expediente entre dois instantes (default seg-sex 07:30-17:30 SP).
-- Semântica meio-aberta [desde, ate) ∩ [h_inicio, h_fim) por dia útil.
create or replace function public.whatsapp_minutos_uteis(
  p_desde     timestamptz,
  p_ate       timestamptz,
  p_h_inicio  time   default '07:30',
  p_h_fim     time   default '17:30',
  p_dias      int[]  default array[1,2,3,4,5]   -- ISO DOW: 1=seg … 7=dom
) returns integer
language plpgsql
stable
as $$
declare
  v_total   interval := interval '0';
  v_dia     date;
  v_dia_fim date;
  v_jan_ini timestamptz;
  v_jan_fim timestamptz;
  v_ov_ini  timestamptz;
  v_ov_fim  timestamptz;
  v_guard   int := 0;
begin
  if p_desde is null or p_ate is null or p_desde >= p_ate then
    return 0;
  end if;
  v_dia     := (p_desde at time zone 'America/Sao_Paulo')::date;
  v_dia_fim := (p_ate   at time zone 'America/Sao_Paulo')::date;
  while v_dia <= v_dia_fim loop
    v_guard := v_guard + 1;
    exit when v_guard > 400;  -- guard anti-loop p/ conversa órfã de anos (já estaria no vermelho)
    if extract(isodow from v_dia)::int = any(p_dias) then
      v_jan_ini := (v_dia + p_h_inicio) at time zone 'America/Sao_Paulo';
      v_jan_fim := (v_dia + p_h_fim)    at time zone 'America/Sao_Paulo';
      v_ov_ini  := greatest(p_desde, v_jan_ini);
      v_ov_fim  := least(p_ate, v_jan_fim);
      if v_ov_fim > v_ov_ini then
        v_total := v_total + (v_ov_fim - v_ov_ini);
      end if;
    end if;
    v_dia := v_dia + 1;
  end loop;
  return floor(extract(epoch from v_total) / 60)::int;
end;
$$;
```

- [ ] **Step 4: Rodar e ver passar**

Boot PG17 + snapshot + aplica a migration + roda o teste:
```bash
psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260604130000_whatsapp_sla.sql
psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql
```
Expected: `NOTICE: OK: whatsapp_minutos_uteis (10 asserts)` + `NOTICE: OK: wa_is_stop_keyword (6 asserts)`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260604130000_whatsapp_sla.sql db/test-whatsapp-sla.sql
git commit -m "feat(whatsapp-sla): funções SQL minutos-úteis + stop-keyword (TDD em PG17)"
```

---

### Task 3: SQL — view `v_whatsapp_sla`

**Files:**
- Modify: `supabase/migrations/20260604130000_whatsapp_sla.sql` (parte 2 — view + seed)
- Modify: `db/test-whatsapp-sla.sql` (parte 2 — asserts da view)

- [ ] **Step 1: Escrever os asserts da view (semeando conversas/mensagens/carteira)**

Adicionar ao fim de `db/test-whatsapp-sla.sql`:
```sql
-- ===== View v_whatsapp_sla: cenários de "esperando" =====
-- usa um "agora" fixo (quinta 2026-06-04 10:00 SP) via override? Não dá pra mockar now() na view.
-- Em vez disso semeamos com instantes RELATIVOS a now() pra os asserts serem estáveis.
DO $$
DECLARE
  v_vend uuid := gen_random_uuid();   -- vendedora dona
  v_cli  uuid := gen_random_uuid();   -- cliente (profile)
  c_espera uuid; c_bola uuid; c_fechada uuid; c_stop uuid; c_semdono uuid;
  v_min int; v_nivel text; v_n int;
BEGIN
  -- carteira: cliente -> vendedora
  insert into public.carteira_assignments(customer_user_id, owner_user_id, source)
    values (v_cli, v_vend, 'omie');

  -- C1: cliente mandou msg "agora - 40 min de relógio real" e ninguém respondeu → esperando
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k1','5599000000001', v_cli, 'aberta') returning id into c_espera;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_espera,'in','text','qual o preço do verniz?', now() - interval '40 minutes');

  -- C2: cliente mandou, vendedora HUMANA respondeu depois → bola com o cliente (fora)
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k2','5599000000002', v_cli, 'aguardando_cliente') returning id into c_bola;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_bola,'in','text','oi', now() - interval '60 minutes');
  insert into public.whatsapp_messages(conversation_id, direction, type, body, sender_user_id, wa_timestamp)
    values (c_bola,'out','text','respondido', v_vend, now() - interval '30 minutes');

  -- C3: igual C1 mas conversa FECHADA → fora
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k3','5599000000003', v_cli, 'fechada') returning id into c_fechada;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_fechada,'in','text','pergunta', now() - interval '40 minutes');

  -- C4: único inbound é stop-keyword → fora
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k4','5599000000004', v_cli, 'aberta') returning id into c_stop;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_stop,'in','text','PARAR', now() - interval '40 minutes');

  -- C5: cliente sem cadastro (customer_user_id null) → esperando, mas SEM DONO
  insert into public.whatsapp_conversations(phone_key, phone_e164, customer_user_id, status)
    values ('k5','5599000000005', null, 'aberta') returning id into c_semdono;
  insert into public.whatsapp_messages(conversation_id, direction, type, body, wa_timestamp)
    values (c_semdono,'in','text','tem em estoque?', now() - interval '40 minutes');

  -- C6 (anti-template): conversa onde a "resposta" foi blast de template SEM sender → ainda esperando
  -- (sender_user_id NULL não conta como resposta humana)
  insert into public.whatsapp_messages(conversation_id, direction, type, body, sender_user_id, wa_timestamp)
    values (c_espera,'out','template','[promo]', null, now() - interval '20 minutes');

  -- ASSERTS
  -- C1 está na view e é da vendedora
  SELECT count(*) INTO v_n FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_n = 1, 'C1 deve estar esperando (template sem sender não respondeu)';
  SELECT owner_user_id INTO v_vend FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_vend IS NOT NULL, 'C1 tem dono derivado da carteira';
  -- C2/C3/C4 fora
  ASSERT NOT EXISTS (SELECT 1 FROM public.v_whatsapp_sla WHERE conversation_id IN (c_bola,c_fechada,c_stop)),
    'C2 (bola), C3 (fechada), C4 (stop) NÃO esperam';
  -- C5 esperando e sem dono
  SELECT owner_user_id INTO v_vend FROM public.v_whatsapp_sla WHERE conversation_id = c_semdono;
  ASSERT v_vend IS NULL, 'C5 é sem dono';
  -- minutos > 0 (passou ~40 min de relógio; em expediente conta integral, fora conta parcial — só checa > 0)
  SELECT minutos_uteis_aguardando, nivel INTO v_min, v_nivel FROM public.v_whatsapp_sla WHERE conversation_id = c_espera;
  ASSERT v_min >= 0, 'C1 tem minutos >= 0';
  RAISE NOTICE 'OK: v_whatsapp_sla (cenários esperando/bola/fechada/stop/sem-dono/template) min=% nivel=%', v_min, v_nivel;
END $$;
```

> Nota: os asserts de NÍVEL exato (amarelo/vermelho) dependem de `now()` e do expediente atual; por isso o teste valida a PRESENÇA/ausência na view e o dono, não o número exato (o número exato já é coberto pelos 10 asserts determinísticos da função na Task 2).

- [ ] **Step 2: Rodar e ver falhar (view não existe)**

Run: `psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql`
Expected: FAIL ("relation public.v_whatsapp_sla does not exist").

- [ ] **Step 3: Implementar a view + seed de config na migration**

Adicionar ao fim de `supabase/migrations/20260604130000_whatsapp_sla.sql`:
```sql
-- ============================================================================
-- PARTE 2 — config + view
-- ============================================================================

-- Config global (company_config é key-value text). Idempotente.
insert into public.company_config(key, value) values
  ('whatsapp_sla_hora_inicio', '07:30'),
  ('whatsapp_sla_hora_fim',    '17:30'),
  ('whatsapp_sla_dias',        '1,2,3,4,5'),
  ('whatsapp_sla_atencao_min', '15'),
  ('whatsapp_sla_atrasado_min','30'),
  ('whatsapp_sla_digest_habilitado', 'true')
on conflict (key) do nothing;

create or replace view public.v_whatsapp_sla
with (security_invoker = on) as
with cfg as (
  select
    coalesce((select value from public.company_config where key='whatsapp_sla_hora_inicio'), '07:30')::time as h_inicio,
    coalesce((select value from public.company_config where key='whatsapp_sla_hora_fim'),    '17:30')::time as h_fim,
    coalesce((select string_to_array(value, ',')::int[] from public.company_config where key='whatsapp_sla_dias'),
             array[1,2,3,4,5]) as dias,
    coalesce((select value::int from public.company_config where key='whatsapp_sla_atencao_min'), 15) as atencao_min,
    coalesce((select value::int from public.company_config where key='whatsapp_sla_atrasado_min'), 30) as atrasado_min
),
-- última resposta HUMANA por conversa (out com sender_user_id; exclui blast/IA e template automático)
last_out as (
  select distinct on (conversation_id)
    conversation_id,
    coalesce(wa_timestamp, created_at) as ts,
    id
  from public.whatsapp_messages
  where direction = 'out' and sender_user_id is not null
  order by conversation_id, coalesce(wa_timestamp, created_at) desc, id desc
),
-- primeira mensagem do cliente ainda não respondida (exclui stop-keyword)
aguardando as (
  select distinct on (i.conversation_id)
    i.conversation_id,
    coalesce(i.wa_timestamp, i.created_at) as aguardando_desde
  from public.whatsapp_messages i
  left join last_out lo on lo.conversation_id = i.conversation_id
  where i.direction = 'in'
    and not public.wa_is_stop_keyword(i.body)
    and (lo.conversation_id is null
         or (coalesce(i.wa_timestamp, i.created_at), i.id) > (lo.ts, lo.id))
  order by i.conversation_id, coalesce(i.wa_timestamp, i.created_at) asc, i.id asc
),
-- responsável efetivo (dono da carteira + cobertura/férias) — espelha v_tarefas_estado
owner as (
  select c.id as conversation_id,
    coalesce(
      (select cc.covering_user_id from public.carteira_coverage cc
        where cc.covered_user_id = ca.owner_user_id and cc.active
          and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
        order by cc.valid_from desc limit 1),
      ca.owner_user_id
    ) as owner_user_id
  from public.whatsapp_conversations c
  left join lateral (
    select owner_user_id from public.carteira_assignments
    where customer_user_id = c.customer_user_id and eligible
    order by valid_from desc limit 1
  ) ca on true
),
calc as (
  select a.conversation_id, a.aguardando_desde,
    public.whatsapp_minutos_uteis(a.aguardando_desde, now(), cfg.h_inicio, cfg.h_fim, cfg.dias) as minutos
  from aguardando a cross join cfg
)
select
  calc.conversation_id,
  conv.customer_user_id,
  conv.phone_e164,
  conv.contact_name,
  o.owner_user_id,
  calc.aguardando_desde,
  calc.minutos as minutos_uteis_aguardando,
  case
    when calc.minutos >= cfg.atrasado_min then 'vermelho'
    when calc.minutos >= cfg.atencao_min  then 'amarelo'
    else 'verde'
  end as nivel
from calc
join public.whatsapp_conversations conv on conv.id = calc.conversation_id
join owner o on o.conversation_id = calc.conversation_id
cross join cfg
where conv.status <> 'fechada';
```

- [ ] **Step 4: Rodar e ver passar**

Run: `psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260604130000_whatsapp_sla.sql && psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql`
Expected: `NOTICE: OK: v_whatsapp_sla (...)`.

> Se a migration falhar com "relation whatsapp_conversations/carteira_coverage does not exist", o `schema-snapshot.sql` está stale pra essas tabelas → aplicar antes `supabase/migrations/20260528140000_whatsapp_fundacao.sql` no PG17 de teste (padrão do picking-bridge: snapshot + patch das migrations mais novas que o snapshot).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260604130000_whatsapp_sla.sql db/test-whatsapp-sla.sql
git commit -m "feat(whatsapp-sla): view v_whatsapp_sla (esperando/dono ao vivo/limiares) + seed config"
```

---

### Task 4: Hook `useWhatsappSla`

**Files:**
- Create: `src/queries/useWhatsappSla.ts`

- [ ] **Step 1: Implementar o hook (espelha useWhatsappInbox: cast pra tabela fora do types.ts + Realtime + refetch)**

```ts
// src/queries/useWhatsappSla.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SlaNivel } from '@/lib/whatsapp/sla-format';

export interface WaSlaRow {
  conversation_id: string;
  customer_user_id: string | null;
  phone_e164: string | null;
  contact_name: string | null;
  owner_user_id: string | null;
  aguardando_desde: string;
  minutos_uteis_aguardando: number;
  nivel: SlaNivel;
}

// v_whatsapp_sla não está no types.ts gerado — mesmo cast de useWhatsappInbox.ts.
function waSelectAll(view: string) {
  const client = supabase as unknown as {
    from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
  };
  return client.from(view).select('*');
}

export function useWhatsappSla() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['whatsapp', 'sla'],
    queryFn: async () => {
      const res = await (waSelectAll('v_whatsapp_sla') as PromiseLike<{ data: unknown; error: { message: string } | null }>);
      if (res.error) throw new Error(res.error.message);
      return (res.data ?? []) as WaSlaRow[];
    },
    refetchInterval: 30000, // "tiquetaqueia" o contador (now() na view dá minutos frescos a cada fetch)
    staleTime: 15000,
  });
  // Realtime: qualquer mensagem/conversa nova revalida o SLA na hora.
  useEffect(() => {
    const ch = supabase.channel('wa-sla')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'sla'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' },
        () => qc.invalidateQueries({ queryKey: ['whatsapp', 'sla'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);
  return q;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (sem erros novos).

- [ ] **Step 3: Commit**

```bash
git add src/queries/useWhatsappSla.ts
git commit -m "feat(whatsapp-sla): hook useWhatsappSla (view + Realtime + refetch 30s)"
```

---

### Task 5: Componente `SlaBadge`

**Files:**
- Create: `src/components/whatsapp/SlaBadge.tsx`

- [ ] **Step 1: Implementar**

```tsx
// src/components/whatsapp/SlaBadge.tsx
import { cn } from '@/lib/utils';
import { formatSlaWait, slaNivelClasses, type SlaNivel } from '@/lib/whatsapp/sla-format';

export function SlaBadge({ minutos, nivel, className }: { minutos: number; nivel: SlaNivel; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums', slaNivelClasses(nivel), className)}>
      esperando há {formatSlaWait(minutos)}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.
```bash
git add src/components/whatsapp/SlaBadge.tsx
git commit -m "feat(whatsapp-sla): componente SlaBadge (tempo + cor por nível)"
```

---

### Task 6: Selo no inbox (`WhatsappInbox.tsx`)

**Files:**
- Modify: `src/pages/WhatsappInbox.tsx`

- [ ] **Step 1: Modificar a lista de conversas pra mostrar o selo**

Adicionar o import e o uso do hook + Map; modificar o `<button>` da lista. Substituir o corpo do componente por:
```tsx
// src/pages/WhatsappInbox.tsx  (modificação)
import { useMemo, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useWhatsappConversations, useWhatsappThread } from '@/queries/useWhatsappInbox';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { SlaBadge } from '@/components/whatsapp/SlaBadge';
import { useSendWhatsapp } from '@/hooks/useSendWhatsapp';
import { formatBrPhone } from '@/lib/phone';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';

export default function WhatsappInbox() {
  const { data: conversations = [] } = useWhatsappConversations();
  const { data: slaRows = [] } = useWhatsappSla();
  const slaByConv = useMemo(
    () => new Map(slaRows.map((r) => [r.conversation_id, r])),
    [slaRows],
  );
  const [activeId, setActiveId] = useState<string | undefined>();
  const { data: messages = [] } = useWhatsappThread(activeId);
  const send = useSendWhatsapp(activeId);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      <aside className="w-80 border-r overflow-y-auto">
        {conversations.length === 0 ? (
          <EmptyState tone="operational" icon={MessageCircle} title="Sem conversas"
            description="As conversas aparecem quando um cliente responde." />
        ) : conversations.map((c) => {
          const sla = slaByConv.get(c.id);
          return (
            <button key={c.id} onClick={() => setActiveId(c.id)}
              className={`block w-full text-left p-3 border-b hover:bg-muted ${activeId === c.id ? 'bg-muted' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium truncate">{c.contact_name ?? formatBrPhone(c.phone_e164)}</div>
                {sla && <SlaBadge minutos={sla.minutos_uteis_aguardando} nivel={sla.nivel} />}
              </div>
              <div className="text-xs text-muted-foreground">{c.status}{c.customer_user_id ? '' : ' · sem cadastro'}</div>
            </button>
          );
        })}
      </aside>
      <main className="flex-1 flex flex-col">
        {!activeId ? (
          <EmptyState tone="operational" icon={MessageCircle} title="Selecione uma conversa" description="" />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`max-w-[70%] rounded p-2 text-sm ${m.direction === 'out' ? 'ml-auto bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  {m.type === 'text' ? m.body : `[${m.type}]`}
                </div>
              ))}
            </div>
            <form className="p-3 border-t flex gap-2"
              onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) send.mutate(t, { onSuccess: () => setDraft('') }); }}>
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Responder…" />
              <Button type="submit" disabled={send.isPending}>Enviar</Button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint + commit**

Run: `bun run typecheck && bun lint`
Expected: PASS.
```bash
git add src/pages/WhatsappInbox.tsx
git commit -m "feat(whatsapp-sla): selo 'esperando há Xmin' na lista do inbox"
```

---

### Task 7: Card de Meu Dia da vendedora + toggle Minhas/Todas

**Files:**
- Create: `src/components/whatsapp/SlaCardMeuDia.tsx`
- Modify: `src/components/dashboard/FarmerDashboardV2.tsx`

- [ ] **Step 1: Implementar o card**

```tsx
// src/components/whatsapp/SlaCardMeuDia.tsx
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useWhatsappSla } from '@/queries/useWhatsappSla';
import { formatSlaWait } from '@/lib/whatsapp/sla-format';

export function SlaCardMeuDia() {
  const { user } = useAuth();
  const { data: rows = [] } = useWhatsappSla();
  const [escopo, setEscopo] = useState<'minhas' | 'todas'>('minhas');

  const visiveis = useMemo(() => {
    const base = escopo === 'minhas' ? rows.filter((r) => r.owner_user_id === user?.id) : rows;
    return [...base].sort((a, b) => b.minutos_uteis_aguardando - a.minutos_uteis_aguardando);
  }, [rows, escopo, user?.id]);

  const vermelhos = visiveis.filter((r) => r.nivel === 'vermelho').length;
  const pior = visiveis[0];
  if (rows.length === 0) return null;

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageCircle className={`w-4 h-4 ${vermelhos > 0 ? 'text-status-error' : 'text-status-warning'}`} />
          <h2 className="text-sm font-semibold">Clientes sem resposta no WhatsApp</h2>
        </div>
        <div className="flex rounded-md border text-2xs overflow-hidden">
          {(['minhas', 'todas'] as const).map((e) => (
            <button key={e} onClick={() => setEscopo(e)}
              className={`px-2 py-0.5 ${escopo === e ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
              {e === 'minhas' ? 'Minhas' : 'Todas'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {visiveis.length === 0
          ? 'Nenhum cliente esperando. 👌'
          : <>{visiveis.length} cliente(s) esperando{vermelhos > 0 ? ` · ${vermelhos} atrasado(s)` : ''}{pior ? ` · pior: ${formatSlaWait(pior.minutos_uteis_aguardando)}` : ''}.</>}
      </p>
      <Link to="/whatsapp" className="text-xs text-primary hover:underline">Abrir inbox →</Link>
    </Card>
  );
}
```

- [ ] **Step 2: Montar o card no topo do FarmerDashboardV2**

Em `src/components/dashboard/FarmerDashboardV2.tsx`, adicionar o import e renderizar o card logo após `<KpisToday />`:
```tsx
// topo do arquivo
import { SlaCardMeuDia } from '@/components/whatsapp/SlaCardMeuDia';
// ...dentro do return, logo após <KpisToday />:
      <KpisToday />

      <SlaCardMeuDia />
```

- [ ] **Step 3: Typecheck + lint + commit**

Run: `bun run typecheck && bun lint`
Expected: PASS.
```bash
git add src/components/whatsapp/SlaCardMeuDia.tsx src/components/dashboard/FarmerDashboardV2.tsx
git commit -m "feat(whatsapp-sla): card de Meu Dia da vendedora (Minhas/Todas)"
```

---

### Task 8: Badge na sidebar (`AppShell.tsx`)

**Files:**
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Adicionar item de menu do WhatsApp (se ainda não houver) + a query de contagem da vendedora**

Na seção `Vendas` (por volta da linha 77-85), garantir o item do inbox e adicionar o da supervisão:
```tsx
  {
    title: 'Vendas',
    items: [
      { icon: ShoppingCart, label: 'Pedidos', path: '/sales' },
      { icon: PlusCircle, label: 'Novo Pedido', path: '/sales/new' },
      { icon: MessageCircle, label: 'WhatsApp', path: '/whatsapp' },
      { icon: Wrench, label: 'Ferramentas de Venda', path: '/vendas/ferramentas' },
      { icon: Link2, label: 'Chamadas pendentes', path: '/farmer/calls/pending-link' },
      { icon: Phone, label: 'Telefonia', path: '/telefonia' },
    ],
  },
```
> Garantir que `MessageCircle` está importado de `lucide-react` no topo do AppShell.

Adicionar a query de contagem (perto das outras `useQuery` de badge, ~linha 353), contando os VERMELHOS da vendedora logada:
```tsx
  const { user } = useAuth(); // se ainda não estiver no escopo
  const { data: waSlaMeusVermelhos } = useQuery({
    queryKey: ['whatsapp-sla-badge', user?.id],
    queryFn: async () => {
      const client = supabase as unknown as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown; error: unknown }> } };
      const res = await (client.from('v_whatsapp_sla').select('owner_user_id,nivel') as PromiseLike<{ data: unknown; error: unknown }>);
      const rows = (res.data ?? []) as Array<{ owner_user_id: string | null; nivel: string }>;
      return rows.filter((r) => r.owner_user_id === user?.id && r.nivel === 'vermelho').length;
    },
    enabled: isStaff && !!user?.id,
    refetchInterval: 60000,
    staleTime: 30000,
  });
```

- [ ] **Step 2: Mapear o badge no item `/whatsapp`**

No `useMemo` de `sectionsWithBadges` (~linha 460-498), adicionar:
```tsx
      if (it.path === '/whatsapp' && waSlaMeusVermelhos && waSlaMeusVermelhos > 0) {
        return { ...it, badge: waSlaMeusVermelhos, badgeVariant: 'destructive' as const };
      }
```
E incluir `waSlaMeusVermelhos` nas deps do `useMemo`.

- [ ] **Step 3: Typecheck + lint + commit**

Run: `bun run typecheck && bun lint`
Expected: PASS.
```bash
git add src/components/AppShell.tsx
git commit -m "feat(whatsapp-sla): badge vermelho na sidebar (clientes meus atrasados)"
```

---

### Task 9: Página de supervisão `/whatsapp/sla`

**Files:**
- Create: `src/pages/WhatsappSlaSupervisao.tsx`
- Modify: `src/App.tsx` (rota)
- Modify: `src/components/AppShell.tsx` (item de menu na seção Gestão)

- [ ] **Step 1: Implementar a página (gated master/gestor, agregada por vendedora + balde sem-dono)**

```tsx
// src/pages/WhatsappSlaSupervisao.tsx
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useWhatsappSla, type WaSlaRow } from '@/queries/useWhatsappSla';
import { formatSlaWait } from '@/lib/whatsapp/sla-format';

interface Grupo { ownerId: string | null; total: number; vermelhos: number; amarelos: number; pior: number; }

function agrupar(rows: WaSlaRow[]): Grupo[] {
  const map = new Map<string, Grupo>();
  for (const r of rows) {
    const key = r.owner_user_id ?? '__sem_dono__';
    const g = map.get(key) ?? { ownerId: r.owner_user_id, total: 0, vermelhos: 0, amarelos: 0, pior: 0 };
    g.total += 1;
    if (r.nivel === 'vermelho') g.vermelhos += 1;
    if (r.nivel === 'amarelo') g.amarelos += 1;
    g.pior = Math.max(g.pior, r.minutos_uteis_aguardando);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.vermelhos - a.vermelhos || b.pior - a.pior);
}

export default function WhatsappSlaSupervisao() {
  const { isMaster, isGestorComercial } = useAuth();
  const { data: rows = [] } = useWhatsappSla();
  const grupos = useMemo(() => agrupar(rows), [rows]);

  // nomes das vendedoras (owner_user_id -> name) via profiles (profiles está no types.ts → sem cast)
  const ownerIds = useMemo(
    () => [...new Set(rows.map((r) => r.owner_user_id).filter((x): x is string => !!x))],
    [rows],
  );
  const { data: nomes } = useQuery({
    queryKey: ['whatsapp-sla-owner-nomes', ownerIds],
    queryFn: async () => {
      const map: Record<string, string> = {};
      if (ownerIds.length === 0) return map;
      const { data } = await supabase.from('profiles').select('user_id,name').in('user_id', ownerIds);
      for (const p of (data ?? []) as Array<{ user_id: string; name: string | null }>) {
        if (p.name) map[p.user_id] = p.name;
      }
      return map;
    },
    enabled: ownerIds.length > 0,
    staleTime: 300000,
  });

  if (!isMaster && !isGestorComercial) {
    return <div className="container mx-auto p-4 text-sm text-muted-foreground">Acesso restrito a gestão.</div>;
  }

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold">SLA do WhatsApp — supervisão</h1>
        <p className="text-xs text-muted-foreground">Clientes sem resposta, por vendedora. Atualiza ao vivo.</p>
      </div>
      {grupos.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">Nenhum cliente esperando agora. 👌</Card>
      ) : grupos.map((g) => (
        <Card key={g.ownerId ?? 'sem'} className={`p-3 flex items-center justify-between ${g.ownerId === null ? 'border-status-error/40' : ''}`}>
          <div>
            <div className="text-sm font-medium">
              {g.ownerId === null ? '⚠️ Sem dono (cliente sem carteira)' : (nomes?.[g.ownerId] ?? `Vendedora ${g.ownerId.slice(0, 8)}`)}
            </div>
            <div className="text-xs text-muted-foreground">
              {g.total} esperando · <span className="text-status-error">{g.vermelhos} atrasado(s)</span> · {g.amarelos} em atenção · pior {formatSlaWait(g.pior)}
            </div>
          </div>
          <Link to="/whatsapp" className="text-xs text-primary hover:underline">Inbox →</Link>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Registrar a rota em `App.tsx`**

Topo (lazy import, junto dos outros ~linha 19-164):
```tsx
const WhatsappSlaSupervisao = lazy(() => import("./pages/WhatsappSlaSupervisao"));
```
Dentro de `<Routes>` (junto das rotas protegidas, ~linha 240):
```tsx
            <Route path="whatsapp/sla" element={<WhatsappSlaSupervisao />} />
```

- [ ] **Step 3: Item de menu na seção Gestão (AppShell)**

Na seção `Gestão` do AppShell, adicionar:
```tsx
      { icon: MessageCircle, label: 'SLA WhatsApp', path: '/whatsapp/sla' },
```

- [ ] **Step 4: Typecheck + lint + build + commit**

Run: `bun run typecheck && bun lint && bun run build`
Expected: PASS.
```bash
git add src/pages/WhatsappSlaSupervisao.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(whatsapp-sla): página de supervisão /whatsapp/sla (por vendedora + sem dono)"
```

---

### Task 10: Empacotar a migration F1 (ritual `lovable-db-operator`)

**Files:** nenhum novo — gera o artefato de apply.

- [ ] **Step 1: Rodar o ritual `lovable-db-operator`** pra a migration `20260604130000_whatsapp_sla.sql`: gera o BLOCO pronto pro SQL Editor + a query de validação pós-apply + a nota de PR. A query de validação:
```sql
SELECT 'F1 OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('whatsapp_minutos_uteis','wa_is_stop_keyword')) AS funcs,   -- esperado 2
  (SELECT count(*) FROM information_schema.views WHERE table_name = 'v_whatsapp_sla') AS view,                 -- esperado 1
  (SELECT count(*) FROM public.company_config WHERE key LIKE 'whatsapp_sla_%') AS config_keys;                 -- esperado 6
```

- [ ] **Step 2:** Atualizar o audit (`bun run audit:migrations`) e regenerar se necessário.

- [ ] **Step 3: Commit**

```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql 2>/dev/null || true
git commit -m "chore(whatsapp-sla): empacota migration F1 p/ SQL Editor + audit" --allow-empty
```

> **Entregar inline na conversa** o BLOCO SQL F1 + a query de validação, rotulado "🟣 Lovable → SQL Editor → cola → Run". Founder aplica e confirma a contagem (2 funcs / 1 view / 6 config).

---

## CHECKPOINT F1

Após a Task 10 + apply do founder: a Fase 1 está no ar (selo no inbox, card na Meu Dia, badge, painel de supervisão), **sem nenhuma edge function**. Validar visualmente no device (o gstack `/browse` não renderiza a SPA — conferir no Chrome real). Só depois seguir pra F2.

---

## FASE 2 — Digest diário por e-mail

### Task 11: Migration do digest (log + função + cron + CHECK)

**Files:**
- Create: `supabase/migrations/20260604140000_whatsapp_sla_digest.sql`
- Modify: `db/test-whatsapp-sla.sql` (asserts de idempotência)

- [ ] **Step 1: Escrever o assert de idempotência (teste que falha)**

Adicionar ao fim de `db/test-whatsapp-sla.sql`:
```sql
-- ===== Digest idempotente: rodar 2x não duplica =====
DO $$
DECLARE v_antes int; v_depois int;
BEGIN
  PERFORM public.whatsapp_sla_digest_tick();
  SELECT count(*) INTO v_antes FROM public.fornecedor_alerta WHERE tipo='whatsapp_sla';
  PERFORM public.whatsapp_sla_digest_tick();  -- 2ª vez no mesmo dia local
  SELECT count(*) INTO v_depois FROM public.fornecedor_alerta WHERE tipo='whatsapp_sla';
  ASSERT v_antes = v_depois, 'digest não pode duplicar no mesmo dia';
  ASSERT (SELECT count(*) FROM public.whatsapp_sla_digest_log) = 1, 'log tem 1 linha do dia';
  RAISE NOTICE 'OK: digest idempotente (antes=% depois=%)', v_antes, v_depois;
END $$;
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql`
Expected: FAIL ("function public.whatsapp_sla_digest_tick() does not exist").

- [ ] **Step 3: Implementar a migration**

```sql
-- supabase/migrations/20260604140000_whatsapp_sla_digest.sql
-- ============================================================================
-- F2 — digest diário do SLA de WhatsApp
-- ============================================================================

-- estende o CHECK de tipo (lista canônica atual + whatsapp_sla)
alter table public.fornecedor_alerta drop constraint if exists fornecedor_alerta_tipo_check;
alter table public.fornecedor_alerta add constraint fornecedor_alerta_tipo_check
  check (tipo in ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
                  'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','outro'));

-- guarda de idempotência: 1 digest por dia local
create table if not exists public.whatsapp_sla_digest_log (
  data_local date primary key,
  created_at timestamptz not null default now()
);
alter table public.whatsapp_sla_digest_log enable row level security;
-- sem policies → só service_role/definer escrevem (igual tabelas de motor)

create or replace function public.whatsapp_sla_digest_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_habil   text;
  v_vermelhos int;
  v_titulo  text;
  v_msg     text;
begin
  select value into v_habil from public.company_config where key='whatsapp_sla_digest_habilitado';
  if coalesce(v_habil,'true') <> 'true' then return; end if;

  -- idempotência: marca o dia; se já marcado, sai (cron repetido/retry não duplica)
  insert into public.whatsapp_sla_digest_log(data_local) values (v_hoje) on conflict do nothing;
  if not found then return; end if;

  select count(*) into v_vermelhos from public.v_whatsapp_sla where nivel='vermelho';
  if v_vermelhos = 0 then return; end if;  -- nada atrasado hoje → dia marcado, sem e-mail

  -- corpo: por vendedora (nome via profiles) + balde sem-dono
  select string_agg(linha, E'\n' order by ord) into v_msg from (
    select 1 as ord,
      coalesce(p.name, 'Sem dono (cliente sem carteira)') || ': '
        || count(*) || ' esperando, ' || count(*) filter (where s.nivel='vermelho') || ' atrasado(s), pior '
        || public.whatsapp_minutos_uteis(min(s.aguardando_desde), now()) || ' min' as linha,
      case when s.owner_user_id is null then 9999 else 0 end
        + (count(*) filter (where s.nivel='vermelho'))::int * -1 as ord2
    from public.v_whatsapp_sla s
    left join public.profiles p on p.user_id = s.owner_user_id
    group by s.owner_user_id, p.name
  ) t(ord, linha, ord2);

  v_titulo := 'WhatsApp: ' || v_vermelhos || ' cliente(s) atrasado(s) hoje';

  insert into public.fornecedor_alerta(tipo, empresa, severidade, status, titulo, mensagem)
  values ('whatsapp_sla', 'oben', 'atencao', 'pendente_notificacao', v_titulo, v_msg);
end;
$$;

-- cron: 21:00 UTC = 18:00 BRT, seg-sex (chamada SQL LOCAL, sem net.http_post)
select cron.schedule('whatsapp-sla-digest-diario', '0 21 * * 1-5', $$select public.whatsapp_sla_digest_tick()$$);
```

> Nota sobre `min(aguardando_desde)` no "pior": `whatsapp_minutos_uteis(min(aguardando_desde), now())` usa os defaults de hora (07:30-17:30); o "pior" tempo do grupo = o que espera há mais tempo = o de menor `aguardando_desde`. Aceitável pro resumo (o número fino já está na tela).

- [ ] **Step 4: Rodar e ver passar**

Run: `psql "$DBURL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260604140000_whatsapp_sla_digest.sql && psql "$DBURL" -v ON_ERROR_STOP=1 -f db/test-whatsapp-sla.sql`
Expected: `NOTICE: OK: digest idempotente (...)`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260604140000_whatsapp_sla_digest.sql db/test-whatsapp-sla.sql
git commit -m "feat(whatsapp-sla): digest diário idempotente -> fornecedor_alerta + cron (TDD)"
```

---

### Task 12: `dispatch-notifications` trata `whatsapp_sla` (Lovable)

**Files:** edge `supabase/functions/dispatch-notifications/index.ts` (editada via chat do Lovable).

- [ ] **Step 1: Verificar como o dispatcher formata o e-mail por tipo.** Ler `supabase/functions/dispatch-notifications/index.ts`: se ele já envia `titulo`+`mensagem` genericamente (sem `switch (tipo)`), o digest funciona sem editar a edge (só confirmar que o tipo novo não cai num filtro). Se houver `switch (tipo)`/allow-list de tipos, **adicionar `whatsapp_sla`** (assunto = `titulo`, corpo = `mensagem`).

- [ ] **Step 2: Montar o prompt pro chat do Lovable** (se a edge precisar de edição), instruindo a ler `supabase/functions/dispatch-notifications/index.ts` do repo e adicionar o tratamento do tipo `whatsapp_sla` (assunto=titulo, corpo=mensagem), sem mexer no resto. Confirmar "Active" no Cloud → Edge functions.

- [ ] **Step 3: Commit (doc/nota se houver mudança de repo); senão, registrar no PR que a edição é manual no Lovable.**

---

### Task 13: Empacotar a migration F2 (ritual `lovable-db-operator`)

- [ ] **Step 1: Rodar `lovable-db-operator`** pra `20260604140000_whatsapp_sla_digest.sql`. Query de validação:
```sql
SELECT 'F2 OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname='whatsapp_sla_digest_tick') AS func,                                     -- 1
  (SELECT count(*) FROM cron.job WHERE jobname='whatsapp-sla-digest-diario') AS cron,                                  -- 1
  (SELECT count(*) FROM information_schema.tables WHERE table_name='whatsapp_sla_digest_log') AS log_table,            -- 1
  (SELECT 'whatsapp_sla' = ANY(string_to_array(replace(replace(pg_get_constraintdef(oid),'CHECK (tipo = ANY (ARRAY[',''),'])',''), ', ')) FROM pg_constraint WHERE conname='fornecedor_alerta_tipo_check') AS tipo_ok;
```

- [ ] **Step 2:** Entregar inline o BLOCO SQL F2 + validação, rotulado "🟣 Lovable → SQL Editor". Founder aplica.

- [ ] **Step 3: Commit do audit.**

```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql 2>/dev/null || true
git commit -m "chore(whatsapp-sla): empacota migration F2 + audit" --allow-empty
```

---

## Self-Review (cobertura do spec)

- ✅ Métrica = primeira não respondida (view CTE `aguardando` + tuple compare) — Task 3.
- ✅ "Respondido" = humano (`sender_user_id IS NOT NULL`) — `last_out` na view; teste C6 (template sem sender) — Task 3.
- ✅ Âncora `coalesce(wa_timestamp, created_at)` — view + função — Task 2/3.
- ✅ Stop-keyword fora (`wa_is_stop_keyword`) + `fechada` fora — Task 2/3 (asserts C3/C4).
- ✅ Relógio expediente configurável (`whatsapp_minutos_uteis` + `company_config`) — Task 2/3.
- ✅ Limiares 15/30 configuráveis + `nivel` — Task 3.
- ✅ Dono ao vivo (carteira + cobertura) + sem-dono — Task 3 (assert C5) + Task 9.
- ✅ 3 superfícies: selo inbox (Task 6) + card Meu Dia c/ Minhas/Todas (Task 7) + badge (Task 8) + supervisão (Task 9).
- ✅ Display-only (filtro no front; RLS não muda) — Task 7/8/9.
- ✅ Digest idempotente + `titulo`/`mensagem`/CHECK + cron local + `NOTIFICATION_EMAIL_TO` — Task 11/12.
- ✅ Fases (F1 sem edge / F2 digest) — estrutura do plano.
- ✅ Testes PG17 + vitest do helper — Task 1/2/3/11.

**Não-objetivos (fora, por design):** hardening de RLS do inbox, e-mail tempo-real, feriados, e-mail pessoal por vendedora, flag IA↔humano (o predicado de `sender_user_id` já protege).
