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
- Fechamento contábil, conciliação fiscal (PGDAS/DARF/NF), CMV/CPV real, depreciação, provisões (13º/férias), eliminação intercompany, pró-labore × folha × distribuição: **deferidos** (DRE segue direcional até lá).

---

## 🔧 Onda 3b — DRE v2: imposto teórico (conferência) (2026-05-22)

Adiciona à DRE o **imposto teórico esperado por regime**, ao lado do realizado (do Omie), como sanity-check. Tabelas legais (Anexos I–V do Simples + presunções) verificadas contra a Receita Federal; lógica testada em `dre-helpers.ts`/`dre-tabelas-tributarias.ts` (vitest) e espelhada no engine.

| Item | Como funciona |
|---|---|
| **Simples** | DAS teórico = alíquota efetiva × receita do mês. Efetiva = (RBT12 × nominal − parcela a deduzir) / RBT12, com RBT12 = receita bruta dos 12 meses anteriores (de `fin_dre_snapshots` competência). Anexo vem da config; fator-r alterna III/V (ver limitação). |
| **Presumido** | IRPJ/CSLL **trimestrais** (presunção por atividade) + **adicional 10%** sobre base presumida que excede R$60k/tri + PIS/COFINS cumulativo. Rateado linearmente por mês (aproximação). |
| **Degradação honesta** | Sem dado essencial (ex.: Simples sem anexo configurado) → teórico = `null`, **nunca número inventado**, e rebaixa a confiança. |
| **Confiança** | Delta realizado×teórico > 25% vira **motivo** (não rebaixa sozinho — pode ser competência/recolhimento); config tributária incompleta limita a confiança a "media". |
| **Config** | Coluna opcional `fin_config_cashflow.dre_tributario` (JSONB): `{regime, anexo, fator_r_habilitado, presuncao_irpj, presuncao_csll}`. Sem ela → default por empresa + teórico parcial. |

### Regra de ouro da Onda 3b
O teórico é **conferência de plausibilidade**, não verdade fiscal — o realizado (Omie) continua sendo o número. **Limitações documentadas** (viram motivo de delta/confiança, não erro silencioso): (a) fator-r não alterna anexo sem folha segregada confiável; (b) rateio trimestral linear no presumido; (c) competência do DAS (recolhido sobre receita do mês anterior) não realinhada. Conciliação fiscal real (PGDAS/DARF) segue **deferida**.

---

## 🔧 A2 — Retorno & Valor (ROIC / WACC / EVA) (2026-05-23)

Camada de retorno sobre o capital empregado, pra decidir **onde colocar o próximo R$1** entre as 3 empresas. Híbrida: NOPAT e capital de giro são **computados** (reusam DRE v2 + NCG); ativo fixo, dívida, PL, Ke/Kd e normalizações são **inputs manuais** (tabela **`fin_valor_inputs`, RLS master-only** — dado sensível do dono não fica em `fin_config_cashflow`, legível por employee), com degradação honesta. Lógica testada em `valor-helpers.ts` (vitest) e espelhada no engine `fin-valor-engine` (master-only).

| Item | Como é calculado |
|---|---|
| **NOPAT** | EBIT operacional puro (`resultado_operacional − receitas_financeiras + despesas_financeiras`, TTM) **menos** só os impostos **abaixo da linha**: presumido `IRPJ+CSLL`; Simples `0` (DAS já está nas deduções). Nunca `EBIT×(1−t)`. Sem clamp (NOPAT pode ser negativo). Carga tributária total do regime é exibida à parte, **nunca** re-subtraída. |
| **Margem op. pré-imposto** | `EBIT / receita_líquida` — comparável entre regimes. |
| **Capital investido** | `capital_giro (NCG do último snapshot) + ativo_fixo (manual) − ajustes`. Sem ativo fixo → **parcial** + confiança rebaixada. |
| **WACC (hurdle-rate)** | `peso_equity·Ke + peso_dívida·Kd`. Ke decomposto (âncora + prêmios) com cenários conservador/base/agressivo; **Kd pré-imposto** (tax-shield desligado nos 2 regimes). Sem dívida/PL/Ke → **indisponível** (não chuta). |
| **ROIC / spread / EVA** | `ROIC = NOPAT/capital`; `spread = ROIC − WACC`; `EVA = spread × capital`. Capital ≤ 0 → null. |
| **ROIC incremental (headline)** | `ΔNOPAT / Δcapital` (TTM atual vs −12m). Δcapital pequeno/negativo ou histórico insuficiente → `null` + aviso. |
| **Normalização (comingling)** | Pró-labore de mercado, aluguel de mercado e intercompany. Saída **reportado vs normalizado** lado a lado; o normalizado é o número de decisão. |
| **Confiança** | `alta/media/baixa` por completude dos inputs; nunca fabrica número (campo ausente = `null` + motivo). Propaga a confiança da DRE subjacente (Onda 3). |

### Regra de ouro da A2
A2 nunca inventa. Faltou ativo fixo → ROIC parcial. Faltou dívida/PL/Ke → WACC/EVA/spread indisponíveis. Faltou normalização → só reportado, com aviso de comingling. **Limitações deferidas (documentadas):** leases/aluguéis como quase-dívida; split capex manutenção × crescimento; eliminação intercompany pra view consolidada; registro automático de ativo fixo (sync ERP); real vs nominal/inflação; concentração cliente/fornecedor; obsolescência de estoque. Migração de regime pra lucro real reativaria o tax-shield. **A2 é direcional**, não auditoria — melhora a decisão de alocação de capital, mas não substitui balanço/valuation formal.

---

