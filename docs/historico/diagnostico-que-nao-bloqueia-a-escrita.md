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

## O que o mutcheck pegou na própria suíte

- `soma += centavos(d)` → `soma += d * 100` **sobrevivia**: todos os descontos dos testes (0,10; 0,20; 10; 20) viram inteiros exatos ao multiplicar por 100. O caso que discrimina é R$ 0,29 (0,29 × 100 = 28,999999999999996). Suíte que só usa números "redondos" é cega justamente ao defeito de ponto flutuante que a correção existe para matar.
- A mutação `if (raw.length > TETO) {` → `if (false) {` **não compilava**: dentro de um bloco inalcançável o TypeScript perde o estreitamento de `Array.isArray` e `raw` volta a `unknown`. O runner a marcou INVÁLIDA — contada como pega, seria o falso-PEGA. Reescrita como `raw.length > TETO * 1000`.

E um defeito do lado da operação, fora do repo: o ramo "registrar o PARE e seguir" do condutor da passada nunca tinha sido exercitado — na 1ª vez que um PARE caiu nele, a passada saiu com o código de falha. Ramo de script operacional sem teste é o mesmo "ausente ≠ zero" no eixo do instrumento: agora ele tem um teste com controle (o corpo antigo reproduz o defeito).

Prova: módulo **69/69** (Deno) · mutcheck **64/64 pegas**, 0 sobreviventes, 0 inválidas, controle+ 64/64 · `test:edges` **1130/0** · `edges:typecheck` 0 erros de classe-crash (114 tolerados, a mesma contagem da main) · 14 gates vitest que leem a edge como texto **204/204** · eslint, knip, `authz:check`, `sonda:bump` e `sonda:fingerprint` verdes.
