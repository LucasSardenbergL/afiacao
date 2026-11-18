# Rescan do scanner Lovable Security — lote 6 (2026-11-17)

Continuação do [lote 5](scanner-lovable-rescan-lote5.md). O deep scan das 20:25Z deixou 5 achados novos no painel, sem triagem. Este lote tria os 5. Um é real e alcança o preço do tintométrico, e a revisão dele achou um segundo furo da mesma classe na mesma edge. Dois são da classe "dado do request no system prompt" e foram endurecidos. Um não é explorável hoje. Um espera decisão do founder. Cada fato de banco abaixo foi lido na PROD via `psql-ro` em 2026-11-17, entre 20:53Z e 22:10Z.

## Os 5 achados

| Título no painel | Veredito | Onde está |
|---|---|---|
| Anyone with a sync credential can alter catalog records (Warning) | **Real**, corrigido aqui | `tint-sync-agent`, rota `/catalogs` |
| Request data is embedded in the system prompt (Warning) | O caminho direto é desenho. **O indireto é real e baixo.** Endurecido aqui | `copilot-analyze` |
| Staff users can override bundle argument model instructions (Warning) | Desenho: staff contra si mesmo. Endurecido aqui porque o campo é um enum | `generate-bundle-argument` |
| Anyone can disrupt biometric sign-in (Warning) | **Não explorável hoje**: a escrita que o painel descreve não executa na PROD | Seção "`biometric-auth`" |
| Any signed-in user can inflate their gamification score (Critical) | A premissa confere e o impacto hoje é nulo. **Decisão do founder** | Seção "Gamificação" |

## O que entrou

| Achado | Correção |
|---|---|
| 🔴 `tint-sync-agent`: o agente escolhia colunas do servidor no staging de catálogo, entre elas `created_at` | `v1.4-catalogo-lista-fechada`: lista fechada de colunas por entidade (`catalogo-rows.ts`). `id`, `created_at` e `matched_id` ficam com o default do banco. Item com campo fora da lista é recusado inteiro: não vira linha, conta em `error_count` e fica em `tint_sync_errors` |
| 🔴 `tint-sync-agent`, rota `/keys-snapshot`: o `generated_at` do agente era gravado sem conferência, e é por ele que o banco ordena os snapshots. **Não estava no painel**: saiu da consulta de desenho ao Codex | Mesma versão: `validarGeneratedAt` (`snapshot-relogio.ts`) exige RFC 3339 com fuso e recusa, com 400 e sem escrever, o instante mais de 10 minutos à frente do servidor |
| 🟠 `copilot-analyze`: contexto do cliente, bundle, fase e intenção anteriores vinham do body e entravam no system prompt | `v1.5-system-prompt-fixo`: o system é uma constante. O dado do request vai na mensagem, em blocos que o system declara como dado. Fase e intenção só passam se forem do enum da tool |
| 🟡 `generate-bundle-argument`: `customerProfile` do body entrava cru no system prompt dos dois modos | `v1.5-perfil-enum-fechado`: só um dos 4 perfis passa. O resto vira `nao_informado`, com uma linha no prompt dizendo ao modelo para não presumir perfil |

Sem migration e sem Publish. Camada única de deploy: as 3 edges.

## `tint-sync-agent`: o agente escolhia o relógio do servidor

A rota `/catalogs` grava 5 tabelas de staging (`tint_staging_produtos`, `_bases`, `_embalagens`, `_skus`, `_corantes`). Até a v1.3 ela montava a linha copiando toda propriedade do item recebido, menos as 5 que já tinha posto (`sync_run_id`, `account`, `store_code`, `raw_data`, `staging_status`). Sobravam três colunas do servidor ao alcance de quem tem o token de sync: `id`, `matched_id` e `created_at`.

`created_at` é a que importa. As funções que leem o staging, com o corpo lido da PROD:

- `tint_promote_sync_run` escolhe a linha vencedora de cada chave por `ORDER BY created_at DESC, id DESC`. O próprio corpo diz, num comentário, que conta com o relógio do servidor.
- `tint_calc_preco_final` e `tint_recalc_preco_oficial` leem o custo e o volume do corante da linha mais recente de `tint_staging_corantes`, pela mesma ordenação, e somam ao preço da base.
- `tint_staging_purge` só apaga a linha com mais de 30 dias que tem outra mais nova por cima.

Uma linha de corante com `created_at` no futuro vencia toda sincronização legítima seguinte e nunca era purgada. O preço do balcão ficava preso no custo dela, mesmo depois de o token ser trocado. Mandar um custo errado o agente sempre pôde, e a sincronização seguinte que trouxesse custo e volume o corrigia (as funções de preço só olham linha com os dois preenchidos). O que a cópia genérica acrescentava era a persistência.

`matched_id` não é lido por nenhuma das 5 funções. `id` é o desempate da ordenação.

**Medido, para dar tamanho:**

- Nenhuma linha das 5 tabelas tem `created_at` mais de 5 minutos à frente do relógio, e nenhuma traz chave de servidor no `raw_data` (`created_at`, `id`, `matched_id`, `staging_status`, `sync_run_id`, `account`, `store_code`). Foram 846.250 linhas, varredura completa. O caminho nunca foi usado.
- Uma loja, um token. `tint_integration_settings` tem uma policy só, de master: o token é legível pelo master e por quem tem acesso ao computador da loja.
- As 5 tabelas têm RLS ligada e uma única policy, de SELECT para staff. O único escritor é esta edge.
- O agente real só envia colunas de negócio. Nas 3.000 linhas mais recentes de cada tabela: `produtos {cod_produto, descricao}`, `bases {descricao, id_base_sayersystem}`, `embalagens {descricao, id_embalagem_sayersystem, volume_ml}`, `skus {cod_produto, id_base, id_embalagem}`, `corantes {descricao, id_corante_sayersystem, volume_ml}`.

