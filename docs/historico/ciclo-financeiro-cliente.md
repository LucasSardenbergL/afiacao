# Ciclo financeiro por cliente (aba "Ciclo", master)

- **Data:** 2026-10-14
- **PR:** (preencher)
- **Spec:** `docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md`
- **Prova SQL:** `db/test-fin-ciclo-cliente.sh` (marcador `PROVA-CICLO-CLIENTE-OK`, LC_ALL=C e pt_BR.UTF-8)
- **Lição de domínio:** `docs/agent/financeiro.md` § "Ciclo por cliente"

## Números medidos (spec §2, prod via psql-ro, 2026-10-13/14)

- Baixa derivada (`v_titulo_baixas`) cobre ~90% dos títulos CR vencidos em 12m, por quantidade (colacor 1493/1623, colacor_sc 435/527, oben 4582/5106); a cobertura por valor é exibida na tela.
- Prazo concedido × real (12m): oben 26,2d → 29,6d (+3,5); colacor 22,1 → 24,7 (+2,6); colacor_sc 11,1 → 14,3 (+3,2).
- Clientes com ≥6 títulos pagos em 12m cobrem 89% do valor pago (oben, 184), 74,5% (colacor, 72), 26% (colacor_sc, 19).
- Oben: 138/184 atrasam no p80 (R$2,56M de R$3,4M); quase ninguém paga antes do vencimento.
- Carteira vencida em aberto (2ª população): spec §2 (medição inicial) oben 408 títulos / 116 clientes / R$268k; colacor 230 / 87 / R$119k (legado); colacor_sc 67 / 36 / R$19k. **Pré-voo de 2026-10-14 com as views finais: oben 103 clientes / R$262k.**
- Custo do dinheiro: `fin_funding_inputs = {}` e `fin_dividas` vazia, sem CET no banco.

## Challenge Codex (spec §11)

| Achado | Sev. | Adoção |
|---|---|---|
| Amostra só de pagos exclui quem mais precisa de cobrança; janela por baixa distorce tendência | P0 | Vencidas abertas como 2ª população + coorte por **vencimento** com censura |
| Fórmula `(1+c)^(N/30)−1` errada | P0 | `d_max = 1−(1+c)^(−N/30)`; N = cenário incremental, sem R$ por cliente |
| Encurtar prazo formal ≠ antecipar caixa | P0 | Folga sem R$; pontual = cenário assumido rotulado |
| Excesso sobre carência: média de max, não max da média; estoque ≠ recorrente | P1 | `excesso_carencia_pond` + separação |
| `n_meses×30` anualiza pico; recebimento ≠ faturamento | P1 | `volume_emitido_12m` por emissão |
| Parcelas não são independentes; média ≠ condição | P1 | `n_documentos` na confiança; proposta por calendário de parcelas |
| p80 por qtd vs por R$; "alta confiança" injustificada | P1 | Duas leituras + `misto`; sem nível `alta` |
| Hierarquia é hipótese | P1 | Rotulada; cenários nunca somados |
| Baixa final aplicada ao principal; "pior caso"; PMP≠CMV; degraus "de mercado"; 7→0 | P2 | `prazo_ponderado_dias`; "máximo observado"; PMP sem R$/dia; "degraus usuais"; sem 7→0 |

## Falsificações (sabotar um ramo por vez, controle verde na mesma invocação)

**SQL** (`db/test-fin-ciclo-cliente.sh`, rc=0 em LC_ALL=C e pt_BR.UTF-8): CONTROLE OK + 13 sabotagens "vermelha ok" cobrindo, entre outras, cancelado, excesso, sinal, ambíguo, finitude, `nullif` da NF, `nullif` do `numero_documento`, `mes_parcial` e prazo `-Infinity` como baixa. Última rodada desta entrega (rc=0), trecho final:

```
sabotagem vermelha ok: mes_parcial 1o mes da janela
sabotagem vermelha ok: prazo -infinito como baixa
PROVA-CICLO-CLIENTE-OK
```

**Helper TS** (`ciclo-cliente-helpers.test.ts`, 48/48 na 1ª entrega; 57/57 após a rodada de correção):
1. fórmula invertida → FAIL "c=2%, N=30 → 1,9608%": `expected 0.020000000000000018 to be close to 0.0196078`
2. volume ausente → 0 → FAIL "volume ausente → cenário null com motivo, nunca 0": `expected +0 to be null`
3. sem bloco vencido → FAIL x2: `expected 'cobrar_atraso' to be 'recuperar_vencido'` e `expected 'nenhuma' to be 'recuperar_vencido'`

