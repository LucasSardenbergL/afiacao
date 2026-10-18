# Giro de estoque por SKU — frente 3 do painel de ciclo financeiro

> Spec da frente 3 adiada em `2026-10-14-ciclo-financeiro-cockpit-cliente-design.md` §10. Aba "Ciclo" (master) de `/financeiro/capital-giro?aba=ciclo`. Money-path.

## 1. Por que

O founder abre a aba Ciclo para decidir **onde o caixa está preso no estoque** e agir de dois jeitos:

1. **Segurar compra** — SKU com estoque demais para o que gira.
2. **Liquidar** — SKU que parou de girar (ou nunca girou) e tem saldo.

Hoje o card mostra **PME 0d** nas 3 empresas. Isso é ausente lido como zero (proibido no money-path) e esconde exatamente o número que motiva a frente.

### 1.1 Diagnóstico do PME = 0d (medido em prod, 2026-10-18, psql-ro)

`fin-cashflow-engine` (`index.ts` ~468 e ~1162):

```ts
const estoque_valor = Number(estoqueRow?.valor ?? 0);           // linha ausente → 0
const pme = dados.cmv_ttm > 0 ? (estoque_valor / cmv_ttm) * 365 : 0;   // sem CMV → 0
```

- **Numerador ausente:** `fin_estoque_valor` tem **0 linhas** em prod. Só é escrita à mão pelo `ConfigCashflowDialog` (com botão "estimar pelo Omie" → RPC `fin_estimar_estoque_omie`); ninguém nunca gravou. Está em `tabelas-jamais-escritas.txt`.
- **O mesmo zero entra na NCG** (`ncg.aco.estoque`): a NCG das 3 empresas omite o estoque inteiro. A `NcgDecomposicao` avisa ("Estoque não informado"), o card de PME da aba Ciclo não.
- **Denominador também está furado** (`cmv_ttm` = soma do CMV de `fin_dre_snapshots` competência nos últimos 12 meses, incluindo o mês corrente parcial):
  - oben: DRE só tem 2025-10..2026-03 → 6 meses na janela, último mês há 6 meses.
  - colacor_sc: CMV **gravado 0** nos 6 meses existentes.
  - colacor: 12 meses, mas a janela inclui o mês corrente parcial.
  - Corrigir só o numerador produziria PME errado (oben dividindo estoque de hoje por meio ano de CMV antigo → PME ~2× inflado).

Fonte real do estoque: `inventory_position` (saldo × `cmc` do Omie, sync a cada 30–60 min). Em prod hoje: oben (account `vendas`) 793 SKUs com saldo, Σ ≈ R$ 505 mil · colacor (`colacor_vendas`) 1460, ≈ R$ 2,79 mi · colacor_sc (`servicos`) 50, ≈ R$ 38 mil. `cmc` NULL com saldo>0: 0 em todas; `cmc = 0`: 8 SKUs.

### 1.2 O "estoque" do Omie não é todo estoque de giro

`omie_products.tipo_produto` segue o tipo de item SPED. Σ saldo×cmc com saldo>0 (prod, 2026-10-18):

| tipo | colacor (`colacor_vendas`) | oben (`vendas`) |
|---|---|---|
| 08 ativo imobilizado | **R$ 1.477 mil** (198 SKUs: máquinas, dispensador…) | R$ 50 mil |
| 07 uso e consumo | R$ 199 mil (gasolina etc.) | R$ 8 mil |
| 00 revenda · 01 MP · 03 em processo · 04 acabado | R$ 1.070 mil | R$ 446 mil |
| 99 outras | R$ 42 mil | R$ 0,2 mil |

`servicos` (colacor_sc) não tem `product_id` → sem `tipo_produto`. Somar 07/08 no estoque infla PME e NCG (colacor: PME ~4.000 dias com tudo; ~1.550 só com giro — ainda alto, mas é o dado).

## 2. Objetivos

