# O guard que decide sobre um retrato que o lock não protege

> **A classe (2026-09-05):** em plpgsql, um guard escrito como `SELECT … INTO` → `IF … THEN recusa`
> → `UPDATE … WHERE id` **não é um guard sob concorrência**. Ele decide sobre um retrato que
> nenhum lock protege: entre a leitura e a escrita a linha pode virar outra coisa, e o `UPDATE`
> por chave primária grava mesmo assim. O guard só vale quando o **predicado mora na mesma
> instrução que grava** — aí o Postgres, em READ COMMITTED, espera o lock da transação
> concorrente e **re-avalia o predicado contra a versão nova da linha** (EvalPlanQual), pulando-a
> se ela não se qualifica mais.
>
> O sintoma é sempre o mesmo e é caro: **duas transações que ambas "checaram" e ambas gravaram**.
> Aqui isso valia um pedido de compra REAL no Omie carimbado como `cancelado_humano`.
>
> E o corolário de teste: **um assert sequencial não distingue "tem guard" de "o guard é
> atômico"**. O corpo velho — com o `IF` e tudo — passa no teste sequencial e perde a corrida.
> Só um teste com duas conexões separa os dois, e só um **baseline vermelho** prova que a corrida
> do teste está de fato acontecendo.

Origem: o `[P1]` do parecer Codex (gpt-5.6-sol · xhigh) no PR #2204, deixado explícito no corpo
daquele PR como "Pendência que só o founder decide". O #2204 mitigou pelo front (o lote nunca
toca `aprovado_aguardando_disparo`; o status é relido do banco antes de chamar a RPC) mas não
podia fechar: **a janela é do servidor**.

## O que estava errado

`public.cancelar_pedido_sugerido(bigint, text, text)` fazia, em três passos:

1. `SELECT * INTO v_pedido FROM pedido_compra_sugerido WHERE id = p_pedido_id`
2. `IF v_pedido.status IN ('disparado','concluido_recebido') THEN` devolve `{error: …}`
3. `UPDATE pedido_compra_sugerido SET status='cancelado_humano', … WHERE id = p_pedido_id`

O passo 3 não repetia o predicado do passo 2 e não havia `FOR UPDATE` no passo 1.

Em paralelo, a edge `disparar-pedidos-aprovados` seleciona `aprovado_aguardando_disparo`, segura
a linha em memória durante a chamada HTTP `IncluirPedCompra` no Omie — **segundos de janela** — e
finaliza com outro `UPDATE … WHERE id`.

**Cenário A (o que corrompe):** a RPC lê `aprovado`; o disparador cria o PO no Omie e grava
`disparado`; a RPC grava por último e deixa `cancelado_humano` **sobre uma compra em andamento**.
O `omie_pedido_compra_id` fica órfão debaixo de um status cancelado.

## O fix

Uma única instrução — o predicado dentro do `WHERE` que grava:

```sql
UPDATE pedido_compra_sugerido
   SET status = 'cancelado_humano', …
 WHERE id = p_pedido_id
   AND status NOT IN ('disparado', 'concluido_recebido')
RETURNING id INTO v_id;
```

Se `v_id IS NULL`, relê o status **só para montar a mensagem** — a decisão já foi tomada pelo
predicado, e essa releitura não pode voltar a decidir nada.

É o mesmo padrão que `iniciar_envio_portal_pre_claim` já usa **nesta mesma tabela**, pelo mesmo
motivo. Não era invenção nova; era aplicar o padrão da casa onde ele faltava.

Migration: `supabase/migrations/20260905224959_cancelar_pedido_guard_atomico.sql`
(`CREATE OR REPLACE` — nunca `DROP`+`CREATE`, que resetaria o ACL; `SECURITY INVOKER`,
`search_path` e a higiene do portal preservados).

## O que esta fatia **não** fecha (dito para não ser lido como fechado)

**Cenário B:** a RPC cancela primeiro e o disparador, que já selecionou a linha, cria o PO e grava
por cima. O operador vê "rejeitado" e a compra acontece.

