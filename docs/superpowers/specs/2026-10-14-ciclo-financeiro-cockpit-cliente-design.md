# Ciclo financeiro — cockpit + comportamento de pagamento por cliente (frente 1+2)

> Status: rascunho para revisão do founder + challenge Codex (money-path). Data: 2026-10-14.
> Escopo desta spec: frentes 1 (cockpit do ciclo) e 2 (cliente). Frentes 3 (giro por SKU) e 4 (PMP por fornecedor) ficam para specs próprias.

## 1. Objetivo

Dar ao founder (master) uma aba **"Ciclo"** em `/financeiro/capital-giro` que responda, para as 3 empresas (colacor, oben, colacor_sc):

1. **Onde está o ciclo** — PME + PMR − PMP por empresa, quanto vale 1 dia de cada prazo em R$, e quanto do PMR é **prazo contratado** vs **atraso**.
2. **Quem paga como** — por cliente: prazo contratado, prazo real, atraso típico e pior-caso, perfil de pagamento.
3. **O que fazer com cada cliente** — UMA alavanca sugerida (cobrar atraso · desconto por pontualidade · encurtar prazo) com o **R$ de caixa liberado** estimado e o grau de confiança.

**Não-objetivos:** não altera condição de pagamento no Omie, não envia cobrança, não decide crédito (o gate `venda_gate_credito` segue intocado). Recomenda; o dono decide (regra-mãe de `docs/agent/financeiro.md`).

## 2. Evidência que moldou o desenho (medida em prod 2026-10-13/14, psql-ro)

- Baixa real derivada (`v_titulo_baixas`) cobre ~90% dos títulos CR vencidos nos últimos 12m (colacor 1493/1623, colacor_sc 435/527, oben 4582/5106).
- Prazo contratado × real (12m, ponderação simples): oben 26,2d → 29,6d (atraso médio +3,5d); colacor 22,1 → 24,7 (+2,6); colacor_sc 11,1 → 14,3 (+3,2).
- Densidade por cliente: clientes com ≥6 títulos pagos em 12m cobrem 89% do valor (oben, 184 clientes), 74,5% (colacor, 72), 26% (colacor_sc, 19).
- **Perfil por p80 do atraso** (clientes ≥6 títulos): quase ninguém paga ANTES do vencimento (oben: 2 clientes / R$9k com folga ≥3d; colacor: 0). O dinheiro está no atraso (oben: 138 de 184 clientes atrasam no p80, R$2,56M de R$3,4M).
- ⇒ A ideia inicial "cortar prazo até a folga do cliente" rende ~zero. A alavanca dominante é **fechar o gap contratado→real** (cobrança), depois **desconto por pontualidade**, e só para pontuais o **degrau de prazo**.
- Custo do dinheiro: `fin_funding_inputs` = `{}` nas 3 empresas e `fin_dividas` vazia ⇒ **não há CET no banco**. O desconto não pode inventar taxa (§5.3).
- Condição de pagamento contratada **não é persistida** por cliente (catálogo `omie_condicao_pagamento_catalogo` com `dias_parcelas` vazio; `codigo_parcela` só no pedido, não gravado). ⇒ "prazo contratado" = **vencimento − emissão do próprio título** (prazo de fato concedido, por parcela).

## 3. Arquitetura (abordagem A — view de fatos + helper TS puro, sem edge)

Padrão do Otimizador de Compras: SQL só junta fatos; regra em helper TS puro testado (vitest); UI lê via react-query. Sem edge nova ⇒ deploy = migration + Publish.

```
fin_contas_receber ─┐
                    ├─ v_ciclo_cliente_titulos (por título, 12m de baixa) ─┬─ v_ciclo_cliente_resumo (por company×cliente)
v_titulo_baixas ────┘                                                    └─ v_ciclo_empresa_mensal (por company×mês)
                                                                                  │
        src/lib/financeiro/ciclo-cliente-helpers.ts (perfil, alavanca, R$ liberado)  ◄┘
                                                                                  │
        src/components/financeiro/cashflow/ciclo/*  (aba "Ciclo", master-only)    ◄┘
        + PME/PMP/NCG atuais do fin-cashflow-engine (useCashflowProjection — já existe)
```

### 3.1 `v_ciclo_cliente_titulos` (por título)

Fonte: `fin_contas_receber r` ⋈ `v_titulo_baixas b` em `(company, omie_codigo_lancamento)` com `b.tipo='CR'`. Filtros: `r.status_titulo <> 'CANCELADO'`, `b.data_baixa_final >= current_date - 365`, `r.valor_documento > 0` e finito, `r.data_emissao`/`r.data_vencimento` NOT NULL, `data_vencimento >= data_emissao`.

Colunas: `company, omie_codigo_cliente, nome_cliente, omie_codigo_lancamento, numero_documento, data_emissao, data_vencimento, data_baixa, valor_documento, prazo_contratado_dias (venc−emissão), prazo_real_dias (baixa−emissão), atraso_dias (baixa−venc; negativo = antecipou)`.