- **G1.** PME por empresa honesto: número quando há base, **"—" + motivo** quando não há. Nunca 0 por ausência.
- **G2.** NCG passa a incluir o estoque real (consequência de G1 — mesma variável).
- **G3.** Lista de SKUs por empresa ordenada por **R$ parado**, com dias de cobertura, dias sem venda, R$ acima da cobertura-alvo e etiqueta de ação (`segurar_compra` | `liquidar`).
- **G4.** Resumo por empresa da seção: R$ em giro (com cobertura de custo), R$ candidato a liquidar, R$ excedente em candidatos a segurar compra, R$ fora do giro. **Sem** "dias de estoque pela saída" agregado (removido pós-Codex, §5.4).

## 3. Não-objetivos

- PMP por fornecedor (frente 4).
- Executar compra/liquidação pela tela; alterar parâmetros de reposição.
- Trazer itens de NF-e da Colacor (`omie-sync-vendas-items` com `empresa: COLACOR`) — outra sessão. Quando os dados chegarem, a seção acende sozinha (§5.2).
- Consertar o DRE da oben parado em 2026-03 nem o CMV 0 da colacor_sc — outra sessão (é bug de sync financeiro, não desta frente).
- Consertar o bug latente de `useBaixoGiro.ts:44` (`account = 'colacor'` não existe) — fora; registrado no PR.

## 4. Anti-objetivos (falha mesmo funcionando)

- Qualquer 0 que signifique "não sei" (PME, dias de cobertura, R$ de SKU sem custo).
- Somar R$ entre empresas, inclusive num "consolidado".
- Mostrar número de giro para colacor/colacor_sc fabricado a partir de **pedidos** (`sales_orders` ≠ faturamento).
- R$ sem o rótulo "cenário — não é previsão".

## 5. Desenho

### 5.0 Estoque de giro — uma regra, um lugar

Função SQL nova `fin_estoque_giro_valor(p_company text)` (SECURITY DEFINER, mesmo gate de `fin_estimar_estoque_omie`: service_role ou `private.cap_custo_ler`), retorna `valor_giro, valor_fora_giro, valor_sem_classificacao, skus_giro, skus_giro_com_custo, cobertura_pct`.

- **Fora do giro** = `tipo_produto` ∈ {07 uso e consumo, 08 imobilizado, 09 serviço, 99 outras} **ou** `familia` (trim, sem caixa) ∈ {"uso e consumo", "imobilizado"}. Founder confirmou (2026-10-18): os 08 da colacor são imobilizado; os 99 medidos são pneus, cabos, cafeteira, extintor → fora.
- **Giro** = tem `tipo_produto` e não é fora do giro (na prática 00, 01, 02, 03, 04, 05, 06, 10). Só o giro entra no PME/NCG.
- **Sem classificação** = sem `product_id`/`tipo_produto` (todo `servicos`). Fora do numerador, com motivo e R$ mostrado.
- `fin_estimar_estoque_omie` fica intocada (o diálogo de configuração passa a chamar a nova; a velha sai num PR de limpeza).
- **Divergência de cadastro** = tipo e família discordam (ex.: tipo 08 com família de produto, como "LIQUIDOS BIO" R$ 13 mil na oben; tipo 00 com família "Uso e Consumo"). A classificação acima decide; a divergência vira flag para o founder conferir no Omie. Uma função SQL auxiliar `IMMUTABLE` (`_fin_estoque_classe(tipo, familia)` → `giro|fora_giro|sem_classificacao`) é a única dona da regra; `fin_estoque_giro_valor` e a RPC da §5.2 a chamam, nunca copiam.

### 5.1 Engine `fin-cashflow-engine` (edge) — PME e estoque

**Numerador (estoque):** ordem de precedência, com `fonte` registrada:

1. Linha manual em `fin_estoque_valor` com `data_ref` ≥ hoje(SP) − 45 dias → usa (é o dono declarando, por ex. após inventário). `fonte = 'manual'`.
2. Senão, `fin_estoque_giro_valor(company)` (chamada como service_role) → `valor_giro` se `skus_giro > 0`. `fonte = 'omie'`. Se `cobertura_pct < 95` → motivo de confiança ("N% dos SKUs com saldo sem custo"); se `valor_sem_classificacao > 0` → motivo ("R$ X de estoque sem tipo de item fora da conta").
3. Senão → `estoque_valor = null` + motivo "Estoque indisponível".

Erro de transporte em qualquer leitura **lança** (contrato `exigirLeitura` atual), não degrada.

