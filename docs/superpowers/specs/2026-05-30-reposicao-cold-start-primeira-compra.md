# Reposição — Cold-start / sugestão de primeira compra (Sayerlack)

> Spec travada em 2026-05-30 (sessão de auditoria de mapeamento/parâmetros Sayerlack).
> Desenho revisado com codex. **Money-path, raio de explosão alto** (mexe na view que
> alimenta TODA sugestão de compra) → construir report-first, escopado, sem rush.

## STATUS (atualizado 2026-05-30, fim da sessão)
- ✅ **Gargalo de GRUPO resolvido** (PR #494, em prod): `classificar_sayerlack_grupo_default()`
  + cron `reposicao-classificar-sayerlack-grupo` (7h30) classificou **83** SKUs sem-grupo no
  `sayerlack_normal` (default conservador; marca `atualizado_por='auto_default_sayerlack'` p/
  revisão). **0 válidos restando**; o cron mantém os novos. Os ~17 não-classificados eram
  desabilitados/fracionados (corretamente fora).
- ✅ **+28 SKUs Sayerlack viraram sugeridos** na hora (os com ≥2 compras): `com_param` 148→176,
  via `preencher_parametros_faltantes_skus` + cron 8h (PR #487) aplicando os sugeridos assim que
  a view destrava.
- ✅ **A "Parte 1" abaixo (SLA/lead time) estava na verdade CONCLUÍDA** — o SLA já estava
  cadastrado (logística 124/124, LT de grupo 24/24); o que faltava era a CLASSIFICAÇÃO de grupo
  (feita acima). Não há SLA a cadastrar.
- ⏸️ **RESTA só a Parte 2 (cold-start / approach A)** pros ~55-74 SKUs com `num_ordens<2` (vendem
  mas <2 compras → gate `AGUARDANDO_SEGUNDA_ORDEM`). Esse é o trabalho de uma passada dedicada.

## ⚠️ REVISÃO CRÍTICA (2026-05-30, 2º consult codex) — premissa corrigida, approach mudou

**ERRO DE PREMISSA da spec original:** assumia `num_ordens` = nº de COMPRAS. **ERRADO.**
Rastreado no snapshot: `num_ordens = count(DISTINCT nfe_chave_acesso)` de `venda_items_history`
nos **últimos 90 dias** = nº de **notas fiscais de VENDA** distintas em 90d. A view inteira
parte de `venda_items_history` (só entra SKU com ≥1 venda/90d) → `num_ordens ≥ 1` sempre →
**`num_ordens<2` ≡ `num_ordens=1` ≡ "vendeu em UMA única NF nos últimos 90 dias"**.

**Consequência:** o "vende regular mas nunca comprado" (num_ordens≥2 sem histórico de compra)
**NÃO está preso aqui** — passa o gate 1 e, com lt teórico (SLA via grupo, #494), vira `OK`
direto (foram os "+28"). O que SOBRA em `AGUARDANDO_SEGUNDA_ORDEM` são itens de **venda rara
(1 NF/90d)** → alto risco de **one-off/encalhe**; demanda (1 ponto/90d), sigma (fallback 0.5·d)
e XYZ ('Z') são frágeis. Renomear mentalmente o status: `BAIXA_RECORRENCIA_VENDA_90D`.

**Approach REVISADO (codex):** **NÃO** relaxar o gate pra fila automática. Em vez disso:
- **Trilha `CANDIDATO_PRIMEIRA_COMPRA`** (terceira via: nem auto, nem cemitério) → os
  `*_sugerido` SEGUEM `NULL` (o cron #487 **não** aplica → fila automática 100% intacta), e a
  view expõe os candidatos + qtde-teste capada em **colunas NOVAS dedicadas** → **lista de
  revisão** na UI (badge/contador/ordenação por valor; comprador decide).
- **Guard de recorrência (180d):** `meses_distintos_com_venda ≥ 2` **E** `nfs_distintas ≥ 2`
  **E** `dias_desde_ultima_venda ≤ 60` (+ `clientes_distintos ≥ 2` se a coluna existir).
- **Cap (compra-teste):** `qtde = LEAST(qc_eoq, demanda_media_diaria × cap_dias_classe)`,
  `cap_dias` A=30 / B=21 / C=14 (conservador); sem inflar z; SS pequeno/zero.
- **Escopo v1:** Sayerlack / fornecedor habilitado; **shadow** (a própria view é o shadow — mostra
  o que seria sugerido sem disparar R$). Global + `AUTO_EXPERIMENTAL` com trava financeira = v2.
- **Raio de explosão:** a trilha nova intercepta SÓ casos hoje em `num_ordens<2` (caminho `OK`
  intacto); colunas só-adição (não renomeia/reordena → consumidores intactos).

**Modos de falha a tratar (codex):** ruptura (baixa venda = falta de estoque, não de demanda) →
sinalizar; NF gigante distorce demanda+ABC; MOQ/múltiplo; validade/obsolescência; canibalização;
devoluções/cancelamentos contaminando histórico; ABC promovendo one-off caro pra 'A'.

**Estado:** report-first (BLOCO 0 read-only) entregue ao founder pra medir magnitude real
(quantos passam o guard, valor, por fornecedor) → calibra o design final → constrói.

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
