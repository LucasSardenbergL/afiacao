# Schema financeiro — tabelas, colunas e armadilhas

Referência técnica pra adaptar os templates SQL. Identificadores **exatos** (não parafrasear).
Tudo read-only. Fonte: migrations `supabase/migrations/2026032820*`, `2026051900*` +
`src/integrations/supabase/types.ts` + hooks/edge functions financeiras.

## Índice
- [Convenção de empresa](#convenção-de-empresa)
- [Armadilhas que quebram query](#armadilhas-que-quebram-query)
- [Tabelas núcleo (Omie sincronizado)](#tabelas-núcleo-omie-sincronizado)
- [DRE, confiabilidade e tributário](#dre-confiabilidade-e-tributário)
- [Cashflow / NCG / eventos / alertas](#cashflow--ncg--eventos--alertas)
- [Fechamento, orçamento, intercompany](#fechamento-orçamento-intercompany)
- [RPCs e views úteis](#rpcs-e-views-úteis)

## Convenção de empresa
- Tabelas `fin_*`: coluna **`company text`**, valores `'colacor' | 'oben' | 'colacor_sc'`.
  `CHECK (company IN ('oben','colacor','colacor_sc'))`. A tabela `fin_categoria_dre_mapping`
  aceita também o valor especial `'_default'` (regra padrão de mapeamento).
- ⚠️ Tabelas **Omie/vendas** usam outra convenção: `omie_clientes.empresa_omie`,
  `sales_orders.account`. **Não dá pra juntar direto** com `fin_*` por empresa sem mapear.
  Cada empresa é uma conta Omie separada (credenciais `OMIE_<OBEN|COLACOR|COLACOR_SC>_*`).
- Regime tributário **não está no banco** — é `COMPANIES[co].regime` no front
  (`colacor`/`oben` = `presumido`, `colacor_sc` = `simples`).

## Armadilhas que quebram query
1. **`status_titulo` é MAIÚSCULO no banco.** O que a edge function `omie-financeiro` grava:
   `'ABERTO'`, `'VENCIDO'` (calculado por data no sync), `'PAGO'` (mapeia LIQUIDADO/RECEBIDO),
   `'PARCIAL'`, `'CANCELADO'`. O **front** (`financeiroService.ts`, `useFinanceiroAlertas.ts`)
   filtra por `'A VENCER'`, `'ATRASADO'`, `'VENCE HOJE'`, `'RECEBIDO'` — valores que **não
   existem** no banco. **Não copie os filtros do front.**
   - Aberto: `status_titulo IN ('ABERTO','VENCIDO','PARCIAL')` — ou melhor, `saldo > 0`.
   - Quitado: `status_titulo IN ('PAGO','LIQUIDADO')`.
   - **Sempre rode `00-sanity-status.sql` primeiro** pra ver os valores reais por empresa.
2. **Vencido: calcule por data, não por status.** O `status_titulo='VENCIDO'` depende de
   quando o sync rodou. Pra aging confiável use `data_vencimento < CURRENT_DATE AND saldo > 0
   AND data_recebimento IS NULL`.
3. **`saldo` é coluna GERADA** em CR (`valor_documento − valor_recebido`) e CP
   (`valor_documento − valor_pago`). Confiável, use direto.
4. **DRE: sempre filtre `regime`.** `fin_dre_snapshots` tem UNIQUE `(company, ano, mes, regime)`.
   Sem o filtro de `regime` você soma caixa + competência e dobra tudo.
5. **Estoque no NCG = 0.** O engine usa `estoque_valor = 0` hardcoded. Valor real (se houver)
   está em `fin_estoque_valor` (preenchimento manual via Lovable). NCG sem estoque vem baixa.
6. **`fin_kpi_tributario` provavelmente vazia.** O painel tributário calcula no front. Pra
   carga tributária use `fin_dre_snapshots.impostos / receita_bruta` (efetiva observada).

## Tabelas núcleo (Omie sincronizado)
Migration `20260328200000_financial_module.sql`. PK `id uuid`, todas com `company text`.

### `fin_contas_receber`
`omie_codigo_lancamento bigint`, `omie_codigo_cliente bigint`, `nome_cliente text`,
`cnpj_cpf text`, `numero_documento text`, `numero_pedido text`,
`data_emissao date`, `data_vencimento date`, `data_recebimento date`, `data_previsao date`,
`valor_documento numeric(15,2)`, `valor_recebido numeric(15,2)`, `valor_desconto`,
`valor_juros`, `valor_multa`, **`saldo numeric GENERATED (= valor_documento − valor_recebido)`**,
`status_titulo text`, `categoria_codigo text`, `categoria_descricao text`, `departamento text`,
`centro_custo text`, `vendedor_id bigint`, `omie_ncodcc bigint`.
UNIQUE `(company, omie_codigo_lancamento)`.

### `fin_contas_pagar`
Espelha CR, com: `omie_codigo_cliente_fornecedor bigint`, `nome_fornecedor text`,
`data_pagamento date`, `valor_pago numeric(15,2)`,
**`saldo numeric GENERATED (= valor_documento − valor_pago)`**, `codigo_barras text`,
`tipo_documento text`, `categoria_codigo text`.

### `fin_contas_correntes`
`omie_ncodcc bigint`, `descricao text`, `banco text`, `agencia text`, `numero_conta text`,
`tipo text` (CC/PP/CI/CX), `saldo_data date`, **`saldo_atual numeric(15,2)`**, `ativo boolean`.
UNIQUE `(company, omie_ncodcc)`. **Saldo inicial de caixa = Σ `saldo_atual` WHERE `ativo`.**

### `fin_movimentacoes`
`omie_ncodmov bigint`, `omie_ncodcc bigint`, `data_movimento date`, `tipo text` (`'E'`/`'S'`),
`valor numeric`, `categoria_codigo text`, `conciliado boolean`, `omie_codigo_lancamento bigint`,
`natureza text` (CP/CR/TRF/OUT).

### `fin_categorias`
Plano de contas Omie: `omie_codigo text`, `descricao text`, `tipo text` (`'R'`/`'D'`/`'T'`),
`conta_pai text`, `nivel int`, `totalizadora boolean`, `ativo boolean`.
UNIQUE `(company, omie_codigo)`.

## DRE, confiabilidade e tributário

### `fin_dre_snapshots`
`ano int`, `mes int`, **`regime text NOT NULL ('caixa'|'competencia')`**, e as linhas
(`numeric(15,2)`): `receita_bruta`, `deducoes`, `receita_liquida`, `cmv`, `lucro_bruto`,
`despesas_operacionais`, `despesas_administrativas`, `despesas_comerciais`,
`despesas_financeiras`, `receitas_financeiras`, `resultado_operacional`, `outras_receitas`,
`outras_despesas`, `resultado_antes_impostos`, `impostos`, `resultado_liquido`.
Mais: **`qtd_categorias_sem_mapeamento int`**, `detalhamento jsonb`
(`{receitas, despesas, categorias_nao_mapeadas[]}`). UNIQUE `(company, ano, mes, regime)`.
- **caixa**: agrupa por `data_vencimento` (proxy histórico), filtra recebido/pago, usa
  `valor_recebido`/`valor_pago`.
- **competencia**: agrupa por `data_emissao`, tudo exceto CANCELADO, usa `valor_documento`.
  Default do front é `'competencia'`.

### `fin_confiabilidade`
Cobertura por `(company, ano, mes)`: `total_cr`, `total_cp`, `total_mov`, `cr_sem_categoria`,
`cp_sem_categoria`, `pct_mov_conciliado`, `mov_sem_titulo`, `dre_categorias_mapeadas`,
`dre_categorias_heuristica`, `dre_categorias_total`, **`pct_valor_mapeado numeric(5,2)`**,
`fechamento_status text`, `ultimo_sync timestamptz`. Populada pela RPC
`fin_calcular_confiabilidade(p_company, p_ano, p_mes)`.
- **Regra de regime**: `pct_valor_mapeado` alto + `dre_categorias_heuristica`/`qtd_categorias_sem_mapeamento`
  baixos ⇒ competência confiável. Senão, usar caixa com ressalva.

### `fin_categoria_dre_mapping`
`company text` (aceita `'_default'`), `omie_codigo text`, `dre_linha text` (CHECK em 11
valores: `receita_bruta, deducoes, cmv, despesas_operacionais, despesas_administrativas,
despesas_comerciais, despesas_financeiras, receitas_financeiras, outras_receitas,
outras_despesas, impostos`). UNIQUE `(company, omie_codigo)`. Empresa-específico **sobrepõe**
`_default`.

### `fin_kpi_tributario` (provavelmente vazia — não confie)
`ano`, `mes`, `regime`, `receita_bruta_acumulada` (RBT12 p/ Simples), `aliquota_efetiva`,
`carga_tributaria_total`, `faixa_sn text`, `fator_r`, `base_presuncao_*`, `irpj`, `csll`,
`pis`, `cofins`, `iss`, `icms`, `detalhamento jsonb`. Existe no schema mas sem código que a
popule — calcule carga via DRE.

## Cashflow / NCG / eventos / alertas
Migrations `20260519000*`. Fonte canônica de cálculo = edge function `fin-cashflow-engine`
(runtime, não persiste; por empresa única, não consolida).

### `fin_config_cashflow` (PK = `company`, 1 linha por empresa)
`overrides_cenario jsonb`, **`thresholds jsonb`** com chaves: `caixa_negativo_semanas`,
`ncg_deficit_alerta`, `dias_cobertura_min`, `inadimplencia_max_pct`,
`concentracao_top1_max_pct`, `pmr_crescimento_max_pct_90d`. `adiantamento_categorias_codigos text[]`.

### `fin_eventos_recorrentes`
`descricao`, `valor numeric(15,2)`, `tipo text ('entrada'|'saida')`, `categoria_dre text`,
**`is_folha boolean`**, `dia_do_mes int`, `inicio date`, `fim date`, `ativo boolean`.
Folha 30d (pro PCO) = Σ `valor` WHERE `is_folha AND tipo='saida' AND ativo`.

### `fin_eventos_eventuais`
`descricao`, `valor`, `tipo`, `categoria_dre`, `data_prevista date`, `data_realizada date`,
`status text ('previsto'|'confirmado'|'cancelado'|'realizado')`. Projeção usa `previsto`+`confirmado`.

### `fin_alertas`
`tipo text`, `severidade text ('info'|'aviso'|'critico')`, `mensagem text`, `valor numeric`,
`threshold numeric`, `contexto jsonb`, `dismissed_at`, `dismissed_by`, `dismissed_until`.
Alertas ativos = `dismissed_at IS NULL AND (dismissed_until IS NULL OR dismissed_until < now())`.

### `fin_projecao_snapshots`
`snapshot_at`, `cenario text ('realista'|'otimista'|'pessimista')`, `horizon_weeks int`,
`dados jsonb`, `ncg numeric`, `capital_giro_proprio numeric`, `saldo_tesouraria numeric`,
`dias_cobertura numeric`, `premissas jsonb`. Permite trend "a projeção piorou?".

### `fin_estoque_valor`
`data_ref date`, `valor numeric`, `fonte text`, `cobertura_pct`, `observacao`. Fonte do
estoque no ACO/NCG (mas o engine não lê — usa 0). Pega o `valor` mais recente por empresa.

## Fechamento, orçamento, intercompany
- `fin_fechamentos` — `ano`, `mes`, `status ('aberto'|'em_revisao'|'fechado'|'reaberto')`,
  `versao int`, `snapshot_dre_caixa_id`, `snapshot_dre_competencia_id`, `fechado_por/em`,
  `aprovado_por/em`. UNIQUE `(company, ano, mes, versao)`.
- `fin_orcamento` — `ano`, `mes`, `dre_linha text`, `valor_orcado numeric`. UNIQUE
  `(company, ano, mes, dre_linha)`. (Budget vs actual = juntar com `fin_dre_snapshots`.)
- `fin_forecast` — `tipo ('caixa'|'dre')`, `ano`, `mes`, `dre_linha`, `valor_forecast`,
  `metodo`, `confianca`.
- `fin_ic_matches` — matching intercompany CR↔CP: `empresa_origem`, `empresa_destino`,
  `cr_id`, `cp_id`, `diff_valor numeric GENERATED`, `status text` (inclui `divergencia_valor`,
  `sem_contrapartida`).
- `fin_eliminacoes_intercompany` (regras) + `fin_eliminacoes_log` (`ano`, `mes`, `valor_eliminado`).
- `fin_conciliacao` — `mov_id`, `tipo_titulo ('CR'|'CP')`, `titulo_id`, `status`,
  `diferenca numeric GENERATED`.

## RPCs e views úteis
- **`fin_categorias_sem_mapping(p_company text, p_start date, p_end date)`** → `(omie_codigo,
  categoria_nome, valor_periodo)` de categorias com valor sem linha em `fin_categoria_dre_mapping`.
  Filtra por `data_emissao`. **Use isto pro bloco 5.**
- `fin_calcular_confiabilidade(p_company, p_ano, p_mes)` — popula `fin_confiabilidade` (write —
  **não chamar**; só ler a tabela).
- `fin_projecao_13_semanas(p_company, p_saldo_inicial)` — projeção SQL simples (sem
  inadimplência nem eventos). Menos sofisticada que o engine; serve de cross-check rápido.
- Views agregadas (por `company`): `fin_aging_receber`, `fin_aging_pagar` (buckets
  `a_vencer`/`vencido_1_30`/`31_60`/`61_90`/`90_plus`, sufixos `_qtd`/`_valor`),
  `fin_fluxo_caixa_diario`, `fin_dre_competencia_base`.

## RLS
Todas as `fin_*` têm RLS. As policies têm duas gerações (`admin/manager` legado vs
`employee/master` nas tabelas A1) e podem não casar com os roles reais do app. **Irrelevante
pro SQL do dono no Lovable** (roda como `postgres`/service, bypassa RLS). Só relevante se a
skill orientar acesso autenticado pela app — o que ela não faz.
