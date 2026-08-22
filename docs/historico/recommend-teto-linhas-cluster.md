# O teto que apagava clientes reais — `sim_score` do motor de recomendação

**Entrega:** `fix(recommend)` 2026-08-22 · migration `20260822000358_recommend_cluster_agregado`
+ edges `recommend/index.ts` e `_shared/recommend-leituras.ts`
**Origem:** o eixo que o [#1852](recommend-amostra-sem-denominador.md) deixou NOMEADO ao consertar
a amostra e o denominador.
**Irmãos da mesma classe:** [`roteirizador-corte-cidades.md`](roteirizador-corte-cidades.md) e o
próprio #1852 — 3ª vez no repo que um corte por ranking usa um EIXO que não é o da decisão.

## O defeito, e por que não era "só uma amostra menor"

`carregarCluster` lia `order_items` dos 50 clientes amostrados com `.order("id").limit(1000)`.
Como `order_items.id` é UUID `gen_random_uuid()`, esse LIMIT **não é janela temporal** — é amostra
de LINHAS. Medido em prod:

| cluster | linhas existentes | vistas | clientes com compra REAL | **ZERADOS** | produtos vistos / reais |
|---|---|---|---|---|---|
| critico | 749 | 749 | 50 | 0 | 299 / 299 |
| atencao | 2.413 | 1.000 | 50 | **5** | 329 / 500 |
| estavel | 16.738 | 1.000 | 50 | **2** | 423 / **1.410** |

Os 5 e 2 são o defeito inteiro: o cliente **tinha** compra, o comprador pesado consumiu o
orçamento de 1.000 linhas antes de chegar nele, e o denominador (50) o contava como "não
comprou". Isso é fabricar zero — o que `money-path.md` §2 proíbe. Em `estavel` a edge decidia
vendo **6% das linhas e 30% dos produtos**.

Recompra e pedido com muitos SKUs gastavam cap **sem mover o numerador**, que conta clientes
DISTINTOS. O orçamento era gasto exatamente no que não era usado.

## A lição de método: a agregação no lugar errado ARRASTA o teto

Agregar no TypeScript obriga a **ler as linhas**; ler linhas obriga a um **teto**; o teto
corta por um eixo que não é o da decisão. A correção não é um teto maior — é mover a agregação
para onde os dados estão. Depois disso o teto vira disjuntor de custo, e o volume que trafega
é o agregado (≤1.410 linhas), não o histórico (16.738).

**Corolário que quase me mordeu:** a RPC devolvendo linha-por-produto **reabriria o defeito**.
O agregado tem 957 / 1.312 / 1.109 produtos e o PostgREST capa em 1.000 em silêncio — inclusive
em `.rpc()`. Dois dos três clusters truncariam **hoje**, e `critico` está a 4% do teto. Por isso
o retorno é **uma linha com `jsonb`** (40–55 kB): sem cap, atômica, sem página inconsistente.
O nº de produtos é limitado estruturalmente pelo catálogo ativo (3.140), então esse eixo não
cresce sem limite — o de clientes sim, e é lá que o disjuntor mora.

## As escolhas de recorte foram MEDIDAS, não estimadas

| recorte | critico | atencao | estavel | veredito |
|---|---|---|---|---|
| histórico inteiro | 406 | 837 | 4.172 | **escolhido** |
| últimos 12 meses | **33** | 149 | 1.410 | rejeitado |
| últimos 10 pedidos | 290 | 404 | 628 | rejeitado |

A janela temporal é **anti-correlacionada com o eixo do cluster**: `critico` É o cluster de quem
parou de comprar, então o `health_class` já codifica recência e filtrar por recência de novo
derruba 92% do sinal justamente onde estão 91,6% dos clientes. (44% dos pares de SKU ativo em
`critico` têm mais de 36 meses, contra 15% em `estavel` — a assimetria é o próprio eixo.)

A amostragem foi **eliminada**, não ajustada: a população elegível é 779 / 348 / 100 e o cluster
inteiro custa **51,9 ms** (`EXPLAIN ANALYZE`, pior caso). Não havia cauda longa a amostrar. De
brinde, a auto-inclusão que o #1852 deixou aberta caiu de 2% para 0,13% / 0,29% / 1,00% — diluída,
não consertada.

## O denominador: por que "população" e não "observados"

Os dois **divergem** (779 vs 633 em `critico`; 348 vs 334 em `atencao`) e a escolha muda
comportamento: com população, zero produtos cruzam 0,10 em `critico`; com observados, dois cruzam.

População é o certo por duas razões:
1. **A leitura é EXAUSTIVA.** Cliente sem par é fato OBSERVADO — "li o histórico inteiro dele e X
   não está lá" —, não truncagem. É precisamente a exaustividade que separa este zero legítimo do
   zero fabricado que a entrega mata. ⚠️ E é por isso que tem **precondição**: se o disjuntor
   morder, o denominador-população deixa de ser honesto. Daí `truncado` devolver NULL, não 0.
2. **"Clientes similares"** no texto que o vendedor lê é a população do cluster, não a
   subpopulação que já comprou algo. Dividir pelos observados é viés de seleção — denominador
   filtrado pelo numerador — e infla `sim` sistematicamente.

## O que muda no que o vendedor vê

| cluster | den antes | sim máx antes | >0,10 / >0,15 / >0,20 | den depois | sim máx depois | >0,10 / >0,15 / >0,20 |
|---|---|---|---|---|---|---|
| critico | 50 | 0,180 | 4 / 2 / 0 | 779 | 0,096 | **0 / 0 / 0** |
| atencao | 50 | 0,240 | 4 / 3 / 1 | 348 | 0,210 | 13 / 2 / 1 |
| estavel | 50 | 0,200 | 8 / 1 / 0 | 100 | **0,430** | 129 / 64 / **34** |

Em `critico` os cortes **deixam de disparar** — e isso é o sistema dizendo a verdade, não uma
regressão: com o cluster inteiro **não há** produto que 10% dos 779 clientes comprem. O `sim` de
antes era maior por ser calculado sobre 50 pessoas, não por haver mais sinal. **Não recalibrei os
cortes de propósito**: baixá-los para fazer o ramo acender seria fabricar disparo.

## O sinal da fase anterior (o que autorizou esta fase)

`recommendation_log` em 2026-08-22: 669 `cross_sell` + 28 `repurchase` + **1 `cluster_based`**.
O #1852 mediu **zero, sempre**. O ramo acendeu pela primeira vez depois daquele deploy — é a
evidência positiva com denominador que `docs/historico/fase-sem-sinal.md` exige antes da fase N+1.

## Prova

- **SQL provado EXECUTANDO** em PG17: `db/test-recommend-cluster-agregado.sh` — 25 asserts, 6
  falsificações (dedup, whitelist, NULL-sob-truncagem, REVOKE, SKU ativo, universo de pedidos).
  O assert **A0 é o controle**: reproduz a leitura antiga e exige que ela zere um cliente real —
  sem ele, "nenhum cliente zerado" não provaria conserto nenhum.
- **A falsificação achou um assert sem dente** e isso vale registrar: o teste do REVOKE passava
  **sem** o REVOKE, porque no harness `authenticated` não tinha SELECT nas tabelas e o 42501 vinha
  da tabela, não da função. No Supabase real `authenticated` **tem** SELECT (a RLS é que filtra),
  então o harness testava um mundo que não existe — e o REVOKE, que lá é a única barreira, parecia
  redundante. Lição: **um harness que não espelha os GRANTs do ambiente real transforma defesa em
  redundância aparente.**
- **Antes/depois medido:** `db/recommend-cluster-rpc-antes-depois.sql` (read-only).
- **Edge:** 38 testes em `recommend-leituras_test.ts` (`test:edges` 825/825), com 4 falsificações
  próprias conferindo dente.

## Pós-deploy — o que ficou PROVADO e o que não (2026-08-22)

**Migration:** aplicada e revalidada em prod por DEFINIÇÃO — ACL `anon=f authenticated=f
service_role=t`, `SECURITY INVOKER`, `search_path` fixo, 8/8 invariantes em `pg_get_functiondef`.
⚠️ Ela **não pode ser executada** pelo `claude_ro`: o próprio REVOKE que a protege bloqueia a role
de diagnóstico. Esta função só se valida por definição — prova de execução exige passar pela edge.

**Edge:** provada no ar por **assinatura de gate**, técnica registrada em
[deploy.md](../agent/deploy.md). O bundle servido passou por #1877 (v1.3) e, horas
depois, #1882 (v1.4) — ambos com este PR como ancestral e ambos carregando a RPC (`git merge-base --is-ancestor` + `git show <commit>:<arquivo>`, e nenhum commit
tocou `recommend-leituras.ts` entre os dois).

