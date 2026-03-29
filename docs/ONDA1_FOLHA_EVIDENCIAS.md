# Onda 1 — Folha de Evidências
## Registro de Validação do Módulo Financeiro

Data de execução: ___/___/______
Executor: _________________________

---

## E1. Infraestrutura

| Item | Status | Observação |
|------|--------|------------|
| Migration 200000 aplicada | ☐ OK ☐ ERRO | |
| Migration 200100 aplicada | ☐ OK ☐ ERRO | |
| Migration 200300 aplicada | ☐ OK ☐ ERRO | |
| Migration 200400 aplicada | ☐ OK ☐ ERRO | |
| Migration 200500 aplicada | ☐ OK ☐ ERRO | |
| Migration 200600 aplicada | ☐ OK ☐ ERRO | |
| Edge function deployada | ☐ OK ☐ ERRO | |
| 6 secrets configurados | ☐ OK ☐ ERRO | |
| Usuário com role admin | ☐ OK ☐ ERRO | |

---

## E2. Debug Raw — Validação de Payload

### Oben

| Entidade | Conectou? | Array key real | Campo código | Campo valor | Formato data | Campo status | Campo paginação | Ação necessária |
|----------|-----------|---------------|-------------|-------------|-------------|-------------|-----------------|-----------------|
| contas_pagar | ☐ SIM ☐ NÃO | | | | | | | |
| contas_receber | ☐ SIM ☐ NÃO | | | | | | | |
| categorias | ☐ SIM ☐ NÃO | | | | | | | |
| contas_correntes | ☐ SIM ☐ NÃO | | | | | | | |
| resumir_cc | ☐ SIM ☐ NÃO | Campo saldo: _______ | | | | | | |

### Colacor

| Entidade | Conectou? | Array key real | Campo código | Diferenças vs Oben | Ação necessária |
|----------|-----------|---------------|-------------|-------------------|-----------------|
| contas_pagar | ☐ SIM ☐ NÃO | | | | |
| contas_receber | ☐ SIM ☐ NÃO | | | | |
| categorias | ☐ SIM ☐ NÃO | | | | |
| contas_correntes | ☐ SIM ☐ NÃO | | | | |
| resumir_cc | ☐ SIM ☐ NÃO | Campo saldo: _______ | | | |

### Colacor SC

| Entidade | Conectou? | Array key real | Campo código | Diferenças vs Oben | Ação necessária |
|----------|-----------|---------------|-------------|-------------------|-----------------|
| contas_pagar | ☐ SIM ☐ NÃO | | | | |
| contas_receber | ☐ SIM ☐ NÃO | | | | |
| categorias | ☐ SIM ☐ NÃO | | | | |
| contas_correntes | ☐ SIM ☐ NÃO | | | | |
| resumir_cc | ☐ SIM ☐ NÃO | Campo saldo: _______ | | | |

### Correções de parsing aplicadas (se houver):

| Campo | Esperado pelo código | Valor real no Omie | Arquivo:Linha | Corrigido? |
|-------|---------------------|-------------------|---------------|------------|
| | | | | ☐ |
| | | | | ☐ |
| | | | | ☐ |

---

## E3. Sync Real

| Empresa | Entidade | Status sync_log | Qtd sincronizada | Duração (ms) | Rate limits | Erros |
|---------|----------|-----------------|------------------|-------------|-------------|-------|
| Oben | categorias | ☐ complete ☐ error | | | | |
| Oben | contas_correntes | ☐ complete ☐ error | | | | |
| Oben | contas_pagar | ☐ complete ☐ error | | | | |
| Oben | contas_receber | ☐ complete ☐ error | | | | |
| Oben | movimentacoes | ☐ complete ☐ error ☐ skip | | | | |
| Colacor | categorias | ☐ complete ☐ error | | | | |
| Colacor | contas_correntes | ☐ complete ☐ error | | | | |
| Colacor | contas_pagar | ☐ complete ☐ error | | | | |
| Colacor | contas_receber | ☐ complete ☐ error | | | | |
| Colacor | movimentacoes | ☐ complete ☐ error ☐ skip | | | | |
| Colacor SC | categorias | ☐ complete ☐ error | | | | |
| Colacor SC | contas_correntes | ☐ complete ☐ error | | | | |
| Colacor SC | contas_pagar | ☐ complete ☐ error | | | | |
| Colacor SC | contas_receber | ☐ complete ☐ error | | | | |
| Colacor SC | movimentacoes | ☐ complete ☐ error ☐ skip | | | | |

