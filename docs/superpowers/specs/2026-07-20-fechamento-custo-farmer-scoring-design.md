# FU4-F fase 3 — o scoring do farmer para de baixar o catálogo de custo

> Spec de desenho. Escopo: **apenas** `useFarmerScoring`. As outras vias browser→custo estão
> inventariadas na §9 e ficam para PRs próprios.
>
> Decisão de produto (dono, 2026-07-20): **o NÚMERO de custo fecha, o SINAL fica.**

## 1. O follow-up que originou isto estava errado — e o erro importa

O enunciado do FU4-F fase 3 apontava `farmer_client_scores.gross_margin_pct` como derivado
persistido do custo, invertível por `custo = receita × (1 − margem%)`. **Medido em prod
(2026-07-20, `psql-ro`), o vazamento não existe:**

| métrica | valor |
|---|---|
| linhas | 6.632 |
| não-nulas | 6.632 |
| **≠ 0** | **0** |
| valores distintos | **1** (zero) |
| último `calculated_at` | 2026-07-20 06:00:33 (cron rodou) |

A coluna é estruturalmente morta: [`calculate-scores/index.ts:355`](../../../supabase/functions/calculate-scores/index.ts)
grava `gross_margin_pct: 0` literal no seed, e a interface `ScoreUpdate` (`:69-90`) — o payload do
`apply_score_updates` — não contém a coluna, então o UPDATE diário nunca a toca. Confirmado pelo
catálogo, não pelo repo: **zero** funções em `pg_proc` mencionam a coluna e nenhum cron SQL-inline
a escreve. Com margem 0 para todos, `custo = receita × (1 − 0) = receita` — não há o que deduzir.

**A nota de desenho do enunciado também estava errada.** Ela propunha `g_score` como "o componente
de margem normalizado, substituto natural". Previsão falsificável testada contra prod:

| coluna persistida | medido | o que realmente é |
|---|---|---|
| `m_score` | 0 não-zero, **1 valor distinto** | margem — morto (deriva de `gross_margin_pct`) |
| `g_score` | 841 não-zero, 52 distintos, 0–100; acompanha `category_count` monotonicamente | **diversidade** |

A edge grava `g_score: Math.round(diversityScore)` ([`:546`](../../../supabase/functions/calculate-scores/index.ts)).
As duas implementações usam as mesmas letras para grandezas diferentes — no hook `m`=monetário,
`g`=margem, `x`=diversidade; na edge `m_score`=margem, `g_score`=diversidade. Adotar `g_score` como
substituto trocaria margem por diversidade em silêncio.

**Consequência que facilita o conserto:** como `marginScore=0` para todos, o `health_score`
**persistido já ignora margem** (peso de 20% zerado). O hook é o único lugar onde margem influencia
score — grosseirizar o `g` do hook o aproxima da edge, não o afasta.

## 2. O vazamento real

[`useFarmerScoring.ts:181-193`](../../../src/hooks/useFarmerScoring.ts) baixa o catálogo de custo
inteiro para o browser:

```ts
const productCosts = await fetchAllPages<ProductCostRow>((de, ate) =>
  supabase.from('product_costs').select('product_id, cost_final, cost_price')...
```

