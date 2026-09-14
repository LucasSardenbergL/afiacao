# A conferência dizia `diverge` e a escrita seguia — diagnóstico que não bloqueia é relatório

**2026-09-14** · `supabase/functions/omie-desconto-backfill/` (v1.5) · money-path · continuação de [cobertura-que-o-campo-ausente-tambem-daria.md](cobertura-que-o-campo-ausente-tambem-daria.md)

## O que aconteceu

A v1.3 da edge do backfill de `order_items.desconto_valor` ganhou uma testemunha por valor: somar o desconto que a régua lê em cada item e comparar com o `total_pedido.valor_descontos` que o próprio Omie calcula. Na passada completa de dry-run (54 páginas, Oben/TTM, repetida em 11/09 e 14/09), ela respondeu **4.864 `confere` e 1 `diverge`**: o pedido **7638**, com R$ 292,26 de desconto nos itens e R$ 0,00 no total, nunca faturado.

O verificador externo da execução parou a passada no `diverge` — e a 2ª opinião (Codex r2) reproduziu o que teria acontecido sem ele: com a v1.3, a página do 7638 terminava em **HTTP 200 com as nove linhas aplicadas**. O sensor medira, o operador leria, e a edge escreveria mesmo assim. A proteção morava no script de quem dispara, não no caminho que escreve.

## A forma generalizável

> **Diagnóstico que não bloqueia é relatório.** Quando uma checagem identifica, por unidade de decisão (aqui, o pedido), que duas fontes discordam, a MESMA informação tem de decidir a escrita dentro do caminho que escreve. Se ela só aparece na resposta, a proteção depende de alguém ler antes de escrever — e deixa de existir no primeiro run automático, ou no primeiro operador com pressa.

Na v1.5 a conferência virou portão (`portaoDoPedido`): pedido fora de `confere` não tem linha nenhuma no plano, e cada linha retirada sai como recusa **com motivo** (`total_nao_confere`), para o fechamento por id continuar valendo.

## A folga que escondia o desconto inteiro

A 1ª versão aceitava **um centavo de diferença por item** como arredondamento. O Codex r2 mostrou o furo: 100 itens zerados contra um total de R$ 0,69 davam `confere` — a folga (R$ 1,00) era maior que o desconto. **Tolerância proporcional ao tamanho da amostra cresce exatamente onde o erro se esconde.** A v1.5 compara em centavos inteiros, por igualdade: diferença de arredondamento deixa de ser absorvida e vira recusa medida, visível no detalhe por pedido (precisão > recall). De quebra some a divergência fabricada pelo ponto flutuante (`|0,03 − 0,04|` = 0,010000000000000002).

## A testemunha de fora do caminho

Os títulos do Omie (`fin_contas_receber`, outro endpoint) foram cruzados com bruto − desconto planejado: **1.974 pedidos faturados batem ao centavo**. As exceções vieram em par: **12305 e 12787**, mesmo cliente, mesmos dois itens (70 + 60), R$ 0,69 de desconto no pedido e as duas notas emitidas no bruto (R$ 130,00). O total do próprio Omie confere nos dois — logo o portão não os pega. Conflito entre dois documentos do Omie não se resolve escolhendo o conveniente: a invocação ganhou `excluir_ids`, que **só estreita** e é fail-closed (forma inválida → HTTP 400, nunca "sem exclusão").

## A 3ª rodada: o padrão que escrevia, e o mesmo dia que não amarrava nada

A revisão do commit da v1.5 (Codex r3) reprovou o deploy com três achados — o portão estava certo; o caminho até ele, não:

- **JSON quebrado virava escrita.** `req.json().catch(() => ({}))` transformava corpo ilegível em `{}`, e cada parâmetro tinha padrão silencioso: o de `dry_run` era ESCREVER, o de `max_paginas` era 12, e `excluir_ids` ausente é, legitimamente, "nenhuma exclusão". Um dry-run com exclusões e uma vírgula a mais chegava à RPC como escrita sem exclusão atravessando 12 páginas. Agora `lerParametrosBackfill` (pura, no módulo) lê o corpo INTEIRO antes de qualquer efeito: não-objeto é 400; `dry_run` é obrigatório e booleano; parâmetro presente e inválido é 400 — inclusive `max_paginas: "1"`, que `Number.isFinite` recusava em silêncio e trocava por 12.
- **`excluir_ids: null` passava como "sem exclusão"** — e o teste protegia a exceção. Só ausente é vazio.
- **"Mesmo dia UTC" fixa a janela, não os dados.** Entre o dry-run aprovado e a escrita, o Omie pode mudar um desconto sem mudar SKU, quantidade, preço nem total: tudo segue `confere`, e o valor novo é gravado. A comparação posterior por id só DETECTA o que já foi escrito. A escrita passou a exigir `plano_aprovado` [id, valor]: o portão só libera a linha cujo valor, em centavos, está no plano; o resto vira recusa `fora_do_plano_aprovado`. É o vínculo PREVENTIVO. Na operação, o manifesto de cada página é o plano do dry-run dela, logo antes, ∩ o plano da passada que o founder aprovou — valor diferente do aprovado para ANTES de escrever.

