# Módulo Financeiro — Classificação de Confiabilidade

## ✅ MVP Operacional (pode usar agora para gestão diária)

Estes dados vêm direto do Omie sem transformação opinativa.
São fatos sincronizados — o número no app reflete o número no Omie.

| Funcionalidade | O que mostra | Fonte |
|---|---|---|
| **Contas a Receber** | Títulos abertos, vencidos, recebidos com valores, datas, status | Omie `ListarContasReceber` |
| **Contas a Pagar** | Títulos abertos, vencidos, pagos com valores, datas, status | Omie `ListarContasPagar` |
| **Saldo Bancário** | Saldo real de cada conta corrente com data de consulta | Omie `ResumirContaCorrente` |
| **Aging (Recebíveis/Payables)** | Distribuição por faixa de vencimento (a vencer, 1-30, 31-60, 61-90, +90) | Calculado localmente sobre CR/CP |
| **Top Inadimplentes** | Ranking de clientes com maior valor vencido | Agrupamento sobre CR vencidos |
| **Fluxo de Caixa (Previsto)** | Entradas e saídas previstas por dia, baseado em vencimento | Datas de vencimento de CR/CP |
| **Fluxo de Caixa (Realizado)** | Entradas e saídas efetivas por dia | Datas de recebimento/pagamento de CR/CP |
| **Exportação CSV** | Extração de CR, CP, DRE para análise externa | Dados locais formatados |
| **Alertas Operacionais** | Posição líquida negativa, inadimplência >20%, cobertura caixa <30% | Calculado sobre resumo |
| **Capital de Giro (posição)** | CR - CP, CG líquido, projeção 30 dias | Somas diretas sobre CR/CP/CC |

### Limitações do MVP:
- Depende de sync manual ou cron configurado
- Dados têm delay de até 24h em relação ao Omie (não é real-time)
- Limite de 50 páginas por sync = ~5.000 títulos por empresa por entidade

---

## ⚠️ Requer Configuração para Confiabilidade (usar com ressalvas até ajustar)

Estes dados envolvem **classificação** ou **cálculo derivado** que depende de
configuração manual do usuário para ser preciso.

| Funcionalidade | Risco | O que fazer |
|---|---|---|
| **DRE Regime de Caixa** | Categorias classificadas por **heurística** quando não há mapeamento explícito. Heurística usa keywords na descrição — pode classificar errado. | Acessar `/financeiro/mapping`, selecionar cada empresa, classificar todas as categorias que aparecem como "sem mapeamento". Recalcular DRE depois. |
| **PMR / PMP / Ciclo Financeiro** | Calculado sobre títulos recebidos/pagos nos últimos 90 dias. Amostra pode ser pequena para empresas novas ou com baixo volume. | Válido quando há >30 títulos no período. Empresas com <30 títulos terão PMR/PMP com margem de erro alta. |
| **Concentração Top 5** | Calculado sobre saldo aberto atual, não sobre faturamento mensal. | Usar como indicador direcional, não como métrica de risco formal. |

### Indicadores visuais no app:
- Badge **"Regime de Caixa"** na DRE indica que é baseado em pagamento/recebimento, não competência
- **Warning amarelo** na tab DRE lista categorias sem mapeamento explícito
- Campo `qtd_categorias_sem_mapeamento` no snapshot DRE para auditoria

---

## ❌ Não Implementado (não usar como verdade contábil)

| Funcionalidade | Status | Plano |
|---|---|---|
| **DRE por Competência** | Não implementado | Requer data de emissão como base ao invés de data de pagamento/recebimento. Estrutura da tabela já suporta (`regime = 'competencia'`), precisa de nova lógica no calcularDRE. |
| **Conciliação Bancária** | Dados existem (movimentações), tela não existe | Cruzar `fin_movimentacoes` com CR/CP por `omie_codigo_lancamento`. |
| **Balanço Patrimonial** | Não implementado | Requer integração com plano de contas contábil completo, não apenas financeiro. |
| **EBITDA Real** | Não calculado | Depende de DRE por competência + ajustes (depreciação, amortização). O que existe é "resultado operacional" por caixa. |
| **Projeção de Caixa com Cenários** | Não implementado | Base de dados existe para Monte Carlo ou projeção linear. |
| **Budget vs Actual** | Não implementado | Requer input de orçamento mensal por categoria/empresa. |

---

## Fluxo Recomendado para Primeiro Uso

1. Configurar credenciais das 3 empresas no Supabase
2. Acessar `/financeiro/sync` → "Sync Completo"
3. Verificar os dados na tab "Visão Geral" — saldos batem com o Omie?
4. Ir para `/financeiro/mapping` → classificar categorias por empresa
5. Voltar para `/financeiro/sync` → "Calcular DRE" do ano
6. Validar DRE contra relatórios do Omie/contabilidade
7. Se DRE bater: configurar cron diário
8. Se DRE não bater: ajustar mappings e recalcular

### Regra de ouro:
**Se a DRE mostra R$ em "Desp. Operacionais" e você não sabe o que é, não use como número de controller.**
Vá em Mapeamento DRE, descubra quais categorias caíram lá, e reclassifique.
