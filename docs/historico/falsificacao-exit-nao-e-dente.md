# Falsificação: exit≠0 não é dente — o vermelho tem de ser do assert que a sabotagem declara

**2026-09-27.** O `--falsificar` de `db/test-data-health-sync-reprocess.sh` (núcleo do CI,
`falsificar=13`) contava como "✅ vermelha como devia" QUALQUER rodada sabotada que saísse ≠0. O
`sabotar()` sai com `exit 9` quando o padrão da sabotagem não ocorre exatamente 1× no corpo — deriva
normal depois de editar a migration —, e esse exit também virava dente. O `money-path.md` já
proibia isso ("o vermelho tem de ser do SEU assert"); faltava o laço obedecer.

A varredura mostrou que não era um laço: era uma **classe com três idiomas**, e o núcleo tinha os
três. O que o runner (`db/roda-nucleo-ci.sh`) faz com eles é o que dá o peso: ele exige exit 0, um
recibo `SABOTAGENS: <v> vermelhas / <f> falhas`, `f = 0` e `v ≥ N` — e **confia** no recibo. Ele não
sabe o que é sabotagem; quem sabe é o laço que o emite.

## O defeito, medido

Numa cópia com o padrão de `message_com_data_do_relogio` derivado:

```
  ✅ message_com_data_do_relogio — vermelha como devia (1 assert(s) quebraram)
SABOTAGENS: 1 vermelhas / 0 falhas        ← exit 0
```

O "1 assert quebrou" era a própria linha `❌ SABOTAGEM NÃO APLICÁVEL`, contada pelo `grep -c '❌'`.
Nenhum assert da suíte tinha julgado nada — e o CI aprovaria.

## O conserto do alvo — cada sabotagem declara quem TEM de acusá-la

`SABOTAGENS="erro_nao_e_broken:A7,A9 desconhecido_vira_ok:A13 …"`: `,` = E (cada um tem de virar),
`|` = OU (basta um); o ID é o prefixo `A<n> ` que cada assert passou a imprimir (A1…A31). A rodada só
conta como vermelha com as **quatro camadas**:

1. a sabotagem **aplicou** (a linha `SABOTAGEM ATIVA em` está no log);
2. a suíte rodou **inteira** (PASS+FAIL do recibo = o do controle — aborto no meio não é assert);
3. **cada** assert declarado está verde no controle e vermelho aqui;
4. **nenhum `ERROR:` do psql** que o controle não tem (o controle tem zero) — a 4ª veio do Codex (abaixo):
   sabotagem que faz o SQL ERRAR esvazia a medição, e o assert declarado cai por erro, não por julgamento.

Não se exige "exatamente estes vermelhos": os colaterais oscilam (o A25 sob
`message_com_hora_de_parede` depende de a leitura cruzar a virada de um segundo). O mapa medido:

| sabotagem | declarado | vermelhos da rodada isolada |
|---|---|---|
| erro_nao_e_broken | A7,A9 | A7 A8 A9 A15 A21 A22 A24 A28 |
| desconhecido_vira_ok | A13 | A13 |
| nao_catalogada_vira_ok | A14 | A14 |
| orfa_nunca_dispara | A10 | A10 |
| stale_nunca_dispara | A12 | A12 |
| nunca_executou_vira_ok | A2 | A2 |
| retry_liquida_erro | A15 | A10 A11 A15 |
| degradado_conta_dispensada | A18 | A18 |
| message_com_idade | A23 | A23 |
| message_com_data_do_relogio | A23 | A23 |
| message_com_hora_de_parede | A23 | A23 (+A25 às vezes) |
| message_constante | A24 | A24 |
| fora_do_v_sources | A28,A30 | A26 A28 A30 (checks 22→21) |

Normal `PASS=31 FAIL=0`; `--falsificar` `SABOTAGENS: 13 vermelhas / 0 falhas`, exit 0.

### A meta-falsificação do laço — uma camada por vez, nos dois locales

Cada variante é uma CÓPIA num repo-sombra (symlinks; o worktree não é tocado), com edições exatas
(casou ≠1× = erro da meta, não veredito), `bash -n` antes de rodar (no bash 3.2, erro de sintaxe com
`trap … EXIT` sai 0 — entrada 22 de `evidencia-positiva-shell.md`) e a expectativa declarada ANTES.
**12/12 em `LC_ALL=C` e 12/12 em `pt_BR.UTF-8`:**

