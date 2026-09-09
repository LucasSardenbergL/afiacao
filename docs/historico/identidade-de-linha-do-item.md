# Identidade de linha do item: a chave que não era chave

Entrega de 2026-08-30, fechando a pendência **ESTRUTURAL** que o #2134 nomeou em
[`atomicidade-logica-do-pedido.md`](atomicidade-logica-do-pedido.md) ("Segue aberto") e que o
parecer [`2026-08-30-codex-atomicidade-pedido.md`](../pareceres/2026-08-30-codex-atomicidade-pedido.md)
levantou como P1-1.

## O problema em uma linha

`omie_codigo_produto` não é identidade de linha. Com o mesmo SKU em duas linhas do pedido, não há
como dizer qual linha local casa com qual item do payload — e o #2134, sem identidade para
oferecer, fez a única coisa honesta: **pulou o pedido inteiro**. Degradação, não conserto.

## A medição veio primeiro, e derrubou TRÊS premissas da tarefa

Prod, `psql-ro`, 2026-08-30. Cada uma destas custou minutos e mudou o que valia construir.

### 1. A duplicidade é LEGÍTIMA — e isso se prova contra o PAYLOAD, não contra as linhas

| | |
|---|---|
| pares `(sales_order_id, omie_codigo_produto)` repetidos | 1.179, em 1.049 pedidos Omie vivos |
| **o payload do Omie repete o SKU também** (`sales_orders.items`) | **1.177 de 1.179** |
| com quantidade/preço DIFERENTES entre as linhas | 1.057 (90%) |
| indistinguíveis (qtd/preço/produto/cliente idênticos) | 122 |

**A generalização de método:** "esta duplicata é dado real ou lixo de import?" não se responde
olhando as linhas duplicadas — elas parecem iguais nas duas hipóteses. Responde-se comparando com
o **retrato da FONTE** que já está guardado. `sales_orders.items` é construído pelo mesmo canon
que alimenta o item, então ele é a segunda testemunha. Sem ela, a resposta seria opinião.

### 2. O backfill das ~70 mil linhas era premissa, não necessidade

Era o caminho esperado pela tarefa, e três medições o dispensam:

1. **Zero foreign keys apontam para `order_items`** (catálogo de prod). Nada guarda o `id` de um
   item, então recriar linha não deixa referência pendurada.
2. Identidade de linha só é **usada** no instante da reconciliação — e é exatamente esse o
   instante em que o payload a **fornece**. Linha que nunca reconcilia nunca precisa dela.
3. A janela do reprocess é 7 dias (operacional) / 30 (estratégica). Dos 1.049 pedidos ambíguos,
   **7 estão dentro de 7 dias e 14 dentro de 30**; o resto vai até **2020-04-17**.

⇒ Os outros 1.035 **não estavam congelados pelo guard** — estão fora de qualquer janela há anos,
e continuariam fora com ou sem esta entrega. "1.049 pedidos congelados" está certo na letra e
engana na escala: o guard congela ~14 por vez, num denominador de 484 pedidos vivos na janela de
30 dias (**2,9%**).

**A generalização:** antes de dimensionar um backfill, pergunte **quem LÊ a coluna e QUANDO**. Se
o único leitor é o mesmo processo que a escreve, o backfill é o processo rodando — e o custo vira
zero. O reflexo de tratar "coluna nova" como "coluna nova + backfill" é o que faz uma entrega
barata parecer cara.

### 3. Não há como provar que o campo CHEGA — e isso muda o desenho, não o adia

`sync-reprocess` usa **`ListarPedidos`**. Quem lê `ide.codigo_item` hoje no repo é o
`omie-vendas-sync`, e lê do **`ConsultarPedido`** — endpoint diferente. A doc oficial diz que a
resposta do `ListarPedidos` é um array do tipo `pedido_venda_produto`, que contém
`det.ide.codigo_item`. Mas **a mesma página documenta `infoCadastro.dAlt/hAlt`**, que o #2134 não
conseguiu provar que chegam. Nesta API, documentação não é medição. E não existe payload de
`ListarPedidos` persistido em lugar nenhum: `omie_webhook_events` tem 192 linhas, **zero** com
`det` ou `codigo_item`.

