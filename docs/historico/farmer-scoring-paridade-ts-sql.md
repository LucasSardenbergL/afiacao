# Paridade TS×SQL do farmer scoring — o baseline da §5.1, medido

> Medido em prod 2026-08-13 (`~/.config/afiacao/psql-ro`, leitura pura).
> Harness: [`db/test-fu4f-fase3-paridade-ts-sql.sh`](../../db/test-fu4f-fase3-paridade-ts-sql.sh) ·
> motor: [`scripts/paridade-farmer-scoring.ts`](../../scripts/paridade-farmer-scoring.ts) ·
> números: `logs/paridade-fu4f/relatorio.json` (gitignorado — reproduza rodando o harness).

A §5.1 do spec `2026-07-20-fechamento-custo-farmer-scoring-design.md` previa um harness de
paridade TS×SQL — "mesma cesta de clientes, margem pelo TS e pela RPC, exigindo a mesma faixa".
Ele **não foi feito**, e o #1543 saiu com a divergência **declarada** (comentário no hook) em vez
de **medida**. Este documento é a medição.

## O que foi comparado

O motor do `useFarmerScoring` roda **duas vezes sobre o mesmo corpus de prod**, trocando só a
origem da margem: (a) o cálculo client-side pré-#1543, recuperado de `c95e4d90`, sobre
`sales_orders.items` × `product_costs`; (b) `g`/`margem_pct`/`faixa` de
`get_carteira_margem_faixa()` → `private.margem_cliente_agregada()`.

**Tudo mais fica idêntico de propósito** — rf/m/x/s, churn, recover, expansion e eff saem do mesmo
cálculo nos dois lados, porque o #1543 mudou só a fonte da margem. As personas são as **3 reais**
de prod (1 master com `cap_carteira_ler`, 2 farmers), não hipotéticas.

## 1. Quantos clientes mudam de FAIXA

| persona | clientes | muda de faixa | principal movimento |
|---|---:|---:|---|
| master `414a9727` (`cap_carteira_ler`) | 835 | **58 (6,9%)** | 25 `neutro→verde`, 21 `amarelo→verde` |
| farmer `33f59dc7` | 835 | **497 (59,5%)** | 411 `verde→neutro`, 57 `amarelo→neutro` |
| farmer `700657a1` | 835 | **405 (48,5%)** | 328 `verde→neutro`, 49 `amarelo→neutro` |

## 2. Delta no health score e mudança de classe (limiares 80/60/40)

| persona | Δ médio | Δ p90 | Δ máx | muda de classe |
|---|---:|---:|---:|---:|
| master | 1,36 | 3,1 | 14,5 | **14 (1,7%)** |
| farmer `33f59dc7` | 4,08 | 10,9 | 14,5 | **78 (9,3%)** |
| farmer `700657a1` | 3,56 | 10,6 | 14,5 | **44 (5,3%)** |

O `14,5` idêntico nas três **não é artefato**: é o teto estrutural do componente G (peso 0,15
redistribuído ⇒ ~15 pontos), atingido por clientes *distintos* em cada persona quando `g` salta
entre `null` e `1`. Conferido cliente a cliente (`top_delta_health` no relatório).

## 3. Agenda diária: ZERO clientes entram ou saem

Nas 3 personas: `agenda_saiu = 0`, `agenda_entrou = 0`, lista idêntica slot a slot.

**Por quê:** nenhuma dimensão que a agenda usa lê `g`. Os três laços de quota ordenam por
`churnRisk` (risco), `expansionScore` (expansão) e `priorityScore` (follow-up), e
`priorityScore = 0,40·churn + 0,30·recover + 0,20·expansion + 0,10·eff` — o health score **não
entra**. Só o *rótulo* `healthClass` exibido muda, em 3 · 1 · 2 dos 20 slots.

⚠️ Este zero é o resultado **esperado**, e um comparador quebrado diria o mesmo. Ele só vale
porque a falsificação F3 prova o contrário: perturbando a prioridade de um lado, `agenda_identica`
vira `false` nas três personas. Ausência de sinal não é aprovação.

## 4. A decomposição — dois deltas de naturezas opostas

**Eixo universo (allowlist × denylist)** — atinge todos. O hook filtra
`status IN ('confirmado','faturado','entregue')`, e `confirmado`/`entregue` têm **zero linhas**:
a allowlist resolve para só `faturado` (20.598 de 30.834 pedidos). É o delta do master, e ele
**só adiciona**: 28 clientes ganham margem, **0 perdem**.

**Eixo escopo (carteira)** — atinge só os farmers, e é o dominante. `sales_orders` é company-wide
para staff, mas a RPC devolve só a carteira do caller. Dos 835 clientes que cada vendedora vê na
tela, **541** (`33f59dc7`) e **440** (`700657a1`) pertencem a **outra carteira**.

| persona | tinha margem (TS) | tem (SQL) | ganha | **perde** |
|---|---:|---:|---:|---:|
| master | 736 | 764 | 28 | **0** |
| farmer `33f59dc7` | 736 | 273 | 9 | **472** |
| farmer `700657a1` | 736 | 371 | 14 | **379** |

⚠️ **`eligible` não é a causa.** Zero clientes com pedido caem em "na minha carteira, mas
`eligible=false`" — os 2.127 assignments não-eligible são **aliases fiscais** (2.127/2.127 com
e-mail `@placeholder.local`), sem pedido na allowlist. Consistente com a §5 do `database.md`.

⚠️ E a perda **não é regressão: é a autorização funcionando.** Antes do #1543 o browser baixava o
catálogo de custo inteiro e calculava margem de cliente que não é da vendedora. O #1543 não criou
o desalinhamento — ele o **expôs**. O que resta em aberto é de produto: a tela lista 835 clientes
quando a carteira tem 294/395 com pedido.

