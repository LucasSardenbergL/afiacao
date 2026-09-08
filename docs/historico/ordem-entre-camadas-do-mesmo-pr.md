# A ordem entre as 3 camadas do MESMO PR — o comentário que declarava a dependência não era um gate

> **#2285 · `reposicao_claim_disparo` / Cenário B do TOCTOU de reposição · medido 2026-09-07/08.**
> A migration escreveu no próprio cabeçalho: *"ORDEM DE APLICAÇÃO: esta migration PRIMEIRO, o deploy
> da edge DEPOIS"*. A ordem foi **invertida**: a edge foi deployada, provada por sonda e ficou
> servindo por **≥2h25min** chamando uma RPC que não existia. Ninguém desobedeceu — **ninguém foi
> perguntado**, porque nada no caminho do deploy lê aquele parágrafo.

## O que aconteceu (cronologia medida)

| Quando (UTC) | Fato | Fonte |
|---|---|---|
| 2026-09-06 01:21:45 | última atestação da edge ANTERIOR (`v1.1-marco-causal`) | `deploy_atestacoes` |
| 2026-09-07 **21:22:19** | edge `v1.2-claim-disparo` **provada no ar** (sonda, req 72246) | `deploy_atestacoes` |
| 2026-09-07 **23:47** | colunas `disparo%` = **0** (controle: 58 colunas) · `reposicao_claim_disparo` = **0** (controle: 22 funções `reposicao_%`) | `psql-ro`, `pg_attribute`/`pg_proc` |
| 2026-09-08 **00:04:41** | tudo presente · controles moveram para **60** e **24** | `psql-ro` |

Os dois controles moverem-se **exatamente pelo delta da migration** (+2 colunas, +2 funções) é o que
separa "o banco mudou" de "minha leitura estava errada". Sem controle positivo nas duas medições,
esta linha seria opinião.

## Por que não virou prejuízo — e por que isso foi SORTE DE DESENHO, não do processo

A edge é **fail-closed no claim**, e o autor previu literalmente este caso:

> *"Erro na RPC (rede, RLS, **coluna ausente porque a migration ainda não foi colada**) NÃO libera o
> disparo: sem conseguir reivindicar, não compramos. Ausente ≠ autorizado."*

Claim com erro → `status_final = "nao_disparado"` e `return` **sem escrever nada** na linha. Por isso
o estrago foi de **disponibilidade**, não de dado — medido no fim da janela: **0** pendências de
disparo abertas, **0** pedidos em `falha_envio`, nenhum resíduo da sonda da postcondição, e o único
pedido disparável (id 2388) **intocado desde 2026-09-03**, no estado correto para o próximo run.

Trocasse-se aquele `return` por um `throw`, o mesmo intervalo teria gravado `falha_envio` em cima de
pedidos sadios. **A camada que faltava foi coberta por uma decisão tomada em OUTRA camada** — e é
por isso que ela não pode ser creditada ao processo de deploy.

## A regra que fica

O `deploy-redundante-ledger-e-cron-de-sonda.md` (2026-09-05) fixou, com razão:

> *edge precisa de deploy ⇔ `(versao, fonte)` servido ≠ `(versao, fonte)` da main. **Nada mais é motivo.***

Essa regra responde **QUANDO** deployar. Ela é cega para **SE PODE AGORA**. São perguntas
diferentes, e a segunda não tem dono:

- `pendencias:deploy` compara bundle servido × main — não abre `supabase/migrations/`.
- `audit:migrations` inventaria migrations — não sabe que uma edge já foi ao ar dependendo de uma.
- O cabeçalho da migration declara a ordem — **em prosa, para um humano que talvez não a abra.**

> **REGRA. Quando um PR entrega edge + migration acopladas, a dependência tem de existir como
> ARTEFATO VERIFICÁVEL, não como parágrafo.** Antes de deployar a edge, meça o objeto que ela chama
> (`pg_proc`/`pg_attribute` via `psql-ro`, com controle positivo). Migration primeiro, sempre — a
> ordem inversa só é "segura" quando alguém já escreveu o fail-closed, e você não deveria descobrir
> isso depois.

## Lição secundária: o sensor esquece antes de o cron acordar

Quis auditar o run do cron das **13:00 UTC** e descobri que ele é inauditável por construção:

```
net._http_response  →  270 linhas, a mais antiga de 2026-09-07 18:00:01   (~6h de retenção)
cron disparar-pedidos-aprovados-oben  →  0 13 * * *                        (24h de intervalo)
```

**Retenção (6h) < intervalo (24h) ⇒ o run diário nunca é auditável no dia seguinte.** E
`cron.job_run_details = succeeded` continua provando só o ENQUEUE. Resultado: sobre aquele run
específico eu só sei dizer *"não tenho dado"* — que é a resposta honesta, e não "correu bem".
Quem precisar dessa resposta tem de gravar no momento do run (o registro server-side de execução),
não esperar consultar o `net._http_response` depois.

## Como pegar de novo

O caso foi pego pelo passo *"migration de terceiro na janela"* do ritual `/fecho` de **outra**
sessão — ou seja, por um ritual de FECHAMENTO, horas depois, e não pelo caminho do deploy. Funcionou;
só custou uma janela inteira. O barato é a medição de 30 segundos ANTES do deploy da edge:

```sql
-- controle positivo junto, sempre: um zero sem controle é ausência de dado, não ausência de objeto
SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='<a rpc que a edge nova chama>')      AS alvo,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname LIKE '<prefixo do dominio>%')         AS controle;
```
