# As cinco candidatas ao TOCTOU: nenhuma tem o defeito — e o porquê de cada uma

> Triagem de 2026-09-06, fechando a pendência que a
> [3ª via](terceira-via-toctou-aprovacao.md) deixou explícita: o regex da varredura lista **9**
> funções que escrevem em `public.pedido_compra_sugerido` tendo algum `INTO`; 3 são as vias já
> corrigidas, `iniciar_envio_portal_pre_claim` já usava claim condicional, e sobravam **5 não
> triadas**. **Veredito: as 5 estão limpas.** Artefato: `db/test-tick-auto-aprovacao-corrida.sh`
> (11 asserts, `exit 0` nos dois locales).

## A classe procurada

`SELECT … INTO` decide → `IF … recusa` → `UPDATE … WHERE id` grava **sem repetir o predicado e sem
lock**. Em READ COMMITTED o `SELECT` não bloqueia: a função decide sobre um retrato, espera no lock
de uma transação concorrente e grava por cima do que ela acabou de commitar
([a classe](guard-fora-da-escrita-nao-e-guard.md)).

Um achado exige **as três** juntas: (a) decisão sobre retrato gravada sem reconferir; (b) o valor
decidido é money-path; (c) existe escritor concorrente plausível. Faltando (a), as outras duas não
importam — e foi (a) que faltou nas cinco.

Método: corpo **VIVO** lido na PROD com `~/.config/afiacao/psql-ro` via `pg_get_functiondef` — o
`supabase/schema-snapshot.sql` não prova a definição servida.

## O veredito, função a função

| Função | O que fecha o eixo | Onde se lê |
|---|---|---|
| `aplicar_promocoes_no_ciclo` | escritas **set-based** com o predicado no `WHERE` de quem grava | próprio corpo |
| `gerar_pedidos_sugeridos_ciclo` | idem + `pg_advisory_xact_lock` contra si mesma | próprio corpo |
| `pedido_compra_split` | `FOR UPDATE` no pai **antes** de decidir | próprio corpo |
| `sayerlack_aplicar_custo_portal` | CAS no `WHERE` + `ROW_COUNT`; o `SELECT` vem **depois** | próprio corpo |
| `reposicao_alerta_pedido_minimo_tick` | claim condicional **e** um `FOR UPDATE` que vive **no callee** | **outra função** |

### 1. `aplicar_promocoes_no_ciclo` — os `INTO` são contadores, não decisões

Os cinco `INTO` (`v_flat`, `v_fb`, `v_pedidos`, `v_economia`, `v_bloqueados`) são agregados em
escalar que alimentam **só o `RETURN`**. Não existe `SELECT … INTO` de uma linha que porteie uma
escrita. As duas escritas na tabela são set-based, com o predicado dentro da instrução que grava:
`status = 'pendente_aprovacao'` no recálculo de `valor_total`, e
`status IN ('pendente_aprovacao','bloqueado_guardrail')` — **allowlist** — na reavaliação do
guardrail. Uma aprovação concorrente tira a linha dos dois predicados e o EvalPlanQual a pula.

Registrado por honestidade: `v_pedidos`/`v_economia` leem um retrato entre a escrita dos itens e a
do cabeçalho, então sob concorrência podem sair defasados. É **estatística de retorno**, não
decisão de escrita — não é a classe, e não vira número gravado.

### 2. `gerar_pedidos_sugeridos_ciclo` — os `INTO` são config, e o expurgo é allowlist

Os quatro `INTO` (`v_stale_dias`, `v_teto_ativo`, `v_teto_b`, `v_teto_c`) leem `company_config` —
configuração, não retrato da linha-alvo. As três DML na tabela: o `UPDATE` que expira zumbis traz
`status = 'pendente_aprovacao'` no próprio `WHERE`; o `DELETE` da limpeza do dia traz
`status IN ('pendente_aprovacao','bloqueado_guardrail')` — a mesma allowlist do `podeEditar`; e o
`INSERT` não tem contra o que correr. Um pedido aprovado no meio do ciclo sai de ambos os
predicados e **não é apagado**: falha fechada. O `pg_advisory_xact_lock` do topo serializa
execuções dela mesma (cron × botão × retry), não as RPCs humanas — e não precisa.

### 3. `pedido_compra_split` — o lock vem antes da decisão

```sql
SELECT status, split_parent_id INTO v_status, v_split_parent
  FROM public.pedido_compra_sugerido WHERE id = p_pedido_id
  FOR UPDATE;               -- ← trava ANTES de decidir, e o lock dura até o COMMIT
```