---

## E4. Validação Cruzada — Saldos Bancários

Critério: saldo_data preenchido E valor confere com Omie.
(Saldo zero é aceito se o Omie também mostra zero.)

| Empresa | Conta | Banco | Saldo Omie | Saldo App | saldo_data preenchido? | Diferença | Status |
|---------|-------|-------|-----------|-----------|----------------------|-----------|--------|
| Oben | | | R$ | R$ | ☐ SIM ☐ NÃO | R$ | ☐ OK ☐ FALHA |
| Oben | | | R$ | R$ | ☐ SIM ☐ NÃO | R$ | ☐ OK ☐ FALHA |
| Colacor | | | R$ | R$ | ☐ SIM ☐ NÃO | R$ | ☐ OK ☐ FALHA |
| Colacor | | | R$ | R$ | ☐ SIM ☐ NÃO | R$ | ☐ OK ☐ FALHA |
| Colacor SC | | | R$ | R$ | ☐ SIM ☐ NÃO | R$ | ☐ OK ☐ FALHA |

---

## E5. Validação Cruzada — CR e CP

Fonte Omie: Finanças → Contas a Receber/Pagar → filtrar "Em Aberto"
Fonte App: SQL direto (evita ambiguidade de UI)

```sql
-- CR
SELECT company, COUNT(*) as qtd, SUM(valor_documento) as total_doc, SUM(saldo) as total_saldo
FROM fin_contas_receber
WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL')
GROUP BY company;

-- CP
SELECT company, COUNT(*) as qtd, SUM(valor_documento) as total_doc, SUM(saldo) as total_saldo
FROM fin_contas_pagar
WHERE status_titulo IN ('ABERTO','VENCIDO','PARCIAL')
GROUP BY company;
```

| Empresa | Tipo | Qtd Omie | Qtd App | Diff Qtd | Total Omie | Total App | Diff % | Status |
|---------|------|---------|---------|----------|-----------|-----------|--------|--------|
| Oben | CR | | | | R$ | R$ | % | ☐ OK ☐ FALHA |
| Oben | CP | | | | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor | CR | | | | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor | CP | | | | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor SC | CR | | | | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor SC | CP | | | | R$ | R$ | % | ☐ OK ☐ FALHA |

Tolerância: < 2% em quantidade E em valor.
Se > 2%: causa provável → filtro de data cortando títulos antigos.

---

## E6. Validação — Amostra de Títulos

| # | Empresa | Tipo | Nº Documento | Valor Omie | Valor App | Data Venc Omie | Data Venc App | Status Omie | Status App | OK? |
|---|---------|------|-------------|-----------|-----------|---------------|--------------|------------|------------|-----|
| 1 | | CR | | R$ | R$ | | | | | ☐ |
| 2 | | CR | | R$ | R$ | | | | | ☐ |
| 3 | | CR | | R$ | R$ | | | | | ☐ |
| 4 | | CP | | R$ | R$ | | | | | ☐ |
| 5 | | CP | | R$ | R$ | | | | | ☐ |

---

## E7. Validação — Fluxo de Caixa (Dupla Contagem)

Data escolhida para teste: ___/___/______
Empresa: _______________

A view `fin_fluxo_caixa_diario` usa `valor_documento` (não `saldo`) para entradas/saídas previstas.
O teste deve comparar com a mesma métrica.