**Antes/depois reproduzido em prod** (`db/recommend-cluster-rpc-antes-depois.sql`, `EXIT=0`): bate
com o medido no PR dentro de ±1 cliente — banco vivo. Os 5 e 2 clientes zerados em
`atencao`/`estavel` seguiam lá até o deploy.

⚠️ **O efeito no ranking está medido OFFLINE, não observado.** A query reproduz a lógica da RPC
contra os dados reais; ela não é a edge rodando. Desde o merge do #1877 (2026-08-22 18:33Z),
`recommendation_log` tem **0 impressões** — a última execução do motor, de qualquer tipo, é de
**2026-08-21 23:52:48** local, anterior à entrega. Zero impressão é ausência de dado, não
aprovação: pela regra de `fase-sem-sinal.md` esta entrega **ainda não tem sinal de uso próprio**, e
quem julga é:

```sql
SELECT recommendation_type, count(*) FROM recommendation_log
WHERE created_at >= '2026-08-22T18:33:16Z' GROUP BY 1;
```

O que esperar quando alguém usar a tela: `cluster_based` sumindo de `critico` (nenhum produto cruza
0,10 com n=780) e acendendo em `estavel` (62 produtos cruzam 0,15, contra 1 antes). Se ele passar a
DOMINAR o mix contra `cross_sell`, é consequência esperada de destampar sinal real — e é o gatilho
para a decisão de produto sobre os cortes, que segue aberta abaixo.

