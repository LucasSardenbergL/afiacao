# Rescan do scanner Lovable Security — lote 5 (2026-11-17)

Continuação do [lote 4](scanner-lovable-rescan-lote4.md). O deep scan de 2026-11-17 deixou 5 achados no painel. Este lote conserta os 2 reais, que são da mesma classe: **a edge autentica o chamador como "staff" e depois grava com service-role num registro cujo id vem do body, sem aplicar a regra de dono que a RLS impõe a esse mesmo chamador**. Cada fato de banco abaixo foi lido na PROD via `psql-ro` em 2026-11-17.

## Os 5 achados do deep scan

| Título no painel | Veredito | Onde está |
|---|---|---|
| Employee can overwrite another author's document (Critical) | **Real**, corrigido aqui | `kb-ingest-document` |
| Some actions can reach other users' records (Warning, 2 caminhos) | **Real**, corrigido aqui | `extrair-sinais-ligacao` |
| Any staff member can redirect customer ownership (`b339bb5b`) | Já corrigido; o scanner cita código que não existe mais | Seção "Correção do lote 4" |
| Your app can be used to send messages or spend your money | Desenho (decisão do founder no [lote 3](scanner-lovable-rescan-lote3.md): o número discado segue livre e é validado) | `nvoip-calls` |
| Any signed-in user can disable another user's push alerts | **Desenho**, documentado na própria migration. A 1ª leitura deste lote dizia "real e baixo" e estava errada | Seção "O painel depois do lote" |

## O que entrou

| Achado | Correção |
|---|---|
| 🔴 `kb-ingest-document`: qualquer employee reprocessava o documento de outro autor | `v1.0-dono-pela-rls`: staff só passa se a policy de UPDATE de `kb_documents` (master ou autor) deixa aquele usuário alterar aquele documento. A recusa (403) sai antes de o cliente service-role existir: nenhuma leitura, embedding ou escrita vem antes, nem o `markError`, que também escreve |
| 🟠 `extrair-sinais-ligacao`: qualquer employee lia o estado e regravava a análise da ligação de outro vendedor | `v1.0-dono-pela-rls`: staff só passa se a policy de UPDATE de `farmer_calls` (dono da ligação, ou `cap_carteira_escrever`) deixa. O gate vem antes da leitura de idempotência, do LLM e das duas escritas. Os ids do envelope saem da linha da ligação, não do body. Erro de leitura e ligação inexistente saem antes do LLM (500 e 404) |

As duas edges ganharam `versao.ts` e sonda de versão. Sem o marcador, o `pendencias:deploy` as deixava em "fora do alcance" e o deploy do conserto não seria atestável.

## O impacto, medido

- **`kb-ingest-document`.** O conteúdo regravado sai do PDF do próprio documento, não do body, então o employee não escolhia o texto. O que ele conseguia: gastar embedding e **virar um documento `ready` para `error`**. `kb_chunks` tem `UNIQUE (document_id, chunk_index)`, logo reprocessar um documento que já tem chunks falha no insert e cai no `markError`. Não duplica chunk. Hoje são 297 documentos, todos `ready`, de 1 único autor.
- **`extrair-sinais-ligacao`.** A leitura só devolvia `{ skipped: "ja_extraido" }`, e só para quem mandasse o transcript exato já extraído: um oráculo de confirmação, não um vazamento de conteúdo. A escrita era o problema: o employee gravava, na ligação de outro vendedor, sinais extraídos de um transcript **que ele mesmo mandava**, e o trigger enfileirava o recálculo de score do cliente. `farmer_calls` tem **0 linhas** em PROD: o furo era latente, sem dado exposto.
- O módulo da base de conhecimento está **congelado** no manifesto desde 2026-10-12 (rota escondida). Isso tira o caminho da tela, não a edge: qualquer employee com JWT a invocava direto.

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
- Falha transitória (5xx, 429, rede, corpo incompleto) repete a sonda **uma** vez. Repetir é inócuo, porque ela não muda valor. O teto de 10 s cobre a requisição inteira, inclusive a leitura do corpo.
- A service-role nunca entra na sonda. Com ela, a resposta seria "pode" para qualquer um.

**O que a sonda é, e o que ela não é:**

