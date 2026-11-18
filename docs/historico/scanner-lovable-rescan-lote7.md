# Rescan do scanner Lovable Security — lote 7 (2026-11-18)

Continuação do [lote 6](scanner-lovable-rescan-lote6.md). O deep scan de 2026-11-18 ~02:30Z deixou **1 achado ativo**: "Caller-supplied category text enters the system prompt" (Warning), na `identify-tool` (`index.ts:185`, `categoriesContext`). A seção "Parentes conferidos" do lote 6 já listava as 3 edges de IA que ainda punham texto do request ou do cadastro no system prompt. Este lote fecha as três no padrão do `copilot-analyze` (#3947): system prompt constante e dados na mensagem do usuário, delimitados e declarados como dado.

## O que entrou

| Edge | Antes | Agora | VERSAO |
|---|---|---|---|
| `identify-tool` | `categories[]` do body no system (com teto 80/200 e sem quebra de linha, do lote 1) | `SYSTEM_PROMPT_FERRAMENTA` constante; categorias no bloco `<categorias_cadastradas>` da mensagem, antes da foto (`ferramenta-prompt.ts`) | `v1.2-categorias-na-mensagem` |
| `analyze-services` | `userTools[]` do body e a lista de `omie_servicos` no system; **qualquer JWT válido** chamava | `SYSTEM_PROMPT_SERVICOS` constante; blocos `<ferramentas_do_cliente>`, `<servicos_disponiveis>` e `<pedido_do_cliente>` (`servico-prompt.ts`); **staff ou cliente aprovado**, fail-closed, antes da cota | `v1.1-aprovado-e-dados-na-mensagem` |
| `analyze-unified-order` (money-path) | system em 2 blocos: regras estáveis com cache + "DADOS DESTA CONSULTA" (catálogo, ferramentas do body, serviços, histórico de pedidos, candidatos com nome e documento) | system = só o bloco estável, com o mesmo `cache_control`; os dados são o 1º texto da mensagem, dentro de `<dados_desta_consulta>`, antes do pedido do vendedor e das fotos | `v1.11-dados-na-mensagem` |

O helper novo `_shared/bloco-de-dado.ts` (`criarBlocosDeDado`) monta os blocos e neutraliza os delimitadores. O texto de um bloco não consegue fechar o próprio bloco nem abrir outro do mesmo conjunto: `</x>` vira `</_x>`, com tolerância a maiúscula e a espaço ou quebra de linha em volta da barra. O limite é o mesmo do copiloto: entidade HTML e homóglifo passam como vieram. O `copilot-analyze` continua com a cópia local dele, porque migrar exigiria redeploy de uma edge que não muda de comportamento.

### Gate do `analyze-services`: decisão técnica, não de produto

Quem chama é só o `VoiceServiceInput` (`ServiceItemForm` → `UnifiedOrder`), nas rotas `/new-order` (aberta a cliente, sob `ProtectedRoute`, que exige `isApproved`) e `/sales/new` (`RequireStaff`). O gate novo é o mesmo da `identify-tool` desde o lote 1: `user_roles` employee/master **ou** `profiles.is_approved = true`, e erro de leitura = 403. Ele não recusa nenhum chamador que a UI deixa entrar. O cadastro em /auth é público, então "JWT válido" incluía o cliente recém-cadastrado, barrado em toda a UI, que ainda assim gastava IA paga aqui.

Ressalva do Codex, registrada e sem ação: o `AuthContext` também autoaprova quem tem `commercial_roles` e grava em `profiles` sem conferir o resultado. Um usuário assim, sem papel de staff e com `is_approved` ainda falso, passaria pelo front e seria recusado aqui. A `/new-order` está congelada (`manifesto.ts`, `GuardModuloCongelado`) e a `/sales/new` é só de staff, então hoje isso é incompatibilidade latente, sem quebra demonstrada.

### Correção de passagem na `identify-tool`

O teste do handler achou um 500 anterior a este lote: um item `null` em `categories[]` derrubava o `nomesCategorias` (`c.name` sem `?.`) **depois** de a edge pagar a chamada ao modelo. Agora o filtro aceita só nome em string não vazia.

## Os ignorados do painel (só leitura, 2026-11-18)

Conferido no painel pelo Chrome do founder. Nenhum botão de correção nem "Unignore" foi clicado.

- **"Any staff member can inject system prompt instructions"** aponta para o `generate-bundle-argument/index.ts:191-201` (`customerProfile` no system). **Não é** uma das 3 deste lote. O #3947 já pôs o perfil num enum fechado, e o achado segue ignorado.
- **"Request categories are inserted into the system prompt"** ("qualquer conta aprovada controla as categorias interpoladas no system") é a `identify-tool`, a mesma classe do achado ativo. Esta entrega também o fecha. O detalhe dele não foi aberto: a atribuição vem da descrição.

## Prova

- **Handler EXECUTADO nas 3 edges.** As edges de IA importam o SDK da Anthropic por `npm:`, que não carrega na suíte offline. Por isso o lote 6 provou o copiloto só por AST. `_shared/harness-ia_test.ts` lê o `index.ts`, troca só o import do SDK (e o do `_shared/anthropic-cliente.ts`) por um falso que captura os parâmetros de cada `messages.create`, torna absolutos os imports relativos e carrega o resultado como `data:`. Gate, cota, validação, montagem do prompt e normalização da saída são o código real. Os testes (`identify-tool/index_test.ts`, `analyze-services/index_test.ts`, `analyze-unified-order/index_test.ts`) exigem canários do body **e** das respostas falsas do banco ausentes de todo o `system` e presentes no bloco certo da mensagem. O `analyze-unified-order` cobre texto, texto + foto e só foto (este com as 2 chamadas: transcrição de system literal e análise), mais a variante sem busca de cliente.
- **Gate do `analyze-services`:** staff e cliente aprovado passam. Cliente sem aprovação, sem perfil e com perfil ilegível recebe 403, com **zero** cota, zero leitura de serviços e zero chamada ao modelo.
- **Falsificação.** `scripts/falsificar-prompt-cache.sh` ganhou alvo por sabotagem (também o `index.ts`) e 5 sabotagens novas: dado de volta ao system, dados depois do pedido, ponteiro "abaixo" na regra 28, neutralização removida, cadastro fora do bloco. São 11 sabotagens válidas, com linha de base verde na mesma invocação, em `LC_ALL=C` **e** `pt_BR.UTF-8`. Há 4 contratos novos em `scripts/mutcheck.d/` (`identify-tool-prompt`, `identify-tool-ferramenta-prompt`, `analyze-services-prompt`, `bloco-de-dado`), com **17/17 mutações pegas** nos dois locales. A primeira rodada deixou sobreviver "sem categorias o bloco vem vazio" (lista só com itens sem nome), e o teste novo que a mata foi o que achou o 500 do `null`.
- **Gates de edge:** `test:edges` (2818+ verdes), `edges:typecheck`, `edges:sintaxe`, `sonda:bump`, `sonda:fingerprint -- --write` (só as 3 edges mudaram no mapa), vitest (`edge-money-path-invariants` ganhou o wiring "o system não recebe os dados").

O que fica fora da prova: o modelo. Mover o catálogo do system para a mensagem não muda o que está disponível ao modelo, mas a **precisão** de identificação só se mede com pedidos reais. O sinal disso em prod é a taxa de itens descartados e de cache (`[analyze-unified-order] cache …` no log), comparada antes e depois do deploy.

## Achado anterior, sem ação aqui

No modo **só foto** do `analyze-unified-order`, o candidato vindo de `profiles` é montado no formato do Omie (`nome_fantasia` preenchido, `razao_social`/`cnpj_cpf` não), e o prompt recebe `RazãoSocial:undefined | CNPJ/CPF:undefined`. O documento do perfil nunca chega ao modelo nesse modo. Isso não vem deste lote, e o teste do handler registra a ausência.

## 2ª opinião (Codex)

- **Desenho** (gpt-6-astra · max · 409 s · 186.390 tokens). O padrão foi aprovado nas 3 edges e o gate não quebra chamador ativo. A sugestão adotada foi neutralizar com todos os nomes novos e manter o helper em `_shared/`. Também apontou o que cobrir nos testes (texto, texto + foto e só foto, com canários do banco) e o que adaptar (invariante "DOIS blocos" e `falsificar-prompt-cache.sh`). Ficou uma divergência consciente: o Codex sugeriu subir para o system a cauda constante do bloco de dados ("FIM DOS DADOS…", checklist, "Responda SEMPRE…"). Ela ficou na mensagem, **fora** do bloco `<dados_desta_consulta>`, logo depois dele. É texto constante, mantém a recência que o #1622 buscou, e o system declara que só o conteúdo do bloco é dado.
- **Código, adversarial** (gpt-6-astra · max · 332 s · 172.759 tokens): **nada bloqueante**. Não achou dado do request ou do cadastro no `system` das 4 chamadas, nem fuga literal dos delimitadores. Reintroduzir dados no `system`, em memória, derrubou os testes das 3 edges. Orçamento, ordem, variante e fallbacks do `analyze-unified-order` estão preservados. Manter a cauda na mensagem "não é erro". Um **P2 de cobertura**, que ele reproduziu: o `user_roles` falso do `harness-handler_test.ts` ignorava o `.in("role", …)`, e apagar o filtro do gate deixava os testes verdes. Corrigido aqui: o falso passou a respeitar o filtro, os dois gates ganharam o caso `jwt-customer` não aprovado, e a mutação "papel customer conta como staff" entrou nos dois `.mut`.

## Deploy (2026-11-18): DEPLOY CONFIRMADO nas 3 edges

Depois do merge do #3954 (`f7281b895`, 03:16Z). Camada única: sem migration e sem Publish, porque nenhum arquivo de `src/` muda comportamento.

| Passo | Evidência |
|---|---|
| Ledger antes | `pendencias:deploy` (exit 1): as 3 edges pendentes, mais nenhuma |
| Pacote | `pendencias-pacote.ts` → `28db7222bad7`, contra `origin/main@f7281b895`. Pré-condição de banco satisfeita (`ia_consumir_cota`). Nenhuma ordem entre edges foi declarada, e nenhuma é necessária: não há dependência entre as 3 |
| Envio | `send_message` às 10:38:58Z. O cliente estourou o tempo e a mensagem não foi reenviada. Ela foi achada pelo `list_messages` (uma única cópia, igual ao Passo 2) e acompanhada pelo `get_message`. O agente conferiu 38/38 hashes (27 arquivos distintos) e publicou as 3. Custo: 2,5 créditos |
| Sonda | `db/sonda-seg-lote7-20261118.sql` pelo `db:aplicar`: primeiro o ensaio, depois a tentativa #1171. Requests 25603, 25604 e 25605, todos com HTTP 200 |
| Veredito | **DEPLOY CONFIRMADO** nas 3: `v1.1-aprovado-e-dados-na-mensagem`, `v1.11-dados-na-mensagem` e `v1.2-categorias-na-mensagem`, com a `fonte` igual à do mapa da `main`. O `pendencias:deploy` de depois saiu com **0** |
| Sensor | `lovable-sensor-edicao.ts`, 6,1 min depois do envio: **EDICAO_DETECTADA**. O commit `80f72d88e` ("Published 3 functions verbatim") acrescentou as devDependencies `@lovable.dev/vite-plugin-dev-server-bridge` e `@lovable.dev/vite-plugin-hmr-gate` em `package.json`/`bun.lock`. Nenhuma edge foi tocada. Revertido neste PR |

O agente disse que as mudanças em `package.json`/`bun.lock` "já existiam antes da tarefa". O commit é dele mesmo assim: o workspace as empurrou junto com o deploy. É a mesma classe dos lotes anteriores.

## Painel depois da entrega (2026-11-18 ~10:55Z, print do founder, só leitura)

O deep scan rodou ~1 h antes do print, com o #3954 já na `main`, e o painel mostrou **"No active issues"**. O achado ativo do lote, "Caller-supplied category text enters the system prompt", **não está** entre os 12 ignorados, o que mostra que o scanner o deu por resolvido e que ninguém o ignorou. Os 12 ignorados são os mesmos de antes. Entre eles continua o "Request categories are inserted into the system prompt", que o código deste lote também fecha. Nenhum botão de correção nem "Unignore" foi clicado. Fora do escopo: "Project dependencies · 59 packages · 91 known issues".
