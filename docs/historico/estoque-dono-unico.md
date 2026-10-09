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
  do PR; auto-revisão adversarial + falsificação 13/13). **Revisão independente RETROATIVA feita em
  2026-10-05** (gpt-6-astra · max · 658 s · 160.290 tokens, já com o código no ar) — ver "O que o Codex
  retroativo achou" abaixo: 2 P0 reproduzidos, raros e limitados — consertados no #2788 (frente de classe).

## O deploy (2026-10-05)

- Ledger antes: `sync-reprocess` prod `v1.13-hoje-sp-datas-omie` → main `v1.14-estoque-dono-unico`,
  pendente há 3 d. Pacote `5405e4a6b1cd` contra `main@92e7201dd` (23 arquivos do fecho; só o mapa de
  fingerprints mudara desde o merge; nenhum PR aberto tocando o fecho; pré-condição de banco ✅).
- O chat do Lovable estava OCUPADO (deploy da `algorithm-a-audit` de outra sessão às 16:08:09Z): esperei a
  resposta dela antes de enviar — mensagem por cima de agente pausado REJEITA a ação pendente.
- Enviado pela sessão (MCP) às **16:12:55Z**; o agente conferiu os 23 `sha256` contra o commit, deployou
  verbatim e fechou com `No files were edited.` (1,4 crédito). Sensor de edição 5,4 min depois:
  **`SEM_EDICAO`** (0 commits do bot na `main`).
- **Prova funcional, 1ª rodada no bundle novo** (operational 16:15Z): `{"pages": 8, "total_posicoes": 782,
  "zeramento_candidatos": 1, "zerados_fora_da_lista": 1}`, 0 divergências. O produto zerado
  (12034226322, CATALISADOR FCA.7090QT) tinha estoque 1 local e saíra da lista depois das 12:15; a
  testemunha independente (`sku_estoque_atual`, modo "S", 15:42) diz **físico 0** — o zero estava certo, e
  antes ele ficaria 1 fantasma até a strategic de 02:30. A `inventory_position` dele segue com o saldo 1
  congelado (a classe do chip "Zerar estoque esgotado só pelo dono, fora do sync-reprocess").
- Ledger depois: **`✅ confere`** — `sync-reprocess v1.14-estoque-dono-unico · visto via sonda` às 16:37:45Z (a sonda do cron `37 */2`, sem sonda humana).

## O que o Codex retroativo achou (2026-10-05)

- **P0-1 — listagem parcial por mudança ENTRE páginas.** O `ListarPosEstoque` pagina por offset sobre uma
  lista viva: se um produto esgota e sai da lista depois da página k, as seguintes "andam" uma posição e o
  item da fronteira é PULADO — com tamanhos de página normais, a guarda diz "completa" e o 4b zera um produto
  que tem saldo. Formato de página não é retrato consistente.
- **P0-2 — sobrescrita de saldo mais recente.** Se o `sync_inventory` de 30 min grava um saldo positivo entre
  a listagem do 4b e a leitura/escrita dele, o 4b grava 0 por cima (o upsert não tem condição). Exige
  sobreposição de execuções (a agenda `:15` × `:00/:30` não a produz; uma execução manual perto do `:30`,
  sim).
- **P2-3** — recusa do zeramento (teto, listagem incompleta) termina `complete` sem `error_message`, e o
  `sync_reprocess_saude` não vê. **P2-4** — o parser compartilhado (`_shared/pos-estoque.ts`) aceita
  `nCodProd: true` como código 1 (pré-existente; o contrato do Omie não produz isso).
- Sem defeito: conta/account, aritmética do teto, keyset/21000, NULL/NaN, passo de produtos, fiação.
- **Calibração:** os P0 são reais e raros (mudança de lista nos ~4 s de paginação; sobreposição de runs) e
  LIMITADOS (o produto volta ao saldo certo no próximo `sync_inventory`, ≤ 30 min). Sem rollback: a v1.13
  fazia uma versão mais ampla do mesmo dano toda noite (~694 zerados) e deixava fantasma de até 24 h.
