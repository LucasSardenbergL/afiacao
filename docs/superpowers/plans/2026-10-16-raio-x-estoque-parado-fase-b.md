# Raio-X do estoque parado — fase B (app) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levar o Raio-X do estoque parado para uma 3ª aba "Raio-X" em `admin/reposicao/baixo-giro`, para Oben e Colacor, com decisão gravada no banco, saída do motor de compras, missão por cliente e medição de caixa liberado.

**Architecture:** O SQL só junta fatos (`raio_x_estoque_fatos`, `raio_x_medicao`) e escreve por RPCs transacionais (`raio_x_decidir`, `raio_x_contar`, `raio_x_classificar`). Toda a regra (categoria, destino sugerido, placar, saídas, medição) é TS puro em `src/lib/reposicao/raio-x/`, portado de `docs/superpowers/raio-x-estoque-parado/logica.mjs` com os testes.

**Tech Stack:** Postgres 17 / Supabase (migration manual no Lovable), React 18 + TS strict, react-query, shadcn/ui, vitest, provas `db/test-*.sh` (PG17).

**Spec:** `docs/superpowers/specs/2026-10-15-raio-x-estoque-parado-fase-b-design.md` (ler inteira antes de qualquer task; a fase A e a `logica.mjs` são a referência das regras).

## Global Constraints

- Empresas: `oben` e `colacor`. Qualquer outra → RPC levanta erro; a tela da Colacor SC (`colacor_sc`) mostra `EmptyState tone="operational"` com "sem cadastro de produto — fora do Raio-X por ora".
- Mapa de contas (só dentro de SQL): oben → estoque `oben`, cadastro `oben`, venda `OBEN`; colacor → estoque `colacor_vendas`, cadastro `colacor`, venda nenhuma. **Nunca** a conta `vendas`.
- Ausente ≠ zero: `q12`/`ncli`/`ult_venda`/clientes da Colacor = `null`; CMC ausente ou ≤ 0 = `null`, contado como "sem custo — não avaliado", nunca R$ 0.
- Destinos: `trocar` · `venda_dirigida` · `liquidar` · `manter_suspender_recompra` · `estrategico` · `erro_cadastro`. Sugestões extras: `novo_aguarde` · `revisar` · `sem_historico`.
- Categorias: `nao_mercadoria` · `uso_consumo` · `mercadoria`.
- Tirar do motor só em `trocar`/`liquidar` (→ `tipo_reposicao='descontinuado'`) e `manter_suspender_recompra` (→ `'sob_encomenda'`), sempre com `habilitado_reposicao_automatica=false`.
- `TOP_N = 61` por empresa; `DIAS_NOVO = 90`; limiar de liquidação `0.9`; meta R$ 60.000.
- RPCs: staff = `public.has_role(auth.uid(),'employee') OR public.has_role(auth.uid(),'master')`; negado → SQLSTATE `42501`. `REVOKE ALL … FROM PUBLIC, anon` em toda função, verificado por `has_function_privilege`.
- Fail-closed do motor: SQLSTATE `RX001`, mensagem começando com `raio_x: sku sem sku_parametros`.
- Paginação PostgREST: toda leitura de RPC set-returning usa `.range()` + `order by sku_codigo_omie` até página vazia (teto silencioso de 1.000).
- Código e rotas em pt-BR; toast só `sonner`; cores `text-status-*`; filtros com `useUrlState`; `track('raio_x.<acao>')`.
- Arquivo novo em `src/` registrado no módulo `reposicao` de `src/lib/modulos/manifesto.ts` (os globs `src/lib/reposicao/**` e `src/components/reposicao/**` já cobrem; teste de página novo listado explicitamente).
- Migration: **um arquivo novo** `supabase/migrations/20261016120000_raio_x_estoque_parado.sql`, construído nas Tasks 1–3 e aplicado pelo ritual `lovable-db-operator` (Task 4). Nunca editar migration existente.
- Testes SQL rodam nos dois ambientes (`LC_ALL=C` e `LOCALE=pt_BR.UTF-8`); asserções ASCII, caixa fixa, sem `-i`; controle verde e sabotagem na MESMA invocação; commit antes de sabotar.

## Review Focus

