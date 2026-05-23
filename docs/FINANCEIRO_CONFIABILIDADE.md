# Módulo Financeiro — Classificação de Confiabilidade

## ✅ A1 — Inteligência de Caixa (CFO mode) — entregue (2026-05-19)

| Funcionalidade | O que mostra | Como usar |
|---|---|---|
| **Fluxo 13 semanas** | Projeção semanal com entradas/saídas/saldo, em 3 cenários (realista/otimista/pessimista). Inclui CR/CP vencendo + eventos recorrentes + eventos eventuais. Aplicação de inadimplência observada (taxa histórica 12m). | Tab "Fluxo 13s" em /financeiro/capital-giro. Toggle de cenário no header. Alertas de caixa negativo aparecem no topo. |
| **NCG decomposta** | ACO (CR aberto + estoque + adiantamentos) − PCO (CP fornecedor + folha 30d + tributos). Projeção 12m. CCC com PMR/PMP. Comparação com Capital Giro Próprio. | Tab "NCG". Indicador visual quando NCG > CGP (déficit de liquidez). |
| **Eventos recorrentes** | Folha, aluguel, pró-labore, etc. Repete mensalmente no dia configurado. Clamp pra último dia em fevereiro. Flag `is_folha` separa pra cálculo de PCO. | Tab "Eventos" → sub-aba Recorrentes. Onboarding sugere 5 eventos comuns na primeira visita. |
| **Eventos eventuais** | Aportes, compras de imobilizado, empréstimos. Status: previsto → confirmado → realizado (ou cancelado). | Tab "Eventos" → sub-aba Eventuais. |
| **Alertas configuráveis** | 6 tipos: caixa negativo, NCG déficit, cobertura baixa, inadimplência alta, concentração top1, saída spike. Thresholds editáveis por empresa. Snooze 7d / dismiss permanente. UNIQUE constraint evita spam. | Card stack no topo da tab Fluxo. Engine avalia a cada chamada. Cron diário registra histórico. |
| **Snapshots diários** | Projeção persiste 1× ao dia (cron) por empresa × cenário. Permite trend "projeção piorou nas últimas 4 semanas?". | Cron `fin-cashflow-snapshot-diario`. Visível em tabela `fin_projecao_snapshots`. |

### Configurações necessárias (one-time, pós-deploy A1)

1. Founder cadastra eventos recorrentes existentes (folha, aluguel, etc.) via Tab Eventos
2. Master ajusta thresholds default em Configuração (gear icon)
3. Master define códigos Omie de adiantamentos em Configuração
4. Cron `fin-cashflow-snapshot-diario` agendado via SQL Editor (template em 20260519010000_fin_a1_cron.sql)

### Não cobrindo ainda (próximos ciclos)

- **A2** — WACC, ROIC, EVA, spread sobre WACC
- **A3** — DuPont, Altman Z-score, Beneish M-score
- Integração estoque com valoração real (atualmente assume estoque_valor=0 — founder pode preencher manual)
- DRE competência growth rate aplicado na projeção NCG 12m (atualmente linear)
- Alerta `pmr_subindo` (precisa 90 dias de snapshots históricos antes de ativar)

---

## 🔧 Onda 1 — Correção do NCG (2026-05-19)

Revisão de metodologia via Codex (consult) pegou 4 problemas no NCG/indicadores do `fin-cashflow-engine`. Corrigidos:

