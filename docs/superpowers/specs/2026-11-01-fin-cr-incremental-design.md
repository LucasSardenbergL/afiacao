# `fin_contas_receber` incremental com reconciliação de exclusões — desenho (plano v4, lote 15 / B3)

> Money-path (crédito, aging, inadimplência, DSO). Medições de 2026-11-01/02 (UTC), oben via API Omie
> ao vivo (só leitura) + prod via `psql-ro`. Os números abaixo são o que sustenta cada decisão.

## 1. Problema

O `sync_contas_receber` lista **tudo** (`ListarContasReceber` sem filtro; `filtro_data_*` nunca chega
ao Omie) 2×/dia × 3 empresas: ~450 páginas/run, 45.617 de 45.660 linhas reescritas em 12 h, 97% já
baixadas, e o cron estoura o budget de 100 s e depende da continuação `*/10`.

E há um defeito vivo que o full atual **não** corrige por construção (upsert não remove):

| empresa | títulos ABERTOS no banco que o Omie já excluiu | R$ | dos quais `ATRASADO` |
|---|---|---|---|
| oben | 29 | 13.668,66 | 9 (R$ 3.485,42, 5 clientes) |
| colacor_sc | 7 | 1.624,05 | 5 (R$ 838,05, 3 clientes) |
| colacor | 2 | 1.168,00 | 0 |

Detecção: linha aberta cujo `updated_at` ficou para trás do último full (o full regrava tudo que o Omie
devolve). Na oben, os 29 batem 29/29 com o conjunto aberto do banco ausente da listagem do Omie, e
10/10 consultados um a um responderam `Lançamento não cadastrado` (os outros 19 não foram consultados:
ver §6, bloqueio). São inadimplência fantasma na trava de crédito e no aging.

## 2. Contrato do Omie — o que a doc diz e o que a medição mostrou

Doc oficial (`/api/v1/financas/contareceber/`, lida 2026-11-01): `lcrListarRequest` tem
`filtrar_por_data_de/ate`, `filtrar_apenas_inclusao`, `filtrar_apenas_alteracao`,
`filtrar_apenas_titulos_em_aberto` — **sem descrição de semântica**. A resposta traz `info.dInc/hInc`,
`info.dAlt/hAlt/uAlt`. **Não há método que liste excluídos.**

Medido (oben):

| pergunta | resultado |
|---|---|
| `filtrar_por_data_de/ate` + `filtrar_apenas_alteracao=S` filtra por `info.dAlt`? | sim: 799 títulos em 01/10–01/11, `dAlt` min 01/10, max 31/10; janela 27/10–01/11 → `dAlt` 27/10..31/10. Granularidade de **dia**, limites inclusivos |
| **baixa** carimba o `dAlt` do título? | 372/379 baixas de 30 dias (`fin_movimentacoes` BAXR, por `ncodbaixa`) têm `dAlt ≥` 1ª observação − 26 h, ou registro ANTES da data da baixa (retorno bancário `uAlt=WEBSERVICE` às 18–20 h do dia anterior: 39 casos). As 7 restantes foram "vistas" em 13/10 10:00 por re-hash do espelho (baixas de jan–jul) — não são observação de registro. **0 contraexemplo** |
| **estorno** de baixa carimba? | 2/2 (`12097272930`, `12064843447`: baixa vista pela última vez 10/07 11:40, `dAlt` 10/07 13:39) |
| **cancelamento** pós-baixa carimba? | 1/1 (`12169736742`: baixa vista pela última vez 22/10 05:40, `dAlt` 22/10 08:28) |
| **inclusão** aparece no filtro de alteração? | 447/447 títulos novos de 30 dias; `dAlt = dInc` na criação |
| **exclusão**? | invisível: o título some de toda listagem; `ConsultarContaReceber` → `Lançamento não cadastrado` |
| `filtrar_apenas_titulos_em_aberto=S` cobre o aberto? | 854 devolvidos; **831/831** abertos do banco que ainda existem estão lá (os 29 que faltam são os excluídos). Devolve também 23 `RECEBIDO` (superconjunto — inofensivo) |
| `status_titulo` | **relativo ao DIA** (`A VENCER` → `VENCE HOJE` → `ATRASADO`) — muda sem alteração no título, logo **sem** `dAlt`. Incremental só por `dAlt` congelaria o aging |

Limite da evidência: só a oben foi medida pela API (as credenciais locais são só dela). A colacor e a
colacor_sc usam o mesmo endpoint; o teto de exclusão (§3.4) e o 1º run observado (§5) cobrem o resto.

## 3. Desenho

