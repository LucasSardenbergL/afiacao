# Cobertura bidirecional no Cockpit de Valor (`fin-valor-cockpit`)

> Spec — 2026-06-18. Follow-up do [#939](https://github.com/LucasSardenbergL/afiacao/pull/939) (denominador da cobertura) e do `/codex consult` que o acompanhou. Money-path (financeiro/A3). Brainstorming aprovado pelo founder.

## Problema

A `cobertura_receita` do cockpit (A3, Oben) = `min(1, receita_app / arTotal_faturável)`. Mede **quanto do AR financeiro é explicado por venda no app** (detecta venda fora do app). É **unidirecional e capada em 1,0** (`Math.min`): quando `receita > arTotal` (regime atual da Oben — ~R$5,06M vs ~R$4,05M faturável), satura em 1,0 e **perde o sinal inverso** — "venda no app sem AR correspondente" fica invisível.

Hoje esse gap inverso é **~20%** (R$1M): receita do app (R$5,06M) > AR faturável (R$4,05M). Causas prováveis: venda à vista (não gera conta a receber), venda recente sem título sincronizado, ou divergência app↔Omie financeiro. Levantado pelo Codex (consult 2026-06-18) como limitação da métrica.

## Decisão

Expor **dois sinais** (heurística direcional de confiança, **não** reconciliação contábil):

- **`ar_por_app` = `min(1, receita/arFaturável)`** — idêntico à `cobertura_receita` de hoje (mantido, retrocompat).
- **`app_por_ar` = `min(1, arFaturável/receita)`** — novo; detecta venda no app sem AR.

A confiança rebaixa **apenas em caso extremo** (`app_por_ar < 0,5` = mais da metade da venda do app sem AR faturável) → nível **média (2)**. Gap moderado (`≥ 0,5`, inclui o 0,80 atual) **não penaliza** — venda à vista é esperada e não deve virar falso-alarme. Precisão > recall.

Média (2), não baixa (1): `app_por_ar` baixo subestima o **encargo de capital de cliente** (otimismo no EVP), mas não invalida o cockpit como o hurdle ausente faz.

## Arquitetura / Componentes

### Helper puro — `src/lib/financeiro/valor-cockpit-helpers.ts` (espelhado VERBATIM no edge)

```ts
coberturaBidirecional({ receita, arFaturavel }: { receita: number; arFaturavel: number })
  : { ar_por_app: number; app_por_ar: number }
  // arFaturavel > 0 ? min(1, receita/arFaturavel) : 1   (= cobertura_receita de hoje)
  // receita     > 0 ? min(1, arFaturavel/receita) : 1   (novo)
```
Divisor `≤ 0` → `1` (não penaliza; consistente com o `arTotal > 0 ? … : 1` atual). Guard `Number.isFinite` nas entradas (ausente/NaN → trata como indisponível → 1, nunca fabrica penalidade).

### Edge — `supabase/functions/fin-valor-cockpit/index.ts`

- `arTotal` já é o AR **faturável** (filtrado por `tituloFaturavelAR`, do #939).
- `const { ar_por_app, app_por_ar } = coberturaBidirecional({ receita: res.empresa.receita, arFaturavel: arTotal })`.
- `cobertura_receita = ar_por_app` (substitui o cálculo inline atual; **retrocompat** — mesmo valor).
- Payload: **mantém** `cobertura_receita`; **adiciona** `cobertura_app_por_ar: app_por_ar`.

### `scoreConfiancaCockpit` — helper + edge

- Novo campo de input: `cobertura_app_por_ar: number`.
- Regra (após a de `cobertura_receita`): `if (cobertura_app_por_ar < 0.5) rebaixar(2, "${((1 - cobertura_app_por_ar) * 100).toFixed(0)}% da venda do app sem AR faturável — encargo de cliente subestimado; possível divergência app↔financeiro.")` (o motivo mostra a fração **sem** AR = `1 − app_por_ar`).
- Não toca as demais regras (hurdle/custo/AR/estoque permanecem).

### UI — `src/pages/FinanceiroValorCockpit.tsx` + tipo em `useValor`/service

- Header de confiança (hoje linha ~172, "X% de cobertura de receita") passa a mostrar o par compacto: **"Cobertura: X% do AR explicado · Y% das vendas com AR"** (X = `ar_por_app`, Y = `cobertura_app_por_ar`).
- Adicionar `cobertura_app_por_ar: number` ao tipo do retorno do cockpit (`useValor`/`financeiroService`).
- O motivo de rebaixamento (quando `< 0,5`) já aparece na lista de `confianca.motivos`.

## Fluxo de dados

edge: `res.empresa.receita` (numerador) + `arTotal` (denominador faturável) → `coberturaBidirecional` → payload `{ cobertura_receita, cobertura_app_por_ar, confianca }` → `useValor` → `FinanceiroValorCockpit` exibe o par.

## Casos de borda / erro

- `receita = 0` ou `arFaturavel = 0` → o sinal correspondente = 1 (não penaliza). O caminho de cockpit vazio (`vazio: true`) já retorna antes, então no fluxo normal `receita > 0`.
- `NaN`/`Infinity` nas entradas → guard `Number.isFinite` → trata como indisponível (1), nunca penalidade fabricada.
- Interação na confiança: hurdle ausente (nível 1) continua dominando o `min`; `app_por_ar < 0,5` só puxa para 2 se nada pior estiver ativo.

## Testes (vitest, helper puro — o padrão do repo)

- `coberturaBidirecional`: `receita > ar` (ar_por_app satura em 1, app_por_ar < 1); `ar > receita` (inverso); iguais (ambos 1); divisor 0 → 1; NaN/Infinity → 1. **+ FALSIFICAÇÃO** (sabotar o helper → vermelho).
- `scoreConfiancaCockpit`: `app_por_ar < 0,5` → média + motivo; `= 0,80` (caso Oben) → não penaliza; hurdle ausente ainda domina (baixa).
- `typecheck` strict. `/codex challenge` no diff.

## Escopo / Não-escopo

- **NÃO** renomeia `cobertura_receita` (retrocompat — a UI e o A4 consomem).
- **NÃO** altera numerador/denominador (definidos por #935/#939).
- **NÃO** é reconciliação contábil — proxy direcional; o caveat no comentário do edge permanece.

## ⚠️ Deploy (DOIS canais desta vez)

Diferente do #939: esta feature **muda a UI** → exige **(1) Publish do frontend** no Lovable **+ (2) deploy MANUAL da edge** (chat do Lovable, verbatim). Migration: nenhuma.