**Denominador (CMV):** 12 **meses fechados** (exclui o mês corrente de SP). Exige as 12 linhas presentes e Σ CMV > 0; caso contrário `cmv_ttm = null` + motivo específico:
- "CMV do DRE cobre N/12 meses fechados (último: AAAA-MM)".
- "CMV do DRE zerado nos meses fechados".

**PME:** `estoque_valor != null && cmv_ttm != null ? estoque/cmv_ttm*365 : null`. Tipo passa a `number | null` (como PMR/PMP). `cash_conversion_cycle` exige PME também (null se PME null).

**NCG:** `aco.estoque: number | null`. Com null, `aco.total` soma só o que existe **e** o motivo fica em `confianca_dados.motivos` ("NCG sem estoque"). Escolha consciente da v1: não propagar null para a NCG inteira (impacto em A2/funding); o caminho null fica raro com a fonte Omie. O aviso existente da `NcgDecomposicao` passa de `estoque === 0` para `estoque === null`.

**Expor** em `indicadores`: `estoque_valor`, `estoque_fonte` (`'manual' | 'omie' | null`), `estoque_data_ref`. O app exibe a fonte no card.

Efeito esperado hoje: colacor PME numérico; oben e colacor_sc **"—"** com motivo de DRE. NCG das 3 sobe pelo valor do estoque. Isso é correção, não regressão — registrar no PR com os números antes/depois.

### 5.2 RPC `fin_ciclo_giro_sku(p_company text)` — lista por SKU

SQL, `SECURITY DEFINER`, `STABLE`, `search_path` fixo, gate na fronteira igual às `fin_ciclo_*` (`_fin_ciclo_gate_master()` e depois `fin_user_can_access(p_company)`). `REVOKE` de `PUBLIC` **e** `anon`, `GRANT` a `authenticated`.

Mapas (constantes na função, como em `fin_estimar_estoque_omie`):
- account de estoque: oben→`vendas`, colacor→`colacor_vendas`, colacor_sc→`servicos`.
- empresa de consumo: oben→`OBEN`, colacor→`COLACOR`, colacor_sc→sem fonte.

**Fonte de consumo disponível** ⇔ empresa mapeada **e** existe ≥1 linha em `venda_items_history` (NF-e — a raiz de toda a demanda efetiva) nos últimos 365 dias para ela. Gate pela tabela-raiz, não pela view: a explosão PCP deriva de NF-e, então não acende sozinha. Hoje (medido): só `OBEN` tem linhas (8.358 em 365d). Sem fonte → colunas de consumo/dias/ação = null e `motivo_consumo = 'sem_consumo_por_sku'`.

Consumo e última saída: **ambos** de `v_sku_demanda_efetiva` (venda efetiva + insumos explodidos pela malha PCP + substituição de SKU) — Σ `quantidade` em `data_emissao` ≥ hoje(SP) − 365 e `max(data_emissao)` all-time. **Não** usar `v_sku_ultima_venda` (só venda direta): um insumo consumido pela produção e nunca vendido avulso viraria "liquidar" girando. A coluna se chama `ultima_saida`/`dias_sem_saida`. Junção por `omie_codigo_produto`.

SKU que é `sku_codigo_antigo` em `sku_substituicao` aplicada (`consolidar_demanda`): demanda foi transferida ao novo → `acao = null`, `motivo_acao = 'substituido'` (decisão do builder: o saldo do código velho é problema de cadastro, não de giro).

Universo: `inventory_position` da account com `saldo > 0`, **todas as classes**, com colunas `classe` (`giro|fora_giro|sem_classificacao`), `tipo_produto`, `familia` e `divergencia_cadastro` (bool). Consumo/dias/ação só são calculados para `giro`; nas demais ficam null. O cliente separa as duas listas.

Colunas por linha:

| coluna | regra |
|---|---|
| `omie_codigo_produto`, `codigo`, `descricao` | de `inventory_position`/`omie_products` (descrição pode ser null em `servicos`) |
| `saldo`, `cmc` | `inventory_position` |
| `valor_parado` | `saldo*cmc` se `cmc > 0`, senão **null** ("sem custo") |
| `consumo_qtd_365d` | Σ quantidade 365d; null se sem fonte; 0 se fonte existe e SKU não vendeu |
| `dias_cobertura` | `saldo / (consumo_qtd_365d/365)` se consumo > 0; senão null |
| `ultima_saida`, `dias_sem_saida` | `max(data_emissao)` em `v_sku_demanda_efetiva` (all-time); null se sem fonte ou nunca saiu |
| `valor_excedente` | `max(0, saldo − consumo_diário×90) × cmc` quando consumo > 0 e cmc > 0; null caso contrário |
| `acao` | ver abaixo |

