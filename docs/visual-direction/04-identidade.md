# Identidade visual — logo, wordmark, sidebar

> Data: 2026-05-13 · Define logo/wordmark e a estrutura nova da sidebar.

---

## 1. Logo / wordmark — 3 propostas

### Opção A — Wordmark "Colacor" puro (recomendado)

**Sem ícone.** Só o texto "Colacor" em Geist Sans 600, tracking apertado (-0.03em).

```
Colacor
```

Sidebar mostra: `Colacor` (light foreground), com o logotipo discreto e premium. No collapsed mode, só a inicial `C` em quadrado 32×32 com border `--border` e background `--muted`.

- **Vantagens**: zero ambiguidade de marca (afiação não é mais o protagonista). Estilo Vercel ("Vercel" sem ícone), Mercury ("Mercury" com asterisco discreto).
- **Custo**: nenhum design de ícone necessário.
- **Risco**: pode parecer "sem identidade visual" — depende de Geist + tracking + cor entregar a personalidade.

### Opção B — Símbolo abstrato + wordmark

Quadrado preto preenchido com letra `C` branca, dimensão 24×24, ao lado do wordmark `Colacor`.

```
█C  Colacor
```

- **Vantagens**: ícone funciona standalone (favicon, PWA, sidebar collapsed). Transmite "marca estabelecida".
- **Custo**: 30min pra desenhar variantes (favicon 32px, PWA 192/512, monochrome).
- **Risco**: símbolo genérico pode soar "corporativo qualquer um".

### Opção C — Símbolo de abrasivo (granulado/textura)

Padrão de 9 pontos formando um quadrado (`⠿` ou similar), referenciando textura de lixa/abrasivo. Sutil, geométrico, premium.

```
⠿⠿  Colacor
```

- **Vantagens**: liga visualmente ao negócio (abrasivos) sem ser literal (lixa explícita seria foklórico). Distintivo.
- **Custo**: precisa testar com vários tamanhos pra garantir que não vira ruído.
- **Risco**: público interno pode não pegar a metáfora.

### Recomendação: **Opção A** — wordmark puro

Razão: alinhado a Vercel/Mercury (referências), zero custo de design, se fica bom em "produção", evolui pra B em outra fase. **Implementação**: troca o `<Scissors>` no AppShell por wordmark texto.

---

## 2. CompanySwitcher com identidade visual

Atualmente as 3 empresas (Colacor, Oben, Colacor SC) compartilham o ícone `Building2` cinza. Indistinguíveis a olho.

### Proposta

Cada empresa ganha um **monograma** colorido sutil em quadrado 20×20:

| Empresa | Monograma | Cor de fundo | Cor texto |
|---|---|---|---|
| Colacor (indústria) | `C` | `hsl(0 0% 9%)` (preto) | branco |
| Oben (distribuidora) | `O` | `hsl(212 80% 35%)` (azul Vercel-info dessaturado) | branco |
| Colacor SC (serviços) | `S` | `hsl(142 50% 32%)` (verde-money dessaturado) | branco |

Aparece tanto no dropdown trigger quanto nos itens. Trazem identidade sem comprometer a paleta neutra.

---

## 3. Sidebar enxuta — reorganização

### Estado atual

12 seções flat, ~30 itens visíveis:

```
Principal · Afiação · Vendas · Estoque · Reposição · Produção
Performance · Inteligência · Financeiro · Tintométrico
Automação · Gestão · Documentação
```

Problema: 12 títulos em sequência sem hierarquia. Comprador que só usa Reposição vê tudo.

### Proposta

**Estrutura em 3 níveis:**

1. **"Favoritos"** (topo) — itens fixados pelo próprio usuário (até 5). LocalStorage por user. Default: vazio.
2. **Seções operacionais visíveis sempre** (3-4 mais usadas pelo perfil):
   - Dashboard, Pedidos (vendas), Picking (operação), Cockpit (gestão)
   - Determinado pelo `commercial_role` ou `role`
3. **Seções colapsáveis** (resto) — agrupadas por área (Comercial, Estoque, Financeiro, Tintométrico, Gestão). Por padrão fechadas. Expansão lembrada por user.

### Implementação resumida

- Hook `useSidebarFavorites` (localStorage)
- Componente `<SidebarSection>` colapsável com `Collapsible` shadcn
- Item com botão `<Star>` na linha (visível em hover) pra fixar/desfixar
- Reordenar dentro de favoritos por drag (futuro)

### Implementação prática

Pra esta entrega vou fazer **versão pragmática**:

- Implementar componente `<CollapsibleSection>` que envolve as seções menos usadas (Documentação, Automação, Gestão) em `<details>` colapsáveis
- Manter as seções operacionais (Principal, Vendas, Estoque, Reposição, Financeiro, Tintométrico) sempre abertas
- Sem favoritos por enquanto (depende de schema novo)

Reduz a 5-6 seções visíveis sempre, vs 12.
