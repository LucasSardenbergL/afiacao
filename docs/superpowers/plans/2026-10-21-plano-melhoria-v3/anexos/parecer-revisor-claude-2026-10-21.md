=== PARECER REVISOR CLAUDE (Caminho B, substitui Codex) ===
(subagente Claude Opus · 2026-10-21 · 52 tool uses · 331 s · read-only, sem banco. O Codex não foi
consultado: `scripts/codex-async.sh -r max` saiu com EXIT=79 (SALDO_ALTO, cota em 99% com teto de 85%,
janela reabre em 27/10 07:46). O founder escolheu o Caminho B. Parecer cru, sem edição.
Entrada: anexos/rascunho-pre-revisao-2026-10-21.md + as 8 perguntas do prompt.)

Legenda: ✅ conferido lendo o código · ⚠️ plausível, não conferido. Nada editado, sem acesso a banco.

## 1. Prioridade do Top 5 — **MOVER**
A ordem atual põe em 1º um defeito com impacto **zero até ~2027-03** (item 1) e em 3º o único caminho vivo que escreve **estoque no Omie sem conferência e sem trilha** (item 3, reenquadrado em §2). Minha ordem:
1. **process-nfe** (medir uso → aposentar ou endurecer; P para medir)
2. **Saldo CC** (ampliado para saldo **velho por conta**, não só NULL; P) — afeta "Posição agora" e as 13 semanas todo dia
3. **fin-valor-engine** (defeito certo, custo P, prazo ~2027-03-26 — fazer agora porque é barato, não porque é urgente)
4. **NF-e sem itens** (medir ORIGEM antes de consumidores; P)
5. **Ciclo** → vira só pergunta 🧭, sem item de código (§2)

## 2. Evidência de cada item — **MOVER** (itens 1 e 3 reenquadrados, 4 ampliado, 5 rebaixado)

**Item 1.** ✅ A query é exatamente a descrita (`fin-valor-engine/index.ts:324-326`, sem `cenario`, `.limit(400)`, `error` descartado). ✅ O cálculo de ~133 dias e o "−12m" cortado fecham: `acharCapitalGiroAnterior` usa janela 365 com tolerância 60 (`src/lib/financeiro/valor-helpers.ts:129-141`). **Falso positivo: "cenário misturado afeta o atual".** A NCG não depende do cenário: em `fin-cashflow-engine/index.ts:1353-1355` só `premissas` recebe `cenario`; `calcularNCG(dados)` (`:1065`) lê só `dados` — as 3 linhas do dia têm a mesma NCG (a menos de segundos de diferença de dados) ✅. **O conserto proposto ainda é frágil:** filtro de cenário sem janela volta a cortar com qualquer "recalcular" manual com save ⚠️ — é a armadilha "o teto é o EIXO" do CLAUDE.md. Faça DUAS leituras pontuais: mais recente (`limit 1`) e mais próximo do alvo (`lte alvo order desc limit 1` + `gte alvo order asc limit 1`), independente de volume; `error` → indisponível. Extraia a leitura para um helper testável (o `_test.ts` do handler inteiro é caro; a lógica pura já é espelhada de `src/`).

**Item 2. O caminho de dados está mal lido.** `status='efetivado'` também é gravado por `omie-nfe-reconcile/index.ts:571-575`, que alinha o app quando a operação "dá entrada das NF-e DIRETO no Omie (humano)" (`:3-5`), sem itens e sem escrever no Omie ✅. Logo as 26 podem ser NF-e recebidas FORA do app — estoque e CMC no Omie estão certos, falta só rastreabilidade de lote no app; a causa do #3142 pode não ser a delas ⚠️. **Medição antes de tudo:** separar as 26 pela origem do `efetivado` (reconcile × efetivação do app) via psql-ro, mostrando as colunas de tentativa/lock que cada caminho grava. "60% das efetivadas sem itens" mistura denominadores: as 18 NF-e com itens não são todas `efetivado`, e o doc diz "16 com itens" (`docs/historico/nfe-recebimento-rpc-transacional.md:~70-76`) ⚠️. **Risco no backfill pelo Omie:** `ConsultarRecebimento` cai na trava anti-REDUNDANT por método e conta (`omie-nfe-reconcile/index.ts:8-12`) — backfill de 26 precisa de espaçamento ✅.

