# O Cenário B: a pendência de disparo, e por que ela não é um mutex

> **A classe (2026-09-06):** quando o efeito externo acontece FORA do banco — uma chamada HTTP entre
> dois round-trips PostgREST — nenhum lock atravessa a janela. O que atravessa é uma **marca durável
> na linha**, escrita antes do efeito e removida só pelo desfecho que o registra. Mas a marca só
> funciona se ela for uma **pendência da LINHA**, não um mutex de execução: no instante em que uma
> tentativa que falhou pode apagar a marca de outra que ainda pode comprar, o buraco volta inteiro.
>
> E o corolário de entrega: **o predicado no `WHERE` protege quem passa pela função; um trigger
> protege a linha.** Quando duas entregas paralelas disputam o corpo da mesma função, mover o guard
> para o trigger não é desvio de conflito — é a versão mais forte do mesmo guard.

Fecha o `[P1]` deixado explícito em [guard-fora-da-escrita-nao-e-guard.md](guard-fora-da-escrita-nao-e-guard.md),
que fechou o Cenário A (o cancelamento gravando por cima de um disparo já commitado) e nomeou o B
como pendência de desenho.

## O que estava errado

`disparar-pedidos-aprovados` seleciona a linha (`status='aprovado_aguardando_disparo'`), passa por
validações, chama `IncluirPedCompra` no Omie — **pedido de compra REAL, dinheiro** — e só então
grava o desfecho. Leitura e escrita são round-trips PostgREST **separados**, com segundos de HTTP no
meio. Nessa janela, `cancelar_pedido_sugerido` commita `cancelado_humano` e a edge grava por cima:
**o operador vê "rejeitado" e a compra aconteceu.**

`SELECT … FOR UPDATE` é inexequível aqui: cada round-trip é a sua própria transação e o row lock não
sobrevive a ela. Lock só serializa dentro de UMA instrução, e nenhuma delas pode conter a chamada ao
Omie.

## O fix

Uma coluna dedicada, `disparo_claim_em` (+ `disparo_claim_por`, diagnóstico), e duas metades que só
valem juntas:

1. **A edge reivindica** (`reposicao_claim_disparo`, uma instrução, allowlist de status DENTRO do
   `WHERE` que grava) **imediatamente antes** de `IncluirPedCompra`. Se o cancelamento já commitou,
   o claim pega zero linhas e **nenhuma chamada ao Omie acontece**.
2. **Um trigger `BEFORE UPDATE`** veta a transição `→ cancelad%` enquanto a pendência existe.

Nada em `status` muda — então nada que lê `status` (rótulos, KPIs, health checks, varreduras de
retry e de expiração) precisa saber que isto existe. Era esse o raio que um status novo em voo
(`disparando`) teria arrastado.

## As três correções do Codex que mudaram o desenho

O primeiro rascunho tinha o guard no `WHERE` da RPC e o `catch` da edge limpando o claim. O parecer
(gpt-6-astra · max) derrubou os dois:

**1. Falha NUNCA pode limpar a pendência.** Com dois runs:

```
A: claim commita; pausa antes do HTTP.
B: claim commita; o Omie rejeita B definitivamente.
B: catch grava falha_envio + claim=NULL; commita.
C: cancelar_pedido_sugerido aceita e commita.
A: chama IncluirPedCompra; cria o PO real.
```

A idempotência do `cCodIntPed` não salva: **A está criando o primeiro PO**. A rejeição de B prova
algo sobre B, não sobre A. Hoje só o desfecho REGISTRADO (`disparado`/`disparado_simulado`) limpa, na
mesma instrução que grava o status — e aí quem veta o cancelamento passa a ser o próprio `status`.
Isso resolve junto o caso de um só run: timeout, resposta perdida e duplicata não confirmada são
**resultados incertos**, e liberar a marca neles recria a corrida.

**2. O claim é idempotente, com `COALESCE(disparo_claim_em, NOW())`.** Ele *não* exige
`disparo_claim_em IS NULL`: exigir transformaria uma pendência presa (edge morta entre a chamada e a
gravação) em pedido travado para sempre e mataria a recuperação automática que já funciona — o run
seguinte re-dispara, o Omie recusa por duplicata e a edge reconcilia. E o `COALESCE` preserva o
**início** da pendência: sobrescrever o carimbo a cada tentativa faria uma pendência de ontem
aparecer eternamente "de agora" para quem investiga.

**3. Zero linhas não é erro SQL.** A gravação final ignorava o `{error}` e devolvia
`status_final: "disparado"` mesmo quando falhava. Verificar o erro não basta: um `UPDATE` que não
casa a linha volta `error: null`. Agora ela pede `.select("id")`, exige a linha **persistida**,
relê antes de afirmar qualquer coisa (a resposta pode ter se perdido depois do commit) e — em caso
de dúvida — devolve `disparado_sem_registro` em vez de mentir, sem lançar: lançar cairia no `catch`
e gravaria `falha_envio` por cima de uma compra que existe.

