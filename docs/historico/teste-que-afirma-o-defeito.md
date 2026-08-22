# O teste que afirma o defeito — e a garantia que ninguém mediu

> Entrega de 2026-08-21 (`fetchAll` → `FalhaLeituraCritica`). Achado registrado como fora de
> escopo no #1836 e fechado depois. Duas lições, e a segunda é a cara.

## 1. Suíte verde pode significar "o defeito está PROTEGIDO", não "o defeito não existe"

`fetchAll` (`supabase/functions/_shared/paginate.ts`) reconstruía a falha de página como
``new Error(`${label}: ${error.message}`)``. `error.message` do PostgREST encaminha o MESSAGE
do Postgres, que interpola valor de LINHA (`RAISE EXCEPTION` com ID/CPF, erro de cast
reproduzindo o valor inválido) — e o `catch` do `Deno.serve` devolve `.message` no corpo da
resposta HTTP. Medido no dia: **13 das 20 edges** que dependem do helper montam o campo
`error:` da resposta a partir de `.message`.

O helper tinha teste. A suíte estava verde. O que o teste dizia era:

```ts
assertEquals((e as Error).message, "carteira_assignments: canceling statement due to statement timeout");
```

Seis testes afirmavam ATIVAMENTE o vazamento — cinco em `mapas-paginados_test.ts` casando a
mensagem inteira contra `${fonte}: ${MESSAGE do Postgres}`, e um em `relatorio-mensal_test.ts`
exigindo `message.includes("boom")` com a justificativa escrita **"erro deveria carregar a causa
original"**. A intenção era legítima e continua de pé (não engolir a falha, preservar o
diagnóstico); o que ninguém perguntou foi ONDE a causa deveria viver. Enquanto isso, cada um
desses testes era uma trava contra a correção: mudar o helper deixava a suíte vermelha, e a
leitura natural de "vermelho" é "quebrei alguma coisa".

**A regra:** quando um teste falha ao corrigir um defeito, a primeira pergunta é *qual contrato
esse teste afirma* — não *como faço ele passar de novo*. Um teste que casa a mensagem INTEIRA de
um erro está afirmando o formato do que sai pelo sink, e é aí que a asserção precisa das DUAS
metades: o diagnóstico preservado (em `cause`) **e** o texto do servidor ausente da mensagem
pública. Só "lançou" deixa o vazamento voltar; só "não vazou" passa com o diagnóstico perdido.

## 2. "Verificar o sink" é MEDIR — reler o próprio comentário não conta

O cabeçalho de `leitura-critica.ts` já dizia, desde que a classe nasceu, que o texto cru "fica em
`cause`, que não é serializado pela resposta". A frase era falsa por um detalhe de JavaScript:

```ts
this.cause = erro;                     // propriedade PRÓPRIA e ENUMERÁVEL
super(msg, { cause: erro });           // não-enumerável
```

Com a atribuição, `JSON.stringify(err)` e `{ ...err }` carregam o objeto cru do PostgREST
inteiro — `message`, `details` e `hint`, que é exatamente onde o Postgres interpola valor de
linha. Medido antes de corrigir, executando:

```text
Object.keys(err)                     => ["fonte","codigo","name","cause"]
JSON.stringify(err).includes(CPF)    => true
```

O mesmo challenge derrubou mais três garantias afirmadas da mesma família, todas reproduzidas
por execução antes de aceitar:

| Afirmado | Medido |
| --- | --- |
| "a falha de página é envelopada" | uma REJEIÇÃO do `await build(...)` escapava crua: `Error: "CPF-RAW-52998224725"` |
| "`data == null` cobre a resposta malformada" | `{ data: "CPF" }` resolvia `["C","P","F"]` — `push(...rows)` espalha qualquer iterável, e vira PII picada em caracteres entrando no cálculo como linha do banco |
| "o `code` é sanitizado por allowlist" | `^[A-Za-z0-9_]{1,12}$` valida FORMA, não domínio: `codigoDoErro({ code: "52998224725" })` devolvia o CPF INTEIRO pela porta que existe para fechá-lo |

**A regra:** uma garantia de privacidade escrita em comentário é uma HIPÓTESE até alguém rodar o
serializador que o sink de verdade usa. `JSON.stringify`, spread, `Response.json`, `console.error`
— cada um enxerga um conjunto diferente de propriedades, e "não-enumerável" é a diferença entre
invisível e exposto. O custo de medir é um `deno run` de dez linhas.

Corolário para allowlist: validar FORMA não é fechar DOMÍNIO. Um CPF sem pontuação passa em
qualquer regex de "alfanumérico curto". Quando o domínio legítimo é pequeno e enumerável —
SQLSTATE tem exatamente 5 caracteres, PostgREST usa `PGRST` + 3 dígitos — é o domínio que vale,
e o que sobra vira `desconhecido`.

## Onde isso vive

- Helper: `supabase/functions/_shared/paginate.ts` · classe: `_shared/leitura-critica.ts`
- Guardas: `paginate_test.ts`, `leitura-critica_test.ts` (sink medido, não afirmado),
  `recommend-leituras_test.ts` (as duas metades juntas)
- Gate textual: contract-pins G2 de `src/__tests__/paginacao-artesanal-gate.test.ts` — um por
  RAMO (`error` e `!Array.isArray`), porque um pin só deixava o outro ramo regredir verde.
