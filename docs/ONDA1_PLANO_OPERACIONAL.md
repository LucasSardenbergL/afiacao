# Onda 1 — Plano Operacional Corrigido (v2)
## 100% aderente ao código real

---

## 1. Objetivo

Provar que o sync puxa dados reais do Omie, grava corretamente, e o frontend renderiza números que batem com os relatórios do Omie.

**Não será tratado:** conciliação, orçamento, intercompany, tributário, fechamento, cron, cockpit, stress test, DRE competência.

---

## 2. O que é validação vs implementação

### Apenas validar (código já existe):
- Sync de categorias, CC, CP, CR, movimentações
- Saldo bancário via ResumirContaCorrente
- Fluxo de caixa diário (view corrigida na migration 200300)
- DRE regime de caixa
- Warning de categorias não mapeadas
- Indicador "Último sync" no header
- Alertas financeiros (inadimplência, posição líquida)
- Export CSV
- Seleção de empresa individual no /financeiro/sync

### Provavelmente exigirá corrigir código:
- **Nomes de campos do Omie** — o código tenta vários nomes alternativos (ex: `t.codigo_lancamento_omie || t.nCodTitulo`), mas o Omie pode retornar um nome diferente de todos os previstos. debug_raw vai revelar isso.
- **Array wrapper da resposta** — o código tenta `result.conta_pagar_cadastro || result.titulosEncontrados`, mas o nome real pode ser outro.
- **Campo de paginação** — `result.total_de_paginas` pode ser `result.nTotPaginas` ou outro nome.
- **ResumirContaCorrente** — o campo de saldo pode ser `nSaldo`, `nSaldoAtual`, `saldo`, ou outro.
- **Parâmetros de filtro de data** — `dDtEmissaoDe` pode não ser aceito pelo Omie (silenciosamente ignorado), o que não é erro mas muda o volume de dados.
- **Status de título** — o Omie pode retornar valores como "BAIXADO", "EM CONCILIAÇÃO", "PROTESTADO" que o statusMap não cobre.

---

## 3. Checklist Sequencial

### Fase 0: Infraestrutura

```
[ ] 0.1 — Aplicar as 6 migrations no SQL Editor do Supabase, NESTA ORDEM:
      1. 20260328200000_financial_module.sql
      2. 20260328200100_fin_categoria_dre_mapping.sql
      3. 20260328200300_fix_fluxo_caixa_dre_regime.sql
      4. 20260328200400_fix_cron_sync.sql
      5. 20260328200500_financeiro_v2.sql
      6. 20260328200600_financeiro_v3_backend.sql

      Verificação: SELECT tablename FROM pg_tables WHERE tablename LIKE 'fin_%';
      Deve retornar: fin_categorias, fin_contas_correntes, fin_contas_pagar,
      fin_contas_receber, fin_movimentacoes, fin_dre_snapshots,
      fin_categoria_dre_mapping, fin_sync_log, fin_fechamentos,
      fin_fechamento_log, fin_conciliacao, fin_eliminacoes_intercompany,
      fin_eliminacoes_log, fin_orcamento, fin_forecast, fin_permissoes,
      fin_kpi_tributario, fin_sync_checkpoint, fin_confiabilidade

[ ] 0.2 — Deploy da edge function
      Terminal: supabase functions deploy omie-financeiro
      Ou: copiar conteúdo de supabase/functions/omie-financeiro/index.ts
      no Dashboard → Edge Functions → criar "omie-financeiro"

[ ] 0.3 — Configurar 6 secrets no Supabase
      Dashboard → Edge Functions → Manage secrets
      OMIE_VENDAS_APP_KEY          = [chave Oben]
      OMIE_VENDAS_APP_SECRET       = [secret Oben]
      OMIE_COLACOR_VENDAS_APP_KEY  = [chave Colacor]
      OMIE_COLACOR_VENDAS_APP_SECRET = [secret Colacor]
      OMIE_COLACOR_SC_APP_KEY      = [chave Colacor SC]
      OMIE_COLACOR_SC_APP_SECRET   = [secret Colacor SC]

      SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são auto-injetados.
      SUPABASE_ANON_KEY também (usado pelo validateCaller).

[ ] 0.4 — Verificar que o usuário logado tem role admin ou manager
      SELECT * FROM user_roles WHERE user_id = '[seu_user_id]';
      Se não tiver: INSERT INTO user_roles (user_id, role) VALUES ('[id]', 'admin');
```