Um quarto veio da sessão que mediu o [P1] do #2478: **a escrita exige `max_paginas: 1` explícito**, porque o lote acumula entre páginas e o pedido da fronteira relido chegaria duas vezes à mesma RPC (medição e resíduos em [recusas-da-escrita-dois-fatos.md](recusas-da-escrita-dois-fatos.md)).

> **Quem pode escrever não tem padrão.** Em rota de efeito, todo parâmetro ausente que muda O QUE se escreve — modo, alcance, exclusão, plano — é erro, não default; e corpo ilegível é erro, não objeto vazio. O teste casa a MARCA do ramo: `ok: false` sozinho aprova a guarda errada (sem a guarda de `dry_run`, `{}` ainda reprovaria — pela exigência do plano).

## As ferramentas de fora também foram sabotadas

A operação usa checadores fora do repo: veredito por resposta, agregador da passada, montador do manifesto, conferência do banco antes/depois e o gerador dos disparos. Cada um ganhou harness com controle verde, e cada checagem NOVA foi sabotada numa cópia do checador, com o harness exigido vermelho e o controle verde na mesma invocação. Dois buracos apareceram:

- a conferência "tudo o que o banco gravou está no manifesto" não tinha caso que a isolasse: toda sabotagem dela era pega por OUTRA checagem. Faltava a linha nova, fora do plano relatado e dentro do manifesto, gravada com outro valor;
- o gerador recusava a escrita sem plano por dois caminhos (a guarda explícita e o `jq` que valida o arquivo), e o harness só olhava o exit 2 — removida a guarda, seguia verde.

**Checagem que nenhuma sabotagem isolada deixa vermelha é redundante ou está sem caso** — e as duas coisas são invisíveis até alguém sabotar uma camada por vez.

## O que o mutcheck pegou na própria suíte

- `soma += centavos(d)` → `soma += d * 100` **sobrevivia**: todos os descontos dos testes (0,10; 0,20; 10; 20) viram inteiros exatos ao multiplicar por 100. O caso que discrimina é R$ 0,29 (0,29 × 100 = 28,999999999999996). Suíte que só usa números "redondos" é cega justamente ao defeito de ponto flutuante que a correção existe para matar.
- A mutação `if (raw.length > TETO) {` → `if (false) {` **não compilava**: dentro de um bloco inalcançável o TypeScript perde o estreitamento de `Array.isArray` e `raw` volta a `unknown`. O runner a marcou INVÁLIDA — contada como pega, seria o falso-PEGA. Reescrita como `raw.length > TETO * 1000`.
- A mesma armadilha voltou com `false && planoAprovado.get(…)`: no ramo inalcançável, o TypeScript usa o tipo DECLARADO (`… | null`) e a mutação não compila. Reescrita como `planoAprovado.get(a.id) === -1` — desliga o plano sem mexer em tipo.

E um defeito do lado da operação, fora do repo: o ramo "registrar o PARE e seguir" do condutor da passada nunca tinha sido exercitado — na 1ª vez que um PARE caiu nele, a passada saiu com o código de falha. Ramo de script operacional sem teste é o mesmo "ausente ≠ zero" no eixo do instrumento: agora ele tem um teste com controle (o corpo antigo reproduz o defeito).

Prova do portão (antes do r3, commit `76df04819`): módulo **69/69** (Deno) · mutcheck **64/64 pegas**, 0 sobreviventes, 0 inválidas, controle+ 64/64 · `test:edges` **1130/0** · `edges:typecheck` 0 erros de classe-crash (114 tolerados, a mesma contagem da main) · 14 gates vitest que leem a edge como texto **204/204** · eslint, knip, `authz:check`, `sonda:bump` e `sonda:fingerprint` verdes.

Prova depois do r3 (corpo estrito, plano aprovado, página única na escrita): módulo **79/79** (Deno) · mutcheck **79/79 pegas**, 0 sobreviventes, 0 inválidas, controle+ 79/79 · harnesses das ferramentas de operação verdes (veredito 49 casos, agregador 24, manifesto 11, conferência 16, gerador 20) e **15 sabotagens de checador vermelhas com 5 controles verdes** · BATERIA_R4_PLACEHOLDER.
