# Saldo de conta corrente fresco e NCG por leitura pontual (plano v3, itens 2 e 3)

**Data:** 2026-10-26 · **Edges:** `fin-cashflow-engine` `v2.0-saldo-cc-fresco` · `fin-valor-engine` `v1.1-ncg-leitura-pontual` · **Publish:** sim (`src/` muda o que a Posição Agora e o Cockpit exibem) · **Migration:** nenhuma · money-path.

## Item 2 — saldo ausente ou velho entrava no caixa como número

### Por que

O `omie-financeiro` lê o saldo de cada conta pelo extrato (`ListarExtrato`). Quando o extrato falha, o upsert **preserva** o saldo anterior: não mexe em `saldo_atual` nem em `saldo_data` (`omie-financeiro/index.ts:680-700`). Nenhum leitor conferia `saldo_data`, então um saldo de dias atrás entrava com cara de hoje. E dois leitores somavam conta sem saldo como zero:

- `getCapitalDeGiro` (`financeiroService.ts`): `(c.saldo_atual || 0)` → `saldo_cc`, `capital_giro_liquido`, `saldo_projetado_30d` (Posição Agora: KPIs, Projeção 30d, Comparativo, Stress Test);
- `fin-cashflow-engine`: `Number(c.saldo_atual ?? 0)` → saldo inicial das 13 semanas, NCG, dias de cobertura e tesouraria, persistidos pelo cron.

### O que a medida mostrou (psql-ro, 2026-10-27 01:23Z)

- 40 contas ativas (colacor 15, colacor_sc 10, oben 15): 0 com `saldo_atual` nulo, 0 com `saldo_data` nulo, todas com `saldo_data` = 2026-10-26. O bug estava **latente**: a correção não muda nenhum número de hoje.
- `saldo_data` é **DATE** (o dia de SP em que o extrato respondeu), não timestamp.
- `saldo_atual` tem **DEFAULT 0**. Uma conta nova cujo 1º extrato falhe nasce "R$ 0" com `saldo_data` NULL, e o `saldo_atual == null` do `saldoIndisponivel` antigo nunca dispararia (money-path §2, "valor com DEFAULT constante não é fato"). O sinal confiável de ausência é `saldo_data` NULL: o writer só grava os dois juntos.
- `fin-sync-base-diario` (jobid 75) roda `0 6 * * *` UTC = 03h SP, todos os dias.

### A regra

`classificarSaldoConta` (espelho verbatim `src/lib/financeiro/saldo-contas.ts` ↔ `fin-cashflow-engine/saldo-contas.ts`, paridade no vitest) recebe a referência `{ hoje, minimo }` em dias de SP, com `minimo` = o dia de SP de (agora − 4 h):

- **fresca**: `saldo_data ≥ minimo`. Das 04h SP em diante só o saldo de HOJE vale; antes das 04h, o de ontem ainda é o último possível (o sync de base roda às 03h).
- **velha**: anterior a `minimo`.
- **desconhecida**: `saldo_data`/`saldo_atual` nulo, valor ilegível, data ilegível ou futura.

**A 1ª versão estava errada**, e quem pegou foi o revisor adversário: "hoje ou ontem" aceitava o caso mais comum, UM sync perdido, por ~21 h do dia. A engine de caixa (`fin-cashflow-snapshot-diario`, `0 10 * * *` = 07h SP) gravava sobre o saldo de ontem sem marca. O plano falou em 36 h; com a coluna DATE e o sync às 03h, o eixo certo é "o sync de hoje já devia ter rodado".

Consumidores:

- **Tela** (`resumirSaldoContas`): qualquer conta não fresca, ou nenhuma conta ativa → `null` + motivo. Vale para:
  - `getCapitalDeGiro`: `saldo_cc`, `capital_giro_liquido` e `saldo_projetado_30d` passam a `number | null`; `saldo_cc_motivo` é novo;
  - `getResumoFinanceiro`: `saldo_total_cc`, cujos consumidores já tratavam `null`. Agora ele também pega a conta velha e a do DEFAULT 0;
  - o drill-down de Caixa (`CockpitDrillDown`), que antes dizia "Total: R$ X" ao lado do KPI "—".

  O consolidado fica `null` se UMA empresa estiver indisponível. KPIs, Projeção e Stress Test mostram "—" e o motivo, sem alerta de déficit. No cockpit, o `catch` do resumo devolvia `{}`, e o `reduce` dava R$ 0 de caixa: agora o resumo vazio também é indisponível.
