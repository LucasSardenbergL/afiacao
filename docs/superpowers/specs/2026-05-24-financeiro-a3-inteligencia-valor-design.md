# Financeiro A3 — Inteligência de Valor (Cockpit cliente/produto + preço/prazo) — Design

> Continuação do programa "Estado da Arte do Financeiro" (A1 caixa 13s · A2 retorno/ROIC). A3 muda a pergunta de "quanto fatura" para **"quanto vale"**: contribuição econômica por cliente / SKU / combo, e a ação comercial a tomar. Design pré-validado por dois consults Codex (priorização da fronteira + fórmula do custo de capital de giro).

## 1. Contexto e objetivo

O dono decide preço, prazo, desconto e foco comercial. Hoje o app mostra faturamento e margem bruta, mas não **lucro econômico** — margem de contribuição **menos o custo do capital de giro** que aquele cliente/SKU consome (recebíveis parados + estoque parado), cobrado ao **hurdle-rate da A2 (WACC)**. É onde mora o vazamento de valor numa distribuidora: cliente "grande" que paga tarde, SKU de margem ok mas com estoque empacado, desconto que come a margem, prazo maior que o do fornecedor.

A3 entrega um **Cockpit de Valor** (ranking por lucro econômico) + uma **camada prescritiva** (que termo comercial mudar) — o output "estado da arte" para um dono operando no detalhe.

## 2. Escopo por empresa (honesto — definido pelo dado real)

- **`order_items`/`sales_orders` NÃO têm coluna `company`**; `omie_products.account` default `'oben'`. O fluxo de venda com **linha de SKU no app é da Oben** (a distribuidora, dona do portal de pedidos).
- **Oben**: cockpit SKU-completo (linha de venda + custo + estoque + AR por cliente). É a empresa-alvo, e onde o Codex disse que o valor está.
- **Colacor (indústria) / Colacor SC (serviços)**: sem linha de SKU no app → degradam para nível-cliente (a partir do AR do Omie, sem SKU) ou "SKU indisponível". A tela declara isso explicitamente. Custo absorvido de fábrica (BOM Colacor) é **não-escopo**.

MVP entrega **Oben**; o nível-cliente das outras duas é um seguimento barato (mesmo engine, sem a parte de SKU).

## 3. Fontes de dado (tudo já existe no schema)

| Dado | Tabela | Uso |
|---|---|---|
| Linha de venda (cliente×SKU×qtd×preço×desconto) | `order_items` (+ `sales_orders`) | Receita líquida e quantidade por combo |
| Custo do produto | `product_costs.cost_price` (1 custo médio atual/produto) | Margem de contribuição (direcional; sem BOM) |
| AR por cliente | `fin_contas_receber` (`omie_codigo_cliente`, `saldo`, datas, status, por `company`) | Saldo médio em aberto → base de capital do cliente; PMR/inadimplência |
| Estoque por SKU | `inventory_position` (`saldo`, `cmc`, `omie_codigo_produto`, `account`) | Valor de estoque parado → base de capital do SKU |
| AP (fornecedor) | `fin_contas_pagar` (por fornecedor, `company`) | Crédito de financiamento **nível-empresa** (não rateado) |
| Produto | `omie_products` (`codigo`, `descricao`, `ncm`, `account`) | Identidade do SKU |
| Hurdle-rate (WACC) | engine/inputs da **A2** (`fin_valor_inputs` + `fin-valor-engine`) | Taxa do encargo de capital (`k`) |

**Join cliente→AR:** `order_items.customer_user_id` → profile `omie_codigo_cliente` → `fin_contas_receber.omie_codigo_cliente` (filtrado por `company`).

## 4. Núcleo metodológico — tabela atômica cliente×SKU (fonte da verdade)

Decisão central (Codex): **não** calcular a view de cliente e a de SKU independentemente (somá-las dupla-conta margem e capital). Em vez disso, **uma célula atômica por combo `(cliente c, SKU s)` no TTM**, e cliente/SKU/empresa são **rollups** dela.

Para cada célula:
- `R_cs` = receita líquida do combo; `Q_cs` = quantidade; `CM_cs` = margem de contribuição do combo.
- **Encargo de capital de giro do combo**, alocado das bases reais:
  - AR do cliente alocado pelos SKUs **por participação de receita**: `A_cs = A_c × (R_cs / R_c)`.
  - Estoque do SKU alocado pelos clientes **por participação de quantidade**: `I_cs = I_s × (Q_cs / Q_s)`.
  - **`EVP_cs = CM_cs − k × (A_cs + I_cs)`**, com `k` = WACC anual (A2).
- **Rollups (reconciliam por construção):**
  - `EVP_cliente_c = Σ_s EVP_cs` = `CM_c − k × [A_c + estoque alocado aos SKUs que ele compra]`
  - `EVP_SKU_s = Σ_c EVP_cs` = `CM_s − k × [I_s + AR alocado dos clientes que compram s]`
  - `Σ_c EVP_cliente = Σ_s EVP_SKU = Σ_cs EVP_cs` (= EVP bruto da empresa)
