# Fase sem sinal — a fase N+1 construída sobre uma fase N que nunca provou estar viva

> **A classe (2026-08-13):** entregar a fase N, ler o silêncio que vem depois como funcionamento (ou
> como falha do desenho) e construir a fase N+1 em cima. O repo pagou isso **três vezes**, em três
> domínios diferentes, com o mesmo formato: a fase N estava no ar, ninguém reclamou, nenhum sinal
> positivo de uso jamais existiu — e o trabalho seguinte foi planejado sobre essa suposição.
>
> A regra que ficou no CLAUDE.md (§Armadilhas): **antes da fase N+1, exija ≥1 sinal POSITIVO de uso
> real em produção, com denominador. Toda fase que entrega superfície de uso nasce com o seu sensor.**

É o parente de produto de uma regra que o repo já tinha para comandos — *"validação só conta com
evidência positiva; ausência de sinal não é aprovação"*. A versão de comando protege uma sessão de
trabalho; esta protege um **programa de várias fases**, onde o custo do engano só aparece semanas
depois e já contaminou o que veio em cima.

---

## Os três precedentes

### 1. Piloto Sayerlack de auto-aprovação — o fusível nunca foi ligado

Detalhe completo em [reposicao-auto-aprovacao-piloto.md](reposicao-auto-aprovacao-piloto.md).

| Fato | Evidência (psql-ro, 2026-07-09) |
|---|---|
| Infra em produção desde | 2026-06-11 (tick SQL + cron `*/30` + log + salvaguardas) |
| `reposicao_auto_aprovacao_log` | **0 linhas *ever*** — nem v1 nem v2 |
| Fusível `reposicao_auto_aprovacao_ativa` | **`false` desde o seed** |
| Pedidos elegíveis na janela | **abundantes** (quase todo dia, máximos 17k–22k) — vários aprovados **na mão** |

O piloto foi recalibrado (v1 → v2, 2026-06-15) **sobre uma v1 que nunca havia auto-aprovado nada**:
a v1 ficou inerte por 4 dias e a resposta foi mexer no critério, sem antes provar que o critério
chegava a ser avaliado. Ele não chegava — o braço não executava. Só o check-in agendado, ~4 semanas
depois, produziu o veredito: **inconclusivo/inerte**, sem dado para promover nem para matar.

O doc do piloto já enunciou a regra em escala local: *"se um dia religar, exigir **ver
auto-aprovações acontecendo**; NÃO ligar o fusível achando que já rodou"*. O que faltava era a
generalização — nada impedia o mesmo formato de reaparecer em outro domínio. Reapareceu duas vezes.

### 2. Rota do Farmer (`/rota/ligacoes`) — tela viva, telemetria zerada desde a origem

