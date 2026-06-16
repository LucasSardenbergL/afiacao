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

## 2. Metodologia — net-R$ MARGINAL (revisões Codex 1º + 2º passe)

A análise é **incremental contra um baseline**, nunca sobre a média. **Cada componente usa a janela
temporal certa** pra não inflar (correções do 2º passe).

**Baseline e candidatos:**
- `qtd_minima_efetiva = max(lote_minimo_fornecedor, minimo_forcado_manual ?? 0)` — ver §3.
- `q_base = max(EOQ, qtd_minima_efetiva)`, arredondado a múltiplo do lote. **Se o `q_base` já ativa um
  threshold de desconto, o baseline já recebe esse desconto** (e é o candidato `manter_base`).
- **Candidatos não são só os thresholds** (o ótimo pode estar ENTRE eles). Gerar em cada ponto
  relevante e escolher o de **maior `beneficio_liquido`**:
  1. `q_base`;
  2. cada `volume_minimo` da **curva de desconto** (`fornecedor_promocao`, `volume_progressivo`);
  3. **limite do aumento** = qtd cujo consumo baseline cobre até a vigência do aumento;
  4. **limite da ruptura** = qtd que cobre exatamente o período com ruptura simulada;
  todos arredondados a múltiplo do lote.

**Fórmula (por candidato, incremental vs `q_base`):**
`valor_extra = (q_cand − q_base) × preço_líquido`; `q_extra = q_cand − q_base`.
```
beneficio_liquido =
    desconto_incremental    // SÓ desconto promocional atômico: desc_promo(q_cand) − desc_promo(q_base)
  + aumento_evitado         // só a qtd consumida APÓS a vigência do aumento (janela temporal)
  + ruptura_evitada         // marginal e capada; fase 1 default = 0 + flag (ver abaixo)
  − capital_extra           // tranche que fica parada DURANTE toda a cobertura do q_base + metade da sua
  − impacto_prazo           // (prazo_cand% − prazo_padrão%) × valor_CANDIDATO (pedido inteiro), sinal normalizado
  − frete_incremental       // % valor + fixo + taxa de pedido (modela os 3)
```

**Componentes (cada um com a correção do 2º passe):**
- **`desconto_incremental`** — usa **campos atômicos** (`desconto_promo_perc`), **NUNCA** o
  `desconto_total_perc`/`economia_bruta_estimada` da view (que já somam desconto+aumento → double-count).
  = `(desconto_promo(q_cand) − desconto_promo(q_base))` aplicado ao volume, em R$.
- **`aumento_evitado`** — campo atômico `aumento_evitado_perc`, **separado** do desconto. Só conta a
  quantidade cujo **consumo/recompra baseline cairia APÓS a vigência** do aumento:
  `q_extra_elegivel_aumento = max(0, q_cand − max(q_base, demanda_diaria × dias_ate_aumento))`.
- **`ruptura_evitada`** — `valor_ruptura_estimado` é **agregado do cenário base, não marginal**. Sem as
  datas/quantidade marginais da ruptura, **fase 1 usa `ruptura_evitada = 0` + flag "benefício de ruptura
  não estimado (conservador)"**. (Quando houver o delta marginal: `min(valor_ruptura_na_janela_incremental,
  q_extra_elegivel_ruptura × preço)`.) Evita prêmio artificial pra comprar demais.
- **`capital_extra`** — o extra é a **última tranche consumida**: fica parado durante **toda a cobertura
  do `q_base`** + **metade** da sua própria cobertura (não começa a contar só depois do q_base):
  `valor_extra × Cm_anual × ((q_base/demanda_diaria) + 0,5 × (q_extra/demanda_diaria)) / 365`.
  (O fator 0,5 é só sobre a parcela própria — o triângulo de consumo do extra.)
- **`impacto_prazo`** — se o prazo promocional troca a condição do **pedido inteiro**, incide sobre
  `valor_candidato` (não só o extra): `(prazo_cand% − prazo_padrão%) × valor_candidato`. Sinal
  **normalizado no helper** (desconto de prazo = benefício; encargo = custo). Sempre vs o prazo PADRÃO.
- **`frete_incremental`** — modela as 3 formas de `fornecedor_custo_adicional_config` (`% valor`, `fixo`,
  `taxa de pedido`); flag de confiança se a config estiver incompleta.

**Outras armadilhas tratadas:**
- **Não double-count de capital** — o EOQ já embute `Cm`; aqui cobra-se só o **extra acima do q_base**
  (com o tempo correto acima).
- **MOQ / mínimo é restrição**, entra no `q_base`, não no benefício.
- **EOQ com preço descontado** — fase 1 ignora o recálculo (2ª ordem), marca `eoq_recalculo_ignorado:
  true` **+ flag de baixa confiança se o desconto for alto (>20%)** ou se `q_base` estiver muito perto
  de um threshold. Fase 2 recalcula.
- **Escopo da promo** — `escopo ∈ {sku, grupo, fornecedor_total}`. Recomendação **forte** só p/ `sku`;
  `grupo`/`fornecedor_total` → `simulacao_parcial` (avaliador por-SKU isolado pode mentir).

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
- ⚠️ **Campos atômicos obrigatórios (2º passe Codex):** a view deve expor `desconto_promo_perc` e
  `aumento_evitado_perc` **separados** — NUNCA o `desconto_total_perc`/`economia_bruta_estimada` da
  `v_oportunidade_economica_hoje` (que já somam os dois). Se o helper usar o total e ainda somar o
  aumento, dá **double-count**. O frete vem nas 3 colunas (`% valor`, `fixo`, `taxa de pedido`).
- A página lê a view + as curvas (React Query, como já faz) e chama o helper **client-side**. **Sem
  edge function nova** (menos cerimônia de deploy; dado operacional já client-readable).

## 5. Contrato de tipos (`src/lib/reposicao/compras-otimizador-helpers.ts` + consumido pela página)

```typescript
export type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';

