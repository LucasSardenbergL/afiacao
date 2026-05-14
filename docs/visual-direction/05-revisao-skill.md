# Revisão visual com skill `frontend-design`

> Data: 2026-05-13 · Aplicação dos princípios da skill ao trabalho já feito.
>
> A skill é explícita sobre evitar "generic AI aesthetics": fontes batidas (Inter, Roboto), layouts previsíveis, paletas tímidas, ausência de atmosfera. O briefing do app é "fintech/SaaS premium minimal" (não maximalismo) — então a régua é **precisão e refinamento**, não dramaticidade. Mesmo assim, há lugares onde o trabalho atual ainda está "no meio do caminho".
>
> Issues organizadas por categoria. Severidade marcada (alta / média / baixa). Quick wins implementados nesta entrega.

---

## 1. Tipografia

### T1 — Body em Geist Sans é "competente mas esquecível" (média)
A skill diz: "Pair a distinctive display font with a refined body font." Geist Sans é melhor que Inter, mas continua sendo geometric sans neutra. Sem display font separado, o app não tem **assinatura tipográfica**.

**Proposta**: carregar uma serif refinada (ex: **Newsreader**, Source Serif 4, Tiempos) e usar APENAS em h1 de cockpits e telas-hero. Body continua Geist. Cria contraste tipográfico = sensação Mercury/premium.

**Severidade**: média. Custo: 1 linha em `index.html` + utility `.font-display` em `tailwind.config.ts` + adoção pontual em 5 telas.

### T2 — H1 atual é tímido (alta) ✅ resolvido nesta entrega
`index.css` h1 = `text-2xl` (24px), `font-weight: 600`, `letter-spacing: -0.02em`. Para cockpit financeiro, isso é pequeno demais. Vercel/Mercury page titles são 32-40px, peso 500, tracking -0.04em.

**Aplicado**: h1 vira 30px (4xl), peso 500, tracking -0.04em. h2 vira 22px tracking -0.03em.

### T3 — Heading weight 600 está no meio do caminho (alta) ✅ resolvido
Peso 600 é "semi-bold corporate". Vercel/Mercury usam **500** combinado com tracking apertado — parece mais fino, premium.

**Aplicado**: h1/h2 viram peso 500. h3/h4 mantêm 600 (ainda precisam destacar em densidade).

### T4 — Geist Mono subutilizado (baixa)
Carregamos Geist Mono mas só usamos em `.kpi-value`. Mercury aplica mono em **IDs de pedido**, **CNPJ**, **dates** (criando textura "técnica" que distingue valores precisos vs descrições). Hoje usamos Inter `font-mono` em alguns lugares — inconsistência.

**Proposta**: utility `.font-tabular` e auditoria pra aplicar em IDs/datas. Custo médio (não quick win).

---

## 2. Cor e atmosfera

