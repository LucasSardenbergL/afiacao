# O censo que parte de um LITERAL — e desliga inteiro quando o literal envelhece

**2026-09-08.** `scripts/lib/exclusividade.ts` define `JOB_RAIZ = 'validate'` e `jobsBloqueantes(ci)`
devolve o fecho transitivo a partir dele. O nome é um literal, e ninguém conferia que ele ainda
existe no `ci.yml`. Renomeie o job — ou mude o required check de nome — e a cascata inteira desliga
**sem uma linha vermelha**:

```
fecho VAZIO → gatesCandidatos() marca TODOS com bloqueiaPR: false
            → avaliar(), que faz gates.filter(g => g.bloqueiaPR), não cobra NINGUÉM
            → bloqueantesOpacos() não lista nada
            → `bun run exclusividade` sai 0, verde, dizendo "0 gate(s) bloqueante(s)"
```

Zero lido como cobertura total. É a mesma família do guard de **denominador** que o próprio job
`validate` já tem (`li $total job(s), esperava $esperados — o agregador não pode afirmar nada`) e da
guarda anti-vácuo do gate de índice (#2378): **`ausente ≠ zero`, aplicado ao censo**. Achado por
inspeção, antes de custar — mas o custo, se tivesse acontecido, seria a máquina inteira aprovando
todo gate por ausência de dado enquanto imprimia um número que lê como cobertura.

## A regra

> **Todo censo que parte de um literal de configuração externa precisa provar que o literal ainda
> existe.** A função pura pode — e deve — devolver vazio honesto: vazio é como se diz "não encontrei
> o required check aqui". Quem converte vazio em VERMELHO é o gate, e a mensagem dele nunca pode ser
> "nenhum gate bloqueia": é "o required check não foi encontrado".

Os dois eixos são separados de propósito. Hoje `fecho vazio` ⇔ `raiz ausente`, mas quem decide isso
é a implementação de `jobsBloqueantes`; se ela mudar de forma e passar a esvaziar por outro caminho,
o efeito para o gate é idêntico — logo a asserção é sobre o **efeito**, não sobre a causa de hoje.

## Cruzar duas fontes: o que isso compra, e o que NÃO promete

A verdade sobre qual check é required **não mora no repo** — mora na branch protection do GitHub
(`gh api repos/:owner/:repo/branches/main/protection --jq .required_status_checks.contexts`, que em
2026-09-08 devolveu exatamente `["validate"]`). Consultar isso no gate exigiria rede e um token com
`administration: read`, que o `GITHUB_TOKEN` do CI não tem — e gate barato que depende de rede vira
gate que degrada.

Então o cruzamento com o `auto-merge.yml` é de **concordância, não de derivação**: aquele arquivo
nomeia o check (hoje só em prosa, no cabeçalho — seu `run:` é `gh pr merge --auto`, que não nomeia
check nenhum), e o guard exige que as **três pontas** digam a mesma coisa: o literal do código, o job
do `ci.yml` e a citação do `auto-merge.yml`. Renomear passa a custar três edições coordenadas em vez
de uma silenciosa.

Ler **prosa** de propósito é a exceção que confirma a regra do stripper compartilhado
([gates-textuais-cegos.md](gates-textuais-cegos.md)): ali o comentário é ruído em volta da medição;
aqui ele é a única âncora textual que o repo tem para o nome. E o limite fica dito em voz alta no
código, porque guard que promete mais do que entrega é pior que guard nenhum:

> **Descoberto:** trocar o required check **só** na branch protection, sem tocar em arquivo nenhum,
> deixa este guard verde e mentiroso. Esse eixo só se prova com `gh api`, e é trabalho de humano.

## O vácuo análogo no `gates:frescura` — e por que só um dos sentidos tinha

Não é o mesmo eixo (aquele gate não usa `JOB_RAIZ`; varre todos os jobs), mas é o mesmo veneno: os
dois sentidos dele são cruzamentos de conjunto, e **cruzar com vazio aprova sempre**.

O sentido 2 (máquina→manual) se defende sozinho, por acidente feliz de desenho: inventário vazio faz
o censo inteiro virar `CENSO-OBSOLETO`, censo vazio faz todo gate virar `NAO-CITADO`. O sentido 1
(manual→máquina) **não**: `extrairCitacoes` devolvendo `[]` zera os órfãos e o gate ainda assina
"manual e maquina conferem nos dois sentidos" — afirmação sobre leitura que não houve. É plausível,
não hipotético: o CLAUDE.md é reescrito toda semana pela política de enxugar, e as citações são
reconhecidas por **forma** (crase + `bun run`).

O piso é **zero**, de propósito. Um mínimo maior (`≥ 10 citações`) pegaria também a regex que casa 2
de 16, mas vira baseline a manter — e baseline desatualizada é o defeito que originou aquele gate.
Zero não envelhece.

## A prova (falsificação por camada, controle verde na mesma invocação)

| camada sabotada | quem fica vermelho |
|---|---|
| `return 1` do guard comentado (**via morta**: o guard roda, imprime e não reprova) | **1** teste — só o do BINÁRIO |
| `conferirAncoraDaRaiz` vira no-op na lib | 5 testes puros |
| para de cruzar com o `auto-merge.yml` | 2 testes (o ramo "arquivo ausente" segue vivo, e é certo) |

A primeira linha é o motivo de o teste do binário existir: guard puro é guard que **pode nunca ter
sido ligado ao exit code**, e nenhum teste de função pura pega isso. Por isso o gate ganhou `--ci
<arq>` — a suíte roda o processo real contra um `ci.yml` sabotado e cobra o vermelho de verdade.

O discriminante é o **marcador** `ANCORA-DA-RAIZ-QUEBRADA`, não o exit 1 sozinho: uma REPROVA
legítima da matriz também sai 1, e casar só o número faria a sabotagem "passar" pelo motivo errado no
dia em que a matriz reprovasse — falsificação com linha de base podre
([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)).

No `gates:frescura`, as sabotagens **S8/S9** entraram no `scripts/test-gates-frescura.sh` (7→9),
verdes nos dois locales. Elas são diferentes das S6/S7 (fail-closed) num ponto que importa: ali a
fonte fica **ilegível**; aqui ela continua perfeitamente legível e apenas **vazia** — o caso em que o
gate imprime números honestos (`0 citacoes`) e mesmo assim assina embaixo.
