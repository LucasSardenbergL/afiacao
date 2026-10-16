# Raio-X do estoque parado — ferramenta no app (fase B) — design

**Data:** 2026-10-15 · **Status:** design aprovado em chat (seções 1–5), aguardando revisão da spec
**Antecessora:** [fase A — faxina](2026-10-14-raio-x-estoque-parado-design.md) (Artifact + `docs/superpowers/raio-x-estoque-parado/`, lógica testada em `logica.mjs`).

## 0. Portão trocado por decisão do founder

A spec da fase A condicionava a B ao sinal **medido** (100% do Top 61 decidido e ≥ R$ 60k liberados, medição a partir de 2026-11-25). Em **2026-10-15 o founder decidiu começar a B antes**, aceitando como sinal o **uso** da página: 17 decisões gravadas no Artifact (10 `liquidar`, 7 `estrategico`, 1 autor), ≈ 28% do Top 61. Motivo: terminar a faxina dentro do app (quem decidiu, motor de compras, missão ao vendedor) em vez de no Artifact solto. A meta e o prazo da fase A **continuam** e passam a ser lidos no próprio app (§5).

## 1. Objetivo e critério de pronto

Levar o Raio-X para dentro do app como **3ª aba "Raio-X"** da tela `admin/reposicao/baixo-giro` ("Baixo giro & estoque parado"), para Oben e Colacor.

Pronto quando:
- o comprador decide um SKU parado no app, e a decisão fica gravada com autor, data e foto do estoque;
- a decisão pode tirar o item do motor de compras na mesma transação, e o pedido de compra mostra o selo da decisão;
- a venda dirigida vira missão de desova **por cliente**;
- a medição de caixa liberado roda no app (card), sem ritual manual;
- as 17 decisões da fase A estão carregadas e o Artifact está em modo só leitura.

### Fora de escopo (YAGNI)
Colacor SC (sem cadastro em `omie_products`, R$ 37k) · fonte de venda da Colacor via `sales_orders` (melhoria isolada futura) · escrita no Omie · preço de liquidação sugerido · log append-only de decisões · notificação automática · edge function.

## 2. Diagnóstico de partida (psql-ro, 2026-10-15)

**Oben** (`inventory_position.account='oben'`; `vendas` duplica a Oben): universo parado da fase A ≈ 611 SKUs / R$ 341k. Estoque com saldo e CMC por tipo: `00` R$ 434k · `08` R$ 50k · `07` R$ 8,4k · `04` R$ 6,5k · `01` R$ 6,2k · `03` R$ 0,6k.

**Colacor** (`colacor_vendas`, R$ 2,79 mi, 1.456 SKUs): `08` R$ 1,48 mi · `01` R$ 649k · `00` R$ 228k · `07` R$ 199k · `03` R$ 141k · `04` R$ 52k · `99` R$ 42k.

**Limites do dado:**
- Venda por NF (`v_venda_items_history_efetivo`) **só existe para OBEN** (desde 2025-10-21). A Colacor não tem histórico de venda nas fontes do Raio-X → `q12 = null`, nunca 0.
- `sku_parametros` (motor de reposição) só existe para OBEN.
- `omie_products.tipo_produto` é coluna dedicada (escrita só pelo `omie-sync-metadados`, normalizada em 2 dígitos).

## 3. Arquitetura

**RPC de fatos em SQL + lógica em TS** (a forma da fase A: `fatos.sql` + `logica.mjs`). O SQL só junta fatos; categoria, destino sugerido, placar, listas e medição ficam em TS testado. Mudar uma regra = PR de front, sem migration.

### 3.1 RPC `raio_x_estoque_fatos(p_empresa text)`

Read-only, só staff, `REVOKE` de `PUBLIC` **e** `anon`. Set-returning e **paginada** (`.range()` + `order by sku`), porque a Colacor passa de 1.000 linhas (teto silencioso do PostgREST, inclusive em `.rpc()`).

Mapa de contas **dentro** da RPC (o front não repete a inconsistência do Baixo giro):

| `p_empresa` | estoque | cadastro | venda NF 12m |
|---|---|---|---|
| `oben` | `oben` | `oben` | `OBEN` |
| `colacor` | `colacor_vendas` | `colacor` | nenhuma (`q12`, `ncli`, `ult_venda`, clientes = `null`) |