## 🔧 A3 — Inteligência de Valor (Cockpit cliente/produto) (2026-05-24)

Para de olhar faturamento e olha **lucro econômico** por cliente/SKU: margem de contribuição **menos o custo do capital de giro** (recebíveis + estoque parados) cobrado ao hurdle-rate da A2. Escopo MVP: **Oben** (onde há linha de SKU no app). Gate: gestor comercial (`commercial_role` gerencial/estrategico/super_admin) + master.

| Item | Como é calculado |
|---|---|
| **Lucro econômico (EVP)** | Tabela atômica cliente×SKU: `EVP_cs = CM_cs − k×(A_cs + I_cs)`. AR do cliente alocado por receita; estoque do SKU por quantidade. Cliente/SKU/empresa reconciliam (invariante testado). |
| **Margem de contribuição** | `receita_líquida − custo×qtd` (`product_costs`, custo médio atual; sem BOM). Custo ausente → null. |
| **Encargo de capital** | AR = saldo médio TTM (time-weighted) × WACC; estoque = `saldo×cmc` (snapshot run-rate) × WACC. AP = crédito nível-empresa (não rateado por linha). |
| **Recomendações** | Regras determinísticas: cortar desconto / subir preço / encurtar prazo / despriorizar SKU / crescer, com R$ em jogo. Limiares em `fin_config_cashflow.cockpit_config`. |
| **Confiança** | Cobertura de receita (order_items ÷ AR), custo/AR/estoque ausentes, imposto estimado nível-empresa. |

**Regra de ouro:** direcional, não verdade contábil. Custo sem BOM; imposto estimado nível-empresa; estoque snapshot; cobertura depende do sync de vendas (medida e exibida). Nunca fabrica: ausente = null + motivo. **Filtro Oben por produto:** um pedido do app mistura itens das 3 empresas (enviados separadamente), então o engine conta só linhas de `omie_products.account='oben'`. **Deferido:** recomendações de prazo/estoque (precisam de PMR por cliente e dias-de-estoque por SKU — hoje inertes); AR médio ignora cronologia de pagamento parcial.

**Onde:** helper `src/lib/financeiro/valor-cockpit-helpers.ts` (vitest); engine `fin-valor-cockpit` (gestor+master, espelha o helper, escopo Oben); coluna `fin_config_cashflow.cockpit_config`; página `/financeiro/valor-cockpit`.

---

## 🔧 A4 — Próxima Melhor Ação (next-best-action) (2026-05-24)

Fila priorizada de ações concretas que o dono deve aprovar/recusar, sob a restrição de caixa de cada empresa. **Compõe** A1 (caixa) + A2 (hurdle/spread) + A3 (cockpit Oben) — não recomputa nada. Gate gestor comercial + master.

| Item | Como funciona |
|---|---|
| **Fila** | Ações ordenadas por tipo: consertar valor (A3 preço/prazo) → liberar caixa → crescer (A2 spread+) → benchmark. Dentro do tipo: sem-caixa primeiro, depois EVA/caixa, payback. |
| **Status** | Financiar já / Financiar condicional / Consertar antes / Falta dado / Não financiar. Hurdle (WACC A2) é o corte. |
| **Caixa** | Por empresa (NÃO fungível): saldo de tesouraria − reserva (dias de cobertura mínimos). Confiança baixa → haircut. |
| **Hurdle** | WACC da A2; fallback honesto (retorno do dono / custo de dívida / mediana) + flag se ausente. |
| **Benchmark** | "Não fazer nada / pagar dívida / distribuir" sempre presente — o piso quando nada supera o hurdle. |

**Regra de ouro:** consertar preço/prazo ANTES de crescer (não recomenda crescer quando a resposta é "parar de vender mal"). Caixa não-fungível entre PJs. Degrada honesto: function interna falha → ações daquela empresa viram "Falta dado". **Deferido:** otimização matemática; cockpit granular p/ Colacor/SC (só sleeve company-level até lá); execução automática (A4 recomenda, o dono decide).

**Onde:** helper `next-best-action-helpers.ts` (vitest); engine `fin-next-best-action` (gestor+master, chama A1/A2/A3 via service_role); página `/financeiro/proxima-acao`.

---

## 🔧 Otimizador Tributário — Comparador de Regime (Simples × Presumido × Real) (2026-05-24)

A escolha de regime é o **lever fiscal nº 1** de uma PME — decisão única que move dezenas de milhares de R$/ano. Por CNPJ, compara a **carga federal + CPP** nos 3 regimes sobre 12 meses móveis (TTM), aponta o ótimo, quantifica a **economia anual em R$** vs o regime atual e degrada honestamente quando falta dado. Compõe a DRE v2 (regime-aware) e RBT12 já calculados — não recomputa o realizado. Gate **master-only** (estratégia tributária sensível, igual A2). Lógica testada em `regime-tributario-helpers.ts` (vitest, ~26 testes) e espelhada no engine `fin-regime-tributario` (master-only). Revisão de metodologia feita com **Codex (2 passes, effort alto)**.

