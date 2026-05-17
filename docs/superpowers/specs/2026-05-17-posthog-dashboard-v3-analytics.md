# PostHog Dashboard — "Afiação Dashboard V3"

> Spec dos charts/funnels a criar no PostHog UI pra medir adoção e iterar o
> Dashboard Principal V3. Os 12 eventos já estão instrumentados (veja
> [docs/superpowers/specs/2026-05-16-dashboard-principal-v3-design.md](2026-05-16-dashboard-principal-v3-design.md) §9).
>
> Data: 2026-05-17 · Projeto PostHog: `423408`

---

## Como criar

1. Abrir PostHog → **Dashboards** → New dashboard → nome: `Afiação — Dashboard V3`
2. Pra cada chart abaixo, "Add insight" → escolher tipo (Trends/Funnels/Retention) → configurar conforme spec → salvar
3. Filtros globais do dashboard: nenhum (cada chart cuida do seu)
4. Compartilhar com a equipe via URL ou export PDF semanal

---

## Charts a criar (8 essenciais)

### 1. **Adoção diária** (Trends — Line)

**Objetivo**: quantos staff únicos abrem o dashboard por dia.

- **Event**: `dashboard.viewed`
- **Aggregation**: Unique users
- **Date range**: Last 30 days
- **Interval**: Day
- **Filter**: `persona ≠ customer` (defensivo, mas é só staff de qualquer jeito)
- **Breakdown** (opcional): `persona`

Métrica-alvo: crescimento contínuo. Plateau = sinal de saturação ou problema.

---

### 2. **Persona accuracy** (Trends — Pie)

**Objetivo**: % de usuários onde auto-detect acertou (não trocaram persona).

- **Event A**: `dashboard.viewed`, Unique users, last 30 days
- **Event B**: `dashboard.persona.switched`, Unique users, last 30 days
- **Métrica derivada**: `(A - B) / A × 100`

**Como criar na UI**: 2 insights separados (A e B), título "Override rate = B/A × 100".

Métrica-alvo: < 15% override = auto-detect bem calibrado. Se ≥ 30%, revisar `inferPersona()` thresholds.

---

### 3. **Funil: Abrir → Agir** (Funnels)

**Objetivo**: % dos que abrem o dashboard que clicam em algo.

- **Step 1**: `dashboard.viewed`
- **Step 2**: ANY of (`dashboard.brief.priority_cta_clicked` OR `dashboard.brief.delta_clicked` OR `dashboard.kpi.clicked` OR `dashboard.zone.list_item_clicked` OR `dashboard.zone.open_cockpit`)
- **Conversion window**: Same session (30min)
- **Breakdown**: `persona`

Métrica-alvo: > 60% engajam. < 30% = dashboard é decorativo, repensar.

---

### 4. **Top KPIs clicados** (Trends — Bar horizontal)

**Objetivo**: ranking dos KPIs mais acessados, identifica o que importa.

- **Event**: `dashboard.kpi.clicked`
- **Aggregation**: Total count
- **Date range**: Last 30 days
- **Breakdown**: `zone` ou property `kpi`
- **Order**: Descending

Sinal: KPIs com volume baixo são candidatos a remover (menos densidade visual).

---

### 5. **Open-cockpit por zona** (Trends — Bar)

**Objetivo**: quais zonas levam usuário pra view detalhada.

- **Event**: `dashboard.zone.open_cockpit`
- **Aggregation**: Total count
- **Date range**: Last 30 days
- **Breakdown**: `zone`

Métrica-alvo: distribuição relativamente uniforme entre zonas relevantes. Zone com 0 cliques = morta, considerar remover do persona ou rebaixar de prioridade.

---

### 6. **PriorityCard CTA — variant breakdown** (Trends — Pie)

**Objetivo**: quais variants (critical/warning/info/success) chamam mais ação.

- **Event**: `dashboard.brief.priority_cta_clicked`
- **Aggregation**: Total count
- **Date range**: Last 30 days
- **Breakdown**: `variant`

Sinal: se warning > critical em count, talvez score crítico esteja muito alto (threshold permite que warning roube atenção). Se success aparece (CTA em sucesso), bug — success não deveria ter CTA.

---

### 7. **Realtime reliability** (Trends — Line)

**Objetivo**: % de sessões em que ≥1 channel conectou. Detecta degradação do Supabase Realtime.

- **Event A**: `dashboard.viewed`, Unique users, last 7 days, interval day
- **Event B**: `dashboard.realtime.channel_connected`, Unique users, last 7 days, interval day
- **Métrica derivada**: `B / A × 100`

Métrica-alvo: > 90% conectam. < 70% = Realtime mal configurado (publication missing, RLS bloqueando, plan limit). Hoje o LiveBadge depende disso.

---

### 8. **Bounce zones** (Insights — SQL)

**Objetivo**: zonas que ninguém clica numa sessão = candidatas a remover/reorder.

```sql
-- HogQL query
SELECT
  COUNT() AS views,
  countIf(
    JSONExtractString(properties, 'zone') = 'tintometrico'
    AND event IN ('dashboard.zone.open_cockpit', 'dashboard.kpi.clicked', 'dashboard.zone.list_item_clicked')
  ) AS tint_clicks,
  countIf(
    JSONExtractString(properties, 'zone') = 'financeiro'
    AND event IN ('dashboard.zone.open_cockpit', 'dashboard.kpi.clicked', 'dashboard.zone.list_item_clicked')
  ) AS fin_clicks
FROM events
WHERE event = 'dashboard.viewed'
  AND timestamp >= now() - INTERVAL 30 DAY
```

Repetir pro `zone` de cada uma das 6 zonas. % clicks/views < 5% = candidato a rebaixar na ordem da persona ou remover (após decisão de produto).

---

## Filtros úteis pra investigação ad-hoc

Salvar como "Saved insights" pra debugging rápido:

- **Persona switches** (`dashboard.persona.switched`) breakdown por `from` → `to`: descobre confusões de auto-detect (ex: muita gente trocando de "vendedor" pra "gestor" = `inferPersona` confunde os dois).
- **Empty state shown** (`dashboard.empty_state.shown`) breakdown por `zone` + `reason`: detecta tabelas que sempre estão vazias (bug ou desnecessárias).
- **Company switched from dashboard** (`dashboard.company.switched_from_dashboard`): mede quanto o switcher é usado de dentro do `/` vs do topbar.

---

## Alarmes (PostHog → Alerts)

Configurar 2 alarmes mínimos:

1. **Realtime reliability < 50% por 4h** → alguém quebrou a publication. Critical.
2. **Override rate > 40% em 7 dias** → auto-detect quebrado. Important.

---

## Frequência de revisão

- **Semanal**: chart 1, 3, 5 (adoção, engajamento, distribuição entre zonas)
- **Mensal**: chart 2, 4, 6 (persona accuracy, KPI ranking, variant breakdown)
- **Ad-hoc**: chart 7 (realtime) quando houver suspeita; chart 8 (bounce) antes de cada review trimestral do dashboard

---

## Out-of-scope

- Per-user drill-down de quem clica o quê (PII; usar session replay sob demanda)
- Comparação contra "antigo StaffHome" (não existe baseline, dashboard novo é full replace)
- A/B test framework (precisa setup separado, deixar pra próxima iteração de produto)
