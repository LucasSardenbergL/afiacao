# Reposição — Cold-start / sugestão de primeira compra (Sayerlack)

> Spec travada em 2026-05-30 (sessão de auditoria de mapeamento/parâmetros Sayerlack).
> Desenho revisado com codex. **Money-path, raio de explosão alto** (mexe na view que
> alimenta TODA sugestão de compra) → construir report-first, escopado, sem rush.

## Problema

Dos **272** SKUs do fornecedor `RENNER SAYERLACK S/A` (empresa OBEN), **124 (46%)** estão
sem `ponto_pedido`/`estoque_maximo` em `sku_parametros` → o motor `gerar_pedidos_sugeridos_ciclo`
**nunca os sugere pra compra** (exige os dois preenchidos). Compras silenciosamente perdidas.

A `v_sku_parametros_sugeridos` calcula os parâmetros, mas tem um GATE `status_sugestao` (CASE,
nesta ordem) e TODOS os `*_sugerido` são `CASE WHEN status_sugestao='OK' THEN <calc> ELSE NULL`:

1. `num_ordens < 2` → `AGUARDANDO_SEGUNDA_ORDEM`
2. `lt IS NULL` → `SEM_LEADTIME_DEFINIDO`
3. `fornecedor_nome IS NULL` → `SEM_FORNECEDOR_IDENTIFICADO`
4. `NOT fornecedor_habilitado` → `AGUARDANDO_HABILITACAO_FORNECEDOR`
5. `grupo_codigo IS NULL AND fornecedor='RENNER SAYERLACK'` → `AGUARDANDO_CLASSIFICACAO_GRUPO`
6. `preco_item_eoq IS NULL/0` → `SEM_PRECO`
7. ELSE `OK`

`lt = GREATEST(lt_total_teorico_dias_uteis [v_sku_lt_teorico = SLA do fornecedor], lt_medio [histórico])`.

### Diagnóstico real (dos 116 que TÊM demanda mas estão sem param)

| status_sugestao | qtd | têm lt_teorico (SLA) |
|---|---|---|
| AGUARDANDO_SEGUNDA_ORDEM | 74 | **20** |
| SEM_LEADTIME_DEFINIDO | 38 | **0** |
| AGUARDANDO_CLASSIFICACAO_GRUPO | 4 | — |

**Achado-chave:** o gargalo NÃO é só o gate `num_ordens<2`. É o **lead time**: só **20 dos 116**
têm fonte de lead time (SLA teórico). Os outros **92 não têm lead time nenhum** (nem histórico
nem SLA) → não dá pra calcular reorder de jeito nenhum. **O SLA do RENNER SAYERLACK está quase
todo NÃO cadastrado.**

## Design (revisado com codex — 2 consults)

Ordem de alavancagem (corrigida pela viabilidade):

### Parte 1 (MAIOR alavanca) — cadastrar/consertar o SLA de lead time do RENNER SAYERLACK
Investigar **por que só 20 SKUs têm `lt_total_teorico_dias_uteis`** na `v_sku_lt_teorico` (o que
a view exige: rota/logística/config do fornecedor). Cadastrar o SLA → ~92 SKUs ganham lead time
teórico → ficam elegíveis pra Parte 2. **Sem isso, o approach A só atinge 20.**
⚠️ codex: **NÃO** usar lead time default global ("compra fantasma"); LT tem que vir de SLA/dado real.

### Parte 2 — trilha `OK_PRIMEIRA_COMPRA` na v_sku_parametros_sugeridos
- **Trilha SEPARADA, não toca o caminho `OK`** (raio de explosão). Condições:
  `demanda>0 AND num_ordens<2 AND lt_teorico IS NOT NULL AND fornecedor_nome IS NOT NULL
   AND fornecedor_habilitado AND preco_item_eoq>0 AND classe_abc IS NOT NULL
   AND (grupo_codigo IS NOT NULL OR fornecedor <> 'RENNER SAYERLACK')`.
- Usa **`lt_teorico` direto** (não `GREATEST`), pra não esconder a origem.
- **Conservadorismo (codex): NÃO inflar z-score.** Em vez disso, **CAP de cobertura** na 1ª compra
  (ex.: `min(qtde_calculada, demanda_media × ~45 dias)`; teto por classe — A maior, C menor).
- **Guard anti one-off** (approval não basta): só entra com **venda recorrente** (≥2 períodos /
  venda nos últimos ~120d) e SKU não descontinuado/inativo.
- **Flags expostas:** `tipo_sugestao` (NORMAL/PRIMEIRA_COMPRA), `lt_origem` (TEORICO/HISTORICO/MISTO),
  `requer_revisao=true` → o dono revisa essas com atenção no approval.
- Os **38 lt-NULL** seguem travados até a Parte 1 (cadastrar SLA).

### Parte 3 — build report-first + escopado
- **Relatório antes/depois** (valor total sugerido, nº SKUs, cobertura resultante) **ANTES** de
  ligar — o dono revisa o impacto. + escopo **Sayerlack primeiro**, não global de cara.
- A função `preencher_parametros_faltantes_skus` + cron `reposicao-preencher-parametros-faltantes`
  (já entregues, PR #487, fill-only-por-campo/COALESCE) **aplicam os sugeridos automaticamente**
  assim que a view destravar. Então a Parte 2 + 3 só precisam destravar a VIEW; o resto já roda.

## Erro de premissa registrado (codex)
"Depois das compras reais o histórico assume" não é pleno com `lt = GREATEST(teorico, historico)`
— o histórico só assume se for MAIOR que o SLA. Aceitável (conservador), mas: 1ª compra = teorico;
poucas compras = GREATEST/ponderada; histórico suficiente = percentil/média aparada com piso no SLA.

## Os 4 AGUARDANDO_CLASSIFICACAO_GRUPO
Quick win independente: classificar em grupo de produção (`/admin/reposicao/grupos-producao`).

## Não-objetivos / fora de escopo
- Lead time default global (rejeitado pelo codex).
- Mexer no caminho `OK` existente.
- Ligar global sem o relatório antes/depois.

## Plano de build (passada dedicada)
1. Investigar a `v_sku_lt_teorico` (por que só 20 SKUs) + cadastrar o SLA Sayerlack (Parte 1).
2. Spec → migration da view com a trilha `OK_PRIMEIRA_COMPRA` (Parte 2), `CREATE OR REPLACE`
   verbatim do corpo de produção + a trilha nova (nunca reescrever do zero).
3. Relatório antes/depois (simulação) → revisão do dono.
4. Ligar escopado (Sayerlack) → o cron #487 aplica → acompanhar.
5. Helper puro testável pro cap/guard (TDD), espelhado se for pra função.