| Correção | O que mudou |
|---|---|
| **PCO não duplica tributo** | Antes, impostos (categoria `3.99…`) entravam em `cp_fornecedor` E em `tributos_a_pagar` → PCO/NCG inflados. Agora os baldes são mutuamente exclusivos (imposto só em `tributos_a_pagar`). |
| **Estoque real no NCG** | Antes `estoque_valor = 0` (hardcoded) → NCG e CCC subestimavam capital de giro de Colacor/Oben. Agora vem do balancete via tabela `fin_estoque_valor` (input manual em Configuração), com botão "Estimar do Omie" (Σ físico×custo, best-effort com score de cobertura). |
| **"Capital de Giro Próprio" → "Liquidez Operacional Líquida"** | O número (caixa + CR + estoque − PCO) não era CGP de verdade. Renomeado pra parar de enganar. CGP verdadeiro (PL + PNC − ANC) chega no A2 (que introduz patrimônio + imobilizado). |
| **CCC ganha PME** | Antes `CCC = PMR − PMP` (ignorava dias de estoque). Agora `CCC = PMR + PME − PMP`, com PME = estoque ÷ CMV(TTM) × 365. Colacor SC (serviços) cai pra PME ≈ 0. |

### Regra de ouro da Onda 1
**Sem o valor de estoque do balancete informado em Configuração, NCG e CCC ficam subestimados.** Atualize trimestralmente (o app avisa quando o último valor tem mais de 90 dias ou está ausente). PME usa o estoque pontual como proxy do estoque médio até haver série histórica.

### Ainda direcional (próximas ondas)
- DRE "caixa" por `data_vencimento` (não por recebimento real) + linha de imposto agregada (Simples vs presumido): **Onda 3**.
- Detecção de imposto pelo prefixo `'3.99'` ainda é frágil — passa a usar o mapping DRE na **Onda 3**.

---

## 🔧 Onda 2 — Timing da projeção 13s (2026-05-20)

Substituímos o modelo de QUANDO o caixa entra na projeção 13 semanas. Antes: cada recebível caía na data de vencimento, com haircut fixo de inadimplência, o `atraso_medio_dias` calculado era ignorado, e títulos já vencidos **sumiam** da projeção. Agora: **curvas de cobrança por faixa de aging**, calibradas sem viés. Lógica testada em `src/lib/financeiro/aging-helpers.ts` (vitest) e espelhada verbatim no engine Deno.

| Mudança | O que passou a valer |
|---|---|
| **Curvas por faixa de aging** | Faixas `a_vencer / 1-30 / 31-60 / 61-90 / +90` (dias de atraso). Cada faixa tem `taxa_recebimento` e `lag_dias`. |
| **Calibração por exposição (sem viés)** | `taxa = pago ÷ exposição`, onde exposição = R$ que **entrou** na faixa (liquidados **+** abertos não-pagos). Abertos censurados puxam a taxa pra baixo — remove o viés otimista de calibrar só com "quem já pagou". |
| **Lag ponderado por R$** | `lag_dias` = média do atraso (recebimento − vencimento) **ponderada por valor** (+ mediana guardada). Um título grande lento pesa mais que N pequenos rápidos. |
| **Vencidos reagendados (não somem)** | `a_vencer` → recebe em `vencimento + lag`; vencido → `hoje + lag restante` (ou residual). Nunca mais desaparece da projeção. |
| **Ponte "após horizonte" + AR impaired** | Recebimento esperado para **depois das 13 semanas** vai pra linha "esperado após horizonte" (não entra no caixa projetado). A parte não-recebível (`1 − taxa`) vira **AR impaired** (perda esperada). Exclusão deliberada e reportada — ≠ o bug antigo de sumir com vencido. |
| **Inadimplência = taxa de perda ponderada** | `inadimplencia_pct` = média ponderada por R$ de `(1 − taxa_recebimento[faixa])` sobre o CR aberto. Para de misturar estoque (saldo >90) com fluxo (receita 12m). O alerta `inadimplencia_alta` usa esse número. |
| **Cenários com clamp** | otimista sobe taxa / encurta lag; pessimista o oposto. Clamps: `taxa ∈ [0,1]`, `lag ∈ [0, lag_max[faixa]]`. Cenário não move +90 pra "caixa fantasia". |
| **PMR/PMP ponderado por R$** | Antes média simples por título; agora ponderado por valor. |
| **Guard de folha por janela** | Se houver CP de categoria de folha vencendo em ≤30d, o ERP já registra a folha — não soma o evento recorrente em cima (`folha_30d = max(CP folha na janela, recorrente)`, e os CPs de folha saem de `cp_fornecedor`). Ativa quando `fin_config_cashflow.folha_categorias_codigos` está preenchido; sem isso fica inerte (comportamento atual preservado). |
| **Confiança por R$ + concentração** | Faixa só é "alta" com ≥20 títulos **E** volume ≥ R$ 50k **E** top-1 ≤ 60% da exposição. Senão usa default editável + flag `confianca: 'baixa'` (mostrado na UI). |