**O que muda de comportamento:**

- Para o agente real, nada: a linha nova é igual à antiga, chave a chave. O teste de caracterização compara as duas para os 6 formatos reais.
- Item com campo fora da lista: antes o PostgREST recusava o lote inteiro, de até 500 linhas, por coluna inexistente. Agora só o item é recusado (`separarLoteDeCatalogo`): ele não vira linha, entra em `error_count` e em `errors[]` da resposta com o nome do campo, e a edge grava uma linha por entidade em `tint_sync_errors`. O conector só confirma o lote com `error_count` zero, então reenvia a entidade no ciclo seguinte. Os itens limpos do mesmo lote entram.
- Item que não é objeto (texto, número, lista, `null`) é recusado do mesmo jeito. Antes `null` derrubava a rota com 500 e deixava o run em `running`.
- Entidade gravável que não vem como lista (`{"corantes": {...}}`) responde 400 sem abrir run e sem escrever (`erroDeFormaDoLote`). Antes, sozinha no lote, ela contava zero item gravável e recebia o ack limpo do lote sem run: o conector confirmava um lote que ninguém gravou. `null` e ausente seguem valendo como "não veio".
- Item sem a chave da entidade e com `id`: a regra `item[chave] || item.id || ''` é a de antes. Antes, porém, o `id` do item ia também para a coluna `id` da linha, que é uuid, e derrubava o lote se não fosse um uuid. Agora ele vira só a chave da entidade. Não é autoridade nova: o agente já podia mandar o mesmo valor na chave.

A rota `/formulas` já montava a linha por lista fechada (`staging-rows.ts`, Fase 1d), e `precos_base` também. O furo era só das 5 entidades de catálogo.

### Recusar o item, não limpá-lo

A 1ª versão deste conserto limpava o item: o campo fora da lista não virava coluna, a linha entrava, e a edge escrevia um aviso no log. Para fechar o furo dá no mesmo, porque a coluna do servidor não entra de nenhum dos dois jeitos. A diferença está no que a edge responde ao conector. Com a limpeza a resposta saía com `error_count` zero, o conector confirmava o lote e avançava a marca da entidade. Um campo novo de negócio que a lista não conhecesse sumia sem ninguém ser avisado, e o conector não reenvia depois.

Três leituras independentes apontaram esse ponto: o parecer de desenho do Codex desta sessão (P2: "ignorar silenciosamente tem custo de compatibilidade"), a revisão sem contexto do diff (achado 1: "o sinal é fraco"), e uma sessão que fez o mesmo lote em paralelo, cujo parecer de desenho disse "recusar o item é a decisão correta aqui; limpar e confirmar descartaria silenciosamente informação que o produtor acredita ter entregue".

Pesou também o que a PROD já faz. Na v1.3 o campo fora da lista derruba o lote por coluna inexistente, com erro contado e registrado. Foi assim que o campo `ativo` apareceu em campo em 12/06 e o conector foi corrigido (o comentário em `connector/sayersync/sync.go` conta o caso). Limpar e confirmar tirava da edge um comportamento ruidoso que já tinha servido uma vez. Recusar mantém o ruído e reduz o estrago ao item ofensor.

O custo, dito pelo parecer da outra sessão e medido na 3ª rodada do Codex desta: enquanto a lista da edge não for atualizada, a entidade com o campo novo fica em reenvio, os itens limpos dela são regravados a cada ciclo, e o run entra na fila de promoção de novo. As outras entidades seguem. O conector é deste repositório, então a regra é a ordem: o campo entra na lista da edge antes de sair do conector.

Onde a recusa aparece: no log do conector ("lote NÃO confirmado"), em `errors[]` da resposta guardada do run, e em `tint_sync_errors`, visível ao abrir o run em `TintSyncRuns`. Ela **não** aparece no alerta do staff, que só lê erro de run de fórmulas.

A lista fechada do builder continua por baixo da recusa. Tirar a recusa não devolve a coluna do servidor à linha.

### `/keys-snapshot`: o mesmo relógio, por outra porta

O painel não apontou esta rota. Quem apontou foi o Codex, na consulta de desenho, ao procurar outros caminhos da mesma classe. Conferido no corpo vivo das funções:

- `tint_apply_keys_snapshot` pula como "fora de ordem" o snapshot com `generated_at` menor ou igual a `tint_integration_settings.last_keys_snapshot_at`. Quando aplica, grava o `generated_at` do snapshot como novo marco.
- `tint_promote_sync_run`, `tint_receita_versoes_capturar` e `tint_watchdog_fase5_check` escolhem o snapshot de referência pelo maior `generated_at`.

A edge só conferia se o campo existia. Um snapshot completo com `generated_at` em 2099 virava o marco para sempre: todo snapshot legítimo seguinte era pulado, e as retiradas do catálogo paravam de sincronizar, de novo mesmo depois da troca do token.

Medido: 81 linhas, 27 snapshots em 30 dias. O `generated_at` está sempre atrás do recebimento, entre 3min35s e 4min24s, que é o tempo de gerar e enviar. Nenhum chegou adiantado, e `last_keys_snapshot_at` não está no futuro. O caminho nunca foi usado.

A regra nova: RFC 3339 estrito com fuso explícito (é o que o conector manda, `time.RFC3339`, tirado do PostgreSQL de origem), instante que existe no calendário, e no máximo 10 minutos à frente do relógio do servidor. Quem lê o instante é o `instanteNs` de `preparacoes.ts`, o parser que a edge já tinha para as janelas de preparação. A 1ª versão trazia um segundo parser, com regras próprias para a mesma pergunta; a revisão sem contexto apontou a duplicação. Fora disso a rota responde 400 e não escreve. O valor aceito é gravado como veio. A folga limita o marco a 10 minutos à frente, não o tempo de recuperação: se um snapshot adiantado dentro da folga for aplicado, o legítimo gerado logo depois é pulado, e o conector só gera outro quando muda a data. A sincronização das retiradas pode esperar o dia seguinte. Deixou de ser para sempre.