O desfecho **não** foi esperar. Foi desenhar **inerte-até-alimentado**: sem o campo, toda linha
fica com `omie_codigo_item` nulo, o nível de identidade nunca liga, e o comportamento é
byte-a-byte o de hoje. **A coluna É o sensor.** `metadata.itens_com_codigo_item / itens_lidos` no
`sync_reprocess_log` responde na primeira run, com **denominador** — e o denominador é o que
impede ler "não houve pedido na janela" como "o campo não vem".

## O conserto: casamento em DOIS NÍVEIS

Dentro da mesma transação, sob o `FOR UPDATE` do pai:

1. **nível 1** — por `omie_codigo_item`, quando os dois lados o têm;
2. **nível 2** — por `omie_codigo_produto`, e **só onde o SKU é 1-1 entre os que SOBRARAM, nos
   DOIS lados**. É aqui que a linha antiga (sem identidade) casa com o item novo (com identidade)
   e o `UPDATE` **grava** o `codigo_item`: a adoção é incremental, correta por construção (SKU
   único naquele pedido *é* identidade naquele pedido) e preserva o `id` da linha;
3. o que sobra de `atual` é `DELETE`; o que sobra de `desejado` é `INSERT`.

**O caminho legado é um caso particular disto, não um ramo à parte.** Com o desejado não
identificado, o nível 1 é vazio e o nível 2 reproduz exatamente o join `d.cod = a.cod` de antes.
Um `IF/ELSE` com duas statements teria o mesmo efeito e **duas superfícies para divergir**.

A invariante que o harness afirma em todos os asserts é sempre a mesma: **o pós-estado é
exatamente o conjunto desejado.** Não "parecido", não "sem duplicata" — igual.

### A armadilha já paga tem chave nova, e continua tendo dois lados

Um guard de ambiguidade tem **dois lados** — o payload que chega e o estado que já está gravado —
e o lado esquecido costuma ser o do **banco**. Foi esse exatamente o P1-1 do parecer. A chave
mudou, a armadilha não: são **dois** guards de `omie_codigo_item` repetido, `G-a` no desejado e
`G-b` no atual, e nenhum substitui o outro. Sem o `G-b`, duas linhas locais com o mesmo
`codigo_item` casariam ambas no nível 1 — o valor dobrado de volta, com roupa nova (`F12`).

## A LIÇÃO NOVA: uma defesa estrutural APOSENTA a explícita — e a falsificação existente passa a medir o alvo errado

O guard de SKU repetido (`G-c`) existia para impedir **valor dobrado**. Com o casamento em dois
níveis ele **não impede mais isso** — quem impede é o requisito de 1-1 entre os remanescentes, que
é estrutural: duas linhas ambíguas simplesmente não casam com ninguém, caem no `DELETE`, e os
itens desejados entram pelo `INSERT`. O pós-estado sai correto **mesmo com o guard desligado**.

Consequência imediata e cara: **o `F4`, a falsificação que provava o `G-c`, saiu SEM DENTE.** Ela
media o sintoma antigo (duas linhas do código 2 sobrevivendo). A sabotagem continuava sendo a
certa; o **sintoma** é que tinha mudado de lugar.

> **Generalização:** quando uma defesa migra de explícita para estrutural, a falsificação que
> provava a explícita continua verde ou vira ruído — e nos dois casos ela deixa de provar o que o
> nome diz. Falsificação não se **re-roda** depois de um refactor de defesa: ela se **re-deriva**.
> O diagnóstico barato é perguntar *"qual é o sintoma HOJE?"* antes de rodar, e desconfiar de
> falsificação que continua passando sem que ninguém tenha mexido nela.

O mesmo erro apareceu de novo, sozinho, no `F12`: a primeira versão contava linhas de um SKU, e o
defeito real era outro — as duas linhas que compartilham identidade recebem **ambas** o conteúdo
do mesmo item desejado (a linha do código 1 fica com a quantidade e o preço do código 2, sem
trocar de `omie_codigo_produto`) e o item sem par é **inserido** por cima. Contar linha de um
código não pega isso. **Afirmar a INVARIANTE pega os dois** — e por isso todo assert desta zona
compara o conjunto inteiro, não uma contagem.

## E por que o `G-c` FICOU, mesmo aposentado da sua função original

Porque ele passou a defender outra coisa: **estabilidade**. Sem identidade de linha o casamento do
pedido ambíguo nunca converge, então o rebuild se repetiria **a cada run** (a cada 2 h), com
`corrections` inflado para sempre — a esteira que o `T6`/P1-3 do #2134 combateu na direção
oposta. **Congelar é estável; reconstruir em loop, não.** O `I4` é o assert que fecha isso: a
segunda passada do mesmo payload ambíguo **com** identidade é no-op de verdade.

