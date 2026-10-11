# A descrição do fornecedor sumia na confirmação da promoção (2026-10-10)

> Pendência do [jev-backtest-ptbr.md](jev-backtest-ptbr.md) §3/§8 (PR #2719: "13/13 com a descrição do
> fornecedor IGUAL à do SKU escolhido"). Migration
> `20261010224755_promocao_item_descricao_fornecedor_preservada.sql`, prova
> `db/test-promocao-descricao-fornecedor.sh` (núcleo do CI), tela em `src/components/reposicao/promocaoDetail/`.
> Regra viva em [reposicao.md](../agent/reposicao.md) §Motor.

## O defeito

`promocao_item.descricao_produto_fornecedor` deveria guardar o que o **fornecedor ofertou** — o texto que a
extração por visão leu do PDF/PNG da campanha. Promoção alimenta o forward buying
(`aplicar_promocoes_no_ciclo`), então o par "o que o fornecedor ofertou × qual SKU recebeu o desconto" é a
auditoria de um fluxo de dinheiro, e o histórico é o gabarito para automatizar promoção→SKU um dia. Três
escritores trocavam esse texto pela descrição do SKU Omie:

| Escritor | O que fazia | Linhas em prod |
|---|---|---|
| Tela — vínculo manual (`MapeamentoStatusCell`) | o original recebia a descrição do 1º SKU escolhido; cada irmão (`<código>#omie<id>`) nascia com a do SKU dele | 13 `manual_confirmado` (6 originais + 7 irmãos) |
| `expandir_promocao_item` — laço de ≥2 variantes | cada filha nascia com `v_variante.descricao` | 12 filhas da campanha 1 |
| `expandir_promocao_item` — ramo de 1 variante | `COALESCE(descricao_produto_fornecedor, v_variante.descricao)`: o NULL virava a descrição do SKU | 3 `unico` (indistinguível de texto legítimo) |
| `converter_sugestao_em_campanha_flat` | o item nascia com a descrição do SKU da sugestão interna | 0 (nunca usado) |

O único escritor que **origina** o texto é a edge `promocao-extrair-via-vision`
(`descricao_produto_fornecedor: item.descricao`) — não muda. Ninguém lê a coluna no cálculo do dinheiro
(`aplicar_promocoes_no_ciclo` não a cita; em prod só as 2 funções escritoras a mencionam): o dano é de
auditoria e de gabarito, não de preço.

## A medição (psql-ro, 2026-10-10)

- **25 de 25** `expandido_automatico` nasceram com a descrição do SKU. As 11 "diferentes" do catálogo atual
  são renomeação **posterior** no Omie ("PRIMER PU BRANCO FL.6269.02BD" → "PRIMER PU FL.6269.02BD"): a
  observação de cada filha grava a variante da época, e ela é igual à descrição gravada. As 10 origens
  `expandido_origem` têm descrição NULL.
- As 13 filhas da **campanha 23** não são desta função: códigos com sufixo de embalagem (`DR.4403L5`), sem
  observação, criadas num instante só (2026-05-13 01:00:44) e com as origens desativadas dois dias depois
  — um escritor ad-hoc, fora do código.
- **13 de 13** `manual_confirmado` iguais ao SKU; 7 com `#omie`. Originais criados pelo extrator às 13:41:08
  e sobrescritos pela tela entre 13:41:59 e 13:42:33 (campanha 24); o 119 (campanha 16) em 2026-05-16.
- Sem tabela de auditoria e sem o JSON cru da extração (só `console.log`); o arquivo-fonte vive em
  `promocao_campanha.origem_arquivo_url` (bucket `promocoes`), que o `claude_ro` não lê.

## O conserto

**Tela.** O vínculo manual não manda a descrição no PATCH do original, e os irmãos levam a do original
(`item.descricao_produto_fornecedor`, NULL inclusive). A descrição do SKU passa a ser **lida** do catálogo:
`useDescricoesSkuOmie` (conta da campanha em minúscula; chave = conta + SKUs distintos e ordenados) e
`descricaoDoSku`, que separa carregando / indisponível (erro ou sem rede) / fora do catálogo (só depois de
leitura boa) / ok, e marca o cache de refetch falho como desatualizado. Tooltips e popover mostram
**Fornecedor** e **SKU Omie** lado a lado (`DescricoesDoVinculo`); a coluna da tabela virou "Descrição
(fornecedor)". Dois defeitos preexistentes do mesmo handler, achados pelo Codex: o PATCH do original não era
aguardado (falhava e os irmãos nasciam com "vinculado" na tela) — agora `mutateAsync` e nada segue sem ele,
e a gravação de item (`atualizarItemPromocao`) só é sucesso com **exatamente 1 linha** afetada (o PostgREST
responde 204 sem erro a PATCH que não casa nada, e o original podia ter sido excluído);
e a similaridade já confirmada caía no ramo "Pendente" — ganhou ramo próprio. O "Confirmar" da similaridade
fica travado sem a descrição confiável do SKU: conferir um casamento aproximado exige ver os dois lados.

**SQL** (TRAVA → PRE por md5 → `CREATE OR REPLACE` → backfill → POS). A expansão não atribui mais a descrição
no ramo único e a filha leva a da origem; o converter não grava a descrição. O resto dos dois corpos é o de
prod byte a byte (gerado por troca exata: md5 `566edd78…`/`557f962e…` → `76b6e55a…`/`73b85888…`).

## O backfill — só onde o original é provado

O Codex (desenho, P1) derrubou o primeiro desenho, que casava filha↔origem por código **ou prefixo**: um
único casamento não prova filiação, e o prefixo estendia a regra a um escritor cujo contrato ninguém
demonstrou. Ficou um **manifesto fechado** de 12 linhas — as filhas da campanha 1 — com as provas
conferidas linha a linha **no apply** (qualquer uma que não valha mais aborta tudo, funções incluídas):

1. filha e origem na campanha 1, mesmo código, `expandido_automatico` × `expandido_origem`;
2. a observação da filha registra `[Expandido automaticamente do código <c> — variante: <descrição>]`;
3. a origem tem descrição NULL **e** `atualizado_em = criado_em` da filha — a última escrita dela foi o UPDATE
   da própria expansão, que não toca a descrição. Logo o original da filha é NULL.

As 17 linhas (12 filhas + 5 origens) são **travadas** (`FOR UPDATE`, em ordem de id) antes de qualquer
prova ser lida, e a POS4 exige as 12 **presentes** e com o original. Achado do adversarial do Codex (P1),
reproduzido **por execução** antes do conserto: outra transação que mudasse a observação da filha 8 sem
tocar a descrição, aberta durante o apply, deixava a migration aplicar sobre a prova vencida — o UPDATE só
revalida `id` e descrição, e o READ COMMITTED reavalia o `WHERE` sobre a versão nova (prova M9:
`APLICOU|MUDARAM` → `RECUSOU|intactas`); e filha excluída passava na POS4, que contava só as com texto.
Filha já saneada é pulada **sem** UPDATE: o gatilho `trg_touch_promocao_item` renovaria `atualizado_em`
num UPDATE no-op (Codex, P2). Valores "antes" de cada filha estão no próprio manifesto (reversível).

**Fica fora — original irrecuperável do banco, segue com texto de catálogo, NÃO serve de gabarito:**

| Linhas | Procedência |
|---|---|
| 119, 151-155 (originais) e 156-162 (irmãos `#omie`) | escrita de catálogo **comprovada** pela tela; o texto do extrator que existia antes (ou o NULL) se perdeu |
| 5, 133, 134 (`unico`) | indeterminada: o `COALESCE` só escrevia sobre NULL, mas texto legítimo igual ao catálogo é possível |
| 138-150 (filhas ad-hoc da campanha 23) | escritor fora do código, sem observação que prove a variante |

Recuperar qualquer uma exige ler o arquivo-fonte da campanha (Storage) e transcrever o texto do fornecedor
— decisão do founder, fora desta entrega.

## Provas

- vitest: `MapeamentoStatusCell.test.tsx` (vínculo, PATCH falho, exibição, similaridade), `descricaoSku.test.ts`,
  `useDescricoesSkuOmie.test.tsx`, `ItensTab.test.tsx`, `atualizarItemPromocao.test.ts` e
  `AdminReposicaoPromocaoDetail.gravacao.test.tsx` (a página até o toast). 10 sabotagens de UI, cada uma
  vermelha no teste certo.
- PG17 `db/test-promocao-descricao-fornecedor.sh`: 31 asserts (C predecessores = prod; A o defeito reproduz;
  M PRE/backfill/POS numa transação — `psql -1`, a moldura que o `db:aplicar` dá; não executa o
  `aplicar_sql` em si —, cada cenário num **clone** do banco-base, M9 com 2 conexões e ordem observada; F a
  chamada do front e do converter), verde em `C` e `pt_BR.UTF-8`; `--falsificar` com 15 sabotagens (as de
  corpo aplicadas **depois** do apply, para o vermelho vir do comportamento e não do md5).
- Codex: desenho (263 s · 111.012 tokens; P1 do prefixo → manifesto) e adversarial no diff (312 s · 190.053
  tokens; P1 da corrida → trava; P2 PATCH sem linha → `atualizarItemPromocao` exige 1 linha afetada; P2
  Confirmar com o SKU sem texto → travado).

## Lições

- **Copiar o derivado para a coluna de ENTRADA apaga a auditoria.** O SKU já estava em `sku_codigo_omie`; a
  descrição dele se lê por join. O `COALESCE(col, derivado)` que "só preenche o vazio" é a mesma fabricação
  — transforma "sem texto do fornecedor" em "o fornecedor escreveu o nome do catálogo".
- **Um casamento único por regra não é filiação.** Backfill de dado de dinheiro sai de manifesto fechado com
  a prova por linha conferida no apply, não de um predicado genérico.
- **UPDATE no-op não é inofensivo** com gatilho de carimbo: re-aplicar tem de pular a linha, não regravá-la.
- **Prova lida e UPDATE são instantes diferentes.** Conferir a prova num SELECT e escrever noutro deixa a
  janela em que a prova vence (o `WHERE` do UPDATE só revalida o que ele cita). Trave as linhas ANTES de ler
  a prova — e prove a corrida com duas conexões e ordem observada, não com `sleep`.
- **Sabotagem que não entra é verde "sem dente" pelo motivo errado.** A falsificação acusou a da POS4 por
  presença: o nome `pos4_…` não casava o `pos_*` do `case` que aplica sabotagens de migration, a suíte rodou
  limpa e saiu verde. O assert estava certo; o mutante é que nunca nasceu. O harness agora marca
  `SAB_APLICADA` em cada ramo e aborta (`exit 9`) a sabotagem que nenhum ramo reconheceu.
