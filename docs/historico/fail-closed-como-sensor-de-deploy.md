# O erro fail-closed como SENSOR de deploy — e o secret cujo nome convida a inventar valor

> **#2035 (`analytics_outbox`, commit `d5d79cf11`, money-path) — desbloqueio medido em 2026-08-28/29.**
> Duas lições que parecem separadas e são a MESMA decisão de desenho vista de dois lados: a mensagem
> de erro que provou qual bundle estava em produção é a mesma que impediu a perda silenciosa de 105
> eventos. Quem escreveu `return json({ erro: "POSTHOG_INGEST_KEY nao configurado" }, 500)` em vez de
> degradar em silêncio ganhou as duas de uma vez, e provavelmente só mirava uma.

## O que aconteceu

A sessão recebeu uma tarefa herdada com estado medido: migration 1 aplicada, **deploy da edge
pendente**, **migration 3 (cron) pendente**, 74 eventos parados na outbox. A ordem estava escrita no
cabeçalho da própria migration 3 (tabela → edge → cron) porque invertê-la aponta o cron para função
inexistente: 404 a cada 5 min com `cron.job_run_details = succeeded`, que só prova o ENQUEUE.

**A premissa estava vencida.** Entre a medição do prompt (10:16Z) e a re-medição (23:32Z), outra
sessão completou os dois passos. Pedir o deploy teria sido o gasto redundante que a própria tarefa
mandava evitar. O que travava era outra coisa, invisível na descrição original: **faltava o secret
`POSTHOG_INGEST_KEY`**.

## Lição 1 — a mensagem de erro ÚNICA prova a VERSÃO da edge, de graça

Neste projeto o N2 (Management API) é **estruturalmente indisponível** — o Supabase é da org do
Lovable, não existe PAT que o founder possa gerar. Sobra N1 (existência, via `OPTIONS`) e N3
(comportamento). O `verify-edge.sh` deu N1 verde, o que **não** prova qual bundle está servido.

A prova de versão veio de graça, do `net._http_response` — gravado por uma invocação avulsa, **não**
pelo cron do drain, que nesta hora ainda não existia (a migration 3 seguia pendente; ver §Fecho):

```
id 62407 · 2026-08-28 23:35:00Z · status 500
{"erro":"POSTHOG_INGEST_KEY nao configurado"}
```

`git grep` provou que essa string existe em **um único arquivo do repo** —
`supabase/functions/analytics-outbox-drain/index.ts:74`, criado por este PR. Só o bundle do #2035
pode tê-la emitido. Isso é **N3, prova de versão**, não N1.

**Por que é mais barato que as vias já documentadas.** A skill `lovable-deploy-verify` cobre o N3
PASSIVO pela **forma do JSON** (conjunto de chaves como assinatura estrutural) e o **marcador
plantado** (`versao: VERSAO` em toda resposta). Ambos exigem preparo: o primeiro depende de as duas
versões terem forma diferente — sorte, não desenho; o segundo exige instrumentar a edge e manter o
`sonda:bump`. A mensagem de erro única **não exige nada**: ela já está lá porque alguém escolheu
falhar ruidosamente.

**Bônus que não custou nada:** o 500 vem DEPOIS do `authorizeCronOrStaff`, então a mesma linha prova
que o `x-cron-secret` do Vault está correto. Um secret errado teria parado antes, com 401.

### Quando vale e quando não vale

| condição | por quê |
|---|---|
| ✅ a string é **única no repo** (`git grep` prova) | é o que separa "esta versão" de "qualquer versão" |
| ✅ o corpo do erro chega a `net._http_response` | edge chamada por cron grava sozinha; dentro de `pg_net.ttl = 6 h` |
| ⛔ mensagem genérica (`{"error":"internal"}`) | não discrimina bundle nenhum |
| ⛔ a string também existe em `_shared/` ou noutra edge | prova o módulo, não a versão daquela edge |
| ⚠️ prova o bundle que RESPONDEU, não que o trabalho deu certo | mesma ressalva do eco de `versao` |

