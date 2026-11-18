# Rescan do scanner Lovable Security — lote 6 (2026-11-17)

Continuação do [lote 5](scanner-lovable-rescan-lote5.md). O deep scan de 2026-11-17 (20:25Z a 20:38Z) trouxe 5 achados novos. Este lote dá o veredito dos cinco e conserta o único que mexe em dinheiro: na edge `tint-sync-agent`, quem tem o token de sync da loja escolhia a **data de criação** da linha de staging do catálogo, e é essa data que decide qual dado "vence" na promoção. Um item com data no futuro ficava preso no catálogo para sempre.

Cada fato de banco abaixo foi lido na PROD via `psql-ro` em 2026-11-17, entre 20:59Z e 23:51Z (o papel da conexão tem `BYPASSRLS`, então as contagens são reais). Cada fato de código foi lido na `main@e53dbff03`. O detalhe de cada achado foi lido no painel, pelo Chrome do founder, só abrindo e fechando o diálogo: nenhum clique em "Try to fix", em checkbox ou em scan.

## Os 5 achados

| # | Título no painel | Veredito | Onde |
|---|---|---|---|
| 1 | Any signed-in user can inflate their gamification score (Critical) | **Real por construção, sem consequência hoje.** É o desenho declarado na migration; o único leitor do score alheio está congelado. Decisão do founder | `gamification_scores` |
| 2 | Anyone can disrupt biometric sign-in (Warning) | **Não se reproduz.** A escrita que o painel aponta falha no banco e o recurso está morto em três camadas | `biometric-auth` |
| 3 | Anyone with a sync credential can alter catalog records (Warning) | **Real**, corrigido aqui | `tint-sync-agent` |
| 4 | Staff users can override bundle argument model instructions (Warning) | **Desenho já aceito.** É o mesmo campo, na mesma edge, de um achado que o founder marcou como aceito em 15/11; o painel só cita a outra chamada | `generate-bundle-argument` |
| 5 | Request data is embedded in the system prompt (Warning) | **Desenho**, pela mesma decisão. A edge é outra, então marcar pede o sim do founder | `copilot-analyze` |

## O que entrou

| Achado | Correção |
|---|---|
| 🟠 `tint-sync-agent`, rota `/catalogs`: o item escolhia `created_at` e `id` da linha de staging | `v1.4-colunas-fechadas-e-snapshot-sem-futuro`: lista fechada de colunas por entidade (`catalogo-staging.ts`). O item só preenche as colunas de catálogo da sua tabela. Com qualquer campo fora da lista ele é recusado inteiro, conta como erro na resposta e a edge tenta registrar em `tint_sync_errors` |
| 🟠 Mesma edge, rota `/keys-snapshot`: o `generated_at` do corpo era gravado sem conferência (parente achado pela 2ª opinião) | Só RFC 3339 com fuso, e recusa de adiantamento acima de 10 minutos sobre o relógio do servidor (`snapshot-gerado-em.ts`). O texto que vai ao banco é o que o conector mandou |
| 🟡 Mesma rota `/catalogs`: entidade que vinha como objeto, sozinha no lote, recebia confirmação limpa | A forma do lote é conferida antes de qualquer atalho: corpo que não é objeto, ou entidade gravável que não é lista, responde 400 |

Sem migration e sem Publish. Uma edge.

## Achado 3 — o que o token conseguia, medido

A rota copiava toda propriedade de cada item para a linha (`index.ts:511-515` na `main@e53dbff03`: `for (const [k, v] of Object.entries(item))`), protegendo só cinco nomes (`sync_run_id`, `account`, `store_code`, `raw_data`, `staging_status`). Sobravam ao alcance do item, além do catálogo, três colunas das tabelas `tint_staging_{produtos,bases,embalagens,skus,corantes}`:

- `matched_id`: coluna morta. Tem 0 linhas preenchidas nas cinco tabelas e nenhuma função a cita.
- `created_at` e `id`: são o critério de "mais recente". O corpo vivo de `tint_promote_sync_run` escolhe, para cada chave tocada pelo run, a linha de staging com `ORDER BY s.created_at DESC, s.id DESC LIMIT 1` entre **todos** os runs do par conta e loja (linhas 70 a 142 do `prosrc`), e o `cor_latest`, que dá custo e volume do corante ao preço, usa a mesma ordem (linhas 526 a 532). A purga (`tint_staging_purge`, linhas 52 a 57) apaga a linha com mais de 30 dias que tenha outra "mais nova" por `(created_at, id)`.

Consequência, executada em PG17 com essas consultas copiadas (`db/test-seg-lote6-triagem.sh`, bloco C): uma linha de custo 0,01 com `created_at` em 2099 vence o run honesto, o reenvio honesto posterior não desfaz, e a purga apaga as linhas honestas e poupa a forjada. O bloco C é uma miniatura das consultas, não a função inteira; o critério `(created_at, id)` na função inteira já estava provado em `db/test-tint-promote-latest-indexado.sh`.

O tamanho certo do achado:

- **Quem tem o token já é a fonte autorizada do catálogo dessa loja.** Mandar valor errado ele sempre pôde, e o reenvio seguinte ou o re-scan semanal corrige. O que a cópia cega dava a mais era **prender** o valor: a linha forjada vencia todo dado honesto dali em diante, inclusive depois de trocar o token.
- `account`, `store_code` e `sync_run_id` vinham do servidor. O item não saía da própria loja nem do próprio run. Há uma loja só (`oben`/`M01`, `automatic_primary`), e o token só é lido pelo master (`tint_integration_settings` tem uma policy, de master).
- Ninguém explorou: 0 linhas com `created_at` no futuro nas cinco tabelas.

## O conserto: lista fechada, recusa barulhenta

`supabase/functions/tint-sync-agent/catalogo-staging.ts`. A linha nasce só com nomes literais: as cinco colunas do servidor, as colunas de catálogo da entidade que o item trouxe, e a chave (`item[chave] || ''`, como era). `id` e `created_at` ficam com o default do banco.

| Entidade | Colunas que o item pode preencher |
|---|---|
| produtos | `cod_produto`, `descricao` |
| bases | `id_base_sayersystem`, `descricao` |
| embalagens | `id_embalagem_sayersystem`, `descricao`, `volume_ml` |
| skus | `cod_produto`, `id_base`, `id_embalagem` |
| corantes | `id_corante_sayersystem`, `descricao`, `preco_litro`, `custo`, `volume_ml` |

**Recusar o item, e não limpar e aceitar.** Item com campo fora da lista não vira linha. Ele conta em `error_count` e em `errors[]` da resposta, e o conector só confirma um lote com `ok`, `error_count = 0` e `errors` vazio (`connector/sayersync/sync.go`); sem confirmação ele não avança a marca da entidade e reenvia no ciclo seguinte. Tirar os campos estranhos e gravar o resto esconderia um campo novo, ou um nome digitado errado, que nunca chegaria à coluna. A cópia cega já era barulhenta nesse caso (campo que não é coluna derrubava o chunk de até 500 itens com PGRST204); a recusa mantém o barulho e passa a ser por item.

**A lista não recusa nada do tráfego real.** O staging guarda o item cru em `raw_data`, então deu para medir o contrato de verdade antes de fechá-lo: em toda a retenção são 846.914 itens de catálogo, de 4 versões do conector (0.2.3 a 0.2.6), com um único conjunto de chaves por entidade e **0 itens com chave fora da lista**. Nas últimas 24 horas antes do conserto, 690 runs de catálogo, 0 com erro.