Corrigido em 2026-08-13 pelo [#1717](https://github.com/LucasSardenbergL/afiacao/pull/1717).

| Fato | Estado |
|---|---|
| Pipeline | **íntegro** — 24 cidades ativas, config viva, RPC funcional, centenas de candidatos/cidade |
| Tela | construída, roteada, no menu; closed-loop de outcome entregue no #550 |
| `route_contact_log` / `route_queue_snapshot` | **zerados desde a origem** |
| Desfechos distinguíveis pela UI | **nenhum** — 4 saídas-vazias + "nunca aberta" eram o mesmo pixel |

Aqui a fase N+1 (`PR2c`, closed-loop de registro de resultado) foi construída **sobre** a fase N
(`PR2a`, motor de rota + lista de ligação) sem que a fase N tivesse emitido um único sinal de uso. O
efeito não é só "não sabemos se funciona": é que a investigação **trava**, porque `cities=0`,
`candidatos=0`, `todos_excluidos`, `sem_capacidade` e "ninguém abriu" produzem exatamente a mesma
tela vazia. A quarta é a perigosa — com `cap=0` a lista de excluídos fica vazia, idêntica a "nenhum
candidato", e inferir o motivo dos totais seria **fabricar diagnóstico**.

A correção é o formato de sensor que este doc recomenda: o motivo é **declarado no ponto que sabe**
(`rota.fila_vazia` + motivo, `rota.fila_carregada`, `rota.fila_erro`, `rota.contato_erro`), nunca
inferido pela UI. O erro tem precedência sobre `data` — o React Query preserva o retrato anterior em
`isError`, e sem essa ordem uma query que **passou** a falhar seguiria reportando sucesso.

### 3. Plano tático do Farmer — o zero media a ausência de usuários

Detalhe e as duas erratas (#1713 e #1716) em [fila-plano-tatico.md](fila-plano-tatico.md).

533 planos gerados, **0 desfechos**. A leitura registrada foi: *"se `concluido` continuar em 0, o
gargalo é adoção da tela, não custo do formulário"*. Errado por omissão — o numerador zero foi lido
como veredito sobre o desenho da tela sem que ninguém tivesse medido o denominador:

| Medição do denominador (psql-ro, 2026-08-13) | Valor |
|---|---|
| `master` | 1 usuário — **1 com sessão viva em 30d** (o próprio founder) |
| `employee` | 2 usuários — **0 com sessão viva** |
| `customer` | 5.664 — **0 com sessão viva** |
| Último sign-in das duas farmers donas de 506 dos planos | **2026-04-15** e **2026-04-13** |

O app inteiro tinha **um usuário ativo, e era o founder**. Um denominador de zero usuários produz
numerador zero em qualquer desenho de tela — o melhor botão do mundo mede o mesmo que o pior. E o
alvo do veredito seria o trabalho de outra pessoa ("a vendedora não adota a tela"), o que torna esse
erro mais caro que um número errado.

---

## A regra, e como aplicá-la

**Antes de construir a fase N+1, a fase N precisa ter emitido ao menos um sinal POSITIVO de uso real
em produção — e o sinal precisa ter denominador (quantos podiam ter usado).**

1. **Rode o sensor da fase N e cole a evidência no plano/PR da fase N+1.** Uma linha de log, um
   evento, uma transição de estado — algo que só existe se alguém usou. "Está no ar e ninguém
   reclamou" é ausência de dado, e ausência de incidente em código que nunca executou é ausência de
   dado, não evidência de segurança.
2. **Se a fase N não tem sensor, a fase N+1 é instalar o sensor** — não a funcionalidade seguinte.
   Foi o que o #1717 fez, e é mais barato que a investigação que ele destravou.
3. **Numerador sem denominador não é métrica** — é o `Number(null) === 0` em escala de produto.
   Antes de ler zero como veredito sobre uma tela, prove (a) que o código está no ar (merge na `main`
   não publica nada: §Lovable = 3 deploys manuais — a errata do caso 3 provou por bytes, varrendo
   331 chunks atrás de uma string exclusiva da entrega) e (b) que existe alguém do outro lado.
4. **Fusível/flag prova-se por efeito observado, não por config lida.** No caso 1 o cron estava
   ativo, a função existia e o fusível estava `false` — cada peça "certa" isoladamente, efeito zero.
5. **Gatilho de "quando medir" é query, não recado.** Enquanto o gatilho for "alguém me avisa", ele
   herda a mesma falha do zero sem denominador: ninguém consegue conferir se já disparou.

### A query canônica do denominador

```sql
SELECT ur.role,
       count(DISTINCT ur.user_id) AS usuarios,
       count(DISTINCT s.user_id)  AS ativos_7d
FROM user_roles ur
LEFT JOIN auth.sessions s
       ON s.user_id = ur.user_id
      AND s.updated_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

⚠️ **O par de sinais tem dente; nenhum dos dois sozinho teria.** `auth.sessions` some no logout e na
expiração — lida sozinha, "0 sessões" é ausência de dado. O que salva a inferência é
`auth.users.last_sign_in_at`: é **evidência positiva** (uma data real, que o Postgres não apaga). Na
direção oposta, `last_sign_in_at` sozinha também não bastaria: o Supabase não a atualiza no refresh
de token, então uma data velha é compatível com uso diário sob sessão persistente. Um mede que
**houve** entrada; o outro, que **há** presença.

### ⚠️ Instalar o sensor não basta: ele tem de medir a PERGUNTA (2026-08-18, #1765)

O item 2 acima manda instalar o sensor quando a fase N não tem um. Este caso é o que acontece
**depois** disso — e mostra que "tem sensor" e "a pergunta é respondível" são coisas diferentes.

**A pergunta era frequência:** *"com que frequência o recálculo do farmer produz zero
recomendações?"* Medido antes de desenhar: 28 execuções COM linha em 5,5 meses, 3 farmers. O
recálculo vazio saía por `return` mudo — sem linha, sem registro. Numerador sem denominador.

**O sensor projetado foi um HEAD** — 1 linha por `(motor, farmer_id)`, `ON CONFLICT DO UPDATE`,
avançando a cada execução inclusive quando vazia. Resolvia o compare-and-swap sem depender de haver
linha, e distinguia "nunca rodou" (head ausente) de "rodou e deu vazio" (head com `resultado=vazio`)
— duas coisas que antes eram o mesmo estado. Tudo verdade, e ainda assim **ele não responderia a
pergunta**: o upsert sobrescreve, então um `vazio+completo` de hoje some no run com linhas de
amanhã. A query de decisão devolveria *"nunca aconteceu"* para algo que aconteceu — a MESMA
ausência-de-dado que o sensor foi instalado para curar, agora com cara de resposta.

Pego pelo challenge Codex xhigh, depois de a implementação já estar verde com 49 asserts e 6
falsificações. **Os asserts provavam que o head funcionava; nenhum provava que ele media a
pergunta.** Correção: separar as duas coisas — `farmer_geracao_vigente` = HEAD (estado corrente +
CAS) e `farmer_geracao_execucoes` = LOG append-only (frequência), escritos na mesma transação.
Volume nunca foi objeção: 28 execuções em 5,5 meses.

**A regra:** antes de aceitar um sensor, escreva a query que ele vai responder e confira se a
ESTRUTURA dele comporta a resposta. Três formas que não comportam:

| a pergunta é… | e o sensor é… | então ele responde |
|---|---|---|
| *com que frequência* | um head/upsert (1 linha por chave) | o último estado — o evento anterior foi apagado |
| *quantos* | um flag booleano | se aconteceu ao menos uma vez |
| *quando começou* | um `updated_at` sobrescrito | quando mudou pela última vez |

Estado e história são perguntas diferentes, e **o upsert é a forma canônica de perder história sem
perceber** — porque nada falha, nada fica vermelho, e a tabela existe com dado dentro.

⚠️ **E o par tem de ser à prova de retry:** o log ganhou `UNIQUE(motor, farmer_id, run_id)`, senão a
"frequência" mede retries junto com execuções. Contador sem chave de idempotência não conta eventos,
conta chamadas.

⚠️ **Sensor com grant de escrita direto é sensor forjável.** A 1ª versão dava `GRANT INSERT, UPDATE`
a `authenticated` — com isso o browser dispensava a RPC e escrevia o head por `UPDATE` direto,
pulando lock, compare-and-swap e anti-forja de uma vez. Guard que se contorna pela porta ao lado não
é guard; e aqui o contorno não corrompia um número qualquer, corrompia a **medição sobre a qual a
fase seguinte decidiria**. Escrita só pela RPC (`SECURITY DEFINER`), leitura por RLS. O tell foi o
próprio spec afirmar *"a tabela não recebe grant de escrita direta"* enquanto o SQL fazia o
contrário — **contradição entre o documento e o código passa justamente porque o documento está
certo.**

⚠️ **Sensor recusado por um custo que NÃO existe.** O mesmo design (§7.5) recusou um insumo de
cobertura — *"quantos clientes da carteira têm item que RESOLVE para um SKU do catálogo?"* — com a
justificativa de que exigiria percorrer os itens de todos os pedidos só para instrumentar, e o
deixou como limitação declarada. Não exigia: os dois motores **já percorrem** todos os itens de
todos os pedidos (para montar `customerProducts` e `baskets`), e o descarte silencioso
(`if (!productId) continue`) mora DENTRO desse loop — o insumo era um filtro sobre estrutura já
construída em memória. Fechado em 18/08/2026, mostrou que a limitação era grande: 39,9% dos 47.735
itens não resolvem, e **107 dos 861 clientes com pedido não têm NENHUM item utilizável**. Um farmer
feito só deles dava zero com todos os universos fartos — o falso `completo` que a fase seguinte
usaria como licença para expirar.

O tell é **custo de instrumentação alegado em prosa e nunca medido** (o irmão do "no ar e ninguém
reclamou": ausência de dado com cara de conclusão). Antes de recusar um sensor por custo, abra o
call-site e veja se o loop já passa pelo dado — instrumentar o que já se percorre é grátis, e aqui
a distância entre "caro" e "grátis" foi só ninguém ter aberto o arquivo.
### ⚠️ O sinal pode chegar ENVENENADO pela camada de baixo (2026-08-18, follow-up do #1765)

O caso anterior é sobre a ESTRUTURA do sensor comportar a resposta. Este é o passo seguinte: a
estrutura está certa, o sensor está armado em prod — e mesmo assim o **primeiro sinal que ele vai
registrar é falso**.

**O estado medido (prod, via `psql-ro`):** `farmer_geracao_execucoes` = **0 linhas**, e
`farmer_geracao_vigente` = 0. Duas análises foram abertas contra esse zero (15/08 e 18/08); as duas
voltaram sem poder concluir nada. A auditoria do sensor descartou as falhas silenciosas — tabelas
aplicadas, RPC `farmer_geracao_registrar` `SECURITY DEFINER` com EXECUTE para `authenticated` e não
para `anon`, policies de SELECT no lugar, definição em prod idêntica à do repo. **O sensor está
correto; o que falta é o Publish do frontend.**

**O discriminante do Publish não é o cross-sell — é o bundle.** São dois motores com cadências
opostas, e medir só um induz ao erro:

| motor | tela | última gravação | leitura |
|---|---|---|---|
| cross-sell (`farmer_recommendations`) | `/farmer/recommendations` (`useEffect`) | 2026-08-15 17:32 UTC | 3 dias de silêncio — normal: **junho e julho tiveram ZERO gerações** |
| bundle (`farmer_association_rules`) | outra tela | **2026-08-18 07:30 UTC** | roda quase todo dia |

O `useBundleEngine` da `main` **já registra o vazio** (`registrarVazio()`). Logo: o motor de bundle
rodou hoje, produziu vazio, e não deixou linha no sensor ⇒ o bundle no ar é o **anterior** ao
Publish. Medir só `farmer_recommendations` levaria à conclusão oposta ("ninguém abre a tela").

**O veneno.** O #1782 mostrou que o motor de bundle produz vazio **todo dia por bug**: a RPC
`get_skus_margem_positiva` devolve 2.462 linhas e era lida **sem paginação**, então o cap de 1.000
do PostgREST entrega mil linhas **e sucesso**. No `useBundleEngine`, esse retorno truncado não cai
no ramo fail-closed — cai aqui:

```ts
const vendaveis = new Set(vendaveisResult.data.map((r) => r.product_id));
insumos.vendaveis = { ok: true, n: vendaveis.size };   // ok:true, n:1000
```

`avaliarCompletude` só degrada quando algum insumo tem `ok:false`. Nenhum tem. O resultado é uma
execução `resultado='vazio'` + `completude='completo'` + `scores.n>0` + `vendaveis.n>0` — que é
**exatamente** o predicado que a fase 2 definiu como "o sinal que autoriza ligar a expiração".

> **`ok:true` quer dizer "a leitura não lançou", não "a leitura veio inteira".** Um sensor de
> completude construído sobre esse `ok` herda, sem saber, todo truncamento silencioso da camada
> de baixo — e o entrega com a roupa do sinal legítimo.

Se o Publish tivesse saído antes do #1782, o sensor teria coletado esse falso positivo **todo dia**,
e ligar a expiração por vazio teria **zerado a carteira** de vendedoras cujos bundles existiam e
foram perdidos na cauda truncada. O sensor não teria errado nada: ele mediria com precisão um
número já envenenado.

**Ordem operacional que isto impõe:** o #1782 entra **antes** do Publish do sensor. Publicar com o
bug vivo não é neutro — contamina o denominador que vai levar meses para se acumular.

**O resíduo:** [`db/gatilho-farmer-fase2.sql`](../../db/gatilho-farmer-fase2.sql). A query decide
sozinha entre `AGUARDE` / `CONTAMINADO` / `DECIDA` / `ENCERRE`, e carrega a guarda que faltava —
qualquer insumo com **exatamente 1.000** linhas é assinatura de cap do PostgREST e derruba o
veredito para `CONTAMINADO` antes de ele virar `DECIDA`. Os quatro ramos foram falsificados contra
a lógica publicada (tabela substituída por cenário sintético); no ramo `CONTAMINADO` o cenário tem
`vazios_completos=1`, isto é, sem a guarda ele **teria** autorizado a fase 2.

⚠️ **CONFIRMADO com dado (2026-08-19 01:22 UTC).** A previsão acima deixou de ser previsão. O
Publish saiu, `farmer_geracao_execucoes` gravou sua **primeira** linha, e ela veio assim:

```
motor=cross_sell  resultado=linhas  completude=completo
insumos: scores 3858 · catalogo 3139 · pedidos 861 · carteira_ativa 171 ·
         clientes_com_profile 147 · regras 24 · vendaveis {"n": 1000, "ok": true}
```

`vendaveis.n = 1000` **exato** — a assinatura do cap, com `ok:true`, no primeiro registro que o
sensor produziu na vida. O gatilho classifica `CONTAMINADO` e recusa, que é o desfecho correto.
Vale reter o que isso custou: o sensor foi desenhado, revisado por challenge, provado com 49
asserts e publicado — e ainda assim seu primeiro dado é inútil, por um bug numa camada que
nenhuma dessas etapas olhava. **Instrumentar não termina no sensor; termina no primeiro dado
lido de verdade.**

⚠️ **E o gatilho que NUNCA pode ficar verde.** O sensor acima ganhou uma query de decisão — "já há
o que analisar?" — que recusava vazio envenenado pelo cap de 1.000. Ela contava a assinatura de
truncamento sobre a tabela INTEIRA. Mas `farmer_geracao_execucoes` é append-only: as 7 execuções
truncadas de 19/08 nunca saem de lá. O veredito seria `CONTAMINADO` **para sempre**, mandando
"descarte o período e recomece o denominador" sem oferecer meio de fazê-lo — e o primeiro
vazio+completo legítimo apareceria enterrado atrás de linhas velhas e imutáveis. Provado com o mesmo
cenário nas duas versões: a antiga responde `CONTAMINADO`, a nova responde `DECIDA`.

Um gatilho que só sabe dizer "não" parece o lado seguro do precisão>recall, e não é: ele não decide,
ele **abdica** — e some com o sinal que a fase seguinte precisa ver. A correção é uma janela que
começa depois da última contaminação, com as descartadas em coluna própria (cap silencioso é o
defeito, não a cura) e a contaminação ATIVA ainda travando tudo. **Ao escrever um sensor, pergunte
também o que precisa acontecer para ele dizer SIM** — se não houver resposta, ele não mede a
pergunta, mede o passado.

⚠️ **E o agregado que esconde o sensor que nunca foi exercido.** O mesmo gatilho somava os DOIS
motores. Em 20/08: 10 execuções de `cross_sell`, **zero** de `bundle` — somadas, "10 execuções". A
causa não é preguiça de ninguém: `FarmerRecommendations` recalcula num `useEffect` ao ABRIR a tela,
`FarmerBundles` só calcula por BOTÃO. Um acumula por uso orgânico, o outro nunca. Provado com 20
execuções sintéticas de cross-sell e zero de bundle: a versão agregada responde
`ENCERRE — encerre a linha`, decidindo pelos dois; a versão por motor responde `ENCERRE` para o
cross-sell e `SEM DENOMINADOR` para o bundle.

Encerrar uma linha é a decisão mais irreversível que este arquivo governa, e ela sairia sobre um
motor cujo denominador é **zero** — o `ausente=zero` promovido a veredito. **Quando um sensor cobre
mais de uma superfície, o denominador é por superfície**; e superfícies que se exercem de formas
diferentes (automático vs. manual) nunca compartilham denominador, mesmo medindo a mesma coisa.

⚠️ **E o `AGUARDE` que nunca vira nada — porque falta USO, não sensor.** O gatilho exigia 20
execuções julgáveis. Medido em 20/08: **3 farmers têm carteira, 1 executou alguma vez, e as últimas
24h tiveram ZERO execuções** — as 10 de 19/08 saíram todas num intervalo de 1h04, que é sessão de
teste, não rotina. Nesse ritmo o 20 não chega nunca, e o veredito repetiria "aguarde" para sempre.

Este é o topo da escada que este documento sobe: primeiro faltava o sensor, depois o sensor não
media a pergunta, depois o agregado escondia o motor zerado — e no fim **o que falta não é medição,
é a superfície ser usada**. Um `AGUARDE` sem taxa não distingue "crescendo devagar" de "parado", e a
diferença decide a ação: no primeiro caso espera-se, no segundo **a fase seguinte é instalar o uso**.
Correção: `taxa_7d` e `farmers_com_carteira` saem na própria linha, e o ramo `ESTAGNADO` nomeia o
denominador que não cresce. Falsificado com 5 execuções há 30 dias (`ESTAGNADO`) contra 5 há 2 dias
(`AGUARDE`).

**A regra:** todo veredito de espera tem de carregar a taxa que o justifica. Sem ela, "aguarde" não
é uma decisão — é o silêncio com cara de decisão.

⚠️ **E `completo` que não garante o UNIVERSO certo.** Até o #1822 os dois motores filtravam
`sales_orders` por `status IN ('confirmado','faturado','entregue')` — e **dois desses status nunca
existiram nesta tabela**: a allowlist tinha sido copiada de outra. As leituras não falhavam, não
truncavam em 1.000, saíam `ok:true` e `completude='completo'`. Só enxergavam menos base. Medido no
mesmo farmer: `pedidos=861` nas 10 execuções pré-fix contra **1227** na primeira pós-fix, +42%.

Nenhuma assinatura numérica pega isso — `n=1000` é cap do PostgREST, não allowlist errada — e
`completo` aqui é **verdadeiro e inútil**: o insumo foi lido com sucesso, da fonte errada. É o
limite do rótulo que esta linha inteira construiu: completude atesta que a leitura não falhou,
nunca que ela mirava o lugar certo.

Daí a **época** (o conceito do #1796): execução anterior ao fix mediu outro universo e não entra no
mesmo denominador. Ao corrigir um bug que muda o universo lido, **avance a época** — e o que conta
é o Publish, não o merge. Efeito imediato e desconfortável: o cross-sell caiu de "3 julgáveis" para
**zero**, porque as 3 que pareciam limpas liam a base errada.




### Onde a regra NÃO se aplica

Instrumentar tudo tem custo, e regra que grita errado treina a ignorar o vermelho. O gatilho é a
fase entregar **superfície de uso** — tela, botão, automação que decide sozinha, qualquer coisa cujo
sucesso dependa de alguém (ou de um cron) agir. Refactor interno, migração de tipos, gate de CI e
correção de bug com teste de regressão já nascem com o seu sinal: o teste vermelho→verde.

---

## Lição

Os três casos têm a mesma forma e três disfarces diferentes: no caso 1 o silêncio parecia
"calibragem errada" (e a resposta foi recalibrar); no caso 2, "a tela não presta ou ninguém entra"
(indistinguíveis por construção); no caso 3, "a vendedora não adota" (veredito sobre o trabalho de
outra pessoa). Em nenhum deles o silêncio era informação sobre o desenho — era a **ausência do
sensor** que deixava qualquer história caber no mesmo vazio.

**Corolário para revisão:** quando um plano diz "fase 2" ou "próximo passo", a primeira pergunta não
é sobre o desenho da fase 2. É: *qual linha de dado prova que a fase 1 foi usada, e quantos podiam
tê-la usado?* Se a resposta for uma inferência em vez de uma query, a fase 2 é instalar o sensor.

**Segundo corolário (2026-08-18):** quando o sensor finalmente acender, a pergunta não é só *"o
sinal chegou?"* — é *"a fonte do sinal estava sã quando ele chegou?"*. Um número medido com
precisão sobre um insumo truncado em silêncio é indistinguível do número legítimo, e a decisão que
ele autoriza é irreversível para quem está do outro lado (aqui: a carteira da vendedora). Por isso
o gatilho não devolve só o placar — ele **recusa** o veredito quando enxerga a assinatura do
truncamento.

---

## Corolário 2026-08-19 — a época do sensor, e a unidade em que ele conta

O sensor do caso 3 entrou em produção e as duas primeiras perguntas que ele levantou não são sobre o
desenho dele, e sim sobre **como ler o número que ele produz**. Ambas mordem depois, quando quem lê
já não é quem instalou.

### A época é o deploy do ESCRITOR, não a migration

Cronologia real, cada passo com evidência:

| quando (UTC) | o quê | as tabelas do sensor |
| --- | --- | --- |
| 08-18 15:15 | PR mergeado na `main` | não existem |
| 08-18 ~23:00 | migration aplicada no SQL Editor (tipos regenerados pelo bot às 23:01) | existem, **0 linhas** |
| 08-19 ~00:30 | **Publish** do frontend (provado nos bytes: chunk `registrar-geracao-*.js`) | existem, **0 linhas** |
| 08-19 01:22 | 1ª execução real registrada | 1 linha |

Entre 23:00 e 00:30 as tabelas existiam, estavam vazias, e o vazio **não era dado**: não havia escritor
no ar. Uma query de frequência rodada nessa janela responderia "nunca aconteceu" — a mesma
ausência-de-dado com cara de resposta que o sensor foi instalado para curar, agora deslocada para a
janela de deploy.

**Regra:** toda query de frequência sobre um sensor carrega um `data_inicio`, e ele é o **deploy do
escritor** — não a data da migration, não a do merge. Sem isso o numerador é honesto e o
**denominador de tempo mente**. E num app com service worker a época é ainda mais tarde para cada
usuário individualmente: quem não recarregou segue no bundle anterior, que não escreve. O primeiro
zero pós-deploy é ambíguo por construção; o segundo já não é.

### O contador conta a unidade DELE, não a do baseline

O baseline que justificou o sensor era "**28 execuções em 5,5 meses**", obtido agrupando linhas de
`farmer_recommendations` por dia. O log novo conta **execuções do motor** — e o motor recalcula **ao
montar a tela**. Na primeira sessão real de uso: **3 execuções em 6 minutos**, as três com as mesmas
671 linhas.

São unidades diferentes: uma conta *dias com resultado*, a outra conta *aberturas de tela*. Comparar
os dois direto lê como explosão de uso que não houve — e a decisão que vier dessa comparação estará
errada na direção mais convincente possível, porque os dois números são verdadeiros.

**Regra:** ao instalar um contador que vai substituir um baseline, escreva **na mesma linha** a
unidade dos dois. Se não forem a mesma, ou o baseline se recalcula na unidade nova, ou a comparação
fica proibida por escrito. `UNIQUE(motor, farmer_id, run_id)` protege contra *retry da mesma
execução*; nada protege contra **trocar a definição de "execução"**.

### O que essas 3 execuções provaram sobre o desenho

O head mostra **uma**. O log mostra **três**. Se o sensor tivesse ficado só no head — o desenho
original, que estava verde com 49 asserts e 6 falsificações —, a resposta a *"com que frequência
isso roda?"* seria "uma vez", e as outras duas teriam sido sobrescritas sem deixar rastro. A lição do
capítulo anterior deixou de ser argumento e virou medição: **na primeira execução real**.

---

## O sensor que colapsa TRÊS estados em um (MixGap, 2026-08-21)

Continuação direta da fatia do denominador (`farmer-apriori-denominador.md`, #1853): ao segmentar o Apriori por conta, o MixGap sai de **116 para ~84 clientes com gap**. A pergunta que a mudança faz nascer — *"a queda foi a esperada, ou o card quebrou?"* — era **irrespondível**, e não por falta de dado: por falta de **discriminante**.

```tsx
if (totalComGap > 0 && !tracked.current) track('carteira.mixgap_visto', { total_com_gap: totalComGap });
if (!data || data.totalComGap === 0) return null;
```

`useMyMixGap` **lança** quando a RPC falha, então no erro `data` fica `undefined` — a **mesma** condição do zero. Três estados, uma tela em branco e um silêncio:

| estado real | tela | PostHog |
|---|---|---|
| zero oportunidades | (nada) | (nada) |
| erro de leitura | (nada) | (nada) |
| vendedor nunca abriu | (nada) | (nada) |

É a irmã de UI do §6/§12 do money-path: lá a leitura falha calada e o motivo morre no `catch`; aqui os dois chegam à tela **como ausência de oportunidade**. E é a forma mais barata do "zero sem denominador não julga desenho": o zero existia, só não era distinguível de nada.

### A regra que isto acrescenta

**Um sensor de adoção precisa distinguir "não houve" de "não consegui" ANTES de ser usado como denominador.** Um contador que soma os dois mede uma coisa que não existe. O tell é sintático e barato de procurar: **um `return null` que serve mais de um estado**, ou um `?? 0` no payload de telemetria.

Duas consequências no desenho:

- **O evento sai com `total_com_gap: null` no erro, nunca `0`.** Mandar zero somaria falha de leitura à série de "carteiras sem oportunidade" e fabricaria exatamente o número que o sensor existe para medir (§2 — ausente ≠ zero). O assert que carrega isso é `expect(ev.total_com_gap).not.toBe(0)`, e a falsificação correspondente (trocar `null` por `0`) fica vermelha só nele.
- **Ausência de ACESSO não é um estado do card.** `get_meu_mixgap` devolve `NULL` para não-staff; contar isso como "visto" poluiria o denominador com quem nunca poderia ver a tela. Não renderiza e **não emite** — a única ausência de evento legítima.

E a guarda de "emitir uma vez" passou de booleano para **o estado emitido**: `erro → zero → com_gap` na mesma montagem é a transição que separa falha transitória de carteira realmente vazia, e um `useRef<boolean>` a engoliria.

### Medição que também recalibrou a fila

Ao medir os candidatos de fatia (todos com denominador, prod via `psql-ro`), a ordem de gravidade que eu havia proposto **se inverteu**:

| defeito (denominador) | ativo hoje | após o deploy do #1853 |
|---|---|---|
| tupla fabricada — MixGap (139 grupos / 116 clientes) | 9 grupos; 5 clientes com score inflado 14,3%; **0 mudam de família** | **0 de 130** |
| tupla fabricada — Melhorias (16 consequentes) | **0** | 0 |
| `recommend` sem filtro de status (23.113 pares) | **5 pares, 3 clientes** (0,02%) | igual |

Eu havia chamado a tupla fabricada (`max(confidence)` × `max(lift)` de regras diferentes) de "o único que fabrica número na tela" e recomendado corrigi-la primeiro. O número **é** fabricado, mas não muda a decisão em nenhum cliente — e a própria segmentação a zera, porque com regras por conta cada grupo passa a ter uma regra só. A previsão do Codex de que pioraria com mais regras **não se confirmou**: 14 regras segmentadas produzem menos grupos multi-regra que 24 globais.

**A lição de método:** severidade herdada de um parecer — inclusive de uma revisão adversária boa — continua sendo hipótese até ter denominador. As três medições custaram três queries e trocaram a fatia inteira.

### Revisão independente RETROATIVA (2026-08-22): o card separado, montado atrás de um `&&`

O `/codex` não rodou antes do merge (a sessão fechou) — rodou depois, com o #1859 já em produção. O
achado principal **não estava no componente**:

```tsx
// src/pages/FarmerCalls.tsx:33 — `error` nem é desestruturado
const { data: positivacao } = useMyPositivacao();   // useMyPositivacao.ts:43 → if (error) throw
// :436 — único ponto de montagem do card no app inteiro
{positivacao && ( … <MixGapCard /> )}
```

As duas RPCs saem pelo mesmo PostgREST, então a falha correlacionada é o caso COMUM. Quando ela
acontece, `positivacao` fica `undefined` e **o card nem monta**: os três estados novos, a tela de erro
nova e o evento em todos os ramos ficam inacessíveis exatamente na situação que motivou a correção.

**A regra que isto acrescenta: um teste de componente ISOLADO não prova o estado que o HOST decide.**
Os 6 testes montam `<MixGapCard />` direto e são verdes num contexto que não existe em produção — é o
"gate que mente por não conhecer a forma real do repo", na forma de harness. Ao separar estados num
card, o teste tem de montar o host, ou no mínimo asseverar que o host não o esconde atrás do `&&` de
uma query irmã. O tell para procurar: `{<algo> && (<Card/>)}` onde `<algo>` vem de um hook que lança.

Os outros achados que sobreviveram à verificação:

- **Quarto estado — offline.** Com `networkMode:'online'` (default, sem override) a query fica
  `fetchStatus:'paused'`/`status:'pending'`: `isLoading` (v5 = `isPending && isFetching`) é **false**,
  `data` `undefined`, `error` `null` ⇒ cai em `semAcesso`, some da tela e **não emite**. Num PWA de
  campo esse não é o caso raro. As duas análises (Codex e a minha, escrita antes de abrir o parecer)
  chegaram nele por caminhos separados. **Medido** (vitest, `onlineManager.setOnline(false)`,
  exit 0): tela `''` e **zero** eventos. No mesmo arquivo, o cenário de refetch-que-falha-com-cache
  renderiza a lista normalmente antes de falhar — é o controle que descarta "mock quebrado" como
  causa do vazio.
- **O erro tem precedência sobre o dado stale, e isso custa a lista.** Medido no mesmo par: com
  `com_gap` já na tela, um refetch que falha leva a `erro` e a lista de oportunidades **some**
  (`listaAindaNaTela=false`), embora o cache ainda a tenha. Honesto para o sensor, regressão para o
  vendedor em campo — o desenho que serve aos dois é um estado composto (lista + aviso de
  desatualizada), não a escolha entre um e outro.
- **A dedup por estado não reseta na troca de sujeito.** `trackedEstado` sobrevive à mudança de
  `effectiveUserId` ("Ver como"): alvo diferente com o mesmo estado não emite — e a 1ª emissão não
  marca que era impersonação, então o denominador de adoção conta staff como vendedor.
- **Severidade herdada, de novo.** O parecer marcou `coverage ?? []` (4/4 consumidores de
  `useMyActiveCoverage`, nenhum lendo `error`) como CRÍTICO. Medido em prod: `carteira_coverage` tem
  **0 linhas** ⇒ dano hoje **zero**. Vira MÉDIO **com gatilho**: corrigir antes do primeiro cadastro,
  porque depois some em silêncio. Mesma lição do parágrafo acima, agora aplicada ao parecer que revisa
  o PR que a escreveu.

Denominador do card: `commercial_roles` = **3 vendedores**. Com n=3 o argumento do sensor fica mais
forte, não mais fraco — um evento perdido é um terço da série.

## A CLASSE, varrida e gateada (2026-08-22) — de instância a assinatura

A revisão retroativa acima descreveu o defeito do MixGap como padrão. Esta entrada é a
erradicação: assinatura calibrada, varredura completa, corte por dano medido e gate.

**A assinatura teve de virar AST.** A primeira tentativa foi textual e mentiu nos dois
sentidos. Falso NEGATIVO: perguntar "o arquivo trata erro?" com grep de `error` casa
`text-status-error` do Tailwind — e esconde justamente os piores casos. Falso negativo nº2:
o silêncio quase nunca pendura no alias cru, e sim numa **derivada** (`const check =
data?.find(...)` → `if (!check) return null`), que foi como o `DataHealthBanner` escapou da
1ª varredura. A assinatura final é estrutural — *a desestruturação liga `error`?* — com
propagação de taint por ponto fixo, e está calibrada contra o par pré/pós-fix do #1859: casa
o pré, não casa o pós (`src/lib/gates/erro-colapsado-em-vazio.ts`).

**Duas formas, dano bem diferente** (1.456 fontes varridas):

| forma | sítios | o que o usuário vê na falha |
|---|---|---|
| **auto-ocultação** — `return null` guardado pela leitura | **46** (36 arquivos) | o componente inteiro some sem rastro |
| `{data && <X/>}` | 93 | some um trecho; a página continua na tela |
| default no binding (`data: x = []`) | 86 | o vazio afirma "não há" |

O 94º sítio de `jsx-&&` foi o **host** que escondia o card do #1859 — corrigido nesta mesma
leva, e é por isso que a contagem fecha em 93.

Só a primeira entrou no gate. As outras duas estão medidas e nomeadas: gatear `jsx-&&`
faria a baseline crescer por motivo benigno em idioma legítimo, e baseline que cresce por
motivo benigno ensina a atualizá-la no automático — que é como um gate morre.

**O corte saiu por dano MEDIDO em prod, não por severidade herdada** (a mesma lição que a
seção anterior aprendeu, agora aplicada ao próprio parecer que a escreveu):

| alvo | denominador (psql-ro, 2026-08-22) | veredito |
|---|---|---|
| `AlertasStack` (fluxo de caixa) | **14 alertas vivos, 2 CRÍTICOS**, nas 3 empresas | corrigido agora |
| `DataHealthBanner` (financeiro + cockpit de reposição) | os 3 `source` montados existem em `_data_health_compute` ⇒ `!check` hoje **é** falha de leitura | corrigido agora |
| `CarteiraSaudePanel` (gêmeo exato do #1859) | 3 vendedores em `commercial_roles`; evento `carteira.saude_vista` só saía COM data | corrigido agora |
| `CoveragePanel` + 4 consumidores de `useMyActiveCoverage` | `carteira_coverage` = **0 linhas** | dano hoje ZERO → chip com gatilho — **quitado na leva seguinte** (ver abaixo) |

O `DataHealthBanner` merece nota à parte: o padrão correto estava **20 linhas ao lado o
tempo todo**. `DataHealthBadge` faz `isError ? 'red' : badgeLevel(data ?? [])` — fail-closed.
O banner, MESMO hook, fazia `const { data } = useDataHealth()` e desaparecia da tela
financeira. A classe não é falta de conhecimento no repo; é falta de *fiscal*.

**O quarto estado virou teste.** O offline (`pending` + `paused`: `isLoading` FALSE, `data`
undefined, `error` null) tinha sido MEDIDO no #1874 e registrado só como nota. Agora é
guarda permanente, nos três componentes e na tabela exaustiva de `estadoDeLeitura` — as 9
combinações de `status × fetchStatus` têm nome, porque estado sem nome colapsa no vizinho.

### O IRMÃO da classe: ausente degradado para VAZIO (2026-08-22, leva seguinte)

A varredura acima mira "erro vira silêncio" (`data` undefined → `return null`). O irmão é a
mesma colisão na direção oposta: **`data` undefined vira `[]`**, e a tela segue renderizando —
completa por fora, incompleta por dentro. `useMyActiveCoverage` LANÇA quando o SELECT falha, e
os quatro consumidores faziam `(coverage ?? []).map(...)` sem ler `error`; o efeito é
`ownerIds = [eu]`, com a carteira COBERTA sumindo de sugestões de visita, scores, plano tático
e copilot. Nada quebra, nada avisa: o vendedor vê uma carteira menor e plausível.

A correção não foi espalhar `estadoDeLeitura` por quatro arquivos, e sim criar **uma costura
só** — `useCarteirasQueEuCubro()`, que devolve os ids **e** `coberturaIndisponivel`. `coveredIds`
segue degradando para `[]` de propósito (a MINHA carteira continua verdade, e derrubar a tela
tiraria do vendedor em campo o que ele tem); o que mudou é que a ausência agora viaja
ACOMPANHADA do motivo, e as telas falam.

**Dois achados que sobrevivem a este PR:**

1. **O gate NÃO enxerga esta sub-forma, e isso é estrutural.** `acharColapsos` só registra o
   sítio quando há default no destructuring (`{ data = [] }`) ou silêncio (`return null`).
   `const { data: coverage } = useX()` seguido de `(coverage ?? []).map(...)` **na linha de
   baixo** não tem nenhum dos dois: 2 dos 4 consumidores eram invisíveis ao contador, e só
   apareceram porque a leitura humana foi ao consumidor, não ao relatório. Gate mede a forma
   que sabe medir — a fatia que ele cala não é fatia limpa.

2. **A medição que impediu uma correção INERTE.** O chip listava `UnifiedOrder.tsx:255-256`
   (`num_itens`/`valor_total` com `?? 0`) como o mesmo defeito. Aplicando o próprio aviso do
   money-path §2 — *meça se a ausência chega COMO null antes de trocar* — `lastOrderData` é
   construído LOCALMENTE em TS (`items` de um `.map`, `total` de uma soma), nunca atravessa a
   rede: os campos não podem faltar, e o `?? 0` ali é defesa morta. Trocar teria produzido um
   diff plausível, um item a mais no PR e zero mudança de comportamento — *fix* inerte é
   indistinguível de *fix* real no relatório, e só a medição separa os dois. O sítio de fato
   nulo era outro (`churn_risk: number | null` na telemetria de `ClientesAPositivarCard`), e
   esse foi corrigido. **A lista do chip é hipótese; o tipo e a origem do dado é que decidem.**

## O alarme que se apaga por ser olhado (gatilho da fase 2 do Farmer, 2026-08-21)

`db/gatilho-farmer-fase2.sql` existe para impedir que a fase 2 seja aberta sem denominador. Ele
cometeu a própria falha que vigia — **uma camada acima, sobre PESSOAS em vez de linhas.**

O veredito `ESTAGNADO` foi escrito com todas as letras para dizer *"aguardar não produz sinal
quando a superfície não está em uso"*. Mas a condição implementada era **temporal**:
`exec_7d = 0`. E verificar o sensor **é uma execução**. Quem abre a tela para conferir renova
`exec_7d`, derruba o veredito para `AGUARDE` ("o sinal está vindo") e apaga o alarme — **justo
quando alguém foi olhar.** Um sensor que se cala ao ser observado não relata: ele consola.

Medido em 21/08 (prod, `psql-ro`), depois de a época descartar o período contaminado:

| o que o gatilho dizia | o que o dado dizia |
|---|---|
| `AGUARDE — 3/20 julgaveis, 3 execucoes nos ultimos 7 dias` | as **14** execuções que existem na tabela são de **1 farmer só** — o founder, verificando |
| `1/3 farmers com carteira ja executaram` (no texto, sem efeito no veredito) | os outros 2 **nunca** abriram a tela |
| — | excluindo o founder, o gatilho devolve **`SEM DENOMINADOR`**: adoção real = **zero**, não "baixa" |

E o defeito latente era pior que o cosmético: **`ENCERRE` ficava ACIMA de qualquer checagem de
ator.** Com 20 julgáveis, ele afirma *"o vazio-de-verdade não acontece neste motor — encerre a
linha"*. O executor único já havia produzido **14 dos 20**: seis cliques a mais e o gatilho
encerraria uma linha de produto com **n=1**, e com a autoridade de quem mostra denominador.

### A regra que isto acrescenta

1. **Um denominador de adoção tem de excluir — ou no mínimo NOMEAR — o rastro de quem verifica.**
   Quem mede faz parte do que é medido; sem separar os dois, o sensor lê a própria pegada como uso.
   Detecção que não depende de saber *quem* é o verificador: `farmers = 1` enquanto
   `farmers_com_carteira > 1` já basta — **um ator não é população**, seja ele quem for.
2. **Afirmação UNIVERSAL exige amostra populacional; EXISTENCIAL não.** `ENCERRE` ("não acontece")
   precisa e por isso passou a ficar **abaixo** do corte de ator único; `DECIDA` ("aconteceu ao
   menos uma vez") não precisa e continua **acima** — amostra enviesada derruba o universal, nunca
   o existencial. Rebaixar os dois juntos seria trocar um erro por outro.
3. **Reportar o fato não é o mesmo que poder concluir sobre ele.** `farmers` e
   `farmers_com_carteira` já saíam na linha — o comentário do código até nomeava a adoção. Faltava
   o veredito **agir**. Sensor que enxerga e não decide adia o erro para o leitor, e o leitor lê a
   palavra em caixa alta, não a coluna.

Ramo `MONOUSUARIO` + prova executável em `db/test-gatilho-farmer-fase2.sh` (9 asserts, com
falsificação: sem o ramo, o caso de 20-de-1-ator vira `ENCERRE`).

**Lição de método:** o teste reprovou o **caso 5** e o defeito estava na *fixture*, não no fix — eu
tinha suposto a forma de um "vazio julgável" em vez de lê-la (`scores.n > 0` **e** `vendaveis.n > 0`
**e** a cobertura declarada). O teste barato pagou-se antes de existir PR: sem ele, eu teria
entregue um ramo que atropelava a existência e só descobriria isso quando o primeiro vazio real
chegasse — e aí ele viria mudo.

## Quarto estado do MixGap: OFFLINE (2026-08-22) — e a sabotagem que ficou VERDE

> Continuação da seção "Revisão independente RETROATIVA" acima. Fica aqui no fim, e não lá,
> porque o #1886 (a mesma classe, varrida e gateada) insere no mesmo ponto do arquivo —
> hunk vizinho entre worktrees paralelas é conflito garantido.

`MixGapCard` passou a discriminar por `fetchStatus`, não por `isLoading`: `data === undefined` é
pendente, pausado OU desabilitado; só `data === null` é a RPC dizendo "sem acesso". Offline virou
estado próprio (`aguardando_rede`, tela de conexão) e **emite** evento com `total_com_gap: null` —
não emitir recriaria o buraco do #1859 ("offline" indistinguível de "nunca abriu"), e emitir não
contamina o denominador porque adoção se calcula sobre os estados com número honesto
(`com_gap`/`zero`), como já era preciso com `erro`. O que segue MUDO é `semAcesso`. O erro deixou de
ter precedência sobre o cache: com dado, a lista fica na tela + faixa de aviso e o evento leva
`desatualizado: 'erro' | 'sem_rede'` (a dedup passou a ser por `estado:motivo`, senão engoliria a
transição "número fresco" → "número velho", que é o sinal de leitura falhando em campo).

**A lição durável está na falsificação que ficou VERDE.** Sabotar a precedência `pausado`-antes-de
-`error` no ramo SEM dado não derrubou teste nenhum. Não era teste fraco: era o mecanismo que eu
tinha descrito errado. `fetchState` (query-core, `query.ts`) zera `error`/`status` ao iniciar um
fetch **apenas quando `data === undefined`** ⇒ sem dado, erro e pausa **nunca coexistem** (a ordem
ali é inócua), e só COM dado no cache eles se sobrepõem — que é onde a precedência decide algo. O
comentário do código afirmava um conflito inexistente e o teste passava por não discriminar nada.
⇒ **sabotagem que não fica vermelha é achado, não aprovação**: ou o assert não mede o que diz, ou o
mecanismo é outro. Investigue o mecanismo antes de aceitar o verde — foi o que produziu o único
teste que mede a precedência de verdade (erro no cache + rede caindo depois).

### Consolidação (2026-08-22, pós-merge do #1886): o card deixou de ter metade artesanal

O #1886 (varredura da CLASSE) e o #1892 (o quarto estado) atacaram o mesmo defeito em paralelo e
não colidiram em código — o que deixou o `MixGapCard` como **único** consumidor derivando na mão o
que já era canônico em `src/lib/leitura/estado-de-leitura.ts`. Trocado: `estadoDeLeitura({status,
fetchStatus})` no lugar de `isPending`/`fetchStatus`/`error` soltos, e `desatualizado(q, temDado)`
no lugar do ternário local. Os 15 testes de `MixGapCard.estados.test.tsx` passaram **sem edição** —
que é a asserção que importa: teste que precisa mudar num refactor de consolidação está medindo a
implementação, não o comportamento.

Duas coisas ficaram LOCAIS de propósito, e a fronteira é a lição:

- **`data === null` ("não é staff") não é estado de leitura** — é a resposta da RPC. Subir isso para
  o helper misturaria "a leitura não aconteceu" com "a leitura aconteceu e disse não", que é
  exatamente o par que o #1859 colapsou. Continua com precedência sobre tudo no card.
- **`'sem-rede'` (helper) ≠ `'sem_rede'` (PostHog).** A série já tem a chave com underscore gravada
  desde o #1892; renomear partiria o histórico do evento em duas séries que ninguém soma depois. A
  tradução mora na fronteira da telemetria, num mapa `satisfies Record<EstadoSemLeitura, string>` —
  o `satisfies` é o que a faz **falhar a compilação** se o helper ganhar um terceiro estado, em vez
  de mandar `undefined` para o PostHog.

**Complemento (mesmo dia, sessão paralela): o `satisfies` protege o MAPA, não a FRONTEIRA.**
`MOTIVO_NA_SERIE` falha a compilação se o helper ganhar um estado novo — mas não tem como impedir
que alguém mande o estado do helper ao PostHog **por fora dele** (`track(…, { …, leitura })`). E
essa rota não acende nenhuma das defesas de sempre: a tela não muda, e `track(event,
Record<string, unknown>)` não tipa payload, então o `tsc` fica verde.

Os 15 testes do card também não pegam, e isso foi MEDIDO por falsificação sobre o card já
consolidado: acrescentando `leitura` ao payload, **15 verdes, 0 vermelhos** — porque eles usam
`toMatchObject`, que ignora chave EXTRA. "Os testes passaram sem edição" prova que o refactor
preservou comportamento; **não** prova que o literal está preso.

O que prende é um assert MECÂNICO sobre o payload inteiro — *nenhum valor string do evento contém
hífen* —, porque o vocabulário da leitura é hifenizado e o da série nunca é. Ele vale para o
literal que ainda não foi inventado, que é justamente o que uma allowlist de valores conhecidos
não cobre. Vive em `MixGapCard.estados.test.tsx`, describe "o alfabeto do evento não muda por
refactor".

⚠️ **O que manteve o arquivo fora do gate `erro-colapsado-em-vazio` foi acidente feliz, e vale saber
por quê:** o gate exige que a desestruturação do hook ligue alguma de `{error, isError, …, status}`.
A versão antiga passava por causa do `error`; a nova passa por causa do **`status`**, que o helper
exige. Se a consolidação tivesse escondido a fatia atrás de um objeto (`const q = {...}` fora da
desestruturação), o gate voltaria a acusar o card — corretamente, porque a estrutura que ele lê é a
desestruturação. Verificado com falsificação: removendo `status` da desestruturação,
`contarAutoOcultacao` sobe de **0 para 1**. Gate que não foi falsificado no arquivo em questão é
contagem, não prova.

## O que sobra quando a correção mergeia por outra sessão (2026-08-22): o sensor e o guard

O achado retroativo do #1859 (seção acima) virou DUAS entregas paralelas no mesmo dia, em sessões
diferentes. O #1886 varreu a classe e mergeou: `estadoDeLeitura` (exaustivo sobre
`status × fetchStatus`, com o offline nomeado), `AvisoLeituraFalhou` em 4 telas, gate com parser TS
que reconhece `return-null`/`ternario-null`/`jsx-&&`, e o `<MixGapCard />` fora do `&&`.

**A regra que isto acrescenta: consertar o que a tela MOSTRA não conserta o que ela MEDE — e o
segundo não tem gate estrutural que o pegue.** Depois do #1886 em produção, o
`carteira.positivacao_vista` continuava dentro do `PositivacaoHero`, isto é, só no ramo de sucesso:
falha de leitura e falta de rede seguiam emitindo NADA. A tela ficou honesta e a série continuou
mentindo por omissão, que é a forma mais cara — "no ar e ninguém reclamou" sobre um denominador que
não existe. Renderizar e medir são trabalhos diferentes; por isso o sensor virou **hook**
(`useSinalPositivacao`) e não mais um componente de estado, que teria duplicado a camada de render
do #1886. Corolário prático: ao varrer uma classe de "leitura que falha calada", varra os DOIS
consumidores da leitura — o JSX e o `track()`.

**E o gate estrutural não substitui o teste de host.** O gate do #1886 pega a FORMA `{x && <Card/>}`
quando o hook é desestruturado sem `error`. Esconder o card atrás de uma condição nova que
desestruture `error` (`{!erroPositivacao && <MixGapCard/>}`) passa verde no gate e reintroduz o
defeito. Um é sintático e barato de varrer o repo inteiro; o outro é comportamental e prova o que a
tela faz. O #1886 mudou `FarmerCalls.tsx` sem nenhum teste que MONTE `FarmerCalls`.

### Três coisas que a verificação pegou e que valem mais que o patch

- **Sabotagem que não muda nada nem sempre acusa asserção inerte — pode ser o RAMO que é inerte.**
  Ao falsificar o tratamento de offline, o número de falhas não mudou. A leitura óbvia ("o teste não
  testa isso") estava errada: o teste testava, e o furo era que eu havia derivado `estado` para o
  EVENTO deixando os guards de RENDER lendo `isLoading`/`error` crus. O ramo offline existia no
  sensor e não na tela. **Duas derivações do mesmo estado divergem no primeiro caso de borda** — e o
  de borda era exatamente o que eu tinha acabado de acrescentar. Cura: uma fonte de verdade só, e a
  porta do ramo de sucesso exigindo o dado (`if (data)`, sem `!`), para que o crash deixe de ser
  representável em vez de depender de eu ter derivado certo.
- **Suíte vermelha sob máquina saturada não é sinal.** 10 arquivos "falharam" com load 99 — todos
  timeout de 20s, nenhum defeito. Concluir "são pré-existentes, não são meus" porque a mensagem não
  cita meus arquivos teria ACERTADO PELO MOTIVO ERRADO. Com `--testTimeout` folgado: 718/718 verde.
  (O gate do manifesto era o pior caso, e foi consertado em paralelo pelo #1893.)
- **Re-medir contra a `origin/main` do INSTANTE, não contra a base do ramo.** Entre o começo e o fim
  desta entrega a main ganhou 12 commits, dois deles exatamente sobre os arquivos em questão. Metade
  do que estava pronto e verificado virou descarte — corretamente. O tell barato: `git diff
  origin/main --stat` acusando arquivos que você nunca tocou.

## A leitura do sensor do MixGap (2026-08-22): não havia população exposta para ler

> Continuação das duas seções acima (quarto estado + o sensor que sobrou do #1886). O chip
> pedia a leitura que este arquivo existe para cobrar:
> a série de `carteira.mixgap_visto` por `estado` e por `desatualizado` desde o Publish —
> em especial se `aguardando_rede` e `desatualizado != null` ocorrem em campo, já que a
> correção do #1892 foi feita sobre uma hipótese de PWA de vendedor na rua nunca observada.
>
> **A série continua NÃO LIDA.** O que mudou é que agora se sabe por quê, e a resposta não
> era nenhuma das três hipóteses previstas.

### 1. O acesso ao PostHog não existia na sessão — e isso não é a resposta

Quatro vias, todas fechadas, todas verificadas por evidência positiva e não por suposição:

| via | verificação | resultado |
|---|---|---|
| MCP/plugin PostHog | `.claude/settings.json`; `ListPlugins`; busca de ferramenta | `"posthog@claude-plugins-official": false`; lista vazia; nenhuma tool `mcp__posthog__*` |
| Personal API Key (`phx_…`) | `.env` do worktree e do repo principal, env vars, `~/.config/afiacao/`, `~/.config/posthog` | inexistente. Só `VITE_POSTHOG_KEY` (`phc_…`), que é de **ingestão** — escreve, não consulta |
| navegador logado | `/browse` headless e o Chrome real | ambos redirigem `/sql` → `/login`; nenhuma sessão ativa |
| espelho no banco | `information_schema` via `psql-ro` | nenhuma tabela replica eventos `carteira.*` (`posthog_error_webhook_log` é do webhook de erro de e-mail) |

**Ausência de acesso não é ausência de eventos.** Nada aqui autoriza dizer que a série está
vazia — inclusive porque há motivo para ela **não** estar (item 4).

### 2. O que dava para medir sem o PostHog — e que reenquadra a pergunta

O Publish **saiu**. Varredura por bytes do bundle de produção (`verify-bundle-multi.sh`,
333 chunks, 6.132.861 bytes, closure do Vite ∪ precache do Workbox):

```
carteira.mixgap_visto         1  FarmerCalls-CmLY9tuD.js
aguardando_rede               1  FarmerCalls-CmLY9tuD.js     <- exclusivo do #1892
sem_rede                      1  FarmerCalls-CmLY9tuD.js     <- exclusivo do #1892
Oportunidades de cross-sell   1  (controle POSITIVO)
zzz_controle_negativo_9f3     0  (controle NEGATIVO)
```

E as outras duas hipóteses de "sensor não chegando" também caem: **o PostHog inicializa**
(1 chave `phc_` distinta embutida no bundle + `us.i.posthog.com` no chunk `index`; o gate de
`analytics.ts` só desliga sem `KEY` ou em DEV) e **o card monta** (`FarmerCalls.tsx:440`).

E o card monta **fora** do `&&` do host: a correção do #1886 (merge 19:39 BRT) entrou no mesmo
Publish — a string exclusiva dela (`"Sem conexão — não foi possível verificar "`, de
`AvisoLeituraFalhou.tsx`) está no bundle ao lado da do #1892. Ou seja, nem o gate do host
suprime a emissão. O que **não** está publicado é o #1896 (merge 21:56 BRT, depois desta
varredura) — irrelevante para `mixgap_visto`, que ele não toca.

### 3. O denominador do chip estava errado — e o erro é do tipo que infla adoção

O chip dizia "`commercial_roles` tem 3 vendedores". O gate real não é esse. Quem a RPC atende:

```sql
IF NOT (has_role(uid,'master') OR has_role(uid,'employee')) THEN RETURN NULL; END IF;
```

`commercial_role` (`farmer`/gestor) é **ortogonal** ao `app_role` que abre a porta. A população
que pode ver o card é **2 `employee` + 1 `master`** — não três vendedores. O número bateu por
coincidência; a composição, não. Denominador tirado da tabela de papel comercial mede outra
população que não a da tela.

### 4. A medição que responde ao chip: a exposição é de UMA pessoa, e é o founder

| papel | última sessão | sessões desde o merge do #1892 | desde o #1859 |
|---|---|---|---|
| master (founder) | 2026-08-22 21:56 (agora) | 2 | 4 |
| employee A | 2026-08-14 14:03 (8 dias) | **0** | **0** |
| employee B | (nenhuma sessão VIVA — ver correção 2026-08-23) | **0** | **0** |

O #1892 mergeou às 19:12 BRT de sábado; o Publish saiu entre 19:12 e 20:31 BRT. Na janela
inteira, a única pessoa que abriu o app foi quem escreveu o código. **`aguardando_rede` é
hipótese de vendedor na rua — e nenhum vendedor abre o app há 8+ dias.**

Daí o desfecho: é o caso (c) — sensor não chegando — mas por uma causa que não estava na lista
("Publish não saiu" / "PostHog não inicializou" / "vendedor não abriu a tela"). Os três foram
descartados por medição. O que resta é mais fundo: **não há população exposta ao sensor.**

### 5. A regra que isto acrescenta

**Antes de LER a série, prove que houve população exposta na janela.** Sensor instalado não é
sensor legível: sem exposição, a série vazia é indistinguível de "o estado não ocorre" — e ler
essa série como evidência cometeria o erro deste arquivo uma casa adiante, agora com a
autoridade de um número. O "quando medir" que o arquivo já exigia como query precisa de um
segundo termo: **quando medir E sobre quem** — e o denominador vem do gate que serve a tela,
não da tabela que o nome do papel sugere.

Corolário para o MixGap: a fase N+1 não é ler o PostHog. É descobrir por que dois `employee`
não abrem o app — um deles nunca.[^corr] Um sensor sobre população inerte é a versão de telemetria
do fusível que nunca foi ligado (o piloto Sayerlack, no topo deste arquivo).

[^corr]: **Corrigido em 2026-08-23:** o "nunca" era leitura de `auth.sessions`, que é fotografia do vivo e não histórico. A employee B logou em **2026-04-13** (`last_sign_in_at`) e a sessão dela expirou. Ver a seção final deste arquivo.

### 6. A armadilha de medição que quase inverteu a conclusão

`auth.users.last_sign_in_at` dava **4 meses** para os dois `employee` (abr/2026) — leitura que
sustentaria "ninguém nunca usou". `auth.sessions.updated_at` deu **8 dias** para um deles.
As duas medem coisas diferentes: `last_sign_in_at` só se move em **login novo**, e não em
refresh de token — quem fica logado no PWA usa o app por meses sem tocá-la. Sozinha, ela é
**ausência de dado** vestida de data. A conclusão do item 4 só é afirmável porque duas fontes
independentes foram cruzadas, e a segunda mudou o número.

(`dashboard_visits`, a tabela criada em 2026-05-17 justamente para registrar visita
server-side, tem **0 linhas** — mais um sensor desta família que nunca chegou a medir.)

### 7. A query, para quando houver exposição

Rodar no PostHog (SQL insight) quando ≥1 `employee` tiver sessão posterior ao Publish:

```sql
SELECT properties.estado          AS estado,
       properties.desatualizado   AS desatualizado,
       count()                    AS n,
       count(DISTINCT person_id)  AS pessoas
FROM events
WHERE event = 'carteira.mixgap_visto'
  AND timestamp > toDateTime('2026-08-22 22:12:36')
GROUP BY estado, desatualizado
ORDER BY n DESC
```

O controle que separa (b) de (c) vai junto, na mesma leitura: `SELECT count() FROM events
WHERE timestamp > …` sem filtro de evento. Série do evento vazia **com** o controle positivo
é dado real; as duas vazias é sensor não chegando — a distinção que o item 1 não pôde fazer.


---

## O zero da employee B não era conta morta — era sessão expirada (2026-08-23)

O item 4 acima registrou "employee B — (nenhuma sessão jamais)" e o item 5 tirou dali a fase N+1:
*"descobrir por que dois `employee` não abrem o app — um deles nunca"*. O **"nunca" está errado**, e
o erro é da mesma família das outras sete casas deste arquivo: uma tabela foi lida como histórico
quando é fotografia.

### 1. A hipótese morreu na primeira fronteira

A suspeita era defeito de onboarding — convite não entregue, `profiles` ausente, `is_approved`
falso. Instrumentando cada fronteira (`auth.users` → `profiles` → `user_roles` → sessão), a
hipótese caiu antes da segunda:

| fronteira | employee B (`atendimentocolacor@gmail.com`) | veredito |
|---|---|---|
| `confirmation_sent_at` | 2026-04-10 11:04:53 | e-mail SAIU |
| `confirmed_at` / `email_confirmed_at` | 2026-04-10 11:05:42 | clicou **49s depois** |
| `encrypted_password` | definida | ✓ |
| `banned_until` / `deleted_at` | nulos | ✓ |
| `profiles` (por `user_id`) | existe, criado 2026-04-10 | ✓ |
| `is_approved` / `is_employee` | `t` / `t` | ✓ |
| `user_roles.role` | `employee` | ✓ (passa no gate da `get_meu_mixgap`) |
| `auth.identities` | 1, provider `email` | ✓ |
| **`last_sign_in_at`** | **2026-04-13 13:51:09** | **ela LOGOU** |
| `recovery_sent_at` | **NULL** | nunca pediu recuperação de senha |
| `auth.sessions` / `auth.refresh_tokens` | 0 / 0 | sessão encerrada e podada |

**Não há defeito, e portanto não há SQL de correção.** A conta foi provisionada, o e-mail chegou,
ela confirmou em 49 segundos, logou 3 dias depois e nunca mais voltou — nem tentou, já que
`recovery_sent_at` é nulo nos três usuários. Escrever um `UPDATE` "de conserto" aqui seria
fabricar reparo para máquina inteira: a correção mais cara deste arquivo é a que conserta o que
não está quebrado e declara o problema resolvido.

### 2. A armadilha nova: `auth.sessions` é fotografia do VIVO, não histórico

Sessão que expira ou faz logout é **apagada**, e leva os `refresh_tokens` junto por cascade. Zero
linhas significa "nenhuma sessão viva agora" — não distingue *nunca logou* de *logou e expirou*.

O par de armadilhas erra para **lados opostos**, e é por isso que nenhuma das duas é medida de uso
sozinha:

| coluna | erra para | por quê |
|---|---|---|
| `auth.users.last_sign_in_at` | **subestima** uso | só se move em login NOVO; PWA persistente usa meses sem tocá-la |
| `count(auth.sessions)` | **superestima** inatividade | a sessão encerrada não deixa rastro nenhum |

A leitura conjunta correta: `last_sign_in_at` responde **"logou alguma vez?"** (é piso — não-nulo
⇒ logou, naquela data); `auth.refresh_tokens.created_at` responde **"com que frequência?"**.
`auth.sessions` não responde nem uma nem outra: ela só diz quem está logado neste instante.

### 3. Três ausências de dado que quase viraram veredito

Todas foram pegas pelo mesmo movimento — aplicar o predicado ao **founder**, que comprovadamente
usa o app, e exigir que ele desse positivo:

1. **`profiles` liga por `user_id`, não por `id`.** O join ingênuo (`p.id = ur.user_id`) devolveu
   "nenhum dos 3 tem profiles" — *incluindo o master que abre o app todo dia*. Foi o controle que
   denunciou; sem ele, o falso-negativo teria virado o defeito de onboarding procurado.
2. **`auth.audit_log_entries` tem 0 linhas no total.** A fonte autoritativa de histórico de login
   não existe neste projeto. Consultada por usuário devolve zero, que lê como "nenhum evento" e é
   "nenhum conteúdo". Só o `count(*)` sem filtro separa os dois.
3. **`sales_orders.created_by` não é uso do app.** A employee A tem 29.095 linhas — que começam em
   **2020-06-22**, anos antes de o app existir: é atribuição de venda vinda do Omie. O
   discriminador é `origem`, e ele é brutal: `origem='web_staff'` (pedido nascido no app) tem
   **2 linhas em 30.979** — uma da employee A (13/06) e uma do founder (08/08). Ler as 29 mil como
   adoção inverteria a conclusão do arquivo inteiro.

O `count(*)` sem filtro ao lado de todo count filtrado deixou de ser zelo e virou o formato padrão
da medição: **tabela morta e usuária inerte produzem o mesmo zero.**

### 4. O denominador honesto da employee A

`auth.refresh_tokens.created_at` é a melhor trilha de uso que o banco tem: uma linha por refresh de
JWT, que só acontece com o cliente **aberto**. A leitura foi verificada duas vezes antes de virar
número:

- **cadência** — os 5 tokens de 22/04 estão em 11:11, 12:17, 13:14, 15:11, 17:34: ~1h de distância,
  a assinatura de app aberto ao longo de um dia de trabalho, não de um evento automático;
- **completude** — o primeiro token nasce **32ms** depois do `created_at` da sessão, então a cadeia
  está inteira desde o início e a contagem é registro completo, não piso.

| mês | dias com o app aberto |
|---|---|
| abr (a partir do dia 15) | 3 — dias 15, 17 e 22 (10 refreshes) |
| mai | 1 — dia 28 |
| jun | 3 — dias 12, 17 e 23 |
| **jul** | **0** |
| ago | 1 — dia 14 |

**8 dias em 122.** E o formato importa mais que o total: abril foi tentativa real (dia 22 ela ficou
com o app aberto das 11h às 17h34), e o que veio depois é **decaimento**, não recusa. A pergunta
para ela não é "por que você não usa" — é "o que parou de valer a pena".

### 5. A regra que isto acrescenta

O item 5 pediu população exposta antes de ler a série. Este item diz **com que régua** se mede a
exposição:

> **Nenhuma tabela de sessão mede adoção.** `auth.sessions` é estado presente, `last_sign_in_at` é
> um piso, e as duas erram para lados opostos. Antes de afirmar "nunca usou", exija a coluna que
> só se move com um login que aconteceu de fato — e antes de afirmar "usa", exija a trilha que só
> se move com o cliente aberto.

Corolário para este caso: o app não tem um problema de contas quebradas. Tem **duas vendedoras que
o experimentaram e o abandonaram**, uma depois de 8 dias de uso espalhados por 4 meses, outra
depois de um único login. Toda telemetria instalada nas telas de carteira continua ilegível — mas
agora por uma causa nomeada, que não se conserta com SQL.

*(Observação estrutural, não defeito: a conta da employee B é `atendimentocolacor@gmail.com` — a
caixa **compartilhada** de atendimento, com o nome pessoal dela no `profiles`. Conta de função não
tem dono; é candidata natural a ninguém sentir que é sua. Vale conferir com o founder antes de
tratar como conta individual.)*

---

## A série do MixGap era LEGÍVEL — e ninguém tinha como ler (2026-08-23)

O §7 do topo deixou uma query "para quando houver exposição". Ao tentar rodá-la descobriu-se algo
anterior: **não havia via de leitura nenhuma.** As quatro foram medidas e as quatro estavam fechadas
— plugin PostHog desabilitado em `.claude/settings.json`, nenhuma Personal API Key em lugar algum,
navegador (headless e real) caindo em `/login`, e nenhum espelho de `carteira.*` no banco.
`VITE_POSTHOG_KEY` existe, mas é `phc_` — chave **pública de ingestão**, que escreve evento e não
consulta.

Isto é mais grave que uma pendência de medição: **a regra deste arquivo era incumprível por
construção.** O repo instalava sensor (`carteira.mixgap_visto`, `carteira.positivacao_vista`,
`dashboard.*`, `offline.*`) sem que ninguém pudesse lê-lo. "Quando medir é query, não recado" só
vale se a query for executável.

A via foi construída (`scripts/posthog-query.sh` + Personal API Key read-only 0600; detalhe em
[docs/agent/analytics.md](../agent/analytics.md)) e as queries rodaram:

| leitura | resultado |
|---|---|
| sanidade — `count()` de eventos em 30d | **699** |
| **série** de `carteira.mixgap_visto` desde o Publish do #1892 | **vazia** (0 linhas) |
| **controle** — mesma janela, sem filtro de evento | **11 eventos, 1 pessoa** |

### 1. O controle positivo não bastava — quem decidiu foi o IRMÃO

Série vazia **com controle positivo** é, pela regra do §7, dado real. Mas o controle sozinho é fraco:
prova que *alguma* telemetria chega, não que chegaria *deste* sensor. A prova forte veio de um
terceiro eixo — o **irmão na mesma superfície**:

- `carteira.positivacao_vista` chegou ao PostHog **3×** em 90 dias (última: `2026-08-14T17:03:20Z`);
- `carteira.mixgap_visto` **nunca** chegou — zero em 90 dias;
- os dois montam na **mesma página**, `src/pages/FarmerCalls.tsx` (`PositivacaoHero` e `MixGapCard`).

Logo o caminho evento→PostHog está provado **para esta tela**, e a série vazia não pode ser falha de
transporte. Some-se que os 11 eventos da janela são só `$autocapture`/`$pageview`/`$pageleave`/`$set`
— **nenhum evento custom**: a única pessoa ativa depois do Publish nunca abriu a FarmerCalls.

### 2. Terceira fonte independente para o denominador da employee A

A seção anterior deste arquivo estabeleceu, por `auth.refresh_tokens`, que agosto da employee A foi
**1 dia — o dia 14**. A telemetria, medida sem conhecer aquele número, põe o último
`carteira.positivacao_vista` em `2026-08-14T17:03:20Z`.

São **três** trilhas independentes convergindo no mesmo dia: `auth.sessions` (§6 do topo),
`auth.refresh_tokens` (seção anterior) e PostHog. E a convergência tem valor além da confirmação:
a seção anterior mostrou que `auth.sessions` **superestima inatividade** e `last_sign_in_at`
**subestima uso** — a telemetria de produto não tem nenhum dos dois vieses, porque só existe se
alguém renderizou a tela. É a única das três que mede **exposição ao sensor**, que é exatamente o
denominador que o §5 do topo pediu.

O que ela acrescenta ao caso do MixGap: o dia 14 é **8 dias ANTES** do Publish do #1892. A employee A
nunca teve como ver o card.

### 3. Achado lateral: o sensor de dashboard tem os dois lados desencontrados

`dashboard.viewed` disparou **8×** (1 pessoa) em 30 dias, enquanto `dashboard_visits` — a tabela
criada em 2026-05-17 justamente para registrar visita server-side — segue com **0 linhas**
(reconfirmado via `psql-ro`). O sensor client-side funciona; o server-side nunca foi ligado. O §6 do
topo registrava a tabela vazia como "mais um sensor que nunca mediu"; agora sabe-se que a visita
**ocorre** e só o registro server-side falha — o que é **bug**, não ausência de uso.

Denominador de 30 dias, para calibrar leituras futuras: **3 pessoas distintas**, 699 eventos.

### 4. A regra que isto acrescenta

**A via de leitura é PRÉ-REQUISITO de instalar o sensor, não consequência.** Um `track()` sem caminho
de consulta não é telemetria: é código morto que *parece* medição, e passa em todo CI. Antes de
mergear sensor novo, a pergunta é "qual comando lê esta série, e ele roda?" — se a resposta não é um
comando executável, a fase N+1 é construir a via, não instalar mais sensor.

**Corolário sobre o controle:** controle positivo prova que a telemetria chega, **não** que chegaria
daquele sensor. Quando existir um **irmão na mesma superfície** com histórico, ele é a testemunha
mais forte — foi o que separou "ninguém abriu a tela" de "o evento se perdeu" aqui.

---

## Revisão independente RETROATIVA do #1896 (2026-08-23): o sensor mede, mas rotula errado

O `/codex` do #1896 falhou com **exit 75 (cota esgotada)** e o PR mergeou pelo Caminho B, marcado
`REVISÃO INDEPENDENTE PENDENTE`. A cota voltou e o challenge rodou retroativo (`gpt-5.6-terra`,
xhigh, exit 0), com o código já em produção e **intocado desde o merge**. Como no #1859, escrevi a
minha análise ANTES de abrir o parecer — três achados saíram nos dois, por caminhos separados.

### O que sobreviveu à verificação

- **`is_hunter` fabricado, e o offline torna isso DETERMINÍSTICO.** `FarmerCalls.tsx:44` faz
  `const { data: commercialRole } = useMyCommercialRole()` e **descarta o `isLoading` que o hook
  expõe** (`useMyCommercialRole.ts:23,53`); `isHunter` vira `false` enquanto o papel não chega. Sem
  rede as duas queries pausam juntas, então **todo** evento `'sem-rede'` de hunter sai
  `is_hunter:false` — não é corrida, é sempre. E a dedup por estado impede a correção quando o papel
  chega. **Medido** (vitest, exit 0): `{"estado":"sem-rede",…,"is_hunter":false}` e **1** evento no
  total depois do papel resolver como `hunter`. Nos dashboards o valor é hardcoded e está CERTO —
  `CommercialDashboard.tsx:21` gateia com `isLoading`. O buraco é só no host que não gateia.
- **A dedup não reseta na troca de SUJEITO** (mesmo achado do #1859, herdado). `trackedEstado`
  (`useSinalPositivacao.ts:48`) é um ref que sobrevive à mudança de `effectiveUserId`, porque
  `ImpersonationProvider` é Context (`App.tsx:224`) e a rota não remonta. Alvo diferente com o mesmo
  estado não emite, e o payload não leva sujeito nem `isImpersonating` ⇒ o denominador de adoção
  conta staff impersonando como vendedor.
- **`sem-rede` COM cache é invisível, e `erro` COM cache leva número real.** `estadoDeLeitura`
  testa `status==='success'` (`estado-de-leitura.ts:47`) ANTES do `fetchStatus`, então cache quente
  + sem sinal devolve `'pronta'`. **Medido:** `{"estado":"pronta","pct":55,"total_eligible":40}` com
  a rede desligada — indistinguível de leitura fresca. No ramo `erro`, `data ? … : null`
  (`useSinalPositivacao.ts:57-60`) manda os números do cache, contra o que o próprio comentário
  :25-27 promete. O irmão **#1892 já resolveu isto** no MixGapCard (`desatualizado:'erro'|'sem_rede'`
  + dedup por `estado:motivo`); o #1896 não herdou. `desatualizado()` já existe pronto em
  `estado-de-leitura.ts:90`.
- **Os dois dashboards silenciam o estado que o sensor registra.** `FarmerDashboardV2.tsx:57` e
  `HunterDashboard.tsx:38` fazem `{positivacao && <PositivacaoHero/>}` sem aviso nenhum, enquanto
  `FarmerCalls.tsx:450-452` monta `AvisoLeituraFalhou`. O sensor agora PROVA que erro/offline
  acontecem lá — e é exatamente a classe que o #1859/#1886 existem para matar, viva em dois hosts.

### A lição durável: um teste de HOST pode ser tão cego quanto o de componente isolado

O #1896 nasceu para consertar "nenhum teste montava o host". Ele monta — e **ainda assim** não
percebe a regressão que motivou o #1886. **Falsificado, medido:** com o código intacto a suíte dá
`6 passed`; removendo o bloco `AvisoLeituraFalhou` de `FarmerCalls.tsx:450-452`, a suíte dá
`6 passed` **de novo**. A asserção do caso de erro é negativa (`queryByText(/Toda a carteira…/)`
=== null) e usa o MixGap como âncora positiva, então ela sobrevive a uma tela que voltou a silenciar
a falha.

**A regra:** montar o host prova que o componente é ALCANÇÁVEL; não prova que o host ainda DIZ
alguma coisa. Guard de estado-de-falha precisa de asserção POSITIVA sobre a fala (existe aviso), não
só negativa sobre a mentira (não afirma o contrário) — e a falsificação tem de sabotar **o host**,
não o componente.

**Corolário de sensor:** o mock que resolve uma dependência de forma SÍNCRONA apaga a dimensão que
ela introduz. `useMyCommercialRole: () => ({data:null, isLoading:false})`
(`FarmerCalls.mixgap-fora-do-gate.test.tsx:103`) e o `useImpersonation` fixo (:97) tornam A1 e a
troca de sujeito **impossíveis de falhar** ali. Não é tautologia da asserção: é cegueira do harness.
E o guard de "1 escritor por slug" não existe — a helper `evento()` (:165) faz `.reverse().find()`,
lê só a ÚLTIMA chamada, então um segundo escritor do mesmo slug passaria verde inflando o denominador.

### Desfecho: os dois buracos do guard fechados (2026-08-24)

Os dois falsos verdes acima viraram asserção, e **cada um foi falsificado no host** — não no teste:

- **A FALA.** O caso de erro agora afirma POSITIVAMENTE que o aviso existe, ancorado em
  `data-testid` (`aviso-positivacao`) e não na copy: o desenho é do #1886 e pode mudar sem que o
  contrato mude, e casar a string trocaria o falso verde por um falso vermelho. A âncora de
  MONTAGEM continua antes dela, para separar "a página não subiu" de "subiu e emudeceu".
  **Falsificado:** removendo o bloco de `FarmerCalls.tsx:450-452`, `1 failed | 5 passed`, exit 1 —
  onde a versão anterior dava `6 passed`.
- **A CONTAGEM.** `evento()` passou a delegar a `eventos()`, e todo desfecho exige exatamente UMA
  emissão (`umaEmissao`). **Falsificado:** com um segundo `useSinalPositivacao(isHunter)` no host,
  `4 failed | 2 passed`, exit 1 — e o diff mostra por que `toMatchObject` jamais pegaria isto:
  `['pronta','pronta']`, `['erro','erro']`, `['sem-rede','sem-rede']`. Payload **idêntico**; só a
  contagem muda.

**A armadilha da contagem:** contar logo depois do `waitFor` que espera o evento é corrida a favor
do verde — o `waitFor` para na PRIMEIRA emissão, e uma segunda vinda do commit seguinte chegaria
depois da leitura. Daí `aguardarDesfecho()`: espera sair **e** ASSENTA o React (dois flushes de
effects) antes de qualquer `toHaveLength`. Um guard de duplicata que não assenta mede o instante
errado e volta a ser decorativo.

Continuam ABERTOS os achados de PRODUTO da mesma revisão (`is_hunter` fabricado sem gate de
`isLoading`, dedup que não reseta na troca de sujeito, `sem-rede` com cache lido como `pronta`, e os
dois dashboards que silenciam o estado que o sensor registra) — este PR é só do guard.

## O INSERT que nunca saiu do browser — `dashboard_visits` (2026-08-23)

O §3 da seção anterior fechou em "é bug, não ausência de uso" e deixou o bug sem nome. Ele tem nome,
e não é o que a intuição do repo sugere.

**A hipótese natural estava errada.** "INSERT barrado por RLS não levanta erro visível no cliente" é
armadilha real e documentada aqui — mas não era esta. As policies estavam corretas
(`dashboard_visits_user_insert` com `WITH CHECK (auth.uid() = user_id)`) e o ACL cru de `pg_class`
mostrava `authenticated=arwdDxtm`, com o `a` de INSERT, idêntico a `profiles`/`user_roles`.

> **Nota de método:** a primeira leitura de grants usou `information_schema.role_table_grants` e veio
> **vazia** — o que parecia prova de "sem permissão". Não era: aquela view é filtrada pelas roles do
> usuário corrente, e `claude_ro` é restrito. Vazio ali é **ausência de dado**. Quem responde sem
> viés de role é `pg_class.relacl`.

**A causa-raiz: o query builder do PostgREST é um _thenable preguiçoso_.** O `fetch()` mora **dentro**
de `then()` (`postgrest-js/src/PostgrestBuilder.ts`). O código era:

```ts
void supabase.from('dashboard_visits').insert({ ... });   // ← monta a query, não manda NADA
```

O operador `void` avalia o operando e descarta. Ele **não** chama `.then()`. Logo nenhum HTTP era
emitido — não havia requisição para o RLS barrar. Provado com o postgrest-js real e um `fetch` dublê:

| expressão | `fetch` disparado |
|---|---|
| `void builder.insert(...)` | **0×** |
| `await builder.insert(...)` | 1× |
| `builder.insert(...).then(…)` | 1× |

Contraste que delimita o risco: `supabase.functions.invoke()` e `supabase.auth.getSession()` devolvem
**Promise de verdade** e disparam sozinhos. Só o builder de `supabase.from(...)` é preguiçoso — as
outras duas ocorrências de `void supabase` no repo estão corretas.

### Por que sobreviveu 3 meses

Três camadas de silêncio empilhadas, e nenhuma delas é "ninguém olhou":

1. **A mitigação foi projetada e descartada.** O spec (`2026-05-17-dashboard-visits-design.md`, l. 185)
   listava o risco "RLS quebra insert silenciosamente" com a mitigação `dashboard.visit.failed` +
   `logger.warn`. Nunca implementada. E `void` descarta até o objeto `error` — o código ficou sem
   nenhuma superfície de falha.
2. **O CI ficava verde porque o mock não era fiel.** O teste mockava `supabase.from` com `vi.fn()`
   comum. Um `vi.fn()` não tem a preguiça do builder, então `void` "funcionava" no teste. O write path
   tinha **0 testes** — as 5 asserções existentes cobriam só leitura.
3. **A tabela vazia lia como "sensor que nunca mediu"**, que é a interpretação que o §6 do topo deste
   arquivo registrou. Só o cruzamento com PostHog (45 visitas em 90 dias) separou as duas leituras.

### O que quase virou um segundo bug

Corrigir **só** o `void` teria piorado a tabela, por duas razões que a tabela vazia mascarava:

- **3 escritores.** `useLastVisit` monta 3× por dashboard (`DashboardBody` → `BriefZone` →
  `DeltasStrip` → `useBriefDeltas`), cada um com seu `mountedAtRef`. Destravado o INSERT, viravam
  3 linhas por visita, com timestamps a milissegundos de distância.
- **Off-by-one no read.** O spec assumia escrita no **mount** e por isso lia `range(1, 1)` ("segunda
  mais recente"); a implementação escreve no **unmount**. Com a tabela cheia, `range(1,1)` devolveria
  a **penúltima** visita. Com a tabela vazia, o fallback pra `localStorage` escondia isso.

Correção: escritor único (`useRegistrarVisitaDashboard`, 1 chamador), `range(0, 0)`, `.then()` com
`track('dashboard.visita_erro')`, e `persona`/`company_selection` — colunas que existiam desde
2026-05-17 e nunca eram escritas.

### A regra que isto acrescenta

**Thenable preguiçoso não falha: ele não acontece.** Um builder descartado com `void` não gera erro,
não gera log, não gera requisição — some sem rastro, e nenhum gate do repo (typecheck, lint,
`no-floating-promises`, RLS, CI) vê. `void` sobre um builder do PostgREST é sempre bug; sobre uma
Promise real é só "não estou aguardando".

**E o corolário de teste:** um mock que não reproduz a **preguiça** da dependência testa a si mesmo.
O dublê tem que só registrar a chamada quando alguém **puxa** a promise — senão o teste fica verde
exatamente no bug que deveria pegar. Falsificado nos três eixos: restaurar o `void`, devolver o
`range(1,1)` e reintroduzir a escrita duplicada deixam o arquivo vermelho.

### O desfecho: medido em 2026-08-24, veredito é "ainda sem denominador"

Publish confirmado por bytes (a sentinela literal `dashboard.visita_erro` no chunk
`StaffDashboard-*.js` do entry servido, `verify-frontend.sh` **exit 0**, 2026-08-24 10:12Z). O
código do fix **está no ar**. O efeito, não:

| sinal | valor | fonte |
|---|---|---|
| numerador — `count(*)` de `dashboard_visits` | **0** (nunca teve linha) | `psql-ro` |
| denominador — `dashboard.viewed` desde o Publish | **0** | PostHog |
| último `dashboard.viewed` de todos | **2026-08-14 22:00Z** (10 dias antes) | PostHog |
| controle sem filtro de evento (90d) | **2.618 eventos**, último em 2026-08-23 11:09Z | PostHog |
| `dashboard.visita_erro` | **0** | PostHog |

O controle é o que dá dente: com 2.618 eventos em 90 dias a ingestão está viva, então a série vazia
de `dashboard.viewed` é **dado real** — ninguém abriu o dashboard — e não sensor sem chegar. A
cadência histórica é de 1–4 aberturas por semana, 1 pessoa; as semanas de 16/08 e 23/08 têm **zero**.

**Nem confirma nem reprova.** 0 linhas com denominador 0 é a ausência de dado que este arquivo
inteiro existe para não deixar virar veredito. `auth.sessions` mostrava o master com sessão tocada
às 09:57Z do mesmo dia — e ainda assim zero evento: `updated_at` avança no **refresh de token**, que
é presença de token, não de uso. Reavaliar quando houver ≥1 `dashboard.viewed` posterior ao Publish.

### ⚠️ E o denominador certo é mais estreito do que "abriu o dashboard"

Lendo o writer para desenhar a reavaliação, aparece uma condição que a tabela vazia escondia: o
INSERT mora no **cleanup do `useEffect`**, e só dispara se a sessão durou ≥5 min (`MIN_SESSION_MS`).
Não há `beforeunload` nem `pagehide` em `useLastVisit.ts` — e **cleanup de `useEffect` não roda
quando a aba fecha ou leva F5**. Logo:

> só vira linha quem ficou ≥5 min no dashboard **e saiu por navegação SPA** (ou logout). Fechar a
> aba — a saída mais comum — não grava, e **não emite `dashboard.visita_erro`**, porque não chegou a
> tentar.

Isso muda a leitura da próxima medição: `dashboard.viewed > 0` **com** 0 linhas **não** prova que o
fix não pegou; é indistinguível de "abriu e fechou a aba". Para separar as duas, o denominador tem
de ser *aberturas que qualificam*, e hoje **nenhum sensor mede isso**. Quem for reavaliar escolhe:
tratar `viewed` como limite superior e exigir uma sessão manual controlada (≥5 min no dashboard,
depois **navegar para outra rota** antes de fechar), ou instalar o sensor que falta — um `track()` no
próprio cleanup, antes do `if (sessionDuration < MIN_SESSION_MS) return`, que registre a tentativa e
o motivo da desistência. Enquanto ele não existir, a diferença entre "não gravou" e "não tentou"
continua invisível — a mesma ausência de dado, um degrau adiante.

### A reavaliação pedida logo em seguida (2026-08-24 10:23Z): o relógio não andou

Pedido de reavaliar o veredito acima, com a query da janela `> 2026-08-24 10:12:00`. As leituras
vieram idênticas — e a razão é que a medição anterior tinha **13 minutos**. O #1939 mediu
10:10–10:20Z; a releitura é 10:23Z. Ler `dashboard_visits` de novo **não é dado novo**.

A prova de que nada correu não é a série repetida, é o controle: `max(timestamp)` de *todos* os
eventos continuava `2026-08-23T11:09:23Z` nas duas medições. Mesmo último evento ⇒ **nenhum evento
entrou entre elas**. (O total subiu 2.618 → 2.630 só porque o #1939 filtrou 90 d e esta leitura não
filtrou: 12 eventos mais antigos que a janela, não 12 novos. Contador que muda de recorte não mede
crescimento.)

**Reavaliação exige um EVENTO, não um pedido.** O gatilho registrado acima — "quando houver ≥1
`dashboard.viewed` posterior ao Publish" — é uma condição sobre o mundo; reexecutar a query sem ela
gasta uma sessão para reproduzir o mesmo `null`. Quando o gatilho é temporal, o veredito anterior
já contém a resposta.

#### Duas armadilhas de medição, ambas capazes de inverter o veredito

1. **A janela estava no FUTURO.** `toDateTime('2026-08-24 10:12:00')` é **UTC**, e às 10:23Z isso
   cobria 11 minutos. A série vazia era vazia **por construção**. Uma janela em UTC contra um
   relógio local (`-03`) parece 3 h de dados e é zero — e o zero se disfarça de sintoma.
2. **O controle herdou a variável sob teste.** Rodar o controle *com a mesma janela* devolveu
   `0` também, e série-vazia-**com**-controle-vazio é a assinatura de "sensor não chegando"
   (`analytics.md` §4) — o diagnóstico oposto. Só o controle **sem** filtro de tempo (2.630 eventos,
   ingestão viva) mostrou que o zero era dado real.

> **Um controle positivo só controla o que ele NÃO compartilha com a série sob teste.** Se ele herda
> a janela, o filtro ou a fonte, ele morre junto e confirma qualquer coisa. Ao montar o par
> série/controle, a pergunta é: *que variável eu quero descartar?* — e é exatamente essa que o
> controle não pode conter.

#### O que foi feito em vez de remedir: o sensor que separa "não gravou" de "não tentou"

Escolhida a segunda opção que a seção anterior oferecia. `dashboard.visita_tentativa` passa a sair no
**topo do cleanup**, antes de qualquer `return`, com `motivo` ∈ {`sessao_curta`, `sem_usuario`,
`gravou`} — os dois primeiros eram os `return` mudos das linhas 81 e 90, o tell sintático que este
arquivo manda procurar (*um `return` que serve mais de um estado*). A quarta saída — aba fechada,
onde o cleanup **nem roda** — continua fora do alcance do hook, mas deixa de ser invisível: como
`dashboard.viewed` sai no **mount** do mesmo `DashboardShell` e `visita_tentativa` no **unmount**, ela
é a diferença entre os dois contadores.

```
aberturas que qualificam   = count(dashboard.visita_tentativa WHERE motivo='gravou')
saídas por fechar aba / F5 = count(dashboard.viewed) - count(dashboard.visita_tentativa)
```

Com isso a próxima medição do #1934 é conclusiva **sem** depender de sessão manual: `motivo='gravou'`
com 0 linhas em `dashboard_visits` é falha real do INSERT (investigar RLS); `motivo='sessao_curta'`
dominante diz que ninguém fica 5 min; e nenhum `visita_tentativa` com `viewed > 0` diz que todos
fecham a aba — e aí a correção é `pagehide`, não RLS. Os três eram o mesmo zero até aqui.

**O sensor é a fase N+1 legítima**: não mede adoção de produto, mede a *própria verificabilidade* de
uma correção que já está no ar. Instalá-lo não precisa de denominador — precisa dele quem for
concluir alguma coisa a partir dele.

#### ⚠️ ERRATA — a fórmula da subtração morreu no mesmo dia (2026-08-24, PR desta seção)

A frase acima — *"e aí a correção é `pagehide`, não RLS"* — foi executada horas depois, e ao ser
executada **invalidou a fórmula que a antecede**. Registrado aqui porque uma fórmula de medição que
envelhece errada é pior que fórmula nenhuma: ela continua rodando e devolvendo um número plausível.

`useRegistrarVisitaDashboard` agora grava por DOIS caminhos, e ambos emitem `visita_tentativa`:

| Caminho | Quando | Emissão |
|---|---|---|
| `unmount` (cleanup do effect) | navegação in-app | client do supabase |
| `pagehide` | fechar aba · F5 · sair do site | `fetch` com `keepalive: true` |

Logo `count(viewed) − count(visita_tentativa)` **não mede mais** saídas por fechar a aba: essas
saídas passaram a emitir `visita_tentativa` também. A subtração agora tende a zero — e um zero por
mudança de instrumentação é indistinguível, para quem lê a fórmula velha, de "ninguém mais fecha a
aba". Exatamente o colapso de significados que o sensor existia para desfazer.

A quarta saída deixou de ser inferida por subtração e passou a ser **medida direto**, pelo novo
campo `via`:

```
saídas por fechar aba / F5   = count(visita_tentativa WHERE via='pagehide')
saídas por navegação in-app  = count(visita_tentativa WHERE via='unmount')
aberturas que qualificam     = count(visita_tentativa WHERE motivo='gravou')   -- inalterado
```

`motivo` também cresceu, e os três valores novos são **desistências que antes não existiam** (não
são renomeações — não há série histórica a reconciliar): `ja_gravado` (o `unmount` que vem depois de
um `pagehide` que já gravou — dedup, não perda), `lente_ativa` (a lente "ver como" barrando o fetch
cru, que não passa pelo write-guard do client) e `sem_token` (sessão sem `access_token` para
autenticar o fetch; o `unmount` ainda pode gravar pelo client).

**A lição, que é do próprio arquivo:** a fase N+1 aqui não foi "usar o sensor", foi *corrigir o furo
que o sensor tornou visível* — e a correção mudou o instrumento. Sensor e correção competem pelo
mesmo denominador. Ao fechar um furo que o sensor media por ausência, **reescreva a query junto com
o código**, no mesmo PR: a query mora no doc, mas ela é parte da mudança, não comentário sobre ela.

## ✅ FECHADO — `dashboard_visits` tem `id = 1` (2026-08-24 12:29:32Z)

A tabela vazia há três meses recebeu a primeira linha. O `#1934` está **provado em produção**:

```
 id |         visited_at         |  persona  | company_selection | session_minutes
----+----------------------------+-----------+-------------------+-----------------
  1 | 2026-08-24 12:29:32.543+00 | comprador | all               |               7
```

Vigília no `psql-ro` a cada 40s: `12:29:16Z linhas=0` · `12:29:58Z linhas=1`. As duas colunas que
existiam desde 2026-05-17 e nunca tinham sido escritas (`persona`, `company_selection`) vieram
preenchidas.

**A linha se corrobora sozinha, e é o que a torna evidência e não relato.** A sessão que conduziu o
teste informou o mount às **12:22:28Z**, *antes de a linha existir*. `12:29:32.543 − 12:22:28 =
7min 04s`, `Math.floor` → **7**, que é exatamente o `session_minutes` gravado. Nenhuma linha espúria
bateria com um horário fornecido antes do fato — a checagem não depende de confiar em quem reportou.

Do lado do browser (interceptor de `fetch`, sessão `interesting-driscoll-dfb6e1`): POST com
`keepalive: false`, corpo com os 5 campos, resposta **201** em 416ms.

⚠️ **`keepalive: false` ⇒ o que se provou foi o caminho do UNMOUNT.** Dizer "o #1949 está provado"
seria forte demais: o `emitirComKeepalive` do `pagehide` **continua sem exercício real**. Provado
está o INSERT chegando ao banco pela saída de navegação SPA — o caminho clássico. É a mesma
disciplina do resto deste arquivo: um sinal genérico não prova a asserção específica.

### A sequência causal: os três PRs estavam certos o tempo todo

| # | corrigiu | era o que travava? |
|---|---|---|
| #1934 | o thenable preguiçoso sem `.then()` | real, mas não era o último bug |
| #1945 | o cleanup com 3 saídas mudas (sensor) | real, e também não travava |
| #1949 | a visita perdida ao fechar a aba | real, e também não travava |
| — | **o aceite do SW pelo cliente** | **era isto** |

O browser executava `index-DghZxghH.js` enquanto o servidor entregava `index-DnOk4g4H.js`. Nenhum
dos três fixes estava rodando no cliente. **O que faltava não era código: era a quarta camada de
deploy** — `registerType: 'prompt'` com `skipWaiting` removido de propósito faz o build novo instalar
e **esperar o clique**, por tempo indefinido, por cliente. Detalhe e a regra geral em
[`deploy.md`](../agent/deploy.md); o ponto para este arquivo é outro:

> **Uma verificação por bytes prova DISPONIBILIDADE. A pergunta "o fix está agindo?" é sobre ADOÇÃO,
> e adoção não se lê no servidor.** Foi por isso que três `exit 0` seguidos e um Publish confirmado
> conviveram, sem contradição aparente, com uma tabela vazia.

O teste só produziu dado depois de forçar o aceite: `offline_queue_v1` verificada vazia (vive no
`localStorage`, que `caches.delete` não toca) → `unregister()` + `caches.delete('workbox-precache-v2-…')`
→ reload → bundle trocou → sessão de 7 min → saída por navegação SPA → **201**. Ambiente restaurado
depois (SW reinstalado e `activated`, 8 caches, fila ainda vazia).

### E o desfecho previsto do par tabela × evento aconteceu: **linha SEM evento**

Nenhum `dashboard.visita_tentativa` chegou ao PostHog — a ingestão estava devolvendo **503**. O par
se comportou como projetado: a tabela é o lado **imune** (INSERT direto no Supabase), o evento é o
lado frágil. Tivéssemos confiado só no PostHog, o veredito de hoje seria "continua quebrado".

⚠️ **E uma armadilha nova, que quase entrou neste registro como número:** a query de breakdown por
`properties.motivo` voltou **504** (`"Query has hit the max execution time"`) da API de consulta —
que é **ausência de dado**, não zero. Um `count()` simples respondeu: `[[0]]`, exit 0. **503 na
ingestão e 504 na consulta chegam pelo mesmo cano e só um dos três resultados é medição.** Antes de
ler um zero do PostHog como ausência de uso, prove que a query terminou.

### O sensor que falta: a versão que o cliente EXECUTA

O fecho do `#1934` deixou uma pergunta cuja única resposta hoje é abrir o browser de alguém: **qual
build cada cliente está executando?** Levou um teste inteiro para descobrir que a resposta era
`index-DghZxghH.js` enquanto o servidor entregava `index-DnOk4g4H.js` — e a descoberta foi acidental,
por um toast de "Nova versão disponível" aparecer num screenshot.

Enquanto isso exigir inspeção manual, **a adoção do service worker é inobservável** — que é este
arquivo aplicado à própria camada de deploy: uma fase (o Publish) declarada concluída sem sinal de que
chegou. A diferença é que aqui o denominador não é "quantos podiam usar", é "quantos já aceitaram".

O sensor é barato e o lugar dele é o payload de todo evento: **o hash do bundle em execução**
(`import.meta.env.VITE_BUILD_ID`, ou o próprio nome do chunk do entry). Com ele:

```
adoção do deploy = clientes com build_id = <atual> / clientes que emitiram qualquer evento
```

e a pergunta "o fix está no ar?" ganha a segunda metade que faltava — **"…e quantos já o executam?"**.
Sem isso, `verify-frontend.sh` continua respondendo sozinho uma pergunta que tem duas partes.

**Não construído de propósito.** A regra deste arquivo vale para ele mesmo: a fase N aqui é o 503 da
ingestão do PostHog, ativo em 2026-08-24 — enquanto nenhum evento entra, um sensor novo no payload
não teria como ser lido, e instalá-lo agora seria fase N+1 sem sinal da fase N. A ordem é destravar a
ingestão, confirmar que evento volta a chegar, e só então acrescentar o campo.

#### Construído (2026-08-24, à noite): a fase N deu sinal e o sensor entrou

O pré-requisito acima foi cumprido no mesmo dia — a ingestão voltou (evento `diagnostico.ingestao`
chegando às 21:59Z, `total=2631`); o 503 de ~12:17–12:30Z foi transitório, não estado. Com sinal da
fase N, o sensor deixou de ser fase N+1 no escuro e foi construído.

**A escolha que mudou em relação à spec acima:** era `VITE_BUILD_ID` **ou** o nome do chunk do entry.
Ficou o **chunk do entry**, e a razão desqualifica a primeira opção em vez de só preferir a segunda:
o builder do Lovable **não tem `.git`** (confirmado 2026-06-19, comentário no `vite.config.ts`) e
nenhuma env de SHA de plataforma foi identificada até hoje — tanto que o `__BUILD_ENV_KEYS__` ainda
está lá como probe justamente para descobrir o nome dela. Um `VITE_BUILD_ID` derivado de commit
degradaria para a constante `"dev"` em produção, e **um id constante entre builds não identifica
build**: o sensor nasceria verde e cego, que é a falha exata que este arquivo cataloga.

O hash do entry não tem essa dependência — é content-hash do Vite, nasce sempre, e muda se e somente
se o app mudou. Melhor ainda, é o **mesmo eixo** que o `verify-frontend.sh` (linha do `ENTRY=`, na skill `lovable-deploy-verify`) já extrai do servidor
(`grep -oE '/assets/index-[A-Za-z0-9_-]+\.js'`), então "entregue" e "executado" comparam sem tabela
de tradução. O risco que isso cria é os dois regexes andarem separado — e o sintoma seria "adoção
0%", indistinguível de ninguém ter atualizado. Por isso a paridade entre eles é presa por teste
(`src/lib/__tests__/build-id-paridade.test.ts`), e a falsificação que a valida é sutil de propósito:
tirar `_` e `-` do charset deixa o teste da extração **verde** (o hash da amostra não os usa) e só a
paridade acusa.

**Três estados, não dois** — a decisão de leitura que evita a próxima cegueira: propriedade
**ausente** = build anterior à instrumentação (não-adoção legítima, e o estado da maioria logo após
este Publish); `'desconhecido'` = build atual com entry não encontrado (dev, ou o HTML mudou de
forma); hash = leitura boa. Colapsar os três num só reproduziria o erro de origem num lugar novo.

⚠️ **Este PR não tem sinal de si mesmo até ser publicado E aceito.** A primeira leitura útil da
adoção vem depois do Publish, e ela vai começar perto de 0% — que aqui é o sensor funcionando, não
falhando. Ler antes disso é o erro que este arquivo inteiro descreve.

## O controle positivo de ingestão somava DOIS canos — e o do browser está sem entregar

O `#1964` construiu o sensor de `build_id` depois de dar por cumprido o pré-requisito que o `#1957`
tinha posto: *"a ordem é destravar a ingestão, confirmar que evento volta a chegar, e só então
acrescentar o campo"*. A ingestão de fato voltou; o `503` de ~12:17–12:30Z de 24/08 foi transitório.
O que não se sustenta é o **controle** — e o desfecho mostrou por quê.

O `#1964` toma os 66 eventos da janela de 7 dias como **`controle POSITIVO de ingestão`**, concluindo
que *"uma série vazia adiante seria sinal real, não silêncio de canal morto"*. A **mesma query**,
decomposta por `properties.$lib` — que o `posthog-js` preenche e uma captura por `curl` não —, mostra
que os 66 nunca foram um conjunto só:

| via | n | primeiro | último |
|---|---|---|---|
| browser (`$lib='web'`) | 65 | 2026-08-18T09:25Z | **2026-08-23T11:09Z** |
| API direta (sem `$lib`) | 1 | — | **2026-08-24T21:59Z** |

65 + 1 fecham os 66. Todos os 65 eventos de browser são **anteriores ao 503** — o último por ~25
horas. O único evento posterior ao incidente entrou por `curl`. O controle prova que o **servidor
voltou a aceitar um POST**; não prova que o **`posthog-js` volta a emitir**.

### E não é "sem exercício": o cano do browser foi exercitado e não entregou

Enquanto isto era escrito, o `#1965` fez o teste que faltava — dashboard montado **em produção**,
autenticado, bundle correto, sessão de 8 min encerrada por fecho de aba, em `2026-08-25T00:17:10Z`.
Medição independente do PostHog às `00:45Z` (`force_blocking`, já com o fix de cache do `#1959`):
**zero eventos de qualquer tipo em 25/08** — nem o `dashboard.viewed` do mount.

O app rodou e **nada chegou**. O cano do browser não está "não-provado": está **provado sem
entregar**. Um controle positivo agregado leu como saudável um canal que, exercitado, não entrega —
e essa é a diferença entre não ter medido e ter medido a coisa errada.

### Por que isso morde o sensor que o `#1964` acabou de instalar

`build_id` é super property do `initAnalytics`: sai **pelo cano do browser**, o que não entrega. Pior,
o `#1964` já deixou a leitura pré-resolvida — *"primeira leitura útil da adoção vem depois do
Publish, e ela vai começar perto de 0%"*, *"que aqui é o sensor funcionando, não falhando"*. Com o
cano mudo, **0% é ambíguo** (ninguém adotou × nada chega), e a instrução de leitura já resolve a
ambiguidade no sentido otimista. É a cegueira de origem reproduzida num lugar novo, que o próprio
`#1964` se propôs a evitar ao separar *ausente* de `'desconhecido'` de *hash*.

**A regra:** cano com dois caminhos exige **controle POR CAMINHO**. Controle positivo agregado é
sinal genérico lido como específico — o mesmo vício que o `#1955` flagrou no `keepalive:false`. E não
há o que fabricar: **o primeiro evento com `$lib='web'` é a prova**, porque o `posthog-js` o emite
sozinho no `$pageview`. Enquanto ele não vier, toda leitura de adoção é indistinguível de canal morto.

```
SELECT toDate(timestamp) AS dia,
       if(isNull(properties.$lib),'API_direta','browser_SDK') AS via,
       count() AS n, max(timestamp) AS ultimo
FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY dia, via ORDER BY dia DESC
```

## O `keepalive` que não grava: cinco causas ELIMINADAS por medição, e a que sobra não é lá

O `#1965` deixou a causa em aberto com honestidade — restam *"keepalive cortado no unload"* e *"token/RLS"* — porque o `.then()` que reportaria o erro não roda: a página já morreu. Esse é o ponto
que torna o caminho opaco, e é também o que faz a eliminação valer mais que o palpite: **tudo que é
do lado do SERVIDOR é verificável sem browser**, e nada disso sobreviveu.

| hipótese | como foi medida | resultado |
|---|---|---|
| falta `GRANT` de INSERT | `has_table_privilege('authenticated','dashboard_visits','INSERT')` | **`t`** — existe (ACL `arwdDxtm`) |
| policy de INSERT ausente/errada | `pg_policies` | existe: `WITH CHECK (auth.uid() = user_id)` |
| `auth.uid()` não resolve o JWT | `set_config('request.jwt.claims', …)` em transação | **`policy_passaria = true`**; sem claim → `NULO` |
| URL/key divergentes do client oficial | `useLastVisit.ts:107` × `client.ts:6` | **a mesma** `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` |
| token velho no `tokenRef` | `AuthContext.tsx:241` | `onAuthStateChange` → `setSession` em **todo** evento (inclui `TOKEN_REFRESHED`) → re-render → ref fresco |

⚠️ **A consulta de grants por `information_schema` quase fabricou a primeira linha ao contrário:**
`role_table_grants` voltou **vazia** para a tabela — e vazio ali parece "não há GRANT". Ela filtra
pelo que a role da CONEXÃO enxerga, e o `claude_ro` não enxerga esses grantees. O ACL bruto
(`pg_class.relacl` + `has_table_privilege`) mostra o oposto. **Ausência em `information_schema` é
ausência de VISIBILIDADE, não de privilégio** — a mesma armadilha de sempre, num catálogo novo.

E o CORS também não é: o preflight do endpoint responde **200 em 0,22s**, libera
`authorization,apikey,content-type,prefer` e manda **`access-control-max-age: 3600`**. Como o próprio
`useLastVisit` **lê** essa mesma URL no mount, o preflight já está em cache quando o `pagehide`
dispara — a explicação "o preflight não completa no unload" perde a força.

### O que sobra, e por que a assimetria é a pista

Sobra o **transporte durante o unload**. E a assimetria observada é coerente com ela e com mais nada:
o `unmount` grava (linha `id=1`) usando o **client oficial**, com a página viva; o `pagehide` não
grava usando `fetch` cru, com a página morrendo. Mesmo token, mesma URL, mesma policy, mesmo grant —
muda o **momento**.

O comentário do `emitirComKeepalive` registra o trade-off que fecha o círculo: *"`sendBeacon` não
serve — não deixa mandar os headers de auth que o PostgREST exige"*. Os headers de auth são
exatamente o que tira a request do conjunto "simples" do CORS; a escolha feita para poder autenticar
é a mesma que põe a request na categoria mais frágil no unload. **A solução escolhida carrega a causa
provável da falha** — o que não se resolve mexendo no fetch, e sim tirando a autenticação do header
(uma edge que aceite POST simples e valide o JWT no corpo torna `sendBeacon` utilizável).

### O teste que decide, em 30 segundos

Não é preciso mais análise: com a página **VIVA** o `.then()` roda e o status HTTP aparece. No console
do dashboard autenticado, o mesmo POST do `emitirComKeepalive` — se voltar **201**, a request é
válida e o culpado é o unload; se voltar **401/403**, é auth/RLS e esta tabela está errada:

```js
const { data: { session } } = await window.supabase.auth.getSession()
const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/dashboard_visits`, {
  method: 'POST', keepalive: true,
  headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
             Authorization: `Bearer ${session.access_token}`, Prefer: 'return=minimal' },
  body: JSON.stringify({ user_id: session.user.id, visited_at: new Date().toISOString(),
                         session_minutes: 9, persona: 'teste', company_selection: 'all' }),
})
console.log(r.status, await r.text())   // 201 => unload é o culpado · 401/403 => auth/RLS
```

`persona: 'teste'` marca a linha como sintética — dá para distinguir de visita real depois.

### E a telemetria muda NÃO é o deploy: 178/178 chunks servidos, incluindo o do PostHog

A hipótese natural para "o browser não entrega" era a 4ª camada de novo — bundle incompleto, chunk
faltando, key não embutida. **Nenhuma sobreviveu**, e o servidor é verificável sem login:

| hipótese | medida | resultado |
|---|---|---|
| key não foi embutida no build | `grep phc_` no entry servido | **1** ocorrência (negativo: `0`) |
| host do PostHog ausente | `grep us.i.posthog.com` | **1** ocorrência |
| `opt_out` ligado em produção | `analytics.ts:100` | só sob `import.meta.env.DEV` |
| `initAnalytics` nunca chamado | `App.tsx:212` | chamado |
| chunk do `posthog-js` não servido | os **178** chunks do entry, um a um | **0 faltando** — o do PostHog responde `200`, 190KB |

Ou seja: o build servido está íntegro e o PostHog **carrega**. O que impede a emissão está no
**cliente** — bloqueador de rastreador, extensão ou rede local —, e isso não se mede daqui: `us.i.
posthog.com` está nas listas de bloqueio mais comuns, e um `curl` (que foi o que entregou o evento de
24/08 21:59Z) não passa por nenhuma delas.

⚠️ **Esta tabela quase saiu com uma causa-raiz FALSA na última linha.** Extraí o nome do chunk com
`grep -o 'posthog[A-Za-z0-9_.-]*'` e testei `posthog-Do2CBfqi.js`: **404**, igual ao chunk inventado
de controle. Parecia conclusivo — entry referencia, servidor não serve, PostHog não inicializa,
explica todos os zeros. **O nome real é `vendor-posthog-Do2CBfqi.js`**: o padrão começava em
`posthog` e comeu o prefixo `vendor-`. O 404 era do nome que eu inventei sem perceber, e o chunk
verdadeiro responde `200`.

O que salvou foi a **contradição entre duas medidas**: a varredura dos 178 disse `0 faltando` no
mesmo minuto em que o teste avulso dizia `404`. Duas medidas do mesmo fato discordando é sinal de que
uma delas mede outra coisa — aqui, um nome. **Um 404 só é evidência de ausência depois que o NOME é
verificado contra a fonte**, do mesmo jeito que uma citação. É a armadilha do `+` do diff e do `*` do
JSDoc numa terceira roupa: o recorte que trunca o identificador e devolve um resultado coerente,
porém sobre outro objeto.

**E a medição que fecha o argumento veio sozinha, minutos depois.** Às `2026-08-25T01:24Z` a tabela
tinha **5 linhas** — quatro delas gravadas naquela madrugada, a última há cinco minutos (o `#1972`
registra que parte veio de uso real, não de teste) — enquanto o PostHog, na **mesma janela de 24h**,
tinha **zero** eventos de browser. App gravando e telemetria muda, ao mesmo tempo, medidos lado a
lado: é o estado *linha sem evento* do par tabela × evento em forma pura, e a prova de que o
silêncio não é o app parado nem o deploy quebrado.