É o padrão da [2ª via](segunda-via-de-cancelamento-fora-da-fronteira.md) na forma mais forte
(`FOR UPDATE` ⊃ `FOR NO KEY UPDATE`). As três escritas sem predicado adicional estão cobertas: duas
gravam **linhas-filhas criadas na mesma transação** (nenhuma outra transação as enxerga ainda), e a
última grava o pai sob o lock tomado antes da decisão.

### 4. `sayerlack_aplicar_custo_portal` — o `SELECT` vem DEPOIS da escrita

```sql
UPDATE public.pedido_compra_sugerido p SET valor_total = p_valor_total
 WHERE p.id = p_pedido_id
   AND p.omie_pedido_compra_numero IS NULL          -- CAS dentro do WHERE de quem grava
   AND p.status_envio_portal = 'sucesso_portal';
GET DIAGNOSTICS v_afetadas = ROW_COUNT;             -- a decisão é o ROW_COUNT
```

O `SELECT … INTO v_omie, v_status` aparece **depois**, e só para montar a mensagem — exatamente a
forma em que a 1ª via foi consertada, aqui já entregue pela `20260905090000`. O
`INTO v_ids_distintos` valida o argumento `jsonb`, não um retrato de tabela: não há com quem correr.

### 5. `reposicao_alerta_pedido_minimo_tick` — limpa, mas por um lock que não está nela

Esta é a única cuja absolvição **não se lê no próprio corpo**, e por isso é a que ganhou prova.

**Eixo status** — o claim é condicional, no `WHERE` de quem grava, com `IF FOUND`:

```sql
UPDATE public.pedido_compra_sugerido
   SET status = 'aprovado_aguardando_disparo', aprovado_por = 'auto:sayerlack-v2', …
 WHERE id = r.pedido_id
   AND status = 'pendente_aprovacao' AND aprovado_em IS NULL AND cancelado_em IS NULL;
IF FOUND THEN …
```

