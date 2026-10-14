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