Junto vieram três achados menores, todos aplicados: a escrita de `falha_envio` (no `catch` e no gate
de mínimo de faturamento) ganhou allowlist de status, para não levar `cancelado_humano → falha_envio`;
e o resumo por e-mail e o `sync_reprocess_log` passaram a contar sucesso por **allowlist**, porque
"tudo que não é `falha_envio`" fazia qualquer `status_final` novo entrar calado na coluna de
disparados.

## Por que o guard virou trigger

`bun run wt:preflight` acusou 🔴: outra worktree, em voo e sem commitar, recria
`cancelar_pedido_sugerido` para fechar a corrida do **portal Sayerlack**. Como o apply é manual no
SQL Editor, "a última a rodar vence" apagaria em silêncio um dos dois guards de money-path.

A saída foi medir, não deduzir. Em PG17 descartável, com barreira observada (`pg_blocking_pids`):
com A segurando `UPDATE … SET disparo_claim_em = now()` e B executando
`UPDATE … SET status='cancelado_humano' WHERE id=… AND status NOT IN (…)`, **B bloqueia, espera o
COMMIT de A e o trigger aborta lendo `OLD.disparo_claim_em` = o valor recém-commitado.** Em READ
COMMITTED o EvalPlanQual re-busca a linha, e o `BEFORE ROW` roda sobre a versão nova — a mesma
mecânica que faz o predicado-no-`WHERE` funcionar.

O trigger é **estritamente mais forte**: vale para o `UPDATE` cru do PostgREST, para
`remover_itens_pedido_sugerido` e para qualquer caminho que ainda não existe. A única coisa que o
predicado-no-`WHERE` teria a mais, confirmada no 2º parecer, é continuar filtrando quando alguém
desabilita o trigger ou roda com `session_replication_role=replica`.

**O veto não tem porta**, e isso também é decisão do parecer. A GUC `app.correcao_cancelamento_pos_disparo`
significa "conciliei e sei o desfecho"; com uma pendência ABERTA ninguém sabe — uma execução em voo
pode comprar depois da conciliação. A saída é encerrar a pendência numa instrução **anterior**, e o
Postgres força essa ordem sozinho: limpar o claim e cancelar na mesma instrução continua barrado,
porque o trigger lê `OLD`.

## O detector, e o que ele não vê

Como a marca só é limpa pelo desfecho registrado, `disparo_claim_em IS NOT NULL` ⇔ **disparo em voo
(segundos) ou a edge morreu no meio**. Isso dá o detector sem sensor novo e sem front:

```sql
SELECT id, status, disparo_claim_em, disparo_claim_por,
       now() - disparo_claim_em AS pendente_ha, omie_pedido_compra_id, status_envio_portal
  FROM public.pedido_compra_sugerido
 WHERE disparo_claim_em IS NOT NULL
 ORDER BY disparo_claim_em, id;
```

Sem filtrar por status nem por identificador nulo — as combinações inconsistentes são exatamente as
que se esconderiam. **Idade serve para investigar, nunca para liberar.** Ela não enxerga: efeito no
portal Sayerlack anterior ao claim, execução anterior ao deploy da edge nova, e órfão histórico
nascido com as colunas nulas.

## A prova

`db/test-claim-disparo-cenario-b.sh` — PG17 descartável, **70 asserts, exit 0**, três execuções em
`lc_messages=C` e três em `pt_BR.UTF-8` (o harness imprime o controle do próprio eixo: `division by
zero` vira `divisão por zero`).

- **S1 (baseline vermelho)** roda a SEQUÊNCIA da edge como ela é — round-trips separados, com a
  chamada ao Omie no meio — sobre o sistema de HOJE: seleciona, o cancelamento commita, e a gravação
  final incondicional passa por cima. O baseline é a RPC do Cenário A **já corrigida**, não o corpo
  pré-A: misturar dois defeitos não prova o segundo.
- **S2** repete a ordem com o fix e o assert que carrega o peso é o **zero** da testemunha do Omie —
  nenhuma compra foi criada. A testemunha mora numa tabela escrita em transação PRÓPRIA, para
  sobreviver à recusa da gravação local; senão "o PO existe" seria afirmado pela mesma transação que
  se quer avaliar.
- **R1/R2** são a corrida real em duas conexões com bloqueio **observado** (`pg_blocking_pids`), e
  **F6** falsifica a própria barreira: com A travando outra linha, ela tem de dizer `nao`.
- **D1** é o contraexemplo do Codex virado em teste: dois runs reivindicam, o desfecho de falha de um
  **não** limpa a pendência, e o cancelamento continua recusado enquanto o outro pode comprar.
- **C8** prova que a porta de correção pós-disparo **não** libera pendência de disparo.
- **F1–F5** sabotam uma camada por vez (o trigger inteiro; o prefixo `cancelad%`; a allowlist do
  claim; o `COALESCE`; a postcondição nos dois lados) e **F4b** é o controle na MESMA sabotagem: com
  o prefixo trocado por lista fechada, o veto ainda dispara para `cancelado` puro — a sabotagem foi
  cirúrgica, não desligou o trigger inteiro.
