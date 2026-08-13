# Registro de desfecho em 1 toque (Plano Tático)

> Spec de 2026-08-07. Continuação direta de [fila-plano-tatico.md](../../historico/fila-plano-tatico.md)
> (PR #1693), que deu **saída** à fila. Esta entrega ataca a outra metade: o **custo de captura**.
> Domínio: Farmer/Inteligência. Money-path (o dado alimenta margem e efetividade de carteira).

## O problema, medido

Produção via `psql-ro`, 2026-08-07 — depois de o cron `expirar-planos-taticos` rodar:

| status | linhas | com `actual_margin` | com `call_result` |
|---|---|---|---|
| `expirado` | 364 | 0 | 0 |
| `gerado` | 169 | 0 | 0 |

`farmer_recommendations`: 3.659 linhas, 100% `pendente`. `call_log`: parado desde 2026-06-09.
`farmer_client_scores`: 6.633 linhas recalculadas hoje.

**Tudo que depende de digitação manual está em zero; o que a máquina calcula sozinha está vivo.**
A fase 1 provou que a fila não era mais o gargalo — os 169 planos pendentes estão alcançáveis, com
7 dias de janela, ordenados por risco. E o desfecho continua em zero. O que resta é o formulário:
`RecordResultDialog` pede switch + select + **margem em R$** + duração, atrás de um card que
precisa ser aberto. A vendedora não sabe a margem durante a ligação, e não vai parar para calcular.

## Decisões do founder (2026-08-07)

1. **Cinco desfechos**, preservando o vocabulário já gravado: Vendeu (`venda_realizada`) ·
   Interesse futuro (`interesse_futuro`) · Não vendeu (`sem_interesse`) · Não atendeu
   (`nao_atendeu`) · Remarcou (`reagendado`). `interesse_futuro` fica porque comercialmente
   não é recusa.
2. **Botões na face do card**, sempre visíveis na fila de pendentes. É o único arranjo que
   entrega 1 toque de verdade — abrir o card antes já custa o que mantém o registro em zero.
3. **Os cinco concluem o plano.** A RPC viva força `status='concluido'`; tratar "não atendeu"
   como não-conclusivo exigiria alterar SQL. Fica como follow-up **medido**: se "não atendeu"
   sair sub-representado na primeira semana, é porque a vendedora evita o botão para não perder
   o plano — e aí a mudança de RPC volta com evidência, não com suposição.

## A descoberta que dispensou o SQL

`pg_get_functiondef` da PROD (não o repo — apply manual diverge):

```
registrar_resultado_plano(_plan_id uuid, _plan_followed boolean, _call_result text,
  _actual_margin numeric, _call_duration_seconds integer, _objection_type text DEFAULT NULL,
  _notes text DEFAULT NULL) RETURNS void
```

Os parâmetros não têm `DEFAULT`, mas **aceitam `NULL` explícito**; as colunas de destino são
todas nullable e a tabela não tem nenhuma CHECK constraint. Logo: **entrega 100% frontend**.
Sem SQL Editor, sem migration, sem `prove-sql-money-path`. Só 🖱️ Publish.

## Desenho

### Componente

`BotoesDesfecho.tsx` (novo, em `src/components/farmer/tacticalPlan/`) — cinco botões em duas
linhas, agrupados por semântica: **com conversa** (Vendeu · Futuro · Não vendeu) e **sem
conversa** (Não atendeu · Remarcou). Renderizado por `PlanCard` na face, sob
`plan.status === 'gerado'`. Desabilitado sob a lente "Ver como" (registro é write — mesmo
write-guard do dialog). Estado local de salvamento bloqueia toque duplo: a RPC recusa a segunda
gravação com "Plano já concluído" e o toast de erro puniria quem só tocou duas vezes.

`RecordResultDialog` **permanece** no expandido. Deixa de ser o único caminho e vira o caminho
detalhado (margem, duração, objeção, notas). Nenhuma capacidade é removida — e planos
`expirado` continuam registráveis por ele, já que os botões da face só servem à fila ativa.

### O payload — o coração

Um toque captura **um** fato. Todo campo que o toque não pergunta grava `null`, nunca zero:

| campo | 1 toque grava | por quê |
|---|---|---|
| `callResult` | valor do botão | é o dado que estamos capturando |
| `actualMargin` | `null` | não apurada. `0` entra em métrica como resultado real |
| `callDurationSeconds` | `null` | ninguém cronometrou. `0` afirmaria ligação instantânea |
| `planFollowed` | `null` **nos cinco** | o toque não pergunta se ela seguiu o roteiro |
| `objectionType` / `notes` | ausente | não perguntados |

O `planFollowed: null` nos **cinco** (e não `true` nos três com conversa) é o ponto que quase
passou: gravar `true` afirmaria adesão ao roteiro que ninguém declarou — o `|| 0` de sempre,
vestido de booleano. Quem quiser essa informação usa o dialog detalhado.

### As metades que faltavam

Corrigir só o writer deixa a correção inerte (`money-path.md` §2). Passar a gravar `null` em
massa acende quatro leitores que hoje são inertes porque **não há um único plano concluído**:

1. **`PlanCard`, resumo do concluído** — `plan.planFollowed ? 'Sim' : 'Não'` exibiria **"Não"**
   para todo registro de 1 toque: afirma que a vendedora ignorou o roteiro. Vira tri-estado.
2. **`PlanCard`, `Resultado: {plan.callResult}`** — mostraria `venda_realizada` cru. Passa a usar
   o rótulo legível do mesmo dicionário dos botões (fonte única).
3. **`parsePlan`** — `d.actual_margin ? Number(…) : undefined` trata **margem 0 apurada** como
   ausente. Espelho invertido do `|| 0`: aqui o número medido é que se perde.
4. **`getEffectivenessStats`** — `totalMargin += Number(d.actual_margin || 0)` dividido por
   `count` produziria média fabricada, diluída pelos não apurados; `followRate` idem, com `null`
   contando como "não seguiu". Passa a usar denominadores dos **apurados** e a degradar para
   `null` quando não houver nenhum. `profitPerHour` só considera planos com margem **e** tempo —
   razão entre um total de margem e um total de tempo de conjuntos diferentes não significa nada.

Não há consumidor de UI para `getEffectivenessStats` hoje, mas o dado que a alimenta é
exatamente o que esta entrega passa a produzir — é arma carregada, não código morto.

## Fora de escopo (deliberado)

- **Elo de margem com o Omie.** `sales_orders` só tem `whatsapp_conversation_id`; nada liga
  pedido a plano tático. Exige coluna nova + writer — trabalho de banco com desenho próprio.
  Até lá, margem `NULL` rotulada como não apurada é a resposta honesta.
- **Reviver `farmer_category_conversion`.** Esta entrega é o passo (1) da ordem obrigatória do
  post-mortem, e só ele.
- **Alterar `registrar_resultado_plano`.** Ver decisão 3.

## Validação

- `src/components/farmer/tacticalPlan/__tests__/BotoesDesfecho.test.tsx`: payload de cada botão
  com asserção **explícita** de `null` (não `0`, não `false`), toque duplo bloqueado, ausência
  fora de `gerado`, desabilitado sob a lente.
- `PlanCard.test.tsx`: "Plano seguido" não exibe "Não" quando `planFollowed` é `null`; margem
  `0` apurada continua aparecendo.
- `heavy bun run typecheck` e `heavy bun run test` com exit code capturado (`> log 2>&1; echo $?`).
- Manifesto: o glob `src/components/farmer/**` já dá dono ao arquivo novo — nada a registrar.

## A prova real

Não é o CI verde. É o dado aparecer. Uma semana após o Publish:

```sql
SELECT status, count(*), count(actual_margin), count(call_result)
FROM farmer_tactical_plans GROUP BY 1;
```

Se `concluido` continuar em 0, a entrega **não** funcionou — e isso é informação, não fracasso:
significa que o gargalo é adoção da tela, não custo do formulário. A hipótese desta sessão é
falsificável, e o teste é esse.