**Item 3. Subestimado e com a solução errada.** ✅ `process-nfe` não para em `AlterarEtapaRecebimento`: chama **`ConcluirRecebimento`** (`:501-510`), que é a entrada de estoque no ERP. ✅ `nQtdeRecebida` vem da NF (`:379-390`), não de contagem física. ✅ Não grava nada no banco (zero `.from(`/`.rpc(`); o histórico vive em `localStorage`, `src/pages/NfeReceipt.tsx:17-20`). ✅ Fica na aba "Manual" de `/admin/estoque/recebimento` (`AdminEstoqueRecebimento.tsx:215-217`) e em `App.tsx:350`. ✅ O caminho principal (`omie-nfe-recebimento`) usa `quantidade_conferida` (`:220`) e **BLOQUEIA** quando o fator de conversão ≠ 1 (`src/lib/recebimento/efetivacao-helpers.ts:287-298`). ⚠️ Inferência forte: a aba Manual é a válvula de escape justamente das NF-e **com conversão** — onde o `Math.round` (litro/kg → inteiro) mais erra. **Falso positivo: "três regras de quantidade" a unificar.** O `smartRound` do webhook/sync calcula `quantidade_esperada` do app na unidade da NF, sem fator (`omie-nfe-recebimento-sync/itens.ts:40-66`) ✅; o `process-nfe` calcula a quantidade em unidade de estoque para o Omie. São grandezas diferentes — um `_shared/qtd-recebimento.ts` único misturaria unidades. **"1 rota servida" não mede a aba Manual**: o ledger grava só o `pathname` (`PageViewTracker.tsx:20,38`). **Entrega certa:** (a) medir invocações do `process-nfe` pelos logs de edge (ela não deixa linha no banco); (b) 🧭 aposentar ou restringir a master com motivo gravado; (c) só se mantida: relógio + trilha em tabela + teste da sequência. ✅ É a ÚNICA edge que escreve no Omie (Alterar/Concluir) sem `chamarOmie`/`omie-chamada-relogio` — varri as escritas: `disparar-pedidos-aprovados`, `omie-nfe-recebimento`, `omie-sync`, `omie-vendas-sync` passam pelo núcleo.

**Item 4.** ✅ `financeiroService.ts:763` (a função é `getCapitalDeGiro`, `:698`, não `getCapitalGiro`) e `fin-cashflow-engine/index.ts:480-481` corretos. ✅ O NULL nasce como dito (conta nova com extrato falho, `omie-financeiro/index.ts:676-700`). **Mas o risco maior é outro:** em falha, o upsert **preserva o saldo anterior** (`:682`, `:696-699`), e nenhum leitor confere `saldo_data` (grep: nada de `saldo_data` em `financeiroService.ts` nem em `fin-cashflow-engine`) ✅. O data-health usa `max(cc.saldo_data)` por empresa (`db/aplicar-sync-reprocess-degradado-vigiadas.sql:37-38`) — uma conta fresca esconde as outras velhas ✅. Medir via psql-ro: `now()-saldo_data` por conta ATIVA. Os "62" incluem inativas; as leituras filtram `ativo=true` (`:745`, engine `:432`) e o comentário de `fin-cashflow-engine/index.ts:478-479` diz 37 ativas (14/9/14) — confira o denominador.

**Item 5.** ✅ Refs conferem (aba master-only, `FinanceiroCapitalGiro.tsx:20,40,47`). ✅ Ressalva: "ledger só tem 4 eventos" é impreciso — o tipo declara ≥7 nomes (`src/lib/analytics-ledger.ts:~38-66`); se "4" é eventos com linha em prod, diga isso. O único usuário é o founder, que é quem decide: um sensor M para observar uma pessoa que pode responder em 1 linha é desproporcional. Se ele quiser o dado, 1 evento `financeiro.ciclo_aberto` (P), não instrumentar 4 seções.

## 3. Falsos positivos no rascunho — **CORTAR**
1. "Cenário misturado afeta o atual" (item 1): NCG independe do cenário ✅.
2. "Três regras de quantidade → helper único" (item 3): grandezas diferentes ✅.
3. "60% das efetivadas sem itens por causa do bug do #3142" (item 2): origem alternativa (reconcile), causa não provada ✅/⚠️.
4. "Uso: 1 rota servida" como prova de uso do `process-nfe`: rota ≠ aba ✅.
5. "0 nulos → latente" como se fosse o risco todo: o saldo velho por conta não foi medido ✅.
6. `smartRound` "três cópias": são 2 cópias idênticas + 1 regra de outra natureza ✅.
Os itens 1, 2, 3 e 4 seguem válidos, mas os quatro tinham parte do diagnóstico ou da solução errada.

## 4. Riscos ausentes — **FALTA**
- **Saldo CC velho por conta** (§2 item 4), com o data-health cego pelo `max()` ✅.
- **`process-nfe` sem trilha:** um recebimento concluído pela aba Manual deixa o `nfe_recebimentos` do app `pendente` ⚠️ — pode ser a origem do `falha_efetivacao`/reconciles posteriores; vale cruzar na medição.
- **`process-nfe` + `Math.round` em conversão** (`:390`): 3,6 L viraria 4 no estoque do ERP ⚠️ (exigir caso real).
- `AdminReposicaoCadastros.tsx:252-253`: `.limit(2000)` (capa 1.000) + `if (error) return []` — o rascunho já tem como "quando tocar"; concordo, não é dinheiro direto ✅.
- `omie-sync` `sync_deleted_orders`: o select de `omie_ordens_servico` é sem paginação e descarta `error` (`omie-sync/index.ts:1633-1636`) — hoje benigno porque a deleção exige prova positiva ✅.

