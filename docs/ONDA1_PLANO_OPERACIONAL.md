# Plano Operacional — Onda 1
## Validação do Módulo Financeiro com Dados Reais do Omie

---

## 1. Objetivo da Onda 1

### O que precisa ser provado

Que o sync puxa dados reais do Omie, grava corretamente no Supabase, e o frontend renderiza números que batem com os relatórios do Omie. Especificamente:

- A edge function `omie-financeiro` conecta, autentica e pagina corretamente nas 3 empresas
- Os campos do JSON de retorno do Omie são mapeados para as colunas certas da tabela
- Os saldos bancários conferem com o Omie (diferença aceitável: R$ 0,00)
- O total de CR aberto no app confere com o relatório de Contas a Receber do Omie (tolerância: < 1%)
- O total de CP aberto no app confere com o relatório de Contas a Pagar do Omie (tolerância: < 1%)
- O fluxo de caixa não duplica valores
- A DRE gerencial produz um resultado que faça sentido (mesmo que categorias precisem de ajuste)
- As categorias do Omie aparecem na tela de mapping

### O que NÃO será tratado agora

- Conciliação bancária (precisa de dados estáveis primeiro)
- Orçamento (precisa de input do Lucas)
- Intercompany / eliminações (validar se existe volume antes)
- Tributário (informativo, não bloqueia)
- Fechamento mensal (1 operador, sem equipe)
- DRE por competência
- Cron automático (sync manual por 2-4 semanas)
- Cockpit CFO (dashboard principal é suficiente)
- Stress test (precisa de dados reais pra ter sentido)

---

## 2. Checklist de Validação com Dados Reais

### Fase 0: Infraestrutura (30 minutos)

```
[ ] 0.1 — Verificar se as 7 migrations foram aplicadas no Supabase
      → SQL Editor → verificar se tabelas fin_* existem
      → Se não: aplicar manualmente cada migration no SQL Editor, na ordem:
        20260328200000, 200100, 200300, 200400, 200500, 200600

[ ] 0.2 — Verificar se a edge function está deployada
      → Supabase Dashboard → Edge Functions → omie-financeiro deve aparecer
      → Se não: rodar `supabase functions deploy omie-financeiro`

[ ] 0.3 — Configurar credenciais no Supabase
      → Edge Functions → Manage secrets (ou Settings → Edge Functions → Secrets)
      → Adicionar 6 variáveis:
        OMIE_VENDAS_APP_KEY          = [chave da Oben]
        OMIE_VENDAS_APP_SECRET       = [secret da Oben]
        OMIE_COLACOR_VENDAS_APP_KEY  = [chave da Colacor]
        OMIE_COLACOR_VENDAS_APP_SECRET = [secret da Colacor]
        OMIE_COLACOR_SC_APP_KEY      = [chave da Colacor SC]
        OMIE_COLACOR_SC_APP_SECRET   = [secret da Colacor SC]

[ ] 0.4 — Verificar que SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
      existem como secrets automáticos (o Supabase injeta esses)
```

### Fase 1: Primeiro Sync — Uma Empresa de Cada Vez (1-2 horas)

**NÃO comece com sync_all. Teste entidade por entidade, empresa por empresa.**

