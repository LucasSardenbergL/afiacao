# Plano de melhoria do código — v3 (2026-10-21)

> Sucede o [plano v2](../2026-10-18-plano-melhoria-v2/README.md), concluído inteiro em 2026-10-21. Herda as decisões dele e do [plano de 2026-09-05](../2026-09-05-plano-melhorias-codebase/README.md): 5 usuários · 1 dev · **"canônico quando tocar"** · motores e monólitos cortados salvo incidente · 1 lote = 1 sessão · arquivo quente = 1 dono · máquina meta só com incidente citado por ID ([maquinas-meta.md](../../../agent/maquinas-meta.md)). Não reabre o que foi cortado.
>
> **Método:** baseline medida (health stack, `casts:stale`, `deriva:corpo:prod`, `pendencias:deploy`, CI) + 2 varreduras em subagente (código/arquitetura e domínio/produto; **Sonnet**, porque o Fable estava sem crédito) + medição em prod via `psql-ro` de cada achado candidato + 2ª opinião adversária.
> **O Codex NÃO foi consultado.** `scripts/codex-async.sh -r max` saiu com `EXIT=79` (SALDO_ALTO: cota em 99%, teto 85%, janela reabre em **27/10 07:46**). O founder escolheu o **Caminho B**: revisor adversário Claude (subagente Opus) no lugar dele. Parecer cru em [anexos/parecer-revisor-claude-2026-10-21.md](anexos/parecer-revisor-claude-2026-10-21.md) e rascunho que ele revisou em [anexos/rascunho-pre-revisao-2026-10-21.md](anexos/rascunho-pre-revisao-2026-10-21.md). O revisor derrubou 6 afirmações do rascunho e reordenou o Top 5. O que ele afirmou e foi **conferido no código ou medido em prod** está marcado ✅; o que ficou plausível sem conferência, ⚠️. **Codex retroativo** sobre este README depois de 27/10.
> `Codex: desenho=não consultado (EXIT=79, Caminho B: revisor Claude Opus) · código=n/a (plano) · extra=Codex retroativo após 27/10 07:46`

## 0. Baseline medida (worktree sobre `728b0cbeb`, 2026-10-21)

