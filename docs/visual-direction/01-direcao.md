# Direção Visual — Reposicionamento "Fintech/SaaS Premium"

> Data: 2026-05-13 · Inputs: Vercel, Mercury, Stripe Dashboard como referências · Light + dark com toggle · Reposicionar identidade.
>
> **Esta fase NÃO toca em código.** Define direção visual antes de implementar. Próximo passo é spec de tokens (`02-tokens.md`) e telas-piloto (`03-pilotos.md`).

---

## 1. Diagnóstico do visual atual

O app hoje carrega uma identidade **HubSpot Canvas + Polaris + Gong** declarada no `DesignSystem.tsx`. O que isso significa visualmente, na prática:

| Atributo | Estado atual | Como soa |
|---|---|---|
| **Paleta primária** | Azul `hsl(222 83% 53%)` saturado, tipo HubSpot/Material | Corporativo "década passada" |
| **Background** | Cinza claro azulado `hsl(220 14% 96%)` | OK, mas genérico |
| **Sidebar** | Dark fixa `hsl(220 25% 11%)` | Vibe Canvas/Notion sidebar, mas contraste alto destoa do resto |
| **Tipografia** | Inter (sans), JetBrains Mono (mono) | Boa escolha, mas usa só pesos básicos |
| **Border radius** | `0.5rem` em tudo | Médio — nem moderno-quadrado nem retrô-redondo |
| **Cards** | Sombras suaves multi-camada, border sutil | Padrão shadcn — "limpo mas sem alma" |
| **Botões** | `h-9` default, primary azul cheio | Funcional, sem refinamento |
| **Densidade** | `density-compact` global (32px input / 36px row) | Boa pra B2B |
| **Motion** | 100/200/350ms com `cubic-bezier(0.4, 0, 0.2, 1)` Material | Sem assinatura própria |
| **Numbers / valores** | Inter regular | Sem tabular nums → valores "dançam" em tabelas |
| **Cores semânticas** | Definidas em tokens, mas usadas com cores cruas (emerald/red/amber) em 50+ lugares | Inconsistente |

**Veredicto**: o app hoje comunica **"sistema interno corporativo razoável"**. Não comunica **"premium", "moderno", "expensive feeling"**. Os componentes shadcn dão um piso decente, mas nenhuma escolha visual cria identidade.

---

## 2. O que Vercel, Mercury e Stripe Dashboard têm em comum

Vou destilar os patterns visuais compartilhados entre os 3 — é isso que vai virar a base do nosso sistema.

### 2.1 Tipografia geométrica + tabular nums obrigatório

- **Vercel** usa Geist Sans (font própria, geométrica neo-grotesque) + Geist Mono pra código/valores
- **Mercury** combina Domine (display serif, só em headlines grandes) + Inter (body) + IBM Plex Mono (números financeiros)
- **Stripe** usa Stripe Sans (variante Inter customizada) com `font-feature-settings: 'tnum'` em qualquer número

**Padrão comum**: dois tipos — um geométrico sans pra UI body + um mono ou tabular pra valores. Números **nunca** em proporcional. Headlines em pesos 500/600, não 700 (peso menor = sensação mais "fina" e premium).

### 2.2 Paleta: 1 cor primária minimal + escala neutra cuidadosa

- **Vercel**: preto/branco absoluto (`#000` / `#FFF`), com escala Gray bem trabalhada (`gray-50` a `gray-1000`). Acentos só em estados (azul focus, vermelho erro)
- **Mercury**: roxo `#5E36BF` (acento), branco quente `#FAFAFA` (light) ou preto azulado (dark), escala neutral warm-leaning
- **Stripe Dashboard**: roxo Stripe `#635BFF`, branco `#FFF`, cinzas neutros

**Padrão comum**: **uma cor de identidade só**, usada com parcimônia (botão primário, link, focus ring). O resto é escala neutra de 10-12 tons. Nada de azul + verde + amarelo + roxo na mesma tela. As cores semânticas (success/warning/error) existem mas usam tons dessaturados.

### 2.3 Borders 1px finas + sombras quase ausentes

- **Vercel**: `border: 1px solid hsl(0 0% 92%)` em light, `hsl(0 0% 14%)` em dark. Sombra praticamente zero.
- **Mercury**: sombras só em popovers/modals, com ofset pequeno e cor preta com 5-8% opacidade
- **Stripe Dashboard**: sombras box-shadow `0 1px 3px rgba(0,0,0,0.05)` no máximo