| Item | Como é calculado |
|---|---|
| **Base de comparação** | Eixo **federal + CPP** (mesma cesta de tributos entre regimes). O DAS "cheio" do Simples é decomposto pela **partilha da LC 123** (`PARTILHA_SIMPLES`): `federal+CPP = DAS − indireto_no_DAS` (ICMS/ISS/IPI já com teto/redistribuição). CPP **embutido** no DAS dos anexos I/II/III/V (só o IV recolhe à parte). ICMS/ISS/IPI vão pro **eixo indireto separado** (§2.6). |
| **Simples** | Alíquota efetiva sobre **RBT12** (`(RBT12×nominal − deduzir)/RBT12`); DAS anual ≈ efetiva × receita TTM (flag de aproximação). **Elegibilidade por RBA** (receita bruta acumulada do ano-calendário, **não** RBT12): teto R$4,8M, sublimite R$3,6M → `elegivel`/`sublimite_excedido`/`inelegivel`. **fator-r** (serviços III×V): massa/receita ≥ 0,28 → III, senão V; sem massa → banda de sensibilidade + break-even. |
| **Presumido** | IRPJ/CSLL **anualizados somando 4 trimestres**, cada um com seu **próprio limite de R$60k** para o adicional de 10% (nunca o teto anual de uma vez). Trimestres reais do histórico quando disponíveis; TTM/4 com flag (sazonalidade infla/esconde adicional). **Receitas financeiras integrais na base IRPJ/CSLL** (não via presunção). PIS/COFINS cumulativo 3,65% sobre receita tributável (receita financeira = alíquota zero). |
| **Real (TRIAGEM, baixa confiança)** | Lucro ≈ `resultado_antes_impostos` da DRE TTM, **sem LALUR** (adições/exclusões/compensação 30% não modelados) → confiança **sempre ≤ media** por construção. IRPJ 15% + adicional 10%>R$60k/tri, CSLL 9%; lucro ≤ 0 → IRPJ/CSLL = 0. **PIS/COFINS não-cumulativo 9,25% − crédito** (crédito = 0 default, pior caso — falta NCM/CFOP/CST; override `credito_pis_cofins_estimado`) **+ 4,65% sobre receitas financeiras** (Decreto 8.426/2015, sem crédito — omitir pode inverter Real × Presumido). |
| **Encargo patronal** | CPP no Presumido/Real recolhido à parte: `folha_cpp_anual × encargo_patronal_pct` (default **0,20** = CPP estrita; flag de que RAT/FAP/terceiros ~25,8–26,8% não inclusos → viés pró-Presumido/Real). |
| **Inputs** (`fin_regime_inputs`, **master-only**) | `folha_cpp_anual`, `massa_fator_r_anual` (salários+pró-labore+CPP+FGTS, distinta da base CPP), `encargo_patronal_pct` (default 0,20), `presuncao_irpj/csll`, `credito_pis_cofins_estimado`, `receita_tributavel_pis_cofins_pct` (1 − monofásico/ST/alíquota-zero), `anexo_simples`. RLS master-only. |
| **Confiança** | `scoreConfiancaRegime` agrega o pior sinal; 'alta' exige folha conhecida + dentro dos limites + sem flags fortes. Real nunca passa de media. |

### Regra de ouro do Otimizador
**Recomenda, não declara** — troca de regime exige **contador + substância econômica**. Caveat fixo na UI. Degradação honesta: Real é **sempre ≤ media** (LALUR não modelado); sem `folha_cpp_anual` → comparação Simples×outros **incompleta** + banda; perfil de revenda (Oben) sem `receita_tributavel_pis_cofins_pct` → monofásico/ST/alíquota-zero pode superestimar PIS/COFINS → status **"estimativa incompleta"**; economia < banda de erro → status **`empate_tecnico`** ("exige validação do contador"); RBA aproximada por TTM (sem acumulado do ano corrente) → flag. Nunca fabrica: input ausente = `null` + motivo. **Deferido (fase 2):** realocação de receita entre CNPJs, efeito do crédito do cliente no preço, simulação NCM/CFOP/CST por item.

**Segurança:** página `/financeiro/regime-tributario`, hook `useRegimeTributario`, engine `fin-regime-tributario` e tabela `fin_regime_inputs` (RLS) **todos master-only**; engine aceita `service_role` Bearer p/ composição interna.

**Onde:** helper `src/lib/financeiro/regime-tributario-helpers.ts` (vitest); engine `fin-regime-tributario` (master-only, espelha o helper); migration `20260524120000_fin_regime_inputs.sql`; hook `src/hooks/useRegimeTributario.ts`; dialog `src/components/financeiro/RegimeInputsDialog.tsx`; página `src/pages/FinanceiroRegimeTributario.tsx`.

## 🔧 Otimizador de Compras — Decisão "Comprar Mais?" (net-R$ marginal) (2026-05-25)

Por SKU, **neta o trade-off completo** de comprar acima do baseline pra pegar desconto/forward-buy: soma desconto + aumento-evitado + ruptura-evitada e **subtrai** capital-extra empatado + encargo de prazo + frete incremental → "comprar **quanto**, e vale a pena de verdade?". Sobe a `/admin/reposicao/oportunidades` de "economia bruta" para **decisão net-R$ marginal** — **sem página nova** (reaproveita tabela/KPIs/drawer). Compõe a matemática que já existe no Postgres (EOQ, ponto de pedido, ruptura simulada, custo de capital `Cm`, curva de desconto). Lógica testada em `compras-otimizador-helpers.ts` (vitest, ~19 testes). Metodologia revisada com **Codex (2 passes)**.

