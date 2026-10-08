# CT-e fora do rastreio (parte B): a fonte pula o frete e o casamento não o aceita como candidata

> 2026-10-05. Parte B de [sku-items-cte-fora-da-fila.md](sku-items-cte-fora-da-fila.md) (§7). A parte A
> tirou o CT-e da fila do leadtime. Esta tira o CT-e da FONTE: o `omie-sync-nfes-recebidas` deixa de
> gastar sono e `ConsultarRecebimento` nele e de gravá-lo como órfã. E o tira das CANDIDATAS do
> casamento de frete, no `omie-sync-ctes-recebidos`. Regra que fica: **"um CT-e em várias linhas"
> pede a cardinalidade por NF-e DISTINTA antes de qualquer unicidade.** Uma NF-e que fatura N
> pedidos são N linhas, e o vínculo extra quase sempre é a linha-irmã legítima.

## 1. Premissas do pedido × o que a medição mostrou

| premissa | medido |
|---|---|
| sleep de 5 s antes de cada consulta | **1,1 s** nesta edge (`RATE_LIMIT_DELAY_MS = 1100`); os 5 s são do sku-items |
| o sync de CT-e reprocessa até `dias` = 30 | via cron é **`dias = 3`**: o orquestrador (jobid 52) é o único cron das duas edges. 30 é só o default de uma chamada manual sem corpo, e nenhuma tela chama a edge |
| 13 fretes (16%) não chegaram à NF-e | são 13 **vínculos** (16% de 82) caídos em linha 57. Por CT-e, 10 dos 11 que casaram consigo mesmos chegaram depois à NF-e por re-associação: só **3 CT-e** (de 43) nunca chegaram a uma NF-e 55 |
| um CT-e já usado pode ser re-associado | **provado**: 27 de 43 CT-e estão em ≥ 2 linhas (um em 7), e cada run grava no máximo 1 vínculo por CT-e. Mas o vínculo extra é quase sempre a linha-irmã da MESMA NF-e (§4) |
| promover a decisão para `_shared/` e reexportar no sku-items | **adiado** (revisão, P2-1): o sku-items v1.3 já estava servido, e o #2801 saiu de draft com auto-merge e sobe a MESMA edge para outra v1.4, com migration própria. O reexport converge depois dele; até lá a paridade das duas cópias é testada |

## 2. A evidência (psql-ro, 2026-10-05)

| medição | valor |
|---|---|
| rastreio (`purchase_orders_tracking`) | 884 linhas; **135 modelo 57**, todas órfãs, 0 com leadtime; COLACOR sem CT-e |
| retrato das linhas 57 | criação mais nova 2026-10-01 18:15 UTC; regravação mais nova 2026-10-04 22:15 UTC (o sync de NFes regrava a órfã enquanto ela está na janela); 13 com vínculo de frete |
| `raw_data` das 210 órfãs (item do `ListarRecebimentos`) | `cabec.cModeloNFe` é SEMPRE string JSON: "55" em 75, "57" em 135. A chave crua é estrita e IGUAL à coluna em 210 de 210. A variante `cChaveNfe` não aparece |
| `sync_nfes_recebidas`, 14 dias | 168 runs, 168 `complete`, **0 com erros**; média de 4,5 processadas, 3,0 órfãs e 4,5 consultas por run |
| vínculos CT-e → linha | 82 vínculos de 43 CT-e. Por linhas: 16 em 1 linha, 22 em 2, 2 em 3, 1 em 4, 1 em 5, 1 em 7 |
| … por NF-e 55 DISTINTA | 3 CT-e só em linha 57 · 13 em 1 linha de 1 NF-e · 8 em 2 linhas da MESMA NF-e · 10 em 1 NF-e + a própria linha 57 · **4 em 2 NF-e distintas** · 2/1/1/1 em 3/4/5/7 linhas de UMA NF-e |
| linhas 57 com vínculo | 13 (11 = a própria linha do CT-e, via CONECT; 2 = outro CT-e). Todas de mais de 30 dias |
| linhas 57 candidatas na transição | 3 com `t3` nulo e t2 nos últimos 6 dias |
| chave ou CNPJ com letra | **0** (coluna e `raw_data`) |
| leitores do rastreio fora das edges | `v_leadtime_por_grupo` e `v_pedidos_em_aberto` (sem leitor no repo), `v_sku_leadtime_efetivo` e `recomputar_leadtime_derivado` (só via `sku_leadtime_history`, que CT-e não tem), `reposicao_pos_candidatos` (PO positivo; a órfã é negativa), `_data_health_compute` (vigia por heartbeat em `sync_state`, não pelo `updated_at` do rastreio) |

