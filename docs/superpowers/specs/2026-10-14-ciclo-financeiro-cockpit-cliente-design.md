# Ciclo financeiro — cockpit + comportamento de pagamento por cliente (frente 1+2)

> Status: **v2** — incorpora o challenge Codex (gpt-6-astra, high, 2026-10-14; 3 P0 + 5 P1 + P2, todos adotados — §11). Aguarda revisão do founder.
> Escopo: frentes 1 (cockpit do ciclo) e 2 (cliente). Frentes 3 (giro por SKU) e 4 (PMP por fornecedor) ficam para specs próprias.

## 1. Objetivo

Dar ao founder (**master-only**) uma aba **"Ciclo"** em `/financeiro/capital-giro` que responda, para as 3 empresas (colacor, oben, colacor_sc):

1. **Onde está o ciclo** — PME + PMR − PMP por empresa, quanto vale 1 dia de PMR/PME em R$, e quanto do prazo real é **prazo concedido** vs **atraso**.
2. **Quem paga como** — por cliente: prazo concedido, prazo real, atraso (frequência e exposição em R$), **carteira vencida em aberto agora**.
3. **O que fazer com cada cliente** — UMA alavanca sugerida, com o **cenário** de caixa em R$ quando o cenário for explicitável, e "hipótese sem número" quando não for.

**Não-objetivos:** não altera condição no Omie, não envia cobrança, não decide crédito (`venda_gate_credito` intocado). Recomenda; o dono decide. **Cenário ≠ previsão:** nenhum R$ da tela é benefício esperado — sem piloto medido não há taxa de resposta (§11, P0-3/P1-4).

## 2. Evidência que moldou o desenho (prod, psql-ro, 2026-10-13/14)

- Baixa derivada (`v_titulo_baixas`) cobre ~90% dos títulos CR vencidos em 12m (colacor 1493/1623, colacor_sc 435/527, oben 4582/5106) — **por quantidade**; a cobertura por valor é exibida na tela, não presumida.
- Prazo concedido × real (12m): oben 26,2d → 29,6d (+3,5); colacor 22,1 → 24,7 (+2,6); colacor_sc 11,1 → 14,3 (+3,2).
- Clientes com ≥6 títulos pagos em 12m cobrem 89% do valor pago (oben, 184), 74,5% (colacor, 72), 26% (colacor_sc, 19).
- Perfil por p80 do atraso: quase ninguém paga antes do vencimento (oben 2 clientes/R$9k com folga ≥3d; colacor 0). Oben: 138/184 atrasam no p80 (R$2,56M de R$3,4M).
- **Carteira vencida em aberto (fora da amostra de pagos):** oben 408 títulos / 116 clientes / R$268k (R$60k > 90d); colacor 230 / 87 / R$119k (média 872d — legado); colacor_sc 67 / 36 / R$19k.
- Custo do dinheiro: `fin_funding_inputs = {}` nas 3 e `fin_dividas` vazia ⇒ **sem CET no banco**.
- Condição de pagamento não é persistida por cliente ⇒ "prazo concedido" = `vencimento − emissão` **de cada parcela** (o vencimento é o VIGENTE; renegociação apaga o original — limitação rotulada).

## 3. Arquitetura (abordagem A — views de fatos + helper TS puro, sem edge)

```
fin_contas_receber ─┬─ v_ciclo_cr_titulos (por parcela: paga 12m OU vencida em aberto) ─┬─ v_ciclo_cliente_resumo (company×cliente)
v_titulo_baixas ────┘                                                                    └─ v_ciclo_empresa_coorte (company×mês de VENCIMENTO)
        src/lib/financeiro/ciclo-cliente-helpers.ts (confiança, perfil, alavanca, cenários)
        src/components/financeiro/cashflow/ciclo/*  (aba "Ciclo", master-only)
        + PMR/PMP/PME/CCC/NCG atuais do fin-cashflow-engine (useCashflowProjection — reuso)
```

Deploy = 1 migration + Publish. Todas as views `WITH (security_invoker=on)` (RLS financeiro das bases vale); gate master é de UI. Data de corte em SP: `(now() AT TIME ZONE 'America/Sao_Paulo')::date` (= `hoje_sp` abaixo).

### 3.1 `v_ciclo_cr_titulos` (por parcela)

`fin_contas_receber r LEFT JOIN v_titulo_baixas b ON (company, omie_codigo_lancamento) AND b.tipo='CR'`. Base comum: `status_titulo <> 'CANCELADO'`, `valor_documento` NOT NULL, `> 0`, finito (`< 'Infinity'`), `data_emissao`/`data_vencimento` NOT NULL, `data_vencimento >= data_emissao`. Duas populações, **nunca misturadas numa média**:

- `situacao='paga'`: `b` presente e `data_vencimento` em `[hoje_sp − 365, hoje_sp)` (**coorte por vencimento**, não por baixa — evita que recuperar dívida velha "piore" a tendência).
- `situacao='vencida_aberta'`: `b` ausente, `status_titulo='ATRASADO'`, `saldo > 0` — **qualquer idade** (envelhecimento é coluna).

Colunas: `company, omie_codigo_cliente, nome_cliente, omie_codigo_lancamento, numero_documento, data_emissao, data_vencimento, valor_documento, saldo, situacao, prazo_concedido_dias (venc−emissão), prazo_real_dias (= b.prazo_ponderado_dias — média dos movimentos ponderada, cobre pagamento parcial; NÃO data_baixa_final aplicada ao principal), atraso_dias (prazo_real − prazo_concedido; negativo = antecipou; NULL se vencida_aberta), dias_vencido (hoje_sp − venc, só vencida_aberta)`.

Parcela de status ambíguo (`ABERTO`/`VENCIDO` de fallback, `PARCIAL` sem baixa) fica **fora** das duas populações e conta em `n_status_ambiguo` no resumo (status ambíguo nunca entra em número — `financeiro.md`).

### 3.2 `v_ciclo_cliente_resumo` (por company × cliente)

Pagas (12m por vencimento): `n_parcelas, n_documentos (distinct numero_documento — observações independentes), valor_pago, prazo_concedido_pond, prazo_real_pond, atraso_pond` (ponderados por `valor_documento`), `atraso_p50, atraso_p80` (por **quantidade**), `atraso_p80_valor` (ponderado por R$ — percentil acumulado por valor), `atraso_max_observado`, `excesso_carencia_pond = Σ v·max(0, atraso−3) / Σ v`, `pct_valor_atrasado` (valor com atraso>0 / valor_pago), `ultima_baixa`.
Vencidas abertas: `n_vencidas, saldo_vencido, saldo_vencido_90, dias_vencido_max`.
Volume: `volume_emitido_12m` = Σ `valor_documento` de parcelas não-canceladas **emitidas** em `[hoje_sp−365, hoje_sp)` (competência por emissão — não recebimento), `primeira_emissao`.
Outros: `n_status_ambiguo`.

Inclui cliente **só com vencidas abertas** (sem nenhuma paga) — ele precisa aparecer na fila de cobrança. ~1.000+ linhas ⇒ leitura via `lerTodasAsPaginas` (`.range` + `.order('company').order('omie_codigo_cliente')`), nunca single-shot (cap 1.000 PostgREST).

### 3.3 `v_ciclo_empresa_coorte` (company × mês de vencimento, 12m)

`mes_vencimento, valor_vencido_no_mes, valor_pago, valor_em_aberto (censurado), pct_valor_pago, prazo_concedido_pond, prazo_real_pond_pagas, atraso_pond_pagas, mes_parcial`. A tendência mostra **pagas e censuradas lado a lado**: coorte recente tem menos títulos pagos e parece melhor do que é — a UI mostra `pct_valor_pago` em cada ponto.

### 3.4 Moldura do cockpit (reuso)

- PMR/PMP/PME/CCC/NCG por empresa: do `fin-cashflow-engine` com `prazoComGate` e `confianca_dados.motivos`. **Reusar, não recalcular.** Ausente → "—" + motivo.
- **R$/dia:** PMR → receita competência TTM / 365 (`fin_dre_competencia_base`, `origem='CR'`); PME → CMV diário do engine. **PMP sem R$/dia na v1** (exige compras, não CMV — frente 4).
- O PMR do engine e o `prazo_real_pond` da 3.3 são medições diferentes; divergência > 3d → selo "fontes divergem", com as duas lidas.

## 4. Confiança e perfil (helper puro)

### 4.1 Confiança do cliente (sobre documentos, recência)

| Confiança | Regra |
|---|---|
| `media` | `n_documentos ≥ 6` **e** `ultima_baixa ≥ hoje_sp − 90` |
| `baixa` | resto → **sem alavanca de prazo/desconto** (cobrança da vencida aberta continua) |

Não há `alta` na v1: quantidade de dados não dá confiança no **efeito** da alavanca (Codex P1-7). Um nível de dado, não de efeito.

### 4.2 Perfil — duas leituras, ambas precisam concordar

`perfil_qtd` sobre `atraso_p80` e `perfil_valor` sobre `atraso_p80_valor`, mesmas faixas:

| Perfil | p80 |
|---|---|
| `folga` | ≤ −3 |
| `pontual` | (−3, 0] |
| `atraso_leve` | (0, 7] |
| `atraso_cronico` | > 7 |

