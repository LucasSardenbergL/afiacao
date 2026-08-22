# O sensor de desfecho do motor Farmer — instalar antes de calibrar

> 2026-08-21. Instala a superfície que registra se uma recomendação virou venda.
> Não calibra nada: sem histórico de desfecho não há contra o que calibrar.
> Migration `20260821194411_farmer_recomendacao_desfecho.sql` · prova em
> `db/test-farmer-desfecho.sh`.

## O estado que motivou

Medido em produção com `psql-ro` em 2026-08-21:

```
status=expirado n=16233
status=pendente n=1083
offered=0 accepted=0 rejected=0 margin=0 tempo=0
```

**17.316 recomendações e ZERO desfecho em todas as cinco colunas que existiam para
registrá-lo.** O vocabulário `'ofertado'|'aceito'|'rejeitado'` está no CHECK de
`status` desde fev/2026 e nunca foi escrito: `markAsOffered/Accepted/Rejected` foram
removidos em 2026-07-21 por não terem chamador, e a tela nunca ofereceu ação de
resultado. `farmer_category_conversion` tem 0 linhas pelo mesmo motivo, e é por isso
que `TAXA_CONVERSAO_CROSS_SELL/UP_SELL` e `FATOR_COMPLEXIDADE` seguem ARBITRADOS.