**A ironia operacional que vale registrar:** esta via só existe **enquanto algo está quebrado**. Depois
do fix a edge devolve `{"reivindicados":…}` e a mensagem some. Não é substituta de sonda — é o que
usar no exato momento em que se está diagnosticando, que costuma ser quando mais falta prova de
deploy.

## Lição 2 — nome de secret que convida a INVENTAR valor é armadilha money-path

A primeira pergunta do founder, verbatim: **"POSTHOG_INGEST_KEY qual senha eu coloco?"**

Pergunta correta. O nome sugere credencial que se gera. Não é: é a **Project API Key** do PostHog
(`phc_…`), pública por desenho, já assada no bundle do frontend como `VITE_POSTHOG_KEY` — que também
explica a pergunta seguinte, **"não achei em secrets essa vite posthog"**. E não acharia: `VITE_*` é
`import.meta.env`, resolvido em BUILD-time e congelado no bundle; `POSTHOG_INGEST_KEY` é
`Deno.env.get()`, runtime da edge. Listas diferentes, mundos diferentes.

### O modo de falha que um valor inventado produziria

Está no comentário do próprio código, `index.ts:144`:

> "aceito" = ACEITE HTTP. O PostHog responde 200 e ainda assim descarta evento inválido

Com chave inventada, o PostHog responde **200** e joga fora. A edge lê 200 como aceite, chama
`analytics_outbox_aceitar`, e então:

- a fila drena (`pendentes` → 0) — parece sucesso
- `aceitos` sobe — parece sucesso
- o cron fica verde — parece sucesso
- **os 105 eventos nunca chegaram a lugar nenhum**

Trocar o 500 ruidoso por isso é trocar um problema visível por um invisível — exatamente a classe que
a outbox existe para acabar (`docs/historico/fase-sem-sinal.md`: "no ar e ninguém reclamou" é ausência
de dado). **Chave rejeitada (401/403) seria segura**, porque a edge manda para quarentena e para de
tentar; o perigo é a chave *aceita e ignorada*.

### A contramedida barata: entregar o valor sem que ele passe pelo chat

A chave estava pública no bundle servido. Em vez de pedir ao founder que a colasse na transcrição
(que persiste em disco), o comando devolve o valor **no terminal dele**, e o agente só publica um
fingerprint mascarado para conferência:

```bash
curl -s "https://steu.lovable.app$(curl -s https://steu.lovable.app/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)" | grep -oE 'phc_[A-Za-z0-9]{20,}' | head -1
```

