# Rescan do scanner Lovable Security — lote 5 (2026-11-17)

Continuação do [lote 4](scanner-lovable-rescan-lote4.md). O deep scan de 2026-11-17 deixou 5 achados no painel. Este lote conserta os 2 reais, que são da mesma classe: **a edge autentica o chamador como "staff" e depois grava com service-role num registro cujo id vem do body, sem aplicar a regra de dono que a RLS impõe a esse mesmo chamador**. Cada fato de banco abaixo foi lido na PROD via `psql-ro` em 2026-11-17.

## Os 5 achados do deep scan

| Título no painel | Veredito | Onde está |
|---|---|---|
| Employee can overwrite another author's document (Critical) | **Real**, corrigido aqui | `kb-ingest-document` |
| Some actions can reach other users' records (Warning, 2 caminhos) | **Real**, corrigido aqui | `extrair-sinais-ligacao` |
| Any staff member can redirect customer ownership (`b339bb5b`) | Já corrigido; o scanner cita código que não existe mais | Seção "Correção do lote 4" |
| Your app can be used to send messages or spend your money | Desenho (decisão do founder no [lote 3](scanner-lovable-rescan-lote3.md): o número discado segue livre e é validado) | `nvoip-calls` |
| Any signed-in user can disable another user's push alerts | Real e baixo, **não tratado** (fora do escopo desta entrega) | Seção "Fica para o founder" |

## O que entrou

| Achado | Correção |
|---|---|
| 🔴 `kb-ingest-document`: qualquer employee reprocessava o documento de outro autor | `v1.0-dono-pela-rls`: staff só passa se a policy de UPDATE de `kb_documents` (master ou autor) deixa aquele usuário alterar aquele documento. A recusa (403) sai antes de o cliente service-role existir: nenhuma leitura, embedding ou escrita vem antes, nem o `markError`, que também escreve |
| 🟠 `extrair-sinais-ligacao`: qualquer employee lia o estado e regravava a análise da ligação de outro vendedor | `v1.0-dono-pela-rls`: staff só passa se a policy de UPDATE de `farmer_calls` (dono da ligação, ou `cap_carteira_escrever`) deixa. O gate vem antes da leitura de idempotência, do LLM e das duas escritas. Os ids do envelope saem da linha da ligação, não do body. Erro de leitura e ligação inexistente saem antes do LLM (500 e 404) |

As duas edges ganharam `versao.ts` e sonda de versão. Sem o marcador, o `pendencias:deploy` as deixava em "fora do alcance" e o deploy do conserto não seria atestável.

## O impacto, medido

- **`kb-ingest-document`.** O conteúdo regravado sai do PDF do próprio documento, não do body, então o employee não escolhia o texto. O que ele conseguia: gastar embedding e **virar um documento `ready` para `error`**. `kb_chunks` tem `UNIQUE (document_id, chunk_index)`, logo reprocessar um documento que já tem chunks falha no insert e cai no `markError`. Não duplica chunk. Hoje são 297 documentos, todos `ready`, de 1 único autor.
- **`extrair-sinais-ligacao`.** A leitura só devolvia `{ skipped: "ja_extraido" }`, e só para quem mandasse o transcript exato já extraído: um oráculo de confirmação, não um vazamento de conteúdo. A escrita era o problema: o employee gravava, na ligação de outro vendedor, sinais extraídos de um transcript **que ele mesmo mandava**, e o trigger enfileirava o recálculo de score do cliente. `farmer_calls` tem **0 linhas** em PROD: o furo era latente, sem dado exposto.

## O gate: quem decide é a RLS

`supabase/functions/_shared/dono-pela-rls.ts`. A regra não foi reescrita em TypeScript. O gate pergunta ao banco, com o JWT do chamador:

```
PATCH /rest/v1/<tabela>?id=eq.<id>&select=id      corpo: {"id":"<id>"}
≡ UPDATE <tabela> SET id = '<id>' WHERE id = '<id>' RETURNING id
```

O Postgres aplica a policy de UPDATE (USING e WITH CHECK) e a de SELECT, por causa do RETURNING. A linha só volta se aquele usuário pode alterá-la, e nenhum valor muda. Se a policy evoluir, a edge acompanha sem deploy.

- `cron` e `service_role` não têm usuário e passam direto, por lista explícita. Um `via` que o `AuthResult` venha a ganhar nasce fechado.
- Zero linha vira 403 `DONO_SEM_PERMISSAO`. A resposta não distingue "não é o dono" de "não existe", para o id não virar oráculo de existência.
- Tudo o mais é fechado: resposta que não é lista, linha de outro id, HTTP diferente de 2xx, rede, `SUPABASE_ANON_KEY` ausente → 503 `DONO_GATE_INDISPONIVEL`. Id que não é uuid → 400, sem ir à URL.
- A service-role nunca entra na sonda. Com ela, a resposta seria "pode" para qualquer um.