Por que a linha do CT-e casava consigo mesma: a órfã nasce com t2 = emissão do CT-e e com o mesmo
fornecedor (Sayerlack), e a janela é [emissão − 3 dias, emissão]. No CONECT, que só olha a data, a
distância é zero e ela vence sempre. No SP_MINAS o valor dela é o próprio frete, e o desvio contra
2,5% de si mesmo (3.900%) a reprova.

## 3. O conserto

- **`_shared/modelo-documento-fiscal.ts`** — a decisão da parte A (`MODELO_CTE`, `modeloDaChave`,
  `ehCte`, o texto idêntico) para a fonte e o casamento de frete. Novo: `modeloDoCabecalho` (só
  string de 2 dígitos ASCII, sem trim, sem `Number`) e `classificarModeloRecebimento(cabec)`, que
  devolve `cte` quando a chave CRUA E o cabeçalho dizem 57; `outro` quando concordam em outro
  modelo; `divergente` e `ausente` nos demais casos. A chave lida é a que a Omie mandou, nunca o
  `m.chave` do `mapNFe`, que passou pelo `replace(/\D/g, "").slice(0, 44)`. O sku-items ficou com a
  SUA cópia (P2-1): o `_test.ts` compara os veredictos das duas no mesmo corpus, e a convergência
  para reexport fica para depois do #2801.
- **Fonte** (`omie-sync-nfes-recebidas` v1.4-cte-fora-do-rastreio): depois da validação do
  `nIdReceb` e do dedup do run, e antes de `mapNFe`, do sono, do `ConsultarRecebimento`, de
  `updateLinhasDoPedido` e de `insertOrfa`, o CT-e sai com `ctes_ignorados++`. `divergente` e
  `ausente` seguem o fluxo de NF-e e ficam contados (com `console.warn`). A paginação não muda,
  porque o `continue` é por documento. `nfes_processadas` passa a contar só NF-e, e com ele o
  `falhaSistemica` (antes, um run com todas as NF-e falhando saía `complete` porque os CT-e
  contavam como processados). `documentos_listados` (nIdReceb válido e distinto, CT-e incluído) é o
  denominador; os quatro contadores só existem no resumo do run que listou — em `apenas_backfill` e
  no erro fatal ficam AUSENTES do results, nunca um 0 fabricado (P3-1).
- **Fim de listagem** (mesma edge, achado P2-3 da revisão): a fault canônica "Não existem registros
  para a página" — a janela de 3 dias vazia — caía no `erros++` e fechava o run `error` com alerta
  crítico falso (07-05, 07-20, 08-04, 09-08 e 10-06, 00:16 UTC, 1,5 s). A decisão foi para
  `listagem.ts` (`classificarFaultstring` do `_shared/omie-falha.ts` + o regex antigo), testada em
  Deno. A canônica só é fim na PÁGINA 1 (a janela vazia): numa página > 1, dentro do total
  declarado, é anomalia e segue erro visível (2ª passada da revisão, P3-a). Fault que não é fim
  continua erro em qualquer página.
- **Casamento** (`omie-sync-ctes-recebidos` v1.2-cte-fora-das-candidatas): `buscarCandidatas` foi
  para `candidatas.ts` (testado em Deno, com contrato estrutural do cliente). O select ganha
  `nfe_chave_acesso`, `ehCte` tira a linha 57 (denylist: chave ilegível segue candidata) e o resumo
  ganha `candidatas_cte_excluidas`. A falha de leitura passa a lançar `FalhaLeituraCritica`
  (`exigirLeitura`): antes virava `[]`, e o CT-e era contado como órfão num run sem erro. Agora o
  try/catch do item conta `erros`, e nada é gravado.
