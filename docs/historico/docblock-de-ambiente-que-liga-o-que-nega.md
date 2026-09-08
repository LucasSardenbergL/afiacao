# Docblock de ambiente do vitest: citar o token **em prosa** liga o ambiente — inclusive quando a prosa o NEGA

**2026-09-07.** O `vitest.config.ts` particiona a suíte por extensão (`.ts` → `node`, `.tsx` → `jsdom`)
e instrui, para o `.ts` que precisa de DOM: *"a saída é o mesmo docblock"*. A instrução está certa. O que
ela não diz é que **o vitest procura o token no TEXTO do arquivo, não numa declaração** — então quem
escreve prosa *sobre* o docblock troca o ambiente sem querer.

Ao criar `src/hooks/useOfflineMutation.node.test.ts` — cuja razão de existir é rodar em `node`, o único
ambiente onde `navigator.onLine` é `undefined` — o docblock começava assim:

```
 * SEM `@vitest-environment jsdom` DE PROPÓSITO — este arquivo tem de rodar em `node`.
```

O arquivo rodou **em jsdom**. A frase que declarava a intenção foi o que a destruiu.

## A medição

Dois arquivos idênticos salvo a prosa do docblock, mesma config, mesma invocação:

| arquivo | prosa contém o token | `navigator.onLine` | ambiente REAL |
|---|---|---|---|
| `__h1` | sim — **negando** o token | `true` | jsdom |
| `__h2` | não menciona | `undefined` | node |

## Por que passa despercebido

- **O rótulo da saída mente.** O vitest imprimiu `FAIL |node| src/hooks/useOfflineMutation.node.test.ts`.
  `node` ali é o nome do **project**, não o ambiente que rodou. Quem confere o rótulo confirma o
  contrário do que aconteceu.
- **O sintoma é verde, não vermelho.** Um teste escrito para provar comportamento sob sonda ausente passa
  em jsdom — só que provando outra coisa. Mesma família de `gates-textuais-cegos.md`: verde por CEGUEIRA.
- **Nenhum gate pega.** typecheck, lint e a suíte ficam todos verdes. O único detector é o próprio teste.

## O que fica

1. **Não escreva o token de ambiente do vitest em prosa** — nem citando, nem negando, nem em bloco de
   código dentro do comentário. Descreva ("este arquivo não declara ambiente no docblock") sem o token.
2. **Teste cujo VALOR depende do ambiente tem de ASSERIR o ambiente.** Uma asserção de premissa
   (`expect(navigator.onLine).toBeUndefined()`) custa 2 linhas e é o que separa "provei" de "passei".
   Sem ela o arquivo teria sido entregue verde, em jsdom, provando nada. Foi ela que pegou isto.
3. **Premissa de ambiente falha ALTO, não degrada.** Se o runtime passar a definir `onLine`, o certo é o
   arquivo ficar vermelho pedindo reancoragem — não passar por vacuidade.

## Coda: o sabotador que não sabotou

A falsificação desta armadilha (S3: injetar o token em prosa e exigir vermelho) **ficou verde na primeira
tentativa** — e a leitura preguiçosa seria "a asserção de premissa é fraca". Não era: o sabotador usava
`perl -0pi -e "s{...}{... @vitest-environment jsdom ...}"`, e o **perl interpolou `@vitest` como array
vazio** dentro do `s{}{}`. O arquivo recebeu `-environment jsdom` — mudou, sem conter o token.

O guard do laço checava `git diff --name-only` (*"o arquivo mudou"*), que passou. ⇒ **Guard de sabotagem
tem de exigir marcador POSITIVO da mutação pretendida**, não "houve mudança": senão um sabotador quebrado
é indistinguível de um teste fraco, e a conclusão sai invertida. Ver `evidencia-positiva-shell.md`.
