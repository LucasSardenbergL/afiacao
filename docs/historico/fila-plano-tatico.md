# Fila do Plano Tático (PTPL) — 533 planos, zero desfecho, 72% inalcançáveis

> Diagnóstico + correção de 2026-08-07. Origem: o founder pediu para extrair aprendizado de
> [uma matéria sobre a Dionísio](https://revistapegn.globo.com/startups/noticia/2026/07/startup-capta-r-22-milhoes-para-transformar-whatsapp-em-maquina-de-vendas-para-restaurantes.ghtml)
> (startup que captou R$ 2,2 mi para virar o WhatsApp de restaurantes em canal de vendas).
> A frase que puxou o fio: *"mais de 70% dos dados que passam por restaurantes não são captados"*.
> Medimos o equivalente aqui e o número foi pior.

## O que foi medido (psql-ro, 2026-08-07)

| Fato | Valor |
|---|---|
| Cron `tactical-plans-batch-nightly` | **ativo**, `0 8 * * *`, ~30 planos/dia |
| `farmer_tactical_plans` | 533 linhas (21/07 a 07/08), **100% `gerado`** |
| Com desfecho (`concluido`) | **0** |
| Com `actual_margin` | **0** |
| Donos distintos | 3 (285 / 124 / 124) |
| Fora dos 50 slots da UI | **383 de 533 (72%)** |
| Janela real de visibilidade | **6,7 dias** |

Sinais laterais da mesma doença: `farmer_recommendations` 3.659 linhas 100% `pendente`
(idêntico ao post-mortem de [farmer-aprendizado-conversao.md](farmer-aprendizado-conversao.md));
`call_log` parado desde 2026-06-09. **Todo ponto de captura que depende de digitação manual
está em zero.** O que está vivo é o que a máquina calcula sozinha (`farmer_client_scores`,
recalculado diariamente).

## O que NÃO era (hipóteses descartadas com evidência)

- **Não era export morto.** Ao contrário do `farmer_category_conversion`, a cadeia está inteira:
  `FarmerTacticalPlan.tsx` → `PlanCard.tsx:233` → `RecordResultDialog.tsx` → `recordResult` →
  RPC `registrar_resultado_plano` (que grava `status='concluido'` + `actual_margin`).
- **Não era botão escondido por status.** Renderiza sob `plan.status !== 'concluido'`, verdadeiro
  nos 533.
- **`used_at = 0 em 533` NÃO prova não-adoção.** A coluna **não tem writer nenhum** (nem em `src/`,
  nem em `pg_proc`). Ler esse zero como "ninguém abriu os planos" seria repetir exatamente a
  armadilha do post-mortem: *ler uma tabela vazia é pior que não ler*. A inferência foi retirada.

## A causa: o sistema competia consigo mesmo

`loadPlans` fazia `.order('created_at', desc).limit(50)`, **sem filtro de status e sem paginação**.
Com ~30 planos novos por dia, a lista de 50 rotacionava inteira em menos de uma semana — e o plano
saía de vista para sempre, sem nunca ter recebido desfecho.

O ponto não-óbvio: **trocar só o critério de ordenação não resolveria.** Sem uma saída, qualquer
ordenação estável entope — os mesmos 50 planos (de maior risco, ou mais antigos) ficariam no topo
permanentemente, porque nada os remove. A fila só circula se tiver saída.

## A correção

1. **Saída (banco):** `expirar_planos_taticos(_dias integer DEFAULT 7)` + cron
   `expirar-planos-taticos` (`30 8 * * *`, 30 min depois do batch de geração). Plano `gerado`
   fora da janela vira `expirado`. Nunca toca `concluido` — o desfecho registrado é o dado escasso.
   - Guard fail-closed: `_dias` nulo ou `< 1` levanta `22023` (com `_dias=0` a fila INTEIRA
     expiraria, inclusive o lote da madrugada).
   - `SECURITY DEFINER` + `REVOKE` nominal de `anon`/`authenticated` (revogar de `PUBLIC` não
     basta no Supabase — grant explícito por default privileges).
   - Efeito medido em prod antes do apply: **364 expirariam, 169 ficariam na fila.**
2. **Recorte (front):** `status='gerado'` + janela móvel em `generated_at` + ordenação por
   `churn_risk` desc com `generated_at` de desempate. O front aplica a janela por conta própria
   em vez de confiar que o cron rodou — se o job falhar, a fila entupiria de novo.
   - `churn_risk` foi escolhido por ter variância real (53 valores distintos, 33..89).
     `bundle_lie` e `best_individual_lie` seriam o critério natural de valor, mas estão **NULL em
     100% das 533 linhas** — ordenar por eles seria ordem indefinida disfarçada de priorização.
3. **Contador honesto:** a tela passa a dizer "Mostrando 50 de N". Contagem que falha degrada para
   `null` (o rótulo some), **nunca para 0** — "0 pendentes" é indistinguível de "a query morreu".
4. **Abas** pendentes/concluídos/expirados (`useUrlState`), para que o histórico continue
   alcançável. Valor fora do domínio na query string degrada para `pendentes`.

Prova: `db/test-expirar-planos-taticos.sh` (PG17, 15 asserts + 3 falsificações) e
`src/hooks/__tests__/fila-plano-tatico.test.tsx` (5 testes).

⚠️ A falsificação F3 (re-`GRANT` para `authenticated`) só tem dente porque o harness replica o
`ALTER DEFAULT PRIVILEGES` do Supabase. Sem isso o `authenticated` do stub nasceria sem EXECUTE e
o assert de REVOKE passaria por acidente de ambiente — falso-verde.

## O que este PR NÃO resolve (deliberadamente)

- **A geração continua em ~30/dia para 3 donos.** ~10 planos/dia por vendedor não é executável em
  venda consultiva. Reduzir é config (`farmer_algorithm_config`, 17 linhas), não código — ficou
  como item separado. → **resolvido na fase 2, mas por outro motivo que não o esperado; ver abaixo.**
- ~~**O custo de registrar continua alto.**~~ → **resolvido na fase 3** (PR #1701, ao fim deste
  documento). O elo de margem com o Omie continua pendente.
- **Não se sabe se a tela é aberta.** Não há telemetria server-side do módulo Farmer
  (`farmer_audit_log` e `farmer_copilot_events` estão vazias); a fonte seria o PostHog.

## Lição

O post-mortem irmão catalogou o writer **inalcançável**. Este é o caso oposto e mais difícil de
enxergar: **o writer é alcançável, funciona, e mesmo assim o registro nunca acontece** — porque a
própria geração empurra o item para fora da janela antes que alguém aja sobre ele.

Corolário para revisão: **quando uma tabela de intenção tem muitas linhas e nenhuma transição de
estado, meça a taxa de PRODUÇÃO contra o tamanho da JANELA de consumo antes de culpar a adoção.**
Uma fila que recebe 30/dia e mostra 50 no total dá ao humano menos de dois dias de folga — e
nenhuma tela comunica isso sozinha.

E a leitura que veio da matéria: **desfecho que depende de digitação manual não é capturado.**
É por isso que 70% dos dados se perdem no modelo antigo, e é exatamente o padrão aqui.

---

# Fase 2 — 533 planos eram 80 clientes: a fila regenerava a si mesma

> 2026-08-08. A fase 1 deu SAÍDA à fila. A fase 2 fecha a ENTRADA, e a causa achada no
> caminho não era a que a fase 1 previa.

## A hipótese herdada estava certa no sintoma e errada na causa

A fase 1 registrou: *"a geração continua em ~30/dia para 3 donos; reduzir é config"*. A leitura
implícita era "o `TOP_N = 25` da edge é grande demais". Duas medições desmontaram isso:

1. **`TOP_N` é por FARMER, não global** (o loop de `tactical-plans-batch/index.ts` chama
   `selecionarParaPregeracao` uma vez por carteira). O teto seria 9+25+25 = 59 alvos/dia, e a
   produção real é ~25 — ou seja, **o `TOP_N` nunca foi o limitante**. O que fixa 25 é o batch
   truncando (hipótese: o `timeout_milliseconds := 150000` do `net.http_post` cortando o fan-out;
   não confirmável em retrospecto porque `net._http_response` só retém ~6h e o batch roda 08:00 UTC).
2. **95% da geração diária era repetição.** Dos 25 planos de 07/08, **23** eram de cliente que já
   tinha plano nos 7 dias anteriores; em 05/08 e 31/07, **25 de 25**.

| Medição (psql-ro, 2026-08-08) | Valor |
|---|---|
| 533 planos ⇒ clientes DISTINTOS | **80** |
| Fila viva (169 `gerado`) ⇒ clientes | **35** — 14 deles com **7 cópias** cada |
| Candidatos que passam o gate de R$/h | 174 — **97 nunca receberam plano** |
| `gross_margin_pct` preenchido | 1.075 de 6.633 (16%) — o batch é cego em 84% da carteira |

A vendedora não via "10 clientes por dia". Via **o mesmo cliente sete vezes** — uma cópia por dia
da janela — enquanto 97 clientes elegíveis nunca foram alcançados.

## A causa: a idempotência media o DIA, e a fila mede a JANELA

`criar_plano_tatico` perguntava *"já gerei para este cliente HOJE?"* (dia operacional BRT). Aquilo
consertou as 30 duplicatas do mesmo dia do incidente 2026-07-21/22 — e foi correto para aquele bug.
Mas com o batch rodando diariamente, o cliente voltava a ser candidato toda madrugada. A trava
casava com a periodicidade do produtor, não com a do consumidor.

A pergunta certa é **"este cliente já está na fila de alguém?"**. Enquanto o plano estiver aberto,
outro plano para o mesmo cliente só produz cópia. Quando ele sai — expirado pelo cron da fase 1 ou
concluído — o cliente volta ao pool. É isso que faz a fila **circular**.

## A correção

1. **RPC (fronteira):** `criar_plano_tatico` bloqueia por plano `gerado` dentro da janela de 7 dias,
   não pelo dia operacional. `COALESCE(generated_at, created_at, now())` porque as duas colunas são
   nullable e `coluna >= x` com NULL é NULL — numa trava isso é fail-**open**, e a linha de dado
   defeituoso deixaria de bloquear em silêncio. Indecidível RECUSA.
2. **Edge (economia):** `tactical-plans-batch` lê a fila aberta e exclui esses clientes **antes** do
   corte do top-N; `generate-tactical-plan` pula sem chamar a IA. Novo contador `ja_na_fila`.
3. **`TOP_N` 25 → 2.** Com o dedupe, o `TOP_N` deixa de ser "tamanho do lote" e vira **taxa de
   entrada de clientes novos**: a fila estabiliza em `TOP_N × 7`. 2/dia ⇒ ~14 por vendedora
   (calibrado com o founder).

### O detalhe que quase virou um bug pior

Com `TOP_N` pequeno, **a ordem das operações é tudo**. Se o filtro de "já na fila" rodasse *depois*
do `slice(topN)`, o batch escolheria todo dia os mesmos 2 de maior priority, a idempotência os
pularia, e o cliente da posição 3 **nunca entraria** — a fila congelaria com aparência de
funcionamento. Por isso `jaNaFila` é parâmetro do oráculo (`selecionarParaPregeracao`) e não um
filtro no call-site: a invariante fica testada nos dois espelhos, não confiada a quem chama.

Pelo mesmo motivo `semMargem` continua contado sobre a carteira **inteira**, sobrepondo-se a
`naFila`: ele mede a cegueira do batch, e se passasse a excluir quem está na fila, encher a fila
faria a cegueira "melhorar" sozinha.

### O gate de R$/h NÃO subiu — e a medição é o motivo

A pergunta em aberto era se `PROFIT_PER_HOUR_THRESHOLD` (50) deveria subir junto. Medido: os top-5
por priority de cada carteira já têm R$/h entre **52 e 14.513**. Com `TOP_N = 2`, quem entra já passa
folgado — subir a régua seria mexer numa fronteira de negócio sem que ela mudasse resultado nenhum.

## Prova

`db/test-tactical-idempotencia-janela.sh` (PG17, 18 asserts + 3 falsificações). Os asserts que
importam são o par: **A2** (plano de 3 dias bloqueia) e **A3** (plano de 8 dias volta a gerar) —
sozinho, o A2 seria satisfeito por uma trava permanente, que troca "entope" por "congela".

A falsificação **F1** restaura a trava da fase 1 e exige que o A2 fique vermelho; **F2** remove o
`COALESCE` e exige que o A8 (`generated_at` NULL) fique vermelho; **F3** estica a janela para 365
dias e exige que o A3 quebre — sem ela, o A3 estaria provando apenas "existe algum plano", não a
janela.

## Lição

**Uma trava de idempotência tem de casar com o ciclo do CONSUMIDOR, não com o do produtor.** A
chave "por dia" era invisível como defeito: ela funcionava, tinha teste, e o incidente que a
motivou era real. O que mudou foi o produtor virar diário — e aí a mesma trava correta passou a
autorizar exatamente uma cópia por dia.

Corolário para revisão: **quando uma tabela de intenção cresce mas a contagem de entidades
distintas não, o defeito está na chave de idempotência, não no volume.** 533 planos e 80 clientes
é um número que se lê em uma query e que nenhuma tela mostra.

---

# Fase 3 — o custo de captura: registro de desfecho em 1 toque (2026-08-07, PR #1701)

> Entregue **em paralelo** com a fase 2, por outra sessão. As duas são complementares e
> nenhuma torna a outra dispensável: a fase 2 fecha a **entrada** (a fila parou de regenerar o
> mesmo cliente), esta baixa o **custo de registrar o desfecho**. A fase 2 fez os planos
> alcançarem 97 clientes que nunca haviam recebido um; esta faz o resultado da ligação existir
> como dado. Sem a fase 2, o 1 toque seria aplicado sete vezes ao mesmo cliente.

A fase 1 **falsificou a hipótese da fila**: com saída, janela de 7 dias e ordenação por risco, os
planos ficaram alcançáveis — e o desfecho seguiu em zero (medido no mesmo dia, já com o cron
rodando: 364 `expirado` + 169 `gerado`, **0** com `actual_margin`, **0** com `call_result`). Sobrou
uma causa só: o formulário.

**Cinco botões na FACE do card** (Vendeu · Interesse futuro · Não vendeu · Não atendeu · Remarcou),
para planos `gerado`. O `RecordResultDialog` permanece no expandido como caminho **detalhado** — e
é por ele que plano `expirado` segue registrável.

**Nada de SQL.** `pg_get_functiondef` da PROD mostrou que `registrar_resultado_plano` aceita `NULL`
explícito nos parâmetros (eles não têm `DEFAULT`, mas isso não os torna `NOT NULL`), as colunas de
destino são todas nullable e a tabela não tem CHECK. A suposição de que "campo obrigatório na
assinatura" exigiria alterar a função custaria o ritual inteiro de banco por nada.

**O payload é o produto.** Um toque afirma UM fato; margem, duração e adesão ao roteiro vão como
`NULL`. O `plan_followed` é `null` nos **cinco** — inclusive nos três com conversa: gravar `true`
ali parece razoável e é fabricação, porque o toque não pergunta se ela seguiu o roteiro. É o `|| 0`
vestido de booleano.

**As metades que faltavam.** Passar a gravar `null` acendeu quatro leitores inertes *porque não
existia um único plano concluído* — e cada um deles mentiria no dia seguinte ao Publish:
`planFollowed ? 'Sim' : 'Não'` exibindo **"Não"** para todo registro de 1 toque; `call_result` cru
na tela; `parsePlan` com `d.actual_margin ? … : undefined` (o `|| 0` **espelhado**, que perde a
margem 0 *apurada*); e `getEffectivenessStats` dividindo margem por um `count` que inclui os não
apurados.

⚠️ **Decisão consciente:** os cinco desfechos **concluem** o plano, porque a RPC força
`status='concluido'`. Tratar "não atendeu" como não-conclusivo exigiria alterar SQL. Ficou como
follow-up **medido**: se "não atendeu" sair sub-representado, é sinal de que a vendedora evita o
botão para não perder o plano — e aí a mudança volta com evidência.

**A prova real não é o CI.** É `SELECT status, count(*), count(actual_margin) FROM
farmer_tactical_plans GROUP BY 1` uma semana depois.

### ⚠️ Errata (2026-08-13) — a inferência acima tinha um buraco

O parágrafo original terminava assim: *"se `concluido` continuar em 0, o gargalo é adoção da tela,
não custo do formulário"*. **Isso estava errado por omissão**, e a medição de seis dias depois
mostrou por quê.

Medido em 2026-08-13:

| Fato | Evidência |
|---|---|
| Código **no ar** | string `Remarcou` (única de `BotoesDesfecho.tsx`) presente em `/assets/FarmerTacticalPlan-DxJ6Rly6.js`, 331 chunks varridos (`verify-frontend.sh`) |
| Desfechos | **0** — 508 `expirado` + 169 `gerado`, nenhum `call_result` |
| Fila | `gerado` estacionou em ~169 com ~24/dia — **regime estacionário**, a fase 2 fechou a entrada |
| Telemetria da tela | **nenhuma** — zero `track()` em `FarmerTacticalPlan.tsx` e em `tacticalPlan/`, contra 66 arquivos do repo que usam |

E a causa real, dita pelo founder: **as vendedoras ainda não começaram a usar o aplicativo.**

O zero não media a tela nem o formulário — media a **ausência de usuários**. A inferência original
saltava de "0 desfechos" para "gargalo de adoção da tela" pulando duas hipóteses que a precedem:

1. **O código chegou a produção?** Merge na `main` não publica nada (§Lovable = 3 deploys manuais).
   Sem verificar por bytes, o zero é indistinguível de "o Publish nunca saiu".
2. **O público-alvo está em operação?** Um denominador de zero usuários produz numerador zero em
   QUALQUER desenho de tela — o melhor botão do mundo mede o mesmo que o pior.

É a mesma família de *ausência de dado ≠ afirmação* que este repo já cataloga, um andar acima: não é
um número fabricado a partir de `null`, é um **veredito de produto fabricado a partir de um zero sem
denominador**. E o alvo do veredito seria o trabalho de outra pessoa ("a vendedora não adota a
tela"), o que torna o erro mais caro do que um número errado.

**Corolário para revisão:** antes de ler zero como veredito sobre uma tela, prove (a) que o código
está no ar e (b) que existe alguém do outro lado. Só depois de descartar essas duas o zero fala
sobre o desenho. Métrica de adoção sem denominador não é métrica — é o `Number(null) === 0` em
escala de produto.

**Quando medir de verdade:** quando as vendedoras entrarem em operação — gatilho por **evento**, não
por calendário. Se nessa altura o desfecho continuar em zero, aí sim a pergunta é a tela, e o
primeiro passo é instrumentar com `track()` (abertura + clique) para separar "não abrem" de "abrem e
não registram".

### O gatilho virou query (2026-08-13, 2ª leitura do mesmo dia)

A errata acima deixou o gatilho dependendo de o founder avisar. Isso é frágil pelo mesmo motivo que
o zero era: **não é verificável**. A 2ª leitura mediu o denominador direto e a fala do founder virou
dado.

| Medição (psql-ro) | Valor |
|---|---|
| `master` | 1 usuário — **1 com sessão viva em 30d** (o próprio founder) |
| `employee` | 2 usuários — **0 com sessão viva** |
| `customer` | 5.664 — **0 com sessão viva** |

Os três "donos" de carteira do plano tático, com `auth.users.last_sign_in_at`:

| Farmer | Planos | Último sign-in | Sessão mais recente |
|---|---|---|---|
| Tatyana (`employee`) | 334 | **2026-04-15** | 2026-06-23 |
| Regina (`employee`) | 172 | **2026-04-13** | *nenhuma linha* |
| Lucas (`master`) | 171 | 2026-07-24 | mesmo dia, 21:07 UTC |

O app inteiro tem **um usuário ativo, e é o founder**. As duas vendedoras não abrem o sistema desde
abril. O numerador seguia idêntico (508 `expirado` + 169 `gerado`, 0 `call_result`) com a fila
saudável — 25 planos gerados às 08:03 UTC daquele dia.

**A query canônica do gatilho:**

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

Dispara quando `employee → ativos_7d ≥ 1` se sustentar por alguns dias. Só então as três leituras
previstas (gargalo de tela · `nao_atendeu` sub-representado · elo de margem com o Omie) passam a ter
denominador.

⚠️ **Por que este par de sinais tem dente, e nenhum dos dois sozinho teria.** `auth.sessions` some no
logout e na expiração — lida sozinha, "0 sessões" é **ausência de dado**, exatamente a armadilha do
`used_at`. O que salva a inferência é `last_sign_in_at`: ela é **evidência positiva** (uma data real
de abril, não um vazio) e o Postgres não a apaga. Os dois sinais são independentes e concordam. Já
`last_sign_in_at` sozinha também não bastaria na direção oposta: o Supabase não a atualiza no refresh
de token, então uma data velha seria compatível com uso diário sob sessão persistente — é a sessão
viva que fecha esse buraco. Um mede que **houve** entrada; o outro, que **há** presença.

**Lição de método:** um gatilho por evento precisa de um **detector**, não de um combinado verbal.
Enquanto o gatilho é "alguém me avisa", ele herda a mesma falha do zero sem denominador — ninguém
consegue conferir se já disparou. Escrever a query custou uma consulta e transformou a espera em algo
que qualquer sessão futura resolve sozinha, sem interromper o founder.

---

# Fase 4 — o sensor: a tela passa a dizer POR QUE veio vazia (2026-08-13)

> Aplicação direta da regra do #1726: *"fase N+1 exige SINAL da fase N — superfície de uso nasce
> com o sensor; sem sensor, a fase N+1 é instalá-lo."* A errata acima previu este passo
> ("instrumentar com `track()` — abertura + clique"); esta fase o instala. Padrão herdado do
> **#1717** (`c1c5ad25`), que resolveu a mesma classe na tela irmã `/rota/ligacoes`.

## A abertura já estava coberta — e duplicá-la seria o erro

A rota `/farmer/tactical-plan` vive dentro do `AppShellLayout` → `AppShell` → `PageViewTracker`,
que emite `$pageview` a cada mudança de rota. Um evento novo de "abertura" criaria um **segundo
denominador, divergente do primeiro, para a mesma pergunta**. O que faltava era o **desfecho** da
abertura. Mesma conclusão do #1717, verificada aqui em vez de assumida por analogia.

## São 4 saídas, e 3 produziam o mesmo pixel

`loadPlans` (`src/hooks/useTacticalPlan.ts`):

| # | Saída | O que a tela mostrava | Estado da lista |
|---|---|---|---|
| 1 | `!effectiveUserId` → `return` | "Nenhum plano pendente" | intocada (nem liga o `loading`) |
| 2 | **`error` da consulta** | "Nenhum plano pendente" | limpa |
| 3 | `data` vazio | "Nenhum plano pendente" | limpa |
| 4 | `catch` (só `console.error`) | **a lista ANTIGA** | **preservada** |

A perigosa é a **(2)**: o código fazia `const { data } = await …`, **descartando o `error`**, e
`!data` caía no mesmo `setPlans([])` da (3). Falha de consulta era pixel-idêntica a fila vazia —
e classificá-la como "não há plano" é fabricar diagnóstico (money-path §2). O `error` passou a
ser lido **apenas para declarar o motivo**; o que a tela renderiza é byte-a-byte o de antes.

A **(4)** é a que o dado precisava dizer em voz alta: o `catch` não toca em `plans`, então a tela
segue exibindo o retrato do carregamento anterior *como se fosse o atual*. Daí a propriedade
`manteve_lista` — sem ela, "quebrou e esvaziou" e "quebrou e está mentindo em silêncio" são o
mesmo evento.

A **(1)** é hoje inalcançável por esta tela (`useFarmerTacticalPlan` gateia por `user?.id`, e
`effectiveUserId` deriva do mesmo `user`). Instrumentada mesmo assim, para que um chamador futuro
a torne visível em vez de silenciosa — declarado no código, não descoberto de novo.

## Eventos (`<area>.<action>`, área `plano_tatico.` — nova, sem colisão)

```
plano_tatico.fila_carregada   { filtro, n_exibidos, total }
plano_tatico.fila_vazia       { filtro, total, motivo: sem_escopo | sem_resposta | recorte_vazio }
plano_tatico.fila_erro        { filtro, total, origem: consulta | excecao, mensagem, manteve_lista }
plano_tatico.desfecho_clicado { plano_id, desfecho, origem: um_toque }
plano_tatico.desfecho_erro    { plano_id, desfecho, mensagem }
```

**Precedência do erro sobre `data` — garantida pelo TIPO, não por ordem de `if`.** A variante de
erro de `SaidaDaCarga` **não carrega `nExibidos`**: é inrepresentável reportar tamanho de lista
num caminho de falha. Sem isso, uma carga que *passou* a falhar seguiria reportando sucesso com o
número velho (que na saída 4 continua na tela).

**`total` viaja como `null` quando não apurado, nunca como 0** — mesma regra do rótulo da tela.

**O clique sai DEPOIS do guard e ANTES do `await`.** Depois do guard porque toque barrado (lente
"Ver como" / gravação em curso) não é tentativa. Antes do `await` porque o caso que mais importa
é *clicou e a gravação morreu*: no sucesso o dado já existe no banco (`call_result`); é a
**tentativa** que não existia em lugar nenhum.

`desfecho_erro` fica no `catch` de `recordResult`, então cobre os **dois** caminhos de registro
(1 toque e dialog detalhado). O caminho do dialog não emite `desfecho_clicado` — o sucesso dele já
é visível no banco, e o escopo desta fase são os 5 botões de 1 toque.

## O que este sensor NÃO responde

Ele mede a tela, não a operação. O denominador continua sendo a query do §"O gatilho virou query"
— com `employee → ativos_7d = 0`, os cinco eventos vão registrar zero, e **esse zero também não
julga o desenho**. A leitura só começa quando as vendedoras entram em operação. O que muda é que,
a partir daí, o zero deixa de ser mudo.

> ⚠️ Escrito na manhã do merge. **No mesmo dia o `ativos_7d` virou 1** — ver logo abaixo.

### Prova de que está NO AR (2026-08-14, mesmo dia do merge)

A errata de 13/08 existe porque ninguém provou que o código estava em produção antes de ler o
zero. Esta fase não repete o erro — verificado por BYTES no bundle servido:

| Evento | Chunk em prod |
|---|---|
| `plano_tatico.desfecho_clicado` | `FarmerTacticalPlan-_gF1pb_b.js` |
| `fila_carregada` · `fila_vazia` · `fila_erro` · `desfecho_erro` | `useTacticalPlan-C7zaXS-y.js` |

**318 chunks varridos** (enumerados do entry `index-CqhqXtgJ.js` + `index.html`). O hash do chunk
da página mudou de `DxJ6Rly6` (13/08) para `_gF1pb_b` ⇒ houve build novo.

⚠️ **Um chunk só nunca é a prova.** Os 4 eventos da fila estão AUSENTES do chunk da página, porque
`useTacticalPlan` é importado também pelo Copilot e o bundler o manda para um chunk compartilhado.
Ler esse "ausente" como "não publicado" seria fabricar veredito a partir de enumeração incompleta —
a varredura tem de ser a UNIÃO das fontes.

### O gatilho DISPAROU — e o sensor chegou junto

Medido no mesmo dia, com o par de sinais que o §"O gatilho virou query" exige:

| Quem | Papel | `last_sign_in_at` | Sessão mais recente |
|---|---|---|---|
| Lucas | master | 2026-07-24 | 2026-08-14 22:12 |
| Tatyana | employee | 2026-04-15 | **2026-08-14 17:03** |
| Regina | employee | 2026-04-13 | *nenhuma* |

`employee → ativos_7d` saiu de **0 (13/08) para 1**. A sessão da Tatyana, que em 13/08 estava
parada em 23/06, foi atualizada HOJE — e sob a leitura do próprio §gatilho (o Supabase não mexe em
`last_sign_in_at` no refresh de token), sign-in velho + sessão viva = presença.

⚠️ **Presença ≠ uso da tela.** Um refresh de token acontece em aba de fundo; isto NÃO prova que ela
abriu o Plano Tático. Mas essa distinção era indecidível até ontem, e é exatamente a que o sensor
passa a responder. Desfechos seguem em **0** (533 `expirado` + 148 `gerado`, nenhum `call_result`).

**Próxima leitura é no PostHog, não no banco:** `$pageview` de `/farmer/tactical-plan` e os cinco
`plano_tatico.*`. Se houver pageview e nenhum `desfecho_clicado`, aí sim a pergunta é a tela.

## Lição

O sensor tem de nascer com a **taxonomia das saídas**, não com um contador. "Instrumentei a tela"
com um evento único de abertura teria produzido exatamente o mesmo impasse um nível acima: um
número sem como saber o que ele significa. O trabalho real não foi chamar `track()` — foi **ler o
código e enumerar as saídas**, e descobrir que uma delas (o `error` descartado) já era um bug de
observabilidade esperando para ser lido como veredito de produto.