**Padrão comum**: **profundidade é dada por borders, não por sombras**. Sombras existem só em elementos que sobrepõem (modals, dropdowns, tooltips). Cards do conteúdo principal raramente têm shadow.

### 2.4 Densidade média (não comprimida) + leading generoso em headlines

- Inputs entre 36-40px de altura (não 32, não 48)
- Row de tabela entre 40-48px
- Padding de cards 16-24px
- **Headlines com `line-height: 1.1-1.2`** e `letter-spacing: -0.02em` — isso é a assinatura "premium". Faz títulos parecerem tipográficos, não funcionais.

### 2.5 Motion sóbrio com easing custom

- Vercel usa `cubic-bezier(0.16, 1, 0.3, 1)` em quase tudo (easeOutQuint) — assinatura "polished, suave"
- Durações curtas: 150ms hover, 200ms focus, 300ms layout, 500ms overlay
- **Nada de bounce/spring**. Sem motion exagerado.

### 2.6 Sidebar light, não dark (Vercel/Stripe) OU dark sutil (Mercury)

- **Vercel**: sidebar com mesmo background do conteúdo, apenas border-right e contraste de texto
- **Stripe**: sidebar `#0A2540` (azul-preto, não preto puro)
- **Mercury**: dark unifies sidebar com header

**Padrão comum**: **dark sidebar fica datado em 2026**. A tendência atual é sidebar light coerente com conteúdo (Vercel/Stripe) ou dark global em todo o app (Linear/Mercury dark). **Misturar sidebar dark + content light é o look "2018-2020".**

### 2.7 Numbers e dados são protagonistas

- Stripe Dashboard: KPIs em fonte 32-48px com peso 500, com letter-spacing apertado
- Mercury: saldo da conta enorme, com valor em tabular mono
- Vercel Analytics: métricas grandes, gráficos minimalistas

**Padrão comum**: o número é o sujeito da frase visual. Label vira coadjuvante (menor, mais clara). Isso é diferente do estilo atual (KPI label e value parecidos em peso).

---

## 3. Como isso se traduz pra Afiação

7 dimensões com a direção proposta. Cada uma tem 2-3 caminhos pra você decidir.

### Dimensão A — Paleta primária

> **Atual**: azul HubSpot `hsl(222 83% 53%)`

| Caminho | Como fica | Sensação |
|---|---|---|
| **A1 — Preto/branco minimal (Vercel)** | Primary `#000` (light) / `#FFF` (dark). Acentos só em focus/estados. Maximalmente neutro. | Frio, ultra-premium, "expensive". Risco: pode parecer estéril ou genérico se mal executado. |
| **A2 — Roxo/Indigo profundo (Mercury/Stripe)** | Primary tipo `hsl(258 90% 66%)` (roxo Mercury) ou `hsl(243 75% 59%)` (indigo Stripe). | Distintivo, identifica imediatamente como "fintech premium". Risco: precisa combinar com escala neutra impecável pra não virar "kid". |
| **A3 — Verde profundo (financeiro sério)** | Primary tipo `hsl(160 84% 25%)` (verde Stripe, próximo do Plaid). | "Money serious". Faz sentido pra app financeiro, mas pode soar conservador demais pra módulos não-financeiros (Tintométrico, Picking). |
| **A4 — Azul refinado** | Manter família azul mas dessaturar — algo tipo `hsl(217 91% 60%)` (Tailwind blue-500 mas mais profundo). | Familiar mas atualizado. Menor disruption visual. Risco: continua "corporativo". |

> Recomendação: **A2 (roxo/indigo profundo)** dado o briefing "fintech premium". Distingue Afiação visualmente da pasta de "sistemas internos corporativos". Roxo Mercury especificamente é menos comum no Brasil — diferencia.

### Dimensão B — Sidebar

> **Atual**: dark fixa `hsl(220 25% 11%)`, sempre

| Caminho | Como fica |
|---|---|
| **B1 — Sidebar light, coerente com conteúdo (Vercel/Stripe)** | Fundo branco/cinza muito claro, border-right 1px, texto em escala de cinza. No dark mode, vira escuro coerente. |
| **B2 — Sidebar dark global (Linear, Mercury dark)** | App inteiro dark por default. Light é opcional. Faz sentido se você quer comprometer com "dark first". |
| **B3 — Sidebar dark + content light (atual, mantém)** | Conserva o que tem hoje. Mais conservador. |