| Componente | Como é calculado |
|---|---|
| **Baseline e candidatos** | Análise **marginal contra `q_base`** (`max(EOQ, qtd_minima_efetiva)` arredondado ao lote), **nunca** sobre a média. Candidatos **não são só os thresholds** (o ótimo pode estar ENTRE eles): `q_base` + cada `volume_minimo` da curva + limite-do-aumento + limite-da-ruptura. Escolhe o de **maior `beneficio_liquido`**. |
| **Desconto incremental** | `desc_promo(q_cand) − desc_promo(q_base)` usando **campos ATÔMICOS** (`desconto_promo_perc`) — NUNCA o total somado da view (que já inclui aumento → **double-count**). |
| **Aumento evitado** | Campo atômico `aumento_evitado_perc`, **separado** do desconto, com **janela temporal**: só a qtd cujo consumo baseline cairia **APÓS** a vigência do aumento (`q_cand − max(q_base, demanda × dias_ate_aumento)`). |
| **Ruptura evitada** | **Fase 1 = 0 (conservador)** + flag "benefício de ruptura não estimado". O `valor_ruptura_estimado` é agregado do cenário base, não marginal — não infla o net pra comprar demais. Marginal fica pra fase 2. |
| **Capital extra (−)** | O extra é a **última tranche consumida** → carrega parado **desde o dia 0**: `valor_extra × Cm_anual × ((q_base/demanda) + 0,5 × (q_extra/demanda))/365`. O 0,5 incide só sobre a parcela própria (triângulo de consumo do extra). Cobra só o **extra acima do q_base** (o EOQ já embute `Cm` — anti double-count). |
| **Impacto de prazo (−)** | `(prazo_cand% − prazo_padrão%) × valor_candidato` (pedido inteiro, não só o extra), **sempre vs o prazo PADRÃO**. Sinal normalizado no helper (desconto de prazo = benefício; encargo = custo). |
| **Frete incremental (−)** | Modela as **3 formas**: `% valor` + `fixo` + `taxa de pedido` (`fornecedor_custo_adicional_config`); flag de confiança se a config estiver incompleta. |

### Regra de ouro do Otimizador de Compras
**Recomenda quanto, não declara que vai comprar** — o comprador decide com fatores fora do modelo em mente. Arquitetura deliberadamente leve: **helper TS puro** (`compras-otimizador-helpers.ts`, testável, sem I/O) + **view `v_otimizador_compras_insumos`** (só **junta fatos** por SKU, ZERO regra financeira) + **SEM edge function** (dado operacional já client-readable com RLS de staff — ≠ frentes financeiras master-only). Degradação honesta: sem `demanda_diaria`/`qtde_base` → `falta_dado` (sem recomendação, nunca número fabricado); `escopo ∈ {grupo, fornecedor_total}` → `simulacao_parcial` (avaliador por-SKU isolado pode mentir); desconto alto (>20%) ou `q_base` perto de threshold → flag "EOQ não recalculado com preço descontado"; frete parcial → flag. **Fatores materiais fora do modelo (fase 1), sinalizados como flag, não bloqueiam:** validade/perecibilidade, obsolescência, espaço de armazém, caixa/limite de crédito, câmbio (importados), impostos/créditos, desconto condicionado a cesta/mix. **Ponto de extensão:** `minimo_forcado_manual` — o helper/view já aceitam o campo; **onde** o founder seta (campo em `sku_parametros`, regra, override) é decisão futura.

**Onde:** helper `src/lib/reposicao/compras-otimizador-helpers.ts` (vitest, ~19 testes); view `v_otimizador_compras_insumos` (migration manual `20260525140000_v_otimizador_compras_insumos.sql`); frontend enriquecido em `src/pages/AdminReposicaoOportunidades.tsx` + `src/components/reposicao/oportunidades/*` (coluna/KPI/drawer net-R$). Sem nova rota, sem edge function.

## 🔧 Custo Marginal de Funding — Decisão de Antecipação + Planejador de Gap (sub-PR A+B) (2026-05-26)

Por título de `fin_contas_receber`, responde **"vale antecipar este recebível?"** comparando 4 fontes de funding (caixa próprio, antecipação/desconto, capital de giro, cheque especial) **em R$ no horizonte relevante** — a taxa anualizada é só exibição, NUNCA o critério de ranking (horizontes diferentes; % a.a. de um cheque caro sobre poucos dias engana). E (**sub-PR B**) o **planejador de cobertura de gap**: dado o vale de caixa da projeção 13s, qual a **mistura de fontes mais barata em R$** pra cobrir o déficit + **o quanto a inércia custaria**. Master-only (tesouraria/CFO), padrão A2/regime. Helper testado `funding-helpers.ts` (vitest, 33 testes) espelhado verbatim na edge `fin-funding`. Metodologia revisada por **Codex** (consult na metodologia + adversária no código nas duas sub-PRs).

| Componente | Como é calculado |
|---|---|
| **Custo da antecipação (R$)** | `V − v_liq`, onde `v_liq = V − deságio − IOF − tarifa`. Deságio comercial "por fora" (`V × taxa_mensal × N/30`). **IOF** de crédito PJ (`0,38% + 0,0082%/dia`, teto 365d) só pra `desconto`; **factoring = IOF 0**. Taxa efetiva a.a. `(V/v_liq)^(365/N)−1` só pra exibir. |
| **Benchmark contextual** | `gap` (há déficit até o vencimento) → compara contra a fonte alternativa mais barata (capital de giro / cheque) pra prover `v_liq` por N dias; `net_rs = custo_alt − custo_antecip`. `sobra` → compara contra o ganho de aplicar o caixa liberado ao melhor uso (A4 — sub-PR B) ou `cm_anual`. Em sobra, o deságio quase sempre supera o `cm_anual` → recomenda **não antecipar**, com o número. |
| **Custo do caixa próprio** | `cm_anual` (SELIC+spread+armazenagem, de `empresa_configuracao_custos`) quando ocioso; sobe ao **retorno marginal do projeto deslocado** (A4) quando há fila positiva e caixa insuficiente — **sub-PR B**. |
| **gap × sobra** | Pelo **menor `saldo_final` projetado** (projeção 13s) das semanas que começam **até o vencimento** (inclui a semana do vencimento). `checaValeEmT` (simulação 2-cenários) sinaliza se antecipar criaria um vale futuro abaixo da reserva. **Estrutural × calendário:** gap em ≥`gap_estrutural_semanas_min` (default 6) semanas → flag `estrutural` + banner "antecipar é rolagem; renegocie prazo/preço/estoque". |
| **Planejador de gap (sub-PR B)** | `identificarGap` acha o vale mais profundo da projeção (`gap_rs` = reserva − pior saldo; horizonte = semanas até o vale). `montarPlanoCobertura` empilha as fontes da **mais barata em R$ pra mais cara** (ordena pelo custo em R$ no horizonte, não por % a.a.; desempate por governança) respeitando capacidade: caixa próprio até `caixa_livre` (A4) → capital de giro → cheque especial (pode **vencer em R$** num gap curtíssimo → flag "emergência"). Saída: stack + custo total + **custo da inércia** (financiar o gap inteiro no cheque). **Composição A4:** consome só `caixa_livre` + `retorno_marginal` (não re-decide uso); o `retorno_marginal` (aprox. v1 = hurdle + EVA marginal quando quantificado) alimenta a decisão de antecipação em **sobra**. |