**Eixo valor** — e aqui estava a dúvida real. A elegibilidade não decide por status: decide pela
**soma dos itens** (`reposicao_pedido_auto_aprovavel`, P1.2 — "o valor que importa é o que será
comprado"), e esse eixo o `WHERE` acima **não reconfere**. Uma remoção de itens concorrente
(`remover_itens_pedido`, `salvarMutation`) derruba a soma **sem mudar o status**, então o predicado
continuaria casando.

O que fecha isso é a **primeira linha do corpo do callee**:

```sql
SELECT * INTO p FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
```

Um `FOR UPDATE` numa função **read-only**, que da leitura do tick é invisível, e que na leitura do
próprio callee **parece redundante** — ele não escreve nada. Não é redundante: ele trava o pai
**antes** (linha 18) de a soma dos itens ser lida (linha 73), então todo escritor que passa pelo pai
fica serializado e o tick relê itens frescos.

**Até onde esse lock alcança — dito com precisão, porque a diferença importa.** Ele trava o *pai*,
não a tabela `pedido_compra_item`. Contra quem toma o lock do pai antes de escrever — o caminho da
RPC `remover_itens_pedido`, que usa `FOR NO KEY UPDATE` — a serialização é **completa**, e é isso que
R1/R2/F1 medem. Mas existem, medidos no app, **dois escritores diretos de item que não passam pelo
pai**: `useDetalhesModal.ts:174` e `PedidoRow.tsx:122`, ambos `UPDATE pedido_compra_item … .eq('id',…)`
com CAS **por item** (protege contra outro humano, não contra o tick). Contra esses dois, o lock do
pai não serializa: sobra a janela entre a leitura da soma e o `UPDATE` do tick.

Essa janela residual é **estreita por construção, e não foi reproduzida em corrida** — a distinção é
deliberada, não é o mesmo que dizer que não existe. Entre a soma (linha 73) e o `UPDATE` do tick, o
pai **já está travado pelo próprio tick**: ninguém mais pode tomar aquele lock, logo **não há ponto de
bloqueio para alargar a janela**, e ela vale microssegundos de CPU. É exatamente o contrário do R1,
onde tirar o `FOR UPDATE` faz o `UPDATE` do tick **esperar no lock** e a janela virar segundos —
tempo de sobra para a corrupção acontecer de forma confiável, como o baseline mostra.

Ou seja: o lock do callee não *elimina* o eixo valor, ele o **colapsa** de "segundos, reproduzível"
para "microssegundos, sem ponto de bloqueio". Quem quiser fechá-lo de vez precisa levar o predicado
de valor para dentro do `WHERE` que grava (algo como `AND (SELECT SUM(…) FROM pedido_compra_item …)
>= v_threshold`), e isso é decisão de produto — fatia própria, não este fix.

## O achado que a triagem produziu (e não era o defeito procurado)

Nenhuma das cinco tem o TOCTOU. Mas a triagem mediu uma **fragilidade**: a segurança do tick é
*load-bearing* num lock de outra função, onde ele não tem justificativa local. Quem "limpar" aquele
`FOR UPDATE` — o gesto mais natural do mundo numa função sem escrita — reabre o buraco em silêncio,
e nenhum teste do repo acusaria: o `P5` de `db/test-auto-aprovacao-v2.sh` cobre "corrida com humano"
mas é **sequencial** (aprova, commita, só então chama o tick), e assert sequencial **não distingue
"tem guard" de "o guard é atômico"**.

Por isso a absolvição virou regressão executável em vez de parágrafo.

## A prova — `db/test-tick-auto-aprovacao-corrida.sh` (11 asserts)

```
=== RESULTADO: 11 OK, 0 FAIL (lc_messages=C) ===
=== RESULTADO: 11 OK, 0 FAIL (lc_messages=pt_BR.UTF-8) ===
```

O controle do eixo confirma que o servidor mudou de língua de fato (`ERRO: divisão por zero`) — sem
ele, "rodei nos dois" seria alegação.

Corrida em 2 conexões com **barreira observada** (`pg_blocking_pids` pollado até *ver* B bloqueada;
`sleep` não é barreira). **A** é a via real de remoção (`FOR NO KEY UPDATE` no pai → `DELETE` de
item → recalcula `valor_total`); **B** é o tick.

- **R1 — baseline VERMELHO.** Corpo do callee com **uma única alteração** (o `FOR UPDATE` removido,
  gerado por `sed` sobre o `pg_get_functiondef` do corpo real já aplicado): o tick lê o retrato
  antigo (2 itens, R$ 8.000), a remoção commita, o `UPDATE` reencontra `status='pendente_aprovacao'`
  e **auto-aprova um pedido de R$ 4.000 — abaixo da régua de R$ 5.000**. `R1b` mostra o dano fino:
  o log carimba **8.000**, um valor que já não existe.
- **R2 — a absolvição, na mesma corrida.** Corpo real: recusa, deixa `pendente_aprovacao`,
  `aprovado_por` nulo, e `R2b` confirma que nenhum log foi gravado.
- **F1 — falsifica o próprio R2.** Corrida **idêntica** — mesma barreira, mesmo lock, mesma espera —
  mas a remoção deixa o pedido **ainda acima da régua**: o tick **aprova**. Verde aqui + verde em R2
  prova que a recusa de R2 veio do **valor relido**, não do mero fato de ter esperado no lock (que
  recusaria sempre sob concorrência e passaria por guard sem ser um).
- **F0 — controle verde na MESMA invocação**, antes de F1: sem corrida, o corpo real aprova esse
  mesmo formato de pedido. Se o controle falhar, o harness **aborta antes de F1** — uma falsificação
  sempre-vermelha aprovaria qualquer coisa.
- **S0** exige que a sabotagem tenha de fato alterado o corpo: um "baseline" idêntico ao real
  ficaria verde de graça.
- **D1/D2** comparam o `md5(prosrc)` local com o **medido na PROD em 2026-09-06** — sem isso o
  harness poderia estar provando um corpo que não está servido. **D3** é posicional: exige o
  `FOR UPDATE` **no mesmo `SELECT` que lê o pai**, não "em algum lugar do arquivo".

## O que esta varredura NÃO fecha

- **A classe fica varrida nesta tabela, não no banco.** O regex cobriu quem escreve em
  `pedido_compra_sugerido`. Outras tabelas de money-path não foram varridas.
- **O cenário B da 1ª via continua P1 aberto** (o disparador cria o PO no Omie e grava por cima de
  um cancelamento). Lock serializa o banco, não o ERP — ver
  [guard-fora-da-escrita-nao-e-guard.md](guard-fora-da-escrita-nao-e-guard.md).
- **A janela residual do eixo valor contra escritor DIRETO de item** (os dois writers acima) fica
  aberta, colapsada a microssegundos pelo lock do callee mas não fechada. Não reproduzida: sem ponto
  de bloqueio, não há como alargá-la sem inventar um lock que não existe em produção — e um harness
  que inventa a janela mede o harness, não o sistema.
- **Quatro das cinco foram absolvidas por LEITURA**, não por corrida. É defensável porque a proteção
  delas está visível no próprio corpo e um leitor a confere; a do tick não estava, e foi a que virou
  prova. Se uma delas mudar de forma, a absolvição precisa ser refeita.
- **Nada aqui foi aplicado no banco**: a triagem é read-only e não gerou migration.
