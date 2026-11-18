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

## Conserto na edge: o membro ausente do físico com PO aberto (omie-sync-estoque v1.11)

**Furo** (achado do Codex no #3969 e confirmado no código): o lote dos membros de grupo em `publicacao.ts` só gravava
os SKUs que vieram no `ListarPosEstoque`. Membro com PO aberto e **fora** da listagem ficava sem linha em
`sku_estoque_atual`; com isso o pendente dele se perdia, e o pedido do app caía no corte `D − 7`. Resultado: o PO era
contado **0×** e o grupo recomprava. O #3973 tentou o conserto no motor (fallback no último retrato da empresa) e foi
reprovado: o máximo da empresa avança sem publicar o pendente do membro. A decisão do founder foi consertar na edge.

**Desenho.** O par gravado é (físico 0, pendente da MESMA varredura de PO, já aprovada pelo C1). O 0 não fabrica: o C2
garante que a listagem com `cExibeTodos=S` foi completa, e o motor já lia `COALESCE(sea.estoque_fisico, 0) = 0` para o
membro sem linha. O físico do grupo não muda; passam a existir o pendente e o retrato do dia. A marca de dono é
`fonte_sync = 'PO_sem_posicao_ListarPosEstoque'`.
- **INSERT … ON CONFLICT DO NOTHING para TODO membro atual ausente**, com ou sem PO, com RETURNING. O pendente é
  `pendenteMembros ?? 0` (o 0 é legítimo sob o C1).
- **O que o RETURNING omitiu (a linha já existia) → UPDATE.** O `WHERE` leva a marca e o relógio
  (`ultima_sincronizacao <` início da coleta do PO deste run), e o UPDATE também devolve RETURNING. Isso:
  - reconcilia a linha nossa a cada run, inclusive para 0;
  - faz o perdedor de dois inserts simultâneos ainda reconciliar;
  - deixa intacta a linha de OUTRA origem (a varredura completa ainda pode pular uma linha, LIMITE em `fisico.ts`, e
    zerar um físico lido antes seria fabricar);
  - deixa intacto o retrato publicado por um run mais novo depois da coleta deste.
- **O retrato gravado é o INÍCIO da coleta do PO** (`tPo`), no insert e no update, o mesmo valor do filtro `<`. O
  run que começou depois vence nas duas ordens de escrita (Codex, 5ª rodada). É também o instante em que a edge lê as
  chaves de dedup do `em_transito`.
- **Sem leitura prévia das linhas nossas.** A 3ª versão lia as linhas nossas antes. O update no conflito a tornou
  redundante, então ela saiu: menos uma falha possível.
- **Por que o retrato é incondicional:** o PO do APP é deduplicado do pendente, porque o `em_transito` o conta. Sem o
  retrato, o motor corta o `em_transito` em `D − 7`, e com o sync atrasado o PO fica 0× (Codex, 2ª rodada). Detectar o
  PO do app pelos itens do Omie falhava com item vazio ou sem `nCodProd` (Codex, 3ª rodada). O retrato incondicional
  não depende disso.
- **Só membro ATUAL:** o index passa `membrosGrupo`, e passa `undefined` se a leitura da equivalência falhou. Sem ela
  nada é lido nem escrito. Antes, `membrosErro` deixava `pendenteMembros` vazio e zeraria as linhas nossas às cegas.
- **Ficam fora:**
  - o físico ilegível (ele veio na listagem);
  - o item de PO ilegível (sem par; entra na contagem `membros_grupo_ilegiveis`);
  - o ex-membro.
- **Dedup do ramo portal do `em_transito` (Codex, 4ª rodada).** O `fetchEmTransitoKeys` ganhou o predicado do 2º
  ramo da CTE: `status_envio_portal IN (sucesso_portal, enviado_portal)`, protocolo não nulo, número Omie nulo, status
  fora de cancelado/expirado e **sem corte de data**. Ele usa `.limit(1000)` + `count exact` e lança se faltar linha.
  Antes, um PO `AFI-<id>` desse ramo, aberto no Omie, entrava no pendente E no `em_transito` (2×). Isso já afetava
  habilitados e membros listados, e o retrato novo o estenderia aos membros sem linha. Em prod hoje há 0 pedidos nesse
  ramo.
- **Observação:** só SKUs com RETURNING entram no pendente gravado. Falha **ou conflito** tira o `pendente_aplicado`
  (Codex P2, 2ª rodada).
- **Desfecho:** não muda.
- **Resumo e registro:** ganham `membros_grupo_ausentes_{com_po,inseridos,reconciliados,ja_com_linha,falhas,erro}`.

**Codex, 1ª rodada (gpt-6.2-astra, high, 79s): REPROVA, P1.** Só com o INSERT … DO NOTHING, a linha criada pela edge
congelava. Ele executou 4 runs, com a varredura `10 → 10 → 4 → 0`, e a linha ficou em 10 nos quatro. Isso conta 2× a
entrega recebida e 0× um PO novo. O P2 da mesma rodada: a observação era suprimida quando o RETURNING vinha vazio.
Daí veio a reconciliação da linha nossa. Ele confirmou que `ignoreDuplicates` + `select` devolve só as linhas
inseridas (teste do PostgREST).

**Codex, 2ª rodada (high, 1880s): REPROVA, P1 e P2.** O P1 da 1ª rodada foi fechado. Faltavam:
- **P1:** o membro com só PO do app deduplicado ficava sem retrato.
- **P2:** um UPDATE para 0 que perdia a corrida ainda dava `aplicado: true`.
- O ex-membro ganhava retrato fresco.
- O ilegível ausente não entrava na contagem.

Todos foram consertados.

**Codex, 3ª rodada (high, 150s): REPROVA, três P1.**
- **0×, consertado:** a coleta do `dedup_app` dependia do `nCodProd` do item. Agora o retrato é incondicional.
- **0×, consertado:** um run mais velho zerava o retrato de um run mais novo. Agora o UPDATE é condicionado ao relógio.
- **2×, preexistente:** o ramo portal do `em_transito` conta **sem corte de data**, e a dedup da edge só cobria a
  janela de 7 dias. Primeiro foi tratado como fora de escopo; na 4ª rodada o Codex pediu o conserto antes do deploy, e
  ele entrou aqui (ver Desenho).

**Codex, 4ª rodada (high, 95s): REPROVA, dois P1, ambos consertados.**
- **0×:** o perdedor de dois INSERTs simultâneos não reconciliava. Agora o UPDATE condicionado roda no conflito.
- **2×:** o ramo portal; entrou a dedup.

**Codex, 5ª rodada (high, 89s): REPROVA, dois P1.**
- **0×, consertado:** com coletas sobrepostas, a linha guardava o FIM da coleta de A e o filtro usava o INÍCIO da de
  B. Agora o retrato é o início da coleta.
- **0× transitório, aceito como P2 na 6ª:** um pedido do portal com mais de 7 dias, deduplicado, recebe o número Omie
  e vira `disparado`. Sai dos dois ramos da CTE até o próximo sync publicar o pendente do SKU. Sem a dedup, o mesmo PO
  ficava 2× pela vida inteira. Fechar a janela exige o motor saber que o último retrato deduplicou o PO, o que pede
  migration e fica fora daqui. O cron 31/124 roda em UTC 09:05 e 09:40–19:40 a cada 2h, ou seja, SP 06h05 e
  06h40–16h40. O maior intervalo agendado é de 13h25, e uma falha de publicação pode prolongá-lo.

**Codex, 6ª rodada (high, 35s): APROVA.** Fechou o P1 da sobreposição e aceitou o 0× do portal como P2 residual. Nas
palavras dele, só esta edge periódica não consegue garantir a passagem de 1× para 1×.

Fora de escopo, também apontado por ele, há um preexistente: na COLACOR, o
`computePendenteViaListarSaldo` devolve o `Map` no lugar de `{pendente, pendenteMembros}`. Hoje é inalcançável (a
COLACOR não tem habilitado) e fica como follow-up.

**Prova** (Deno, `publicacao_test.ts`, 104/0, depois de sair a leitura das linhas nossas):
- O teste antigo "membro que não veio no retrato não é escrito" virou a expectativa nova. O vermelho antes do conserto
  deu 5 falhas.
- A sequência do Codex (10→10→4→0 e 10→16) roda numa tabela em memória que persiste entre runs. Também estão
  cobertos:
  - a linha de outra origem, que fica intacta;
  - a corrida, que não toca a posição real e mantém a observação fail-closed;
  - a leitura das linhas nossas que falha;
  - o membro que voltou à listagem;
  - o membro que virou habilitado.
- A forma do adaptador está no vitest: marca no `WHERE`, `ignoreDuplicates`, completude da leitura, coleta do
  `dedup_app` e `membrosGrupo` só com a equivalência lida.
- Falsificação com controle verde na MESMA invocação. Na 1ª etapa, 7 sabotagens deram vermelho. Na 2ª, as 9 deram
  vermelho; na 3ª, 14, somando PO do app, membro atual, `membrosErro`, `aplicado` com conflito e contagem de ilegíveis. Na 4ª,
  15, somando insert só com PO, retrato sem o início da coleta e update sem o relógio. Na 5ª, 15 contra o código da 4ª rodada e, depois do conserto da 5ª, 16:
  conflito sem update, dedup do portal ausente ou com corte de data, SKU fora do grupo e as anteriores que seguem
  válidas.
  Uma sabotagem ficou verde e expôs camada não exercida sozinha (a leitura das linhas nossas mascarada pelo conflito):
  ganhou um teste isolado. As da 2ª etapa:
  - sem reconciliar;
  - 0 virando o valor velho;
  - insert sem excluir as linhas nossas;
  - linhas nossas sem o filtro de ausente;
  - aplicado ignorando a leitura;
  - conflito contado como gravado (esta pegou um buraco no teste da corrida, já fechado);
  - update sem a marca;
  - leitura sem a prova de completude.
- A guarda redundante "não está em `encontrados`" foi removida: nenhum teste a provava.

**Residual (aceito):**
- 0× transitório do portal → `disparado` (acima). Follow-up no motor.
- Membro ausente com linha de OUTRA origem mantém o par velho. Ele é coerente no tempo, e o corte pelo retrato velho
  conta os pedidos do app desde então. Aparece em `membros_grupo_ausentes_ja_com_linha`.
- Linha nossa de ex-membro vai a pendente 0. O motor não a lê, porque ela está fora da equivalência.
- Linha nossa com PO ilegível fica velha.

**Deploy:** só a edge `omie-sync-estoque` (v1.11), decidida por `bun run pendencias:deploy`. Sem migration e sem
Publish.
