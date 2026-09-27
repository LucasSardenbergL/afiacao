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
conta como vermelha com as **três camadas**:

1. a sabotagem **aplicou** (a linha `SABOTAGEM ATIVA em` está no log);
2. a suíte rodou **inteira** (PASS+FAIL do recibo = o do controle — aborto no meio não é assert);
3. **cada** assert declarado está verde no controle e vermelho aqui.

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
**10/10 em `LC_ALL=C` e 10/10 em `pt_BR.UTF-8`:**

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

A camada 2 é a ÚNICA que pega o aborto; a 3, a ÚNICA que pega o assert errado. A 1 é redundante para
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
aceita qualquer vermelho" é recusado por escrito) e o `vermelha_por` do pedido-total.

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

- **R1** — toda lista `SABOTAGENS=` declara, em CADA entrada, `nome:ID` (IDs alfanuméricos por `,`/`|`).
  Entrada nua é o defeito; curinga (`a:.*`) é o defeito disfarçado; lista vazia não prova nada.
- **R2** — o laço `for X in $SABOTAGENS` extrai `${X#*:}` e ela chega a um `grep` (direto ou por um
  `for` interno). Declarar e descartar é a entrada nua com outra cara.
- **R3** — cada `falsificar=<n>` do `db/nucleo-ci.txt` tem um JUIZ registrado (o motivo + as âncoras de
  código sem as quais ele volta a aceitar qualquer vermelho); os dois juízes da suíte normal consertados
  aqui também estão registrados.

O laço de antes (`0906c17c2`) fica vermelho com 13 R1 + 1 R2; o repo de hoje passa com exatamente o
denominador medido (455 arquivos, 3 listas, 24 entradas, 3 laços, 4 linhas do núcleo). As mutações
que provam o dente de cada camada: `scripts/mutcheck.d/falsificar-exige-assert.mut`.
Medido: **28/28 PEGA**, 0 sobreviventes, 0 inválidas, controle+ ✓.

**O que o texto não alcança, de propósito:** fora do núcleo, cada laço tem o seu idioma (sentinela,
SQLSTATE, conjunto de IDs, valor exato) — uma regra textual única reprovaria em massa ou aprenderia um
idioma por arquivo. E âncora não prova semântica: só torna vermelha a REMOÇÃO da linha que sustenta o
juiz. Quem prova o juiz é a meta-falsificação acima.

## Lições

- **Exit≠0 não é dente, e "≠ verde" também não.** O vermelho que conta é o do assert que a sabotagem
  declara: nome do assert no log, valor exato, marca do ramo. Qualquer idioma que aceite "algo deu
  errado" aprova sabotagem que não aplicou, aborto e erro alheio — e o runner, que só lê recibo, junto.
- **Juiz estrito descobre defesa em profundidade.** O G3 só passou a ser julgado de verdade quando o
  juiz exigiu a marca: a recusa do D7 some e a D12 barra. Declarar o que vem NO LUGAR é o que separa
  a segunda camada de um erro qualquer.
- **Varredura delegada é hipótese.** Um "já-correto" do subagente caiu na primeira medição.

## O que ficou de fora, com dono

As fases seguintes da erradicação (fora do núcleo, onde nenhum recibo é confiado às cegas) viraram
tarefas com a assinatura calibrada e a lista de sites no briefing:

- **"Erradicar falsificação sem assert em db/ fora do núcleo"** — os 4 afetados de `db/`.
- **"Declarar valor sabotado nas provas db/ com juiz ≠ verde"** — os 27 parciais de `db/`, no padrão do
  `vermelha` com 4º argumento do pedido-total (em fases por domínio).
- **"Erradicar falsificação sem assert no test:falsificacao"** — os 10 afetados e 4 parciais de
  `scripts/`. Esses rodam no CI (`test:falsificacao`, no job `validate`): um vermelho de erro alheio
  lá também aprova.
- **"Erradicar falsificação sem assert nos evals do deploy-verify"** — os 3 afetados e 3 parciais de
  `.claude/skills/lovable-deploy-verify/evals/`.
