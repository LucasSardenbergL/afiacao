# PCP Fase 2A — Custo-padrão & fila de exceções de custo — Design (v2)

> Spec de **design** (o quê/por quê). O **como** (migration, provas) vai no plano.
> **v2** — reescrita após o painel tri-modelo sobre a v1 (BLOCK: 5 P1 do Codex + confirmações Claude/Gemini) e a **sonda de linhagem** que redefiniu o valor. Ver `scratchpad/painel-2a/agregacao.md` e `achado-fase2-custo.md`.

## 1. Contexto & os dois achados que definiram o design

**Achado 1 — a fonte de custo (sonda 2026-07-06).** O `custoProducao{vGGF,vMOD}` da malha Omie está **100% ZERADO** (0/2011). O custo real está no `cmc_snapshot` (CMC de estoque via `ListarPosEstoque`/`nCMC`, edge `cmc-snapshot-backfill`), grade **mensal**, conta **única `colacor_vendas`** (founder confirmou: Colacor compra e vende tudo). Cobertura: **94% acabados, 99% insumos**.

**Achado 2 — o CMC do acabado é HÍBRIDO (sonda de linhagem, mesma data-posição).** Comparando `nCMC(acabado)` vs `Σ(estrutura × nCMC insumo)` em 1863 produtos: **50% batem ≤1%** (idênticos ao centavo em 23%), mas **35% divergem >5%**. Ou seja, o `nCMC` do fabricado é **em parte o custo teórico da estrutura, em parte um custo próprio** (média móvel de OPs históricas + apuração + perda). **Consequência:** a v1 vendia "teórico × real puro" e "gap = conversão de graça" — **falso**: para metade dos SKUs o CMC é o próprio teórico, e o "gap" é ~zero. O valor real está nos **~35% que divergem**.

**Reposicionamento (v2):** o 2A entrega **(1)** o **custo-padrão calculado por SKU** (a base de custo estruturada que hoje não existe — item 1 da Fase 2) e **(2)** uma **fila de exceções** onde o custo-padrão diverge do custo-de-estoque do Omie, **com a causa provável classificada**. NÃO promete "conversão observada de graça" — o resíduo é ambíguo (drift de preço + apuração + material omitido) e é **classificado, não interpretado como MOD/GGF**.

## 2. Objetivo & não-objetivos

**Objetivo:** para cada SKU fabricado, **(a)** calcular o **custo-padrão** = Σ de TODOS os componentes de material × CMC (na mesma data-posição), por bucket, com unidade normalizada e ausente→NULL; **(b)** persistir o resultado **versionado** (auditável, reprocessável); **(c)** comparar com o `nCMC` do acabado e emitir uma **fila de exceções priorizada por R$**, com **classe de causa provável** (drift de preço · material fora do bucket · CMC incompleto · possível erro de receita).

**Não-objetivos:** escrever no Omie (2B); MOD/GGF calculada por tempo (Fase 3+, do apontamento M1); virar fonte na escada `cost_source` multi-writer (o CMC não entra na escada — 1 writer); custo real por OP individual (2B); tratar o resíduo como conversão (rebaixado a `residuo_classificado`).

## 3. Arquitetura — dois módulos

### 2A.0 — Base de custo (leitura data-aware sobre o CMC)
- **`fn_pcp_cmc_vigente(p_cod bigint, p_data_posicao date)` → numeric**: o CMC de `account='colacor_vendas'` na **exata `data_posicao`** pedida (a grade é mensal e comum); fallback para a data-posição imediatamente anterior **só** se explicitado, marcando staleness. **NULL se ausente** (jamais 0). Conta é fixa (não é parâmetro aberto — remove o risco de conta errada).
- **Unidade é CONTRATO, não sonda** (Codex P1): uma tabela `pcp_custo_unidade(papel, uom_coef, uom_cmc, fator_conversao, fonte, vigente_em)` com constraint; o cálculo **recusa (→ NULL/exceção)** quando falta conversão conhecida entre a unidade do coeficiente e a unidade comercial do CMC. Cola/catalisador em G vs CMC por KG/L = fator 1000 barrado aqui.
- **Cobertura/frescor:** `vw_pcp_cmc_cobertura` reporta % com CMC vigente e idade — o 2A sabe onde **não pode** afirmar custo.

### 2A.1 — Motor de custo-padrão + fila de exceções
- **Custo-padrão, TODOS os componentes, bucketizado:** `pcp_custo_padrao_resultados` (versionada — 1 writer) com, por (SKU, data_posicao, versao_regra): custo por bucket (`abrasivo | cola | catalisador | fita | outros_materiais`), total, `custo_status` (`ok | incompleto | unidade_indefinida | ambiguo`), insumos usados. **Soma de TODOS os componentes de cada papel** (não um "canônico" — Codex/Claude E): a classificação canônica roteia, não escolhe o custo. **Qualquer componente fora dos buckets conhecidos vai para `outros_materiais`** (Codex H) — nada cai silenciosamente no resíduo. Componente com CMC/unidade NULL ⇒ SKU `incompleto` (não soma como zero).
- **Cola/catalisador (consumível indireto, spec §1.5):** o fator de perda de mistura **multiplica** o coeficiente cru por área/emenda (preserva a diferença física entre larguras — Gemini J), **não** substitui; o fator vem de **fonte empírica independente**, versionado em `pcp_config` — **proibido calibrá-lo pela própria divergência** contra o CMC (circularidade — Codex J).
- **Comparação temporal-coerente:** custo-padrão e `nCMC` do acabado **na MESMA `data_posicao`** (elimina o lag Gemini/Codex B). Flag `comparacao_temporalmente_valida`; SKU sem CMC comparável na data ⇒ fora da fila (não vira exceção falsa).
- **Fila `pcp_custo_excecoes`** (derivada dos resultados, não fonte paralela — Codex I): SKU, custo_padrao (buckets+total), nCMC, `divergencia_abs` (R$), `divergencia_pct`, `classe_causa`, `custo_status`, `data_posicao`, `derivado_em`. **Ordenável por R$.**
- **`classe_causa`** (Codex D — o resíduo é classificado, não "conversão"): `material_fora_bucket` (havia `outros`?) · `cmc_incompleto` · `drift_preco_provavel` (insumos mudaram muito desde a última posição) · `possivel_erro_receita` (resto). Nenhuma vira "MOD/GGF" sem prova.

