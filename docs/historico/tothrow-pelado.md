# `toThrow()` pelado — o `WHEN OTHERS THEN 'OK'` do TypeScript

**Quando:** 2026-08-21/22 · **Como apareceu:** ciclo de auto-ensino (técnica: mutation-check), não um bug reportado.

## A lição que existia em SQL e não tinha atravessado para o TS

O CLAUDE.md já dizia, para banco: *"teste negativo com `WHEN OTHERS THEN 'OK'` é teatro → capturar a SQLSTATE
esperada"*. O gêmeo em TypeScript é `expect(...).toThrow()` **sem argumento**: passa com QUALQUER exceção,
inclusive um `TypeError` vindo de um typo no próprio dublê. O teste fica verde provando nada.

Mais irônico: a lição **já estava escrita no repo**, num comentário de `src/lib/__tests__/postgrest.test.ts:526` —
*"TypeError e um `rejects.toThrow()` pelado passaria verde pelo motivo errado"*. Ficou presa ali. Não atravessou
nem para as asserções irmãs do mesmo arquivo, nem para o CLAUDE.md, nem para o consumidor da mesma invariante.

## O levantamento (com denominador, não em cima de "achei que tinha")

93 chamadas de `toThrow`/`toThrowError` em `src/`+`scripts/`: **69 com argumento, 24 peladas**.
Das 24, a maioria está **defendida pela asserção seguinte** (`expect(ctx.categoria)…` logo abaixo — se o throw
fosse pelo motivo errado, o `mock.calls[0]` não teria a categoria certa). `not.toThrow()` pelado é legítimo.

Sobram **7 blocos onde o `toThrow()` pelado é a ÚNICA asserção do `it`** — aí nada resta:

| Arquivo | Risco | Por quê |
|---|---|---|
| `src/services/__tests__/getAnaliseDimensional.test.ts:153` e `:163` | **alto** | FAIL-CLOSED de money-path (`/financeiro/analytics`) |
| `src/hooks/unifiedOrder/__tests__/familia-exclusion.test.ts:37,43,48` | médio-alto | guard de injeção no `.or()`; a função tem 2 throws distintos e o pelado não os separa |
| `src/lib/pedidosProgramados/helpers.test.ts:46` | médio-alto | fiscal — "nunca emitir NF com nº fabricado" |
| `src/lib/carteira/__tests__/escopo-clientes.test.ts:24` | baixo | `chunk([1], 0)`, contrato trivial |

## A prova (mutation-check, `scripts/mutcheck.sh`)

Alvo: `fetchAllPages` (`src/lib/postgrest.ts`) visto pelo consumidor `getAnaliseDimensional.test.ts`.
Mutação que modela o risco real — **o código lançar um bug em vez do guard assinado**:

| mutação | antes (`toThrow()` pelado) | depois (casa a marca) |
|---|---|---|
| ramo `data:null` lança `TypeError` em vez da falha assinada | ⚠️ SOBREVIVE | ✓ PEGA |
| guard assina o `motivo` ERRADO (`data_null_sem_error` → `pagina_falhou`) | ⚠️ SOBREVIVE | ✓ PEGA |
| controle+ (trunca na 1ª página) | ✓ PEGA | ✓ PEGA |

Baseline verde e **controle+ válido nas duas rodadas** — sem isso o resultado seria lixo. 1/3 → 3/3.

## O conserto

Casar a **marca estrutural**, não a prosa: `ehFalhaDePagina(erro)` + `erro.motivo`. É estritamente mais forte que
regex de mensagem e o próprio `postgrest.ts` explica por quê — a assinatura existe *"para o caller tratar a falha
ESPERADA de leitura sem, no mesmo gesto, engolir um bug de código"*, e casar por TEXTO já é
*"frágil como contrato"*. Nos outros 5, regex do ramo (`/Pattern de família inválido/` × `/ao menos um pattern/`
separam os dois throws da mesma função).

## Meta-achado: o instrumento de diagnóstico foi o artefato menos testado da sessão

Três bugs, todos no MEU script ad-hoc, todos se apresentando como "achado sobre o repo":

1. **Re-implementei a regra de descoberta do runner.** Filtrei `supabase/**/*_test.ts` assumindo a convenção do
   underscore → declarei `paginacao.test.ts` como "teste que nunca roda". O Deno descobre `*.test.ts` por padrão:
   o arquivo roda, 9 testes, exit 0. **Quando a pergunta é "o runner pega este arquivo?", a fonte de verdade é o
   runner** (rodá-lo e ler o que ele coletou), não um glob que você escreveu.
2. **`FILENAME` no `awk` já tinha avançado** quando o `flush()` roda na virada de arquivo → bloco atribuído ao
   arquivo errado (acusei `getCapitalDeGiro` por um bloco de `getAnaliseDimensional`).
3. **Regex contou comentário como código** → o `` `rejects.toThrow()` `` citado DENTRO do comentário da lição
   virou falso positivo. O repo já tem a regra (`removerComentarios` de `@/lib/gates/limpeza-fonte`,
   `gates-textuais-cegos.md`) — eu não a apliquei porque a tinha arquivado como regra de código de PRODUÇÃO,
   não de script de diagnóstico descartável.

As três regras já existiam no repo, em roupagem de produção. **Script de medição descartável merece o mesmo
guard que código de produção** — porque o resultado dele é que decide o que você vai "consertar".
