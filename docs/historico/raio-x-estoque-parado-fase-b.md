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

## Pendências que não couberam

- **Medir a meta da fase A no card a partir de 2026-11-25:** 100% do Top 61 decidido e caixa liberado ≥ R$ 60k.
- **Contradição de um SKU que deixou de estar parado:** leva a uma lista vazia, mas com o aviso de filtro visível. Fica como melhoria de texto.
- **`rxSku` continua na URL depois de trocar de empresa:** o aviso aparece e há botão para limpar.