## 4. Invariantes money-path (não-negociáveis)
1. **Ausente = NULL, nunca 0.** Sem `COALESCE(cmc,0)` em caminho de custo. Faltou CMC/unidade ⇒ `incompleto`, exceção visível, **não** validado.
2. **Unidade = contrato de dados.** Constraint + tabela de conversão; cálculo bloqueado sem conversão conhecida. Assert PG17.
3. **Coerência temporal.** Custo-padrão e nCMC do acabado na mesma `data_posicao`; sem comparar janelas diferentes.
4. **Soma completa.** Todo componente de material entra em algum bucket (inclusive `outros_materiais`); nada evapora no resíduo.
5. **1 writer, sem circularidade.** `pcp_custo_padrao_resultados`/`_excecoes` têm produtor único; o CMC não entra na escada `cost_source`; o fator de perda NÃO é calibrado pela divergência que ele deveria validar.
6. **RLS = contrato explícito** (Codex G): tabelas de custo com RLS **enabled + FORCED**, policies staff-only; funções de leitura **SECURITY INVOKER** (ou wrapper com gate `auth.uid()` staff, nunca DEFINER cru); `REVOKE ALL` de public/authenticated; grant só a role interna. Não-staff → 0 linhas/erro, **nunca NULL seletivo** (inferência por SKU). Vendedor não vê custo (CLAUDE.md).
7. **Tolerância saneada.** A banda por família só se calibra sobre SKUs com comparação **válida** (unidade provada, CMC presente, sem `outros` faltante, sem ambiguidade). Percentis sobre dado contaminado normalizam erro sistêmico (Codex K).

## 5. O resíduo (ex-"gap de conversão")
`residuo = nCMC_acabado − custo_padrao_total`. **Não** é conversão/MOD-GGF: contém drift de preço, apuração de OPs antigas, ajustes, arredondamento e material eventualmente omitido. É **exposto e classificado** (§3 `classe_causa`), **nunca** promovido a conversão-padrão nem alimenta a escada — até que (a) a linhagem do CMC seja provada e (b) os outros efeitos sejam isolados. Fica como sinal de investigação, não como número contábil.

## 6. Testes a provar (PG17, com falsificação)
- CMC vigente por data-posição exata; fallback só quando pedido; ausente → NULL.
- **Propriedades de conservação:** total = Σ buckets; nenhum componente de material sem bucket; componente duplicado não duplica custo indevido; **recompute idempotente** (mesma data → mesmo resultado).
- **Unidade:** componente sem conversão conhecida ⇒ `unidade_indefinida` (NÃO custo 0). Falsificar: remover a conversão de cola e exigir vermelho.
- **Soma completa:** componente fora dos 4 buckets vai para `outros_materiais` (não some).
- **Coerência temporal:** comparar em data-posição diferente ⇒ fora da fila (não exceção falsa).
- **RLS:** staff vê; não-staff 0 linhas (falsificar INVOKER→DEFINER → vermelho).
- **Cola/catalisador:** fator multiplica (custo varia com a largura); falsificar substituindo por fixo → teste de duas larguras fica vermelho.
- **Falsificação geral:** trocar NULL por 0 quebra o teste de `incompleto`; calibrar tolerância sobre dado contaminado muda a fila (documentar).

## 7. Pontos abertos (plano/sonda — não bloqueiam o design)
1. **Fator de perda de mistura** (cola/catalisador): valor inicial + fonte empírica independente (com founder/dados) — nunca da divergência.
2. **Tolerância por família:** rodar a distribuição **saneada** das divergências sobre os acabados válidos para fixar a banda.
3. **`classe_causa` drift:** heurística de "insumos mudaram muito" precisa de ≥2 datas-posição de CMC (a grade mensal já dá histórico).
4. **Cadência de recompute:** cron encadeado após o backfill mensal de CMC + on-demand staff (marca de frescor visível).
5. **Linhagem do CMC (opcional, rigor extra):** se o founder quiser, confirmar com o contador como o Omie forma o `nCMC` do fabricado (média móvel? recálculo por estrutura? inclui overhead?) — afina a interpretação das exceções, mas o design já é honesto sem isso (trata o resíduo como ambíguo).

## 8. Fora de escopo
Outbox/escrita no Omie, backflush, veículo fiscal do desvio, custo real por OP → **Fase 2B**. MOD/GGF calculada por tempo → Fase 3+. Motor de rota → Fase 3.