**O que a sonda é, e o que ela não é:**

- É uma escrita sujeita à RLS, não uma leitura. Em `kb_documents` o `updated_at` anda (trigger `BEFORE UPDATE`). Em `farmer_calls` nada dispara: os dois triggers são `UPDATE OF <coluna>`. Se a resposta se perde depois do commit, o gate devolve 503 e o `updated_at` já andou.
- Autoriza **no início**. O trabalho seguinte (download, embedding, LLM, escritas) roda por service-role sem reconferir. É a semântica escolhida para um trabalho longo.
- Não prova regra por **valor** de coluna. Um WITH CHECK futuro que dependa do valor novo (ex.: `status`) não é visto. Hoje não há.
- Depende de UPDATE na coluna `id` para `authenticated` (existe nas duas tabelas) e de não haver trigger genérico que suprima o UPDATE.
- O filtro `id=eq.<id>` e o corpo `{ id }` são o mesmo valor. Sem o filtro, o corpo regravaria a PK de outra linha. Por isso a tabela vem de lista fechada, o id é validado como uuid e o teste casa a URL inteira.

## O que mudou de comportamento, além da recusa

- **Staff com id inexistente** recebe 403 da sonda (antes: 404 pelo `markError`, na A; LLM chamado e `ok: true` sem gravar, na B).
- **`extrair-sinais-ligacao` pelo cron**: ligação inexistente → 404 sem chamar o LLM (antes chamava e respondia `ok: true` sem gravar nada); erro de leitura → 500 sem LLM (antes era ignorado). O `sinais-batch` conta os dois como erro e segue a varredura.
- **`customerUserId` e `farmerId` do body são ignorados.** O front e o `sinais-batch` ainda os mandam. Para os dois chamadores legítimos o valor é o mesmo da linha, então o envelope sai igual. Ninguém lê esses dois campos do envelope: o trigger e o `scoring-recalc-client` usam as colunas da linha.
- **`kb-ingest-document`**: body `null` responde 400 "documentId required" em vez de estourar 500.
- Um comentário da B dizia que o `status: 'erro'` seria reprocessado pela varredura. Não é: o `sinais-batch` só pega `sinais_ligacao IS NULL`. O comentário foi corrigido; a política de retry não mudou.

## 2ª opinião (Codex)

`Codex: desenho=gpt-6-astra·max·585s·110.518 tokens (prompt com RÉGUA:) · código=CODEX_CODIGO_PENDENTE · extra=nenhum`

O parecer de desenho manteve o pré-gate e não achou P0. **Adotado:** lista explícita de quem dispensa a sonda; gate fora de qualquer bloco que escreve erro; gate antes do retorno `ja_extraido`; erro de leitura separado de ausência; prova do oráculo no banco (o dublê do teste unitário não prova o que o Postgres responde); teste de ligação que pega "a edge chama o gate e ignora a decisão"; a redação honesta acima (a sonda é escrita, a autorização é no início).

**Não adotado, com motivo:**

- *Cliente com o JWT também nas escritas seguintes.* A ingestão dura dezenas de segundos. Um JWT que expira no meio deixaria o documento em `processing` para sempre, com os chunks gravados, e o `markError` pelo mesmo JWT falharia junto: um modo de falha novo, pior que o atual. As policies de hoje não têm WITH CHECK por valor, então as duas camadas decidiriam igual.
- *O TOCTOU da A.* O autor pode, durante a ingestão, trocar a PK do próprio documento e inserir outra linha no id antigo com `created_by` de terceiro. A edge termina a ingestão nessa linha. Isso não alcança documento que já existia: forja a autoria de um documento novo. A raiz é a policy de INSERT, que não amarra `created_by = auth.uid()`, e o cliente-JWT não fecharia (os chunks seguem por service-role). Vai como follow-up de banco.
- *Saída antecipada para documento `ready`* e *limpeza do `markError(404)`*: comportamento que já existia para o chamador autorizado. Follow-up.

## Prova