## Decisões tomadas na execução

- **Pré-voo 1, `numero_documento = ''` na oben:** `coalesce` não pega string vazia; a chave de documento usa `nullif(btrim(...),'')` nos dois campos. Efeito: clientes oben com ≥6 NFs foram de 0 para 153 (antes nenhum saía de confiança baixa).
- **Pré-voo 2, 'VENCE HOJE':** é status Omie legítimo, não ambíguo; aberto (A VENCER/VENCE HOJE) com vencimento < `hoje_sp` e saldo > 0 conta como vencido (lag de sync). Vencido oben passou de ~116 clientes / R$268k para **103 clientes / R$262k**.
- **Degrau numérico só para cliente de parcela única:** média de parcelas ≠ condição (30/60/90 dá 60); parcelado recebe proposta por calendário, sem degrau inventado.
- **Custo do dinheiro por empresa:** não há CET no banco; o custo mensal é informado por empresa, com teto (`CUSTO_MENSAL_MAX` = 20%).
- **Fila agrupada por empresa em "Todas":** a fila de clientes não mistura CNPJs.
- **Card consolidado omitido:** somar entre CNPJs é proibido.
- **Adiados:** R$/dia do PME e histograma de atraso no drill.

## Fase N+1 só com sinal

Query de uso do evento `financeiro.ciclo_aberto` com denominador (nº de sessões master no período). Sem ≥1 sinal positivo de uso em prod, a fase seguinte é instalar/ler o sensor, não construir mais tela.

## Frente 3 — giro de estoque por SKU e o PME = 0d (2026-10-18)

Spec `docs/superpowers/specs/2026-10-18-ciclo-giro-sku-design.md` · plano `docs/superpowers/plans/2026-10-18-ciclo-giro-sku.md` · prova `db/test-fin-ciclo-giro-sku.sh` (15 sabotagens, C e pt_BR) · migration `20261018200000_fin_ciclo_giro_sku.sql` (aplicada pela sessão, validada por psql-ro, corpo idêntico ao arquivo).

- **Causa do PME 0d:** `fin_estoque_valor` nunca foi escrita em prod (só um formulário manual) e o engine fazia `Number(row?.valor ?? 0)`. O mesmo 0 ia para a NCG, que omitia o estoque das 3 empresas.
- **O denominador também estava furado:** o DRE da oben parou em 2026-03 (6 de 12 meses na janela) e o da colacor_sc grava CMV 0. Agora o CMV exige os 12 meses fechados, senão PME "—" com motivo. Efeito na estreia: colacor com número; oben e colacor_sc com "—" até o DRE ser consertado (fora desta entrega).
- **O "estoque" do Omie não é todo estoque:** na colacor, R$ 1,48 mi é tipo 08 (imobilizado: máquinas, dispensador) e R$ 0,2 mi é 07/99 (uso e consumo). Classe por tipo SPED **ou** família, numa função única `_fin_estoque_classe`. O founder confirmou que o 08 é imobilizado e pediu a lista para acompanhar, que virou "Fora do giro", com o selo "conferir cadastro" quando tipo e família discordam (51 SKUs na colacor, 26 na oben).
- **Codex (challenge da spec):** nenhum P0. Os P1 viraram a §5.4 (fonte de consumo exige 330 dias de histórico e frescor de 7 dias; unidade da malha travada; compra recente (`cmc_ledger` ≤ 90d) não é giro morto; candidatos, não ordens; sem "dias agregados" que dupla-contam acabado + insumo; override manual só com `fonte='manual'`; NCG `parcial`).
- **Desempenho:** a primeira versão da RPC levava 2,5 s em prod. A view `v_pcp_malha_oben` custa ~250 ms por avaliação e, num `EXISTS` correlacionado, era reavaliada por linha (a consulta isolada estourou o tempo). Com CTEs `MATERIALIZED` e `LEFT JOIN`, ficou em 378 ms como master sob `authenticated`.
- **Números de estreia (prod, 2026-10-18):** oben com 315 candidatos a liquidar (≈ R$ 103 mil) e 161 a segurar (≈ R$ 109 mil acima de 90 dias); colacor e colacor_sc sem consumo por SKU (NF-e só da Oben), mostrando só o R$ parado.
- **Onde mais muda:** a NCG das 3 empresas sobe pelo estoque de giro, e o `fin-valor-engine` (capital investido/ROIC) lê essa NCG de `fin_projecao_snapshots`. É correção, não regressão, mas o histórico de snapshots mistura antes e depois.
- **Fase N+1 só com sinal:** os eventos `financeiro.ciclo_giro_visto` e `financeiro.ciclo_giro_filtro` (por empresa/ação), com denominador em `financeiro.ciclo_aberto`.