O que isso pode custar: se o relógio do banco da loja passar a andar mais de 10 minutos adiantado, os snapshots dela serão recusados até alguém acertar o relógio. A recusa volta ao conector como 400 com o relógio do servidor na mensagem. Não foi conferido se algum alerta existente acusa a falta de snapshot aplicado: o `tint_watchdog_fase5_check` usa os snapshots para achar retirada, e o trecho lido não trata a ausência deles.

## As duas edges de IA

As duas exigem staff (`authorizeCronOrStaff`), consomem cota por usuário e forçam uma tool de saída estruturada. Nenhuma tem tool com efeito, e a saída volta para quem chamou.

**O caminho direto é staff contra si mesmo.** O vendedor que manda um `customerProfile` forjado muda o texto que ele mesmo recebe. Não há fronteira cruzada. É a mesma classe do achado "Any staff member can inject system prompt instructions", que já está entre os ignorados do painel.

**O caminho indireto existe no copiloto.** O `customerContext` é montado pelo front (`useFarmerCopilot.ts`) com o `name` de `profiles`, e a policy "Users can update own profile" deixa o cliente alterar a própria linha. Esse texto entrava no system prompt do copiloto que a vendedora lê durante a ligação. O efeito possível era uma sugestão manipulada na tela dela. Não há ação automática. `farmer_copilot_events` tem 0 linhas: o copiloto ainda não tem uso registrado.

O que mudou:

- `copilot-analyze`: o system prompt é a constante `SYSTEM_PROMPT_COPILOTO` (`copiloto-prompt.ts`), sem interpolação. Contexto, bundle, estado anterior e transcrição vão na mensagem do usuário, em quatro blocos. O system diz que o conteúdo dos blocos é dado, nunca instrução. Fase e intenção anteriores só passam se forem um valor do enum da tool; o resto vira `desconhecida`. O texto de um bloco não consegue fechar o bloco: `</transcricao_recente>` dentro da fala vira `</_transcricao_recente>`.
- `generate-bundle-argument`: `perfilParaPrompt` aceita os 4 literais de `CustomerProfile` e devolve `nao_informado` para qualquer outra coisa. Não devolve `misto`: perfil que ninguém classificou não é um perfil misto.

Isso reduz a superfície e não a zera. A transcrição é fala do cliente e continua sendo lida pelo modelo. O que protege a vendedora de uma leitura fabricada segue sendo a tool forçada e o `normalizarAnalise`.

A mudança move texto do system para a mensagem. A informação que o modelo recebe é a mesma, mas a qualidade da sugestão não foi medida depois da mudança: não há ligação gravada para comparar.

## `biometric-auth`: não explorável hoje, e o login biométrico está inoperante

O painel diz que a ação `challenge` não exige identidade e regrava o desafio pendente de qualquer credencial, por `upsert` em `webauthn_challenges` com `onConflict: "credential_id"`. A leitura do código confere. A escrita não acontece:

- `webauthn_challenges` não tem índice único em `credential_id`. Tem a PK em `id` e um índice comum em `credential_id`, na PROD e na migration que criou a tabela (`20260512012320`).
- O planejador da PROD recusa a forma do comando. `EXPLAIN INSERT … ON CONFLICT (credential_id) DO UPDATE …`, pelo `psql-ro`, que não executa e não escreve, devolveu `ERROR: 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification` (`infer_arbiter_indexes`).
- A edge não confere o erro do `upsert` e responde `success: true` com um desafio que não foi gravado.
- `webauthn_challenges` e `webauthn_credentials` têm 0 linhas.

Não há desafio para derrubar, nem tabela para encher.

O mesmo conjunto de fatos mostra que **o login biométrico não funciona de ponta a ponta**. O front (`useBiometricAuth.ts`) gera o desafio no próprio cliente, nunca chama `challenge`, e envia `verify` só com `credentialId`. A edge exige `authenticatorData`, `clientDataJSON`, `signature` e `origin`, e responde 400. Mesmo com o payload completo, `verify` não acharia desafio gravado. A tela de perfil oferece o cadastro da biometria; ninguém cadastrou.

**A armadilha para quem consertar:** criar o índice único que o `upsert` espera é o que torna real o achado do scanner. Com ele, quem conhece o `credentialId` de alguém passa a regravar o desafio em voo. O conserto do login precisa vir junto com a regra de quem pode pedir desafio.

## Gamificação: a premissa confere, o impacto hoje é nulo

`useGamificationScore` calcula o score no cliente e faz `upsert` em `gamification_scores`. As policies "Users can upsert their own score" e "Users can update their own score" liberam a linha do próprio usuário, então qualquer logado grava o score que quiser para si, direto pela API.

O que isso alcança hoje:

- A tabela tem 3 linhas. As 3 são de staff (2 employee, 1 master), a mais recente de 2026-05-15. Nenhum cliente tem linha.
- Nenhuma função, view ou edge lê a tabela. No front, quem lê é `AdminGamification.tsx` (o ranking do staff) e `Gamification.tsx` (a posição do cliente).
- A posição do cliente nunca comparou clientes entre si: a policy de SELECT dele só mostra a própria linha.
- O módulo "Loja / Afiação (cliente)" está congelado no manifesto desde 2026-10-12, com as rotas escondidas.
- O score não libera desconto, benefício nem acesso.

Fechar de verdade pede duas coisas: tirar o `upsert` do hook e remover as duas policies de escrita do cliente. O efeito de produto é o ranking do staff deixar de ser alimentado. Ele hoje só tem as 3 linhas de staff, e a alternativa correta para quando o módulo voltar é o cálculo no servidor.