| variante | exit | recibo | quem acusou |
|---|---|---|---|
| controle | 0 | 1/0 | — |
| D1 padrão derivado | 1 | 0/1 | camada 1 ("vermelha SEM a sabotagem aplicada") |
| D1 sem a camada 1 | 1 | 0/1 | camada 2 |
| D1 sem as camadas 1 e 2 | 1 | 0/1 | camada 3 |
| D2 assert declarado errado (A24) | 1 | 0/1 | camada 3 |
| D2 sem a camada 3 | **0** | **1/0** | ninguém — ESCAPA |
| D3 aborto no meio da suíte | 1 | 0/1 | camada 2 |
| D3 sem a camada 2 | **0** | **1/0** | ninguém — ESCAPA |
| D4 controle sem recibo PASS/FAIL | 1 | — | "SEM um recibo PASS/FAIL legível" |
| D5 sabotagem sem ramo | 1 | 0/1 | camada 1 |
| D6 sabotagem que faz o SQL ERRAR (`THEN u.status::integer::text`) | 1 | 0/1 | camada 4 ("vermelha com ERRO de execução do SQL") |
| D6 sem a camada 4 | **0** | **1/0** | ninguém — ESCAPA, com o A13 ❌ por erro |

A camada 2 é a ÚNICA que pega o aborto; a 3, a ÚNICA que pega o assert errado; a 4, a ÚNICA que pega o erro de execução. A 1 é redundante para
DETECTAR (a 2 e a 3 pegam a deriva) — fica porque nomeia a causa, e mensagem que nomeia a causa é o que
faz alguém consertar em vez de re-rodar.

## A mesma classe no resto do núcleo — três idiomas

**`db/test-pedido-total-liquido-acervo.sh` (`falsificar=18`) — "≠ verde".** `vermelha <rótulo>
<valor> <verde>` contava qualquer desvio. Com a F11 reescrita para fazer o conversor DIVIDIR POR ZERO
em vez de pular a recusa, o `t_sqlstate` devolveu `22012` — não-vazio, ≠ `TL002` — e: `🔴 F11 …
(sabotado: [22012] ≠ verde [TL002])`, recibo **18/0, exit 0**. (A medição cujo `Pq` erra sai vazia:
o outro desvio que contava.) Conserto: `vermelha` ganhou o 4º argumento, o valor que a sabotagem
DECLARA — os 12 colhidos da rodada íntegra, deterministas por construção (F7/F8 dependem de lock, mas
sem `SKIP LOCKED` o conversor TEM de esperar, e o laço de 30 s vê o `wait_event_type = 'Lock'`).
Meta, **10/10 nos dois locales**:

| variante | exit | recibo |
|---|---|---|
| controle (as 12 declaradas batem) | 0 | 18/0 |
| F11 faz o conversor errar | 1 | 17/1 — "esperado [OK], veio [22012]" |
| F3 com a medição que erra (vazia) | 1 | 17/1 — "esperado [9.02], veio []" |
| F11 erra, SEM a igualdade com o declarado | **0** | **18/0** — a camada é a que pega |
| F11 erra, no arquivo de ANTES | **0** | **18/0** — o furo, reproduzido |

**`db/test-authz-revoke-anon-rpc.sh` (núcleo, 19 asserts; falsificação na suíte normal) —
"ABORTOU".** O `sabotar()` devolvia `ABORTOU` para qualquer exit≠0 do apply, com a saída jogada fora.
Agora `ABORTOU` só com `POSTCONDICAO FALHOU` na saída; o resto vira `ERRO ALHEIO a postcondicao: <erro>`.
Meta **6/6**: com a F1 trocada por `SELECT 1/0;`, o arquivo de antes dizia `OK F1 … (=ABORTOU)`; o de
agora, `FAIL … veio [ERRO ALHEIO a postcondicao: ERROR:  division by zero]`.

**`db/test-pedido-edicao-atomica.sh` (núcleo, 54 asserts; na suíte normal) — "rc≠0".** O DO envolve a
chamada com `EXCEPTION WHEN sqlstate '<esperada>' THEN NULL; WHEN OTHERS THEN RAISE`: rc≠0 só diz que
a SQLSTATE esperada não veio — e qualquer erro diz isso. O 1º conserto exigiu `ASSERT_NAO_LANCOU` (a
chamada completou) — e o **controle ficou vermelho**: o G3 (guard de desconto D7) é defesa em
profundidade. Sem o D7, o `discount:5` do `order_items` diverge do `desconto:0` do `items`, e a
coerência (D12) barra com "ficaria incoerente". O vermelho do G3 é legítimo — mas o juiz precisa
SABER disso, não aceitar "qualquer erro". Conserto final: cada sabotagem declara o que vem NO LUGAR da
recusa (5º argumento; default: a chamada completa); o G3 declara `ficaria incoerente`.
Meta, **10/10 nos dois locales**: controle `54 ok / 0 fail` (G1, G2 e G3 com a marca declarada);
G1 fazendo a RPC dividir por zero reprova — "não é o declarado [ASSERT_NAO_LANCOU]: ERROR:  division
by zero" —, onde o arquivo de antes dizia "a recusa SUMIU"; G3 errando reprova MESMO com a marca
declarada; e sem a declaração o G3 cai no juiz estrito (é essa camada que obriga a declarar).

