# Oben — plano para reduzir PME e PMR sem perder qualidade (proposta, 2026-10-31)

> Status: PROPOSTA (nada implementado). Fonte: código da aba Ciclo + leituras read-only em prod (psql-ro, 2026-10-31) + consulta de DESENHO ao Codex (`gpt-6-astra · high · 50s · 19.237 tokens`, prompt com `RÉGUA:`). Decisão registrada que o plano RESPEITA: não alongar PMP/Sayerlack.

## 1. Régua

- 1 dia de PMR = R$ 11.287 (receita competência TTM / 365). 1 dia de PME = R$ 6.753 (CMV = DRE `2.01.*` ≈ R$ 2,46 mi / 365; não exibido no card).
- PME = estoque de giro (foto de hoje, `inventory_position` account `vendas`, classe giro) / CMV 12 meses fechados. PMR engine = média all-time ponderada por R$ baixado só de títulos PAGOS. PMP = CP total.
- Ordem dos irreversíveis: medição → política de compra → liquidação/devolução → condição comercial do cliente.

## 2. Diagnóstico medido (Oben)

### PMR 31d
- Coorte 12m: concedido 27,3d → real 31,2d. O prazo CONCEDIDO explica ~88% do PMR; atraso líquido +3,9d.
- Mix por faixa de prazo concedido (valor pago 12m R$ 3,70 mi · 459 clientes): ≤15d 22% · 16–30d 26% · 31–45d 39% (123 clientes, R$ 1,44 mi, 35→41d) · 46–60d 11% · >60d 1,5%.
- Vencido em aberto hoje: R$ 266.910 (430 parcelas · ≤15d R$61k · 16–45d R$60k · 46–90d R$63k · >90d R$79k em 54 clientes). Fica FORA do PMR (só pagos entram).
- % pago por coorte de vencimento: nov/25–jun/26 95–100%; jul 88%; ago 88%; set 84%; out 74% (parcial). Codex: suspeito, não provado — exige coortes maturadas em D+15/D+30/D+60.
- Maiores R$×dias de atraso: cliente C1 (R$184k, concedido 5,7d, atrasa 13,5d), cliente C2 (R$377k, +5,8d), cliente C3 (+26d), cliente C4 (+15d, R$10,7k vencido), cliente C5 (+20,6d, R$40,8k vencido).
- Gate de crédito atual (`venda_gate_credito`): bloqueia só com vencido >60d, com exceção. Régua de cobrança: só texto na fila; sem estado, sem tarefa, sem WhatsApp. CET: `fin_funding_inputs = {}`.

### PME 75d (73,4d pela conta do dia; conciliar sync/CMV)
- Estoque de giro R$ 495.474 · 746 SKUs · top-20 = 26% do R$, top-100 = 58%.
- Cobertura (saldo / consumo 365d por NF-e + explosão PCP): <30d R$15k · 30–90d R$152k · 90–180d R$58k · 180–365d R$42k · >365d R$102k · sem consumo 365d R$127k (360 SKUs).
- Furo de medição: `Concentrados LC` R$54k em 194 SKUs, só 9 com consumo registrado (dosagem SayerSystem não entra) → ~R$50k do "sem consumo" é artefato. Giro de corante Fase 1 já mede; Fase 2 substituiria a demanda.
- Vazamento de compra: entrada de compra nos últimos 90d (cmc_ledger) em 56 SKUs com cobertura ≥180d (R$56k de estoque), 36 SKUs 90–180d (R$43k), 25 sem consumo (R$18k). A tela de giro ("segurar_compra") não escreve em `sku_parametros`; `cobertura_alvo_dias` está vazio na maioria dos SKUs automáticos.
- Sayerlack ≈ 70% das compras, prazo 4d (2% desconto). PMP fica.
- Não existe sensor de ruptura (`atp_decisoes` tem 1 linha em 120d).

## 3. O que o Codex derrubou do plano preliminar

- PME 50d exige tirar R$157,8k de estoque (não R$170k); corante melhora decisão, mas não reduz PME por si.
- Vencido (R$267k = 23,6 dias) não se SOMA ao PMR; DSO deve usar recebíveis totais (a vencer + vencido) e deixar a convenção explícita.
- Queda de % pago recente ainda não prova deterioração: coorte de outubro teve menos tempo. Alerta universal "<90%" cortado; usar maturação fixa.
- R$262k de excesso não é caixa; R$117k é estoque em SKUs recomprados, não compra indevida. Caixa real só com cálculo por SKU e deságio/frete.
- Cortar: 360 SKUs → sob encomenda em massa; tetos universais 90/120d; top-100 → 45–60d; bloqueio automático com 15d; "prazo real vira concedido"; focar só nos >90d.
- Desconto por antecipação: 1% por 7 dias ≈ 69% a.a. efetivo; não subsidiar quem já paga cedo. Degrau 35→28 na faixa 31–45d ≈ R$30,8k com adesão integral — risco alto.
- Acrescentar: registro de decisão/piloto, ponte de caixa (reclassificação/baixa contábil melhoram PME sem liberar dinheiro), demanda não atendida inclusive venda perdida antes do pedido.