### Regra de ouro da Onda 2
**Materialmente melhor, mas ainda direcional.** As curvas tratam o portfólio como um todo por faixa — não segmentam por cliente, ticket ou instrumento de pagamento (boleto/PIX/cheque), e não aceitam overrides manuais de tesouraria ("cliente prometeu pra sexta"). Esses refinamentos, mais flags de disputado/protestado/jurídico e cheques pré-datados, ficam **deferidos** (evolução futura). O guard de folha só atua depois de configurar as categorias de folha no `fin_config_cashflow` (coluna opcional `folha_categorias_codigos`).

### Ainda direcional (próximas ondas)
- Segmentação por cliente / faixa de ticket / instrumento de pagamento; overrides manuais de tesouraria: **deferidos**.
- Timing de pagáveis (CP segue na data de vencimento): simetria deferida.

---

## 🔧 Onda 3a — DRE v2 estrutural (regime-aware) (2026-05-22)

Reescreve a estrutura da DRE do `omie-financeiro` (`calcularDRE`). Lógica testada em `src/lib/financeiro/dre-helpers.ts` (vitest) e espelhada verbatim no engine Deno.

| Mudança | O que passou a valer |
|---|---|
| **Estrutura regime-aware** | Deduções (tributos sobre receita) ficam acima da receita líquida; IRPJ/CSLL abaixo do resultado. Presumido: ICMS/ISS/PIS/COFINS/IPI nas deduções + IRPJ/CSLL abaixo. Simples: **DAS como linha única** (nunca quebrado — recolhimento unificado da LC 123), nas deduções, com imposto sobre lucro = 0. |
| **Caixa real** | `regime=caixa` passa a bucketar pela **data de recebimento/pagamento real** (com fallback pro vencimento). Rastreia `fallback_pct` por valor; rotula **"caixa estimado"** quando >10%. |
| **Mapping explícito** | Classificação de imposto vem do `fin_categoria_dre_mapping` (`ded_icms`/`ded_iss`/`ded_pis`/`ded_cofins`/`ded_ipi`/`das`/`irpj`/`csll`); a heurística de keyword vira último fallback e, quando pega imposto, conta pra confiança. |
| **Gate de confiança** | Nível `alta/media/baixa` + `motivos[]` no `detalhamento`, por % mapeado por valor, `fallback_pct`, share de categorias genéricas e imposto não mapeado. Exibido na UI. |

### Regra de ouro da Onda 3a
A DRE ficou **regime-aware e menos enganosa**, mas a linha de imposto ainda é **descritiva** (o que saiu no Omie). O **check de imposto teórico** (Simples progressivo RBT12/anexo/fator-r; presumido trimestral + adicional) é a **Onda 3b**. No Simples, a "receita líquida" é gerencial — o DAS mistura tributo sobre receita + IRPJ/CSLL, então não é diretamente comparável a presumido.

### Ainda direcional (próximas ondas)
- Imposto teórico (conferência realizado×esperado por regime): **Onda 3b**.
- Fechamento contábil, conciliação fiscal (PGDAS/DARF/NF), CMV/CPV real, depreciação, provisões (13º/férias), eliminação intercompany, pró-labore × folha × distribuição: **deferidos** (DRE segue direcional até lá).

---

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
