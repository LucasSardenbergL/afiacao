# "A caminho" com um relógio só (2026-11-18) — money-path

## Defeito

O "a caminho" do motor de reposição (`gerar_pedidos_sugeridos_ciclo`, CTE `em_transito`) somava duas fontes com
**relógios independentes**:

| lado | quem | corte dos pedidos do app |
|---|---|---|
| pendente (`sku_estoque_atual.estoque_pendente_entrada`) | `omie-sync-estoque` (`fetchEmTransitoKeys`) | tira do pendente `data_ciclo >= hojeSP() − 7` **no dia S em que o sync roda** |
| em_transito | motor | contava `data_ciclo >= p_data_ciclo − 7` (**D**, o dia do ciclo) |

Com o motor em D lendo um retrato de S < D (o sync do dia falhou ou atrasou), todo pedido do app com `data_ciclo`
em **[S−7, D−8]** ficava fora dos dois lados: o sync o tirou e o motor o cortou. Ele era contado **0×**, e o motor
recomprava (**compra dupla**). O vão cresce 1 dia por dia sem sync. Com o sync em dia (motor 09:15 UTC, ~10 min após
o sync das 09:05) o defeito não morde.

## Medido em prod (psql-ro, 2026-11-18)

- `acoes_execucoes` só tem registro do sync desde 2026-10-07 (42 dias, e não os 90 pedidos). Em todos os dias houve
  algum sync com sucesso, mas **em 2 dias (06/11 e 11/11) o motor das 09:15 UTC rodou sem sync bem-sucedido no
  mesmo dia**: o retrato era da véspera (16:40 SP). O vão (data_ciclo = D−8) tinha **6 e 3 pedidos do app** em
  status contável. Em 11/11 o intraday das 10:15 UTC já leu o retrato novo; em 06/11 o sync só voltou 10:42 SP.
- Falhas do sync no período: rate limit do Omie (redundância), timeout, deadline do run, SOAP 500.
- Efeito do conserto **hoje** (sync em dia): +2 itens contados, ambos de SKUs **não habilitados** com retrato velho.
  Nos SKUs ativos o efeito é zero.

## Conserto (migration `20261118120000_reposicao_acaminho_relogio_do_sync.sql`)

O motor corta **por SKU** no relógio do retrato que está lendo:

```sql
LEFT JOIN sku_estoque_atual sea_c ON sea_c.empresa = pcs2.empresa AND sea_c.sku_codigo_omie = pci.sku_codigo_omie::text
... AND pcs2.data_ciclo >= (LEAST(p_data_ciclo, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date) - 7)
```

- **Por que `ultima_sincronizacao`:** o sync grava o pendente e `ultima_sincronizacao` na **mesma linha e no mesmo
  upsert** (`publicacao.ts concluirRun`), logo depois de ler o PO. A linha só é escrita quando o pendente passou no
  gate de confiança; se não passou, o run aborta antes de escrever. Por SKU porque a gravação é por linha: uma
  gravação parcial deixa linhas de retratos diferentes.
- **Lado seguro (precisão > recall do caixa):** contar 2× é subcompra (recuperável); contar 0× é compra dupla (queima
  caixa). As duas folgas só **acrescentam** a caminho:
  - `− 1 hour`: um run que cruza a meia-noite SP lê o PO no dia S e grava em S+1. Sem a folga o motor cortaria um dia
    depois do sync (0×). Com a folga, um run genuíno entre 00:00 e 01:00 SP conta 2× o pedido da borda (os crons
    rodam 06:05–16:40 SP).
  - `LEAST(p_data_ciclo, …)`: o corte nunca fica depois do corte de antes (retrato posterior ao ciclo, como num
    recálculo de data passada).
  - Sem data (`NULL`): `LEAST` ignora NULL, então vale o corte de antes.