> Recomendação: **B1**. É o padrão atual SOTA. O dark do shell pode ficar pesado depois de 6h olhando. Sidebar light fica mais sofisticado e flexível.

### Dimensão C — Tipografia

> **Atual**: Inter + JetBrains Mono

| Caminho | Como fica |
|---|---|
| **C1 — Geist Sans + Geist Mono (Vercel custom)** | Tipografia mais geométrica que Inter. Vercel libera Geist como open source. Mudança visualmente perceptível. |
| **C2 — Inter Tight (display) + Inter (body) + JetBrains Mono (numbers)** | Mantém Inter base. Inter Tight em headers grandes dá o "premium feel". Mínimo de risco. |
| **C3 — Manter Inter atual mas ativar features (tnum, ss01, cv11)** | Sem trocar fonte. Só ativar tabular nums em valores + stylistic sets em headings. Quase free. |

> Recomendação: **C1 (Geist)**. Mudança mais marcante alinhada ao briefing fintech-premium. Free, open source, suportado oficialmente pela Vercel. Aplicar em paralelo: features tnum/ss01 nos números.

### Dimensão D — Border radius e densidade visual

> **Atual**: `--radius: 0.5rem` (8px) em tudo

| Caminho | Como fica |
|---|---|
| **D1 — Reduzir pra `0.375rem` (6px)** e `0.5rem` só em modals (Vercel/Mercury) | Mais sóbrio, mais "geométrico". |
| **D2 — Aumentar pra `0.625rem` (10px)** em todos | Mais friendly, mais Stripe-landing-page. Não combina com fintech sério. |
| **D3 — Manter `0.5rem`** | Sem mudança. |

> Recomendação: **D1**. Pequena mudança que muda muito a sensação. Botões e cards ficam mais "sharp".

### Dimensão E — Sombras e profundidade

> **Atual**: sombras suaves multi-camada

| Caminho | Como fica |
|---|---|
| **E1 — Borders 1px finas dominantes + sombras só em overlay (Vercel)** | Cards e KPIs sem shadow. Só dropdown/modal/tooltip têm `0 4px 12px rgba(0,0,0,0.08)`. |
| **E2 — Sombra ultra-sutil em cards (`0 1px 2px rgba(0,0,0,0.04)`) + bigger em overlay (Stripe)** | Pequena profundidade no estado base, mais em overlay. |
| **E3 — Manter sombras atuais** | Sem mudança. |

> Recomendação: **E1**. Mais limpo. Borders bem trabalhadas dão a profundidade necessária.

### Dimensão F — Tipografia de números

> **Atual**: Inter regular, números proporcionais

| Caminho | Como fica |
|---|---|
| **F1 — `font-feature-settings: 'tnum'` global em valores** | Números viram tabulares (mesma largura). Tabelas alinham perfeitamente. Free, só configuração. |
| **F2 — F1 + JetBrains Mono em KPIs grandes** | KPIs financeiros viram quase "ticker de bolsa". Mais técnico. |
| **F3 — Manter atual** | Sem mudança. |

> Recomendação: **F1 + F2 só em telas financeiras** (FinanceiroCockpit, AdminReposicaoCockpit). Outras telas ficam com tnum no Inter mesmo.

### Dimensão G — Motion

> **Atual**: 100/200/350ms com easing Material

| Caminho | Como fica |
|---|---|
| **G1 — Easing Vercel custom `cubic-bezier(0.16, 1, 0.3, 1)` + 150/200/300/500ms** | Motion polida, suave. Hover ficam "premium". |
| **G2 — Manter atual** | Sem mudança. |

> Recomendação: **G1**. Mudança quase invisível mas notavelmente mais elegante. Aplica em tudo (hover, focus, transitions, dialogs).

---

## 4. Spec preliminar de tokens (para `02-tokens.md`)

Esboço do que vai mudar em `src/index.css` se você aprovar A2/B1/C1/D1/E1/F1/G1. Detalhamento fica para próxima fase.