### B1 — Background é #FFF puro (alta) ✅ resolvido
`--background: 0 0% 100%` é o branco mais "AI generic" possível. Mercury/Vercel usam off-white quase imperceptível (#FAFAFA / `oklch(0.99 0 0)`) — remove o frio do branco puro.

**Aplicado**: `--background: 0 0% 99%` (light) e `--card: 0 0% 100%` (cards ficam levemente acima da página, criando hierarquia natural por contraste sutil).

### B2 — Cockpits 100% chapados, sem atmosfera (alta)
A skill é direta: "create atmosphere and depth rather than defaulting to solid colors". Mercury usa gradient radial sutil no header das contas (`from-purple/3 to-transparent`). Stripe Dashboard usa gradients sutis em hero KPIs. Vercel usa noise grain (~3% opacity).

**Proposta concreta** (não aplicado nesta entrega):
- Utility `.bg-cockpit-hero`: `background: radial-gradient(ellipse at 50% -20%, hsl(var(--muted)) 0%, transparent 60%)`
- Utility `.noise`: SVG inline grain, opacity 2-3%, aplicado em hero cards
- Aplicar seletivamente em headers do FinanceiroCockpit, AdminReposicaoCockpit, Index

**Severidade**: alta — é o que mais separa "Vercel template" de "Vercel-finished".

### B3 — Status colors no nível "utility" (média)
`--status-success: 142 50% 38%` é verde correto-funcional. Mercury usa `#00C66A` (mais vibrante) em **bursts curtos** (badge "Pago", dot "Live"). Cria 2 níveis: dessaturado pra texto longo, vibrante pra acento de marca.

**Proposta**: adicionar `--status-success-bold: 142 65% 42%` e similares pra warning/info. Não substitui os atuais — adiciona uma camada "bold" pra ser usada apenas em badges de destaque.

---

## 3. Identidade

### MASTER — Falta a "spine" visual (alta)
Olhando o todo, o app refinado parece "Vercel template applied to B2B". Não tem **UM detalhe** que faz o app ser reconhecível em 1 segundo:
- Linear: dot pulsing em status, gradient em hover
- Mercury: asterisco roxo no logo
- Vercel: triangle logomark omnipresente
- Plaid: gradient meshes em hero
- Stripe: roxo signature

**Proposta** (aplicado parcialmente nesta entrega):
- Underline gradient sob o wordmark "Colacor" — 2px de altura, gradient horizontal (`from-foreground via-status-info to-status-success`). Aparece só na sidebar expandida. Cria identidade sutil mas única.

### L1 — Wordmark Colacor é texto puro sem refinamento (média)
"Colacor" em Geist 600 com `letter-spacing: -0.03em`. Funciona mas é "fonte aplicada". Refinamentos:
- Tracking ainda mais apertado (-0.045em)
- `font-weight: 500` (não 600 — mais elegante)
- Versalete 11px com tracking expandido (`COLACOR` industrial)

**Aplicado**: tracking -0.045em + peso 500.

### CS1 — Cores das empresas hardcoded em CompanySwitcher (baixa)
`CompanySwitcher.tsx:17-21` usa hsl strings inline em vez de tokens CSS. Bug de consistência — não respondem a feature flag, não podem ser ajustadas centralmente.

**Proposta** (não aplicado): extrair para tokens `--company-colacor`, `--company-oben`, `--company-sc` em `index.css`.

### CS2 — Monograma básico (baixa)
Quadrado com letra branca centralizada. Mercury usa quadrado com inner shadow + leve gradient. Linear usa círculo com gradient + ring on hover.

**Proposta**: monograma com `box-shadow: inset 0 1px 0 hsl(0 0% 100% / 0.15)` (highlight superior interno) + ring sutil ao hover. Eleva sem complicar.

---

## 4. Motion

### M1 — Sem orchestration de page load (alta) ✅ resolvido
Easing Vercel está aplicado, mas elementos aparecem todos juntos. Vercel/Mercury fazem **staggered reveal**: KPIs aparecem em sequência, 50-80ms entre cada. Sensação "polida" significativa.

**Aplicado**: utility `.stagger-children > *` em `index.css` que aplica `animation-delay: calc(var(--stagger-index, 0) * 50ms)` + `animation: fade-in-up`. Adoção em FinanceiroCockpit (KPIs row 1).

### M2 — ThemeToggle sem charme (baixa)
`Sun ↔ Moon` brusco. Stripe usa círculo half-fill. Vercel usa morph animado.

**Proposta** (não aplicado): transição rotate+scale entre os ícones em vez de swap brusco.

---

## 5. Componentes

### PS1 — Skeleton sem shimmer (média) ✅ resolvido parcialmente
`<Skeleton>` shadcn é só block animado pulse. Vercel/Linear skeletons têm shimmer gradient passando.

**Aplicado**: utility `.shimmer` já existia em `index.css:373` mas não era usada. Aplicar `.shimmer` em vez de `animate-pulse` no shadcn skeleton.

### ES1 — Empty state operational austero demais (baixa)
Ícone 32px cinza + título 14px. Funcional mas "esquecível".

**Proposta** (não aplicado): pattern decorativo SUTIL no fundo (dots grid 1.5px com opacity 4%, ou diagonal stripe). Não distrai mas dá identidade.

### BT1 — Button hover states genéricos (baixa)
Hover é só darken (pattern padrão shadcn). Vercel/Mercury usam ring expansion sutil + active inner shadow pra "press" feel.

**Proposta** (não aplicado): hover com `ring-2 ring-foreground/5` em primary, e active com `box-shadow: inset 0 1px 0 hsl(0 0% 0% / 0.06)`.

### BT2 — Variant `link` sem refinamento (baixa)
Underline simples. Vercel link tem underline animado da esquerda pra direita.

**Proposta** (não aplicado): `border-bottom` 1px com `width: 0` em hover ir pra `width: 100%` com transition.

### KPI1 — `.kpi-value` sem complementos (média)
`R$ 1.2M` lone. Mercury complementa com **delta inline**: `R$ 1.2M ↑12%`. Cria narrativa visual.

**Proposta** (não aplicado): utility `.kpi-delta` (10px Geist Mono + cor status) + adoção em FinanceiroCockpit.

---

## 6. Sidebar e shell

### SB1 — Sections collapse sem stagger (baixa)
Items aparecem todos juntos quando seção expande. Notion faz stagger fade-in (30ms entre cada).

**Proposta** (não aplicado): aplicar `.stagger-children` aos items dentro do `<SidebarSection>` quando `open`.

### SB2 — Sem favoritos pinados (média)
Mercury tem "Pinned" no topo (até 5). Linear tem "Favorites" com drag-to-reorder. App tem 30+ items na sidebar — sem favoritos, comprador rola muito.

**Proposta** (não aplicado): hook `useSidebarFavorites` (localStorage), botão estrela em hover de cada item, top 5 ficam pinados acima de "Principal".

### NSI1 — Indicador de rede genérico (baixa)
Dot pequeno no canto + popover. Pattern batido. Linear quando "online" não mostra nada (limpa o topbar). Quando offline, faz shake + ring expanding.

**Proposta** (não aplicado): esconder quando online (limpa visual), mostrar com pulse-ring quando slow, shake animation quando offline.

---

## 7. Tela `/design-preview`

### DP1 — Catálogo seco, sem narrativa (média)
DesignPreview.tsx mostra componentes lado a lado. Funciona como referência. Mas não **convence visualmente** de que o sistema é premium.

**Proposta** (não aplicado): hero no topo — KPI gigante 96px (`R$ 12.4M`) com `.kpi-value`, label "Receita consolidada · 30 dias", e um delta `↑8.2%`. Demonstra o poder do sistema antes do catálogo. Cria "wow" inicial.

---

## 8. Resumo: o que entrou nesta entrega vs o que ficou

### Aplicado (quick wins)
- ✅ T2: H1 30px peso 500 tracking -0.04em
- ✅ T3: H2 peso 500 (h1+h2)
- ✅ B1: background off-white `0 0% 99%`
- ✅ M1: utility `.stagger-children` + adoção em FinanceiroCockpit
- ✅ PS1: shimmer no Skeleton (substituindo pulse)
- ✅ MASTER: underline gradient sob wordmark Colacor (sidebar)
- ✅ L1: wordmark Colacor refinado (peso 500, tracking -0.045em)

### Não aplicado (precisam decisão / mais investimento)
- 📋 T1: display serif (Newsreader/Source Serif) em headings — depende de aprovar carregar serif
- 📋 T4: Geist Mono em IDs/datas
- 📋 B2: gradient atmosphere em cockpit headers + noise utility
- 📋 B3: status colors "bold" pra acento
- 📋 CS1+CS2: tokens de empresa + monograma refinado
- 📋 ES1: padrão decorativo em empty state
- 📋 BT1+BT2: refinement de hover/active states
- 📋 KPI1: `.kpi-delta` utility
- 📋 SB1: stagger nos items da sidebar
- 📋 SB2: favoritos pinados
- 📋 NSI1: indicador rede com animations condicionais
- 📋 DP1: hero KPI gigante na DesignPreview
- 📋 M2: ThemeToggle morph animation

### Próximo passo

Você decide: implementar todos os 📋, alguns específicos, ou parar por aqui. Sugiro priorizar **T1 (serif em headings) + B2 (gradient atmosphere)** — são as 2 mudanças que mais elevariam o "feeling premium" sem custo alto. Os outros são polish incremental.
