# Ciclo — PMP por fornecedor e custo do prazo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seção "Fornecedores (compras)" na aba Ciclo (master) com PMP por fornecedor, R$/dia sobre compras, desconto de pontualidade obtido/perdido (cenário), juros+multa pagos e fila "onde o prazo está custando".

**Architecture:** 1 migration de FATOS (views `security_invoker=on`) + RPCs SECURITY DEFINER com gate master, provada em PG17 nos 2 locales. A regra (taxa, regime, cenário, fila, tendência) é TS puro em `ciclo-fornecedor-helpers.ts`. Hook com paginação e componentes na aba Ciclo.

**Tech Stack:** Postgres 17 (prova local), Supabase RPC/PostgREST, React 18 + TS strict, react-query, vitest, shadcn.

**Spec:** `docs/superpowers/specs/2026-10-18-ciclo-pmp-fornecedor-design.md` (ler §3, §4 e §8 antes de qualquer task).

## Global Constraints

- Só master. RPCs: `PERFORM public._fin_ciclo_gate_master()` e depois `fin_user_can_access(company)` sobre linhas já agregadas. `REVOKE ALL … FROM PUBLIC, anon`; `GRANT EXECUTE … TO authenticated, service_role`; postcondição embutida com marcador positivo.
- Toda view com `WITH (security_invoker=on)`; `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `GRANT SELECT TO service_role` só (spec §9 #9). A postcondição afirma `NOT has_table_privilege('authenticated', …)`.
- Universo de compras: lista literal (empresa, código) da spec §4.1, **nunca** prefixo.
- Ausente ≠ zero. `NULL` do resumo nunca vira 0. Os guards de finitude (`<> 'NaN'`, `< 'Infinity'`) vêm de `v_ciclo_cr_titulos`.
- Caixa nunca somado entre empresas; a UI é sempre por empresa.
- Todo R$ que não é apurado leva o rótulo `cenário`. Nenhuma copy sugere "pedir/negociar mais prazo".
- Pontualidade e PMP de compras só com `fonte_data_baixa = 'omie_data_pagamento'` (spec §9 #4/#6). A data da CC nunca decide atraso; `v_titulo_baixas` não entra no PMP de compras.
- Taxa observada (spec §9 #2): ≥ 5 **documentos** com desconto nos últimos 180 d do regime, P20–P80 dentro de ±0,5 p.p. da mediana, ≥ 80% deles pagos com atraso ≤ 0. Regime: vencimento do 1º de ≥ 3 documentos com desconto dentro de 90 d. Perdido = `max(taxa·base − descontoInformado, 0)` só com `descontoInformado` conhecido.
- Toast `sonner`, `track('financeiro.ciclo_fornecedor_<acao>')`, `text-status-*`, `<PageSkeleton>`, `<EmptyState tone="operational">`, `useUrlState` para filtro e ordenação.
- PostgREST capa em 1.000 linhas, inclusive em `.rpc()` → `.range()` + `.order` estável (padrão `useCicloCoorte`).
- Arquivo novo em `src/` precisa de dono no `src/lib/modulos/manifesto.ts`: os globs `src/lib/financeiro/**`, `src/components/financeiro/**` e `src/hooks/useFinanceiro*.ts` já cobrem. **Teste de hook** novo vai na lista `testes` do módulo financeiro (como `src/hooks/__tests__/useFinanceiroCiclo.test.tsx`).
- **Desvio da spec, decidido aqui:** a coorte mensal (§4.2 item 4) e a taxa/regime saem dos TÍTULOS no TS, não de uma view `v_ciclo_fornecedor_coorte`. A regra fica num lugar só, e a RPC de títulos já é paginada. Registrar no PR.

## Review Focus

1. **Fornecedor com 1 título só, de desconto (ex.: compra pontual):** não há taxa, não há R$ perdido e o selo é "baixa". Teste em T4 (`taxaDescontoObservada` com 1 título → `taxa: null`).
2. **Mês corrente na tendência:** o valor "em aberto" do mês ainda não venceu inteiro. Precisa sair marcado como parcial, nunca "piora". Teste em T4 (`pontualidadePorMes` com `hoje` no meio do mês → `mesParcial: true`).
3. **Empresa sem compras (colacor_sc):** a seção mostra `EmptyState` com o motivo, sem cards zerados. Teste em T6.
4. **Título pago antes da emissão (prazo concedido negativo):** entra na média e no contador; a ponderação não divide por zero quando todos são negativos ou zero. Teste em T4.
5. **Resumo não lido (`resumo_lido_em` NULL) num título pago:** o desconto fica `null`; o título fica fora do numerador **e** do denominador da cobertura de decisão; não conta como "pago em dia sem desconto". Teste em T2 (SQL) e T4 (TS).

---

### Task 1: `v_titulo_encargos_cp` (espelho do CR) + esqueleto da prova PG17

**Files:**
- Create: `supabase/migrations/20261018150000_fin_ciclo_fornecedor.sql` (seção 1)
- Create: `db/test-fin-ciclo-fornecedor.sh` (molde: `db/test-fin-ciclo-rpc.sh` + `db/test-fin-encargos-titulo.sh`)

**Interfaces:**
- Produces: view `public.v_titulo_encargos_cp`. Colunas, nesta ordem:
  `company, omie_codigo_lancamento, omie_codigo_cliente_fornecedor, numero_documento, data_emissao, data_vencimento, valor_documento, status_titulo, tipo_documento, versoes_titulo int, n_baixas int, soma_baixas, data_baixa date, fonte_data_baixa text, dias_atraso int, identidade_ok bool, valor_pago_principal, valor_liquido_pago, desconto_informado_omie, valor_aberto_informado, encargo_pago, desconto_obtido, diferenca_caixa_documento, fonte, confianca text, resumo_lido_em`.

Regras (diferenças em relação ao `v_titulo_encargos_cr`, todo o resto idêntico):
- ótica do título `categoria_descricao='CONTA_A_PAGAR'`; baixa `categoria_descricao='CONTA_CORRENTE_PAG' AND natureza IN ('BAXP','APBP') AND tipo='S'`;
- a base cobre **todo título não CANCELADO** (o CR cobria só quitados). `quitado`/`alta` exigem `status_titulo IN ('PAGO','LIQUIDADO')`;
- `desconto_informado_omie` = `resumo_desconto` quando `identidade_ok`, independente do caixa: é a evidência de taxa (spec §8);
- `valor_aberto_informado` = `resumo_val_aberto` quando `identidade_ok` e (`valor_titulo` NULL ou `pago+aberto = valor_titulo` ± 0,01);
- `encargo_pago`/`desconto_obtido` só em confiança `alta | erp_sem_caixa | erp_nao_quitado`.

- [ ] **Step 1: Prova.** Monte a prova com `preparar_banco` (stubs de `fin_contas_pagar`, `fin_movimentacoes` com as colunas `resumo_*`, `auth.uid`, `user_roles`, `fin_user_can_access`, `purchase_orders_tracking` com `empresa` de tipo enum `empresa_reposicao` em maiúsculas, `omie_clientes_nao_vinculados`, `fornecedor_omie_cache`, `v_titulo_baixas` real copiado da prod), o laço `suite()`, o CONTROLE VERDE antes do 1º `sed` e o `LOCALE`. Asserções da seção `encargos_cp`:
  - `T12182935508`: BAXP 17261.40 sem nCodBaixa em 09-15 + BAXP 16916.17 com nCodBaixa em 09-16 e resumo (pago 17261.40, desconto 345.23, liquido 16916.17, aberto 0, liquidado) → `n_baixas=2`, `confianca='divergente'`, `desconto_obtido IS NULL`, `desconto_informado_omie=345.23`;
  - título em dia com desconto, caixa batendo → `alta`, `desconto_obtido=119.16` (5958.04 → 5838.88);
  - resumo NULL → `desconto_obtido IS NULL` e `confianca='so_diferenca_caixa'` ou `sem_dado`, nunca 0;
  - título ATRASADO com resumo aberto 500 de 500 → `valor_aberto_informado=500`.
- [ ] **Step 2:** Rode `bash db/test-fin-ciclo-fornecedor.sh` → esperado FAIL (a view não existe).
- [ ] **Step 3:** Escreva a seção 1 da migration (BEGIN, view, grants; a postcondição vai no fim, na T3).
- [ ] **Step 4:** Rode a prova → PASS nas asserções `encargos_cp`. Rode também com `LOCALE=pt_BR.UTF-8`. Exit 0 colado.
- [ ] **Step 5:** Commit `feat(ciclo): v_titulo_encargos_cp — espelho CP do encargo/desconto por título [money-path]`.

### Task 2: fatos de compras — `v_ciclo_cp_titulos` e `v_ciclo_fornecedor_resumo`

**Files:** Modify: a migration (seção 2) e a prova (seção `fatos`).

**Interfaces:**
- Consumes: `v_titulo_encargos_cp` (T1), `v_titulo_baixas`.
- Produces:
  - `public.v_ciclo_cp_compras_categorias(company text, categoria_codigo text)`: lista literal da spec §4.1.
  - `public.v_ciclo_cp_titulos`. Colunas: `company, omie_codigo_fornecedor bigint, omie_codigo_lancamento, numero_documento, categoria_codigo, data_emissao, data_vencimento, data_baixa, fonte_data_baixa, data_baixa_confiavel bool, valor_documento, valor_aberto, fonte_valor_aberto text ('omie_resumo'|'valor_titulo'), situacao text, prazo_concedido_dias int, prazo_real_dias numeric, dias_atraso_baixa int, desconto_obtido, desconto_informado_omie, valor_pago_principal, encargo_pago, confianca_encargo text, dias_vencido int`.
  - `situacao`:
    - `paga`: baixa e status PAGO/LIQUIDADO, vencimento em [hoje_sp−365, hoje_sp);
    - `paga_parcial`: baixa e `valor_aberto_informado > 0`, qualquer idade;
    - `paga_sem_baixa`: PAGO sem baixa, na janela;
    - `vencida_aberta`: sem baixa e (ATRASADO, ou A VENCER/VENCE HOJE com vencimento < hoje_sp);
    - `a_vencer`: aberto com vencimento ≥ hoje_sp;
    - `status_ambiguo`: status fora de {PAGO, LIQUIDADO, A VENCER, VENCE HOJE, ATRASADO, CANCELADO}.
  - `valor_aberto` = `valor_aberto_informado` se não NULL, senão `valor_documento` (aberto/parcial); NULL em `paga`.
  - `data_baixa_confiavel` = `fonte_data_baixa = 'omie_data_pagamento'`. `dias_atraso_baixa` = `data_baixa − data_vencimento` só se confiável; senão NULL.
  - `prazo_real_dias` = `data_baixa − data_emissao` só se confiável (NÃO `v_titulo_baixas`, spec §9 #6).
  - `paga_parcial` = `n_baixas > 0` com status aberto (ATRASADO/A VENCER/VENCE HOJE) ou `valor_aberto_informado > 0`. O remanescente vai para `valor_vencido_aberto` se vencimento < hoje_sp, senão para `valor_a_vencer`.
  - Nome: CTE `nomes` com **uma** linha por (company, fornecedor), `max()` por fonte, ANTES do join. Asserção de invariância: `sum(compras_12m)` com e sem o join de nome é igual.
  - `public.v_ciclo_fornecedor_resumo`. Colunas: `company, omie_codigo_fornecedor, nome_fornecedor, fonte_nome text ('pedido_compra'|'cadastro_omie'|'cache_fornecedor'|NULL), compras_12m, n_titulos_12m int, n_documentos_pagos int, valor_pago, prazo_concedido_pond, prazo_real_pond, atraso_pond_sinal, atraso_pond_pos, n_prazo_negativo int, valor_pago_em_dia, valor_pago_atrasado, valor_pago_data_incerta, valor_pago_conf_decisao, desconto_obtido_12m, encargo_pago_12m, n_titulos_com_desconto int, valor_vencido_aberto, n_vencidas int, dias_vencido_max int, valor_a_vencer, n_status_ambiguo int`.
  - `compras_12m`: soma de `valor_documento` por **emissão** em [hoje_sp−365, hoje_sp), base válida, sem CANCELADO.
  - Nome em cascata da spec §4.2 item 3; `purchase_orders_tracking` casado por `lower(empresa::text)=company`.

- [ ] **Step 1: Asserções da seção `fatos`:**
  - 2.01.99 da colacor (imobilizado) fora; 2.01.97 da colacor dentro; 2.01.97 da oben fora;
  - CC liquidando D+1 com `data_pagamento_omie` = vencimento → `dias_atraso_baixa=0`;
  - título só com data de CC **ou** só `titulo_data_movimento` → `data_baixa_confiavel=false`, `dias_atraso_baixa IS NULL`, entra em `valor_pago_data_incerta`;
  - fornecedor com 10 pedidos em `purchase_orders_tracking` → `compras_12m` sem multiplicar;
  - ATRASADO com BAXP parcial antes do vencimento → `paga_parcial`, remanescente em `valor_a_vencer`; depois do vencimento → em `valor_vencido_aberto`;
  - `authenticated` sem SELECT direto nas views novas;
  - PAGO com `saldo = valor_documento` → `situacao='paga'`, `valor_aberto IS NULL`;
  - prazo negativo → `n_prazo_negativo=1` e entra no `prazo_concedido_pond`;
  - resumo NULL num pago → fora de `valor_pago_conf_decisao`;
  - nome pela cascata: pedido_compra > cadastro_omie > cache; sem nenhum → `nome_fornecedor IS NULL`.
- [ ] **Step 2:** Rode → FAIL.
- [ ] **Step 3:** Implemente a seção 2 (molde: o CTE `chaves` + `LEFT JOIN … USING` do `v_ciclo_cliente_resumo`).
- [ ] **Step 4:** Rode nos 2 locales → PASS. Exit 0 colado.
- [ ] **Step 5:** Commit `feat(ciclo): fatos de compras por título e por fornecedor [money-path]`.

### Task 3: RPCs com gate + controle do engine + falsificação

**Files:** Modify: a migration (seção 3 + postcondição) e a prova (seções `gate` e `falsificar`).

**Interfaces:**
- Produces:
  - `public.fin_ciclo_cp_titulos() RETURNS SETOF public.v_ciclo_cp_titulos`;
  - `public.fin_ciclo_fornecedor_resumo() RETURNS SETOF public.v_ciclo_fornecedor_resumo`;
  - `public.fin_ciclo_cp_empresa() RETURNS TABLE(company text, pmp_compras_pond numeric, compras_12m numeric, rs_por_dia numeric, pmp_engine_controle numeric, n_fora_lista int, valor_fora_lista numeric, n_sem_categoria int, valor_sem_categoria numeric)`.
- `pmp_engine_controle` = `round(sum(prazo_ponderado_dias*valor_baixado)/nullif(sum(valor_baixado),0))` sobre `v_titulo_baixas WHERE tipo='CP' AND prazo_ponderado_dias IS NOT NULL` (fórmula do `v_capital_giro_prazos`).
- `pmp_compras_pond` = prazo real ponderado por `valor_documento` das `paga` de compras.
- `rs_por_dia` = `compras_12m/365`, NULL se `compras_12m` for NULL ou ≤ 0.
- "Fora da lista" = 2.01.* não listado; "sem categoria" = `categoria_codigo` NULL ou `''` (janela de vencimento de 12m).

- [ ] **Step 1: Asserções `gate`** (padrão `db/test-fin-ciclo-rpc.sh`):
  - sem claims → `42501 CICLO_SO_MASTER`;
  - employee → 42501;
  - master com permissão só oben → zero linhas colacor;
  - `has_function_privilege('anon', …)` = false nas 3;
  - `_fin_ciclo_gate_master` sem EXECUTE para authenticated.
- [ ] **Step 2: Sabotagens no laço**, sobre cópia, uma camada por vez, cada uma exigindo vermelho com a marca do ramo:
  - (a) tirar o `PERFORM _fin_ciclo_gate_master()`;
  - (b) tirar o filtro `fin_user_can_access`;
  - (c) `security_invoker=off` no `v_ciclo_cp_titulos`;
  - (d) dedup de baixa sem a camada `nCodBaixa`;
  - (e) data de baixa pela CC primeiro;
  - (f) `coalesce(resumo_desconto,0)`;
  - (g) prefixo `LIKE '2.01%'` no lugar da lista;
  - (h) tirar o anon do REVOKE + neutralizar a postcondição.
- [ ] **Step 3:** Rode → FAIL. Implemente a seção 3 + postcondição (`RAISE NOTICE 'CICLO-FORNECEDOR-OK'`), `COMMIT;`.
- [ ] **Step 4:** Commit **antes** de falsificar; depois rode `bash db/test-fin-ciclo-fornecedor.sh` e `LOCALE=pt_BR.UTF-8 …`. Esperado: controle verde, 8/8 sabotagens vermelhas, exit 0 nos dois locales (colados).
- [ ] **Step 5:** Registre a prova no `test:hooks` / `package.json`, seguindo o lugar onde `test-fin-ciclo-rpc.sh` está. Commit `test(ciclo): prova PG17 da frente 4 com falsificação [money-path]`.

### Task 4: regra pura `ciclo-fornecedor-helpers.ts`

**Files:**
- Create: `src/lib/financeiro/ciclo-fornecedor-helpers.ts`
- Test: `src/components/financeiro/cashflow/ciclo/__tests__/ciclo-fornecedor-helpers.test.ts`

**Interfaces:**
- Consumes: `num()` e `porDia()` de `ciclo-cliente-helpers.ts`.
- Produces:
  ```ts
  export type SituacaoCp = 'paga'|'paga_parcial'|'paga_sem_baixa'|'vencida_aberta'|'a_vencer'|'status_ambiguo';
  export type TituloCp = { company: string; fornecedor: number; lancamento: number; documento: string|null;
    emissao: string; vencimento: string; dataBaixa: string|null; dataBaixaConfiavel: boolean;
    valor: number; valorAberto: number|null; situacao: SituacaoCp; prazoConcedido: number;
    prazoReal: number|null; atrasoBaixa: number|null; descontoObtido: number|null;
    descontoInformado: number|null; valorPagoPrincipal: number|null; encargoPago: number|null; diasVencido: number|null };
  export type ResumoFornecedor = { /* camelCase 1:1 das colunas de v_ciclo_fornecedor_resumo; numéricos number|null */ };
  export function normalizarTituloCp(row: Record<string, unknown>): TituloCp;
  export function normalizarResumoFornecedor(row: Record<string, unknown>): ResumoFornecedor;
  export function taxaDescontoObservada(titulos: TituloCp[], regimeInicio: string|null): { taxa: number|null; nDocumentos: number; motivo: 'amostra'|'dispersao'|'nao_pontualidade'|'sem_regime'|null };
  export function inicioRegimeDesconto(titulos: TituloCp[]): string|null;   // 'YYYY-MM-01'
  export type CustoPrazo = { taxa: number|null; regimeInicio: string|null; perdidoAtraso: number|null;
    perdidoEmDiaSemDesconto: number|null; encargoPago: number|null; descontoObtido: number|null };
  export function custoDoPrazo(titulos: TituloCp[], resumo: ResumoFornecedor): CustoPrazo;
  export function filaCustoPrazo(itens: Array<{ resumo: ResumoFornecedor; custo: CustoPrazo }>): Array<{ resumo: ResumoFornecedor; custo: CustoPrazo; totalRs: number }>;
  export type PontualidadeMes = { mes: string; valorVencido: number; pctEmDia: number|null; pctAtrasado: number|null; valorAberto: number; mesParcial: boolean };
  export function pontualidadePorMes(titulos: TituloCp[], hoje: string): PontualidadeMes[];
  export function confiancaFornecedor(r: ResumoFornecedor): 'media'|'baixa';
  ```
  - `taxaDescontoObservada`: agrupa por **documento** (`documento ?? 'l:'+lancamento`), com razão = Σdesconto/Σprincipal do documento; amostra = documentos com desconto > 0 e vencimento em [max(regimeInicio, hoje−180), hoje); mediana; P20/P80 por interpolação linear (igual `percentile_cont`); exige ≥ 80% da amostra com `atrasoBaixa ≤ 0`.
  - `custoDoPrazo`: só títulos `paga` com `vencimento ≥ regimeInicio`, `dataBaixaConfiavel` e `descontoInformado !== null`. `perdidoAtraso` = Σ `max(taxa·base − descontoInformado, 0)` dos com `atrasoBaixa > 0`; `perdidoEmDiaSemDesconto` = mesma conta nos com `atrasoBaixa ≤ 0`. Base = `valorPagoPrincipal ?? valor`. Taxa ou regime `null` → os dois `null`.
  - `filaCustoPrazo`: `totalRs = (perdidoAtraso ?? 0) + (encargoPago ?? 0)`, mas o item entra **só** se ao menos um dos dois não for `null` e `totalRs > 0`. Ordena por `totalRs` desc e desempata por `valorVencidoAberto` desc. `perdidoEmDiaSemDesconto` não entra no total (é "conferir boleto").
  - `confiancaFornecedor`: 'baixa' se `nDocumentosPagos < 6` ou `valorPagoConfDecisao/valorPago < 0.8` (ou `valorPago` null/0).

- [ ] **Step 1: Testes** (valores exatos):
  - 6 documentos a 2% em dia → `{taxa: 0.02, nDocumentos: 6, motivo: null}`; 3 parcelas da MESMA NF → `nDocumentos: 1`, `motivo: 'amostra'`; 6 entre 1% e 3% → `'dispersao'`; 6 a 2% com 3 atrasados → `'nao_pontualidade'`; 1 título (Review Focus 1) → `taxa: null`; `regimeInicio null` → `'sem_regime'`;
  - regime: 1 documento com desconto em 2026-03-10 + 3 com vencimento em 2026-07-14/21/28 → `'2026-07-14'` (não o dia 1 do mês);
  - perdido já obtido (Codex #1): título atrasado R$ 10.000 com `descontoInformado = 200` e taxa 2% → contribui 0;
  - custo: título de 2026-05 atrasado (antes do regime) não entra; título de 2026-08 com 2 d de atraso, R$ 10.000 e `descontoInformado = 0` → `perdidoAtraso = 200`; título em dia com `descontoInformado = 0` e R$ 5.000 → `perdidoEmDiaSemDesconto = 100` e fora do `totalRs`; `dataBaixaConfiavel=false` não entra;
  - resumo NULL (Review Focus 5): `descontoInformado null` em dia → não conta como "em dia sem desconto";
  - fila: fornecedor sem taxa e sem encargo fica fora; empate desempatado por vencido;
  - `pontualidadePorMes` com `hoje='2026-10-18'` → out/2026 com `mesParcial: true` (Review Focus 2); `% em dia` só com data confiável;
  - prazo negativo (Review Focus 4) entra na média sem quebrar nada.
- [ ] **Step 2:** `heavy bun run test src/components/financeiro/cashflow/ciclo/__tests__/ciclo-fornecedor-helpers.test.ts` → FAIL.
- [ ] **Step 3:** Implemente.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Commit `feat(ciclo): regra pura do custo do prazo por fornecedor [money-path]`.

### Task 5: hook `useFinanceiroCicloFornecedor.ts`

**Files:**
- Create: `src/hooks/useFinanceiroCicloFornecedor.ts`
- Test: `src/hooks/__tests__/useFinanceiroCicloFornecedor.test.tsx` (registrar em `testes` do módulo financeiro no `manifesto.ts`)

**Interfaces:**
- Produces:
  - `useCicloCpTitulos(): UseQueryResult<TituloCp[]>`, `useCicloFornecedorResumo(): UseQueryResult<ResumoFornecedor[]>`, ambos paginados com `.range()` e `.order('company').order(<chave>)`;
  - `useCicloCpEmpresa(): UseQueryResult<Record<Company, CpEmpresa | undefined>>`, com `CpEmpresa = { pmpComprasPond: number|null; compras12m: number|null; rsPorDia: number|null; pmpEngineControle: number|null; nForaLista: number; valorForaLista: number|null; nSemCategoria: number; valorSemCategoria: number|null }`;
  - `queryKey`s `['ciclo','cp-titulos']`, `['ciclo','fornecedor-resumo']`, `['ciclo','cp-empresa']`.
- [ ] **Step 1:** Teste no molde de `useFinanceiroCiclo.test.tsx`: 1.000 + 3 linhas → 1.003 normalizadas; erro de RPC propaga (`isError`), sem array vazio fabricado.
- [ ] **Step 2:** FAIL → implemente → PASS (`heavy bun run test src/hooks/__tests__/useFinanceiroCicloFornecedor.test.tsx`).
- [ ] **Step 3:** Rode `bun run manifesto:gate` (ou o nome real em `package.json`) → exit 0. Commit.

### Task 6: UI — seção Fornecedores + linha no card de empresa

**Files:**
- Create: `src/components/financeiro/cashflow/ciclo/CicloFornecedoresSecao.tsx` (KPIs + fila + tabela + rodapé), `CicloFornecedorDrill.tsx` (títulos do fornecedor, filtrados do hook de títulos), `CicloPontualidade.tsx` (tendência)
- Modify: `CicloTab.tsx` (render da seção após `CicloDescontoPainel`, usando a empresa já selecionada na aba), `CicloEmpresaCards.tsx` (prop `cpEmpresa?: CpEmpresa`)
- Test: `__tests__/CicloFornecedores.test.tsx`, `__tests__/CicloTab.test.tsx` (ajuste)

**Copy fixa (spec):**
- card: `PMP de compras: {X} d · pagar 1 dia antes consome ≈ {R$ Y} de caixa; 1 dia depois retém ≈ {R$ Y} · cenário`;
- tooltip: `O PMP acima inclui imposto, empréstimo e folha; o de compras não.`;
- fila: título `Onde o prazo está custando`;
- linha: `pago em dia sem desconto — conferir boleto`;
- rótulo `cenário` em todo R$ perdido;
- desconto observado: `desconto de pontualidade observado: {X}% ({n} NFs)`;
- fila: três blocos — `custo apurado`, `sem evidência ({n})`, `conferir boleto`.

- [ ] **Step 1: Testes:**
  - empresa sem compras → `EmptyState` com o motivo e zero cards de R$ (Review Focus 3);
  - fornecedor sem nome → `#<código>`;
  - nenhum texto contém `/prazo maior|negociar prazo|pedir prazo/` (regex ASCII, caixa fixa);
  - R$ perdido acompanhado de `cenário`;
  - `track('financeiro.ciclo_fornecedor_secao')` ao montar e `track('financeiro.ciclo_fornecedor_drill')` ao abrir;
  - card com `cpEmpresa.rsPorDia = null` mostra `—`.
