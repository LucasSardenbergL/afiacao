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
| `CoveragePanel` + 4 consumidores de `useMyActiveCoverage` | `carteira_coverage` = **0 linhas** | dano hoje ZERO → chip com gatilho |

O `DataHealthBanner` merece nota à parte: o padrão correto estava **20 linhas ao lado o
tempo todo**. `DataHealthBadge` faz `isError ? 'red' : badgeLevel(data ?? [])` — fail-closed.
O banner, MESMO hook, fazia `const { data } = useDataHealth()` e desaparecia da tela
financeira. A classe não é falta de conhecimento no repo; é falta de *fiscal*.

**O quarto estado virou teste.** O offline (`pending` + `paused`: `isLoading` FALSE, `data`
undefined, `error` null) tinha sido MEDIDO no #1874 e registrado só como nota. Agora é
guarda permanente, nos três componentes e na tabela exaustiva de `estadoDeLeitura` — as 9
combinações de `status × fetchStatus` têm nome, porque estado sem nome colapsa no vizinho.

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
| employee B | (nenhuma sessão jamais) | **0** | **0** |

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
não abrem o app — um deles nunca. Um sensor sobre população inerte é a versão de telemetria
do fusível que nunca foi ligado (o piloto Sayerlack, no topo deste arquivo).

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