## 5. Cortes — **MANTER** (com 1 condição)
- `deleteOrphanOs`: ✅ não achei chamador de `sync_deleted_orders` no repo nem no `cron-jobs-snapshot.tsv` — mas o snapshot está defasado (8 jobs faltando, o próprio rascunho admite). **Condição:** antes de cortar, `psql-ro` em `cron.job` com `command ILIKE '%sync_deleted_orders%'`. O argumento "0 orders criadas em 180 d" está mal posto: a deleção age sobre o HISTÓRICO de `omie_ordens_servico`, não sobre criação nova; o que a torna dormente é a ausência de chamador.
- `supabase-js@2` flutuante: manter o corte (só muda em redeploy, e o deploy já é atestado pelo ledger ⚠️).
- DRE, snapshot de caixa, gate `_test.ts`: manter.

## 6. "Depois do Top 5" e L′ — **CORTAR L′**
L′ é uma lista sem consumidor, cujo único uso é um KPI: máquina meta disfarçada de dado, e ímã de deriva (mais um hotspot). ✅ Já existe descrição versionada de efeito por edge: `EFEITO` em 83 `versao.ts` (ex.: `process-nfe/versao.ts:23`) — se um dia precisar classificar, etiqueta junto do `EFEITO`, sem arquivo novo. Os demais "quando tocar" estão OK. Regenerar o `cron-jobs-snapshot.tsv` sobe para tarefa P: já induziu um falso positivo e condiciona o corte do §5.

## 7. Decisões do founder 🧭 — **FALTA**
1. NF-e: reformular — "depois de medir a ORIGEM: se foram recebidas direto no Omie, aceita o app sem itens (rótulo 'recebida fora do app')? Backfill só se lote/divergência precisar." Recomendo o rótulo; backfill é caro pela trava REDUNDANT.
2. Ciclo: manter; recomendo o founder responder direto, sem sensor M.
3. Piloto N → `database.md`: OK; recomendo adiar até haver um 2º leitor real.
4. **NOVA — `process-nfe`:** aposentar a aba Manual ou mantê-la só para master com motivo gravado? Recomendo aposentar se a medição der ~0 invocações; se houver uso, ele revela exatamente o buraco da conversão no caminho principal — e o produto certo é tratar conversão lá.
5. **NOVA — o ROIC incremental tem leitor?** O cockpit de valor é master-only ⚠️; se não tiver, o item 1 cai para "quando tocar".

## 8. KPIs — **MOVER**
Vaidade: "contas com saldo nulo mostradas como 0 (0 hoje)" (nasce zerado), "edges sem `_test.ts` (após L′)", "CI p50" (entregue no v2, não deste plano), "snapshots lidos por cenário (teste)" (mede saída, não resultado). Trocar por: **contas ATIVAS com `saldo_data` > 36 h** (por conta) · **invocações do `process-nfe`/semana** (e depois 0 se aposentado) · **as 26 NF-e por origem** (reconcile × app) · **ROIC incremental ≠ null a partir de 2027-03-26** (data de checagem = query, não recado) · "dias 3/3 de snapshot de caixa" (manter).

## RESUMO EM 10 LINHAS
1. Item 1 real, mas "cenário misturado" é falso positivo: a NCG independe do cenário (`fin-cashflow-engine/index.ts:1353-1355,1065`).
2. Conserto do item 1 = duas leituras pontuais (mais recente + mais próxima de −12m), não filtro com LIMIT; impacto só a partir de ~2027-03.
3. Item 3 é o mais grave: `process-nfe` CONCLUI o recebimento no Omie (`:503`) com a quantidade da NF, sem conferência e sem trilha no banco.
4. O caminho principal bloqueia NF-e com conversão (`efetivacao-helpers.ts:287-298`) → a aba Manual é provavelmente a válvula de escape desse caso.
5. "Três regras de quantidade → helper único" é falso positivo: grandezas em unidades diferentes.
6. Item 2: `efetivado` também vem do `omie-nfe-reconcile` (recebimento direto no Omie); medir a origem antes dos consumidores.
7. Item 4: o risco maior é o saldo VELHO por conta (preservado em falha, sem leitura de `saldo_data`, data-health com `max()`), não o NULL.
8. Item 5: sensor M para observar o único usuário (o founder) é desproporcional; vira 🧭 ou 1 evento P.
9. L′ é máquina meta sem consumidor (cortar); `EFEITO` em `versao.ts` já existe; regenerar o cron-snapshot antes de confirmar o corte do `deleteOrphanOs`.
10. Nova ordem: process-nfe (medir/decidir) → saldo CC velho/nulo → valor-engine → origem das NF-e → Ciclo só 🧭.