### Regra de ouro do Funding
**Por-CNPJ** (caixa de uma empresa NUNCA cobre gap de outra — sem mútuo intercompany implícito). **CET pra dívida** (input já all-in: TAC/tarifas/seguro/reciprocidade — taxa nominal pura escolheria dívida "barata" que não existe). **Coobrigação é campo obrigatório** (com = dívida disfarçada; sem = transfere risco). Degradação honesta (todas NUNCA fabricam recomendação): sem taxa de antecipação → `falta_dado` (não antecipa "grátis"); sem `cm_anual` nem A4 em sobra → `falta_dado`; sem projeção 13s → contexto `indefinido` (benchmark `cm_anual`, sem detecção de vale); taxa/CET/tarifa negativa → tratada como não configurada. **Limitações v1:** granularidade da projeção é **semanal** (`saldo_final`) — vales intra-semana não capturados; `cria_vale_em_T` só **sinaliza** (não muda a recomendação — re-custo completo = v2); concentração por sacado é **aviso**, não constraint dura; risco de crédito/sem-coobrigação não valorado (v2). **No planejador:** capacidade de dívida/cheque = ilimitada (limite por instrumento = v2); `caixa_livre` = `caixa_disponivel` do A4 (não desconta ação A4 já "aprovada" — A4 não rastreia aprovação); `retorno_marginal` é aproximação (cai no hurdle/WACC quando o A4 não quantifica o EVA do "crescer"); **antecipação NÃO entra como fonte do planejador no v1** (a decisão por título já está na tabela; incluir exigiria capacidade + taxa ponderada = v2); gap = vale mais profundo (não soma déficits multi-semana).

**Onde:** helper `src/lib/financeiro/funding-helpers.ts` (vitest, 33 testes); edge `supabase/functions/fin-funding/index.ts` (master-only, compõe `fin-cashflow-engine` + `fin-next-best-action` (A4) + `empresa_configuracao_custos` + `fin_contas_receber`); tabela `fin_funding_inputs` (migration manual `20260526100000_fin_funding_inputs.sql`, RLS master-only); hook `useFunding` + `FundingInputsDialog` + página `/financeiro/funding` (decisão por título + planejador de cobertura). ⚠️ **Re-deploy da `fin-funding` necessário após o merge do sub-PR B** (compõe o A4 agora).

## 🔧 Orçamento Rolling — Forecast de Aterrissagem (sub-PR A) (2026-05-27)

Constrói SOBRE o "Orçado × Realizado" que já existia (`/financeiro/orcamento`): projeta **onde o ano FECHA** (`landing = realizado dos meses FECHADOS + forecast dos restantes`) e a **variância projetada** vs orçado anual. **Client-side** (helper puro testado + estende a página; **sem edge function, sem migration**). Metodologia revisada por **Codex em 2 etapas** (metodologia + spec) + 1 no plano.

**Princípio (Codex): método POR LINHA, não média global** — pipeline ORDENADO `projetarDRE` (drivers usam a base *forecasted* da etapa anterior): `receita_bruta → deducoes → receita_liquida → cmv → demais → impostos → derivadas`.

| Linha | Forecast |
|---|---|
| receita_bruta | sazonal ajustado (`receita_ano-1[mes] × fator_tendência_YTD`, cap [0,5;2,0]) → run-rate → orçado |
| deduções / cmv | **driver razão-YTD** (% da receita_bruta / receita_líquida **forecasted**) |
| despesas fixas / outras | run-rate dos meses fechados |
| financeiras | média dos últimos 3 fechados |
| **impostos** | **razão YTD** (Σimp/Σreceita fechados × receita FC) — **nunca média cega**; flag <3 fechados/<1 trimestre |
| derivadas | **calculadas** (fórmulas FinDRE); orçado das derivadas **calculado das 11 linhas orçadas** |

**Variância sign-aware** por conjunto literal (receita/derivadas-de-resultado acima=favorável; deduções/cmv/despesas/impostos acima=desfavorável) + `fura_meta` = `|var| > max(10%×orçado, piso)` (orçado≤0 → só piso). **Mês corrente parcial NÃO entra na base nem no realizado** (só meses fechados). **Degradação honesta:** 0 fechados→sem forecast; <3→confiança baixa; denominador de driver ≤0 → run-rate + flag (sem NaN); orçado AUSENTE (≠ zero) → variância não computável. **Por empresa.**

