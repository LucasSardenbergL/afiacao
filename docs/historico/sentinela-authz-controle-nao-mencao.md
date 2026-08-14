# Sentinela de authz que prova CONTROLE, não menção (2026-08-14)

> Follow-up do #1718/#1729. A defesa de autorização da RPC `public.reposicao_pos_candidatos(text)`
> era um bloco `DO $pos$` de regex sobre `pg_get_functiondef`. Ele foi trocado por duas defesas que
> valem para **toda recriação futura** e que provam **comportamento**, não presença de texto.
>
> **Prod estava correta o tempo todo.** Isto é endurecimento de defesa, não incêndio. Verificado por
> `psql-ro` em 14/08: corpo em prod byte-idêntico ao da migration (`md5 f92e1fef…`),
> `private.cap_compras_ler` chamado, `pode_ver_carteira_completa` ausente, grants só para
> `authenticated`/`service_role`.

## 1. A classe: sentinela textual prova PRESENÇA, nunca CONTROLE

A migration `20260813195914` fecha com três regexes sobre a definição viva:

| | padrão |
| --- | --- |
| `c_novo` | `private\.cap_compras_ler\s*\(\s*\(\s*SELECT` |
| `c_velho` | `pode_ver_carteira_completa\s*\(\s*\(\s*SELECT` |
| `c_guard` | `AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)` |

A revisão retroativa por `/codex challenge` (gpt-5.6-sol/xhigh) rodou esses regexes no motor do
próprio Postgres e achou três corpos que **passam** e não fazem o que o regex promete:

| forma sabotada | `c_novo` | `c_velho` | `c_guard` | o que de fato acontece |
| --- | --- | --- | --- | --- |
| gate em ramo MORTO — `IF false AND (SELECT cap_compras_ler(…)) IS NOT TRUE` | ✅ | não pega | — | ninguém é barrado |
| chamada nova só em COMENTÁRIO + gate VELHO real `pode_ver_carteira_completa(auth.uid())` | ✅ | **não pega** (a forma sem `((SELECT` escapa) | — | authz volta de master-only para "gerencial também vê" |
| guard só em COMENTÁRIO, `WHERE` real com `AND TRUE` | — | — | ✅ | volta o alerta falso de 13/08 (4 de 4 candidatos) |

O 2º é o pior: é exatamente a regressão que a pós-condição existe para barrar, numa
`SECURITY DEFINER` com `GRANT EXECUTE` a `authenticated` que devolve protocolo do portal,
fornecedor e a `resposta_canal` jsonb crua.

**Segundo defeito, independente:** o bloco `DO $pos$` executou **uma vez**. Não protege nenhuma
migration futura — e isso não é hipotético: o FU4-G (`20260720120000`) já reescreveu essa função uma
vez, por `regexp_replace`.

> A regra que o repo já tinha — "case a CHAMADA, não a MENÇÃO" — nasceu da falsificação F4 desta
> mesma migration e **não era suficiente**. Casar a chamada ainda é casar texto. O que separa
> menção de controle é executar.

## 2. O que entrou — duas camadas, e as duas eram necessárias

### 2.1 Estrutural: a RPC entra no `AUTHZ_MANIFEST` (vale para toda recriação)

O repo **já tinha** o mecanismo certo: a **Parte A** do `authz:check`
([scripts/authz-gate-check.ts](../../scripts/authz-gate-check.ts)) é last-writer por função, roda
`stripComments` antes de medir e exige o gate em **forma de bloqueio**, com fail-closed quando o
parser não extrai. Faltava a função estar registrada.

**Por que ela não estava** — e a lição, que vale para toda RPC nova: a Parte B (cobertura) só
*exige* classificação de SECDEF que toca o eixo **custo/preço/estoque** (`SENSITIVE_*` em
`scripts/lib/authz-contract.ts`). Esta RPC não toca nenhum desses tokens; o que ela vaza é dado
**comercial de compras**. A cobertura automática não a alcançava — e ninguém percebeu, porque
"o gate de CI está verde" foi lido como "a função está coberta".

### 2.2 Comportamental: as 3 formas viram falsificação executada

[db/test-pos-candidatos-guard-temporal.sh](../../db/test-pos-candidatos-guard-temporal.sh) ganhou
**N1/N2/N3**. Cada uma mede o **par**: os 3 regexes da pós-condição **APROVAM** o corpo sabotado
**e** o assert comportamental que ela mira fica **vermelho**. Só o par demonstra a tese — provar o
comportamento sozinho não diria nada sobre o regex, e provar o regex sozinho não diria que houve dano.

⚠️ **Correção ao plano original**, que supunha as três derrubando `D1` (não-staff → 42501):

