# Recebimento de NF-e: cabeçalho + itens numa TRANSAÇÃO (RPC `importar_nfe_recebimento`)

**Origem:** follow-up deliberado do #3142 (`omie-nfe-webhook` v1.3, [nfe-webhook-reenvio-completa-itens.md](nfe-webhook-reenvio-completa-itens.md)). **Money-path:** entrada de mercadoria. **Runbook de aplicação:** [`docs/runbooks/importar-nfe-recebimento-rpc.md`](../runbooks/importar-nfe-recebimento-rpc.md).

## O que ficava aberto sem migration

Webhook e sync materializavam NF-e em DUAS requisições PostgREST (cabeçalho, depois itens). O #3142 fechou webhook×webhook com ids determinísticos, mas (1) a **sync gravava itens com id aleatório** — a PK determinística não a barrava: webhook×sync na mesma chave podia dar 2N; e (2) o **`omie-nfe-reconcile`** podia promover `pendente→efetivado` entre a leitura do guard e o insert — itens injetados em recebimento efetivado. Sem lock no banco não há como fechar.

**Prod (psql-ro, 2026-10-18 ~21:00 UTC):** 72 cabeçalhos / 133 itens; **0 duplicatas** em `(nfe_recebimento_id, sequencia)`; 57 sem itens (52 efetivado · 4 pendente · 1 falha_efetivacao); os **4 `pendente` têm os 4 sinais de uso NULL** → reparáveis; webhook sem tráfego (0/72 com xml/omie_nfe_id).

## O desenho — e o que o Codex mudou nele

Parecer de DESENHO (gpt-6-astra · max · 251s · 107k tokens): **REPROVADO na forma proposta, sem P0**. O núcleo (advisory lock por chave + `FOR UPDATE` no cabeçalho + cabeçalho e lote no mesmo commit, SECURITY INVOKER pela service_role, RPC-only sem fallback) foi confirmado com contramodelo; os P1 mudaram régua e fronteira:

| Codex (P1) | O que entrou |
|---|---|
| Cardinalidade igual não é certificado (`{1,2}` × `{1,3}`; mesma sequência com quantidade 10× maior) | "já importada" exige o MESMO CONJUNTO `(sequencia, codigo_produto, quantidade_nfe)`; diferença = `divergente` com motivo `cardinalidade`/`conteudo dos itens` |
| Lote vazio em cabeçalho novo era "importada" — o órfão que o próprio contrato aceita | `NFE03`: nada gravado. Vazio sobre cabeçalho vazio = `bloqueada` (nunca 2xx sem itens) |
| Reparo inalcançável: a triagem do cron pulava pela existência do cabeçalho e o botão respondia "já importada" | triagem compartilhada `triarCabecalho`: `pendente` + 0 itens comprovados + 4 sinais NULL = **reparável** → segue à consulta/RPC; o resto é completo |
| Rollback total reabre a fome da fila (NF-e inválida volta a parecer inédita e disputa a única consulta da rodada) | `nfe_importacao_falhas` escrita pelas edges FORA da transação abortada (RPC `…_falha_registrar`, `tentativas+1` atômico); a RPC apaga no sucesso; ≥3 estaciona a chave na triagem; o botão ignora o estacionamento |
| "Retry eterno até alguém olhar" é premissa falsa (Omie: 3 tentativas + DLQ 5 dias em QUALQUER não-2xx) | erro de dado = 422 + registro durável; `bloqueada`/`divergente` = 409 |
| Ordem migration→edges precisa considerar versões mistas: botão ANTIGO com DELETE de compensação apaga em cascata itens que a RPC reparou | DELETE de compensação removido; as duas edges na MESMA leva, logo após a migration; janela documentada no runbook |
| `origem` deve significar quem CRIOU; reparo registra à parte | `reparada_origem`/`reparada_em`; `origem` intacta (NULL de legado segue NULL) |
| Reparo entre origens ok, mas metadados conflitantes = divergência, não escolha | reparo exige mesmo `warehouse_id` e `omie_id_receb` compatível; metadados AUSENTES são preenchidos sob o mesmo lock |

Decisões minhas (não do Codex): `importacao_chave` como 3ª origem (o botão é um writer distinto da sync); sequência numérica em string vale (`"01"` ≡ `1`); o id determinístico do TS saiu — UNIQUE + lock o substituem.

## O adversarial de CÓDIGO (2º estágio) — REPROVOU sem P0, 6 P1 integrados

Parecer sobre o diff (gpt-6-astra · max · 476s · 219k tokens; executou os 74 testes Deno e contramodelos em TS com dependências falsas):

