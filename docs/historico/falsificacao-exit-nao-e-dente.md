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
`tint-promocao-assincrona`, `deploy-sonda-cron`, `deploy-atestacoes` (era afetado — ver "Afetados de `db/` fora do núcleo"), `desconto-valor-escritores`,
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
`monitor-deploy-pr-eval`, `run.sh` (reconferidos na fase dos evals: só o `monitor-deploy-eval` era — os outros
dois caíram na medição, abaixo).

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
| sync: `grep \| head -3` no diagnóstico dá SIGPIPE (141) com log grande | baixa | procede: aborta sem recibo (seguro, mas cego) | `grep -m3` com `\|\| true` |

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
| `test-lovable-revert-scan` | saída vazia = "alarme sumiu" (crash também é vazio) | rc 0 + stdout mudo + stderr VAZIO como o do controle + `bash -n` + `sed` com status e cópia não-vazia |
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
  entra como uma sabotagem só, e derruba o E16f. De 46 para 42, todas medidas no assert que declaram — e 46 de novo com as 4 do guard de HORA que o #2625 mergeou no meio da fase, com um juiz intermediário próprio (IDs `H1…H4` num 3º argumento do `sabota`, e as sem IDs "no veredito antigo"): na integração, as 4 viraram entradas da lista com os IDs que ele declarou.
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

Cada site pelo harness da sessão (fora do repo): o arquivo NOVO e o de ANTES (`bee8feb69`, a main em
que a fase nasceu), com as mesmas edições exatas (casar ≠1× é erro da META), `bash -n` antes, nos
dois locales do shell de fora (`LC_ALL=C` e `pt_BR.UTF-8`), e a expectativa (rc + marca) declarada
ANTES de rodar. Os sites lentos rodam RECORTADOS à sabotagem-alvo (as outras chamadas viram `:`, a
lista fica só com a entrada dela) — com um controle do recorte, para o recorte não fabricar o verde.
O `psql-ro` sabota o fonte in-place: rodou com tudo commitado e nada mais lendo aqueles fontes. Os
consertos do Codex com reprodução barata têm variante própria contra o commit pré-Codex (`0cae061e4`).
Cada célula: C · pt_BR, ✅ = o desfecho declarado.

| site | a reprodução (o buraco) | controle | novo reprova | antes aprovava |
|---|---|---|---|---|
| `onde-parei` | a sabotagem passa a derrubar OUTRO assert | ✅✅ | ✅✅ | ✅✅ |
|  | variável inexistente no ramo — crash, não julgamento |  | ✅✅ | ✅✅ |
| `orfaos-custosos` | "sem o eixo pcpu" derrubando o corte do `cmd` (assert alheio) | ✅✅ (recorte ✅✅) | ✅✅ | ✅✅ |
| `read-contexto-nudge` | "mtime fora da chave" mexendo em `inicio\|limite` (assert alheio) | ✅✅ (recorte ✅✅) | ✅✅ | ✅✅ |
| `ocupacao-por-arquivo` | "dedupe desligado" mexendo no `sub()` do padrão (assert alheio) | ✅✅ (recorte ✅✅) | ✅✅ | ✅✅ |
|  | Codex: `descarte_calado` com o ABORTO do jq — a pré-condição A9 cai junto |  | ✅✅ | ✅✅ (pré-Codex) |
| `ocupacao-por-comando` | `VER_SHELL=(` — sintaxe quebrada (não havia `bash -n`) | ✅✅ (recorte ✅✅) | ✅✅ | ✅✅ |
| `fecho-edges-pendentes` | sabotagem INERTE (só um comentário) — o juiz antigo via a poluição | ✅✅ (recorte ✅✅) | ✅✅ | ✅✅ |
|  | `;fi` solto — sintaxe quebrada |  | ✅✅ | ✅✅ |
| `psql-ro-error-stop` | TS que não compila — o bun morre | ✅✅ | ✅✅ | ✅✅ |
|  | Codex: `ReferenceError` na linha que cita o texto da VIOLA |  | ✅✅ | ✅✅ (pré-Codex) |
| `eval-diagnostico-cegueira` | bloco que nem carrega (aspas partidas) | ✅✅ | ✅✅ | ✅✅ |
| `codex-prompt-paginacao` | git numa ref inexistente — vazio no lugar do SHA | ✅✅ | ✅✅ | ✅✅ |
| `falsificar-implementado` | o cenário do EIXO 1 acusado pelo EIXO 2 | ✅✅ | ✅✅ | ✅✅ |
| `bash-contexto-nudge` | limiar: lixo no stdout e exit ≠0 | ✅✅ | ✅✅ | ✅✅ |
|  | corte: a sabotagem derruba outro assert |  | ✅✅ | ✅✅ |
| `lovable-revert-scan` | o scan MORRE (flag inexistente) e sai mudo | ✅✅ | ✅✅ | ✅✅ · ✅✅ (pós-Codex) |
|  | Codex: `sed` que apaga tudo — cópia vazia |  | ✅✅ | ✅✅ (pré-Codex) |
| `guard-noop-sabotagem` | probe que nem parseia | ✅✅ | ✅✅ | ✅✅ |

**114/114 rodadas conferem** com o desfecho declarado.

**A meta pegou o juiz novo duas vezes.** A primeira no 2º locale (o `read-contexto`, acima). A
segunda na rodada final: o `lovable-revert-scan` pós-Codex APROVOU o crash da reprodução D1 — o
`git diff` com flag inexistente sai 129 só com `usage: …` no stderr, fora da lista-negra de
assinaturas (`fatal:|error:|…`), e o rc morre no pipeline do scan (termina no `sort`). "Julgou nada"
passou a ser stderr VAZIO, com o controle da mesma invocação medindo a linha de base (vazio também);
a coluna "pós-Codex" é esse crash aprovado. **Um erro da META, registrado:** a marca declarada para o
controle do `por-comando` era a do `onde-parei` — 4 DIVERGE com o veredito certo (rc 0, as 11
sabotagens no assert declarado); corrigida para o par de marcas do próprio site (a linha do controle
da falsificação E o `TODOS OS CASOS OK` final) e re-rodada.

### A 2ª opinião (Codex) da 2ª leva

Ritual `/codex` em modo challenge (`scripts/codex-async.sh`, `gpt-6-astra`, reasoning max, 739 s)
sobre o diff dos 13 juízes, com oito perguntas (âncora × dump, contagem × aborto, camada 4, a tabela
`registra`, o `classifica` do psql-ro, os quatro sites de valor exato, a rodada do `fecho`, e a ordem
de conserto). Só leitura — ele reproduziu os predicados em memória, no bash 3.2 e no bun. Calibração
separada:

| achado do Codex | sev. | calibração | o que foi feito | prova |
|---|---|---|---|---|
| a âncora casa LINHA física, não assert: valor cru com `\n` na mensagem fabrica `✗ D2` (eval-diagnostico) e `FALHA E16i` (fecho), e infla a contagem (o N7 do bash-nudge ecoa a saída) | P1 | procede | 1 assert = 1 linha: todo helper de assert achata a quebra (`${1//$'\n'/ \| }`) | suítes e `--falsificar` verdes |
| o A9b também exige `rc=0`: o `descarte_calado` com `exit 5` derruba A9 e A9b, e o juiz aceitava | P2 | procede | `:VERDES` implementado — `descarte_calado:A9b:A9` exige o A9 VERDE na rodada sabotada | meta `D2-precondicao-caida` |
| `\|` na declaração deixa os dois greps casarem membros DIFERENTES; nome repetido no `registra` sobrescreve, e na lista roda duas vezes | P2 | procede, latente (nenhuma lista usava) | a lista rejeita `\|` e nome repetido; `registra` repetido aborta (exit 2) | suítes verdes |
| o crash que a camada 4 não vê: dump do `fecho` truncado (o crash fica depois do corte); K13 do por-comando com stderr em `/dev/null`; read/bash-nudge liam só o `.stderr` (`exec 2>&1` escapa) | P1 | procede | o `bad()` do `fecho` grava o `out` inteiro em `ERROS_DO_ALVO`; o K13 recolhe o stderr; a camada 4 lê log + stderr | suítes e `--falsificar` verdes |
| psql-ro: o bun que MORRE cita a linha-fonte — um `ReferenceError` na linha que tem o texto da VIOLA vira `1 VIOLA` | P1 | procede; medido: o bun mostra as 5 linhas acima + a do erro, rc 1 | o `classifica` casa a marca ANCORADA na linha que o gate imprime, por here-string (o `grep -q` em pipe sob `pipefail` mata o `printf`: 141) | meta `D2-crash-cita-marca` |
| codex-prompt: o SHA DENTRO da mensagem passava (`lixo' veio '<sha>`) | P1 | procede | igualdade direta do valor capturado | suíte e `--falsificar` verdes |
| guard-noop: probe com erro de sintaxe numa linha que contém a marca — o bash CITA a linha | P1 | procede | `bash -n` antes; a marca vale como a LINHA exata (`grep -qxF`) | meta `D1-sintaxe` (barrada no `bash -n`) |
| lovable: `sed` inválido → cópia vazia → "alarme sumiu"; o filtro não tinha `bad substitution` | P1 | procede | status do `sed` + cópia não-vazia; `bad substitution` no filtro | meta `D2-copia-vazia` |
| limiar do bash-nudge: rc ignorado e stderr descartado — JSON + `exit 9` e JSON + lixo passavam | P1 | procede | exit 0 + exatamente 1 objeto JSON (`jq -se 'length == 1'`) + o nudge no `additionalContext` | meta `D1-limiar-lixo` |
| `fecho`: o CONJUNTO de IDs perde multiplicidade (aborto parcial de sublaço); falta recibo de término | P1/P2 | procede em parte: a injeção de IDs fechou com o achatamento, e o alvo roda em `$(…)` — não controla o fluxo da suíte; o aborto parcial exigiria a PRÓPRIA suíte morrer no meio de um laço e seguir | → pendência com dono (abaixo) | — |
| a rodada do `fecho` não isola todo o filesystem (fixtures de CLI e SQL) — sem contaminação atual | P2 | procede, preventivo | → pendência com dono (abaixo) | — |
| imprimir `command not found` fabrica um crash e REJEITA sabotagem legítima | — | procede, e só gera vermelho FALSO — nunca aprova | não mexido | — |
| a camada 4 compara CONTAGEM: trocar um diagnóstico legítimo do controle por um erro real mantém `1 = 1` | baixa | procede em tese; exige uma sabotagem que apague a linha legítima E crie o crash | → pendência com dono (abaixo) | — |

O que ele confirmou NÃO abrir passagem: `${!v-}` não resolve por prefixo; `[[:space:]]"$r:"` separa
`x:` de `x_long:`; `printf -v … '%s'` preserva `%` literal; o `2>>` não vaza entre rodadas (os
`.stderr` são zerados antes); os estados que o `fecho` muta (`cli_corrida`, `cli_sujo`, o stub do psql,
`sql.txt`, `pares-shared`) são restaurados antes do consumo; A4/K11 misturam ramos, mas nenhuma
sabotagem os declara.

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
- **"Sem assinatura de erro" é lista-negra, e lista-negra é incompleta por natureza.** O `git` com
  flag inexistente sai 129 só com `usage: …` — nenhum `error:` —, e o pipeline do alvo engole o rc.
  "Julgou nada" se prova pela LINHA DE BASE: stderr igual ao do controle da mesma invocação (ali,
  vazio). Até o juiz que acabara de passar pelo Codex aprovava esse crash — foi a meta que o pegou.

## Parciais de `db/`, fase 1 — sensores (analytics + data-health), 2026-09-27

**Passo 0 — classe** (a mesma, fora do núcleo). Cada veredito da varredura foi RECONFERIDO lendo o
código e REPRODUZIDO numa cópia antes do conserto; os 5 eram afetados — e dois de um jeito que o
"≠ verde" nem descrevia:

| site | o que o juiz aceitava (medido no arquivo de antes) |
|---|---|
| `analytics-outbox-trigger` | a fonte sumida do compute (0 rows) → `veio []` contava (4/0, exit 0); a 2ª leitura vazia do G4 dizia "volatil" |
| `analytics-outbox-perda` | a purga sabotada que ERRA deixava a soma parada: `veio [0]` — **o valor exato** do F2 (7/0) |
| `data-health-sync-state-saude` | leitura vazia; o apply que falhava abortava MUDO (saída em `/dev/null`) |
| `data-health-estoque-fonte-dado` | `$(chk)` dentro do `[ ]` não dispara errexit: o erro virava `""` ≠ broken. F3 sob `if sabota`: padrão que não casa → `$SAB` vazio → `P -f` sai 0 → "APLICOU" (45/0) |
| `data-health-watchdog-reemissao` | cenário em `if cen_X`: o `rodar` que erra era ignorado. E com `PERFORM 1/0` no lembrete o **próprio watchdog isola o erro** por check: 1 e-mail — o declarado — com a rodada saindo 0 |

**O idioma do conserto**, por cima do `vermelha` com o valor declarado do pedido-total:

- a leitura roda `set +e; v="$(set -e; <leitura>)"; rc=$?; set -e` — o subshell de `$(...)` nasce
  sem errexit, e uma leitura composta que erra no meio segue e imprime o declarado; o rc fica fora
  de lista `||`/`&&` e de condição de `if`, onde o errexit é ignorado. Sem o `set -e` interno, o F2
  da purga escapa com o rc ligado (o rc só vê o `Pq` final, status 0) — é ESSA a camada que pega;
- a medição carrega o que distingue o mecanismo de um erro: `checks_avaliados|checks_falhos|meta=`
  no marcador (um check que FALHA também o para), o comprimento dos md5 no binário estável/volátil,
  e `|f=<checks_falhos>` nos cenários do watchdog — o erro que o SUT engole só aparece ali;
- declarar é identificar o MECANISMO: o fingerprint declara que a mensagem MUDA quando o heartbeat
  anda (a hora de 4 casas é normalizada: 0,0001 h = 0,36 s); o F8 do estoque, as 4 bordas achatadas;
  o F9, 4× broken com idade ≥ 1 dia; o F3, o corpo v3 gravado sobre a base alienígena.

**A 2ª opinião** (Codex challenge, `gpt-6-astra` max, 387 s, sobre este diff) achou três escapes
que a primeira versão ainda deixava — todos reproduzidos por ele e depois pela meta daqui:

| achado | sev. | o que foi feito |
|---|---|---|
| estoque F3: o `return` do `sabota` era o do `rm` — apply que falha DEPOIS do COMMIT (a validação pós-apply) passava | alta | devolve o rc do apply |
| estoque F6–F9: `R="$(janela_rodada)"` sem errexit — `limpa` que falhava era ultrapassada | alta | `rodada_sabotada` (o idioma); derrubou o "já-correto" do F6/F7 |
| watchdog: `echo "$(emails)…"` perde o erro depois do valor | alta | `mede` (atribuição própria) |
| sync-state: a forma normalizada aceitava uma mensagem CONSTANTE com a hora | média | declara a volatilidade |
| outbox-perda F5: a emissão do meta-alerta que falha é só WARNING, fora do `checks_falhos` | média | `meta=` na leitura |
| watchdog: operando vazio na aritmética mata o shell ANTES do RESET do GUC | média | leitura validada antes; RESET também no pai |
| watchdog: estado ausente / fonte faltante viravam `f=0` | média | `rodar` exige o estado e soma as faltantes |
| estoque F9: `ok\|0 ×4` passava | média | declara 4× broken ≥ 1 dia; derrubou o "já-correto" |
| estoque F8: cruzar 08h/18h nas 4 leituras (~100 ms) dá vermelho falso | média | **risco residual registrado** — só vermelho falso; aceitar a transição readmitiria a assinatura do F7 |
| `set -e` ao fim muda quem chamou com `+e` | baixa | não ativo (os scripts nascem com `-e`) |

O bash 5 não existe no Mac; a prova do idioma foi para o CI: `scripts/test-idioma-errexit-leitura.sh`
(no `test:falsificacao`) afirma as formas que as provas usam — e, com `--falsificar`, que tirar o
`set -e` da leitura derruba A1–A3 e que um operando válido derruba A5 — e IMPRIME, sem afirmar, o
contexto proibido (`||`/`if`), que é o que o CI mostra no bash 5.

**Meta-falsificação: 136/136** rodadas nos dois locales (cliente `LC_ALL` + servidor
`--lc-messages=pt_BR.UTF-8`, sonda POSITIVA no log do servidor), repo-sombra por symlinks, edições
exatas 1×, `bash -n`, expectativa declarada antes: controle verde; cada reprodução REPROVA o arquivo
novo e APROVAVA o de antes (`bee8feb69`) ou o anterior à rodada Codex (`3430d1b8c`); cada camada
desligada sozinha deixa o caso voltar a escapar. As que ficaram verdes, ditas: o `rc` é redundante
com a igualdade quando a leitura é um comando só (erro = saída vazia ≠ declarado) — fica porque nomeia
a causa; o `cmp` do sync-state nomeia o sed que não casa, mas não detecta (o "seguiu verde" já pegava).

**Lições novas:** (1) o erro que o **próprio SUT** isola (`WHEN OTHERS` por check) produz o valor
declarado com a rodada saindo 0 — a medição tem de carregar o registro de falhas do SUT;
(2) `if sabota` suspende o errexit ATÉ dentro da função — o `return` dela tem de ser o do passo que
importa, não o do último comando; (3) "já-correto" de leitura minha também é hipótese: F6/F7/F9 do
estoque caíram no Codex.

De passagem (fora da classe, tarefa própria): `mktemp /tmp/x.XXXXXX.sql` é nome LITERAL no mktemp do
macOS (só troca X finais) — rodadas paralelas colidem ("File exists"). Aparece em
`estoque-fonte-dado`, `watchdog-reemissao`, `preco-medio-leadtime-efetivo` e `import-tint-formulas`;
o harness da meta tira o sufixo nas cópias.

## Afetados de `db/` fora do núcleo — 2026-09-27

Os 4 afetados de `db/` foram RECONFERIDOS lendo o código e medindo numa cópia antes de qualquer
conserto. A medição mudou três dos quatro retratos da varredura — e trouxe mais três sites:

| site | a varredura dizia | a medição disse | o conserto |
|---|---|---|---|
| `test-pendencias-deploy-eco-passivo` | laço inteiro: `fail≠0` nos 2 locales | **morto desde 2026-09-05** (07fa9ad87): o `SQL` que ele importa passou a ler o ledger, e a sonda do import reprova os 2 modos antes de qualquer assert. No último estado vivo (`07fa9ad87~1`) o laço aprovava SQL que não COMPILA ("corpo não-JSON derrubou a varredura", dizia) e banco MORTO: o `exit 2` da checagem de mecânica encerra só o subshell, e o `if !` lê como vermelho | **aposentado**; as 4 sabotagens foram para a janela viva, no sucessor |
| `test-deploy-atestacoes` (o sucessor) | já-correto | **afetado**: o S2 aceitava qualquer aborto do apply — inclusive a marca "A3 FALHOU" num NOTICE, que a mensagem antiga ainda EXIBIA; o `grep 'A1'` aprovava sabotagem que só derrubou o A11a; um erro na janela matava a rodada inteira sem veredito (o `cli=$(…)` do A9, atribuição simples sob `set -e`) | `--falsificar` no idioma `SABOTAGENS` (gate R1/R2) |
| `test-hash-omie-canonico` F4 | qualquer aborto | confirmado (1/0 e marca em NOTICE aprovados) | a UMA linha ERROR tem de ser a do ramo |
| `test-sayerlack-custo-portal-cas` F4b | qualquer aborto; `sabota()` sem `return` | F4b confirmado; o `sabota()` FAZ `return 1` (sob `set -e`, mata a rodada: fail-closed). **Achado do Codex:** o `rpc()` pescava a 1ª sentinela `RPC_…` de QUALQUER texto — um NOTICE `RPC_OK_1` antes do erro aprovava o F1 | F4b: `cmp` + linha ERROR; `rpc()`: a sentinela é o VALOR de um SELECT |
| `test-fin-sync-watchdog-retry-sem-efeito` F1 | qualquer erro | confirmado — e **G1/G2** no mesmo idioma ("guard abortou (exit≠0)"), fora da varredura: sem a função, o `::regprocedure` do guard erra ANTES do pre-flight e contava | F1: a linha da relação ausente; G1/G2: a do PRE-FLIGHT |

**Limpos dentro destes arquivos** (valor exato já era o juiz): hash-omie F1–F3b, Sayerlack F1–F10 (o
furo deles morava no `rpc()`), watchdog F2–F5 e G3.

**O desenho mudou na consulta ao Codex** (DESENHO antes do código, com `RÉGUA:`; os 6 achados
aceitos): (1) a marca é CHAVE de uma assinatura — a linha ERROR INTEIRA (`null value in column
"fonte` aceitaria `"fonte_errada"`; SQLSTATE sozinho aceita qualquer NOT NULL); (2) o veto ao erro
não declarado é por PAR `(ID, assinatura)`, e a cascata legítima se declara par a par — sem o
`coalesce`, A2, A3 e o re-apply do A11a erram com a MESMA linha; marca que valesse para qualquer
assert aceitaria a mesma mensagem vinda de outra causa; (3) o status da medição entra no juízo: rc≠0
sem linha ERROR (conexão que cai) é erro de execução, nunca "veio []" comparável; (4) exatamente UMA
linha ERROR — `RAISE NOTICE '%', chr(10) || 'ERROR:  <marca>'` forja uma segunda linha que um grep
ancorado, só de existência, aceitaria; (5) `psql -X` (o `~/.psqlrc` muda a linha que o juiz lê);
(6) o recibo por IDENTIDADE — a mesma sequência de IDs do controle (25, com o A9e da v2), não a
soma, que aceitaria um assert faltando e outro duplicado. A postcondição da migration se chama "A3 FALHOU", o mesmo rótulo
de um assert do teste: a marca solta no texto seria a colisão pronta.

**O adversarial atravessou a 1ª versão por quatro caminhos** (ADVERSARIAL no diff, 655 s; cada
caminho medido por ele com microteste; os quatro procedem):

| achado do Codex | sev. | o conserto (v2) |
|---|---|---|
| o delimitador `] — ` DENTRO de um NOTICE multilinha forjava a assinatura inteira na linha humana do sucessor, com o erro real sendo 1/0 | P1 | o `eq` grava um REGISTRO por assert (ID, status, a linha ERROR limpa ou `-`); o laço julga por igualdade nesses campos, e a linha humana só confirma |
| linha ERROR com rc=0 (um NOTICE numa medição que TERMINOU) virava o erro declarado — nada tinha quebrado | P1 | erro LIMPO = rc≠0 + exatamente uma linha + ERROR; o resto nunca satisfaz `ID!MARCA` |
| NOTICE forjando a linha do ramo, seguido de `pg_terminate_backend` (FATAL): a igualdade integral aceitava, nos 4 arquivos | P1 | as conexões não recebem NOTICE/WARNING (`client_min_messages=error`), e FATAL/PANIC/erro do cliente contam como linha |
| o PRE-FLIGHT aceitava qualquer sufixo | P2 | a linha inteira, só o md5 variável |
| a aposentadoria perdeu o "nenhum campo vazio" da saída do CLI (o parser DESCARTA a linha) | lacuna | A9e + a sabotagem `cli_fonte_vazia` |

A supressão de NOTICE e a contagem de linhas formam um PAR: contra o NOTICE multilinha e contra o
FATAL, cada uma sozinha segura, e só as duas desligadas deixam o ataque passar — a meta mede os três
casos, em vez de fingir que cada camada sozinha é necessária.

**Medido, não previsto:** no bash 3.2, `f() { ( set -e; false; echo segue ); }` chamada em `if f` ou
`f || true` imprime "segue" — o contexto de chamada suspende o `set -e` também DENTRO do subshell.
O laço que isola cada sabotagem num subshell o chama como comando simples (`set +e` em volta, rc
num global); com `|| true`, um aborto no meio da suíte sairia como rodada inteira.

### A meta-falsificação dos afetados

Repo-sombra por symlinks, trocas exatas (casou ≠1× = erro da meta), `bash -n`, expectativa declarada
antes, controle na mesma invocação, `LC_ALL=C` e `pt_BR.UTF-8`; o "antes" e o "depois" lidos de
commits FIXADOS (`git show`), não da árvore — o `heavy` e as rodadas longas são fila, e quem mede a
árvore depois da edição mede o conserto.

**Antes** (os arquivos da `main`, `bee8feb69`) — o furo REPRODUZIDO, nos dois locales:

| site | variante | o veredito de hoje |
|---|---|---|
| hash-omie | a postcondição trocada por 1/0 · a marca num NOTICE + 1/0 · NOTICE multilinha | "✅ F4 postcondição recusa", nas três |
| Sayerlack | GRANT + 1/0 · a marca num NOTICE · NOTICE multilinha · a RPC emite NOTICE `RPC_OK_1` e ERRA | "✅ F4b" nas três; "✅ F1" na sentinela forjada |
| watchdog | o watchdog erra por 1/0 · o nome da tabela num NOTICE · a função sumiu (o `::regprocedure` erra antes do guard) · a marca do pre-flight num NOTICE | "✅ F1"; "✅ G1/G2 — guard abortou (exit≠0)" |
| sucessor | S2 abortando por 1/0 · "A3 FALHOU" num NOTICE (a mensagem antiga ainda a EXIBIA) · sabotagem que só derruba o A11a | "✅ S2"; "✅ S3 → vermelho em A1" |
| eco-passivo, estado vivo (`07fa9ad87~1`) | a sabotagem (a) gerando SQL que não compila · o banco morto antes do laço | `FALSIFICACAO OK` nas duas (o controle aborta 2 vezes — a (c), de propósito; a variante, 4) |

**22/24 + 13/13 bateram o declarado, em cada locale.** Os 2 desvios foram PREVISÕES minhas, com a
causa entendida: o S1 que faz a janela errar não vira falso dente — o `cli=$(…)` do A9, atribuição
simples sob `set -e`, mata a rodada inteira sem veredito (fail-closed, CEGO); e o diagnóstico
procurava "syntax error", que o próprio teste corta em 90 caracteres.

**Depois** (`3c01d17b6`): **51/51 em `C` e 51/51 em `pt_BR.UTF-8`.**

| site | variantes | o que ficou provado |
|---|---|---|
| hash-omie F4 | 12 | erro alheio, NOTICE, NOTICE multilinha e FATAL recusados, com a causa na tela. A IGUALDADE é a única que pega o erro alheio de uma linha só (desligada, o 1/0 volta a passar). Supressão de NOTICE + contagem das linhas, contra o multilinha, e supressão + FATAL contado, contra a conexão morta: cada uma sozinha segura; as duas desligadas, o ataque passa |
| Sayerlack F4b + `rpc()` | 8 | os mesmos ataques recusados; o sed que não casa agora diz "sabotagem NÃO casou", não "postcondição NÃO abortou"; a sentinela forjada vira `RPC_ERR_22012` e o F1 reprova |
| watchdog F1 · G1 · G2 | 11 | idem no F1 e no pre-flight; o PRE-FLIGHT seguido de OUTRO RAMO reprova — o juiz de prefixo o aceitava |
| sucessor | 20 | controle com 25 asserts e 9 sabotagens; os 4 ataques do adversarial recusados — e, com a supressão de NOTICE desligada, o registro estruturado AINDA recusa o delimitador e o rc=0; cascata não declarada, sabotagem que não aplica (inclusive a do CLI) e controle com ID duplicado reprovam. As camadas 2, 3 e 4, cada uma desligada, liberam o caso que SÓ ela pega (`9 vermelhas / 0 falhas`, exit 0); a 1 é redundante — a 2 pega — e fica porque nomeia a causa |

Gates, sobre o mesmo commit: os 19 arquivos do vitest que leem `db/` (1.132 testes), shellcheck
(0 achados em 456), `falsificar-exige-assert` (461 arquivos, 5 listas, 47 entradas, 5 laços, 7
linhas do núcleo — antes: 462 · 4 · 38 · 4 · 7) e `shell-variavel-colada`.

### Lições dos afetados

- **Prova fora do CI apodrece em silêncio.** A do eco passivo ficou 22 dias saindo 1 na `main` e
  ninguém viu: a sonda do import fez o certo (reprovou, em vez de verde por cegueira), mas nada a
  roda. A falsificação das defesas que ela provava morreu junto — e o sucessor, que herdou os asserts,
  não herdou as sabotagens.