**Decisão do founder (2026-11-17): fechar.** O `upsert` saiu de `useGamificationScore.ts`, que segue calculando o score para a tela. A migration `20261117225200_seg_lote6_gamificacao_sem_escrita_do_cliente.sql` remove "Users can upsert their own score" e "Users can update their own score", com postcondição: nenhuma policy de escrita fora da de staff, as 3 que ficam presentes, RLS ligada. É `DROP POLICY`, então é colagem do founder no SQL Editor; o pré-voo na PROD mostrou as 5 policies como previsto. Enquanto ela não for colada, o furo segue aberto pela API: tirar o `upsert` do front não fecha nada sozinho.

## Parentes conferidos

As duas classes deste lote foram varridas nas edges por subagente, só leitura. O relatório de um subagente é pista, não prova: o que está abaixo é o que ele devolveu, com a parte que foi conferida à mão marcada.

**Dado do request no system prompt.** 15 edges chamam LLM (17 chamadas, todas `messages.create` da Anthropic). 12 têm o system fixo ou só com constante e enum validado, as duas deste lote entre elas. 3 ainda interpolam texto do request ou de cliente:

| Edge | O que entra no system | Quem chama | Conferido à mão |
|---|---|---|---|
| `analyze-unified-order` | `profiles.name` e `document` dos clientes candidatos, cadastro do Omie, histórico de `orders` e o `userTools[]` do body (`prompt-sistema.ts`, bloco "DADOS DESTA CONSULTA") | staff | Sim: o bloco é um dos blocos do `system`, e ele mesmo termina dizendo que o conteúdo é dado, nunca instrução |
| `analyze-services` | `userTools[]` do body (`generated_name`, `custom_name`, categoria) | **qualquer JWT válido**, sem conferir staff nem aprovação; cota por usuário | Sim: o gate é só `getUser()` e a lista entra no template do system |
| `identify-tool` | `categories[]` do body, com teto de 80 e 200 caracteres e sem quebra de linha (conserto do [lote 1](scanner-lovable-rescan-lote1.md)) | staff ou cliente aprovado | Não |

Nas três a saída volta para quem chamou e o modelo só tem tool de saída estruturada. Nenhuma foi alterada aqui. Não foi conferido se alguma delas é o achado "Any staff member can inject system prompt instructions" que já está entre os ignorados do painel.

**O payload escolhe a coluna.** 98 edges e `_shared`, 375 arquivos `.ts` fora de teste (os da `tint-sync-agent`, já revistos, ficaram de fora). As 285 chamadas reais a `.insert`, `.upsert` e `.update` foram levadas até onde a linha é montada, e as 13 chamadas a `.rpc` com argumento não literal foram lidas. **Nenhuma outra instância.** Todas as origens fecham em literal de chaves fixas ou em função que devolve chaves fixas. Resposta de API externa (Omie, portal Sayerlack, 360dialog, Nvoip) é mapeada campo a campo ou gravada inteira em coluna jsonb.

Formas que um grep futuro vai acusar e que não são a classe hoje, porque a origem é do servidor:

| Onde | Por que não é |
|---|---|
| `radar-ingest`: `{ ...l, lote, observado_em }` no upsert de `radar_situacao_cadastral` | `l` sai de `validarLinhaSituacao`, que devolve objeto novo com 5 chaves fixas. Conferido à mão. É a mais próxima do body: vira a classe se o validador passar a devolver a própria linha recebida |
| `omie-sync-pedidos-compra`: laço `Object.entries(row)` com lista de exclusão | `row` vem só do mapeador da própria edge, com 12 chaves fixas. Conferido à mão |
| `sync_state` em `omie-analytics-sync` e `omie-sync-pedidos-compra` (`...updates`, `...extra`), `recommendation_log` em `recommend`, `pedido_compra_sugerido` em `disparar-pedidos-aprovados`, `whatsapp_template_sends`, `sayerlack_portal_evidencia`, `cmc_snapshot`, `nfe_recebimentos` (chave computada) | Todos os chamadores passam literal. Não conferido à mão |

Do lado do banco, só três funções usam `jsonb_populate_record`, e as três inserem com lista explícita de colunas.

O que a varredura não cobre: leitura estática, sem executar; as funções SQL só por grep; e o banco de produção não foi consultado (função aplicada fora do repo fica de fora).

## 2ª opinião (Codex)

`Codex: desenho=gpt-6-astra·max·460s·181.702 tokens (prompt com RÉGUA:) · código=gpt-6-astra·max·459s·184.250 tokens · extra=gpt-6-astra·max·469s·225.572 tokens`

Gatilho da 3ª rodada: a fronteira mudou depois do adversarial. O lote com campo fora da lista deixou de ser confirmado ao conector.

**Desenho.** Veredito "não segue", com a lista fechada do `/catalogs` dada como correta. A consulta saiu com o código do `/catalogs` já escrito, o que não é a ordem da regra (desenho antes do código): o que ela mudou foi o resto. Dois P1, os dois adotados:

- *`/keys-snapshot` conserva outro caminho de fixação temporal.* O parecer leu o SQL versionado e avisou que não tinha o corpo vivo. O corpo vivo confirmou (seção acima). Virou `validarGeneratedAt`.
- *A prova permitia verde com a escrita vulnerável.* Os testes só importavam o builder: acrescentar `created_at` à linha depois da chamada, no `index.ts`, deixava a suíte intacta. Virou `index_test.ts`, que executa o handler e olha o corpo do POST.

P2 adotados: aviso dos campos descartados (o parecer mostrou que o conector avança a marca no 200 e não reenvia); caracterização com a linha só de preço do corante e com lote heterogêneo; o teste por AST passou a recusar coluna do servidor com nome fixo em objeto literal; a precisão de que a sincronização seguinte só corrige o custo se trouxer custo e volume.