- **Edge intocada:** o corte do sync já era o relógio certo; o conserto só faz o motor lê-lo. É uma camada de deploy
  (a migration), sem a ordem migration→edge que uma coluna nova exigiria.

## Prova

`db/test-acaminho-relogio-unico.sh` (PG17, migrations reais):

- **D0 pré-voo:** md5(prosrc) do motor da migration viva = o da prod (`93b2407d…`).
- **Controle:** o motor vivo dá o mapa do defeito (G1/G2/M1 recomprados, a caminho 0).
- **Sem a migration nova a prova fica vermelha** (4 RED). Com ela, verde em `LC_ALL=C` e `pt_BR.UTF-8` (25/0).
- Cenários: G1 retrato da véspera · G2 3 dias sem sync · N1 pedido recente · N2/N3 **não conta 2×** o que já está no
  pendente · L1/L2 retrato sem data · M1 meia-noite · F1 retrato posterior ao ciclo · R2 elegibilidade com retrato
  fresco.
- Falsificações com **controle verde na mesma invocação** (fixture intacta pelo mesmo caminho): F1 dois relógios ·
  F2 sem folga · F3 sem LEAST · F4 um dia a mais (2×). Dente da **POS-RU1**: o corte revertido aborta, também quando o
  predicado certo sobrevive só num comentário, e o motor fica intacto (aplicado com `--single-transaction`, como o
  `db:aplicar`).
- As 5 provas irmãs que carregam a fixture ganharam a coluna `ultima_sincronizacao` no stub (o motor é late-bound:
  sem ela, quebrariam em runtime) e seguem verdes.

## Limites conhecidos / onde mais

- **Retrato velho = conta desde o retrato.** Um SKU cuja linha parou de ser atualizada (há 112, a mais velha de
  abril/2026) passa a contar todo pedido do app desde S−7, `concluido_recebido` inclusive. É coerente com o retrato,
  porque o físico também é daquela data, e erra para subcompra. Medido hoje: só SKUs não habilitados.
- `atualizar_parametros_numericos_skus` tem o mesmo corte por `now()` SP − 7, mas só no **log** de posição/capital
  do ajuste automático (`reposicao_param_auto_log`), fora da decisão de compra. Ficou fora deste PR.
- **`calendario_antecipar_avaliacao`** (`20261119120000_calendario_antecipar_recesso.sql`, #3968, ainda **não
  aplicada** em prod em 2026-11-18) copia o `em_transito` do motor com o corte velho (`p_hoje − 7`) e declara "Mudou
  lá ⇒ muda aqui". É informativa (lista de antecipar), mas com o sync atrasado subconta o trânsito e recomendaria
  antecipar o que já foi comprado. Ajuste de paridade fica com a sessão dona do calendário, antes de aplicar.
  `db/test-calendario-acaminho-recesso.sh` fixa a 20261101090000 (motor velho): segue verde, mas não prova o novo.
- O recesso (18/12/2026–03/01/2027) segue dependendo do sync para o físico. Este conserto só garante que o pedido
  do app não suma do a caminho quando o sync falha.

## Parecer Codex (gpt-6.2-astra, reasoning max, 2026-11-18): APROVAR COM MUDANÇAS, nenhum P0

Codex reproduziu o caso D−8: o motor anterior contava 0 e o novo conta 4. Triagem:

- **Aceito:**
  - a 1ª aplicação sobre o predecessor agora tem o rc conferido (A0);
  - o mutante do comentário passa a isolar a limpeza: o predicado novo inteiro só no comentário e um equivalente do
    velho (`- 7`) no código;
  - um controle prova que, **sem** a limpeza, o mutante passa. Prova: 27/0 nos dois locales.
- **Retrato velho conta desde o retrato (P1, mantido por desenho).** O próprio Codex desaconselha um teto
  `GREATEST(…, D−N)`, porque ele reabre o 0× numa interrupção longa. A checagem decisiva que ele pediu, medida em
  prod (psql-ro): há **0** linhas com retrato velho em grupo com âncora habilitada, e os 2 SKUs afetados não são
  habilitados nem estão em grupo. Hoje isso não muda nenhuma decisão de compra.