- **Z1** é o canário do restore: depois de todas as sabotagens, o corpo real está de volta.

Dois defeitos que o próprio harness pegou e que valem registro. A sonda de execução da postcondição
inseria uma linha **sem id**, dependendo da sequence — o que quebra num banco cuja sequence está
atrás do máximo (`RESTART IDENTITY` + ids explícitos). Agora ela usa um id **explícito e negativo**,
abaixo do mínimo atual: `nextval` nunca produz negativo, então ele não colide com linha existente nem
com INSERT concorrente. E tudo roda dentro do bloco `EXCEPTION`, que é um savepoint — quando o
trigger aborta, o INSERT é revertido junto, inclusive o evento que o trigger de outbox teria gravado.
O segundo: o `corrida()` fazia `tail -1` da saída do psql, e a exceção do trigger tem várias linhas
(ERROR + CONTEXT) — o assert falhava com o comportamento CERTO.

## Pendências (ditas para não serem lidas como fechadas)

- ~~**`disparado_simulado` continua cancelável.**~~ **FECHADO** pelo [#2309](https://github.com/LucasSardenbergL/afiacao/pull/2309)
  (`20260907095841`), já aplicado na prod: o estado virou PÓS-disparo, com saída pela porta
  `corrigir_cancelamento_pos_disparo`. A prova desta entrega passou a aplicar a cadeia inteira e
  ganhou quatro asserts de **convivência** (C3b–C3e) mais a falsificação F1b/F1c — porque dois
  triggers `BEFORE UPDATE` na mesma tabela é exatamente onde um guard novo cala o guard do vizinho
  sem ninguém perceber. Aqui o meu roda por último e tem precedência quando há disparo em voo: a
  porta serve para conciliar o que **já** aconteceu, e conciliar não prova que a execução em voo
  não vai comprar depois.
- **O portal Sayerlack fica fora.** A formulação honesta, do próprio parecer: *esta fatia arbitra
  cancelamento versus novas submissões ao Omie pelas execuções atualizadas; ela não impede envio ao
  portal, nem desfaz ou concilia pedidos já recebidos pelo fornecedor.* Um cancelamento pode vencer
  entre a seleção e o envio ao portal, e o detector de pendência de disparo não encontra isso. É a
  fatia da outra worktree (`20260906170000`).
- **A garantia começa depois da adoção.** Migration aplicada não basta: enquanto a edge velha estiver
  servindo, ninguém escreve `disparo_claim_em` e o veto é vacuamente verdadeiro. A ordem é migration
  **primeiro** (aditiva e inofensiva sozinha), deploy da edge **depois** — e a edge nova é
  **fail-closed**: sem conseguir reivindicar, ela não compra, então a ordem inversa pararia os
  disparos em vez de deixá-los desprotegidos.

## Nota de método: o primeiro vermelho não é o bloqueante

Com o PR aberto, o `validate` reprovou no step **Authz carimbo de prod**. Li a saída de cima para
baixo, encontrei `❌ AUSENTE_EM_PROD: public.reposicao_selar_pedido` (função de OUTRO PR, mergeado e
ainda não colado no SQL Editor), e concluí que a fila inteira estava travada esperando o founder.
Errado — e caro: parei uma entrega pronta por um dia inteiro atrás de uma ação que não era
necessária.

O step tem comentário explícito no `ci.yml` dizendo o contrário: ele *"cobra só os eixos que um PR
CONSEGUE consertar — contrato ou auditor mudou sem re-medir"*, e **idade e achado vivo em prod NÃO
entram**, justamente para não travar ~30 worktrees por algo que só o founder conserta. O bloqueante
real estava na PRIMEIRA linha, e era meu:

```
❌ [CARIMBO_CONTRATO_MUDOU] `funcoes`: o CONTRATO mudou desde a medição — prod nunca foi
   verificado contra ele. Rode `bun run authz:carimbo:gravar` e commite o carimbo.
```

Eu havia adicionado `reposicao_claim_disparo` ao manifest sem re-medir. Um `authz:carimbo:gravar`
resolveu; os `⚠️ [CARIMBO_ACHADO]` que eu tinha lido como causa são informativos por desenho
(`bloqueiaPR: false`) e continuam lá, verdes, hoje.

**A regra:** num gate que emite achados de várias severidades, o veredito é do eixo **BLOQUEANTE**,
não do primeiro `❌` na tela. Antes de atribuir a reprovação a terceiros — e principalmente antes de
pedir ação ao founder — case o achado com o eixo que o gate declara bloquear. `❌` é sinal de
atenção; quem decide o exit é `bloqueiaPR`. Ler a saída na ordem em que ela imprime é ler pela
diagramação, não pela semântica.