### Fase 1: Debug Raw — Validar Parsing Antes de Sincronizar

**Esta fase é a mais importante. Pula ela e você vai debugar no escuro.**

```
[ ] 1.1 — Chamar debug_raw para contas_pagar da Oben
      POST [SUPABASE_URL]/functions/v1/omie-financeiro
      Headers: Authorization: Bearer [SEU_JWT_OU_SERVICE_KEY]
              Content-Type: application/json
      Body: {"action":"debug_raw","entidade":"contas_pagar","companies":["oben"]}

      Resposta esperada:
      {
        "oben": {
          "raw_response_keys": ["pagina","total_de_paginas","registros","conta_pagar_cadastro"],
          "array_key": "conta_pagar_cadastro",
          "record_count": 2,
          "first_record_sample": { ... todos os campos reais ... }
        }
      }

      ANOTAR:
      - Qual é o array_key real? (código espera "conta_pagar_cadastro")
      - O campo de código é "codigo_lancamento_omie"? Ou outro nome?
      - O campo de valor é "valor_documento"? Ou "nValorTitulo"?
      - O formato de data é DD/MM/YYYY? Ou YYYY-MM-DD?
      - Qual é o campo de status? "status_titulo"? Valores possíveis?
      - Qual é o campo de categoria? "codigo_categoria"?
      - O campo de paginação é "total_de_paginas"?

[ ] 1.2 — Chamar debug_raw para contas_receber da Oben
      Body: {"action":"debug_raw","entidade":"contas_receber","companies":["oben"]}
      Mesmas anotações.

[ ] 1.3 — Chamar debug_raw para categorias da Oben
      Body: {"action":"debug_raw","entidade":"categorias","companies":["oben"]}
      Verificar: campo "codigo", "descricao", "tipo_categoria".

[ ] 1.4 — Chamar debug_raw para contas_correntes da Oben
      Body: {"action":"debug_raw","entidade":"contas_correntes","companies":["oben"]}
      Verificar: "nCodCC", "cDescricao", "cInativa".

[ ] 1.5 — Chamar debug_raw para resumir_cc da Oben
      Primeiro: anotar um nCodCC real do passo 1.4
      Body: {"action":"debug_raw","entidade":"resumir_cc","ncodcc":NUMERO,"companies":["oben"]}
      Verificar: qual campo traz o saldo? "nSaldo"? "nSaldoAtual"? Outro?

[ ] 1.6 — Comparar campos do debug_raw com o que o código espera
      Abrir supabase/functions/omie-financeiro/index.ts
      Para cada entidade, verificar se o nome do campo no JSON real
      bate com o que o código lê (ex: t.codigo_lancamento_omie vs t.nCodTitulo).
      
      Se NÃO bater: corrigir o código, re-deploy, re-testar debug_raw.

[ ] 1.7 — Repetir 1.1-1.5 para Colacor e Colacor SC
      (os campos podem ser diferentes entre empresas se usarem módulos diferentes)
```

### Fase 2: Primeiro Sync Real

**Só avance se a Fase 1 não revelou incompatibilidades nos campos.**