export interface InsumoSku {              // 1 linha da view + curva injetada
  empresa: string; sku: string; fornecedor: string;
  preco_cheio: number;                     // preço de tabela (sem desconto promocional)
  preco_liquido: number;                   // preço já líquido do desconto-base aplicável ao q_base
  demanda_diaria: number | null;
  eoq: number | null;
  lote_minimo_fornecedor: number | null;
  minimo_forcado_manual: number | null;    // extension point (§3); default null
  cm_anual: number;                         // custo de capital (empresa_configuracao_custos)
  // prazo: SEMPRE comparado ao padrão; % positivo = encargo (custo), negativo = desconto (benefício)
  prazo_padrao_perc: number | null;
  // frete: as 3 formas (modeladas; flag se incompleto)
  frete_perc_valor: number | null;          // % sobre o valor
  frete_fixo: number | null;                // R$ fixo por pedido
  frete_taxa_pedido: number | null;         // taxa de pedido R$
  // ruptura: agregado base (não marginal) — fase 1 só usa pra DETECTAR período com ruptura; benefício = 0
  ruptura_valor_estimado: number | null;
  ruptura_dias: number | null;
  // aumento anunciado (campo ATÔMICO, separado do desconto promocional)
  aumento_evitado_perc: number | null;      // % do aumento futuro
  dias_ate_aumento: number | null;          // dias até a vigência (janela temporal do aumento_evitado)
  // curva de desconto promocional (campo ATÔMICO desconto_promo_perc, NUNCA o total somado da view)
  curva_desconto: Array<{ volume_minimo: number; desconto_promo_perc: number; prazo_perc?: number }>;
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
- **Ruptura: fase 1 usa `ruptura_evitada = 0` por padrão** (o `valor_ruptura_estimado` é agregado, não
  marginal) + flag "benefício de ruptura não estimado (conservador)". Não infla o net.
- Desconto alto (>20%) ou `q_base` perto de um threshold → flag "EOQ não recalculado com preço
  descontado — confiança reduzida".
- Frete config incompleta (faltam as 3 formas) → flag "frete parcial".
- `escopo ∈ {grupo, fornecedor_total}` → `simulacao_parcial` (recomendação fraca).
- `minimo_forcado_manual` ausente → usa só o lote do fornecedor (esperado, não é degradação).
- **Fatores materiais fora do modelo (fase 1) — sinalizados como flag, não bloqueiam:** validade/
  perecibilidade, obsolescência, espaço de armazém, caixa/limite de crédito, pedidos em aberto +
  estoque atual, câmbio (importados), impostos/créditos, e desconto condicionado a cesta/mix. O
  produto deve deixar explícito que a recomendação ignora esses fatores (o comprador decide com eles em mente).
- `scoreConfianca` agrega o pior sinal.

## 8. Invariantes e testes (~28–32, TDD)
- `qtd_minima_efetiva = max(lote, forcado)`; `q_base = max(EOQ, qtd_minima_efetiva)` arredondado ao lote.
- `q_extra = q_candidata − q_base ≥ 0`.
- **Capital (correção 2º passe):** `capital_extra = valor_extra × Cm × ((q_base/demanda) + 0,5×(q_extra/
  demanda))/365` — testar que o extra carrega DESDE o dia zero (paga a cobertura do q_base + metade da
  própria), não só os dias próprios; testar que NÃO cobra o pedido inteiro (só o extra).
- **Desconto atômico:** `desconto_incremental = (desc_promo(q_cand) − desc_promo(q_base))` — testar que
  NÃO usa o total somado (sem double-count com aumento).
- **Aumento com janela:** `q_extra_elegivel_aumento = max(0, q_cand − max(q_base, demanda×dias_ate_aumento))`
  — testar que qtd consumida ANTES da vigência não recebe o aumento_evitado.
- **Ruptura fase 1 = 0** por padrão + flag (não infla); testar.
- **Candidatos entre thresholds:** com aumento/ruptura, o ótimo pode não estar num `volume_minimo` —
  testar que candidatos de aumento/ruptura-limit entram e podem vencer.
- **Curva progressiva:** escolhe o candidato de **maior** net, não o primeiro desconto.
- **Prazo:** `(prazo_cand% − prazo_padrão%) × valor_candidato`; sinal normalizado (desconto=benefício,
  encargo=custo).
- **Frete:** modela `% valor` + `fixo` + `taxa de pedido`.
- `recomendacao = comprar_mais` só quando `beneficio_liquido_rs > 0` e `escopo = sku`; `manter_base`
  quando nenhum candidato supera o baseline.
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
- **PME/capital por SKU** — usa `Cm × valor_extra × dias` (marginal direto, com o tempo do 2º passe), não o
  PME company-level. `valor_extra` usa **preço líquido** do candidato (não o cheio).
- **Ruptura marginal** (P2 → fase 2): hoje `ruptura_evitada = 0` conservador; a versão marginal exige
  datas/quantidade da ruptura por janela (não só o agregado `valor_ruptura_estimado`).
- **Fatores materiais fora do modelo** (validade, obsolescência, armazém, caixa/crédito, câmbio, impostos,
  cesta/mix) — sinalizados como flag na fase 1 (§7); modelagem é fase 2+.
- **View é migration manual** (Lovable, via `lovable-db-operator`) — sem ela a página cai num fallback de
  "dados insuficientes".
