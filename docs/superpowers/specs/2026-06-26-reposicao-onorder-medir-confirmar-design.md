# Reposição "a caminho" (on-order) — fase MEDIR + CONFIRMAR — design

**Data:** 2026-06-26 · **Escopo:** OBEN (money-path) · **Origem:** follow-up de fundo do PR #1072 (hotfix de janela) + reabertura do blueprint `2026-06-14-reposicao-onorder-redesign-blueprint.md`. Decisão de escopo do founder: **medir + confirmar antes de construir o redesign**. Codex (gpt-5.5 high) consultado na metodologia (2026-06-26).

> ⚠️ **STATUS 2026-06-26 (pós-execução): a edge probe foi SUPERADA, não construída.** Ao sincronizar com `main` descobri que (1) `purchase_orders_tracking` JÁ é a réplica-por-PO que a probe ia diagnosticar, e (2) o #1076 que a corrige (janela [365,120] + pagina-até-vazia + bulk upsert) foi **REVERTIDO** por um auto-commit `Changes` do Lovable. Pivotei (Claude+Codex, sessão 019f0554) para **restaurar o #1076 + guardrail CI + medir cobertura via `psql-ro`** — medido direto no banco: 127 POs OBEN abertas, **28 com previsão nula**, 0 futuras (a réplica regredida cortava o futuro). A edge probe e seus helpers foram descartados; a semântica e a análise deste doc seguem válidas. Commits: `498052a8` (re-aplica #1076), guardrail das edges, fix `types.ts` stale do #1079. O redesign B (motor lê da réplica como fonte única) continua FUTURO — precisa `coverage_check` + fail-closed (a janela ainda perde nula/futura>120d → subestima → compra dupla).

