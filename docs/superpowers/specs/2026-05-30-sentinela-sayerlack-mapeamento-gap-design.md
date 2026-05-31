# Sentinela — check "motor Sayerlack sem de-para" — Design

**Data:** 2026-05-30
**Status:** especado (follow-up do PR do parser-variante-espaço + fonte-motor). **NÃO implementar antes do backlog do gap cair pra ~0** (senão nasce vermelho permanente).

## Objetivo

Adicionar um check ao Sentinela de Saúde de Dados que vigia o **quadrante perigoso** do mapeamento Sayerlack: **SKU que o motor de reposição PODE comprar e que está SEM de-para ativo no portal**. Hoje esse gap só é descoberto quando o pedido **falha no disparo** (`status_envio_portal = 'erro_nao_retentavel'`) — reativo, e foi assim que o gap de 94 SKUs passou despercebido. O check antecipa: alerta na transição ok→degradado, antes do pedido falhar.

## Contexto

- O PR anterior (parser `sayerlack-sku` v2 + fonte-motor na tela de Mapeamento SKU) fechou ~87 dos 94 SKUs do gap via auto-apply, deixando ~7 manuais. Mas **o gap reabre silenciosamente** sempre que: um SKU Sayerlack novo entra no Omie com reposição automática ligada, ou um produto fracionado é "promovido", etc. Sem um vigia, só o `erro_nao_retentavel` denuncia — tarde.
- A medição do risco na tela (`faltantesMotor`) é **client-side e aproximada**: espelha só os predicados do motor que vivem em `sku_parametros` (reposição ligada, tipo automática, ponto/máximo definidos), **não** os de join externo (`familia_nao_comprada`, `omie_products.ativo`, `sku_status_omie.ativo_no_omie`) nem o `NOT ILIKE 450/405ML` por `omie_products.descricao`. Pro check do Sentinela (que é SQL), a hora é de criar a **view fiel** ao motor — assim o check e (opcionalmente) a tela passam a usar a MESMA fonte fiel.
- Infra do Sentinela ativo (ver `2026-05-27-sentinela-ativo-design.md`): `_data_health_compute()` (fonte única, SECURITY DEFINER, sem gate) → `get_data_health()` (wrapper com redação por papel) + `data_health_watchdog()` (cron `data-health-watchdog */30`, alerta na transição ok→degradado pros domínios não-financeiros via `fin_alertas` + `fornecedor_alerta`). O domínio **reposição** já é coberto pelo watchdog.

## Princípios (herdados do Sentinela ativo)

- **Fonte única de verdade**: o check vive em `_data_health_compute()`; dashboard e watchdog leem dela. A contagem do gap vem de uma **view** (não reimplementar o predicado em dois lugares).
- **Vigiar EFEITO NO DADO, não status técnico**: o check conta SKUs no quadrante de risco, não "o cron rodou". É falha futura determinística (o motor vai pedir, o portal vai recusar).
- **Baixo ruído**: 1 email na transição ok→degradado; silêncio enquanto persiste; dismiss na recuperação (count→0).
- **Sem verde silencioso**: count desconhecido (erro de query) → `unknown`/`broken`, nunca 0.

## Design

### 1. View fiel ao motor — `v_sayerlack_mapeamento_gap`
`security_invoker = on`, idempotente (`CREATE OR REPLACE`). Espelha os predicados ESTRUTURAIS da RPC `gerar_pedidos_sugeridos_ciclo` (sem o dinâmico `estoque_efetivo <= ponto_pedido` — queremos todos os elegíveis, não só os que precisam HOJE):

