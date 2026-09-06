# A 3ª via do mesmo TOCTOU: aprovar podia gravar por cima de um cancelamento

`supabase/migrations/20260906151715_aprovar_pedido_guard_atomico.sql` ·
`db/test-aprovar-pedido-guard.sh` · money-path de reposição

## O defeito

O corpo VIVO de `public.aprovar_pedido_sugerido(bigint, text)` decidia sobre um **retrato** e
gravava sem reconferir:

```sql
SELECT * INTO v_pedido FROM pedido_compra_sugerido WHERE id = p_pedido_id;  -- retrato
IF v_pedido.status NOT IN ('pendente_aprovacao','bloqueado_guardrail') THEN … END IF;
UPDATE pedido_compra_sugerido SET status='aprovado_aguardando_disparo' …
 WHERE id = p_pedido_id;   -- grava SEM repetir o predicado, sem lock
```

Em READ COMMITTED (default do Supabase) o `SELECT` **não bloqueia**: lê o snapshot antigo. Uma
aprovação concorrente a um cancelamento lê `pendente_aprovacao`, passa no guard, **espera no
lock** e, quando o cancelamento commita `cancelado_humano`, o `UPDATE … WHERE id` continua
casando e carimba a aprovação **por cima**. O pedido volta à fila do disparador e vira compra
real no Omie depois de ter sido cancelado por um humano.

## O fix

Uma única instrução, com o predicado no `WHERE` da escrita — o padrão da 1ª via
(`20260905224959`), **não** o da 2ª. A 2ª (`remover_itens`) precisou de `FOR NO KEY UPDATE`
porque lá são três escritas e o predicado vive em **outra tabela** (o EvalPlanQual re-avalia a
linha ALVO travada, não o pai). Aqui a escrita é uma só e o predicado está na própria linha
alvo, então o EvalPlanQual basta: o UPDATE espera o commit do cancelamento, re-avalia o
predicado contra a versão NOVA, não casa, e a RPC recusa com 0 linhas.

Allowlist (`IN ('pendente_aprovacao','bloqueado_guardrail')`), não denylist — o mesmo conjunto
que a função já exigia, agora como política de servidor.

## O que quase passou batido: `{"error": null}` é lido como SUCESSO

A 1ª via já tinha ensinado que `'texto' || NULL` colapsa a string inteira para NULL. **Aqui isso
morde mais forte**: `erroDoJsonb` em `src/components/reposicao/pedidos/aprovar-disparar.ts` faz
`if (e == null) return null` — ou seja, trata `error: null` como **ausência de erro**. Uma
recusa nesse formato não curto-circuitaria: o fluxo seguiria para o disparo e o operador veria
desfecho de sucesso para uma aprovação recusada. Falha **aberta**. Hoje é inalcançável
(`status` é NOT NULL, medido na PROD); o `COALESCE` das mensagens é a defesa se o NOT NULL cair.

Na direção oposta, a ausência do NOT NULL faria `status IN (…)` virar NULL, a linha não seria
atualizada e a RPC recusaria — falha **fechada**. Os dois lados foram considerados de propósito.

## Método — o que encontrou isto

O achado veio de parecer Codex (gpt-6-astra · max) durante a entrega da 2ª via, e foi
**confirmado contra a produção** com `~/.config/afiacao/psql-ro` lendo `pg_get_functiondef`.
Isso importa: o `supabase/schema-snapshot.sql` não prova a definição viva — apply manual diverge
do repo, e a última a recriar vence. Pré-voo lê a PROD, não o repo.

A lição de método das entregas irmãs (procurar a fronteira pelos **efeitos**, não pelo nome) se
confirmou de novo: a 3ª via não aparecia em nenhuma busca por quem chama a 2ª.

## A prova (`db/test-aprovar-pedido-guard.sh` — 47 asserts, 0 falhas)

Rodada nos **dois** locales, `exit 0` colado nos dois:

```
=== RESULTADO: 47 OK, 0 FAIL (lc_messages=C) ===              VEREDITO_EXIT=0
=== RESULTADO: 47 OK, 0 FAIL (lc_messages=pt_BR.UTF-8) ===    VEREDITO_EXIT=0
```

O controle do eixo de locale confirmou que o servidor realmente falava pt-BR na 2ª rodada
(`ERRO: divisão por zero`) — sem esse controle, "rodei nos dois" seria alegação, não medição.

