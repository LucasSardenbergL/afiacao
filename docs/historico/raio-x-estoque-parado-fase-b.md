# Raio-X do estoque parado — fase B (a ferramenta dentro do app)

2026-10-17/18 · PRs #3115, #3122, #3128 e #3134 · spec `docs/superpowers/specs/2026-10-15-raio-x-estoque-parado-fase-b-design.md` · plano `docs/superpowers/plans/2026-10-16-raio-x-estoque-parado-fase-b.md`

## Por que a fase B começou antes do sinal medido

A fase A (Artifact solto, retrato de 2026-10-15) condicionava a B ao sinal **medido**: 100% do Top 61 decidido e ≥ R$ 60k de caixa liberado, medidos a partir de 2026-11-25. Em 2026-10-15 o founder **trocou o portão**. Aceitou como sinal o **uso** da página: 17 decisões gravadas no Artifact, 10 `liquidar` e 7 `estrategico`, todas do mesmo autor, cerca de 28% do Top 61.

O motivo foi terminar a faxina dentro do app, com autor, motor de compras e missão ao vendedor, em vez de no Artifact. A meta e o prazo da fase A continuam e agora são lidos no card "Caixa liberado" do app. A troca é **decisão do founder, registrada**, não uma exceção à regra de `fase-sem-sinal.md`: o sinal de uso existia, com denominador (17 de 61).

## O que entrou

| PR | Entrega |
| --- | --- |
| #3115 | Banco: `raio_x_decisao` e mais 5 RPCs com gate `cap_custo_ler`/escrita SECURITY DEFINER, com provas PG17 [money-path] |
| #3122 | Aba "Raio-X" em `admin/reposicao/baixo-giro`: lógica TS, hook paginado (`.range()`), placar, segmentos e saídas |
| #3128 | Decisão com saída do motor na mesma transação, reclassificação, contagem e selo no pedido de compra [money-path] |
| #3134 | Card "Caixa liberado" (RPC `raio_x_medicao`) e carga das 17 decisões da fase A [money-path] |

**Card "Caixa liberado".**
- Na Oben, mostra vendido, liquidado (preço abaixo de 90% do médio de 12 meses), trocado, ainda parado e recomprado, contra a meta de R$ 60.000.
- Na Colacor, mostra só "trocado" e "saiu do estoque (sem NF para atribuir: venda, consumo ou baixa?)". A palavra "vendido" nunca aparece, porque ali não há NF que atribua a saída.
- Caixa liberado e "R$ que distorce o DIO" **nunca se somam**: ficam em blocos separados e há teste para isso.
- Uma contradição (SKU decidido que voltou a ser comprado) filtra pelo **SKU exato** (`rxSku` na URL), porque a busca por código é substring: `A1` casa `A10`.

**Carga da fase A.**
- O script `scripts/raio-x/carga-fase-a.ts` gera `db/2026-10-18-raio-x-carga-fase-a.sql`.
- Foto = `retrato.json` do Artifact (meta.hoje = 2026-10-15). O `foto_em` é meia-noite de São Paulo.
- `origem='artifact_fase_a'` e `tirou_do_motor=false`.
- Aplicada com aprovação do founder via `bun run db:aplicar`: primeiro `--ensaio` com rollback, depois a tentativa #502, com recibo e sha256 `7ab38a25…` do commit `acb05b1e4`.
- Validação por fora via psql-ro, na Oben: estrategico 7 (R$ 30.861,35) e liquidar 10 (R$ 26.014,26), total 17 (R$ 56.875,61), com o motor intacto.

**O Artifact da fase A** (`https://claude.ai/artifact/MyvzRxHFpMnhfAufb6zg3p`) foi republicado em 2026-10-18 em modo **só leitura**. Ganhou o aviso "Migrado para o app" com link para a aba, e os controles de decisão foram desligados para todos. As decisões continuam visíveis e os dados do Artifact **não** foram apagados.

## Lições

- **Uma postcondição só de contagem passa por falso verde.** `count(*) where origem='artifact_fase_a' = n`, com o n tirado do próprio arquivo, aprovava:
  - linha `app` pré-existente engolida pelo `on conflict do nothing`;
  - linha da mesma origem em outra empresa;
  - reexecução com dado divergente;
  - arquivo parcial.

  O Codex pegou esse caso. O conserto foi juntar uma CTE com as tuplas esperadas, comparando cada coluna com `is not distinct from`, e conferir o total por origem com `--esperado` fixo. Cada caso foi provado executando num PG17 descartável.
- **Corpo que roda dentro de EXECUTE não se protege com `SET LOCAL standard_conforming_strings`.** A string inteira já foi lida antes do SET. Por isso a defesa é recusar `\` e `'` em todo texto que vira literal, com whitelist na categoria.
- **`if v <> n then raise` é barrado pelo gate `assert-verde-por-ausencia`** mesmo quando `v` vem de `count(*)`, que nunca é NULL. O gerador emite `is distinct from`. A versão aplicada (com `<>`) e a do repo diferem só nisso, e o commit `3d533b65a` registra.
- **Ausente ≠ zero também no texto de apoio.** "N SKU(s) sem medição (R$ 0 na foto…)" com todos os SKUs sem custo é ausente apresentado como zero. Quando não há custo conhecido, o aviso diz só "N sem custo".

