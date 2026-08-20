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