- **Edge** (`saldoInicialDasContas`): a conta desconhecida **lança**, como a lista vazia já lançava (`exigirLinhas`). A conta velha **entra datada até 7 dias** e, além disso, lança. Conta parada há semanas não é "datada", é morta. O motivo vai para:
  - `confianca_dados.motivos` (NCG e Ciclo);
  - `confianca_dados.saldo_inicial`, exibido na tela das 13 semanas, onde é verdade;
  - `premissas.saldo_cc_parcial` do snapshot, para a marca não ficar só na resposta.

  O texto não diz que a NCG usa o saldo: ela é ACO − PCO. Lançar por UMA conta derrubaria a NCG e o Ciclo, que nem a usam.

### Fora do escopo (registrado, não mexido)

- **RPC SQL `fin_projecao_13_semanas`** (achado do revisor, conferido no `pg_proc` de prod): `COALESCE(SUM(saldo_atual), 0) … WHERE ativo`, sem `saldo_data`. Lista vazia vira R$ 0, conta nula sai da soma e saldo velho conta como de hoje. Consumidores: `CaixaCompraCard` (decisão de compra) e `useFinanceiroZone`. Pede migration (`CREATE OR REPLACE` com pré-voo `pg_get_functiondef`), e por isso é follow-up próprio. → **Resolvido** na seção "Item 2, na RPC" abaixo.
- ~~Os alertas `fin_alertas` gerados no mesmo run não carregam o motivo do saldo datado (o snapshot carrega).~~ Fechado em 2026-10-31 (seção "As 4 lacunas").

- ~~O data-health por empresa usa `max(saldo_data)` (`db/aplicar-sync-reprocess-degradado-vigiadas.sql:37-38`): uma conta fresca esconde as velhas. A tela e a engine agora olham conta a conta, então a lacuna sobra só no sensor.~~ Fechado em 2026-10-31.
- ~~O produtor: `DROP DEFAULT` de `saldo_atual` (gravar NULL de verdade) seria migration. O consumidor já trata `saldo_data` NULL como ausente, então o DEFAULT não chega mais à soma.~~ Fechado em 2026-10-31.
- ~~A lista `contas_correntes` do resumo ainda exibe `saldo_atual ?? 0` por conta.~~ Fechado em 2026-10-28 (seção "Item 2, na lista por conta").

## Item 3 — o cockpit de valor lia os snapshots de NCG com o eixo errado

### Por que

`fin-valor-engine` lia `fin_projecao_snapshots` com `order(snapshot_at desc).limit(400)`, sem janela e com o `error` descartado (`const { data: snaps }`). A engine A1 grava 3 cenários por dia por empresa (a NCG independe do cenário), então 400 linhas ≈ 133 dias. O ponto −12m do ROIC incremental (`acharCapitalGiroAnterior`, 365 ± 60 d) estaria sempre fora: o incremental sairia "histórico insuficiente" para sempre, em silêncio. E uma falha de leitura virava "sem snapshot de NCG — rode a engine A1".

### Medida (psql-ro, 2026-10-27)

colacor 427, colacor_sc 439, oben 433 linhas. As 400 mais recentes já cortam em 2026-06-02/06/04. O snapshot mais antigo é de 2026-05-25. Há 0 NCG nulo e 0 NaN. Índice `fin_proj_company_snap_idx (company, snapshot_at DESC)`. O −12m passa a existir em ~2027-03-26 (2026-05-25 + 365 − 60 d), e o founder lê o ROIC incremental.

### A regra

Aumentar o limite só adia (o teto é o EIXO, [roteirizador-corte-cidades.md](roteirizador-corte-cidades.md)). `lerSnapshotsNcg` (`fin-valor-engine/snapshots-ncg.ts`) faz duas leituras pontuais, independentes do volume:

1. a mais recente com NCG não nula (`limit 1`);
2. a vizinha de cada lado do alvo (recente − 365 d): `lte` desc `limit 1` + `gte` asc `limit 1`.