## Correções pós-revisão (2026-10-31, revisão Codex + Fable de 2026-10-30) [money-path]

A revisão achou 4 bugs que ameaçavam a medição da meta de 25/11, um rótulo errado na Colacor e a falta de sensor de visita (0 decisões no app desde ~18/10 e nenhum jeito de saber se alguém abriu a aba). Migrations `20261031130000_raio_x_correcoes_pos_revisao.sql` e `20261031130100_analytics_ledger_raio_x.sql`.

1. **Janela de venda pela foto.** `raio_x_decidir` troca `decidido_em` quando o destino muda e a foto fica. A medição filtrava a venda por `decidido_em`, então trocar "venda dirigida" → "liquidar" apagava do placar venda já feita. Agora a janela começa no dia (SP) de `foto_em`, que é imutável, com fronteira estrita. Linha sem foto devolve `qtd_vendida`/`receita` NULL: antes vinha 0, que era ausente fabricado como zero. **A contradição de recompra continua por `decidido_em` do destino vigente, de propósito:** compra feita antes de decidir tirar do estoque não contradiz a decisão. As 17 decisões da fase A têm `foto_em = decidido_em` (15/10), então a medição delas não muda.
2. **Coorte do Top 61 congelada** (`raio_x_coorte_top` + `raio_x_congelar_coorte`). Antes o Top era recalculado a cada leitura: item que vende sai, outro entra, e a meta virava alvo móvel. Na 1ª leitura sem coorte, o app manda os SKUs do Top de hoje. O servidor grava posição e valor (saldo × cmc lidos lá) uma única vez por empresa, e a primeira escrita vence. O placar mede contra a coorte, inclusive SKU que vendeu tudo e saiu da lista. Quem entraria no Top hoje aparece com "entrou no Top depois do congelamento" e não mexe no denominador. Se a coorte falhar (ex.: migration não aplicada), a aba **não cai**: o placar mede contra o Top de hoje e diz isso. **A coorte original de 17/10 não é reconstruível** (não há histórico de posição), então a coorte nasce no 1º acesso depois do Publish. Como houve 0 decisões no app desde então, o Top de hoje ≈ o de 17/10, menos o que vendeu.
3. **Entrada recente vira alerta, não imunidade.** `novo_aguarde` agora vale só para cadastro < 90 dias. Item parado com entrada < 90 dias segue a regra normal e ganha na linha o alerta "recompra recente de item parado · entrada há N dias".
4. **"Caixa liberado" não era caixa.** O card agora mostra três parcelas separadas: **estoque reduzido (a custo)**, **receita das vendas** (faturado das unidades contadas) e **crédito de troca informado**. **O critério da meta não mudou:** a barra dos R$ 60k segue somando estoque reduzido + crédito informado, agora rotulada "critério da meta", nunca "caixa". Mudar o critério (ex.: medir por receita) é decisão do founder.
5. **Colacor, tipos 01/03.** Continuam no bloco uso e consumo (fora da reposição, decisão mantida), mas o placar os separa como **estoque industrial (CPC 16) que NÃO distorce o DIO**. "Distorce o DIO" passa a ser não-mercadoria (08/imobilizado e afins) + uso e consumo (07, família, marcação). Pelo psql-ro em 2026-10-31, na conta `colacor_vendas` com saldo > 0 e cmc > 0: 01 ≈ R$ 643k (173 SKUs), 03 ≈ R$ 141k (110), 07 ≈ R$ 202k (279), 08 ≈ R$ 1,48 mi (199).
6. **Sensor de visita.** `reposicao.raio_x_aberta` no ledger server-side (`analytics_ledger_registrar`, mesmo molde da aba Corantes), 1× por titular, empresa e dia, só com a leitura pronta e nunca sob a lente "Ver como". ⚠️ A `analytics_outbox` **purga em 30 dias** (`purgar_em`). Para 25/11 cabe na janela; para série mais longa, rode a query antes de vencer.

**Prova:** `db/test-raio-x-fatos.sh` aplica a 31/10 POR CIMA da 16/10. Controle verde nos dois locales; a PRE anti-deriva é provada à parte (corpo derivado aborta); 34 sabotagens ficam vermelhas pelo motivo certo, das quais 3 são da janela/contradição e 7 da coorte. Uma lição: **sabotar a migration ANTIGA também muda o corpo antigo que a PRE da nova confere**, então nesse laço a PRE roda neutralizada numa cópia, e é provada separadamente.

### Query — visitas e decisões por dia (psql-ro)