| Codex (P1) | O que entrou |
|---|---|
| Payload vazio sobre cabeçalho com itens devolvia `ja_importada` — a exceção ao certificado por conjunto; e conjunto igual com cabeçalho de OUTRO armazém certificava | `NFE03` para QUALQUER lote vazio; compatibilidade de `warehouse_id`/`omie_id_receb` antes de qualquer sucesso (reparo OU certificado) |
| Ledger consultado por `omie_id_receb` sem filtro de armazém: falha de OB estacionava NF-e de CC com id coincidente; chave global alimentava `idsJa` de outra conta | ledger por id filtrado por `warehouse_id`; linha de outro armazém só contribui com a CHAVE |
| Conflito permanente (cabeçalho de OB reparável numa rodada de CC → `divergente` toda rodada) consumia a consulta sem estado durável | `bloqueada`/`divergente` também vão ao ledger (`registravel`), nas 3 origens; ≥3 estaciona |
| Mapper fabricava item válido de entrada inválida (`det:[7]` → "Item sem descrição, quantidade 0"); `det:[null]` → TypeError 500 sem RPC nem ledger | `validarLote` compartilhado (objeto, sequência ≥1, quantidade finita > 0, descrição/unidade não vazias) ANTES da RPC, nas 3 origens; webhook valida a estrutura antes do mapper; chave normalizada (espaços fora) |
| Rejeições sem registro durável nosso (`divergente` só com 409) | ledger para impedimentos; `tentativas_registradas` no corpo dos 409/422 |
| "Mesma leva" não drena uma execução antiga em voo (botão antigo + DELETE em cascata) | runbook passo (0): pausar o cron com prova positiva de rodada terminada, botão parado com prova por `origem IS NULL` pós-janela, religar no (5); rollback com a mesma drenagem |
| P2: `22P05` como infra; ledger sem deadline segurava a resposta; botão devolvia `ja_importada` com 0 itens; policies só contadas; trigger ausente no harness | `22P05` → dado; `Promise.race` com 5 s; botão → 409 `bloqueada`; A22e–i exercitam staff/customer/anon/service_role de verdade; trigger `updated_at` no harness |

## A prova (`db/test-importar-nfe-recebimento.sh`, no núcleo CI com `falsificar=9`)

PG17 descartável aplica o SQL REAL 2× (idempotência + PRE md5). **75 asserts**: os 5 desfechos, NFE01/02/03 e 22001 por SQLSTATE (WHEN OTHERS re-lança), rollback total (nenhum cabeçalho órfão; reparo falho preserva o anterior), UNIQUE por fora da RPC, ACL por `has_function_privilege` E 42501, PRE anti-deriva abortando em A2, e **duas conexões com barreira observada** (`pg_blocking_pids`, nunca sleep): webhook×sync na chave NOVA (a 2ª fica presa no advisory e sai `ja_importada`, N itens), reconcile depois da RPC (espera o `FOR UPDATE`, promove cabeçalho COM itens) e reconcile ANTES segurando a linha (a RPC espera, relê a tupla promovida, `bloqueada`, 0 itens).

**Falsificação, 9/9 vermelhas no assert certo**, com três lições de dente:
- **Sem `FOR UPDATE` a RPC ainda bloqueia** — no UPDATE do reparo. "B preso" fica verde; o que fica vermelho é **itens injetados num cabeçalho efetivado** (a janela SELECT→UPDATE). Teste de lock precisa do adversário segurando a linha ANTES.
- **`REVOKE … FROM anon` é redundante com o de PUBLIC**: deletá-lo não muda nada. Só CONCEDER expõe — e aí o **42501 continua vindo da TABELA** (INVOKER): a testemunha é `has_function_privilege`, nunca só o SQLSTATE (exatamente o aviso do Codex).
- Seed com `status='efetivado'` E `efetivado_at` tem DUAS camadas; sabotar o gate de status ficava verde pela 2ª. O caso de uma camada só é `falha_efetivacao` (o 1 de prod).

Edges: 74 testes Deno (`--no-remote`): interpretação fail-closed do jsonb, classificação de erro, triagem, tradução HTTP do webhook, laço real do cron com os desfechos novos.

## O ensaio contra a prod pegou o que o harness não via

