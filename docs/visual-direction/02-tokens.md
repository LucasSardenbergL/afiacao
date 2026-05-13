# Spec de Tokens — Implementação da Direção Visual

> Data: 2026-05-13 · Implementa decisões de [01-direcao.md](./01-direcao.md). Esta é a referência canônica do que muda em `src/index.css` e `tailwind.config.ts`.

---

## 1. Cores — Light mode (default)

```css
:root {
  /* Backgrounds — escala neutra warm-leaning */
  --background: 0 0% 100%;            /* #FFFFFF — branco puro */
  --foreground: 0 0% 9%;              /* #171717 — preto suave (não puro, evita harshness) */

  --card: 0 0% 100%;
  --card-foreground: 0 0% 9%;

  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 9%;

  --muted: 0 0% 96%;                  /* #F5F5F5 */
  --muted-foreground: 0 0% 45%;       /* #737373 */

  --accent: 0 0% 96%;
  --accent-foreground: 0 0% 9%;

  --secondary: 0 0% 96%;
  --secondary-foreground: 0 0% 9%;

  --border: 0 0% 92%;                 /* #EBEBEB — bordas sutis */
  --input: 0 0% 92%;

  /* Primary — preto (Vercel-style minimal) */
  --primary: 0 0% 9%;                 /* #171717 — botão primary é preto */
  --primary-foreground: 0 0% 100%;
  --ring: 0 0% 9%;                    /* focus ring preto sutil */

  /* Sidebar light coerente — mesma família do conteúdo */
  --sidebar-background: 0 0% 99%;     /* quase branco com leve diferenciação */
  --sidebar-foreground: 0 0% 30%;
  --sidebar-primary: 0 0% 9%;
  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 0 0% 96%;
  --sidebar-accent-foreground: 0 0% 9%;
  --sidebar-border: 0 0% 92%;
  --sidebar-ring: 0 0% 9%;
  --sidebar-muted: 0 0% 60%;

  /* Surfaces — escala discreta de profundidade via cinza */
  --surface-0: 0 0% 100%;
  --surface-1: 0 0% 98%;
  --surface-2: 0 0% 96%;
  --surface-3: 0 0% 92%;

  /* Texto — hierarquia */
  --text-primary: 0 0% 9%;
  --text-secondary: 0 0% 40%;
  --text-tertiary: 0 0% 56%;
  --text-disabled: 0 0% 72%;
  --text-inverse: 0 0% 100%;
  --text-link: 212 80% 50%;           /* azul Vercel sutil só pra links */

  /* Status — dessaturados, calibrados pra uso prolongado */
  --status-success: 142 50% 38%;       /* verde profundo, não emerald-500 */
  --status-success-foreground: 142 50% 22%;
  --status-success-bg: 142 50% 95%;
  --status-warning: 35 80% 45%;        /* amber sóbrio */
  --status-warning-foreground: 35 80% 28%;
  --status-warning-bg: 35 80% 95%;
  --status-error: 0 65% 48%;           /* vermelho marrom-leaning */
  --status-error-foreground: 0 65% 32%;
  --status-error-bg: 0 65% 96%;
  --status-info: 212 80% 50%;          /* azul Vercel info */
  --status-info-foreground: 212 80% 32%;
  --status-info-bg: 212 80% 96%;
  --status-pending: 35 80% 45%;
  --status-progress: 212 80% 50%;
  --status-danger: 0 65% 48%;
  --status-purple: 271 50% 50%;
  --status-purple-foreground: 271 50% 32%;
  --status-purple-bg: 271 50% 96%;
  --status-indigo: 234 60% 50%;
  --status-indigo-foreground: 234 60% 32%;
  --status-indigo-bg: 234 60% 96%;

  /* Destructive (alertas) */
  --destructive: 0 65% 48%;
  --destructive-foreground: 0 0% 100%;

  /* Radius — reduzido pra sharp/sóbrio */
  --radius: 0.375rem;                  /* 6px (era 8px) */

  /* Shadows — quase ausentes; profundidade via border */
  --shadow-xs: none;
  --shadow-sm: 0 1px 2px hsl(0 0% 0% / 0.04);
  --shadow-md: 0 4px 12px hsl(0 0% 0% / 0.06);   /* só overlays */
  --shadow-lg: 0 8px 24px hsl(0 0% 0% / 0.08);   /* só modals */
  --shadow-xl: 0 16px 40px hsl(0 0% 0% / 0.10);
  --shadow-focus: 0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring));

  /* Motion — easing Vercel + escala revisada */
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --duration-overlay: 500ms;
  /* easing aplicado em tailwind.config.ts via animation utilities */
}
```