- **sku-items: fora desta leva** (P2-1). Nenhum arquivo dele muda.
- **Ordem entre edges: nenhuma.** As duas são independentes: a fonte pode subir antes ou depois do
  casamento, e as duas ordens são seguras.

## 4. Re-associação: medida, não mexida

O matcher não confere se o CT-e já foi vinculado: a candidata só precisa de `t3_data_cte` nulo. Em
cada run (12 por dia, durante os 3 dias da janela) ele grava o CT-e numa linha ainda livre. O efeito
dominante é **benigno**: uma NF-e que fatura N pedidos tem N linhas, e o re-vínculo preenche as
irmãs uma por run. Impor "1 CT-e → 1 linha" quebraria exatamente esse caso. O que sobra de defeito é
outro problema, de granularidade. O matcher casa LINHA, quando a unidade é a NF-e:

- 4 CT-e caíram em 2 NF-e distintas (pode ser frete de duas notas, pode ser erro: o dado não diz);
- 5 NF-e têm linhas-irmãs com CT-e DIFERENTES, e várias têm parte das irmãs com t3 e parte sem;
- o `nValorNFe` some do `raw_data` das linhas com pedido (o sync de pedidos sobrescreve o jsonb), e
  o SP_MINAS só enxerga a candidata cujo `raw_data` ainda é o do recebimento.

Corrigir isso significa casar o CT-e com a NF-e e propagar o vínculo às irmãs, ou recusar o CT-e já
vinculado a OUTRA NF-e. É redesenho com decisão de produto, e ficou fora deste PR (§7). Excluir o 57
não piora a re-associação. O CONECT, que gastava um run casando consigo mesmo, passa a ir direto às
NF-e, e a janela de candidatas só encolhe.

O revisor mediu o que torna o efeito quase nulo HOJE (P2-2, P3-8): o CONECT não teve CT-e da
Sayerlack desde junho (todo vínculo desde então é SP_MINAS), o SP_MINAS nunca casa um CT-e consigo
mesmo (desvio 39 contra o teto de 0,30) e nenhuma das 338 linhas 55 com pedido tem `nValorNFe` no
`raw_data` — o SP_MINAS só enxerga órfã. NF-e 55 com t3 por mês: jun 23/34, jul 7/50, ago 5/58,
set 4/42. "Chegou a uma 55" não quer dizer "chegou à certa" (P3-7): as 10 re-associações não estão
consertadas por isso.

## 5. Revisão

Sem Codex: a cota estava em **89% (teto 85%)** e a janela reabre em **09/10 19:30**. O wrapper saiu
com exit 79 sem gastar a chamada. **Caminho B**: revisor adversarial independente (subagente, só
leitura, re-mediu no banco), sobre o desenho e o código já commitado. Veredito dele: **sem P0/P1**,
"pode ir com ajustes". Codex retroativo quando a janela reabrir.