- **Lucro econômico bruto da empresa:** `EVP_company_gross = Σ CM_cs − k × (Σ A_c + Σ I_s)`.

Onde:
- **`A_c`** = **saldo médio diário em aberto** de `fin_contas_receber` do cliente no TTM (usar `saldo`, não valor de face; incluir títulos abertos durante o período mesmo que emitidos antes). PMR/DSO é **diagnóstico**, não base de capital.
- **`I_s`** = valor de estoque médio do SKU no TTM = média de `saldo × cmc` (não o snapshot mais recente, salvo rotulado como run-rate).
- Encargo anual = `base × k` no TTM cheio; para período parcial, `base × ((1+k)^(dias/365) − 1)`.

Views de lente única (`CM_c − k·A_c` e `CM_s − k·I_s`) existem **só como diagnóstico** e **nunca são somadas entre si**.

## 5. AP (financiamento de fornecedor) e velocidade

- **AP** é keyed por fornecedor, não por cliente/SKU → **não rateia por linha** (rateio fabrica precisão falsa). Mostra-se como **crédito nível-empresa**: `EVP_company_net = EVP_company_gross + k × AP_médio_comercial` (≡ `CM − k×(AR + estoque − AP)`). Sem haircut de DPO. (Rateio opcional só ao estoque, rotulado "financiamento de fornecedor pooled" — fora do MVP.)
- **Velocidade / estoque parado**: **NÃO** multiplica o encargo (dupla-conta o efeito de stock). Vira **flag** separado: sem venda no TTM, dias-de-estoque acima do limiar, margem negativa, estoque sem demanda alocada. Impairment real = baixa/perda esperada, não multiplicador de WACC.

## 6. Receita líquida e margem (cuidados BR — distribuidora)

- **Margem de contribuição usa receita LÍQUIDA**: após descontos, devoluções, cancelamentos, impostos sobre venda e bonificações. Bonificação = desconto / venda preço-zero com custo (não some).
- Impostos **não estão por linha** em `order_items` → alocação **nível-empresa/regime** (Presumido: impostos sobre receita direcionais), marcada **"estimado"**. (Imposto exato por linha = não-escopo.)
- AR é **valor bruto da nota** (inclui impostos/frete/ST); alocação de AR usa a base financiada da nota quando poss​ível, não a receita gerencial líquida.
- Custo: `cost_price`/`cmc` é direcional. ICMS-ST, frete de entrada, custos não-recuperáveis idealmente no custo landed (não-escopo refinar; sinalizar). Frete de saída/comissões/taxa de cartão entram na CM se materiais e disponíveis.
- Devolução reverte receita+custo+imposto+AR de forma consistente.

## 7. Scores de qualidade

- **Cliente**: margem, comportamento de pagamento (PMR realizado), inadimplência, concentração, volatilidade de compra. (PMR/inadimplência reusam as curvas de aging da A1/Onda 2.)
- **Produto**: margem de contribuição %, intensidade de estoque (dias), velocidade de venda, carga tributária, pressão de desconto.

## 8. Camada prescritiva (preço/prazo) — regras determinísticas configuráveis

Por combo/cliente/SKU, regras (sem ML, honestas):
- `EVP < limiar` **e** `desconto > desconto_máx` → **cortar desconto** (quantifica quanto recupera).
- `EVP < 0` por causa do encargo de AR (`A_c` alto / PMR alto) → **encurtar prazo / exigir antecipado**.
- `margem_contribuição% < margem_mínima` → **subir preço** (Δ pra atingir margem-alvo).
- SKU `EVP_SKU < 0` + estoque alto/velocidade baixa → **despriorizar SKU / renegociar fornecedor / liquidar estoque**.
- `EVP` alto + crescente → **crescer / proteger**.

**Config master** (mesma família da A2): margem mínima, taxa de custo de giro (default = WACC A2), desconto máximo, prazo-alvo, limiares de dias-de-estoque e sample mínimo. Coluna JSONB opcional `cockpit_config` (ou reuso de `fin_valor_inputs`), leitura defensiva.

## 9. Confiança / degradação honesta (disciplina por campo)

- `CM_cs = null` se custo ausente, quantidade inválida, ou receita não confiável; `= estimado` se usa custo atual pra venda histórica.
- `encargo AR = null` se AR não junta ao cliente; `= 0` só se cliente junta e não tem AR aberto.
- `encargo estoque = null` se estoque/`cmc` do SKU ausente; `= 0` só se SKU existe com estoque zero.
- `EVP_cs = null` se CM null ou base de capital necessária ausente; `EVP parcial` só com flag.
- **Cobertura de receita** = receita de `order_items` ÷ receita-AR total do cliente → vira score de confiança (se a maior parte das vendas não passa pelo app, o cockpit avisa que está parcial).
- Amostra pequena (receita/nº notas/unidades < limiar) → flag "histórico insuficiente"; nunca topo/fundo do ranking.
- Janela **TTM + rolling 3m**. `bucket "não-alocado"` para AR sem cliente, estoque sem venda, AP não rateável.
- Nunca fabrica número: campo ausente = `null` + motivo (princípio do módulo).