```
[ ] 1.1 — Sync categorias da Oben (menor risco, sem dados sensíveis)
      → No app: /financeiro/sync → selecionar "Oben" → clicar "Sync" em Categorias
      → OU via curl/Postman:
        POST [SUPABASE_URL]/functions/v1/omie-financeiro
        Headers: Authorization: Bearer [ANON_KEY], Content-Type: application/json
        Body: {"action":"sync_categorias","companies":["oben"]}
      → Verificar resposta: {"success":true,"oben":{"totalSynced":XX}}
      → Verificar no Supabase: Table Editor → fin_categorias → filtrar company=oben
      → ANOTAR: quantas categorias vieram? Tem tipo R, D, T?

[ ] 1.2 — Sync contas correntes da Oben
      → Mesma mecânica: {"action":"sync_contas_correntes","companies":["oben"]}
      → VALIDAÇÃO CRÍTICA: abrir o Omie da Oben → Finanças → Contas Correntes
      → Comparar: mesmo número de contas? Mesmos nomes? Saldo bate?
      → ANOTAR: saldo de cada CC no Omie vs. no app

[ ] 1.3 — Sync contas a pagar da Oben
      → {"action":"sync_contas_pagar","companies":["oben"]}
      → Se falhar: anotar o erro exato (ver seção 4 - Falhas Esperadas)
      → VALIDAÇÃO: Omie → Finanças → Contas a Pagar → filtrar 6 meses
      → Comparar: total de títulos? Soma de valores?
      → ANOTAR: Total títulos Omie vs app, Soma R$ Omie vs app

[ ] 1.4 — Sync contas a receber da Oben
      → {"action":"sync_contas_receber","companies":["oben"]}
      → VALIDAÇÃO: mesma lógica do CP
      → ANOTAR: totais e diferenças

[ ] 1.5 — Sync movimentações da Oben
      → {"action":"sync_movimentacoes","companies":["oben"]}
      → Este é o mais provável de falhar (endpoint menos estável)
      → ANOTAR: sucesso/falha, quantidade

[ ] 1.6 — Repetir 1.1 a 1.5 para Colacor
[ ] 1.7 — Repetir 1.1 a 1.5 para Colacor SC
```

### Fase 2: Validação de Saldos (30 minutos)

```
[ ] 2.1 — Abrir /financeiro no app → tab "Visão Geral"
      → Conferir "Saldo Bancário" com o que o Omie mostra
      → Para CADA conta corrente, anotar:
        | Conta | Saldo Omie | Saldo App | Diferença |
      → Diferença aceitável: R$ 0,00 (saldo é snapshot, não cálculo)

[ ] 2.2 — Conferir "A Receber" total com relatório Omie
      → Omie → Finanças → Contas a Receber → filtrar "Em Aberto"
      → Soma no Omie vs. soma no app
      → Tolerância: < 1% (diferença por títulos em trânsito)

[ ] 2.3 — Conferir "A Pagar" total com relatório Omie
      → Mesma lógica
```

### Fase 3: Validação do Fluxo de Caixa (30 minutos)

```
[ ] 3.1 — Abrir /financeiro → tab "Fluxo de Caixa"
      → Verificar que existem barras de entradas e saídas
      → Selecionar uma semana específica com movimentação conhecida
      → Comparar entradas da semana com CR vencendo naquela semana
      → NÃO deve haver valor duplicado

[ ] 3.2 — Teste de duplicação: no Table Editor, rodar:
      SELECT data, SUM(entradas_previstas), SUM(saidas_previstas)
      FROM fin_fluxo_caixa_diario
      WHERE company = 'oben' AND data = '2026-03-28'
      GROUP BY data;
      → Comparar com:
      SELECT SUM(saldo) FROM fin_contas_receber
      WHERE company = 'oben' AND data_vencimento = '2026-03-28'
      AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');
      → Os valores devem ser iguais
```

### Fase 4: Mapeamento de Categorias (30-60 minutos)

```
[ ] 4.1 — Abrir /financeiro/mapping
      → Selecionar "Oben" no dropdown de empresa
      → Verificar se as categorias aparecem na seção "sem mapeamento"
      → Se não aparecem: as categorias foram sincronizadas? Verificar fin_categorias

[ ] 4.2 — Para cada categoria listada como "sem mapeamento":
      → Classificar manualmente:
        - Códigos 1.0X.XX → receita_bruta (exceto devoluções)
        - Códigos 2.0X.XX → cmv
        - Códigos 3.01.XX → despesas_administrativas
        - Códigos 3.02.XX → despesas_comerciais
        - Códigos 4.01.XX → despesas_financeiras
        - Códigos 4.02.XX → receitas_financeiras
        - Códigos 5.XX.XX → impostos
      → Na dúvida: abrir a categoria no Omie e ver onde ela é usada

[ ] 4.3 — Repetir para Colacor e Colacor SC
      → Ou usar o mapping "Padrão" se as categorias forem iguais

[ ] 4.4 — ANOTAR: quantas categorias mapeadas vs total
      → Meta: > 80% do VALOR mapeado explicitamente
```

### Fase 5: Validação da DRE (30 minutos)