1. **SKU com saldo sem linha em `omie_products`** (tipo, família e descrição nulos) → precisa aparecer como `mercadoria` com motivo "sem cadastro no Omie", nunca sumir nem quebrar a categorização. Teste na Task 5.
2. **Estoque muda entre abrir a tela e decidir** → a foto vem do `inventory_position` no servidor, e um saldo enviado pelo cliente não existe na assinatura. Teste na Task 2 (foto = valor do banco após alterar o saldo entre duas chamadas; a 2ª decisão não move a foto).
3. **`inventory_position` com mais de uma linha por SKU na mesma conta** (synced_at diferentes) → a RPC usa só a mais recente; duplicar dobraria o R$. Teste na Task 1.
4. **Trocar a empresa no seletor com o Sheet de decisão aberto** → a decisão grava a empresa da LINHA, não a do seletor, e o Sheet fecha quando a empresa muda. Teste na Task 11.
5. **Sync de estoque velho** (`max(synced_at)` da conta > 24h) → a aba mostra o aviso `text-status-warning` "estoque sincronizado há N h — números podem estar defasados" (a fase A bloqueava a publicação por isso). A RPC devolve `synced_at`; teste na Task 7.

---

## PR 1 — Banco (fica DRAFT até a migration estar aplicada em prod)

### Task 1: Tabelas + RLS + `raio_x_estoque_fatos`

**Files:**
- Create: `supabase/migrations/20261016120000_raio_x_estoque_parado.sql`
- Create: `db/test-raio-x-fatos.sh`

**Interfaces:**
- Produces (SQL):
  - `raio_x_classificacao_manual(empresa text, sku_codigo_omie bigint, categoria text, motivo text, marcado_por uuid, marcado_em timestamptz, PK(empresa, sku_codigo_omie))`, CHECK `categoria in ('nao_mercadoria','uso_consumo','mercadoria')`, CHECK `length(btrim(motivo)) > 0`.
  - `raio_x_decisao(empresa text, sku_codigo_omie bigint, destino text null, observacao text, fornecedor_informado text, credito_troca numeric, decidido_por uuid, decidido_em timestamptz, foto_saldo numeric, foto_cmc numeric, foto_valor numeric, foto_categoria text, foto_em timestamptz, tirou_do_motor boolean not null default false, motor_antes jsonb, qtd_contada numeric, contado_por uuid, contado_em timestamptz, origem text not null default 'app' check in ('app','artifact_fase_a'), atualizado_em timestamptz, PK(empresa, sku_codigo_omie))`, CHECK `destino` nos 6 destinos ou null, CHECK `empresa in ('oben','colacor')`.
  - RLS ligada nas duas; política SELECT só staff; **nenhuma** política de INSERT/UPDATE/DELETE (escrita só via RPC SECURITY DEFINER da Task 2).
  - `raio_x_estoque_fatos(p_empresa text) returns table(sku_codigo_omie bigint, codigo text, descricao text, familia text, tipo_produto text, ativo boolean, saldo numeric, cmc numeric, unidade_estoque text, unidades_venda text[], no_motor boolean, tipo_reposicao text, classe_abc text, cadastro_em date, ult_entrada date, fornecedor text, q12 numeric, ncli int, ult_venda date, preco_medio_12m numeric, clientes jsonb, synced_at timestamptz)`, STABLE, SECURITY INVOKER, `order by sku_codigo_omie`. `clientes` = array de até 5 `{nome, ult, qtd}` por qtd desc.

- [ ] **Step 1: Escrever `db/test-raio-x-fatos.sh`** no molde de `db/test-fin-ciclo-rpc.sh` (PG17 local, cópia da migration, stubs de `inventory_position`, `omie_products`, `sku_parametros`, `v_venda_items_history_efetivo`, `nfe_recebimentos`/`_itens`, `has_role`, `auth.uid()`). Asserções:
  - (a) oben: SKU com 2 linhas em `inventory_position` (synced_at diferentes) volta 1 vez, com o saldo da mais recente;
  - (b) linha na conta `vendas` nunca aparece;
  - (c) colacor lê `colacor_vendas`; `q12`, `ncli`, `ult_venda` e `clientes` são NULL (`IS NULL`, não 0);
  - (d) `cmc = 0` volta `cmc IS NULL`;
  - (e) SKU sem `omie_products` volta com `tipo_produto IS NULL`, sem sumir;
  - (f) 1.205 SKUs semeados → `count = 1205` e ordem estritamente crescente;
  - (g) `p_empresa='colacor_sc'` → erro;
  - (h) customer sob `SET LOCAL ROLE authenticated` → `42501`; `has_function_privilege('anon', …,'EXECUTE')` = f e idem `public`;
  - (i) `select` direto em `raio_x_decisao` como customer → 0 linhas, e `insert` → erro de RLS.