**Os outros três juízes do núcleo já eram certos**, cada um no seu idioma: `canaria-veredito`
(`CERTO` só com a marca da asserção nos 2 locales; SQL inválido e morte do shell recusados; controle
NEGATIVO do próprio juiz), `db-aplicar` (`confere` com rc EXATO e todas as marcas; "o rc sozinho
aceita qualquer vermelho" é recusado por escrito) e o `vermelha_por` do pedido-total. Dois entraram
DEPOIS da varredura e foram lidos um a um: `test-transporte-nuvem` (#2601, `falsificar=10`: vermelho só
com a marca `FALHA [T<n>]` do assert, sobre um controle `0 fail` da mesma invocação) e
`test-tint-promocao-assincrona` (o #2605 o põe no núcleo com `falsificar=12`: exige o CONJUNTO EXATO de
asserts caídos — o juiz mais estrito do repo), registrado de antemão para o gate não travar aquele PR.

## A varredura (matar-classe)

**Passo 0 — instância única ou classe? Classe**: o mesmo erro de julgamento em três idiomas, só no
núcleo. Assinatura calibrada: *o veredito que conta a sabotagem como dente não identifica o assert —
"saiu ≠0", "valor ≠ verde" (aceita erro e vazio) ou "rc≠0" (aceita qualquer erro)*; casa o laço de
`0906c17c2` e não casa o de hoje. A varredura (subagente read-only, 2026-09-27) cobriu `db/`,
`scripts/` e `.claude/`:

| território | afetado | parcial (≠ verde) | já-correto | falso-positivo |
|---|---|---|---|---|
| `db/` | 7 | 28 | ~43 | 14 |
| `scripts/` | 10 | 4 | 22 | 1 |
| `.claude/` (evals) | 3 | 3 | 3 | — |

**Aviso de método:** o subagente classificou o pedido-total como "já-correto" (leu o `vermelha_por` e
não o `vermelha`); a reprodução acima o desmentiu. Veredito de varredura delegada é **hipótese** — no
núcleo, só a medição decide, e cada site das fases seguintes tem de ser reconferido antes de editado.

**Consertados aqui (todo o núcleo):** `test-data-health-sync-reprocess`, `test-pedido-total-liquido-acervo`,
`test-authz-revoke-anon-rpc`, `test-pedido-edicao-atomica`.

**Afetados fora do núcleo** (fase seguinte, com dono — ver abaixo):
`db/test-pendencias-deploy-eco-passivo.sh:185-192` (laço inteiro: `fail≠0` nos 2 locales),
`db/test-hash-omie-canonico.sh:206` (só F4), `db/test-sayerlack-custo-portal-cas.sh:283` (só F4b),
`db/test-fin-sync-watchdog-retry-sem-efeito.sh:321-323` (só F1); em `scripts/` (todos no
`test:falsificacao`): `test-orfaos-custosos`, `test-onde-parei`, `test-read-contexto-nudge`,
`test-ocupacao-por-arquivo`, `test-ocupacao-por-comando`, `test-fecho-edges-pendentes`,
`test-psql-ro-error-stop`, `test-eval-diagnostico-cegueira`, `test-codex-prompt-paginacao`,
`test-falsificar-implementado`; em `.claude/skills/lovable-deploy-verify/evals/`:
`criterio-caro-eval`, `edges-pendentes-sql-eval`, `sonda-veredito-401-eval`.

**Parciais ("≠ verde")**: `db/` — `analytics-outbox-trigger`, `analytics-outbox-perda`,
`data-health-sync-state-saude`, `data-health-estoque-fonte-dado`, `farmer-desfecho`,
`farmer-geracao-vigente`, `farmer-head-geracao`, `farmer-melhor-individual-bulk`,
`fu4f-fase3-carteira-margem-faixa`, `preco-medio-leadtime-efetivo`, `recommend-cluster-agregado`,
`oportunidade-erro-terminal`, `tactical-plan-idempotencia`, `data-health-watchdog-reemissao`,
`tint-promote`, `regua-preco-customer360`, `pedidos-programados`, `pos-frescor-marcador`,
`v-titulo-baixas-otica-canonica`, `authz-private-execute-fecho`, `cap-carteira-escrever-master-only`,
`margin-audit-log-master-pode-ler`, `remove-trigger-auto-super-admin`,
`backfill_kb_documents_product_code`, `carteira-saude-eligible-efeito`, `import-tint-formulas`,
`farmer-margem-server-side`; `scripts/` — `test-eval-via-morta`, `test-bash-contexto-nudge`,
`test-lovable-revert-scan`, `test-guard-noop-sabotagem`; evals — `verify-edge-eco-eval`,
`verify-edge-escrita-eval`, `verify-frontend-eval`.

**Já-corretos** (o veredito identifica o assert — sentinela, SQLSTATE, marca, conjunto exato de IDs ou
valor exato): em `db/` os 3 juízes do núcleo citados acima, `push-vendedora`, `auto-aprovacao-piloto`,
`tint-promocao-assincrona`, `deploy-sonda-cron`, `deploy-atestacoes`, `desconto-valor-escritores`,
`cfo-caixa-90d-otica`, `pedido-venda-coerencia`, `disparado-simulado-pos-disparo`, `fin-sync-lease`,
`calculate-scores-lease`, `carteira-rebuild-lease`, `endividamento-money-path`,
`get-ultimos-precos-cliente`, `rpc-tactical-plan-posse-segura`, `tactical-plans-eligible-fail-closed`,
`tactical-plans-rls-split`, `tactical-plan-rpc-hardening`, `vendas_sync_semear_janela`,
`atp-gate-pedido-fase2`, `assoc-rules-segmento`, `criar-pedidos-com-itens`, `aprovar-pedido-guard`,
`remover-itens-pedido-guard`, `authz-custo-fu4f-fase3-recommend`, `…-ranking`,
`authz-preco-omie-products`, `em-transito-erro-terminal`, `qtde-multiplo-embalagem`,
`teto-cobertura-motor`, `ia-uso-cota`, `tint-get-price`, `tint-get-prices`,
`omie-identidade-a2-client-to-user`, `po-inexistente-antes-de`, `pos-candidatos-guard-temporal`,
`sku-fornecedor-externo-fator-positivo`, `reposicao-selo-aprovacao`, `tint-fase5-watchdog`,
`tint-watchdog-corante`, `data-health-custos-proveniencia`, `data-health-pedidos-compra`,
`farmer-association-rules-atomica`, `tick-auto-aprovacao-corrida`, `comment-honesto-margem-faixa`,
`farmer-escopo-carteira`, `tint-promote-tombstone-fase5`, `param-auto`, `authz-funcoes-falsificacao`,
`authz-reescrita-falsificacao`, `falsifica-nucleo-ci`, `falsifica-atp-fase3`,
`falsificar-gate-corpo`; em `scripts/` — `test-setup-contrato`, `test-codex-async`, `test-pr-watch`,
`test-claude-mem-saude`, `test-vigia-gstack`, `test-gate-senha-bootstrap`, `test-gates-frescura`,
`test-medir-footprint`, `lab-claude-mem-reanimar/falsifica`, `lab-retry-pgdg/falsifica`,
`falsificar-baixa-nao-ingerida`, `falsificar-individuais`, `falsificar-ordem-entre-edges`,
`falsificar-…-declaracao`, `falsificar-prompt-cache`, `sonda-cron-prova.ts`,
`test-pipestatus-guard-sinal`, `test-pipestatus-zsh-guard`, `test-pr-duplicata-guard`,
`test-shellcheck-gate`, `test-sonda-processo-guard`; evals — `monitor-deploy-eval`,
`monitor-deploy-pr-eval`, `run.sh`.

**Falsos-positivos da assinatura**: `db/test-crm-carteira` (`SABOTAR=` manual, sem laço),
`db/test-reposicao-publicar-run-completo` (o trigger ZZ999 é fixture), `db/roda-nucleo-ci.sh` (só lê
o recibo), `db/lib/gerar-canaria-fixture.ts` (comentário), os `must_fail()`/`naotem()` de 10 provas
(asserts negativos comuns), `scripts/test-posthog-query` (fixture do detector). ~225 `db/test-*.sh`
não têm marcador nenhum de sabotagem além do cabeçalho do template — descartados por AUSÊNCIA de
marcador, não lidos linha a linha: um laço com vocabulário totalmente outro escaparia.

## O gate — `scripts/falsificar-exige-assert-gate.ts`

Teste que lê fonte (vitest, `falsificar-exige-assert-gate.test.ts`), sobre o stripper COMPARTILHADO:

- **R1** — toda lista `SABOTAGENS=` declara, em CADA entrada, `nome:VERMELHOS[:VERDES]` (IDs
  alfanuméricos por `,`/`|`; `ID!MARCA` para o erro de execução DECLARADO). Entrada nua é o defeito;
  curinga (`a:.*`) é o defeito disfarçado; lista vazia não prova nada.
- **R2** — o laço `for X in $SABOTAGENS` extrai `${X#*:}` e ela chega a um `grep` DENTRO do corpo do
  laço (até o `done` de mesma indentação), seguindo a cadeia de derivação até o ponto fixo
  (`resto` → `verm` → `for x` → `id`); continuação `\` é um comando só. Declarar e descartar é a
  entrada nua com outra cara.
- **R3** — cada `falsificar=<n>` do `db/nucleo-ci.txt` usa esse idioma LIMPO (R1/R2 sem violação no
  arquivo) ou tem um JUIZ registrado: o motivo + as âncoras de código, na verificação E no ramo que
  rejeita. Os dois juízes da suíte normal consertados aqui também estão registrados.

**O idioma nasceu em paralelo.** No mesmo dia, o #2606 (positivação) escreveu o próprio laço na mesma
ideia — e MAIS estrito: `nome:VERMELHOS:VERDES` (o que tem de continuar verde), `ID!MARCA` e um veto a
qualquer `ERRO_DE_EXECUCAO` não declarado. A 1ª versão deste gate daria DOIS falsos-positivos nele (a
gramática só aceitava um `:`; a cadeia até o grep tem três elos). Recalibrado contra o arquivo REAL do
PR (`git show pr/2606:…`): 1 lista, 14 entradas, 0 violações, e o estado pós-#2606 dá 0 sem registro
nenhum — com UMA entrada nua reintroduzida, R1+R3. **Confirmado no merge real:** o #2605 e o #2606
entraram na main durante este PR, e pós-rebase o gate leu 462 arquivos, 4 listas (38 entradas), 4 laços
e 7 linhas `falsificar=<n>` do núcleo — todas julgadas (o tint pelo juiz pré-registrado, a positivação
pelo idioma limpo): 0. E o merge real pegou um defeito que a simulação não pegaria: o teste do corpo
REAL ainda exigia JUIZ para toda linha do núcleo (o desenho de antes do "idioma OU juiz") e só reprovou
quando a positivação entrou de verdade — rodar o teste sobre o corpo real depois de cada rebase não é
redundante com a simulação.

O laço de antes (`0906c17c2`) fica vermelho com 13 R1 + 1 R2; o repo de hoje passa com exatamente o
denominador medido (457 arquivos, 3 listas, 24 entradas, 3 laços, 5 linhas do núcleo). A 5ª linha
foi o controle positivo do R3 em caso REAL: o `test-transporte-nuvem` entrou no núcleo depois da
varredura, e a 1ª rodada pós-rebase o acusou ("falsificar=<n> sem JUIZ registrado") até o juiz dele
ser lido e registrado. Simulado o manifesto do #2605: com o pré-registro do tint, 0; sem, R3. As mutações
que provam o dente de cada camada: `scripts/mutcheck.d/falsificar-exige-assert.mut`.
Medido: **39 testes; 38/38 PEGA**, 0 sobreviventes, 0 inválidas, controle+ ✓.

**O que o texto não alcança, de propósito:** fora do núcleo, cada laço tem o seu idioma (sentinela,
SQLSTATE, conjunto de IDs, valor exato) — uma regra textual única reprovaria em massa ou aprenderia um
idioma por arquivo. E âncora não prova semântica: só torna vermelha a REMOÇÃO da linha que sustenta o
juiz. Quem prova o juiz é a meta-falsificação acima.

## A 2ª opinião (Codex, 2026-09-27)

Ritual `/codex` em modo challenge (`scripts/codex-async.sh`, `gpt-6-astra`, reasoning max, 339 s),
sobre o diff inteiro, com cinco perguntas. O parecer, resumido **nas palavras dele** — e a calibração,
separada:

| achado do Codex | sev. | calibração | o que foi feito |
|---|---|---|---|
| sync: sabotagem que faz o SQL errar esvazia a medição, e o A13 cai por ERRO — o laço contaria | alta | procede: é o "≠ verde" do pedido-total dentro do alvo | camada 4 (acima) |
| marca num `NOTICE` antes de OUTRO erro passa no authz, na edição e no `postcondicao_de` | média | procede: a marca estava solta no texto | a marca vale NA linha do `ERROR:` (a única, sob `ON_ERROR_STOP`) |
| F9 aceita qualquer `23514` — inclusive o CHECK de valores do registro | média | procede | `t_sqlstate_c` devolve `SQLSTATE:constraint`; o F9 declara `23514:pedido_venda_coerencia` |
| F7/F8 deterministas só enquanto a barreira de X vive (~30 s) | média | procede, e só gera vermelho FALSO — nunca aprova | registrado como risco residual; não mexido |
| G3 aceitar "ficaria incoerente" | — | legítimo, concorda | — |
| gate: âncora só na verificação, não no ramo que rejeita; R2 aceita grep fora do laço; `\` de continuação dá falso-positivo | média | procede | âncoras também nos ramos de rejeição; R2 limitado ao corpo do laço; continuação juntada |
| sync: `grep | head -3` no diagnóstico dá SIGPIPE (141) com log grande | baixa | procede: aborta sem recibo (seguro, mas cego) | `grep -m3` com `|| true` |

O que ele confirmou NÃO abrir passagem: o espaço depois do ID impede `A2`/`A23`; o `case` com saída
multilinha; a falta do 4º argumento do `vermelha` aborta sob `set -u` (inclusive com `trap` no bash 3.2).

Cada conserto tem meta-falsificação nos dois locales, com o buraco REPRODUZIDO antes:

- **alvo — 12/12 × 2.** D6: a sabotagem de `desconhecido_vira_ok` trocada por `THEN u.status::integer::text`
  (compila, erra em runtime) reprova na camada 4; com ela desligada, passa `1/0` com o A13 ❌ por erro —
  o cenário do Codex, medido.
- **authz — 10/10.** F1 trocada por um `RAISE NOTICE` com "POSTCONDICAO FALHOU" seguido de `SELECT 1/0`:
  agora `ERRO ALHEIO … division by zero`; na versão intermediária (`0f3b22776`), `OK … (=ABORTOU)`.
- **pedido-edicao — 14/14.** O mesmo na G1 (`RAISE NOTICE $n$ASSERT_NAO_LANCOU$n$` antes de `1/0`):
  agora "não é o declarado [ASSERT_NAO_LANCOU]: division by zero"; na intermediária, "a recusa SUMIU".
- **pedido-total — 20/20 (14 + as 6 da F9 refeita).** F13 com a marca da postcondição num NOTICE antes de `1/0`: agora
  `esperado o ramo [postcondicao], veio [outro_erro]` (17/1); na intermediária, 18/0. F9 com o registro
  gravando `total_depois = total_antes` — o CHECK de valores dispara `23514` ANTES do gatilho deferido da
  coerência: agora `veio [23514:pedido_total_liquido_conversoes_valores]` (17/1); antes, 18/0. A 1ª
  tentativa injetou o erro DENTRO do `EXCEPTION WHEN check_violation` do laço, que o engoliu (`OK` nas
  duas versões): erro da META, não veredito — refeita no registro, fora do tratador.

## A fase `scripts/` — os sites do `test:falsificacao` e vizinhos (2026-09-27, 2ª leva)

**Passo 0 — instância única ou classe? Classe** — a mesma da 1ª leva, agora onde o CI roda o
`test:falsificacao` (job `validate`): um vermelho de erro alheio lá também aprova. A assinatura
calibrada da 1ª leva (casa o laço de `0906c17c2`, não o de hoje) guiou a leitura site a site.

### Reconfirmação, lendo o código

Os 14 vereditos da varredura delegada eram hipótese; lidos um a um, **os 14 se confirmaram** —
nenhum entrou como limpo — e três estavam piores do que a varredura disse (o 2º bloco do
`bash-contexto-nudge`, que também julgava por `bash "$0"` ≠0; o `eval-diagnostico`, que rodava os
asserts no MESMO processo; e o `fecho-edges`, vazio por poluição — abaixo). O `eval-via-morta` saiu
desta fase por acordo com a sessão dos evals do deploy-verify: o PR dela muda o próprio eval (sem
`via_viva` ele passa a RECUSAR, exit 1, e não mais aprovar), e o juiz tem de mudar junto com o alvo.

| site | o juiz de antes | o conserto |
|---|---|---|
| `test-onde-parei` | `SONDA_OVERRIDE=$copia bash "$0" >/dev/null`: exit≠0 = vermelho | `SABOTAGENS` (P1…P10c) |
| `test-orfaos-custosos` | idem, nos 2 locales | `SABOTAGENS` (O1…O52, CA1…6, CQ1…6) |
| `test-read-contexto-nudge` | idem | `SABOTAGENS` (R1…R16, Sgnu1…3, Sbsd1…3) |
| `test-ocupacao-por-arquivo` | idem | `SABOTAGENS` (A1…A10; o A9 partido em A9/A9b) |
| `test-ocupacao-por-comando` | idem, e **sem `bash -n`** | `SABOTAGENS` (K1…K14) + `bash -n` + fumaça |
| `test-fecho-edges-pendentes` | `fail≠0` da suíte, sem `bash -n` — **e vazio por poluição** | `SABOTAGENS` (E1…E16p, `E16d_<avaria>`) + `bash -n` + rodada isolada |
| `test-psql-ro-error-stop` | QUALQUER fixture com rc≠esperado no 1º locale que quebrasse | `SABOTAGENS` (`V?`/`L?`/`REPO`) + o par (rc, marca) |
| `test-eval-diagnostico-cegueira` | `rodar_asserts ≠0` — inclusive o **2** de um bloco que nem carregou; troca de TODAS as ocorrências; asserts no mesmo processo | `SABOTAGENS` (D1…D10) + troca 1× + `bash -n` + subshell |
| `test-falsificar-implementado` | cada cenário: exit≠0 | `SABOTAGENS` (EIXO1/EIXO2/LISTA) + exit exato 1 |
| `test-bash-contexto-nudge` | limiar: QUALQUER stdout; 2º bloco (corte): `bash "$0"` ≠0 sem `bash -n` | limiar: marca exata (o nudge no `additionalContext`); corte: `SABOTAGENS` (N1…N14) |
| `test-codex-prompt-paginacao` | `$falhas > 0` | valor exato: G1/G2 com o SHA do CITADOR, G3/G4 verdes, `bash -n` + `unset -f` |
| `test-lovable-revert-scan` | saída vazia = "alarme sumiu" (crash também é vazio) | rc 0 + stdout mudo + stderr sem erro + `bash -n` |
| `test-guard-noop-sabotagem` | `verificar_guard ≠0` (três motivos) | o motivo declarado: "alvo sumiu" com o alvo PRESENTE |
| `test-eval-via-morta` | S1: tudo menos `2+MARCA` | → fase dos evals (S1 declara o desfecho do eval novo) |

### O idioma, e as quatro camadas

Nos 10 sites com lista de sabotagens, `sabota "desc" 'sed'` (julgando pelo exit) virou
`SABOTAGENS="nome:IDs"` + uma TABELA `registra <nome> …` — nome da lista sem registro e registro
fora da lista reprovam (o primeiro não sabotaria nada; o segundo nunca rodaria) — e o laço exige as
quatro camadas do sync-reprocess: **(1)** aplicou e não quebrou a sintaxe; **(2)** a suíte rodou
INTEIRA (nº de asserts = o do controle; no `fecho`, o CONJUNTO de IDs, porque 5f/14c/16d imprimem um
`bad` por item); **(3)** cada ID declarado verde no controle e vermelho aqui; **(4)** nenhuma
assinatura de erro de execução a mais que o controle — com `ERROS_DO_ALVO` (default `/dev/null`: a
suíte normal não muda) recolhendo o stderr que a suíte jogava fora. Todos caem sob R1/R2 do gate.
Os de sabotagem única ou veredito de valor usam valor/marca exata.

### O que a medição trouxe

- **O `--falsificar` do `fecho-edges` era VAZIO — poluição de estado entre rodadas.** O repo do
  `--desde` era um por LOCALE, criado uma vez e MUTILADO pelo 13c (remove o mapa e commita), e o
  `base_sha` morava num arquivo comum aos dois locales. A suíte normal passa uma vez por locale e não
  sente; o `--falsificar` a chama ~94 vezes no mesmo `$tmp`, e da 3ª rodada em diante o `--desde`
  caía em TODA rodada — o juiz antigo aprovava as 46 pela poluição. Medido: com o estado vazando,
  `presenca_wrapper_basta` derrubava E6c + E13, E13b, E14b, E14b2, E14d (conjuntos diferentes em C e
  pt_BR); isolada (`mktemp -d` por chamada de `suite()`), só o E6c.
- **Isolada, a rodada mostrou 7 sabotagens do `fecho` sem dente** que o juiz antigo "aprovava":
  as 2 do SQL da 2ª classe (o E12b casava `->> 'probe'` e `'sem-campo-fonte'` SOLTOS, que existem
  também na 3ª classe — apertado ao que o comentário dele promete, passou a pegar as duas); e 5 que
  ficaram VERDES: l4 (o CLI usa o mesmo wrapper do banco — cai junto), l5 e l6 (cada uma redundante
  com outra trava: o pulo da janela × o `-z "$servido"`; o `-n "$esperado"` × a dupla chave), a
  mecânica na classificação e a via (c) na falha do auxiliar (nenhum cenário faz o auxiliar falhar).
  Duas tinham `sed` CONFLADO — tiravam duas travas, e o vermelho era o da sabotagem vizinha. As 5
  saem da lista com o `sed` preservado em comentário; o PAR da janela viva (l5 + `-z "$servido"`)
  entra como uma sabotagem só, e derruba o E16f. De 46 para 42, todas medidas no assert que declaram.
- **O ID tem de identificar UM assert.** O A9 do `ocupacao-por-arquivo` tinha dois ramos de falha
  ("abortou a varredura" × "passou CALADO") sob o mesmo ID, e duas sabotagens o declaravam mirando
  ramos diferentes — cada uma aceitaria o vermelho da outra. Partido (A9/A9b), a medição mostrou que
  "jq volta a rodar solto sob `set -e`" (`if ! jq` → `if jq`) nunca soltou o jq do `set -e`: só
  invertia a contagem — derrubava o A9b, o sintoma da vizinha. Agora troca a contagem por `exit 5`, o
  aborto do incidente. O 16d do `fecho` (7 avarias num ID só) ganhou um ID por avaria pelo mesmo motivo.
- **O 2º locale pegou um defeito do próprio juiz novo** — a meta-falsificação existe para isso. Com o
  shell de fora em pt_BR.UTF-8, o controle do `read-contexto` reprovava ("16 de 25 asserts"): a rodada
  interna em `LC_ALL=C` corta `${out:0:70}` por BYTE, parte um caractere multibyte no log, e o `sed`
  do BSD, lendo em UTF-8, para com "illegal byte sequence" (o `grep -c` nem responde). Medido nos dois
  lados (3 linhas em C, 2 em pt_BR). Todo grep/sed/awk do JUIZ passou a rodar em `LC_ALL=C`; o locale
  das rodadas internas não muda — é ele que a meta exercita.
- **Hipóteses que a medição corrigiu** (as declarações nasceram dos comentários de cada sabotagem):
  `orfaos` sem o eixo pcpu derruba só o O4 (o warsaw segue barrado pelo cputime); `por-comando`
  "prefixo" derruba o K1 (a tese), não o K1b; `psql-ro` `forma_c` derruba a limpo-**j** (`-c` vence
  stdin e opaco), e as duas do STRIPPER só são pegas pelo corpo do repo (`REPO` → `2 INDETERMINADO`);
  `fecho`: presença do wrapper → E6c, exit anômalo do ledger → E16k. Declarar o que caiu SEM ler o
  porquê canonizaria o furo; cada correção foi lida contra o alvo.
- **`eval-diagnostico` rodava os asserts no MESMO processo** (`rodar_asserts "$mut"`, bloco carregado
  com `.`): um `exit` sabotado no bloco sairia do próprio teste. **`codex-prompt-paginacao` sem
  `unset -f`**: uma sabotagem que não definisse `sha_de` deixaria valendo a função REAL do controle.
- **Quase reintroduzi o furo no `bash-contexto-nudge`**: com a sabotagem do limiar no laço, o juiz
  seria o N4 ("abaixo do limiar → silêncio"), que aceita QUALQUER saída — o defeito que o site tinha.
  O limiar voltou ao bloco próprio com o valor exato.

### A meta-falsificação

<!-- TABELA -->

## Lições

- **Exit≠0 não é dente, e "≠ verde" também não.** O vermelho que conta é o do assert que a sabotagem
  declara: nome do assert no log, valor exato, marca do ramo. Qualquer idioma que aceite "algo deu
  errado" aprova sabotagem que não aplicou, aborto e erro alheio — e o runner, que só lê recibo, junto.
- **Juiz estrito descobre defesa em profundidade.** O G3 só passou a ser julgado de verdade quando o
  juiz exigiu a marca: a recusa do D7 some e a D12 barra. Declarar o que vem NO LUGAR é o que separa
  a segunda camada de um erro qualquer.
- **Varredura delegada é hipótese.** Um "já-correto" do subagente caiu na primeira medição.
- **Erro de execução é o vermelho mais barato de confundir com dente.** Sabotagem que só QUEBRA a
  consulta derruba o assert que a mede — com o nome certo no log. Quem julga precisa ver o `ERROR:` e
  recusá-lo (a camada 4; o `ERRO_DE_EXECUCAO` do #2606), ou declarar o valor exato que só o
  julgamento produz.
- **Gate que nasce com um idioma só reprova o idioma melhor.** O #2606 chegou ao mesmo lugar por outro
  caminho, no mesmo dia; o gate tem de aceitar o mais estrito, não só o que o inspirou.
- **Um laço que reroda a suíte N vezes no MESMO `$tmp` herda o estado das rodadas anteriores** (2ª
  leva). A suíte normal passa uma vez e não sente; a falsificação passa ~94 — e o que a rodada 3
  herda da 1 pinta tudo de vermelho de graça. Cada rodada, o seu diretório. Irmã do "o ISOLAMENTO
  mente" do money-path, na dimensão do laço de falsificação.
- **O ID tem de identificar UM assert.** Dois ramos de falha com semânticas diferentes sob o mesmo ID
  reabrem a classe por dentro — cada sabotagem aceita o vermelho da outra. Partir o ID foi o que
  mostrou que uma sabotagem nunca tinha testado o que o nome dela dizia.
- **O juiz também tem locale.** A rodada interna em `LC_ALL=C` corta strings por byte; o juiz que lê o
  log em UTF-8 engasga no caractere partido. Quem LÊ log de outro processo lê em `LC_ALL=C`.

## O que ficou de fora, com dono

As fases seguintes da erradicação (fora do núcleo, onde nenhum recibo é confiado às cegas) viraram
tarefas com a assinatura calibrada e a lista de sites no briefing:

- **"Erradicar falsificação sem assert em db/ fora do núcleo"** — os 4 afetados de `db/`.
- **"Declarar valor sabotado nas provas db/ com juiz ≠ verde"** — os 27 parciais de `db/`, no padrão do
  `vermelha` com 4º argumento do pedido-total (em fases por domínio).
- ~~**"Erradicar falsificação sem assert no test:falsificacao"**~~ — **feita na 2ª leva** (seção
  acima): os 14 de `scripts/` reconfirmados e consertados — 13 aqui, e o `eval-via-morta` pela fase
  dos evals do deploy-verify (o PR dela muda o eval e o juiz juntos).
- **"Erradicar falsificação sem assert nos evals do deploy-verify"** — os 3 afetados e 3 parciais de
  `.claude/skills/lovable-deploy-verify/evals/`, e o `scripts/test-eval-via-morta.sh` (acordado entre
  as sessões em 2026-09-27).

Da 2ª leva ficaram, com dono:

- **"Isolar as camadas sem dente do fecho-edges"** — as 5 que saíram da lista do `fecho` por ficarem
  VERDES isoladas (o `sed` de cada uma está comentado no próprio teste): cenário com banco quebrado e
  CLI são (l4); auxiliar do grafo de imports que FALHA (a via (c)); e a decisão de produto sobre as
  travas redundantes (l5/l6, a mecânica na classificação) — manter como defesa em profundidade sem
  prova própria, ou provar cada uma com um cenário que neutralize a outra.
- **"Gate R4: todo slug do test:falsificacao usa o idioma limpo ou tem juiz registrado"** — o análogo
  do R3 para o `test:falsificacao`: hoje R1/R2 só enxergam quem USA a lista; um teste novo com juiz
  "exit≠0" entraria no CI sem nenhum gate acusar. Os de valor/marca exata (codex-prompt, guard-noop,
  lovable-revert-scan, o limiar do bash-contexto-nudge) e os já-corretos da varredura entram como juiz
  registrado, com âncoras.