**Divergência entre `perfil_qtd` e `perfil_valor` → perfil `misto`, sem alavanca automática** (a tela mostra as duas leituras). Constantes exportadas (3d = carência de cobrança vigente; 7d = 1 semana).

## 5. Alavanca e cenários

Precedência fixa: **(0) carteira vencida aberta** sempre primeiro; depois por perfil. A ordem cobrança > desconto > prazo é **hipótese operacional** (os dados sustentam investigar cobrança primeiro; não provam que desconto supera prazo) — rotulada assim.

### 5.0 Vencida em aberto (qualquer perfil, qualquer confiança)
`saldo_vencido > 0` → "recuperar R$ X vencidos (Y > 90d)". É **estoque** a recuperar, **nunca** somado ao cenário recorrente (5.1) nem chamado de lucro.

### 5.1 `atraso_leve` / `atraso_cronico` → cobrar o atraso recorrente
- **Cenário "reduzir ao alvo de 3d":** `R$ = excesso_carencia_pond × volume_emitido_12m / 365`. Usa `média(max(0, atraso−3))` ponderada — antecipações **não** cancelam atrasos (≠ `max(0, média−3)`). Rótulo: "capital empatado recorrente se o atraso cair à carência — cenário, não previsão".
- Texto: crônico → "régua ativa + revisar limite"; leve → "lembrete D−2/D+1".

### 5.2 `atraso_leve` (secundária) → desconto por pontualidade
- **Teto de indiferença** (Codex P0-2): `P·(1−d)·(1+c)^(N/30) = P` ⇒ **`d_max = 1 − (1+c)^(−N/30)`**, `c` = custo mensal efetivo do dinheiro, `N` = dias de antecipação **incremental** (cenário escolhido pelo master: 10/20/30 — NÃO derivado do atraso histórico). Ex.: c=2%, N=30 → 1,9608%.
- Exibido como tabela "N dias → desconto máximo", **sem R$ de benefício por cliente**: o desconto também é pago por quem já pagaria pontual e sem piloto não há adesão medida. Antes de custos operacionais e mudança de risco (rotulado).
- `c` ausente → "informe o custo do seu dinheiro", **nenhum número**. `c` inválido (≤0, NaN, ±∞) ou `N ≤ 0` → fail-closed com mensagem de inválido, **nunca vira 0/default**. `c` é input efêmero (`useUrlState`, por empresa), não persistido na v1.

### 5.3 `pontual` / `folga` → encurtar prazo um degrau (hipótese)
- Degraus usuais (sem evidência de mercado — rótulo honesto): `[90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7]`; **sem 7→0** (à vista exige negociação, não degrau).
- `pontual` (paga no vencimento): **cenário "se continuar pagando no vencimento"** — `R$ = (prazo_atual − degrau) × volume_emitido_12m/365`. Rotulado cenário assumido.
- `folga` (paga antes): **sem R$** — se ele paga em 25 com vencimento 30, mudar para 28 pode liberar zero (Codex P0-3). Mostra só "candidato a degrau; benefício depende de piloto".
- Proposta sempre referida ao **calendário de parcelas** concreto (ex.: "30/60/90 → 28/56/84"), nunca à média (três parcelas 30/60/90 têm média 60 ≠ condição "60").

### 5.4 Ranking
Fila por empresa: (1) `saldo_vencido` desc; (2) cenário 5.1 desc; (3) candidatos de degrau. **Cenários de prazo e de cobrança nunca são somados nem misturados como igualmente realizáveis.** Totais só por empresa (caixa por-CNPJ); consolidado = "visão", rotulado.

## 6. UI (aba "Ciclo" em `FinanceiroCapitalGiro.tsx`, master-only via `useAuth().isMaster`)

1. **Faixa por empresa** (3 cards + consolidado-visão): PME · PMR · PMP · Ciclo (engine), "1 dia de PMR = R$ X", barra concedido|atraso (3.3), cobertura por valor, selo de fonte/confiança.
2. **Tendência por coorte de vencimento** (12m): concedido vs real das pagas + `% do valor já pago` — skill `dataviz` na implementação.
3. **Fila de clientes** (por empresa): cliente · vencido aberto · docs · concedido · real · atraso p80 (qtd | R$) · % valor atrasado · perfil · alavanca · cenário R$ · confiança. Filtros `useUrlState`.
4. **Drill do cliente** (sheet): parcelas pagas 12m + vencidas abertas (query filtrada por cliente), histograma de atraso, cenário com a conta aberta.
5. **Painel de desconto** (por empresa): input `c` + tabela N → d_max.
6. Caveat fixo: "Direcional. Prazo concedido = vencimento − emissão de cada parcela (vencimento vigente; renegociação apaga o original). Todo R$ é cenário, não previsão — não há piloto medido."
7. `<PageSkeleton>`, `<EmptyState tone="operational">`, `text-status-*`. Sensor: `track('financeiro.ciclo_aberto')`, `track('financeiro.ciclo_cliente_drill')`, `track('financeiro.ciclo_desconto_simulado')`.

