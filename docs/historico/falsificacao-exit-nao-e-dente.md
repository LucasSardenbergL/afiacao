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

## O que ficou de fora, com dono

As fases seguintes da erradicação (fora do núcleo, onde nenhum recibo é confiado às cegas) viraram
tarefas com a assinatura calibrada e a lista de sites no briefing:

- ✅ **"Erradicar falsificação sem assert em db/ fora do núcleo"** — feito ("Afetados de `db/` fora do núcleo", acima): os 4
  afetados, mais o sucessor e o `rpc()`; um aposentado. Risco residual (Codex): dois erros com a MESMA
  linha ERROR numa MESMA medição continuam indistinguíveis pelo log.
  - ↳ a classe vizinha que ela revelou — prova fora do CI que MORRE e ninguém vê — virou a tarefa
    **"Varrer provas db/ fora do núcleo mortas na main"**.
- **"Declarar valor sabotado nas provas db/ com juiz ≠ verde"** — os 27 parciais de `db/`, no padrão do
  `vermelha` com 4º argumento do pedido-total (em fases por domínio). **Fase 1 (sensores, 5) feita —
  acima.** Seguem, com a mesma sessão como dono: farmer (5: `desfecho`, `geracao-vigente`,
  `head-geracao`, `melhor-individual-bulk`, `margem-server-side`), preço/custo/margem (5, com o ritual
  Codex), tint + reposição/pedidos/tático (6), authz/RLS + dados (6).
- **"Erradicar falsificação sem assert no test:falsificacao"** — os 10 afetados e 4 parciais de
  `scripts/`. Esses rodam no CI (`test:falsificacao`, no job `validate`): um vermelho de erro alheio
  lá também aprova. O `test-eval-via-morta` saiu desta fase para a dos evals (combinado entre as duas
  sessões): o conserto do eval da sonda muda o desfecho que ele declara.
- ✅ **"Erradicar falsificação sem assert nos evals do deploy-verify"** — ENTREGUE (seção "Os evals do
  deploy-verify", acima): os 3 afetados e 3 parciais, os dois "já-corretos" que a medição desmentiu
  (`run.sh`/classify e o juiz `sabota` do `monitor-deploy-pr-eval`) e o `test-eval-via-morta`, com os
  controles negativos do juiz como gate de reintrodução nos 8.