Outra empresa → erro explícito.

Colunas por SKU: `sku`, `codigo`, `descricao`, `familia`, `tipo_produto`, `ativo`, `saldo`, `cmc`, `unidade_estoque`, `unidades_venda[]`, `no_motor`, `tipo_reposicao`, `classe_abc`, `cadastro_em`, `ult_entrada`, `fornecedor` (`sku_parametros.fornecedor_nome` → emitente da última NF de entrada → `null`), `q12`, `ncli`, `ult_venda`, `preco_medio_12m`, `clientes` (top 5: nome, última compra, qtd). Saldo > 0. CMC ausente/zero vem com `cmc = null` e é contado à parte ("sem custo — não avaliado"), nunca como R$ 0.

### 3.2 Lógica TS — `src/lib/reposicao/raio-x/`

Porte de `logica.mjs` (com os testes) para TypeScript strict.

**Categoria** (em ordem, a 1ª que casa vence; o motivo é sempre exibido):
1. **Marcação manual** (`raio_x_classificacao_manual`), nos dois sentidos: força `uso_consumo`, `nao_mercadoria` ou `mercadoria`.
2. **`nao_mercadoria`:** `tipo_produto = '08'`, família Imobilizado, ou descrição `MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY` sem venda em 12m.
3. **`uso_consumo`** (bloco "uso e consumo / insumo"): `tipo_produto ∈ {07, 01, 03}`, família contendo "uso e consumo", família `Concentrados MixMachine`, família `Concentrados LC` com descrição `^AT[LP]`, ou descrição `1000 ?KG` (granel).
4. **`mercadoria`:** o resto (inclui `00`, `04`, `99` e tipo nulo).

**Universo parado da mercadoria:**
- Oben: fora do motor **ou** `q12 = 0` **ou** cobertura > 180d (regra da fase A).
- Colacor: toda mercadoria com saldo (sem venda não há como separar parado de girando).

**Destino sugerido:** Oben usa a tabela da fase A (`novo_aguarde` → `revisar` por unidade → `trocar` → `venda_dirigida` → `manter_suspender_recompra` → `liquidar`). Com `q12 = null` (Colacor), a sugestão é `sem_historico` com o motivo "sem histórico de venda (NF) — decida manualmente". **Nunca** `liquidar` por falta de dado. A sugestão só pré-seleciona: nada conta como decidido sem o toque humano.

**Top N:** os 61 maiores R$ da mercadoria de cada empresa.

## 4. Banco

Duas tabelas novas, RLS ligada, leitura e escrita só staff (escrita só via RPC).

**`raio_x_classificacao_manual`** — PK `(empresa, sku_codigo_omie)`: `categoria` (CHECK nos 3 valores), `motivo` (NOT NULL, não vazio), `marcado_por`, `marcado_em`.

**`raio_x_decisao`** — PK `(empresa, sku_codigo_omie)`:
- `destino` (CHECK: `trocar`, `venda_dirigida`, `liquidar`, `manter_suspender_recompra`, `estrategico`, `erro_cadastro`; `null` = desfeita), `observacao`, `fornecedor_informado`, `credito_troca numeric` (null = não informado);
- `decidido_por`, `decidido_em` (mudam só quando o destino muda);
- **foto** `foto_saldo`, `foto_cmc`, `foto_valor`, `foto_categoria`, `foto_em`: gravada **pelo servidor** a partir de `inventory_position` na 1ª decisão e congelada depois (linha de base da medição);
- `tirou_do_motor boolean`, `motor_antes jsonb` (`tipo_reposicao` + `habilitado_reposicao_automatica` anteriores; só escrito por esta RPC);
- `qtd_contada`, `contado_por`, `contado_em` (contagem física dos blocos não-mercadoria/uso e consumo);
- `origem` (`app` | `artifact_fase_a`).

### 4.1 RPC `raio_x_decidir(p_empresa, p_sku, p_destino, p_categoria, p_observacao, p_fornecedor, p_credito_troca, p_tirar_do_motor, p_restaurar_motor)`