### 3.1 Modo por run (decidido pela edge, crons intocados)

Por empresa, sob o lease já existente, com `t0` congelado antes de qualquer leitura
(`cr-incremental.ts` → `decidirModoCR`):

1. `fin_sync_cursor(contas_receber).next_page` pendente → **continua o full** (comportamento atual).
2. Estado ilegível, nenhum full completo registrado, ou último full completo > 7 dias → **full** (página 1).
3. Senão → **incremental**.

Estado em `sync_state` (padrão `deveRodarCompleto`, docs/agent/sync.md), 1 linha por marcador × empresa:
`fin_cr_full_inicio` (gravado na página 1 do full), `fin_cr_full_ok` (no fim real do full recebe o
início dele — só se existir e for posterior ao ok anterior; full herdado de bundle antigo é refeito),
`fin_cr_incremental_ok` (`t0` do último incremental íntegro). **Marca d'água = `incremental_ok`; o
`full_ok` só no bootstrap** (nenhum incremental ainda), em dia de São Paulo — não o máximo dos dois: a
continuação do full reinicia o piso e pode fechar truncada, e um `full_ok` mais novo pularia alteração de
título fechado em página não visitada (Codex, código). Janela mais larga é sempre segura. O cursor do
full de CR é lido e gravado com erro que LANÇA (os helpers compartilhados engolem): cursor pendente lido
como "nenhum" recomeçaria o full com início novo, que a continuação velha publicaria como `full_ok`. O deploy da edge não depende da migration: sem a
RPC, o run lista A e B e devolve `reconciliacao: "indisponivel"` (§3.4).

### 3.2 Incremental (1 invocação, sem continuação)

- **A — conjunto aberto completo**: `filtrar_apenas_titulos_em_aberto=S`, com os guards do full em
  **modo estrito**: fim real obrigatório (budget/maxPages antes dele LANÇA), título sem código LANÇA,
  `total_de_registros` lido da 1ª página ANTES do veredito de página vazia e obrigatório (ausente ou
  lidos < declarado LANÇA — `falhaVarreduraEstrita`), além do piso monotônico, vazia antes do piso e página
  repetida. Upsert por página. Refaz o status relativo ao dia de todo aberto **visto**.
- **B — alterados**: `filtrar_por_data_de = marca − 1 dia`, `ate = hoje`, `filtrar_apenas_alteracao=S`,
  mesmo modo estrito. Roda DEPOIS de A (a observação mais nova vence).
- **C1/C2/C3 — reconciliação** (§3.4) com `vistos = códigos gravados em A ∪ B`.
- **Marca d'água** gravada por ÚLTIMO, só com A+B+C íntegros. Qualquer falha LANÇA (`fin_sync_log`
  `error`), sem marca.

Custo medido: A = 2/4/9 páginas (colacor_sc/colacor/oben), B ≈ 1–2, provas ≤ 10 → ~20–30 chamadas/run
nas 3 empresas, contra ~450 páginas. Cabe numa invocação.

### 3.3 Full (rede de segurança, semanal)

Igual ao de hoje (cursor + continuação), mais os marcadores. **Não reconcilia exclusão** (o universo
"todos" por `updated_at` saiu na revisão — §7). Semanal porque o que o crédito lê (o aberto) é
relistado inteiro a cada run por A, e o que muda num título fechado (estorno, cancelamento) carimba
`dAlt` e entra por B; o full cobre o que esse contrato não garante em título fechado (tolerância
explícita de até 7 dias para mudança tardia em título FECHADO, que não alimenta crédito nem DSO — este
sai de `fin_movimentacoes`/`v_titulo_baixas`).

### 3.4 Reconciliação de exclusões — candidato, prova, tombstone

- **C1 `fin_cr_marcar_ausentes`** (SQL): universo = abertos da empresa. Visto → limpa
  `ausente_omie_desde`. Ausente sem marca → marca `t0`. Devolve como **candidatos** só os marcados por
  um run ANTERIOR (o deslize de um run se cura no seguinte sem gastar chamada ao Omie). **Teto**:
  ausentes > `max(5, 10%)` dos abertos → `RAISE` sem escrever (filtro do Omie mudou). Hoje: 29/860,
  7/116, 2/330.
