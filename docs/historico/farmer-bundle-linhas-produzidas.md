# `linhasProduzidas` do bundle — a auditoria de ALCANÇABILIDADE que o teste não substitui

Registro da lacuna de teste declarada no **#1800** e de como ela foi fechada. Vale a leitura antes
de mexer em `src/hooks/useBundleEngine.ts` perto do `catch`: quem ler o `some(...)` sem este doc vai
achar que a estreiteza do caminho é cobertura esquecida, e não a conclusão de uma auditoria.

## A correção (#1800)

```ts
// antes — contava CLIENTES
linhasProduzidas = allCustomerBundles.length > 0;
// depois — conta linhas PERSISTÍVEIS
linhasProduzidas = allCustomerBundles.some((cb) => cb.bundles.length > 0);
```

Achado do challenge Codex (gpt-5.6-sol, xhigh). Um cliente entra em `allCustomerBundles` pelo
`if (topBundles.length > 0 || bestIndividual)` — ou seja, **entra só com a comparação individual, com
`bundles: []`**. Essa comparação não vira linha nenhuma no `p_linhas` da RPC
`farmer_bundle_recomendacoes_substituir` (o payload é `allCustomerBundles.flatMap(cb => cb.bundles…)`).

Contando clientes, esse caso fazia `linhasProduzidas` sair `true` sobre uma execução que não produziu
linha alguma, travando o `if (!linhasProduzidas) await registrarVazio()` do `catch`. O head parava de
se mover, e "nenhum registro novo" voltava a significar duas coisas opostas — o mesmo defeito que o
#1765 (a geração vazia passa a existir) e o #1791 (falha de persistência não pode gravar
`vazio/completo`) fecharam por outros ângulos.

## Por que a correção entrou sem teste — e por que isso foi DECLARADO no PR

`linhasProduzidas` tem **um único leitor**: a linha `if (!linhasProduzidas) await registrarVazio()`
do `catch`. Fora do `catch`, a variável não tem efeito observável nenhum. Logo, todo teste do
invariante precisa de:

1. um cenário com `allCustomerBundles.length > 0` e `.some(cb => cb.bundles.length > 0) === false`
   (cliente só com `bestIndividual`); **e**
2. uma exceção que alcance o `catch` **depois** da linha que calcula `linhasProduzidas`.

O item 2 é o problema.

## A auditoria: o que pode lançar naquela janela

Enumerando tudo o que roda entre `linhasProduzidas = …` e o fim do `try`, no cenário de zero bundles
(`useBundleEngine.ts`, ~linhas 941–1070):

| trecho | pode lançar? | por quê |
|---|---|---|
| `allCustomerBundles.flatMap(cb => cb.bundles.map(…))` | não | itera sobre `bundles: []` |
| `avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_BUNDLE)` | não | pura: `Object.keys`/`filter`/`join`, sem I/O e sem `JSON.stringify` |
| `await registrarVazio()` → `registrarGeracaoFarmer` | não | blindada em TODAS as camadas: `supabase.rpc` dentro de `try/catch`, `mensagemDeErro` sem `JSON.stringify` (nunca lança), e `captureException` embrulhado por `withPosthog`, que tem `try/catch` próprio |
| `const { error } = await supabase.rpc('farmer_bundle_recomendacoes_substituir', …)` | **sim, e rejeita mesmo** | mas só é chamada quando `recomendacoes.length > 0` — e aí `.some(…)` é `true` nos dois mundos, então **não discrimina** |
| `allCustomerBundles.reduce(…)` + montagem de `problemas` | não | aritmética e strings |
| `toast.success` / `toast.warning` | na prática não | `sonner`; é a cauda do `try` |

O #1800 ainda **estreitou** o caminho por conta própria: ao embrulhar a leitura do melhor individual
num `try/catch`, tirou de circulação a rejeição que era a candidata mais provável daquela região. (E
mesmo antes disso ela não servia: escapava de dentro do laço de clientes, ou seja **antes** de
`linhasProduzidas` ser calculado, e sairia `false` nos dois mundos.)