O que a recusa deixa de rastro: uma linha por entidade em `tint_sync_errors`, com o motivo, os nomes dos campos (até 20, cortados em 60 caracteres) e as contagens, sem o item cru. É tentativa de registro: se o insert falhar, a edge avisa no console e a recusa segue na resposta. O card "Fórmulas rejeitadas" não mostra essas linhas, porque só lê runs de fórmula (`useTintAlertas.ts:55`); elas aparecem na tela de runs.

## O que mudou de comportamento

- **Item com `id`, `created_at`, `matched_id` ou qualquer campo que não é coluna de catálogo da entidade:** recusado, com erro na resposta. Antes, as três colunas eram gravadas e o campo desconhecido derrubava o chunk.
- **Item com `sync_run_id`, `account`, `store_code`, `raw_data` ou `staging_status`:** recusado. Antes, o campo era ignorado em silêncio e o resto do item entrava.
- **Item que não é objeto:** recusado, sem estourar.
- **Corpo que não é objeto, ou entidade gravável que não é lista:** 400, nada gravado. Antes, sozinha no lote, a entidade torta caía no ack limpo do lote sem item; ao lado de outra entidade, estourava um `TypeError` e a rota respondia 500 com o run aberto. `null` segue valendo como "o lote não traz essa entidade".
- **`/keys-snapshot` com `generated_at` fora do RFC 3339 com fuso, com data que não existe, ou adiantado em mais de 10 minutos:** 400. Antes, bastava o campo existir. Hora 24 e segundo 60, que o Postgres normalizaria, também são recusados: o conector não os produz.
- O fallback `item.id` como chave saiu. Com a cópia cega ele só passava quando o `id` era um uuid, que virava a chave primária da linha; qualquer outro valor derrubava o chunk. Nenhum item real traz `id`.
- **Para o conector real, nada muda.** A linha gerada é idêntica à de antes para as formas medidas na PROD.

## O parente: o relógio do snapshot de chaves

Achado pela 2ª opinião do Codex e conferido no corpo vivo. `tint_apply_keys_snapshot` pula como "fora de ordem" todo snapshot com `generated_at` menor ou igual ao último aplicado (linhas 50 a 55 do `prosrc`) e grava o do snapshot aplicado em `tint_integration_settings.last_keys_snapshot_at` (linha 115). A rota só conferia que o campo existia (`index.ts:753` na `main@e53dbff03`). Um snapshot com `generated_at` em 2099 avançaria a marca para 2099, e todo snapshot honesto seguinte seria pulado: a desativação por snapshot pararia, inclusive depois de trocar o token.

É a mesma classe do achado 3: **o emissor escolhia o relógio que decide a precedência**. Lá por cópia cega, aqui por campo explícito sem conferência.

- Formato fechado, para o JavaScript e o Postgres lerem o mesmo instante: `2026-11-17T03:03:41Z`, com fração de segundo opcional e fuso `Z` ou `±hh:mm`. `infinity` e `now`, que o Postgres aceita como `timestamptz`, são recusados.
- Adiantamento máximo de 10 minutos. Não se "corrige para agora": inventar o instante da fotografia mexeria na ordem que a promoção usa. Passado não tem piso, porque snapshot antigo já é pulado.
- Medido na PROD: nos 27 snapshots da retenção, `generated_at − created_at` fica entre −260,7 s e −215,4 s. Nenhum adiantado. O conector manda `originNow.Format(time.RFC3339)`, com o relógio do Postgres de origem. A marca atual é `2026-11-17 03:03:41Z`, e não há snapshot com `generated_at` no futuro.

## Achado 1 — gamificação: real por construção, sem consequência hoje

A premissa do scanner confere. `anon` e `authenticated` têm todos os privilégios de tabela (`relacl` com `arwdDxtm` nos dois), então quem decide é a RLS, e as policies "Users can upsert their own score" (INSERT, `auth.uid() = user_id`) e "Users can update their own score" (UPDATE, mesma expressão) liberam a própria linha com qualquer valor. A tabela não tem CHECK: `level_name` é texto livre e os números não têm teto. Executado no bloco A da prova: uma conta sem papel nenhum grava a própria linha com `total_score` 999999, não insere nem altera a de outro usuário (42501 e zero linha), o anônimo não escreve, e o ranking do staff lê o valor forjado em 1º.

