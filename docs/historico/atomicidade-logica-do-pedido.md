# Atomicidade lógica do pedido: a garantia de LEITURA não é a de ESCRITA

Entrega de 2026-08-30, fechando a pendência que o #2132 nomeou ao fechar a CESTA RASGADA
(registro em [`paginacao-offset-janela.md`](paginacao-offset-janela.md)).

## A distinção que é o assunto inteiro

O #2132 trocou duas leituras paginadas por RPCs de snapshot cuja **única query** toca as tabelas.
Uma statement enxerga um snapshot MVCC ⇒ tudo que volta pertence a **um instante do banco**.

Isso fecha a cesta rasgada e **não** fecha a atomicidade do pedido, porque as duas coisas são
defeitos de naturezas diferentes:

| | cesta rasgada (#2132) | atomicidade lógica (esta) |
|---|---|---|
| onde nasce | **leitor** (paginação) | **writer** (transações soltas) |
| o estado lido | **NUNCA existiu** — é artefato | **EXISTIU**, commitado |
| o que é | perda de **precisão** | falta de **atomicidade** |
| como se fecha | leitor de uma query | escrita numa transação |
| leitor correto basta? | sim | **não** — o snapshot lê o meio-pedido *corretamente* |

**A frase que resume: o snapshot lê o pedido meio-reconciliado CORRETAMENTE, porque ele existiu.**
Nenhum conserto de leitor alcança isso. É a diferença entre "a foto saiu tremida" e "o objeto
fotografado estava mesmo pela metade".

## O writer que existia

`sync-reprocess` reconciliava um pedido em **N + M + 2 transações PostgREST**:

```
N × insert de item   (uma transação cada)
M × update de item   (uma transação cada)
1 × delete .in(ids)  dos itens removidos
1 × update do cabeçalho (status/total/subtotal/items)
```

Entre a primeira e a última há um instante commitado com **itens da revisão velha convivendo com
os da nova**, e um cabeçalho que ainda não fala de nenhuma das duas. O código tinha até uma defesa
artesanal — *"itens primeiro; só grava o cabeçalho se nenhum item falhou"* — que nunca cobriu a
falha **entre dois writes de item**, que é o caso comum.

Quem paga: os mesmos dois consumidores. `omie-analytics-sync` publica **regra de associação
Apriori globalmente** — uma cesta que mistura duas revisões vira uma regra que ninguém explica
depois. `fin-valor-cockpit` deriva **margem/EVP** de receita meio-reconciliada.

## Por que o caminho (a), e não o (b)

Os dois nomeados eram: **(a)** RPC de escrita por pedido; **(b)** `order_revision` imutável com
ponteiro `published_revision` trocado no fim.

O que decidiu **não** foi preferência de desenho — foi descobrir que **(a) já é o desenho vigente
deste repo, e esta entrega é o buraco que ele declarou**. A migration `20260617160000`
(`criar_pedidos_com_itens`, #929) fez exatamente isto para o INSERT de pedido novo, foi provada em
PG17 com falsificação, passou por challenge Codex — e o `COMMENT` dela diz, textualmente:

> "Repara órfão (pai sem itens) só se cabeçalho compatível (G5) — **não reconcilia pedido alterado
> (Fase 2)**."

Esta entrega é essa Fase 2. Contra (b), três coisas concretas:

1. **(b) precisa de (a).** Trocar `published_revision` sem rasgar é uma transação — a **mesma
   primitiva**. (b) é (a) mais um modelo de dados novo, não uma alternativa a (a).
2. **(b) toca TODO leitor de `order_items`**, não os dois da pendência: `recommend`,
   `analyze-unified-order`, `algorithm-a-audit`, `usePropostaPreview`, `useHistoricoCompras` e as
   views SQL. Cada um teria de filtrar pela revisão publicada, e **quem esquecesse leria revisão
   não publicada** — falha ABERTA e silenciosa, a classe que este repo persegue. (a) fecha a
   janela para todos eles **sem mudar leitor nenhum**, inclusive os que ainda paginam.
3. **(b) migra as ~70 mil linhas vivas** de `order_items` para carregar `revision_id`. Backfill no
   caminho do dinheiro, por um ganho — histórico de revisões — que a pendência não pede.

## A LIÇÃO NOVA: diff computado fora da transação é atômico e ERRADO

O caminho barato era manter `diffOrderItens` no TS e mandar `{inserir, atualizar, deletar}` pronto
para a RPC aplicar de uma vez. Isso dá atomicidade e **ainda assim não dá o que se quer**:

> Esse diff nasce de um `SELECT` que aconteceu **fora** da transação de escrita. Entre a leitura e
> a aplicação, um item que **nascesse** não estaria nem em `inserir` nem em `deletar` — e
> **sobreviveria**. A revisão aplicada seria *"a nova, mais um estranho"*: uma revisão que ninguém
> pediu, escrita atomicamente.

O conserto é **declarativo**: a RPC recebe o conjunto **desejado** e computa o diff ela mesma,
dentro da transação, sob `FOR UPDATE` do pai. Efeito colateral que vale por si: a chamada vira
**idempotente de verdade** — rodar duas vezes com o mesmo payload converge (assert A13/A14).

**Generalização:** *atomicidade da APLICAÇÃO não é o mesmo que atomicidade da DECISÃO.* Quando a
decisão de escrita é tomada a partir de uma leitura anterior, envolvê-la numa transação congela o
efeito, não a premissa. A pergunta certa não é "isto está numa transação?" e sim **"o estado que
decidiu isto foi lido DENTRO da transação que o aplica?"**.

## O teste que a pendência exigia, e o antídoto que o faz valer

Nenhum teste do repo cobria isto. `T1` em `db/test-reconciliar-pedidos-omie.sh`:

1. seed com a revisão **antiga completa** (itens P1, P2);
2. sessão B abre transação, chama a RPC (revisão nova: P1 removido, P2 atualizado, P3 inserido) e
   **pausa antes do COMMIT** (`pg_sleep`);
3. sessão A chama `apriori_universo_snapshot` — o **leitor REAL de produção**, não um `SELECT`
   ad-hoc;
4. exige revisão **antiga completa OU nova completa**, nunca mistura.

O antídoto contra falso-verde é o mesmo do harness do #2132, e sem ele o teste passaria de graça:
**exige sobreposição temporal** `TB0 < TA < TB1`. Se a leitura não cair dentro da janela de B, o
teste **FALHA por "cenário sem dente"** em vez de aprovar.

E `F1` prova que o cenário morde: reproduz o writer de **hoje** — insert do item novo commitado,
delete do velho e cabeçalho depois — e a leitura no meio devolve `a1,b1,c1`. **A mistura.** Era o
que a pendência dizia que aconteceria, medido em vez de afirmado.

| assert | desfecho |
|---|---|
| T1 — leitura durante a reconciliação não-commitada | **antiga COMPLETA** (`SOBREP=SIM`) |
| T1c — depois do COMMIT | **nova COMPLETA** |
| F1 — o writer de HOJE no mesmo cenário | **RASGA** (`a1,b1,c1`) |

56 asserts, PG17, `exit 0`. Quatro falsificações, todas vermelhas: guard de conjunto da lista de
status virando "não-vazia" · `total` ausente voltando a `coalesce(…,0)` (o pedido **zera**) · guard
de SKU repetido removido (**apaga linha legítima**) · `REVOKE` removido (**`anon` executa a RPC de
escrita**). Uma sabotagem por bloco — sabotagem que contamina o assert vizinho não prova o vizinho.

## O que a medição sustenta — e o que ela NÃO sustenta

Prod, `psql-ro`, 2026-08-30, `sync_reprocess_log` com `entity_type='orders'`, 14 dias:

| | |
|---|---|
| runs | 182 (cron `15 */2 * * *` — 12/dia, **em horário comercial**) |
| duração | 18,9 s média · 60,2 s máxima |
| correções de item | 152 |
| pedidos com upsert | 136 |

**~10 pedidos reconciliados por dia. A janela é de BAIXA FREQUÊNCIA, e isso está dito de
propósito.** O que justifica a correção não é o volume: é que o produto do consumidor é
**publicado** (regra de associação global, margem), e ali vale precisão > recall.

O que a medição **não** sustenta: que houvesse corrida entre dois ciclos do reprocess. 60 s de
máxima contra 7.200 s de intervalo ⇒ não se sobrepõem. O `FOR UPDATE` do pai **não** está lá por
isso — está para serializar contra `criar_pedidos_com_itens`, que trava o mesmo pai, e contra
invocação manual.

## Duas verificações que impediram achado errado

Registradas porque **custam minutos e teriam virado "conserto" inerte ou defeito inventado**:

- **`order_items.created_at` do item reconciliado.** O default da coluna é `now()`, e o writer não
  passava `created_at` — parecia que todo item inserido por reconciliação entrava na janela TTM do
  cockpit com data errada. **Falso:** existe o trigger `trg_order_items_created_at_omie`, que herda
  a data do PAI para todo pedido `omie\_%`. A garantia é do **banco**, não do writer. A RPC segue
  não passando `created_at` de propósito — passar duplicaria a regra em dois lugares — e o assert
  A10 prova que a herança acontece (o harness cria o trigger real).
- **Quem mais escreve `order_items`.** Só `sync-reprocess` e a RPC do `omie-vendas-sync` — que
  **pula** pedido existente com itens (`skipped_complete`). Se houvesse um terceiro writer solto, a
  atomicidade desta RPC seria local e a janela continuaria aberta por outra porta.

## A revisão independente BLOQUEOU esta entrega — e os 4 P1 foram consertados (2026-08-30)

O ritual `/codex` rodou (`gpt-5.6-sol`, xhigh, exit 0) e o veredito foi **BLOQUEAR**, com 4 P1.
Parecer completo em [`../pareceres/2026-08-30-codex-atomicidade-pedido.md`](../pareceres/2026-08-30-codex-atomicidade-pedido.md).
Os quatro foram **consertados**, cada um com a sua falsificação: 87 asserts, exit 0, 9
falsificações vermelhas. O que ele derrubou, em ordem de gravidade:

1. **SKU repetido no estado ATUAL não é detectado** — o guard só olha o conjunto desejado. Medido
   por mim em prod: **1.179 pares repetidos, 1.049 pedidos Omie vivos**. As duas linhas do mesmo
   código caem no `UPDATE`, recebem o mesmo conteúdo, nenhuma é deletada, e o cabeçalho é
   atualizado como se fosse uma linha — **valor duplicado** no Apriori e no cockpit. Pior: o
   assert `C6` do harness **codificava esse comportamento**, exigindo "filhos antigos + cabeçalho
   novo" — a revisão MISTA que esta entrega existe para eliminar. O teste protegia o defeito.
2. **`FOR UPDATE` serializa CHEGADA, não VERSÃO.** O payload não carrega revisão do Omie
   (`infoCadastro.dAlt/hAlt`), então um run que buscou R1 pode chegar depois de um que publicou R2
   e **sobrescrever R2 com R1** — atomicamente errado. E o `T3` aceita qualquer uma das revisões,
   portanto **não prova monotonicidade**. Existe um caminho **(c)** que nem (a) nem (b) enxergavam:
   (a) + compare-and-set por revisão de origem + identidade de linha (`det.ide.codigo_item`).
3. **O cabeçalho não é reconciliado declarativamente** — a decisão de atualizar ignora `items` e
   `subtotal` atuais, então drift só neles nunca é reparado.
4. **`WHEN OTHERS` mascara classes sistêmicas** (deadlock `40P01`, `40001`, permissão, schema) como
   "um pedido ruim", e a run sai `complete`.

Mais dois de menor porte: o antídoto temporal do `T1` tem furo (ver o parecer) e há **deadlock
AB/BA** possível entre lotes com ordem de pedidos divergente — o `T3` testa só duas sessões no
MESMO pedido, onde não há ciclo.

### As duas lições que os consertos deixam

**1. Um guard de ambiguidade tem dois lados, e o lado esquecido costuma ser o do BANCO.** O guard
olhava a entrada (o payload do Omie) e não o estado (o que já está gravado) — e o caso real era o
segundo: 1.049 pedidos vivos, nenhum deles vindo de um payload duplicado. A generalização: quando
uma chave não é identidade, **os dois lados da comparação podem violá-la**, e checar só o lado que
chega deixa passar o lado que ficou. O sintoma diagnóstico é o guard citar só um dos operandos.

**2. Serializar acesso não é ordenar versões.** `FOR UPDATE` garante que duas escritas não se
entrelaçam; não garante que a última a chegar é a mais nova. São propriedades diferentes, e é fácil
ler a primeira como se fosse a segunda porque as duas se descrevem como "resolver concorrência".
Quando as escritas carregam informação de fora do banco, **a ordem de chegada não é a ordem de
frescor** — e sem um carimbo do frescor, a escrita velha vence sem que nada acuse.

**Corolário sobre recomendação de revisor:** o parecer propôs o CAS por `dAlt/hAlt` do Omie. Não
consegui **provar** que o `ListarPedidos` devolve esses campos, e um `dAlt` sempre `NULL`
degradaria o CAS para "aceita tudo" sem erro nenhum. Segui o eixo do achado com um discriminante
que consigo garantir — o instante da leitura pela edge —, e registrei a diferença. **Aceitar a
recomendação certa pelo mecanismo não verificado teria produzido um guard decorativo.**

**A lição de método:** o Codex confirmou o desenho (item 1: "(a) sobre (b) está correta para este
escopo"; item 2: "as CTEs estão corretas"; itens 8 e 9: tolerância e `search_path` corretos) e
derrubou a EXECUÇÃO. O auto-challenge (Caminho B) tinha achado um defeito real — mas nenhum destes
quatro. **Auto-prova cobre o intervalo; não substitui a revisão independente.**

## Segue aberto (não passou por consertado)

- **O snapshot mensal `carteira-positivacao-snapshot` lê QUATRO fontes em instantes distintos**
  (assignments, pedidos, contatos, visitas) e persiste em lotes de 500 em transações separadas,
  continuando após erro. Atomizar o pedido **não** torna aquele snapshot consistente. Intocado
  aqui — herdado do #2132, e continua herdado.
- **`omie-vendas-sync` ainda mantém o mapa etapa→status, o subtotal e o `itemsJson` inline**
  (`omie-pedido.ts` já registra isto), enquanto o reprocess usa o canon compartilhado. Divergência
  entre os dois foi a causa-raiz #B. O canon existe; a unificação não aconteceu.
- **A prova é de PG17 local, não do Data API.** O harness prova a transação no banco. Ele não prova
  o gateway da Supabase, nem RLS de produção, nem um payload de 100 pedidos atravessando o
  PostgREST real como argumento `jsonb`.
- **IDENTIDADE DE LINHA (`det.ide.codigo_item`) — a correção ESTRUTURAL do P1-1.** Enquanto ela não
  existir, os **1.049 pedidos com SKU duplicado não reconciliam**: ficam congelados na revisão
  anterior completa, e a run diz isso em `error_message`. É degradação honesta, não conserto. O
  campo existe no Omie e já é lido pelo `omie-vendas-sync`; falta persisti-lo em `order_items` e
  fazer backfill das ~70 mil linhas vivas — entrega própria, com o seu próprio risco.
- **O CAS usa o instante da LEITURA pela edge, não a revisão da ORIGEM.** Se algum dia se provar
  que o `ListarPedidos` devolve `infoCadastro.dAlt/hAlt`, esse é o discriminante mais forte e o
  carimbo atual vira fallback. Hoje não está provado, e por isso não está no código.
