# fin-cashflow-engine: uma carga de dados para os 3 cenários (plano v7, lote 1 — D10)

**Data:** 2026-11-05 · **Edge:** `fin-cashflow-engine` v2.2 → **v2.3-carga-unica-cenarios** · **Migration:** `20261105160000_fin_cashflow_cron_carga_unica.sql`

## O incidente

Em 05/11 o snapshot de caixa da colacor saiu **sem o cenário realista** (`fin_projecao_snapshots`:
otimista + pessimista). `net._http_response` das 10:05Z: HTTP 500
`Leitura de fin_titulo_baixas_cr_mapa falhou (código 57014)`. Cada job do cron disparava **3
chamadas por empresa** (uma por cenário), e cada chamada fazia a carga inteira — CR/CP paginados,
prazos, estoque e o mapa de baixas (~3,9 s com spill de temp na colacor, sob o `statement_timeout`
de 8 s). Três mapas concorrentes por empresa. Recorrência: 10 dias com menos de 3 cenários entre
10 e 20/10 (antes do escalonamento por empresa, `20261020120100`) e de novo em 05/11.
`_shared/baixas-cr.ts` falhou fechado, como devia (ausente ≠ zero): o cenário sumiu, não saiu errado.

## O que mudou

- **Edge (v2.3):** novo input `cenarios: [...]`, exclusivo com `cenario` e validado antes de
  qualquer leitura (vazio, repetido, desconhecido ou misturado → 400 sem efeito). A carga é
  **uma** por invocação (preguiçosa, memoizada) e cada cenário roda o MESMO `calcularComDados` do
  caminho de cenário único, em série, cada um no seu `comRegistro` — a série de `acoes_execucoes`
  continua com 1 registro por combo. Falha isolada por cenário (um INSERT recusado não leva os
  outros); qualquer falha → HTTP 500 com o detalhe por cenário. **Sem retry:** a persistência é
  INSERT. O caminho `cenario` único (usado pela tela) não mudou.
- **Cron:** os 3 jobs (mesmos nomes e horários) fazem **1 chamada por empresa** com os 3 cenários.
  A migration tem **pré-condição de ordem**: a atestação mais recente da edge em
  `deploy_atestacoes` tem de ser a v2.3 — a v2.2 ignora `cenarios` e gravaria só o realista com
  HTTP 200.
- **Cortado (plano):** cache do mapa por empresa/dia (frescor e invalidação num caminho
  financeiro). `work_mem` local segue experimento, não causa provada.

## Provas

<!-- preenchido com a evidência colada da sessão -->

## Deploy

<!-- edge (MCP Lovable) → sonda → migration (db:aplicar) → ciclo seguinte em fin_projecao_snapshots -->
