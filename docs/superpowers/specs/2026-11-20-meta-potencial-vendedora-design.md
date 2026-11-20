# Meta mensal por potencial da vendedora — design

> Leva 2 do Meu dia do CEO (2026-11-20). Metodologia **"base + alavancas"** escolhida pelo founder,
> revisada por Codex (challenge) e builder-check, e **calibrada por backtest** (12 cortes mensais por conta,
> nov/2025–out/2026, psql-ro). Medições: nota `meta-potencial-medicoes-2026-11-20.md` da sessão.

## Intenção

O card "Receita time · mês" (`TeamKpiTiles`) não tem alvo. As metas do DES foram abandonadas em abril e o
founder recusou meta fixa de grupo: quer meta **derivada de onde a vendedora pode vender mais**, que diga ao
CEO **quanto** vem do ritmo atual e **quanto** depende de ação dela, e de onde.

## Objetivos / não-objetivos / anti-objetivos

- **Objetivo:** meta do mês + ritmo necessário por dia útil no placar = **previsão espontânea calibrada +
  incremento por alavanca**, com a base declarada (empresa + pedido válido por `order_date_kpi`) e a
  atribuição pelo **dono da carteira**.
- **Não-objetivo (v1):** capacidade de ligação (Nvoip) — `call_log` = 20 linhas de teste (mai–jun/2026),
  `farmer_calls` = 0, histórico só na API da Nvoip. Fase própria, com sensor. Up-sell de ticket (sem sinal
  separável da frequência). Comissão. Meta editável à mão.
- **Anti-objetivo:** cobrar como "alavanca" o que já acontece sozinho (dupla contagem); meta que muda no mês;
  número fabricado quando falta fonte.

## O que o backtest mostrou (e por que o desenho mudou)

| Medida (média dos 12 cortes) | Oben | Colacor |
|---|---|---|
| Base A+B (run-rate 6m dos ativos ≤60d) prevê o realizado A+B | ~±10% fora dez/jan | ruidoso (±40%) |
| Clientes C (61–180d) que voltam **sozinhos** no mês | ~19% · R$ ≈ 20% do ticket deles | ~17% |
| Clientes D (181–365d) que voltam sozinhos | ~7% · R$ ≈ 5% | ~8% |
| Estreias de família em cliente existente | ~65/mês · R$ 25k · mediana R$ 200 | ~30/mês · R$ 12k |
| Clientes novos (sem compra anterior) | ~R$ 8k/mês | ~R$ 3k/mês |
| Dezembro (realizado A+B ÷ base), dez/2025 | 0,72 | 0,46 (grupo: 0,68) |

Consequência: as taxas da v0 (20% C, 10% D) eram **o retorno espontâneo**, não incremento — já estariam na
previsão. A v1 separa os dois.

## Abordagens consideradas

1. **Previsão calibrada + incremento por alavanca (escolhida — é "base + alavancas" sem dupla contagem).**
2. Base × (1 + X%) — não diz onde agir.
3. `farmer_client_scores.revenue_potential` — nula nas 17.018 linhas.

## Metodologia (`metodologia_versao = 1`)

Corte = dia 1 do mês M. Universo = `sales_orders` válidos (`deleted_at is null`, status ∉ {cancelado,
rascunho, pendente, orcamento} — o mesmo do placar), por `account`, por `order_date_kpi`. Pedido sem
`customer_user_id`: 0 linhas em mai–out/2026; se aparecer, entra no realizado e na base como "sem cliente".

**Segmentos exclusivos, recência primeiro** (dias desde a última compra antes do corte):
`>365` fora · `181–365` **D** · `61–180` **C** · `≤60` e comprou em ≥4 dos 6 meses **A** · `≤60` demais **B**.

**Previsão espontânea** (por conta):
- Base = Σ receita 6m ÷ 6 dos clientes **A e B** (C/D não entram na base).
- Retorno espontâneo C = taxa_C × Σ ticket-mês-ativo-12m dos C; idem D. taxa = Σ realizado ÷ Σ ticket do
  segmento nos **12 cortes anteriores** daquela conta (pooled).