Eu tinha escrito aqui que o estado final de B ficava `status='disparado'` com os carimbos de
cancelamento — "verdadeiro e detectável, não corrompido". **Está errado, e o Codex derrubou com
dois contra-exemplos**, ambos preexistentes e ambos fora do alcance de qualquer consulta do tipo
`status='disparado' AND cancelado_em IS NOT NULL`:

1. a edge **ignora o `{error}` do seu `UPDATE` final** e devolve `status_final='disparado'` mesmo
   se a gravação falhar ⇒ o banco fica `cancelado_humano` **sem** `omie_pedido_compra_id`, com PO
   real no Omie e o fornecedor possivelmente já notificado;
2. se a resposta do Omie se perder, o `catch` grava `falha_envio` **por cima** do cancelamento.

Ou seja: B segue `[P1]` aberto e **não há hoje sinal confiável que o encontre depois do fato**. A
lição atrás do erro: *"detectável" é uma afirmação sobre uma CONSULTA, e uma consulta só é
detectora das intercalações que você enumerou* — as duas que faltavam bastam para invalidá-la.

**Por que a edge não foi tocada aqui.** O `SELECT … FOR UPDATE` no disparador é **inexequível**
como se imagina: a leitura e a escrita final da edge são round-trips PostgREST **separados**, com
uma chamada HTTP ao Omie no meio; cada chamada é a sua própria transação e o row lock não
sobrevive a ela. Lock só serializa dentro de **uma** instrução/transação SQL, e nenhuma delas
pode conter a chamada ao Omie.

O equivalente exequível é um **claim atômico** antes da chamada, estilo
`iniciar_envio_portal_pre_claim`. E um `UPDATE` final condicional **ingênuo** seria pior do que o
estado de hoje: 0 linhas ⇒ o PO existe no Omie e o banco **nunca grava** `omie_pedido_compra_id`
⇒ PO órfão invisível. Se a edge for tocada, a gravação dos identificadores do Omie tem de ser
incondicional (o PO existe — isso é fato) e só a **transição de status** pode ser condicional.

**Segunda correção do Codex.** Eu tinha afirmado que o claim *exige um status novo em voo* (tipo
`disparando`), e que o raio disso — rótulos do front, KPIs, health checks, varreduras de retry e
de expiração — excedia esta fatia. O furo: **claim não precisa morar no vocabulário de status**.
Uma **coluna dedicada de claim** na própria linha arbitra igual, com raio muito menor: o
disparador reivindica condicionalmente, o cancelamento exige ausência de claim, e só quem ganhou
chama o Omie. Nada em `status` muda, então nada em rótulo/KPI/filtro precisa saber. Fica a
ressalva do próprio parecer: resultado externo ambíguo tem de **manter a pendência para
conciliação**; liberar o claim por timeout recria o problema.

## A prova

`db/test-cancelar-pedido-guard-atomico.sh` — PG17 descartável, **39 asserts, exit 0**, rodado em
`lc_messages=C` **e** `pt_BR.UTF-8` (o harness imprime um controle do próprio eixo: `division by
zero` vira `divisão por zero`, então os dois ambientes são de fato diferentes).

Três asserts carregam o peso, e nenhum vale sem os outros dois:

- **R1 (baseline)** instala o **corpo velho REAL** (a migration `20260530210001`, commitada) e roda
  a corrida: o cancelamento **vence** a compra real e o `omie_pedido_compra_id` fica órfão. Sem
  este vermelho, o verde de R2 poderia significar apenas que a corrida nunca aconteceu.
- **R2 (fix)** roda a mesma corrida com o corpo novo: a RPC **recusa**, o status permanece
  `disparado`, `cancelado_em` continua `NULL` e a higiene do portal **não** é aplicada.
- **F2b** é a falsificação que importa: o corpo velho **ainda recusa no caso sequencial** (F2a
  verde — o guard existe) e **perde a corrida**. É isso que prova que R2 mede *atomicidade*, e não
  a mera existência de um `IF`.