```
[ ] 5.1 — Voltar em /financeiro/sync → "Calcular DRE 2026"
      → Selecionar todas as empresas
      → Aguardar conclusão

[ ] 5.2 — Abrir /financeiro → tab "DRE"
      → Verificar se o warning de "categorias heurísticas" aparece
      → Se sim: voltar à Fase 4 e mapear as categorias faltantes

[ ] 5.3 — Comparar DRE com relatório gerencial do Omie
      → Omie → Relatórios → Demonstrativo de Resultados
      → Comparar: Receita Bruta, CMV, Lucro Bruto, Resultado Líquido
      → ANOTAR: | Linha | Omie | App | Diferença |
      → Tolerância: < 5% (diferenças por categorização)
      → Se > 10%: problema de mapeamento, voltar à Fase 4

[ ] 5.4 — Verificar que o label "Regime de Caixa" aparece na DRE
```

### Fase 6: Validação Frontend Ponta a Ponta (30 minutos)

```
[ ] 6.1 — Verificar que "Último sync" aparece no header do dashboard
      → Deve mostrar data/hora da sincronização mais recente

[ ] 6.2 — Alternar entre empresas no selector
      → Consolidado, Oben, Colacor, Colacor SC
      → Valores devem mudar a cada seleção
      → Consolidado = soma das 3

[ ] 6.3 — Tab "A Receber" → filtrar "VENCIDO"
      → Verificar que os títulos que aparecem estão de fato vencidos
      → Conferir 3 títulos manualmente no Omie

[ ] 6.4 — Tab "A Pagar" → filtrar "ABERTO"
      → Mesma lógica: conferir 3 títulos no Omie

[ ] 6.5 — Exportar CSV de CR e CP
      → Abrir no Excel, verificar que colunas estão corretas
      → Verificar encoding (acentos devem aparecer corretos)

[ ] 6.6 — Abrir /financeiro/capital-giro
      → Verificar PMR e PMP (devem ser > 0 se houver dados)
      → Projeção 30d deve ter saldo positivo ou negativo coerente

[ ] 6.7 — Verificar alertas na Visão Geral
      → Se houver inadimplência > 20%, deve aparecer alerta
      → Se posição líquida for negativa, deve aparecer alerta
```

---

## 3. Critérios de Aceite

A Onda 1 está concluída quando TODOS estes critérios forem verdadeiros:

```
OBRIGATÓRIO:
✅ Sync rodou com sucesso para as 3 empresas (categorias, CC, CP, CR)
✅ Saldo bancário de cada CC confere com Omie (diferença = R$ 0,00)
✅ Total de CR aberto no app vs Omie: diferença < 1%
✅ Total de CP aberto no app vs Omie: diferença < 1%
✅ Fluxo de caixa diário não duplica valores (teste SQL passou)
✅ > 80% do valor financeiro tem categoria mapeada explicitamente
✅ DRE Receita Bruta confere com Omie (diferença < 5%)
✅ DRE Resultado Líquido confere com Omie (diferença < 10%)
✅ "Último sync" aparece no header com data correta
✅ Warning de categorias não mapeadas aparece (se houver)
✅ CSV export funciona com encoding correto

DESEJÁVEL (não bloqueia):
○ Movimentações financeiras sincronizadas
○ PMR e PMP calculados corretamente
○ Alertas financeiros disparam quando deveriam
```

---

## 4. Matriz de Falhas Esperadas

### F1: Credenciais rejeitadas
**Sintoma:** Erro "Credenciais Omie (oben) não configuradas" ou "ERROR: 5000"
**Causa:** Env var com nome errado ou valor incorreto
**Diagnóstico:** Supabase Dashboard → Edge Functions → Secrets → verificar nomes
**Correção:** Os nomes exatos são: `OMIE_VENDAS_APP_KEY`, `OMIE_VENDAS_APP_SECRET`, `OMIE_COLACOR_VENDAS_APP_KEY`, `OMIE_COLACOR_VENDAS_APP_SECRET`, `OMIE_COLACOR_SC_APP_KEY`, `OMIE_COLACOR_SC_APP_SECRET`. Sem espaços, sem aspas no valor.

