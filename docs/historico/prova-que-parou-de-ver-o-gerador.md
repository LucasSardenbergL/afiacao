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

## Segundo capítulo: voltou a ver o gerador, e continuava sem ver a CLI

**Ainda 2026-09-09.** O conserto acima devolveu a prova ao gerador deste disco — mas por um caminho
NOVO. A prova passou a julgar a **fixture** (`db/lib/gerar-canaria-fixture.ts`), enquanto produção
continua recebendo o SQL da **CLI**. Os dois terminam em `gerarSqlDeCanariasResolvidas`, então
coincidiam. Por construção, e só por construção: nada obrigava que continuassem coincidindo.

Medido, com a janela trocada de `janelaMin` para `19` só no ramo da CLI: ela seguiu saindo **0 com
os mesmos 9 546 bytes**, o SQL operacional passou de `interval '20 minutes'` para `'19 minutes'` — e
a prova executada continuou **21 ok / 0 fail**. A fixture saiu byte-a-byte IDÊNTICA. Com a CLI
quebrada de vez (janela 777: exit 1, **zero bytes**), a prova ficou verde igual. Ela não enxergava a
CLI de forma nenhuma — nem divergente, nem morta.

> Mover o alvo da prova para um artefato IRMÃO do que vai para produção não é o mesmo defeito de
> julgar outro estado, mas tem o mesmo desfecho: existe uma mudança que altera produção e não pode
> reprovar a prova. Quando dois caminhos "dão no mesmo", pergunte o que OBSERVA que dão.

## O que ficou (2)

Uma asserção de correspondência, `EQUIVALENCIA_CANARIA`: o artefato da fixture tem de ser
EXATAMENTE a moldura fixa envolvendo o que a CLI emitiu — sem `trim`, sem remover comentário, sem
ordenar, sem normalizar espaço. A comparação é contra o **stdout do executável** da fixture, o mesmo
comando que o `.sh` roda, e não contra o gerador chamado de dentro do teste: reconstruir o caminho
da fixture no teste deixaria de fora qualquer filtro na ENTRADA dela.

Compartilhar a função não bastaria (parecer Codex): *"identidade do ponto chamado não implica
identidade da saída — alguém ainda pode acrescentar `sql = transformar(sql)` depois da função
compartilhada, apenas na CLI"*. E igualdade textual **é** o contrato certo aqui — o erro seria usá-la
para concluir que o CASE está correto, o que continua dependendo do PG17.

As duas provas são assimétricas, e é isso que justifica manter as duas. Medido:

| Sabotagem | `EQUIVALENCIA_CANARIA` | prova do CASE (PG17) |
|---|---|---|
| nenhuma (controle) | verde | verde |
| default da janela 20→21 SÓ na CLI | **vermelha** | verde |
| ramo `ok:false` no gerador compartilhado | verde | **vermelha** |

A do meio está no `scripts/mutcheck.d/sonda-versao-sql.mut`, então roda no CI (falsificação que só
roda à mão é ausência de dado).

Dois defeitos vizinhos apareceram no caminho. A fixture **aceitava** leva com nome repetido que a
CLI recusa — medido: CLI exit 1 com zero bytes, fixture exit 0 com 10 180 bytes carregando a linha
duplicada no `VALUES`. A recusa vivia em `parsearArgs`, e a fixture é uma SEGUNDA fronteira que não
passa por lá; virou `recusarCanariasRepetidas`, chamada pelas duas. E nenhum teste rodava o `main()`
com o `gitReal`: trocar o executor por `r.stdout?.trim() ?? ''` passa nos três testes de `gitReal`
(o sha já é comparado com trim, e vazio continua vazio) e faz `git show` perder a quebra final —
um repo SINCRONIZADO passaria a ser recusado por divergência de bytes. Falso desses é o que faz
alguém afrouxar o guard para destravar o CI, que é a espiral do #2414.

**Ver também:** [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (o controle
verde na mesma invocação), [fase-sem-sinal.md](fase-sem-sinal.md) (ausência de sinal ≠ aprovação),
[gates-textuais-cegos.md](gates-textuais-cegos.md) (verde por cegueira do medidor).