## 2. Cores — Dark mode

```css
.dark {
  --background: 0 0% 6%;               /* #0F0F0F — preto azulado profundo */
  --foreground: 0 0% 95%;
  --card: 0 0% 8%;
  --card-foreground: 0 0% 95%;
  --popover: 0 0% 8%;
  --popover-foreground: 0 0% 95%;
  --muted: 0 0% 12%;
  --muted-foreground: 0 0% 60%;
  --accent: 0 0% 14%;
  --accent-foreground: 0 0% 95%;
  --secondary: 0 0% 14%;
  --secondary-foreground: 0 0% 95%;
  --border: 0 0% 14%;
  --input: 0 0% 14%;
  --primary: 0 0% 95%;                 /* botão primary é branco no dark */
  --primary-foreground: 0 0% 9%;
  --ring: 0 0% 95%;

  --sidebar-background: 0 0% 5%;
  --sidebar-foreground: 0 0% 70%;
  --sidebar-primary: 0 0% 95%;
  --sidebar-primary-foreground: 0 0% 9%;
  --sidebar-accent: 0 0% 12%;
  --sidebar-accent-foreground: 0 0% 95%;
  --sidebar-border: 0 0% 14%;
  --sidebar-ring: 0 0% 95%;
  --sidebar-muted: 0 0% 50%;

  --surface-0: 0 0% 6%;
  --surface-1: 0 0% 8%;
  --surface-2: 0 0% 12%;
  --surface-3: 0 0% 16%;

  --text-primary: 0 0% 95%;
  --text-secondary: 0 0% 70%;
  --text-tertiary: 0 0% 50%;
  --text-disabled: 0 0% 35%;
  --text-inverse: 0 0% 9%;
  --text-link: 212 80% 65%;

  --status-success: 142 60% 55%;
  --status-success-foreground: 142 60% 80%;
  --status-success-bg: 142 50% 12%;
  --status-warning: 35 80% 60%;
  --status-warning-foreground: 35 80% 80%;
  --status-warning-bg: 35 60% 12%;
  --status-error: 0 70% 60%;
  --status-error-foreground: 0 70% 85%;
  --status-error-bg: 0 50% 12%;
  --status-info: 212 80% 65%;
  --status-info-foreground: 212 80% 85%;
  --status-info-bg: 212 50% 12%;
  --status-pending: 35 80% 60%;
  --status-progress: 212 80% 65%;
  --status-danger: 0 70% 60%;
  --status-purple: 271 60% 65%;
  --status-purple-foreground: 271 60% 85%;
  --status-purple-bg: 271 40% 14%;
  --status-indigo: 234 70% 65%;
  --status-indigo-foreground: 234 70% 85%;
  --status-indigo-bg: 234 50% 14%;

  --destructive: 0 70% 60%;
  --destructive-foreground: 0 0% 100%;

  --shadow-sm: 0 1px 2px hsl(0 0% 0% / 0.40);
  --shadow-md: 0 4px 12px hsl(0 0% 0% / 0.50);
  --shadow-lg: 0 8px 24px hsl(0 0% 0% / 0.60);
}
```

## 3. Tipografia

### Fontes carregadas

```html
<!-- index.html -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
```

> Geist é hospedado oficialmente no Google Fonts (gratuito, mesma fonte que a Vercel usa).

### Configuração Tailwind

```ts
// tailwind.config.ts
fontFamily: {
  sans: ["Geist", "Inter", "system-ui", "-apple-system", "sans-serif"],
  mono: ["'Geist Mono'", "'JetBrains Mono'", "Fira Code", "monospace"],
},
```

> Inter fica como fallback (zero risco de FOUT/FOIT).

### Body / typography defaults

