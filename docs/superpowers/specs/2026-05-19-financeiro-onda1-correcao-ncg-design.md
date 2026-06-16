# Financeiro Onda 1 — Correção do NCG

> Parte 1 de 4 do programa "Estado da Arte do Financeiro" (Ondas 1-3 = remediação dos achados do Codex; Onda 4 = A2 Retorno & Valor). Esta onda corrige a base do NCG, que é pré-requisito do A2 (capital investido = NCG + imobilizado).

## 1. Contexto e Objetivo

Revisão de metodologia conduzida via `/codex` (consult) em 2026-05-19 sobre `fin-cashflow-engine` apontou 4 problemas na construção do NCG e dos indicadores, dois deles bugs confirmados em produção. Esta onda corrige todos os quatro **sem** rebuildar o timing da projeção (Onda 2) nem o DRE (Onda 3).

Empresas: Colacor (indústria de abrasivos, carrega estoque), Oben (distribuidora, carrega estoque), Colacor SC (serviços, ~sem estoque).

### Achados endereçados
1. **PCO conta tributos 2×** (bug): impostos entram em `cp_fornecedor` E em `tributos_a_pagar` → PCO/NCG inflados.
2. **`estoque_valor` hardcoded = 0** (bug): NCG e CCC subestimam capital de giro de Colacor e Oben.
3. **`capital_giro_proprio` mal rotulado**: fórmula é liquidez operacional, não CGP.
4. **CCC sem PME**: `CCC = PMR − PMP` ignora dias de estoque → ciclo subestimado pra negócio com estoque.

### Não-escopo (outras ondas)
- Timing da projeção 13s (atraso médio não aplicado, vencidos somem): **Onda 2**.
- Prefixo `'3.99'` frágil pra detectar imposto + split regime-aware do imposto: **Onda 3**.
- CGP verdadeiro (PL + PNC − ANC): **A2** (introduz patrimônio líquido + imobilizado).
- Inadimplência por aging, PMR/PMP ponderados por R$: **Onda 2**.

## 2. Modelo de Dados

### Tabela nova: `fin_estoque_valor`

Histórico de valor de estoque por empresa, com data e fonte (auditável).

```sql
CREATE TABLE IF NOT EXISTS fin_estoque_valor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company     text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  valor       numeric(15,2) NOT NULL CHECK (valor >= 0),
  data_ref    date NOT NULL,            -- data do balancete / referência
  fonte       text NOT NULL CHECK (fonte IN ('manual','omie_estimado')) DEFAULT 'manual',
  cobertura_pct numeric(5,2),           -- só preenchido quando fonte='omie_estimado'
  observacao  text,
  criado_por  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_estoque_valor_company_data_idx
  ON fin_estoque_valor (company, data_ref DESC);
```

- RLS: leitura staff; escrita master (mesmo padrão de `fin_config_cashflow`).
- Entra no trigger de audit da Fundação (`trg_audit`) e no lock de período (`trg_period_lock`, por `data_ref`).
- Engine usa o registro mais recente por empresa (maior `data_ref`).

### Coluna renomeada: `fin_projecao_snapshots`

```sql
ALTER TABLE fin_projecao_snapshots
  RENAME COLUMN capital_giro_proprio TO liquidez_operacional_liquida;
```

Preserva dados existentes. Engine e frontend passam a usar o novo nome.

## 3. Mudanças no Engine (`fin-cashflow-engine`)

### `carregarDados` — novos inputs
- Carrega `fin_estoque_valor` (último por empresa) → `estoque_valor` (substitui o `0` hardcoded na linha ~161).
- Carrega CMV TTM de `fin_dre_snapshots` (regime competência, últimos 12 meses, somado) → `cmv_ttm` (necessário pro PME).

### Fix 1 — `calcularNCG`: PCO mutuamente exclusivo
`cp_fornecedor` passa a excluir **também** categorias de tributo (mesma definição de `tributos_a_pagar`: `categoria_codigo` começa com `'3.99'`):

```
cp_fornecedor = CP aberto, saldo>0,
  NÃO em adiantamento_categorias_codigos
  E NÃO (categoria_codigo LIKE '3.99%')
```

Assim imposto entra só em `tributos_a_pagar`. `pco.total = cp_fornecedor + folha_30d + tributos_a_pagar` deixa de duplicar.
> A fragilidade do prefixo `'3.99'` é tratada na Onda 3 (passa a usar o mapping DRE `dre_linha='impostos'`). Aqui só garantimos exclusão mútua usando a definição vigente nos dois lugares.