- **O oráculo, no banco:** `db/test-seg-lote5-dono-pela-rls.sh` (PG17), com as policies e funções de PROD copiadas (`carteira_clientes_visiveis` é dublê). K0 mostra o furo: por service-role, o UPDATE em documento alheio passa. 25 asserções: autor e master recebem a linha; employee não-autor, customer, anon e id inexistente recebem zero linha, sem erro e sem tocar a linha; a sonda não muda valor, não dispara os triggers de recálculo e não derruba os filhos com FK; gestor comercial e dona da carteira **veem** a ligação e mesmo assim recebem zero linha. 11 sabotagens vermelhas no assert esperado, em `C` e em `pt_BR.UTF-8`, com o controle verde na mesma invocação.
- **O gate, ramo a ramo:** `supabase/functions/_shared/dono-pela-rls_test.ts` (13 testes Deno), casando status e `code` de cada recusa e a forma exata da sonda (URL inteira, corpo, `Authorization` do chamador, `apikey` anon, nenhuma service-role). Falsificado numa cópia fora do worktree: 18 mutantes vermelhos no teste esperado, nos dois locales, com o controle verde na mesma invocação.
- **A ligação nas edges:** `src/__tests__/edge-dono-pela-rls-gate.test.ts`, por AST. As edges importam SDKs que a suíte offline não resolve, então o handler não é executável em teste. O que o teste prova é que o gate é instrução do topo do handler, com `await`, na tabela e no id certos, que a instrução seguinte devolve a recusa, que nada fora de uma lista fechada é chamado antes, que o gate é o importado do módulo compartilhado e que ninguém regrava o principal nem o alvo. 19 mutantes embutidos por edge (gate removido, sem `return`, sem `await`, dentro de `if`, dentro de `try`, tabela ou id trocados, cliente service-role antes do gate, gate no fim do handler, `auth.via` forjado, gate homônimo local, escrita mirando outro id). O próprio teste acusou um ponto cego do detector na 1ª versão: a atribuição escondida atrás de um cast (`(auth as X).via = …`).
- `test:edges` 2675/0 · `edges:typecheck` 0 erro de classe-crash e 0 tolerado nos arquivos tocados · `edges:sintaxe` · `sonda:fingerprint` (87 edges) · `sonda:autentica` · `sonda:nova` · `sonda:bump` · `bun lint` · `bun run typecheck` · `lint:shell` · `knip`.

## Correção do lote 4

O lote 4 previa que os 4 corrigidos sairiam da lista no rescan. **Saíram 3.** O `b339bb5b` ficou, com evidência velha: o painel cita `supabase/functions/omie-cliente/index.ts:949-954` com `p_user_id: matchedUserId`. Esse trecho é o do commit anterior ao #3912 (`1b27f6b7c^`, conferido). Na `main` há 0 ocorrências, e a `omie-cliente` servida é a `v1.12-vinculo-conferido`. Não há o que consertar. A lição: "vai sair no próximo rescan" era previsão, e o scanner pode reapresentar um achado com o código que ele leu antes.

## Lições

- **`authorizeCronOrStaff` responde "é staff", não "pode mexer neste registro".** Service-role ignora a RLS. Edge que recebe um id do body e grava com service-role precisa de um gate de dono na fronteira. Para tabela com policy de UPDATE por dono, o gate é `exigirDonoPelaRls`.
- **A falsificação corrigiu o entendimento da própria policy.** Abrir só a policy de UPDATE de `farmer_calls` não deixou o employee comum passar: ele é barrado também pela de SELECT. Quem a policy de UPDATE barra sozinha é quem lê sem poder escrever (gestor, dona da carteira). O assert do employee comum só cai abrindo as duas.
- **O harness de handler não alcança edge que importa SDK fora do `node_modules`.** `openai`, `pdf-parse` e `@anthropic-ai/sdk` não resolvem sob `--no-remote`. A ligação dessas edges se prova por AST, e o comportamento, no primitivo e no banco.

## Deploy

Pendente: será registrado no PR de sonda. Camada única: as 2 edges. Sem migration e sem Publish.

## Fica para o founder

- **Painel:** ignorar `b339bb5b` (evidência velha, motivo "This is wrong") e o da Nvoip (desenho). Depois do deploy, rodar o deep scan de novo e conferir que os 2 deste lote saíram.
- **Push (`delete_push_subscription`)**: a função é SECDEF e apaga por endpoint sem conferir o dono. A RLS de `push_subscriptions` só mostra a linha ao dono, então o ataque exige conhecer o endpoint alheio. Risco baixo. Só a migration foi lida, não a PROD. Conserto é migration, em lote próprio se o founder quiser.
- **Follow-ups que este lote deixou à vista**, nenhum tratado aqui:
  - policy de INSERT de `kb_documents` não amarra `created_by = auth.uid()` (raiz do TOCTOU acima);
  - `sinais-batch` aceita staff: um employee dispara a varredura, que extrai as ligações pendentes de todos com o transcript gravado. O resultado é o que o cron produziria; o que ele controla é o momento e o custo;
  - o autor ainda consegue reprocessar o próprio documento `ready` e levá-lo a `error` (o UNIQUE dos chunks);
  - a classe não foi varrida nas outras edges: o scanner apontou estas duas, e não há censo de quem mais grava com service-role num id vindo do body.
- **Não usar "Try to fix" nem "Try to fix all"** ([caso](agente-lovable-conserta-o-que-nao-pediram.md)).
