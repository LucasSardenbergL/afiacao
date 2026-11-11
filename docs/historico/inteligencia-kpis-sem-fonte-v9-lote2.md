# KPIs sem fonte saem de `/intelligence` e os agregados dizem que são o top-50 (plano v9, lote 2: C17 fatia 1)

> Plano: [`2026-11-11-plano-melhoria-v9`](../superpowers/plans/2026-11-11-plano-melhoria-v9/README.md),
> linha C17 e §4 (lote 2). Parecer do Codex: `anexos/codex-contestacao.md`, seção C17 (AJUSTAR).
> Precedente: o C15 do v8 ([estados-honestos-home-shell-inteligencia-v8-lote6.md](estados-honestos-home-shell-inteligencia-v8-lote6.md)),
> que removeu LTV e CAC. Só front: **Publish** (do founder), sem edge e sem migration.

## O que mudou

- **"Margem Própria" e "Ticket Médio" saíram** (`IntelligenceOperationalTab.tsx`). Os dois somavam
  `farmer_calls` com `Number(x || 0)`. Em prod a tabela tem 0 linhas (telefonia congelada), então os
  cards mostravam R$ 0 fixo como fato. A query de `farmer_calls` saiu junto: nada mais a lê nesta aba.
  Mesmo contrato do C15: remover, não rotular, porque um card em R$ afirma um número que não existe.
- **"Market Share Est." saiu** (`IntelligenceStrategicTab.tsx`). Era clientes ÷ max(clientes × 3, 100),
  que dá 33,3% fixo a partir de 34 clientes, sem nenhum dado de mercado. A linha de KPIs ficou com
  Elasticidade, Sensibilidade a Desconto e Margem Global (grade de 3).
- **A aba Operacional lê o erro.** Antes ela só olhava `isLoading`: falha dos scores virava "0 clientes
  em risco" e média "—"/0, e um refetch que falhava deixava o valor velho sem aviso. Agora usa o par
  `estadoDeLeitura`/`naoConsegui` + `desatualizado` (o mesmo do `StrategicTab`): sem leitura e sem
  cache, alerta e "—" em Health Score, Priority Score, distribuição e clientes em risco; com cache, o
  último dado bom e o aviso de desatualizado. A falha do IEE (`farmer_performance_scores`) também é
  anunciada; antes o bloco só sumia.
- **Os agregados dizem de onde saem.** A leitura continua `.order('priority_score', desc).limit(50)`,
  agora com a constante `LIMITE_PRIORIDADE`. Com 50 linhas lidas, o rótulo é "50 clientes de maior
  prioridade" (nos dois KPIs, na distribuição e em clientes em risco); abaixo do limite, "N clientes
  com score". O subtítulo "Carteira" e o título "Distribuição de Saúde da Carteira" saíram.
- **Ausente ≠ zero nas médias e no IEE.** As médias de health/priority usavam `Number(x || 0)` e
  puxavam a média para baixo quando o score faltava; agora só os valores conhecidos entram. Componente
  do IEE sem valor mostra "—", não 0%.

## Fora do escopo (de propósito)

- **Fatia 2, o KPI da carteira de verdade.** Tirar o `.limit(50)` só troca o corte de 50 pelo de 1.000
  do PostgREST (a tabela tem 17.002 linhas e 3 farmers). O caminho é um agregado no servidor, com a
  população definida (filtro de farmer, cliente em mais de um farmer). Espera o founder querer o KPI.
- A leitura de `profiles` da aba Operacional (nomes da lista de risco) é single-shot sem paginação;
  já está na baseline do `single-shot-truncado-gate`. Nome que falta cai no prefixo do UUID, não
  fabrica número.

## Evidência

Testes em `src/components/intelligence/__tests__/tabs-erro-honesto.test.tsx` (suíte nova da aba
Operacional, 8 casos, cada um com CONTROLE no mesmo render) e os ajustes nos casos que esperavam o
Market Share (`tabs-erro-honesto`, `auditoria-margem-execucao`). A falsificação (sabotar cada conserto
e exigir vermelho, nos dois locales) está no corpo do PR.