**Etiqueta `acao`** (só com fonte de consumo):
- `liquidar`: `dias_sem_saida ≥ 270` (`LIMIAR_GIRO_MORTO_DIAS` da reposição) **ou** nunca saiu, **exceto** cold start (SKU em `sku_parametros` com situação de cold start, mesma regra de `ehGiroMorto`) e substituído.
- `segurar_compra`: não é `liquidar` e `dias_cobertura > 180`.
- senão null.

Limiares 90/180/270 são **decisão do builder (founder delegou)**; ficam como constantes nomeadas no SQL e espelhadas no helper TS, com teste que trava a igualdade.

Volume: até ~1.500 linhas (colacor) → o cliente pagina com `.range()` + ordem estável (`valor_parado DESC NULLS LAST, omie_codigo_produto`), padrão do #3090 (capa de 1.000 do PostgREST vale para `.rpc()`).

Desempenho: alvo < 2 s sob `SET ROLE authenticated` + claims do master (medir em prod).

### 5.3 App

- `useFinanceiroCicloGiro(company)` em `src/hooks/useFinanceiroCiclo.ts` (padrão do arquivo), paginando.
- Helper puro `src/lib/financeiro/ciclo-giro-helpers.ts`: resumo por empresa (Σ `valor_parado` não-null, contagem sem custo, Σ liquidar, Σ excedente segurar, Σ fora do giro). Soma sem nenhum termo conhecido → null. Ausente nunca vira 0.
- `CicloEmpresaCards`: PME passa a aceitar null → "—" + motivo (mesmo tratamento de PMR/PMP); mostra a fonte do estoque ("Omie, agora" / "manual, dd/mm").
- Seção nova `CicloGiroEstoque.tsx` na `CicloTab`, abaixo dos cards, respeitando o filtro de empresa existente (`cicloEmpresa`; em "all", um bloco por empresa, nunca somados):
  - faixa de resumo (G4) com rótulo "cenário — não é previsão";
  - tabela de giro por R$ parado com filtro de ação (`useUrlState`), colunas da §5.2, "—" com tooltip de motivo;
  - **lista "Fora do giro" (pedido do founder, para acompanhar)**: TODOS os SKUs `fora_giro` e `sem_classificacao` com saldo, por empresa, com tipo, família, saldo, R$ e o selo "conferir cadastro" quando `divergencia_cadastro`; ordenada por R$, recolhida por padrão com o total no cabeçalho;
  - em colacor/colacor_sc: R$ parado aparece, dias/ação "—" com "sem consumo por SKU (NF-e só da Oben)".
- Sensor: `track('financeiro.ciclo_giro_visto', { empresa })` ao renderizar e `track('financeiro.ciclo_giro_filtro', { acao })` ao filtrar.
- `manifesto.ts` registra arquivos novos.

### 5.4 Endurecimento pós-Codex (challenge de 2026-10-18; prevalece sobre §5.0–5.3 onde divergir)