É o padrão de [`fase-sem-sinal.md`](fase-sem-sinal.md) na forma mais pura: a fase
N+1 (calibrar o gate `clusterAdherence < 0.03` e os pesos do ranking, corrigidos em
#1841) exige um sinal que a fase N nunca produziu.

## A descoberta que mudou o desenho

**A UI não tem o `id` da linha.** O motor calcula as recomendações em memória e a
`farmer_recomendacoes_substituir` as insere separadamente; os ids gerados nunca
voltam ao browser (`Recommendation.id` é opcional e não é preenchido nesse fluxo).
Não existe handle para um `UPDATE by id` — o writer precisa localizar a linha pela
**chave de negócio** `(farmer_id, customer_user_id, product_id, recommendation_type)`.

Medido: entre as 1.083 pendentes essa chave é única (1.083 grupos, 0 duplicatas).

## O que o `/codex` xhigh derrubou

O desenho original tinha três botões — "Ofertei" / "Aceitou" / "Recusou" — com a
RPC aceitando `pendente` e `ofertado` como origem e desempatando por
`ORDER BY created_at DESC LIMIT 1`. O parecer adversário matou o primeiro botão com
um cenário concreto:

1. R1 nasce `pendente`; a vendedora marca "Ofertei" → R1 vira `ofertado`.
2. O recompute expira só as `pendente` — R1 **sobrevive** (é o que queremos).
3. O motor recomenda a mesma chave e insere R2 `pendente`.
4. A vendedora marca "Aceitou" pensando em R1 → há **duas** linhas elegíveis, e a
   RPC carimba a errada.

O aceite ficaria colado ao `run_id`, `p_ij` e afinidade de **R2** — um cálculo que
ela nunca viu. `ORDER BY` não transforma a chave em identidade: só torna a
atribuição errada determinística.

> **A lição transferível:** o dado errado é pior que dado nenhum. Contra dado
> ausente ninguém calibra; contra dado errado alguém calibra **com confiança**.

Três correções entraram por causa do parecer:

| Achado | Correção |
|---|---|
| Estado intermediário cria a ambiguidade | `'ofertado'` fica **fora** do escopo. Com só `pendente` elegível, e a RPC de substituição expirando todas as pendentes antes de inserir, a chave volta a ser identidade. |
| Nada garante unicidade da chave | Guard **FD006**: mais de uma linha elegível ⇒ **recusa**, nunca escolha (precisão > recall). Índice único parcial foi recusado — derrubaria o recompute no dia em que o motor emitisse duas linhas iguais no mesmo lote. |
| CHECK valida estado, não transição | Trigger `trg_frec_desfecho_imutavel`. `authenticated` tem `w` direto na tabela (`relacl` medido em prod), então um UPDATE podia reescrever um desfecho deixando o estado final coerente. |

E um achado de UX no mesmo parecer: a tela lê o resultado do motor **em memória**;
uma linha `ofertado` sumiria do próximo cálculo e a vendedora nunca mais alcançaria
o card para registrar o desfecho que interessa.

## O bug que só o teste executando pegou

A primeira correção do CHECK de motivo era:

```sql
(status = 'rejeitado' AND rejection_reason IN ('preco', ...))
OR (status <> 'rejeitado' AND rejection_reason IS NULL)
```

Com `status='rejeitado'` e `rejection_reason IS NULL`: `NULL IN (...)` devolve
**NULL**, o ramo inteiro vira NULL, e **um CHECK que resulta em NULL é considerado
SATISFEITO pelo Postgres**. A constraint deixava passar exatamente o caso que
existia para barrar — recusa sem porquê. Corrigido com `rejection_reason IS NOT NULL`
antes do `IN`.

Não foi pego por leitura: foi o assert 18 do harness PG17 ficando vermelho. É o
motivo nº 1 da skill `prove-sql-money-path` — PL/pgSQL e CHECKs são late-bound.

## A prova

`db/test-farmer-desfecho.sh` — **29 asserts, 0 falhos, 4 falsificações com dente**:

- **controle positivo** — a fixture produz ofertas e o zero de partida é real;
- o desfecho **sobrevive ao recompute** (statement verbatim da RPC de prod), e o
  complemento: nenhuma linha com desfecho pertence ao conjunto que ela expira;
- `actual_margin`/`time_spent_seconds`/`offered_at` seguem **NULL**, não 0;
- o **gestor** não registra na carteira alheia, e a oferta da vendedora fica intacta;
- as falsificações removem o gate `auth.uid()`, o CHECK, a trigger e o guard de
  ambiguidade — cada assert correspondente fica vermelho.

## A falsificação do vitest encontrou DOIS asserts de teatro

O harness SQL já falsificava. Ao aplicar a mesma disciplina aos testes de
componente, duas sabotagens saíram **verdes** — ou seja, dois asserts não provavam
o que o nome deles dizia:

| Sabotagem | Por que ficou verde |
|---|---|
| Remover o guard `isImpersonating` do **hook** | `fireEvent.click` num botão `disabled` **não dispara o handler**. O assert provava o `disabled` do COMPONENTE e nada sobre o hook — justamente a camada que um POST direto alcançaria. |
| Trocar a trava `useRef` por `useState` | O `fireEvent` do RTL passa por `act()`, então o `setState` já fez flush quando o segundo clique chega. O teste nunca reproduziu o "mesmo tick" que a ref existe para cobrir. |

> **A classe:** testar defesa em profundidade **através da UI** só prova a camada de
> cima. Se a camada de baixo tem razão de existir, ela precisa de um teste que
> **pule a de cima** — aqui, uma sonda que chama o hook direto, sem botão no meio.

É a irmã em TypeScript do `WHEN OTHERS THEN 'OK'` do SQL: o teste passa, e o que ele
mede não é o que o nome promete. As seis sabotagens finais (guard da lente, motivo
fabricado, erro do banco ignorado, `ref`→`useState`, recusa sem porquê, e `FD004`
sugerindo retry) derrubam testes **nomeados**, não "algum teste".

## Fora de escopo (deliberado)

- **`'ofertado'`** volta quando a UI tiver o `id`, o que exige a
  `farmer_recomendacoes_substituir` devolver os ids e o hook renderizar as linhas
  persistidas. Entrega própria, sobre o arquivo mais quente do domínio.
- **Margem realizada.** `actual_margin` fica NULL: ninguém sabe a margem no
  momento do clique, e 0 entraria nas médias como resultado apurado.
- **Calibrar o gate e os pesos.** É a fase seguinte, e só começa quando esta query
  tiver linhas.

## Quando medir (é query, não recado)

**A query só é legível depois de expediente decorrido — e expediente não é relógio
de parede.** O Publish foi **sexta 21/08 às 22:40 BRT**; à 00:13 de sábado nenhum
minuto de carteira havia corrido. Mas esperar não era o remédio, e a query da
precondição é que mostrou por quê.

### Medido em 2026-08-22 00:20 BRT (psql-ro) — a coorte está VAZIA e o dono é o founder

```
geradas_na_janela = 0        (nenhuma linha desde o Publish: a razão seria 0/0)
```

| farmer | clientes na carteira | papel | recs total | **pendentes** | última atividade |
|---|---|---|---|---|---|
| `414a9727` | 3.858 | **master (o founder)** | 16.626 | **1.083** | 21/08 (ontem) |
| `700657a1` | 1.530 | employee | **0** | 0 | **nunca** |
| `33f59dc7` | 1.245 | employee | 690 | **0** | 10/04 (**134 dias**) |

São **3 farmers com carteira**, não 1 — e o dono das 1.083 pendentes é a conta do
**founder**, não uma vendedora. Como os botões só existem em card `pendente`, os
dois vendedores reais têm **zero card clicável**: não é "não clicaram ainda", é que
**não há o que clicar**. Um abriu a tela uma vez, há 134 dias; o outro nunca abriu.

**Esperar não produziria sinal sobre vendedor — mediria o founder clicando nos
próprios botões.** É o `MONOUSUARIO` de [`fase-sem-sinal.md`](fase-sem-sinal.md)
(gatilho `db/gatilho-farmer-fase2.sql`, #1865) chegando ao sensor de desfecho pelo
mesmo caminho: *"a fase seguinte é INSTALAR O USO nos demais farmers com carteira —
não esperar."*

> A armadilha é auto-referente e já mordeu duas vezes no domínio: em #1865 o ato de
> verificar renovava `exec_7d` e **apagava** o alarme; aqui o ato de verificar é o
> que **cria** a coorte. Em ambos, quem olha vira a amostra.

A calibração continua bloqueada, e agora sabe-se por quê: não falta tempo, falta
**usuário**. A fase seguinte não é medir de novo — é a tela chegar aos dois
vendedores com carteira.

Antes da query de adoção, a da precondição — se o motor não rodou, não há coorte:

```sql
SELECT max(created_at) AS ultima_geracao, count(*) AS geradas_na_janela
FROM farmer_recommendations
WHERE created_at >= '2026-08-22 01:40:00+00';   -- Publish do sensor
```

```sql
SELECT
  count(*)                                                        AS geradas,
  count(*) FILTER (WHERE accepted_at IS NOT NULL)                 AS aceitas,
  count(*) FILTER (WHERE rejected_at IS NOT NULL)                 AS recusadas,
  count(*) FILTER (WHERE status='expirado'
                     AND accepted_at IS NULL AND rejected_at IS NULL) AS expiradas_sem_interacao,
  count(*) FILTER (WHERE status='pendente')                       AS pendentes_sem_interacao
FROM farmer_recommendations
WHERE created_at >= '<data do Publish>';   -- antes disso o sensor não existia
```

As cinco categorias são **distintas**: `expirado` significa "substituída sem
interação registrada", nunca "rejeitada" — ausente ≠ zero.

`aceitas/(aceitas+recusadas)` chama-se **"aceitação entre desfechos registrados"** —
não é conversão nem precisão do motor. O denominador de adoção é
`(aceitas+recusadas)/geradas` na coorte, e mesmo ele é um **proxy**: mede cobertura
entre recomendações GERADAS, não entre as VISTAS. Não há evento de impressão.

Vieses conhecidos, a carregar para a calibração: quem registra aceite e omite recusa
infla a taxa; `sem_estoque` e `prazo_entrega` são falha **operacional**, não erro do
motor, e penalizariam a afinidade se contados junto.

## Se a query voltar zerada — são TRÊS casos, não dois

| Leitura | O que aconteceu | Próximo passo |
|---|---|---|
| **`geradas = 0`** | O recompute não rodou na janela: a coorte está **vazia** e o card nunca chegou a ser oferecido. `(aceitas+recusadas)/geradas` é `0/0` — **indefinido**, não "0% de adoção". | Rodar a query de precondição acima. Nada a concluir sobre uso. |
| `geradas > 0`, desfechos 0, **tentativa > 0** | O banco está recusando o clique. | Códigos FD001–FD007 da migration. É código. |
| `geradas > 0`, desfechos 0, **tentativa 0** | Ninguém clicou. | Conversa com a vendedora. Não é commit. |

A tentativa vem do evento `recomendacao.desfecho_clicado` (PostHog): ele mede o
**clique**, não a linha gravada — é o que separa a segunda linha da terceira.

**A classe:** `geradas = 0` é o `Number(null) === 0` da adoção. Zerar numerador e
denominador ao mesmo tempo produz uma tela **idêntica** à do desuso, e a versão
anterior desta seção mandava ler as duas como "a superfície está no ar e ninguém a
usa" — uma conclusão sobre a vendedora tirada de um motor que talvez não tenha
rodado. Irmã da regra de corte por ranking: o denominador precisa ser conferido
**antes** da razão que ele sustenta.