SECURITY DEFINER (as tabelas não têm política de escrita; o gate de staff é a 1ª linha da função), checa staff, `REVOKE` de `PUBLIC` e `anon`. **Uma transação:**
1. Upsert da decisão com a semântica do `mesclarDecisao` + foto congelada.
2. Se `p_tirar_do_motor` (só aceito com destino `trocar`, `liquidar` ou `manter_suspender_recompra`): grava `motor_antes` e atualiza `sku_parametros`:
   - `trocar` / `liquidar` → `tipo_reposicao='descontinuado'`, `habilitado_reposicao_automatica=false`;
   - `manter_suspender_recompra` → `tipo_reposicao='sob_encomenda'`, `habilitado_reposicao_automatica=false`.
   **Fail-closed:** 0 linhas afetadas (SKU sem `sku_parametros`) → `RAISE` com SQLSTATE própria e nada é gravado.
3. Se `p_restaurar_motor`: repõe exatamente `motor_antes` e zera `tirou_do_motor`. Mudar o destino **nunca** religa o motor sozinho.

Contagem física e marcação manual têm RPCs próprias e pequenas (`raio_x_contar`, `raio_x_classificar`), com o mesmo gate.

### 4.2 RPC `raio_x_medicao(p_empresa)`

Read-only, paginada. Por SKU decidido: a foto, o saldo atual, qtd vendida e receita (NF) desde `decidido_em`, o preço médio 12m, e as datas de `pedido_compra_item` criados depois de `decidido_em`. Colacor: venda = `null`.

## 5. Tela (aba "Raio-X")

- **Empresa** pelo seletor existente (`useReposicaoEmpresa`). Colacor SC → `EmptyState tone="operational"`: "sem cadastro de produto — fora do Raio-X por ora".
- **Placar** (só mercadoria): R$ decidido / R$ total com barra · R$ por destino · Top 61 · linha "R$ X sem custo — não avaliado". Ao lado, **sem somar**: "R$ que distorce o DIO" = não-mercadoria + uso e consumo.
- **Card "Caixa liberado"**: `medir()` em TS sobre `raio_x_medicao` → vendido · liquidado (preço < 90% do médio 12m) · trocado (crédito informado) · parado · recomprado, contra a meta de R$ 60k, com as **contradições** (decidiu tirar e houve pedido de compra depois) clicáveis. Caixa liberado e DIO reclassificado **nunca** são somados. Colacor: só "trocado" e "saiu do estoque (sem NF para atribuir: venda, consumo ou baixa?)", nunca "vendido".
- **Segmentos** (estado na URL via `useUrlState`):
  1. **Mercadoria:** tabela por R$ com filtros (destino sugerido, fornecedor, pendente/decidido, Top N, busca). A linha expande para os top 5 clientes. Em `pointer:coarse` vira cards.
  2. **Uso e consumo / insumo:** motivo da regra, "qtd contada" e diferença vs Omie (un e R$).
  3. **Não-mercadoria:** igual, com o selo "reclassificar com contador".
  4. **Saídas:** (a) lista de troca agrupada por fornecedor (copiar/CSV; o app não envia nada); (b) **venda dirigida por cliente**, com o botão "Criar missão" abrindo o `DesovaMissaoDialog` existente preenchido com todos os SKUs daquele cliente (1 tarefa por cliente).
- **Decidir** (`Sheet` lateral): destino com 1 toque (sugestão pré-selecionada), observação, fornecedor editável quando `null`, crédito de troca quando `trocar`, e o checkbox **"tirar do motor"**:
  - pré-marcado em `trocar`, `liquidar` e `manter_suspender_recompra`, escondido nos outros destinos;
  - "já fora do motor" quando já está;
  - na Colacor, "sem motor de reposição — nada a desligar".
  O link "reclassificar" abre a marcação manual (motivo obrigatório). "Restaurar motor ao estado anterior" aparece quando existe `motor_antes`.
- **Selo no pedido de compra** (`AdminReposicaoPedidos` / sugestão do motor): o SKU com decisão `trocar`/`liquidar`/`manter_suspender_recompra` mostra `text-status-warning` "Raio-X: <destino> · <data> · <autor>". Só avisa, não bloqueia.
- **Padrões:** `PageSkeleton`, `sonner`, `text-status-*`, `Button size="touch"`, erro honesto (falha na RPC → mensagem, nunca lista vazia fingindo "nada parado").
- **Sensor de uso:** o ledger é `raio_x_decisao` (decididos / universo, por empresa e data), mais `track('raio_x.decisao')`, `track('raio_x.missao_criada')` e `track('raio_x.reclassificacao')`.

