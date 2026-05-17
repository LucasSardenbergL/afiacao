# PostHog Setup Walkthrough — Dashboard V3

> Guia paste-ready pra executar a **Fase 1 da Issue #56**. Cobre:
> 1. Aplicar 2 migrations no Supabase
> 2. Criar 8 charts no PostHog (cada um com config UI + HogQL alternativo)
> 3. Configurar 2 alertas
>
> Tempo total estimado: **~2h** seguindo passo-a-passo.
> Data: 2026-05-17

---

# Parte 1 — Aplicar migrations no Supabase (~10min)

## Pré-requisitos
- Acesso ao Supabase Dashboard do projeto (você tem)
- Permissão pra rodar SQL

## Migration 1: `user_departments`

1. Abrir **Supabase Dashboard → SQL Editor → New query**
2. Copiar e colar o conteúdo de `supabase/migrations/20260517120000_user_departments.sql`:

```sql
-- Cole aqui o conteúdo INTEGRAL do arquivo
-- (75 linhas, vai criar: type department + table user_departments + 2 indexes + 3 RLS policies)
```

3. Clicar **Run** (Cmd+Enter)
4. Verificar sucesso — output deve mostrar "Success. No rows returned."

### Validar
Rodar no SQL Editor:

```sql
SELECT
  EXISTS(SELECT 1 FROM pg_type WHERE typname = 'department') AS type_exists,
  EXISTS(SELECT 1 FROM pg_tables WHERE tablename = 'user_departments') AS table_exists,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'user_departments') AS policies_count;
```

Esperado: `true | true | 3` (1 row).

## Migration 2: `dashboard_visits`

Mesmos passos com `supabase/migrations/20260517140000_dashboard_visits.sql`:

1. SQL Editor → New query
2. Cola conteúdo (53 linhas)
3. Run
4. Validar:

```sql
SELECT
  EXISTS(SELECT 1 FROM pg_tables WHERE tablename = 'dashboard_visits') AS table_exists,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'dashboard_visits') AS policies_count;
```

Esperado: `true | 4`.

## Pós-migrations

- ✅ UI `/admin/departments` passa a salvar dados
- ✅ `useLastVisit` server-side passa a popular `dashboard_visits` em sessões >5min
- Atribuir department pros 10-20 staff principais agora ou depois (~15min)

---

# Parte 2 — Criar PostHog dashboard "Afiação V3" (~1h)

## Setup inicial

1. Abrir **PostHog → Dashboards → New dashboard**
2. Nome: `Afiação — Dashboard V3`
3. Description: `Telemetria do dashboard staff /. Eventos namespace dashboard.* + offline.*`
4. Salvar
5. Em cada chart abaixo: **Add insight → escolher tipo → configurar → Save → Add to dashboard**

> Convenção: **UI Config** = passos clicáveis na PostHog UI. **HogQL alt** = query SQL pra usar via "SQL insight" se preferir.

---

## Chart 1 — Adoção diária

**Objetivo**: quantos staff únicos abrem o dashboard por dia.

**UI Config:**
- Tipo: **Trends → Line chart**
- Series: Event = `dashboard.viewed`
- Aggregation: **Unique users**
- Date range: **Last 30 days**
- Interval: **Day**
- Breakdown: (opcional) Property `persona`

**HogQL alt:**
```sql
SELECT
  toStartOfDay(timestamp) AS day,
  count(DISTINCT person_id) AS users
FROM events
WHERE event = 'dashboard.viewed'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day
```

**Saúde**: crescimento contínuo nas 4 primeiras semanas. **Plateau** = saturação ou problema de onboarding.

---

## Chart 2 — Persona override rate

**Objetivo**: % usuários que trocaram a persona inferida (mede acurácia do auto-detect).

**UI Config:**
- Tipo: **Trends → Big number** (ou Pie)
- Series:
  - A: Event = `dashboard.persona.switched`, Unique users, Last 30 days
  - B: Event = `dashboard.viewed`, Unique users, Last 30 days
- Formula: `A / B * 100`

**HogQL alt:**
```sql
SELECT
  100.0 * count(DISTINCT CASE WHEN event = 'dashboard.persona.switched' THEN person_id END)
        / count(DISTINCT CASE WHEN event = 'dashboard.viewed' THEN person_id END) AS override_rate_pct
FROM events
WHERE event IN ('dashboard.persona.switched', 'dashboard.viewed')
  AND timestamp >= now() - INTERVAL 30 DAY
```