- É uma escrita sujeita à RLS, não uma leitura. Em `kb_documents` o `updated_at` anda (trigger `BEFORE UPDATE`). Em `farmer_calls` nada dispara: os dois triggers são `UPDATE OF <coluna>`. Se a resposta se perde depois do commit, o gate devolve 503 e o `updated_at` já andou.
- Autoriza **no início**. O trabalho seguinte (download, embedding, LLM, escritas) roda por service-role sem reconferir. É a semântica escolhida para um trabalho longo.
- Não prova regra por **valor** de coluna. Um WITH CHECK futuro que dependa do valor novo (ex.: `status`) não é visto. Hoje não há. O limite está executado na prova (X2): a sonda passa e a escrita seguinte é negada.
- Depende de UPDATE na coluna `id` para `authenticated` (existe nas duas tabelas) e de não haver trigger genérico que suprima o UPDATE.
- O filtro `id=eq.<id>` e o corpo `{ id }` são o mesmo valor. Sem o filtro, a sonda regravaria a PK de outra linha do próprio chamador (executado na prova: sabotagem `sonda_sem_filtro`). Por isso a tabela vem de lista fechada, o id é validado como uuid e o teste casa a URL inteira.

## O que mudou de comportamento, além da recusa

- **Staff com id inexistente** recebe 403 da sonda (antes: 404 pelo `markError`, na A; LLM chamado e `ok: true` sem gravar, na B).
- **`extrair-sinais-ligacao` pelo cron**: ligação inexistente → 404 sem chamar o LLM (antes chamava e respondia `ok: true` sem gravar nada); erro de leitura → 500 sem LLM (antes era ignorado). O `sinais-batch` conta os dois como erro e segue a varredura.
- **`customerUserId` e `farmerId` do body são ignorados.** O front e o `sinais-batch` ainda os mandam. Para os dois chamadores legítimos o valor é o mesmo da linha, então o envelope sai igual. Ninguém lê esses dois campos do envelope: o trigger e o `scoring-recalc-client` usam as colunas da linha.
- **`kb-ingest-document`**: o id do documento é capturado uma vez num escalar constante, e é ele que o gate autoriza e que toda leitura e escrita usa. Body `null` responde 400 "documentId required" em vez de estourar 500.
- Um comentário da B dizia que o `status: 'erro'` seria reprocessado pela varredura. Não é: o `sinais-batch` só pega `sinais_ligacao IS NULL`. O comentário foi corrigido; a política de retry não mudou.

## 2ª opinião (Codex)

`Codex: desenho=gpt-6-astra·max·585s·110.518 tokens (prompt com RÉGUA:) · código=gpt-6-astra·max·662s·151.954 tokens · extra=nenhum`

**Desenho.** O parecer manteve o pré-gate e não achou P0. Adotado: lista explícita de quem dispensa a sonda; gate fora de qualquer bloco que escreve erro; gate antes do retorno `ja_extraido`; erro de leitura separado de ausência; prova do oráculo no banco (o dublê do teste unitário não prova o que o Postgres responde); teste de ligação que pega "a edge chama o gate e ignora a decisão"; a redação honesta acima (a sonda é escrita, a autorização é no início).

**Código.** Sem P0 nem P1; cinco P2, todos adotados:

- o teto parava de contar quando chegavam os headers, e um corpo que não terminasse pendurava a edge;
- `cancel()` do corpo podia lançar fora do tratamento e o gate deixava de devolver a recusa;
- `Content-Profile: public` explícito, como o supabase-js manda;
- o teste de ligação passava com o id sombreado num bloco aninhado, com `authorizeCronOrStaff` local e com o gate trocado por destructuring. Agora ele confere a origem das duas funções que decidem e exige uma declaração só de cada nome que carrega a decisão;
- a sabotagem `sonda_sem_filtro` da prova PG17 trocava também o SET e o RETURNING, então provava outra coisa. Passou a ser fiel.

Um sexto ponto virou mitigação: uma falha transitória da sonda deixaria o upload legítimo em `processing`, porque o front dispara e não espera. O gate repete uma vez. Se falhar duas, o documento fica em `processing` (ver follow-ups).

**Não adotado, com motivo:**