### F2: Campo vem com nome diferente do esperado
**Sintoma:** Títulos sincronizados com valor 0, nome vazio, ou data null
**Causa:** O Omie muda nomes de campos entre versões da API. O código tenta vários nomes alternativos (`t.codigo_lancamento_omie || t.nCodTitulo`), mas pode faltar algum.
**Diagnóstico:** Nos logs da edge function (Supabase → Edge Functions → Logs), procurar por `[Fin]`. Se o sync relata 0 títulos mas o Omie tem dados, o array wrapper está errado. Se relata N títulos mas campos são null, o nome do campo está errado.
**Correção:** Adicionar um `console.log(JSON.stringify(titulos[0]))` temporário no início do loop de parsing pra ver o JSON real.
**Onde mexer:** `supabase/functions/omie-financeiro/index.ts`, funções `syncContasPagar` (linha ~235) e `syncContasReceber` (linha ~354).

### F3: Paginação retorna menos páginas do que o esperado
**Sintoma:** Sync diz "50 títulos sincronizados" mas Omie tem 500
**Causa:** O campo de total de páginas pode ser `total_de_paginas` ou `nTotPaginas`  — o código tenta ambos. Ou o filtro de data está cortando demais.
**Diagnóstico:** Comparar `totalPaginas` nos logs com o que o Omie mostra no relatório.
**Correção:** Ajustar o fallback de campo ou remover o filtro de data temporariamente pra ver se retorna tudo.
**Onde mexer:** Linha ~231 (CP) e ~350 (CR) — `result.total_de_paginas || 1`.

### F4: Formato de data inesperado
**Sintoma:** Datas null ou erro de parse no banco
**Causa:** O Omie retorna datas como `DD/MM/YYYY` na maioria dos campos, mas às vezes retorna `YYYY-MM-DD` ou vazio.
**Diagnóstico:** Se `data_vencimento` é null pra todos os títulos, o campo original não está no formato esperado.
**Correção:** A função `parseOmieDate` já trata `DD/MM/YYYY` e `YYYY-MM-DD`. Se aparecer outro formato, adicionar tratamento.
**Onde mexer:** `parseOmieDate` na edge function, linha ~752.

### F5: ResumirContaCorrente falha ou retorna campo diferente
**Sintoma:** Todas as contas correntes com saldo = 0
**Causa:** O endpoint `ResumirContaCorrente` pode retornar `nSaldo`, `nSaldoAtual`, ou outro nome. Ou pode precisar de parâmetros adicionais.
**Diagnóstico:** Log do edge function mostrará "Saldo CC XXX falhou".
**Correção:** Adicionar `console.log(JSON.stringify(saldoResult))` na função `syncContasCorrentes`, dentro do try do `ResumirContaCorrente`.
**Onde mexer:** Linha ~157-170.

### F6: Rate limiting excessivo
**Sintoma:** Sync para no meio, muitas mensagens "Rate limit, waiting..."
**Causa:** O Omie tem limite de 1 request por método a cada 2-5 segundos. Com 3 empresas × 5 entidades, são 15 sequências de requests.
**Diagnóstico:** Contar `rate_limits_hit` no fin_sync_log.
**Correção:** Não rodar sync_all pra 3 empresas de uma vez. Rodar uma empresa por vez. Ou aumentar o delay no `callOmie`.
**Onde mexer:** Linha ~70 — `const delay = Math.min(requestedDelay + 2, 15) * 1000;` — aumentar o +2 pra +5.

### F7: Chave de upsert duplicada
**Sintoma:** Erro "duplicate key value violates unique constraint"
**Causa:** O `omie_codigo_lancamento` pode não ser único se o Omie retornar o mesmo título em páginas diferentes (overlap de paginação).
**Diagnóstico:** O upsert com `onConflict` deveria tratar isso silenciosamente. Se não está, o nome do campo de conflito pode estar errado.
**Correção:** Verificar que o campo `omie_codigo_lancamento` retornado não é null/undefined (o que faria o unique falhar).
**Onde mexer:** Adicionar `if (!row.omie_codigo_lancamento) continue;` antes do upsert.

