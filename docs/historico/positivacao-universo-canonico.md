# Positivação ao vivo: o universo de pedidos do mês congelado

**2026-09-27.** Fecha o chip "Alinhar universo de pedidos da positivação ao vivo", aberto no fecho
de [positivacao-mes-sp-sob-sessao-utc.md](positivacao-mes-sp-sob-sessao-utc.md). Migration
`20260927195430_positivacao_universo_canonico.sql`, prova `db/test-positivacao-eligible-consumo.sh`
(blocos U e M novos, B re-baselinado).

## O defeito

A positivação AO VIVO (`_carteira_positivacao_for_owner`, o hero do farmer) e o mês CONGELADO
(`carregarPedidosDoMes`, edge `carteira-positivacao-snapshot`) contavam pedidos de universos
diferentes:

| | status | apagado | data |
|---|---|---|---|
| ao vivo | `NOT IN ('cancelado','rascunho','pendente')` | conta | `COALESCE(order_date_kpi, data de SP do created_at)` |
| congelado | a denylist canônica de 4 (com `orcamento`) | não conta | só `order_date_kpi` |

## A medição (psql-ro, 2026-09-27 22:41–22:55 UTC)

O retrato do briefing dizia "1 orçamento". Re-medido, a divergência eram **4 pedidos**, e 3 deles
não tinham nada a ver com status:

- **1 `orcamento`**: cotação criada no app em 12/06, nunca enviada ao Omie nem atualizada. Entrava
  pelo fallback: R$ 4.660 de receita em junho.
- **0 apagados.**
- **3 `enviado` sem kpi.** Todo pedido sem kpi (5 linhas) foi criado pelo APP: nenhum dos 4
  escritores do app grava a coluna (`submitQuote` e a proposta de WhatsApp inserem `orcamento`;
  `submitOrder` insere `rascunho`, que vira `enviado` após o push; `pedido-programado-enviar`
  idem). O importador do Omie sempre grava kpi. Os 23 pedidos do app anteriores a 25/05 têm kpi só
  pelo backfill da migration que criou a coluna; os 3 posteriores, 3 de 3, têm kpi nulo.

A leitura óbvia era "o fallback recupera venda que o congelado perde". **Era o contrário.** O
pedido que o app empurra ao Omie volta pelo importador como OUTRA linha, com o mesmo
`(account, omie_pedido_id)` e com kpi. **25 dos 26** empurrados têm esse gêmeo, e são exatamente
os 25 pares duplicados de `omie_pedido_id` da tabela inteira. O congelado contava só a importada;
o ao vivo contava as duas, a do app pelo fallback. Duplicata viva em jun/ago: R$ 1.346,10.