```
[ ] 2.1 — No app: /financeiro/sync → selecionar "Oben" → Sync Categorias
      Verificar: fin_categorias tem registros? Quantos?
      Resultado esperado no card: ✅ com número de categorias

[ ] 2.2 — Sync Contas Correntes da Oben
      Verificar Table Editor: fin_contas_correntes → company=oben
      Conferir: saldo_atual e saldo_data estão preenchidos?
      Se saldo_atual = 0 para todas: F5 ocorreu (ver Fase 1.5)

[ ] 2.3 — Sync Contas a Pagar da Oben
      Verificar: fin_contas_pagar → company=oben
      ANOTAR: quantidade de registros

[ ] 2.4 — Sync Contas a Receber da Oben
      Verificar: fin_contas_receber → company=oben
      ANOTAR: quantidade de registros

[ ] 2.5 — Sync Movimentações da Oben
      Este pode falhar — endpoint menos estável.
      Se falhar: anotar erro, NÃO bloqueia a Onda 1.

[ ] 2.6 — Verificar fin_sync_log
      SQL: SELECT action, status, duracao_ms, api_calls, error_message
           FROM fin_sync_log ORDER BY started_at DESC LIMIT 10;
      Todos devem ter status = 'complete'.
      Se algum tem 'error': ler error_message.

[ ] 2.7 — Repetir 2.1-2.5 para Colacor
[ ] 2.8 — Repetir 2.1-2.5 para Colacor SC
```

### Fase 3: Validação Cruzada com Omie

```
[ ] 3.1 — SALDO BANCÁRIO
      Para cada conta corrente:
      | Empresa | Conta | Saldo Omie | Saldo App | OK? |
      Diferença aceitável: R$ 0,00

[ ] 3.2 — CONTAS A RECEBER (total aberto)
      Omie → Finanças → Contas a Receber → filtrar "Em Aberto"
      App → /financeiro → tab "A Receber" → filtrar "ABERTO"
      
      SQL de conferência:
      SELECT company, COUNT(*), SUM(valor_documento), SUM(saldo)
      FROM fin_contas_receber
      WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL')
      GROUP BY company;
      
      Comparar com o total do relatório Omie.
      Tolerância: < 2% (títulos em trânsito, timing de sync).

[ ] 3.3 — CONTAS A PAGAR (total aberto)
      Mesma lógica do 3.2 mas pra fin_contas_pagar.

[ ] 3.4 — AMOSTRA DE 5 TÍTULOS
      Pegar 5 títulos aleatórios no app (3 CR, 2 CP).
      Procurar cada um no Omie pelo número do documento.
      Conferir: valor, data vencimento, status, categoria.
```

### Fase 4: Validação do Fluxo de Caixa

```
[ ] 4.1 — Abrir /financeiro → tab "Fluxo de Caixa"
      Verificar que barras aparecem com dados.

[ ] 4.2 — Teste de dupla contagem (SQL direto)
      Escolher uma data que tenha CR E CP vencendo:
      
      -- Entradas do dia
      SELECT SUM(saldo) FROM fin_contas_receber
      WHERE company = 'oben' AND data_vencimento = '2026-04-01'
      AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');
      
      -- Saídas do dia
      SELECT SUM(saldo) FROM fin_contas_pagar
      WHERE company = 'oben' AND data_vencimento = '2026-04-01'
      AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');
      
      -- View
      SELECT entradas_previstas, saidas_previstas
      FROM fin_fluxo_caixa_diario
      WHERE company = 'oben' AND data = '2026-04-01';
      
      Os valores devem bater.
```

### Fase 5: Mapeamento de Categorias

