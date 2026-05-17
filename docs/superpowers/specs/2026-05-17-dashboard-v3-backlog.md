# Dashboard V3 — Backlog deferido

> Itens que **não vão ser feitos agora** com racional explícito + critério de
> reativação. Manter este doc atualizado evita revisitar a mesma discussão
> a cada planejamento.
>
> Data: 2026-05-17

---

## 1. Salvar "visões nomeadas" (preset configurations)

Ex: "Manhã de segunda", "Fim de mês fiscal", "Quinta de fechamento financeiro".

**Por que não agora**:
- Drag-reorder + hide já entrega 80% do valor (ordem personalizada persistida por persona)
- Adicionar "visões nomeadas" exige: schema (nome, ordem, hidden, filtros), UI de gerenciamento, share entre usuários, decisão de produto sobre se é per-user ou template-share
- Antes de validar adoção do override de persona + customização de layout, é speculative

**Reativar quando**:
- PostHog mostrar > 30% de usuários customizando layout (sinal de quem quer mais granularidade)
- OU > 3 pessoas pedirem explicitamente
- OU houver caso de uso B2B claro (consultor compartilhando dashboard com cliente)

---

## 2. Onboarding tour

Wizard interativo na primeira visita ao dashboard.

**Por que não agora**:
- Staff opera o app 8h/dia — aprendem em 1-2 dias naturalmente
- Cliente final já tem `OnboardingWizard` no `CustomerDashboard`
- Tour é caro de manter — quebra a cada mudança de layout (e Dashboard V3 ainda vai iterar)
- Sem evidência de dropoff no primeiro uso

**Reativar quando**:
- PostHog mostrar dropoff > 50% na primeira sessão de staff novo
- OU treinamento HR pedir explicitamente
- OU produto adicionar features novas complexas (drag-reorder não conta — é descobrível)

---

## 3. Modo TV / fullscreen (painel na parede)

Auto-refresh agressivo, esconder controles, dark-mode forçado.

**Por que não agora**:
- Zero demanda explícita
- Exige decisões de produto: quais zonas mostrar, refresh rate, identidade visual painel
- Implementar exige rota separada (`/dashboard/tv`) + componente que reusa zonas em layout próprio

**Reativar quando**:
- Operação real solicitar (provavelmente fábrica Colacor querendo painel de produção/picking)
- OU houver hardware Smart TV definido (Chromecast, raspi)

---

## 4. Refactor das 19 outras telas pra `useDashboardCompany`

Migrar tudo que usa `activeCompany` direto pra hook unificado que suporta `'all'`.

**Por que não agora**:
- `useRequiredCompany` adapter já intercepta `'all'` e cai pra single — telas legadas não quebram
- Cada tela tem seu próprio pattern (algumas já agregam manualmente)
- Refatorar em batch = scope creep gigante sem ganho funcional imediato
- Refatorar **por tela quando tocar** captura o ganho gradualmente sem PR pesado

**Reativar quando**:
- Houver requisito de produto que exija múltiplas telas trabalharem em modo `'all'` simultaneamente
- OU tech debt audit identificar custo de manutenção do dual-pattern alto
- Política: **toda PR que toca uma tela legada deve migrar pra `useDashboardCompany`** (forçar migração orgânica)

---

## 5. Histórico de "priority winners" (analytics avançado)

Log diário de qual priority venceu o brief — vira indicador de saúde do negócio.

**Por que não agora**:
- PostHog `dashboard.brief.priority_shown` já tem evento; basta criar chart custom (chart #6 do spec PostHog cobre parcialmente)
- Persistência em DB seria duplicar trabalho

**Reativar quando**:
- Quiser relatórios mensais por email com "10 priorities mais frequentes"
- OU integrar com sistema de OKR (vincular priority frequency a metas)

---

## 6. Notificações push do PriorityCard

Quando score ≥ 90 (critical), enviar push notification ao usuário.

**Por que não agora**:
- Infra de push já existe (orders), mas wiring com Priority engine exige decisão:
  - **frequência**: cada vez que score ≥ 90? rate-limit?
  - **canal**: só push browser? email? WhatsApp?
  - **quiet hours**: respeita horário comercial?
- Sem validar primeiro que usuário ABRE o dashboard hoje (PostHog chart #1), push é spam

**Reativar quando**:
- Adoção do dashboard estiver consolidada (chart #1 plateau)
- OU houver caso de uso urgente comprovado (e.g. financeiro pede notif de divergência conciliação)

---

## 7. Filtros temporais no cockpit (toggle hoje/semana/mês)

Cada KPI ganha dropdown de janela temporal.

**Por que não agora**:
- Adiciona estado por card (state explosion)
- KPIs hoje têm janelas fixas escolhidas com propósito (Vendas=hoje, Reposição=7d, Sistema=24h) — mudar destrói consistência semântica
- Drill-down pro cockpit (Abrir cockpit →) já permite filtrar lá

**Reativar quando**:
- Usuário pedir "Vendas semana / mês" explicitamente (PostHog ZeroEvent search)
- OU houver use-case de comparação temporal sem sair do dashboard

---

## 8. Empty state melhor no PriorityCard (success com ação)

Hoje "Tudo sob controle" é estático. Poderia mostrar dica do dia, changelog, tip de uso.

**Por que não agora**:
- Implementar exige fonte de conteúdo: who writes the tips? auto-gen? manual feed?
- Risco: tips ficam estagnados e viram poluição visual
- Quem está "all good" provavelmente é mais experiente — menos receptivo a tips

**Reativar quando**:
- Houver pipeline de conteúdo definido (changelog é candidato natural)
- OU implementar como random selection de PriorityItems com score 0-29 (transformar success em "leve atenção")

---

## 9. Dark mode tuning

Tokens `bg-cockpit-hero`, `noise`, `status-*-bold` foram tunados pra light.
Dark mode passa, mas pode estar com contraste sub-ótimo em alguns lugares.

**Por que não agora**:
- Smoke test inicial foi em light; sem screenshots dark pra ver problema concreto
- Tuning isolado = baixo ROI vs design system review completo

**Reativar quando**:
- Usuário reportar contraste ruim em modo escuro
- OU `/design-review` skill rodar audit visual

---

## 10. Backfill de `dashboard_visits` retroativo

Quando `dashboard_visits` table existir, popular com PostHog events antigos.

**Por que não agora**:
- Spec do `dashboard_visits` (sibling doc) explicitamente diz "sem backfill"
- PostHog mantém eventos por 1 ano (plano free); query histórica continua possível lá

**Reativar quando**:
- Após implementar `dashboard_visits`, se análise mostrar que histórico server-side é mais barato/rápido que PostHog query

---

## Princípios de adicionar ao backlog

1. **Razão explícita** — não basta "depois"; precisa do "por que adiar"
2. **Critério de reativação** — sinal concreto que dispara a reabertura
3. **Sem datas** — backlog não é roadmap; itens dormem sem deadline
4. **Revisão trimestral** — varrer este doc e remover o que virou obsoleto
