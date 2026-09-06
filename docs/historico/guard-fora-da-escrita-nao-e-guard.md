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
`disparado` por cima. Depois desta migration o estado final desse caso é `status='disparado'` com
os carimbos de cancelamento preenchidos — **verdadeiro** (o PO existe) e **detectável**
(`status='disparado' AND cancelado_em IS NOT NULL`), não corrompido. O que resta errado é a
confirmação de rejeição que o operador viu e que não valeu.

**Por que a edge não foi tocada aqui.** O `SELECT … FOR UPDATE` no disparador é **inexequível**
como se imagina: a leitura e a escrita final da edge são round-trips PostgREST **separados**, com
uma chamada HTTP ao Omie no meio; cada chamada é a sua própria transação e o row lock não
sobrevive a ela. Lock só serializa dentro de **uma** instrução/transação SQL, e nenhuma delas
pode conter a chamada ao Omie.

O equivalente exequível é um **claim atômico** antes da chamada (estilo
`iniciar_envio_portal_pre_claim`), que exige um status novo em voo — e o raio disso (rótulos do
front, KPIs, health checks, varreduras de retry e de expiração) excede esta fatia. E um `UPDATE`
final condicional **ingênuo** seria pior do que o estado de hoje: 0 linhas ⇒ o PO existe no Omie
e o banco **nunca grava** `omie_pedido_compra_id` ⇒ PO órfão invisível. Se a edge for tocada, a
gravação dos identificadores do Omie tem de ser incondicional (o PO existe — isso é fato) e só a
**transição de status** pode ser condicional.

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
`42501` capturando a condição nomeada e re-lançando o resto.

## Dois achados adjacentes, corrigidos junto

**`'texto' || NULL` colapsa a string inteira.** Um pedido `disparado` sem `horario_disparo_real`
devolvia `{"error": null}` — e o front lê `error == null` como *sem erro*, então **a recusa
desaparecia da tela** sobre uma compra real. Agora há `COALESCE(v_disparo::text, '(horário não
registrado)')`.

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

- **Cenário B** continua aberto por desenho, com o caminho descrito acima. É fatia própria, com
  deploy manual de edge (bump de `VERSAO` + fingerprint + os 4 gates de edge do CI).
- **A remoção do último item continua fora da fronteira única.** `useDetalhesModal.ts` grava
  `status='cancelado_humano'` (mais os carimbos e a higiene do portal) por `UPDATE` cru
  `.eq('id', …)`, sem passar pela RPC e **sem guard de status no servidor**. Medido: o único
  freio é `podeEditar`, no cliente (`pendente_aprovacao` ou `bloqueado_guardrail`), decidido
  sobre o `pedido.status` que o browser tem em mãos — que pode ter minutos. É exatamente a
  segunda `[P1]` do parecer Codex no #2204 ("a allowlist não é política de servidor"), na via que
  o #2204 não cobriu. Um pedido aprovado e disparado enquanto o modal estava aberto cai nessa
  escrita. Não foi tocado aqui: é a mesma fatia da edge, e o conserto natural é a RPC ganhar esse
  caminho em vez de o front espelhá-lo.