Confirmado pelo parecer, sem mudança: não há outra cópia arbitrária de colunas nas rotas da edge (`/formulas`, `/preparations`, `/simulate`, `/reconcile`, `logError`, o `Object.assign(upd, extra)` do fechamento do run); ignorar o campo reservado é melhor do que rejeitar o item, porque rejeitar não tira do agente a autoridade sobre o custo; o `id` como desempate segue gerado pelo banco; manter o alias `item.id`.

**Não adotado, com motivo:**

- *Trigger `BEFORE INSERT` forçando `created_at := now()` nas 5 tabelas.* O próprio parecer diz que não é requisito deste merge: o escritor é único e é service-role. Fica como follow-up de banco, para o dia em que houver um segundo escritor.
- *Gravar o aviso de descarte em `tint_sync_errors`.* Na versão que o parecer de desenho viu, ficou de fora, como log da edge. A versão final grava: a recusa do item escreve uma linha por entidade nessa tabela (seção "Recusar o item, não limpá-lo"). O motivo que este registro dava para não gravar estava errado: o alerta do staff não lê erro de run de catálogo.

**Código.** Veredito "segue", sem P0 nem P1. O parecer executou os 145 testes Deno das 3 edges e, em memória, os 68 mutantes dos contratos de então: todos aplicaram em uma linha e caíram por asserção. Quatro P2, todos adotados:

- *`Date.parse` finito não garante instante que o Postgres aceita.* `2026-02-30T00:00:00Z` passava (o JavaScript rola para 2 de março) e o banco recusava depois de a rota tentar gravar: 500, não o 400 prometido. E `…03:18:05.000999Z` passava 999 microssegundos além da tolerância. O instante agora sai dos campos do texto, com o calendário conferido por ida e volta e a fração contada até o nanossegundo.
- *A análise por AST aceitava sobrescritas que o cabeçalho não declarava.* `...{ system: transcript }` depois do `system`, um `rows.forEach` que acrescenta `created_at` depois do builder, e `let systemPrompt` regravado antes da chamada deixavam os 28 testes verdes. O analisador passou a recusar spread e segundo `system` no objeto do `messages.create`, a exigir `const`, e a contar os usos da variável das linhas. O cabeçalho do teste diz o que continua fora.
- *Dez minutos limitam o marco, não o tempo de recuperação.* Se um snapshot adiantado dentro da folga for aplicado, o legítimo gerado logo depois é pulado, e o conector só gera outro quando muda a data. A recuperação pode esperar o dia seguinte. O comentário do módulo e este registro diziam "por esse mesmo tanto"; foram corrigidos.
- *Um mutante equivalente morria por identidade de objeto.* `raw_data: { ...item }` grava o mesmo JSON, e o teste só o derrubava porque exigia a mesma referência. O teste passou a comparar o conteúdo, e o contrato troca esse mutante por dois que perdem evidência de verdade.

Do mesmo parecer, sem severidade, adotado: o nome do campo fora da lista sai sem caractere de controle nem separador de linha Unicode, e a neutralização do delimitador cobre espaço e quebra de linha em volta da barra. Entidade HTML e caractere parecido seguem passando, e isso está escrito no módulo e num teste.

O parecer conferiu no conector que os mapeadores das 5 entidades cabem na lista fechada e que os dois hooks do bundle só enviam os 4 perfis. Ele não rodou o `mutcheck` de shell (altera arquivo), o Vitest canônico não subiu no sandbox dele, e os fatos de PROD que usou foram os fornecidos no prompt.

**3ª rodada (o delta da recusa).** Veredito "segue", sem P0 nem P1. O parecer executou o handler com fakes próprios e os 67 mutantes da tint de então, em memória. Cinco P2:

- *O corte do nome do campo podia impedir o fechamento do run.* Cortar em 60 unidades UTF-16 parte um emoji ao meio e deixa um substituto isolado. O nome vai para `tint_sync_errors` e para a resposta guardada do run, que são `jsonb`, e o Postgres recusa substituto isolado. Com `"a".repeat(59) + "😀"` como nome de campo, o item limpo do lote era gravado, o fechamento falhava e a rota respondia 500. Adotado: corte por ponto de código, e substituto isolado vira `?`. O parecer simulou a recusa do banco; não foi executado em Postgres.
- *O registro da recusa podia segurar a resposta e os itens limpos.* Ele era esperado antes do staging. Adotado: dispara e segue; a rota espera por ele no fim, por no máximo 3 segundos. Estourado o teto, a recusa segue em `errors[]` da resposta e a edge escreve no log que o registro não confirmou.
- *O teste por AST aceitava uma segunda declaração de `lote` num bloco morto, e a linha tocada no bloco de verdade.* A análise escolhia a declaração por posição textual. Adotado: nome declarado duas vezes no arquivo é recusado como ambíguo.
- *O reenvio acrescenta trabalho de promoção.* Enquanto uma entidade tiver item recusado, o conector a reenvia a cada ciclo, os itens limpos são regravados, o run fecha como completo e, em `automatic_primary`, entra na fila de promoção. Para corante com custo, a promoção recalcula o preço das fórmulas que o usam sem exigir que o custo tenha mudado. Na v1.3 o reenvio já existia; o que é novo é regravar os itens limpos do lote que antes falhava inteiro. **Não adotado como código:** o cenário pede um campo que o conector manda e a lista não conhece, o que é erro de ordem de deploy deste repositório, e o parecer não o tratou como bloqueio. Fica registrado como custo conhecido da recusa por item.
- *O alerta do staff não mostra essas recusas.* `useTintAlertas` só lê erro de run de fórmulas, e a promoção regrava o contador de erros do run com a contagem dela, que pode ser zero. A linha em `tint_sync_errors` aparece ao abrir o run em `TintSyncRuns`. **Não adotado como código:** é limite que já existia nos consumidores. Corrigido aqui o que este registro dizia: gravar em `tint_sync_errors` não é avisar o staff.

