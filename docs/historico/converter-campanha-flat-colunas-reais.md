# O converter de negociação em campanha flat: o item nas colunas reais, com o código Sayerlack do diálogo

**2026-10-01.** Issue #2668. Migration `20261001083000_converter_campanha_flat_colunas_reais.sql`, a
fixture `db/fixtures/converter-campanha-flat-predecessora-prod-20261001.sql` e a prova
`db/test-converter-campanha-flat.sh`. É o 3º material da classe (ii) do fuso da sessão
([hoje-da-sessao-nu-funcoes-e-skills.md](hoje-da-sessao-nu-funcoes-e-skills.md)), deixado de fora da
leva das 7 funções porque a RPC estava quebrada por outro defeito.

## O defeito, medido na prod (psql-ro)

O botão "Registrar desconto fechado" da Negociação Paralela chama
`converter_sugestao_em_campanha_flat`. Ela **nunca funcionou** na prod:

- o INSERT em `promocao_item` usava `sku_descricao_extraido`, `desconto_base_perc`,
  `mapeamento_confianca` e `mapeamento_origem`, colunas que a tabela não tem (`pg_attribute`). Isso dá
  42703 a qualquer hora, e a transação volta com a campanha junto. A prova reproduz o defeito
  EXECUTANDO o corpo de prod (P0);
- mesmo com as colunas certas, faltava `sku_codigo_fornecedor` (NOT NULL, sem default), e o
  `sku_codigo_omie` da sugestão é `text` enquanto o do item é `bigint`, sem cast de atribuição;
- `data_inicio` e `data_oferta` eram `CURRENT_DATE`. Das 21:00 às 23:59 BRT a sessão (UTC) já está no
  dia seguinte, e com data fim = hoje o CHECK `ck_periodo_coerente` recusava a campanha.

Uso: 0 campanhas `desconto_flat_condicional`. As 325 sugestões são da v1 (gerador por cron, parado desde
06/06) e estão todas `ignorada`. A v2 calcula a fila ao vivo a partir de `v_sku_parametros_sugeridos` e
só grava a linha quando alguém clica "Vou negociar".

## A decisão (founder, 2026-10-01)

"Consertar só o converter" e "código Sayerlack no diálogo, pré-preenchido". O porquê do código: a
identidade de um item de campanha é o código do FORNECEDOR. A tela de promoção pede esse código, e
`expandir_promocao_item`/`resolver_sku_por_codigo_fornecedor` acham o SKU procurando o código DENTRO da
descrição do produto no Omie (não há coluna com ele; `omie_products.codigo` é interno, `PRD00003`). A
sugestão só tem o SKU Omie, então o código vem de quem converte.

O pré-preenchimento (`extrairCodigoSayerlack`) pega o último termo da descrição que começa por letra e
tem ponto: `VERNIZ PU FOSCO FO5.6717.00GL` → `FO5.6717.00GL`. Cobertura medida: 210 dos 213 SKUs
Sayerlack da fila, e nenhuma descrição com dois candidatos. Os 3 de fora são uma cartela de cores e 2
tingidores com o código separado por espaço (`TEH 3505.211FG`); para eles o campo vem vazio e quem converte
digita. É o mesmo texto que o resolver procura, então uma re-expansão do item volta ao mesmo SKU.

## O conserto

- **SQL.** A assinatura muda (`p_sku_codigo_fornecedor`, obrigatório, depois de `p_data_fim`), então é
  DROP + CREATE: manter o overload antigo deixaria a versão quebrada no ar. O DROP + CREATE reseta o ACL,
  e o fecho PORTA_GATE reemite a porta nomeando as roles. O item grava o código aparado, a descrição, o SKU
  em bigint, `mapeamento_qualidade = 'manual_confirmado'`, `confirmado = true` e a origem na observação;
  o volume continua na campanha. As datas usam o dia de SP. As guardas têm mensagem para o toast: código
  vazio, data fim no passado, SKU não numérico e sugestão já convertida, com a linha travada por
  `FOR UPDATE` (dois cliques não criam duas campanhas). O corte de faturamento trunca o mês sobre
  `timestamp` sem fuso (o mesmo resultado, sem depender da sessão).
- **Front.** O campo no diálogo, a validação e o parâmetro novo; o helper com teste; a ajuda da tela (que
  descrevia as colunas inexistentes); os tipos do Supabase.
- **Ordem de deploy:** a migration, depois o Publish. Até o Publish, o front velho chama a assinatura
  antiga e recebe "função não encontrada", que é o mesmo botão quebrado de hoje.

## A prova — `db/test-converter-campanha-flat.sh`

25 asserts:
- H1/H2: o predecessor é o corpo de prod (md5) e o último CREATE do repo;
- P0: o defeito, executado;
- X1/X3/X3s/X2: a deriva aborta a PRE; a função nasce com a porta sem e com o default ACL do Supabase;
  re-aplicar é seguro;
- O1/A1: a assinatura antiga saiu, e a porta está certa;
- R0: o pin do relógio;
- P1-P3: campanha, item e sugestão;
- N1-N7 + NZ: os portões, sem gravar nada;
- B0/BU/BS: a borda do dia de SP, com D = 28/02/2025, em 4 instantes sob sessão UTC e SP, convertendo
  com data fim = hoje;
- W: como `authenticated`, com o search_path de prod e no relógio real.

`--falsificar`: 19 sabotagens, todas vermelhas no assert certo, com controle verde na mesma invocação.
Matriz: servidor UTC/SP × `lc_messages` C/pt_BR.

A falsificação ensinou duas coisas, ambas antes do PR:
1. O token de acerto do R0 era "TRIPWIRE", e o `eq()` lê essa palavra como vazamento do relógio (vira
   ERRO_DE_EXECUCAO). O token passou a ser "RELOGIO_CONTROLADO".
2. A POS4 procura `current_date` no `prosrc`, e o `prosrc` inclui os COMENTÁRIOS do corpo. Um
   comentário citava `current_date`, e a migration teria abortado na própria pós-condição.

## Passo 0 — instância única ou classe?

**Instância única**, na assinatura "coluna da lista de um INSERT que não existe na tabela-alvo, num corpo
vivo de função". Varredura da prod: 372 funções `public` (plpgsql/sql, fora de extensão), 119 com INSERT,
218 INSERTs, 1.543 colunas conferidas contra `pg_attribute`. Achado: só as 4 do converter. Controle
positivo: o predecessor casa e o corpo novo não. Limites declarados: INSERT sem lista de colunas, em outro
schema, `UPDATE … SET` e leitura de coluna não foram varridos. A primeira versão da varredura dava
falso-positivo em massa: o `btrim` só tira espaço, então a coluna escrita em linha nova virava
"inexistente". A versão final apara espaço, tab e quebra de linha.

## Achado de passagem

O CHECK `promocao_item_mapeamento_qualidade_check` é `= ANY (ARRAY[…, NULL])` e aceita QUALQUER valor: a
comparação com o NULL dá NULL, e um CHECK com NULL passa. Fica sem issue porque é latente: em 01/10, 0 das
151 linhas tinham valor fora do conjunto, e todos os escritores gravam valores fixos.

## Codex

Caminho B: a cota está esgotada até 03/10 19:11 (exit 75 em 30/09). A revisão adversarial foi a minha,
mais a prova falsificável. **REVISÃO INDEPENDENTE PENDENTE**: o retroativo entra junto com os do #2659 e
do #2685.
