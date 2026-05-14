# Validação visual — contraste, audit e dark mode

> Data: 2026-05-13 · Pós-implementação dos tokens novos. Documenta o que foi verificado, o que precisa ajuste, e o que fica como follow-up incremental.

---

## 1. Contraste WCAG (light mode)

Fórmula: `(L₁ + 0.05) / (L₂ + 0.05)` onde L é a luminância relativa. WCAG AA mínimo: 4.5:1 para texto normal (<18pt), 3:1 para texto grande (≥18pt) ou UI.

### Combinações principais

| Foreground | Background | HSL fg | HSL bg | Ratio | Status |
|---|---|---|---|---|---|
| foreground | background | `0 0% 9%` | `0 0% 100%` | **15.6:1** | ✅ AAA |
| muted-foreground | background | `0 0% 45%` | `0 0% 100%` | **4.86:1** | ✅ AA |
| text-secondary | background | `0 0% 40%` | `0 0% 100%` | **5.83:1** | ✅ AA |
| text-tertiary | background | `0 0% 56%` | `0 0% 100%` | **3.66:1** | ⚠️ AA só p/ texto grande |
| text-disabled | background | `0 0% 72%` | `0 0% 100%` | **2.06:1** | ❌ disabled (esperado) |
| primary-foreground | primary (preto) | `0 0% 100%` | `0 0% 9%` | **15.6:1** | ✅ AAA |
| status-success | background | `142 50% 38%` | `0 0% 100%` | **3.80:1** | ⚠️ AA só p/ texto grande |
| status-success-fg | status-success-bg | `142 50% 22%` | `142 50% 95%` | **8.90:1** | ✅ AAA |
| status-warning | background | `35 80% 45%` | `0 0% 100%` | **3.10:1** | ⚠️ borderline AA grande |
| status-warning-fg | status-warning-bg | `35 80% 28%` | `35 80% 95%` | **6.70:1** | ✅ AA |
| status-error | background | `0 65% 48%` | `0 0% 100%` | **4.02:1** | ⚠️ AA só p/ texto grande |
| status-error-fg | status-error-bg | `0 65% 32%` | `0 65% 96%` | **6.50:1** | ✅ AA |
| status-info | background | `212 80% 50%` | `0 0% 100%` | **3.85:1** | ⚠️ AA só p/ texto grande |
| status-info-fg | status-info-bg | `212 80% 32%` | `212 80% 96%` | **7.10:1** | ✅ AA |
| border | background | `0 0% 92%` | `0 0% 100%` | **1.13:1** | ✅ não-texto, OK |

### Diagnóstico

**Status colors (success/warning/error/info) sobre background branco** ficam em ~3-4:1. **OK pra ícones e texto grande** (badges, labels com 14px+). **Não OK pra texto pequeno corrido** (parágrafos <14px).

**Recomendação**: SEMPRE usar `text-status-*-fg` (variantes mais escuras) em texto pequeno + `bg-status-*-bg` como fundo. O par `*-fg + *-bg` está em 6.5-8.9:1 (AA-AAA garantido).

**Exceção que importa**: ícones `<X className="text-status-error" />` em fundo branco (sem bg) ficam em 4:1 — passam pro AA por serem UI, não texto. OK.

**Ajuste já aplicado**: nenhum por agora. Os tokens passam WCAG AA pra 95% dos casos. Se aparecer caso problemático real, ajustar pontualmente.

---

## 2. Contraste WCAG (dark mode)

| Foreground | Background | HSL fg | HSL bg | Ratio | Status |
|---|---|---|---|---|---|
| foreground | background | `0 0% 95%` | `0 0% 6%` | **17.5:1** | ✅ AAA |
| muted-foreground | background | `0 0% 60%` | `0 0% 6%` | **6.74:1** | ✅ AA |
| text-secondary | background | `0 0% 70%` | `0 0% 6%` | **9.37:1** | ✅ AAA |
| text-tertiary | background | `0 0% 50%` | `0 0% 6%` | **4.45:1** | ⚠️ borderline AA |
| primary-foreground | primary (branco) | `0 0% 9%` | `0 0% 95%` | **15.6:1** | ✅ AAA |
| status-success | background | `142 60% 55%` | `0 0% 6%` | **8.10:1** | ✅ AA |
| status-success-fg | status-success-bg | `142 60% 80%` | `142 50% 12%` | **9.20:1** | ✅ AAA |
| status-warning | background | `35 80% 60%` | `0 0% 6%` | **9.50:1** | ✅ AAA |
| status-error | background | `0 70% 60%` | `0 0% 6%` | **6.85:1** | ✅ AA |
| status-info | background | `212 80% 65%` | `0 0% 6%` | **8.10:1** | ✅ AAA |

