# A canária NATURAL de schema — quando a edge não tem sonda, a coluna que ela estreia é a prova

> Prova de VERSÃO do **PR #1888** (PR-2/A2 da identidade Omie, mergeado 2026-08-22 como `a9410fdaa`),
> obtida em **2026-08-23** sem sonda de versão, sem Management API e sem pedir nada ao founder.
> Irmão de [`deploy-no-op-por-desenho.md`](deploy-no-op-por-desenho.md), que registra o caso oposto:
> o deploy que **nenhuma** canária consegue provar.
>
> **Onde isto se encaixa:** o `deploy.md` já documentava 4 caminhos de prova de versão — canária
> (`?canary=1`), sonda (`{"probe":true}`), **assinatura no próprio log da edge** e **assinatura de gate**.
> Esta é o **caso BINÁRIO do terceiro**: lá a testemunha é uma coluna preexistente cujo *valor* o defeito
> enviesava, e o veredito é estatístico (é preciso argumentar que aquela distribuição não vem do código
> novo); aqui a testemunha é uma coluna que o PR **estreou**, e o argumento some — o código velho não
> podia escrevê-la **por inexistência**. Um único valor não-nulo basta.

## O beco

As edges `omie-vendas-sync` e `omie-analytics-sync` foram deployadas manualmente em 2026-08-22 e passaram
no **N1** (existência, `verify-edge.sh`). Aí a escada da `lovable-deploy-verify` acaba:

- **N2 (versão)** — a Management API é **estruturalmente indisponível** aqui: o Supabase é da org do
  Lovable, o founder não tem conta com acesso ao ref, logo **não existe PAT que ele possa gerar**. ⛔