O centro é o grupo R, com **barreira observada** (`pg_blocking_pids` pollado até ver B bloqueada,
e só então A é liberada — `sleep` não é barreira):

- **R1 (baseline VERMELHO)** — o corpo **velho real**, copiado byte-a-byte da PROD e só
  renomeado, termina em `aprovado_aguardando_disparo|lucas|sim`: a aprovação **corrompeu** o
  cancelamento. Sem R1 corrompendo, R2 verde não provaria nada — poderia ser a corrida nunca ter
  acontecido.
- **R2 (a fronteira)** — mesma corrida, corpo novo: `cancelado_humano|<null>|sim`. Recusou e não
  tocou a linha.
- **F7 falsifica o próprio R2** — corrida idêntica, mesma barreira, mesmo lock, mas A leva o
  pedido a um status **ainda dentro** da allowlist. A fronteira **aceita**. Verde aqui + verde em
  R2 = a recusa de R2 veio do *status relido*, não de "esperar no lock" (que recusaria sempre).

As sabotagens F1–F6 atacam uma camada por vez, todas com **controle verde na mesma invocação**
(F0 aplica o arquivo intacto e o laço aborta antes do 1º `sed` se o controle falhar). F6 merece
nota: troca `atualizado_em` por uma coluna inexistente — o `CREATE OR REPLACE` **aceita** (plpgsql
é late-bound) e só o assert de EXECUÇÃO pega. É a prova de que aquele assert não é decorativo.

## Dois bugs que eu mesmo pus no harness (e o que ensinam)

1. **`boolean::text` no psql imprime `true`, não `t`.** 12 asserts ficaram vermelhos por
   formatação do literal esperado, não por defeito no código. Um assert que falha por formatação
   não diz se mede alguma coisa — é ruído que compete com sinal.
2. **Variável atribuída dentro de `$( )` não chega ao pai.** `corrida()` é sempre chamada em
   substituição de comando, que é **subshell**: a global com o caminho da saída de B morria ali e
   o pai lia string vazia. Aqui falhou ruidosamente, mas essa é a *forma* de um falso verde — com
   um `[ -f "$X" ] &&` na frente, teria passado calada. **Estado que atravessa subshell tem de ser
   ARQUIVO, não variável** — o caminho passou a ser fixo.

## Fica em aberto (dito para não ser lido como fechado)

- O **cenário B** da 1ª via continua P1 aberto: o disparador que já selecionou a linha cria o PO
  no Omie e grava por cima de um cancelamento. Fechar exige claim atômico **no disparador**
  (coluna de claim dedicada), com deploy manual de edge. Ver
  `docs/historico/guard-fora-da-escrita-nao-e-guard.md`.
- **ACL:** `aprovar_pedido_sugerido` e `cancelar_pedido_sugerido` ainda têm `anon=X/postgres` no
  ACL da PROD (a 2ª via já revogou o dela). Como as duas são SECURITY INVOKER e a tabela tem RLS
  ligada, anon é barrado na tabela — é defesa em profundidade faltando, **não** buraco aberto.
  Não mexido aqui de propósito: mudar ACL é decisão separada, fora do escopo de um fix de TOCTOU.
- **Varredura:** o mesmo regex (`UPDATE … pedido_compra_sugerido` + `INTO`) lista na PROD 9
  funções; 3 são estas vias e `iniciar_envio_portal_pre_claim` já usa claim condicional em uma
  instrução. ~~Sobram 5 **candidatas não triadas**~~ — **TRIADAS em 2026-09-06: as cinco estão limpas**, com
  evidência por função em [varredura-toctou-cinco-candidatas.md](varredura-toctou-cinco-candidatas.md).
  Candidatas nunca foram achados: o regex só diz que há um UPDATE e algum `INTO`, não que a decisão
  está fora da escrita — e nas cinco ela não estava. A triagem rendeu um achado LATERAL: a
  absolvição de `reposicao_alerta_pedido_minimo_tick` no eixo **valor** depende de um `FOR UPDATE`
  que vive **no callee** `reposicao_pedido_auto_aprovavel`, invisível de quem lê o tick e aparentemente
  redundante lá (a função é read-only). Virou regressão executável: `db/test-tick-auto-aprovacao-corrida.sh`.