- `WITH (security_invoker=on)` — RLS das tabelas-base (acesso financeiro) vale. Gate master é de UI (o dado já é legível por quem tem acesso financeiro hoje via `fin_contas_receber`).
- Data de corte em SP (`(now() AT TIME ZONE 'America/Sao_Paulo')::date`), não `current_date` do servidor UTC.
- **Ressalva conhecida:** `v_titulo_baixas.data_baixa_final` vem da ótica CONTA_A_RECEBER; a CC é +1 dia útil e não é usada (`financeiro.md` §encargos — atraso pela data do TÍTULO).

### 3.2 `v_ciclo_cliente_resumo` (por company × cliente)

Agrega 3.1: `n_titulos, valor_total, prazo_contratado_pond, prazo_real_pond, atraso_pond` (ponderados por `valor_documento`), `atraso_p50, atraso_p80, atraso_max, pct_titulos_atrasados (atraso > 0), pct_atraso_acima_3d`, `primeira_baixa, ultima_baixa`, `n_meses_ativos`.

- Volume esperado: ~1.000 linhas no total ⇒ **PostgREST capa em 1.000** — leitura com `lerTodasAsPaginas` (`.range` + `.order('company').order('omie_codigo_cliente')`), nunca single-shot.
- Percentis por `percentile_cont` sobre o atraso NÃO ponderado (comportamento por título, não por R$) — explícito na UI.

### 3.3 `v_ciclo_empresa_mensal` (por company × mês da baixa, 12m)

`mes, n_titulos, valor, prazo_contratado_pond, prazo_real_pond, atraso_pond` — série para a tendência e a decomposição contratado/atraso. Mês incompleto corrente marcado (`mes_parcial`).

### 3.4 Moldura do cockpit (reuso, nada novo no servidor)

- PMR, PMP, PME, CCC e NCG atuais por empresa: já vêm do `fin-cashflow-engine` (`useCashflowProjection`), com o gate de cobertura (`prazoComGate`) e `confianca_dados.motivos`. **Reusar, não recalcular.** Ausente → "—" com motivo.
- **R$ por dia:** `receita_diaria = receita competência TTM / 365` (`fin_dre_competencia_base`, origem `CR`) para PMR; `cmv_diario` do mesmo engine para PMP/PME. Ausente → null, sem número.
- ⚠️ O PMR do engine (`v_capital_giro_prazos`, desde emissão, ponderado pelo valor baixado — dobrado mas usado como peso) e o `prazo_real_pond` da 3.3 são medições **diferentes**; a UI mostra a decomposição só a partir da 3.3 e rotula a fonte. Divergência > 3d entre os dois → selo "fontes divergem" (não esconder).

## 4. Perfil e confiança (helper puro `ciclo-cliente-helpers.ts`)

### 4.1 Confiança do cliente

| Confiança | Regra |
|---|---|
| `alta` | `n_titulos ≥ 12` e `n_meses_ativos ≥ 4` |
| `media` | `n_titulos ≥ 6` |
| `baixa` | `n_titulos < 6` → **sem sugestão** (só fatos) |

### 4.2 Perfil (sobre `atraso_p80`)

| Perfil | Regra |
|---|---|
| `folga` | `p80 ≤ −3` (paga ≥3d antes do vencimento em 80% das vezes) |
| `pontual` | `−3 < p80 ≤ 0` |
| `atraso_leve` | `0 < p80 ≤ 7` |
| `atraso_cronico` | `p80 > 7` |

Thresholds são constantes exportadas (3d = carência de cobrança atual; 7d = 1 semana). Não são parâmetros de UI na v1.

## 5. Alavanca sugerida (UMA por cliente, por perfil)

### 5.1 `atraso_cronico` e `atraso_leve` → **cobrar o atraso** (alavanca 3)
- Caixa liberado estimado = `max(0, atraso_pond) × faturamento_diario_cliente`, onde `faturamento_diario_cliente = valor_total / 365` (janela 12m).
- Texto: crônico → "régua de cobrança ativa + revisar limite de crédito"; leve → "lembrete D−2 e D+1".
- **Não** sugere prazo menor (encurtar prazo de quem já atrasa só desloca a data no papel).

### 5.2 `atraso_leve` (secundária) → **desconto por pontualidade** (alavanca 2), só com custo informado
- Desconto máximo que se paga: `d_max = (1 + c)^(dias_ganhos/30) − 1`, com `c` = custo do dinheiro mensal informado pelo master e `dias_ganhos = atraso_pond` (+ antecipação pedida, se houver). Exibe "até X,X% de desconto compensa".
- `c` ausente → bloco mostra "informe o custo do seu dinheiro" e **nenhum número**. `c` inválido (≤0, NaN, ∞) → fail-closed (mesmo tratamento de ausente, com mensagem de inválido — nunca vira 0).
- `c` é input efêmero da aba (`useUrlState`, por empresa), **não persistido** na v1 (evita jsonb multi-writer em `fin_funding_inputs`).