| Medida | Valor |
|---|---|
| typecheck · lint · test · knip · lint:shell (cadeia única) | **EXIT=0** nos 5. lint: 0 erros, 73 warnings (46 `exhaustive-deps`, 27 `react-refresh`) · test: **1064 arquivos, 13.051 passed, 2 skipped** (283 s) · knip: saída vazia · shellcheck: 0 achados em 573 arquivos |
| `casts:stale` | EXIT=0 — from 0 · rpc 0 = baseline; 0 casts literais `as never` |
| `deriva:corpo:prod` (psql-ro) | EXIT=0 — 410 identidades: 337 em dia · 66 cosméticas · 6 aceitas · 1 não-mensurável declarada · 20 aposentadas; baseline **23** entradas |
| `pendencias:deploy` | EXIT=0 — **83/83** edges conferem; 14 de 97 fora do alcance da sonda (sem `versao.ts`) |
| CI `validate` no PR | p50 **19,4 min** (n=12 PRs verdes, 16:05–18:13Z, depois do #3313; 12,4–29,1) — confirma o fecho do v2 |
| edges | 97 · **44 com `_test.ts`** (v2: 36) · 53 sem |
| `src/` | 970 arquivos de teste · 0 `.skip/.only/.todo` · 0 `any` explícito · nenhum módulo ativo com 0 testes |
| edges: bordas sem tipo | 108 `as unknown` em código (64 em respostas Omie: `callOmie(...) as unknown as X`) · 34 `await req.json()` sem tipo |
| Falsos problemas (não perseguir) | "DRE sem recomputo automático" (o cron `fin-dre-recalculo-diario`, jobid 215, rodou hoje 15:30Z ✅) · IPF farmer null→0 (`farmer_performance_scores` tem **0 linhas** ✅) · `deleteOrphanOs`/preço vazio em OS (nenhum cron chama `sync_deleted_orders` ✅; `orders` sem linha nova em 180 d) · smartRound "3 regras" (são grandezas diferentes ✅) · imports remotos (0) |

Achado de método: **não existe definição versionada de "edge money-path"** (o manifesto não tem glob para `supabase/functions`), então o "26 de 49 sem teste" do v2 não é reprodutível. Não se cria lista nova (ver §4); o `EFEITO` de cada `versao.ts` (83 edges) já descreve o efeito.

## 1. Tese

O v2 fechou os passivos estruturais (tipos, auth replicada, CI, deriva). Sobra pouco estrutural com dinheiro em jogo: o que apareceu são **caminhos de escrita e leitura pontuais no recebimento e no financeiro**, todos medidos, nenhum com dano visível hoje. O maior é uma escrita no Omie sem conferência nem trilha. Por isso o v3 é curto, **P na maioria**, e mede antes de mexer. Estrutura (duplicação, `as unknown` nas edges Omie, hotspots) fica para "quando tocar". Critério: **impacto em dinheiro/produção × evidência ÷ custo de corrigir, verificar e entregar**.

## 2. Top 5 (são 4: o 5º caiu na medição) — na ordem (1 item = 1 PR · 1 lote = 1 sessão)

### 1 · ✅ `process-nfe`: conclui recebimento no Omie sem conferência, sem relógio e sem trilha — **money-path/estoque, esforço P (trilha) → M (endurecer)**
`supabase/functions/process-nfe/index.ts` (554 linhas, sem `_test.ts`) faz `AlterarRecebimento` → `AlterarEtapaRecebimento` → **`ConcluirRecebimento`** (`:503`, a entrada de estoque no ERP) ✅ com `nQtdeRecebida = Math.round(qtdeNfe / fatorConversao)` (`:390`, fator caindo para `|| 1`) ✅ — quantidade da NF, não da contagem física. É a **única** edge que escreve no Omie sem `omie-chamada-relogio` (`fetch` sem timeout em `:90-110`) ✅ e **não grava nada no banco**: o histórico vive no `localStorage` (`NfeReceipt.tsx:17-20`). Fica na aba "Manual" de `/admin/estoque/recebimento`. O caminho principal **bloqueia NF-e com conversão** (`efetivacao-helpers.ts:287-298`) ✅ ⇒ a aba Manual é provavelmente a válvula de escape justamente desse caso, onde o `Math.round` mais erra (3,6 L → 4) ⚠️. O uso é desconhecido: o ledger só vê o `pathname`, não a aba.
**✅ Entregue em #3334 (2026-10-21):** trilha append-only, Omie pelo relógio, guarda de estado/unicidade e regra de quantidade com caso real; migration aplicada; edge v2.0 no ar (deploy atestado no #3341). Detalhe em [process-nfe-trilha-relogio-regra-quantidade.md](../../../historico/process-nfe-trilha-relogio-regra-quantidade.md).
**Entrega:** (a) trilha server-side por invocação (padrão `_shared/registro-execucao.ts`): quem, NF, itens, fator, quantidade enviada e resultado de cada passo. É sensor de produto **e** o mínimo para a opção "manter". (b) Com 2 semanas de sinal → 🧭 #1. (c) Só se mantida: Omie pelo relógio + teste Deno da sequência + caso real de conversão antes de mexer na regra.

### 2 · ✅ Saldo de conta corrente nulo **ou velho** entra como número no caixa — **money-path, esforço P**
`financeiroService.ts:763` (`getCapitalDeGiro`, `:698`): `c.saldo_atual || 0` alimenta `saldo_cc`, `capital_giro_liquido` (`:805`) e `saldo_projetado_30d` (`:813`); espelho em `fin-cashflow-engine/index.ts:480-481` (`Number(c.saldo_atual ?? 0)`), saldo inicial das 13 semanas e da NCG ✅. O mesmo arquivo já trata a classe em `:256-271` (`saldoIndisponivel`). **Risco maior (revisor):** em falha de extrato o upsert **preserva o saldo anterior** sem mexer em `saldo_data` (`omie-financeiro/index.ts:680-700`) ✅, e **nenhum leitor confere `saldo_data`** (grep: 0 em `financeiroService.ts` e em `fin-cashflow-engine`) ✅. Prod hoje: 40 contas ativas (15/15/10), **0 nulas, 0 com `saldo_data` > 36 h** → latente.
**Entrega:** saldo por conta **ausente ou velho → indisponível/parcial** nos dois leitores (replicando `saldoIndisponivel`), com teste. Fora do escopo: o data-health por empresa usa `max(saldo_data)` (`db/aplicar-sync-reprocess-degradado-vigiadas.sql:37-38`) e uma conta fresca esconde as velhas. Registrar o fato e só mexer se o item mostrar necessidade (é sensor existente, não máquina nova).
**✅ Entregue em #3347 (2026-10-27):** `saldo_data` é DATE e `saldo_atual` tem DEFAULT 0 (a ausência real é `saldo_data` NULL); fresco = de HOJE a partir das 04h SP (o sync de base roda às 03h; "hoje ou ontem" deixava passar UM sync perdido — achado do revisor). Tela: "—" + motivo (Posição Agora, Cockpit, drill-down); edge `fin-cashflow-engine` v2.0 no ar: desconhecida lança, velha entra datada até 7 dias com motivo. Publish pendente (o `src/` muda a tela). Fora: RPC `fin_projecao_13_semanas` (pede migration). Detalhe em [saldo-cc-fresco-e-ncg-leitura-pontual.md](../../../historico/saldo-cc-fresco-e-ncg-leitura-pontual.md).

### 3 · ✅ Cockpit de valor lê os snapshots de capital de giro com o eixo errado — **money-path, esforço P**
`fin-valor-engine/index.ts:324-326`: `fin_projecao_snapshots` com `.order(snapshot_at desc).limit(400)`, **sem janela**, `error` descartado ✅. Prod: 412–424 linhas por empresa em 140–145 dias (3 cenários/dia), então 400 linhas cobrem ~133 dias, e o ponto "−12m" do ROIC incremental (`valor-helpers.ts:129-141`, 365 ± 60 d) **já estará cortado** quando existir (~2027-03-26). Hoje degrada para `null`, sem fabricar número. ~~Cenário misturado afeta o atual~~: falso, a NCG independe do cenário (`fin-cashflow-engine/index.ts:1353-1355,1065`) ✅.
**Entrega (revisor):** **duas leituras pontuais**, a mais recente (`limit 1`) e a mais próxima do alvo −12m (`lte` desc `limit 1` + `gte` asc `limit 1`), independentes do volume ("o teto é o EIXO"). `error` → indisponível; helper testável. Condicionado à 🧭 #4.
**✅ Entregue em #3347 (2026-10-27):** NCG por duas leituras pontuais (atual + vizinhas do alvo −12m); erro no atual → 500, no −12m → motivo; edge `fin-valor-engine` v1.1 no ar (sonda DEPLOY CONFIRMADO, `pendencias:deploy` exit 0). Detalhe em [saldo-cc-fresco-e-ncg-leitura-pontual.md](../../../historico/saldo-cc-fresco-e-ncg-leitura-pontual.md).

### 4 · ✅ 26 NF-e efetivadas sem itens — **produção (rastreabilidade), esforço P depois da 🧭**
Prod: **26 NF-e (modelo 55) `efetivado` + 1 `falha_efetivacao` sem nenhuma linha em `nfe_recebimento_itens`** (2026-04-13 a 2026-09-04): **26 de 39 NF-e efetivadas** ✅. **Nenhuma** foi conferida no app (`conferido_at`, `conferente_id`, `efetivacao_lock_at` e `origem` nulos; `efetivacao_tentativas` > 0) ✅ ⇒ foram recebidas **fora do fluxo de conferência do app**, pelo `omie-nfe-reconcile` (que grava `efetivado` quando a entrada foi feita direto no Omie, `:571-575` ✅) ou pela aba Manual (item 1) ⚠️. O estoque e o CMC estão no Omie; o que falta é o histórico de item e lote no app. Os CT-e já são pulados (`listagem.ts:187`). O `docs/historico/nfe-recebimento-rpc-transacional.md:76` deixou "decisão do founder".
**✅ Entregue em 2026-10-27:** rótulo "Recebida fora do app" na lista, no histórico e na conferência, sem backfill (🧭 #2). A remedição achou **52** efetivadas + 1 falha sem itens (o plano contou 26), todas recebidas direto no Omie e fechadas pelo reconcile, nenhuma depois do #3334; o estoque é legado e fechado desde a importação transacional. Detalhe em [nfe-efetivada-sem-itens-recebida-fora-do-app.md](../../../historico/nfe-efetivada-sem-itens-recebida-fora-do-app.md).
**Entrega:** conforme 🧭 #2. Backfill pelo Omie esbarra na trava anti-REDUNDANT (`omie-nfe-reconcile/index.ts:8-12`) e precisa de espaçamento.

### ~~5~~ · O 5º candidato caiu na medição: o Top tem 4 itens
O candidato era o `cron-jobs-snapshot.tsv` defasado. Prod tem **115 jobs** e o snapshot **105** (de 2026-10-15, #3096): faltam 11, entre eles `fin-dre-recalculo-diario` e os 222/223 de 21/10, e o snapshot ainda lista 1 job já removido (`tactical-plans-batch-nightly`) ✅. Mas **os 11 são citados por alguma migration** (`git grep "'<job>'" -- supabase/migrations` ≥ 1 para cada) ✅, então o DR os recria. Sobra só um refresh de rotina (§3). O revisor sugeria promovê-lo; a medição o rebaixou. O Ciclo virou 🧭 (§5), e nada de pior evidência sobe para ocupar a vaga.

## 3. Depois do Top 5 (quando tocar)
- `supabase/cron-jobs-snapshot.tsv`: refresh (`db/refresh-snapshot.sh`) na próxima sessão que tocar cron ou DR. Hoje faltam 11 jobs de prod (todos com migration) e sobra 1 removido, e a defasagem induziu o falso positivo do "DRE sem recomputo" nesta varredura.
- **L** (do v2) segue: edge money-path **tocada** sai do PR com `_test.ts`. Sem lista nova (§4).
- `omie-vendas-sync/index.ts:2742` (4.557 linhas, 23 commits desde 1/9; escreve PV/OP no Omie): `const { action, account, ...params } = await req.json()` deixa `params.*` como `any` em todo `case`. Parse na borda quando tocar.
- `callOmie(...) as unknown as X` nas edges Omie (64): parse na borda quando tocar a edge.
- `smartRound` em 2 cópias idênticas (`omie-nfe-webhook/index.ts:37`, `omie-nfe-recebimento-sync/itens.ts:40`): mesma grandeza (qtd esperada na unidade da NF), dá para unificar quando tocar. **Não** juntar com o `process-nfe:390` (unidade de estoque).
- Tintométrico: `Math.ceil(v*10)/10` inline em 9 pontos de 6 arquivos; `round2` com 3 semânticas em 7 lugares (diferem em negativos). Helper único quando tocar.
- Limiar R$50/h em 3 cópias "espelha" sem teste cruzado (`useTacticalPlan.ts:268`, `_shared/tactical-margem.ts:13`, `src/lib/tactical/pregeracao.ts:7`).
- `authorizeMaster` local em `fin-funding:43`, `fin-valor-engine:24` e `fin-regime-tributario:26` (já devolvem `{ok}` e o handler testa `.ok`, sem risco de auth aberta ✅); `timingSafeEq` em 4 edges. Trocar por `_shared/auth.ts` quando tocar.
- 11 `@ts-expect-error` "tabela não está nos types" em `fin-cashflow-engine` (`:405-456,1392,1456`): somem na regeneração dos tipos das edges.
- `AdminReposicaoCadastros.tsx:252-253`: `.limit(2000)` (a capa é 1.000) + `if (error) return []`.
- `omie-sync/index.ts:1633-1636` (`sync_deleted_orders`): select sem paginação que descarta `error`. Benigno (sem chamador; deleção exige prova positiva).
- **N**: generalizar as regras vivas para `database.md` (195 KB). Ver 🧭 #5.

## 4. Cortado (com motivo)
- **L′, a lista versionada de edges money-path**: lista sem consumidor cujo único uso é um KPI. É máquina meta disfarçada de dado e ímã de conflito. O `EFEITO` do `versao.ts` já existe (revisor ✅).
- **Sensor M da aba Ciclo** (4 seções no ledger): o único usuário é o founder, que responde em 1 linha (🧭 #3). Se a fase seguinte for desejada, basta 1 evento P.
- **`_shared/qtd-recebimento.ts` único**: misturaria quantidade na unidade da NF com quantidade em unidade de estoque (revisor ✅).
- `deleteOrphanOs` (`omie-sync:1642`): corrida real (FK `order_messages/order_reviews/loyalty_points → orders` é NO ACTION em prod ✅), mas **nenhum cron chama `sync_deleted_orders`** ✅ e o repo não tem chamador. `useAdminOrderDetail.ts:248` (preço vazio vira R$ 0 na OS): `orders` sem linha nova em 180 d.
- IPF farmer null→0: tabela vazia. "DRE sem recomputo": falso (cron 215 ativo).
- Buracos do snapshot de caixa (colacor 14–20/10): já tratados por outra entrega (#3252/#3319, jobs 222/223). Fica só o KPI.
- Pinar `npm:@supabase/supabase-js@2` nas 89 edges: sem incidente em edge; o deploy já é atestado pelo ledger.
- Gate "edge money-path tocada exige `_test.ts`": máquina meta sem incidente.
- `whatsapp-send-template` (módulo congelado) · `omie-webhook` TOCTOU (handlers são stubs) · hotspots de conflito (`manifesto.ts` 82 commits, `sonda-fingerprints.ts` 162, `db/nucleo-ci.txt` 126 desde 1/9: custo real de dev, mas mexer = refactor/máquina sem incidente).
- Continuam cortados do v2: I3 · K3 · mutirão M · J2-mover · M-57 · M-58 · M-50 · majors.

## 5. Decisões do founder 🧭
1. **`process-nfe` / aba Manual de recebimento:** depois de 2 semanas de trilha (item 1a), aposentar a aba ou mantê-la só para master, com motivo gravado e Omie pelo relógio? **Recomendo:** aposentar se a trilha der ~0 uso. Se houver uso, o caso que aparecer (NF com conversão) é o que o caminho principal precisa aprender a tratar, e o produto certo é tratá-lo lá.
2. **26 NF-e efetivadas sem itens:** rótulo "recebida fora do app" na tela, ou backfill dos itens a partir do Omie? **Recomendo:** o rótulo. Nenhuma foi conferida no app, o estoque e o CMC estão no Omie, e o backfill de 26 esbarra na trava REDUNDANT. Backfill só se a rastreabilidade de lote dessas NF-e for exigida.
3. **Ciclo financeiro:** a fase seguinte (alerta de vencimento com desconto, piloto desconto/degrau — specs de 2026-10-14 §155 e 2026-10-18 §179) ainda é desejada? **Recomendo:** responder direto. Se sim, 1 evento `financeiro.ciclo_aberto` no ledger (P); se não, o tema fecha.
4. **ROIC incremental (cockpit de valor):** você lê esse número? **Recomendo:** se lê, o item 3 fica, P e antes de 2027-03-26; se não, ele vai para "quando tocar", com data de checagem (query) em 2027-03-26.
5. **Piloto N → `database.md`:** generalizar? **Recomendo:** sim, depois do Top 5 e com as lições do piloto como condição de merge: 2º leitor independente auditando o TEXTO das regras, regressão de âncoras (`git grep "database.md"` × `§"..."`) e setas do CLAUDE.md conferidas ([money-path-regras-vivas-piloto-n.md](../../../historico/money-path-regras-vivas-piloto-n.md)). `deploy.md` segue fora, porque o `gates:frescura` lê o texto dele.

### Respostas do founder (2026-10-21, no chat) ✅
1. **`process-nfe`: MANTER e melhorar**, nas palavras do founder: "não vou deixar ser feito isso mais pelo omie". O recebimento deixa de ser feito direto no Omie, e a aba Manual passa a ser caminho oficial, não válvula. Por isso o item 1 vira **M completo**: trilha server-side, Omie pelo relógio, teste Deno da sequência e tratamento correto da conversão de unidade (o `Math.round(qtdeNfe / fator)` de `:390` precisa de caso real e regra explícita). Consequência: o `omie-nfe-reconcile` ("entrada direto no Omie") perde a razão de ser e deve ser revisto na mesma sessão. Desligar o reconcile é decisão de produto e deve ser dita ao founder, nunca feita em silêncio. **Decidido (2026-10-27): MANTER ligado.** Ele não escreve no Omie; é quem fecha no painel (`nfe_recebimentos` → `efetivado`) as NF recebidas pela aba Manual, que a `process-nfe` não atualiza.
2. **26 NF-e sem itens: resolver** pela recomendação, com rótulo "recebida fora do app" na tela, sem backfill.
3. **Ciclo: fazer**, com 1 evento `financeiro.ciclo_aberto` no ledger (allowlist de `analytics_ledger_registrar` via `db/*.sql` no ritual lovable-db-operator) e só isso.
4. **ROIC incremental: o founder lê** → o item 3 fica no Top (P, antes de 2027-03-26).
5. **Piloto N → `database.md`: fazer**, depois do Top e com as condições de merge listadas acima.
6. **`omie-nfe-reconcile`: MANTER ligado** (founder, 2026-10-26). A `process-nfe` não atualiza `nfe_recebimentos`, e é o reconcile (cron de hora em hora, seg–sáb) que fecha no painel a NF recebida pela aba Manual ([process-nfe-trilha-relogio-regra-quantidade.md](../../../historico/process-nfe-trilha-relogio-regra-quantidade.md)). Desligá-lo só volta a ser pauta se a `process-nfe` passar a gravar o próprio desfecho.

## 6. KPIs

| KPI | Baseline (2026-10-21) | Como medir |
|---|---|---|
| invocações do `process-nfe`/semana (e 0 se aposentado) | desconhecido (sem trilha) | trilha do item 1a |
| contas ATIVAS com `saldo_atual` nulo ou `saldo_data` > 36 h | 0 de 40 | `psql-ro`: `fin_contas_correntes where ativo` |
| leitores que mostram saldo ausente/velho como número | 2 (`getCapitalDeGiro`, `fin-cashflow-engine`) | código |
| ROIC incremental ≠ null | null (sem −12m até ~2027-03-26) | query em **2027-03-26** |
| NF-e efetivadas sem itens sem rótulo/decisão | 26 (+1 falha) | `psql-ro` |
| dias com 3/3 snapshots de caixa por empresa (08–21/10) | colacor 6/14 · colacor_sc 10/14 · oben 8/14 (21/10: 3/3 nas três) | `fin_projecao_snapshots` |

O CI p50 (19,4 min) é monitoramento herdado do v2, não KPI deste plano.

## 7. Calibração do parecer (separada do parecer cru)
**Conferido por mim no código ✅:** `ConcluirRecebimento` em `process-nfe:503`; `detectarConversao` bloqueia fator ≠ 1 (`efetivacao-helpers.ts:287-298`); `omie-nfe-reconcile:571-575` grava `efetivado` com compare-and-update; NCG independe do cenário (`fin-cashflow-engine:1351-1355`); `omie-financeiro:680-700` preserva o saldo em falha sem tocar `saldo_data`; 0 ocorrências de `saldo_data` nos dois leitores.
**Medido em prod (`psql-ro`) ✅:** nenhum cron chama `sync_deleted_orders`; 40 contas ativas, 0 nulas, 0 com saldo > 36 h; as 27 NF-e sem itens não têm conferência, lock nem origem; o denominador correto é 26/39 efetivadas (o rascunho dizia "60%", mistura que o revisor apontou).
**Não conferido ⚠️:** a aba Manual como "válvula" das NF-e com conversão (exige a trilha); se as 26 vieram do reconcile ou da aba Manual (o lock nulo não separa os dois); o backfill exato sob a trava REDUNDANT.
**Discordância:** nenhuma de fundo. Adotei a ordem do revisor. O "Ciclo" sai do Top, como ele propôs. A regeneração do snapshot de cron, que ele promovia, foi medida e **caiu**: os 11 jobs ausentes têm migration, então não há lacuna de DR. O Top fica com 4 itens. O CI p50 sai dos KPIs, como ele pediu, mas fica citado como monitoramento.