> ✅ **RESULTADO 2026-06-26 (pós re-deploy da edge em prod): correção confirmada, redesign B CONGELADO.** O founder re-deployou `omie-sync-pedidos-compra` (#1076 via PR #1085). Verifiquei via `psql-ro`: as POs etapa-15 com entrega FUTURA voltaram a entrar (**0 → 16**), réplica completa (485d, ~508 POs etapa-15 abertas, pedidos 1091-1092 capturados). **Furo residual medido = desprezível:** as 28 POs de previsão nula são `FATURADO` (etapa 60), **NÃO** etapa-15 → o motor (só conta etapa-15) nunca as contou no "a caminho", logo não são furo; previsão futura >120d = **0** (a mais distante é 27/08, ~62d); atrasada >365d improvável. **Decisão B (Claude+Codex, sessão `019f0554`): congelar.** O B (motor lê da réplica como fonte única) **NÃO ganha cobertura** — a réplica usa a MESMA janela `[365,120]` por previsão do motor; só eliminaria a dupla-varredura, ao custo de trocar a fonte do money-path (risco de compra dupla). Com furo desprezível, o ROI não justifica o risco. **Gatilhos de reabertura:** PO etapa-15 com previsão >120d à frente ou >365d atrás em volume material; OU a dupla-varredura (`omie-sync-estoque` + `omie-sync-pedidos-compra` no mesmo `PesquisarPedCompra`) virar gargalo de performance/cota Omie.

## 1. Por que esta fase existe (o que mudou no diagnóstico)

O motor de reposição decide comprar por `estoque_efetivo = físico + "a caminho"` (`sku_estoque_atual.estoque_pendente_entrada`). **Subestimar "a caminho" → compra dupla** (o motor recompra o que já vem); superestimar → ruptura. Invariante-mestra (Codex): **nunca subestimar**; fail-closed (não-gravar) é aceitável, gravar incompleto não.

O "a caminho" (OBEN) é calculado pela edge `omie-sync-estoque` = Σ saldo `(nQtde−nQtdeRec)` por SKU sobre POs abertas etapa-15 do `PesquisarPedCompra`, filtrando por `[dDataInicial, dDataFinal]`, de-dupado contra pedidos do app recém-disparados (<7d).

### Achados que fundamentam a fase (verificados em prod via `psql-ro`, 2026-06-26)

1. **Semântica da janela = PREVISÃO DE ENTREGA, não inclusão** (CONFIRMADO). Prova: nas 5 POs com maior gap inclusão→previsão, a data em que entram no nosso espelho == `dDtPrevisao` exatamente (ex.: PO incluída 27/03, previsão 26/04, entrou 26/04); **zero** POs abertas com previsão futura no banco, apesar de existirem no Omie (a PO do incidente entrega 08/07). Consequência: a janela corta tudo com previsão fora dela.
2. **O blueprint de 2026-06-14 está factualmente errado neste ponto** — inferiu "emissão" e por isso **ADIOU** o redesign. A "prova" dele (uma PO de previsão 19/06 coberta em 23/06) não distinguia as hipóteses (19/06 já era passado). **A premissa do adiamento caiu.** → corrigir o blueprint (ver §8).
3. **NÃO há double-count vivo** (hipótese inicial retratada): a edge de-dupa pendente vs `em_transito` por PO (`fetchEmTransitoKeys` + `itemContaComoPendente`), então um SKU com pendente>0 e em_transito>0 são POs distintas somadas certo.
4. **A frente single-source #809 foi revertida (#817)** por timeout do edge worker (~400s) na varredura síncrona completa — não é "completável", precisa do redesign do blueprint (réplica-por-PO).

### Casos que escapam hoje (mesmo com o #1072 `[hoje−365, hoje+120]`)

Como o filtro é por previsão, escapam da janela: **previsão NULA** (não está em range nenhum → invisível), **previsão futura > 120d** (fat-finger), **atrasada > 365d**. Cada um → "a caminho" subestimado → compra dupla. O #1072 é paliativo; a solução robusta (Codex) é **inventário próprio de POs** (réplica-por-PO).

## 2. Objetivo

Remover a incerteza com **dado**, sem ainda comprometer o redesign caro:
- **Confirmar** o contrato da API (campo do filtro + regra da previsão nula + existe canal independente da janela?).
- **Medir** a magnitude da sub-classe que escapa (quantas POs abertas ficam invisíveis ao "a caminho", por sub-classe) → dimensiona a urgência do redesign.
- Deixar um **alerta de cobertura** que detecta regressão (gatilhos do blueprint).

Correção de metodologia do Codex: **a edge atual é cega ao que o próprio filtro exclui** → medir cobertura exige uma **fonte independente da janela-por-previsão**. Instrumentar só a edge atual mede sintoma, não cobertura.

## 3. Arquitetura

**Edge de diagnóstico NOVA e ISOLADA: `omie-onorder-probe`** (não um modo na `omie-sync-estoque` quente — isola o risco do money-path).
- POST; gate `authorizeCronOrStaff` (staff autenticado OU `x-cron-secret`); credencial `Deno.env.get("OMIE_OBEN_APP_KEY"/"OMIE_OBEN_APP_SECRET")` (mesma da `omie-sync-estoque`).
- **READ-ONLY ao Omie e ao banco — NÃO grava `sku_estoque_atual`, NÃO toca o cálculo do motor.** Retorna um relatório JSON (e loga estruturado).
- Reusa `callOmie`/`callOmiePedidos` (copiados, não importados — Deno).

## 4. Componente 1 — Probe de semântica (confirma o contrato)

Chamadas controladas ao Omie, comparando o que cada uma retorna. Insumos: POs conhecidas de `purchase_orders_tracking` com inclusão≠previsão e POs de previsão nula conhecidas.

| # | Teste | Confirma |
|---|---|---|
| P1 | PO conhecida: `PesquisarPedCompra` janela=[inclusão,inclusão] vs janela=[previsão,previsão] | qual campo o filtro usa (esperado: só a 2ª retorna) |
| P2 | janela `[hoje, hoje+120]` (futuro) | POs de previsão futura aparecem? quantas? |
| P3 | PO com `dDtPrevisao` nula conhecida: aparece em janela ampla `[hoje−365, hoje+120]`? em `[2010, hoje+3650]`? | **regra do nulo** (sempre excluída / data default) |
| P4 | tentar enumerar por inclusão/alteração: params alternativos no `PesquisarPedCompra` e/ou endpoint `ListarPedidosCompra` se existir | existe canal independente da janela-por-previsão? |
| P5 | `ListarSaldoPendente` (`qtde_entrada`, sem janela de data) vs Σ via `PesquisarPedCompra` | ListarSaldoPendente é fonte independente que cobre futuros? (o comentário da edge diz que é cego a futuro — **re-testar**) |

**Saída:** relatório que fixa o contrato (campo do filtro, regra do nulo, canal independente disponível: sim/qual). Fecha os furos do Codex (`created_at` pode mentir; nulo tem regra própria) com observação direta da API, não inferência sobre o espelho.

## 5. Componente 2 — Auditoria de cobertura (mede o que escapa)

Depende do canal independente achado em P4/P5:
- **Se houver canal sem-janela** (ListarSaldoPendente cobrindo futuros, ou enumeração por inclusão): varre por ele + compara com o cálculo atual (janela por previsão) por `nCodPed`/SKU → **lista POs abertas ausentes do "a caminho", por sub-classe** (nula / futura >120d / atrasada >365d) + soma de unidades subestimadas.
- **Se NÃO houver** (honesto): auditoria assistida por export do Omie (founder puxa a lista de POs abertas; eu cruzo com o espelho). Vira semi-manual.

**Saída:** número que dimensiona a urgência — "N POs abertas (M unidades) invisíveis ao motor hoje, distribuídas em [sub-classes]".

## 6. Componente 3 — Observabilidade no fluxo (fatia seguinte, não nesta entrega)

Aditivo na `omie-sync-estoque` (só logging, sem mudar cálculo): por sync, persistir `paginasLidas`, POs etapa-15 app×manual, range previsão min/max, count nulos, `duracao_ms`. Detecta os **gatilhos do blueprint** (PO chegando a 365d de previsão; `duracao_ms` perto de 400s). É **saúde**, não cobertura.

## 7. Decisão que esta fase destrava

Com o dado de §5: se a sub-classe que escapa for material → reabrir o **MVP da réplica-por-PO** (recomendação do Codex: tabela de POs abertas por `nCodPed` + sync incremental independente + fail-closed quando cobertura não confiável; "não esperar ROI perfeito, o erro é compra dupla em motor automático"). Se for marginal e estável → o #1072 + alerta de cobertura basta por ora.

## 8. Resíduo durável (fazer junto com esta fase)

- **Corrigir o blueprint `2026-06-14-reposicao-onorder-redesign-blueprint.md`**: a §"Conclusão 2026-06-23" infere "emissão" e adia com base nela — está factualmente errada (filtro = previsão, confirmado 2026-06-26). Marcar a inferência como REFUTADA + apontar para este spec, para não enganar uma decisão futura de novo.
- Nota em `docs/agent/reposicao.md`: o `fonte_sync='ListarPosEstoque'` em `sku_estoque_atual` é rótulo enganoso — o `estoque_pendente_entrada` OBEN vem do `PesquisarPedCompra` (filtro por previsão), não do ListarPosEstoque.

## 9. Riscos / fail-closed

- A edge probe NÃO grava nada no money-path → risco operacional mínimo (read-only).
- Probe consome cota de chamadas Omie (rate-limit 429) → janelas controladas, poucas chamadas, reusar o backoff do `callOmie`.
- Confirmação da semântica é observação da API hoje; para tratá-la como **contrato permanente**, P1-P3 substituem a inferência sobre o espelho (Codex: ok reverter a premissa agora; confirmar o contrato em paralelo).
- Sem SQL de decisão money-path nesta fase (edge read-only) → `prove-sql` não aplica aqui; aplica no MVP da réplica (fase futura, que cria tabela + RPC de apply).

## 10. Fora de escopo (fatias seguintes, decididas com o dado)

Componente 3 (observabilidade no fluxo) · MVP réplica-por-PO (`nCodPed` + sync independente + apply atômico fail-closed + bump via `ConsultarPedCompra(cCodIntPed)` para pedidos do app) · particionamento por data.