## ⚠️ REVISÃO INDEPENDENTE PENDENTE — e o diagnóstico ANTERIOR estava errado

**Correção do que este doc afirmava em 2026-08-22.** Estava escrito aqui que "a conta recusa
**todos** os modelos com HTTP 400" e que o eixo era acesso de conta, não nome de modelo. **Falso**,
e a causa é instrutiva: o `codex-async.sh` classificava o erro lendo o stderr CRU, que **ecoa o
prompt inteiro** antes das linhas de erro. O prompt que diagnosticou o problema continha a própria
frase `model is not supported` — então o TEXTO DO PROMPT decidia o controle de fluxo, abortando com
`MODELO_NAO_ACEITO` sem retry. O #1880 consertou (classifica só o que NÃO veio do prompt) e mediu:
`gpt-5.6-terra` e `gpt-5.6-luna` respondem `rc=0`; só `-sol`, `gpt-5.6` e `codex-max` dão 400. O
default era `sol` — morto — então **todo ritual `/codex` do repo falhava**, e o diagnóstico daqui
generalizou de um bug de classificação para uma conclusão sobre a conta.

⚠️ **Corolário de método:** `git show <commit>:<arquivo>` responde sobre o COMMIT; `./script`
executa o DISCO. Ao rodar o ritual depois disso, li o conserto do #1880 por `git show` e executei a
versão velha do script que estava no worktree (criado alguns commits antes) — que tentou `sol` de
novo. Num repo com ~30 worktrees paralelas os dois divergem o tempo todo: **atualize o worktree
antes de executar um script que você acabou de ver ser consertado.**

**Estado real (2026-08-22):** a cota Codex esgotou até 20/09 — confirmei por ping mínimo
independente (prompt de 4 palavras, sem nenhuma frase-gatilho, mesmo limite), e o #1887 chegou ao
mesmo em paralelo e registrou o assunto em
[`farmer-sensor-desfecho.md`](farmer-sensor-desfecho.md), que é onde ele mora — não duplico aqui.
Segue o **Caminho B**, agora com o alvo (a) efetivamente atacado (abaixo). Rodar o Codex retroativo em
setembro, mirando em (b) histórico inteiro carregar par de 6 anos e (c) a renormalização de pesos
sob `truncado` — que segue sem nenhuma execução real.

## O que o Caminho B ACHOU no alvo (a): o filtro de SKU mistura duas perguntas

O denominador é a população elegível (780 em `critico`), e `observados` é 634. Eu justifiquei a
diferença como fato observado — "li o histórico inteiro dele e o produto X não está lá". **Medido,
a justificativa não se sustenta como escrita:**

```
sem_par=146 · tem_order_items=146 · sobrevive_universo=146 · zero_linhas_de_todo=0
```

