# Flaky "sob carga": o teto que você LÊ não é o que governa — e "é a máquina" esconde um número

**Classe:** um teste pisca quando a M2 8GB está saturada, passa isolado, e a explicação sedutora é
"é a máquina, sobe o timeout". Nas duas instâncias abaixo essa explicação estava **errada**: medir o
trabalho real devolveu um número acionável — um teto na camada errada e um custo algorítmico. A
carga só revelou; ela não foi a causa.

**Discriminante (a pergunta que decide, ANTES de tocar em qualquer timeout):**
*quanto tempo o trabalho real leva, e contra qual teto ele corre?* São duas medidas distintas, e
quase sempre uma das duas está errada por ordem de grandeza. "Passa isolado / falha sob carga" não
diz qual — só diz que existe uma margem estreita em algum lugar.

## Instância 1 — `SalesQuotes.accountGuard.test.tsx` (money-path P0-B)

`findByRole(/Enviar Pedido/i)` estourava sob carga com `Unable to find role="button"...` — que **lê
como elemento ausente, não como timeout**. O sintoma mente sobre a causa.

O teste declarava `it(..., 15000)` e o `vitest.config.ts` declara `testTimeout: 20000`. **Nenhum dos
dois governa `findBy*`/`waitFor`**: quem governa é o `asyncUtilTimeout` do `@testing-library/dom`,
que seguia no **default de 1000ms** porque o repo nunca chamou `configure()`. Havia três tetos
visíveis e o que decidia era o invisível.

Isto é a **recidiva do #271** (`sobe testTimeout do vitest 5s→20s (flaky de cold-start)`): aquele PR
diagnosticou a classe certa e corrigiu a camada que enxergava, deixando a irmã no default. Corrigir
"o timeout" sem enumerar as camadas de timeout deixa a metade que reincide.

Medido: sob load ~59 o caminho até a asserção levou **5.894ms** — o trabalho real precisava de ~6s de
wall-clock contra um budget de **1s**. O budget é wall-clock; o trabalho (render + varredura a11y do
`getByRole`) é CPU-bound.

Descartados com verificação, não com suposição: `await` faltando (`convertToOrder` está corretamente
`await`ado), mock resolvendo fora do `act()`, e `findBy` no skeleton em vez do botão.

Fix: `configure({ asyncUtilTimeout: 5000 })` em `src/test/setup.ts` — 5× o default e ainda 4× ABAIXO
do `testTimeout`, para que quem nunca resolve **continue falhando, e falhe com o dump de DOM** do
testing-library em vez do timeout opaco do vitest. Teto maior só ajuda se preserva o diagnóstico.
Removidos também os `it(..., 15000)` do arquivo: eles **encurtavam** o teto global de 20s e criavam
a falsa leitura de folga que mascarou o flake.

**Efeito colateral medido antes de aceitar o teto global:** um `waitFor` que **resolve** não paga
nada a mais; só um que FALHA paga 5s em vez de 1s. Nenhum teste do repo usa o padrão caro
`await expect(waitFor(...)).rejects`, então o custo em caminho verde é ~zero.

## Instância 2 — `manifesto.gate.test.ts`: o irmão que NÃO compartilhava a causa

Chegou junto no mesmo relato, rotulado como o mesmo flake de carga. **Não era** — e é por isso que
vale registrar as duas lado a lado: mesma queixa ("pisca sob carga"), causas em camadas diferentes.

Medido em separado: `listarArquivosSrc` = **543ms**, mas `validarManifesto` = **29.200ms**, contra o
`testTimeout` de 20s. O gate vivia **acima do teto**: não era flake, era **custo** — só passava
quando a máquina folgava. Causa: `casaPadrao` fazia `new RegExp` **a cada chamada**, e o gate a
chama uma vez por (arquivo × padrão).

**Corrigido pelo #1893** (`o gate do manifesto recompilava 1,9M regex — 40s contra o timeout de
20s`), que memoiza em `padraoParaRegex` — nível mais fundamental que o `casaPadrao` — e traz duas
coisas que uma memoização apressada erra:

- **`Map`, não objeto literal:** padrões como `constructor`/`__proto__` colidiriam com
  `Object.prototype` e envenenariam o cache.
- **Teste-sentinela para a flag:** reusar instância de `RegExp` só é seguro **sem** `g`/`y` — com
  elas `test()` carrega `lastIndex` e a 2ª chamada mente.

Medições independentes convergem na ordem de grandeza (29,2s aqui, ~40s lá; a árvore de `src/` e a
carga diferem entre as datas) — e a correção **não tocou em nenhum timeout**.

## A receita

1. **Meça o trabalho real fora do runner** (`bun run` num script solto, `performance.now()`). Um
   teste que leva 29s de CPU não é flaky — está acima do teto, e o teto não é o problema.
2. **Enumere as camadas de teto**, não "o timeout": `it(..., N)` · `testTimeout` do runner ·
   `asyncUtilTimeout` da lib de asserção. A que aparece no código costuma não ser a que decide.
3. **O erro que a lib emite pode não parecer timeout.** `Unable to find role=...` é timeout do
   `findBy*` — leia como "não apareceu A TEMPO", não como "não existe".
4. **Só então** decida entre baixar o custo (instância 2) e subir o teto (instância 1). Subir teto é
   legítimo quando o budget é que estava errado — mas escreva por que, e mantenha-o abaixo do teto de
   cima para não trocar uma falha diagnosticável por uma opaca.
5. **Falsifique nos dois sentidos** (padrão do #271): teto=1 tem de reproduzir o sintoma EXATO, e
   sabotar a asserção tem de dar vermelho — senão o teto novo cegou o teste em vez de estabilizá-lo.
