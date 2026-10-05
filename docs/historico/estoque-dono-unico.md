# Estoque com dono único — o `|| 0` do catálogo zerava os posicionados e era o único reset de quem esgotava

Entrega de 2026-10-01 (branch `estoque-produtos-fallback-zero`), a partir do achado anotado na medição do
fuso ([hoje-sp-typescript-e-data-ciclo.md](hoje-sp-typescript-e-data-ciclo.md), "A medição antes de
mudar"). Edge `sync-reprocess` → `v1.14-estoque-dono-unico`.

## O achado de partida

A rodada `strategic` (cron 35, `30 2 * * *` UTC, só oben) roda pedidos → produtos → estoque. Em 30 dias de
`sync_reprocess_log`, o passo de estoque dela contou **677–694 divergências em 19 de 19 noites**, e o da
`operational` (sem passo de produtos), em todas as 12 horas do dia, **mediana 0, máximo 13** (movimento real
entre rodadas de 2 h). O planejador de produtos gravava `estoque: prod.quantidade_estoque || 0` e
`valor_unitario: prod.valor_unitario || 0`.

## A medição (antes de mudar)

- **Assinatura de zero, não de "outra medida":** na noite de 10-01 a strategic contou 694 divergências; uma
  contagem independente dá 779 posições, **694 elegíveis** pelos mesmos filtros do planejador, 693 com
  saldo ≠ 0. Uma medida alternativa (soma de locais) coincidiria com o saldo em quase todo produto de local
  único; só o zero diverge em todos. Nenhum SKU oben é multi-local (497/497 em `sku_estoque_atual`).
- **O campo:** a doc oficial do Omie descreve `quantidade_estoque` como **"DEPRECATED."**, e o Omie serializa
  campo de esquema vazio PRESENTE — o `omie-sync-metadados` grava o metadata cru, sem fallback, e `cfop` é
  `""` em 3.714/3.714 produtos, `peso_liq` é número 0 em 3.663. Inferência: `quantidade_estoque` chega
  **presente como 0**. Por isso o conserto pedido ("ausente não sobrescreve") seria **inerte**: o `|| 0` nem
  dispara quando o valor já é 0. É o aviso do money-path §2 ("meça se a ausência chega como null"), na versão
  campo-descontinuado.
- **O preço:** `valor_unitario` é "Preenchimento Obrigatório" no Omie e chega presente; os **256 ativos oben
  com preço 0 são zeros do cadastro**, não do fallback (não observei o payload cru — limite registrado).
- **A janela real é ~5 s/noite, não 63–116 s:** o upsert do passo de produtos só acontece DEPOIS da
  paginação (os 63–116 s são chamadas ao Omie); o passo de estoque grava ~5 s depois.
- **Quem lê `omie_products.estoque`:** só sob demanda (badge de disponibilidade do pedido, `recommend`
  descarta `estoque<=0`, `analyze-unified-order` escolhe a conta pelo menor estoque, cotação WhatsApp, venda
  assistida) e o cron 145 `reposicao_cold_start_parametros` às **08:15 UTC**. O motor de compra lê
  `inventory_position`, não esta coluna. Nenhum cron leitor cai em janela de zero.

## O achado que mudou o desenho

O `ListarPosEstoque` padrão (`cExibeTodos` = "N", "sem movimento" fica de fora) **só lista quem tem saldo
≠ 0**: medido em **405/405** SKUs com leitura fresca do modo "S" (`omie-sync-estoque` usa `cExibeTodos:"S"`),
311 com físico ≠ 0 estão todos na lista e 94 com físico 0 estão todos fora, sem contraexemplo. Quem esgota
**sai da lista** e nenhum writer de posição grava o zero. Em `inventory_position` há **78 posições oben
congeladas** fora da lista, todas com saldo ≠ 0 velho; em `omie_products`, **77 delas estão zeradas só pelo
`|| 0` dos writers de catálogo**. Ou seja: o fallback errado era **load-bearing** — tirá-lo sem compensar
trocaria um zero de ~5 s por estoque fantasma de até 24 h.

Decisão do founder (entre 4 opções): **o dono zera, por ausência** — a regra que o sistema já aplicava por
acidente, agora explícita, a cada 2 h, com guardas.

## O conserto

- `products-lote.ts`: a row **não carrega mais a chave `estoque`** (o dono da coluna é o passo de estoque);
  `valor_unitario` ausente **tira o item** (local intacto) e vai para `semValorUnitario` → metadata
  `itens_sem_valor_unitario`; todos ausentes lançam `SemValorUnitarioError` (o run vira `error` e o sensor
  `sync_reprocess_saude`, que lê status, acende).
- `inventory-lote.ts`: `avaliarCompletudeListagem` (página intermediária curta ou última CHEIA = incompleta) e
  `planejarZeramentoForaDaLista` (estoque local ≠ 0, resolvido sem ambiguidade, ausente da listagem →
  estoque 0; pulado inteiro se a listagem é incompleta (página curta, última cheia ou item que o parser recusou — que pode ser produto COM saldo), o snapshot veio vazio ou o raio passa do teto
  `max(20, 5% das posições)`; dedupe contra 21000).
- `estoque-local.ts`: loader **keyset** das linhas locais com estoque ≠ 0 (ver lição 3).
- `index.ts`: passo 4b depois do espelho de estoque; metadata `zerados_fora_da_lista` /
  `zeramento_candidatos` (`null` = não apurado, nunca 0) / `zeramento_pulado`; leitura que falha não zera
  ninguém e vai ao `error_message`.

## Lições

1. **Campo DEPRECATED chega presente como 0** — "ausente → não sobrescreve" não o pega. O dono de uma
   coluna money-path é quem tem a fonte autoritativa; o catálogo não escreve estoque.
2. **Upsert em lote não omite coluna por linha.** O supabase-js manda `columns` = união das chaves do lote e
   grava NULL (ou o DEFAULT, com `defaultToNull:false`) na linha que não tem a chave
   (postgrest-js 2.110.7, `dist/index.cjs` l.3159–3171). Em `valor_unitario` (NOT NULL) derrubaria o chunk com
   23502; em `estoque` apagaria o real. Lote homogêneo é invariante — há um pino de forma no teste.
3. **Offset sobre um filtro numa coluna que outro writer reescreve DUPLICA linha.** O `estoque ≠ 0` é
   reescrito pelo `sync_inventory` de 30 min; com `fetchAll` (offset), uma linha que entra no recorte entre
   duas páginas devolve a anterior duplicada (o teste mediu 1.101 linhas para 1.100 ids) — e duplicata no
   mesmo upsert dá 21000 no chunk inteiro. Keyset (`fetchAllKeyset`) nunca relê.
4. **Fallback errado pode ser load-bearing.** Antes de remover um `|| 0`, pergunte o que ele está zerando
   que ninguém mais zera.
5. **A falsificação pegou a MINHA sabotagem mal ancorada:** a 1ª ocorrência de
   `valor_unitario: valorUnitario,` era a entrada do catálogo, não a row, e a sabotagem ficou verde. Ancore a
   sabotagem em contexto exclusivo do alvo antes de concluir que o teste é cego.

## A prova

- Deno: produtos 25 → 30 testes, estoque 11 → 25, loader 0 → 4 — RED observado por asserção antes de cada
  GREEN; `test:edges` 1.317 passaram / 0 falharam.
- Falsificação: **13/13 sabotagens vermelhas no teste-alvo**, em `LC_ALL=C` e `pt_BR.UTF-8`, controle verde na
  mesma invocação, árvore limpa depois.
- Gates: `edges:typecheck` (0 crash; `deno check` direto nos 4 arquivos, 0 erro), `sonda:bump`,
  `sonda:fingerprint`, os 10 vitest que leem a edge como texto e a suíte completa.
- Codex: **desenho não consultado** — o `codex-async.sh` barrou por `SALDO_ALTO` (cota em 86%, teto 85%,
  janela reabre 03/10 19:11); Caminho B do desenho = RÉGUA própria + decisão do founder. **Código:
  mergeado em 2026-10-01 21:35 UTC (#2744) por ordem do founder, pelo Caminho B** (`sem-codex` no corpo
  do PR; auto-revisão adversarial + falsificação 13/13). **REVISÃO INDEPENDENTE PENDENTE — gatilho: a
  janela do Codex reabre em 03/10 19:11**: rodar o adversarial RETROATIVO sobre o diff do #2744
  (`gh pr diff 2744`) via `scripts/codex-async.sh -r max`, e um P0/P1 que ele achar vira PR de conserto.

## Como conferir depois do deploy

- A strategic seguinte: `divergences_found` do `inventory` cai de ~684 ao patamar da operational (≤ 13);
  `metadata.itens_sem_valor_unitario` = 0 no `products`.
- Toda rodada de estoque passa a ter `zerados_fora_da_lista` e `zeramento_candidatos` no metadata (ausentes =
  bundle velho). As 78 posições congeladas seguem com `omie_products.estoque = 0`.

## Fora deste PR (onde mais o comportamento aparece)

- O mesmo `quantidade_estoque || 0` vive em mais 4 writers de catálogo: `omie-sync-metadados` (08:30 UTC,
  catálogo inteiro das 2 contas — os ~778 posicionados oben ficam em 0 até o `sync_inventory` das 09:00,
  ~28 min), `omie-analytics-sync sync_products` colacor (06:15, até 07:15, ~57 min), `tint-omie-sync` e
  `omie-vendas-sync sync_products` (manuais). Eles seguem sendo, também, o reset acidental das contas que o
  `sync-reprocess` não cobre. O cold-start das 08:15 escapa do metadados por 15 min, não por desenho.
- `inventory_position` não zera quem sai da lista: 78 posições oben e 87 `vendas` congeladas (Σ saldo×cmc
  R$ 26.918 e R$ 27.104), lidas sem filtro de frescor pelo motor de compra (`DISTINCT ON … synced_at DESC`
  + `GREATEST`), e por `atp_disponivel`, `selfservice_disponibilidade` e `fin_estimar_estoque_omie`.

## Fase 2 — o zero passa a ser CONFIRMADO, e vale para a posição (2026-10-05, branch `estoque-dono-unico-classe`)

Edges `omie-analytics-sync` → `v1.7-zero-confirmado` e `sync-reprocess` → `v1.15-zero-confirmado` (esta
leva junto o #2744, que nunca foi deployado sozinho).

**A medição que pediu a fase.** Re-medido em 05/10 13:00 UTC: 208 posições congeladas (`vendas` 84, `oben`
75, `colacor_vendas` 49; Σ saldo×cmc R$ 63,6k), todas com mais de 24 h. O motor só lê o saldo de
`inventory_position` no estoque consolidado dos grupos de embalagem (`GREATEST(inv, sku_estoque_atual)`), e
ali a congelada **suprime compra**: a WP07.3900QT (pp 1, cmc R$ 796) tem 0 confirmado pelo modo "S" e 2,43
congelado desde 27/08 — o motor não a sugere desde então. ⚠️ O primeiro cruzamento com os grupos deu 0 por
CAIXA: `sku_embalagem_equivalencia.empresa` é `oben`, `sku_estoque_atual`/`sku_parametros` são `OBEN`.

**O parecer de desenho (Codex `max`, sem P0) derrubou a inferência.** A listagem paginada não é retrato: se
um produto esgota entre a página 1 e a 2, a seguinte desliza e um POSITIVO some do conjunto sem que guarda
alguma de tamanho perceba — o zero por ausência do #2744 zeraria estoque real. E o upsert de linha
completa podia restaurar `codigo`/`descricao` e apagar um positivo gravado depois da leitura.

**O conserto** (`_shared/zeramento-estoque.ts` puro + `_shared/zeramento-estoque-io.ts`):
- a ausência numa listagem completa só **descobre** candidatos (posição da conta e estoque da empresa ≠ 0);
- o zero é **autorizado** por uma confirmação explícita — `ListarPosEstoque` com `cExibeTodos:"S"` +
  `lista_produtos:[{nCodProd}]`, lotes de 50, a MESMA data do retrato — e só com saldo 0 explícito em
  TODAS as entradas do código; código ausente, saldo não explícito ou item ilegível na resposta =
  desconhecido, nunca zero;
- escrita por `UPDATE` com CAS no valor lido; a posição muda só o saldo, e o `synced_at` avança só se a
  confirmação trouxe cmc utilizável (ele é o frescor do CUSTO: `get_defasagem_cliente` recusa > 48 h);
  `cmc`/`preco_medio` só entram no SET se mudaram (UPDATE OF cmc dispara o ledger mesmo com valor igual);
- sem teto por rodada (com o zero confirmado ele não protege de zero falso — o positivo zerado por engano
  volta na listagem principal seguinte —, e um teto "N mais velhos" deixaria os eternamente-desconhecidos,
  57 congeladas de produto inativo, ocupando as vagas); só o limite de anomalia max(50, 25%) como guarda
  de custo. O congelado drena na 1ª rodada, sem dreno manual;
- `_shared/pos-estoque.ts`: `nSaldo` ausente/null/vazio não vira mais 0 — o item sai do retrato e, se tem
  saldo local, vira candidato à confirmação (`numeroExplicito`);
- `syncInventory` fixa a data do retrato antes da 1ª página (era calculada por página).

**O adversarial do código (Codex `max`, 2 P1 + 3 P2, sem P0; o retroativo do #2744 sem P0/P1) mudou:**
- a confirmação PAGINA (uma entrada por local): o lote só vale com a paginação terminada numa página
  curta (teto de 5 páginas); página que falha = lote inteiro desconhecido — decidir pela página 1 zerava
  produto com saldo em outro local;
- o zero confirmado vale para os DOIS espelhos da mesma conta Omie (`vendas`↔`oben`, mesmas credenciais
  `OMIE_OBEN_*`), cada um com o próprio CAS — senão o zero sem cmc (synced_at preservado) ficava escondido
  na eleição por synced_at do motor e do ATP até o outro dono rodar;
- o CAS é a VERSÃO da linha (`synced_at` da posição, `updated_at` do catálogo) + valor ≠ 0, não igualdade
  numérica (um numeric com mais casas que um double seria recusado para sempre);
- código de produto só de number ou string de dígitos (`[7]` e `true` coagiam para código);
- rodada vazia e rodada com erro gravam `zeramento_candidatos: null` + o motivo, em vez de herdar a
  metadata da rodada anterior.

**Metadata** (`sync_state.metadata` das 3 contas do analytics; `sync_reprocess_log.metadata` do
reprocess): `zeramento_candidatos` (null = não apurado), `zeramento_confirmados_zero`/`_nao_zero`/
`_desconhecidos`, `zerados_posicao`, `zerados_estoque`, `zeramento_recusados_cas`, `zeramento_chamadas`,
`zeramento_estranhos` (código não pedido = filtro não honrado), `zeramento_pulado`, `zeramento_falhas`.
Substitui `zerados_fora_da_lista` do #2744 (nunca foi ao ar).

**Gate** `src/__tests__/estoque-escritores-gate.test.ts` (registro em
`src/lib/gates/estoque-escritores-registro.ts`): todo escritor de `inventory_position` ou de
`omie_products` com a chave `estoque` está registrado com papel; o dono chama o zero confirmado; nenhum
escritor grava zero literal.

**Fora desta fase** (fases-PR seguintes): os 4 writers de catálogo deixam de gravar
`quantidade_estoque || 0` **depois** de o zero confirmado provar em prod (senão a colacor fica sem quem
zere); e o `omie-sync-estoque` passa a refrescar os membros de grupo de equivalência — o galão da WP01
(`descontinuado`, fora dos habilitados) está congelado em 11,72 nas DUAS fontes, e zerar só a posição não
o tira do `GREATEST`.
