# O custo de SONDAR é condicional ao bundle temido — não é o custo do fluxo real

> 2026-09-05, fechando as 3 indeterminadas da auditoria de deploy de edges (26–31/08).
> Complementa o critério do `--caro` que o #2159 mergeou horas antes, e **corrige uma afirmação
> dele** que a medição falsificou.

## O que o #2159 estabeleceu (e continua valendo)

`--caro` classifica pelo **EFEITO medido** do fluxo real, não pela **FORMA** do handler. O proxy
"a edge despacha por `body.action`?" foi medido e reprovado: a metade positiva vale, mas a
**ausência** de dispatch não prova o contrário — `ausente ≠ zero` aplicado à forma do código.

## O que faltava: o probe pode nunca ALCANÇAR o fluxo real

O critério do #2159 mede o que a edge faz **quando roda**. Mas a trava existe contra um cenário
específico — *bundle PRÉ-sensor ignora o `{"probe":true}` e roda o fluxo real*. Se o bundle que se
**teme** estar no ar já honra o probe, ele retorna antes de qualquer efeito, e o custo é **zero
independentemente do que o fluxo real faria**.

Logo o custo de sondar é uma **conjunção avaliada em ordem**, não uma propriedade da edge:

1. **O bundle temido honra o probe?** Prove no PAI, nunca de memória:
   `git show <sha-do-merge>^:supabase/functions/<edge>/versao.ts | grep VERSAO`.
   Marcador presente ⇒ custo **ZERO**, e a pergunta 2 não se faz.
2. **Só se (1) for não:** o que o fluxo real escreve/chama? — aí sim o critério do #2159.

A skill já tinha as duas metades, **em seções que não se citavam**: a "exceção que torna a sonda
ativa segura ANTES do deploy" (v1.0 → v1.1) e, agora, o critério do `--caro`. Elas podem discordar
sobre a mesma edge: o `--caro` classificou `carteira-positivacao-snapshot` como cara-porém-reversível
enquanto a exceção já a declarava **segura**. As duas estão certas — respondem perguntas diferentes,
e a de cima decide.

## A afirmação corrigida

O #2159 registrou que disparar `carteira-positivacao-snapshot` fora de hora custa *"uma linha
parcial do mês corrente que o próximo tick reescreve"*. **Erra nas duas pontas:**

- O probe **retorna antes de escrever** (`index.ts:42` contra o upsert da `:104`) ⇒ em bundle
  **v1.0+** grava **nada**. O upsert só sai no ramo pré-sensor.
- E mesmo nesse ramo, o alvo default é o **mês ANTERIOR**, fechado (`index.ts:62`,
  `nowBrt.getMonth() - 1`) — não o corrente. Reescreve mês fechado com o mesmo dado, em vez de
  publicar um parcial. O próprio comentário do código diz `default = mês anterior em BRT`.

A distinção não é cosmética: o consumidor é o **UTI de contas** (`src/hooks/useUtiContas.ts:254`),
que lê os 2 meses mais recentes com snapshot para decidir entrada. Um parcial do mês **corrente**
teria custo money-path; reescrever o anterior, fechado, não. Superestimar o custo empurra para a
ida-e-volta com o founder que o próprio #2159 existe para evitar — o erro é na direção cara.

## Como fechou, e o que provou

Trava aberta com decisão do founder; probe `request_id` **69358** voltou:

```json
{"ok":true,"probe":true,"versao":"v1.1-pedidos-do-mes-keyset",
 "edge":"carteira-positivacao-snapshot","fonte":"be7d1152c411dfac3eec32dedcbb63e146086e2245bfd2462fac6437f89c175d"}
```

Os quatro campos: `probe:true` (bundle honrou ⇒ não é pré-sensor) · `versao` e `fonte` batendo a
`origin/main` — e é o **`fonte`** que prova que o `_shared/mapas-paginados.ts` subiu junto, o que
importa porque nesta edge o commit tocou **só o `versao.ts`**: o comportamento inteiro veio do
`_shared/`, então o `--name-status` sozinho descreveria a fatia errada. E a **ausência** dos campos
`mes`/`total`/`upserted` do fluxo real prova que a escrita não aconteceu. Deploy **redundante** —
pedi-lo teria gasto crédito do Lovable à toa.

## Método — dois aprendizados de processo

- **A afirmação apodreceu em minutos, não em meses.** O #2159 mergeou às 03:13Z e foi falsificado
  logo depois, lendo o código em vez de renarrar o resumo. Prosa sobre custo é a que mais convida à
  narração: ninguém a executa. O eval do #2159 afere os fatos do código (1 escrita, `onConflict`,
  zero `fetch`) e por isso **não pegava** este erro — ele vivia na frase, não no código medido.
- **A busca por TÍTULO de PR salvou uma duplicata — desta vez.** O CLAUDE.md avisa que busca por
  título é **cega** ao artefato já mergeado; a recíproca é que ela **funciona** enquanto o PR está
  aberto. Aqui ela achou o #2159 antes de eu escrever o mesmo doc. As duas buscas são
  complementares: título para o que está em voo, `git grep` em `origin/main` para o que já entrou.