⚠️ **Dois números para o mesmo cliente.** O cron `calculate-scores` grava
`farmer_client_scores.gross_margin_pct` via `get_customer_margin_summary()` (service_role, **sem**
escopo); a tela do farmer lê a RPC **com** escopo. O mesmo cliente pode ter margem gravada e
"Sem custo conhecido" na tela.

## 5. Custo de produto de alinhar a allowlist (cenário C, medido)

Trocar a allowlist do hook pela denylist **não é neutro** — ela alimenta *todas* as dimensões,
não só a margem:

- pedidos **20.598 → 30.834**; clientes pontuados **835 → 1.195 (+43%)**;
- **a agenda diária troca 9 de 20 slots** (45% do trabalho do dia), nas três personas;
- para o master a paridade TS×SQL **praticamente se fecha**: faixa 58 → **1** cliente, classe
  14 → **1**, Δ health médio 1,36 → **0,003** (p90 = 0, máx 0,4).

Esse colapso a ~zero é a evidência mais forte de que o harness mede o que diz medir: alinhado o
universo, o delta desaparece. O resíduo de 1 cliente vem dos deltas menores conhecidos —
`round(margem_pct, 2)` antes do percentil, os 24 pedidos Omie duplicados em dois status, e os
25 itens de diferença entre o jsonb (47.697) e `order_items` (47.672).

Para os farmers o alinhamento **não resolve** (faixa segue em 56,5% e 47,9%): o delta deles é de
escopo, e escopo não se conserta mexendo em filtro de status.

## 6. Eixo ESCOPO: e se a tela do farmer listasse só a carteira dele? (cenário D, medido)

O eixo dominante não se conserta mexendo em filtro de status. Aqui o universo da **tela** é
alinhado ao da RPC. ⚠️ Isso muda a **população** do cálculo — e a população é o denominador de
`m` (p95 de spend) e da régua de `g` (p10/p90), ou seja, mexe em dimensões que a agenda **lê**.
Diferente do cenário A, aqui a agenda muda.

| | farmer `33f59dc7` | farmer `700657a1` | master (controle) |
|---|---:|---:|---:|
| clientes na tela | 835 → **294** | 835 → **395** | 835 → 835 |
| muda de faixa | 497 (59,5%) → **25 (8,5%)** | 405 (48,5%) → **26 (6,6%)** | 58 (6,9%) → 58 (6,9%) |
| muda de classe | 76 (9,1%) → **7 (2,4%)** | 45 (5,4%) → **8 (2,0%)** | 15 (1,8%) → 15 (1,8%) |
| sem margem no SQL | 562 → **21** | 464 → **24** | 71 → 71 |
| **agenda troca** | **11 de 20 slots** | **12 de 20 slots** | **0 de 20** |

**O master é o controle e ele não se move em nada** — como tem `cap_carteira_ler`, a RPC já lhe
devolvia tudo. Que os três números dele fiquem idênticos é a prova de que o cenário mexe
exatamente em quem deveria mexer, e só nele.

**A decomposição fecha.** Os farmers caem de ~50–60% para **8,5% e 6,6%**, que é o mesmo patamar
do master (6,9%): eliminado o escopo, sobra só o eixo universo, comum a todos. Somando os três
cenários: A (hoje) = escopo + universo · D = só universo · C = nem universo (0,1%).

**Custo:** 11–12 dos 20 slots trocam — *mais* que os 9 do cenário C, como esperado, porque o
cenário D mexe na população e portanto em `m`, `recover` e `priority`.

## Reprodutibilidade — o que é estável e o que não é

Em 4 execuções: `mudou_faixa` deu **[497, 58, 405] nas quatro**, sem variação. Já `mudou_classe`
oscilou (**[78,14,44]** em três, **[76,15,45]** na quarta, horas depois).

Não é instabilidade do harness, é **propriedade da métrica**: a faixa deriva só de `margem_pct`,
que não depende do tempo; a classe deriva do health score, que depende de `rf` (recência), que
anda com o relógio de cada extração — e alguns clientes vivem perto das fronteiras 80/60/40.
⇒ **Δ de ±2 clientes na CLASSE entre extrações é ruído esperado, não regressão.** Quem reexecutar
e vir 76 onde este doc diz 78 não deve procurar bug no código.

## Lições

- **Um "zero" só vale com a falsificação que o negaria.** O resultado da agenda era exatamente o
  que um comparador morto produziria; sem a F3 o número seria indistinguível de bug.
- **Máximo idêntico entre populações pede o detalhe por linha.** `14,5` nas três personas parecia
  artefato e era teto estrutural — só o `cid` separou as hipóteses.
- **Convergência é teste de harness.** Alinhar o universo e ver o delta ir a ~0 valida o
  instrumento melhor do que qualquer assert que eu escrevesse sobre ele.
- **Delta agregado esconde deltas de sinais opostos.** "6,9% mudam de faixa" (master) e "59,5%"
  (farmer) são o mesmo PR: um eixo só adiciona sinal, o outro só remove. A média dos três seria
  um número sem significado.
- **Uma persona sem delta é o controle mais barato que existe.** O master não se move em nenhum
  cenário de escopo, e é isso que prova que o filtro atingiu quem devia. Sem ele, "os farmers
  mudaram" seria compatível com um bug que mexe em todo mundo.
- **Separe a métrica determinística da que depende do relógio.** Faixa é reprodutível ao número;
  classe carrega ±2 de ruído porque nasce da recência. Publicar as duas com a mesma precisão
  aparente convida alguém a caçar um bug que não existe.