`bun run db:aplicar … --ensaio` (transação com ROLLBACK) abortou em **A11**: na prod a tabela nova nasce com os DEFAULT PRIVILEGES do Supabase (`pg_default_acl`: `anon`/`authenticated`/`service_role` = `arwdDxtm` em tabelas, `X` em funções), e `authenticated` ficou com INSERT em `nfe_importacao_falhas`. O harness dava ALL só à `service_role`, então o `GRANT SELECT` estreito parecia suficiente. Conserto: `REVOKE ALL … FROM authenticated` antes do `GRANT SELECT`, e o harness passou a declarar o mesmo default (`ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated, service_role`) — sem isso a prova aprovava uma migration que a postcondição reprovaria na mão do founder. **Lição:** o ACL de tabela nova é do CRIADOR + default do schema, nunca só do que a migration escreve; o ensaio do `db:aplicar` é a 2ª testemunha barata antes do apply, e a prova local tem de carregar o `pg_default_acl` medido (como já faz com `corpo-vivo-acl.sql` para o que o snapshot não traz).

## Deploy (manual, 3 camadas) — como de fato chegou à prod

1. **Migration:** `bun run db:aplicar` após o merge (#3147 → `54a792ae3`), ensaio e apply (recibo #546, 2026-10-19 02:35Z), validada por `psql-ro` numa 2ª conexão.
2. **Edges, 1ª tentativa:** o founder relatou o deploy feito, mas a sonda (`bun run sonda:sql` + `db:aplicar`, recibo #549, #3171) respondeu **BUNDLE VELHO nas duas** (webhook v1.4-ncm-em-shared, sync v1.4). **Merge e "Active" no Lovable não provam o bundle:** só a sonda prova, comparando a `fonte`.
3. **Por que não pegou:** o pacote de deploy (`bun run pendencias:pacote`) **recusava emitir** a colagem (exit 3). As chamadas usavam `cliente.rpc(RPC_IMPORTAR, …)` com constante, e o extrator de pré-condição (`preflight:rpcs`) só enxerga nome **literal**. Sem enumerar as RPCs, ele não mede se o banco as tem e não libera a edge. Correção no #3172: o nome literal na chamada, mais um guardrail que exige o literal. **Regra:** RPC chamada por edge leva o nome literal no `.rpc("…")`.
4. **Edges, 2ª tentativa:** um pacote por edge (não há ordem entre elas), colado no chat do Lovable, e a re-sonda (recibo #551, #3177) deu **DEPLOY CONFIRMADO** nas duas, com `v1.5-rpc-transacional` e a `fonte` igual à da main.

O passo de drenagem do runbook (pausar o cron) existe para a janela de versões mistas. O webhook segue sem tráfego.

## Primeiro sinal de uso (com denominador) — e o achado do CT-e

Medido por `psql-ro` entre 2026-10-19 e 2026-10-20:

- **Importada:** a NF-e 000955811 (modelo 55) entrou pela RPC em 20/10 11:50Z, com **11 itens** e 11 sequências distintas, e `origem = 'sync'`. É o 1º cabeçalho com origem medida.
- **Reparo alcançável, mas os alvos eram CT-e.** A triagem nova deixou de pular os `pendente` sem itens (no `por_armazem.OB`, `ja_importados` caiu de 24 para 22). Os 2 que estavam dentro da janela foram consultados e deram `falha_dado` NFE01 com "lote sem itens". O motivo: a chave tem **modelo 57, ou seja, CT-e de frete da Renner Sayerlack**, e CT-e não tem itens de produto. A RPC fez o certo: não gravou cabeçalho órfão, registrou em `nfe_importacao_falhas` e estacionou a chave após 3 tentativas. Desde então o cron faz 0 consultas desperdiçadas. Um 3º CT-e apareceu em 20/10 e seguiu o mesmo caminho.
- **Causa raiz, que é anterior a esta entrega:** a `omie-nfe-recebimento-sync` não filtra o modelo do documento, e o `ListarRecebimentos` mistura NF-e e CT-e. Dos 57 cabeçalhos sem itens em prod, **28 são CT-e**; os 16 com itens são todos NF-e. O helper `_shared/modelo-documento-fiscal.ts` (`ehCte`) já existia, mas só o rastreio o usava. Pular CT-e na triagem e no botão ficou para uma sessão própria, a v1.6 da sync.

## O que fica (passivo visível, não contabilizado como resolvido)

- 52 `efetivado` + 1 `falha_efetivacao` sem itens, parte deles CT-e. A RPC responde `bloqueada` para esses casos. O que fazer com eles é decisão do founder.
- 2 `pendente` sem itens que são NF-e de verdade (de 03/2026 e 07/2026) ficam fora da janela de 30 dias do cron. Só o botão "Importar NF-e" os alcança, e só se o Omie ainda os listar como abertos.
