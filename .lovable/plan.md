# Sync OBEN, fix do WFOI.6857QT e baixo giro

## 1. Diagnóstico atual (já levantado)

- **OBEN tem 380 SKUs** ativos em `sku_parametros`.
- **Estoque atual sincronizado:** 130 / 380 (250 sem registro em `sku_estoque_atual`).
- **Status Omie sincronizado:** 0 / 380. O `omie-sync-status-produtos` nunca rodou pra OBEN.
- **Última sync de estoque:** 2026-05-10. Cron está rodando, mas com cobertura parcial.
- **Todos os 380 SKUs estão sem fornecedor** (`fornecedor_codigo_omie IS NULL`).
- **211 SKUs são classe BY/BZ/CY/CZ** (baixo giro).
- **WFOI.6857QT** existe (Omie 8689767990), classe CY, ativo, mas: sem fornecedor, sem ponto de pedido, sem estoque sincronizado, sem registro em `sku_status_omie`. Sem histórico de NFe pra deduzir fornecedor.

## 2. O que vou entregar

### A) Diagnóstico do sync OBEN
1. Adicionar uma tela / cartão em `/admin/reposicao/parametros` (aba "Cadastros") com:
   - Cobertura: SKUs com parâmetro × SKUs com estoque sincronizado × SKUs com status Omie.
   - Lista expansível dos SKUs faltantes em cada lado.
   - Botão "Forçar sync de status produtos OBEN" que dispara o `omie-sync-status-produtos` por empresa.
2. Investigar por que `omie-sync-estoque` só pega 130/380. Hipóteses já mapeadas: filtro do sync exige fornecedor habilitado e SKU listado em `ListarPosicaoEstoque` — SKUs sem fornecedor nunca entram. Vou confirmar e documentar a regra real.

### B) Fix curto prazo do WFOI.6857QT
Não consigo atribuir fornecedor sozinho — não há histórico de NFe nem cadastro Omie no banco local. **Preciso que você me informe o nome do fornecedor**. Assim que souber, faço:
1. `UPDATE sku_parametros SET fornecedor_codigo_omie/nome` para os 2 SKUs (WFOI e WFOT 6857QT).
2. Disparar `omie-sync-status-produtos` e `omie-sync-estoque` pra essa empresa.
3. Rodar o cálculo de gatilho (item C) pra esses SKUs.

### C) Cálculo de gatilho (ponto de pedido / estoque mínimo)
Verifico se já existe uma edge function de cálculo (`calculate-scores` ou similar) que preencha `ponto_pedido` e `estoque_minimo`. Se existir, garanto que ela rode pros SKUs corrigidos. Se não existir ou não cobrir esses casos, crio uma edge function pequena `reposicao-calcular-gatilho` que aplica a fórmula:
- `ponto_pedido = demanda_media_diaria × (lt_medio_dias_uteis + z × lt_desvio_padrao)`
- `estoque_seguranca = z × demanda_desvio_padrao × √lt`
- `estoque_minimo = estoque_seguranca`
- z derivado da `classe_consolidada` (A=2.33, B=1.65, C=1.28).

Onde dados estatísticos não existem ainda (item zerado de fato), aplico a regra do item D abaixo.

### D) Regra "baixo giro: sugere 1 unidade"
Para SKUs com `classe_consolidada IN ('AY','AZ','BY','BZ','CY','CZ')` **OU** `demanda_media_diaria < 0.05` (≈ 1,5 un/mês):
1. No motor que popula `pedido_compra_sugerido` (vou localizar o cron / edge function que gera as sugestões), adicionar branch:
   - Se `estoque_disponivel = 0` e SKU tem fornecedor habilitado, **sugere `qtd_sugerida = max(lote_minimo_fornecedor, 1)`** com `motivo = 'baixo_giro_estoque_zerado'` e flag `requer_validacao_humana = true`.
2. Na tela do Cockpit, esses itens já caem no modo "review" (graças ao `calcApprovalSuggestion` que classifica como manual quando há `requer_validacao_humana` ou ausência de histórico). Confirmo o badge "Validar".
3. Adiciono campo `motivo` (string) ou reuso `detalhes` JSONB se já existir, sem migração disruptiva.

### E) Memória de regra
Salvo em `mem://business-rules/reposicao-baixo-giro` a regra dos itens D pra futuras alterações respeitarem.

## Detalhes técnicos

- **Sem schema novo agressivo**: vou tentar reaproveitar colunas existentes em `pedido_compra_sugerido`. Se faltar `motivo`/`requer_validacao_humana`, faço UMA migration aditiva mínima (NULL default).
- **Funções afetadas**: `omie-sync-status-produtos`, `omie-sync-estoque`, e o gerador de sugestões (vou identificar — provavelmente `gerar-pedidos-diario` ou `calculate-scores`).
- **UI**: adições não destrutivas em `AdminReposicaoParametros.tsx` e no Cockpit.
- **Auto-resolução de alertas** (do que já entreguei) continua valendo.

## Pergunta para destravar

**Qual fornecedor atribuir aos SKUs WFOI.6857QT e WFOT.6857QT?** Posso te trazer a lista de fornecedores OBEN habilitados pra você escolher, se preferir.
