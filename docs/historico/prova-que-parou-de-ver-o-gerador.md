# A prova que parou de ver o gerador — destravar mudando ONDE o alvo é produzido apaga a prova

**2026-09-09.** `db/test-canaria-veredito.sh` é a única prova EXECUTADA da ordem dos ramos do CASE
que separa **BUNDLE VELHO SERVINDO** (⇒ redeployar) de **CANÁRIA VERMELHA** (⇒ investigar
regressão) — dois desfechos opostos em money-path. Ela não confere um SQL commitado: **gera** o SQL
pelo gerador do repo, e é isso que a faz envelhecer junto com ele em vez de virar retrato.

Às 00:18Z ela entrou em `db/nucleo-ci.txt` (#2403). Às 00:31Z o primeiro PR reprovou, e todos os
seguintes: a prova chamava a CLI, a CLI tem guard de sincronia fail-closed contra `origin/main`, e
num PR a "fatia da verdade" diverge **por construção** — `sonda:bump` obriga a bumpar o `versao.ts`
da edge alterada e `sonda:fingerprint` obriga a regravar `_shared/sonda-fingerprints.ts`. Três gates
mutuamente impossíveis (#2414). Reproduzido nos dois eixos, isoladamente: bumpar só o `versao.ts` de
uma das 4 edges amostradas ⇒ exit 1; regravar só o mapa ⇒ exit 1 — e como o mapa entrava na fatia
sempre, o segundo eixo atingia **qualquer** PR que tocasse **qualquer** edge instrumentada.

## A lição

O destravamento (#2405) manteve a CLI e trocou **onde ela roda**: um worktree de `origin/main`, onde
a premissa do guard vale por construção. O CI ficou verde e o raciocínio parecia fechado — "o que a
suíte julga é a LÓGICA do SQL, e a main serve tão bem quanto o disco".

Não serve. **Medido em 2026-09-09**, com o gerador do disco sabotado no ramo que dá nome à canária
vermelha (`WHEN ca.corpo ->> 'ok' = 'false'` → `WHEN false`), a suíte saiu **19 ok / 0 fail**. Ela
passou a julgar o gerador da `main` — ou seja, no CI do PR ela era uma cópia do CI da main, e
**nenhuma mudança do PR podia reprová-la**. Verde por CEGUEIRA, exatamente na classe de PR que ela
existe para pegar. O gate não morreu reprovando à toa; morreu **passando**.

> Um teste que gera o próprio alvo tem dois insumos: o gerador e o estado que ele lê. Mover o
> alvo para outro estado para satisfazer um guard move o GERADOR junto — e o que sobra é uma prova
> sobre código que o PR não pode alterar. Quando destravar for "gerar de outro lugar", pergunte o
> que ainda pode ficar vermelho por causa deste PR.

A main não denuncia isso: lá o working tree **é** `origin/main`, então a fatia bate por construção e
o guard passa. O bloqueio (e depois a cegueira) só existiam no PR. **CI de main verde não é sinal
sobre o CI de PR.**

## O que ficou

A prova volta a gerar pelo gerador **deste disco**, por um caminho que não emite SQL operacional:
`db/lib/gerar-canaria-fixture.ts` chama `gerarSqlDasCanarias` direto — a função pura, que no `main()`
já roda antes do guard. O guard segue **intocado** na CLI, e suas cinco recusas continuam provadas
onde já estavam: `scripts/sonda-versao-sql.test.ts` exige, por porta, código 1 **e stdout de zero
bytes** (parecer Codex: "divergência relevante implica falha e zero bytes emitidos" — a localização
textual de `conferirSincronia()` não deve ser o contrato).

O artefato de fixture não pode virar porta operacional por descuido. Um `RAISE EXCEPTION` no topo
**não** basta — `psql -f` sem `ON_ERROR_STOP` (o default) segue para os comandos seguintes depois do
erro, e o disparo sairia igual. Então o SQL inteiro vira o **valor de uma variável `text`** dentro de
um único `DO`: declarar não executa, não há comando seguinte, e apagar o `RAISE` deixa o conteúdo
inerte do mesmo jeito. Medido nas duas pontas, com armadilha armada (`net.http_post` que REGISTRA em
vez de sair na rede, `vault.decrypted_secrets` de mentira): o arquivo aborta com a marca do `RAISE`,
e a sentinela fica vazia mesmo sem `ON_ERROR_STOP`. Sentinela vazia com armadilha armada é evidência
positiva; sem a armadilha seria "não disparou porque este banco é pobre".

E o eixo que estava cego ganhou sensor: `--falsificar` agora sabota o **GERADOR** (num worktree
descartável do HEAD, nunca no disco da sessão — ver #2410) e exige vermelho, com controle verde do
mesmo caminho na mesma invocação. A primeira dessas sabotagens é literalmente a que o #2405
aprovava. Se a prova voltar a julgar um retrato, essa linha fica verde e o `--falsificar` reprova.

**Ver também:** [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (o controle
verde na mesma invocação), [fase-sem-sinal.md](fase-sem-sinal.md) (ausência de sinal ≠ aprovação),
[gates-textuais-cegos.md](gates-textuais-cegos.md) (verde por cegueira do medidor).