- *Cliente com o JWT também nas escritas seguintes.* A ingestão dura dezenas de segundos. Um JWT que expira no meio deixaria o documento em `processing` para sempre, com os chunks gravados, e o `markError` pelo mesmo JWT falharia junto: um modo de falha novo, pior que o atual. As policies de hoje não têm WITH CHECK por valor, então as duas camadas decidiriam igual. A revisão de código não contestou.
- *O TOCTOU da A.* O autor pode, durante a ingestão, trocar a PK do próprio documento e inserir outra linha no id antigo com `created_by` de terceiro. A edge termina a ingestão nessa linha. Isso não alcança documento que já existia: forja a autoria de um documento novo. A raiz é a policy de INSERT, que não amarra `created_by = auth.uid()`, e o cliente-JWT não fecharia (os chunks seguem por service-role). Vai como follow-up de banco.
- *Saída antecipada para documento `ready`* e *limpeza do `markError(404)`*: comportamento que já existia para o chamador autorizado. Follow-up.
- *Executar o handler com os SDKs substituídos.* A suíte de edge roda com comando fixo e `--no-remote`, e trocar a forma do import em produção só para testar é risco de boot. A ligação fica provada por AST.

## Prova

- **O oráculo, no banco:** `db/test-seg-lote5-dono-pela-rls.sh` (PG17), com as policies e funções de PROD copiadas (`carteira_clientes_visiveis` é dublê). K0 mostra o furo: por service-role, o UPDATE em documento alheio passa. 29 asserções: autor e master recebem a linha; employee não-autor, customer, anon e id inexistente recebem zero linha, sem erro e sem tocar a linha; a sonda não muda valor, não dispara os triggers de recálculo e não derruba os filhos com FK; gestor comercial e dona da carteira **veem** a ligação e mesmo assim recebem zero linha. 11 sabotagens vermelhas no assert esperado, em `C` e em `pt_BR.UTF-8`, com o controle verde na mesma invocação.
- **O gate, ramo a ramo:** `supabase/functions/_shared/dono-pela-rls_test.ts` (17 testes Deno), casando status e `code` de cada recusa e a forma exata da sonda (URL inteira, corpo, `Authorization` do chamador, `apikey` anon, nenhuma service-role), a repetição, o teto sobre o corpo e o descarte tolerante. Falsificado numa cópia fora do worktree: 26 mutantes vermelhos no teste esperado, nos dois locales, com o controle verde na mesma invocação. Os 25 de uma linha ficaram versionados como contrato em `scripts/mutcheck.d/dono-pela-rls.mut` (25 mutações, 25 pegas, EXPECT por medição); o 26º, de várias linhas (tirar o try/catch do descarte do corpo), ficou só na medição à mão.
- **A ligação nas edges:** `src/__tests__/edge-dono-pela-rls-gate.test.ts`, por AST. As edges importam SDKs que a suíte offline não resolve, então o handler não é executável em teste. O que o teste prova é que o gate é instrução do topo do handler, com `await`, na tabela e no id certos; que a instrução seguinte devolve a recusa; que nada fora de uma lista fechada é chamado antes; que o gate e a autenticação são os importados dos módulos compartilhados; e que o principal, o request e o id têm uma declaração só e ninguém os regrava. 28 mutantes embutidos por edge. Não é análise geral de JavaScript: getter, Proxy e alias arbitrário ficam fora, e isso está escrito no cabeçalho do teste.
- `test:edges` 2679/0 · `edges:typecheck` 0 erro de classe-crash e 0 tolerado nos arquivos tocados · `edges:sintaxe` · `sonda:fingerprint` (87 edges) · `sonda:autentica` · `sonda:nova` · `sonda:bump` · `canaria:bump` · `bun lint` · `bun run typecheck` · `build` · `lint:shell` · `knip`.

## Correção do lote 4

O lote 4 previa que os 4 corrigidos sairiam da lista no rescan. **Saíram 3.** O `b339bb5b` ficou, com evidência velha: o painel cita `supabase/functions/omie-cliente/index.ts:949-954` com `p_user_id: matchedUserId`. Esse trecho é o do commit anterior ao #3912 (`1b27f6b7c^`, conferido). Na `main` há 0 ocorrências, e a `omie-cliente` servida é a `v1.12-vinculo-conferido`. Não há o que consertar. A lição: "vai sair no próximo rescan" era previsão, e o scanner pode reapresentar um achado com o código que ele leu antes.

## Lições