- [ ] **Step 2:** `bash db/test-raio-x-fatos.sh > logs/rx1.log 2>&1; echo "exit=$?"` → exit ≠ 0 (a migration ainda não existe).
- [ ] **Step 3: Escrever as tabelas e a RPC** na migration. Partir de `docs/superpowers/raio-x-estoque-parado/fatos.sql`; deduplicar estoque com `distinct on (omie_codigo_produto) … order by synced_at desc`; o mapa de contas é um `case p_empresa`; `else raise exception using errcode='22023'`.
- [ ] **Step 4:** rodar nos dois locales → `exit=0` nas duas, com o marcador final `RAIOX-FATOS-OK`.
- [ ] **Step 5: Sabotagens** (uma por vez, sobre cópia, no mesmo laço do controle verde): tirar o `distinct on` → (a) vermelha; trocar `oben` por `vendas` → (b) vermelha; `coalesce(q12,0)` → (c) vermelha; tirar `anon` do REVOKE → (h) vermelha.
- [ ] **Step 6: Commit** `feat(raio-x): tabelas + RPC de fatos do estoque parado (prova PG17)`.

### Task 2: `raio_x_decidir`, `raio_x_contar`, `raio_x_classificar` (money-path)

**Files:**
- Modify: `supabase/migrations/20261016120000_raio_x_estoque_parado.sql`
- Create: `db/test-raio-x-decidir.sh`

**Interfaces:**
- Consumes: as tabelas da Task 1.
- Produces (SQL, todas SECURITY DEFINER `set search_path=public`, gate staff na 1ª linha, `REVOKE … FROM PUBLIC, anon`, `GRANT EXECUTE … TO authenticated`):
  - `raio_x_decidir(p_empresa text, p_sku bigint, p_destino text, p_categoria text, p_observacao text, p_fornecedor text, p_credito_troca numeric, p_tirar_do_motor boolean, p_restaurar_motor boolean) returns raio_x_decisao`
  - `raio_x_contar(p_empresa text, p_sku bigint, p_qtd numeric) returns raio_x_decisao` (null limpa a contagem)
  - `raio_x_classificar(p_empresa text, p_sku bigint, p_categoria text, p_motivo text) returns raio_x_classificacao_manual` (`p_categoria` null apaga a marcação)

Regras de `raio_x_decidir`, em ordem:
1. `p_tirar_do_motor` com destino fora de (`trocar`, `liquidar`, `manter_suspender_recompra`) → `22023`.
2. Upsert. `decidido_por/em` mudam só se `destino` mudar (`IS DISTINCT FROM`); destino null zera os dois.
3. Foto só quando `foto_em is null`: saldo e CMC lidos de `inventory_position` (mesmo mapa/dedupe da Task 1); `foto_categoria = p_categoria` (a categoria é calculada em TS; é rótulo, não dinheiro, por isso pode vir do cliente).
4. Tirar do motor: se `sku_parametros` já está `habilitado_reposicao_automatica=false` com o mesmo `tipo_reposicao` alvo → não escreve, `tirou_do_motor` fica como está. Senão grava `motor_antes = jsonb_build_object('tipo_reposicao',…, 'habilitado',…)` (só se ainda null), faz o UPDATE e `GET DIAGNOSTICS n`; `n = 0` → `RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)' USING ERRCODE='RX001'` (desfaz tudo).
5. `p_restaurar_motor` (exige `motor_antes` não nulo, senão `22023`): repõe os dois campos, `tirou_do_motor=false`, `motor_antes=null`.


- [ ] **Step 1: Escrever `db/test-raio-x-decidir.sh`.** Asserções:
  - (a) 1ª decisão grava a foto = saldo×cmc do banco; muda o saldo no stub; 2ª decisão com outro destino → foto igual à 1ª e `decidido_em` novo;
  - (b) mesma chamada com o mesmo destino → `decidido_em` inalterado;
  - (c) `liquidar` + tirar → `sku_parametros` vira `descontinuado`/false, `motor_antes` guarda o anterior;
  - (d) `manter_suspender_recompra` + tirar → `sob_encomenda`/false;
  - (e) SKU sem `sku_parametros` + tirar → SQLSTATE `RX001` **e** `raio_x_decisao` sem linha para o SKU (nada gravado pela metade);
  - (f) `venda_dirigida` + tirar → `22023`;
  - (g) restaurar → `sku_parametros` igual ao estado inicial e `motor_antes IS NULL`;
  - (h) mudar destino para `estrategico` depois de tirar → `sku_parametros` continua descontinuado;
  - (i) customer → `42501` nas 3 funções; `anon`/`public` sem EXECUTE;
  - (j) `raio_x_classificar` com motivo `'  '` → erro de CHECK;
  - (k) `raio_x_contar(…, null)` limpa `qtd_contada`, `contado_por`, `contado_em`.