Paginado **de propósito** para furar a capa de 1.000 do PostgREST (comentário: *"3.637 linhas > capa
de 1.000"*). Em prod: 3.637 linhas, 3.637 com custo. `product_costs` segue com policy
`master OR employee`, sem `cap_custo_ler` — exatamente o que o [#1473](https://github.com/LucasSardenbergL/afiacao/pull/1473)
documentou como não-fechado.

O hook calcula margem por cliente em memória e a expõe duas vezes: `grossMarginPct`
(renderizado em [`FarmerDashboard.tsx:442`](../../../src/pages/FarmerDashboard.tsx)) e o componente
`g` do health score.

**O vazamento é a resposta de rede, não o número renderizado.** Mascarar a saída mantendo o `fetch`
deixa as 3.637 linhas visíveis no DevTools. O conserto tem de remover a busca. Por isso o padrão do
#1473 (view operacional sem a coluna sensível) não transporta: ali havia uma coluna a projetar; aqui
o hook lê a tabela inteira e não há o que projetar — há o que **não entregar**.

## 3. Desenho: espelhar `get_preco_cockpit` um nível acima

`get_preco_cockpit` já é a implementação de referência do padrão exato de que precisamos, por SKU.
Este desenho a espelha, agregando por cliente — **não inventa padrão novo**:

| elemento | valor herdado do cockpit |
|---|---|
| gate de custo | `private.cap_custo_ler(auth.uid())` |
| faixa | `verde` · `amarelo` · `vermelho` · `neutro` |
| motivo | `saudavel` · `abaixo_da_meta` · `abaixo_do_piso` · `abaixo_do_custo` · `sem_custo` |
| gate de projeção | `CASE WHEN v_pode_num THEN to_jsonb(v) ELSE 'null'::jsonb END` |
| assinatura | `plpgsql STABLE SECURITY DEFINER` |

O `neutro` é obrigatório: o cockpit **não força** um item sem custo para uma faixa colorida. Sem ele,
cliente sem custo conhecido seria empurrado para uma cor, fabricando sinal.

### 3.1 Contrato da RPC

`get_carteira_margem_faixa()` — uma linha por cliente da carteira do caller:

| campo | tipo | regra |
|---|---|---|
| `customer_user_id` | `uuid` | — |
| `faixa` | `text` | `verde\|amarelo\|vermelho\|neutro` — **sempre presente** |
| `motivo` | `text` | vocabulário acima |
| `margem_pct` | `numeric \| null` | **só** quando `cap_custo_ler(auth.uid())`; senão `null` com a chave presente |

Propriedades exigidas:

- `SECURITY DEFINER`, `STABLE`, `SET search_path TO 'public', pg_temp` (`pg_temp` **por último** — regra do FU7)
- **Escopo espelhando a RLS de `farmer_client_scores`**: `private.cap_carteira_ler(uid) OR private.carteira_visivel_para(customer_user_id, uid)`. Um vendedor recebe só a própria carteira.
- **Fail-closed**: `auth.uid() IS NULL` → zero linhas
- `REVOKE EXECUTE FROM PUBLIC, anon` **e** `GRANT EXECUTE TO authenticated` — revogar só de `PUBLIC` é no-op (default privilege do Supabase concede por nome)
- O custo é lido dentro da função e **nunca** sai dela

### 3.1b O que determina a faixa — limiar fixo configurável

No cockpit, `amarelo` significa "abaixo do piso de markup do SKU", com o piso vindo de
`resolve_markup_policy`. Para a margem **agregada de um cliente** esse piso não existe: é preciso
definir o que separa as faixas. **Decisão do dono (2026-07-20): limiar fixo configurável.**

Duas chaves novas em `farmer_algorithm_config` (tabela `key`/`value` numérica, que o hook já lê em
[`:119`](../../../src/hooks/useFarmerScoring.ts)):

| chave | papel |
|---|---|
| `margem_faixa_piso_pct` | abaixo ⇒ `amarelo` (motivo `abaixo_do_piso`) |
| `margem_faixa_meta_pct` | abaixo ⇒ `verde`/`abaixo_da_meta`; acima ⇒ `verde`/`saudavel` |

Classificação (espelha a cascata do cockpit):

```
margem desconhecida        → neutro    / sem_custo
margem < 0                 → vermelho  / abaixo_do_custo
margem < piso              → amarelo   / abaixo_do_piso
margem < meta              → verde     / abaixo_da_meta
caso contrário             → verde     / saudavel
```

**Por que fixo e não percentil da população:** com percentil, ~10% dos clientes seriam vermelhos
**por construção**, mesmo num mês em que todos dessem lucro, e a faixa de um cliente mudaria quando
a população mudasse sem ele fazer nada. O limiar fixo é estável (a faixa só muda se o comportamento
do cliente mudar) e explicável para a vendedora.

⚠️ **PENDENTE — os dois valores-semente não estão medidos.** A query de calibragem
(distribuição real de margem por cliente: p10/p25/mediana/p90 + contagem de margem negativa) não
completou nesta sessão por indisponibilidade das ferramentas de execução. **Rodar antes de fixar os
números na migration** — semear limiar por intuição no money-path é fabricar número. A query está
montada e usa `order_items.product_id → product_costs.product_id` com `NULLIF(...,'NaN')`.

### 3.2 Mudança no hook

- Sai o `fetchAllPages` de `product_costs` e o `costMap` (linhas 181-193)
- Entra a chamada à RPC
- `ClientScore.grossMarginPct: number` → `margemFaixa: 'verde'|'amarelo'|'vermelho'|'neutro'` + `margemPct: number | null`
- `FarmerDashboard:442` passa a exibir a faixa
- `g` deriva da faixa: **verde=1.0 · amarelo=0.5 · vermelho=0.0 · neutro=0.0**

### 3.3 O `neutro` mapeia para 0 **de propósito** neste PR

Hoje, cliente sem SKU de custo conhecido cai em `clientMargin = 0` (ternário da
[linha 350](../../../src/hooks/useFarmerScoring.ts)) e recebe `g≈0` — tratado como **pior margem
possível**. É o `Number(null)===0` que o money-path proíbe, e o `neutro` o nomeia pela primeira vez.

**Este PR preserva esse comportamento** (`neutro → g=0`). Consertar a fabricação junto misturaria
conserto de autorização com mudança de score e destruiria o baseline que prova que nada mais mudou.
Aprovado pelo dono (2026-07-20). Follow-up registrado na §9.

Nuance a preservar na paridade: a população dos percentis (`allMargins`,
[linha 309](../../../src/hooks/useFarmerScoring.ts)) inclui **apenas** clientes com
`totalRevenue > 0`, mas `g` é calculado para todos — inclusive os que não entram na população.

## 4. Paridade TS×SQL — o que tem de casar exatamente

A RPC recalcula server-side o que o hook calcula client-side. Divergência aqui muda score por motivo
**alheio à segurança** — é o risco principal desta entrega.

| dimensão | o que o hook faz | fonte |
|---|---|---|
| universo de pedidos | `.in('status', ['confirmado','faturado','entregue'])` | `:146` |
| data | `order_date_kpi ?? created_at` | `:265` |
| exclusão | `cliente_classificacao.excluir_da_carteira = true` sai **antes** do cálculo; leitura falha ⇒ **aborta** (fail-closed) | `:159-178` |
| mapeamento SKU | `omie_products.omie_codigo_produto → .id → product_costs.product_id` | `:207-210` |
| custo canônico | `custoValido(cost_final) ?? custoValido(cost_price)`, onde válido = finito **e > 0** | `custoCanonico.ts` |
| margem | só sobre SKU com custo **conhecido**; `(totalRevenue − totalCost) / totalRevenue`, `0` se receita 0 | `:277-281`, `:350` |
| percentis | p10/p90 sobre clientes com `totalRevenue > 0` | `:309-311` |

⚠️ **`NaN`**: `custoValido` usa `Number.isFinite`. Em `numeric` do Postgres `'NaN'` é valor legítimo
(o próprio `get_preco_cockpit` testa `<> 'NaN'::numeric`) — o SQL precisa excluí-lo, senão a paridade
quebra exatamente onde ninguém olha.

⚠️ **Dois caminhos de JOIN, e o atalho é uma armadilha de paridade.** `order_items` tem
`product_id` **direto** (colunas reais: `id, sales_order_id, customer_user_id, product_id,
omie_codigo_produto, quantity, unit_price, discount, created_at, hash_payload`), então o SQL
*poderia* ir direto a `product_costs.product_id`. Mas o hook chega lá por
`omie_codigo_produto → omie_products.id`. Os dois caminhos **só** coincidem se `order_items.product_id`
for sempre não-nulo e sempre igual ao mapeamento — não medido. **Medir antes de escolher**; se
divergirem, a RPC segue o caminho do hook (paridade manda), não o atalho.

⚠️ **Duplicação de JOIN — medida, não suposta.** O `database.md` avisa que
*"`omie_products.account` é convenção EMPRESA; JOIN account-blind em RPC money-path duplica
silenciosamente"*. O hook usa `Map.set()` (last-write-wins, escolhe **um** `product_id`); um JOIN em
SQL produziria N linhas. Medido em prod: `omie_codigo_produto` é **único** (7.962 linhas / 7.962
distintos, cada código em exatamente **1** account) e `product_costs` tem 1 linha por `product_id`
(3.637/3.637) ⇒ **o JOIN não duplica hoje**. Mas isso é um fato do **dado**, não uma constraint: um
sync de account nova o quebra em silêncio. **O harness deve travar a unicidade com assert próprio**,
para que a regressão apareça como teste vermelho e não como margem dobrada.

## 5. Como se prova

1. **Harness de paridade TS×SQL** (padrão do repo, ex.: `db/test-city-norm-paridade.sh`): mesma
   cesta de clientes, margem pelo TS e pela RPC, exigindo a **mesma faixa**. É o baseline que prova
   que o conserto não mexe em score.
2. **PG17 via `prove-sql-money-path`**: asserts positivos e negativos com `SQLSTATE` + re-raise,
   escopo de carteira sob `SET ROLE authenticated` + GUC do JWT (nunca `SET LOCAL` — em autocommit
   ele só emite WARNING e o assert fica falso-verde), guard abortando se `current_user ≠ authenticated`.
3. **Assert de unicidade** do §4 (trava o JOIN).
4. **Falsificações** — cada uma exige o vermelho do assert que ela mira, com baseline verde e
   contagem/nomes conferidos antes:
   - sabotar o gate de projeção (`v_pode_num` → sempre `true`) ⇒ vermelho no assert de que
     `margem_pct` é `null` sem `cap_custo_ler`
   - sabotar o gate de escopo ⇒ vermelho no assert de que o vendedor A não vê cliente de B
   - sabotar a unicidade (semear código duplicado em 2 accounts) ⇒ vermelho no assert de duplicação
5. **Codex adversarial** (`gpt-5.6-sol`, `xhigh`) antes de tirar do draft.

Asserts ancoram na **estrutura** (chamada com argumentos), nunca em substring solta — a migration é
fonte do texto que o assert lê de volta por `pg_get_functiondef`, e `.` casa newline no regex do
Postgres (lição do #1472).

## 6. Entrega

1. Migration custom com a RPC — **aplicada à mão pelo founder no SQL Editor** (nome custom não
   auto-aplica no Lovable; falha silenciosa)
2. Validação pós-apply que **lê catálogo** (`pg_proc`/`pg_get_functiondef`/`has_function_privilege`)
   e **nunca invoca** a função — invocar exige `EXECUTE` e dá falso-negativo sob `psql-ro` (lição do #1462)
3. `src/integrations/supabase/types.ts`: a RPC nova **não** regenera os tipos sozinha. Tratar como
   parte da entrega — senão o primeiro PR que a referenciar deixa a `main` vermelha e trava o
   auto-merge de todos os PRs abertos
4. Publish do frontend (Lovable) — merge na `main` ≠ produção

**Ordem de deploy acoplada:** a migration entra **antes** do Publish (o front novo depende da RPC).
Como este PR não revoga nada em `product_costs`, não há a janela de quebra do padrão REVOKE — o front
velho continua funcionando até o Publish.

## 7. O que este PR NÃO fecha — dizer no corpo do PR

**Faixa não é divulgação zero, é divulgação limitada.** Por cliente, a faixa agrega a cesta inteira e
não se inverte para custo unitário — o estreitamento é forte. Mas não é nulo, e precisão>recall exige
declarar isso em vez de anunciar o custo "fechado".

`product_costs` **continua** com policy `master OR employee` e legível por outras vias (§9). Este PR
fecha **uma** via — a maior — e não altera a tabela.

## 8. Alternativas descartadas

| alternativa | por que não |
|---|---|
| View operacional sem a coluna (padrão #1473) | Não há coluna a projetar: o hook lê `product_costs` inteira. Não transporta. |
| Mascarar `grossMarginPct` na UI | Fachada — o `fetch` continua e o catálogo aparece no DevTools. |
| RPC devolver `g` normalizado (0..1) em vez da faixa | Mais fino, mas invertível: `margem = g·(p90−p10) + p10`. Contraria a decisão de produto. |
| Ler o `g_score` persistido | É **diversidade**, não margem (§1). Trocaria a grandeza em silêncio. |
| Popular `gross_margin_pct` corretamente e ler o persistido | Cria o vazamento que o enunciado imaginava, e o valor diário fica stale vs. o hook, que é ao vivo. |
| Faixa por percentil da população (p10/p90) | ~10% vermelhos **por construção**, mesmo com todos lucrativos; faixa muda sem o cliente mudar (§3.1b). |
| Faixa derivada de `resolve_markup_policy` | Semanticamente o mais fiel (mesmo significado de "abaixo do piso" no cockpit e no scoring), mas exige regra de agregação ponderada por SKU/família/conta — desproporcional para esta entrega. Reavaliar se as duas telas divergirem na prática. |

## 9. Fora de escopo — follow-ups com evidência

Vias browser→custo inventariadas e **não** endereçadas aqui:

| via | o que puxa | desenho provável |
|---|---|---|
| [`useCrossSellEngine.ts:171`](../../../src/hooks/useCrossSellEngine.ts) | `product_costs` completa | ranqueamento server-side |
| [`useBundleEngine.ts:203`](../../../src/hooks/useBundleEngine.ts) | `product_costs` completa | ranqueamento server-side |
| [`RecommendationCard.tsx:120`](../../../src/components/RecommendationCard.tsx) | renderiza `Custo:` direto, atrás de `showAdminBreakdown` | gate de projeção |
| [`useBaixoGiro.ts:33`](../../../src/components/reposicao/baixoGiro/useBaixoGiro.ts) | `inventory_position` cru com `cmc` | **verificar o gate antes de concluir** — é tela de reposição, e comprador lê custo legitimamente (`cap_compras_ler`) |

⚠️ **Assimetria de desenho para cross-sell/bundle:** faixa **por SKU** é mais fraca que por cliente.
O preço do SKU é legítimo e conhecido pelo cliente, então a faixa limita o custo unitário a um
intervalo — sobre os 3.637 SKUs. Para esses dois, o que precisa ir ao servidor é o **ranqueamento**,
não a faixa (mesma lição do #1488: *"se o cliente avalia o predicado offline, ele acha o limiar por
busca binária"*).

Outros dois achados desta sessão, independentes desta entrega:

1. **`gross_margin_pct` é coluna morta com 5 consumidores degradando em silêncio** — o peso `hs_w.margin`
   (20%) do health score está zerado; o gate econômico de `tactical-plans-batch:152` reprova todos; os
   KPIs de margem em `IntelligenceStrategicTab:156` e `IntelligenceManagerialTab:123` renderizam `0.0%`;
   `CustomerHero:137` pinta todo cliente de vermelho. Decidir entre popular ou dropar (com
   `db/preflight-dependencia-tabela.sql` antes).
2. **Inconsistência de escala latente** entre consumidores da mesma coluna: `Customer360View`/`CustomerHero`
   tratam como fração (`*100`, `>=0.3`); `IntelligenceManagerialTab`, `useBundleEngine` e
   `generate-tactical-plan` tratam como 0–100 (`<20`, `>35`). Hoje mascarada porque tudo é zero —
   volta a morder no dia em que a coluna for populada.
3. **A fabricação do `neutro`** (§3.3): cliente sem custo conhecido é hoje tratado como pior margem.