| achado do revisor | decisão (minha) |
|---|---|
| P2-1 a leva de 3 edges colide com o #2801 (auto-merge armado, outra v1.4 do sku-items, migration própria); a parte A já estava servida | **aceito**: sku-items fora; paridade das cópias testada; reexport depois do #2801 |
| P2-2 a revalidação do casamento não falsifica nada (CONECT parado desde junho, SP_MINAS não casa consigo mesmo, sem linha 57 nova depois da fonte) | **aceito em parte**: a prova do filtro é Deno + vitest falsificados, e o contador vira detector de vazamento da fonte (esperado 0). NÃO sequenciei "ctes antes, prova positiva, depois nfes": a prova depende de chegar um CT-e de SP Minas (a janela atual tem 0), o que seguraria o conserto da fonte por tempo indefinido. Fica como opção (§7) |
| P2-3 a janela vazia fecha o run `error` com alerta crítico falso (a fault canônica de fim não casava o regex) e imitaria regressão da parte B | **aceito e consertado** (`listagem.ts`, mesma função, mesmo bump) |
| P2-4 o denominador declarado não fechava (`erros` conta falha de página e pode contar 2× o documento) | **aceito**: `documentos_listados` + conferência contra o `ctes_processados` do mesmo tick do orquestrador |
| P2-5 `omie-nfe-recebimento-sync` grava CT-e em `nfe_recebimentos` (20; 2 pendentes, 0 itens) | **registrado** (§7) |
| P2-6 erro de escrita no `updateLinhasDoPedido` grava órfã de NF-e que tem pedido | **registrado** (§7) com medição: 4 NF-e 55 nos dois papéis, causa não atribuível só pelo dado |
| P2-7 a revalidação prova o que sai, não o que tem de ficar | **aceito** (§8: lado da NF-e, runs sem timeout, linha 57 nova só via ausente/divergente) |
| P3-1 contadores 0 nos ramos que não medem | **aceito e consertado** (ausentes; vitest exige um único `: 0`) |
| P3-2 `candidatas_cte_excluidas` são pares, denominador SP Minas + Conect | **aceito** (comentário) |
| P3-3 mudança no `_shared` escapa do `sonda:bump` | **aceito** (aviso no cabeçalho do módulo) |
| P3-4 teste de identidade fraco no `MODELO_CTE` | moot (o reexport saiu) |
| P3-5 CNPJ alfanumérico derruba as 3 camadas juntas | **registrado** (radar, §7) |
| P3-6 "esperado `modelo_ausente` = 0" extrapola (medido só em órfãs) | **aceito** (§8) |
| P3-7 "chegou a uma 55" ≠ "chegou à certa" | **aceito** (§4) |
| P3-8 SP_MINAS quase parado: `nValorNFe` some do `raw_data` das linhas com pedido | **registrado** (§4, §7) |
| P3-9 `nTotalPaginas` (nfes) × `nTotPaginas` (ctes) no mesmo endpoint | **registrado** (radar, §7) |