**Efeito da mudança, medido ANTES do commit** (a exigência P1 #7 do desenho): comparando os dois
universos por dono e mês sobre a carteira elegível, só 2 dono-mês mudam — jun/2026 (−R$ 5.239,10)
e ago/2026 (−R$ 767), total **−R$ 6.006,10**. **Positivados: 0 mudanças. Novos: 0 de 1.198
clientes mudam a data da 1ª compra. Setembro: idêntico.** A validação pós-apply compara com isto,
não com "o hero não mudou" — que seria verdade também para uma migration inerte.

## A decisão (founder, 2026-09-27)

- **D1 — universo canônico** no ao vivo: exclui `orcamento` e apagado.
- **D2 — sem o fallback**: a data é só `order_date_kpi`, igual ao congelado. A troca: uma venda do
  app aparece depois da importação do Omie (cron a cada 2 h por conta) em vez de na hora, e deixa
  de contar 2× depois que o gêmeo chega.

O desenho do Codex refinou a D2 (P1 #1): "até 2 h" é o caminho feliz. O importador pode **pular**
um pedido (cliente não resolvido, desconto ilegível) e o cron olha uma janela móvel de 5 dias.
Medido: **1 venda em 26 nunca voltou** (`4c19af2a`, abril; conta 1× porque tem kpi do backfill).
Depois de maio, 0 casos. Um pedido assim fica fora do ao vivo e do congelado até reprocessar — o
congelado já tinha esse ponto cego. A decisão ficou, e o sensor virou chip (abaixo).

## O conserto

Única mudança no corpo, a CTE `pedidos_validos`:

```sql
SELECT so.customer_user_id, so.order_date_kpi AS d, so.total
FROM public.sales_orders so
WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
  AND so.deleted_at IS NULL
```

Pedido sem kpi sai pelas comparações de mês e pelo `min()`, como no `.gte/.lt` do loader. Um `IS
NOT NULL` explícito seria redundante — e predicado redundante não se falsifica (o Codex concordou).

- **PRE com trava.** O Codex (desenho, P2 #6) mostrou que a pré-condição anti-deriva do #2606 lia
  o corpo sem travar nada: outro aplicador que commitasse entre a leitura e o `CREATE OR REPLACE`
  teria o corpo sobrescrito em silêncio. Agora a PRE faz `ALTER FUNCTION … SET search_path =
  public` (o mesmo valor) ANTES de ler: o ALTER atualiza a linha de `pg_proc`, e um `CREATE`
  concorrente espera esta transação e falha. Medido em PG17 com barreira observada: com o toque, o
  concorrente BLOQUEIA; sem ele, não; tocando OUTRA função, não. `SELECT … FOR UPDATE` em
  `pg_proc` não serve: passa no harness (onde `postgres` é superuser) e falha na prod, onde o
  `postgres` não é superuser e não tem `UPDATE` no catálogo (dono `supabase_admin`, medido). O OID
  é resolvido DEPOIS do toque. O único event trigger que o ALTER aciona na prod é o
  `pgrst_ddl_watch`, que o próprio `CREATE` já aciona (medido).
- **Função ausente aborta** (adversarial, P2 #2): o idioma do #2606 seguia sem a função, pulando a
  trava — e um `CREATE` concorrente naquela janela seria sobrescrito. Esta migration tem
  predecessor obrigatório; numa reconstrução do zero as duas anteriores rodam antes.
- **Identidade por md5 EXATO** (adversarial, P2 #1): a normalização do #2606 (sem comentários,
  espaço colapsado) apaga diferença DENTRO de literal — `interval '1 --x` + quebra + `month'` tem o
  mesmo hash normalizado que `interval '1 month'`, e a PRE aceitaria essa deriva. O exato é seguro
  porque o `db:aplicar` transporta os bytes verbatim: o md5 exato do corpo do #2606 tirado do
  arquivo é o mesmo medido na prod (`8abdeac4…`).
- **POS reordenada.** Os predicados semânticos (universo, sem fallback, ligação em SP) vêm antes
  do md5 do corpo. Na ordem do #2606 eles eram inalcançáveis: todo desvio de corpo caía no md5
  primeiro, e a mensagem que diz O QUE está errado se perdia.
- **Pré-voo na prod** (antes de fechar o arquivo): o corpo vivo tem o md5 exato do predecessor; os
  predicados que a migration muda invertem no corpo antigo; os que não muda ficam estáveis. A PRE
  inteira (com o ALTER) não roda sob `psql-ro`, que é read-only: quem a exercita na prod é o
  `db:aplicar --ensaio`, com o executor e os privilégios reais, e ROLLBACK.

## A prova

- **Bloco U — o universo, predicado a predicado.** Admissão: um pedido em cada status válido
  medido na prod (`faturado`, `importado`, `separacao`, `enviado`) — uma allowlist derruba algum.
  Exclusão no mês: cada predicado tem um cliente cujo ÚNICO pedido de fevereiro só ele exclui, com
  kpi NO MÊS (sem kpi o pedido sairia de qualquer jeito e o assert passaria por vacuidade), e uma
  compra válida em dezembro — vazando, vira positivado mas nunca novo, então o vazamento aparece na
  receita pela potência de 10 sem o "novos" compensar. Exclusão no histórico: um pedido fora do
  universo em janeiro não pode roubar o "novo" de quem compra válido em fevereiro; e um controle
  com janeiro VÁLIDO prova que o "novos" enxerga o histórico.
- **Bloco M — a migration sob o executor** (transação única, como o `db:aplicar`). O Codex pediu
  isso no desenho: os mutantes do #2606 recriavam a função DEPOIS do apply e nunca falsificavam a
  PRE nem a POS. Tudo se prova com o RETRATO INTEGRAL da função (corpo exato | proconfig | ACL),
  porque só o corpo deixaria passar um toque ou um REVOKE que vazou (adversarial, P2 #3):
  - M3: a POS reprovada (wrapper sem EXECUTE nas DUAS pontas — o PUBLIC tem o default de fábrica,
    e tirar só de `authenticated` deixaria a POS7 verde por vacuidade) desfaz tudo;
  - M2: corpo estranho com config (`public, pg_temp`) e ACL (`anon`) DIFERENTES dos que a migration
    deixaria é recusado e preservado inteiro — iguais, um vazamento passaria por vacuidade;
  - M5: função ausente → a PRE aborta e nada nasce;
  - M1: a re-aplicação passa e o retrato não muda;
  - M4: a PRE trava a linha. C segura uma trava de liberação que só o orquestrador solta; A roda a
    PRE do arquivo, sinaliza com advisory de TRANSAÇÃO e fica preso em C — não sai sozinho nem por
    timeout (no rascunho A dormia 30 s e saía, e um "não bloqueou" podia ser timing: adversarial,
    P2 #4); B tenta recriar com `lock_timeout` de 500 ms, e `lock_not_available` prova que
    esperou; depois de B, o sinal de A ainda concedido prova que A seguia na transação. Controle
    M4c: recriar OUTRA função não espera.
  Ficou de fora, de propósito, simular o `aplicar_sql` no harness: o `db:aplicar --ensaio` roda o
  executor real na prod, com os privilégios reais, e faz ROLLBACK — prova mais forte que a cópia.
- **O laço exige o denominador** (adversarial, P2 #5): antes, uma rodada que produzia o vermelho
  declarado e depois morria por um erro (`set -e`) era aceita como dente. Agora cada rodada tem de
  terminar com `RESULTADO` e executar 58 asserts (50 nas duas sabotagens de corpo antigo, que
  pulam o bloco M).
- **Bloco B re-baselinado.** Os pedidos sem kpi (Y1, Y2, Y3 e o 1º de R) viraram controles
  negativos do fallback. Tirar o fallback matava a testemunha de `min()` × `max()` (P1 #4 do
  desenho): entrou Q, que compra com kpi em fevereiro E março — em março é positivado e não é novo.
  `a_positivar` passou a comparar o UUID completo.
- **Oráculo independente em Python** (fora do repo) calculou os esperados de B e U e os vermelhos
  de cada sabotagem de corpo antes de a prova rodar. Bateu nos 34 asserts de valor que ele modela
  (B1–B14 nas duas sessões e U0–U5) e nos vermelhos das 16 sabotagens de corpo; relógio, gate,
  elegibilidade e o bloco M ficam fora do modelo e têm o dente provado só pela execução.
- **Números:** 58 asserts (eram 44). `--falsificar`: controle verde + **26** sabotagens (eram 14),
  entre elas `literal_antiga_3_status`, `sem_deleted_at`, `fallback_de_volta`,
  `allowlist_faturado`, uma por status da denylist, `primeira_so_no_mes`, `corpo_2606` (o corpo de
  prod antes desta) e as 4 da migration (`pre_sem_trava`, `pre_aceita_qualquer`,
  `pre_ausente_segue`, `pos_sem_wrappers`). Matriz servidor `TZ=UTC`/local × `lc_messages`
  C/pt_BR: PENDENTE. (O rascunho anterior ao adversarial fechou 4/4 com 25/25.)
- **Tempo:** no laptop o `--falsificar` levou mais de 10 min, e isso não projeta o CI. No log do
  runner a versão anterior roda em 1 s (suíte) e 18 s (falsificação), ~20× mais rápido. O
  `lock_timeout` do M4 caiu para 500 ms (um CREATE livre termina em microssegundos), e a projeção
  é ~80 s para o job `provas-sql`, que leva 6 min 45 s de um teto de 12.

## O Codex

- **Desenho** (gpt-6-astra · max · 374 s · 148.771 tokens): nenhum P0. P1 #1 (gêmeo não garantido)
  aceito como fato, com o número 1/26, e virou chip de sensor. P1 #2 (A+B não cumprem "venda
  única": os 22 pares de abril seguem duplicados nos dois lados) aceito como diagnóstico, recusado
  como escopo: deduplicar só no ao vivo quebraria a paridade que esta entrega existe para dar; vira
  entrega própria, na fonte e nos dois lados. P2 #3 (novos pode subir quando se exclui pedido)
  medido: 0/1.198. P1 #4 e P2 #5 já estavam no plano da prova e foram completados (Q,
  `primeira_so_no_mes`, UUID completo). P2 #6 (TOCTOU da PRE) aceito e corrigido com a trava.
  P1 #7 (validar só o hero aprova entrega inerte) atendido com a comparação por dono/mês.
- **Adversarial no diff** (gpt-6-astra · max · 570 s · 169.984 tokens), rodado ANTES do 1º commit
  da migration — ela fica imutável no commit, então achado nela depois disso seria migration nova.
  Nenhum P0/P1 no cálculo. Cinco P2 nas proteções e na prova, todos aceitos e corrigidos: #1
  identidade normalizada apaga diferença dentro de literal → md5 exato; #2 função ausente pulava a
  trava → aborta; #3 M2/M3 comparavam só o corpo e o M2 tinha config igual à do toque → retrato
  integral, com config e ACL distintos no corpo estranho; #4 A saía sozinho após 30 s → trava de
  liberação e sinal de transação; #5 o laço aceitava rodada truncada → denominador por rodada.
  Recusados: simular o `aplicar_sql` no harness (o `--ensaio` na prod é a prova real) e validar com
  `psql-ro -X` (o `-X` desliga o psqlrc, que é o que torna o wrapper read-only — database.md §1).
  Um sexto P2, preexistente e fora do diff, foi para chip: o hero chama `novos_clientes_positivados`
  (1ª compra da vida) de "Recuperados (win-back)". E um limite anotado: `a_positivar` corta em 200
  sem desempate único, então a ordem entre empates no corte não é garantida (preexistente).

## A classe

Levantamento estático (subagente, a conferir por quem pegar o chip): 38 objetos SQL vivos leem
`sales_orders`; 12 são lookup por id. Dos 26 que aplicam um universo, **4 são canônicos completos
e 22 divergem, 14 deles money-path**. Os mais graves apontados: `get_regua_preco` (nenhum filtro
de status), `private.customer_metrics_mv` (denylist de 2, sem `deleted_at`, base de
recência/churn) e as `v_caca_*`. Esta entrega leva a positivação para o lado canônico (5 de 26) e
deixa a erradicação para um chip por domínio.

## O que ficou de fora (chips)

1. **Deduplicar os gêmeos push/pull** na fonte (os 22 pares de abril já duplicam nos dois lados) e
   só então deixar os escritores do app gravarem `order_date_kpi`. ⚠️ Hoje o kpi nulo da linha do
   app é, por acidente, o que a deduplica: gravar kpi antes de resolver o gêmeo volta a duplicar
   receita no ao vivo E no congelado.
2. **Sensor de venda empurrada que nunca voltou**: linha do app com `omie_pedido_id` e sem gêmeo
   importado há mais de N horas, por conta — quantidade, valor e idade.
3. **Erradicar a classe** do universo divergente nas 22 funções/views.

## Lições

1. **Duas telas que divergem no "mesmo número" podem estar escondendo DUPLICATA, não perda.** O
   fallback parecia recuperar venda que o congelado perdia; olhando a identidade
   `(account, omie_pedido_id)`, ele contava a mesma venda duas vezes. Antes de alinhar dois
   universos, confira se a linha que só um deles conta tem um gêmeo que o outro conta.
2. **Um NULL acidental pode ser o deduplicador.** Quem "consertar" o escritor para preencher a
   coluna reintroduz a duplicata nos dois lados. Escreva isso onde o próximo vai tropeçar (a
   migration e este diário), não só no chip.
3. **A PRE anti-deriva que só LÊ é um guard fora da escrita** (money-path.md, §TOCTOU). A trava
   tem de ser algo que o papel da PROD pode fazer: o `FOR UPDATE` em catálogo é o conserto óbvio,
   passa no harness e quebra na prod.
4. **Predicado de diagnóstico depois de um predicado que decide tudo é inalcançável.** Ordene do
   que diz O QUE está errado para o que só diz QUE está errado.
5. **Um REVOKE de teste tem de fechar todas as portas que o `has_function_privilege` enxerga.** O
   default de fábrica dá EXECUTE a PUBLIC; revogar só de `authenticated` deixaria o assert verde
   por vacuidade.
6. **O relógio do laptop não projeta o runner.** Antes de enxugar uma prova "lenta", leia no log do
   CI quanto ela leva lá.
7. **Normalizar para tolerar comentário apaga diferença dentro de LITERAL.** Um `--` dentro de
   aspas é texto, não comentário, e o regex não sabe disso. Se o transporte é verbatim, use o hash
   exato; se não é, a normalização tem de entender literais.
8. **Um vermelho declarado não prova nada sobre o resto da rodada.** O laço que só procura o assert
   esperado aceita uma rodada que depois morreu. Exija o fim e o denominador de cada rodada, não só
   o do controle.
9. **Barreira observada não basta se o bloqueador pode sair sozinho.** O sinal tem de sumir junto
   com a transação que ele atesta (advisory de transação), e o bloqueador só sai quando o
   orquestrador manda.