Regra geral: **secret cujo valor correto já existe em algum lugar não deve ser descrito, deve ser
localizado.** Descrever ("é a chave de ingestão do PostHog") convida a inventar; localizar ("sai deste
comando, confira que bate com `phc_noNh…3D4s`") não.

## Verificação — as três camadas que "drenou" NÃO cobre

Depois do secret, a série capturou a transição na mesma tabela:

```
00:35:01  500  {"erro":"POSTHOG_INGEST_KEY nao configurado"}
00:40:00  200  {"reivindicados":105,"aceitos":105,"transitorios":0,"quarentena":0}
```

`quarentena=0` prova que não houve 401/403. **Isso ainda não prova ingestão** — pela Lição 2, 200 do
PostHog é compatível com descarte total. A prova real exigiu ler o destino, via
`scripts/posthog-query.sh` (HogQL read-only):

| camada | como se prova | resultado |
|---|---|---|
| drenou | `aceito_em` na outbox | 105 aceitos, 0 pendentes |
| **chegou** | HogQL no PostHog | **105** (94 criada + 7 expirada + 4 aprovada) |
| chegou **íntegro** | `min(timestamp)` no destino | `2026-08-26T16:16:15.556Z` = `min(ocorrido_em)` da outbox |

A terceira linha é a que quase se esquece: os 105 foram ingeridos às 00:40 mas com a data ORIGINAL
preservada. Se a edge tivesse carimbado a hora do drain, a série chegaria completa e **inutilizável**
para qualquer pergunta temporal — e a contagem, sozinha, não denunciaria.

### Falso susto: reconciliação divergente durante o bootstrap

`analytics_outbox_reconciliacao` acusou fonte 8 vs outbox 4, e fonte 25 vs outbox 7. **Não era perda.**
A view janela 7 dias nos DOIS lados, mas a outbox nasceu em 26/08. Medindo desde o nascimento dela:

| evento | fonte (desde o corte) | outbox | fonte (antes do corte) |
|---|---|---|---|
| aprovada | 4 | **4** ✅ | 4 |
| expirada | 7 | **7** ✅ | 18 |

4+4=8 e 7+18=25 reproduzem exatamente o `na_fonte` da view. Captura perfeita; a divergência se fecha
sozinha em 02/09, quando a janela couber inteira na vida da outbox.

⚠️ **Regra:** view de reconciliação com janela FIXA mente durante o bootstrap do que ela mede — e
mente para o lado alarmante (parece perda). Antes de investigar divergência, compare a idade do
coletor com a janela da view.

## Fecho — a migration 3 entrou em 2026-08-29, e só aí o ciclo virou autônomo

Os 105 eventos drenaram **por invocação avulsa**, com a migration 3 ainda pendente. O cron nasceu
depois, e a distinção não é cosmética: até ele existir, cada drenagem dependia de alguém mandar.

| medição | evidência |
|---|---|
| às 00:50Z o cron do drain **não existia** | `cron.job` só tinha `analytics-outbox-purgar` (jobid 177) |
| migration 3 aplicada ~01:10Z | `cron.job` ganha `analytics-outbox-drain` **jobid 180**, `*/5 * * * *`, ativo |
| 1º tick autônomo | `min(start_time)` do jobid 180 = `2026-08-29 01:15:00.478Z` |
| a verdade HTTP desse tick | `net._http_response` id 62471, **200**, `{"reivindicados":0,"aceitos":0,"transitorios":0,"quarentena":0}` |

Os quatro campos são o `interface Resultado` da própria edge, e nenhuma outra os emite — a resposta
se auto-identifica, então o veredito não depende do `succeeded` do `job_run_details` (que só prova o
ENQUEUE). Os zeros são o resultado CERTO: a fila já estava vazia. O alarme seria `reivindicados: 0`
**com** `na_fila > 0`.

⚠️ **`min(start_time)` do jobid é o que separa "o cron rodou" de "alguém rodou".** Nenhuma resposta
anterior a 01:15Z pode ter vindo do cron 180, porque ele não tinha executado nenhuma vez — e é por
isso que a atribuição lá em cima foi corrigida. Atribuir a um agendador o efeito que veio de mão
humana faz o ciclo parecer fechado enquanto ainda depende de alguém lembrar.

## Resíduo operacional

1. **Ao verificar deploy de edge sem PAT, leia o corpo do erro antes de instrumentar qualquer sonda** —
   se a mensagem for única no repo, a prova de versão já está gravada em `net._http_response`.
2. **Secret cujo valor já existe: localize, não descreva.** Entregue o comando que o extrai, publique
   só o fingerprint mascarado.
3. **`ausente ≠ zero` tem um primo: `200 ≠ ingerido`.** Aceite HTTP não é aceite de dado; a prova é ler
   o destino.
4. **Tarefa herdada com "estado medido" tem validade.** Re-medir custou ~4 min e evitou um deploy
   redundante de edge money-path — os dois passos já tinham sido feitos por outra sessão.
5. **Efeito observado não nomeia o gatilho.** Fila drenada prova que a edge funciona, não que algo a
   chama sozinha. Antes de creditar um cron, exija `min(start_time)` do jobid dele anterior ao
   efeito — senão "está no ar" e "roda sozinho" viram a mesma frase, e só o primeiro é verdade.

## Referências
- Skill `lovable-deploy-verify` (Passo 4, "Edge — a escada": N1/N2/N3, N3 passivo pela forma do JSON)
- `docs/agent/deploy.md` §Canárias · `docs/agent/sync.md` (`cron.job_run_details=succeeded` só prova o ENQUEUE)
- `docs/historico/fase-sem-sinal.md` (ausência de dado ≠ sinal negativo)
- `docs/historico/verificar-sonda-versao.md` (empate da `VERSAO` compartilhada; anti-sinais reprovados)