```css
body {
  font-family: 'Geist', 'Inter', system-ui, sans-serif;
  font-feature-settings: 'tnum', 'cv02', 'cv03', 'cv11';  /* tnum = tabular nums global */
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: -0.005em;             /* -0.5%, sutil tightening */
}

h1, h2, h3, h4 {
  letter-spacing: -0.02em;              /* -2%, premium feel */
  line-height: 1.15;
  font-weight: 600;                     /* não 700 — peso menor parece mais "fino" */
}
h1 { font-size: 1.5rem; }   /* 24px (era 24px, mantém) */
h2 { font-size: 1.25rem; }  /* 20px */
h3 { font-size: 1rem; }     /* 16px */
h4 { font-size: 0.875rem; } /* 14px */
```

### Utility para KPIs grandes (financeiro / cockpit)

```css
.kpi-value {
  font-family: 'Geist Mono', 'JetBrains Mono', monospace;
  font-feature-settings: 'tnum';
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
```

> Aplicar em valores de KPI no FinanceiroCockpit, AdminReposicaoCockpit.

## 4. Motion — easing Vercel

```css
:root {
  --easing-default: cubic-bezier(0.16, 1, 0.3, 1);
}
```

```ts
// tailwind.config.ts — substituir keyframes existentes
animation: {
  "accordion-down": "accordion-down 200ms cubic-bezier(0.16, 1, 0.3, 1)",
  "accordion-up": "accordion-up 200ms cubic-bezier(0.16, 1, 0.3, 1)",
  "fade-in": "fade-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both",
  "scale-in": "scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1) both",
  "slide-in-right": "slide-in-right 300ms cubic-bezier(0.16, 1, 0.3, 1)",
  "slide-up": "slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1) both",
}
```

## 5. Touch targets

Manter as variantes do button.tsx que adicionei (`touch` 44px, `balcao` 56px) — adequadas pra novo estilo. Sem mudança.

## 6. Body global ajuste

```css
button, a, [role="button"] {
  min-height: 32px;
  transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1);  /* hover suave */
}
```

## 7. Plano de implementação

### A. Carregar Geist (1 mudança em `index.html`)

Trocar links Google Fonts atuais (Inter, Bebas Neue, Space Grotesk) por Geist + Geist Mono.

### B. Atualizar `tailwind.config.ts`

- `fontFamily.sans` → Geist primeiro
- `fontFamily.mono` → Geist Mono primeiro
- `animation.*` → easing Vercel

### C. Reescrever `src/index.css`

Substituir as definições de tokens light/dark conforme seções 1-2 acima. Manter as utilities .density-compact, .status-*, .text-status-*, etc. (criadas na Fase 4 da auditoria).

### D. Adicionar ThemeProvider e ThemeToggle

- Usar `next-themes` (já instalado, package.json linha 61)
- Wrap em App.tsx
- Criar `src/components/shell/ThemeToggle.tsx` com ícones Sun/Moon
- Adicionar ao topbar (depois do CompanySwitcher, antes do NetworkStatusIndicator)

### E. Refactor `AppShell.tsx`

- Remover hardcode `bg-sidebar` referenciando dark — agora `--sidebar-background` é light por default
- Logo `Scissors` ganha cor `text-foreground` em vez de `text-primary` (evita ruxo de cor primary nos logos)

### F. Refinement das 5 telas-piloto (Nível 2)

Lista detalhada vai pra `03-pilotos.md`, mas resumo:

1. **FinanceiroCockpit** — KPIs com `.kpi-value` (Geist Mono), substituir `text-emerald-600`/`text-red-600` por `text-status-*`
2. **AdminReposicaoCockpit** — substituir cores hardcoded em badges, hierarquia visual nos headers
3. **AdminCustomers** — segmentos com novos tokens, tabela com hover sutil
4. **Index/Home** — usar nova hierarquia tipográfica, KPIs com `.kpi-value`
5. **TintFormulas** — valores R$ em mono, badges com tokens status-*

---

## 8. O que fica fora desta entrega

- Refactor das outras 114 telas (cores hardcoded em outros lugares) — feito incremental conforme cada tela é tocada
- Logo Colacor novo — manteremos `Scissors` como ícone temporário (pode ser repensado em outra fase)
- Modo high-contrast / acessibilidade WCAG AAA — defer
- Animação de logo / splash screen — defer

Próximo: implementar A-F em sequência. Não vai ter mais doc — código direto.