- [ ] **Step 2:** rodar → vermelho (funções ausentes).
- [ ] **Step 3:** implementar as 3 funções na migration conforme as regras acima.
- [ ] **Step 4:** rodar nos dois locales → `exit=0`, marcador `RAIOX-DECIDIR-OK`.
- [ ] **Step 5: Sabotagens:** trocar `IS DISTINCT FROM` por `true` → (b) vermelha; remover o `RAISE` do `n=0` → (e) vermelha; mover o UPDATE do motor para antes do upsert sem transação única (ou `exception when others then null`) → (e) vermelha; tirar a guarda `foto_em is null` → (a) vermelha.
- [ ] **Step 6: Commit** `feat(raio-x): RPCs de decisão/contagem/classificação com motor fail-closed (prova PG17)`.

### Task 3: `raio_x_medicao`

**Files:**
- Modify: `supabase/migrations/20261016120000_raio_x_estoque_parado.sql`
- Modify: `db/test-raio-x-fatos.sh` (seção nova)

**Interfaces:**
- Produces: `raio_x_medicao(p_empresa text) returns table(sku_codigo_omie bigint, destino text, decidido_em timestamptz, foto_saldo numeric, foto_cmc numeric, foto_valor numeric, foto_categoria text, credito_troca numeric, saldo_atual numeric, qtd_vendida numeric, receita numeric, preco_medio_12m numeric, compras_apos timestamptz[])`, STABLE, INVOKER, gate staff, paginável por `sku_codigo_omie`. Só linhas com `destino is not null`. Colacor: `qtd_vendida`/`receita` NULL. `compras_apos` = `pedido_compra_item.created_at > decidido_em` do SKU.
- [ ] **Step 1:** asserções novas: (a) venda antes de `decidido_em` não conta; (b) Colacor → `qtd_vendida IS NULL`; (c) pedido de compra depois da decisão aparece em `compras_apos`, antes não; (d) SKU sem saldo atual → `saldo_atual = 0` só se existe linha com 0, `NULL` se não há linha.
- [ ] **Step 2:** rodar → vermelho. **Step 3:** implementar. **Step 4:** verde nos dois locales.
- [ ] **Step 5: Sabotagem:** `>=` por `>` invertido no filtro de data → (a) vermelha.
- [ ] **Step 6: Commit** `feat(raio-x): RPC de medição desde a decisão`.

### Task 4: 2ª opinião, apply e tipos

**Files:**
- Modify: `src/integrations/supabase/types.ts` (tabelas + 5 RPCs)
- Modify: `docs/runbooks/` ou registro que o ritual `lovable-db-operator` exigir (`bun run audit:migrations`)

- [ ] **Step 1:** `/codex` via `scripts/codex-async.sh` (background) sobre a migration inteira, com foco em `raio_x_decidir` e no gate. Achados aceitos → voltam às Tasks 1–3 com teste.
- [ ] **Step 2:** invocar a skill `lovable-db-operator` e seguir o ritual (pré-flight de prod: nenhum objeto `raio_x_*` existe; PR com "ATENÇÃO: migration manual necessária" e o SQL no corpo).
- [ ] **Step 3:** depois de aplicado, verificar por fora com psql-ro: as 2 tabelas, RLS ligada, as 5 funções, `has_function_privilege` de `anon` e `public` = f, e `select count(*) from raio_x_estoque_fatos('oben')` retorna sem erro (como `claude_ro`, se o gate permitir; senão pelo conector).
- [ ] **Step 4:** acrescentar os tipos em `types.ts`; `heavy bun run typecheck` → exit 0.
- [ ] **Step 5:** tirar o PR 1 de draft só com a Step 3 colada no PR.

---

## PR 2 — Lógica TS + aba Raio-X (leitura)

### Task 5: Categoria e destino sugerido

**Files:**
- Create: `src/lib/reposicao/raio-x/tipos.ts`, `src/lib/reposicao/raio-x/classificar.ts`
- Test: `src/lib/reposicao/raio-x/__tests__/classificar.test.ts`