`acharCapitalGiroAnterior` (intocado, espelho do `src`) escolhe a mais próxima e aplica a tolerância: é o mesmo vencedor da varredura do histórico inteiro. Erro no ponto atual → **500**, como a DRE logo acima no mesmo handler. Erro em qualquer vizinha → só o ponto atual + motivo "Falha ao ler o NCG do ponto −12m", e o incremental fica indisponível sem dizer "histórico insuficiente". O teste Deno prova com 1.260 linhas que o −12m é lido, e que as 400 mais recentes não o contêm.

Diferença aceita: um NCG `NaN` no ponto mais recente agora deixa o giro indisponível (antes caía no anterior válido). Hoje há 0 NaN, e o efeito é fail-closed.

## Deploy (2026-10-27)

- **Merge:** #3347, `8d901e947`, 02:22Z. O "Lovable update" seguinte não tocou nenhum arquivo da entrega (`git diff --stat 8d901e947 origin/main` vazio nos caminhos dela).
- **Edges:** `pendencias:deploy` acusou exatamente as duas (`DIVERGE_P1`; as outras 81 conferiam).
  - Pacote `626ab9a9d9ae`, colado pela sessão via MCP às 13:59:10Z. Custou 1,8 crédito.
  - O agente rodou `sha256sum -c` dos 19 arquivos contra `19d07a628` (exit 0). As duas edges ficaram **Active** (401 com credencial inválida), e a resposta terminou com `No files were edited.`.
  - O `lovable-sensor-edicao` 6,5 min depois deu `SEM_EDICAO` (0 commits `gpt-engineer-app`).