### Fix 2 — `calcularNCG`: estoque real
`aco.estoque = dados.estoque_valor` (antes `0`). `aco.total = cr_aberto + estoque + adiantamentos`.

### Fix 4 — `calcularIndicadores`: CCC com PME
```
PME = cmv_ttm > 0 ? (estoque_valor / cmv_ttm) * 365 : 0
CCC = PMR + PME − PMP
```
Estoque pontual (do balancete) usado como proxy do estoque médio — documentado como simplificação (estoque médio real virá quando houver série histórica em `fin_estoque_valor`). Colacor SC cai pra PME ≈ 0 (estoque ~0).

### Fix 3 — rename na saída
`calcularIndicadores` devolve `liquidez_operacional_liquida` (mesma fórmula: `saldo_cc + cr_aberto + estoque − pco.total`) em vez de `capital_giro_proprio`. O snapshot persiste na coluna renomeada.

## 4. Helper "estimar do Omie" (opcional, best-effort)

RPC `fin_estimar_estoque_omie(p_company text)` → `{ valor_estimado, cobertura_pct, skus_sem_custo }`.

- Soma `sku_estoque_atual.estoque_fisico × custo` por empresa, juntando a um custo por SKU (via `product_costs`/`inventory_position` quando a chave reconciliar).
- `cobertura_pct` = % do valor coberto por SKUs com custo confiável. **É sugestão**, não entra no NCG sem o master confirmar e gravar em `fin_estoque_valor` (fonte='omie_estimado').
- Se a reconciliação de chave SKU↔custo for fraca (cobertura baixa), a UI mostra o aviso e recomenda o valor manual do balancete. Manual é a fonte de verdade.
- Risco conhecido: reconciliação `sku_codigo_omie` ↔ `product_id` entre o mundo financeiro/reposição e o analytics/vendas é imperfeita. Por isso é estimativa com score, nunca silenciosa.

## 5. Frontend (`/financeiro/capital-giro`, tab NCG + Config)

- **Tab NCG**: decomposição do ACO mostra a linha de estoque (antes sempre 0); CCC exibido como `PMR + PME − PMP` com os 3 componentes; renomeia o card "Capital de Giro Próprio" → "Liquidez Operacional Líquida" com tooltip explicando que CGP verdadeiro chega no A2.
- **Banner de confiabilidade**: se `fin_estoque_valor.data_ref` mais recente > 90 dias (ou inexistente), avisa "estoque desatualizado/ausente — atualize do balancete; NCG e CCC subestimados sem ele".
- **Tab Configuração (master)**: campo de valor de estoque por empresa (valor + data_ref + observação) gravando em `fin_estoque_valor`; botão "Estimar do Omie" que chama o RPC e pré-preenche com o score de cobertura visível.

## 6. Permissionamento
- Leitura: staff (employee/master). Escrita `fin_estoque_valor`: master (RLS).
- Auditoria + lock de período aplicados à nova tabela (anexar `trg_audit` + `trg_period_lock`).

## 7. Testes
- Unit (helpers de NCG): PCO sem double-count (caso com categoria de imposto presente nos dois filtros antigos → agora só em tributos); NCG com estoque > 0; PME = 0 quando cmv_ttm=0; CCC = PMR+PME−PMP.
- Caso Colacor SC: estoque ausente → PME 0, sem banner de erro fatal (só aviso).
- RPC estimativa: cobertura_pct correto com SKUs parcialmente sem custo.

## 8. Migração / Pré-requisitos
- SQL via SQL Editor do Lovable (bloco único idempotente): cria `fin_estoque_valor` + RLS + anexa triggers; renomeia coluna em `fin_projecao_snapshots`; cria RPC `fin_estimar_estoque_omie`.
- Re-deploy `fin-cashflow-engine` via chat do Lovable (lendo o arquivo do repo).
- Seed inicial opcional: master insere o valor de estoque do último balancete das 3 empresas.

## 9. Definição de Pronto
- PCO não duplica tributo (teste passa + validação numa empresa real).
- NCG reflete estoque do balancete; banner aparece se desatualizado.
- CCC mostra os 3 componentes; "Liquidez Operacional Líquida" renomeado em UI e DB.
- Doc `FINANCEIRO_CONFIABILIDADE.md` atualizado com a seção Onda 1 (o que mudou, o que ainda é direcional).
- Onda 1 não introduz regressão no fluxo 13s nem nos alertas (fora de escopo, mas não pode quebrar).
