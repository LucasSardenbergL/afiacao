# "A transação voltou atrás" era uma frase, não uma observação — o veredito 4 sobre uma conexão que caiu

> 2026-09-18 · `scripts/db-aplicar.sh` (etapa 6), `db/test-db-aplicar.sh`, `db/nucleo-ci.txt`.
> Money-path: este script é o canal de ESCRITA em produção. O que ele diz depois de falhar decide
> se um humano reaplica uma migration que talvez já tenha sido aplicada.

## O que ele afirmava sem ter visto

`db-aplicar.sh` grava uma **tentativa** no ledger FORA da transação, roda o apply (`psql -f`, com o
recibo `aplicada` gravado DENTRO da mesma transação) e então julga. O julgamento separava duas
classes que não podem se misturar:

- **exit 4** — "APPLY FALHOU e a transação voltou atrás (nada aplicado pela metade)". Convite
  explícito a corrigir o arquivo e reaplicar.
- **exit 5** — "RESULTADO DESCONHECIDO. NÃO reaplique por reflexo."

A regra que separava as duas era uma regex só:

```bash
ERRO="$(grep -iE '^(psql:)?.*(ERRO|ERROR|FATAL|PANIC)' "$APPLY_OUT" | head -3 | ...)"
if [ "$RC" -ne 0 ] && [ -n "$ERRO" ]; then ... exit 4
```

Com `-i`, `ERRO` casa `erro` e `ERROR` casa `error`. E `error:`/`erro:` em minúscula é justamente o
que o **cliente** psql escreve quando a conexão morre. Então: conexão cai no meio do apply → rc≠0,
regex casa → o script anuncia que a transação voltou atrás. **Ele nunca observou isso.** A conexão
morreu depois de a tentativa estar gravada; o COMMIT pode ter chegado ao servidor com só a resposta
se perdendo. Se a reconciliação pelo ledger também não responder (rede fora), não sobra testemunha
nenhuma — e mesmo assim saía o 4.

O ledger limita o dano (o recibo vai na mesma transação, e o índice único parcial
`db_aplicacoes_sha_aplicada_uniq` barra um segundo recibo). Quem não estava protegido era o humano
que lê a mensagem: ela mandava reaplicar.

## Medido, não deduzido (PG 17.10, `psql -f`, 2026-09-18)

| entrada | rc | o que sai |
|---|---|---|
| erro SQL (`SELECT 1/0`) com ON_ERROR_STOP | 3 | `psql:<arq>:<n>: ERROR:  division by zero` — e **só isso**: nenhuma linha de cliente |
| `pg_terminate_backend` durante o apply | 2 | `FATAL:  terminating connection…` (servidor) + `server closed the connection…` + `error: connection to server was lost` (cliente) |
| `pg_ctl stop -m immediate` durante o apply | 2 | `WARNING:`/`AVISO:  terminating connection due to immediate shutdown` (servidor) + as duas do cliente |

