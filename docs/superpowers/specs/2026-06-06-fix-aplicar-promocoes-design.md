# Fix `aplicar_promocoes_no_ciclo` (quebrada em prod) — design

> 2026-06-06. PR1 de 2 (PR2 = mínimo forçado no forward_buying, com Codex).
> ⚠️ Codex indisponível (usage limit do Plus) no momento da entrega → caminho **B** acordado com o founder: validação exaustiva no **PG17** no lugar da 2ª opinião; Codex faz o adversarial **retroativo** quando voltar.

## Problema
A função SQL `public.aplicar_promocoes_no_ciclo(p_empresa text, p_data_ciclo date)` está **quebrada em produção**. Os 2 UPDATEs (modo `flat` e `forward_buying`) usam:
```sql
UPDATE pedido_compra_item pci ... FROM v_promocao_avaliacao_hoje av
  JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id WHERE ...
```
O Postgres **rejeita no parse**: `ERROR: invalid reference to FROM-clause entry for table "pci"` (o alvo do UPDATE não pode ser referenciado no `ON` de um JOIN dentro do `FROM`). **Provado em PG17 17.10.**

Consequência: a função **aborta toda vez que roda**. É chamada todo ciclo pelo edge `gerar-pedidos-diario` em **best-effort** (`try/catch` + `console.error`) → falha **silenciosa** → **nenhuma promoção de compra foi aplicada aos pedidos** desde que a função foi reescrita.

**Drift §5:** a migration-fonte `20260510223800` só faz `ALTER FUNCTION ... SET search_path`; a definição viva nasceu **direto em prod** pelo Lovable, sem migration versionada — por isso o snapshot de prod tem o bug e nenhuma migration commitada o introduz.

## Fix (cirúrgico, escopo mínimo)
Nos 2 UPDATEs, trocar
```
FROM v_promocao_avaliacao_hoje av JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id WHERE ...
```
por
```
FROM v_promocao_avaliacao_hoje av, pedido_compra_sugerido pcs WHERE pcs.id = pci.pedido_id AND ...
```
Forma válida, semântica idêntica: `pcs.id` é PK → `pcs.id = pci.pedido_id` casa no máximo 1 linha. Resto do corpo **verbatim** da versão viva (pg_get_functiondef 2026-06-06). Escolhi a vírgula (e não `EXISTS`) por ser a mudança mínima e estar provada no PG17; o Codex pode sugerir `EXISTS` no adversarial — troca trivial.

## Por que é seguro ligar a feature
- **Sem multiplicação / dupla aplicação:** a view `v_promocao_avaliacao_hoje` fecha com `SELECT DISTINCT ON (empresa, sku_codigo_omie) ... ORDER BY economia_liquida_valor DESC NULLS LAST, desconto_perc DESC` → no máximo **1 linha por SKU** (a campanha de maior economia vence, determinístico). O `forward_buying` já é gated por `economia_liquida_perc > 0` na própria view.
- **Idempotência:** guard `pci.modo_promocao IS NULL` (não reaplica).
- **Guardrail preservado:** a função reavalia `delta_vs_anterior_perc` e bloqueia (`status='bloqueado_guardrail'`) pedidos inflados por forward_buying acima do `delta_max_perc` do fornecedor.

## Validação — PG17 (`db/test-fix-aplicar-promocoes.sh`)
Aplica a **migration real** sobre stubs. 5 cenários:
1. **Contraprova:** o padrão de prod (JOIN com alvo no FROM) aborta com `invalid reference to FROM-clause entry`.
2. **flat:** preço com desconto, qtde inalterada (sku111: 10→9, vl 45, econ 5).
3. **forward_buying:** qtde inflada (sku222: 5→50, preço 19, vl 950, econ 90).
4. **guardrail:** pedido inflado além do delta máximo → `bloqueado_guardrail`.
5. **só-flat:** pedido sem forward não entra na reavaliação do guardrail. **+ idempotência** (2ª passada aplica 0, não re-desconta).