- **`authorizeCronOrStaff` responde "é staff", não "pode mexer neste registro".** Service-role ignora a RLS. Edge que recebe um id do body e grava com service-role precisa de um gate de dono na fronteira. Para tabela com policy de UPDATE por dono, o gate é `exigirDonoPelaRls`.
- **A falsificação corrigiu o entendimento da própria policy.** Abrir só a policy de UPDATE de `farmer_calls` não deixou o employee comum passar: ele é barrado também pela de SELECT. Quem a policy de UPDATE barra sozinha é quem lê sem poder escrever (gestor, dona da carteira). O assert do employee comum só cai abrindo as duas.
- **Nome genérico de topo num módulo novo de `_shared/` reprova a canária de OUTRA edge.** O `canaria:bump` resolve `_shared/` por símbolo, em texto. Um `const UUID` no módulo novo entrou na superfície da `identidade_probe` da `omie-vendas-sync`, que cita "não-UUID", e o gate pediu bump de `contrato` numa edge que o PR não toca. Só apareceu depois do commit, porque o gate compara com a `main`. Os símbolos de topo do módulo ganharam nomes exclusivos.
- **O harness de handler não alcança edge que importa SDK fora do `node_modules`.** `openai`, `pdf-parse` e `@anthropic-ai/sdk` não resolvem sob `--no-remote`. A ligação dessas edges se prova por AST, e o comportamento, no primitivo e no banco.
- **Sabotagem que muda mais de uma coisa prova outra coisa.** A 1ª `sonda_sem_filtro` trocava o SET para não bater em colisão de PK, e com isso deixou de mostrar o perigo real. A versão fiel mostra: sem o filtro, o documento do próprio chamador perde o id.
- **Antes de chamar um achado de "real", ler o comentário da migration que criou o objeto.** O do push foi registrado aqui como "real e baixo" lendo só o corpo de `delete_push_subscription`. O comentário logo acima da função (`20260610200000_push_vendedora.sql:82-84`) e o bloco 1b (`:47-52`) dizem que apagar por endpoint sem filtro de dono é o desenho. A correção está em "O painel depois do lote".

## Deploy

Camada única: as 2 edges. Sem migration e sem Publish. Feito em 2026-11-17, depois do merge do #3935 (`5d327d9f3`).

| Passo | Evidência |
|---|---|
| Ledger antes | `bun run pendencias:deploy`: as duas em "NUNCA atestada", o esperado para edge recém-instrumentada |
| Pacote | `bun scripts/pendencias-pacote.ts kb-ingest-document extrair-sinais-ligacao`, contra `origin/main@5bf5a9ed0`. Pré-condição de banco satisfeita (nenhuma RPC literal na leva) |
| Envio | `send_message` às 15:40Z. A colagem recebida pelo Lovable foi comparada com o Passo 2 do pacote: igual, 3.828 caracteres. O agente conferiu 13/13 hashes e publicou as duas. Custo: 1,8 crédito |
| Sensor | `lovable-sensor-edicao`: **`EDICAO_DETECTADA`** (exit 1). Ver abaixo |
| Sonda | `db/sonda-seg-lote5-20261117.sql` pelo `db:aplicar`: ensaio, depois a tentativa #1163. Requests 24522 e 24523, HTTP 200 |
| Veredito | **DEPLOY CONFIRMADO** nas duas: `v1.0-dono-pela-rls`, `fonte` igual à do mapa da `main` |
| Ledger depois | `deploy_atestacoes` tem as duas linhas, `via = sonda`: observadas às 15:53:39Z e registradas às 16:00:02Z pelo cron `deploy-atestacoes-colher`. `pendencias:deploy` lista as duas em "confere", cobertura 87/87. Ele ainda saiu 1 por outra edge, de outra entrega (`sayerlack-varrer-pedidos-portal` v1.13) |

**O bot empurrou `bun.lock` e `package.json` na `main`.** O agente fechou com `No files were edited.` e disse que não commitaria as mudanças que já estavam no sandbox. A plataforma as empurrou mesmo assim, no commit `54667707a` ("Deployou 2 funções verbatim"): +2 `devDependencies` (`@lovable.dev/vite-plugin-dev-server-bridge` e `@lovable.dev/vite-plugin-hmr-gate`), que nada no repo importa, e 66 linhas de lock. As edges não foram tocadas: o commit só tem esses dois arquivos, e o pai dele é o commit de onde saíram os hashes conferidos. O revert, byte a byte, é o #3939, mergeado como `2ec7f2944`. É a 4ª ocorrência do mesmo par de arquivos (#3821 e mais duas em 2026-11-11).