**Conclusão da auditoria:** no código de hoje **não existe exceção real que alcance o `catch` com
`allCustomerBundles.length > 0` e todos os `bundles` vazios**. Não por acaso — por blindagem
deliberada de cada camada do caminho de persistência.

## O que foi entregue mesmo assim, e por quê

`src/hooks/__tests__/bundle-head-registra-vazio-sem-linha.test.tsx` — com o **gatilho declarado como
sintético** no cabeçalho: o teste faz o `toast` (a cauda do `try`) lançar, representando "uma falha
qualquer depois de `linhasProduzidas` ter sido decidido".

Não é um teste vácuo, e essa é a linha que separa (a) de (b): **ele falha com o código velho**. O
invariante que ele fixa é do BANCO, não do toast — *execução sem linha persistível tem que mover o
head* — e o dia em que alguém acrescentar um `await` naquela janela (um sensor, uma segunda gravação,
um `track()` assíncrono, uma leitura de conferência), o caminho reabre com o guard já no lugar.

O que o teste **não** deve ser lido como afirmando: que existe hoje um caminho de produção que o
`some(...)` conserta. Não existe. O que existe é uma variável que passou a significar o que o nome
dela diz — e um guard que sobrevive à próxima edição do arquivo.

### A montagem do cenário (o detalhe que não é óbvio)

Duas armadilhas de vacuidade, e como o teste sai delas:

- **`regras` é insumo OBRIGATÓRIO do bundle** (#1779). Zerar as regras produziria zero bundles pelo
  caminho errado — snapshot `degradado` — e o teste mediria outra coisa. Por isso as seis cestas do
  irmão `bundle-head-nao-mente-apos-linhas` são preservadas (o Apriori acha P1→P2 e P1→P3), e o que
  muda é a **carteira**: `c7`, o único cliente a quem as duas regras se aplicariam, fica fora dela.
  As regras existem, e ninguém tem bundle a receber.
- **A 1ª tentativa de registro precisa falhar como `falha_rpc`.** Com `recomendacoes.length === 0`, o
  fluxo normal já chama `registrarVazio()` antes do `catch`; se ela gravasse, `jaRegistrou` travaria o
  slot e os dois mundos ficariam indistinguíveis. O mock devolve erro na 1ª chamada — o que é
  legítimo e é **desenho** do `registrarVazio` (`falha_rpc` de propósito NÃO trava o slot, "para uma
  tentativa falha não suprimir uma posterior que daria certo") — e sucesso na 2ª, a do `catch`.

### Falsificação (a evidência)

Sabotagem: `some((cb) => cb.bundles.length > 0)` → `length > 0`, commitando antes (o `restaurar()`
aqui é `git checkout --`). Rodado nos dois locales, casando a âncora ASCII de caixa fixa
`FG-VAZIO-SEM-LINHA`:

| ambiente | exit | asserção que quebra |
|---|---|---|
| `LC_ALL=C` | 1 (`Tests 1 failed`) | `expected +0 to be 1` — nenhum registro de head com `p_resultado='vazio'` |
| `LC_ALL=pt_BR.UTF-8` | 1 (`Tests 1 failed`) | idem |

Quem quebra é o **discriminador de negócio**, não uma pré-condição: as asserções foram reordenadas de
propósito para que a falsificação exiba "o head não registrou o vazio", e não "o mock foi chamado N
vezes". Restaurado, `bun run test` fecha em 692 arquivos / 6.471 testes, exit 0.

## A lição transportável

**"Sem teste" e "sem caminho" são diagnósticos diferentes, e só a auditoria de alcançabilidade
separa os dois.** Uma correção de money-path que não dá para observar não é necessariamente
supérflua — pode ser uma variável cujo *significado* estava errado, esperando a próxima edição do
arquivo para virar bug. O que não se pode fazer é deixar a lacuna sem registro: sem este doc, o
próximo a ler o `some(...)` gasta a mesma tarde refazendo a enumeração acima para descobrir que o
caminho está fechado — ou, pior, escreve um teste que passa com o código velho e sela a lacuna com
uma cobertura falsa.