### F8: Status de título não mapeado
**Sintoma:** Títulos que são "pagos" no Omie aparecem como "ABERTO" no app
**Causa:** O campo `status_titulo` do Omie pode ter valores que o statusMap não cobre. Ex: "BAIXADO", "EM CONCILIAÇÃO", "PROTESTADO".
**Diagnóstico:** Rodar `SELECT DISTINCT status_titulo FROM fin_contas_pagar` e comparar com os status esperados.
**Correção:** Adicionar os valores faltantes ao statusMap na edge function.
**Onde mexer:** Linha ~236 (CP) e ~355 (CR).

### F9: DRE com tudo em "Despesas Operacionais"
**Sintoma:** A DRE mostra receita bruta correta mas todas as despesas caem em "Desp. Operacionais"
**Causa:** As categorias do Omie real não batem com os prefixos padrão (1.01, 2.01, 3.01, etc.)
**Diagnóstico:** Abrir `/financeiro/mapping`, ver quais categorias estão como "sem mapeamento".
**Correção:** Mapear manualmente cada categoria. Isso é trabalho do operador, não do código.

### F10: Filtro de data corta títulos antigos
**Sintoma:** CR/CP mostra apenas títulos recentes, faltam vencidos antigos
**Causa:** O sync filtra por `dDtEmissaoDe` com 6 meses. Mas o Omie pode usar `dDtRegistroDe` ou `dDtVencDe` como filtro real.
**Diagnóstico:** Comparar quantidade de títulos no app vs Omie sem filtro de data.
**Correção:** Testar com filtro de data removido: `{"action":"sync_contas_pagar","companies":["oben"],"filtro_data_de":"01/01/2024"}`.
**Onde mexer:** Parâmetros `dDtEmissaoDe`/`dDtEmissaoAte` nas linhas ~220-221 (CP) e ~339-340 (CR). Se o Omie não aceitar esses nomes, trocar por `dDtVencDe`/`dDtVencAte` ou remover e paginar sem filtro.

---

## 5. Plano de Correção

Para cada falha, o fluxo é:

```
1. Identificar a falha (log da edge function ou comparação visual)
2. Reproduzir com log detalhado (adicionar console.log do JSON raw)
3. Corrigir no código da edge function
4. Re-deployar: supabase functions deploy omie-financeiro
5. Limpar dados antigos: DELETE FROM fin_contas_pagar WHERE company = 'oben';
6. Re-rodar o sync da entidade específica
7. Validar novamente contra o Omie
```

### Correções mais prováveis (em ordem de ocorrência):

**1. Nomes de campos:** Adicionar console.log do primeiro registro, comparar com o que o código espera, ajustar.
Testar: re-sync + verificar Table Editor.

**2. Filtro de data:** Testar sem filtro primeiro. Se funcionar, ajustar o nome do parâmetro.
Testar: sync com `filtro_data_de` = `01/01/2020`.

**3. Status mapping:** Rodar SELECT DISTINCT, adicionar valores faltantes.
Testar: re-sync.

**4. Saldo CC:** Logar resposta raw do ResumirContaCorrente, ajustar campo.
Testar: sync CC + comparar com Omie.

---

## 6. Instrumentação Mínima

### Logs que DEVEM existir no primeiro sync:

Na edge function (visíveis em Supabase → Edge Functions → Logs):
```
[Fin] Sync completo oben...
[Fin][oben] Categorias p1/3
[Fin][oben] CC 1: Banco do Brasil - saldo R$ 45.230,00
[Fin][oben] CP p1/12 (+100 títulos)
[Fin][oben] CR p1/8 (+100 títulos)
[Fin][oben] Mov p1/5 (+87 movimentações)
```

### Warnings que DEVEM aparecer no frontend:

1. "Último sync: DD/MM às HH:MM" no header do dashboard
2. Badge "Regime de Caixa" na tab DRE
3. Warning amarelo "X categorias classificadas por heurística" na DRE (se houver)
4. Alerta vermelho se posição líquida < 0
5. Alerta amarelo se inadimplência > 20%

### Indicadores a verificar no `fin_sync_log`:

Após cada sync, rodar no SQL Editor:
```sql
SELECT action, status, duracao_ms, api_calls, rate_limits_hit,
       started_at, completed_at, error_message
FROM fin_sync_log
ORDER BY started_at DESC LIMIT 5;
```

Se `error_message` não for null, ler e diagnosticar.
Se `duracao_ms` > 120000 (2 min), o sync está lento — provável rate limiting.
Se `api_calls` = 0, a edge function não chegou a chamar o Omie.

---

## 7. Testes

### Testes unitários (já existem, rodar antes de começar):
```bash
cd afiacao && npx vitest run src/__tests__/financeiro.test.ts
```
Esperar 22/22 passando.

### Testes manuais com payload real (OBRIGATÓRIO):

**T1 — Payload raw do Omie:**
No Developer do Omie (developer.omie.com.br), fazer uma chamada manual de `ListarContasPagar` com `pagina:1, registros_por_pagina:1` e salvar o JSON de resposta. Comparar campo por campo com o que o código espera em `syncContasPagar`. Repetir para `ListarContasReceber`, `ListarCategorias`, `ListarContasCorrentes`.

**T2 — Saldo zero:**
Verificar se alguma CC tem saldo = 0 no app mas saldo > 0 no Omie. Se sim, a F5 ocorreu.

**T3 — Título fantasma:**
Pegar 5 títulos aleatórios no app (3 CR, 2 CP). Procurar cada um no Omie pelo número do documento. Confirmar que valor, data, e status batem.

**T4 — Aging manual:**
Pegar o relatório de aging do Omie (se existir). Comparar com o aging do app. As faixas (a vencer, 1-30, 31-60, 61-90, 90+) devem bater com margem de 2%.

**T5 — DRE cruzado:**
Somar manualmente todas as receitas (CR recebidos no mês) e todas as despesas (CP pagos no mês) no Omie. Comparar com a DRE do app pro mesmo mês.

---

## 8. Entregáveis da Onda 1

### Deve estar funcionando ao final:

```
✅ Sync manual funcionando para 3 empresas
✅ Saldos bancários conferidos e corretos
✅ CR e CP com diferença < 1% vs Omie
✅ Categorias > 80% mapeadas explicitamente
✅ DRE gerencial com Receita/CMV/Resultado coerentes
✅ Fluxo de caixa sem duplicação
✅ Frontend alternando entre empresas corretamente
✅ Alertas disparando quando deveriam
✅ "Último sync" visível no header
✅ CSV export funcional
```

### Pode ficar explicitamente pendente para Onda 2:

```
○ Movimentações financeiras (se endpoint falhar, não bloqueia)
○ Conciliação bancária (depende de movimentações)
○ Orçado vs realizado (depende de input do Lucas)
○ Intercompany (verificar se existe volume)
○ Tributário (informativo)
○ Cron automático (sync manual primeiro)
○ Projeção 13 semanas (depende de dados estáveis)
○ Fechamento mensal (1 operador)
○ Cockpit CFO (dashboard basta)
```

### Artefatos produzidos na Onda 1:

```
1. Tabela de comparação Omie vs App (preenchida manualmente)
   → Saldos CC, totais CR/CP, contagem de títulos

2. Lista de categorias mapeadas (screenshot do /mapping)

3. Lista de bugs encontrados e corrigidos
   → Campo X do Omie mapeia para Y, não para Z

4. Decisão sobre movimentações: funciona ou não?
   → Se não: documentar por quê e adiar pra Onda 2

5. Decisão sobre filtro de data: 6 meses é suficiente?
   → Se não: qual período mínimo?
```

---

## Timeline Estimada

```
Dia 1 (2-3 horas):
  - Fase 0: infraestrutura
  - Fase 1: sync empresa por empresa
  - Identificar e corrigir primeiros bugs de parsing

Dia 2 (1-2 horas):
  - Fase 2: validar saldos
  - Fase 3: validar fluxo de caixa
  - Corrigir bugs encontrados no Dia 1

Dia 3 (1-2 horas):
  - Fase 4: mapear categorias
  - Fase 5: validar DRE
  - Fase 6: validação frontend ponta a ponta

Dia 4: buffer para correções extras

Total estimado: 5-8 horas de trabalho efetivo, distribuídas em 3-4 dias.
```