## 4. Plano em LEVA ÚNICA (decisão do founder 2026-10-31: resolver tudo de uma vez)

As "ondas" viraram 3 FRENTES paralelas, uma sessão por frente, sem arquivo em comum. Só dois gates duros permanecem: liquidar exige demanda verdadeira; desconto exige CET no banco. Cada ação nasce COM o sensor no mesmo PR.

### Decisões do founder (AskUserQuestion, 2026-10-31)
1. **Prazo no pedido:** cliente com título vencido → o pedido AVISA a vendedora (vencido, atraso médio) e SUGERE prazo menor/à vista; vendedora decide; decisão fica registrada com motivo. Não muda condição de contrato; não trava (gate >60d continua como está).
2. **Segurar compra:** suspender recompra JÁ em todos os SKUs com cobertura ≥180d (R$ 144k), com sensor de ruptura nascendo no mesmo PR e reativação em 1 clique.
3. **Liquidar:** começa agora só o INEQUÍVOCO: cobertura >365d, sem venda em 12m, não corante, sem compra nos últimos 90d. O resto espera corante reconciliado + 30–45d do segurar-compra.
4. **Custo do dinheiro:** gravar CET ≈ 2,5% a.m. em `fin_funding_inputs` (Oben) para o desconto por antecipação.

### Frente A — Régua e sensores (financeiro/cashflow/ciclo, engine)
- Card: PME com R$/dia, data do sync, cobertura de custo; PMR pago + DSO (CR aberto total / receita TTM) lado a lado, convenção explícita; Ciclo rotulado "bases distintas".
- Série mensal de estoque de giro lida dos snapshots diários → PME por estoque médio.
- Coortes por vencimento com maturação fixa D+15/D+30/D+60; separar atraso positivo, antecipação, saldo aberto.
- Sensor de ruptura/fill-rate: item pedido × atendido (ATP) + orçamento sem estoque. Vive no ledger, com denominador.
- Corante: consumo dosado (giro-corante Fase 2) entra em `v_sku_demanda_efetiva`.

### Frente B — Pedido, cobrança e desconto (venda/pedido, fila de clientes)
- No pedido (`UnifiedOrder`/fronteira `omie-vendas-sync`): aviso + sugestão de prazo menor para cliente com vencido; decisão registrada (tabela própria, 1 writer).
- Fila de cobrança com estado (a contatar → contatado → promessa → pago/negociado/disputa), dona = vendedora, carteira inicial congelada; régua WhatsApp D−2/D+1/D+7 pelo canal já existente.
- CET 2,5% a.m. persistido; painel de desconto deixa de ser URL efêmera; desconto só onde antecipa caixa (não para quem já paga cedo).
- Sensor: recebido líquido / saldo inicial congelado; promessas cumpridas/vencidas; prazo concedido médio dos pedidos novos (antes × depois).

### Frente C — Estoque (reposição, giro, Raio-X)
- "Segurar compra" escreve em `sku_parametros` (suspende auto-reposição / fixa `cobertura_alvo_dias`) com autor, motivo, validade e reativação em 1 clique; aplicado de saída a todos ≥180d.
- Liquidação do inequívoco via Raio-X existente, registrando deságio/frete/margem; troca por outro encalhe não vale.
- Sayerlack: entregas parceladas / lotes menores mantendo preço e 2%; medir lead-time P95 antes de reduzir segurança.
- Guardrail: fill-rate (Frente A) cai >1 p.p. → pausa e revisão; item crítico faltante → reativa.

### Ordem dentro da leva
Dia 1: A (sensor de ruptura + CET) e C (segurar compra) sobem juntos; B (aviso no pedido + fila) sobe em paralelo. Liquidação inequívoca assim que o filtro estiver provado por SQL. Degrau de prazo em massa e liquidação do resto: só com sinal (fill-rate estável 30d, corante reconciliado).

## 5. Metas honestas (inalteradas)
- PME 75 → 60d em 90 dias (≈ R$100k) é o que as ondas 0–2 sustentam; 50d só com Onda 3 executada e corante reconciliado.
- PMR: 31d muda pouco sem Onda 4; o ganho de caixa vem da Onda 1 (vencido) e aparece no DSO, não no PMR pago.
- Nada disso é compromisso até os sensores da Onda 0 existirem.
