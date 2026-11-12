# Contribuição por cliente — rodada 2, entrega 3 (2026-11-12)

> Programa "Venda por cliente" (spec `docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md`), rodada 2
> aprovada pelo founder em 12/11/2026. Frente de **rentabilidade** que não depende de as farmers usarem o app.
> Migration `20261113130000_venda_contribuicao_cliente.sql` · prova `db/test-venda-contribuicao.sh` (núcleo do CI)
> · tela: aba **Contribuição** em `/admin/venda-cliente` (master).

## O que é

`public.venda_contribuicao(janela, eixo, empresa, ordem, limite, offset)` — só o founder (`private.cap_custo_ler`
**e** `has_role master`: a capability sozinha admite employee estratégico). Uma tupla `jsonb` (snapshot único, sem a
capa de 1.000 do PostgREST), página estável por (métrica, chave). Eixos: empresa · cliente (comprador canônico) ·
pedido (ID interno) · SKU · família · vendedor (responde **indisponível** até a Entrega 2 criar a autoria do pedido).

Contribuição da linha = receita líquida do desconto − CMC − custo do prazo, **antes de impostos, frete e
devoluções**:

| Perna | Fonte | Quando falta |
|---|---|---|
| Receita líquida | `unit_price × quantity − desconto_valor` (R$ da linha) | desconto NULL ⇒ `nao_apurado`; negativo/NaN/> bruto ⇒ `invalido`; preço ≤ 0 ⇒ `sem_preco` — receita NULL, nunca a cheia |
| Custo | "CMC estimado pela posição anterior": `cmc_snapshot` mais recente com `data_posicao ≤ dia` e idade < 45 d | senão custo **atual** de `product_costs`, marcado `atual`; senão NULL |
| Prazo | títulos de `fin_contas_receber` casados ao pedido; `S = Σvᵢ(1+r)^(−dᵢ/365)/Σvᵢ`, `dᵢ = vencimento − emissão`, pesos por **valor** | motivo: `sem_titulo`, `ambiguo`, `cliente_nao_confere`, `titulo_invalido`, `valor_nao_bate`, `prazo_fora_faixa`, `taxa_ausente` |

Cada agrupamento traz as três camadas com o **seu** denominador (margem bruta sobre receita com custo; custo do
prazo sobre receita com prazo; contribuição sobre a **interseção**), e a ponte `receita − custo − prazo =
contribuição` fecha só na interseção (assert `APONTE`).

## Decisões (com o porquê)

- **Só snapshot, sem `cmc_ledger`** (Codex, desenho): o ledger registra mudança OBSERVADA, não vigência; misturar
  "o mais recente dos dois" não dá série homogênea. Idade 45 d: com a grade mensal, 30 d → 75,2% da receita da oben,
  45 d → 81,3%, 60 d → 85,3% (colacor 70,0 / 71,1 / 71,1). Os +4 p.p. de 60 d são pedidos recentes, onde o custo
  atual já é próximo — 45 d fica.
- **Casamento pedido → títulos**: `(company = account, btrim(numero_pedido) = btrim(omie_numero_pedido), status ≠
  CANCELADO, emissão ∈ [dia − 3, dia + 60])`. A colacor **reusa** o número do pedido (4.819 números com emissões a
  > 60 d entre si) — por isso: exclusividade do título contra **todos** os pedidos de venda com aquele número (não
  só os da janela: um título no limite de duas janelas financiaria dois pedidos — contraprova do Codex), cliente do
  título = cadastro Omie do pedido (`omie_customer_account_map`; 98–99% dos pares medidos batem) e
  `|Σ valor_documento − total| ≤ max(1, 0,5%·total)` (mantém 99% dos casados). Nunca se procura subconjunto de
  parcelas. Um 2º elo (cliente + data + valor, sem número) daria só +R$ 280k de R$ 3,1M não casados e é ambíguo —
  fora da v1.
- **Taxa**: a mesma régua de `fin_regua_custo_capital` (selic + spread, sem armazenagem), lida direto da
  configuração porque aquela função tem gate de staff por `auth.uid()` e o motor roda na pós-condição sem JWT. A
  prova cobra a paridade (`ATAXA`). Taxa **vigente** aplicada ao passado — rotulada.
- **Piso**: `resolve_markup_policy` (tier de `cliente_tier_preco`, hoje 0 linhas) comparado ao preço **líquido**
  unitário × custo selecionado. O repo (`medir_abaixo_piso_tier`) usa `unit_price` bruto e custo atual — aqui é de
  propósito: o bruto ignora a concessão que a tela existe para expor. `gap_piso` não é perda realizada e sobrepõe
  o desconto.
- **Não mexe** na margem da carteira (`private.margem_cliente_agregada`).

## Números de prod (psql-ro, 2026-11-12, corpo do motor executado; a RPC em si exige o JWT do founder)

