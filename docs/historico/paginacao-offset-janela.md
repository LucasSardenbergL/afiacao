# Paginação por offset sob mutação: o risco não segue o volume de escrita

Medição de 2026-08-21 (psql-ro, prod `fzvklzpomgnyikkfkzai`), levantada pela 2ª rodada do
challenge Codex no #1836 e registrada FORA DE ESCOPO daquele PR — que tratou truncagem
silenciosa (dano PERMANENTE) e não inconsistência sob mutação (dano de JANELA).

## A regra (o que a medição comprou)

**O que desloca uma paginação por offset não é o VOLUME de escrita da tabela — é a escrita
que atravessa a FRONTEIRA DO RECORTE.**

- `INSERT` e `DELETE` **sempre** atravessam: mudam a cardinalidade antes do offset corrente.
- `UPDATE` só atravessa se tocar a coluna do `.order()` **ou** uma coluna do `WHERE`.
  Um update de preço/estoque numa leitura `ORDER BY id` deixa a linha exatamente onde estava.

Corolário que inverte a intuição: **ranquear as tabelas por `n_tup_upd` inverte o ranking de
risco.** Medido:

| tabela | ins | del | upd | pagina? | atravessa a fronteira? |
|---|---:|---:|---:|---|---|
| `product_costs` | 1.174 | **0** | **8.032.695** | sim (3.679) | **não** — `order by id`, filtro imutável |
| `fin_contas_receber` | 1.755 | **0** | 7.177.342 | sim (44.092) | **não** |
| `inventory_position` | 778 | **0** | 6.210.727 | sim (3.134) | **não** |
| `omie_products` | **86** | **0** | 5.324.219 | sim (3.143 ativos) | **SIM** — filtro `.eq('ativo',true)` |
| `order_items` | 67.061 | **1.406** | 88.612 | sim (8 clientes, máx 2.849) | **SIM** — DELETE hard |
| `sales_orders` | 29.057 | 536 | 30.848 | sim (30.979) | parcial — DELETE hard |
| `profiles` | 423 | 0 | 2 | sim (5.668) | não (e já usa keyset onde é money-path) |

As três tabelas mais quentes do banco (8,0M / 7,2M / 6,2M updates) são **seguras**.
A mais fria em escrita real — `omie_products`, com 86 inserts e zero deletes — é a **mais
exposta**, porque quem a reescreve (`omie-sync-status-produtos`, cron diário 03:30 UTC)
mexe exatamente no `ativo` que o `WHERE` do leitor usa: um SKU que flipa `true→false`
entre duas páginas desloca todas as seguintes e um SKU ativo é **pulado**. É o dano do
#1836 (catálogo parcial) pela via da janela em vez da truncagem.

## Os dois mecanismos completos (e por que só estes)

**1. `order_items` no `recommend`** — `.eq('customer_user_id',…).order('id').range(…)`.
`sync-reprocess` faz reconcile diff-based com `.delete().in('id', diff.deletar)`
(`supabase/functions/sync-reprocess/index.ts:339`) e roda `15 */2 * * *` — **inclusive
12:15, 14:15 e 16:15 BRT, em pleno horário comercial**, enquanto o vendedor usa o app
(`recommend` é on-demand via `useRecommendationEngine.ts`, sem cron).
A PK é **uuid v4** (100% das 70.225 linhas): um INSERT cai em posição *aleatória* na
ordenação, então ~50% dos inserts caem **antes** do cursor e deslocam. Com id sequencial
nenhum insert deslocaria — a aleatoriedade do v4 é parte do mecanismo.
Dano: altera `purchaseCounts[product_id]`, que atravessa o corte `purchaseCount >= 2` em
`recommend/index.ts` e muda `ctx_score` (peso `w_ctx` 0.20 no score final).

**2. `omie_products` no `recommend`** — `.eq('ativo',true).order('id').range(…)`, 3.143
ativos ⇒ 4 páginas. Janela de escrita: cron 03:30 UTC = **00:30 BRT, madrugada** — não
cruza o horário de uso. Mecanismo presente, sobreposição baixa.

## O que a medição NÃO sustenta