## Escopo
- **PR1 (este):** só o fix do parse → liga a aplicação de promoções. Mecânico, provado.
- **PR2 (próximo, com Codex):** respeitar `sku_parametros.minimo_forcado_manual` (a "R") no `forward_buying` — `qtde_final = av.qtde_com_desconto` poderia rebaixar a qtde abaixo do piso. Decisão de modelagem (na view × na função; recálculo de economia) que agora importa de verdade (o forward volta a rodar). Não misturado aqui para não somar risco numa função que vai ligar pela 1ª vez.

## Entrega / rollout
- Migration `20260606170000_reposicao_fix_aplicar_promocoes.sql` — **manual no SQL Editor** (CREATE OR REPLACE substitui a versão quebrada). **Sem deploy de edge** (o edge só *chama* a função). **Sem Publish** (é backend).
- ⚠️ **Muda comportamento:** ao aplicar, o próximo ciclo (`gerar-pedidos-diario`) passa a aplicar descontos/forward_buying nos pedidos. Founder deve revisar a 1ª rodada.

## Hardening (Codex adversarial — migration `20260606180000`)
O Codex adversarial retroativo do PR1 (caminho B) achou furos de **lógica de domínio** pré-existentes, **expostos ao ligar a feature** — confirmados em prod: a recuperação retroativa (rodar a função com data passada) aplicou **campanha fora de vigência** em 4 itens (campanha começou 01/06, pedidos de 30–31/05) → **revertidos** (pendentes, zero dano). 7 travas conservadoras, todas na função (redesenho da view fica pra v2):
- **H1** fornecedor exato (`pcs.fornecedor_nome = av.fornecedor_nome` — a view casa só empresa+SKU no `DISTINCT ON`, sem fornecedor → podia vazar entre fornecedores do mesmo SKU).
- **H2** vigência na data do pedido: join `promocao_campanha pc ON pc.id = av.campanha_id` + `pcs.data_ciclo BETWEEN pc.data_inicio AND pc.data_fim`. **Escolhi isto no lugar do `p_data_ciclo=CURRENT_DATE`** que o Codex sugeriu — o edge passa `new Date().toISOString().slice(0,10)` (data **UTC**), então comparar com `CURRENT_DATE` é frágil a fuso; o join valida a vigência **real** e é robusto a fuso. **Previne exatamente o erro retroativo.**
- **H3** cast `pci.sku_codigo_omie = av.sku_codigo_omie::text` (em vez de `::bigint`, que estoura em SKU não-numérico).
- **H4** respeita `pci.ajustado_humano IS NOT TRUE` (nos dois modos).
- **H5** só `pcs.tipo_ciclo = 'normal'` — nos 2 UPDATEs **e** nos blocos de agregação/recálculo de `valor_total`/guardrail (senão tocaria pedidos de oportunidade, que já têm `modo_promocao` próprio).
- **H6** forward `qtde_final = GREATEST(av.qtde_com_desconto, pci.qtde_final)` — **nunca rebaixa** o mínimo forçado (a "R") nem o ajuste humano → **isto FECHA o follow-up do mínimo forçado no forward_buying**. `valor_linha`/`economia` recalculados pela compra real; `qtde_sem_promocao = pci.qtde_final`.
- **H7/H7b** guards de quantidade: `av.qtde_com_desconto` e `pci.qtde_final` ambos `> 0 AND < 'Infinity'` (NaN/∞/zero) + `pci.qtde_final >= COALESCE(av.qtde_base, 0)` (não inflar além da base econômica modelada).

**Validação:** PG17 `db/test-hardening-aplicar-promocoes.sh` (7 travas + happy + idempotência + fórmulas de H6 + oportunidade intocada). **Codex em metodologia + adversarial no código: nenhum P1; 3 P2 incorporados** (tipo_ciclo nos blocos posteriores, guard de `pci.qtde_final`, asserts de fórmula).

**Lição:** aplicar mutação money-path retroativa (backfill manual) sem validar a vigência foi **precipitado** — o rito (Codex + auditoria) pegou e corrigiu; a trava H2 previne reincidência. Migration manual (substitui a `170000`).
