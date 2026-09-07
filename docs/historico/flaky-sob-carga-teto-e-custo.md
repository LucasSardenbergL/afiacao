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

## Instância 3 — `erro-colapsado-em-vazio-gate.test.ts` (#2311): medir ISOLADO **subestima 4×**

Gate AST (compiler API do TypeScript sobre 1.473 fontes, 8,5 MiB) estourou com `Test timed out in
20000ms` — 21.754ms — na M2 saturada; verde no CI. A hipótese de entrada era "o teto de render virou
orçamento de varredura num repo que quadruplicou" (o `testTimeout: 20000` do #271 foi calibrado com
195 arquivos de teste; hoje são 786).

**O passo 1 da receita, sozinho, teria mandado fechar como não-reproduzível.** Medido em 2026-09-07,
do mais limpo ao mais real, o pior `it`:

| regime | pior `it` | folga contra 20s | subestima o real em |
|---|---|---|---|
| fora do runner (`bun`/JSC) | 3.267ms | 6,1× | 3,9× |
| fora do runner (`node`/V8) | 2.435ms | 8,2× | 5,2× |
| vitest, arquivo **isolado** | 4.890ms | 4,1× | 2,6× |
| vitest, **suíte completa** | **12.643ms** | **1,58×** | — |

Fora do runner o trabalho é ~3s contra um teto de 20s, e a conclusão sedutora é "o teto está
folgado, foi a máquina". Errado: o número que governa é o da **suíte completa**, 4× maior, porque o
regime que custa é a **contenção entre os workers paralelos do vitest** — e nem a execução fora do
runner nem a execução isolada *dentro* do vitest reproduzem esse regime, por construção. Repetir a
medição isolada, em duas engines e sob load 120 com 4,1GB de swap, dá sempre ~3s: **estabilidade da
medida errada não é evidência**.

Contexto que só a suíte completa dá, e que decide a escala da correção: esses dois `it` são o **1º e
o 2º testes mais lentos de 8.134**; o 3º fica em 9.820ms e nenhum outro passa de 15s. Uma varredura
estática achou **21 testes** da classe "gate que varre o repo dentro do `it`", todos no teto global —
mas a medição mostrou o risco **concentrado em um arquivo**, não espalhado. Contar sítios da classe
prevê exposição; só medir prevê qual estoura.

Fix: orçamento próprio nos dois `it`, **por fonte** (40 ms/fonte, 4,7× o pior medido) e não um número
fixo — a causa que aperta sozinha é o repo crescer, então o teto acompanha o denominador sem
afrouxar o custo unitário, que é o que denuncia regressão do detector. Piso `Math.max(20_000, …)`
para nunca ficar ABAIXO do global (a armadilha da instância 1). E como "teto maior só ajuda se
preserva o diagnóstico", um `onTestFailed` imprime fontes/ms/ms-por-fonte contra a referência
medida, separando carga · repo · detector — as três hipóteses que o timeout nu não distingue.

Descartados com medição, não com suposição: motor de JS (bun e node concordam), memória (pico de
219MB), custo do detector (2,05 ms/fonte, estável), e cache incremental — memoizar `acharColapsos`
baratearia o **2º** `it`, deixando o 1º, que é o gargalo, intacto.

## A receita

0. **Meça no regime que falhou.** Fora do runner e isolado-no-runner medem *o custo*; só a **suíte
   completa** mede a *contenção entre workers*, que na instância 3 valia 4× e era o número que
   governava. Medida isolada estável, repetida em duas engines, continua sendo a medida errada.
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