---

# Frente 4 — PMP por fornecedor e o custo do prazo (2026-10-18)

Spec `docs/superpowers/specs/2026-10-18-ciclo-pmp-fornecedor-design.md` (§9 = calibração do challenge Codex, prevalece). Plano `docs/superpowers/plans/2026-10-18-ciclo-pmp-fornecedor.md`. Migration `20261018150000_fin_ciclo_fornecedor.sql`. Prova `db/test-fin-ciclo-fornecedor.sh` (40 asserts + 9 sabotagens INLINE, no `nucleo-ci`).

## A premissa que o founder derrubou

O handoff pedia "fila de fornecedores onde cabe negociar prazo maior". O founder: *prazo maior = preço de compra maior*. Ele quer o menor preço, o estoque girando rápido e receber cedo. A frente virou **"quanto o prazo está custando"**. O caso concreto é a Sayerlack: 2% de desconto no boleto pago até o vencimento (vem escrito no boleto); antecipado dá 2% na NF; acima disso o preço sobe. Desde jul/2026 o boleto vence em 9–11 d, por escolha da fábrica.

## Medido em prod (psql-ro)

| Fato | Medida |
|---|---|
| Controle do engine (`v_capital_giro_prazos.pmp`, reproduzido) | **32 / 5 / 12 d — bate** |
| PMP de COMPRAS (dDtPagamento − emissão, ponderado por valor) | colacor 50,3 d · oben 13,1 d · colacor_sc −29,5 d (1 título) |
| Ponte engine → compras | universo (o engine inclui empréstimo, ICMS, folha — a colacor_sc é quase só folha) + janela 12m + peso `valor_documento` |
| Compras 12m por emissão · R$/dia | colacor R$ 263,7 mil · R$ 723/d — oben R$ 2,41 mi · R$ 6.615/d |
| Sensor de universo (12m, emissão) | 2.01.* fora da lista: colacor 87 títulos / R$ 50,7 mil; colacor_sc 26 / R$ 35,2 mil; oben 119 / R$ 18,8 mil. Sem categoria: colacor 18 / R$ 54,5 mil |
| Tempo da consulta inteira (corpo da RPC por empresa) | 1,9 s (como dono, sem RLS por linha) |
| Sayerlack por mês de vencimento | até mai/2026 vencimento 1–2 d após a emissão e quase tudo pago depois dele, **sem** desconto no boleto (regime antigo: 2% embutido na NF). Descontos isolados em nov/2025 (1,2%) e fev/2026 (2,9%). **Desde ago/2026: 27 títulos a exatamente 2%**, quase tudo em dia; 1 pago atrasado ainda COM desconto; ~4 pagos em dia SEM desconto ("conferir boleto") |

## Decisões que a medição forçou

- **Saldo do CP não serve:** `saldo = valor_documento` até em PAGO. Em aberto = `resumo_val_aberto` (identidade ok), senão o valor do título com selo.
- **Pontualidade só por `data_pagamento_omie`:** `titulo_data_movimento` pode ser registro/previsão, e a CC liquida em D+1. Ambos viram "data incerta", com denominador explícito.
- **Regime de desconto:** abre no vencimento do 1º de ≥ 3 NFs com desconto em 90 d. Sem isso, os descontos isolados de nov/fev abririam o regime e o cenário cobraria "2% perdidos" de um ano em que o desconto vinha na NF.
- **Perdido = `max(taxa·base − desconto_informado, 0)`:** o título pago atrasado que ainda levou o desconto contribui 0.
- **Código de categoria muda entre empresas:** lista (empresa, código) explícita; o prefixo `2.01%` puxaria imobilizado da colacor.
- **Views sem SELECT para `authenticated`:** só as RPCs (gate master) leem. `security_invoker` não cria restrição master (Codex #9).
- **Taxa implícita a.m. removida:** não existe a alternativa "pagar depois sem desconto" como data concreta (Codex #7).