## Revisão sem contexto

Depois do parecer de código, um subagente sem o histórico da sessão revisou o diff inteiro, só leitura, executando sondas próprias. Conclusão dele: sem bloqueio. O que ele conferiu executando: a aritmética do relógio contra `Temporal.Instant` (300 mil instantes aleatórios e 200 mil na fronteira da folga, nenhuma divergência); a linha nova contra a antiga para 15 formatos do conector e 200 mil itens aleatórios com colunas da própria entidade, nenhuma divergência; os 6 lotes do conector pelo handler.

O que ele achou, e o destino de cada um:

| Achado | Destino |
|---|---|
| Campo fora da lista virou "aceita e avisa no log", com o lote confirmado. O sinal é fraco | Adotado: seção "Recusar o item, não limpá-lo" |
| A ligação positiva das duas edges de IA não tinha teste. Tirar `bundleContext` da mensagem do copiloto, ou a linha do perfil do prompt, deixava o teste por AST verde | Adotado: o teste exige os 5 campos na mensagem e o perfil e as duas regras em cada prompt |
| O teste do handler não prendia a folga de 10 minutos. Adiantar o relógio do servidor em até 49 minutos passava | Adotado: `+11 min → 400` e `+9 min → 200` no handler |
| Item que não é objeto entrava como linha de chave vazia, com `error_count` zero | Adotado: é recusado como os demais |
| A regra do perfil não informado dizia "balance os argumentos" também no prompt que gera perguntas | Adotado: texto neutro |
| Dois parsers RFC 3339 na mesma edge, com regras diferentes | Adotado: o módulo do relógio reusa o `instanteNs` |
| Texto que ficou para trás: comentário do conector, página de contrato da API, um JSDoc órfão | Adotado |

## Prova

- **A rota executada:** `supabase/functions/tint-sync-agent/index_test.ts`. O handler roda pelo harness com um PostgREST falso que guarda o corpo de toda escrita.
  - `/catalogs` com o lote como o conector envia: as 6 escritas de staging na ordem, zero erro, nenhuma linha e nenhum `columns=` com `id`, `created_at` ou `matched_id`, colunas do servidor com o valor do servidor.
  - `/catalogs` com item que traz coluna do servidor: o item não vira linha, a resposta sai com `error_count` 5 e uma entrada em `errors[]` por entidade nomeando o campo, o corante limpo do mesmo lote entra, e há uma linha por entidade em `tint_sync_errors` com os nomes e sem o item.
  - Campo de negócio desconhecido (o caso `ativo`) e item que não é objeto: recusados do mesmo jeito. Entidade que não vem como lista: 400 sem run e sem escrita. `null` segue valendo como ausente.
  - `/keys-snapshot`: 2099, +1 hora e +11 minutos respondem 400 com zero escrita; ilegível, sem fuso e 30 de fevereiro também; o instante real entra, gravado como veio; +9 minutos entra.
  - O registro da recusa não segura o staging: com o fake respondendo `tint_sync_errors` só depois da última escrita de staging, a rota grava os itens limpos e depois espera os registros. Nome de campo com emoji na fronteira do corte: a rota responde 200 e nada do que vai ao banco tem substituto isolado.
  - Token errado: 401 e zero escrita.
- **Os módulos puros:** `catalogo-rows_test.ts` (lista fechada por entidade, valor sem conversão, ausente fica ausente, só propriedade própria, a linha nova igual à antiga para 9 formatos reais do conector, lote heterogêneo, recusa, mensagem, forma do lote), `snapshot-relogio_test.ts` (fronteira da folga até o microssegundo, fuso com minutos, calendário, forma estrita), `copiloto-prompt_test.ts` e `argumento-helpers_test.ts`.
- **A ligação nas 3 edges, por AST:** `src/__tests__/edge-seg-lote6-gate.test.ts`, 47 testes, 40 deles mutantes embutidos. O cabeçalho diz o que a análise não alcança. As duas edges de IA importam o SDK da Anthropic por `npm:` e não carregam na suíte offline: para elas a ligação se prova só aqui.
- **Mutação:** 5 contratos versionados em `scripts/mutcheck.d/` (`tint-catalogo-rows`, `tint-snapshot-relogio`, `tint-sync-agent-handler`, `copiloto-prompt`, `perfil-do-bundle`). 100 mutações, 100 pegas, em `C` e em `pt_BR.UTF-8`, com a suíte crua verde na mesma invocação e os fontes devolvidos byte a byte. Três rodadas não fecharam de primeira, e as três corrigiram alguma coisa. "Minutos do fuso ignorados" sobrevivia, porque nenhum caso tinha fuso com minutos; o teste ganhou o caso em que ignorar os minutos muda o veredito. Um mutante não compilava; o executor o marcou como inválido em vez de pego, e ele foi reescrito. "Timer do limite não desarmado" sobrevivia: o teste contava com o Deno acusar timer pendente, e o Deno 2.9 não acusa (medido: um `setTimeout` de 60 segundos solto passa verde). O teste passou a contar as chamadas a `clearTimeout`.
- **Os fatos de banco da triagem, executados:** `db/test-seg-lote6-triagem.sh` (PG17). Entrou depois deste lote, vinda da sessão paralela. Sobe as policies e o DDL copiados da PROD e roda 12 asserções em três blocos, relendo o que foi gravado:
  - a conta sem papel grava a própria linha de `gamification_scores` com qualquer valor, não insere nem altera a de outro usuário, o anônimo não escreve, e o ranking do staff lê o valor forjado em 1º;
  - o upsert da biometria falha com `42P10` e nada grava; no controle, com `UNIQUE (credential_id)`, o mesmo comando grava e a 2ª chamada troca o desafio;
  - a linha de staging com `created_at` forjado vence o run honesto, o reenvio honesto posterior não desfaz, e a purga apaga as honestas e poupa a forjada. Este bloco é uma miniatura das consultas do corpo vivo da promoção e da purga, não a função inteira; o critério `(created_at, id)` na função inteira está em `db/test-tint-promote-latest-indexado.sh`.

  O modo `--falsificar` roda o controle verde e cinco sabotagens na mesma invocação, em `C` e em `pt_BR.UTF-8`. Três são o estado que fecha cada achado (sem as policies de escrita do dono; com o `UNIQUE`; com a data do servidor), e duas fazem a 1ª escrita sumir sem erro, para mostrar que o assert nota. Cada uma derruba exatamente os asserts esperados. A prova fica fora do núcleo do CI: documenta a triagem, não guarda conserto de banco.