- **Fora deste PR (preexistentes; o motor novo nunca conta menos que o de antes):**
  - membro de grupo **sem linha** em `sku_estoque_atual`: o `LEFT JOIN` dá NULL e o corte volta ao do ciclo (0× no
    vão);
  - disparo tardio entre syncs: o pedido ganha o nº Omie depois da leitura do sync;
  - PO numerado parado na etapa 10;
  - `gerar_pedidos_oportunidade_ciclo` usa a anti-duplicação `p_data_ciclo − 7` (o mesmo relógio duplo, mas na
    oferta antecipada);
  - o histórico do carimbo sem o pendente: remendo WP01 e edge v1.5.
  Uma coluna dedicada `pendente_corte_app` (gravada pela edge) é o desenho de longo prazo que o Codex sugere.

## Deploy

| camada | o quê | quem |
|---|---|---|
| migration | `20261118120000_reposicao_acaminho_relogio_do_sync.sql` (nome custom, **não auto-aplica**) | sessão via `bun run db:aplicar` (envelope: PRE md5, POS-RU1, transação) ou founder no SQL Editor |
| edge | nenhuma | — |
| Publish | nenhum (sem mudança em `src/`) | — |

## Residuais tratados (PR seguinte, 2026-11-18): migration `20261119130000_reposicao_acaminho_membro_sem_linha.sql`

- **Membro sem linha (consertado).** O SKU sem retrato próprio passa a cortar pelo **último retrato da empresa**:
  `COALESCE(sea_c.ultima_sincronizacao, máx. da empresa)`. Esse é o run do sync que pulou o PO do membro. Antes, o
  `LEFT JOIN` dava NULL e o corte voltava ao dia do ciclo, o que dava 0× no vão. Isso vale para o galão que "vive sem
  sea próprio" e para a linha sem data.
  - O conserto só acrescenta (`LEAST`). Se a empresa não tem retrato nenhum, vale o corte de antes.
  - Medido em prod (psql-ro): hoje há 0 membros sem linha e 0 linhas sem data. É uma proteção latente.
  - Prova: `db/test-acaminho-membro-sem-linha.sh`. Ela é vermelha contra a 20261118120000 (o grupo recompra) e verde
    com a nova, 14/0 nos dois locales.
    - F1 tira o fallback, F2 deixa o máximo vazar entre empresas, e as duas mordem com controle verde.
    - O dente da POS-RU1 aborta a migration com o corte sem o fallback e faz rollback.
  - `db/test-acaminho-relogio-unico.sh` passou a extrair o motor da própria 20261118120000, como já fazem as provas
    do calendário, em vez de ler a fixture viva.
- **Oportunidade (não é o relógio duplo; não mudou).** `v_oportunidade_economica_hoje` (`pg_get_viewdef` da prod) não
  lê `sku_estoque_atual`, pendente nem `pedido_compra_item`: a quantidade vem da demanda (EOQ/cenário). A janela
  `p_data_ciclo − 7` de `gerar_pedidos_oportunidade_ciclo` é uma heurística ("pedido normal recente bloqueia a
  oferta") e não faz par com o pendente. Com o sync em dia, o pedido normal de D−8 também passa, e por isso o retrato
  atrasado não muda a decisão da oportunidade.
- **Seguem abertos e documentados:** disparo tardio entre syncs (nº Omie gravado depois da leitura) e PO numerado
  parado na etapa 10.

| camada | o quê | quem |
|---|---|---|
| migration | `20261119130000_reposicao_acaminho_membro_sem_linha.sql` (PRE md5 `48ae5fd1…` → `cc792038…`, POS-RU1) | sessão via `bun run db:aplicar` pós-merge |
| edge | nenhuma | — |
| Publish | nenhum | — |