**Saúde**:
- < 15% = auto-detect bem calibrado ✅
- 15-30% = aceitável
- > 30% = revisar thresholds em `inferPersona` ⚠️

---

## Chart 3 — Funil: Abrir → Agir

**Objetivo**: % de sessões em que usuário clicou em algo após abrir.

**UI Config:**
- Tipo: **Funnels**
- Steps:
  - 1: Event = `dashboard.viewed`
  - 2: Event matches ANY of:
    - `dashboard.brief.priority_cta_clicked`
    - `dashboard.brief.delta_clicked`
    - `dashboard.kpi.clicked`
    - `dashboard.zone.list_item_clicked`
    - `dashboard.zone.open_cockpit`
- Conversion window: **30 minutes** (mesma sessão)
- Breakdown: Property `persona`

**HogQL alt:** (PostHog funnels são mais fáceis na UI; usar SQL aqui é overkill)

**Saúde**:
- > 60% = engajamento alto ✅
- 30-60% = ok
- < 30% = dashboard é decorativo, repensar PriorityCard rules ⚠️

---

## Chart 4 — Top KPIs clicados

**Objetivo**: ranking dos KPIs mais acessados.

**UI Config:**
- Tipo: **Trends → Bar chart (horizontal)**
- Series: Event = `dashboard.kpi.clicked`
- Aggregation: **Total count**
- Date range: **Last 30 days**
- Breakdown: Property `zone` (ou `kpi` se quiser granular)
- Order: Descending

**HogQL alt:**
```sql
SELECT
  JSONExtractString(properties, 'zone') AS zone,
  JSONExtractString(properties, 'kpi') AS kpi,
  count() AS clicks
FROM events
WHERE event = 'dashboard.kpi.clicked'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY zone, kpi
ORDER BY clicks DESC
LIMIT 20
```

**Saúde**: KPIs com volume muito baixo são candidatos a remover (reduz densidade visual).

---

## Chart 5 — Open-cockpit por zona

**Objetivo**: quais zonas levam usuário pra view detalhada.

**UI Config:**
- Tipo: **Trends → Bar chart**
- Series: Event = `dashboard.zone.open_cockpit`
- Aggregation: Total count
- Date range: Last 30 days
- Breakdown: Property `zone`

**HogQL alt:**
```sql
SELECT
  JSONExtractString(properties, 'zone') AS zone,
  count() AS opens
FROM events
WHERE event = 'dashboard.zone.open_cockpit'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY zone
ORDER BY opens DESC
```

**Saúde**: distribuição relativamente uniforme entre zonas. Zona com **0 cliques** = morta, considerar remover.

---

## Chart 6 — PriorityCard CTA — variant breakdown

**Objetivo**: quais variants (critical/warning/info/success) chamam mais ação.

**UI Config:**
- Tipo: **Trends → Pie chart**
- Series: Event = `dashboard.brief.priority_cta_clicked`
- Aggregation: Total count
- Date range: Last 30 days
- Breakdown: Property `variant`

**HogQL alt:**
```sql
SELECT
  JSONExtractString(properties, 'variant') AS variant,
  count() AS clicks
FROM events
WHERE event = 'dashboard.brief.priority_cta_clicked'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY variant
```

**Saúde**:
- Warning > Critical em count = threshold critical muito alto, warning está roubando atenção
- Success aparece com CTA = bug (success não deveria ter CTA)

---

## Chart 7 — Realtime reliability

**Objetivo**: % de sessões em que ≥1 channel Supabase Realtime conectou.

**UI Config:**
- Tipo: **Trends → Line**
- Series:
  - A: Event = `dashboard.viewed`, Unique users, Last 7 days, Day
  - B: Event = `dashboard.realtime.channel_connected`, Unique users, Last 7 days, Day
- Formula: `B / A * 100`

**HogQL alt:**
```sql
SELECT
  toStartOfDay(timestamp) AS day,
  100.0 * count(DISTINCT CASE WHEN event = 'dashboard.realtime.channel_connected' THEN person_id END)
        / count(DISTINCT CASE WHEN event = 'dashboard.viewed' THEN person_id END) AS reliability_pct
FROM events
WHERE event IN ('dashboard.viewed', 'dashboard.realtime.channel_connected')
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY day
ORDER BY day
```

**Saúde**:
- > 90% conectam = saudável ✅
- 70-90% = aceitável
- < 70% = Realtime mal configurado (publication missing, RLS bloqueando, plan limit) ⚠️

---

## Chart 8 — Bounce zones (SQL)

**Objetivo**: zonas com 0 cliques numa sessão = candidatas a remover/reorder.

