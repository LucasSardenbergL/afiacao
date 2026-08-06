---
name: benchmark-externo
description: >-
  Motor de origem de features do founder neste repo (Afiação/Colacor): transforma um
  benchmark externo (link, artigo, PDF, relatório, case de concorrente) num PROGRAMA de
  PRs pequenos. Use SEMPRE que o Lucas trouxer uma fonte de fora e perguntar o que dela
  já existe no app ou pedir pra atacar — qualquer fraseado: "existe isso no nosso app?",
  "a gente tem isso?", "o que temos disso?", "isso dá pra fazer aqui?", "o que falta pra
  ter isso?", "vamos atacar os gaps", "monta um programa disso", "análise de lacunas /
  gap analysis", "o que o concorrente tem que a gente não tem". Vale mesmo sem a palavra
  "benchmark" e só com a fonte + intenção de comparar (colou um link da Prosus / PEGN /
  Pernambucanas / Panrotas / Brazil Journal / McKinsey / Endeavor, ou um print/PDF de um
  case, e disse "olha isso"). Por quê: o padrão se repete 7+ vezes e gerou 3 dos maiores
  programas do mês, mas cada rodada REMONTA o processo à mão (browse + varredura de 119
  rotas + priorização) — caro e frágil (fan-out ad-hoc que morre por contenção e não
  entrega). A skill fixa o processo e padroniza a saída no formato que o auto-merge do
  repo espera (fases-PR). NÃO use para: revisar um diff (`/review`); planejar UMA feature
  já decidida (`writing-plans`→`executing-plans`); decidir se VALE construir algo do zero
  (`/office-hours`, vem ANTES desta); pesquisa de mercado ampla sem alvo no app
  (`pesquisa-mercado-br`/`deep-research`); número de negócio do banco (`bi-colacor`).
---

# Benchmark externo → programa de PRs

## Por que esta skill existe (leia antes de começar)

Este é o **motor de origem de features** do founder. O arco é sempre o mesmo:

> fonte de fora (link/PDF/case) → "existe isso no nosso app?" → mapa de gaps → "vamos atacar" → programa multi-PR.

Ele se repete 7+ vezes por mês e produziu 3 dos maiores programas do período. O founder **não** precisa que você mude o que ele faz — precisa que você **tire o atrito de remontar o processo do zero toda vez**. Sem esta skill, o padrão observado é reconstruir o andaime à mão (fan-out de exploradores ad-hoc que estoura tokens e às vezes morre por contenção sem entregar tabela nem programa), com a saída em formato diferente a cada rodada.

A skill fixa **um** processo leve e entrega **sempre** os dois artefatos no formato que o resto do repo espera: uma **tabela de gaps com evidência** e um **programa em fases-PR pequenas** (o formato que o auto-merge digere — `.github/workflows/auto-merge.yml`).

## Lei de Ferro (os 4 invariantes que não se quebram)

Quebrar qualquer um recria a dor que a skill existe pra matar:

1. **Evidência, não memória.** "Já temos isso" só vale com **rota real + `arquivo:linha`** achados AGORA por grep — nunca "acho que tem". O app tem ~119 rotas lazy; ninguém (nem você) lembra de cabeça, e "feature que já existia virou pedido de reconstrução" é dor documentada. Memória fabrica tanto falso-tem quanto falso-gap.
2. **Três estados, não dois.** Cada prática é `tem` · **`tem-parcial`** · `gap`. O `tem-parcial` é a categoria que mais rende (é onde o programa **completa** o que já começou, barato) — o binário tem/não-tem esconde exatamente ela.
3. **Classifique por PERSONA.** No Afiação a mesma capacidade quase sempre existe do lado **staff** e falta do lado **cliente** (self-service) — a maquinaria está construída mas **fenceada atrás de `RequireStaff` / `isCustomerMode`** (o padrão dominante do app). Marcar "tem" uma coisa que o comprador não acessa é o erro clássico — a coluna persona (cliente/staff) impede isso, e essa é justamente a categoria de gap mais barata de fechar (expor o que já existe, não construir do zero).
4. **Varredura fixa e leve, não fan-out.** Uma passada estruturada: `grep` no `App.tsx` + grep dirigido por termo. **Não** dispare 5 sub-exploradores paralelos (caro e frágil na M2 — o baseline morreu assim). Um subagente `Explore` dirigido, se precisar, para um domínio específico — não um enxame.