**Interfaces:**
- Produces:
  - `type Empresa = 'oben' | 'colacor'`; `type Categoria = 'nao_mercadoria' | 'uso_consumo' | 'mercadoria'`; `type Destino` (6 valores); `type Sugestao = Destino | 'novo_aguarde' | 'revisar' | 'sem_historico'`.
  - `type FatoSku` = colunas da RPC da Task 1, em snake_case idêntico ao retorno (sem camada de mapeamento).
  - `type ItemRaioX = FatoSku & { valor: number | null; cobertura: number | null; categoria: Categoria; motivo_categoria: string; parado: boolean; destino_sugerido: Sugestao | null; motivo_destino: string; top: boolean }`.
  - `categorizar(f: FatoSku, manual?: { categoria: Categoria; motivo: string }): { categoria: Categoria; motivo: string }`
  - `sugerirDestino(f: FatoSku, hoje: string): { destino: Sugestao; motivo: string }`
  - `classificar(fatos: FatoSku[], manuais: Map<number, {categoria: Categoria; motivo: string}>, empresa: Empresa, hoje: string): ItemRaioX[]` — ordenado por valor desc (nulos ao fim), `top` nos 61 maiores da mercadoria parada.
- [ ] **Step 1: Portar** os casos de `docs/superpowers/raio-x-estoque-parado/logica.test.mjs` referentes a `categorizar`/`sugerirDestino`/`classificar` para vitest, e acrescentar:
  - `tipo_produto` `'08'` → `nao_mercadoria`, motivo contém `tipo 08`;
  - `'07'`, `'01'`, `'03'` → `uso_consumo`, motivo contém o código;
  - família `'Material de Uso e Consumo'` → `uso_consumo`;
  - `'04'` e `'00'` → `mercadoria`;
  - manual `mercadoria` num `'07'` → `mercadoria` com o motivo manual; manual `uso_consumo` num `'00'` → `uso_consumo`;
  - sem cadastro (tipo/família/descrição null) → `mercadoria`, motivo `sem cadastro no Omie` (Review Focus 1);
  - `q12: null` → `sugerirDestino` = `sem_historico`, motivo `sem histórico de venda (NF) — decida manualmente`; nunca `liquidar`;
  - `cmc: null` → `valor: null`, fica fora do Top;
  - Oben: `parado` = `!no_motor || q12===0 || cobertura>180`; Colacor: `parado` = toda mercadoria.
- [ ] **Step 2:** `heavy bun run test src/lib/reposicao/raio-x` → FAIL (módulo inexistente).
- [ ] **Step 3:** implementar em `classificar.ts`, mantendo as regex e a ordem de `logica.mjs`.
- [ ] **Step 4:** → PASS. **Step 5: Falsificar:** apagar a regra `q12 === null` → o teste `sem_historico` fica vermelho; reverter.
- [ ] **Step 6: Commit** `feat(raio-x): categoria por tipo Omie + destino sugerido (porte da fase A)`.

### Task 6: Placar, saídas, contagem e medição

**Files:**
- Create: `src/lib/reposicao/raio-x/placar.ts`, `src/lib/reposicao/raio-x/saidas.ts`, `src/lib/reposicao/raio-x/medir.ts`
- Test: `src/lib/reposicao/raio-x/__tests__/{placar,saidas,medir}.test.ts`

**Interfaces:**
- Consumes: `ItemRaioX`, `Destino` (Task 5).
- Produces:
  - `type DecisaoRow` = linha de `raio_x_decisao` (snake_case).
  - `placar(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): { total; decidido; pendente; porDestino: Partial<Record<Destino, number>>; topTotal; topDecidido; semCustoN: number; distorceDio: number }` (só mercadoria parada com valor; `distorceDio` = soma de `nao_mercadoria` + `uso_consumo` com valor, separado).
  - `listaTroca(itens, decisoes): { sku_codigo_omie; codigo; descricao; saldo; valor; fornecedor: string }[]`
  - `vendaDirigidaPorCliente(itens, decisoes): { cliente: string; valor: number; itens: ItemRaioX[] }[]`
  - `diffContagem(item: ItemRaioX, qtd: number | null): { dif_un: number; dif_valor: number | null } | null`
  - `type LinhaMedicao` = retorno da RPC da Task 3; `medir(linhas: LinhaMedicao[], empresa: Empresa): { vendido; liquidado; margem_sacrificada; trocado; caixa_liberado; parado; recomprado; saiu_sem_nf: number | null; contradicoes: {sku_codigo_omie: number; destino: Destino; pedido_em: string}[]; sem_medicao: number[] }`.