```
[ ] 5.1 — Abrir /financeiro/mapping → selecionar "Oben"
      Verificar: seção "sem mapeamento" mostra categorias?
      Se vazio: ou todas já estão mapeadas pelo seed, ou o sync de
      categorias não trouxe dados (voltar Fase 2.1).

[ ] 5.2 — Para cada categoria SEM mapeamento:
      Classificar na linha DRE correta.
      Referência rápida de códigos Omie:
        1.XX = receita
        2.XX = custos/CMV
        3.01 = desp. administrativas
        3.02 = desp. comerciais
        4.01 = desp. financeiras
        4.02 = rec. financeiras
        5.XX = impostos

[ ] 5.3 — Repetir para Colacor e Colacor SC

[ ] 5.4 — Verificar cobertura:
      SQL: 
      WITH cats_usadas AS (
        SELECT DISTINCT company, categoria_codigo FROM fin_contas_receber WHERE categoria_codigo != ''
        UNION
        SELECT DISTINCT company, categoria_codigo FROM fin_contas_pagar WHERE categoria_codigo != ''
      )
      SELECT 
        c.company,
        COUNT(*) AS total_cats,
        COUNT(m.id) AS mapeadas,
        COUNT(*) - COUNT(m.id) AS faltando
      FROM cats_usadas c
      LEFT JOIN fin_categoria_dre_mapping m 
        ON (m.company = c.company OR m.company = '_default') 
        AND m.omie_codigo = c.categoria_codigo
      GROUP BY c.company;
      
      Meta: "faltando" = 0 (ou o mais próximo possível de 0)
```

### Fase 6: Validação da DRE

```
[ ] 6.1 — /financeiro/sync → "Calcular DRE 2026"
      (Ou 2025, conforme período com dados)

[ ] 6.2 — /financeiro → tab "DRE"
      Verificar:
      - Badge "Regime de Caixa" aparece? ✓/✗
      - Warning amarelo de categorias heurísticas aparece? ✓/✗
        (se Fase 5 mapeou tudo, NÃO deve aparecer — isso é bom)

[ ] 6.3 — Comparar com Omie (se disponível):
      Omie → Relatórios → Demonstrativo de Resultados → mesmo mês
      | Linha         | Omie    | App     | Diferença |
      | Receita Bruta |         |         |           |
      | CMV           |         |         |           |
      | Lucro Bruto   |         |         |           |
      | Resultado Líq |         |         |           |
      
      Se diferença > 10%: categorias mal mapeadas. Voltar Fase 5.
      Se diferença > 30%: bug de parsing ou filtro de data cortando. Voltar Fase 1.
```

### Fase 7: Frontend Ponta a Ponta

```
[ ] 7.1 — "Último sync" aparece no header?
      (Só aparece APÓS o primeiro sync ter gravado dados nas tabelas)

[ ] 7.2 — Alternar entre Consolidado / Oben / Colacor / Colacor SC
      Valores mudam a cada seleção? Consolidado = soma das 3?

[ ] 7.3 — Tab "A Receber" → filtrar "VENCIDO" → conferir 2 títulos no Omie
[ ] 7.4 — Tab "A Pagar" → filtrar "ABERTO" → conferir 2 títulos no Omie
[ ] 7.5 — Exportar CSV de CR → abrir no Excel → acentos OK?
[ ] 7.6 — Capital de Giro: PMR e PMP > 0? Projeção 30d coerente?
[ ] 7.7 — Alertas: se inadimplência > 20%, aparece alerta vermelho?
```

---

## 4. Critérios de Aceite Revisados

### Obrigatório (bloqueia produção):
```
✅ debug_raw retorna JSON válido para as 3 empresas (prova que credenciais funcionam)
✅ Sync rodou com status = 'complete' no fin_sync_log para todas as entidades
✅ fin_contas_correntes tem saldo_atual preenchido (não zero) para pelo menos 1 CC por empresa
✅ Saldo bancário no app = saldo no Omie (R$ 0,00 de diferença)
✅ COUNT de CR abertos no app vs Omie: diferença < 2%
✅ COUNT de CP abertos no app vs Omie: diferença < 2%
✅ SUM de CR abertos no app vs Omie: diferença < 2%
✅ SUM de CP abertos no app vs Omie: diferença < 2%
✅ Teste de dupla contagem no fluxo de caixa: PASSOU
✅ Nenhuma categoria com >5% do valor total está classificada por heurística
✅ DRE Receita Bruta vs Omie: diferença < 5%
✅ "Último sync" visível no header após sincronização
```

