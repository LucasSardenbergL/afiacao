# Giro de estoque por SKU — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PME por empresa honesto (null + motivo, nunca 0) com estoque de giro real, NCG com estoque, e seção de giro por SKU (segurar compra / liquidar + lista fora do giro) na aba Ciclo.

**Architecture:** Uma função SQL `IMMUTABLE` é dona da classe do estoque (giro / fora do giro / sem classificação). Duas RPCs SECURITY DEFINER leem `inventory_position`: o total por empresa (engine) e a lista por SKU (aba Ciclo, gate master). O engine troca `fin_estoque_valor`-ou-0 por precedência manual → Omie → null, e o CMV por 12 meses fechados exigidos; a lógica nova sai num módulo puro testado em Deno. O app só lê, pagina e formata via helper puro.

**Tech Stack:** Postgres 17 (Supabase/Lovable Cloud), Deno edge, React 18 + TS strict, react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-ciclo-giro-sku-design.md` — **§5.4 (pós-Codex) prevalece** sobre §5.0–5.3.

## Global Constraints

- Ausente ≠ zero: nenhum `?? 0`/`Number(null)` em PME, estoque, CMV, dias, `valor_parado`, `valor_excedente`.
- Caixa por CNPJ: nada soma R$ entre empresas.
- Todo R$ da seção nova com o rótulo "cenário — não é previsão".
- Mapas: estoque oben→`vendas`, colacor→`colacor_vendas`, colacor_sc→`servicos`; consumo oben→`OBEN`, colacor→`COLACOR`, colacor_sc→sem fonte.
- Fora do giro: `tipo_produto` ∈ {07,08,09,99} **ou** `lower(trim(familia))` ∈ {'uso e consumo','imobilizado'}. Sem `tipo_produto` (ou sem `product_id`) → `sem_classificacao`. Demais → `giro`.
- Limiares: cobertura-alvo **90** d, segurar_compra **> 180** d, liquidar **≥ 270** d sem saída.
- Manual em `fin_estoque_valor` vale se `data_ref ≥ hoje(SP) − 45`.
- CMV: 12 meses fechados (exclui mês corrente de SP), todos presentes e Σ > 0.
- Gate da RPC por SKU: `_fin_ciclo_gate_master()` e depois `fin_user_can_access(p_company)`; `REVOKE` de `PUBLIC, anon`; `GRANT` a `authenticated, service_role`.
- Arquivo novo em `src/` → dono em `src/lib/modulos/manifesto.ts`.
- Migration nova é custom (Lovable não aplica): idempotente, postcondição embutida, nota "⚠️ migration manual" no PR; skill `lovable-db-operator` para aplicar.
- Comandos pesados com prefixo `heavy`.

## Review Focus

1. SKU com `cmc = 0` (8 em prod) → `valor_parado` null e contado como "sem custo", nunca R$ 0 somado como se fosse custo. Teste: PG17 (Task 1) e helper (Task 4).
2. Insumo consumido só via malha PCP (nunca vendido avulso) → não pode virar `liquidar`. Teste: fixture PG17 com linha só na explosão (Task 1).
3. Empresa sem fonte de consumo (colacor hoje) ou com fonte velha/curta → lista com R$ e `acao`/dias null + `motivo_consumo` (`sem_consumo_por_sku` | `consumo_incompleto` | `consumo_desatualizado`). Testes na Task 1 (fixtures de fonte curta e velha) e Task 5 (texto na tela).
4. Lista > 1.000 linhas (colacor ~1.460) → paginação completa; o total do resumo bate com a soma de todas as páginas. Teste no hook (Task 4).
5. Engine com estoque null → `aco.estoque` null, `ncg.parcial = true`, motivo presente; `NcgDecomposicao` escreve "parcial — sem estoque" para `null` e nada para `0` real. Testes nas Tasks 2 e 3.
6. SKU comprado há pouco e ainda sem saída → nunca `liquidar` (`motivo_acao='compra_recente'`). Teste: fixture `cmc_ledger` na Task 1.

---

### Task 1: Migration SQL + prova PG17

**Files:**
- Create: `supabase/migrations/20261018200000_fin_ciclo_giro_sku.sql`
- Create: `db/test-fin-ciclo-giro-sku.sh` (modelo: `db/test-fin-ciclo-rpc.sh` — mesmo harness `db/lib/pg-harness.sh`, stubs, `SET LOCAL ROLE authenticated` + `request.jwt.claims`, cópia da migration em tmpdir para sabotar)

**Interfaces:**
- Produces:
  - `public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text` — `IMMUTABLE`, `'giro'|'fora_giro'|'sem_classificacao'`.
  - `public.fin_estoque_giro_valor(p_company text) RETURNS TABLE(valor_giro numeric, valor_fora_giro numeric, valor_sem_classificacao numeric, skus_giro int, skus_giro_com_custo int, cobertura_pct numeric)` — gate igual a `fin_estimar_estoque_omie` (service_role ou `private.cap_custo_ler(auth.uid())`, senão 42501). Somas só de `saldo>0 AND cmc>0`; `cobertura_pct` = % de SKUs de giro com `cmc>0`; empresa inválida → P0001. Sem SKU de giro com custo (`skus_giro_com_custo = 0`) → `valor_giro` NULL (não 0). `REVOKE ALL FROM PUBLIC, anon`; `GRANT` a `authenticated, service_role`; `auth.uid()` null sem service_role → 42501.
  - `public.fin_ciclo_giro_sku(p_company text) RETURNS TABLE(omie_codigo_produto bigint, codigo text, descricao text, tipo_produto text, familia text, classe text, divergencia_cadastro boolean, saldo numeric, cmc numeric, valor_parado numeric, consumo_qtd_365d numeric, dias_cobertura numeric, ultima_saida date, dias_sem_saida int, valor_excedente numeric, acao text, motivo_acao text, motivo_consumo text)` — regras da spec §5.2. Consumo e `ultima_saida` de `v_sku_demanda_efetiva`; fonte disponível ⇔ em `venda_items_history` da empresa `min(data_emissao) ≤ hoje−330` e `max ≥ hoje−7` (spec §5.4.1). Insumo da malha com unidade divergente → consumo null, `motivo_consumo='unidade_divergente'`. Linha em `cmc_ledger` (mesma account) com `observed_at ≥ hoje−90` → sem `liquidar`, `motivo_acao='compra_recente'`. Cold start = `sku_parametros.parametro_cold_start = true` na empresa. Substituído = `sku_substituicao` aplicada `consolidar_demanda` com `sku_codigo_antigo` = o código → `acao` null, `motivo_acao='substituido'`. `divergencia_cadastro` = a classe por tipo difere da classe por família quando ambas existem. Ordem: `valor_parado DESC NULLS LAST, omie_codigo_produto`.
  - Constantes nomeadas no SQL: `90`, `180`, `270` como `CONSTANT` no `DECLARE` com nomes `c_cobertura_alvo_dias`, `c_segurar_compra_dias`, `c_giro_morto_dias`.

- [ ] **Step 1: Pré-voo em prod (psql-ro).** `pg_get_functiondef` de `fin_user_can_access`, `_fin_ciclo_gate_master`, `private.cap_custo_ler`; tipos de `sku_parametros.sku_codigo_omie`, `sku_substituicao.sku_codigo_antigo`, `v_sku_demanda_efetiva.sku_codigo_omie`, `venda_items_history.empresa`; confirmar que os 3 nomes novos não existem. Expected: tipos anotados no cabeçalho da prova.
- [ ] **Step 2: Escrever a prova (falha).** Fixtures mínimas: empresa oben com SKU giro vendido (dias_cobertura = saldo/(consumo/365)), SKU giro só na explosão PCP (não liquidar), SKU sem saída nunca (liquidar), SKU cold start sem saída (acao null), SKU com cobertura 400 d (segurar_compra, `valor_excedente = (saldo − consumo/365×90)×cmc`), SKU `cmc=0` (valor_parado null), SKU tipo 08 (classe fora_giro, consumo null), SKU tipo 00 + família "Uso e Consumo" (fora_giro, divergencia true), SKU sem product_id (sem_classificacao), substituído (motivo_acao 'substituido'); SKU sem saída com `cmc_ledger` de 30 dias (motivo_acao 'compra_recente'); insumo com unidade da malha divergente (motivo_consumo 'unidade_divergente'); colacor com estoque e sem NF-e (motivo_consumo 'sem_consumo_por_sku'); variante com NF-e só dos últimos 100 dias ('consumo_incompleto') e outra com última NF-e há 20 dias ('consumo_desatualizado'). Asserções de gate: employee → 42501; master sem acesso a colacor → 42501 em `fin_ciclo_giro_sku('colacor')`; `anon` sem EXECUTE (`has_function_privilege`); `fin_estoque_giro_valor` exclui fora/sem classe e devolve NULL sem giro. Strings ASCII, caixa fixa, sem `-i`. Run: `bash db/test-fin-ciclo-giro-sku.sh > logs/giro.log 2>&1; rc=$?; tail -c 1500 logs/giro.log; [ $rc -ne 0 ]` — Expected: falha (migration não existe).
- [ ] **Step 3: Escrever a migration** com bloco de postcondição (SECURITY DEFINER presente, anon/PUBLIC sem EXECUTE, `_fin_estoque_classe` `IMMUTABLE`) e marcador positivo de fim.
- [ ] **Step 4: Controle verde nos 2 locales.** `bash db/test-fin-ciclo-giro-sku.sh` e `LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-giro-sku.sh`, cada um com `exit=0` colado.
- [ ] **Step 5: Commit** (antes de falsificar).
- [ ] **Step 6: Sabotagens na MESMA invocação (`--falsificar`), uma camada por vez, controle verde abortando antes do 1º `sed`:** (a) tirar o gate master; (b) tirar `fin_user_can_access`; (c) tirar `anon` do REVOKE (+ 6b neutralizando a postcondição); (d) `valor_parado` com `coalesce(...,0)`; (e) trocar a fonte de `ultima_saida` para `v_sku_ultima_venda`; (f) remover 99 da lista fora do giro; (g) remover exceção de cold start; (h) trocar o gate de frescor por `EXISTS` simples; (i) remover a exceção `compra_recente`; (j) `valor_giro` com `coalesce(sum,0)`. Cada uma tem que ficar vermelha pela asserção certa. Rodar nos 2 locales.
- [ ] **Step 7: `bun run lint:shell`** (exit 0) **e commit.**

### Task 2: Engine — estoque, CMV e PME honestos

**Files:**
- Create: `supabase/functions/fin-cashflow-engine/estoque-pme.ts`
- Create: `supabase/functions/fin-cashflow-engine/estoque-pme_test.ts`
- Modify: `supabase/functions/fin-cashflow-engine/index.ts` (~373-387 tipos de `dados`; ~425-480 leituras; ~1032-1055 `aco`; ~1125-1210 `Indicadores`/pme/ccc)
- Modify: `supabase/functions/fin-cashflow-engine/versao.ts` (via `sonda:bump`)

**Interfaces:**
- Consumes: `fin_estoque_giro_valor` (Task 1).
- Produces (exportados de `estoque-pme.ts`):
  - `type EstoqueResolvido = { valor: number | null; fonte: 'manual' | 'omie' | null; data_ref: string | null; motivos: string[] }`
  - `resolverEstoque(manual: { valor: number; data_ref: string } | null, omie: { valor_giro: number | null; skus_giro: number; cobertura_pct: number; valor_sem_classificacao: number } | null, hojeSP: string): EstoqueResolvido`
  - `cmvTtmFechado(linhas: Array<{ ano: number; mes: number; cmv: number | null }>, hojeSP: string): { valor: number | null; motivo: string | null }`
  - `calcularPme(estoque: number | null, cmvTtm: number | null, coberturaOk: boolean): number | null`
- `Indicadores.prazo_medio_estoque: number | null`; novos `estoque_valor: number | null`, `estoque_fonte: 'manual' | 'omie' | null`, `estoque_data_ref: string | null`. `ncg.aco.estoque: number | null`; `ncg.parcial: boolean` (true sse estoque null); `liquidez_operacional_liquida` continua number mas soma estoque só se não-null (o flag `ncg.parcial` cobre os dois). `cash_conversion_cycle` null se PME null.

- [ ] **Step 1: Testes Deno (falham).** `resolverEstoque` (recebe só linhas `fonte='manual'` — o `select` filtra): manual de 10 dias → fonte manual; manual com `data_ref` no futuro → ignorado; manual de 46 dias + omie → fonte omie; omie `valor_giro=null` → valor null; omie `skus_giro=0` e sem manual → valor null, motivo contém "Estoque indisponivel"; `cobertura_pct=90` → `valor` preservado mas `calcularPme` recebe flag e devolve null (assinatura: `calcularPme(estoque, cmvTtm, coberturaOk: boolean)`), motivo contém "sem custo"; `valor_sem_classificacao>0` → motivo com o R$. `cmvTtmFechado` com hoje 2026-10-18: 12 meses out/25–set/26 → soma; mesmas + out/26 → ignora out/26; 6 meses → null, motivo "6/12"; 12 linhas com um mês duplicado e um faltando → null; um `cmv` null → null; todos 0 → null, motivo "zerado". `calcularPme(null, x, true)`, `(x, null, true)`, `(1000, 3650, false)` → null; `(1000, 3650, true)` → 100. Run: `bun run test:edges` — FAIL (módulo não existe).
- [ ] **Step 2: Implementar `estoque-pme.ts`** (sem imports remotos — `--no-remote`).
- [ ] **Step 3: Ligar no `index.ts`:** leitura de `fin_estoque_valor` com `.eq('fonte','manual').lte('data_ref', hojeSP)` + `supabase.rpc('fin_estoque_giro_valor', { p_company })` dentro do mesmo `Promise.all`, ambas via `exigirLeitura`; motivos de `resolverEstoque` e `cmvTtmFechado` entram em `motivos_confianca`; `aco.total` soma estoque só se não-null e, se null, push "NCG sem estoque".
- [ ] **Step 4: Gates de edge, cada um com exit 0 colado:** `bun run test:edges`, `bun run edges:typecheck`, `bun run edges:sintaxe`, `heavy bun run test`, `bun run sonda:bump`, `bun run sonda:fingerprint -- --write`.
- [ ] **Step 5: Commit.**

### Task 3: App — PME/NCG aceitam null; diálogo usa a regra nova

**Files:**
- Modify: `src/hooks/useCashflowProjection.ts:46` (`prazo_medio_estoque: number | null`; novos campos de estoque; `aco.estoque: number | null`)
- Modify: `src/components/financeiro/cashflow/ciclo/CicloEmpresaCards.tsx` (PME null → "—" + motivo como PMR/PMP; legenda da fonte: "Omie, agora" / "manual, dd/mm")
- Modify: `src/components/financeiro/cashflow/NcgDecomposicao.tsx:45,142` (aviso quando `aco.estoque === null`; PME null → "—")
- Modify: `src/hooks/useEstoqueValor.ts` (`estimarEstoqueOmie` chama `fin_estoque_giro_valor` e devolve `valor_estimado = valor_giro`) e `ConfigCashflowDialog.tsx` (salvar grava sempre `fonte: 'manual'`; o "estimar" só preenche o campo)
- Test: `src/components/financeiro/cashflow/ciclo/__tests__/CicloTab.test.tsx` (fixture `prazo_medio_estoque: null` → texto "—", nunca "0d"); teste novo de `NcgDecomposicao` (`aco.estoque` null + `parcial` → texto "parcial — sem estoque"; 0 numérico → sem aviso)

- [ ] **Step 1: Testes (falham).** Run: `heavy bun run test -- ciclo NcgDecomposicao` — FAIL.
- [ ] **Step 2: Implementar.** `heavy bun run typecheck` aponta todo consumidor de `prazo_medio_estoque`/`aco.estoque`; corrigir cada um sem `?? 0`.
- [ ] **Step 3: `heavy bun run test` e `heavy bun run typecheck`** com exit 0. **Commit.**

### Task 4: Helper puro + hook paginado

**Files:**
- Create: `src/lib/financeiro/ciclo-giro-helpers.ts`, `src/lib/financeiro/__tests__/ciclo-giro-helpers.test.ts`
- Modify: `src/hooks/useFinanceiroCiclo.ts` (+ `useCicloGiroSku(company: Company)`, padrão de `useCicloCoorte`: `.rpc(...).select('*').order('valor_parado', { ascending: false, nullsFirst: false }).order('omie_codigo_produto').range(de, ate)` até página curta)
- Modify: `src/lib/modulos/manifesto.ts`

**Interfaces:**
- Produces:
  - `type GiroSkuRow` = colunas da RPC (Task 1), em snake_case como as outras rows do ciclo.
  - `resumirGiro(rows: GiroSkuRow[]): { valorGiro: number | null; skusSemCusto: number; valorLiquidar: number | null; valorExcedenteSegurar: number | null; valorForaGiro: number | null; valorSemClassificacao: number | null; temFonteConsumo: boolean }` — cada soma só de termos não-null; nenhum termo → null. Sem dias agregados (spec §5.4.5).
  - `separarListas(rows): { giro: GiroSkuRow[]; foraGiro: GiroSkuRow[] }` (`foraGiro` = `fora_giro` + `sem_classificacao`).
  - Constantes `LIMIAR_COBERTURA_ALVO_DIAS = 90`, `LIMIAR_SEGURAR_COMPRA_DIAS = 180`, `LIMIAR_GIRO_MORTO_DIAS_FIN = 270`.

- [ ] **Step 1: Testes (falham):** soma ignora null; tudo null → null (não 0); `temFonteConsumo=false` quando nenhuma linha giro tem `motivo_consumo` null; cmc 0 conta em `skusSemCusto`; fora do giro não entra em `valorGiro`; teste que lê a migration como texto e afirma `c_cobertura_alvo_dias CONSTANT int := 90`, `180`, `270` iguais às constantes TS; hook com mock de 1.460 linhas em 2 páginas devolve 1.460.
- [ ] **Step 2: Implementar. Step 3: `heavy bun run test` exit 0. Step 4: Commit.**

### Task 5: Seção `CicloGiroEstoque` na aba Ciclo

**Files:**
- Create: `src/components/financeiro/cashflow/ciclo/CicloGiroEstoque.tsx`, `__tests__/CicloGiroEstoque.test.tsx`
- Modify: `src/components/financeiro/cashflow/ciclo/CicloTab.tsx` (abaixo dos cards; um bloco por empresa de `tendencias`)
- Modify: `src/lib/modulos/manifesto.ts`

**Interfaces:** Consumes `useCicloGiroSku`, `resumirGiro`, `separarListas` (Task 4).

- Faixa de resumo: R$ em giro, R$ candidato a liquidar, R$ excedente em candidatos a segurar, R$ fora do giro, SKUs sem custo; sem fonte → "sem consumo por SKU (NF-e só da Oben)"; rótulo "cenário — não é previsão" e aviso "confira reservas, lead time e demanda contratada antes de agir".
- Tabela de giro: filtro de ação via `useUrlState` (chave `cicloGiroAcao`: `todos|liquidar|segurar_compra`), top 50 + "ver todos", colunas: código, descrição, saldo, R$ parado, cobertura (qtd, dias), dias sem saída, R$ excedente, "Candidato a liquidar"/"Candidato a segurar compra"; null → "—" com tooltip do motivo.
- Lista "Fora do giro": recolhida, cabeçalho com total; colunas tipo, família, saldo, R$, selo "conferir cadastro" se `divergencia_cadastro`.
- `track('financeiro.ciclo_giro_visto', { empresa })` uma vez por empresa; `track('financeiro.ciclo_giro_filtro', { acao })`.
- Loading `<PageSkeleton variant>`; vazio `<EmptyState tone="operational">`; erro visível (não lista vazia).

- [ ] **Step 1: Testes (falham):** colacor sem fonte → "—" e texto "sem consumo por SKU"; nenhum "0d"/"R$ 0,00" para null; filtro liquidar mostra só liquidar; fora do giro mostra selo; rótulo de cenário presente; erro da query renderiza mensagem.
- [ ] **Step 2: Implementar. Step 3: `heavy bun run test`, `heavy bun run typecheck`, `bun lint`, `bun run gates:rapidos` exit 0. Step 4: Commit.**

### Task 6: Codex do diff, aplicar, deployar, validar, PR

- [ ] **Step 1:** `/codex` review do diff via `scripts/codex-async.sh` em background; tratar P0/P1.
- [ ] **Step 2:** Abrir PR (não-draft só depois do Step 5; antes, **draft**), corpo com "⚠️ migration manual", números antes/depois de PME e NCG por empresa, bug latente de `useBaixoGiro.ts:44` citado.
- [ ] **Step 3:** Aplicar a migration pela skill `lovable-db-operator` (envelope, pré-voo 🟢, validação por fora) + `bun run audit:migrations`.
- [ ] **Step 4:** Deploy da edge via `bun run pendencias:deploy` / `pendencias:pacote`.
- [ ] **Step 5: Validação em prod (psql-ro), colada no PR:** 3–5 SKUs oben recalculados à mão (saldo, cmc, consumo 365d na `v_sku_demanda_efetiva`, dias); `fin_estoque_giro_valor` por empresa vs soma manual; PME colacor = valor_giro / Σcmv(out/25–set/26) × 365; tempo de `fin_ciclo_giro_sku('colacor')` sob `SET ROLE authenticated` + claims do master < 2 s.
- [ ] **Step 6:** Registrar em `docs/historico/ciclo-financeiro-cliente.md` (frente 3) e lição em `docs/agent/financeiro.md` (estoque de giro = classe SPED+família; `fin_estoque_valor` só override). Tirar do draft; Auto-fix ligado.
- [ ] **Step 7:** Após merge e Publish do founder: `lovable-deploy-verify` (`monitor-deploy.sh --pr <n>`).
