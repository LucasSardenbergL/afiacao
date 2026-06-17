# Skill `reposicao-caixa` — decisão de compra com impacto no caixa (Oben)

> Skill **proprietária project-scoped** (`.claude/skills/reposicao-caixa/`) que ajuda o dono da **Oben** (distribuidora que compra e revende) a decidir compras de reposição **conectando reposição ↔ caixa/NCG** — o vão que o app trata em módulos separados. Saída = um **MEMORANDO de decisão** (comprar/segurar/parcelar/negociar prazo/reduzir lote/antecipar/promoção/priorizar). Read-only. Construída com `skill-creator`, 2ª opinião do Codex no modelo financeiro, validada contra produção. Regra viva fica na própria skill; aqui é a narrativa.

## Visão geral

Entregue em 2 PRs ([#904](https://github.com/LucasSardenbergL/afiacao/pull/904) v1 + [#906](https://github.com/LucasSardenbergL/afiacao/pull/906) correções do teste real). A lógica de reposição (ponto de pedido/EOQ/ABC-XYZ, Silver-Pyke-Peterson) **já existe no Postgres**; a skill **não recalcula** — lê esses números, soma a camada de caixa que ninguém soma, e devolve o memo. A maior alavanca operacional do dono (junto com finanças) e o módulo com mais dívida técnica.

## Por que skill-shaped

Decisão repetida, cara, cheia de trade-offs (custo de capital, lead time, ruptura, promoção, impacto no caixa). Prompt avulso não lembra as regras toda vez; a skill garante que as travas disparem **sempre**. Validação com `skill-creator` (3 casos: veto de caixa, antecipar aumento, promo marginal): **com-skill 100% vs baseline 68%** nos assertions de disciplina (premissas explícitas, nível de confiança, "o que me faria mudar de opinião").

## Núcleo econômico (decisões do founder + 2ª opinião do Codex)

- **Custo de capital = custo MARGINAL do caixa**, contextual (não taxa fixa): **CDI ~1%/mês** se o caixa fica acima do piso de runway · **antecipação de recebíveis ~2,2%/mês** (default) se a compra força antecipar · **conta garantida ~4,5%/mês** se entra/estica crédito bancário. A faixa é escolhida lendo a projeção de 13 semanas.
- **Gate de caixa é o VETO #1** (a Oben paga fornecedor **à vista** — confirmado pelo founder): compra economicamente atraente que cria uma semana de caixa fraca é **rejeitada ou redimensionada**, nunca aprovada. "Caixa veta ROI."
- **Caso B (antecipar aumento)**: separa **timing puro** (o lote normal já cairia antes da vigência → antecipar é ~de graça) de **estoque extra real** (break-even em custo líquido pós-desconto à vista; `N_max = 2·(30·ln(1+ganho)/ln(1+r) − C)`). Melhor data = a mais tarde possível antes da vigência.
- **Caso C (promoção)**: valor esperado com obsolescência/FEFO; tetos por cobertura/classe ABC.
- **Hardening do ship-review do Codex** (nenhum P1, "ship now"): piso de runway vira **pergunta ativa** (não default silencioso de R$ 0); checagem de **portfólio/compras-pendentes** vira passo sempre-presente (o memo é **stateless** — não conhece compras de outras sessões).

## ⚠️ Lições do teste real contra produção (que o eval sintético não pega)

Rodei as queries da skill direto no Postgres de produção (read-only via `claude_ro`, CLAUDE.md §1). Dois achados money-path:

- **`custo_capital_efetivo_perc` (Query 1/3/5) está em % AO ANO**, não ao mês (real de prod: THINNER = `25,75` = 25,75% a.a. ≈ 1,93%/mês). As faixas da skill (1/2,2/4,5) são **% ao mês** → **misturar = erro de 12×** no custo de carregar. Travado: nota de unidade na fórmula central + converter `r_mês ≈ (1+r_ano)^(1/12)−1`.
- **RPC `fin_projecao_13_semanas` é gated a staff autenticado**: `claude_ro` recebe `permission denied for function`. Confirma o design "founder cola do Lovable" para a folga de caixa — o assistente **não** roda a RPC por fora (as demais queries são SELECTs em tabelas/views legíveis). Documentado em `SKILL.md` + Query 2.
- **Schema confirmado contra produção** (2026-06-17): Query 1/3/5/6 + assinatura da RPC batem; `sku_codigo_omie` é **bigint** em `sku_parametros` e **text** em `sku_estoque_atual`/`eventos_outlier` (cast `::text` nos joins); empresa é `'OBEN'` na reposição vs `'oben'` no financeiro.

## Demonstração end-to-end (memorando real)

Promo real de **20% no THINNER DR.4403LT** (SKU 8689717792): a skill recomendou **SEGURAR** — estoque 66 un ≈ 61 dias vs **máximo 29** (sobrestocado 2,3×); classe AZ irregular (CV 1,12) + outlier crítico pendente → **confiança baixa**. O sistema sinalizava R$ 244 de economia; a skill olhou o estoque e disse "você não precisa disso". É o valor que ela agrega sobre o número cru.

## Onde está

- Skill: `.claude/skills/reposicao-caixa/` (`SKILL.md` + `references/sql-queries.md` 8 queries + `references/modelo-financeiro.md`).
- Pendência conhecida (não-bug, evolução v2): o memo é **stateless** — não rastreia "caixa já comprometido" por outras decisões. Mitigado pela checagem de portfólio (Query 3); o ideal futuro seria persistir um orçamento de caixa comprometido.
- Premissas que o founder ainda pode cravar: piso de runway (hoje a skill pergunta) e o custo marginal do caixa do dia a dia (default 2,2%/mês).