- **C2 prova (edge)**: por candidato, `ListarContasReceber` página 1 com `filtrar_cliente` +
  `filtrar_por_emissao_de/ate` = emissão ± 1 dia. Uma resposta = leitura consistente, sem página para
  deslizar. `ausente_provado` só se a resposta se afirma completa (`total_de_paginas ≤ 1`, itens =
  `total_de_registros`, < 100), todo item tem código e é do cliente pedido; o código achado =
  `presente`; o resto = `inconclusivo` (fica para outro run). Contagens só valem como inteiro ≥ 0 de
  verdade (`Number("")` não vira 0; páginas ausentes não viram 0; itens com 0 páginas é incoerente).
  Parcelas da mesma NF dividem a RESPOSTA (cada código é reavaliado nela); ≤ 10 provas por run, em ordem
  embaralhada — inconclusivos perenes não monopolizam o teto (backlog da oben drena em ~3 runs). Medido na oben: controles reais vêm; o
  fantasma vem vazio com `total_de_registros: 0` (sem fault) ou entre outros títulos do cliente.
- **C2b reconfirmação (edge)**, só se houver confirmado: relista os alterados de [último dia de B, hoje]
  em modo estrito. O Omie pode mudar cliente/emissão do título entre B e a prova (a prova leria a chave
  velha e voltaria vazia); código visto sai dos confirmados, e o upsert carimba `updated_at > t0`, que o
  C3 também barra. Custo: ~1 página, só em run com exclusão.
- **C3 `fin_cr_excluir_confirmados`** (SQL): só apaga quem segue aberto, marcado por run anterior e
  **não regravado neste run** (`updated_at < t0` — observação positiva vence a prova). Seleção com
  `FOR UPDATE OF r` (writer concorrente com a linha regravada e a transação aberta: o Postgres espera e
  reavalia as guardas na versão nova), guardas repetidas no DELETE e contagem igual à do tombstone ou
  `RAISE`. Tombstone
  (`fin_contas_receber_excluidos`: linha inteira + evidência da prova) na mesma transação, antes do
  DELETE; o `NOT NULL` de `ausente_omie_desde` no tombstone é uma 2ª defesa contra apagar não-marcado.
- Por que DELETE e não status novo: `status_titulo` é texto livre (CHECK dropado em 20260329) e ~13
  leitores só NEGAM `CANCELADO`/`RECEBIDO` (`fin_aging_receber`, `v_grupo_contas_receber(_por_doc)`,
  `v_ciclo_*`, `fin_consolidado_intercompany`, `fin_dre_competencia_base`, `cobranca_quitacao_ok`,
  `fin-cashflow-engine`, `titulos-dre.ts`, `fin-valor-cockpit`, `financeiroV2Service`). Ausência de linha
  todos tratam. Única FK: `fin_ic_matches.cr_id ON DELETE SET NULL` (o tombstone guarda o `id`).
- `cobranca_quitacao_ok`: hoje o fantasma ABERTO bloqueia a quitação do cliente para sempre.
- **Nunca** `ConsultarContaReceber` por título inexistente (§6).
- Migration ausente = `PGRST202`, ou `42883` cuja mensagem nomeia a própria RPC; `42883` de dependência
  interna LANÇA (não vira "indisponível" com marca avançando).

### 3.5 Frescor (`_data_health_compute`)

Preservado, não melhorado: `max(cr.updated_at)` GLOBAL (20261031191715:116-123), stale > 26 h — o
incremental regrava todo aberto a cada run, como o full regravava. `cobranca_quitacao_ok` e
`fin_calcular_confiabilidade` leem `fin_sync_log` `complete` (o incremental só fecha `complete` com
A+B+C íntegros; o full mantém a semântica de hoje). O Codex apontou que o agregado global já mente
hoje (uma empresa sã esconde outra parada) — follow-up fora deste lote (§8).

## 4. Régua

- **Unidade decisória:** título aberto por cliente (trava de crédito, aging, inadimplência, cobrança).
- **Onde aparece:** `fin_contas_receber.status_titulo ∈ {ATRASADO, A VENCER, VENCE HOJE}`.
- **Denominador:** abertos por empresa (oben 860 · colacor 330 · sc 116).
- **Ordem do irreversível:** DELETE só com prova de uma resposta única, depois de 2 runs completos com
  ausência, sem observação positiva no run; tombstone antes, na mesma transação.

## 5. Provas

- `db/test-fin-cr-reconciliacao.sh` (PG17, no núcleo do CI, 82 asserts): baixa, estorno, exclusão
  (marca → candidato → prova → apaga, FK do IC vira NULL), deslize que se cura, retry do mesmo `t0`,
  observação positiva vence a prova, **corrida** (writer com a linha regravada e a transação aberta
  durante o C3, 2 sessões), não-marcado e fechado não se apagam, teto sem escrita, falha do tombstone
  desfaz o DELETE, isolamento, ACL. 7 sabotagens, cada uma reprovando o SEU rótulo (defesas duplas
  neutralizadas juntas; a da corrida, uma camada por vez), controle verde antes e depois; LC_ALL=C e
  pt_BR.UTF-8.
