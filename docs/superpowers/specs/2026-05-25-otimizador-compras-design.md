# Otimizador de Compras — Decisão "Comprar Mais?" (fase 1)

> Spec aprovado em 2026-05-25. Próxima fronteira do "Estado da Arte do Financeiro" (Codex #2 — compras).
> Decisão do founder: **não é página nova nem do-zero** — é *formular* a área que já existe
> (`/admin/reposicao/oportunidades`), subindo de "economia bruta" para **decisão net-R$ marginal**.

## 1. Contexto e objetivo

O módulo Reposição é maduro e a maior parte da matemática **já existe no Postgres** (views/RPCs):
EOQ/lote econômico (`v_sku_parametros_sugeridos.qc_eoq`), safety stock / ponto de pedido
(`sku_parametros`), risco de ruptura (`simular_formula_estoque` → SRL%, `valor_ruptura_estimado`,
`giros_ano`), custo de capital por empresa (`empresa_configuracao_custos`, `Cm = selic + spread +
armazenagem`), e a economia de desconto/forward-buy (`v_oportunidade_economica_hoje`). A página
`AdminReposicaoOportunidades` já consome essa última e mostra **economia bruta** (desconto + aumento
evitado × qtd × custo de capital), com tabela, KPIs, filtros e drawer por SKU prontos.

**Gap:** ninguém **neta** o trade-off completo numa decisão por SKU. Comprar mais pra pegar desconto
empata capital, paga frete/encargo de prazo e cobre (ou não) ruptura. O `simular_puxar_volume_trimestre`
faz esse net — mas está **hardcoded pro fornecedor Sayerlack/DES**, não generaliza.

**Objetivo (fase 1):** enriquecer a `AdminReposicaoOportunidades` de "economia bruta" para a
**decisão net-R$ marginal por SKU** — "comprar **quanto**, e vale a pena de verdade?" — compondo os
dados que já existem. Sem página nova. Reaproveita a UI (tabela/KPIs/drawer).

**Fora de escopo (fase 2):** generalização multi-SKU do rebate trimestral (DES/Sayerlack);
recálculo de EOQ com o preço já descontado (efeito de 2ª ordem); recomendação **forte** para promo
de grupo/fornecedor-total (fase 1 marca como "simulação parcial").

## 2. Metodologia — net-R$ MARGINAL (revisão Codex, 1º passe)

A análise é **incremental contra um baseline**, nunca sobre a média.

**Baseline e candidatos:**
- `qtd_minima_efetiva = max(lote_minimo_fornecedor, minimo_forcado_manual ?? 0)` — ver §3.
- `q_base = max(EOQ, qtd_minima_efetiva)` (arredondado a múltiplo do lote quando o lote for embalagem real).
- `q_candidato` = para cada threshold da **curva de desconto por volume** (`fornecedor_promocao`:
  `volume_minimo`, `volume_progressivo`), a menor quantidade ≥ `q_base` que ativa o threshold.
- Gera um candidato por threshold; **escolhe o de maior `beneficio_liquido`** (não o primeiro desconto).

**Fórmula (por candidato, tudo incremental vs baseline):**
```
beneficio_liquido =
    desconto_incremental            // (preço_cheio − preço_desc) × q_candidato − desconto já no baseline
  + aumento_evitado_incremental     // compra antes da vigência do aumento × qtd extra (de v_oportunidade_economica_hoje)
  + ruptura_evitada_incremental     // só quando o extra cobre período COM ruptura simulada (senão = 0)
  − capital_extra                   // = valor_extra × Cm_anual × (dias_cobertura_extra / 365) × 0,5
  − impacto_prazo                   // encargo/desconto do prazo vs o prazo PADRÃO do fornecedor
  − frete_incremental               // frete adicional do volume extra (fornecedor_custo_adicional_config)
```
onde `valor_extra = (q_candidato − q_base) × preço_unitário` e `dias_cobertura_extra = (q_candidato −
q_base) / demanda_diaria`.

**Armadilhas (cravadas pelo Codex) — todas tratadas:**
- **Não double-count de capital:** o EOQ já embute `Cm`. Aqui cobra-se capital **só sobre o estoque
  acima do `q_base`**, pelos **dias extras**, e com fator **0,5** (o estoque extra é consumido ao
  longo do tempo, não fica inteiro parado). `1,0` só num modo "conservador" opcional.
- **MOQ / mínimo é restrição, não desconto** — entra no `q_base`, não no benefício.
- **Desconto progressivo = curva**, avaliada nos thresholds; pega o melhor net.
- **Ruptura evitada** só conta quando o candidato aumenta cobertura num período que **tinha ruptura
  simulada** (`simular_formula_estoque` recente) — senão vira prêmio artificial pra comprar demais.
- **Prazo de pagamento** é benefício OU custo, sempre **comparado ao prazo padrão** do fornecedor.
- **Desconto muda preço e EOQ:** fase 1 **ignora** o recálculo do EOQ com preço descontado (2ª ordem)
  e marca `eoq_recalculo_ignorado: true`. Fase 2 recalcula.
- **Escopo da promo:** `escopo ∈ {sku, grupo, fornecedor_total}`. Recomendação **forte** só p/ `sku`;
  `grupo`/`fornecedor_total` → status "simulação parcial" (o avaliador por-SKU isolado pode mentir).

## 3. Quantidade mínima efetiva — ponto de extensão (requisito do founder)

O founder precisa poder **forçar uma quantidade mínima** em certos itens da sugestão de pedido (além
do lote do fornecedor). O helper trata isso por um único input:
```
qtd_minima_efetiva = max(lote_minimo_fornecedor ?? 0, minimo_forcado_manual ?? 0)
```
- `lote_minimo_fornecedor` já existe (`sku_parametros.lote_minimo_fornecedor`).
- `minimo_forcado_manual` é **input opcional** (default `null` → só o do fornecedor). **Onde** ele é
  setado (campo em `sku_parametros`, regra, override por sessão) é **decisão futura do founder** — fora
  do escopo desta fase. A costura: o helper e a view aceitam o campo; quando a origem for decidida, é só
  popular. Documentar como extension point; não construir a UI de setar agora.

## 4. Arquitetura — helper TS puro + 1 view de insumos (sem edge function)

Refino sobre a recomendação do Codex (que sugeria engine Deno): aqui os dados (views) **já são lidos
client-side com RLS de staff** — a `AdminReposicaoOportunidades` já faz isso. **Não há dado sensível
nem necessidade de service_role/gate master** (≠ frentes financeiras). Então:

- **Helper puro** `src/lib/reposicao/compras-otimizador-helpers.ts` (TDD, vitest) — toda a matemática
  marginal (§2). Funções: `qtdMinimaEfetiva`, `qtdBase`, `gerarCandidatos`, `capitalExtra`,
  `impactoPrazo`, `rupturaEvitada`, `avaliarComprarMais` (retorna o melhor candidato), `scoreConfianca`.
  Puro e determinístico — sem I/O.
- **1 view** `v_otimizador_compras_insumos` (migration manual via Lovable SQL Editor; **só JOIN de
  fatos por SKU, ZERO regra financeira**): junta `v_oportunidade_economica_hoje` + `sku_parametros`
  (lote, demanda, EOQ committed) + `v_sku_parametros_sugeridos.qc_eoq` + `empresa_configuracao_custos`
  (Cm) + `fornecedor_prazo_pagamento_config` (prazo padrão) + `fornecedor_custo_adicional_config`
  (frete) + `simulacao_estoque_resultados` (ruptura recente) + `sku_estoque_atual`/`omie_products`
  (estoque/preço). 1 linha por SKU/empresa.
- A **curva de desconto** (`fornecedor_promocao`, 1-para-muitos) é uma **query separada** pequena; o
  helper recebe a curva como array.
- A página lê a view + as curvas (React Query, como já faz) e chama o helper **client-side**. **Sem
  edge function nova** (menos cerimônia de deploy; dado operacional já client-readable).

## 5. Contrato de tipos (`src/lib/reposicao/compras-otimizador-helpers.ts` + consumido pela página)

```typescript
export type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';

export interface InsumoSku {            // 1 linha da view + curva injetada
  empresa: string; sku: string; fornecedor: string;
  preco_unitario: number;
  demanda_diaria: number | null;
  eoq: number | null;
  lote_minimo_fornecedor: number | null;
  minimo_forcado_manual: number | null;   // extension point (§3); default null
  cm_anual: number;                        // custo de capital (empresa_configuracao_custos)
  prazo_padrao_encargo_perc: number | null;// encargo/desconto do prazo padrão
  frete_incremental_unit: number | null;   // frete por unidade extra (ou 0)
  ruptura_valor_estimado: number | null;   // simular_formula_estoque recente (ou null)
  ruptura_dias: number | null;
  aumento_evitado_unit: number | null;     // de v_oportunidade_economica_hoje (ou 0)
  curva_desconto: Array<{ volume_minimo: number; desconto_perc: number; prazo_encargo_perc?: number }>;
  escopo: EscopoPromo;
}

export interface DecisaoCompra {
  empresa: string; sku: string; fornecedor: string;
  q_base: number; q_candidata: number; q_extra: number; dias_cobertura_extra: number;
  desconto_rs: number; aumento_evitado_rs: number; ruptura_evitada_rs: number;
  capital_extra_rs: number; impacto_prazo_rs: number; frete_incremental_rs: number;
  beneficio_liquido_rs: number;
  recomendacao: RecomendacaoCompra;
  escopo: EscopoPromo;
  eoq_recalculo_ignorado: true;
  flags: string[];
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
}
```

## 6. Frontend — enriquecer `AdminReposicaoOportunidades` (sem página nova)

- `OportunidadesTable`: coluna **net-R$ (`beneficio_liquido_rs`)** ao lado da economia bruta; nova
  ordenação por net; mostrar `q_base → q_candidata` (quanto comprar). Badge de `recomendacao`/escopo.
- `KpiCards`: somar **net-R$** (além do bruto).
- Drawer por SKU (`DrawerConteudo`/`SkuDetailSheet`): **decomposição R$** (desconto, aumento evitado,
  ruptura evitada, − capital extra, − prazo, − frete = net) + baseline vs candidato.
- Cores `text-status-*`; sem emerald/red-600. Sem nova rota.

## 7. Degradação honesta / confiança
- Falta `demanda_diaria`/`eoq` → não dá pra dimensionar → `falta_dado` (sem recomendação).
- Falta ruptura simulada recente → `ruptura_evitada = 0` + flag "sem simulação de ruptura — benefício
  pode estar subestimado".
- `escopo ∈ {grupo, fornecedor_total}` → `simulacao_parcial` (recomendação fraca).
- `minimo_forcado_manual` ausente → usa só o lote do fornecedor (esperado, não é degradação).
- `scoreConfianca` agrega o pior sinal.

## 8. Invariantes e testes (~25–30, TDD)
- `qtd_minima_efetiva = max(lote, forcado)`; `q_base ≥ qtd_minima_efetiva` e `≥ EOQ`.
- `q_extra = q_candidata − q_base ≥ 0`; candidato sempre ativa um threshold da curva.
- `capital_extra = valor_extra × Cm × dias_extra/365 × 0,5` (testar fator 0,5; não cobra o pedido inteiro).
- Ruptura evitada = 0 quando não há ruptura simulada no período (não fabrica prêmio).
- Prazo: encargo vs padrão (benefício quando prazo melhor sem encargo; custo quando há encargo).
- Curva progressiva: escolhe o candidato de **maior** net, não o primeiro desconto.
- `recomendacao = comprar_mais` só quando `beneficio_liquido_rs > 0` e `escopo = sku`.
- Degradação: input ausente → `falta_dado`/flag, nunca número fabricado.

## 9. Segurança / acesso
- Mesma RLS/acesso da `AdminReposicaoOportunidades` atual (staff/comprador). A view `v_otimizador_
  compras_insumos` herda as policies das fontes (só junta fatos já legíveis). Sem dado sensível novo.

## 10. Plano de validação
1. **2º passe do Codex** na metodologia do spec (antes de codar) — focar: marginal vs médio, fator 0,5,
   curva de desconto, interação ruptura×desconto, prazo vs padrão, MOQ/forçado.
2. TDD do helper (vitest).
3. Migration da view entregue via SQL Editor do Lovable (bloco pronto + query de validação) — usar a
   skill `lovable-db-operator`.
4. Revisão adversária do Codex pós-implementação.
5. `bun run test` + `bun lint` + CI `validate` verde.

## 11. Riscos e decisões em aberto
- **Origem do `minimo_forcado_manual`** — founder decide depois onde setar (§3). Helper/view já aceitam.
- **Curva de desconto real** — `fornecedor_promocao.volume_progressivo` é dado, mas a cobertura/qualidade
  do cadastro varia; sem curva → só avalia o desconto flat disponível (ou nada). Flag de confiança.
- **Promo de grupo/fornecedor-total** — fase 1 só sinaliza ("simulação parcial"); generalização real é fase 2.
- **PME/capital por SKU** — usa `Cm × valor_extra × dias_extra` (marginal direto), não o PME company-level.
- **View é migration manual** (Lovable) — sem ela a página cai num fallback de "dados insuficientes".