É o desenho declarado. A migration que criou a tabela diz, logo acima das duas policies: `-- Users should be able to upsert their own score (computed client-side or via function)` (`20260222013401_…:131`). A tabela é o cache de um número que o navegador do cliente calcula (`useGamificationScore.ts:160-164`).

O que foi medido:

- **3 linhas, todas de staff** (2 employees e 1 master), gravadas em 2026-02-23, 2026-04-10 e 2026-05-15. Os valores batem com a conta do hook para quem não tem dado nenhum (35 e 50). Nenhuma linha de cliente, e nenhuma forjada.
- **O único leitor do score alheio é o ranking de `/admin/gamification`** (`AdminGamification.tsx:71-74`), e a rota está congelada até 2027-01-10 (módulo `loja-afiacao` no manifesto). Nenhuma função, view, matview, cron, trigger ou edge cita a tabela. O nível não dá desconto, prioridade nem benefício em lugar nenhum do código: só aparece em telas e no certificado.
- **O caminho de escrita segue vivo.** A home (`/`) ficou fora do congelamento e monta o `CustomerDashboard` (`Index.tsx:116`), que chama o hook. Um cliente que abrisse a home hoje gravaria a própria linha.
- **Os insumos do score também são do cliente.** `user_tools` (INSERT, UPDATE e DELETE do dono), `training_completions` (INSERT do dono), `referrals` (INSERT do dono, sem amarrar o `status`) e `orders` (INSERT e UPDATE do dono) somam 80% do peso. Só `sending_quality_logs`, 20%, é gravada por staff. Calcular no servidor fecharia a forja direta, mas não tornaria o ranking confiável. Hoje essas tabelas têm 4, 1, 0, 0 e 0 linhas.

Duas saídas, as duas legítimas. A escolha é do founder:

- **Aceitar e marcar como ignorado**, com a condição escrita: antes de descongelar o módulo, o score passa a ser calculado no servidor, ou o ranking sai.
- **Fechar a escrita do dono agora**, com uma migration que remove as duas policies. A sabotagem `gam_sem_escrita_do_dono` da prova mostra o efeito: o cliente deixa de gravar e o staff segue gravando. O hook não confere o erro do upsert, então a tela do cliente não muda; o ranking ficaria só com linhas de staff até alguém mover o cálculo. É outra classe de conserto (policy de RLS) e não entrou neste lote.

## Achado 2 — biometria: o caminho descrito não acontece

O painel diz que qualquer um troca o desafio de outra credencial e atrapalha um login biométrico em curso. O código faz o upsert que ele descreve (`biometric-auth/index.ts:92-101`), sem conferir identidade. Mas:

- **O upsert falha no banco.** `webauthn_challenges` só tem chave primária em `id` e um índice **não único** em `credential_id` (migration `20260512012320_…:14`; a PROD é igual). `ON CONFLICT (credential_id)` sem índice único é erro 42P10, e a edge não confere o resultado: responde sucesso sem ter gravado nada, desde que foi criada. Executado no bloco B da prova, com o controle ao lado: na tabela gêmea com `UNIQUE (credential_id)`, o mesmo comando grava e a 2ª chamada troca o desafio, que é exatamente o que o scanner descreve.
- **Não há login a interromper.** `webauthn_credentials` e `webauthn_challenges` têm 0 linhas. Nenhuma tela chama o login biométrico: `Profile.tsx` só usa `checkRegistration`, e o bloco de configuração traz o comentário "hidden for now" (`:414`); `Auth.tsx` não cita biometria.
- **Front e edge não conversam.** O hook gera o desafio no próprio navegador (`useBiometricAuth.ts:196`), nunca chama a ação `challenge`, e chama `verify` só com `credentialId` (`:217-222`), sem os campos que a edge exige (400). Espera um `email` que a edge não devolve. E a `verify`, quando dá certo, devolve só o `user_id`: não cria sessão.