- **`created_at` de `order_items` não é instante de escrita.** 69.618 de 70.225 linhas
  (99,1%) têm `created_at` = `12:00:00` exato — é data de pedido normalizada. Uma primeira
  medição de "0,051% do tempo com escrita ativa" saiu daí e foi **descartada**: era artefato.
  Só 106 horários distintos em 70k linhas.
- **`pg_stat_user_tables` não tem denominador aqui**: `stats_reset` é `NULL` no Supabase
  (não exposto/nunca resetado), então `n_tup_ins` é acumulado de janela **desconhecida** —
  serve para comparar tabelas entre si, não para derivar taxa por segundo.
- **`cron.job_run_details` mede o ENQUEUE**, não a edge: as três runs dão 0,1s porque é o
  `net.http_post` enfileirando. A duração real veio de `acoes_execucoes`
  (`analytics_sync.sync_completo` 30,9s média / 37,3s máx; `reposicao.sincronizar_recalcular`
  48,7s / 72,8s máx). `net._http_response` não serviu: retém ~6h e já perdeu a URL (drenada
  da queue).
- **`n_live_tup` mente**: dava 392 para `profiles`, que tem **5.668** linhas reais.

## Ordenação por coluna não-única: latente, não ativo

O gate `_shared/paginacao-delegada_test.ts` exige a **presença** de `.order(`, não a
**unicidade** da coluna — `.order('status')` passaria. Auditadas as 6 ordenações por coluna
não-única/mutável, nenhuma tem dano ativo hoje:

- `algorithm-a-audit:239` — **já corrigido** (#1589) com ordem composta `unit_price desc, id asc`.
- `omie-sync-status-produtos:175` (`fornecedor_nome`) — **7 linhas**, nunca pagina.
- `gerar-pedidos-diario:350` (`status`,`fornecedor_nome`) — **18 linhas** no pior ciclo, e sem `.range()`.
- `analyze-unified-order:390` (`descricao`) — `.limit(1000)`, amostra deliberada.

Latente: se qualquer uma crescer além de 1.000 o defeito acorda, e é **determinístico**
(não depende de mutação — basta o plano mudar), portanto pior que o da janela.

## Veredito

Corrigir por keyset **as duas leituras money-path do `recommend`** (mecanismo completo,
`.order('id')` já presente ⇒ a coluna-chave não precisa ser inventada) e **documentar** as
demais: não é migrar os 21 call-sites de `fetchAll`, é o recorte que a medição sustenta.
Precedente do repo, que esta medição confirma em vez de contrariar: `fin-valor-cockpit:490`
já decidiu "display ℹ️ baixo: offset `.range` basta — o syncPedidos, money-path, é que exige
keyset".

## Adendo: o acoplamento `PAGE` ↔ `max-rows` (outra classe, PR próprio)

Do mesmo parecer: `fetchAll` (e agora `fetchAllKeyset`) tratam página curta como EOF. Com
`PAGE = 1000` e o `max-rows` do PostgREST em prod **também** 1.000, o laço pede exatamente
o cap e segue correto — medido: 3.140 linhas de `omie_products` devolvendo 1.000. Mas se
alguém baixasse o `max-rows` para 500, toda leitura pararia na primeira página e devolveria
o parcial **em silêncio** — a truncagem do #1836 de volta, por outra porta. Nada vigia isso.

Fica FORA deste PR de propósito: é truncagem por cap, não deslocamento por mutação, e
misturar duas classes num PR money-path é o que faz metade de um fix se perder. As duas
saídas, na ordem em que valem a pena:

1. **`PAGE` menor que o cap** (ex.: 900). Qualquer `max-rows` ≥ 900 passa a devolver página
   cheia e o EOF volta a ser inequívoco. Custa ~11% mais requests e **zero** trabalho no
   banco. Não exige mudar nenhuma assinatura.
2. **`count:'exact'` na primeira página** como testemunha independente, comparando o total
   com o lido no fim. É a checagem mais forte — e a mais cara: um COUNT completo por
   leitura, em cima de `fin_contas_receber` (44.092 linhas) toda vez. `RespostaPostgrest`
   já carrega `count`, mas o `build` de hoje não tem por onde pedi-lo: exigiria mexer na
   assinatura dos 21 call-sites, que é exatamente o que a medição desaconselhou.

**ERRATA (2026-08-22, ao implementar): a saída (1) estava errada.** `PAGE = 900` protege só
contra caps entre 900 e 999 — com `max-rows` em 500, `500 < 900` continua sendo lido como EOF e
a leitura trunca igual. E paga +11% de requisições em TODA leitura, não uma por laço.

O que foi feito é uma terceira saída, que nenhuma das duas anteriores enxergava: **EOF por
página VAZIA + avanço pelo número REAL de linhas devolvidas** (`from += rows.length`, não
`from += PAGE`). As duas metades são necessárias — só trocar o critério de parada ainda pularia
linhas, porque o offset avançaria 1.000 sobre um servidor que devolveu 500.

Isso vale para QUALQUER cap, sem `count:'exact'` e sem mexer nos 21 call-sites. Custo: uma
requisição a mais por leitura, a que volta vazia. O fim da tabela deixa de ser uma inferência a
partir de um número que o servidor escolhe, e passa a ser um fato observado.

## ⚠️ REVISÃO INDEPENDENTE PENDENTE

O ritual `/codex` desta entrega **não rodou**: a cota do ChatGPT Plus (janela rolante de 7
dias) esgotou em 2026-08-21 — `codex-async.sh` saiu com `COTA_ESGOTADA` (exit 75) antes de
gastar tempo. Seguido o **Caminho B** de `docs/agent/money-path.md`: validação adversária
própria, registrada aqui. **Auto-revisão não substitui revisão independente** — ela cobre o
intervalo. Rodar o Codex retroativo quando a cota voltar; o prompt do challenge está em
`/tmp/codex-prompt.txt` (efêmero) e é reconstituível a partir deste doc.

O auto-challenge achou **dois defeitos no próprio `fetchAllKeyset`**, ambos resolvendo em
SILÊNCIO — a classe que esta entrega existe para combater:

1. **Ordem `DESC` do call-site.** O helper só recebe `build`, então não enxerga o `.order()`.
   Com `.order(id,{ascending:false})` + `.gt(cursor)` o cursor recua: 1.999 linhas devolvidas,
   ~999 duplicadas e **1.300 nunca lidas**. A guarda de "cursor parado" não pegava — sob DESC
   a 2ª página já volta curta e o laço encerra pelo `length < PAGE` antes da comparação.
2. **Coluna-chave fora do `.select()`.** O `.select()` é uma string e a interface da linha
   PROMETE o campo: tirar `id` do select **passa no typecheck** e só quebra em runtime, com
   cursor `undefined`.

E um terceiro, de escopo: a guarda de ordem comparava só os extremos da página — a página com
o miolo embaralhado (o que `.limit()` sem `.order()` produz) passava. Todas as três viraram
uma varredura da PÁGINA INTEIRA, que custa uma comparação por linha contra uma ida à rede.

Falsificado 4× (cada guarda sabotada exigiu vermelho, e o vermelho veio): cursor pela primeira
linha da página · guarda de cursor removida · guarda de ordem removida · guarda de
ordem/unicidade removida.

## Tentativa retroativa (2026-08-22): cota AINDA esgotada — e a pergunta em aberto fechada por MEDIÇÃO

Segunda tentativa do ritual: `codex-async.sh -m gpt-5.6-terra -r xhigh -t 1200` saiu de novo
com `COTA_ESGOTADA` (**exit 75**) — a janela rolante de 7 dias não virou. **O marcador acima
continua de pé: nenhuma revisão independente rodou nesta entrega.**

⚠️ **O prompt guardado está DEFASADO — não reenviar como está.** Escrito em 2026-08-21, ANTES
do #1889: ele cita `if (rows.length < PAGE) break`, que o #1889 trocou por `rows.length === 0`.
A pergunta (3) dele ("página curta como EOF trunca se o max-rows cair para 500 — errei em não
baixar PAGE para 900?") pergunta por um defeito que o #1889 **já consertou**. Reenviar queima
cota numa pergunta morta e continua sem revisar #1877/#1882/#1889, que o prompt nem menciona.
Regenerar contra o código VIVO antes de rodar.

⚠️ **Armadilha de evidência — variante nova da 7ª (`| tail` engole o exit code).** O wrapper
rodou em background e o harness reportou **"exit code 0"**: esse era o exit do ÚLTIMO comando
do compound (`wc -c`), não o do `codex-async.sh`. O `echo "CODEX_EXIT=$?"` colado logo após o
comando foi o que revelou o **75**. Sem ele, "exit 0" + arquivo de parecer criado leria como
sucesso — e o arquivo tinha **0 bytes**. **Regra: o compound termina no comando que você quer
medir, ou o `$?` vai colado nele. Arquivo de saída CRIADO não é arquivo de saída ESCRITO.**

### A pergunta em aberto: CONFIRMADA — mas o vetor não era o que se supunha

Ficou em aberto se inicializar `anterior = null` (em vez de `anterior = cursor`) na varredura
de página era buraco real, já que a primeira linha de cada página não é comparada ao cursor da
anterior. A defesa registrada era *"a checagem de cursor no fim do laço já cobre isso, só que
uma página depois"*. Medido em vez de argumentado — a defesa está **meio certa**, e a metade
errada é a que importa:

| vetor | a checagem de cursor pega? | desfecho antes do fix |
|---|---|---|
| **sistemático** (`.gte` no lugar de `.gt`) | sim, mas só na página **TERMINAL** | lança — tabela inteira lida, 1 duplicata por página no acumulado |
| **pontual** (retry com cursor velho, lag de réplica, ramo do call-site que tira o cursor de outra coluna) | **NUNCA** | **resolve em silêncio**: 2.310 linhas, 10 duplicadas |

O motivo de a guarda não alcançar o caso pontual: ela compara só a **última** linha da página.
Uma página que recomeça atrás do cursor e termina à frente dele passa pelas duas guardas — está
ascendente por dentro (varredura interna passa) e avançou por fora (checagem de cursor passa).
É exatamente a duplicata silenciosa que este helper inteiro existe para tornar impossível.

**Fix:** `anterior` começa em `cursor`. Na 1ª página `cursor` é `null` ⇒ comportamento
idêntico; nas demais exige `k > cursor`, que é literalmente o contrato do keyset — call-site
correto não tem como tropeçar, então não há falso-positivo a pagar. Código **próprio**
(`KEYSET_PAGINA_SOBREPOSTA`), não reuso de `CHAVE_REPETIDA`: com `.gte`, `k === cursor` é linha
repetida ENTRE PÁGINAS, não chave não-única — o conserto é o operador do filtro, não a escolha
da coluna, e mandar trocar uma chave que já é única é diagnóstico que parece diagnóstico e não é.

**Latente, não vivo:** os 2 call-sites (`order_items`, `omie_products`) usam `.gt("id", cursor)`
corretamente, conferido. Isto fecha a classe antes do 3º call-site, não conserta leitura torta
em produção.

**LIÇÃO GERAL — guarda de fronteira que só olha um extremo do lote não cobre o outro.** A
varredura interna e a checagem de cursor pareciam redundantes e não são: uma vigia o MIOLO da
página, a outra vigia o SALTO entre páginas, e a primeira linha de cada página caía no vão
entre as duas. O sintoma diagnóstico é a assimetria — se a guarda de saída compara a última
linha, a guarda de entrada tem de comparar a primeira, contra o estado que sobreviveu à volta
anterior. Corolário do que já estava nesta página: **violação sistemática é a fácil; a que
escapa é a pontual, porque ela se conserta sozinha na página seguinte e some do rastro.**

Gate: RED verificado antes do fix (`esperava lançar KEYSET_PAGINA_SOBREPOSTA, mas resolveu`) ·
848 testes de edge, 0 falhas · **3 falsificações com dente**: reverter `anterior = cursor` (os
2 vetores voltam, cada um com o seu vermelho) · `atravessaPagina` fixo em `false` (ambos
vermelhos por **código errado**, provando que o teste casa a classificação e não "lançou algo")
· tirar `KEYSET_PAGINA_SOBREPOSTA` da allowlist (`veio desconhecido`, provando que a entrada é
carga e não enfeite).