Mais: **R3** é controle inócuo (um disparo em OUTRA linha não bloqueia este cancelamento — senão
"recusa sempre sob concorrência" passaria por fix); **F1** tira o guard e exige que cancelar um
`disparado` passe; **F3** tira o `COALESCE` do horário e exige `{"error": null}`; **A2** prova
`42501` capturando a condição nomeada e re-lançando o resto; **V1/V2** rodam a própria query de
validação do handoff nos dois sentidos (uma validação que nunca soube dizer "não aplicada" não
valida nada).

## A lição mais cara desta fatia: `sleep` não é barreira

A primeira versão do harness sincronizava as duas conexões com `sleep 0.8`. Estava verde. O Codex
apontou que verde ali **não prova nada**: se o disparador commitasse antes de a RPC começar, até o
corpo velho produziria a recusa esperada — R2 passaria sem nunca ter exercitado o EvalPlanQual; e
se o cancelamento terminasse antes de o disparador começar, F2b veria o mesmo JSON esperado sem
corrida nenhuma.

Troquei a espera por **ordem observada**:

- o bloqueador faz o `UPDATE` **dentro de um `DO`** e exige `FOUND` — se ele não pegar a linha, a
  transação aborta e o teste reprova, em vez de "a corrida acontecer" sobre zero linhas;
- logo depois ele toma um **advisory lock**, que é o sinal, visível de outra sessão, de que a
  linha já está travada. B só é lançada depois de esse sinal aparecer;
- o orquestrador então **polla `pg_blocking_pids`** até *ver* B bloqueada, e só aí libera A. O
  resultado da corrida carrega esse testemunho (`|sim`), e **F6 falsifica a própria barreira**:
  com A travando outra linha, ela tem de dizer `nao`.

**E foi o segundo locale que revelou a fragilidade.** Com `lc_messages=C` as seis primeiras
execuções passaram; a primeira execução em `pt_BR.UTF-8` reprovou F2b com `|nao` e F2c com
`omie_pedido_compra_id` nulo — exatamente o ordenamento invertido que o Codex tinha descrito.
Rodar nos dois ambientes não pegou um bug de *locale*: pegou um **bug de sincronização** que só se
manifesta sob um escalonamento diferente. É um argumento a mais para a regra dos dois ambientes:
ela vale como **segunda amostra de escalonamento**, não só como teste de tradução de mensagem.

Estado final: **48 asserts, exit 0, três execuções seguidas em cada locale.**

## Duas medições que o parecer corrigiu no próprio teste

**A sonda de execução da postcondição usava `min(id) - 1`** como "id ausente por construção". Não
é: se um `INSERT` com id menor ainda não commitou, a sonda escolhe justamente o id que a outra
transação está prestes a materializar — sequence crescente **não ordena commits**. Agora usa
`NULL::bigint`, e `id = NULL` nunca casa uma PK, sob qualquer concorrência. (Medido junto, contra
a prod: os três triggers de `pedido_compra_sugerido` são todos `FOR EACH ROW`, então uma execução
que afeta zero linhas não dispara nenhum. O `RowExclusiveLock` que ela toma é de **tabela**,
convive com DML e conflita só com manutenção/DDL.)

**O assert de `42501` media a coisa errada.** `anon` não tinha nem `EXECUTE` na função nem
`SELECT`/`UPDATE` na tabela — e como a função é `SECURITY INVOKER`, um `anon` **com** `EXECUTE`
falharia com o **mesmo `42501`**, vindo da tabela. O assert ficaria verde medindo privilégio de
tabela. Agora `anon` recebe os privilégios de tabela no fixture, de modo que o único que falta é o
`EXECUTE`, e **A2b** falsifica concedendo `EXECUTE` e exigindo que a mesma chamada passe.

## Dois achados adjacentes, corrigidos junto

**`'texto' || NULL` colapsa a string inteira.** Um pedido `disparado` sem `horario_disparo_real`
devolvia `{"error": null}`. Agora há `COALESCE(v_disparo::text, '(horário não registrado)')` — e o
mesmo `COALESCE` no ramo de status desconhecido, porque se o `NOT NULL` de `status` cair um dia,
aquela concatenação colapsa igual.