colacor_sc: rotulada "serviços — poucos documentos por cliente; leitura majoritariamente de baixa confiança".

## 7. Erros e degradação

- Leitura com `error` → estado de erro explícito (nunca lista vazia). Sucesso vazio → EmptyState.
- `volume_emitido_12m` null/0 → cenário null ("sem volume na janela"), não R$ 0.
- Engine indisponível → cards "—" + motivo; fila de clientes segue (fonte independente).
- Predicados numéricos money-path fecham os três lados (`IS NOT NULL`, `<> 'NaN'`, `< 'Infinity'`).

## 8. Testes

- **SQL (PG17, `db/test-ciclo-cliente.sh`, skill prove-sql-money-path):** fixtures — paga antecipada, paga atrasada, paga parcial (2 movimentos), cancelada, emissão>venc, valor 0/NaN/∞, vencida aberta 10d e 120d, status ambíguo, cliente só-vencido, coorte com metade censurada. Assertar populações, `atraso` via `prazo_ponderado_dias`, `excesso_carencia_pond` (antecipação não cancela atraso), `atraso_p80_valor`, `n_documentos`. **Falsificar** uma camada por vez (filtro de cancelado; sinal do atraso; `max(0,·)` do excesso; exclusão do ambíguo) com controle verde na mesma invocação; `LC_ALL=C` e `pt_BR.UTF-8`; commitar antes de falsificar.
- **Helper (vitest):** fronteiras de perfil (−3, 0, 7) nas duas leituras e o `misto`; confiança (5/6 docs; recência 90/91d); degraus (30→28; 31→30; 7→sem sugestão); `d_max` (c=2%,N=30 → 0,019608; c ausente/0/NaN/∞/N≤0 → fail-closed com a **marca do ramo**, não "lançou algo"); folga → cenário null; volume null → cenário null; vencida aberta nunca somada ao recorrente.
- **Componente:** aba oculta para não-master; erro de leitura ≠ empty state.
- Manifesto: arquivos novos em `src/lib/modulos/manifesto.ts`.

## 9. Deploy (definição de pronto)

| Camada | Quem |
|---|---|
| Migration (3 views) | Envelope da sessão se pré-voo 🟢 (idempotente + transacional + postcondição), senão founder no SQL Editor — custom não auto-aplica |
| Publish Lovable | Founder |
| Edge | nenhuma |
| Verificação | Sessão: `psql-ro` confere views e que os agregados batem com §2; abrir a aba |

## 10. Limitações aceitas na v1

- Vencimento vigente (renegociação mascara atraso original) — não há fonte do original.
- Sem experimento: nenhum R$ é previsão. Fase N+1 (piloto de desconto/degrau com grupo controle) exige sinal de uso desta (sensor §6).
- PMP por fornecedor e R$/dia de PMP → frente 4. Giro por SKU → frente 3.

## 11. Challenge Codex — o que mudou (2026-10-14)

| Achado | Sev. | Adoção |
|---|---|---|
| Amostra só de pagos exclui quem mais precisa de cobrança; janela por baixa distorce tendência | P0 | Vencidas abertas como 2ª população + coorte por **vencimento** com censura (§3.1, 3.3, 5.0) |
| Fórmula `(1+c)^(N/30)−1` errada | P0 | `d_max = 1−(1+c)^(−N/30)`; N = cenário incremental, sem R$ por cliente (§5.2) |
| Encurtar prazo formal ≠ antecipar caixa | P0 | Folga sem R$; pontual = cenário assumido rotulado (§5.3) |
| Excesso sobre carência: média de max, não max da média; estoque ≠ recorrente | P1 | `excesso_carencia_pond` + separação (§5.0/5.1) |
| `n_meses×30` anualiza pico; recebimento ≠ faturamento | P1 | `volume_emitido_12m` por emissão (§3.2) |
| Parcelas não são independentes; média ≠ condição | P1 | `n_documentos` na confiança; proposta por calendário de parcelas (§4.1, 5.3) |
| p80 por qtd vs por R$; "alta confiança" injustificada | P1 | Duas leituras + `misto`; sem nível `alta` (§4) |
| Hierarquia é hipótese | P1 | Rotulada; cenários nunca somados (§5, 5.4) |
| Baixa final aplicada ao principal; "pior caso"; PMP≠CMV; degraus "de mercado"; 7→0 | P2 | `prazo_ponderado_dias`; "máximo observado"; PMP sem R$/dia; "degraus usuais"; sem 7→0 |
