# A (sensor de nível/composição) + B (fusível na graduação) — desenho

Contexto e medição: `docs/historico/fila-de-prontidao-e-sensor-de-derivada.md` (#2022).
Calibragem re-medida em prod **2026-08-26 01:39 UTC**. Evidência tem validade — re-meça antes de aplicar.

## B — fusível de magnitude na graduação do cold-start

**Buraco:** `reposicao_cold_start_parametros`, ramo GRADUAR, escreve `pp/max/min/ss/cobertura` direto no
`UPDATE`, sem passar pelo CASE de `atualizar_parametros_numericos_skus` ⇒ **sem o fusível
`max_sug > param_auto_fusivel_mult * max_antes`**. Caminho vivo (8 graduações, última 2026-08-25).

**Não é o teto de cobertura.** `reposicao_teto_cobertura_oben_*` (ativa, b=90/c=60) é aplicado no MOTOR
(`gerar_pedidos_sugeridos_ciclo`), com rastro em `reposicao_teto_cobertura_log`: **733 linhas capadas entre
29/07 e 26/08** — está vivo e funciona. A cobertura de 286d de um graduado NÃO vira compra de 286 dias.
⇒ O fusível de magnitude segue necessário porque é proteção **independente**: compara com o valor ANTERIOR,
não com a demanda. Se a demanda estiver errada, o teto de cobertura usa a mesma demanda errada e não protege.

**Regra:** ao graduar, se `estoque_maximo_sugerido > v_mult * estoque_maximo_atual` (ou se não houver âncora
`> 0`), **não gradua**; registra `acao='segurado'` e o SKU permanece cold-start, visível pelo sensor A.

**Calibragem (por dado, não por chute):** os 8 graduados saltaram de `max=2` para 3..5 ⇒ **1,5×–2,5×**.
Com `v_mult=3`, **0 das 8 graduações históricas seria bloqueada** — zero falso positivo observado.

**DDL necessário:** `reposicao_cold_start_log_acao_check` hoje é `IN ('criado','graduado')` ⇒ estender com
`'segurado'`.

**Por que segurar não recria o limbo:** o barrado vira linha de log com motivo e aparece na composição do
sensor A. A lição do #2022 é justamente não criar vão silencioso — B só é seguro **acompanhado de A**.

## A — sensor de nível + composição + idade

**Buraco:** `reposicao_param_limbo_watchdog` só alerta em salto `+30/dia` e o `ELSE` faz
`dismissed_at = now()` ⇒ verde com a fila congelada (146→119, **parada desde 2026-08-05**).
Ele NÃO é substituído — continua servindo ao propósito original (detectar regressão do cron).

**Composição (os estágios que o sensor precisa distinguir), medida em 2026-08-26:**

| estágio | n | regra |
|---|---|---|
| `FORA_JANELA_DEMANDA` | 71 | sem linha em `v_sku_parametros_sugeridos` (janela de venda 90d) |
| `AGUARDANDO_SEGUNDA_ORDEM` | 81 | `status_sugestao` da view |
| `SEM_LEADTIME_DEFINIDO` | 54 | idem |
| demais status da cascata | 0 | idem (`SEM_FORNECEDOR`, `AGUARDANDO_HABILITACAO`, `SEM_PRECO`, `OK`) |

**Artefatos:**
1. `v_reposicao_param_fila` — 1 linha por SKU travado, com `estagio`, `habilitado`, `tipo_reposicao`,
   `parametro_cold_start`, `dias_no_limbo`.
2. `reposicao_param_fila_log` — snapshot diário por (empresa, medido_em, estagio) com contagem.
   Único em `(empresa, medido_em, estagio)`, seguindo o padrão de `uq_reposicao_param_limbo_log_dia`.
3. `reposicao_param_fila_sensor()` — popula o log e alerta **ESTAGNAÇÃO**: nível sem queda há N dias
   (N=14, configurável em `company_config`). Fail-closed: sem série suficiente, NÃO alerta e NÃO dismissa.
4. Cron diário.

**Denominador correto** (lição do Codex): o sensor reporta separando `habilitado_reposicao_automatica`
— o número que importa é o de habilitados (119), não o de ativos (206).

## Invariantes a provar em PG17 (com falsificação)

- B1: salto `> v_mult ×` ⇒ NÃO grava parâmetro e registra `'segurado'`.
- B2: salto `<= v_mult ×` ⇒ grava normalmente (não regride o caminho feliz — os 8 históricos passam).
- B3: âncora ausente (`max_antes` NULL/`<=0`) ⇒ segura (não grava sem poder avaliar magnitude).
- A1: cada SKU travado cai em exatamente UM estágio (sem dupla contagem, sem SKU órfão).
- A2: estagnação dispara só com série suficiente; série curta ⇒ silêncio, nunca alerta nem dismiss.