| 12 meses | oben | colacor |
|---|---|---|
| Itens / pedidos | 10.482 / 4.700 | 2.683 / 1.382 |
| Receita bruta / desconto / líquida | R$ 5,51M / R$ 93,4k / R$ 5,38M | R$ 772k / R$ 3,1k / R$ 768k |
| Custo: na data / atual / sem (itens) | 8.511 / 1.890 / 81 | 1.923 / 725 / 35 |
| Margem bruta (receita com custo: 98,6% / 98,0%) | 47,74% | 59,16% |
| Pedidos com prazo `ok` | 1.867 (40,5% da receita) | 0 — 746 `taxa_ausente` |
| Custo do prazo | R$ 31,5k = 1,45% da receita coberta, prazo médio 32,6 d | — (prazo médio 23,0 d conhecido) |
| Contribuição | R$ 1,03M = 48,72% sobre 39,5% da receita | indisponível |
| Abaixo do piso (preço líquido) | 1.326 de 10.347 itens, gap R$ 110k | 125 de 2.645, gap R$ 9,2k |

90 dias: oben margem 48,94%, prazo `ok` em 505/1.128 pedidos (43,2% da receita), custo do prazo 1,31%,
contribuição 49,56%; colacor margem 62,31%, 186 pedidos `taxa_ausente`.

Status de prazo (12m, pedidos): oben `ok` 1.867 · `sem_titulo` 2.767 (R$ 3,12M) · `cliente_nao_confere` 40 ·
`valor_nao_bate` 26; colacor `taxa_ausente` 746 · `sem_titulo` 621 · `cliente_nao_confere` 9 · `valor_nao_bate` 6.

Desempenho: o motor em 12 meses roda em ~1,2 s quente (5,6 s com cache frio) contra o `statement_timeout` de 8 s
do `authenticated`; a aba só monta quando aberta.

### Delta contra a margem que a carteira mostra (item 4 — proposta, não troca)

Nos **mesmos** 4.001 itens da oben com receita, custo atual, custo da data e prazo conhecidos (R$ 2,10M brutos),
ponte em R$ com resíduo **0,0000**:

| | R$ | % |
|---|---|---|
| Margem da carteira (preço bruto − custo atual) | 1.020.982 | 48,50% s/ bruto |
| − desconto da linha | −6.936 | |
| + custo da data abaixo do atual | +38.479 | |
| − custo do prazo | −30.244 | |
| = Contribuição | 1.022.281 | 48,73% s/ líquida |

No agregado o número quase coincide **por compensação**: o custo atual (mais alto que o histórico) deprime a margem
da carteira em ~1,8 p.p., e isso cancela desconto + prazo. Por cliente não compensa — quem compra com mais desconto
ou mais prazo fica superestimado na carteira. No mesmo conjunto de itens de 12m (só custos conhecidos), margem com
custo da data 48,68% × custo atual 45,71% (oben) e 60,14% × 58,78% (colacor). **Proposta** (decisão do founder):
a carteira passar a usar preço líquido e custo da posição anterior; nada foi trocado nesta entrega.

### Conferência com o DRE (receita por competência)

O CR do DRE (`fin_dre_competencia_base`, origem `CR`) é exatamente a soma dos títulos emitidos no mês.

- **colacor**: receita líquida dos pedidos = 89–107% do CR mensal (mai–out/2026) — diferença de calendário pedido ×
  emissão.
- **oben**: pedidos = **123–148%** do CR mensal (~R$ 470k × ~R$ 360k). Por mês ~R$ 250k de pedidos não casam
  título, e ~R$ 120k de títulos não têm número de pedido. Em 6 meses, os pedidos oben sem título somam
  `faturado` R$ 858k · `separacao` R$ 432k · `importado` R$ 257k · `enviado` R$ 8,5k. O universo de venda do
  programa (o mesmo de `private.venda_linhas_pedido`) inclui `separacao`/`enviado` por desenho; `separacao` com
  meses de idade sugere status parado no espelho — **achado para a Entrega 2 (sync)**, não tocado aqui.
- CMC dos itens × CMV do DRE: não comparado — o DRE fase 2 não isola CMV por empresa de forma comparável ao CMC
  estimado; fica como conciliação explicada, não oráculo (Codex).

## Pendências que a tela mostra (e quem destrava)

1. **colacor sem taxa de capital** (`empresa_configuracao_custos` só tem `OBEN`): 746 pedidos com prazo conhecido
   ficam sem custo do prazo e sem contribuição. Destrava: cadastrar selic + spread da colacor (decisão do founder).
2. **58% dos pedidos oben sem título casado** (R$ 3,1M em 12m) — contribuição cobre ~40% da receita. Ver a
   conferência do DRE acima.
3. **Eixo vendedor** — quando a Entrega 2 criar a autoria do pedido, trocar o ramo `indisponivel` pela coluna.

## Prova

`db/test-venda-contribuicao.sh`: 49 asserts (gate, ACL, parâmetros, cardinalidade, cada perna e cada motivo de
degradação, janelas inclusivas, comprador canônico, ponte, paginação, ordem), 15 sabotagens — todas vermelhas no
assert declarado, com controle verde na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`. Testes TS:
`src/lib/venda-cliente/__tests__/contribuicao.test.ts` (borda) e
`src/components/venda-cliente/painel/__tests__/AbaContribuicao.estados.test.tsx` (falha ≠ R$ 0, eixo indisponível,
empresa sem taxa); a regra de situação foi falsificada (2 vermelhos exatos, 9 verdes).