1. **Fonte de consumo exige cobertura e frescor**, não "≥1 linha": em `venda_items_history` da empresa, `min(data_emissao) ≤ hoje − 330` **e** `max(data_emissao) ≥ hoje − 7`. Senão `motivo_consumo` = `'consumo_incompleto'` ou `'consumo_desatualizado'` e consumo/dias/ação null. (OBEN hoje: desde 2025-10-21, última 2026-10-16 → passa.)
2. **Unidade da malha:** insumo cujo consumo vem da explosão PCP com `v_pcp_malha_oben.unidade` ≠ `omie_products.unidade` → consumo null, `motivo_consumo='unidade_divergente'`. (Medido: 23 insumos, 0 divergentes.) Joins sempre por empresa/account + código.
3. **Compra recente não é giro morto:** SKU com linha em `cmc_ledger` (mesma account) com `observed_at ≥ hoje − 90` → não recebe `liquidar`, `motivo_acao='compra_recente'`. Proxy declarado: não há data de criação confiável do SKU (`inventory_position.created_at` foi recriado em 2026-05-24).
4. **Etiquetas são candidatos**, não ordens: a UI diz "Candidato a liquidar" / "Candidato a segurar compra" e um aviso "confira reservas, lead time e demanda contratada antes de agir".
5. **Sem dias agregados na seção:** a soma de produto acabado + insumos explodidos conta a mesma venda duas vezes, e o número não reconcilia com o PME (CMV contábil). O PME do card é o único número de dias por empresa; por SKU, a coluna chama "cobertura (qtd)".
6. **Custo incompleto derruba o PME:** `fin_estoque_giro_valor` → `valor_giro` null se `skus_giro_com_custo = 0`; o engine põe PME null (não só motivo) se `cobertura_pct < 95`.
7. **Override manual estrito:** só linha com `fonte = 'manual'` e `hoje − 45 ≤ data_ref ≤ hoje` vale. Linha `omie_estimado` salva pelo diálogo **não** é override (é foto velha da regra antiga, com imobilizado). O diálogo deixa de gravar `omie_estimado`: o botão "estimar" só preenche o campo e o dono decide gravar como manual.
8. **NCG parcial explícita:** com estoque null, `ncg.parcial = true` (campo novo) e `aco.estoque = null`; `liquidez_operacional_liquida` usa o mesmo estoque e herda o flag. UI escreve "parcial — sem estoque" ao lado do total. Antes deste PR as 3 eram parciais em silêncio; depois, só onde não há estoque de giro classificável (colacor_sc hoje).
9. **CMV:** 12 meses **distintos**, exatamente os 12 fechados anteriores ao mês corrente, `cmv` não-null, Σ > 0.
10. **`fin_estoque_giro_valor`:** valida empresa (P0001), gate cap_custo_ler/service_role (42501, inclusive `auth.uid()` null), `REVOKE ALL FROM PUBLIC, anon`, `GRANT` a `authenticated, service_role`, objetos qualificados por schema; testes negativos por papel.

## 6. Prova

- PG17 `db/test-fin-ciclo-giro-sku.sh`: fixtures cobrindo SKU sem custo, sem venda, cold start, consumo 0, empresa sem fonte, gate (não-master → 42501; sob `SET ROLE authenticated` + GUC). Controle verde + sabotagens (uma camada por vez) na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`.
- Testes Deno do engine: estoque manual recente vs Omie vs ausente; CMV 6/12, zerado, 12/12; PME/CCC null.
- vitest do helper e dos componentes ("—" nunca "0d").
- psql-ro em prod: 3–5 SKUs da oben conferidos à mão (saldo, cmc, consumo, dias); PME da colacor recalculado à mão.
- 6 gates de edge, `sonda:bump`/`sonda:fingerprint`.
- `/codex` (money-path) sobre spec e sobre o diff.

## 7. Decisões do builder (founder delegou; revisar na leitura)

- Limiares 90 / 180 / 270 dias (§5.2).
- Manual em `fin_estoque_valor` vale por 45 dias e tem precedência sobre o Omie.
- NCG com estoque null soma o resto + motivo (não vira null inteira).
- CMV exige 12 meses fechados presentes e Σ > 0; senão PME "—". Medido: colacor tem os 12 (out/25–set/26) → número; oben (DRE parou em mar/26) e colacor_sc (CMV 0) → "—".
- Última saída pela demanda efetiva, não pela venda direta; SKU substituído sem etiqueta.
- Estoque sem classificação (`servicos`) fora do numerador, mostrado à parte.

## 8. Decisões do founder (2026-10-18)

- Tipo 08 da colacor (máquinas etc., R$ 1,48 mi) **é imobilizado** → fora do giro, mas **listado** para acompanhamento (§5.3).
- Tipo 99: medido, é uso e consumo/imobilizado → fora do giro (regra §5.0).

## 9. Deploy

Migration (sessão aplica via `lovable-db-operator`), edge (sessão deploya via `pendencias:deploy`), Publish (founder). Verificação `lovable-deploy-verify`.