O achado é **latente em código morto**. Ele passaria a valer se alguém "consertasse" o upsert criando o índice único. Se a biometria voltar, o desafio tem de ser por cerimônia, e não por credencial.

## Achados 4 e 5 — texto do staff no system prompt

**Achado 4.** O painel cita `generate-bundle-argument/index.ts:285-295`, a chamada do modo padrão, e o campo `customerProfile`. Entre os ignorados já existe "Any staff member can inject system prompt instructions", que cita o **mesmo arquivo** em `:191-201`, a chamada do modo de perguntas, e o **mesmo campo**. Foi marcado pela conta do founder em 15/11 às 17:19 (hora local), com o motivo: risco residual aceito por desenho, por decisão explícita do founder; só staff ou cron aciona, com cota; a saída volta ao próprio funcionário. O achado novo é a segunda chamada do mesmo caso.

**Achado 5.** `copilot-analyze` põe `customerContext` e `bundleContext` do corpo no system prompt (`:176`, `:179`). O painel cita a linha `:213`, que é a resposta de erro. As três condições daquela decisão valem aqui também: só staff ou cron passa (`:34`), há cota por usuário (`:148`), e a saída é uma única ferramenta forçada cujo resultado volta a quem pediu; a edge não grava nada. O próprio painel descreve o chamador como staff. A edge é outra, então a decisão não se estende sozinha: marcar pede o sim do founder.

Ficou à vista, e não foi feito: no front, `customerProfile` é um de quatro valores (`CustomerProfile`, em `useBundleArguments.ts:19`), e `currentPhase` e `currentIntent` são a fase e a intenção que a análise anterior devolveu (`useCopilotEngine.ts:256-257`), que o próprio prompt lista como valores fechados. A edge poderia conferir contra a lista em vez de aceitar texto livre. Cada edge custa um deploy.

## Parentes conferidos

Censo da classe "linha de banco montada por cópia do corpo" nas 98 edges, feito por subagente e conferido por amostragem em dois pontos: **nenhum outro caso**. O que parece o padrão e está fechado hoje:

- `recommend` espalha `extras` no insert de `recommendation_log`, mas o único chamador passa dois campos escolhidos a dedo, e `unit_cost` e `margin` são forçados a `null` depois do spread.
- `radar-ingest` manda as linhas do corpo cruas para a RPC, e o SQL as abre com `jsonb_to_recordset(...) AS x(colunas)`.
- `omie-sync-pedidos-compra` e `cmc-snapshot-backfill` copiam objeto montado no servidor (resposta da Omie, quatro campos).
- Na própria `tint-sync-agent`: `precos_base`, `/formulas`, `/preparations` e `/heartbeat` montam a linha campo a campo. A rota `simulate`, com JWT de staff, grava corantes campo a campo com dado do servidor; o teste de forma a achou na 1ª execução, porque exigia que as cinco tabelas não tivessem outro escritor.

Fora da classe, vizinho, não tratado: `omie-sync`, ação `sync_order`, usa lista explícita, mas `id`, `user_id`, `subtotal` e `total` de `orders` vêm do corpo. O gate é cron ou staff.

## 2ª opinião (Codex)

`Codex: desenho=gpt-6-astra·max·445s·201.562 tokens (prompt com RÉGUA:) · código=gpt-6-astra·max·477s·194.262 tokens · extra=nenhum`

**Desenho.** A consulta rodou com o conserto de `/catalogs` já escrito, e não antes do código, como manda o ritual. O parecer foi "aprovo com ajustes", sem P0.

Adotado:

- **P1, o relógio do snapshot** (seção acima). O conserto entrou neste PR por ser da mesma classe e da mesma edge.
- **P2, entidade torta sozinha recebia confirmação limpa.** A conferência de forma passou para antes do atalho.
- **P2, `errors = 0` no run pode ser falso verde no deploy.** A promoção sobrescreve `tint_sync_runs.errors` e `inserts` com os contadores dela. A conferência de produção tem de ler `idempotency_response`, que é a resposta que o conector recebeu.
- **P2, o registro da recusa era melhor esforço sem dizer.** `logError` ignorava o `error` do insert. Passou a devolver se gravou, e a recusa avisa no console quando não.
- **P2, o teto de nomes só cortava depois de acumular tudo.** Passou a valer durante a coleta.
- **P2, o gerador do teste de propriedade cobria muito menos do que parecia.** O multiplicador estourava a precisão do `Number`: 1.996 das 2.000 iterações geravam uma chave só, 12 conjuntos distintos. Trocado por Park–Miller, com asserção de cobertura por entidade.

Não adotado, com motivo:

- *Fechar sem promoção o run em que tudo foi recusado.* Mexe no fecho e no enfileiramento, que são money-path e estão fora do conserto. O run recusado é o rastro da recusa, e qualquer lote válido de um item já dispara uma promoção.
- *Aplicar `MAX_PAYLOAD_BYTES`*, declarado e nunca usado. É anterior a este lote e pede medir antes os tamanhos legítimos.
- *Trigger no banco forçando `created_at`.* O parecer também não recomendou: para os escritores que existem, a lista fechada resolve sem tocar o banco.

**Código.** "Aprovo com ajustes", sem P0 nem P1. O revisor comparou 14 cenários do handler real com o da `main`, com o Supabase simulado em memória: para os lotes honestos, status, resposta e escritas coincidiram. Quatro P2, todos adotados:

- **O teste de forma deixava passar a regressão mais grave.** Trocando `if (montado.recusados > 0)` por `< 0`, os 13 testes de texto passavam, e o handler respondia 200 com `error_count: 0` para um item recusado: o conector confirmaria o lote. Uma das verificações negativas recortava o texto a partir de um índice que ninguém conferia. Entrou `index_test.ts`: o handler de `/catalogs` e de `/keys-snapshot` executado de verdade, com o PostgREST simulado, conferindo a resposta e cada escrita.
- **O validador do snapshot aceitava data fora do contrato que anunciava**: 30 de fevereiro, ano 0000, fuso `+23:59` e hora 24. O Postgres recusava e a rota respondia 500 no lugar do 400, sem gravar instante nenhum. E a fração de segundo ficava fora da conta do teto. O validador passou a conferir calendário e fuso campo a campo e a somar a fração.
- **`logError` devolvendo boolean quebrou a tipagem do adaptador de `/preparations`** (TS2322, classe que o `edges:typecheck` tolera por desenho; quem viu foi o `deno check` do entrypoint). O adaptador voltou a devolver `Promise<void>`.
- **A prova SQL não relia o que dizia ter gravado.** O A1 só conferia a ausência de erro, e o B2 não conferia a 1ª gravação antes da 2ª. Os dois passaram a reler o estado, e a falsificação ganhou duas sabotagens em que a 1ª escrita some sem erro.

## Prova

