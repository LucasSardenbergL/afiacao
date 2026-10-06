# Preço exato no PO Sayerlack — preço do portal + IPI por item

> Design · 2026-10-05 · decisões do founder, desenho do Claude · **money-path** (Codex no desenho e no código).
> Relacionados: [baixa de PO / D4'](2026-09-26-baixa-pedido-compra-nf-concluida-design.md) §17 ·
> [captura cega](../../historico/sayerlack-captura-custo-cega.md) · [reposicao.md §Portal Sayerlack](../../agent/reposicao.md).

## 1. Problema (medido em 2026-10-05 — `psql-ro` + tela do Omie)

- O PO nasce com o preço do **motor** (CMC ou média histórica: `disparar-pedidos-aprovados`, `nValUnit = preco_unitario`),
  não com o da Sayerlack, e **sem IPI** (`nValorIpi` = 0 em todos os POs). Na NF 000953881 (8 itens) o unitário do PO
  erra de −18,2% a +9,7% contra o da nota.
- A captura do preço do portal (`enviar-pedido-portal-sayerlack/captura-custo.ts`) falhou fechado em 24 dos 28 pedidos
  desde 06/09 (`checksum_divergente`). A "divergência de natureza não identificada" do cabeçalho da captura é o **IPI**.
- O pedido de 1 item passa (`json_total_unico`), mas grava `data.value` — que tem IPI — como total da linha: o IPI vai
  **embutido** no `nValUnit`.

## 2. Decisões (não re-litigar)

Do founder, no handoff (2026-10-05):

- o preço vem do **portal no momento do pedido** (os unitários da Sayerlack mudam "de mês em mês");
- o PO leva o unitário do portal **sem IPI** em `nValUnit` e o **IPI do item** em `nValorIpi`;
- a alíquota por NCM vem de **fonte medida**. Ausente ≠ zero: NCM sem alíquota não grava custo — nunca IPI 0 fabricado;
- a diferença residual entre pedido e nota fica para a conferência.

Do founder, nesta sessão:

- **D1** — `preco_unitario`/`valor_linha` continuam sendo **custo (com IPI)**. A decomposição (unitário sem IPI + IPI do
  item) vai em colunas novas, e é ela que o PO usa.
- **D2** — a tabela de alíquotas nasce com as **13 alíquotas medidas** (§3).

## 3. Evidência

**Backtest** sobre os 29 pedidos Sayerlack com protocolo (06/09 → 05/10). Entram as linhas do DOM
(`portal_resposta.itens_capturados`, Preço Venda em 4 casas), o total cobrado (`portal_add_json.value`) e o NCM de
`omie_products` (conta `oben`). Modelo da NF-e — linha e IPI arredondados por item:

- **29/29 fecham em ≤ R$ 0,02** (20 exatos). Quatro regras de arredondamento diferentes levam ao **mesmo** conjunto de
  alíquotas, e nenhuma reproduz 29/29 exatos: o portal arredonda por dentro com uma precisão que o DOM de 4 casas não
  mostra. A tolerância, portanto, sai do arredondamento (§6), não de "zero".
- **Identificabilidade:** trocar a alíquota de UM NCM pela vizinha erra no mínimo R$ 4,87. A exceção é 2922.19.19
  (R$ 0,18, uma linha de R$ 13,71) — ainda 12× a tolerância de 1 linha.
- **Cobertura:** dos 157 pedidos com protocolo desde jan/2026, **152 (97%)** têm todos os NCMs na tabela (só 53 com as
  4 da NF). Ficam de fora 3204.19.20 (6 linhas) e 3209.10.20 (2 linhas).

| NCM | Alíquota | Fonte | Linhas no backtest | Melhor alternativa erra |
|---|---|---|---|---|
| 3208.10.10 | 3,25% | portal | 30 | R$ 54,02 |
| 3208.10.20 | 3,25% | nf + portal | 19 | R$ 90,07 |
| 3208.20.19 | 3,25% | portal | 11 | R$ 70,35 |
| 3208.20.20 | 3,25% | nf + portal | 10 | R$ 22,75 |
| 3208.90.39 | 6,5% | nf + portal | 22 | R$ 109,84 |
| 3814.00.90 | 6,5% | nf + portal | 13 | R$ 50,17 |
| 3212.90.90 | 6,5% | portal | 2 | R$ 12,93 |
| 3214.10.20 | 1,3% | portal | 1 | R$ 4,87 |
| 3214.90.00 | 0% | portal | 13 | R$ 64,79 |
| 2915.39.99 | 0% | portal | 7 | R$ 18,82 |
| 3204.12.10 | 0% | portal | 2 | R$ 6,48 |
| 3808.92.19 | 0% | portal | 1 | R$ 5,91 |
| 2922.19.19 | 0% | portal | 1 | R$ 0,18 |

"nf" = NF 000953881 (Renner Sayerlack, emitida em 02/10/2026), lida na tela de recebimento do Omie em 05/10. Os 1,3%
são os 2% da TIPI com a redução de 35% de 2022 — mesma família de 5% → 3,25% e 10% → 6,5%.

## 4. Régua

- **Unidade cobrada:** o total do pedido no portal (`data.value`, em R$ com IPI, 2 casas); na NF, `vProd` + `vIPI` por
  item (2 casas).
- **Unidade decisória — o que o PO leva:** por item, o valor da mercadoria (Preço Venda do DOM, sem IPI) e o IPI do item.
  `nValUnit` = mercadoria ÷ quantidade (unidade Omie); `nValorIpi` = IPI da linha em R$.
- **Onde o sistema expõe:** `pedido_compra_item` (custo com IPI + decomposição) → `valor_total` (derivado) ≈
  `valor_total_portal_provado` (cobrado) → PO no Omie (`nValMerc` + `nValorIpi` = `nValTot`) → NF.
- **Denominador do sensor:** envios com protocolo, via `portal_resposta.captura_custo` (`fonte`, `motivo`, `cego`).
- **Como a prova falsifica:** `|Σ round2(PV_i) + Σ IPI_i − data.value| ≤ tol(n)`. Uma alíquota errada numa linha de R$ L
  desloca o total em L × Δalíquota (≥ R$ 4,87 nos dados) e estoura. Frete ou encargo não modelado também estoura —
  fail-closed.
- **Ordem das etapas irreversíveis:** portal (compra na fábrica, irreversível) → captura (RPC, reversível enquanto não há
  PO) → PO no Omie (irreversível na prática). A RPC só grava **antes** do PO (CAS); o PO lê o que estiver gravado.

## 5. Desenho

### 5.1 Dados — uma migration

- **`ipi_aliquota_ncm`**: `ncm text` PK (CHECK 8 dígitos) · `aliquota_pct numeric` (CHECK `0 ≤ x < 100`, que barra NaN e
  ±Infinity, e no máximo 2 casas, como a TIPI — é o que deixa o IPI exato em centavos dos dois lados, §5.2) · `fonte`
  (`'nf' | 'portal'`) · `evidencia` (não vazia) · `medido_em date` · `atualizado_em`. RLS ligada e sem policy: só
  service_role lê. A escrita é pelo SQL Editor. Seed: as 13 linhas do §3.
- **`pedido_compra_item`** ganha `preco_unitario_sem_ipi_portal`, `valor_ipi_portal`, `aliquota_ipi_portal` e
  `ncm_ipi_portal`. **Escritor único: a RPC do §5.3.** CHECK: as 4 nulas ou as 4 preenchidas, com finitude e faixa em
  cada uma.
- **`sayerlack_ipi_itens(p_pedido_id)`** devolve por item `item_id`, `ncm` (só os dígitos de `omie_products.ncm`, conta
  `lower(empresa)`) e `aliquota_pct` (NULL quando o NCM está fora da tabela). É **uma implementação só**: a edge calcula
  com ela e a RPC confere com ela. Fechada para anon e authenticated.

### 5.2 Captura — funções puras em `captura-custo.ts` + espelho byte a byte em `src/`

- A edge lê `sayerlack_ipi_itens` antes de consolidar. Erro na leitura vira o motivo `ipi_leitura_falhou` — não consegui
  ler ≠ não existe.
- Linha = Preço Venda do DOM (sem IPI). `IPI_i = round2(round2(PV_i) × alíq_i)`, calculado em **centavos inteiros**
  (meio centavo para cima, como o `round(numeric, 2)` do Postgres para valor positivo). Em ponto flutuante, a fronteira
  de meio centavo (ex.: R$ 2,00 × 3,25% = 0,065) podia dar 1 centavo diferente do SQL; em inteiros, o TS e a RPC
  produzem o MESMO IPI, e a RPC pode exigir igualdade exata.
- **Prova** (§6): `|Σ round2(PV_i) + Σ IPI_i − data.value| ≤ tol(n)`. Se falhar: `checksum_divergente`, nada gravado.
- O pedido de **1 item passa pela mesma prova**: a fonte é `dom_checksum` para 1 e N itens, e `json_total_unico` deixa de
  ser emitido. Fica a leniência histórica do sku não lido na linha única.
- Item sem alíquota: fonte `nenhuma`, motivo `ipi_ncm_desconhecido` e `ncm_sem_aliquota: [...]` no resumo — a lista do
  que falta cadastrar.
- `derivarCustos` devolve `{item_id, qtde_final, valor_mercadoria, valor_ipi}` para **todos** os itens. Some o pulo
  `sem_mudanca`, e com ele a leitura de `preco_atual` que só o alimentava: as colunas novas precisam nascer em todo item.
- O resumo ganha `ncm_sem_aliquota`, `checksum.ipi_modelado` e `checksum.total_modelado`, e mantém `soma_dom`,
  `total_json`, `delta_abs`, `delta_rel` e `tolerancia_abs`.

### 5.3 Escrita — `sayerlack_aplicar_custo_portal`, mesma assinatura, `CREATE OR REPLACE`

Payload por item: `{item_id, qtde_final, valor_mercadoria, valor_ipi}`. A RPC, nesta ordem:

1. **CP001** payload inválido: array vazio; item sem id inteiro; `qtde_final` ou `valor_mercadoria` não finitos ou ≤ 0;
   `valor_ipi` não finito ou < 0; total não finito ou ≤ 0. O payload antigo (`preco_unitario`/`valor_linha`) cai aqui.
2. **CP004** id repetido no payload.
3. CAS no próprio UPDATE (sem PO Omie + `sucesso_portal`), que grava o provado como hoje — **CP002**/**CP003**.
4. **CP004** o payload não cobre todos os itens do pedido, algum `qtde_final` difere do da linha (recusa se a
   quantidade mudou depois do envio) ou o `qtde_final` da linha não é inteiro. O PO manda `nQtde = ceil(qtde_final)`:
   com 3,6 L, `4 × mercadoria ÷ 3,6` passaria 11% da mercadoria. Hoje não acontece, porque o disparo persiste o `ceil`
   antes do portal e a captura só roda em produção; a recusa é a defesa na fronteira.
5. **CP006** item sem alíquota (via `sayerlack_ipi_itens`).
6. **CP007** o IPI do payload difere do recalculado com a alíquota da tabela (igualdade exata — os dois lados calculam
   em centavos, §5.2), ou `|Σ (round2(mercadoria_i) + IPI_i) − total provado| > tol(n)`.
7. Grava por item: o IPI, a alíquota e o NCM da tabela, `preco_unitario_sem_ipi_portal = round2(mercadoria) ÷ qtde`,
   `valor_linha = round2(mercadoria) + IPI` e `preco_unitario = valor_linha ÷ qtde`. Recalcula `valor_total`. É
   exatamente o que a prova validou: o conjunto gravado reproduz o total modelado ao centavo (princípio do Codex de
   06/09 — o checksum valida o que fica gravado, não outra coisa).

Tudo-ou-nada: qualquer RAISE desfaz o passo 3 também. O CP005 de hoje (derivado indeterminado: item sem `valor_linha`)
sai: com o payload cobrindo todos os itens e cada um gravado com `valor_linha > 0`, ele fica inalcançável — e guard
inalcançável não se prova nem se falsifica.

**Compatibilidade de deploy** — nenhuma combinação grava número errado:

| Banco | Edge de captura | Edge de disparo | Resultado |
|---|---|---|---|
| velho | nova | qualquer | payload novo → CP001 → captura cega; PO como hoje |
| novo | velha | qualquer | payload velho → CP001 → captura cega; PO como hoje |
| novo | nova | velha | custo com IPI gravado; PO com unitário COM IPI e sem `nValorIpi` — o mesmo do pedido de 1 item hoje (total certo) |
| novo | nova | nova | PO com `nValUnit` sem IPI + `nValorIpi` ✅ |

### 5.4 PO — `disparar-pedidos-aprovados`

- Item com decomposição (sem IPI > 0 e IPI ≥ 0, ambos finitos): `nValUnit = preco_unitario_sem_ipi_portal` e
  `nValorIpi = valor_ipi_portal`. Sem decomposição: como hoje (`nValUnit = preco_unitario`, sem `nValorIpi`).
- A leitura das colunas novas não quebra o disparo se a migration ainda não estiver aplicada: lê como hoje.
- Tela, e-mail e `valor_total` seguem com o custo com IPI — para quem lê, nada muda.

## 6. Tolerância

`tol(n) = 0,005 + 0,0101 · n`: meio centavo do `data.value` (2 casas) mais, por linha, o arredondamento da linha a
centavos (0,005), o do IPI do item (0,005) e o da exibição do Preço Venda em 4 casas (0,00005 × (1 + alíquota), com folga
até 100%).

Medido: pior delta R$ 0,02 (n = 7, 10 e 18) contra tolerâncias de R$ 0,076, 0,106 e 0,187. O menor deslocamento por
alíquota errada nos dados é R$ 0,18.

Risco residual aceito: uma alíquota errada numa linha de valor abaixo de tol/Δalíquota (por exemplo, < R$ 5,75 a 3,25%
num pedido de 18 linhas) passa — e o erro de dinheiro fica limitado à própria tolerância (≤ R$ 0,19 nesse pedido).

## 7. Implantação e prova em prod

Camadas, todas do founder: (1) a migration (SQL Editor ou envelope da sessão); (2) as edges que `bun run
pendencias:deploy` apontar — `disparar-pedidos-aprovados` e `enviar-pedido-portal-sayerlack`. A migration vai primeiro;
entre as edges, qualquer ordem é segura (§5.3). Antes de pedir o deploy das edges, `git log -S` de um símbolo novo de
cada uma na main: o sync do Lovable já reverteu arquivo recém-mergeado (#1445 → #1478).

Antes/depois, por query:

- próximo pedido Sayerlack: `captura_custo.fonte = 'dom_checksum'`, `cego = false` e itens com `valor_ipi_portal`;
- PO no Omie: `nValorIpi > 0` (`ConsultarPedCompra` ou tela). O 1º PO real é combinado com o founder;
- NF seguinte: total do PO = total da NF, ou a diferença explicada.

## 8. Testes

- **Deno + vitest (espelho):** casos reais — #2459 (1 item a 3,25%: 362,9698 → 374,77), #3091 (6,5% + 3,25%), #3168
  (18 linhas) —, NCM desconhecido, leitura que falha, prova estourada e payload.
- **Paridade TS×SQL** por arquivo-ouro com os 29 pedidos (`db/fixtures/`): o vitest e o PG17 conferem o mesmo IPI por
  linha e o mesmo veredito por pedido.
- **PG17** (`db/test-*.sh` + `db/nucleo-ci.txt`): CHECKs da tabela e das colunas, `sayerlack_ipi_itens` e cada SQLSTATE
  da RPC (CP001–CP004, CP006, CP007), com assert positivo e negativo. Falsificação: sabotar cada invariante com controle verde na
  mesma invocação, commitando antes.
- Os 6 gates da edge, `sonda:bump`/`sonda:fingerprint` das 2 edges e os registros `authz-funcoes-fechadas` e
  `audit-custom-migrations`.

## 9. Fora do escopo e riscos

- **Fora:** associação NF↔PO (D4'), backlog D3 e alimentar `ipi_aliquota_ncm` automaticamente pelas NFs (o recebimento
  não guarda IPI hoje — Fase 2).
- **NCM com "Ex" da TIPI** (alíquota diferente no mesmo NCM): a tabela é por NCM, então um produto num Ex diferente
  estoura a prova e a captura fica cega (fail-closed).
- **Decreto que mude uma alíquota:** a prova estoura nos pedidos daquele NCM e o sensor mostra `checksum_divergente`;
  conserto = atualizar a linha da tabela.
- **NF 5% abaixo do portal** (PO 1238, pergunta aberta ao founder): o PO segue o portal; se for desconto que o portal
  não mostra, a conferência acusa.
- **Pedido de 1 item com NCM fora da tabela** deixa de capturar (hoje captura com o IPI embutido). A cobertura é de 97% e
  o sensor lista o NCM que falta.

## 10. Pareceres Codex

- **Desenho: Caminho B.** O Codex não foi consultado: `scripts/codex-async.sh` saiu com exit 79 (`SALDO_ALTO` — cota em
  92%, acima do teto de 85%; a janela reabre em 09/10 às 19:30) sem gastar a chamada. Decisão do founder (05/10): o
  desenho segue pela RÉGUA (§4), escrita e conferida pelo Claude sobre o backtest executado, e o Codex fica para o
  adversarial de código. A conferência passou pelas 7 perguntas preparadas para o Codex e acrescentou dois pontos: a
  recusa de `qtde_final` não inteiro (§5.3, passo 4) e o `git log -S` antes do deploy (§7).
- **Código:** adversarial no diff final, com `CODEX_ASYNC_TETO_SALDO=0` (decisão do founder). Pendente.