| | sabotagem | assert que ELA quebra | por quê |
| --- | --- | --- | --- |
| N1 | ramo morto | **D1/D5** | o gate não executa: qualquer um entra |
| N2 | gate novo em comentário, velho real | **D4** | D1 fica **verde** — um customer é barrado pelos DOIS gates. Quem distingue é um `employee` com `commercial_role='gerencial'`: `pode_ver_carteira_completa` o libera, `cap_compras_ler` (master-only) não |
| N3 | guard em comentário | **G1** | guard temporal não é authz |

Foi preciso modelar `pode_ver_carteira_completa` fiel ao corpo de prod (master **ou** employee
gerencial/estratégico/super_admin) e criar a persona gerencial. Sem isso, N2 passaria despercebida.

## 3. As duas cegueiras do detector, MEDIDAS (não deduzidas)

Registrar a função exigiu rodar o detector contra a definição real primeiro. Ele reprovava:

| forma | `blocksOnCall` antes | correto |
| --- | --- | --- |
| **a forma REAL do repo** `(SELECT gate(…)) IS NOT TRUE` | `false` (lia como decorativo) | `true` |
| `(SELECT gate(…)) = false`, e com quebra de linha antes do operador | `false` | `true` |
| **ramo morto** `IF 1=0 AND NOT gate() THEN RAISE` | `true` | `false` |

- **Causa dos dois primeiros:** o wrapper `(SELECT …)` — idioma initplan do Supabase — quebra a
  adjacência entre o `)` da chamada e o operador de negação. Falha FECHADA, mas o efeito prático foi
  a RPC ficar **fora** do contrato: registrá-la deixava o CI vermelho por falso positivo, então
  ninguém registrou. Corrigido por `unwrapSelectScalar`, conservador em dois pontos (só SELECT
  escalar; só `(` seguido de `select`, para que `NOT outra(gate())` continue não contando).
- **O terceiro** é o caso 1 da tabela do §1, e o detector **aceitava**. Corrigido exigindo que o
  RAISE seja alcançável.

> **Lição transferível:** um detector calibrado só na forma canônica não vigia o código que existe.
> Antes de concluir que um eixo "não tem cobertura porque ninguém registrou", rode o detector contra
> o objeto real — pode ser que ele não consiga aceitar a forma correta.

## 4. Evidência

| o quê | resultado |
| --- | --- |
| baseline (5c3e6c2f, árvore provada limpa) | `663 arquivos / 6133 testes`, exit 0 |
| pós-mudança | `663 arquivos / 6147 testes`, exit 0 — **delta +14**, exatamente os testes escritos |
| `authz:check` antes e depois | exit 0, **0 erros novos, 0 dívida revelada** (mesmos 2 avisos) |
| harness PG17 | **28 OK / 0 FAIL** (era 21) |
| falsificação do gate de CI, `LC_ALL=C` **e** `pt_BR.UTF-8` | canário exit 0 / sentinela 0; sem-gate, ramo-morto e comentário → **exit 1, sentinela 1** nos dois locales. Sentinela `reposicao_pos_candidatos SEM gate`: ASCII, caixa fixa, sem `-i` |
| meta-falsificação do harness (o `par()` tem dente?) | esperado invertido → `27 OK / 1 FAIL`, só N1. `veredito()` cego → `25 OK / 3 FAIL`: D6 (canário do helper) + N1 + N2 |
| `shellcheck` do harness | 0 achados |

## 5. Limites declarados

- O gate de CI prova que a chamada **governa um ramo alcançável que levanta exceção**. Não prova que
  a exceção acontece para quem deve — isso é o harness PG17 (D1/D4).
- O guard de ramo morto pega o literal na **cabeça** da condição (`IF false AND …`, `IF (1=0) AND …`).
  Não pega `IF x AND false AND …`. Ampliar exigiria avaliar a expressão; o alvo declarado deste
  detector é regressão **acidental**, e a defesa contra evasão é a asserção executada.
- `NOT COALESCE(gate(), false)` (sem parênteses em volta do COALESCE) segue não sendo reconhecido —
  limitação **preexistente** e falha FECHADA: o autor reescreve na forma comum ou classifica.

## 6. Follow-ups deixados

1. **Ampliar o eixo de `touchesSensitive` para compras** (`fornecedor_nome`, `portal_protocolo`,
   `pedido_compra_sugerido`, `purchase_orders_tracking`): medido — revelaria **15 SECDEF** não
   classificadas. É entrega própria, porque classificar cada uma exige auditoria de grants em prod;
   classificar sem medir seria fabricar. Enquanto não for feita, **RPC nova do eixo compras não é
   coberta automaticamente** — registre à mão no manifest.
2. **`public.reposicao_pos_marcador`** — a sessão paralela do frescor do marcador
   (`claude/frescor-marcador-pos-candidatos`) cria essa SECDEF com o mesmo gate e a **mesma
   pós-condição por regex**. O padrão está se propagando. Registrar no manifest quando aquele PR
   mergear. (A recriação de `reposicao_pos_candidatos` naquela migration usa a forma idêntica de
   gate e **passa** neste gate — conferido antes deste PR.)