```
/* Cores — Light */
--primary: 258 90% 66%;          /* roxo Mercury-like */
--primary-foreground: 0 0% 100%;
--background: 0 0% 100%;          /* branco puro */
--foreground: 0 0% 9%;            /* preto suave */
--muted: 0 0% 96%;
--muted-foreground: 0 0% 45%;
--border: 0 0% 92%;
--card: 0 0% 100%;
--sidebar-background: 0 0% 99%;   /* sidebar light agora */
--sidebar-foreground: 0 0% 30%;
--sidebar-border: 0 0% 92%;

/* Cores — Dark */
--background: 0 0% 6%;            /* preto azulado profundo */
--foreground: 0 0% 95%;
--muted: 0 0% 12%;
--muted-foreground: 0 0% 60%;
--border: 0 0% 14%;
--card: 0 0% 8%;
--sidebar-background: 0 0% 5%;
--sidebar-foreground: 0 0% 70%;
--sidebar-border: 0 0% 14%;
--primary: 258 90% 70%;           /* roxo um pouco mais brilhante no dark */

/* Tipografia */
font-family-sans: 'Geist', system-ui, sans-serif;
font-family-mono: 'Geist Mono', JetBrains Mono, monospace;
font-feature-settings: 'tnum', 'ss01';
heading-tracking: -0.02em;
heading-line-height: 1.15;

/* Radius */
--radius: 0.375rem;

/* Shadow */
--shadow-xs: none;
--shadow-sm: 0 1px 2px hsl(0 0% 0% / 0.04);
--shadow-md: 0 4px 12px hsl(0 0% 0% / 0.08);  /* só em overlays */
--shadow-lg: 0 8px 24px hsl(0 0% 0% / 0.12);  /* só em modals */

/* Motion */
--easing-default: cubic-bezier(0.16, 1, 0.3, 1);
--duration-fast: 150ms;
--duration-normal: 200ms;
--duration-slow: 300ms;
--duration-overlay: 500ms;
```

---

## 5. Decisões registradas (2026-05-13)

Após segunda rodada questionando fadiga em uso diário 8h:

| Dimensão | Decisão | Justificativa |
|---|---|---|
| A — Paleta primária | **A1 ajustado — Quase-neutro estilo Vercel/Linear** | Roxo `hsl 258 90% 66%` original tinha saturação alta demais pra uso prolongado. Quase-neutro elimina fadiga visual e desloca identidade pra tipografia/spacing/detalhe. |
| B — Sidebar | **B1 — Light coerente com conteúdo** | Padrão SOTA. Sidebar dark + content light é look 2018-2020. |
| C — Tipografia | **C1 — Geist Sans + Geist Mono** | Vercel font, free, geométrica premium. |
| D — Radius | **D1 — Reduzir pra 6px** | Mais sharp, alinhado a Vercel/Linear. |
| E — Sombras | **E1 — Borders 1px dominantes** | Sombras só em overlay (modal/dropdown). |
| F — Números | **F1 — Tabular nums global + Geist Mono em KPIs financeiros** | Valores nunca dançam em tabelas. KPIs financeiros viram "ticker premium". |
| G — Motion | **G1 — Easing Vercel custom + 150/200/300/500ms** | Assinatura "polida" sem ser dramática. |

### Implicação chave: status colors viram o coração das cores

Com primary neutro, **todo o sinal visual de estado** (sucesso, alerta, erro, info) precisa ser bem calibrado:

- **Success** — verde profundo dessaturado `hsl(142 50% 38%)` (não emerald-500 saturado)
- **Warning** — amber/orange dessaturado `hsl(35 80% 45%)` (não amber-500 puro)
- **Error** — vermelho marrom-leaning `hsl(0 72% 45%)` (não red-500 saturado)
- **Info** — azul Vercel sutil `hsl(212 80% 50%)`

Todos com versões `-bg` muito claras (light) ou muito escuras (dark) pra fundos de badge/banner. **Esses tons são as únicas cores cromáticas na tela — precisam aguentar uso prolongado.**

## 6. Próxima decisão pendente

**Telas-piloto pra validar a direção**:

- **Opção α** — `FinanceiroCockpit` + `AdminReposicaoCockpit`: telas analíticas, alta densidade, KPIs financeiros (boa pra mostrar tabular nums + Geist Mono). Risco: complexidade alta, pode demorar.
- **Opção β** — `Index/Home`: cobre todas as personas (staff vê pedidos, customer vê dashboard), é a primeira impressão visual. Mais simples mas menos "demonstração de poder visual".
- **Opção γ** — `AdminCustomers`: tabela densa com filtros, segmentos (que acabamos de implementar), avatar de cliente. Boa pra mostrar tipografia + tabela + chips + tabular nums em coluna "gasto mensal".

Próximo doc (`02-tokens.md`) é independente da escolha — define os tokens novos no nível CSS. Mas `03-pilotos.md` depende dessa escolha. Aguardo sua resposta.