- **Os fatos da triagem, no banco:** `db/test-seg-lote6-triagem.sh` (PG17). 12 asserções em três blocos (gamificação, biometria, staging do tintométrico), cada um com controle, e relendo o que foi gravado. O modo `--falsificar` roda o controle verde e cinco sabotagens na mesma invocação, em `C` e em `pt_BR.UTF-8`: três são o estado que fecharia cada achado, duas fazem a 1ª escrita sumir sem erro; cada uma derruba exatamente os asserts esperados. Não entrou no núcleo do CI: ela documenta a triagem, não guarda conserto de banco.
- **O builder:** `catalogo-staging_test.ts` (15 testes Deno). Equivalência linha a linha com o algoritmo antigo, copiado dentro do teste, para as 5 formas reais e para 336 combinações de colunas permitidas com valores `null`, `0`, `''` e texto, comparando conteúdo e conjunto de chaves; cada coluna de controle em cada entidade (40 casos); propriedade com gerador determinístico (aceite se e só se todas as chaves são da entidade).
- **O relógio do snapshot:** `snapshot-gerado-em_test.ts` (12 testes Deno), com a fronteira da tolerância ao segundo e à fração, o fuso entrando na conta, o calendário (30 de fevereiro, ano 0000, hora 24) e os formatos que o Postgres aceita e o validador recusa.
- **O handler, executado:** `tint-sync-agent/index_test.ts` (13 testes Deno, PostgREST simulado pelo harness de handler). Lote honesto: resposta sem erro e exatamente as escritas de antes. Item forjado: `error_count` 1, `errors[]` nomeando o campo, nenhuma linha nem coluna `created_at` no staging, e o registro sem o valor do item. Conta, loja e run vêm do servidor mesmo com os nomes no corpo. Entidade que não é lista: 400 e zero escrita. Snapshot no futuro: 400 e zero escrita; honesto: grava o mesmo texto.
- **A forma do `index.ts`:** `src/__tests__/tint-catalogo-colunas-fechadas.test.ts` (vitest, 13 testes, lê a edge como texto). A rota só delega ao builder, a recusa conta como erro, as cinco tabelas não têm outro escritor fora da simulação, a forma do lote vem antes do atalho, e o `generated_at` que vai ao banco é o validado.
- **Dívida quitada no caminho:** `logError` passou a conferir o `error` do insert, e a linha de base do gate de escrita que falha calada desceu de 3 para 2 nesta edge (`escrita-critica-gate.test.ts`).
- **Falsificação:** quatro contratos em `scripts/mutcheck.d/` (`tint-catalogo-staging`, `tint-snapshot-gerado-em`, `tint-sync-agent-handler`, `tint-catalogo-forma`): 80 mutações de uma linha, 78 pegas, com o controle verde na mesma invocação. As duas que sobrevivem são equivalentes: "copiar todas as chaves do item já aceito" (a cópia por lista é a 2ª camada, e sozinha ela é inalcançável, porque o filtro já barrou as chaves estranhas) e "usar o `generated_at` cru no insert depois de validado" (é o mesmo valor). As duas camadas do builder abertas juntas, numa cópia fora do worktree: a linha sai com `created_at` em 2099 e 7 testes caem, em `C` e em `pt_BR.UTF-8`.
- `test:edges` 2782/0 · `deno check` do entrypoint · `edges:typecheck` · `edges:sintaxe` · `sonda:fingerprint` (87 edges) · `sonda:bump` · `sonda:nova` · `sonda:autentica` · `canaria:bump` · `bun lint`.

## Lições