Servidor em pt_BR traduz a severidade (`ERRO:`, `AVISO:`); o cliente em pt_BR traduz o que ele mesmo
gera (`erro: a conexão com o servidor foi perdida`). É a mesma separação do
[#2488](falsificacao-db-aplicar-idioma-do-servidor.md): **a palavra em CAIXA vem do servidor.**

Daí a regra nova, e o que ela custa em cada direção:

- **exit 4 exige evidência POSITIVA de aborto vinda do servidor** — `^psql:<arq>:<linha>: (ERRO|ERROR):`,
  ancorada no prefixo e **sem `-i`**: a caixa é o que separa o servidor do cliente.
- **`FATAL` e `PANIC` saíram do ramo 4.** São a conexão sendo derrubada, não um comando respondido
  com erro. Antes eram tratados como prova de rollback limpo.
- **Não há veto redundante de "conexão perdida" na condição do 4.** Um `ERROR:` respondido pelo
  servidor prova o aborto mesmo que a conexão caia logo depois: com ON_ERROR_STOP o psql para ali e
  o COMMIT nunca chega a ser enviado. Pôr o veto seria uma camada inalcançável — e camada
  inalcançável é defeito a registrar, não segurança a mais.

## A reconciliação não fecha a corrida

Já existia: se o ledger disser `aplicada`, o COMMIT chegou → exit 0. O que **não** foi promovido a
conclusivo é o contrário. Ler `tentativa` depois de uma queda não prova que não commitou: o backend
pode estar processando o COMMIT naquele instante, e a linha vira `aplicada` segundos depois. Uma
leitura de um instante não fecha uma corrida. Por isso, com conexão perdida, só `aplicada` decide;
todo o resto é 5.

Efeito colateral aceito de propósito: onde antes ficava `falhou` (que libera o re-apply), agora fica
`desconhecido` — e a etapa 3 **barra** o re-apply desses bytes até um humano resolver à mão. É mais
caro e é o lado certo do erro.

## A prova, por execução

Reproduzir exigia entrar na janela: a tentativa **já gravada** e o apply **dentro do corpo**.
Conexão recusada desde o início para na sonda (exit 6) e não exercita veredito nenhum. A fixture
`db/fixtures/db-aplicar-lento.sql` abre a janela (`pg_sleep` + o sentinela `APPLY_LENTO`), o
executor roda em background e a prova derruba a conexão quando vê o backend no corpo —
`pg_stat_activity`, resposta POSITIVA, com teto e ramo que diz "não consegui" (laço de espera sem
desistência é fail-OPEN).

- **A13** — `pg_terminate_backend`: o cluster segue no ar e a reconciliação **responde** `tentativa`.
- **A14** — `pg_ctl -m immediate stop`: a reconciliação fica **muda**, como no relato original.

Antes da correção, as duas saíam **4** dizendo "voltou atrás". Depois, saem **5** com nome próprio.
A prova casa a MARCA, não só o número: `CONEXAO PERDIDA` tem de estar lá e `APPLY FALHOU` não pode
estar — é a frase, não o exit, que manda o operador reaplicar.

Duas sabotagens novas no `--falsificar` (13 no total), uma camada por vez, nas três combinações
servidor×cliente:

- **S12** — religa o `-i` na regex do veredito. **Um caractere**, e o defeito volta inteiro: o
  `error:` do cliente passa por severidade do servidor e a queda vira 4.
- **S13** — desliga a detecção da queda. **O rc não muda** (segue 5): o dente está na marca. Sem
  ela, a mensagem vira a genérica de "sem marcador" e some a única instrução que serve aqui — ler
  o ledger para saber se o COMMIT chegou. Sabotagem cujo vermelho o rc sozinho não pegaria.

Nenhuma das duas é alcançada pelas fixtures de erro do banco: só a queda no meio do apply as
exercita. S10/S11 (a regex por idioma) foram reescritas junto — a alternância mudou de forma, e o
`prepara_sabotagem` teria reprovado por padrão inerte, que é o mecanismo funcionando.

## O que a própria prova pegou enquanto era escrita

Três erros meus, todos por execução e nenhum por leitura:

1. **`set -e` comia o rc do background.** `( aplicar … ; echo $? > arq ) &` morre no exit≠0 do
   executor e o arquivo nunca é escrito — o rc real virava "TRAVOU" e a prova mediria o próprio
   harness. Virou `|| r=$?`, como no `rc_de`.
2. **"Erro de cliente" não é "conexão perdida".** A primeira versão tratava qualquer `error:`
   minúsculo como queda. A sabotagem **S2** (que remove o `ON_ERROR_STOP` e deixa o corpo começando
   numa barra solta) produz `psql:…: error: invalid command \` com **rc=0** — e o script passou a
   anunciar "CONEXAO PERDIDA (rc=0)". Fabricação nova no lugar da antiga, pega pela suíte que já
   existia. A detecção passou a ser o **rc 2** (EXIT_BADCONN, independente de idioma) mais os
   trechos ASCII da mensagem de queda nos dois idiomas.
3. **A marca do servidor não sobrevivia ao recorte.** O executor mostra `tail -c 900` do log do
   apply, e num erro dentro do `EXECUTE` o servidor **ecoa o corpo inteiro** antes: o `FATAL:` caía
   fora. A marca passou a ser a linha de contexto (`PL/pgSQL function aplicar_sql` / em pt_BR
   `PL/pgSQL aplicar_sql`), que vem depois do eco — e que continua distinguindo as três
   combinações, inclusive a mista `c_pt`.

## Fora desta entrega (medido, não consertado)

- **O `|| msg` que engole a falha do UPDATE do ledger.** Quando o banco está fora (A14), a cicatriz
  não é gravada e a tentativa fica ABERTA; o script avisa e segue. Não é o defeito de veredito, e
  `tentativa` é seguro por construção (se o COMMIT tivesse chegado, o recibo da mesma transação
  estaria `aplicada` e a etapa 3 barraria por lá). Fica registrado como escolha, não como descuido.
- **A âncora `[^:]*` supõe caminho de log sem `:`.** Nenhum `TMPDIR` real tem, e o engano cai no
  lado seguro: sem casar, o veredito é 5.

## As regras

- **Erro de cliente não é evidência sobre a transação.** Quem pode afirmar aborto é quem processou
  o comando. `error:`/`erro:` em minúscula, `server closed the connection`, rc 2 — tudo isso é o
  cliente dizendo que parou de enxergar, não que nada aconteceu.
- **`-i` numa regex de VEREDITO apaga a distinção que a caixa carrega.** Aqui, a caixa era
  literalmente a diferença entre servidor e cliente.
- **Camada que nenhum cenário alcança é defeito, não defesa.** Se sabotá-la não deixa nada
  vermelho, ela é redundante — remova ou dê a ela um cenário próprio.
- **Sabotagem cujo dente está na MARCA, e não no rc, é a que o exit code sozinho não pegaria.**
  Uma suíte que só case número aprova a perda da instrução que o humano vai ler.