- `supabase/functions/omie-financeiro/cr-incremental_test.ts` (Deno, 32): decisor e janela (dia de SP,
  marca do incremental), veredito da prova (metadado inválido nunca prova), fim estrito, `rpcAusente`, e o
  FLUXO com dependências falsas — falha em B, teto/permissão/`42883` interno no C1, falha na prova, na
  reconfirmação ou no C3 não gravam marca; presente e reobservado nunca vão ao DELETE; cache por
  resposta, não por veredito; ordem embaralhada. 7 sabotagens mordem.

## 6. Observação pós-deploy

`fin_sync_log.results` do 1º incremental por empresa: `modo`, `paginas_abertos/alterados`, `vistos`,
`marcados`, `candidatos`, `provas`, `presentes`, `inconclusivos`, `adiados`, `excluidos`. Esperado: 1º
incremental marca oben 29 / sc 7 / colacor 2; o 2º os devolve como candidatos e prova; `presentes > 0`
num run = sinal de deslize ou de contrato do filtro de aberto quebrado (investigar).

## 7. Incidente da medição

A sonda consultou ~14 títulos inexistentes em minutos e o Omie respondeu
`API bloqueada por consumo indevido. Tente novamente em 1800 segundos` (app key da oben, compartilhada
por ~20 edges; 2026-11-02 ~01:35–02:05 UTC, domingo à noite). Conferido via `psql-ro` depois: nenhum
erro de bloqueio em `sync_state` nem `sync_reprocess_log`; o único log financeiro da janela
(`sync_pedidos` 02:05) fechou `complete`. `net._http_response` da janela já tinha sido purgado (ausência
de dado, não prova). Lições: "não cadastrado" repetido conta como consumo indevido; e o Omie aceita
UMA requisição por método por vez na conta ("Já existe uma requisição desse método sendo executada").

## 8. Revisão Codex e residuais

Desenho (gpt-6-astra · max · 565 s · 146.076 tokens): **P0 aceito** — duas ausências não provam
exclusão (deslize repetido na fronteira de página); daí a prova por cliente. P1 aceitos: teto separado
por abertos (o universo "todos" saiu), modo estrito (sem código, `maxPages`, contagem truncada), erros
de RPC explícitos, marca por último, fluxo testado.

Código (gpt-6-astra · max · 704 s · 175.898 tokens), reprovado com 2 P0 + 5 P1 + 2 P2, **todos aceitos**:
P0 mudança de cliente/emissão no Omie entre B e a prova → C2b; P0 corrida no C3 em Read Committed →
`FOR UPDATE` + guardas no DELETE + contagem (prova com 2 sessões, cenário C); P1 1ª página vazia com
contagem > 0 passava no estrito; P1 `full_inicio` casado com cursor de outro full → cursor estrito; P1
full truncado avançava a marca → marca do incremental; P1 metadado inválido virava prova; P1 `42883`
interno virava "indisponível"; P2 testes cegos (cada correção tem teste e sabotagem que morde); P2 fila
travada por 10 inconclusivos → ordem embaralhada. Fica como hipótese não medida: resposta do Omie
coerente porém FALSA (itens omitidos com contagem igualmente sub-reportada).

**Residuais, fora deste lote:**

- Frescor por empresa e por run integral no `_data_health_compute` (arquivo quente; hoje o `max` global
  já mascara empresa parada).
- O full reinicia o piso (`totalPaginas = 1`) a cada continuação — uma vazia na retomada pode passar
  como EOF. Pré-existente; com a marca d'água vindo do incremental, um full truncado não abre buraco no
  B (exceto no bootstrap, quando ainda não há incremental), mas segue podendo publicar `full_ok` sobre
  retrato truncado de título FECHADO.
- Exclusão de título FECHADO (hoje 5 linhas, R$ 2,6 mil: 3 RECEBIDO + 2 CANCELADO) não é reconciliada
  — entra em leitores que só negam CANCELADO (DRE competência, faturável). Prova por cliente serviria
  igual, falta o gerador de candidatos sem a régua errada do `updated_at`.
- `|| 0` do mapeamento (`valor_documento`, `valor_recebido`) fabrica zero em campo ausente —
  pré-existente, não tocado.
- A cobertura do B por `dAlt` é hipótese MONITORADA (372/379 baixas de 30 dias, 2/2 estornos, 1/1
  cancelamento, 447/447 inclusões — só oben): o full semanal é a tolerância a ela falhar em título fechado.
