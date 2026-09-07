# Job que roda e não fala — o vermelho que só existe para quem abre o run

**2026-09-07.** O `mutation-check` ficou vermelho na `main` por ~10h (#2279 → #2289) e o founder
só soube porque **abriu um run**. O job rodava a cada push na main desde sempre; o que faltava
não era execução, era **canal**. Os dois steps de alerta do repo viviam no `validate`, e ninguém
tinha reparado que o `mutation-check` era o único job da main sem nenhum.

A armadilha é que "o job roda" *parece* cobertura. Roda, mede, e produz um veredito correto — que
morre no log. **Execução sem canal é ausência de dado para quem decide**, exatamente como o
`grep` sem ocorrência e o processo enfileirado da §armadilhas do CLAUDE.md.

## O que o episódio custou, e por quê

O vermelho eram **3 mutações INVÁLIDAS e ZERO divergências**. Custou horas de sessão para ser
lido — não por ser difícil, mas porque o sumário fundia numa linha só duas causas de **remédios
opostos**:

| causa | o que significa | remédio |
|---|---|---|
| `DIVERGE` | a suíte **perdeu poder** — mutação que era pega passou a sobreviver | devolver o dente ao teste; **nunca** afrouxar o `.mut` |
| `INVÁLIDA` | o `.mut` **envelheceu junto com o fonte** (padrão não casa, ou casa >1 linha) | corrigir o **padrão**; é manutenção, não regressão |
| baseline `✗` | o **monitor** não conseguiu medir (harness/bun ausente) | nada se conclui sobre cobertura |

Um alarme que não as separa manda o leitor para o remédio errado — o precedente dos 4 vazios no
mesmo pixel ([fase-sem-sinal.md](fase-sem-sinal.md) §2). E o `.mut` stale é **ruído esperado** num
repo multi-sessão: é justamente por isso que o job não é required. Tratá-lo com a urgência de uma
regressão de cobertura ensina a ignorar os dois.

## O que NÃO se mexeu, de propósito

- **Quando o job roda.** Ele já rodava em push na main. Segue fora do `schedule` pelo motivo que o
  próprio comentário do job dá: não-required, pode ficar INVÁLIDO por refactor legítimo, e
  ~2m41s/dia sem leitor. Sensor não é sinônimo de rodar mais vezes.
- **O veredito do job.** Aqui o objeto medido é o **próprio commit** — job vermelho é
  semanticamente certo, e o modelo é o `validate`. O `authz-sentinela` fica verde porque mede um
  sistema **externo**, onde "o monitor funcionou" e "produção está limpa" são fatos diferentes.
  Copiar o padrão errado teria apagado o sinal que o autor do PR usa.

## Canal próprio, sempre

Label `mutcheck-cobertura`, não a `ci-main-red`: o corpo daquela afirma "provável reversão por
commit direto do Lovable" — diagnóstico **errado** aqui, que mandaria o founder ao `deploy.md`
procurar um incidente inexistente. Mesma razão que separou a `authz-prod`. **Sensor que significa
duas coisas é um sensor que não se sabe ler.**

E ausência de resumo não vira silêncio: se o step morre antes de escrever o JSON, o corpo diz
isso, em vez de afirmar zero problema (`ausente != zero`).

## Como isto se prova

[test-mutcheck-sensor.sh](../../scripts/test-mutcheck-sensor.sh) mede os quatro estados contra
contratos de **fixture** (via `MUTCHECK_DIR`, que existe para isso: sensor caro de exercitar não
é exercitado) e **executa o script do alerta extraído do próprio `ci.yml`** — um teste que
reimplementasse o alerta provaria o teste, não o alerta. O **caso verde vem primeiro e aborta o
resto** se falhar ([guard-novo-sem-caso-verde.md](guard-novo-sem-caso-verde.md)).

Falsificação: 9 sabotagens — uma por peça, incluindo "os dois remédios sempre juntos" e "o fecho
não fecha" — todas vermelhas, com controle verde na mesma invocação e contra-prova inerte verde.

> ⚠️ **Duas sabotagens nasceram falso-VERDES** e o motivo vale mais que o conserto:
> `state: 'closed'` e `if (open.data.length > 0)` aparecem **3× e 2×** no `ci.yml`, e o
> `perl -0pe s///` sem `/g` casa a **primeira** — a do `ci-main-red`, num step que este teste
> corretamente não cobre. A falsificação estava medindo o job errado e chamando isso de buraco.
> **Num arquivo com steps irmãos, a âncora precisa conter algo único do step alvo** (aqui, o
> emoji do título e a frase do comentário de fecho); e vale conferir o **número da linha**
> atingida, não só que "alguma coisa mudou".