Isso também é a resposta ao "por que não simplesmente remover o guard e desbloquear os 14 sem
depender do `codigo_item`": porque a troca seria *congelado* por *reconstruído a cada 2 horas*.

## A prova

`db/test-reconciliar-pedidos-omie.sh`: **113 asserts, PG17, `exit 0` nos DOIS locales (`C` e `pt_BR.UTF-8`)**, com a Zona 6 nova
(`I1`–`I8`) e quatro falsificações próprias, todas vermelhas:

| falsificação | o que sabota | vermelho que produz |
|---|---|---|
| `F10` | o 1-1 do lado **ATUAL** no nível 2 | duas linhas do mesmo SKU sobrevivem — **valor dobrado** |
| `F11` | a adoção como motivo **próprio** de escrita | **nenhuma** linha ganha identidade: o desenho nasceria inerte e ninguém veria |
| `F12` | o `G-b` (identidade repetida no **banco**) | pós-estado deixa de ser o desejado — o defeito do parecer, com a chave nova |
| `F13` | o `G-a` (identidade repetida no **payload**) | payload contraditório é aplicado, e falta um item no pós-estado |

O `F11` merece o destaque: **a falha mais cara possível aqui não era escrever errado, era a coluna
nunca se preencher.** Um pedido estável não dispara `UPDATE` por nenhum outro motivo, então sem a
adoção como motivo próprio a identidade só existiria onde já não fazia falta — e os dois sensores
ficariam em zero, indistinguíveis de "o Omie não manda o campo".

## A LIÇÃO DO REBASE: "a última a recriar VENCE" tem um irmão — a última a ser COLADA