- `test:edges` 2803/0 · `edges:typecheck` 0 erro de classe-crash e 0 tolerado nos arquivos tocados · `edges:sintaxe` · `sonda:fingerprint` (87 edges) · `sonda:autentica` · `sonda:nova` · `sonda:bump` · `canaria:bump` · `bun lint` · `bun run typecheck` · `knip` · `lint:shell` · `docs:indice` · `docs:links`. O `docs:citacoes` acusou 7 citações `arquivo:linha` de outros docs para o `index.ts` da `tint-sync-agent`, deslocadas pelas edições. Foram reapontadas e lidas uma a uma.

O que nada disto prova: default, constraint e RLS do banco de verdade, a promoção, o preço final e a purga depois da mudança, o bundle servido, e a qualidade da resposta do modelo com o contexto na mensagem.

## Lições

- **Copiar o payload para a linha entrega ao remetente toda coluna que o servidor não listou.** A rota protegia 5 colunas por nome e esqueceu as três que o banco preenche por default. Lista do que é proibido envelhece a cada coluna nova; lista do que é permitido não.
- **"Relógio do servidor" é premissa de quem lê e obrigação de quem grava.** A promoção, o preço e a purga confiavam em `created_at`. Quem garantia isso era só o fato de ninguém mandar a coluna.
- **Um achado pode estar certo sobre o código e errado sobre o sistema.** O `upsert` da biometria faz o que o painel diz, no papel. Na PROD ele não executa. O que decide é o planejador da PROD, não a leitura do arquivo.
- **Erro de escrita não conferido esconde uma funcionalidade morta.** A edge respondia `success: true` havia seis meses sem gravar nada.
- **Limpar o que veio a mais e confirmar o lote é responder "entregue" a quem mandou outra coisa.** Fechar o furo e decidir o que responder ao remetente são duas decisões. A 1ª versão acertou a primeira e errou a segunda, e o erro só apareceu porque três leituras sem combinar entre si chegaram ao mesmo ponto.
- **O comportamento ruidoso que já existe é evidência de desenho.** A v1.3 recusava o lote com campo desconhecido por acidente (coluna inexistente), e esse acidente tinha achado o campo `ativo` em campo. Antes de trocar um erro por um aviso, procurar quem já foi salvo pelo erro.
- **Duas sessões fizeram o mesmo lote sem saber uma da outra.** A conferência de colisão olhou PR aberto, branch remoto e arquivo tocado na `main`. A outra sessão ainda não tinha publicado nada. Ela avisou ao ver o PR e não abriu outro, e a comparação entre as duas rendeu a recusa do item e a forma do lote. O custo foi o trabalho dobrado.
- **Revisão sem o contexto da sessão pega o que as com contexto não pegam.** O Codex e esta sessão olharam o que o gate proíbe. Quem chegou sem história perguntou o que o gate exige, e achou que nada exigia os 5 campos na mensagem do copiloto.
- **Texto que vem de fora e vai para `jsonb` se corta por ponto de código.** `slice` conta unidades UTF-16. Um emoji na fronteira vira meio emoji, o Postgres recusa, e a falha aparece longe da causa: no fechamento do run.
- **Gravar numa tabela de erros não é avisar alguém.** Antes de escrever "fica visível", abrir quem lê a tabela. O alerta do staff filtra por tipo de run.
- **"O runner acusaria" é hipótese até alguém medir.** O teste do teto de espera dizia, num comentário, que o Deno reprovaria um timer não desarmado. Não reprova. Quem mostrou foi o mutante sobrevivente, e a conferência foi um teste de duas linhas num diretório à parte.
- **Teste do módulo puro não prova que a rota usa o módulo.** As suítes do builder e do validador ficavam verdes com `created_at` acrescentado à linha no `index.ts`. O que prova a rota é o corpo do POST, capturado com o handler executado. O harness (`_shared/harness-handler_test.ts`) já existia e a edge só importa o supabase-js, que resolve offline.
- **Validar um instante pelo parser de uma linguagem e gravar o texto original é validar uma coisa e gravar outra.** O JavaScript lia 30 de fevereiro como 2 de março; o Postgres recusava. Ou se calcula o instante dos campos do texto, ou se grava o que foi calculado.
- **Ao limitar um marco, diga o que o limite garante.** "No máximo 10 minutos à frente" é o marco. O tempo de recuperação depende de quando o remetente manda o próximo, e aqui é um dia.
- **Mutante morto por identidade de objeto não prova proteção do conteúdo.** Um `Object.is` derrubava `{ ...item }`, que grava a mesma coisa.
- **A consulta de desenho achou o que o scanner não apontou.** Pedir ao Codex "existe outro caminho da mesma classe?" rendeu o `/keys-snapshot`. A pergunta vale mesmo com o código já escrito.
- **Reapontar citação pela ocorrência mais próxima erra quando a âncora aparece em duas linhas vizinhas.** O gate passou com a citação do insert apontando para o delete. A conferência que vale é ler a linha citada.
- **Tocar um módulo que a canária exercita pede bump de contrato, mesmo sem mudar comportamento.** Exportar duas constantes de `copiloto-tools.ts` reprovou o `canaria:bump`. A lista de fases e intenções passou a sair do schema da própria tool, e o módulo ficou intacto.