**Tipo: SQL insight** (necessário; UI não dá pra essa)

**HogQL:**
```sql
WITH sessions AS (
  SELECT
    person_id,
    toStartOfDay(timestamp) AS day,
    -- Sessão = todos os eventos do mesmo person no mesmo dia
    groupArray(event) AS events_in_session,
    groupArray(JSONExtractString(properties, 'zone')) AS zones_clicked
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event IN (
      'dashboard.viewed',
      'dashboard.zone.open_cockpit',
      'dashboard.kpi.clicked',
      'dashboard.zone.list_item_clicked'
    )
  GROUP BY person_id, day
)
SELECT
  zone,
  count() AS sessions_with_views,
  countIf(arrayExists(z -> z = zone, zones_clicked)) AS sessions_with_click,
  100.0 * countIf(arrayExists(z -> z = zone, zones_clicked)) / count() AS click_rate_pct
FROM sessions
ARRAY JOIN ['vendas', 'estoque', 'reposicao', 'financeiro', 'tintometrico', 'sistema'] AS zone
WHERE arrayExists(e -> e = 'dashboard.viewed', events_in_session)
GROUP BY zone
ORDER BY click_rate_pct ASC
```

**Saúde**: zonas com **click_rate_pct < 5%** = candidatas a rebaixar na ordem da persona ou remover.

---

# Parte 3 — Configurar 2 alertas (~15min)

Pré-requisito: ter destination (email, Slack, etc) configurado em **PostHog → Project Settings → Subscriptions/Webhooks**.

## Alerta 1 — Realtime reliability crítica

**Caminho**: Insight #7 → **More → Subscribe → New Alert**

- Name: `Realtime reliability < 50%`
- Condition: **Value goes below** `50`
- Trigger: when value drops for `4 hours`
- Recipients: seu email / Slack channel
- Severity: **Critical**

**O que significa quando dispara**: usuários estão abrindo dashboard mas Supabase Realtime channels não conectam. Possíveis causas:
- Publication `supabase_realtime` foi removida de alguma tabela
- RLS bloqueando user
- Supabase Realtime quota excedida
- Edge function/network corrompida

## Alerta 2 — Override rate alto

**Caminho**: Insight #2 → **More → Subscribe → New Alert**

- Name: `Persona override rate > 40%`
- Condition: **Value goes above** `40`
- Trigger: when value above for `7 days`
- Recipients: seu email
- Severity: **Important**

**O que significa quando dispara**: auto-detect de persona está errando muito. Mais de 40% dos usuários estão trocando manualmente. Possíveis causas:
- Heurística por uso (≥40% prefixo) muito restritiva
- `commercial_role` mal preenchido no banco
- Faltam atribuições de `user_departments`
- Personas operacionais mal mapeadas

---

# Quando concluir

- [ ] Marcar checkbox "Fase 1 setup" na [Issue #56](https://github.com/LucasSardenbergL/afiacao/issues/56)
- [ ] Aguardar 2-4 semanas pra dados acumularem
- [ ] Atribuir departments pros staff principais via `/admin/departments`
- [ ] Voltar pra Fase 3 (interpretação) — abrir nova sessão referenciando issue #56

---

# Troubleshooting

## "Migration falhou: type 'department' already exists"
Já foi aplicada antes. Migration tem `IF NOT EXISTS` guard, deveria ser idempotente. Verificar se erro real ou só warning.

## "Chart mostra 0 events"
- Verificar se PostHog `VITE_POSTHOG_KEY` está configurado em produção (`.env` do deploy)
- Acessar `/` como staff e ver Network tab: requests pra `posthog.com/e/` devem chegar
- PostHog → Live events → filtrar `event LIKE 'dashboard.%'` deve mostrar fluxo

## "Funnel mostra 0% conversion"
- Confirma que conversion window cobre sessão típica (30min default funciona)
- Confirma que eventos têm `person_id` correto (PostHog identify rodou)

## "Realtime reliability sempre 0"
- Migration `20260517100000_enable_realtime_dashboard_v3.sql` foi aplicada?
- Supabase Realtime habilitado no plano?

---

# Referências

- Spec original: [docs/superpowers/specs/2026-05-17-posthog-dashboard-v3-analytics.md](2026-05-17-posthog-dashboard-v3-analytics.md)
- Backlog formal: [docs/superpowers/specs/2026-05-17-dashboard-v3-backlog.md](2026-05-17-dashboard-v3-backlog.md)
- Issue de follow-up: https://github.com/LucasSardenbergL/afiacao/issues/56