2ª passada, só sobre o delta dos ajustes: **sem P0/P1/P2**, 4 P3, "o delta pode ir como está". O
revisor conferiu o texto REAL da fault de fim no mesmo endpoint ("ERROR: Não existem registros para a
página [1]!", HTTP 500, capturado em `omie-nfe-recebimento-sync/listagem_test.ts`) e que o `retry.ts`
o devolve ao laço em vez de retentar.

| achado (2ª passada) | decisão (minha) |
|---|---|
| P3-a o fim canônico aceito em QUALQUER página esconderia um parcial (página > 1 dentro do total) | **aceito e consertado**: só na página 1 |
| P3-b o conserto troca o falso positivo por um falso negativo (listagem vazia para sempre fecha `complete`, e nenhum sensor olha este sync) | **aceito**: consulta manual R6 (§8), sem máquina nova |
| P3-c o corpus da paridade não tinha 58/59/66, e o `toLowerCase()` de dígitos não testava nada | **aceito** |
| P3-d 0 sem medida quando o `ListarRecebimentos` lança na página 1; a identidade derivada não estava escrita | **aceito** (comentário da `ContagemModelo` e §8) |

## 6. Falsificação: uma camada por vez, com controle verde na mesma invocação

Script de sabotagem com restauração por cópia, conferida byte a byte, nunca `git checkout`. Só conta
VERMELHO de asserção — erro de tipo ou "nenhum teste" seria vermelho errado — e, onde declarada, com a
MARCA do ramo na saída. Rodou em `LC_ALL=C` e em `pt_BR.UTF-8`, sobre o código já com os ajustes da
revisão (as duas passadas): **26 de 26 vermelhos nos dois**, controle verde no início e no fim de cada
invocação, árvore limpa no fim.

| sabotagem | camada | vermelho em |
|---|---|---|
| S1 um sinal só basta (chave 57 → CT-e) | Deno | divergente 57/55 virou `cte` |
| S2 a chave é normalizada antes de ler o modelo | Deno | chave agrupada com espaço virou `cte` |
| S3 cabeçalho leniente (trim, número) | Deno | `modeloDoCabecalho(57)` deu "57" |
| S4 o 57 em qualquer posição (`includes`) | Deno | NF-e com 57 no número virou `cte` |
| S5 `cChaveNfe` na frente de `cChaveNFe` | Deno | divergente 55/57 virou `cte` |
| S6 a cópia da parte A diverge sozinha | Deno | "modeloDaChave("57") divergiu entre as cópias" (só a paridade enxerga) |
| S7 o select perde `nfe_chave_acesso` | Deno | consulta e filtro |
| S8 o filtro do 57 some | Deno | as 2 linhas 57 voltam às candidatas |
| S9 allowlist do 55 | Deno | chave ilegível e modelo 65 somem |
| S10 a falha de leitura vira lista vazia | Deno | "esperado FalhaLeituraCritica, veio NADA" |
| S11 a contagem de excluídas sempre 0 | Deno | `ctesExcluidas` 0 ≠ 2 |
| S12 o ramo do CT-e conta mas não pula | vitest | regex do ramo com `continue` |
| S13 a classificação lê a chave do `mapNFe` | vitest | argumento tem de ser `nfe?.cabec` |
| S14 a linha certa comentada, modelo fixo no lugar | vitest | código sem comentários |
| S15 o bloco MOVIDO para depois da consulta | vitest | "ramo do CT-e tem de vir ANTES de mapNFe" |
| S16 o contador de divergência some | vitest | contador visível |
| S17 o contador some do resumo que mede | vitest | "tem de nascer zerado no resumo do run que mede" |
| S18 o resumo do casamento perde a contagem | vitest | `candidatas_cte_excluidas += ctesExcluidas` |
| S19 cópia local de `buscarCandidatas` | vitest | import do módulo testado + sem cópia |
| S20 classificador local na fonte | vitest | import do `_shared` |
| S21 a fault canônica deixa de ser fim (volta ao regex antigo) | Deno | "ERROR: Não existem registros para a página [1]!: esperado true" |
| S22 fim de listagem LARGO demais (qualquer "registros") | Deno | "esperado false, veio true" (retrato parcial) |
| S23 o laço de páginas volta ao regex local | vitest | "o fim da listagem deixou de passar pela decisão testada" |
| S24 `apenas_backfill` grava 0 nos contadores | vitest | "zerado fora do resumo do syncEmpresa" |
| S25 `documentos_listados` depois da classificação | vitest | "documento listado tem de vir ANTES de classificação" |
| S26 o fim canônico aceito em QUALQUER página | Deno | "página 2: … esperado false, veio true" (o parcial sumiria) |

## 7. O que fica descoberto

- **A granularidade do matcher** (§4): casar CT-e ↔ NF-e e propagar às irmãs, ou recusar o CT-e já
  vinculado a outra NF-e. Decisão de produto. O `t3` não entra nos `lt_*` do motor: o dano é na
  decomposição logística e nas telas. E o SP_MINAS está quase parado por outro motivo (P3-8): lê o
  `nValorNFe` de um jsonb multi-writer que o sync de pedidos sobrescreve.
- **As 135 linhas 57, os 13 vínculos em linha 57 e os 3 CT-e que nunca chegaram a uma NF-e — ✅ resolvido
  em 2026-10-08.** As 137 linhas foram apagadas pelo envelope, com backup, e os 3 CT-e não foram re-casados
  (decisão do founder). Ver [sku-items-cte-fora-da-fila.md](sku-items-cte-fora-da-fila.md) §10.
- **As órfãs 57 deixam de ser regravadas**: `status` e `t4` delas congelam. Nenhum leitor depende
  disso (as duas views que as contam não têm leitor no repo).
- **Radar: CNPJ alfanumérico** (inscrições novas desde jul/2026). A classificação lê a chave CRUA
  com parser só de dígitos, então a chave com letra cai em `modelo_ausente`: segue o comportamento
  de hoje e fica visível no primeiro caso. A corrupção da chave gravada é outro defeito, e mais
  antigo: `replace(/\D/g, "")` em três writers (`mapNFe` e o backfill no sync de NFes, `mapCte` no de
  CT-e), e o import por chave recusa letra ("letra não é chave"). O conserto é PR próprio, com o
  layout SEFAZ da chave alfanumérica e todos os leitores alinhados. Medido: 0 ocorrências.
- **Reexport no sku-items**: depois que o #2801 mergear e subir, o `escopo.ts` passa a reexportar do
  `_shared` (com bump próprio). Até lá, a paridade está no `_shared/modelo-documento-fiscal_test.ts`.
- **4ª superfície do CT-e (P2-5)**: `omie-nfe-recebimento-sync` grava CT-e em `nfe_recebimentos` (20:
  18 efetivados, 2 pendentes com 0 itens). Pode ser legítimo (efetivar o CT-e na Omie pode ser passo
  fiscal); é decisão de produto.
- **Órfã em erro de escrita (P2-6)**: `updateLinhasDoPedido` que lança deixa `vinculadasNestaNFe = 0`
  e o laço grava órfã de uma NF-e que tem pedido — o que o guard do `ConsultarRecebimento` proíbe.
  Medido: 4 NF-e 55 aparecem nos dois papéis (órfã e linha de pedido); a causa pode ser também o
  pedido chegar depois da nota. Conserto curto (`continue` sem `insertOrfa` quando algum update
  lançou), fora deste PR.
- **Prova positiva do filtro do casamento em produção (P2-2) — saiu sozinha no 1º tick** (§8, "No
  ar"). Este item previa sequenciar as edges, mas as duas subiram juntas e não precisou: a fonte velha
  tinha gravado a linha 57 do CT-e de SP Minas às 02:15 do mesmo dia, e o casamento novo a excluiu
  (`candidatas_cte_excluidas` = 1 com R1 = 0). Segue sem prova em produção o CONECT, sem CT-e da
  Sayerlack desde junho.
- **Radar: total de páginas (P3-9)**: o sync de NFes lê `nTotalPaginas`, o de CT-e lê
  `nTotPaginas`/`total_de_paginas`, no mesmo endpoint. Com `dias = 3` (uma página) não pesa; numa
  chamada manual com `dias` largo, a página 2 em diante pode não ser lida. O site já é dívida
  baselinada no G4 do `paginacao-artesanal-gate`.
- **Codex retroativo** no diff, quando a janela reabrir.

## 8. Deploy e revalidação

1. PR mergeado ⇒ `bun run pendencias:deploy` decide ⇒ deploy das duas edges pela sessão (MCP). O
   sku-items NÃO entra: nada dele mudou.
2. **Baseline no instante do deploy** (read-only): contagem, `max(created_at)` e `max(updated_at)`
   das linhas 57, e a lista de ids das linhas 57 com vínculo de frete (13 em 2026-10-05).
3. Revalidação depois do primeiro tick do orquestrador (:15 das horas pares), com
   `psql-ro -v ON_ERROR_STOP=1 -v deploy='<instante do deploy>'`. Só valem runs sem
   `interrompido_por_timeout`.

```sql
-- R1: nenhuma linha 57 nova, nem regravada, desde o deploy
select count(*) filter (where created_at > :'deploy') novas, count(*) filter (where updated_at > :'deploy') regravadas
from purchase_orders_tracking where nfe_chave_acesso ~ '^[0-9]{44}$' and substr(nfe_chave_acesso, 21, 2) = '57';
-- R2: a MESMA lista de linhas 57 com vínculo de frete
select id from purchase_orders_tracking
where nfe_chave_acesso ~ '^[0-9]{44}$' and substr(nfe_chave_acesso, 21, 2) = '57'
  and (t3_data_cte is not null or cte_chave_acesso is not null) order by id;
-- R3: o sync de NFes enxerga e pula os CT-e (só runs que listaram: a chave existe no results)
select started_at, status, results->>'documentos_listados' listados, results->>'ctes_ignorados' ctes,
       results->>'modelo_divergente' div, results->>'modelo_ausente' aus,
       results->>'consultas_detalhadas' det, results->>'nfes_processadas' proc, results->>'erros' err
from fin_sync_log where action = 'sync_nfes_recebidas' and started_at > :'deploy'
  and coalesce((results->>'interrompido_por_timeout')::boolean, false) = false order by started_at;
-- R4: o que TEM de ficar — NF-e 55 emitida depois do deploy chega ao rastreio com pedido casado
select count(*) filter (where omie_codigo_pedido > 0) com_pedido, count(*) filter (where omie_codigo_pedido < 0) orfas
from purchase_orders_tracking where empresa = 'OBEN' and nfe_chave_acesso ~ '^[0-9]{44}$'
  and substr(nfe_chave_acesso, 21, 2) = '55' and t2_data_faturamento > :'deploy';
-- R5: conferência no MESMO tick do orquestrador (mesma janela de 3 dias): CT-e pulados pela fonte
-- contra CT-e listados pelo casamento de frete
select r.id, (r.content::jsonb #>> '{resultados,nfes,body,summary,0,ctes_ignorados}') nfes_ctes_ignorados,
       (r.content::jsonb #>> '{resultados,ctes,body,summary,0,ctes_processados}') ctes_processados,
       (r.content::jsonb #>> '{resultados,ctes,body,summary,0,candidatas_cte_excluidas}') candidatas_57_fora,
       (r.content::jsonb #>> '{resultados,nfes,body,versao}') v_nfes, (r.content::jsonb #>> '{resultados,ctes,body,versao}') v_ctes
from net._http_response r where r.created > :'deploy'
  and r.content like '{%"resultados"%' and r.content like '%omie-sync-nfes-recebidas%' order by r.id;
```

Esperado:
- R1 = 0 e 0. Exceção legítima: CT-e que passou como `ausente`/`divergente`, que segue o fluxo de NF-e.
  Nesse caso a linha 57 nova tem de bater com os contadores do R3.
- R2 igual à lista do baseline.
- R3: `ctes` igual aos CT-e da janela; `div` e `aus` em 0. O `cModeloNFe` só foi medido em órfãs, então
  `aus` > 0 em NF-e com pedido é ruído (aviso a cada run), não omissão.
- R4 com ≥ 1 NF-e com pedido assim que entrar nota nova: prova o lado que fica.
- R5: `nfes_ctes_ignorados` igual a `ctes_processados`, salvo ausente/divergente e CT-e sem `nIdReceb`
  no cabeçalho. `candidatas_57_fora` positivo NÃO é vazamento enquanto houver linha 57 LEGADA na
  janela (a limpeza das antigas é do founder): é o filtro tirando uma linha antiga. Vazamento da fonte
  é o R1 > 0. *Corrigido depois do 1º tick: esta linha dizia "em 0: positivo é linha 57 NOVA", e o
  tick das 20:15 de 06/10 deu 1 com R1 = 0 (ver "No ar", abaixo).*

Identidade derivada, por run: `documentos_listados − ctes_ignorados − nfes_processadas` = documentos
que falharam no caminho de NF-e (detalhe ou escrita) — o que `erros` sozinho não dá.

```sql
-- R6 (vigiar à mão, sem máquina nova): listagem vazia PARA SEMPRE — dia útil em que nenhum run listou
-- documento. Com a janela de 3 dias, um dia útil vazio é raro e pede investigação (parâmetro, cEtapa,
-- mudança na Omie): o `complete` com 0 listados não acende nada sozinho.
select (started_at at time zone 'America/Sao_Paulo')::date dia, count(*) runs,
       max((results->>'documentos_listados')::int) max_listados
from fin_sync_log
where action = 'sync_nfes_recebidas' and status = 'complete' and results ? 'documentos_listados'
  and coalesce((results->>'interrompido_por_timeout')::boolean, false) = false
  and extract(isodow from started_at at time zone 'America/Sao_Paulo') between 1 and 5
group by 1 having max((results->>'documentos_listados')::int) = 0 order by 1 desc;
```

Janela vazia (fim de semana ou feriado) não é regressão: desde esta versão ela sai `complete`, com
`documentos_listados` = 0. Um `error` com 0 listados num tick em que o casamento listou 0 CT-e sem
`erro_fatal` é o padrão de antes do conserto: verifique se a versão servida é a nova.

### No ar (2026-10-06, pela sessão)

| camada | como | prova (por fora) |
|---|---|---|
| as 2 edges (nfes v1.4, ctes v1.2) | `pendencias:prompt` só das duas (`origin/main@99567e308`) → `send_message` às 19:46:22Z. O agente conferiu 15/15 hashes antes do `deploy_edge_functions` (1,8 crédito). O `omie-sync-estoque` v1.5 (#2817), pendente no mesmo ledger, é de outra leva e ficou fora | eco no tick 105978 (20:15Z): `v1.4-cte-fora-do-rastreio` com `fonte` `9fdb19a3…` e `v1.2-cte-fora-das-candidatas` com `bc8533b7…`, os dois iguais ao mapa |
| ledger do ctes (fora da allowlist do cron de sonda) | `db/sonda-pos-deploy-ctes-recebidos-v1.2-2026-10-06.sql`, gerado pelo `sonda:sql --so-disparo`, pelo `db:aplicar` (ensaio, depois tentativa #253) | passo 2 no psql-ro: request 105960, HTTP 200, **DEPLOY CONFIRMADO**; `pendencias:deploy` → `CONFERE` |
| ledger do nfes | cron de sonda (job 184, :37 das horas pares) | `deploy_atestacoes` 20:37:00Z via sonda: `v1.4-cte-fora-do-rastreio` + `9fdb19a3…`; `pendencias:deploy` → `CONFERE` (a única pendência que restou no ledger é o `omie-sync-estoque` da outra leva) |

**Sensor de edição: `EDICAO_DETECTADA` (exit 1), e a edição era a regeneração de tipos.** O sinal veio
do `edit_id` da resposta. O `get_diff` da mensagem e os 2 commits do bot na `main` mostram só
`src/integrations/supabase/types.ts` +12: `v_sku_items_fila` e `sku_items_fila_parada_check()`, do #2819
(aberto), cuja migration já está em prod (`to_regclass`/`to_regprocedure` medidos). Não reverter: é o
mesmo desempate do #2820.

**Baseline (19:45Z):** 137 linhas 57 (eram 135 em 05/10; a fonte velha gravou mais 2 em 06/10, às
02:15 e às 18:15 — o bug seguia ativo) e 13 com vínculo (md5 da lista `fe5f50ab…`).

**Revalidação depois do tick das 20:15Z** (`deploy` = 19:46:22Z):

| | medido | veredito |
|---|---|---|
| R1 | 0 novas, 0 regravadas | ✅ |
| R2 | 13, md5 `fe5f50ab…` | ✅ igual ao baseline |
| R3 | run 20:15:30 `complete`: 3 listados, 2 CT-e pulados, 0 divergente, 0 ausente, 1 consulta, 1 NF-e processada, 0 erro; identidade 3 − 2 − 1 = 0 | ✅ |
| R4 | 0 / 0 | ⏳ nenhuma NF-e 55 emitida depois do deploy (o t2 é a data de emissão, então conta a partir de 07/10). O caminho de NF-e segue vivo: a NF-e do run (55, órfã desde as 14:15) foi reconsultada e regravada às 20:15:34, e as 339 linhas do rastreio tocadas depois do deploy, por qualquer escritor, são todas 55 |
| R5 | `ctes_ignorados` 2 = `ctes_processados` 2; `candidatas_cte_excluidas` 1 | ✅ O 1 é linha 57 LEGADA: R1 = 0, e as 4 linhas 57 sem vínculo da janela são anteriores ao deploy. Pela janela e pelos dois CT-e que a fonte pulou, é a órfã SAYERLACK de 05/10 que a fonte velha gravou às 02:15, a linha do próprio CT-e de SP Minas (inferência: o resumo só dá o total) |

O resumo do casamento no mesmo tick: 1 CT-e de SP Minas (órfão, sem casamento), 1 de outra
transportadora ignorado, 0 CONECT. R6 fica armado, para vigiar à mão.
