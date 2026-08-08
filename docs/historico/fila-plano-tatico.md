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
- **O custo de registrar continua alto.** O `RecordResultDialog` pede 4 campos, entre eles a
  **margem realizada** digitada, que a vendedora dificilmente sabe durante a ligação. O caminho
  natural é registro de 1 toque (ligou / não atendeu / vendeu / recusou) com a margem vindo do
  pedido no Omie pelo elo, não do teclado.
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