- [ ] **Step 2:** FAIL → implemente → PASS (`heavy bun run test src/components/financeiro/cashflow/ciclo`).
- [ ] **Step 3:** `heavy bun run typecheck` e `bun run lint` → exit 0. Commit `feat(ciclo): seção Fornecedores (compras) na aba Ciclo`.

### Task 7: pré-voo em prod, Codex, diário e PR

- [ ] **Step 1: Pré-voo psql-ro** (só leitura). Rode os SELECTs das views como CTEs inline e cole os resultados no PR:
  - controle engine 32/5/12;
  - PMP compras por empresa;
  - top 10 da fila;
  - Sayerlack: taxa, regime, perdido;
  - sensor de categoria.
  Divergência engine × compras explicada pelo universo.
- [ ] **Step 2: `/codex` review** da migration + helpers via `scripts/codex-async.sh` em background. Parecer CRU + calibração separada no PR.
- [ ] **Step 3:** `heavy bun run test`, `heavy bun run typecheck`, `bun run gates:rapidos` → exit 0 colado.
- [ ] **Step 4:** Diário `docs/historico/ciclo-financeiro-cliente.md` (seção "Frente 4") e lição em `docs/agent/financeiro.md` §Ciclo:
  - saldo do CP = valor até em PAGO;
  - desconto de pontualidade em `resumo_desconto`;
  - códigos de categoria variam por empresa.
- [ ] **Step 5:** Re-conferir `origin/main` + `gh pr list` + `git grep v_titulo_encargos_cp origin/main`. Abrir o PR (título com `[money-path] (⚠️ migration manual)`), ligar Auto-fix.

### Task 8: aplicar a migration (envelope) e verificar

- [ ] **Step 1:** Skill `lovable-db-operator`: pré-voo 🟢, `pg_get_viewdef` de que nada com esses nomes existe em prod, apply idempotente e transacional com `-v ON_ERROR_STOP=1` e marcador `CICLO-FORNECEDOR-OK`.
- [ ] **Step 2:** Validação por fora:
  - `security_invoker` nas views;
  - `has_function_privilege` anon=false;
  - tempo de cada RPC sob `SET ROLE authenticated` + claims do master < 2 s.
- [ ] **Step 3:** Após o merge, o founder faz o Publish → `lovable-deploy-verify` (`monitor-deploy.sh --pr <n>`).