**Seed de baixa fricção (sub-PR B, entregue):** botão "Sugerir orçamento de {ano-1}" no modo de edição = realizado do ano anterior × (1+crescimento%), **winsorizado por múltiplo da MEDIANA** (`seedOrcamento`, `fatorOutlier` default 3 → capa o mês outlier a `mediana×3`, robusto — std com o próprio outlier inflaria o limite) + **bloqueio de amostra curta** (<3 meses com valor → não sugere, `amostra_curta_sem_sugestao`) + mês ausente preenchido pela média capada com flag `mes_ausente_media` (honesto p/ sazonalidade). Só popula o `draft` (NÃO salva — o founder revisa e clica Salvar). Mata as ~120 células digitadas. Codex no plano pegou testes fracos (winsorize agora com assert EXATO) + a fragilidade do std.

**Drill de variância por categoria (passo focado, entregue):** clicar numa linha do Forecast que **fura a meta** expande inline e decompõe o **realizado YTD** dela pelas categorias do Omie (atribuição por **CÓDIGO** via `fin_categoria_dre_mapping`, NÃO por descrição), com **delta YoY nos mesmos meses fechados**. Honesto por design (Codex): **explica o realizado YTD, NÃO a variância anual** (categoria não decompõe o forecast restante → mostrado à parte); **reconciliação SEMPRE visível** (realizado do snapshot vs Σ categorias vs resíduo + % → qualidade `ok` ≤5% **E** ≤R$10k / `parcial` / `diagnostico` >20%, nunca esconde). **Aliases fiscais regime-aware (Codex no spec, verificado no `montarDRE`):** o snapshot agrega sublinhas — `deducoes` = `deducoes+ded_*+das+impostos legado` (DAS cai aqui no Simples), `impostos` = `0` (simples) / `irpj+csll` (presumido). **Fonte de reconciliação = `fin_dre_competencia_base` (Codex adversarial P1):** a matview dimensional comum é por **`data_vencimento`**, mas o snapshot é **competência (`data_emissao`)** → drillar contra ela acusaria resíduo FALSO por base temporal. A `fin_dre_competencia_base` (CR+CP por `data_emissao`, `status≠CANCELADO`, soma `valor_documento`) é a **mesma base** que o `calcularDRE` competência usa → reconcilia de verdade. O drill soma por código sobre CR+CP (o `calcularDRE` classifica por código independente do razão), com **paginação** (a view passa de 1000 linhas). Helper `src/lib/financeiro/orcamento-drill-helpers.ts` (15 testes; `drillLinha`/`aliasesDaLinha`/`fontesDaLinha`) + `getCategoriasCompetenciaRaw` + `DrillVarianciaPanel`. **Limitações:** mapping não-versionado (reclassifica o passado com a regra atual → v2); resíduo residual reflete categorias não mapeadas/fallback heurístico do `calcularDRE` (exposto, não escondido).

**Drill v2 — concentração por fornecedor/cliente (entregue):** **toggle** no painel ("Por categoria | Por fornecedor·cliente") que re-agrega a linha por **entidade**, só em **linhas puras** (despesas→fornecedor/CP, receitas→cliente/CR; deduções/impostos/derivadas SEM lente — mistura/ambíguo). Responde "quais poucos fornecedores concentram o gasto e explicam o aumento vs ano-1". **2 Paretos:** concentração de NÍVEL (top-N por `abs(realizado)` / Σabs) + AUMENTO (`aumento_bruto=Σmax(delta,0)`; top-N / aumento_bruto; `null` se não cresceu). **Identidade:** `cnpj_cpf` válido (rejeita sentinela todos-iguais)→nome normalizado→`sem_identificacao`; badges Novo/Sumiu/Sem ID. **Honesto (Codex P2):** "concentração do realizado YTD e variação YoY", NUNCA "causou o estouro da meta" (não há meta por fornecedor). **Fonte = `fin_contas_pagar/receber` diretas** (mesmos filtros da `fin_dre_competencia_base`: emissão, status≠CANCELADO, valor_documento) → **reconcilia contra o total-por-categoria do v1** (`total_decomposto`, mesma base viva — Codex adversarial P1: NÃO contra o snapshot, que pode estar stale); o snapshot fica como contexto. **Limita server-side ao horizonte fechado** (senão ano-1 trunca e perde YTD); **chunked `.in()`** (URL), **`.order(id)`** (paginação estável), **teto 20k → modo diagnóstico** (esconde % — Pareto inválido truncado). Helper **`src/lib/financeiro/orcamento-entidade-helpers.ts`** (12 testes; `concentrarPorEntidade`/`coletarTitulosEntidade`/`entidadeDaLinha`) + `codigosDaLinha` extraído do v1 (reuso fecha a reconciliação) + `getTitulosEntidadeRaw` + toggle no `DrillVarianciaPanel`. **Codex em todas as 4 etapas** (metodologia + spec [3 P1] + plano [7 P1] + adversarial no código). **CLIENT-SIDE — sem migration/edge/deploy.** **Limitações:** nome normalizado não resolve filiais/grupos; volume/preço/título = v2 futuro; explica realizado YTD, não variância contra meta.