- [ ] **Step 1:** portar os testes de `placar`, `listaTroca`, `vendaDirigidaPorCliente`, `diffContagem` e `medir` de `logica.test.mjs`, e acrescentar:
  - `medir(…, 'colacor')` → `vendido === 0`, `liquidado === 0`, `saiu_sem_nf` = (foto_saldo − saldo_atual)×foto_cmc;
  - `medir(…, 'oben')` → `saiu_sem_nf === null`;
  - `placar` não soma `distorceDio` em `total`;
  - item com `valor: null` incrementa `semCustoN` e não entra em `total`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (a `medir` recebe a foto da linha no lugar do retrato). **Step 4:** PASS.
- [ ] **Step 5: Falsificar** `caixa_liberado` somando `distorceDio` → teste vermelho; reverter.
- [ ] **Step 6: Commit** `feat(raio-x): placar, saídas e medição em TS`.

### Task 7: Hook de dados + erro honesto + sync velho

**Files:**
- Create: `src/components/reposicao/raioX/useRaioX.ts`
- Test: `src/components/reposicao/raioX/__tests__/useRaioX.test.ts`

**Interfaces:**
- Consumes: as RPCs (Tasks 1–3), `classificar`, `placar` (Tasks 5–6), `fetchAllPages` de `@/lib/postgrest` (o mesmo usado por `useExcessoEstoque`).
- Produces: `useRaioX(empresa: Empresa | null): { itens: ItemRaioX[]; decisoes: Map<number, DecisaoRow>; placar: ReturnType<typeof placar>; syncedHoras: number | null; isLoading: boolean; erro: Error | null }`. `empresa === null` → query desligada. Query keys: `['raio-x', empresa, 'fatos' | 'decisoes' | 'manuais' | 'medicao']`.
- [ ] **Step 1:** testes com supabase mockado: (a) RPC com erro → `erro` preenchido e `itens` vazio (a tela usa `erro`, não a lista); (b) 1.205 linhas em 2 páginas → 1.205 itens; (c) `synced_at` de 30h atrás → `syncedHoras >= 24` (Review Focus 5).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(raio-x): hook de leitura paginada`.

### Task 8: Aba Raio-X — placar e segmentos

**Files:**
- Create: `src/components/reposicao/raioX/RaioXTab.tsx`, `RaioXPlacar.tsx`, `RaioXMercadoria.tsx`, `RaioXContagem.tsx` (serve os segmentos 2 e 3, com o prop `categoria`)
- Modify: `src/pages/AdminReposicaoBaixoGiro.tsx:105-107` (novo `TabsTrigger value="raio-x"` + `TabsContent`)
- Test: `src/pages/__tests__/AdminReposicaoBaixoGiro.raio-x.test.tsx`; registrar no manifesto (`src/lib/modulos/manifesto.ts`, módulo `reposicao`, ao lado da linha 578)

**Interfaces:**
- Consumes: `useRaioX`, `useReposicaoEmpresa`.
- Produces: `<RaioXTab />`; segmento na URL `?rx=mercadoria|uso|nao|saidas` (`useUrlState`), filtros `rxDestino`, `rxForn`, `rxStatus=pendente|decidido`, `rxTop=1`, `rxBusca`.
- [ ] **Step 1:** testes de render: (a) erro na RPC → texto `Não foi possível carregar o Raio-X` e **não** o empty state de "nada parado"; (b) `colacor_sc` → `fora do Raio-X por ora`; (c) `syncedHoras=30` → `estoque sincronizado há 30 h`; (d) placar mostra `distorce o DIO` separado do total; (e) item Colacor mostra `sem histórico de venda (NF)`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar com `PageSkeleton`, `EmptyState tone="operational"`, tabela no desktop e cards em `pointer:coarse`, linha expansível com os top 5 clientes. **Step 4:** PASS.
- [ ] **Step 5:** `heavy bun run typecheck && bun lint` → exit 0.
- [ ] **Step 6: Commit** `feat(raio-x): aba Raio-X com placar e segmentos`.

### Task 9: Saídas + missão por cliente

**Files:**
- Create: `src/components/reposicao/raioX/RaioXSaidas.tsx`
- Modify: `src/components/reposicao/baixoGiro/DesovaMissaoDialog.tsx:24-43` — o prop `alvos` passa a ser `AlvoDesova[]` (de `@/lib/reposicao/desova-helpers`) e ganha `tituloPrefixo?: string`; `AdminReposicaoBaixoGiro.tsx` (a aba Excesso) passa a mapear `RowExcesso → AlvoDesova` no call site.
- Modify: `src/lib/reposicao/desova-helpers.ts` — `formatarMissaoDesova(alvos, tituloPrefixo?)` prefixa o título (`"Cliente X — "`).
- Test: `src/lib/reposicao/__tests__/desova-helpers.test.ts` (caso novo), `src/components/reposicao/raioX/__tests__/RaioXSaidas.test.tsx`

**Interfaces:**
- Consumes: `listaTroca`, `vendaDirigidaPorCliente` (Task 6).
- Produces: alvo da missão por item = `{ sku_codigo_omie, sku_descricao, excedente_un: saldo, capital_excedente: valor, tempo_digerir_dias: cobertura arredondada ou null, dias_sem_vender }`.
- [ ] **Step 1:** testes: (a) `formatarMissaoDesova(alvos, 'Cliente X')` → título começa com `Cliente X — `; (b) sem prefixo, o título fica idêntico ao atual (a aba Excesso não muda); (c) "Criar missão" de um grupo com 3 SKUs abre o diálogo com 3 alvos; (d) a lista de troca gera CSV com cabeçalho `codigo;descricao;saldo;valor;fornecedor`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar; `track('raio_x.missao_criada', { empresa, skus })`. **Step 4:** PASS, incluindo os testes existentes de `desova-helpers` e da aba Excesso.
- [ ] **Step 5: Commit** `feat(raio-x): saídas (troca + venda dirigida por cliente) e missão por cliente`.

### Task 10: Validação com dado real

**Files:**
- Create: `scripts/raio-x/validar-fase-b.mjs` (lê um JSON exportado da RPC via psql-ro, roda `classificar`/`placar` e imprime totais por categoria)

- [ ] **Step 1:** `~/.config/afiacao/psql-ro -At -c "select json_agg(f) from raio_x_estoque_fatos('oben') f"` (ou conector `--dados-nuvem`) → arquivo no scratchpad; idem colacor.
- [ ] **Step 2:** `node scripts/raio-x/validar-fase-b.mjs <oben.json> oben` → mercadoria parada Oben ≈ 611 SKUs / R$ 341k (desvio > 2% → explicar no PR antes de seguir); colacor → somas por tipo batem a tabela da spec §2.
- [ ] **Step 3:** escolher 3 SKUs (1 de cada categoria) e colar no PR para o founder conferir no Omie.
- [ ] **Step 4: Commit** e abrir o PR 2 (Auto-fix ligado).

---

## PR 3 — Decisão, motor e selo

### Task 11: Sheet de decisão, reclassificação e contagem

**Files:**
- Create: `src/components/reposicao/raioX/DecisaoSheet.tsx`, `src/components/reposicao/raioX/useRaioXMutacoes.ts`
- Modify: `RaioXMercadoria.tsx`, `RaioXContagem.tsx` (abrir o Sheet / campo de contagem)
- Test: `src/components/reposicao/raioX/__tests__/DecisaoSheet.test.tsx`

**Interfaces:**
- Consumes: `raio_x_decidir`, `raio_x_contar`, `raio_x_classificar`; `ItemRaioX`, `DecisaoRow`.
- Produces: `useRaioXMutacoes(empresa)` → `{ decidir(args), contar(sku, qtd), classificar(sku, categoria, motivo) }`, cada um invalidando `['raio-x', empresa]` e com `toast` de sucesso/erro. O erro `RX001` vira `Este SKU não tem parâmetro de reposição — desmarque "tirar do motor"`.
- [ ] **Step 1:** testes:
  - (a) destino sugerido vem pré-selecionado, mas "Salvar" só habilita após um toque;
  - (b) checkbox "tirar do motor" marcado em `liquidar`, ausente em `venda_dirigida`;
  - (c) Colacor → texto `sem motor de reposição — nada a desligar`, sem checkbox;
  - (d) `motor_antes` presente → botão `Restaurar motor ao estado anterior`;
  - (e) a chamada usa a `empresa` do item, e trocar a empresa no contexto fecha o Sheet (Review Focus 4);
  - (f) erro `RX001` → toast com a mensagem acima;
  - (g) `liquidar` com `origem='artifact_fase_a'` e `tirou_do_motor=false` → selo `decidido na fase A — motor não foi tocado` + ação `tirar do motor agora`;
  - (h) contagem `"12,5"` → chama `contar` com 12.5; `"abc"` → erro no campo, nada enviado (porte de `lerNumero`).
- [ ] **Step 2:** FAIL. **Step 3:** implementar; `track('raio_x.decisao', {empresa, destino, tirou_do_motor})` e `track('raio_x.reclassificacao', {empresa, categoria})`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(raio-x): decisão com saída do motor, reclassificação e contagem`.

