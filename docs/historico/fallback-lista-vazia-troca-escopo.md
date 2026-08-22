# O fallback que trocava o ESCOPO quando a leitura vinha vazia (Farmer, #escopo-orfao)

> Diário de PR. A regra durável está na §Armadilhas do `CLAUDE.md`; o detalhe do domínio em
> `docs/agent/money-path.md`. Aqui fica o caso, com os números que o justificam.

## O código

Os dois motores do Farmer (`useCrossSellEngine`, `useBundleEngine`) tinham a mesma linha:

```ts
let clientScores = await fetchAllScores(effectiveUserId);           // .eq('farmer_id', X)
if (!clientScores.length && !isImpersonating) clientScores = await fetchAllScores(); // TODOS
```

e depois gravavam o resultado com `p_farmer_id: effectiveUserId`.

O comentário chamava isso de *"try farmer-specific first, fallback to all (for super_admin)"*.
**O comentário descrevia a INTENÇÃO; a condição perguntava outra coisa.** Ela não pergunta se
o usuário é super_admin — pergunta se a leitura **veio vazia**. Qualquer caminho que produza
lista vazia (carteira legitimamente vazia, página perdida, RLS, timeout) arma a troca de
escopo, e o mais destrutivo dos desfechos — "carregue a base inteira e grave sob este nome" —
é o **default** de uma falha, não uma escolha.

## O dano, medido (psql-ro, 2026-08-21)

Por lote, contra o dono ATUAL de cada cliente:

| lote | gravado sob | clientes | % que são dele | % da base que ele detém |
|---|---|---|---|---|
| mar/2026 | `414a9727` | 54 | 42,6% | 58,2% |
| abr/2026 | `33f59dc7` | 166 | **25,9%** | **18,8%** |
| mai/2026 | `414a9727` | 138 | 4,3% | 58,2% |
| ago/2026 | `414a9727` | 238 | **100%** | 58,2% |

A linha de abril é a assinatura: receber 25,9% quando se detém 18,8% da base é o que o
**acaso** dá a quem sorteou da base inteira — não o que a própria carteira daria. Total:
**2.676 linhas** em `farmer_recommendations` com `farmer_id` ≠ dono, mais 12 em
`farmer_bundle_recommendations` (4 clientes, nenhum do farmer que as gravou).

O lote de agosto (100% correto) é o controle que torna os outros legíveis: o caminho de
leitura já tinha sido endurecido (`fetchAllPages` lança em vez de devolver vazio, #1545), e
com ele o fallback deixou de ser alcançado por falha de transporte. **O amplificador seguia
armado** — só faltava uma carteira vazia.

## Por que a linha fora de escopo não é só ruído de tela

As RPCs de substituição expiram `WHERE farmer_id = p_farmer_id AND status='pendente'`. A
oferta do cliente C gravada sob A, quando o dono é B, é **invisível ao recálculo de B**: o
dono real recalcula e ela sobrevive, deixando o mesmo cliente com duas gerações pendentes.

Não é vazamento permanente: o UPDATE **não** filtra por cliente, então ela morre no próximo
recálculo do **dono antigo**. Foi assim que as 12 linhas de março do bundle morreram em 21/08.
É uma janela — que dura o quanto o dono antigo demorar a recalcular (no lote de abril, meses).

## A correção, nos dois lados

1. **Browser:** o fallback saiu. Carteira vazia → lista vazia, que os motores já tratam
   (`aplicarRecomendacoes([])` + `registrarVazio()`) — a mesma degradação honesta que a lente
   "Ver como" já usava.
2. **Servidor (o que não se contorna):** gate `FG009` nas duas RPCs. `farmer_client_scores`
   tem `UNIQUE (customer_user_id)` ⇒ o dono é uma **função**, computável dentro da RPC. Ele
   entra entre a validação de linhas e o UPDATE, então "nada foi expirado" segue verdadeiro
   na recusa. Só o browser não bastaria: #1840 é o precedente de o browser reescrever por
   cima do servidor.

## Três detalhes que custam caro se invertidos

- **`IS DISTINCT FROM`, não `<>`.** Com `<>`, o cliente sem linha de score dá NULL, o `WHERE`
  o descarta e ele **passa** — justo o caso de dono desconhecido, o mais suspeito de todos.
- **A cegueira da RLS precisa RECUSAR.** A RPC é `SECURITY INVOKER`; se a RLS de
  `farmer_client_scores` esconder do chamador a linha de um cliente alheio, o LEFT JOIN
  devolve NULL — e NULL é recusado. Se o predicado fosse escrito ao contrário, a RLS viraria
  a porta de trás do gate.
- **ERRCODE novo se confere antes.** `FG008` já era da trigger de pendente-sem-`run_id`
  (`20260814223445`). Dois erros com a mesma SQLSTATE são indistinguíveis para quem os trata —
  e o próprio harness de teste casaria o erro errado e pintaria verde. Em prod: `FG001`–`FG008`
  e `FG101`–`FG107` ocupados.

## O que ficou de fora, de propósito

O cliente que troca de dono **depois** de a oferta ser gravada. Corrigir isso na RPC exigiria
ampliar a policy de UPDATE para "sou o dono atual deste cliente", e o challenge Codex recusou
com o argumento certo: **RLS autoriza LINHAS, não operações** — a policy ampliada abriria
escrita direta por PostgREST sobre linhas de outro farmer, contornando RPC, CAS e auditoria.
O lugar certo é a origem (a edge que reatribui o dono expira as pendentes do dono antigo).

Não fica como recado — fica como **query**:

```sql
SELECT count(*) FROM farmer_recommendations r
  JOIN farmer_client_scores s USING (customer_user_id)
 WHERE r.status='pendente' AND r.farmer_id <> s.farmer_id;
-- baseline 21/08/2026, pós-saneamento: 0
```

## Onde o controle positivo pagou

A primeira fixture do teste do bundle era **estéril** — não produzia bundle nenhum. O teste
"farmer sem carteira não persiste nada" passava, e passaria para sempre, medindo nada. Foi o
controle positivo ("o MESMO dado, lido pelo dono, PRODUZ") que o pegou.

E o stub precisou respeitar `.eq('farmer_id', …)` de verdade: os moldes vizinhos ignoram
filtros, e com o filtro ignorado as duas leituras devolvem o mesmo — o fallback fica
**invisível** e o teste passa dos dois lados da correção.