Esta fatia nasceu sobre `20260830190000`. Entre o começo e a entrega, a main ganhou
`20260905225613_preco_ausente_nao_e_zero.sql` (#2224), que **também faz `CREATE OR REPLACE` de
`reconciliar_pedidos_omie`** — tornou `order_items.unit_price` nullable e deixou o diff de preço
NULL-SAFE. Uma migration minha escrita a partir do corpo de 30/08 teria **revertido o #2224 em
silêncio**, e nada no CI veria: o arquivo é sintaticamente válido, o harness passava, e a perda só
apareceria como margem negativa fabricada semanas depois.

Três coisas que essa quase-falha ensina, e que o marcador do `database.md` não cobria sozinho:

1. **Timestamp maior não protege.** No Lovable a aplicação é MANUAL: vence quem for **colado por
   último**, não quem tem o nome lexicograficamente maior. O timestamp é etiqueta, não ordem.
2. **O corpo novo se DERIVA do vigente, não se reescreve.** Esta migration foi montada por
   transformação programática do corpo extraído do arquivo real — cada substituição afirmando que
   o padrão existe e é único. O que eu não toquei está lá byte a byte, inclusive a régua de preço.
3. **A cadeia provada tem de ser a cadeia REAL.** O harness passou a aplicar os TRÊS elos
   (base → preço → identidade) e ganhou uma sentinela que lê o `prosrc` depois da minha recriar a
   função, exigindo que o `a.unit_price IS NULL AND d.unit_price IS NULL` continue lá. Sem esse
   elo do meio, a reversão seria invisível para o teste.

E uma armadilha de extração, paga em cima: o terminador do corpo é **`$function$` sozinho na
linha**, com o `;` na linha seguinte. Casar `^\$function\$;` não dá erro — o range do `sed`
simplesmente segue até o próximo `$function$` do arquivo e **arrasta a função seguinte para dentro
do recorte**. Aqui isso injetou `private.margem_cliente_agregada()` na minha migration, e só foi
pego porque o schema `private` não existia no harness. **A versão silenciosa desse mesmo erro é
aplicar código de outro domínio junto com o seu.** Toda extração de corpo SQL precisa de uma
asserção de que o recorte não vazou (aqui: `grep -c 'private\.'` = 0).

## Segue aberto

- **Se o `ListarPedidos` devolve `det.ide.codigo_item` — a medir na primeira run.** Ler
  `metadata->>'itens_com_codigo_item'` e `itens_lidos` do `sync_reprocess_log` (`entity_type='orders'`).
  Zero com denominador > 0 ⇒ o campo não vem, e a entrega fica inerte por desenho (nada quebra, e
  os 14 pedidos seguem congelados). ⚠️ **Falso-negativo a vigiar:** bundle novo + migration
  `20260906180000` **não aplicada** produz exatamente a mesma leitura (a RPC antiga ignora o campo
  no item) — confira a migration antes de concluir qualquer coisa sobre o Omie.
- **`criar_pedidos_com_itens` (o outro writer de `order_items`) não grava identidade** — o pedido
  que nasce pelo app não conhece o `codigo_item` do Omie no instante do INSERT. As linhas nascem
  com `NULL` e adotam na primeira reconciliação. Fail-closed, sem correção pendente.
- **Item de KIT pode não trazer o código** (a doc do Omie marca `codigo_item_integracao` como
  "vazio se o produto for componente de um kit"). Payload parcialmente identificado cai no caminho
  legado inteiro, por desenho — misturar duas chaves de casamento no mesmo pedido reabriria a
  classe de defeito que esta entrega fecha. Se aparecer volume disso, é fatia própria.
- **O CAS segue usando o instante da LEITURA pela edge, não a revisão da ORIGEM** — herdado do
  #2134 e intocado aqui.

---

# O outro writer: o pedido passa a NASCER com identidade (2026-09-08)

Continuação direta. Os dois primeiros itens de "Segue aberto" fecharam — um por **medição**, outro
por **entrega**.

## O sensor respondeu sozinho, em 24 h

A pendência nº 1 não era um recado: era uma **query com denominador e com o falso-negativo
nomeado**. Bastou lê-la (`psql-ro`, 2026-09-08):

| janela | runs | `itens_lidos` | `itens_com_codigo_item` | `ambiguos` |
|---|---|---|---|---|
| 30 d **antes** de 07/09 20:00 | 378 | — | — | **684** |
| **depois** | 12 | **4.220** | **4.220 (100 %)** | **0** |

O `ListarPedidos` **devolve** `det.ide.codigo_item`. O falso-negativo que o doc mandava conferir
antes de concluir qualquer coisa (migration não aplicada) foi descartado no mesmo Run: o
`pg_get_functiondef` da PROD traz `v_ident`, `v_atual_id_dup` e `v_sku_repetido`.

E o guard já não é mais alcançável na prática: pedidos com SKU repetido reconciliaram no mesmo dia
com identidade completa nas linhas (12179930461 → 5/5, 12179183059 → 7/7), e **442 de 444** pedidos
reconciliados desde então têm identidade em todas as linhas.

> **A generalização:** pendência que nasce com a **query que a resolve** fecha por leitura.
> Pendência que nasce como recado espera alguém lembrar — e o custo de lembrar cresce com o tempo,
> exatamente quando o contexto que a tornaria barata já evaporou.

## O que faltava: 1,4 % de cobertura, porque só um dos dois writers escrevia

`criar_pedidos_com_itens` — a porta de entrada de **todo** pedido Omie — não gravava
`omie_codigo_item`. Só a reconciliação adotava, e só dentro da janela (7 d / 30 d). Medido:
**1.024 de 70.956 linhas (1,4 %)** com identidade.

O que a cobertura baixa custa é preciso: enquanto a coluna é NULL, um pedido com SKU repetido só
escapa do guard de ambiguidade se o **payload** trouxer identidade completa. Isso é um contrato de
API de terceiro. Enquanto ele vale, o guard é inalcançável; no dia em que não valer, **1.067
pedidos** (3,4 % de 31.249 — 494 oben, 573 colacor) voltam a ser puláveis, e pular é *silencioso*:
o pedido inteiro fica na revisão velha, sem erro em lugar nenhum.

A entrega faz o pedido **nascer** com identidade, com o guard `G-a` (identidade repetida no payload
→ `NULL` em todas as linhas do pedido). Régua por **pedido**, não por linha — a mesma do `v_ident`.
Gravar identidade repetida seria pior que não gravar: criaria a condição `G-b` da reconciliação,
que congela o pedido **para sempre**. Ausente é reversível; ambíguo gravado não é.

O acervo permite o guard nascer limpo: **0** pedidos com `omie_codigo_item` duplicado hoje.

**Colacor é o caso que a média esconde:** `orders` reprocessou **1 vez, em 2026-02-28**;
**0 de 19.706** pedidos com `omie_reconciliado_em`. Para essa conta a reconciliação nunca foi um
caminho de adoção — esta RPC é o **único** que existe.

## A LIÇÃO NOVA: a sabotagem que quebra a ARIDADE do SQL mede outra coisa

`F7` desligava o `G-a` trocando `count(cid) = count(DISTINCT cid)` por `true`. O predicado saiu — e
com ele a **agregação**: o CTE passou a devolver uma linha por item, a subquery escalar estourou, e
o pedido morria por **erro de SQL** antes de chegar ao INSERT. O harness ficou vermelho, que é o
que a falsificação pede.

**Vermelho pelo motivo errado é indistinguível de vermelho pelo motivo certo** — e "aprova" um
assert que talvez não tenha dente nenhum. Foi o sintoma (`<sem linhas>`, em vez de `777,777`) que
denunciou: o pedido não existia, quando deveria existir *com* a identidade ambígua gravada.

A sabotagem fiel preserva a **forma** e remove só a **decisão**: `count(cid) = count(cid)`. Mesma
aridade, mesma agregação, guard sempre verdadeiro. Idem no `F9`: tirar a coluna da lista do INSERT
deixava 10 expressões para 9 alvos (erro de SQL); a sabotagem certa é a **expressão** virar
`NULL::bigint` — o corpo compila, o INSERT roda, e a coluna fica NULL para sempre, que é
exatamente o estado pré-migration.

## A LIÇÃO NOVA 2: o ÚLTIMO caso de uma suíte nunca prova a própria restauração

`F6` dropava o índice único e chamava `restaura`, com o comentário `# recria o índice`. **Era
falso** — `restaura()` re-aplica a *migration*, e o índice é pré-requisito da ZONA 1, de outra
migration. O banco terminava o script sem índice.

Isso viveu escondido porque o `F6` era o **último** caso. Ao acrescentar `F7`–`F9` depois dele, os
três nasceram falhando com `42P10` — e o sintoma (`<sem linhas>`) era **idêntico** ao de uma
sabotagem que funciona. Custou duas rodadas de diagnóstico para separar as duas causas.

> **A generalização:** um `restaura()` só é provado pelo caso que vem **depois** dele. O último de
> uma suíte de falsificação restaura contra ninguém — e um comentário afirmando o contrário é pior
> que nenhum, porque desliga a suspeita. Ou o `restaura` **asserta** o que restaurou (foi o que
> ficou: `F6r`), ou a suíte precisa de um caso-sentinela no fim.

## O que NÃO foi feito, de propósito

- **Sem backfill** das ~70 mil linhas históricas — o único leitor de `omie_codigo_item` é a própria
  reconciliação, no instante em que o payload a fornece (o argumento original desta linhagem, e ele
  não mudou).
- **Sem `UNIQUE (sales_order_id, omie_codigo_item)`.** O acervo está limpo hoje, mas um UNIQUE
  derrubaria o INSERT do pedido inteiro num dado sujo do Omie. O `G-a` degrada para `NULL`, que é
  reversível — a mesma escolha de "precisão > recall" feita em toda esta linhagem.
- **Nada foi afrouxado na invariante do agregado.** As CONSTRAINT TRIGGERs comparam
  (produto, quantidade, preço, desconto); `omie_codigo_item` não entra nesse eixo, então gravá-la
  não move o multiset. O guard de ambiguidade segue exatamente como está — o que muda é a
  **entrada** nele.

## Segue aberto (revisado)

- ~~Se o `ListarPedidos` devolve `det.ide.codigo_item`~~ — **medido: sim, 4.220/4.220.**
- ~~`criar_pedidos_com_itens` não grava identidade~~ — **fechado por esta entrega.**
- **`ambiguos > 0` continua sendo só `console.warn`** e a run fecha `complete`. O indicador
  *antecedente* é `itens_lidos > 0 AND itens_com_codigo_item = 0` (o campo parou de vir), que
  acende **antes** de a ambiguidade voltar. Não há alarme sobre esse par — fatia própria.
- **`sync-reprocess` de `orders` não roda para colacor** (1 run em 2026-02-28). Edição no Omie de
  pedido colacor não chega ao app. É o dano maior desta vizinhança e não é escopo desta entrega.
- **Item de KIT** e **o CAS pela leitura, não pela origem** — herdados, intocados.