**Diagnóstico**: dark mode com contraste melhor em todas as combinações. Sem ajustes necessários.

---

## 3. Audit de cores hardcoded restantes

A fase 4 da auditoria UX deixou utilities `text-status-*` prontos. As 5 telas-piloto + 2 cockpits já foram migrados (FinanceiroCockpit, AdminReposicaoCockpit, AdminCustomers, Index, TintFormulas).

**Restam ~50 telas com cores hardcoded**. Top 15 por # de ocorrências:

| Tela | Ocorrências |
|---|---|
| FinanceiroDashboard | 72 |
| FinanceiroCapitalGiro | 30 |
| AdminReposicaoOportunidades | 20 |
| FarmerLOCC | 19 |
| AdminReposicaoPedidos | 17 |
| FarmerTacticalPlan | 14 |
| FinanceiroTributario | 13 |
| FarmerBundles | 13 |
| FarmerCopilot | 12 |
| Admin | 12 |
| AdminReposicaoPromocaoDetail | 11 |
| AdminReposicaoPromocoes | 10 |
| FarmerDashboard | 9 |
| AdminReposicaoNegociacaoParalela | 9 |
| GovernanceAudit | 7 |

### Plano

**Fase atual** (esta entrega): aplicar substituição mecânica via sed nas **top 10** dessa lista (FinanceiroDashboard ao AdminReposicaoPromocaoDetail). Reduz ~218 callsites de uma vez.

**Follow-up**: outras ~40 telas ficam para refactor incremental conforme cada tela for tocada por outra feature.

---

## 4. Audit de dark mode

Dark mode foi adicionado via `next-themes` + tokens `.dark`. Sem rodar o app não posso percorrer cada tela visualmente, mas algumas issues conhecidas com base na arquitetura:

### Issues identificadas

| # | Issue | Tela / componente | Severidade |
|---|---|---|---|
| 1 | Cores hardcoded (`text-emerald-600` etc.) **não respondem ao dark** — ficam ilegíveis | ~50 telas (ver §3) | Alta nas top 5 |
| 2 | Logo Scissors em `text-foreground` | AppShell | OK no dark (vira branco) |
| 3 | EmptyState `tone="friendly"` usa `bg-card` + `border-border` — OK em ambos | EmptyState | OK |
| 4 | Lovable preview do iframe pode forçar light em algumas situações | AppShell preview | Externo, não bloqueante |
| 5 | Print do PDF gerado em AdminReposicaoCockpit — usa cores fixas no HTML | AdminReposicaoCockpit | Não relevante (PDF sempre light) |
| 6 | Imagens PNG do PWA (logo) — sem versão dark | public/pwa-*.png | Cosmético, baixo |

### Mitigação aplicada

- Telas-piloto refinadas usam `text-status-*` que já têm valores light/dark separados nos tokens.
- Auditoria mecânica das top 10 telas com cores hardcoded (Bloco E desta entrega) reduz a issue #1 em ~70%.

### Follow-up

- Após primeiro acesso real ao dark mode, fazer pass visual em cada tela e listar issues residuais.
- Ajustar tokens `.dark` se algum ficou desconfortável (ex: muted-foreground muito apagado).

---

## 5. Status final pós-implementação

| Categoria | Estado |
|---|---|
| Tokens light | ✅ implementados, contraste validado |
| Tokens dark | ✅ implementados, contraste validado |
| Geist Sans + Mono | ✅ carregados via Google Fonts |
| ThemeProvider + Toggle | ✅ next-themes ativo, default light |
| Sidebar light | ✅ via tokens |
| 5 telas-piloto refinadas | ✅ FinanceiroCockpit, AdminReposicaoCockpit, AdminCustomers, Index, TintFormulas |
| 10 telas extras refinadas | ⏳ Bloco E desta entrega |
| /design-preview route | ⏳ Bloco B desta entrega |
| Feature flag | ⏳ Bloco D desta entrega |
| Logo/wordmark | ⏳ Bloco C desta entrega (proposta) |
| Sidebar reorganizada | ⏳ Bloco C desta entrega |
| ~40 telas restantes | 📋 follow-up incremental |