### Task 12: Selo no pedido de compra

**Files:**
- Create: `src/components/reposicao/raioX/SeloRaioX.tsx`, `src/components/reposicao/raioX/useDecisoesRaioX.ts`
- Modify: `src/components/reposicao/pedidos/ItensPreviewLinha.tsx:86` (selo ao lado do código)
- Test: `src/components/reposicao/pedidos/__tests__/ItensPreviewLinha.test.tsx` (casos novos)

**Interfaces:**
- Produces: `useDecisoesRaioX(empresa, skus: string[])` → `Map<string, {destino, decidido_em, decidido_por_nome}>`, lendo `raio_x_decisao` com `.in('sku_codigo_omie', skus)` filtrado pelos 3 destinos; `<SeloRaioX decisao />`.
- [ ] **Step 1:** testes: (a) SKU com `liquidar` → texto `Raio-X: liquidar · <data> ·` com classe `text-status-warning`; (b) `venda_dirigida` → sem selo; (c) falha na leitura das decisões → a linha do pedido renderiza normalmente, sem selo e sem quebrar (selo é aviso).
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS (incluindo os testes existentes de `ItensPreviewLinha`).
- [ ] **Step 5: Commit** e abrir o PR 3.

---

## PR 4 — Medição, carga da fase A e Artifact