Enquanto o commit do bot esteve na `main` (das 15:42Z às 16:00Z, 18 minutos), o gate `knip` reprovava em qualquer branch aberto a partir dela: `Unused devDependencies (2)`, as duas do Lovable. Medido num branch só de docs: vermelho sobre `54667707a`, verde depois do rebase sobre o revert.

## O painel depois do lote

Conferido em 2026-11-17, pelo Chrome do founder. Às 15:42Z o painel mostrava 5 achados ativos e 9 ignorados; às 15:48Z, 2 ativos e 11 ignorados. Os 3 achados que não eram deste lote **foram para "Ignored findings" nesse intervalo, marcados pela conta do founder**. Esta sessão abriu os detalhes para ler o motivo e não clicou em mais nada: o gesto não foi dela.

| Achado | Ignorado em (hora local) | Motivo registrado no painel, resumido |
|---|---|---|
| Any staff member can redirect customer ownership (`b339bb5b`) | 17/11, 12:43 | Evidência velha: corrigido no #3912 e no #3925, `omie-cliente` v1.12 no ar. As linhas 949-954 não têm mais a chamada |
| Your app can be used to send messages or spend your money (3 caminhos em `nvoip-calls`) | 15/11, 20:08 para `index.ts:211-221` (lote 3); 17/11, 12:45 para `:208-218` e `:207:7` | Desenho, decisão do founder no lote 3: staff liga para qualquer número. Desde a `nvoip-calls` v1.3 o número é validado |
| Any signed-in user can disable another user's push alerts | 17/11, 12:46 | Desenho, documentado na migration `20260610200000_push_vendedora.sql` |

**Correção deste registro sobre o push.** A 1ª versão dizia "real e baixo, conserto é migration". Está errado. A migration declara o desenho em dois lugares: no bloco 1b (`:47-52`), o endpoint pertence a quem está logado no device agora; no comentário da função (`:82-84`), apagar por endpoint sem filtro de usuário é necessário quando quem desloga já não é o dono da linha. É o caso do device compartilhado de balcão. Filtrar por dono quebraria a limpeza do logout, e o push da pessoa anterior continuaria chegando a quem logou depois. O que sobra de risco exige conhecer o endpoint de outro device. Conferido aqui, na migration e não na PROD: a policy `push_subscriptions_own` é own-only e as duas RPCs devolvem `void`. O motivo do painel também afirma que a função de envio só aceita o cron; isso não foi conferido aqui.

Ficaram **2 achados ativos**, os deste lote. Eles só saem da lista quando o scanner reler o código. Até o próximo deep scan rodar, "vão sair" é previsão, a mesma da "Correção do lote 4".

## Fica para o founder

- **Deep scan:** rodar de novo e conferir que os 2 deste lote saíram.
- **`devDependencies` do bot:** enquanto o sandbox do Lovable estiver com aquelas duas dependências pendentes, o commit pode voltar num próximo deploy, e cada volta custa um PR de revert. E enquanto o revert não entra, o `knip` deixa vermelho todo PR aberto a partir da `main`. A alternativa é aceitá-las no repo, o que exige dispensá-las no `knip`. Não foi medido se o CI consegue instalá-las.
- **Follow-ups que este lote deixou à vista**, nenhum tratado aqui:
  - policy de INSERT de `kb_documents` não amarra `created_by = auth.uid()` (raiz do TOCTOU acima);
  - `sinais-batch` aceita staff: um employee dispara a varredura, que extrai as ligações pendentes de todos com o transcript gravado. O resultado é o que o cron produziria; o que ele controla é o momento e o custo;
  - o autor ainda consegue reprocessar o próprio documento `ready` e levá-lo a `error` (o UNIQUE dos chunks);
  - se a sonda falhar duas vezes seguidas, o upload fica em `processing`: o front dispara a ingestão e não espera a resposta. A tela está congelada hoje;
  - a classe não foi varrida nas outras edges: o scanner apontou estas duas, e não há censo de quem mais grava com service-role num id vindo do body.
- **Não usar "Try to fix" nem "Try to fix all"** ([caso](agente-lovable-conserta-o-que-nao-pediram.md)).