- **N3 (comportamento)** — as duas **não estão** entre as 5 edges com canária de versão do #1772, e a
  canária que a `omie-analytics-sync` tem (`doc_ambiguo_probe`) é **NÃO-VERSIONADA**: responde igual com
  bundle velho ou novo (o "mente verde" da ⚠️ #2 do `deploy.md`).

Sondar às cegas também não serve: bundle **anterior** à sonda ignora o parâmetro e **executa o fluxo real**
(sync Omie inteiro). O caminho normal estava fechado nos três degraus.

## A saída: o PR estreou uma COLUNA

`20260821192817_omie_identidade_a2_client_to_user.sql` criou `omie_customer_account_map
.evidence_document_normalized` — e **só o TypeScript novo** do `omie-analytics-sync/syncCustomers` a
escreve. Isso a torna uma **canária natural**: não foi construída para provar deploy, mas prova, porque
presença ⇒ o writer novo rodou. As **4 condições** que a fazem valer (todas verificadas antes de concluir):

1. **A coluna é NOVA** — a ausência prévia é *garantida por DDL*, não inferida de amostra. Em 2026-08-22
   estava em **0 de 16.118**.
2. **Sem backfill** — a própria migration é explícita: *"TODAS nascem com evidence NULL — o backfill é
   justamente NÃO backfillar (NULL = sem prova)"*. Um `UPDATE` de backfill teria provado o **SQL**, não a edge.
3. **Writer exclusivo** — nenhum outro caminho preenche. Verificado em prod: **0 triggers** na tabela; das
   2 funções que citam a coluna, `register_carteira_member` a grava **`NULL` sempre** (INSERT *e* `ON
   CONFLICT UPDATE` — ela zera, nunca preenche) e `omie_sync_identity_snapshot` **só lê**.
4. **Há um writer que roda SOZINHO** — 3 crons diários (`0/20/40 5 * * *` UTC) chamando `sync_customers`.
   Sem isso a canária só responderia se alguém acionasse a tela, e "ninguém preencheu" seria ambíguo.

## A medição que PROVOU a versão (2026-08-23, ~21:26 UTC, via `psql-ro`)

| account (empresa) | cron | total | com evidência | último write |
| --- | --- | --- | --- | --- |
| `oben` | `0 5 * * *` (`vendas`) | 5.621 | **5.621 (100%)** | 2026-08-23 **05:03:09** |
| `colacor` | `20 5 * * *` (`colacor_vendas`) | 5.201 | **5.201 (100%)** | 2026-08-23 **05:20:58** |
| `colacor_sc` | `40 5 * * *` (`servicos`) | 5.296 | 0 | 2026-07-18 (congelado — ver abaixo) |

**0 → 10.822 em um dia**, e o `updated_at` de cada bloco cai **em cima do horário do cron da própria
conta**. É a diferença entre "a coluna tem dado" e "a coluna foi preenchida por AQUELE writer, NAQUELE
run": a canária natural **data e assina** o deploy de graça. **Versão PROVADA.**

## N3 de produto — o `client_to_user` deixou de ser `{}`

Bytes provam que o código subiu; não provam que o **valor** chegou. A RPC `omie_sync_identity_snapshot`
é gated (o `claude_ro` leva `permission denied` — desenho certo, gate na fronteira), então em vez de
contornar o gate, **reproduzi a lógica dela** em SQL read-only a partir do `pg_get_functiondef` de prod:
`client_to_user` saiu de `{}` para **5.621 (oben) + 5.201 (colacor)**, com **100%** das linhas com
evidência sobrevivendo ao filtro de não-ambiguidade (`n_users = 1`) — zero documento ambíguo virou
vínculo. A transição fail-closed descrita no PR **terminou** para essas duas contas.

## O passo que quase se pula: falsificar a própria conclusão

Ver `com_evidencia > 0` e declarar vitória seria a armadilha. A pergunta que fecha a prova é **"que OUTRO
caminho poderia ter preenchido isto?"** — foi ela que produziu a condição 3 acima. E o resultado foi melhor
que "nenhum outro": `register_carteira_member` grava a coluna como `NULL` **por desenho** (comentário na
migration: *"esta RPC não prova identidade por documento — não pode deixar a prova de outro writer colada
na linha que ela acabou de reescrever"*). O único suspeito plausível **zera** a canária em vez de
preenchê-la, o que torna 10.822 preenchidos ainda mais inequívoco.

## A mesma canária mediu a RECUPERAÇÃO (re-medição 2026-09-06)

O `colacor_sc` zerado em 23/08 **não era regressão do #1888** — era o sync de `servicos` congelado desde
2026-07-18, incidente investigado e resolvido por outras sessões (#1971 causa-raiz, #1980 sentinela, #2000
verificação, #2012 o `timeout_milliseconds`), com o relato completo em
[`sync-servicos-congelado-verificacao.md`](sync-servicos-congelado-verificacao.md). A causa real foi um
**guard de colisão de código** na união de fontes do `fetchCodigoUserMap` — **não** a hipótese de
credencial ausente que eu havia levantado aqui e não conseguia confirmar por SQL.

Re-medindo em **2026-09-06 23:15 UTC**, a mesma query devolve:

| account | total | com evidência | último write |
| --- | --- | --- | --- |
| `oben` | 5.621 | **5.621 (100%)** | 2026-09-06 05:02:50 |
| `colacor` | 5.201 | **5.201 (100%)** | 2026-09-06 05:20:56 |
| `colacor_sc` | 5.296 | **5.296 (100%)** | 2026-09-06 **05:41:05** |

**16.118 de 16.118.** A canária natural, criada para provar um deploy, **também datou o destravamento do
sync** — sem instrumentação nova. Uma coluna que só o caminho saudável escreve é simultaneamente prova de
versão e sensor de saúde do writer: onde ela está NULL, aquele writer não passou.

⚠️ **A lição de método embutida:** este doc quase foi entregue em 23/08 com uma seção "achado lateral —
hipótese não confirmada (credencial)". Duas semanas depois ela seria **desinformação**, e a hipótese estava
**errada**. Medição tem prazo de validade: antes de entregar, **re-meça** e procure na `main` se o achado
lateral já virou trabalho de outra worktree (`git log --grep`) — o registro é para quem chega depois, e
uma especulação errada custa mais do que a omissão.

## A regra que fica

> **Antes de declarar "sem canária, versão não provável", pergunte se o PR estreou SCHEMA.** Coluna/tabela
> nova com writer exclusivo é canária de graça — mais forte que sonda, porque a ausência prévia é garantida
> por DDL em vez de inferida, e o `updated_at` do write assina *qual* run a preencheu. É a variante mais
> barata de procurar: quando existe, dispensa a análise de distribuição que o caminho da assinatura-no-log
> exige.

**Quando NÃO serve:** (a) a migration faz backfill (prova o SQL, não a edge); (b) mais de um writer alcança
a coluna (presença deixa de ser assinatura — cheque triggers *e* `pg_get_functiondef`, não só o TS);
(c) o PR não toca schema — aí o marcador de versão volta a ser pré-requisito, como em
[`deploy-no-op-por-desenho.md`](deploy-no-op-por-desenho.md); (d) não há writer autônomo, e "0" fica
ambíguo entre "bundle velho" e "ninguém acionou".

**Dívida que continua aberta:** `omie-vendas-sync` e `omie-analytics-sync` seguem **sem canária versionada**
(a da `omie-analytics-sync` acumula o 3º congelamento registrado — #2002). Desta vez o schema salvou; o
próximo PR nessas edges pode não estrear coluna nenhuma.