```
FROM sku_parametros sp
LEFT JOIN sku_grupo_producao sg   ON (empresa, sku)            -- traz grupo_codigo (display)
LEFT JOIN omie_products op        ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
LEFT JOIN familia_nao_comprada fnc ON (empresa, op.familia)
LEFT JOIN sku_status_omie sso     ON (empresa, sku)
WHERE sp.empresa='OBEN'
  AND sp.fornecedor_nome ILIKE '%SAYERLACK%'
  AND sp.habilitado_reposicao_automatica = TRUE
  AND COALESCE(sp.tipo_reposicao,'automatica') = 'automatica'
  AND fnc.id IS NULL
  AND COALESCE(op.ativo, true) = true
  AND COALESCE(sso.ativo_no_omie, true) = true
  AND COALESCE(op.descricao,'') NOT ILIKE '%450ML'
  AND COALESCE(op.descricao,'') NOT ILIKE '%405ML'
  AND sp.ponto_pedido IS NOT NULL AND sp.estoque_maximo IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM sku_fornecedor_externo m
                  WHERE m.empresa=sp.empresa AND m.fornecedor_nome ILIKE '%SAYERLACK%'
                    AND m.sku_omie = sp.sku_codigo_omie::text AND m.ativo = true)
```
Colunas: `empresa, sku_codigo_omie, sku_descricao, grupo_codigo`. Reutilizável: a tela de Mapeamento pode trocar a aproximação client-side por esta view (fecha a limitação documentada no PR — opcional).

### 2. Check em `_data_health_compute()`
Novo check (CTE no `WITH checks`):
- `source = 'reposicao_mapeamento_sayerlack'`, `domain = 'reposicao'`.
- `n_gap = (SELECT count(*) FROM v_sayerlack_mapeamento_gap)`.
- `n_gap_em_pedido_aberto` = SKUs do gap que JÁ estão num `pedido_compra_sugerido` não-disparado (status pendente/aprovado) — esses vão falhar no próximo disparo (urgência maior).
- **status / severity**:
  - `n_gap = 0` → `ok` / `info`.
  - `n_gap_em_pedido_aberto > 0` → `broken` / `critical` (há pedido que vai recusar no portal).
  - senão (`n_gap > 0`) → `degraded`(ou `stale`, conforme vocabulário vigente) / `warning`.
- `message`: "N SKUs Sayerlack compráveis pelo motor sem de-para no portal (M já em pedido aberto)".
- `how_to_fix`: "Mapeamento SKU → Validar mapeamentos → Gravar automaticamente; restante manual".
- `freshness_basis`: contagem (não é frescor temporal) — usar a convenção do projeto pra checks não-temporais.

### 3. Push
O domínio `reposicao` já está no IN do `data_health_watchdog`. **Confirmar** que o watchdog itera por `source` dentro do domínio (e não por um source fixo) — se for fixo, adicionar `reposicao_mapeamento_sayerlack` ao conjunto vigiado. Transição ok→degradado/broken → `fin_alertas` (`tipo='data_health_reposicao_mapeamento_sayerlack'`, UNIQUE parcial anti-spam) + enfileira `fornecedor_alerta`. Dismiss no retorno a `ok`.

## Pré-condição de ativação (importante)

**Aplicar a migration do check SÓ depois do backlog do gap estar ~0** (auto-apply dos ~87 + cadastro manual dos ~7 do PR anterior). Se aplicar antes, o check nasce `warning`/`broken` e o watchdog dispara email na hora — vermelho permanente até zerar (anti-padrão que o founder rejeita). Sequência: merge do PR → auto-apply na UI → mapear os 7 → **então** colar a migration do check (nasce verde, vira regressão alertável).

## Não-objetivos

- Não vigia outros fornecedores de portal (só Sayerlack/OBEN tem automação de portal hoje).
- Não auto-corrige (não dispara o auto-apply sozinho) — só alerta; a gravação segue revisada por humano (gate do gabarito).
- Não mede o dinâmico "precisa repor hoje" — o check é estrutural (quem PODE ser pedido), não "quem será pedido neste ciclo".

## Migration (ritual Lovable — CLAUDE.md §5)

1 migration custom (view + `CREATE OR REPLACE` de `_data_health_compute` com o check novo; e ajuste do watchdog se o IN for por source fixo). Entregar o SQL inline pra colar no SQL Editor + query de validação (`SELECT source, status, severity, message FROM get_data_health() WHERE source='reposicao_mapeamento_sayerlack'`). Consult codex no desenho da view (fidelidade ao motor) recomendado.