## O ritual — 6 passos

Crie estes 6 todos (TodoWrite) e siga em ordem. Os passos 3 (tabela) e 5 (programa) são os artefatos que o founder leva embora.

### Passo 1 — Capturar a fonte e extrair PRÁTICAS

- **Link** → `/browse` (gstack; obrigatório pra web — não `WebFetch`): `goto` + `text`. Se for SPA que não renderiza, `snapshot`.
- **PDF/print** → `Read` no arquivo (o Read lê PDF e imagem).

Destile a fonte numa **lista de práticas concretas e enumeráveis** — o que a empresa-referência FAZ (features, capacidades, táticas), não o marketing. Uma prática é acionável e testável contra o app ("cotação online self-service", "recompra em 1 clique", "hierarquia de conta multiusuário com aprovação"), não um adjetivo ("experiência melhor"). Numere-as; some 8–20 costuma ser o alvo. Guarde a fonte (URL/arquivo) — vai citada no fim.

### Passo 2 — Mapear o app (FRESCO, nunca de memória)

O mapa de rotas é a fonte da verdade do que existe. Extraia agora:

```bash
grep -nE 'path=' src/App.tsx        # ~119 rotas; a verdade fresca do que existe
```

Eixo que orienta a leitura (confirme no grep, não decore): rotas de **cliente** vivem no layout do comprador (`orders`, `new-order`, `tools`, `loyalty`, `recurring-schedules`, `savings`, `gamification`, `support`); rotas de **staff** são o grosso (`admin/*`, `sales/*`, `financeiro/*`, `farmer/*`, `admin/reposicao/*`, `tintometrico`, `producao`, `recebimento`, `governance/*`). Para cada prática do Passo 1, um grep dirigido pelo termo do domínio (nome de página, hook, rota) confirma tem/parcial/gap com `arquivo:linha`:

```bash
grep -rniE 'quote|cotac|orcament' src/ --include='*.tsx' -l   # ex.: a prática "cotação online"
```

Se um domínio for grande e ambíguo, **um** subagente `Explore` dirigido a ele (não um enxame) — peça o veredito tem/parcial/gap + `arquivo:linha`, não um dump.

### Passo 3 — Tabela de gaps (artefato #1)

Renderize no chat. Uma linha por prática, ordenada por estado (gaps primeiro):

| # | Prática (benchmark) | Estado | Persona | Evidência (rota · `arquivo:linha`) | Nota |
|---|---|---|---|---|---|
| 1 | Cotação online self-service | 🟡 tem-parcial | staff↛cliente | `sales/quotes` · `src/pages/SalesQuotes.tsx` | existe pro vendedor; comprador não tem |
| 2 | Recompra em 1 clique | 🟢 tem | cliente | `recurring-schedules` · `…/RecurringSchedules.tsx` | recorrência ativa |
| 3 | Hierarquia de conta multiusuário | 🔴 gap | cliente | — | nenhuma rota; aprovação só staff (`admin/approvals`) |

Regras: 🔴 gap / 🟡 tem-parcial / 🟢 tem. Coluna Evidência **vazia proíbe** 🟢/🟡 (Lei de Ferro 1). `staff↛cliente` marca a capacidade que existe mas não chega ao comprador (Lei de Ferro 3).

### Passo 4 — Priorizar com o Codex (2ª opinião, background)

Priorização de programa é decisão de metodologia não-óbvia → passa pelo Codex (regra do CLAUDE.md). Dispare-o via **Bash com `run_in_background:true`** (o harness te re-invoca quando terminar — nunca segure a sessão em foreground) e siga trabalhando no rascunho do Passo 5 enquanto ele roda:

```bash
scripts/codex-async.sh -r high "Priorize estes gaps do app B2B Afiação por IMPACTO×ESFORÇO.
Money-path (preço/pedido/financeiro/reposição/estoque) primeiro. Separe quick-wins (1 PR)
de épicos (fase multi-PR). Contexto e tabela: <cole a tabela do Passo 3 + 2 linhas de negócio>.
NÃO abra supabase/schema-snapshot.sql."
```

Defaults do script: `-m gpt-5.5 -r high -t 1200` (20min hard-stop). Se a cota do Codex estourar (não-transitório, o script avisa), siga pelo **Caminho B**: priorize você mesmo por impacto×esforço e grave `REVISÃO INDEPENDENTE PENDENTE` no roadmap (detalhe em `docs/agent/money-path.md`). Integre o parecer quando voltar — realoque a ordem, não ignore.

### Passo 5 — Programa em fases-PR (artefato #2)

Cada gap priorizado vira **1 PR pequeno** (o auto-merge do repo digere PR apertado; épico = várias fases). Formato igual ao dos programas do repo (`docs/historico/programas-vendas.md`), com marcadores ✅ feito · 🔄 andamento · ⏳ pendente · 🚧 bloqueado:

```
### Programa: <tema do benchmark> (fonte: <url/arquivo>)
- ⏳ **PR1 — <gap quick-win>:** <escopo de 1 PR>. Rotas/arquivos tocados: <…>.
- ⏳ **PR2 — <gap>:** <…>. 🟥 money-path → exige `prove-sql-money-path` + Codex adversarial.
- ⏳ **PR3 — <épico, fase 1 de N>:** <fatia mínima entregável>.
```

Marque em cada PR o que o founder terá de fazer à mão (§ armadilhas do Lovable): 🟣 migration no SQL Editor (`lovable-db-operator`), 💬 edge pelo chat, 🖱️ Publish (`lovable-deploy-verify`). Todo PR que toca dinheiro/autorização carrega a nota "prove-sql + Codex" — não é opcional no money-path.

### Passo 6 — Persistir e (se o founder mandar atacar) começar

- **Roadmap vivo no chat** (preferência do founder) — a tabela + o programa, re-renderizados quando mudam. Não crie arquivo de roadmap compartilhado (ímã de conflito multi-worktree).
- Programa grande e aprovado → registre em `docs/historico/` ou abra spec em `docs/superpowers/specs/` (via `writing-plans`), e execute PR a PR. Ao abrir cada PR (não-draft), **arme `scripts/pr-watch.sh <nº>` em background** e avise no desfecho por PushNotification (CLAUDE.md §Merge).

## Resumo do que entregar

Ao final, no chat, nesta ordem:

1. **A fonte** citada (url/arquivo) + as N práticas extraídas.
2. **A tabela de gaps** (Passo 3) — 3 estados, persona, evidência `arquivo:linha`.
3. **O programa em fases-PR** (Passo 5) — priorizado (Codex ou Caminho B), money-path sinalizado, deploy manual do Lovable rotulado por PR.
4. Uma pergunta de fecho só se precisar de decisão: **atacar tudo, um subconjunto, ou só a tabela por enquanto?**

Nunca entregue o programa sem a tabela por trás (é a evidência que impede reconstruir feature que já existe), nem a tabela sem evidência `arquivo:linha` (é memória disfarçada de análise).

## Armadilhas

- **Marcar 🟢 por lembrança.** Toda linha verde/amarela tem `arquivo:linha` do grep de agora, ou vira 🔴 até provar.
- **Esquecer a persona.** `sales/quotes` é "tem" pro vendedor e "gap" pro cliente — são linhas diferentes se o benchmark fala de self-service do comprador.
- **Fan-out de exploradores.** Um enxame de subagentes na M2 8GB morre por contenção e não entrega (baseline real). Varredura por grep + no máximo 1 Explore dirigido por domínio ambíguo.
- **PR gigante.** O auto-merge e o founder engolem PR pequeno; épico entra fatiado em fases numeradas, não num PR-monstro.
- **Pular o Codex no money-path.** Priorização que mexe em preço/pedido/financeiro sem 2ª opinião viola o CLAUDE.md — background + Caminho B se a cota estourar.