```sql
WITH v AS (
  SELECT (o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia, o.props->>'empresa' AS empresa,
         count(*) AS visitas, count(DISTINCT o.user_id) AS pessoas
    FROM public.analytics_outbox o
   WHERE o.evento = 'reposicao.raio_x_aberta'
   GROUP BY 1, 2),
d AS (  -- estado ATUAL: decidido_em é o da última troca de destino (o histórico de trocas não é guardado)
  SELECT (x.decidido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia, x.empresa, count(*) AS decisoes
    FROM public.raio_x_decisao x
   WHERE x.origem = 'app' AND x.destino IS NOT NULL
   GROUP BY 1, 2)
SELECT coalesce(v.dia, d.dia) AS dia, coalesce(v.empresa, d.empresa) AS empresa,
       coalesce(v.visitas, 0) AS visitas, coalesce(v.pessoas, 0) AS pessoas, coalesce(d.decisoes, 0) AS decisoes
  FROM v FULL JOIN d ON d.dia = v.dia AND d.empresa = v.empresa
 ORDER BY 1 DESC, 2;
```

Antes da migration do ledger ser aplicada e do Publish, zero visitas é **ausência de sensor**, não falta de uso. O denominador só vale a partir da 1ª linha.

## Pacote 2 — plano de execução (2026-10-31) [money-path] [migration manual]

Spec: `docs/superpowers/specs/2026-10-31-raio-x-pacote-2-design.md` (desenho aprovado pelo founder em chat).

- **RPC nova `raio_x_planejar`** (migration `20261031180000_raio_x_plano_execucao.sql`): 6 colunas em `raio_x_decisao`
  (`preco_piso`, `canal_liquidacao`, `responsavel`, `prazo`, `concluido_em`, `concluido_por`). Escritor único do plano;
  `raio_x_decidir`/`raio_x_medicao` **intocadas** — o decidir devolve a linha via `%ROWTYPE` + `SELECT *` e ganha as
  colunas sem recriar (provado EXECUTANDO no PG17, `db/test-raio-x-planejar.sh`: controle verde nos dois locales + 14
  sabotagens, inclusive REVOKE sem anon e INVOKER abortando pela postcondição).
- **Re-decidir não apaga o plano no banco:** a leitura filtra (piso/canal só com destino `liquidar`; `concluido_em <
  decidido_em` = destino mudou depois → não concluído).
- **Custo de esperar** = valor × taxa anual / 12, com a taxa de `fin_regua_custo_capital` (OBEN 17,75% a.a.; COLACOR
  sem configuração → nada exibido). Com taxa única a ordem da lista não muda: o ganho é urgência em R$.
- **Piso × preço real** só com UMA unidade de venda (senão "sem comparação"); a medição lista "liquidou abaixo do piso".
- **"Executado" é tarefa, não dinheiro:** a meta continua vindo só da medição.
- **Ritual Codex (gpt-6-astra, high, 128s, ~121k tokens) — 5 achados, todos aplicados:** (P1) rascunho velho
  sobrescrevia o plano → `p_atualizado_em` + **RX003** (concorrência otimista, provada no PG17); (P2) re-marcar
  "executado" depois de mudar o destino guardava a data velha → só preserva execução VIGENTE; (P2) NF sem
  `valor_total` vira receita 0 na medição (coalesce) → piso não compara com receita ≤ 0 (receita PARCIALMENTE ausente
  segue indetectável sem tocar a medição — limitação aceita); (P2) reabrir repunha responsável/prazo apagados →
  padrões só em plano nunca gravado; (P2) "Salvar execução" fechava o painel descartando rascunho da decisão →
  rascunho cruzado trava o outro botão. Authz/ACL/search_path e `decidir`/`contar` após o ALTER: sem achado.

### Query — adoção do plano (psql-ro)

```sql
SELECT empresa,
       count(*) FILTER (WHERE destino IN ('trocar','venda_dirigida','liquidar','erro_cadastro')) AS executaveis,
       count(*) FILTER (WHERE responsavel IS NOT NULL)                                          AS com_responsavel,
       count(*) FILTER (WHERE destino = 'liquidar' AND preco_piso IS NOT NULL)                   AS liquidar_com_piso,
       count(*) FILTER (WHERE concluido_em >= decidido_em OR (concluido_em IS NOT NULL AND decidido_em IS NULL)) AS executadas,
       count(*) FILTER (WHERE concluido_em::date <= prazo)                                       AS no_prazo,
       count(*) FILTER (WHERE prazo < (now() AT TIME ZONE 'America/Sao_Paulo')::date AND concluido_em IS NULL) AS vencidas
  FROM public.raio_x_decisao GROUP BY empresa;
```

## Pendências que não couberam

- **Medir a meta da fase A no card a partir de 2026-11-25:** 100% do Top 61 decidido e caixa liberado ≥ R$ 60k.
- **Contradição de um SKU que deixou de estar parado:** leva a uma lista vazia, mas com o aviso de filtro visível. Fica como melhoria de texto.
- **`rxSku` continua na URL depois de trocar de empresa:** o aviso aparece e há botão para limpar.