## 6. Migração da fase A

- **Fonte:** `ArtifactData` do Artifact `MyvzRxHFpMnhfAufb6zg3p`, coleção `decisoes` (17 docs; campos `destino`, `decidido_em`, `decidido_por`, 1 autor).
- **Foto = retrato de 2026-10-14** (`retrato.json` do Artifact: saldo e CMC), para a linha de base da fase A não se mover. `decidido_por` = `auth.uid` do founder (confirmado que é o único autor), `decidido_em` original, `tirou_do_motor=false`, `origem='artifact_fase_a'`.
- **Aplicação:** script gera `INSERT … ON CONFLICT DO NOTHING` numa transação com pós-condição (`count(*) where origem='artifact_fase_a' = 17`), no envelope de escrita (pré-voo 🟢, validado por fora). As 17 linhas são mostradas ao founder antes.
- **Na tela:** os `liquidar` migrados mostram "decidido na fase A — motor não foi tocado" e a ação "tirar do motor agora".
- **Artifact:** depois da carga e do Publish, ele é republicado com o banner "migrado para o app → link" e a decisão desligada. Os dados no banco do Artifact são preservados.

## 7. Testes e validação

- **TS (vitest, TDD):** porte de `logica.test.mjs` mais casos para: tipo 07/01/03/08 · marcação manual vencendo nos dois sentidos · Colacor `q12=null` → `sem_historico` (nunca `liquidar`) · CMC ausente fora do placar · `medir()` da Colacor sem "vendido". Cada teste novo é **falsificado** (sabotar → vermelho; commit antes de sabotar).
- **SQL (PG17 `db/test-*.sh` / `prove-sql-money-path`):**
  - `raio_x_decidir` **executada**: foto pelo servidor e congelada; `motor_antes` + restaurar; fail-closed com SQLSTATE exata e nada gravado; `p_tirar_do_motor` recusado em destino fora dos 3.
  - RLS sob `SET ROLE authenticated` (customer negado) e `has_function_privilege` em `PUBLIC` e `anon`.
  - Paginação de `raio_x_estoque_fatos` acima de 1.000 linhas com ordem estável.
  - Strings casadas em ASCII, rodando em `LC_ALL=C` e em `pt_BR.UTF-8`.
- **Tela:** teste de erro honesto no padrão de `AdminReposicaoBaixoGiro.erro-honesto.test.tsx`. Arquivos novos registrados no módulo `reposicao` do manifesto.
- **2ª opinião:** `/codex` (via `scripts/codex-async.sh`) sobre `raio_x_decidir` e a medição (money-path).
- **Validação com dado real (psql-ro):** Oben bate o diagnóstico da fase A (~611 SKUs / R$ 341k; desvio > 2% → explicar antes de entregar); Colacor bate a tabela por tipo da §2; 3 SKUs entregues ao founder para conferir no Omie.

## 8. Entrega e deploy

| PR | conteúdo | observação |
|---|---|---|
| 1 | tabelas + 5 RPCs + testes SQL | **draft** até a migration estar aplicada em prod |
| 2 | lógica TS + aba Raio-X (leitura, placar, segmentos, saídas, missão por cliente) | depende do 1 aplicado |
| 3 | decisão + motor + selo no pedido de compra | |
| 4 | card de medição + carga das 17 + Artifact só leitura | |

| camada | quem |
|---|---|
| Migration | Claude prepara pelo ritual `lovable-db-operator`; a aplicação segue o ritual (envelope do Claude ou founder no SQL Editor); verificação por fora via psql-ro |
| Carga das 17 | Claude, no envelope |
| Publish do front (Lovable) | **founder**; Claude confere que o bundle no ar tem a aba |
| Edge | nenhuma |
| Adoção | o SW troca o build só quando o usuário recarrega; o sinal é a 1ª linha `origem='app'` em `raio_x_decisao` |

Antes de cada `gh pr create`: conferir `origin/main`, `gh pr list` e migrations paralelas em `sku_parametros` / `AdminReposicaoPedidos`.