- **Varredura delegada é hipótese, nos dois sentidos, de novo:** um "já-correto" era afetado, um
  "afetado" estava morto, uma premissa ("sem `return`") era falsa e três sites vieram de fora dela
  (G1/G2 da releitura; o `rpc()` do Codex).
- **Marca que a própria migration emite colide com o vocabulário do teste.** Assinatura é a linha
  ERROR inteira, par a par com o assert — nunca a palavra solta.
- **O 2º locale pegou a própria meta:** `$rc≠` sob UTF-8 virou `${rc\xE2}` e o `set -u` a matou (a
  classe que `shell-variavel-colada-gate` já vigia; `logs/` não é escaneado). E o `grep` do zsh desta
  máquina é função do shim: diante de um byte UTF-8 inválido ele não imprime nada e sai 1 — nem o
  `-c` responde. Inspeção à mão de log usa `/usr/bin/grep`.

## Os evals do deploy-verify (2026-09-27)

**Passo 0 — instância única ou classe? Classe**, com a assinatura da fase 1 (o veredito que conta a
sabotagem como dente não identifica o assert), agora nos `--falsify` de
`.claude/skills/lovable-deploy-verify/evals/`. Eles rodam no CI (`evals:deploy-verify:falsificacao`,
job `validate`), e um vermelho de erro alheio lá também aprova.

**Reconfirmação site a site.** A lista veio da varredura delegada, ou seja, era hipótese. Cada juiz
foi lido e REPRODUZIDO numa cópia (repo-sombra, edições exatas 1×, `bash -n` antes, expectativa
declarada antes), com o arquivo de ANTES (`bee8feb69`) e uma sabotagem que só derruba o alvo:

| site | juiz de antes | a reprodução | o arquivo de antes |
|---|---|---|---|
| `criterio-caro` (afetado) | `rc>0` da suíte | o recipe vira um regex INVÁLIDO: C1 segue verde e o C2 cai por ERRO do grep | "pega: recipe apagado" |
| `edges-pendentes-sql` (afetado) | `erros≠0` de qualquer dos 13 casos, **sem controle verde** | `ORDER BY … DESC)`: os 13 caem em "a consulta falhou" | "pegada: o DISTINCT ON…" |
| `sonda-veredito-401` (afetado) | `rc≠0` de qualquer dos 19 | `AND )` na recência: os 19 ficam sem veredito, com a via viva | "pegada: testemunha sem RECENCIA" |
| `verify-edge-eco` (parcial) | `exit ≠ normal` | `[ 1 -ge 0 ] \|\| ( recusa`: morre de SINTAXE com exit 2, o exit PREVISTO da (2) | "fail-closed do ping removido" |
| `verify-edge-escrita` (parcial) | `exit ≠ normal` | o mesmo na (2), e uma variável não definida na (4) | "ping_sem_dente", "alvo_sem_guard" |
| `verify-frontend` (parcial) | `≠ normal` em A-D, G e I (C/D num laço ad hoc), `exato`/`marca` opcionais | uma variável não definida na A: exit 1, o exit previsto | "divergiu: sem fechamento transitivo" |

Os 6 se confirmaram. A leitura também achou o que a varredura não trazia:

- **Uma sabotagem nascida teatro.** A "controle nao chega na projecao (CROSS JOIN removido)" da sonda
  vem do #2131. O CASE lê `c.*`, então arrancar o JOIN nunca abriu ramo nenhum: o SQL não compilava,
  os 19 casos saíam sem veredito e o laço contava isso como dente. Ela foi re-derivada para o JOIN que
  MULTIPLICA a leva, acusada pelo `uma_linha_por_edge` ("devolveu 2 linha(s)"). É a 1ª falsificação
  que esse assert teve.
- **"Exatamente 1 ocorrência" falhava em quatro lugares.** O `sed` da (1) do eco trocava os DOIS
  `exit 2` do script. No gerador da sonda, 3 alvos apareciam 2×: os dois ramos de 401 (agora
  declarados `2`), o `'INDETERMINADO — 401`, que também está no SQL da canária, e o
  ` CROSS JOIN controle_credencial c`, que casava o prefixo de `cred`. E as 13 do frontend eram `sed`
  sem nenhuma checagem de que tinham aplicado.
- **Nome diferente do efeito medido.** A "campo ausente volta a ser lido como DEPLOY PARCIAL" hoje cai
  no ELSE ("bundle velho" com `fonte=?`) e foi renomeada. Quem reabre o defeito de 09-05 é a do
  COALESCE.
- **Um sintoma de crash declarável.** No `uma_linha_por_edge`, um SQL que ERRA também dava
  "0 linha(s)", e um autor poderia declarar esse sintoma como previsto. Agora quem decide é o exit do
  psql: erro vira não-veredito.
- **Dois "já-corretos" não eram.** O `run.sh` (classify) aprovava uma mutação do `classify.sh` que só
  quebrava a sintaxe ("mutação pega": a saída vazia diverge de todos os casos) e não tinha controle no
  `--falsify`. O juiz `sabota` do `monitor-deploy-pr-eval` (19 das 24 sabotagens: caso isolado,
  `FAIL≠0`) creditava uma que só derrubava o monitor por variável não definida. As duas coisas foram
  medidas nos dois locales e consertadas aqui (mesma pasta, mesma classe). O `monitor-deploy-eval` se
  confirmou correto: ele é a referência do idioma.

**O conserto é um idioma só nos 8, o do `monitor-deploy-eval`:**

- alvo LITERAL com o nº exato de ocorrências (1, salvo declaração);
- `bash -n` no alvo sabotado;
- CONTROLE íntegro na mesma invocação, e por locale onde o eval não fixa `LC_ALL`;
- o desfecho PREVISTO de cada sabotagem, que não pode descrever o controle: exit + marca do ramo, os
  IDs `C1…C12` do caro, as marcas do veredito da sonda, caso+chave+valor do classify;
- erro de execução recusado: stderr no caro, não-veredito com a via viva na sonda, exit do psql, rc do
  classify.

As marcas foram MEDIDAS e lidas ramo a ramo. Uma previsão minha, feita pela leitura, errou (a 3ª classe
do edges dá "nenhuma sonda em", não `SONDA_ANONIMA`), e a medição a corrigiu antes de ela virar gabarito.

**O gate de reintrodução é comportamental.** O gate textual do #2619 lê `SABOTAGENS=` e, por decisão,
não alcança estes laços. Então cada `--falsify` roda **controles negativos do próprio juiz**: um por
camada, cada um uma sabotagem que só aquela camada separa do julgamento. Por exemplo:

- **marca:** a sabotagem sai com o exit PREVISTO sem passar pelo ramo (`exit 2` no lugar do guard, SQL
  quebrado declarando a DERIVA do `#anonimas`);
- **shell:** o ramo imprime a marca e o script MORRE, ou `${X?marca}` põe a marca só no diagnóstico;
- **ids/stderr/valor/exec/passo:** nos idiomas do caro, do classify e do monitor.

O gate exige a RAZÃO do julgamento (`ULTIMO_MOTIVO`/etiqueta). Recusa por "não aplicou", "sintaxe" ou
"controle" deixa o gate VERMELHO, porque não exercitou o juiz (achado do Codex). Na falsificação do
gate, cada camada removida (ou o juiz devolvido ao idioma antigo) deixa vermelho o negativo dela:
**50/50 nos dois locales**:

- em cada uma das 16 camadas removidas, o negativo DAQUELA camada fica vermelho ("o juiz perdeu a
  identidade"). As camadas: shell e só-exit no eco, na escrita, no frontend e no edges; stderr e IDs no
  caro; a marca na sonda; exec e valor no classify; shell, só-exit e passo no monitor;
- o negativo cujo alvo sumiu é recusado "por OUTRO motivo [NAO-APLICOU]": o gate não aceita recusa que
  não seja do juiz;
- os 8 controles ficam verdes.

Um resíduo fica registrado: o exit do psql na sonda (achado 3) não tem negativo isolado, porque a
sabotagem que o isolaria (um veredito que SAI e depois erra) pede duas edições no gerador.

**Meta-falsificação, nos dois locales** (controle verde + a reprodução reprova no arquivo novo + o
arquivo de antes aprovava), sobre os commits e com as camadas isoladas onde há mais de uma:

| eval | controle | a reprodução reprova no novo | camada isolada | o de antes aprovava |
|---|---|---|---|---|
| `verify-edge-eco` | 4/4 | sintaxe (exit 2 = o previsto) e variável não definida | sem o `bash -n`: só a marca | as duas |
| `verify-edge-escrita` | 4/4 | idem | idem | as duas |
| `criterio-caro` | 8/8 | regex inválido: `ERRO-DE-EXECUCAO` | sem o stderr: "C1 não ficou vermelho"; declarando o C2: stderr | sim |
| `verify-frontend` | 13/13 | variável não definida na A (exit 1 = o previsto), sintaxe na C | sem o `bash -n`: só a marca | as duas |
| `edges-pendentes-sql` | 11/11 | SQL quebrado: "motivo ERRADO … obtido exit=2" | — | sim |
| `sonda-veredito-401` | 12/12 | `AND )`: `veredito=<vazio>`; a CROSS JOIN teatro declarando "devolveu 0 linha(s)" | — | as duas |
| `run.sh` (classify) | 5/5 | a mutação que só quebra a sintaxe dá `quebrou a SINTAXE`; sem o `bash -n`, dá `ERRO de execução` | — | sim |
| `monitor-deploy-pr` | 24/24 | a variável não definida no prfora dá `VERMELHO pelo motivo ERRADO` | — | sim |

Totais das metas: eco 14/14, escrita 14/14, caro 12/12, frontend 14/14, edges 8/8, sonda 10/10,
reproduções dos "já-corretos" 8/8, gate 14/14 ; mais classify novo 4/4, monitor novo 6/6 e as camadas do gate 50/50 (a 1ª versão do gate, antes do
Codex, fez 14/14). O `test-eval-via-morta` foi medido de três formas:

- contra o eval de ANTES: `--falsificar` sai 1, com S1 e S2 reprovando;
- com um aborto logo depois do 1º baseline: S1 e S2 reprovam, porque falta o recibo das 12;
- com o exit 5: o S1 reprova.. O `test-eval-via-morta` novo: 0/0 contra o
eval novo nos dois locales, e `--falsificar` exit 1 (S1 e S2 reprovando) contra o eval de antes.

**A 2ª opinião (Codex, 2026-09-27)** — ritual `/codex` em modo challenge (`codex-async.sh`,
`gpt-6-astra`, reasoning max, 643 s), sobre o diff inteiro. Ele VALIDOU os contraexemplos em memória
com os predicados reais. Achou 7 furos, e todos procedem:

| achado do Codex | sev. | o que foi feito |
|---|---|---|
| exit + substring aceita crash: a marca sai e o script MORRE com o exit previsto (1); `${X?marca}` põe a marca SÓ no diagnóstico do bash (eco, escrita, frontend, edges) | alta | camada de ERRO DE SHELL: saída com `<script>: line N:` é recusada |
| monitor: o `prrevert` exigia como marca o PRÓPRIO texto da sabotagem, e um `command not found` o fabricava | alta | re-derivada (a detecção de revert deixa de avisar) + camada de shell |
| sonda: veredito PARCIAL seguido de erro do psql (exit 3) era creditado | alta | o exit do psql decide (`SQL_ERRO` = não-veredito) |
| monitor: "1º passo que falhou" não dizia QUAL passo do grupo | média | `id@passo`: o prefixo da descrição do passo é parte do contrato |
| classify: nem "a mutação muda algo" nem "o previsto difere do controle" | média | `SEM-MUDANCA` e `PREVISTO-NO-CONTROLE` recusados |
| gates negativos: "recusado pelo juiz" ≠ "não creditado por qualquer motivo" (um `aplica` que falha deixava o gate verde) | média | cada juiz registra o MOTIVO (`ULTIMO_MOTIVO`/etiqueta) e o gate exige o do JULGAMENTO; dois negativos por eval, um por camada |
| S1/S2 do `test-eval-via-morta` aceitavam aborto logo após a 1ª mensagem | média | exigem o recibo das 12: o laço TERMINOU |

O que ele confirmou certo: as duas ocorrências do 401, o CROSS JOIN re-derivado (mantém o alias `c` e
duplica a relação), o `uma_linha_por_edge` recusando psql com exit ≠ 0, os filtros com nome errado (os
dois SQL exigem exatamente um caso no baseline) e o `criterio-caro` (stderr separado + fim explícito +
IDs).

**Defesa em profundidade revelada.** O `test-eval-via-morta` provava o `via_viva` exigindo que, sem
ele, o eval da sonda VOLTASSE a aprovar 11/11 com a via morta. Com o juiz do previsto isso deixou de
acontecer: o baseline íntegro do caso-alvo já sai vermelho com a via morta, e sem o discriminador o eval
recusa pela causa errada (exit 1, "o caso-alvo não passa íntegro"). Os papéis mudaram assim:

- o S1 da falsificação exige esse desfecho DECLARADO;
- o S2 exige a nova camada: nenhuma sabotagem creditada;
- o `via_viva` ficou com o papel de NOMEAR a via (exit 2).

Sobre o eval de ANTES, o teste novo reprova S1 e S2. A mudança colidia com a fase `scripts/` [a93aad],
que editava o mesmo S1 declarando o desfecho antigo (exit 0). Isso foi coordenado entre as sessões: o
arquivo inteiro ficou com esta fase, e a reprodução que ela sugeriu (o eval sai 5 depois de imprimir o
que o S2 procura) reprova no S1.

**Tropeços de método desta fase** (os que custariam caro se passassem):

- A "linha de base" via `heavy` esperou 45 min na fila e rodou sobre a árvore JÁ editada, ou seja,
  sobre uma mistura de antes e depois ("heavy é uma FILA", `money-path.md`). A de pt_BR nem rodou: o
  exit 1 dela é o timeout de 1800 s do `heavy`, não do eval. A meta lê o "antes" por revisão git e é
  imune a isso.
- Editar o script da meta com uma rodada em voo corrompeu o rabo dele. As 10 linhas de veredito valem;
  o exit 1 final era do harness, que ainda lia o arquivo por offset.
- Uma marca com `|` quebrou o parse do plano (ERRO-DA-META, recusado certo). No zsh, `"$H:…"` é
  modificador (`bad substitution`), e `$F` sem aspas não divide: a varredura de worktrees sairia limpa
  por cegueira. O controle positivo foi exigir que o próprio worktree aparecesse nela.
- Uma edição com âncora errada FALHOU (`AssertionError`) dentro de um comando encadeado por `;`. A
  rodada seguinte rodou o eval SEM a mudança, saiu 0 e quase virou prova; só a saída mostrou o erro.
  O conserto foi encadear por `&&` e pôr o veredito na ÚLTIMA instrução (a contagem dos negativos).
- Uma conferência da meta contou `SEM o recibo` com caixa fixa, mas o S2 escreve `sem`. Era erro da
  meta: o log tinha as duas FALHAs.

## Parciais de `db/`, fase 2 — farmer, 2026-09-27

**Passo 0 — classe.** Os 5 reconferidos lendo o código e reproduzidos numa cópia; os 5 eram afetados,
e o `desfecho` tinha além disso **dentes de VÁCUO** — sabotagem que "mordia" sem nada a morder:

| site | o que o juiz aceitava (medido no arquivo de antes) |
|---|---|
| `farmer-desfecho` | o DO captura `WHEN OTHERS`: o `22012` da RPC sabotada contava como "≠ SQLSTATE da defesa". F1 usava `$OUTRO` (que TEM oferta da mesma chave — a lição que o assert 10 já tinha e a falsificação não) e F4 não tinha ambiguidade (o F2 apaga a 1ª pendente): **sem sabotagem nenhuma**, o arquivo de antes dizia "4 com dente / 0 inertes", exit 0 |
| `farmer-geracao-vigente` | a chamada sabotada que ERRA deixava o total em `[1…]` ≠ verde (35/0); o sentinela antes do erro no COMMIT contava; o apply da sabotagem rodava dentro de `if` (errexit suspenso) |
| `farmer-head-geracao` | F4/F9: a chamada que ERRA dá o MESMO `0` que a sabotagem produz (o teste esvazia head/log antes); W1/W2 liam `permission denied` — em pt_BR o controle intacto caía no ramo "PASSOU" |
| `farmer-melhor-individual-bulk` | a RPC que erra dava `[]` ≠ `[AUSENTE]`: "assert caiu como devia" (18/0) |
| `farmer-margem-server-side` | F2 `veio []` ≠ `40.00` contava (47/0); F3 aceitava a quebra de outra coisa como "A1 fica vermelho" |

**O conserto:** o valor declarado (colhido do arquivo intacto, 2 rodadas iguais) em cada juiz, a
medição pelo `medir()` (erro → `ERRO_rc=<n>`, que nenhum declarado casa), sentinelas com `PSQL_RC=0`
e condições nomeadas (`insufficient_privilege`, `unique_violation`) no lugar do texto do servidor.
No `desfecho`, o **`controle_cena`**: a defesa INTACTA tem de barrar a MESMA cena, nesta invocação,
antes da sabotagem — foi ele que acusou os dois vácuos (F1 passou a usar `$GESTOR`; F4 repõe a 1ª
pendente antes da 2ª).

**A 2ª opinião** (Codex challenge, `gpt-6-astra` max, 388 s) achou mais escapes; todos reproduzidos
na meta (pré = o commit antes da rodada) e fechados, menos os dois marcados:

| achado | disposição |
|---|---|
| `head -1` escolhe a 1ª sentinela: `SEM_ERRO n=1` e depois `1/0` capturado aprova | todas as sentinelas (`paste -sd'\|'`) — o declarado é UMA só (pré 0 → novo 1) |
| chamada sem efeito preserva o declarado (margem F4, head F4/F9: o estado preparado JÁ é o valor) | a medição carrega um efeito independente da chamada: `42\|NULL\|1` (antes, depois, retorno), `0\|2`, `0\|<head do run>` (pré 0 → novo 1) |
| valor correto seguido de erro (`red`/`ne`/`eq_esperando_vermelho` recebem a substituição como argumento) | `medir()` nos três (pré 0 → novo 1) |
| A6 `*ERROR*`: em pt_BR o servidor diz `ERRO` e a rejeição indevida passava | `PSQL_RC` + condição nomeada (pré-pt 0 → novo 1) |
| `L3 … \|\| true`: o retry que erra "prova" idempotência | `\|\| bad` (pré 0 → novo 1) |
| apply da sabotagem dentro de `if` (errexit suspenso) | a função devolve o rc do apply, não o do `rm` |
| `K=2` faria `T+2−K = T` (chamada inerte casaria) | fechado pelo 2º campo (`\|N_LOTE`); na cena atual K=1 — não reproduzível, só por construção |
| **residual:** `ROW_COUNT` depois de `PERFORM` conta a chamada, não as linhas atualizadas dentro da RPC | registrado: o `n=1` do desfecho prova "executou sem erro", não o efeito |
| **residual:** `controle_cena` sem rollback quando a defesa REGRIDE contamina a cena seguinte | o controle já soma FAIL; as reposições limitam a propagação |

**Meta-falsificação** (C e pt_BR, controle verde na mesma invocação, uma camada por vez):
**96/96** — desfecho 24, geracao-vigente 26, head-geracao 18, melhor-individual 12, margem 16. Em
cada site: a reprodução reprova no novo, passava no de antes, e desligar a camada (igualdade,
`medir`, `controle_cena`, `PSQL_RC`) devolve o escape.

**Lições da fase 2:**

- **Dente de vácuo é a mesma classe pelo outro lado.** O juiz não identificava o assert porque não
  havia assert a identificar: a cena não exercitava a defesa. Só um controle POSITIVO na mesma
  invocação (a defesa intacta barra) separa "mordeu" de "não tinha o que morder".
- **O estado preparado pode ser o declarado.** Quando o teste zera algo antes da chamada e a
  sabotagem produz zero, a chamada que nada faz também produz zero — a medição tem de carregar o
  efeito da PRÓPRIA chamada.

## Parciais de `db/`, fase 3 — preço/custo/margem (money-path), 2026-09-27

**Passo 0 — classe.** Os 5 reconferidos lendo o código e reproduzidos numa cópia; os 5 eram afetados:

| site | o que o juiz aceitava (medido no arquivo de antes) |
|---|---|
| `fu4f-fase3-carteira-margem-faixa` | `ne` aceitava a leitura que ERRA (≠ verde); sob `sabota … && {…}` o apply que falhava pulava o bloco inteiro sem vermelho nenhum (exit 0) |
| `preco-medio-leadtime-efetivo` | a medição VAZIA contava como o número enviesado da fonte crua (18/0) |
| `recommend-cluster-agregado` | `exige_vermelho` aceitava a chave AUSENTE da medição (25/0); a sabotagem que não casa passava calada |
| `regua-preco-customer360` | F2 casava `*1*` — qualquer texto com um "1", inclusive o de um erro (35/0) |
| `v-titulo-baixas-otica-canonica` | `muta` aceitava a linha que SOME por defeito qualquer (`(vazio)` ≠ controle, 21/0); F4 aceitava a perda TOTAL; A9 casava a AUSÊNCIA de uma sentinela (qualquer erro) |

**O conserto:** o valor declarado (colhido do arquivo intacto, 2 rodadas iguais) em cada juiz; `medir()`
nas medições de juiz; o apply da sabotagem com o rc nomeado (falha = vermelho, não bloco pulado); o F4
do v-titulo exige a perda SELETIVA (o 1001 fica); o A9 pela condição nomeada (`raise_exception`
capturado com psql 0).

**A 2ª opinião** (Codex challenge, `gpt-6-astra` max, 371 s — obrigatória no money-path) achou 5 escapes;
todos reproduzidos na meta (pré = o commit antes da rodada: passava; novo: reprova) e fechados:

| achado | disposição |
|---|---|
| K3 (fu4f): só a leitura do vendedor passava pelo `medir`; o controle do gestor que ERRA dava `1 ≠ vazio` e aprovava | as DUAS leituras pelo `medir`, e o `ne` reprova erro em qualquer lado (pré 0 → novo 1) |
| A9 (v-titulo) provava uma CÓPIA do guard escrita no teste: remover o guard da migration deixava o A9 verde | executa o bloco `$post$` EXTRAÍDO da migration e exige a mensagem do guard `security_invoker` dela (novo 1 com o guard real removido) |
| régua F1/F3: `fnum` dentro de `[ "$(…)" = t ]` descartava o rc — `t` seguido de erro passava | `medir` no `fnum`; o `sed` que não casa é nomeado (pré 0 → novo 1) |
| cluster F6: duas substituições; a que não casasse passava calada (`observados=3` igual) | F6a/F6b, cada substituição exigida (pré 0 → novo 1) |
| v-titulo F6: `5/3` não dizia QUAIS linhas — trocar a linha certa também dava 5/3 | declara o CONJUNTO de ids faltantes/sobrando |
| **residual (baixa):** K3 dá `1` porque o cálculo satura (1,125) — estável, pouco discriminante | registrado |

**Meta-falsificação** (C e pt_BR, controle verde na mesma invocação, uma camada por vez): **70/70** —
fu4f 18, preço-médio 8, cluster 16, régua 10, v-titulo 18.

**Lição da fase 3:** **guard copiado no teste prova a cópia.** O A9 dava o vermelho certo, pelo motivo
certo — no código errado. A falsificação de um guard de migration roda o bloco DA migration (extraído do
arquivo); senão, remover o guard real deixa tudo verde.

## Parciais de `db/`, fase 4 — tint + reposição/pedidos/tático, 2026-09-27

**Passo 0 — classe.** Os 6 reconferidos lendo o código e reproduzidos numa cópia; os 6 eram afetados
(um deles no núcleo do CI):

| site | o que o juiz aceitava (medido no arquivo de antes) |
|---|---|
| `tint-promote` (núcleo) | F1/F2 "diverge em ≠ 0 linhas": uma sabotagem COMBINADA que divergia em 2648 linhas contava como o NULL-honesto furado (720) |
| `import-tint-formulas` | cada guard "≠ o valor do defeito": 1 item — nem os 0 da rejeição, nem os 2 do defeito — contava (17/0) |
| `oportunidade-erro-terminal` | "≠ 6001" aceitava a saída VAZIA (bloco 1) e um SKU a mais (bloco 3); o apply sabotado que falhava era engolido pelo `\|\| true` |
| `pedidos-programados` | F1 "≠ 0": o customer vendo 2 headers, e não o 1 sem RLS, contava (24/0) |
| `pos-frescor-marcador` | X1 "!= t": o `f1` engolia o erro em `[]` e qualquer desfecho contava |
| `tactical-plan-idempotencia` | o `falsifica` só IMPRIMIA os discriminadores do F2/F3 (um F5 com 2 colunas com default dava "7 com dente"); o p3 lia a última linha do erro (DETAIL/CONTEXTO, dependente do locale) |

**O conserto:** o valor declarado — 720 e 1928 exatos no tint-promote (juiz registrado no `JUIZES` do
`falsificar-exige-assert-gate`, com 4 âncoras), `0/3/0` no import, `NENHUM` e `6001,6004` na
oportunidade, `1` no pedidos-programados, a SQLSTATE `42703` no X1 — e o MOTIVO declarado no
`falsifica` do tático, com `PSQL_RC=0` e condição nomeada.

**A 2ª opinião** (Codex challenge, `gpt-6-astra` max, 462 s) achou mais escapes — dois deles MEUS,
introduzidos nesta fase. Todos reproduzidos na meta (pré = o commit antes da rodada: passava; novo:
reprova) e fechados, menos os marcados:

| achado | disposição |
|---|---|
| tint Flog-2 "0 apontados": a chamada que nem gera o log (o `RESET38` o apagou antes) também dá 0 | mede `marcados\|total` — declarado `0\|3` |
| tint Flog-5 "≠ 1/9.000" aceitava a receita APAGADA (`0/-`) | declara `1/5.000000`, a parcial promovida |
| import F2 com `qtd2ml:""` (o A2 usa `"0"`): sem guard nenhum, o `""` já abortava a linha e preservava a receita — dente por acidente | o payload do A2; e F1–F3 medem `itens\|rej=<linhas que o guard rejeitou>` — o guard INERTE dava os mesmos `0` (no pré, F1/F3 "caíam sob o guard" sem guard) |
| tático p3 (**meu**): o `PERFORM` descartava o retorno — o A7 de antes exigia o UUID | volta a exigir o id retornado + a linha com esse id (RPC que devolve NULL) |
| tático F3: `DUPLICATA_PASSOU` sem a duplicata GRAVADA (RPC que volta sem inserir) | conta o gravado: `n=2` |
| tático F2/F7: qualquer 23505; o glob `…dia_operacional*` casava `…_extra` | a mensagem errada nomeia a constraint; delimitador `;` |
| pos X1 (**meu**): a consulta COPIADA num DO deixava escapar a `f1` neutralizada (`printf t`) | a `f1` devolve `SQLSTATE=<código>` (`VERBOSITY=sqlstate`) e o X1 mede pela MESMA `f1` do assert |
| pos X6/X6b "≠ barrado" aceitava erro alheio; `barra()` aceitava a marca num NOTICE antes de outro erro | desfecho nomeado (`vazou`, com `PSQL_RC`); a marca na linha do ERRO, depois da SQLSTATE da pós-condição (42P13/42501) |
| oportunidade `NENHUM`: a geração INERTE (`RETURN;`) dá o mesmo — o `OFERTADOS` apaga tudo antes | a medição leva a linha-resumo da RPC e header×itens: bloco 1 `ret=0\|0\|0\|0\|{promo_flat}\|hi=0\|0`, bloco 2 `ret=1\|1\|200\|0\|{promo_flat}\|hi=1\|0` |
| **residual (baixa):** 720/1928 são contagens — no modelo aritmético da cena, outras sabotagens (preço 999; fator 2 nas maiores) dariam o mesmo número | registrado: o juiz barra erro, vazio e outra cardinalidade; o CONJUNTO afetado fica para quando a prova mudar |
| **residual (média):** o `JUIZES` ancora aceitação e rejeição, não a LIGAÇÃO com a medição (`DSAB=720` fixo passa), e o registro é voluntário | limite do desenho textual do gate (R3), fora desta fase → ✅ fechado em 2026-09-30 ("A ligação do juiz com a medição — e o registro fechado", abaixo) |
| **fora da classe:** assert PRINCIPAL verde por ausência (`IF q900 <> 12.5` com `q900` NULL; `eq … "$(cand)" ""` com a leitura que erra) | tarefa **"Erradicar assert principal verde por ausência em db/"**, com as duas assinaturas calibradas |

**Meta-falsificação** (C e pt_BR, controle verde na mesma invocação, uma camada por vez): **102/102** —
44 da fase (oportunidade 10, pedidos 8, pos 6, tático 8, import 6, tint 6) e 58 da rodada Codex (tint
10, import 10, tático 18, pos 14, oportunidade 6).

**Lições da fase 4:**

- **Consertar um eixo da medição pode soltar outro.** Os dois achados "meus" nasceram de consertos
  certos: trocar o `cria` por um DO (para nomear a condição) apagou a exigência do UUID; copiar a
  consulta do `f1` num DO (para ler a SQLSTATE) desligou o X1 do assert. O juiz mede pelo MESMO caminho
  do assert, e o conserto preserva o que a versão anterior já exigia.
- **Caminho fixo em `/tmp` faz rodadas paralelas se atropelarem** (o F1d-1 do tint-promote reprovou
  com "âncora não encontrada" numa rodada que, sozinha, passa) — virou a tarefa **"Corrigir temporários
  que colidem em provas db/"**.

## Parciais de `db/`, fase 5 — authz/RLS + dados, 2026-09-27

**Passo 0 — classe.** Os 6 reconferidos lendo o código e reproduzidos numa cópia; os 6 eram afetados:

| site | o que o juiz aceitava (medido no arquivo de antes) |
|---|---|
| `authz-private-execute-fecho` | F2 "≠ BARROU": `OUTRO:22012` (a função que ERRA) contava como o GRANT de volta — e a marca `ZQ_EXECUTOU_SEM_ERRO` num NOTICE antes de outro erro também (o `\|\| true` engolia o rc); F1 "≠ scrub" aceitava `99.5/N/0.8` |
| `cap-carteira-escrever-master-only` | a função sabotada que ERRA dava `""` ≠ `false` → "o corpo antigo escreve de novo" |
| `margin-audit-log-master-pode-ler` | a policy que ERRA: a `le` imprimia o uid do `set_config` antes do erro, e o `tail -1` o entregava — `≠ 7` contava |
| `remove-trigger-auto-super-admin` | o trigger restaurado concedendo OUTRO papel (`estrategico`) contava como o super_admin |
| `backfill_kb_documents_product_code` | F1 "≠ vazio": um código LIXO no D2 contava como o vazamento do rascunho; F3 "≠ o próprio code": o D1 zerado contava como o cruzamento |
| `carteira-saude-eligible-efeito` | F1 "≠ 3": a chave `carteira` AUSENTE contava; F2 "≠ succeeded": com o job fora da lista, o `tail -1` devolvia a tag `SET` do `SET test.uid` — `mensal=SET` contava como dente |

**O conserto:** o valor declarado (colhido do arquivo intacto, 2 rodadas iguais, conferido na semente):
`99.5/123.45/0.8` e `EXECUTOU`; `true`; `0` e `PUBLIC`; `super_admin`; `FL.9999.00` (a ficha-rascunho
do D2), `YC.1401.00` (a do D4) e `PC.2992.00` (a do OUTRO doc); `5` (as 3 elegíveis + as 2
inelegíveis) e `(null)`. As medições pelo `medir()`; as marcas do `veredito` só com o psql saindo 0.

**A 2ª opinião** (Codex challenge, `gpt-6-astra` max, 425 s):

| achado | disposição |
|---|---|
| **Alta:** o `grep -Fxq 'PSQL_RC=0'` aceitava QUALQUER linha — a função sob teste podia imprimir `PSQL_RC=0` num NOTICE e forjar o `EXECUTOU` com a chamada abortada | o rc numa variável, fora do texto; e o desfecho é o CONJUNTO das marcas — exatamente uma (a forja do Codex: pré 0 → novo 1; sem o conjunto, o rc sozinho ainda reprova) |
| **Média:** sem `-X`, um `~/.psqlrc` com `ON_ERROR_STOP off` faz o script seguir depois do erro e sair 0 — a marca antes do erro vira desfecho | `-X` nos 6. Com `PSQLRC` hostil: pré 0 → novo 1; tirar só o `-X` ou só o conjunto ainda reprova (cada camada basta); tirar os dois devolve o escape. As outras provas de `db/` viraram a tarefa **"Blindar provas db/ contra ~/.psqlrc (psql -X)"** |
| **Média:** o `0` do margin-audit F1 saía também de DROP POLICY sem recriar (a RLS nega tudo) | a assinatura por papel `master=0\|estrategico=7\|super_admin=7` (pré 0 → novo 1) |
| **Baixa:** o F2 do cap-carteira recriava um corpo que não é o da migration (gerencial/super_admin escreviam) — a sabotagem mudava comportamento junto com o ACL | o corpo da migration (master-only) |

**A própria meta tinha um furo:** o authz-private fixa o `lc_messages` do BANCO por
`HARNESS_LC_MESSAGES` (default C) — a rodada "pt" da primeira meta rodou as sessões em C, com o
servidor em pt, e a sonda do postmaster não via isso. O harness passou a exportar a variável e a meta
foi refeita (18/18). Nenhuma outra das 27 provas fixa o `lc_messages`.

**Meta-falsificação** (C e pt_BR, controle verde na mesma invocação, uma camada por vez): **98/98** — 66
da fase (authz-private 18, cap-carteira 8, margin-audit 10, remove-trigger 8, backfill 12,
carteira-saude 10), 24 da rodada Codex e os 8 controles do HEAD final.

**Lições da fase 5:**

- **A saída julgada não carrega o veredito do processo.** `echo "PSQL_RC=$?"` dentro do texto só é
  seguro com o casamento ANCORADO no fim (o `*…PSQL_RC=0` dos globs, onde a linha real é a última);
  "em qualquer linha" deixa a função sob teste forjar o rc. O rc vai numa variável.
- **`tail -1` depois de `SET …; SELECT …` devolve a tag `SET` quando o SELECT volta sem linha** — a
  ausência vira um valor que nenhum "≠ verde" reconhece como ausência.
- **Sonda de locale no postmaster não prova o locale da SESSÃO:** `ALTER DATABASE … SET lc_messages`
  sobrepõe o do servidor.

## As camadas sem dente do `fecho-edges` e os resíduos do Codex (2026-09-28)

**Passo 0 — instância única ou classe? Classe, e varrida.** A classe é a da 2ª leva — sabotagem que
fica VERDE isolada e sai da lista —, e só o `fecho` tinha sabotagem FORA da lista com o `sed` guardado
em comentário (a 2ª leva mediu os 14 sites com a rodada isolada). A medição revelou um irmão: **assert
cujo cenário não alcança o caminho que declara medir**, varrido em todo o bloco do ledger (E16…E16p)
com a pergunta "o cenário chega a CHAMAR o ledger?" — E16f e E16g não chegavam, e o E16h dizia "NEM
é consultado" sem medir a consulta. Os dois resíduos do Codex são **instância**: a varredura dos outros
12 juízes do `test:falsificacao` (delegada; cada "afetado" reconferido no código) mostrou que todos os
que usam `SABOTAGENS` comparam CONTAGEM — o `fecho` era o único juiz de CONJUNTO — e criam o `$tmp`
por rodada (re-execução do script ou `mktemp` dentro da função). Ela trouxe dois achados de OUTRA
classe: o `falsificar-implementado` julga por presença do ID + rc 1 (um crash de `set -u` depois da
marca também sai 1 — o resíduo da camada 4, já com dono em "Gate R4", abaixo); e o
`psql-ro-error-stop` restaura por `git checkout`, em TODA execução (o `trap` não depende do
`--falsificar`), um arquivo que o dirty-check dele não cobre — edição não commitada no gate some calada.
Virou a tarefa **"Impedir que o test-psql-ro apague edição do gate"**.

### A medição, antes de qualquer cenário

Harness fora do repo, com as fixtures da suíte e um TRAÇO de chamadas no stub do ledger; cada trava
tirada sozinha pelo `sed` PRECISO que o bloco "SEM DENTE" guardou, contra cenários candidatos — **23/23
medições com o mesmo veredito em `C` e `pt_BR.UTF-8`** (rc, nº de chamadas, marcas; só o corte de
exibição, por byte × por caractere, e a ordem de um `sort` do harness diferem):

| trava | sozinha, na suíte de 2026-09-27 | o que SÓ ela impede (medido) | caso |
|---|---|---|---|
| l4 — o ledger só com a mecânica OK | verde | a CHAMADA ao CLI com o banco reprovado (0→1); com a worktree defasada, "⛔ ANTES DE AGIR: sincronize" apontando a causa ERRADA | E16h2 |
| l5 — quem respondeu na janela não é candidato | verde | a CHAMADA com a janela decidindo tudo (0→1); com a worktree defasada, o "sincronize" em cima de um DESATUALIZADA já PROVADO | E16f2 |
| `-z "$servido"` — a parceira da l5 | verde (o E16f tinha 1 edge) | com uma 2ª edge puxando a consulta, o CONFERE histórico absolve a `edge-velha`: `LEDGER_CONFERE` no lugar do DESATUALIZADA | E16f, E16g |
| l6 — `-n "$esperado"` | verde | CLI com CONFERE e `observado` VAZIO para edge fora do mapa: `"" = ""` → `LEDGER_CONFERE` | E16g2 |
| via (c) — `exit 2` com o auxiliar falhando | verde | `bun` presente-porém-quebrado: exit 1 e a `edge-fora-do-mapa` some calada | E13d |
| mecânica na classificação — (A) a leitura de `esperado`/`servido`, (B) a condição do NO_AR | A verde, B verde | nada — cada uma torna a outra INALCANÇÁVEL; juntas, o E5e cai com **exit 0 e NO_AR** | par → E5e |

Três diagnósticos do bloco "SEM DENTE" não se confirmaram:

- **A l4 não ficava verde porque "o CLI cai junto".** O E16h já era banco quebrado com CLI são. A
  absolvição, o laço do veredito barra sozinho (com a mecânica reprovada ele nem lê o `esperado`); o
  que SÓ a l4 impede é a chamada — e a chamada não muda a classificação, então nenhum assert a via.
- **l5 e l6 não eram redundantes: era o CENÁRIO que não as separava.** l5 × `-z "$servido"` só se
  cobrem com UMA edge (o ledger nem é chamado); l6 × dupla chave só se cobrem com `observado` real.
- **A mecânica é a única redundância ESTRUTURAL.** Nenhuma entrada torna `esperado` não-vazio com a
  mecânica reprovada, e juntas as duas travas guardam o pior desfecho do script: a mecânica que ele
  próprio reprovou (a linha `#anonimas` sumiu) absolvendo tudo — "nenhum chip", exit 0.

**Decisão do founder (2026-09-28):** a mecânica fica como defesa em profundidade, provada em PAR
(`mecanica_fora_da_classificacao:E5e`, o idioma do par da janela viva); l5 e l6, pelos cenários
próprios.

A mesma pergunta achou uma **6ª trava, que nem estava na lista**: a OUTRA metade do contrato da l5
("o ledger só é consultado quando há a quem perguntar") — edge FORA do mapa não é candidata. Sem ela,
uma janela só com edge fora do mapa chama o CLI (0→1) e, com a worktree defasada, imprime o "ANTES DE
AGIR" sobre uma edge que o ledger nem julgaria; a classificação não muda, então nenhum assert via.
Medida à parte, **7/7 com o mesmo veredito nos 2 locales**, antes do caso E16f3.

### Os cenários

- **E13d** — `bun` presente-porém-quebrado só no PATH do caso (`command -v` o acha; sai 1): exit 2,
  nada classificado, e o stderr dele repassado (`bun-quebrado`) prova que o caso CHEGOU ao auxiliar.
- **E16h2, E16f2 e E16f3** — o stub do ledger registra cada chamada num traço (`LEDGER_TRACE`, na
  rodada). Mecânica reprovada → 0; janela viva decidindo todas as edges → 0; só edge fora do mapa → 0;
  o controle da MESMA rodada (a `edge-muda`, que a janela não decidiu) → 1, senão o zero seria
  ausência de dado.
- **E16f e E16g** ganharam a `edge-muda`, que PUXA a consulta — e o "ledger: sem veredito" dela é o
  controle de que o ledger FOI lido. O `-z "$servido"` cai sozinho nos dois; o par antigo
  (`janela_viva_sem_as_duas_travas`) saiu da lista.
- **E16g2** — o modo `confere-vazio` do stub: CONFERE com `observado` e TODOS os campos seguintes
  vazios para a `edge-fora-do-mapa`. Todos, porque o `IFS=$'\t' read` do alvo colapsa campo vazio (tab
  é espaço-IFS) e o `l_obs` herdaria o campo seguinte. Latente e sem efeito de veredito hoje (nenhum
  campo seguinte é um sha de 64 hex), mas o `LEDGER_DIVERGE` imprimiria campos deslocados.

### A Tarefa 2 — os resíduos do Codex

- **(a) Multiplicidade e recibo.** Cada laço (E5f, E14c2, H1, H2, H4) imprime UM assert por iteração,
  com ID próprio (`H1_<n>`) nos dois ramos, e fecha com o resumo — o ID que a lista declara — também
  nos dois (o E16d já era assim). A suíte termina com `FIM_DA_SUITE locale=<loc> asserts=<n>`. O juiz
  compara o recibo e a LISTA com repetição, e o controle acusa ID repetido (a premissa "um ID, uma
  linha") e recibo incoerente com as linhas (assert sem ID é invisível às camadas 2 e 3). A execução
  normal passou a exigir o recibo e o mesmo nº de asserts nos dois locales: um `return` no meio pulava
  os asserts seguintes EM VERDE.
- **(b) Fixtures.** O tree sujo, a corrida (que nasce EM DIA, sem o reset de antes), o eco do SQL, o
  `pares-shared` e o traço do ledger nascem na rodada. O que continua compartilhado entre as ~100
  execuções virou SÓ LEITURA (`chmod -R a-w`): um caso — ou um alvo sabotado — que escrevesse ali
  falha alto em vez de vazar. O `git` da frescura (`rev-parse`, `diff`/`status` com
  `--no-optional-locks`) lê o repo só-leitura sem tropeçar: a suíte inteira passa com ele.

### A varredura dos `sed` — a única conflada

Na revisão, uma varredura barata: quantas linhas do alvo cada uma das 52 sabotagens muda. Só três
mudam mais de uma — o par da mecânica e a `frescura_antes_da_chamada` (duas edições de propósito) e a
`shared_sem_mapa_ok`, que, sem endereço, trocava os TRÊS `exit 2` de 6 espaços (o do mapa, o do `bun`
ausente e o da via (c)). O vermelho declarado (E13c) vinha da trava certa, mas o E13d caía de tabela.
Agora a faixa começa no `if` do mapa — 1 linha; medido nos 2 locales: `vermelhos: E13c`, onde o `sed`
antigo dava `vermelhos: E13d E13c`.

### A meta-falsificação

Pelo harness da sessão, fora do repo: repo-sombra por variante (o teste é cópia do commit, `scripts/`
por symlink), edições exatas (casar ≠1× = erro da META), `bash -n` antes e o desfecho (rc + marca)
declarado ANTES. Com a máquina em load ~200, a suíte inteira levava 12–16 min por variante; a 2ª forma
do harness REDEFINE a `suite()` só com os blocos que a camada exercita (âncoras exatas), e cada família
de recorte tem o seu controle — o recorte não pode fabricar o verde. O modo normal roda só com o locale
de fora `C` (ele força os dois internos); o `--falsificar`, onde o juiz tem locale, nos dois. Cada
célula: C · pt_BR, ✅ = o desfecho declarado.

| camada | a reprodução | controle | novo | antes |
|---|---|---|---|---|
| as 6 entradas novas | R6: cada trava tirada sozinha → vermelho SÓ no assert declarado | ✅✅ | ✅✅ | a medição de 2026-09-27 (verdes — por isso saíram da lista) |
| a 6ª trava | E16f3 | ✅✅ | ✅✅ | ✅ a suíte de antes, INTEIRA, aprova o alvo sem ela |
| o par da mecânica | só a metade B → o juiz acusa o VERDE | ✅✅ | ✅✅ | — |
| recibo + lista | aborto PARCIAL do laço H1, só na rodada sabotada | ✅✅ | ✅✅ reprova (`recibo [C 12] x controle [C 15]`) | ✅✅ aprovava |
| — sem o recibo | idem | | ✅✅ reprova (a lista pega) | |
| — sem a lista | idem | | ✅✅ reprova (o recibo pega) | |
| recibo por locale | a rodada sabotada roda no locale ERRADO (sempre C) | | ✅✅ reprova | ✅✅ aprovava |
| — sem o recibo | idem — os IDs batem | | ✅✅ ESCAPA: só o recibo vê | |
| recibo na execução normal | `return` no meio da suíte | ✅ | ✅ "NAO chegou ao fim" | ✅ aprovava (verde) |
| um ID por linha | o laço H1 volta a repetir o ID | | ✅✅ o controle acusa | |
| — sem a checagem de repetido | idem | | ✅✅ ESCAPA | |
| tree sujo na rodada | alvo que LIMPA o tree + sabotagem INERTE declarando E16n | ✅✅ | ✅✅ a inerte reprova | ✅✅ aprovava (vermelho emprestado) |
| compartilhado só-leitura | alvo que MOVE a ref do `cli_defasado` + INERTE declarando E16j | ✅✅ | ✅✅ a inerte reprova | ✅✅ aprovava |
| — sem o `chmod a-w` | idem | | ✅✅ ESCAPA: só o só-leitura protege | |
| o `sed` preciso | `shared_sem_mapa_ok` com o `sed` novo × o antigo | | ✅✅ vermelho só no E13c | ✅✅ o antigo derrubava o E13d junto |

Mais as três da 1ª forma, com a suíte INTEIRA (antes de o load a inviabilizar): as duas suítes verdes
contra o alvo íntegro e a via (c) sem o `exit 2` reprovando no E13d, nos 2 locales. **56/56 rodadas
conferem** com o desfecho declarado. A meta não pegou o juiz novo; pegou o próprio HARNESS duas vezes,
antes de valer: a checagem de âncoras rodou em zsh, onde `"$ref:scripts/…"` aplica o modificador `:s`
e o `git show` leu o COMMIT em vez do arquivo (os harnesses rodam em `bash`); e a 2ª forma editava o
corpo da suíte DEPOIS de recortá-la — o bloco editado existiria duas vezes, e o `troca` acusaria.

### Lições

- **"Verde isolada" é relativo ao CENÁRIO.** Das 5, quatro tinham propriedade própria que nenhum caso
  alcançava. Antes de chamar uma trava de defesa em profundidade, pergunte o que SÓ ela impede e se a
  suíte chega lá; redundância de verdade é ESTRUTURAL (uma trava torna a outra inalcançável) — e se
  prova em PAR.
- **Efeito que não muda a saída só se vê por um traço.** A chamada indevida ao CLI não mexia na
  classificação, e a classificação era tudo o que os asserts olhavam. Stub que registra as próprias
  chamadas, com o controle de 1 chamada na mesma rodada.
- **O assert tem de alcançar o que o nome dele promete.** O E16h dizia "NEM é consultado" e media a
  absolvição; E16f e E16g diziam provar o tratamento do veredito do ledger sem nunca o chamar.
- **Vazio = vazio é o modo de falha da dupla chave.** A 2ª chave só é eixo de fora se EXISTIR (`-n`).

## O gate R4 — todo alvo do `test:falsificacao` (2026-09-29)

**Passo 0 — instância única ou classe? Classe** — a mesma; este é o passo 4 (o gate) para a superfície
que o R1/R2 não enxergavam: o `test:falsificacao` roda 27 arquivos, e 17 deles não usam a lista
`SABOTAGENS`. Um teste novo com juiz "exit≠0" entraria no CI sem nenhum gate acusar.

**O gate.** R4 no `falsificar-exige-assert-gate.ts`: cada arquivo que o roteiro EXECUTA — os slugs do
laço, expandidos pelo MESMO parser do `test:hooks` (`arquivosExecutados`, `scripts/lib/lacos-test-hooks.ts`:
dois parsers do mesmo laço divergem no dia em que a forma dele muda), e os comandos fora dele (o
`sonda-cron-prova.ts`) — usa o idioma limpo OU tem juiz registrado, com âncoras. Forma do roteiro que o
fiscal não sabe expandir (`bun run` aninhado, outro interpretador) sobra no RESÍDUO e é INDETERMINADO;
piso de 20 alvos (medidos 27). A âncora de um alvo do roteiro reprova como R4 — inclusive a do `lab-*`
que um slug despacha (`delegadoPor`: o juiz de verdade do `claude-mem-reanimar` e do `retry-pgdg` mora
lá). O `.ts` é limpo pelo stripper de TS, com o sentinela do bloco descartado herdado do
`gate-sonda-autentica`. TDD: 9 testes vermelhos pelo motivo certo antes do código; a 1ª versão errou
num ponto que agora é mutação — `arquivosExecutados` devolve o nome RELATIVO a `scripts/`, e todo slug
virou "não lido".

**A releitura dos 17 (+ 3 delegados).** Mapeados por subagente (hipótese), relidos um a um — a
varredura de 2026-09-27 chamava os que conhecia de "já-corretos"; **três não eram**:

| alvo | o juiz | veredito da releitura |
|---|---|---|
| `codex-async`, `codex-async-nuvem` | `FAIL [<marca>]` + troca 1× + `bash -n` + controle nos 2 locales | identifica o assert (`controle-sem-consulta` cobre mais de um) |
| `vigia-gstack`, `vigia-nuvem`, `instrucoes-carregadas` | exit EXATO 1 + `FAIL [<caso>]`, controle por locale | identifica |
| `pr-watch` | a marca carrega o valor errado exato (`exit: want 0, got 4`) | o mais estrito do grupo |
| `claude-mem-saude` | `FALHA <caso>:` por locale; sabotagem vazia recusada | identifica |
| `gate-senha-bootstrap`, `gates-frescura` | sabotam a ENTRADA; rc EXATO + marcador do ramo | identificam |
| `guard-noop-sabotagem`, `eval-via-morta`, `codex-prompt-paginacao` | linha exata / exit + baseline + recibo / valor exato | identificam |
| `claude-mem-reanimar`, `retry-pgdg` | despacham a `lab-*` (rc 0 + marcador exato); os labs: término + a FALHA declarada / o C0 verde + cada caso | identificam (3 juízes delegados registrados) |
| **`setup-contrato`** | marca por substring na saída INTEIRA do vitest | **afetado** |
| **`medir-footprint`** | "fora da janela", para qualquer lado | **afetado** |
| **`sonda-cron-prova.ts`** | os seis sintéticos defeituosos por `!== 'PASSA'` | **afetado** |

Residual comum aos de `FAIL [<id>]`: sem camada de crash — o assert declarado que inclui o rc também cai
se o alvo MORRER no ramo dele. Registrado no motivo de cada juiz, e pendência com dono (abaixo).

**O R4 no merge real.** No rebase sobre a main, o gate acusou um 18º alvo que ninguém tinha
registrado: `[R4] package.json:87 scripts/test-gstack-auto-upgrade.sh roda no test:falsificacao sem o
idioma SABOTAGENS limpo e sem JUIZ registrado` — o #2655 o pôs no roteiro enquanto este PR corria.
É o caso que o R4 existe para pegar, acontecendo. Relido (o molde do `vigia-gstack`, com a rodada
recortada ao caso-alvo por `SO_CASO`) e registrado; as âncoras do `claude-mem-saude` e do
`vigia-gstack`, que a main também mudou, sobreviveram.

**O R4 no CI (#2660): casar o padrão 1× não é rodar a mutação.** As 17 mutações novas do contrato
do gate tinham o padrão conferido (casa UMA linha), não o dente — o `mutation-check` do 1º push deu
53/55: um INVÁLIDO (o padrão ainda casava `regra: 'R3'`, que virou `regra` quando o `julgarAncoras`
passou a herdar a regra do domínio) e um SOBREVIVE — desligar o ramo "alvo que o fiscal não leu"
fazia o ramo vizinho ("sem idioma e sem juiz") acusar o mesmo alvo com o diagnóstico ERRADO, e o
teste, que casava só o NOME do alvo, aprovava. Consertado casando a MARCA do ramo (o gêmeo em TS do
`toThrow()` pelado); 55/55 local, `--seco` 55/55 cirúrgicos. E o `mutation-check` do push do conserto
saiu `cancelled` no teto de 25 min — como em 8 dos 13 runs recentes de outros PRs (#2650): o PR
entrou sem esse sinal no CI, e a evidência do contrato é a rodada local.

**Os três afetados, medidos antes do conserto:**

- **`setup-contrato`** — sonda num arquivo com um teste vermelho e um verde: o vitest lista o irmão
  VERDE (`   ✓ IRMAO VERDE …`) e o code-frame da falha cita a linha-fonte dele. As marcas 4 e 5 (nomes de
  teste e de describe) e a alternativa `storage funcional` da 1ª casavam com teste verde, bastando
  outro teste do arquivo cair. Conserto: a marca vale só fora das linhas `✓` e do code-frame
  (`linhas_de_falha`), casada por here-string (sob `pipefail`, o `grep -q` que sai cedo mataria o
  estágio de cima).
- **`medir-footprint`** — a sabotagem não declarava o SENTIDO. Conserto: SAB1 tem de CAIR (só a raiz
  não vê a árvore); SAB2 e SAB4, SUBIR. A medição incompleta já era recusada.
- **`sonda-cron-prova.ts`** — medido: os seis dão `FALHA` hoje; nenhum `INVERIFICAVEL`. A folga
  aceitava o harness que não mede e o sintético que não compila. Conserto: classe exata para todos, e
  a `FALHA` que vem do handler que LANÇA (`status -1`, que cai na faixa de status do classificador) é
  recusada.

**A meta-falsificação** (o arquivo de ANTES = `6f22db94b` e o novo, edições exatas, o desfecho declarado
antes de rodar, C e pt_BR):

| alvo | a reprodução (o buraco) | controle | antes aprovava | novo reprova |
|---|---|---|---|---|
| `sonda-cron-prova.ts` | D1 `fallthrough` com import irresolvível → `INVERIFICAVEL` | ✅✅ · ✅✅ | ✅✅ | ✅✅ |
|  | D2 `io-antes-do-metodo` cujo handler LANÇA → `FALHA` pelo status -1 |  | ✅✅ | ✅✅ |
|  | D3 `helper-no-ramo` que não compila → `NAO_COMPILA` |  | ✅✅ | ✅✅ |
| `medir-footprint` | M1 o pico do alvo pesado SOBE na SAB1 — o de antes: "delta caiu para 364MB" | ✅✅ · ✅✅ | ✅✅ | ✅✅ |
|  | M2 o divergente CAI na SAB2 — "delta divergente virou 4MB" |  | ✅✅ | ✅✅ |
|  | M4 o sequencial CAI na SAB4 — "delta virou 50MB (~2x de 200)" |  | ✅✅ | ✅✅ |
| `setup-contrato` (recortado à sabotagem-alvo) | V5 marca = nome de describe; outro teste do arquivo cai (o polyfill de MediaStream) | recorte ✅✅ · ✅✅ | ✅✅ | ✅✅ |
|  | V4 marcas = nomes de teste de DOM |  | ✅✅ | ✅✅ |
|  | V1 a alternativa `storage funcional` |  | ✅✅ | ✅✅ |
| o gate R4 (CLI, no worktree) | F1 slug novo com juiz exit≠0 → `[R4] package.json`; F2 âncora do pr-watch; F3 âncora do juiz DELEGADO de lab (regra do despachante); F4 `bun run` aninhado → INDETERMINADO; F5 âncora do `.ts` só num comentário | ✅✅ | — | 10/10 |

Cada célula: C · pt_BR; ✅ = o desfecho declarado antes. **60/60 conferem**, o controle de cada site nas
duas versões e a árvore limpa depois. **Dois erros da META, registrados:** a 1ª M2 do `medir-footprint`
deslocou o pico em −100 e o deixou NEGATIVO — "medição incompleta" nas duas versões, o que não é
veredito; refeita com −60. E o `mutcheck` do gate chamado direto (sem o `-all`) roda o teste com o
vitest, ignorando o `@test_cmd` do `.mut` — o baseline "vermelho" era o vitest sem arquivo; com
`MUTCHECK_TEST_CMD` explícito, o baseline é verde. **Um defeito do próprio teste do gate:** o controle
positivo no corpo real analisava os ~470 arquivos DENTRO do `it` e estourou o timeout de 20 s com a
máquina sob load average > 100 (1,3 s sem carga); passou a julgar o RECORTE do R4 (alvos do roteiro +
arquivos com juiz), com piso.

**Os que rodam FORA do `test:falsificacao`, com falsificação própria (a avaliação pedida).** Censo dos
57 slugs dos dois laços do `test:hooks`: 31 não estão no `test:falsificacao`, e 13 deles têm marcador
de sabotagem no código. Lidos: 4 são rótulo/fixture (`stop-contexto-caro`, `claude-md-budget`,
`tokens-report`, `posthog-query`); 9 falsificam de verdade dentro da suíte normal.
- `lovable-revert-scan` — correto, e já julga o stderr INTEIRO (o desfecho declarado é silêncio:
  stdout mudo, exit 0, stderr vazio como o do controle). **Registrado** (âncoras).
- o limiar do `bash-contexto-nudge` — exato (exit 0 + exatamente 1 JSON + o nudge), mas o stderr do hook
  sabotado vai para `/dev/null`: entra na camada 4 (PR seguinte), e é registrado lá.
- `sonda-processo-guard` — **afetado**: `[ -n "$(executa …)" ]`, QUALQUER stdout do hook sabotado conta,
  stderr descartado — e a sabotagem é in-place no hook real. `pr-duplicata-guard` (casos "cala") e
  `word-split-zsh-guard` (regras de detecção) julgam por SILÊNCIO sem rc nem stderr — o crash também
  cala, o furo que o `lovable` fechou. Fora do domínio do R4: pendência com dono (abaixo), junto com
  o gate que falta (um R5 para o `test:hooks`).

## A camada 4 por LINHA — o stderr INTEIRO do alvo (2026-09-29)

**Passo 0 — instância única ou classe? Classe** — o resíduo do Codex da 2ª leva, nos 8 laços que o
herdaram (`onde-parei`, `orfaos-custosos`, `read-contexto-nudge`, `ocupacao-por-arquivo`,
`ocupacao-por-comando`, `fecho-edges-pendentes`, `eval-diagnostico-cegueira`, `bash-contexto-nudge`),
mais o `idioma-errexit-leitura`, que passava limpo no R1/R2 sem camada 2 nem 4. A camada comparava a
CONTAGEM de assinaturas do bash entre a rodada sabotada e o controle — dois furos: a sabotagem que
apaga um diagnóstico legítimo do controle e cria um crash real passa por `1 = 1`; e erro de
FERRAMENTA fica fora de qualquer lista-negra (o `usage:` do git que o juiz do `lovable` aprovou).

**Medido antes de mudar (a linha de base).** Rodei o `--falsificar` real dos 8 numa sombra com a
limpeza neutralizada (um shim de `mktemp`: neste macOS o `/usr/bin/mktemp -d` IGNORA o `TMPDIR`) e
contei, no controle, o que a camada de então lia (log + o `.stderr` do `ERROS_DO_ALVO`): **zero**
assinaturas nos 8, nos dois locales — o `1 = 1` estava latente, não ativo. Mas o stderr dos
controles do `ocupacao-*` NÃO era vazio (26 e 58 linhas só nas chamadas que o `ERROS_DO_ALVO`
cobria): ali o stderr é o RELATÓRIO do alvo ("sessões analisadas", `TAXONOMIA-…`), e 7 das 11
sabotagens do `ocupacao-por-comando` o mudavam de propósito. "Sabotada ⊆ controle" ingênuo reprovaria
sabotagem legítima — a medição decidiu o desenho.

**O desenho** (`scripts/lib/falsificacao-stderr.sh`, carregada com `.`):

- **O canal: um EMBRULHO do alvo**, criado só no laço (a suíte normal não muda): roda a cópia, apensa
  o stderr INTEIRO dela a `<log>.stderr` e o devolve no stderr. Toda chamada passa por ele — a que a
  suíte mescla na saída (`2>&1`, antes vista só no dump do assert que falha, às vezes CORTADO em 220
  caracteres), a que ela descarta e a que ela recolhia. Síncrono (arquivo, não `tee` em `>(…)`: o
  processo de fundo sobreviveria ao alvo — fail-open); caminhos ABSOLUTOS de `bash`/`cat`/`rm` (há
  suíte que roda o alvo com `PATH` restrito a stubs); temporário `<arquivo>.<pid>`, fora do `TMPDIR`
  que a suíte aponta para o alvo. A encanação por chamada do #2639 (`2>>"${ERROS_DO_ALVO:-/dev/null}"`,
  23 pontos em 6 arquivos) volta a `2>/dev/null`: o canal agora é o embrulho.
- **Linha nova = FORMA que o controle nunca disse** (normalizada: o caminho da cópia e o diretório
  temporário viram marcadores, o `line N` do bash vira N; os demais dígitos NÃO — `rc=0` ≠ `rc=129`).
  Repetir uma forma que o controle disse não é crash — a menos que a linha tenha assinatura de crash,
  que conta por OCORRÊNCIA (1 no controle, 2 na sabotada = 1 nova). O awk lê o controle por
  `FILENAME == ARGV[1]`, nunca `FNR == NR`: com o controle VAZIO (o caso comum) o `FNR==NR` trataria as
  linhas da sabotada como controle e aprovaria tudo.
- **`declara_stderr <sabotagem> <trecho>`**: o que a sabotagem muda de PROPÓSITO no stderr — o
  `ID!MARCA` do #2606 para a camada 4. Trecho ASCII, específico; trecho vazio aborta (casaria tudo).
- **`linha_de_base`**: cada controle diz em voz alta o que mediu — "stderr do alvo: N linha(s), M com
  assinatura de crash"; arquivo ausente é dito como tal (ausente ≠ zero).
- O log da suíte (o arnês que morre) segue julgado pelas linhas com assinatura de crash — ali o log
  difere do controle por desenho. `camada4` sai sempre 0: o veredito é a SAÍDA (sob `set -e`, um
  status ≠0 mataria o laço em vez de reprovar a rodada).

**Medido depois, com o embrulho** (linha de base dos controles, stderr INTEIRO): `onde-parei` 3 linhas,
`ocupacao-por-arquivo` 45, `ocupacao-por-comando` 74, os demais 0 — **0 com assinatura de crash em
todos**. Rodadas com linha nova: `ocupacao-por-comando` 7/11, todas relatório (`TAXONOMIA-NAO-CLASSIFICADO
n=1 de 1`, `TAXONOMIA-SILENCIOSA`, `TAXONOMIA-QUIETA`, `VER-SHELL n=0`, `ERRO: --ver-shell … (modo atual:
ferramenta)`, a vírgula decimal) → declaradas; `ocupacao-por-arquivo` 1/11 — **`mktemp: too few X's in
template`**, erro de ferramenta que a contagem nunca viu, e que aqui É o vermelho declarado do
`mktemp_so_bsd` (a suíte monta um stub do mktemp GNU para provar que a forma só-BSD quebra) → declarado;
todos os outros laços, 0.

**A meta-falsificação** (o arquivo de ANTES = o da camada por contagem, e o novo; edições exatas numa
sombra do worktree — o hook-base do M1 modificado numa CÓPIA, nunca no repo —, o desfecho declarado
antes, C e pt_BR):

| site | a reprodução (o buraco) | controle | antes aprovava | novo reprova |
|---|---|---|---|---|
| `bash-contexto-nudge` | M1, o resíduo do Codex: o hook-base ganha um diagnóstico LEGÍTIMO com assinatura em toda chamada (a linha de base do controle passa a dizer "28 linha(s), 28 com assinatura de crash"); a sabotagem o troca por um crash REAL (`set -u` + variável inexistente) — o hook morre em toda chamada, 10 asserts caem, e a contagem dá 28 = 28 | ✅✅ · ✅✅ | ✅✅ | ✅✅ |
| `onde-parei` | M2: a sonda chama o `git` REAL com flag inexistente e engole o rc — `unknown option` + `usage: git …`, nenhuma assinatura do bash (o de antes: "✅ … vermelho no assert declarado (P5)") | ✅✅ · ✅✅ | ✅✅ | ✅✅ |
| `ocupacao-por-comando` | M4: a sabotagem que DECLARA `TAXONOMIA-SILENCIOSA n=` ganha um erro de ferramenta NÃO declarado (`sort: unrecognized option`) — a declaração não o engole | ✅✅ · ✅✅ | ✅✅ | ✅✅ |

**24/24 conferem**, cada rodada vermelha com UMA falha, a da avaria. **A meta pegou um defeito meu no 2º
locale:** a declaração do `locale_nao_forcado` tinha sido medida com o shell de fora em C, onde só a
chamada que força a vírgula muda; em pt_BR, TODA linha com percentual muda, e o controle do
`ocupacao-por-comando` ficou vermelho. A declaração virou "vírgula decimal num percentual" (`,D%`) e o
recorte foi refeito. Os 9 laços novos: verdes nos dois locales (o `fecho`, 92/92), e o modo normal das
9 suítes, que o `test:hooks` roda, também.

**No rebase sobre o #2652** (as camadas sem dente do `fecho`, mergeadas antes deste PR): 3 conflitos
no `test-fecho-edges-pendentes.sh` — o `bad()` (o recibo de término deles + o embrulho), o bloco do
alvo e o controle (recibo + IDs únicos deles, linha de base minha) —, resolvidos por FORMA, com o
resolvedor abortando em estrutura inesperada. O `fecho` combinado: controle com 93 asserts, recibo e
IDs únicos, e **1 linha** de stderr do alvo, 0 de crash: `bun-quebrado: saida 1 de proposito` — o stub
do E13d (auxiliar do grafo de imports que FALHA de propósito), repassado pelo alvo. Medida POR FORA, com
o stderr do alvo capturado no modo normal numa sombra; a 1ª sombra, com a cópia do alvo fora da árvore,
ficou vermelha no E13/E13b/E13d/E14b/E14b2 — o auxiliar derivado de `$0` fecha fail-closed, a mesma
armadilha que o espelho do laço documenta — e foi refeita com o espelho. `test:falsificacao` inteiro
sobre o rebase: exit 0.

**O que mais entrou:** o `idioma-errexit-leitura` ganhou as camadas 2 (o recibo `RESULTADO` com o nº
de asserts do controle) e 4; o limiar do `bash-contexto-nudge` julga o stderr INTEIRO do hook sabotado
contra o do hook REAL na mesma entrada (era `/dev/null`); o `eval-diagnostico-cegueira` carrega o bloco
com `.` — sem embrulho possível —, então lá o "stderr do alvo" é tudo o que a rodada imprimiu fora das
linhas de assert e do recibo. O teste da lib (`test-falsificacao-stderr.sh`, no `test:hooks`) tem o
dente provado por 17 mutações (17/17 PEGA). E o `shellcheck-gate` não cobria `scripts/lib/*.sh` — a lib
nova (e o `wt-medida.sh`) entraram no escopo em zero achados.

**Residual, registrado:** (1) alvo cujo stderr é contrato cobra declaração de toda sabotagem nova que
mude o relatório — custo de manutenção, fail-closed (vermelho falso, nunca aprovação); (2) no
`eval-diagnostico`, o que o bloco imprime dentro de `$(… 2>&1)` (D6–D10) é julgado pelos próprios
asserts; (3) o embrulho devolve o stderr DEPOIS do stdout — o controle passa pelo mesmo embrulho (maçã
com maçã), e nenhum dos 9 controles ficou vermelho com isso; (4) os juízes `FAIL [<id>]` fora do
idioma no `test:falsificacao` seguem sem camada de crash (pendência com dono, abaixo).

## A ligação do juiz com a medição — e o registro fechado (2026-09-30)

**Passo 0 — instância única ou classe? Classe.** O achado (Codex, fase 4, média, confirmado por ele
com o gate real): as âncoras do `JUIZES` provavam a PRESENÇA das linhas de aceitação e rejeição, não a
LIGAÇÃO com a medição; o registro era voluntário para quem falsifica na suíte normal; e as âncoras
prendiam espaço e prosa que não sustentam o julgamento (excesso, baixa). É propriedade do MECANISMO —
âncora = substring solta —, não do tint: a varredura (subagente, hipótese; quem decidiu foi o próprio
gate depois) achou a medição fora das âncoras em **35 dos 40 juízes** (26 inteiramente, 9 em parte) e
18 âncoras de pura prosa.

**Reprodução, antes de mexer** (sombra do worktree, edições exatas — casou ≠1× é erro da meta —,
desfecho declarado antes, C e pt_BR, controle verde na mesma invocação) — **20/20**:

| variante no `db/test-tint-promote.sh` | gate de antes |
|---|---|
| a leitura trocada por `DSAB=720` | verde (exit 0) |
| `DSAB=720` inserido logo depois da leitura | verde |
| o ramo `0\|"")` liberado (`ok`) | verde |
| o `case` desligado da variável (`case "720" in`) | verde |
| um ramo pega-tudo antes do `720)` | verde |
| a entrada do tint apagada do `JUIZES` | verde |
| controle+: tirar uma âncora existente | vermelho (a sombra mede) |
| excesso: colapsar o espaço duplo de `720)  ok`; reescrever a prosa do `*)` | vermelho sem mudar o julgamento |

Erro da meta, registrado: a 1ª variante de excesso PREFIXOU recuo — e a âncora, substring, seguiu
casando. O excesso de espaço aparece ao TIRAR espaço.

**O desenho** (`scripts/falsificar-exige-assert-gate.ts`):

- **Forma normal + curinga de prosa.** Âncora e código casam sem recuo e com espaço colapsado; `"…"`
  ou `'…'` numa âncora é UMA string entre aspas (a dupla aceita `\"`), que não atravessa a aspa que
  fecha — a mensagem pode mudar, o código em volta dela não.
- **Bloco.** Uma âncora pode ser um BLOCO: linhas CONSECUTIVAS de código (vazia e comentário não
  contam), cada uma casada INTEIRA. O juízo compacto — a leitura, o `case`, os três ramos, o `esac` —
  vira um bloco: ramo liberado, `case` desligado e ramo inserido rompem, e o diagnóstico diz onde
  ("casa até «X» (linha N), e a linha N+1 não é «Y»").
- **`mede` — a ligação.** Cada juiz declara as variáveis que o veredito julga. O gate acha toda
  ESCRITA delas pela MÁSCARA do stripper compartilhado (`mascaraContexto`: código, nunca string) —
  atribuição, `local`/`export`, `read`, `printf -v`, `for`, `${V:=}`, aritmética, `unset`, `mapfile`, e
  o redirecionamento para `"$V"` (o log que o veredito lê) — e exige: ≥1 escrita numa linha presa
  INTEIRA (a medição presa), nenhuma escrita solta DENTRO do juízo (da medição presa à última âncora
  que lê a variável; em `(( ))` a leitura é o nome nu) e alguma âncora que a leia. **Por que o recorte,
  e não "toda escrita presa":** a varredura mediu `rc=$?`/`saida=` reusados pela suíte normal e pelo
  controle em 24 dos 40 arquivos — "toda escrita" prenderia dezenas de linhas alheias ao juízo (o
  excesso de volta), e fora do juízo a escrita não muda o julgamento (a medição sobrescreve antes; o
  veredito já leu depois).
- **`semLigacao`.** Juiz sem `mede` tem de dizer POR QUE (texto não vazio). Os dois juízes-helper —
  `db-aplicar` (`confere` chamado em ~15 pontos) e `pedido-total` (14 medições INLINE no argumento de
  `vermelha`) — ligam medição e veredito pelo argumento posicional, que o texto não segue: presos o
  juízo inteiro e a primitiva que mede; a ligação é detecção MANUAL documentada, explícita no diff.
- **Registro fechado.** `REGISTRO_FECHADO` lista os 40 arquivos; o `JUIZES` tem de ser exatamente ele.
  Apagar um juiz — voluntário ou não — vira DUAS mudanças no diff; juiz novo fora do registro também
  reprova (senão a remoção dele, depois, voltaria calada).

**A erradicação.** Os 40 juízes reescritos: 38 com `mede` (a medição presa; o juízo compacto em bloco)
e 2 com `semLigacao`. As âncoras de pura prosa viraram a CONDIÇÃO que descreviam, com a mensagem em
curinga (a do `pr-watch` fica: é o VALOR declarado, não prosa). Onde a mensagem traz `$(… "x" …)`
dentro da string — o curinga não atravessa aspa —, a linha fica literal: excesso residual em 9 linhas.

**A falsificação do gate:**

- **ponta a ponta** (CLI numa sombra, C e pt_BR, controle verde PRIMEIRO em cada locale, desfecho
  declarado antes) — **36/36**: as 6 variantes do tint reprovam, e a classe fora dele também — a
  medição do `codex-async` trocada por constante; uma forja entre `suite` e o veredito; o log do
  `transporte-nuvem` escrito à mão; a camada 4 do `data-health` cegada (`erros_sql="$erros_controle"`);
  `S2_DIV` forjado no `medir-footprint` (leitura aritmética); a classe reatribuída no
  `sonda-cron-prova.ts`; o `semLigacao` do `db-aplicar` apagado; o `lovable` (voluntário de
  `scripts/`) apagado do registro. Os excessos (espaço e prosa, no tint e no `vigia-gstack`) ficam
  verdes. Cada vermelho com a marca do seu ramo.
- **propriedades no registro REAL** (vitest, um `it` por juiz): apagar as linhas de QUALQUER âncora
  ou bloco dos 40 reprova com a marca do ramo; uma escrita forjada de QUALQUER variável julgada entre
  a medição e o veredito — ou na própria linha, quando os dois moram nela — reprova pela ligação
  (219 casos, conferidos também por fora do vitest).
- **contrato de mutações** (`scripts/mutcheck.d/falsificar-exige-assert.mut`): 23 novas, uma por
  camada, e as 2 que miravam código que mudou (`limpo.includes`, o `v.push` do juiz não lido)
  reescritas. `--seco`: 78/78 cirúrgicas. Rodada cheia (numa sombra, sob `heavy`): **78 mutações · 77 pegas · 1
  sobrevivente** — a máscara do stripper desligada. Furo do TESTE, não do gate: nos casos "dentro de
  aspas" (`echo "D=720"`) quem excluía era a fronteira do nome (a aspa colada), não a máscara.
  Entraram 4 casos que SÓ a máscara exclui (`echo "texto D=720 dentro"`, `echo "manda > $D"`, a prosa
  em aspas simples, a atribuição dentro do valor de outra) — medidos antes: com a máscara, nenhuma
  escrita; sem ela, 4 —, e a rodada dirigida (controle+ e a mutação) deu **2/2 pegas** (baseline verde), exit 0.
- **as suítes**: `heavy bunx vitest run scripts/falsificar-exige-assert-gate.test.ts` → **190/190**, exit 0;
  `heavy bash db/roda-nucleo-ci.sh` → `SQL_PROOF_OK provas=49/49 falsificacoes=14/14`, exit 0 — os 9 juízes
  de `db/` presos aqui rodam verdes, com os `--falsificar`; `tsc -p tsconfig.scripts.json`, exit 0.

**Erros da meta e do caminho, registrados:**

- a 1ª versão da propriedade reprovou 18 casos que eram dela: forjar logo depois da medição do
  CONTROLE rompe o bloco do controle (vermelho legítimo, com outra marca), e em
  `elif novas="$(camada4 …)"; [ -n "$novas" ]` medição e veredito moram na MESMA linha — "depois" já
  é fora do juízo, e corretamente não reprova. A propriedade passou a forjar ENTRE os dois, ou NA linha.
- 3 expectativas escritas ANTES do código esperavam só "bloco rompeu"; o 1º GREEN (183/186) mostrou
  que o gate acusa também a medição solta — o bloco é tudo-ou-nada: rompido, deixa de prender a
  leitura. O comportamento é o certo; as expectativas foram corrigidas.
- a forma `const|let|var` do TS era redundante (a atribuição já pega `const x = …`) — a mutação que a
  removesse sobreviveria; saiu.
- a revisão do próprio diff achou a âncora VAZIA: `''` casava qualquer linha (verde por vácuo) e o bloco
  `[]` derrubava o gate (`codigo[-1]`) — agora reprova como registro inválido, com teste e mutação.
- `String.raw` interpola `${…}`: a âncora com `${decl//,/ }` virou template comum com `\${`.
- o 1º "RED" não rodou nada: o `heavy` estourou 30 min na fila (a vaga presa 60 min por um
  `roda-nucleo-ci` de outra sessão) — `exit=1` do semáforo, não do teste. Refeito (o teste novo sobre o gate de `origin/main`): **52 de 106
  vermelhos** pelo motivo certo — função ausente (`acharAncora`, `escritasDe`, `julgarRegistro`) ou
  comportamento ausente (a brecha que ficava verde, o excesso que reprovava, o bloco não suportado) —, e
  os 54 de antes, verdes.

**Resíduo, registrado:** (1) a ligação é textual — `eval`, nameref, `printf -v "$1"` indireto e a
escrita por helper num arquivo de caminho literal ficam fora; (2) a forma normal não julga espaço
DENTRO de literal (mudá-lo quebra o casamento em runtime — vermelho falso, nunca aprovação); (3) nos 2
juízes-helper a ligação é manual (`semLigacao`); (4) a tarefa **"Blindar provas db/ contra ~/.psqlrc
(psql -X)"** vai mexer na linha de medição do `pedido-edicao-atomica` (`"$PGBIN/psql" -p …`): o gate
a acusa e a âncora se atualiza no mesmo PR — o gate fazendo o trabalho dele, não fricção a contornar.

## O que ficou de fora, com dono

As fases seguintes da erradicação (fora do núcleo, onde nenhum recibo é confiado às cegas) viraram
tarefas com a assinatura calibrada e a lista de sites no briefing:

- ✅ **"Erradicar falsificação sem assert em db/ fora do núcleo"** — feito ("Afetados de `db/` fora do núcleo", acima): os 4
  afetados, mais o sucessor e o `rpc()`; um aposentado. Risco residual (Codex): dois erros com a MESMA
  linha ERROR numa MESMA medição continuam indistinguíveis pelo log.
  - ↳ ✅ a classe vizinha que ela revelou — prova fora do CI que MORRE e ninguém vê — virou a tarefa
    **"Varrer provas db/ fora do núcleo mortas na main"**, ENTREGUE em
    [provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md): as 261 rodadas uma a
    uma, 12 apodrecidas (8 mortas, 4 vermelhas), 9 delas por re-dump do snapshot; um matador medido
    para cada, a falsificação de authz revivida e a do marcador v2 aposentada; as outras 10 em fases
    por domínio, com dono, e o sensor proposto para a decisão de custo do founder.
- ✅ **"Declarar valor sabotado nas provas db/ com juiz ≠ verde"** — ENTREGUE (seções "Parciais de
  `db/`, fase 1" a "fase 5", acima): os 27 parciais, em 5 fases por domínio, cada uma com a 2ª opinião
  do Codex e a meta-falsificação nos dois locales. Os residuais ficaram registrados em cada seção. A
  série revelou três classes vizinhas, que viraram tarefas com a assinatura calibrada no briefing:
  - **"Erradicar assert principal verde por ausência em db/"** — `IF x <> lit` com `x` NULL (a linha
    sumiu) e `eq … "$(…)" ""` com a leitura que erra;
  - **"Corrigir temporários que colidem em provas db/"** — caminho fixo em `/tmp` (89 linhas em 21
    provas) e `mktemp` com sufixo, que o macOS não troca;
  - **"Blindar provas db/ contra ~/.psqlrc (psql -X)"** — 379 chamadas sem `-X` em 286 provas.
- ✅ **"Erradicar falsificação sem assert no test:falsificacao"** — ENTREGUE na 2ª leva (seção "A fase
  `scripts/`", acima): os 14 de `scripts/` reconfirmados e consertados — 13 lá, e o `eval-via-morta`
  pela fase dos evals do deploy-verify (o PR dela mudou o eval e o juiz juntos).
- ✅ **"Erradicar falsificação sem assert nos evals do deploy-verify"** — ENTREGUE (seção "Os evals do
  deploy-verify", acima): os 3 afetados e 3 parciais, os dois "já-corretos" que a medição desmentiu
  (`run.sh`/classify e o juiz `sabota` do `monitor-deploy-pr-eval`) e o `test-eval-via-morta`, com os
  controles negativos do juiz como gate de reintrodução nos 8.

Da 2ª leva ficaram, com dono:

- ✅ **"Isolar as camadas sem dente do fecho-edges"** — ENTREGUE (seção "As camadas sem dente do
  `fecho-edges` e os resíduos do Codex", acima): as 5 de volta à lista — quatro com o cenário que as
  isola, a da mecânica em PAR por decisão do founder —, a 6ª trava que nem estava na lista (E16f3), o
  irmão que a medição revelou (E16f/E16g sem chamar o ledger) e os dois resíduos do Codex. Deixou, com
  dono:
  - **"Cobrir as travas do edges-pendentes sem sabotagem"** — o resto da classe da 6ª trava no mesmo
    alvo: commit-base não achado (o E14c3 passa por ele e só exige rc≠3), `bun` ausente na via (c), os
    `mecanica_ok=0` de mapa/janela/psql/consulta sem sabotagem (psql ausente × sonda `SELECT 1` parece
    PAR estrutural — decisão do founder) e o exit final;
  - **"Impedir que o test-psql-ro apague edição do gate"** — achado da varredura dos 12 juízes, de
    OUTRA classe: o `trap` restaura por `git checkout`, em toda execução, um arquivo fora do dirty-check.
  - Sem tarefa, registrado: o `IFS=$'\t' read` do alvo colapsa campo vazio do ledger (o `l_obs` herda
    o campo seguinte) — não muda veredito hoje, e o E16g2 vale nas duas leituras (todos os campos
    vazios).
- ✅ **"Gate R4: todo slug do test:falsificacao usa o idioma limpo ou tem juiz registrado"** — ENTREGUE
  (seção "O gate R4", acima): o R4, 19 juízes relidos e registrados, e os 3 "já-corretos" que a
  releitura desmentiu — `setup-contrato`, `medir-footprint`, `sonda-cron-prova` —, consertados com meta
  nos dois locales. O resíduo do Codex na camada 4 (comparar as LINHAS, não a contagem; o stderr
  INTEIRO, não só as assinaturas do bash) — ✅ ENTREGUE (seção "A camada 4 por LINHA", acima).
- **"Estender o R4 ao test:hooks e consertar os juízes por silêncio"** — a avaliação dos que falsificam
  fora do `test:falsificacao` (seção "O gate R4") achou 9 falsificações dentro da suíte normal do
  `test:hooks`, fora de qualquer gate: o `sonda-processo-guard` conta QUALQUER stdout do hook sabotado
  (e sabota o hook REAL in-place); o `pr-duplicata-guard` (casos "cala") e o `word-split-zsh-guard`
  (regras de detecção) julgam por silêncio sem rc nem stderr — o furo que o `lovable` fechou. O gate
  que falta é um R5: o R4 para os slugs do `test:hooks` com marcador de sabotagem (4 falsos-positivos
  medidos: `stop-contexto-caro`, `claude-md-budget`, `tokens-report`, `posthog-query`).
- **"Camada de crash nos juízes `FAIL [<id>]` fora do idioma"** — os juízes registrados no R4 que julgam
  pelo ID do caso (`codex-async`, `codex-async-nuvem`, `vigia-*`, `instrucoes-carregadas`, `pr-watch`,
  `claude-mem-saude`) aceitam o vermelho do assert declarado que caiu por CRASH do alvo (o
  `stdin-herdado` do codex-async inclui o rc); o `controle-sem-consulta` cobre mais de um assert.
  Depende da lib da camada 4 (`scripts/lib/falsificacao-stderr.sh`, PR seguinte).