## Deploy

Camada única do conserto das edges: as 3 edges. Feito em 2026-11-18 (UTC), depois do merge do #3947 (`5d6198811`).

| Passo | Evidência |
|---|---|
| Ledger antes | `bun run pendencias:deploy`: as 3 em "DEPLOY PENDENTE declarado", e só elas |
| Pacote | `bun scripts/pendencias-pacote.ts tint-sync-agent copilot-analyze generate-bundle-argument`, contra `origin/main@a0a4b1ac6`. Pré-condição de banco satisfeita |
| Envio | `send_message` às 01:48:50Z. A chamada estourou o tempo do lado do cliente; a mensagem foi localizada por `list_messages` e **não** foi reenviada. O agente conferiu 35/35 hashes em 26 arquivos e publicou as três. Custo: 3 créditos |
| Sensor | `lovable-sensor-edicao`: **`EDICAO_DETECTADA`** (exit 1). Ver abaixo |
| Sonda da `tint-sync-agent` | `db/sonda-seg-lote6-20261117.sql` pelo `db:aplicar`: ensaio, depois a tentativa #1167. Request 25125, HTTP 200, **DEPLOY CONFIRMADO**: `v1.4-catalogo-lista-fechada`, `fonte` igual à do mapa da `main` |
| Ledger depois | `pendencias:deploy`: `tint-sync-agent` em "confere", vista por sonda. `copilot-analyze` e `generate-bundle-argument` ainda pendentes às 01:57Z: as duas são do cron de sonda, e o ledger só as vê depois que ele passa |
| O sync real | Depois do deploy, 5 runs de catálogo fecharam `complete` com zero erro (o último às 01:50:29Z), e nenhuma linha de staging tem data futura. O conector de verdade passou pela lista fechada sem recusa |

**O bot empurrou `bun.lock` e `package.json` na `main` de novo.** Commit `58cd59b07` ("Deployed 3 tint-edge funcs"): as mesmas 2 `devDependencies` do lote 5, e 66 linhas de lock. As edges não foram tocadas. O agente escreveu que os dois arquivos já estavam modificados no sandbox e que não os commitaria; a plataforma empurrou assim mesmo. É a 5ª ocorrência. O revert, byte a byte contra o pai do commit, vai no PR da gamificação.

### Segundo deploy da `tint-sync-agent`: v1.5 (2026-11-18)

Depois do merge do #3951 (`4eda73ab3`), pela sessão paralela, por decisão do founder ("Fazer agora"). Camada única, sem migration e sem Publish.

| Passo | Evidência |
|---|---|
| Ledger antes | `pendencias:deploy`: só a `tint-sync-agent` pendente, `v1.4-catalogo-lista-fechada` em produção e `v1.5-registro-da-recusa-conferido` na `main` |
| Pacote | `bun scripts/pendencias-pacote.ts tint-sync-agent` → `cf12d381f240`, contra `origin/main@4eda73ab3`. Pré-condição de banco satisfeita |
| Envio | `send_message` às 02:22:39Z. O cliente estourou o tempo e a mensagem não foi reenviada: foi achada pelo `list_messages`, igual ao Passo 2 do pacote, e acompanhada pelo `get_message`. O agente conferiu 13/13 hashes e publicou. Custo: 2,9 créditos |
| Sonda | `db/sonda-seg-lote6-v15-20261118.sql` pelo `db:aplicar`: ensaio, depois a tentativa #1169. Request 25147, HTTP 200 às 02:24:56Z |
| Veredito | **DEPLOY CONFIRMADO**: `versao` `v1.5-registro-da-recusa-conferido` e `fonte` igual à do mapa da `main` (`1994b3eb…2456`) |

O agente fechou com `No files were edited.` e `git status` limpo. A plataforma pediu três vezes que ele corrigisse erros de typecheck antigos de outras edges, e ele só os listou.

## Fica para o founder

- **Colar a migration da gamificação** no SQL Editor (bloco no PR). Sem ela o furo continua aberto.
- **`copilot-analyze` e `generate-bundle-argument` no ledger:** conferir com `bun run pendencias:deploy` depois que o cron de sonda passar. Até lá, "publicado pelo Lovable" não é prova de que o bundle novo está servindo.

- **Login biométrico inoperante:** consertar o fluxo inteiro ou tirar a opção da tela de perfil.
- **Marcar como ignorado no painel**, com o OK dele: o da biometria. Os dois de prompt e o do tintométrico devem sair sozinhos no próximo deep scan; como no lote 5, isso é previsão até o scan rodar.
- **Da sessão paralela** (`origin/claude/seg-lote6-triagem-deep-scan`), entrou depois, num PR próprio: a prova PG17 dos fatos da triagem (`db/test-seg-lote6-triagem.sh`, seção "Prova") e o `logError` da `tint-sync-agent` conferindo o erro do próprio insert (`v1.5-registro-da-recusa-conferido`). O supabase-js resolve com `error` quando o banco recusa, sem lançar: o registro da recusa "respondia" sem ninguém saber se tinha gravado. Agora, registro que respondeu e não gravou avisa no console, e a recusa segue em `errors[]` como antes. A dívida do gate de escrita calada desta edge desceu de 3 para 2. Custou um segundo deploy da edge, por decisão do founder ("Fazer agora").
- **As 3 edges de IA que ainda põem texto do request no system** (`analyze-unified-order`, `analyze-services`, `identify-tool`), e a `analyze-services` aceitando qualquer JWT válido. Seção "Parentes conferidos".
- **Não usar "Try to fix" nem "Try to fix all"** ([caso](agente-lovable-conserta-o-que-nao-pediram.md)).