### Task 13: Card "Caixa liberado"

**Files:**
- Create: `src/components/reposicao/raioX/RaioXCaixaLiberado.tsx`
- Modify: `RaioXTab.tsx`, `useRaioX.ts` (consulta `medicao`)
- Test: `src/components/reposicao/raioX/__tests__/RaioXCaixaLiberado.test.tsx`

- [ ] **Step 1:** testes: (a) Oben mostra vendido/liquidado/trocado, barra contra `R$ 60.000` e contradições clicáveis que filtram a lista pelo SKU; (b) Colacor mostra `saiu do estoque (sem NF para atribuir` e não mostra a palavra `vendido`; (c) caixa liberado e "distorce o DIO" aparecem em blocos distintos, sem soma.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(raio-x): card de caixa liberado`.

### Task 14: Carga das 17 decisões da fase A

**Files:**
- Create: `scripts/raio-x/carga-fase-a.mjs` + `scripts/raio-x/carga-fase-a.test.mjs`

**Interfaces:**
- Entrada: `decisoes.json` (`ArtifactData list`, coleção `decisoes`), `retrato.json` (`Artifact read path=retrato.json`), `--uid <auth.uid do founder>`.
- Saída: SQL `begin; insert into raio_x_decisao (empresa, sku_codigo_omie, destino, decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em, origem) values … on conflict do nothing; do $$ … postcondição count(origem='artifact_fase_a') = 17 senão raise … $$; commit;` e a linha final `-- CARGA-FASE-A-OK`.
- [ ] **Step 1:** teste: (a) 17 docs → 17 tuplas, `empresa='oben'`, foto = saldo/cmc do retrato, `foto_em = meta.hoje do retrato`; (b) SKU ausente no retrato → o script aborta com exit ≠ 0 (nunca grava foto nula); (c) destino fora dos 6 → aborta.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** gerar o SQL, mostrar as 17 linhas ao founder e, aprovado, aplicar no envelope (`-v ON_ERROR_STOP=1`, exige `CARGA-FASE-A-OK`); validar por fora: `select count(*) from raio_x_decisao where origem='artifact_fase_a'` = 17.
- [ ] **Step 6: Commit** `feat(raio-x): carga das 17 decisões da fase A`.

### Task 15: Artifact em modo só leitura + diário

**Files:**
- Modify: `docs/superpowers/raio-x-estoque-parado/index.html` (banner "migrado para o app → link" e controles de decisão desligados) e `LEIA-ME.md` (a medição agora é o card do app)
- Create: `docs/historico/raio-x-estoque-parado-fase-b.md` (portão trocado pelo founder, números da validação, PRs)

- [ ] **Step 1:** só depois do Publish confirmado pela skill `lovable-deploy-verify` (o bundle no ar tem a aba): republicar o Artifact `https://claude.ai/artifact/MyvzRxHFpMnhfAufb6zg3p` com a página modificada. **Não** apagar dados do banco do Artifact.
- [ ] **Step 2:** conferir no navegador que a página abre com o banner e que nenhum botão de decisão grava.
- [ ] **Step 3: Commit** e abrir o PR 4.