### Desejável (não bloqueia):
```
○ Movimentações financeiras sincronizadas
○ Todas as categorias mapeadas (0 heurísticas)
○ DRE Resultado Líquido vs Omie: diferença < 10%
○ PMR e PMP calculados > 0
○ Alertas financeiros disparam corretamente
○ CSV com encoding correto
```

---

## 5. Matriz de Falhas (atualizada)

| # | Falha | Sintoma | Diagnóstico | Correção | Arquivo:Linha |
|---|-------|---------|-------------|----------|---------------|
| F1 | Credenciais erradas | `"Credenciais Omie (oben) não configuradas"` | Dashboard → Secrets | Verificar nomes exatos | edge function:14-33 |
| F2 | Campo com nome diferente | Valores 0, null, ou string vazia em colunas que deveriam ter dados | Comparar `debug_raw.first_record_sample` com campos no código | Ajustar o fallback `t.campo_esperado \|\| t.campo_alternativo` | edge function:235-295 (CP), 354-408 (CR) |
| F3 | Array wrapper errado | `totalSynced: 0` mas Omie tem dados | `debug_raw.array_key` mostra o nome real | Ajustar `result.NOME_REAL \|\| result.fallback` | edge function:232-233 (CP), 351-352 (CR) |
| F4 | Data em formato inesperado | Todas as datas null | Verificar `debug_raw.first_record_sample.data_vencimento` | Ajustar `parseOmieDate` se formato for diferente | edge function:752-770 |
| F5 | ResumirContaCorrente campo errado | Todas CC com saldo = 0 | `debug_raw` com entidade `resumir_cc` | Ajustar `saldoResult.CAMPO_REAL` | edge function:157-170 |
| F6 | Rate limiting | Sync para no meio | `rate_limits_hit` no fin_sync_log | Rodar 1 empresa por vez, não 3 de uma vez | edge function:70 |
| F7 | Título sem código | Erro de unique constraint | Log mostra `X títulos sem código, ignorados` | Já corrigido com filtro validRows | edge function:297-300 (CP), 410-413 (CR) |
| F8 | Status não mapeado | Títulos pagos aparecem como ABERTO | `SELECT DISTINCT status_titulo FROM fin_contas_pagar` | Adicionar ao statusMap | edge function:236-243 (CP), 355-364 (CR) |
| F9 | Categorias ruins | DRE com tudo em Desp. Operacionais | /financeiro/mapping mostra categorias não mapeadas | Mapear manualmente | Trabalho do operador |
| F10 | Filtro de data ignorado | Volume muito grande ou muito pequeno | Comparar contagem com/sem filtro | Testar `filtro_data_de: "01/01/2020"` | edge function:220-221 |

---

## 6. Entregáveis

### Deve funcionar ao final da Onda 1:
- Sync manual das 3 empresas com dados corretos
- Saldos bancários conferidos
- CR/CP conferidos com Omie
- Categorias mapeadas
- DRE gerencial coerente com Omie
- Dashboard alternando entre empresas
- Indicador de último sync

### Fica para Onda 2:
- Cron automático
- Conciliação bancária
- Movimentações (se falhar na Onda 1)
- Orçado vs realizado
- Intercompany
- Tributário
- Fechamento mensal
- Projeção 13 semanas

---

## Timeline

**Dia 1 (2-3h):** Fase 0 (infra) + Fase 1 (debug_raw de todas as entidades e empresas)
**Dia 2 (2-3h):** Corrigir campos se necessário → Fase 2 (sync real) → Fase 3 (validação cruzada)
**Dia 3 (1-2h):** Fase 4 (fluxo) + Fase 5 (mapping) + Fase 6 (DRE) + Fase 7 (frontend)
**Dia 4:** Buffer para correções