### 5.3 `pontual` e `folga` → **encurtar prazo um degrau** (alavanca 1)
- Degraus de mercado: `[90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7, 0]`. Sugerido = próximo degrau abaixo de `prazo_contratado_pond` arredondado.
- `folga`: pode descer até `prazo_contratado − |atraso_p80|` (o próprio comportamento prova a folga), limitado a 2 degraus.
- `pontual`: só 1 degrau, rotulado **"hipótese — sem experimento que meça a reação"**.
- Caixa liberado = `(prazo_atual − prazo_sugerido) × faturamento_diario_cliente`.

### 5.4 Ranking
Lista ordenada por `caixa_liberado` desc dentro da empresa; filtros por empresa/perfil/confiança via `useUrlState`. **Nunca soma caixa liberado entre empresas** como se fosse fungível (caixa por-CNPJ) — o total aparece por empresa; consolidado só como "visão", rotulado.

## 6. UI (aba "Ciclo" em `FinanceiroCapitalGiro.tsx`, master-only)

1. **Faixa por empresa** (3 cards + consolidado-visão): PME · PMR · PMP · Ciclo (do engine), "1 dia de PMR = R$ X", barra contratado|atraso do PMR (3.3), selo de confiança/fonte.
2. **Tendência 12m** (linha por empresa: prazo contratado vs real) — skill `dataviz` na implementação.
3. **Tabela de clientes** (por empresa): cliente · títulos · prazo contratado · prazo real · atraso p50/p80 · perfil · alavanca · R$ liberado · confiança. Linha de baixa confiança: só fatos, sem alavanca.
4. **Drill do cliente** (sheet): títulos 12m (query filtrada por cliente — pequena), histograma de atraso, sugestão com a conta explicada.
5. Caveat fixo: "Direcional — prazo contratado = vencimento − emissão de cada título; não há condição de pagamento cadastrada. Sugestões de prazo são hipóteses sem experimento."
6. `<PageSkeleton>`, `<EmptyState tone="operational">`, `text-status-*`, `track('financeiro.ciclo_*')`.
7. **Sensor de uso** (fase N+1 exige sinal): `track('financeiro.ciclo_aberto')` + `track('financeiro.ciclo_cliente_drill')`.

colacor_sc: rotulada "serviços — poucos títulos por cliente; leitura majoritariamente de baixa confiança".

## 7. Erros e degradação

- Leitura com `error` → estado de erro explícito na aba (nunca lista vazia). Lista vazia com sucesso → EmptyState "sem títulos pagos em 12m".
- `valor_total = 0`/null → cliente sem R$ liberado (null, não 0).
- Engine indisponível → cards do cockpit "—" com motivo; tabela de clientes segue (fonte independente).

## 8. Testes

- **SQL (PG17, `db/test-ciclo-cliente.sh`, prove-sql-money-path):** fixtures de títulos com antecipação, atraso, cancelado, emissão>venc, valor 0; asserção das colunas derivadas e dos ponderados; **falsificar** (sabotar o filtro de cancelado / o sinal do atraso → exigir vermelho) com controle verde na mesma invocação; rodar em `LC_ALL=C` e `pt_BR.UTF-8`.
- **Helper (vitest):** fronteiras de perfil (p80 = −3, 0, 7), confiança (5/6/11/12 títulos), degraus (prazo 30 → 28; 31 → 30; 7 → 0; 0 → sem sugestão), desconto com `c` ausente/0/NaN/∞ (fail-closed, sem número), caixa liberado null quando faturamento ausente.
- **Componente:** aba oculta para não-master; erro de leitura ≠ empty state.
- Manifesto de módulos: novos arquivos registrados em `src/lib/modulos/manifesto.ts`.

## 9. Deploy (definição de pronto)

| Camada | Quem |
|---|---|
| Migration (3 views) | Founder no SQL Editor (ou envelope da sessão, se pré-voo 🟢) — custom não auto-aplica |
| Publish Lovable | Founder |
| Edge | **nenhuma** |
| Verificação | Sessão: `psql-ro` confirma views + contagens batem com §2; abrir a aba |

## 10. Questões abertas para o challenge Codex

1. `vencimento − emissão` por parcela como "prazo contratado": parcelas 30/60/90 de uma mesma NF viram prazos distintos — isso distorce o perfil? Alternativa: ponderar por valor (já é) vs agrupar por documento.
2. p80 não-ponderado do atraso como definidor de perfil vs ponderado por R$.
3. `faturamento_diario_cliente = valor_baixado_12m / 365` subestima clientes novos (< 12m) — usar `n_meses_ativos × 30`?
4. Caixa liberado da cobrança assume que o atraso vai a zero — estimar só a fração acima da carência (atraso − 3d)?
