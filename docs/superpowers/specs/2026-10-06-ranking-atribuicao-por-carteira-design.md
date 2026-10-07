# Ranking de vendedores pelo DONO DA CARTEIRA — o `created_by` das importadas deixa de decidir quem vendeu

> Money-path (ranking/comissão). Medido na prod via `psql-ro` em 2026-10-05/06. Decisões do founder na
> sessão de 2026-10-06. Antecedentes: [spec do Master v2](2026-06-04-master-visao-time-design.md) ("atribuição =
> `created_by`; dono-de-carteira fica para a v3") e [spec do kpi no envio](2026-10-05-app-grava-kpi-no-envio-design.md)
> §3.3/§9, que deixou a atribuição real para esta entrega.

## 1. O problema

O importador `omie-vendas-sync` (`sync_pedidos`, `index.ts:1115-1123` na main de 2026-10-06, o bloco
`// System user for created_by`) carimba em TODA linha importada o
`created_by` de `profiles WHERE is_employee = true LIMIT 1`, sem `ORDER BY`. O ranking de vendedores do Master
(`useTeamRanking` → `fetchPedidosMTD` → `montarRanking`) credita a receita por `created_by` ("quem lançou o
pedido"). Resultado: o card dá **100%** da receita a uma farmer qualquer. E o mesmo artefato faz o tile
**"vendedores ativos"** (`useTeamKpis`) contar essa farmer como ativa em todo dia que chega importação.

## 2. Medição (prod)

| | valor |
|---|---|
| importadas válidas set+out por `created_by` (controle da tarefa) | 589 pedidos, R$ 592.547,12, **100% `33f59dc7`** (Tatyana) — reproduzido |
| importadas em 12 meses por `created_by` | `33f59dc7` 5.880 · `414a9727` (founder, master) 427 — o `LIMIT 1` já virou de dono |
| vendedor do PEDIDO (codVend) persistido | **em lugar nenhum**: 31.708 importadas, nenhuma com `omie_payload`; `fin_contas_receber.vendedor_id` vazio em 45.025/45.025 |
| `carteira_assignments` | 7.301 linhas, `UNIQUE(customer_user_id)`; `source` ∈ {`omie`, `hunter_orphan`}; `eligible=false` = "zero comissão + invisível; todo leitor filtra `WHERE eligible`" (`rebuild-helpers.ts:231`) |
| `commercial_roles` | 2 farmers (Tatyana `33f59dc7`, Regina `700657a1`) + 1 master (founder `414a9727`); 0 hunter/closer/super_admin |
| clientes distintos por mês (12 m) | pico **204** (mar/26) |
| RLS da carteira para o master | `Master manage carteira` (ALL) → lê as 7.301 |
| tile "vendedores ativos" hoje (06/10) | **1 hoje / 1 em 7 d**, e o 1 é só a importada (`33f59dc7`); 0 pedido do app, 0 ligação, 0 visita em 7 d |

**Régua decidida, por mês (conta = todas; dado vivo, out/26 até 06/10):**

| mês | Regina | Tatyana | carteira de não-vendedor | sem vendedor atribuído |
|---|---|---|---|---|
| ago/26 | 68,3% | 21,7% | 9,9% | 0% |
| set/26 | 69,0% (332 ped.) | 27,4% (175 ped.) | 3,7% (21 ped.) | 0% |
| out/26 | 65,9% | 17,0% | 17,1% | 0% |

Em 12 meses: 89,2% da receita vai para vendedor elegível, 9,6% para a carteira `omie` do founder, 1,2% para o
pool órfão, 0,02% para carteira inelegível, **0% sem carteira**. A régua "vendedor do cliente no Omie"
(`omie_customer_account_map` → `omie_vendedor_map`) dá a mesma distribuição a ±0,5 pp: a carteira `omie` é
derivada dela.

## 3. Quem lê `sales_orders.created_by`

| leitor | o que faz | muda com esta entrega? |
|---|---|---|
| policies RLS / views / funções de leitura (catálogo VIVO) | **nenhum** — só o escritor `criar_pedidos_com_itens` | — |
| `omie-vendas-sync` reparo (`index.ts:1544-1613`) | repassa o `created_by` do pai na reapuração | não (o valor gravado não muda) |
| `omie-vendas-sync` `deriveOmieAccountIdentity` (`:2905`, `:3328`) | guard "cliente = quem criou" no envio/edição | não |
| `pedido-programado-enviar` | `created_by` da linha do app | não |
| `src/lib/dashboard/fetch-pedidos-mtd.ts` + `team-kpis.ts` (ranking) | **atribui a receita** | **sim — deixa de ler** |
| `src/hooks/useTeamKpis.ts` (tile "vendedores ativos") | conta quem criou pedido em 7 d | **sim — só a linha do app conta** |
| `submitOrder`/`submitQuote`/`enviarProposta` | ESCREVEM `created_by = user.id` (linha do app) | não |

A coluna é `NOT NULL` sem default: gravar "ninguém" no importador exigiria DDL ou um usuário-sistema, e não é
preciso para corrigir quem a lê. O importador fica como está, com um comentário dizendo que o valor NÃO é
atribuição.

## 4. Decisões

| # | decisão | escolha |
|---|---|---|
| D1 | régua de atribuição | **dono ATUAL da carteira do cliente**, só `eligible = true` — a régua da positivação e da cadeia de comissão ("vendedor do cliente no Omie → carteira → comissão") (founder) |
| D2 | dono que não é farmer/hunter/closer | rodapé **separado** ("Carteira de não-vendedor"), distinto de "Sem vendedor atribuído" (founder) |
| D3 | onde implementar | **no front**: o hook lê a carteira dos clientes do mês; `montarRanking` puro. Alternativa recusada: RPC SQL (snapshot único, mas migration + prova PG17 + apply por um card que só o master vê) (founder) |
| D4 | tile "vendedores ativos" | entra: pedido importado deixa de ser atividade; hoje vai de 1/1 para 0/0 (founder) |
| D5 | 2ª opinião | cota do Codex em **92%** (teto 85%) até **09/10 19:30** → Caminho B no desenho (§7) + PR **DRAFT** até o adversarial no diff |
| D6 | sessão paralela (`claude/app-grava-kpi-push`) | os 4 arquivos do ranking/tile ficam com esta entrega; o ramo D1 de lá (importada → `created_by`, app → não atribuído) fica desnecessário. Combinado por mensagem entre sessões em 2026-10-06 |

## 5. Desenho

### 5.1 A régua (pura) — `src/lib/dashboard/team-kpis.ts`

```ts
export interface OrderRankRow { total: number | null; status: string | null; customer_user_id: string | null }
export interface RankingResult {
  ranking: RankingVendedor[];
  /** Pedidos válidos de cliente com carteira ELEGÍVEL cujo dono não é vendedor (master, pool órfão). */
  carteiraNaoVendedor: { receita: number; pedidos: number };
  /** Pedidos válidos sem carteira elegível (cliente sem carteira, carteira inelegível, cliente nulo). */
  naoAtribuido: { receita: number; pedidos: number };
  semAtividade: number;
}
export function montarRanking(
  orders: OrderRankRow[],
  regua: {
    donoPorCliente: Map<string, string>; // customer_user_id → owner_user_id, SÓ eligible
    vendedores: Map<string, string>;     // userId → nome (farmer/hunter/closer)
  },
): RankingResult
```

Os dois mapas vão num objeto NOMEADO: são do mesmo tipo (`Map<string, string>`), e na forma posicional
trocá-los compilaria em silêncio.

Para cada pedido com `isPedidoValido(status)`: `dono = donoPorCliente.get(customer_user_id)`;
`dono ∈ vendedores` → linha do vendedor; `dono` definido e ∉ `vendedores` → `carteiraNaoVendedor`; sem `dono`
→ `naoAtribuido`. Ordem por receita desc; `semAtividade = |vendedores| − |ranking|`. **`created_by` não existe
mais no tipo**: nenhuma via o lê. Invariante (testada): Σ ranking + não-vendedor + não-atribuído = Σ válidos.

`rankingSemPedido(r)` (puro): `true` só quando os TRÊS destinos estão vazios — o card usa para se esconder
(hoje ele olha só `ranking` e `naoAtribuido`, e esconderia um mês só de carteira de não-vendedor).

### 5.2 A leitura da carteira — `src/lib/dashboard/fetch-donos-carteira.ts` (novo)

`fetchDonosCarteira(clienteIds: string[]): Promise<Map<string, string>>`

- ids distintos, em lotes de **150** (`.in('customer_user_id', lote)` com `.eq('eligible', true)`, select
  `customer_user_id, owner_user_id`). `UNIQUE(customer_user_id)` ⇒ cada lote devolve ≤ 150 linhas, longe do teto
  de 1.000; com o pico de 204 clientes/mês são 2 requisições.
- **`error` → lança; `data` nula sem `error` → lança** (malformada ≠ fim, classe #1338→#1564). Lista vazia → mapa
  vazio sem requisição.
- Cliente sem linha elegível simplesmente não entra no mapa — e cai em `naoAtribuido` na régua. Ausência aqui é
  a verdade do banco para o master (RLS ALL), não falha de leitura.

### 5.3 O hook — `src/hooks/useTeamRanking.ts`

Papéis → nomes (como hoje) → `fetchPedidosMTD` (agora com `customer_user_id`) → ids distintos dos pedidos
válidos → `fetchDonosCarteira` → `montarRanking`. Qualquer leitura de dinheiro que falha lança → o card mostra
"Indisponível no momento" (já existe), nunca "Sem vendedor atribuído".

### 5.4 O card — `src/components/dashboard/RankingVendedoresCard.tsx`

- Subtítulo: "por quem lançou o pedido" → **"por dono da carteira"**.
- Rodapé: nova linha **"Carteira de não-vendedor: R$ X · N ped."** (com `title` explicando: dono da carteira sem
  papel farmer/hunter/closer — hoje o master e o pool órfão), antes de "Sem vendedor atribuído".
- Esconde-se só com `rankingSemPedido`.

### 5.5 O tile — `src/hooks/useTeamKpis.ts`

A leitura de atividade de `sales_orders` ganha `.is('hash_payload', null)`: só a linha nascida no app (sem hash
do importador) é "vendedor lançou pedido". Ligação e visita seguem iguais. `hash_payload` tem SELECT para
`authenticated` (medido na spec paralela). O registro do gate `universo-pedidos-ts-registro.ts` acompanha a
forma nova da query.

### 5.6 O importador

**Nenhum byte na edge.** A ideia inicial era um comentário em `index.ts` (o `created_by` da importada é carimbo
técnico, NÃO atribuição). Só que o `sonda:fingerprint` faz hash dos bytes CRUS da edge, com os comentários, e o
`omie-vendas-sync` é instrumentado (`versao.ts`). Um comentário mudaria a `fonte` e abriria pendência de deploy
(DIVERGE_P2) no ledger. A lição vai para `docs/agent/database.md`, que é onde o próximo leitor de
`sales_orders.created_by` procura.

## 6. Prova

**vitest (TDD — o teste nasce vermelho pelo motivo certo):**
- `montarRanking`: (a) carteira elegível de vendedor → linha dele; (b) dono não-vendedor → `carteiraNaoVendedor`;
  (c) sem carteira → `naoAtribuido`; (d) `created_by` de A com carteira de B → B (o artefato não decide);
  (e) linha do app e importada do mesmo cliente → mesmo dono; (f) inválido (orçamento/pendente/cancelado/
  rascunho) fora de tudo; (g) conservação Σ; (h) ordem desc + `semAtividade`; (i) cliente nulo → `naoAtribuido`.
- `rankingSemPedido`: só não-vendedor → `false` (o card aparece).
- `fetchDonosCarteira` (supabase mockado): 151 ids → 2 chamadas (150 + 1); duplicados deduplicados; filtro
  `eligible = true` presente em toda chamada; `error` → lança; `data` nula → lança; `[]` → nenhuma chamada.
- tile: a query de atividade carrega o filtro de `hash_payload` nulo (asserção sobre o builder mockado).
- `fetchDonosCarteira`: erro no 2º lote lança (o 1º lote não vira mapa parcial).
- `fetchPedidosMTD`: a página traz `customer_user_id` (sem ele, o mês inteiro iria calado para "Sem vendedor
  atribuído").
- hook: a carteira é lida com os clientes dos pedidos do mês (sem nulo); falha da carteira → erro (card
  "Indisponível"), nunca mapa vazio.
- card: subtítulo "por dono da carteira"; linha "Carteira de não-vendedor" (com `title`) antes de "Sem vendedor
  atribuído"; some só com os três destinos vazios.

**Falsificação** (`scripts/falsificar-ranking-carteira.sh`; commit antes; `trap` restaura; controle VERDE na mesma
invocação antes da 1ª sabotagem; cada sabotagem declara os testes que a acusam, que TÊM de avermelhar, e nenhum
outro pode; rodada em `LC_ALL=C` e `pt_BR.UTF-8`; os testes casam por marcador ASCII como `[RK-D]`):
S1 sem `.eq('eligible', true)` · S2 crédito por `created_by` · S3 erro da carteira vira mapa vazio ·
S4 `data` nula vira fim · S5 não-vendedor somado em `naoAtribuido` · S6 `rankingSemPedido` olhando só 2 destinos ·
S6b o card voltando a olhar só 2 destinos · S7 tile sem o filtro de `hash_payload` · S8 hook manda lista vazia à
carteira · S9 hook engole a falha da carteira · S10 `fetchPedidosMTD` sem `customer_user_id` · S11 papéis
(`commercial_roles`) com `data` nula viram destino · S12 falha de outra origem no lugar da carteira (o `[HK-FALHA]`
casa a marca do ramo). S11 e S12 vieram da revisão final com contexto novo.

**Medir depois:** a SQL de referência (Apêndice A) roda no dia da validação e dá os números esperados do card
naquele instante; o founder confirma no card depois do Publish e de atualizar o app (o SW só troca de build no
clique — bytes servidos = disponibilidade, não adoção). Registro em `docs/historico/`.

## 7. Caminho B — auto-revisão adversária do DESENHO (REVISÃO INDEPENDENTE PENDENTE)

O Codex não foi consultado no desenho (`SALDO_ALTO` 92%, janela reabre 09/10 19:30). Esta seção é a validação
própria; não substitui o adversarial no diff, que segura o PR em DRAFT.

**RÉGUA:**
- *Unidade decisória:* o PEDIDO válido do universo canônico (4 status fora + `deleted_at` nulo + `order_date_kpi`
  no mês de SP), creditado inteiro (`total`) ao dono ATUAL da carteira ELEGÍVEL do `customer_user_id` dele. A
  venda conta 1× porque o universo já garante ≤ 1 linha com kpi por `(account, omie_pedido_id)` (gêmeos).
- *Onde o sistema a expõe:* card "Ranking de vendedores · mês" do `MasterDashboard` (só papel comercial
  master/super_admin) e tile "vendedores ativos". A MESMA carteira já decide a positivação
  (`_carteira_positivacao_for_owner`) e a comissão (cadeia `codigo-vendedor.ts` → `carteira-rebuild`).
- *Denominador:* set/26 = 528 pedidos válidos, R$ 533.890,89; 100% têm carteira; 96,3% em vendedor, 3,7% em
  não-vendedor, 0% sem carteira (§2).
- *Como a prova falsifica:* §6 — S1..S12 e S6b, cada camada sozinha, nos dois locales.
- *Ordem irreversível:* nenhuma. Só front (Publish); reverter = reverter o PR + Publish. Nenhum dado escrito.

**Premissas atacadas:**

| premissa | evidência |
|---|---|
| o `created_by` das importadas não é lido por RLS/visibilidade | catálogo vivo: 0 policy/view/função de leitura; edges e front enumerados (§3) |
| a carteira cobre os clientes que compram | 0% da receita de 12 m sem carteira |
| a leitura não trunca no teto do PostgREST | `UNIQUE(customer_user_id)` + lote de 150 ⇒ ≤ 150 linhas/req; pico 204 clientes/mês |
| o master lê a carteira inteira | policy `Master manage carteira` (ALL) |
| ausência no mapa = sem carteira, não falha | erro e `data` nula lançam (§5.2); só sucesso com linha ausente vira `naoAtribuido` |
| "carteira" e "vendedor do cliente no Omie" contam a mesma história | ±0,5 pp entre as duas em set/out (§2) |
| filtrar `hash_payload` nulo não esconde atividade real do app | a linha do app nasce sem hash (28/28 medidas na spec paralela); só o importador grava `omie_*` |

## 8. Riscos aceitos e limites

1. **Dois instantes:** pedidos e carteira são lidos em requisições diferentes (money-path §14); a carteira só
   muda no rebuild.
2. **Dono atual, não o da data da venda:** cliente que troca de dono leva o mês inteiro (igual à positivação).
3. **Par app×importada com cliente diferente** (3/25 medidos): a venda pode trocar de dono quando a importada
   chega e zera o kpi do app.
4. **Quem não é master não lê a carteira inteira:** se o card for aberto por papel comercial super_admin sem
   `has_role(master)` (hoje 0), a RLS esconde linhas e elas cairiam em "Sem vendedor atribuído". É o mesmo limite
   que o card já tem em `commercial_roles` (staff só vê o próprio papel).
5. **Tile em 0/0 hoje:** verdadeiro para o que o app enxerga (0 pedido do app, 0 ligação, 0 visita em 7 d).

## 9. Fora do escopo

- Comissão (cálculo/relatório) — esta entrega só corrige o card.
- Mudar o `created_by` do importador (usuário-sistema ou DDL de `NOT NULL`).
- Capturar o codVend do pedido nas importadas (régua "vendedor do pedido").
- Gate de master/super_admin no card (limite 4).

## 10. Pronto quando

- [ ] spec e plano revisados pelo founder;
- [ ] código + testes (TDD) + falsificação S1..S12 e S6b nos 2 locales; `typecheck`, `lint`, `test` verdes;
- [ ] PR **DRAFT**; Codex adversarial no diff (≥ 09/10 19:30), achados tratados; revisão final com contexto novo;
- [ ] Publish do front (founder) e o app do founder atualizado;
- [ ] medição depois (Apêndice A) × card, registrada em `docs/historico/`.

Camadas de deploy: **só o Publish** (founder). Nenhuma migration, nenhuma edge.

## Apêndice A — SQL de referência (medir antes/depois)

```sql
-- Régua decidida, conta = todas. Trocar o intervalo pelo mês medido; para uma conta, AND so.account = '<conta>'.
WITH u AS (
  SELECT so.customer_user_id, so.total
  FROM sales_orders so
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
    AND so.order_date_kpi >= '2026-10-01' AND so.order_date_kpi < '2026-11-01'),
vend AS (SELECT DISTINCT user_id FROM commercial_roles WHERE commercial_role IN ('farmer','hunter','closer'))
SELECT CASE WHEN ca.customer_user_id IS NULL THEN 'sem vendedor atribuido'
            WHEN ca.owner_user_id IN (SELECT user_id FROM vend) THEN ca.owner_user_id::text
            ELSE 'carteira de nao-vendedor' END AS destino,
       count(*) AS pedidos, sum(u.total) AS receita
FROM u LEFT JOIN carteira_assignments ca ON ca.customer_user_id = u.customer_user_id AND ca.eligible
GROUP BY 1 ORDER BY 3 DESC;
```
