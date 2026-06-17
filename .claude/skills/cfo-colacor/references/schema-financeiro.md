# Schema financeiro — tabelas, colunas e armadilhas

> 📌 **Fonte canônica do schema financeiro = `.claude/skills/bi-colacor/references/schema-conventions.md`
> + `queries-financeiro.md`.** Este doc NÃO duplica — só registra o que é específico do ritual de
> fechamento (NCG, DRE caixa vs competência, tributário por regime). As armadilhas de status/saldo
> abaixo estão **alinhadas com a bi-colacor** (mesma verdade, validada no 1º fechamento real). Em
> qualquer divergência, a bi-colacor vence — atualize este doc, não invente.

Referência técnica pra adaptar os templates SQL. Identificadores **exatos** (não parafrasear).
Tudo read-only. Fonte: migrations `supabase/migrations/2026032820*`, `2026051900*` +
`src/integrations/supabase/types.ts` + hooks/edge functions financeiras + a `bi-colacor`.

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
> ⚠️ Itens 1-5 validados CONTRA PRODUÇÃO no 1º fechamento real (2026-06-16) — foram as
> armadilhas que quebraram o fechamento. Leia antes de confiar em qualquer filtro.

1. **🔴 `saldo` NÃO zera na baixa — filtre por `status_titulo`, NUNCA por `saldo > 0`.** Armadilha-mãe.
   Quando o Omie baixa um título, o sync **não** zera `saldo` nem preenche `data_recebimento`/`valor_recebido`
   — só muda o `status_titulo`. Logo títulos QUITADOS continuam com `saldo = valor_documento` e
   `data_recebimento IS NULL`, e `saldo > 0 AND data_recebimento IS NULL` conta quitado como aberto
   (ex.: CR aberto da Colacor apareceu como R$17,7M; o real era R$129k). O único marcador confiável é `status_titulo`.
2. **Valores reais de `status_titulo`** (o sync grava COM espaço — a doc antiga dizia MAIÚSCULO, errado):
   - **Receber**: aberto `IN ('A VENCER','ATRASADO','VENCE HOJE')` · quitado `'RECEBIDO'` · `'CANCELADO'`.
   - **Pagar**: aberto `IN ('A VENCER','ATRASADO')` · quitado `'PAGO'` · `'CANCELADO'`.
   - Vencido = `'ATRASADO'`. **NÃO existem** `'ABERTO'`/`'VENCIDO'`/`'PARCIAL'`/`'LIQUIDADO'`.
   - **Rode `00-sanity-status.sql` primeiro** — é onde se vê se o sync mudou os rótulos.
3. **Aging: conjunto por status, faixa por data.** Pegue os vencidos por `status_titulo IN ('ATRASADO','VENCE HOJE')`
   e calcule os dias com `CURRENT_DATE − data_vencimento`. O status defasa 1-7 dias (um "VENCE HOJE" já venceu),
   então a FAIXA vem da data; o CONJUNTO vem do status (nunca de `saldo`/`data_recebimento`, furados).
4. **`nome_cliente`/`cnpj_cpf` VAZIOS** em `fin_contas_receber`/`_pagar`; `omie_clientes` **não tem coluna
   de nome** (só `omie_codigo_cliente`, `empresa_omie`, `omie_codigo_vendedor`). Lista de cobrança sai por
   `omie_codigo_cliente`; nome real só via tabela de pedidos (`nome_fantasia`) — enriquecimento pendente.
   Nunca fabrique nome.
5. **Cruze com o engine como âncora.** Os alertas do engine (`fin_alertas`: `ncg_deficit`, `caixa_negativo`,
   `inadimplencia_alta`) usam a lógica certa (status). Se seu SQL diverge MUITO do engine, é contaminação
   por `saldo` — o engine é a verdade, conserte o SQL.
6. **DRE: sempre filtre `regime`.** `fin_dre_snapshots` tem UNIQUE `(company, ano, mes, regime)`.
   Sem o filtro de `regime` você soma caixa + competência e dobra tudo.
7. **Estoque = 0 e folha = 0 na prática.** `fin_estoque_valor` e `fin_eventos_recorrentes` (folha) estão
   VAZIAS neste ambiente → NCG e projeção saem cegas pro maior ativo (estoque) e maior saída (folha).
   Primeira ação de setup: valorar estoque + cadastrar folha. Sinalize sempre.
8. **`fin_kpi_tributario` e `fin_confiabilidade` provavelmente VAZIAS.** O painel tributário calcula no
   front; a confiabilidade nunca foi rodada. Pra carga use `fin_dre_snapshots.impostos / receita_bruta`;
   pra escolher regime do DRE tenha plano B (ver SKILL bloco 4), pois `pct_valor_mapeado` pode não existir.

## Tabelas núcleo (Omie sincronizado)
Migration `20260328200000_financial_module.sql`. PK `id uuid`, todas com `company text`.

### `fin_contas_receber`
`omie_codigo_lancamento bigint`, `omie_codigo_cliente bigint`, `nome_cliente text`,
`cnpj_cpf text`, `numero_documento text`, `numero_pedido text`,
`data_emissao date`, `data_vencimento date`, `data_recebimento date`, `data_previsao date`,
`valor_documento numeric(15,2)`, `valor_recebido numeric(15,2)`, `valor_desconto`,
`valor_juros`, `valor_multa`, **`saldo numeric GENERATED (= valor_documento − valor_recebido)`** —
⚠️ **NÃO confiável**: `valor_recebido` não é preenchido na baixa, então `saldo` não zera em título quitado
(ver armadilha 1). Pra "aberto", filtre por `status_titulo`, não por `saldo`.
`status_titulo text` (valores: `'A VENCER'`/`'ATRASADO'`/`'VENCE HOJE'`/`'RECEBIDO'`/`'CANCELADO'`),
`categoria_codigo text`, `categoria_descricao text`, `departamento text`,
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
  Filtra por `data_emissao`. ⚠️ **NÃO usar no SQL Editor** — é SECURITY DEFINER com gate de perfil
  (`auth.role()='service_role' OR fin_user_can_access(company)`; senão `RAISE 'Acesso negado: requer
  perfil financeiro'`, SQLSTATE **42501**), e a sessão do SQL Editor do Lovable não tem perfil. O
  **bloco 5 usa a query DIRETA equivalente** nas tabelas (CR+CP por `data_emissao` + categoria sem
  `dre_linha` no mapping, com fallback `_default`), não a RPC.
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