**Limitações v1 / o que ficou pro v2:** versionamento/snapshot histórico do forecast = v2; impostos regime-aware no forecast (compõe `fin-regime-tributario`) = v2; decomposição de variância volume/preço/mix = v2; consolidado cross-CNPJ = v2. ✅ **Follow-up de regime RESOLVIDO (PR #421):** a badge dizia "Regime de Caixa" mas a página sempre calculou **competência** (correto p/ orçado×realizado; o forecast depende dela p/ reconciliar). Era rótulo errado → corrigido p/ "Regime de Competência".

**Onde:** helper `src/lib/financeiro/orcamento-forecast-helpers.ts` (vitest, 26 testes; `projetarDRE` + `seedOrcamento` + primitivas); página `src/pages/FinanceiroOrcamento.tsx` (seção "Forecast de aterrissagem" + botão "Sugerir orçamento"); item na sidebar (`/financeiro/orcamento`, antes órfã). **Sem migration, sem edge function, sem deploy** (client-side puro).

## 🔧 Consolidação do Cockpit — religado às engines (2026-05-28)

Uma auditoria de consistência achou que o **Cockpit** (`/financeiro/cockpit`, consolidado das 3 empresas) mostrava números ERRADOS porque foi construído com atalhos antes das engines A1 existirem: **projeção 13s** via RPC ingênua `fin_projecao_13_semanas` (joga CR/CP no vencimento; sem curva de cobrança/inadimplência/eventos/folha) e **NCG** = `CR−CP` (só abertos). Religado:

- **Projeção 13s + NCG agora vêm da engine A1** via `fin_projecao_snapshots` (snapshot diário; curvas calibradas, inadimplência, eventos, folha; NCG = ACO−PCO real). **Snapshot-first** (não 3 invocações live — tela executiva semanal): mostra "dados de {data}".
- **Consolidado COM decomposição por empresa** (Codex P1 — caixa NÃO é fungível entre 3 CNPJs distintos; somar pode esconder insolvência local). **Coorte por data de referência:** só snapshots do dia mais recente entram; empresa com snapshot mais antigo = `stale` (fora da soma, sinalizado); dedupe por empresa (latest-wins). **Cenário explícito** ("realista"). **Intercompany NÃO eliminado** (premissa documentada — CR de uma empresa pode ser CP de outra → aviso no bloco). **Falha parcial honesta** (banner "N de 3", números = mínimo conhecido; ausente ≠ zero).
- **Rótulos honestos:** "Caixa Projetado 30d" (que não era 30d) → "Posição líquida (abertos)"; `DataBasisFooter` com regime dinâmico (não "caixa" fixo); badge "ACO−PCO (engine)" no NCG.
- Helper `src/lib/financeiro/cockpit-consolida-helpers.ts` (13 testes; `consolidarCockpit`) + `getProjecaoSnapshotsCockpit`. **Codex em todas as etapas** (metodologia + spec [3 P1] + plano [3 P1 anti-impl-preguiçosa] + adversarial). **CLIENT-SIDE — sem migration/deploy** (o snapshot já é gravado pelo cron `fin-cashflow-snapshot-diario`).
- **Limitações:** snapshot até 1 dia stale (data visível); intercompany não eliminado; caixa consolidado não-fungível (por isso a quebra por empresa). A decomposição ACO/PCO detalhada e os cenários ficam na tela **Capital de Giro** (live).
- ✅ **Caixa inicial da projeção exposto (transparência) (2026-05-31)** — alvo final da frente de consolidação (consult Codex rodada 3). A engine A1 grava `saldo_inicial` em cada semana do snapshot (= `fin_contas_correntes.saldo_atual` no momento), mas o client **descartava** o campo → o Cockpit mostrava o saldo bancário "agora" **ao lado** da projeção, sem dizer de qual caixa ela partiu. Agora `getProjecaoSnapshotsCockpit` lê o `saldo_inicial` (nullable, **fora do filtro rígido** — campo só-display não dropa a semana), `consolidarCockpit` expõe `caixa_inicial_projecao` (Σ do `saldo_inicial` da semana de **menor `inicio`** das empresas presentes — não `semanas[0]` literal, robusto se a semana 0 foi filtrada) + `caixa_inicial_por_empresa`/`caixa_inicial_parcial`, e o helper puro `compararCaixaInicial` mostra o **delta vs saldo bancário atual SÓ com coorte completa** (`caixa_inicial` da coorte parcial × `totalCC` das 3 = maçã×laranja). UI no `Projecao13Card`: "Caixa inicial da projeção: Y · saldo atual Z · Δ W (a diferença pode refletir movimentações após o snapshot)". **Mesma fonte** (engine e hook leem `fin_contas_correntes.saldo_atual` ativo=true) → snapshot de hoje tende a Δ~0; defasado mostra quanto o caixa mudou. **Codex em todas as etapas** (spec [sem P1] + plano [sem P1; campo obrigatório > opcional, testes menor-inicio-válido + coorte-parcial] + adversarial). **CLIENT-SIDE — sem migration/edge/deploy** (snapshot já grava o campo). Não muda nenhum número; só expõe a base + delta (sem alerta/threshold — não é diagnóstico). **Encerra a frente de consolidação cross-tela**; o maior valor seguinte é o founder preencher os inputs de contabilidade (folha/Ke/dívida/taxas) que destravam regime/valor/funding confiantes.

## 🔧 Valor A2 — Guard de NCG indisponível (ausente ≠ R$0) (2026-05-28)

Seguindo a consolidação do Cockpit, a mesma auditoria achou um furo no **Valor A2** (`/financeiro/valor`, ROIC/EVA): o engine lê o **NCG da engine A1** (`fin_projecao_snapshots.ncg`) como capital de giro — mesma fonte do Cockpit — mas, quando **não havia snapshot de NCG**, assumia `capital_giro = 0` silenciosamente. Com ativo fixo informado, o capital investido virava só o ativo fixo (subestimado) → **ROIC superestimado**, confiança **não** rebaixada (o "parcial" só olhava ativo fixo), e o aviso ficava enterrado num motivo. Violava "ausente ≠ zero" e divergia do Cockpit (que já trata NCG ausente como parcial). Corrigido:

- **NCG ausente → capital de giro e capital investido `null` (indisponível), não R$0**; ROIC/spread/EVA viram `null` (não fabricados) e a confiança cai pra **baixa**. UI diz "Sem snapshot de NCG — capital de giro indisponível (rode a projeção)", e **não** mais "* capital parcial (sem ativo fixo)" (mensagem errada nesse caso).
- **NCG negativo (folga) e zero são valores REAIS** (não ausência — `s.ncg != null`, sem truthiness). Capital investido ≤0 por folga grande continua dando `roic=null` **por capital conhecido** → confiança **media** (distinto de NCG ausente = baixa).
- **Frescor honesto (Codex P1):** snapshot de NCG com 45+ dias (cron é diário) → confiança **media** + "NCG de {data} (Nd atrás)" visível na tela. Stale NÃO vira indisponível (o NCG é real; pipeline morto já é vigiado pelo Sentinela).
- **Guard anti-coerção (Codex P1):** `capital_normalizado` null não vira `null + ajuste = número`. EBIT/NOPAT normalizado seguem calculados e exibidos; só as métricas que dependem de capital ficam null.
- Toda a resolução de capital (resolver + frescor + −12m + capitalInvestido) numa **função pura composta `resolverCapitalParaValor`** (testada ponta-a-ponta) espelhada verbatim no edge — não sobra `capital_giro = ncg ? ncg : 0` inline (Codex P1). **Reconciliação:** com snapshot válido, `A2.capital_giro` = último `fin_projecao_snapshots.ncg` da empresa = o mesmo NCG que o Cockpit usa.
- Helper `valor-helpers.ts` (+novos `resolverCapitalGiro`/`frescorGiro`/`acharCapitalGiroAnterior`/`resolverCapitalParaValor`; 56 testes) espelhado no engine `fin-valor-engine`. **Codex em todas as etapas** (spec [3 P1] + plano [3 P1: composta anti-inline + asserts exatos + distinção NCG-ausente×capital≤0] + adversarial). **Sem migration; requer deploy do `fin-valor-engine` via Lovable** (ROIC/EVA são calculados no edge). A4 (`fin-next-best-action`) lê só `wacc`/`spread` (já nullable) → não quebra.

## 🔧 A3 Cockpit de Valor — Guard de hurdle indisponível (não fabricar 20%) (2026-05-30)

Mesma frente do A2, alvo escolhido por consult Codex. O A3 (`/financeiro/valor-cockpit`, lucro econômico EVP por cliente/SKU) cobrava o capital de giro a um hurdle `k` que, **sem o Ke configurado** (`fin_valor_inputs.ke.base` ausente), virava **20% fabricado** (`fin-valor-cockpit` L204 `keBase ? ... : 0.20`). Esse hurdle inventado entrava em `encargo = k × (AR+estoque)` → `evp = cm − encargo` → **EVP fabricado** por cliente/SKU, e a UI mostrava "@ 20.0%". Mesmo "ausente vira número" do A2 NCG-guard. Corrigido:

- **Ke ausente/inválido → `k = null`** (`resolverHurdleCockpit`, NÃO fabrica 0,20; âncora obrigatória; soma ≤0 = "capital grátis" → null; `''`/whitespace do PostgREST não fabrica). `encargo`/`evp` viram **`null`** (não fabricados) em célula/rollup/empresa; a **margem (cm) segue** (não depende de k); confiança cai pra **baixa**; UI troca "@ 20.0%" por banner "EVP indisponível — configure o Ke em /financeiro/valor" e pinta o EVP null em neutro (não verde).
- **Acumuladores null-aware (Codex P1):** `encargoTotal`/`encEmp` guardados (`if (cel.encargo != null)`) — `null + x` NÃO vira número; `encargoTotalNull`/`encNull` → encargo_total null quando todo encargo é null.
- **Recomendações gated (Codex):** com hurdle ausente, `evp=null` significa "não calculável" (≠ "destrói valor") → suprime as regras EVP-dependentes (encurtar prazo/despriorizar/crescer); **"Subir preço"** (margem-pura) segue; "Cortar desconto" dispara com motivo hurdle-aware (sem prometer EVP). **Distingue `evp=null` por CUSTO ausente** (comportamento conservador atual preservado — teste de regressão) **de `evp=null` por HURDLE ausente** (global) via flag `hurdle_indisponivel`.
- **Aviso de hurdle vive na confiança + banner da UI, NÃO nas recomendações por-cliente** — senão vazaria pro **A4** (`fin-next-best-action` mapeia `recomendacoesCliente` → candidatos) como N itens "Configurar hurdle" na fila do CFO. Achado durante a execução.
- **Escopo (Codex): manter Ke; WACC é follow-up** (`A3.k=Ke` × `A2.wacc`; trocar p/ WACC misturaria bugfix com mudança de metodologia e ampliaria a indisponibilidade quando falta Kd/dívida/PL — fica p/ quando o founder preencher os inputs).
- Helper `valor-cockpit-helpers.ts` (+`resolverHurdleCockpit`; 43 testes) espelhado no engine `fin-valor-cockpit`; contrato `ValorCockpitResult` nullable (`k`/`encargo`/`encargo_total` + `hurdle_indisponivel`). **Codex em todas as etapas** (spec [3 P1 + escopo Ke×WACC] + plano [2 P1 testes regressão/misto + P2.3 asserts exatos + P3.6 UI neutra] + adversarial). **Sem migration; requer deploy do `fin-valor-cockpit` via Lovable** (EVP calculado no edge). Gate gestor comercial + master.

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