## 10. Onde mexe (arquitetura — espelha a A2, que funcionou)

- **Helper puro**: `src/lib/financeiro/valor-cockpit-helpers.ts` (vitest), funções: `margemContribuicao`, `encargoCapitalCliente`, `encargoCapitalSKU`, `montarCelulasComboEVP` (a tabela atômica + alocação), `rollupCliente`/`rollupSKU`/`rollupEmpresa`, `scoreCliente`/`scoreProduto`, `recomendarAcaoComercial`, `scoreConfiancaCockpit`. **Espelhado verbatim** no engine Deno.
- **Engine Deno**: `supabase/functions/fin-valor-cockpit/index.ts` — lê `order_items`+`product_costs`+`fin_contas_receber`+`inventory_position`+WACC(A2) pra Oben, monta as células, devolve rankings + recomendações + confiança. **Gate: gestor comercial (`commercial_roles.commercial_role IN ('gerencial','estrategico','super_admin')`) + master.** Vendedor individual NÃO acessa (não vê margem de todos os clientes). O engine valida o papel via JWT (gestor ou master) antes de responder.
- **Config**: coluna JSONB opcional `fin_config_cashflow.cockpit_config` (idempotente, leitura defensiva) — limiares operacionais (margem mínima, taxa de giro default=WACC A2, desconto máx, prazo-alvo, dias-de-estoque, sample mínimo). São política comercial operacional (não dado do dono), então tudo bem ficar legível por staff/gestor.
- **UI**: rota/aba `/financeiro/valor-cockpit` (gate gestor comercial + master) — ranking por lucro econômico (cliente / SKU / combo), filtros, scores, e as **recomendações acionáveis** com o R$ em jogo; banner de confiança + cobertura de receita.
- **Tipos/hook**: `financeiroService.ts` + `useValorCockpit`.
- **Docs**: seção A3 em `FINANCEIRO_CONFIABILIDADE.md`.

## 11. Testes (vitest no helper)

- `margemContribuicao`: receita − custo×qtd; custo ausente → null; receita líquida (desconto entra).
- `encargoCapitalCliente`/`encargoCapitalSKU`: base × k; base ausente → null; base 0 → 0.
- `montarCelulasComboEVP`: alocação `A_cs = A_c·R_cs/R_c` e `I_cs = I_s·Q_cs/Q_s`; **rollups reconciliam** (Σcliente = ΣSKU = Σcombo = empresa) — teste de invariante; combo com CM null → EVP null.
- `rollup*`: somas corretas; não dupla-conta.
- `recomendarAcaoComercial`: cada regra dispara na condição certa + quantifica; sem gatilho → "saudável".
- `scoreConfiancaCockpit`: cobertura baixa → rebaixa + motivo; amostra pequena → flag; custo/estoque ausente propaga.

## 12. Migração / pré-requisitos

- Depende da A2 em produção (hurdle-rate WACC) — em PR mergeado, pendente deploy do engine.
- Sem migration obrigatória além da coluna `cockpit_config` opcional (SQL idempotente entregue ao SQL Editor). Sem ela → usa defaults + degrada.
- Confirma que `omie-vendas-sync`/sync popula `order_items` e `inventory_position` com a cobertura assumida (a cobertura de receita já é medida e exibida).
- Re-deploy do engine via chat Lovable. Rota nova no `App.tsx`.

## 13. Definição de pronto

- Tabela atômica cliente×SKU com a fórmula `EVP_cs = CM_cs − k×(A_cs + I_cs)` e alocação que **reconcilia** nos 3 rollups (invariante testado).
- AR = saldo médio TTM; estoque = saldo×cmc médio; AP = crédito nível-empresa; velocidade = flag (não multiplicador).
- Rankings cliente/SKU/combo por lucro econômico + scores + **recomendações de preço/prazo com R$ em jogo**.
- Escopo Oben-primário; degradação honesta declarada na tela (cobertura de receita, custo/imposto estimado, amostra pequena, "não-alocado").
- Helper vitest verde; `bun run test` 100%; `validate` (CI) verde; zero lint novo; `deno check` no engine.
- UI + docs CONFIABILIDADE seção A3 honesta ("direcional; custo é médio atual sem BOM; imposto estimado nível-empresa; cobertura depende do sync").
- A3 não regride A1/A2/Ondas 1-3.

## 14. Não-escopo (deferido — documentado)

Custo de absorção total de fábrica da Colacor (BOM/labor/overhead); elasticidade de preço real (precisa experimento/teste A/B comercial); imposto exato por linha (ICMS-ST/MVA/ressarcimento); custo landed completo; SKU-level para Colacor/Colacor SC até o dado de linha existir; rateio de AP por linha; impairment formal de estoque; recebíveis factored/descontados; sazonalidade modelada além de média TTM. Otimizador prescritivo continua **regra determinística** (não otimização matemática/ML).
