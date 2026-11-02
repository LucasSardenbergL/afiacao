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

Por empresa, sob o lease já existente:

1. `fin_sync_cursor(contas_receber).next_page` pendente → **continua o full** (comportamento atual).
2. Sem marca d'água incremental, `full_ok` > 7 d, marca > 10 d, ou estado ilegível → **full**
   (página 1). Estado em `sync_state` (padrão `deveRodarCompleto`, docs/agent/sync.md): 1 linha por
   marcador × empresa, cada uma com UM writer — `fin_cr_full_inicio`, `fin_cr_full_ok`,
   `fin_cr_incremental_ok` (`last_sync_at` = `t0` do run íntegro; a marca d'água é a data BRT dele).
   Sem a migration aplicada (RPC/coluna ausentes) o incremental falha FECHADO para o full = exatamente o
   comportamento de hoje — o deploy da edge não depende da ordem da migration.
3. Senão → **incremental**.

### 3.2 Incremental (1 invocação, sem continuação)

`t0 = now()`, `hoje = hojeSP()`.

- **A — conjunto aberto completo**: `filtrar_apenas_titulos_em_aberto=S`, paginação com os MESMOS
  guards do full (piso monotônico, vazia antes do piso = anomalia que lança, página repetida lança,
  `!result` fora de budget lança). Upsert por página. Recalcula o status relativo ao dia de TODO aberto.
- **B — alterados**: `filtrar_por_data_de = marca − 1 dia`, `ate = hoje`, `filtrar_apenas_alteracao=S`,
  mesmos guards. Upsert por página. Roda DEPOIS de A: a observação mais nova vence (título baixado entre
  A e B chega como RECEBIDO).
- Budget estourado em A ou B → **lança** (log `error`, watchdog). Não avança marca, não reconcilia.
- **C — reconciliação** (RPC, §3.4) com `vistos = códigos(A ∪ B)`, universo = abertos.
- **Marca d'água** = `hoje` (data de `t0`), gravada só depois de A+B+C íntegros. A sobreposição de
  1 dia cobre a granularidade de dia e alteração durante o próprio run.

Custo medido: A = 2/4/9 páginas (colacor_sc/colacor/oben), B ≈ 1–2 páginas → ~20 páginas/run nas 3
empresas, contra ~450. Cabe em uma invocação (~30 s).

### 3.3 Full (rede de segurança, semanal)

Igual ao de hoje (cursor + continuação). Novo: na página 1 grava `full_iniciado_em`; ao alcançar o
fim real, roda a reconciliação com universo = todos e "visto" = `updated_at ≥ full_iniciado_em`, e só
então grava `full_ok_em` e `marca = data(full_iniciado_em)`.

**Por que semanal e não diário:** o que o crédito lê (o aberto) é refeito INTEIRO a cada run por A; o
que muda num título fechado (estorno, cancelamento) carimba `dAlt` e entra por B. O full só pega o
desconhecido em título FECHADO (exclusão de RECEBIDO/CANCELADO — 5 linhas, R$ 2,6 mil, hoje) e erro de
marca d'água — nenhum dos dois alimenta DSO (que sai de `fin_movimentacoes`/`v_titulo_baixas`).

### 3.4 Reconciliação de exclusões — `fin_cr_reconciliar_ausentes` (SQL, 1 transação)

- Coluna dedicada `fin_contas_receber.ausente_omie_desde timestamptz` (1 writer: esta RPC; não vai no
  payload do upsert — não é jsonb multi-writer).
- Visto → `ausente_omie_desde = NULL`.
- Não visto, no universo, sem marca → marca `t0` (**candidato**). Não apaga.
- Não visto, no universo, marcado por run ANTERIOR (`ausente_omie_desde < t0`) → **tombstone**
  (`fin_contas_receber_excluidos`: linha inteira em jsonb + datas) **e DELETE**.
- Duas ausências em runs completos distintos, porque a listagem paginada **desliza** (título que sai do
  aberto no meio de A empurra outro para fora da janela da página — docs/agent/sync.md, estoque). Um
  falso candidato reaparece no A seguinte e a marca é limpa.
- **Teto**: candidatos novos + confirmações > `max(5, 10% do universo)` → `RAISE` sem escrever nada
  (contrato do Omie mudou, filtro trocou de semântica). Hoje: 29/860 = 3,4% (oben), 7/116 = 6% (sc).
- Por que DELETE (com tombstone) e não um status novo: `status_titulo` é texto livre (CHECK dropado em
  20260329) e ~13 leitores só NEGAM `CANCELADO`/`RECEBIDO` — `fin_aging_receber`,
  `v_grupo_contas_receber(_por_doc)`, `v_ciclo_*`, `fin_consolidado_intercompany`,
  `fin_dre_competencia_base`, `cobranca_quitacao_ok`, `fin-cashflow-engine`, `titulos-dre.ts`,
  `fin-valor-cockpit` (`tituloFaturavelAR`), `financeiroV2Service` — e contariam `EXCLUIDO` como aberto ou
  faturável. Ausência de linha todos já tratam. Única FK: `fin_ic_matches.cr_id ON DELETE SET NULL`
  (o tombstone guarda o `id`). Nenhum DELETE desta tabela existe hoje no código.
- Efeito em `cobranca_quitacao_ok`: hoje o fantasma ABERTO bloqueia a quitação do cliente para sempre;
  depois do DELETE ela passa a depender só dos títulos reais.
- **Não** confirma exclusão chamando `ConsultarContaReceber` por título (§6).

### 3.5 Frescor (`_data_health_compute`)

`_data_health_compute` (20261031191715:116-123): `max(cr.updated_at)` GLOBAL (sem empresa), stale
> 26 h. `cobranca_quitacao_ok` e `fin_calcular_confiabilidade` leem `fin_sync_log` complete de
`sync_contas_receber` ≤ 24 h — o incremental grava a mesma linha por empresa por run. A reescreve todo aberto a cada run → `updated_at` do conjunto que
o crédito lê continua sendo frescor real.

## 4. Régua (para a prova e para o Codex)

- **Unidade decisória:** título aberto por cliente (trava de crédito, aging, inadimplência).
- **Onde aparece:** `fin_contas_receber.status_titulo ∈ {ATRASADO, A VENCER, VENCE HOJE}`.
- **Denominador:** abertos por empresa (oben 860 · colacor 330 · sc 116).
- **Falsificação:** prova PG17 da RPC com baixa (sai do aberto, chega em B), estorno (volta ao aberto,
  chega em A), exclusão (some de A e B: marca no run 1, tombstone+delete no run 2), deslize (some de A
  num run só: marca e limpa), teto (RAISE sem escrita) — e sabotar uma camada por vez.
- **Ordem do irreversível:** o DELETE só acontece no 2º run completo; o tombstone é gravado na mesma
  transação, antes.

## 5. Observação pós-deploy

1º incremental por empresa: `results` no `fin_sync_log` traz `modo`, `paginas_a/b`, `vistos`,
`marcados`, `excluidos`. Esperado no 1º run: oben 29 / sc 7 / colacor 2 marcados; no 2º, os mesmos
excluídos.

## 6. Incidente da medição

A sonda consultou ~14 títulos inexistentes em minutos e o Omie respondeu
`API bloqueada por consumo indevido. Tente novamente em 1800 segundos` (oben, 2026-11-02 ~01:35 UTC,
domingo 22:35 BRT). Nenhum cron do `omie-financeiro` roda nessa janela. Lição de desenho: "não
cadastrado" conta como consumo indevido → confirmar exclusão título a título derrubaria a conta.