> **Correção do Codex a um rascunho meu, registrada porque o erro é instrutivo:** eu tinha escrito
> que "a recusa desaparecia da tela". Não desaparecia. Medido nos consumidores reais: em
> `rejeitar-pedido.ts` o `{error: null}` passa por `erroDoJsonb` (que devolve `null`) e cai no ramo
> `!confirmouOk(data)`, virando falha com o motivo genérico *"resposta inesperada da RPC (sem
> status ok)"*; o `CancelarModal` atravessa a mesma fronteira. O ganho real do `COALESCE` é a
> mensagem **verdadeira** — "já foi disparado" — no lugar de uma que não diz ao operador que a
> compra existe. **Afirmar o dano mais grave do que ele é também é fabricação**, e é mais fácil de
> cometer quando o fix é o mesmo nos dois casos.

**Motivo fabricado.** Se a linha existe e não está num status bloqueado mas o `UPDATE` não a
pegou, ela mudou entre as duas instruções. Dizer "já foi disparado" seria inventar a causa; a
função passa a devolver o status que realmente leu.

## A postcondição embutida, e o ponto cego dela — medido, não deduzido

A migration termina num `DO $post$` que **aborta o apply** se o objeto não ficou suficiente:
assinatura, `prosecdef=false`, `search_path` preso, `authenticated` executa, o predicado
**dentro** do `WHERE` do `UPDATE`, e — porque plpgsql é late-bound — um **assert por execução**:
chama a própria RPC com `(SELECT min(id) FROM pedido_compra_sugerido) - 1`, um id que não existe
por construção, o que planeja o `UPDATE` e o `SELECT` sem tocar uma linha real.

Cada `RAISE` carrega um sentinela **ASCII de caixa fixa** (`[GUARD-NO-UPDATE]`, `[ACL-EXECUTE]`,
`[EXEC-LATE-BOUND]`, …) para o harness casar sem depender de locale.

**O ponto cego, afirmado como fato medido (F5c):** o eixo de ACL usa
`has_function_privilege('authenticated', …)`, que é verdadeiro **também quando o privilégio vem de
PUBLIC**. Logo ele **não detecta `DROP FUNCTION` + `CREATE`** — o harness prova que, depois do
`DROP`+`CREATE`, o `proacl` nominal some (o grant a `authenticated` desaparece) e a postcondição
**passa mesmo assim**. O que esse eixo pega é a perda **efetiva** de EXECUTE, que é o que quebra a
tela. O assert está escrito para ficar **vermelho** se um dia a cobertura melhorar — obrigando
quem melhorar a reescrever esta linha em vez de deixar o doc mentir.

## Pendências

- ~~**Cenário B** continua aberto por desenho~~ — **FECHADO** em
  [cenario-b-claim-de-disparo.md](cenario-b-claim-de-disparo.md) (migration `20260906190615`,
  edge `v1.2-claim-disparo`), pelo caminho descrito acima e com duas correções que o desenho daqui
  não previa: a marca de claim **não pode ser limpa por falha** (com dois runs, o `catch` de um
  liberaria a linha enquanto o outro ainda pode comprar) e o guard mora num **trigger**, não no
  `WHERE` da RPC — outra worktree disputava o corpo de `cancelar_pedido_sugerido`, e o trigger
  cobre toda via de escrita em vez de só a RPC. `disparado_simulado` e o portal Sayerlack
  seguem abertos, registrados lá.
- **A remoção do último item continua fora da fronteira única.** `useDetalhesModal.ts` grava
  `status='cancelado_humano'` (mais os carimbos e a higiene do portal) por `UPDATE` cru
  `.eq('id', …)`, sem passar pela RPC e **sem guard de status no servidor**. Medido: o único
  freio é `podeEditar`, no cliente (`pendente_aprovacao` ou `bloqueado_guardrail`), decidido
  sobre o `pedido.status` que o browser tem em mãos — que pode ter minutos. É exatamente a
  segunda `[P1]` do parecer Codex no #2204 ("a allowlist não é política de servidor"), na via que
  o #2204 não cobriu. Um pedido aprovado e disparado enquanto o modal estava aberto cai nessa
  escrita. Não foi tocado aqui: é a mesma fatia da edge, e o conserto natural é a RPC ganhar esse
  caminho em vez de o front espelhá-lo.