- **O conserto é o #2788** (frente de classe, `sync-reprocess` v1.15 + `omie-analytics-sync` v1.7): a ausência
  na listagem só DESCOBRE candidatos, e o zero é AUTORIZADO por confirmação explícita no Omie
  (`ListarPosEstoque` em modo "S" filtrado por produto — saldo 0 explícito em todas as entradas; ausente ou
  ilegível = desconhecido, nunca zero); a escrita é `UPDATE` com compare-and-set na versão lida. O desenho que
  eu tinha esboçado — usar o `synced_at` do `sync_inventory` de 30 min como testemunha — foi descartado: é
  outra listagem em modo "N" da mesma conta, com a mesma paginação por offset sobre a lista viva, ou seja, mais
  uma ausência, não uma confirmação.

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
leva substitui a v1.14 do #2744, que ficou no ar sozinha de 2026-10-05 16:12Z a 2026-10-06 00:27Z — ver
"O deploy (2026-10-05)" acima e "O deploy da Fase 2" abaixo).

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
Substitui `zerados_fora_da_lista` do #2744 (que foi ao ar na v1.14 e saiu do metadata com a v1.15).

**Gate** `src/__tests__/estoque-escritores-gate.test.ts` (registro em
`src/lib/gates/estoque-escritores-registro.ts`): todo escritor de `inventory_position` ou de
`omie_products` com a chave `estoque` está registrado com papel; o dono chama o zero confirmado; nenhum
escritor grava zero literal.

**Fora desta fase** (fases-PR seguintes): os 4 writers de catálogo deixam de gravar
`quantidade_estoque || 0` **depois** de o zero confirmado provar em prod (senão a colacor fica sem quem
zere); e o `omie-sync-estoque` passa a refrescar os membros de grupo de equivalência — o galão da WP01
(`descontinuado`, fora dos habilitados) está congelado em 11,72 nas DUAS fontes, e zerar só a posição não
o tira do `GREATEST`.

## O deploy da Fase 2 (2026-10-06)

- Ledger antes: `sync-reprocess` prod `v1.14` → main `v1.15-zero-confirmado` e `omie-analytics-sync` `v1.6` →
  `v1.7-zero-confirmado`, pendentes desde o merge do #2788 (17:28Z); nenhuma mensagem de deploy delas no chat.
  Feito pela sessão do #2744, com o OK do founder.
- Pacote `b7c1b30a0997` contra `main@0dc6ba510` (2 edges, 34 arquivos distintos, 8 RPCs de pré-condição em
  prod ✅; 2 avisos informativos pré-existentes: `finalize_nao_vinculados_snapshot` com corpo editado à mão e
  `omie_sync_identity_snapshot` sem migration que o commite). Nenhum PR aberto tocando o fecho.
- Enviado às **00:26:05Z**; o agente conferiu os 34 `sha256` (`sha256sum -c` exit 0, workspace em `0dc6ba51`),
  deployou as duas verbatim, sondas 401 nas duas, `No files were edited.` (2,1 créditos). Sensor 5,3 min depois:
  **`SEM_EDICAO`**.
- **Prova funcional, 1ª rodada da v1.7** (`sync_inventory` `vendas`, 00:30:12Z): `zeramento_candidatos: 84`,
  `zeramento_confirmados_zero: 84`, `nao_zero: 0`, `desconhecidos: 0`, `recusados_cas: 0`,
  `zerados_posicao: 158`, `zeramento_chamadas: 2`. Na tabela: as posições congeladas com saldo ≠ 0 caíram de
  **78 (oben) e 87 (vendas)** — Σ saldo×cmc R$ 26.918 e R$ 27.104 — para **0 e 0**.