- Novos = média mensal dos 12 meses anteriores (receita de cliente sem compra antes do mês).
- **Índice sazonal do GRUPO** = realizado A+B ÷ base A+B no corte do mesmo mês do ano anterior (somando
  contas — a Colacor sozinha é ruidosa demais: 0,37 num setembro). Aplicado à base e às alavancas. Sem o
  corte do ano anterior → índice `null` → **meta indisponível** (mostra a previsão sem ajuste só como
  "cenário", sem %, sem ritmo). Grupo com conta sem meta → meta/%/ritmo do grupo indisponíveis.

**Incremento por alavanca** (o que a vendedora faz a mais; premissas declaradas e versionadas, mostradas
em clientes, não só em R$):
- Recuperar C: **+10 p.p.** de retorno sobre o espontâneo (Oben ≈ +9 clientes ≈ R$ 6,6k).
- Reativar D: **+5 p.p.** (≈ +5 clientes ≈ R$ 4k).
- Frequência B: **+10% dos B** compram um mês a mais (≈ +14 clientes ≈ R$ 12k no grupo).
- Cross-sell: **+10 estreias de família/mês** por conta além do histórico × mediana da estreia (≈ R$ 2k).

**Meta** = (previsão + incremento) × índice, por conta; grupo = soma das contas com meta.
Referência: nov/2026 ≈ R$ 546k previsão + R$ 32k incremento ≈ **R$ 578k**; dez/2026 ≈ **R$ 400k**.

**Atribuição:** dono da carteira (`carteira_assignments` `eligible = true`, a régua do ranking/positivação/
comissão), **congelado no corte**. Realizado por vendedora = pedidos do mês dos clientes da carteira
congelada dela. Dono sem pedido válido nos 60 dias antes do corte → aparece marcado "sem vendedora ativa"
(caso Tatyana até a reatribuição). Cliente sem carteira elegível → "sem dono".

## Congelamento

- Só o **mês corrente** (o servidor decide por `now()` em America/Sao_Paulo; nada de `p_mes` do cliente).
- Congela no 1º acesso **a partir do dia 3** (sync tardio do Omie); dias 1–2 → calculada e exibida como
  **provisória**, sem gravar. Congelada, nunca recalcula (nova metodologia = nova versão, lida por constante).
- `pg_advisory_xact_lock` por (mês) — cálculo + gravação numa transação; leitura só da versão vigente.

## Ritmo por dia útil

Dia útil = aberto em `calendario_operacao_empresa` da conta (recesso/emenda/feriado já cadastrados; peso
`meia_equipe` conta 1). Ritmo = (meta − realizado) ÷ dias úteis restantes incluindo hoje se útil. Grupo:
dias em que **alguma** conta abre. Meta batida → "meta batida".

## Arquitetura

- **Migration** (aplico no envelope; prova PG17 `db/test-meta-potencial.sh` falsificada com controle):
  - `meta_potencial_mensal` — RLS on, sem policy, ACL fechada ao JWT. Colunas dedicadas (nada de jsonb para
    número): `mes, account, owner_user_id (null=sem dono), versao, base, esp_c, esp_d, novos, inc_c, inc_d,
    inc_b, inc_cross, indice_sazonal, meta, n_a, n_b, n_c, n_d, owner_ativo, calculado_em`.
  - `meta_potencial_visualizacao (dia, user_id, n)` — **sensor de uso** (escritor único = a RPC).
  - `meta_potencial_mes()` — SECURITY DEFINER, `search_path=''`, **gate master antes de ler/escrever**,
    `REVOKE` PUBLIC+anon. Calcula/congela conforme acima, registra visualização, devolve meta + realizado
    vivo por (conta, dono) + dias úteis.
- **Front:** `useMetaPotencial()`; seleção do CompanySwitcher filtra contas. Tile "Receita time · mês":
  "meta R$ X · Y% · R$ Z/dia útil (N dias)". Bloco recolhível: previsão vs incremento, cada alavanca em
  clientes + R$, índice, vendedoras, base declarada. Erro → "meta indisponível" sem esconder a receita.

## Deixado ao builder

Nomes, layout do bloco, formato dos testes (vitest do front + PG17 da RPC), forma exata do SQL de calibração.