- **Sonda:** `db/2026-10-27-sonda-disparo-fin-cashflow-v2.0-fin-valor-v1.1.sql`, pelo envelope (`--ensaio` ok, recibo #722). O Passo 2, lido pelo psql-ro, deu **DEPLOY CONFIRMADO** nas duas, HTTP 200: `v2.0-saldo-cc-fresco` e `v1.1-ncg-leitura-pontual`.
  - `bun run pendencias:deploy` saiu com **exit 0** ("✅ confere — 83").
- **Publish:** feito pelo founder no editor (o da sessão tinha sido negado). Conferido em 2026-10-28 01:03Z: o HTML de `steu.lovable.app` trocou `/assets/index-DD-kF4y9.js` → `/assets/index-Bicgy1Ig.js`. Bytes = disponibilidade, não adoção: o PWA troca de build quando o cliente aceita a atualização. Histórico da tentativa: O workspace estava em `669aa9c62` (= `origin/main`, contém o #3347), mas o `deploy_project` pela sessão foi negado pelo classificador do modo auto ("Production Deploy"). O bundle de produção antes do Publish é `/assets/index-DD-kF4y9.js`.
  - Prova depois do Publish: esse nome tem de mudar no HTML de `steu.lovable.app`.
  - Até o Publish, a Posição Agora, o Cockpit, o drill-down e o aviso das 13 semanas servem o build velho. As edges já servem a regra nova: a resposta da engine traz `confianca_dados.saldo_inicial`, que o build velho só ignora.

## Item 2, na RPC — `fin_projecao_13_semanas` (2026-10-28)

### Por que

Era o "Fora do escopo" acima. A RPC SQL somava `COALESCE(SUM(saldo_atual), 0) … WHERE ativo` sem olhar
`saldo_data`, e alimenta o `CaixaCompraCard` (piso das 13 semanas × fila de compras). Corpo de prod
conferido em 2026-10-28 01:45Z: md5 do `prosrc` `ec1db10e…` = o da `20260927202603` (repo == prod). ACL
`authenticated, service_role` (= `db/lib/corpo-vivo-acl.sql:149`), dono `postgres`.

### A regra

Migration `20261028014827_projecao_13s_saldo_inicial_fresco_ou_nulo.sql`, molde TRAVA → PRE (md5 exato) →
`CREATE OR REPLACE` → POS (md5, `STABLE`, `SECURITY DEFINER`, não-`STRICT`, `search_path=public`, 2
defaults, dono, EXECUTE só de `authenticated`/`service_role`). Só o ramo `p_saldo_inicial IS NULL` muda:

- o saldo inicial é a soma das contas ativas do escopo (`p_company`, ou todas) **só** quando todas são
  frescas. Senão é `NULL`, e o `saldo_projetado` das 13 semanas sai `NULL`. `entradas_previstas`,
  `saidas_previstas` e `fluxo_liquido` seguem;
- `NULL` quando não há conta ativa, quando alguma tem `saldo_data`/`saldo_atual` `NULL`, NaN ou ±Infinity,
  ou quando alguma tem `saldo_data` fora de `[minimo, hoje]`;
- a régua é a de `classificarSaldoConta`: `hoje` = dia de SP de `now()`, `minimo` = dia de SP de
  `now() − 4 h`. As 4 h são subtraídas **antes** da conversão de fuso, como o TS faz com milissegundos;
- `now()` (a função é `STABLE`). Via PostgREST cada RPC é a própria transação, então `now()` é o instante
  da chamada.

`saldo_atual` em prod é `numeric(15,2)`, que não guarda ±Infinity. O filtro de infinito é defensivo.

Consumidores conferidos antes do apply: `pisoProjecao` pula a linha `NULL` (nenhuma válida → "projeção
indisponível"); `useFinanceiroZone` mostra "—". Ninguém no repo passa `p_saldo_inicial`.

### Prova

`db/test-projecao-13s-saldo-fresco.sh`, no núcleo do CI (46 asserts, `falsificar=16`):

- PG17, relógio controlado (`public.now()` lendo `test.agora`, TRIPWIRE sem ela), sessão UTC e SP;
- predecessor = corpo de prod (md5 conferido), PRE recusa deriva (K1), re-apply idempotente, ACL
  preservado, `4 h` da SQL = `HORAS_TOLERANCIA_SYNC_BASE` do TS;
- 18 casos × 2 sessões. Destaques: 03:59:59 × 04:00:00 SP; 22h SP, quando o UTC já é amanhã; consolidado
  contaminado só sem `p_company`; `p_saldo_inicial = 0` e `NULL` explícito; saldo zero e negativo;
- gate: `authenticated` não-staff e sem uid caem no 42501 do gate, `anon` cai no ACL;
- 16 sabotagens num espelho, com o md5 literal recalculado para a POS não as barrar, e controle verde na
  mesma invocação. Medidas em `lc_messages` `C` e `pt_BR.UTF-8`: 16/16 vermelhas nas duas.

O Codex apontou um mutante equivalente: tirar só o `v_contas = 0` não muda nada, porque `SUM` do vazio já
é `NULL`. A sabotagem do vazio tira a condição **e** põe o `COALESCE(…, 0)`.

### Codex (desenho, 126 s, 91,5k tokens): "OK com ajustes"

Entraram: o mutante equivalente acima, a soma parcial como mutante, a POS mais larga, o typmod real da
coluna na fixture, as 13 linhas exigidas em todo caso e o gate testado como `authenticated` não-staff.

Ficaram de fora, todos anteriores a esta entrega:

- **Piso semanal ≠ piso de caixa.** O mínimo dos fechamentos semanais não é o mínimo intrassemanal: uma
  compra à vista hoje pode furar o caixa antes de um recebimento na sexta da mesma semana. O card afirma
  "não rompe os fechamentos semanais projetados", não "não fura o caixa".
- **`staleTime` do `CaixaCompraCard`** (5 min, sem refetch periódico nem no foco): uma leitura feita às
  03:59 pode continuar na tela depois das 04h. É o mesmo regime de toda tela TS do item 2.
- **`search_path = public` sem `pg_temp` no fim** em `SECURITY DEFINER`: uma tabela temporária homônima
  precederia `public`. Para explorar, o chamador precisaria de SQL cru. É padrão de dezenas de funções do
  repo, não desta.
- `types.ts` declara `saldo_projetado: number` (gerado pelo Lovable).

### Apply (2026-10-28)

- **Merge:** #3383, squash `cd21d4cc7`, 02:52Z. O 1º CI reprovou no contrafactual de
  `scripts/fuso-da-sessao-em-migrations-e-skills-gate.test.ts`: tirar só a migration do fuso já não
  ressuscitava a `fin_projecao_13_semanas` morta, porque esta migration a redefine depois. O conserto foi
  tirar também a sucessora no contrafactual (`SUCESSORAS_DO_FIX`), sem afrouxar a asserção.
- **Pré-voo** às 03:10Z: corpo vivo `ec1db10e…`, o predecessor.
- **`bun run db:aplicar`** da `main` (`f03a8d89c`), sha256 `62bb53a5…`: tentativa **#742** virou recibo,
  exit 0. Antes do merge, o `--ensaio` tinha passado.
- **2ª testemunha** (`psql-ro`, 03:11Z): md5 `dc22fe016ea307694ea1426cd75e011f`. Seguem como estavam
  `STABLE`, `SECURITY DEFINER`, não-`STRICT`, `{search_path=public}` e o dono `postgres`. O ACL também,
  com EXECUTE só para `authenticated` e `service_role` (anon e PUBLIC `f`).
- **`bun run deriva:corpo:prod`:** exit 0, 422 identidades batem com `origin/main@f03a8d89c`.
- **Dado real no instante do apply** (00:11 SP): 40 contas ativas, todas com `saldo_data` 27/10. A
  janela ainda aceita ontem antes das 04h, então havia 0 inválidas e a projeção seguia numérica. Das 04h SP
  em diante o saldo de hoje passa a ser exigido: se o `fin-sync-base-diario` das 03h falhar, o card mostra
  "projeção indisponível" em vez do saldo de ontem.
- Nenhuma edge nem Publish: a mudança é só de banco, e os consumidores já tratavam NULL desde o #3347.

## Item 2, na lista por conta da Visão Geral (2026-10-28)

O resumo (`getResumoFinanceiro`) já devolvia `saldo_total_cc: null` pela régua, mas a lista `contas_correntes` normalizava `saldo_atual ?? 0`. A aba Visão Geral exibia a conta sem extrato como "R$ 0,00". Pior: o filtro de "zeradas" (`saldo_atual !== 0`) a escondia atrás do botão "Mostrar N contas zeradas". E a conta velha aparecia com o valor de dias atrás.

- `saldoExibivelDaConta` (`src/lib/financeiro/saldo-contas.ts`, fora do bloco espelhado) aplica `classificarSaldoConta` conta a conta. Fresca → o número, inclusive 0. Velha → `null` + "Saldo de dd/mm/aaaa: o extrato não atualizou". Desconhecida (nula, DEFAULT 0 sem `saldo_data`, data futura) → `null` + "Sem saldo do extrato".
- `FinResumo.contas_correntes[].saldo_atual` passa a `number | null`, com `saldo_motivo` novo. A aba mostra "—" + motivo. Só o saldo FRESCO igual a zero conta como zerada, e a indisponível fica sempre visível.
- Prova: os testes de helper, serviço e aba. A falsificação teve controle verde na mesma invocação e depois 5 sabotagens, todas vermelhas no teste delas: serviço de volta ao `?? 0`, velha com o valor antigo, desconhecida → 0, aba escondendo a indisponível, aba exibindo `fmt`.
- Deploy: só **Publish** (`src/`), pelo founder. Sem edge, sem migration. Hoje nenhum número muda: as 40 contas estão frescas.
- **Publish conferido (2026-10-29):** #3400 mergeado em `54fbca760` (22:34Z de 28/10). O HTML de `steu.lovable.app` trocou `/assets/index-Bicgy1Ig.js` → `/assets/index-DDyRhNXy.js`. Dos 354 chunks, `financeiroService-Rwr8N7KX.js` traz "Sem saldo do extrato" e "o extrato não atualizou", e `FinanceiroDashboard-CkCsIvVQ.js` traz `saldo_motivo`. Bytes = disponibilidade, não adoção: o PWA troca quando o cliente aceita a atualização.

## As 4 lacunas que sobraram (2026-10-31)

Medida de partida (psql-ro, 2026-10-31 ~19:00Z): 62 contas, 40 ativas (colacor 15, colacor_sc 10, oben 15), todas com `saldo_data` 31/10; 0 com `saldo_data` ou `saldo_atual` NULL. O sync das 03h gravou as 40 entre 03:00:12 e 03:00:30 SP: a virada das 04h tem ~1 h de folga. Nenhum número muda hoje: as quatro eram latentes.

### 1. `CaixaCompraCard` (#3401)

- **Piso semanal ≠ piso de caixa.** O piso passa a ser o MIN entre o saldo de HOJE e os 13 fechamentos. "Hoje" = `saldo_projetado[0] − fluxo_liquido[0]`, que é exatamente o saldo inicial da RPC (a semana 0 parte dele). O caso do issue (saldo R$100, compra R$500, +R$1.000 na sexta) agora acusa −R$400. Sem a semana 0 numérica, o card fica indisponível: um piso só de fechamentos não pode ter cara de piso de caixa. A conta é em centavos (`1100,10 − 1000` dava `100,0999…`, e uma fila de R$100,10 "furava" um caixa que zera).
- **O que o card ainda NÃO vê, e agora diz:** o dia a dia dentro de cada semana (um pagamento antes de um recebimento da mesma semana) e os títulos vencidos antes desta semana (fora da RPC inteira). O limite pessimista (início da semana − todas as saídas) foi rejeitado: acenderia "fura caixa" quase toda semana.
- **A leitura não atravessa a virada.** A chave da query carrega o `minimo` da régua e vale `null` em 03:55–04:05 SP (`chaveFrescorDaLeitura`, folga de ±5 min para o relógio do aparelho divergir do banco). Nessa janela o card não lê nem exibe o número e diz "Virada diária do saldo bancário". Um timer (`msAteMudarChaveFrescor`, busca binária sobre a própria régua, sem supor o offset de SP) e a volta da aba (`visibilitychange`) re-renderizam o card na hora certa.
- **Codex (desenho, xhigh, 417 s, 149k tokens): reprovado, com 2 P1 e 1 P2.** Entraram: a margem do relógio (P1, ele reproduziu com 10 s de adiantamento: o saldo de ontem ficava na chave nova até a virada seguinte), os centavos (P2) e a nota sobre os vencidos. O outro P1 está no item 2.
- **Codex (código, xhigh, 299 s, 143k tokens): reprovado, com 1 P1 e 1 P2, os dois consertados.** O P1 era uma corrida entre o render e o efeito, que ele reproduziu com React Query real e StrictMode. O render das 03:54:59.990 pegava a chave de antes, o efeito das 03:55:00.010 agendava direto para 04:05, e às 04:00:01 a tela ainda mostrava o saldo de ontem. Agora o efeito confere a chave e força o render quando ela divergiu, com teste próprio. O P2: o manifesto do núcleo exigia 11 sabotagens, e a prova tem 10.
- Residual: relógio do aparelho divergindo mais de 5 min do banco. `useFinanceiroZone` lê a mesma RPC com `refetchInterval` de 5 min: a janela dele é ≤ 5 min e ele é KPI do dashboard, não decisão de compra.

### 2. Sensor `saldo_bancario` conta a conta

Migration `20261031191715_data_health_saldo_bancario_conta_a_conta.sql`, molde TRAVA → PRE (md5 `1eb65dcd…`, prod = `20261028000116`) → `CREATE OR REPLACE` → POS. O corpo antigo era `max(saldo_data)` de **todas** as contas (não por empresa), com `> 36 h` e cast do DATE no fuso da sessão: uma conta fresca escondia as outras 39. Agora cada conta ativa passa pela régua de `classificarSaldoConta`, igual à da RPC. broken = nenhuma ativa ou alguma desconhecida (NULL, NaN, data futura); stale = alguma velha; ok = todas frescas. A message conta as contas fora da régua por empresa, em ordem alfabética, e a data mais antiga. `expected_max_age_seconds` = 28 h é metadado (D é fresca até 04:00 SP de D+1); quem decide é a data. Uma linha só: três linhas com o mesmo `source` quebrariam o `.find()` do banner e o laço do watchdog.

**O sensor não vira e-mail, e isto ficou como está.** Achado do Codex, conferido na prod: `saldo_bancario` não está no `v_sources` do `data_health_watchdog` (nenhum check do financeiro está). O check aparece no `/health` e no `DataHealthBanner` da Visão Geral. Ligar o push é sensor novo, e não há incidente que o peça (CLAUDE.md, "máquina meta nova"). Hoje a defesa de quem decide está nas telas, que já mostram "—" com o motivo.

Prova `db/test-data-health-saldo-bancario-conta-a-conta.sh` (PG17, cadeia viva do trio, relógio controlado). O controle `A23` reproduz o defeito no corpo de prod: ok com 1 conta parada há 8 dias. Bordas: 03:59:59 × 04:00:00 SP em sessão UTC e SP, 22h SP, desconhecida (NULL, NaN, futura), inativa fora, nenhuma ativa, broken > stale, message constante com o relógio andando, e PRE, re-apply e ACL nos clones.

### 3. `DROP DEFAULT` de `saldo_atual`

Migration `20261031191716_fin_contas_correntes_saldo_atual_sem_default.sql`. Writers medidos: só o `omie-financeiro`, num upsert por conta que só inclui `saldo_atual`/`saldo_data` quando o extrato respondeu. Nenhuma função SQL nem trigger escreve na tabela. Só o INSERT de conta NOVA com extrato falho dependia do default (nascia 0/NULL). A prova emula o upsert do PostgREST (só as colunas do payload no INSERT e no `DO UPDATE`): a conta nova sem extrato passa a nascer NULL/NULL, a existente preserva o saldo e o sucesso com saldo zero grava 0 e a data. Sem backfill, porque não há linha nascida do default. Codex: sem impedimento no writer atual; o cuidado é um futuro upsert em LOTE heterogêneo, em que a união de colunas transforma omissão em NULL para outra linha.

### 4. `fin_alertas` com o saldo datado

`fin-cashflow-engine` `v2.1-alertas-saldo-datado`. `marcarAlertasDoSaldoDatado` (`saldo-contas.ts`) marca só os 3 tipos cujo valor parte do saldo: `caixa_negativo`, `ncg_deficit` e `cobertura_baixa`. A mensagem (a única coisa que a `AlertasStack` exibe) ganha "— saldo inicial PARCIAL: N de M conta(s) com extrato de dd/mm/aaaa", e o motivo por extenso vai em `contexto.saldo_cc_parcial`. Como a persistência reescreve mensagem e contexto do alerta ativo a cada run, a marca some no 1º run com o saldo fresco. Residual: uma condição que o saldo datado esconde (um `caixa_negativo` dispensado porque o saldo velho era maior) não gera alerta para carregar o motivo. O snapshot e a tela das 13 semanas carregam.

### Merge e apply (2026-10-31)

- **Merge:** #3466, squash `93579508e`, 22:49Z. Nenhum commit do Lovable depois dele.
- **Migrations:** aplicadas por `bun run db:aplicar` a partir de `93579508e`, cada uma depois do `--ensaio` (ok nas duas).
  - Pré-voo às 22:52Z: corpo vivo `1eb65dcd…`, o predecessor, e DEFAULT 0.
  - `20261031191715`: tentativa **#810** virou recibo, exit 0.
  - `20261031191716`: tentativa **#811** virou recibo, exit 0.
- **2ª testemunha** (`psql-ro`):
  - `_data_health_compute`: md5 `ded4fd5b5f9d4731c9b9893b1ffba3ba`. Seguem `STABLE`, `SECURITY DEFINER`, `search_path=public, pg_temp` e o dono `postgres`. O EXECUTE segue `f` para anon, authenticated e PUBLIC.
  - O watchdog (`b325d2af…`) e o heartbeat (`f5defcde…`) ficaram intocados.
  - `fin_contas_correntes.saldo_atual`: `column_default` NULL, nullable.
  - O dado no instante (19:53 SP): 40 ativas, 0 desconhecidas, 0 velhas. O sensor dá `ok`, nenhuma mudança de status.
- **Edge `fin-cashflow-engine` v2.1: NÃO está no ar.** O `pendencias:deploy` acusou exatamente ela (`v2.0-saldo-cc-fresco` → `v2.1-alertas-saldo-datado`), e as outras 82 conferiam. O pacote `18be9c130124` (pré-condição de banco ok) foi montado, mas o `send_message` foi recusado: *workspace out of credits*. A mensagem não chegou ao agente.
  - Até o deploy, os `fin_alertas` seguem sem a marca do saldo datado. Hoje isso não muda nada, porque as 40 contas estão frescas.
  - Para fechar: créditos no workspace, depois o Passo 2 do pacote (`bun run pendencias:pacote` de novo, se a `main` andou), a sonda (`bun run sonda:sql fin-cashflow-engine`) e `pendencias:deploy` com exit 0.
- **Publish: pendente, e é do founder.** `src/` mudou o `CaixaCompraCard`. Até o Publish, o card antigo segue no ar, mas a RPC já devolve "indisponível" para o saldo velho desde o #3383.