```sql
-- Entradas previstas na view
SELECT entradas_previstas FROM fin_fluxo_caixa_diario
WHERE company = '______' AND data = '______';

-- Cálculo manual com mesma métrica (valor_documento, não saldo)
SELECT SUM(valor_documento) FROM fin_contas_receber
WHERE company = '______' AND data_vencimento = '______'
AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');

-- Saídas previstas na view
SELECT saidas_previstas FROM fin_fluxo_caixa_diario
WHERE company = '______' AND data = '______';

-- Cálculo manual
SELECT SUM(valor_documento) FROM fin_contas_pagar
WHERE company = '______' AND data_vencimento = '______'
AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');
```

| Métrica | View | SQL Manual | Diferença | Status |
|---------|------|-----------|-----------|--------|
| Entradas previstas | R$ | R$ | R$ | ☐ OK ☐ FALHA |
| Saídas previstas | R$ | R$ | R$ | ☐ OK ☐ FALHA |

---

## E8. Mapeamento de Categorias

```sql
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
```

| Empresa | Total cats | Mapeadas | Faltando | % cobertura | Status |
|---------|-----------|----------|----------|-------------|--------|
| Oben | | | | % | ☐ OK ☐ PARCIAL |
| Colacor | | | | % | ☐ OK ☐ PARCIAL |
| Colacor SC | | | | % | ☐ OK ☐ PARCIAL |

Meta: 0 faltando (ou < 5% do valor em categorias não mapeadas).

---

## E9. Validação — DRE

Mês avaliado: ___/______
Regime: Caixa

| Empresa | Linha | Valor Omie | Valor App | Diferença | Diff % | Status |
|---------|-------|-----------|-----------|-----------|--------|--------|
| Oben | Receita Bruta | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Oben | CMV | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Oben | Lucro Bruto | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Oben | Resultado Líq | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor | Receita Bruta | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor | Resultado Líq | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor SC | Receita Bruta | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |
| Colacor SC | Resultado Líq | R$ | R$ | R$ | % | ☐ OK ☐ FALHA |

Warning de heurística aparece? ☐ SIM ☐ NÃO
Badge "Regime de Caixa" aparece? ☐ SIM ☐ NÃO

---

## E10. Frontend Ponta a Ponta

| Verificação | Status |
|-------------|--------|
| "Último sync" aparece no header (após sync) | ☐ OK ☐ FALHA |
| Selector de empresa alterna dados corretamente | ☐ OK ☐ FALHA |
| Consolidado = soma das 3 empresas | ☐ OK ☐ FALHA |
| Tab CR: filtro VENCIDO mostra títulos vencidos | ☐ OK ☐ FALHA |
| Tab CP: filtro ABERTO mostra títulos abertos | ☐ OK ☐ FALHA |
| Export CSV: acentos corretos no Excel | ☐ OK ☐ FALHA |
| Capital de Giro: PMR e PMP > 0 | ☐ OK ☐ FALHA ☐ N/A |
| Alertas disparam se inadimplência > 20% | ☐ OK ☐ FALHA ☐ N/A |

---

## Resumo Final

| Critério | Resultado |
|----------|-----------|
| debug_raw funciona nas 3 empresas | ☐ PASSOU ☐ FALHOU |
| Sync completo com status 'complete' | ☐ PASSOU ☐ FALHOU |
| Saldos bancários conferem (saldo_data preenchido) | ☐ PASSOU ☐ FALHOU |
| CR/CP qtd e valor < 2% diferença | ☐ PASSOU ☐ FALHOU |
| Fluxo de caixa sem dupla contagem | ☐ PASSOU ☐ FALHOU |
| Categorias com > 95% cobertura | ☐ PASSOU ☐ FALHOU |
| DRE Receita Bruta < 5% diferença | ☐ PASSOU ☐ FALHOU |
| Frontend ponta a ponta funcional | ☐ PASSOU ☐ FALHOU |

**Onda 1 concluída:** ☐ SIM ☐ NÃO (com ressalvas: _______________)

**Próxima ação:** ________________________________________________

**Bugs encontrados e corrigidos:**

| # | Descrição | Causa | Correção | Testado? |
|---|-----------|-------|----------|----------|
| 1 | | | | ☐ |
| 2 | | | | ☐ |
| 3 | | | | ☐ |