- Ledger depois: **`✅ confere`** nas duas — `sync-reprocess v1.15-zero-confirmado` e `omie-analytics-sync v1.7-zero-confirmado`, vistas via sonda do cron às 00:38:10Z.
- ✅ **Conferido em 06/10** (psql-ro, até 18:15Z) — fecha o 📌 que estava aqui:
  - `sync-reprocess` v1.15: a **strategic** das 02:30Z deu **`divergences_found: 0`** no `inventory` (eram
    677–694 por noite antes do #2744) e `itens_sem_valor_unitario: 0` no `products`; as **operational** de
    02:15Z a 18:15Z deram `zeramento_candidatos: 0`, todas `complete`, sem erro — o espelho `oben` já tinha
    sido zerado pelo dono de `vendas` às 00:30Z (o zero confirmado vale para os dois espelhos).
  - `colacor_vendas`, 1ª rodada da v1.7 (01:15Z): `candidatos: 48`, **`confirmados_zero: 44`**,
    `desconhecidos: 4`, `estranhos: 0`, `recusados_cas: 0`. Os 4 desconhecidos são os 4 da medição de 05/10
    com o catálogo parado — `5185282104/109/114/119` (lanterna, lâmpadas, "Manutenção Elétrica"), posição e
    cadastro sem atualização desde 02/10, saldo 1–2: excluídos no Omie, a confirmação "S" não os devolve e o
    zero NÃO é escrito (ausente ≠ zero). Ficam como órfãos presos (limpeza manual, `reposicao.md` §Malha OBEN)
    e custam 1 chamada de confirmação por rodada da colacor.
  - Contraprova nos dois sentidos (00:40Z): nenhuma posição zerada com `estoque_fisico > 0` no
    `sku_estoque_atual` fresco do modo "S"; das zeradas com leitura "S" < 24 h, 40/40 confirmam 0.
  - Congeladas ao longo do dia: `vendas` 0, `oben` 0, `servicos` 0, `colacor_vendas` 4 — sem reacúmulo; a
    rodada de `vendas` das 01:00Z já deu 0 candidatos (estado de regime).
  - **O incidente fechou:** a WP07.3900QT voltou a ser sugerida no ciclo de 06/10 12:15Z (estoque físico 0,
    `qtde_sugerida` 2) e o pedido foi aprovado com 1 un a R$ 796,21 e **disparado** — a 1ª sugestão dela
    desde 04/07. O ciclo de 18:15Z sugeriu +1 (pp 1/máx 2 com 1 a caminho: regra do motor, não fantasma).

## Fase 3 — o catálogo deixa de gravar estoque (2026-10-06, branch `estoque-dono-unico-catalogo`)

Edges `omie-sync-metadados` → `v1.1-catalogo-sem-estoque`, `omie-analytics-sync` → `v1.8-…`,
`omie-vendas-sync` → `v1.11-…`, `sync-reprocess` → `v1.16-…` e `tint-omie-sync` (sem `versao.ts`).

**O sinal da fase 2 que libera esta.** A WP07 foi sugerida e disparada, a strategic deu 0 divergência, e a
1ª rodada confirmou 84/84 (`vendas`) e 44/48 (`colacor_vendas`). Re-medido em 06/10 ~19:40Z:
- catálogo × posição mais fresca dá **0 divergência nos dois sentidos** (colacor 1.449 e oben 782 não-zero
  iguais);
- `omie_products.estoque` é numeric, aceita NULL e tem DEFAULT 0;
- das 3 triggers da tabela, nenhuma cita estoque.

**O conserto.**
- Os 4 mapeamentos de catálogo perdem a chave `estoque`, e as interfaces perdem o campo. O lote é
  homogêneo, então o postgrest-js monta `columns` sem `estoque`: no conflito o valor fica, e no INSERT
  entra o DEFAULT 0, como já entrava com o `|| 0`. O desenho da classe, com o Codex, já tinha aprovado isso
  (D4).
- 5º ponto, achado nesta fase: o `products-lote` do `sync-reprocess` ainda VALIDAVA o campo e descartava o
  produto (preço junto) quando vinha lixo. O Omie serializa campo vazio como `""` (o `cfop` vem assim em
  3.714/3.714 produtos); se o DEPRECATED passar a chegar assim, a rodada perderia o catálogo inteiro por um
  campo que o passo nem usa.

**Gate.**
- O registro encolheu: o papel `catalogo-legado` e as entradas de metadados e tint saíram. A partir de
  agora, o G1 barra a volta deles.
- Entrou o **G5**: nenhuma fonte de edge lê `quantidade_estoque`. Analytics e vendas-sync seguem
  registrados por outras escritas legítimas, então a volta do `|| 0` no catálogo deles passaria por G1–G4.

**A prova.**
- Os REDs foram observados antes do conserto:
  - calibração com 2 falhas (`undefined`);
  - G5 vermelho com exatamente os 5 arquivos;
  - G2 vermelho com metadados e tint;
  - Deno `0 !== 4`: o lixo no campo tirava os 4 produtos, inclusive o `""`.
- Falsificação `FALSIFICACAO_OK` em `C` e `pt_BR.UTF-8`, com controle 16/16 antes e depois:
  - S2 e S4 re-miradas para o vendas-sync;
  - **S7** (o `|| 0` de volta no syncProducts do analytics) só o G5 pega;
  - **S8** (a volta no metadados) cai no G1.
- `deno check` das 5 edges com a mesma contagem de erros da main (3/7/0/0/0).

**Codex: Caminho B.** A cota estava em 92% (o teto é 85%) e a janela só reabre em 09/10 19:30. O desenho
virou a RÉGUA escrita e conferida por mim, no corpo do PR. O PR fica em DRAFT até o adversarial do código.

**O que NÃO muda.** Os 4 órfãos colacor seguem com `estoque` 2/2/1/1 desde 02/10: o reset do catálogo nunca
os tocou, porque o `ListarProdutos` não os traz. A decisão de inativá-los é do founder.

**Como conferir depois do deploy** (query, não recado). O metadados termina ~08:33Z e o `syncInventory`
oben roda às 09:00Z. Entre 08:35Z e 08:59Z do dia seguinte, rode:
`select account, count(*) filter (where updated_at >= current_date + time '08:30') catalogo_rodou, count(*) filter (where estoque <> 0) nao_zero from omie_products group by 1;`
- Com o bundle velho, oben tem `nao_zero` ≈ 0 na janela.
- Com o novo, ≈ 782, com `catalogo_rodou` ≈ 3.715.

Na colacor a janela é 06:17Z–07:14Z, depois do syncProducts das 06:15Z.

## O deploy da Fase 3 (2026-10-07)

O pacote `58d7df9c0628` (5 edges, `origin/main@f55523513`) foi colado pelo conector, com o OK do founder.
- O agente conferiu os 45 sha256 (exit 0) e publicou as 5 edges.
- Todas estão Active: responderam 401 sem credencial, o que mostra boot sem erro.
- Ele fechou com `No files were edited.`, e o sensor de edição deu `SEM_EDICAO` (nenhum commit do bot na main).
- Custo: 3,5 créditos.
- Banco: pré-condição ✅ (as 18 RPCs rodam o corpo commitado).

**Atestação:**
- `omie-sync-metadados` (fora da allowlist do cron) passou por sonda humana pelo envelope (`db:aplicar`, tentativa #261, registro no #2831) e deu **DEPLOY CONFIRMADO** (`v1.1-catalogo-sem-estoque`, fonte batendo).
- `omie-analytics-sync` v1.8, `omie-vendas-sync` v1.11 e `sync-reprocess` v1.16 foram atestadas pelo cron de sonda das 00:37Z, vistas às 00:39Z.
- `tint-omie-sync` não tem `versao.ts`; a prova é o deploy com os hashes.

O adversarial do Codex no diff ficou para retroativo (a cota reabre em 09/10 19:30), por decisão do founder.

## Remendo da WP01 (2026-10-07): o galão congelado sai do grupo

O galão da WP01 (`12078998671`) é membro NÃO habilitado do grupo de equivalência. Ele estava em 11,72 no
`sku_estoque_atual` desde 31/07, enquanto o Omie confirmou 0 (zero confirmado, 06/10 00:30:12Z, nos dois
espelhos).

O motor (`gerar_pedidos_sugeridos_ciclo`) soma `GREATEST(inv.saldo, sea.estoque_fisico)` por membro, em
litros (a unidade dos 28 membros) e sem fator. Por isso o físico do grupo era 16,92 L, quando o real era
5,2 L. O quarto, com ponto de pedido em torno de 5, estava a uma venda de precisar de uma compra que o motor
não sugeriria.

**Aplicação.** Pelo envelope, com `db/remendo-wp01-galao-zero-confirmado-2026-10-07.sql`:
- pré-condição: o zero confirmado ainda de pé nos dois espelhos;
- UPDATE com CAS no valor congelado (11,72 e a data de 31/07);
- pós-condição: a linha em 0;
- ensaio OK, depois a tentativa #263.

**Validação por fora:** a linha ficou em 0/0, com `ultima_sincronizacao` igual ao instante da confirmação e
`fonte_sync` em `ListarPosEstoque` (o motor só trata `cold_start_seed` como não confirmada). O físico do
grupo ficou em 5,2 L.

**Os outros membros.** Dos 28 membros dos 14 grupos, 4 não são habilitados e congelam. Só este tinha
fantasma positivo. Os outros 3 estão em 0 há 94–96 dias, e o `GREATEST` com a posição fresca os neutraliza.

**A classe** (membro desabilitado com estoque congela positivo) se conserta no PR-3: o `omie-sync-estoque`
passa a gravar o físico dos membros de grupo.

## Fase 4 — o par dos membros de grupo (PR-3, 2026-10-07, branch `estoque-membros-de-grupo`)

Edge `omie-sync-estoque` → `v1.7-membros-de-grupo`, construída em cima da v1.6 do #2828 (refactor
`fisico.ts`/`publicacao.ts`).

**A medição.** São 14 grupos de equivalência com 28 membros, todos em L. Desses, 4 não são habilitados e
congelavam no `sku_estoque_atual`:
- o galão da WP01, com 11,72 de 31/07 e 0 confirmado (o fantasma, remendado no #2832);
- WP02.3900GL, WP71.3900QT e WP88.3900QT, em 0 há 94–96 dias.

Os zeros velhos são inofensivos enquanto a posição está fresca. A classe que dá dano é **membro desabilitado
com estoque positivo**.

**O que a sessão do #2828 pegou no 1º desenho.** O 1º desenho gravava só o físico do membro e preservava o
pendente. Mas o motor SOMA o físico e o pendente de todos os membros do grupo. Físico fresco com pendente
velho conta a NF recebida duas vezes: é o par misto que o C1 da v1.6 recusa, numa população nova. O PR voltou
para DRAFT até o par ficar completo.

**O conserto.**
- `fisico.ts`: o membro NÃO habilitado vai para um mapa à parte (`membros`). As invariantes do `encontrados`
  (vazio inesperado, inativação, pendente) não mudam. Membro ilegível em algum local perde a soma inteira e
  nunca barra os habilitados.
- `index.ts`: lê os membros com o MESMO recorte do motor (empresa minúscula, `ativo`, `fator_para_base > 0`).
  - As duas varreduras de pendente (PesquisarPedCompra e ListarSaldoPendente) devolvem `pendenteMembros` à
    parte, sob o MESMO gate de confiança.
  - Item inválido de membro vai para `membrosPendenteIlegiveis`, nunca para `problemas`.
  - O coletor da baixa de PO observa habilitado OU membro (o contrato do #2780: "o conjunto aberto que o
    motor contou").
- `publicacao.ts`: depois da inativação, um lote à parte grava o PAR (físico + pendente da mesma varredura,
  `?? 0` legítimo sob o C1).
  - Sem o pendente dos membros, ou com item inválido, não há linha: nunca o físico sozinho.
  - A observação confere contra o pendente GRAVADO (habilitados ∪ membros com par), e `pendente_aplicado`
    exige os dois lotes inteiros.
  - Falha no lote dos membros não muda o desfecho; aparece no resumo (`membros_grupo_*`).

**Limite.** A 2ª testemunha da RPC `reposicao_po_observado_publicar` confere SKU a SKU só os HABILITADOS
(`sku_parametros.habilitado_reposicao_automatica`). Para os membros, a conferência é só a da edge; estendê-la
ao banco é migration.

**A prova.**
- RED antes do GREEN, nas duas rodadas (o físico, depois o par), e então 66/66 na pasta da edge.
- Falsificação 16/16 com a marca, em `C` e `pt_BR.UTF-8`, com controle Deno e vitest verde antes e depois:
  - acumulador: membro no `encontrados`, ilegível barrando, soma parcial nas 2 ordens, vazio contando membros;
  - lote: pendente 0 no lugar do par, físico sem par, membro ilegível gravado, desfecho dependendo dos
    membros, `0` no lugar de `null`;
  - observação: conferência só com habilitados, `pendente_aplicado` ignorando os membros;
  - fiação: predicado, recorte, item inválido do membro em `problemas`, coletor sem o membro.
- Codex: sem consulta, por decisão do founder (cota). Adversarial retroativo depois de 09/10 19:30.

## O deploy da Fase 4 (2026-10-07)

O pacote `e887a72f8751` (`omie-sync-estoque`, `origin/main@1c05421a1`) foi colado pelo conector, com o OK do
founder.
- O agente conferiu os 15 sha256 (exit 0) e publicou a edge. Ela está Active: respondeu 401 sem credencial.
- Ele fechou com `No files were edited.`, e o sensor de edição deu `SEM_EDICAO` duas vezes, a 2ª com 6,6 min de
  folga sobre o envio.
- Custo: 1,8 crédito.

**Atestação.** A edge não está na allowlist do cron, então passou por sonda humana pelo envelope (`db:aplicar`,
tentativa #272, registro no #2843) e deu **DEPLOY CONFIRMADO** (`v1.7-membros-de-grupo`, fonte batendo). O
ledger marca confere.

**Como conferir:** depois do 1º run da v1.7 (cron 09:00Z), rode a query do PR #2836:
- os 4 membros não habilitados devem ter `ultima_sincronizacao` do run;
- o resumo deve trazer `membros_grupo_gravados` = 4;
- a observação deve seguir publicando.

## As unidades do consolidado de grupo (2026-10-07)

A suspeita, levantada durante a Fase 4, era que o físico do grupo estivesse sendo somado sem fator, misturando quartinhos e galões. A medição na prod (psql-ro) mostrou o contrário: **o físico está certo**. Os 28 membros estão em litros no Omie (QT = 0,81 L, GL = 3,24 L), então somar litro com litro dispensa o fator.

O desvio real está na compra. A `qtde_final`, o em trânsito e o PO falam em embalagens, mas o motor as compara com o máximo em litros. O resultado é comprar cerca de 19% a menos e contar o trânsito cerca de 23% inflado. O caso visto foi o pedido 1268 (WP01 QT): 5 QT pedidos chegam como 4,05 L contra um máximo de 8 L.

O dano é pequeno: o motor compra menos e com mais frequência, e o gatilho compara litro com litro. O founder decidiu documentar e deixar o conserto na fila: [#2849](https://github.com/LucasSardenbergL/afiacao/issues/2849), uma migration money-path com Codex. Detalhe em `docs/agent/reposicao.md` §Léxico.

## A conferência do 1º dia e a v1.8 (2026-10-07/08)

**PR-3 (v1.7) conferido em prod.** As 4 linhas de membro não habilitado (os galões da WP01 e da WP02, os quartinhos da WP71 e da WP88) passaram a ser sincronizadas a cada run, com o par 0/0 vindo de `ListarPosEstoque`. Os 8 runs de 07/10 terminaram com `desfecho: completo` e a observação de PO publicada.

**O que a conferência pegou.** A query prometida no PR-3 (`membros_grupo_*` em `acoes_execucoes`) não tinha o que mostrar. A `CHAVES_REGISTRO` filtra o resumo, e as chaves dos membros ficaram de fora: saíam só na resposta HTTP, que o cron descarta. Uma falha no lote dos membros, justamente a classe que a v1.7 fecha, não deixaria rastro. A **v1.8-registro-membros** (#2854) acrescenta as 6 chaves. O teste de forma ficou vermelho antes do conserto, e a falsificação deu 6/6 nos dois locales.

**O deploy da v1.8 (08/10):**
- O Lovable conferiu os 15 hashes contra `2663721ed`, a edge ficou **Active** às 10:43 UTC e custou 0,9 crédito.
- A sonda deu **DEPLOY CONFIRMADO** (tentativa #285), e o ledger marca "confere".
- O sensor de edição deu EDICAO_DETECTADA, mas o `edit_id` era a regeneração do `types.ts` pela migration do acervo (`pedido_total_liquido_excecao`). Nada em `supabase/functions/` mudou.

**PR-2: a conferência precisa ser feita DENTRO da janela.** O `sync-inventory-vendas-30m` regrava as linhas com estoque às :00 e às :30, então um zeramento pelo catálogo das 08:3x seria desfeito às 09:00. Ler depois disso não prova nada; em 07/10 e 08/10, a leitura tardia deu 784 linhas não-zero na oben, o esperado, mas sem valor de prova. A leitura que vale é entre 08:40 e 08:59 UTC:

```sql
select account, count(*) filter (where estoque <> 0) nao_zero from omie_products group by 1;
```

Esperado: oben ≈ 784 (o bundle velho daria ≈ 0 depois do catálogo).

**De passagem:** o run das 09:00 de 07/10 falhou com "consumo redundante" do Omie, provavelmente disputando a chamada com o `sync-inventory-vendas-30m`, que roda nos mesmos :00. O run das 09:41 recuperou. Foi 1 caso em 9; observar antes de mexer no cron.
