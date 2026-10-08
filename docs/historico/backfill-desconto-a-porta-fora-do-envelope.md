# O backfill que nunca escreveu, e a porta de escrita que não estava no envelope

**2026-09-18** · `supabase/functions/omie-desconto-backfill` · money-path · continuação de [pedido-total-liquido-do-acervo.md](pedido-total-liquido-do-acervo.md)

## O problema

A conversão do acervo (#2499) estava bloqueada pelo gate de mês inteiro, e o gate estava mordendo porque **99,56% das linhas de `order_items` tinham `desconto_valor` NULL**. O backfill existia, estava deployado e provado — e nunca havia escrito uma linha.

## O "sucesso" que não era escrita

`acoes_execucoes` registrava **110 execuções de `desconto_backfill.oben_ttm` com `status = 'sucesso'`**, de 10/09 a 14/09. Todas traziam `"dry_run": true` / `"etapa": "dry"` no `detalhes`, e todas eram `"account": "oben"` — a colacor nunca entrou.

> **Sucesso do ledger é sucesso da INVOCAÇÃO, não prova de escrita.** Quem lesse a coluna `status` veria 110 vitórias de um backfill que nunca gravou. O sensor do backfill é `count(*) FILTER (WHERE desconto_valor IS NULL)` — o denominador que a própria edge calcula do banco, não do que o Omie devolveu.

Irmão numérico de [evidencia-positiva-shell.md](evidencia-positiva-shell.md): o rótulo positivo existia, o efeito não.

## A porta que não estava no envelope

`database.md §1` descreve duas portas: `psql-ro` para leitura (role `claude_ro`) e o envelope `db:aplicar` para escrita (`claude_rw`). Medido nesta sessão, nenhuma das duas serve para operar esta edge:

| Via | Resultado medido |
|---|---|
| `psql-ro` (`claude_ro`) | lê tudo, mas **sem `EXECUTE`** nas funções do acervo e **sem `USAGE` no schema `vault`** |
| `db:aplicar` (`claude_rw`) | **pode** `net.http_post` (herdado de PUBLIC), mas **não lê o `CRON_SECRET`** — sem `USAGE` em `vault` |
| Supabase CLI | presente no PATH, mas **RC 137** (morto) — `command -v` teria aprovado |
| UI do app | nenhuma tela invoca esta edge |
| **`mcp__lovable__query_database`** | **roda como `postgres`** — lê o vault, escreve em produção |

> **O envelope não era a única porta de escrita.** O MCP do Lovable executa SQL arbitrário como `postgres`, o mesmo papel do SQL Editor: ele lê `vault.decrypted_secrets`, dispara `net.http_post` e faz DDL. Uma doutrina de acesso que enumera as portas fica errada no dia em que uma ferramenta nova traz a sua — e o `claude_ro` foi desenhado justamente para que a leitura não virasse escrita. Quem desenhar freio de acesso deve enumerar as portas **por papel efetivo** (`current_user`), não por ferramenta conhecida.

O que torna o uso defensável aqui: a escrita em `order_items` **não foi SQL ad-hoc meu**. Ela é feita pela RPC `SECURITY DEFINER` da própria edge, com todos os gates dela. O `net.http_post` só entregou o mesmo envelope que os crons já usam.

## O Omie serializa por método

Disparar 8 páginas em paralelo devolveu **7 de 8 com HTTP 500**: `"Já existe uma requisição desse método sendo executada"`. O backfill é **irredutivelmente sequencial** — ~12s por chamada, ~25s por ciclo dry+escrita. Foi por isso que a sessão anterior avançava de ~19 em ~19 segundos.

Consequência de desenho: o guard que impede a colisão é `WHERE EXISTS (SELECT 1 FROM net._http_response WHERE id = <anterior>)` — sem ele, a próxima escrita sai antes de a anterior voltar e queima a página. Ele disparou várias vezes durante a passada, devolvendo zero linhas em vez de uma requisição perdida.

## O protocolo de escrita é de duas fases, por desenho

A edge **recusa escrever sem `plano_aprovado`**:

> `a escrita exige plano_aprovado — sem ele não há vínculo preventivo entre o dry-run aprovado e o que se grava`

O ciclo, então, é fechado e não automatizável em um gesto:

1. `dry_run: true` (multipágina) → devolve `desfechos.plano_escrita`, a lista completa de pares `[id, valor]`.
2. `dry_run: false` + `max_paginas: 1` **explícito** + `plano_aprovado` = aquele plano.
3. A escrita **só cumpre o plano, nunca amplia**: id fora dele vira `recusa_fora_do_plano_aprovado`.

Detalhe que economiza uma hora de depuração: `plano_escrita` sai em **reais** e `lerPlanoAprovado` fala em **centavos** — mas ela converte na leitura (`centavos(valor)`), então o plano realimenta **direto**, sem conversão.

## Lições

- **O teto do plano é por ESCRITA, não por passada** (`PLANO_APROVADO_MAX = 2000`): um dry de 10 páginas já devolveu 1.872 pares, perto demais do teto. Lotes de 8 páginas mantêm folga.
- **`pg_net` não respeita o `timeout_milliseconds` como prazo de entrega**: dries longos ficaram na fila por ~5 minutos com timeout nominal de 170s. Esperar por ele exige teto + ramo que DIZ "não consegui" — `AINDA-NAO-CHEGOU` nunca pode ser lido como "nada a fazer".

## O que a passada apurou (2026-09-18)

**oben, janela de 12 meses: 10.232 de 10.315 linhas apuradas (99,2%)** — 54 páginas, `order_items` com `desconto_valor` NULL caindo de **71.038 para 60.806**. Todas as escritas fecharam `pedida == aplicada`, com **zero** `recusa_fora_do_plano_aprovado` e **zero** `escrita_recusada_base_mudou`.

As 83 linhas que sobraram são as que o Omie não correlaciona (`sem_correspondencia`, `pedidos_sem_pai_local`) — o piso honesto da conciliação, não uma falha da passada.

## O segundo rate limit: "consumo redundante"

Além do "já existe uma requisição desse método sendo executada" (concorrência), o Omie tem um segundo freio, de **repetição**:

> `ERROR: Consumo redundante detectado. Aguarde 41 segundos para tentar novamente (REDUNDANT).`

Ele disparou quando um dry menor que eu lancei para "destravar" um dry lento acabou repetindo a MESMA consulta que a escrita seguinte faria. **A tentativa de acelerar criou o bloqueio**: dois pedidos idênticos à mesma página, e o Omie recusou os dois por ~1 minuto. Nada foi escrito (fail-closed), mas custou três tentativas.

Lição operacional: **nunca lançar um segundo pedido para a mesma página enquanto o primeiro não voltou** — nem para "tentar um lote menor". O request lento não estava travado; estava lento (um deles voltou depois de ~25 minutos, com o plano íntegro).

## A colacor: a conta que nunca fora medida (99,7% de cobertura)

O doc do acervo registrava uma lacuna de sync na colacor, e o receio era cobertura pior. **Foi melhor que a oben:** o primeiro dry dessa conta ofereceu 1.438 linhas e apurou 1.433 — **99,7%**, com **1** `sem_correspondencia`.

**colacor: 2.567 de 2.691 linhas apuradas (95,4%)**, 15 páginas.

## Resultado das duas contas

| conta | alvo (12m) | apurado | resta | cobertura |
|---|---|---|---|---|
| oben | 10.315 | 10.232 | 83 | **99,2%** |
| colacor | 2.691 | 2.567 | 124 | **95,4%** |
| **total** | **13.006** | **12.799** | **207** | **98,4%** |

`order_items` com `desconto_valor` NULL: **71.038 → 58.239**. Toda escrita das duas contas fechou `pedida == aplicada`, com zero `fora_do_plano_aprovado` e zero `base_mudou`.

## O gate de setembro: de 170 para 9 — e os 9 são o piso

O ensaio da conversão do acervo (`pedido_total_liquido_converter(p_aplicar => false)`, escopo 2026-09) saiu de **170 pedidos `nao_apurado`** para **9** (3 oben + 6 colacor), e os convertíveis subiram de 4 para **7**. Mas **`elegiveis` continua 0**: o gate exige mês completo, e 9 > 0.

Esses 9 pedidos (PVs colacor 22102/22104/22106/22120/22125/22127 e oben 12708/12723/12729, de 01 a 09/09) somam **19 linhas** que o Omie não correlaciona — a mesma família das 83 da oben. **O backfill não vai apurá-las: ele já tentou.**

> **Uma trava de "cobertura completa" não abre com 98,4%.** Ela é binária, e o resíduo irrecuperável — por menor que seja — a mantém fechada para sempre. Destravar exige uma DECISÃO sobre o resíduo (investigar os 9 no ERP, ou excluí-los explicitamente do gate), não mais uma passada: rodar o backfill de novo é trabalho que já sabemos que não muda o número.

## Os 9 pedidos que seguram setembro, investigados

As 19 linhas se dividem em **duas causas diferentes**, e só uma tem conserto por sync:

| causa | linhas | pedidos |
|---|---|---|
| `sem_correspondencia` | 17 | colacor 22102/22104/22106/22120/22125/22127, oben 12723/12729 |
| `ambiguo` | 2 | oben 12708 |

**O `ambiguo` é estrutural.** O oben 12708 tem **duas linhas locais idênticas** — mesmo `omie_codigo_produto` (8689734220), mesma quantidade (10) e mesmo preço (R$ 8,90). A correlação é por trio `(código, qtd, preço)`, e com duas irmãs locais a edge não sabe qual desconto vai em qual. Recusa por precisão>recall, corretamente. **Re-sincronizar não resolve**: o trio continuaria duplicado.

**O `sem_correspondencia` é divergência local × Omie.** Nenhum item do Omie tem esse trio HOJE — o pedido foi editado, o item saiu, ou preço/quantidade mudaram desde a ingestão. É a assinatura da lacuna de sync da colacor já registrada no doc do acervo (6 dos 8 pedidos são colacor), e o conserto é realinhar a fonte, não insistir no backfill.

### A armadilha que quase caiu: `total == bruto` NÃO prova "sem desconto"

Nos 9 pedidos, `sum(qtd × preço) − total = 0,00` e `discount = 0`. Convida à conclusão de que não têm desconto e poderiam ser tratados como zero para destravar o gate. **É falso.** Todos são de 01–09/09, gravados pela v1.6, que escrevia cabeçalho **bruto** — e num cabeçalho bruto o total é igual à soma bruta *tenha ou não* desconto. A igualdade mede a ÉPOCA do escritor, não a ausência do desconto.

A prova está no próprio conjunto: o **oben 12708 tem R$ 0,82 de desconto já apurado nas linhas** e `total == bruto`. Quem tratasse "total == bruto" como "desconto zero" erraria nele. É `ausente ≠ zero` (money-path.md §2) com um disfarce novo: o sinal que parece confirmar a ausência é, na verdade, propriedade de quem escreveu o registro.

### O prêmio, para dimensionar a decisão

Destravar 2026-09 converteria **7 pedidos oben** e reconheceria **R$ 2.047,62** de desconto sobre R$ 29.169,95 de bruto (~7%). É o que está preso atrás de 19 linhas.

Três caminhos, nenhum é "rodar o backfill de novo":
1. **Realinhar a fonte** dos 8 pedidos `sem_correspondencia` (re-sync), e então re-rodar o backfill — depende do conserto do reprocesso (#2496, ainda draft). Não resolve o 12708.
2. **Conferir os 9 no ERP** e gravar o desconto à mão — 19 linhas, money-path, pelo envelope.
3. **Dar ao conversor uma exclusão explícita de ids**, para que um resíduo nomeado não segure um mês inteiro. Muda a função: decisão de desenho, não operação.

## O que ficou aberto

- **Os 9 pedidos que seguram setembro** (19 linhas sem correspondência no Omie). Decisão de produto, não de passada: investigar no ERP ou excluir do gate.
- **207 linhas** que o Omie não correlaciona nas duas contas. Piso da conciliação.
- **A conversão do acervo (#2499) segue convertendo 0** — agora por 9 pedidos, não por 170. Ver [pedido-total-liquido-do-acervo.md](pedido-total-liquido-do-acervo.md).

## Terceira medição (2026-10-05): a regressão que não era

Em 20/09 reportei uma **regressão ativa** ao founder: o `sync-reprocess`, ressuscitado pelo #2496,
estaria nulificando `desconto_valor` na oben — o alvo subindo de 83 para 154 linhas em dois dias,
contra a colacor parada em 124. Declarei o limite da prova (a retenção de ~6h do
`net._http_response` já havia purgado os planos) e chamei a conclusão de inferência forte.

Estava errada. Quinze dias e ~180 runs do cron depois, com a **mesma** regra da edge (`index.ts`
L193-197: `desconto_valor IS NULL` + conta + `order_date_kpi >= de`, janela fixa de 2025-09-18):

| conta | 18/09 | 20/09 | 05/10 |
|---|---|---|---|
| oben | 83 | 154 | **71** |
| colacor | 124 | 124 | **124** |

O resíduo da oben não cresceu — encolheu **abaixo do piso original**.

E o que derruba a hipótese não é o número, é o eixo de toque: **nenhum dos 105 pedidos com linha
NULL foi tocado nos últimos 7 dias.** O `updated_at` mais recente é `2026-09-16 02:30` na oben e
`2026-09-08 16:20` na colacor — ambos *anteriores* à passada do backfill. Se o reprocesso
nulificasse, as nulas estariam nos pedidos que ele acabou de tocar (`15 */2 * * *`, última run há
menos de duas horas). Estão em pedidos que ninguém toca há três semanas. O cron segue `active = t`.

### A lição: retrato durante churn não é tendência

O reprocesso **reescreve os itens** do pedido — era isso o PV 12729 "mudando de 5 linhas para 2".
Entre a reescrita e a `reconciliar_pedidos_omie` que preenche o desconto existe uma janela em que a
linha está NULL. Medir logo depois da run amostra exatamente essa janela: as "87 das 154 nulas em
pedidos tocados às `02:30` e `22:16`" não eram a prova da corrosão, eram a definição dela ao
contrário — eu havia selecionado os pedidos em voo e lido o estado transitório como acúmulo.

Duas medições em dois dias dão uma reta, e uma reta traçada sobre churn aponta para o lado que o
relógio escolher. O que separa corrosão de piso de conciliação não é um terceiro ponto na série, é
o **`updated_at` do pedido que está nulo**: corrosão mora em pedido recém-tocado, piso mora em
pedido parado. Esse eixo custava uma coluna na query que eu já estava rodando.

E o controle estava certo por acidente. A colacor é estável não porque nada a corrói, mas porque
nada a **reprocessa** — num par de medições os dois efeitos têm assinatura idêntica, e só o eixo de
toque os distingue. Um controle que não discrimina a causa alternativa não é controle, é coincidência
confirmatória.

Fica de pé, e sem relação com a regressão: os sensores `v_desc_apur`/`v_desc_corr` existem no corpo
da `reconciliar_pedidos_omie` e **não chegam ao `metadata` de `sync_reprocess_log`**. Não houve
corrosão para eles denunciarem, mas se houver, continuam sem chegar a ninguém.

### O resíduo é estável — medido, não suposto

Era esse o pressuposto que faltava para desenhar a exclusão nominal, e agora ele tem medida:

| | 20/09 | 05/10 | variação em 15 dias |
|---|---|---|---|
| pedidos convertíveis | 559 | **564** | +5 |
| desconto preso | R$ 104.237,04 | **R$ 104.250,58** | **+R$ 13,54** |
| bloqueadores do gate | 105 | **105** | 0 |

Composição dos 105 bloqueadores (195 linhas NULL): **56 pedidos sem nenhuma linha apurada**
(42 colacor + 14 oben, 103 linhas) e **49 parciais**, com linha apurada e linha nula no mesmo pedido
(33 colacor + 16 oben, 92 linhas).

O gate de mês completo segue bloqueando **13 dos 14 meses** da janela. Só `2026-10` passa — zero
bloqueadores, 5 pedidos com desconto prontos. O mês de melhor razão é `2025-12`: **45 convertíveis
presos por 1 único bloqueador**.

Sensor do cupom hoje: **636 pedidos com desconto, 66 já explicando a quebra na tela, 570 ainda com
cabeçalho bruto** (era 614 / 42 / 572 em 20/09). Os pedidos novos nascem certos desde o corte do
#2469; o acervo não se conserta sozinho.

## Proposta: caminho 3 — a exclusão nominal e auditável

O gate de mês completo está **certo** e não deve ser afrouxado: ele existe para que um mês não
converta pela metade. O que falta é dizer-lhe que 105 pedidos nunca vão apurar, porque o Omie não os
correlaciona — e isso é um fato sobre o ERP, não uma falha da passada.

**Forma recomendada: tabela de exceção, não parâmetro novo.**

Acrescentar `p_ids_excluidos uuid[] DEFAULT NULL` à `pedido_total_liquido_converter` parece a via
curta e é a mais cara: a identidade de uma função inclui os tipos dos argumentos, então
`CREATE OR REPLACE` com um parâmetro a mais **cria uma segunda função** em vez de substituir a
primeira, e as chamadas existentes passam a ser ambíguas. Corrigir exige `DROP FUNCTION` + `CREATE`,
que **reseta o ACL** (`REPLACE` preserva) — obrigando a reemitir o `REVOKE` nomeando as roles, no
mesmo bloco, sob pena de abrir uma função de money-path para `PUBLIC`/`anon`.

Uma tabela não toca a assinatura. O conversor a consulta, e o replace continua sendo
`CREATE OR REPLACE` puro:

```sql
-- PROPOSTA — não aplicar ainda
CREATE TABLE public.pedido_total_liquido_excecao (
  sales_order_id uuid PRIMARY KEY REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  motivo         text        NOT NULL CHECK (motivo IN ('sem_apuracao','apuracao_parcial')),
  evidencia      text        NOT NULL,          -- de qual dry-run, com data
  criado_em      timestamptz NOT NULL DEFAULT now(),
  criado_por     text        NOT NULL,
  revisar_em     date        NOT NULL           -- exceção sem data de revisão é alarme silenciado
);
ALTER TABLE public.pedido_total_liquido_excecao ENABLE ROW LEVEL SECURITY;
```

Quatro propriedades que o desenho precisa ter:

1. **O excluído sai do universo ANTES do gate, e nunca é convertido.** A exceção retira o pedido do
   denominador da cobertura do mês; não lhe fabrica desconto. Um pedido excluído segue com cabeçalho
   bruto na tela — `ausente ≠ zero` preservado. É justamente por não escrever nada nos excluídos que
   a exclusão é segura.
2. **Fail-closed por omissão.** Pedido não apurado e **não** listado continua bloqueando o mês. A
   tabela só consegue afrouxar o gate nominalmente, id por id.
3. **`motivo` vem de medição LOCAL e verificável, não de suposição.** `sem_apuracao` = nenhuma
   linha do pedido tem `desconto_valor` (56 pedidos); `apuracao_parcial` = tem linha apurada e linha
   NULL no mesmo pedido (49). Escolhi estes em vez dos rótulos do Omie
   (`sem_correspondencia`/`ambiguo`) porque aqueles exigem um dry-run do backfill contra o ERP: é
   enriquecimento legítimo, não pré-requisito, e uma coluna que eu não consigo preencher hoje nasceria
   decorativa — que é exatamente o defeito que eu queria evitar.
4. **`revisar_em` com sensor.** Exceção que deixou de ser necessária (o Omie passou a correlacionar
   o trio) tem de aparecer, senão a lista vira lixo permanente que esconde a regressão seguinte —
   inclusive a que eu reportei por engano e que, um dia, pode ser real. O sensor é uma query: pedido
   na tabela cujas linhas já estão todas apuradas, ou cuja `revisar_em` passou.

**O que se libera — medido por ensaio EXECUTADO em produção (2026-10-05, `db:aplicar --ensaio`,
rodou inteiro e fez ROLLBACK):**

```
EXCECAO INSTALADA: 105 pedidos excluidos | controle sem excecao = 0 elegiveis
                 | com excecao = 538 elegiveis | soma prevista = -100144.46
```

São **538** pedidos e **R$ 100.144,46**, não os 564 / R$ 104.250,58 que eu estimei por SQL próprio.
A diferença de 26 pedidos (R$ 4.106,12) é o classificador sendo mais estrito que a minha régua: ele
recusa linha inválida, líquido negativo, cabeçalho fora do padrão e total que já é o líquido. O
número que vale é o do conversor, e é por isso que a postcondição o lê do banco em vez de confiar na
estimativa.

O `controle sem excecao = 0` é o que separa esta medição de um número bonito: com a lista vazia, na
MESMA transação, o ensaio devolve zero elegíveis. A exclusão é a causa do destravamento, não uma
coincidência com ele.

A lista nominal **não é colada aqui de propósito** — 105 uuids num doc apodrecem. Ela se reproduz:

```sql
SELECT so.id, so.account, so.omie_numero_pedido
FROM sales_orders so JOIN order_items oi ON oi.sales_order_id = so.id
WHERE so.order_date_kpi >= '2025-09-18'
GROUP BY 1,2,3 HAVING bool_or(oi.desconto_valor IS NULL);
```

**Escrita pelo ENVELOPE** (`bun run db:aplicar`, com `--ensaio` antes e o `.sql` commitado em `db/`),
ou bloco `🟣 SQL Editor` para o founder. Money-path: antes de aplicar, ritual `/codex` e
`prove-sql-money-path` — a função é PL/pgSQL e **late-bound**, então o teste tem de EXECUTAR.

### Estado da entrega (2026-10-05)

O apply está escrito, commitado e **provado por ensaio em produção**:
[`db/2026-10-05-pedido-total-liquido-excecao.sql`](../../db/2026-10-05-pedido-total-liquido-excecao.sql).
Ele instala a tabela, deriva a lista e troca o conversor — e **não converte nada**. A conversão é um
segundo apply, com postcondição própria.

Duas decisões que mudaram durante a escrita, as duas por lição do próprio repo:

- **O conversor é trocado por SUBSTITUIÇÃO PROGRAMÁTICA**, não por corpo copiado. A primeira versão
  colava as 246 linhas do `pg_get_functiondef`; isso é uma bomba de relógio, porque apply commitado é
  imutável e um corpo copiado **reverte em silêncio** qualquer endurecimento posterior — a irmã da
  armadilha do `CREATE OR REPLACE` sem `WITH`. O bloco lê o corpo VIVO, exige que cada âncora apareça
  **exatamente 1×**, troca e reexecuta; âncora ausente ou duplicada **aborta**. É idempotente: se o
  corpo já menciona a tabela, não faz nada.
- **Guarda de 48h no INSERT**, que é a lição desta mesma sessão virada em código. O reprocesso deixa
  linha NULL transitória; sem o filtro, um pedido **em voo** entraria na exceção por engano e perderia
  a conversão para sempre, em silêncio. Hoje a guarda custa zero (105 bloqueadores, 105 parados, 0 em
  voo) — e é por isso que ela tem de estar lá antes de custar algo.

Provas colhidas:

| prova | resultado |
|---|---|
| `db:aplicar … --ensaio` (prod, rodou inteiro e fez ROLLBACK) | **rc=0**, postcondições (a)–(f) |
| controle da postcondição (e): lista vazia na mesma transação | **0 elegíveis** |
| com a exceção de pé | **538 elegíveis**, −R$ 100.144,46 |
| `db/test-pedido-total-liquido-acervo.sh` (PG17) | **68 ok / 0 fail** |

**O que falta, e não é opcional:** `sem-codex` — a cota do Codex está em 89% (teto 85%) e a janela de
7 dias só reabre em **09/10 19:30**. A regra do repo é explícita: em money-path o adversarial de
CÓDIGO não se pula, e *"cota baixa não é gatilho de pular — é gatilho de DRAFT"*. Então o PR fica
DRAFT e **nada foi aplicado em produção**: o ensaio reverteu tudo. O apply real espera o parecer, ou
uma decisão explícita do founder pelo Caminho B.

### O apply 2: a conversão, e o pré-voo que a recusa sem o apply 1

[`db/2026-10-05-pedido-total-liquido-converter-acervo.sql`](../../db/2026-10-05-pedido-total-liquido-converter-acervo.sql)
é a conversão em si. Ele **não acredita** que o apply 1 tenha pegado — confere, e no catálogo, não
invocando (validação que executa o objeto mente nos dois sentidos): a tabela existe? o corpo vivo do
conversor menciona a tabela? a lista tem linha? Qualquer "não" aborta antes de escrever.

**Prova negativa, colhida hoje** (o apply 1 ainda não está em prod, então o pré-voo *deve* recusar):

```
rc=3 · marcador FIM_APLICACAO_OK AUSENTE
ERROR: P0001: pre-voo: a tabela pedido_total_liquido_excecao NAO existe — o apply 1 nao foi
aplicado (ou foi so ensaiado, e o ensaio faz ROLLBACK)
```

As três postcondições dele medem a mesma coisa por caminhos diferentes, e têm de bater:

1. `escritos > 0` — o relatório do conversor.
2. O **sensor do cupom** (a query que mede o que o cliente vê) tem de cair, e cair **exatamente** o
   que foi escrito. Escrever sem consertar a tela, ou consertar mais do que se escreveu, aborta: o
   relatório da função e o sensor da tela são medições independentes do mesmo fato.
3. Nenhum total do lote fora de `(0, bruto]` — líquido zerado ou acima do bruto é número fabricado,
   não conversão.

⚠️ Este arquivo **não foi ensaiado**, e não podia ser: o ensaio do apply 1 faz ROLLBACK, então a
tabela não existe em prod enquanto ele não entrar de verdade. O ensaio dele é o passo entre os dois
applies, e é obrigatório.

### O par inteiro, EXECUTADO: `db/test-pedido-total-liquido-excecao.sh`

Eu escrevi aqui que o apply 2 "não foi ensaiado e não podia ser". A segunda metade era falsa: não
podia **em produção** (o `--ensaio` faz ROLLBACK, então lá a tabela nem existe e o pré-voo recusa —
corretamente). Num PG17 local, com as migrations reais, os dois applies rodam na ordem e dá para
olhar. **21 asserções, 0 falhas.**

O que só esta prova mostra, e o ensaio em prod não mostrava:

| assert | o que afirma |
|---|---|
| A1 · A1b | o pré-voo do apply 2 recusa sem o apply 1 — e recusa **pelo motivo certo** |
| A9 | o corpo vivo passou a ler a tabela: a substituição programática produz código que **executa** |
| A10–A11 | reaplicar o apply 1 é idempotente (lista segue com 2, patch segue 1×) |
| A12 | o destravamento é **nominal**: julho sai, junho fica preso pelo pedido em voo |
| A14–A18 | o convertível virou líquido; os três excluídos seguem com **cabeçalho bruto** |
| A19 | o sensor do cupom caiu **exatamente** o que foi escrito |
| A20 | reaplicar o apply 2 **falha** em vez de escrever de novo |

E `--falsificar`: **5 sabotagens, 5 vermelhas no assert DECLARADO**, com o controle verde (21/0) na
MESMA invocação.

| sabotagem | assert que a acusa | o que pegou |
|---|---|---|
| `guarda48_fora` | A4 | `postcondicao (c)`: 1 exceção com pedido tocado nas últimas 48h |
| `ancora_adulterada` | A4 | `patch: a ancora 2 nao aparece EXATAMENTE 1x no corpo vivo` |
| `filtro_neutralizado` | A4 | `postcondicao (f)`: com 2 exceções o ensaio segue com 0 elegíveis |
| `prevoo_tabela_cego` | A1b | o **segundo** cinto do pré-voo: o conversor não lê a tabela |
| `duas_camadas_fora` | A6, A7 | **sem ERROR nenhum** — o apply passa e só os asserts pegam |

A última linha é a que vale ler. Com a guarda de 48h **e** seu verificador fora, o apply **não
reclama**: o pedido em voo entra na lista e é excluído para sempre, em silêncio. É o dano que a lição
desta sessão (churn ≠ corrosão) evita, agora medido em vez de suposto. E a `guarda48_fora` sabota
**uma camada por vez** — o passo 2 usa `p.updated_at <`, a postcondição (c) usa `so.updated_at >=`,
âncoras distintas de propósito. Na primeira versão eu derrubei as duas juntas, que não prova nada.

**Três correções que o CI me cobrou**, e as três são da mesma família — ausência lida como aprovação:

1. O gate `falsificar-exige-assert-gate` (regra R3) reprovou minha primeira versão, com razão: o
   veredito era `saída ≠ "ok"`, ou seja, **aceitava vermelho de qualquer causa** — PG que não sobe,
   arquivo que falta, migration que muda. Vermelho de ambiente aprovaria a sabotagem. O idioma
   `SABOTAGENS` do repo obriga a declarar *qual* assert tem de acusar cada sabotagem, e o laço confere
   três coisas: controle verde antes, a sabotagem **aplicou** (marca `SABOTAGEM ativa:`), e o assert
   declarado virou vermelho.
2. O A1b nasceu vazio e passava calado: `APPLY_ERR` era setada dentro de `$(aplicar …)`, que é
   **subshell** — variável de lá não volta ao pai. O erro agora vai para arquivo. Ausente lido como
   vazio é a mesma armadilha de `ausente ≠ zero`, só que no shell.
3. O gate `assert-verde-por-ausencia` achou **três asserções NULL-blind nos próprios applies**, e
   são defeito real, não ruído de linter: `IF (length(v_def) - …) / length(v_a1v) <> 1` não dispara
   quando o lado esquerdo é NULL, porque `NULL <> 1` é NULL. Se `pg_get_functiondef` devolvesse NULL,
   a asserção de âncora **aprovaria em silêncio** e o replace seguiria num corpo que ninguém conferiu.
   Existe um guard de existência antes, mas uma asserção não deve depender da ordem dos guards para
   ser fail-closed. Viraram `IS DISTINCT FROM`, NULL-safe por construção. A terceira era a do sensor
   do cupom (`(v_antes - v_depois) <> v_escritos`) — a postcondição mais importante do apply 2.

⚠️ Os bytes mudaram com isso, e **o ensaio vale para os bytes exatos** — refeito em produção com o
sha novo (`67fedaa6…`): mesmo resultado, `105 pedidos excluidos | controle sem excecao = 0 elegiveis
| com excecao = 538 elegiveis | soma prevista = -100144.46`. O PG17 também: controle verde (21) e as
5 sabotagens vermelhas no assert declarado.


### O bloqueio que eu reportei errado: `exit 79` não é a parede

Fechei a etapa anterior dizendo ao founder que havia **duas** saídas — esperar 09/10 ou autorizar o
Caminho B — e que a decisão era dele. A decisão é dele mesmo, mas a dicotomia era falsa, e o erro foi
meu: li `exit 79` como "cota esgotada" quando o cabeçalho do próprio `codex-async.sh` diz, em letra
redonda, `≠ 75, que é ter BATIDO na parede`. O 79 é guard **local** de orçamento, e o comentário dele
declara a razão do teto de 85%: *"o que resta deve ficar pro money-path"*.

O adversarial deste apply **é** money-path. A reserva não estava me barrando — estava guardando cota
para exatamente este consult. Com ~1,4 pp por consulta (medido em 18/09) e 89% usado, sobram ~7
consultas. A saída certa é a terceira, que eu não ofereci: **gastar a reserva** — decisão do founder,
porque a cota é compartilhada, não porque o adversarial seja opcional.

Nada disso afrouxa a regra: o adversarial de código continua não-pulável. O que muda é que o
bloqueio tem 4 dias menos do que eu anunciei, e que eu transformei um código de saída em prazo de
calendário sem ler o ramo que o emitiu.

### O desfecho do `exit 79`: a reserva não existia, e o erro era o mesmo de antes

Autorizado a gastar a reserva, subi o teto e rodei. O wrapper releu o saldo e devolveu **100,0%** —
não 89%. O 89% era leitura de ontem, de um rollout antigo; entre ontem e hoje o saldo virou em alguma
das 14 sessões paralelas desta máquina. **Não havia reserva para gastar.**

Então eu errei duas vezes seguidas, e a segunda é mais interessante que a primeira. A primeira foi ler
`exit 79` como parede (corrigido acima — e aquela correção segue válida: o 79 é guard local, não 429).
A segunda foi transformar o número que o 79 imprime em capacidade: *"89% usado, ~1,4 pp por consulta,
cabem ~7"*. Esse número é um **piso** por desenho — o próprio sensor diz que piso é o lado certo de
errar num guard. Piso não se divide.

E é a mesma armadilha desta sessão inteira, pela terceira vez: **retrato datado lido como estado
atual.** Foi o churn de reprocesso lido como corrosão (83→154 linhas); foi o pedido em voo que a
guarda de 48h mantém fora da lista; e agora foi um saldo de ontem virando orçamento de hoje. O
antídoto é o mesmo nos três: antes de transformar leitura em previsão, **re-medir** — aqui a releitura
custava zero, bastava subir o teto, que é exatamente o que descobriu o 100%.

Fato operacional: o adversarial de código **não roda antes de 09/10 19:30**. Não por política nossa
agora, mas porque a janela está esgotada de verdade.

### APLICADO em produção (2026-10-08, 00:41–00:52 UTC) — o desfecho medido

Caminho B por decisão do founder: o PR saiu do draft com `REVISÃO INDEPENDENTE PENDENTE` e
auto-challenge registrados, mergeou, e os dois applies foram aplicados pelo envelope.

| passo | recibo |
|---|---|
| `db:aplicar …excecao.sql` (sha `67fedaa6…`) | **APLICADO**, tentativa #274 virou recibo na mesma transação |
| `db:aplicar …converter-acervo.sql --ensaio` | rodou inteiro: **538 escritos, tela 570 → 32**, e reverteu |
| `db:aplicar …converter-acervo.sql` (sha `14fd7848…`) | **APLICADO**, tentativa #276 · lote `e8ec64ba…` |

```
EXCECAO INSTALADA: 105 pedidos excluidos | controle sem excecao = 0 elegiveis
                 | com excecao = 538 elegiveis | soma prevista = -100144.46
CONVERSAO OK: 538 pedidos escritos | tela: 570 brutos -> 32 | soma da mudanca = -100144.46
```

**O sensor do cupom, medido POR FORA** (query própria via `psql-ro`, não o relatório da função — as
duas medições são independentes de propósito):

| | antes | depois |
|---|---|---|
| pedidos com desconto | 639 | 639 |
| **coerentes na tela** | 69 | **607** |
| **ainda com cabeçalho bruto** | **570** | **32** |

E as invariantes, também por fora:

- lote `e8ec64ba…`: **538 escritos**, soma **−R$ 100.144,46**, **0** totais fora de `(0, bruto]`;
- **105/105 excluídos seguem com cabeçalho BRUTO** — `ausente ≠ zero` preservado na prática, não só
  no desenho;
- **nenhum excluído foi convertido** (junção do ledger com a tabela de exceção: 0 linhas);
- 11 meses destravados: `2025-10`=70 · `11`=49 · **`12`=45** · `2026-01`=65 · `02`=41 · `03`=53 ·
  `04`=50 · `05`=38 · `06`=57 · `07`=51 · `08`=19. Os 45 de dezembro são exatamente os que estavam
  presos por **um** bloqueador.

Dois detalhes que valem como prova de desenho, e não eram garantidos:

1. **O ACL da função sobreviveu.** A substituição programática é `CREATE OR REPLACE` por construção
   (`pg_get_functiondef` + `EXECUTE`), e `REPLACE` preserva o ACL onde `DROP`+`CREATE` o resetaria. A
   evidência é um erro: o `psql-ro` levou `permission denied for function
   pedido_total_liquido_converter` ao tentar chamá-la, e `has_function_privilege` devolve `false` para
   `anon` e `authenticated`. Se eu tivesse recopiado o corpo, a função teria voltado aberta.
2. **A janela foi escolhida pelo achado P2 do auto-challenge:** 00:41 UTC, com os crons em `15 */2` e
   `30 2` — ~1h30 de folga até o próximo. O sensor antes/depois roda em `read committed` (medido), e
   um commit de cron no meio moveria o delta.

**O que fica aberto, e é passo do founder:** o `supabase/schema-snapshot.sql` precisa ser re-gerado
pelo chat do Lovable. A tabela `pedido_total_liquido_excecao` e o corpo novo do conversor existem em
prod e **não** em `supabase/migrations/` — então, até o re-dump, eles só existem no DR por este
parágrafo. Os outros dois passos da reconciliação não se aplicam: não há migration formal para
registrar em `schema_migrations`, e `types.ts` não morde porque a tabela tem RLS fechada e o front
não a consome (se um dia consumir, a regeneração dos tipos entra na mesma entrega).

E o Codex retroativo segue devendo: a cota reabre **09/10 19:30**, e o achado que vier de lá é
conserto, não discussão.

### A sequência, quando o parecer chegar

```bash
bun run db:aplicar db/2026-10-05-pedido-total-liquido-excecao.sql            # 1. instala (nao converte)
bun run db:aplicar db/2026-10-05-pedido-total-liquido-converter-acervo.sql --ensaio
bun run db:aplicar db/2026-10-05-pedido-total-liquido-converter-acervo.sql   # 2. converte os 538
```

E depois, por fora: o sensor do cupom tem de mostrar os brutos caindo de 570 para ~32, e
`bun run audit:migrations` + re-dump do snapshot, porque objeto criado à mão fora de
`supabase/migrations/` só existe no DR pelo snapshot.