- **Coluna com default do banco também é coluna que o cliente escolhe, quando a linha nasce de cópia do corpo.** `created_at` parece metadado, e vira dado de negócio no dia em que alguém escreve `ORDER BY created_at DESC LIMIT 1`. Ao triar cópia cega, liste as colunas que ficam ao alcance e procure quem **lê** cada uma. A 1ª leitura deste achado dizia "defesa em profundidade, baixo", e só mudou ao ler o corpo vivo da função que consome a tabela.
- **O relógio de precedência não pode vir do emissor sem conferência.** Vale para a coluna com default e para o campo explícito. O parente de `/keys-snapshot` não era cópia cega, e tinha o mesmo efeito.
- **Guardar o item cru permitiu fechar o contrato sem adivinhar.** O `raw_data` do staging deu a medida exata do que o conector manda, em toda a retenção. Sem ele, a escolha entre recusar e limpar seria feita no escuro.
- **Upsert com `onConflict` numa coluna sem índice único falha em silêncio quando ninguém confere o erro.** A edge de biometria respondeu sucesso por seis meses sem gravar um desafio.
- **O teste de forma achou um escritor que a leitura não tinha achado.** "Nenhum outro escritor para estas tabelas" falhou na 1ª execução e mostrou a rota `simulate`.
- **E o mesmo teste de forma não prova o que o conector recebe.** Ele conferia que as linhas certas existiam no texto, e passava com a condição da recusa invertida. Para edge cujo handler carrega offline, o teste que decide é o que executa o handler com o PostgREST simulado e confere resposta e escritas; o de texto fica para o que a execução não alcança.
- **O gate de tipos das edges tolera TS2322.** Trocar o retorno de um helper compartilhado dentro do `index.ts` quebrou um adaptador, e o gate passou. Depois de mexer em assinatura, rode `deno check` no entrypoint.
- **Gerador pseudoaleatório escrito à mão em JavaScript: confira a cobertura que ele entrega.** O produto estourou os 53 bits e o teste de propriedade rodava quase sempre o mesmo caso, verde.
- **Dois vermelhos locais do vitest que não eram do diff.** A suíte completa saiu com código 1 duas vezes com a máquina saturada: uma por `Timeout calling "onTaskUpdate"` do próprio vitest, com todos os testes passando, e outra por um teste de hook que espera 30 ms fixos (`useTintCoresDoClienteUmToque`) e passa isolado. Nenhuma das duas rodadas contou como verde.

## Deploy

Camada única: a edge `tint-sync-agent`. Sem migration e sem Publish. Pendente no momento deste registro: será feito pela sessão depois do merge, pelo ritual de `docs/agent/deploy.md` (ledger, pacote por nome, MCP do Lovable, sensor, sonda), com o servidor da loja desligado, e registrado no PR da sonda.

A conferência de produção do dia seguinte não pode ser só "sem erro":

- Os dois 400 novos (forma do lote e `generated_at`) saem **antes** de o run existir e não deixam rastro no banco. Um defeito que recusasse lote honesto apareceria como **ausência**: de runs de catálogo e do snapshot do dia. A conferência é de presença, contra o patamar de antes (690 runs de catálogo em 24 horas; um snapshot por dia, aplicado).
- A promoção sobrescreve `errors` e `inserts` do run. O que o conector recebeu está em `tint_sync_runs.idempotency_response` (`error_count` e `errors`), e a promoção concluída, em `promocao_status`.

## Fica para o founder

- **Achado 1 (o Critical):** escolher entre aceitar e marcar como ignorado, com a condição do descongelamento, ou fechar a escrita do dono numa migration.
- **Achados 2, 4 e 5:** dizer se marca como ignorados. Motivos prontos: recurso morto e escrita que falha (2); mesmo caso do achado aceito em 15/11 (4); mesmas três condições daquela decisão (5).
- **Achado 3:** depois do deploy, um deep scan novo confere se ele saiu da lista.
- **Follow-ups que este lote deixou à vista**, nenhum tratado aqui:
  - a edge `biometric-auth`, o hook e as duas tabelas são código morto com um endpoint sem autenticação no ar: remover ou refazer é decisão de produto;
  - `MAX_PAYLOAD_BYTES` da `tint-sync-agent` nunca é aplicado;
  - a rota `simulate` deixa um employee gravar linhas de simulação no staging real de corantes, e a promoção lê o "mais recente" entre todos os runs do par;
  - `omie-sync`, ação `sync_order`: `id`, `user_id` e totais de `orders` vêm do corpo, atrás de gate de cron ou staff;
  - `referrals` e `orders` deixam o dono inserir a linha com o `status` que quiser.
- **Não usar "Try to fix" nem "Try to fix all"** ([caso](agente-lovable-conserta-o-que-nao-pediram.md)).