Os 146 têm compra, e os pedidos passam pelo filtro de universo. Quem os elimina é **exclusivamente
`o.ativo`** — todo produto que compraram saiu do catálogo. Eles não são "clientes que não compraram
X": são clientes sobre quem a pergunta não é respondível com este recorte. O erro conceitual é
misturar, no MESMO denominador, um filtro de **cliente** (`health_class`, `sales_history_status`,
que define a população) com um filtro de **produto** (`o.ativo`, que define o que é recomendável).

E o viés **não é neutro**: correlaciona com o próprio eixo do cluster. Quem parou de comprar
comprava o que hoje está descontinuado — 146/780 = **18,7%** em `critico`, 14/347 = 4,0% em
`atencao`, **0** em `estavel`. É o que separa 0 de 2 produtos cruzando o corte de 0,10:

| cluster | pop | obs | só SKU inativo | simmax pop | simmax obs | >0,10 pop | >0,10 obs |
|---|---|---|---|---|---|---|---|
| critico | 780 | 634 | **146** | 0,096 | **0,118** | **0** | **2** |
| atencao | 347 | 333 | 14 | 0,213 | 0,222 | 12 | 15 |
| estavel | 100 | 100 | 0 | 0,430 | 0,430 | 128 | 128 |

⚠️ **Mas a contra-medição rebaixa a severidade, e ela também é obrigatória.** Os 146 são clientes
LEVES: 427 linhas no total, média 2,9, **mediana 2**, e 38% têm uma linha só. Um cliente de 2 linhas
contribuiria no máximo 2 produtos entre 957 — para quase todo produto ele é um "não comprou"
legítimo, ativo ou não. Então isto é **[P2]: escolha de denominador com viés medido**, não a
fabricação grosseira que a primeira leitura sugeria. O que fica como regra durável, independente
da magnitude: **filtro de PRODUTO não pertence ao denominador de uma proporção sobre CLIENTES.**

### Resolvido: o founder decidiu trocar (2026-08-22)

O achado foi apresentado com os dois números — o viés (18,7%) e a contra-medição que o rebaixa
(mediana 2 linhas) — e a decisão foi **trocar o denominador para `observados`**.

⚠️ **A correção NÃO precisou de migration**, e isso vale registrar como método: `observados` já
existia no contrato da RPC, calculado e devolvido, apenas rotulado como "DIAGNÓSTICO, não
denominador". A entrega inteira é `Math.max(denominador, 1)` → `Math.max(observados ?? 0, 1)` no
consumidor, mais a justificativa e o gate que a pina. Antes de escrever SQL novo, **verifique se o
dado que você quer já está atravessando o contrato** — aqui estava, e a diferença é entre um deploy
de edge e um par migration-manual + edge.

Como consequência, as duas ordens de deploy são seguras (não há janela ruim): migration nova não
existe, e a RPC em produção já devolve os dois campos — a edge velha usa população (comportamento de
ontem), a nova usa observados. Nenhuma combinação quebra.

Efeito: `critico` deixa de estar MUDO — sai de simmax 0,096 com **nenhum** produto cruzando 0,10
para 0,118 com **dois**; `atencao` vai de 12 para 15 produtos em 0,10; `estavel` não muda
(observados = população = 100). O `?? 0` não fabrica: `observados` só é `null` sob truncagem, e aí
`simIndisponivel` já desligou o componente. Medição reproduzível em
`db/recommend-denominador-observados.sql` (roda contra prod, `EXIT=0`).

## Segue aberto (nomeado para não passar por consertado)

- **auto-inclusão**: diluída para 0,13%/0,29%/1,00%, não consertada — falta leave-one-out;
- o cluster é global por `health_class` e **ignora `farmer_id`**, embora a coluna exista;
- **os cortes 0,10/0,15/0,20 não foram recalibrados**, e agora mordem de forma muito diferente por
  cluster (0,096 em `critico` com n=779; 0,430 em `estavel` com n=100). Recalibrar exige decidir se
  o corte é sobre proporção ou sobre contagem absoluta — e isso é decisão de produto, não de
  implementação;
- o caminho de degradação sob `truncado` **nunca executa hoje** (779 « 5.000): é disjuntor, e sua
  primeira execução real será a primeira vez que alguém o vê funcionar.
