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

1. ~~**Ampliar o eixo de `touchesSensitive` para compras**~~ — **FEITO em 2026-08-14**, §7 abaixo.
2. ~~**`public.reposicao_pos_marcador`**~~ — **FEITO** junto, no mesmo PR (§7.2). O PR paralelo
   mergeou (`20260814000125`), o gate foi medido em prod e a RPC entrou no manifest.

---

# 7. O eixo de COMPRAS entra no contrato — e as 12 reveladas são baselinadas (2026-08-14)

> Follow-up 1 do §6, fechado. A Parte B passou a exigir classificação também no eixo **comercial de
> compras**. Isso revelou **12 SECDEF** sem classificação; cada uma foi classificada pelos **grants
> REAIS de prod**, medidos um a um. Nenhuma regra do detector foi afrouxada.

## 7.1 O que mudou, e por que a medição é a entrega

`SENSITIVE_*` ([scripts/lib/authz-contract.ts](../../scripts/lib/authz-contract.ts)) ganhou 4 tokens
— tabelas `pedido_compra_sugerido`, `purchase_orders_tracking`; colunas `fornecedor_nome`,
`portal_protocolo`. Os 4 foram conferidos como objetos REAIS de prod antes de entrar (token morto
seria contrato falso na direção oposta): `fornecedor_nome` existe em **25 tabelas**, e é ele que dá
alcance ao eixo.

Com os tokens e **sem** classificar: `bun run authz:check` → **exit 1, exatamente 12 erros**. Esse
vermelho é o produto intermediário que prova que o eixo tem dente — sem ele, "verde depois de
classificar" não distinguiria cobertura de silêncio.

A fronteira entre as duas listas **não é julgamento de estilo, é medição**:

| lista | significa | como se decide |
|---|---|---|
| `AUTHZ_MANIFEST` | alcançável por `authenticated`/`anon` — fecha por **gate no corpo** | `has_function_privilege('authenticated', oid, 'EXECUTE')` = **t** |
| `ACKNOWLEDGED_SENSITIVE` | fecha por **PRIVILÉGIO** (sem EXECUTE para essas roles) | o mesmo, = **f**, com `proacl` cru confirmando que não é `NULL` (que valeria PUBLIC) |

Medido em prod (`psql-ro`, 2026-08-14 — 16 nomes pedidos, **16 linhas devolvidas**, nenhum overload):

| resultado | funções |
|---|---|
| `auth=SIM · anon=NAO · svc=SIM` → **AUTHZ_MANIFEST** | `converter_sugestao_em_campanha_flat`, `pedido_compra_split` (+ `reposicao_pos_candidatos`, já lá) |
| `auth=NAO · anon=NAO · svc=SIM` → **ACKNOWLEDGED** | as outras 10 (+ `_data_health_compute` e `reposicao_cold_start_parametros`, já lá — reconfirmadas) |

`anon` não alcança **nenhuma** das 12. As 10 fechadas têm ACL explícito
(`postgres=X # service_role=X # sandbox_exec=X`): o EXECUTE de `authenticated` não está lá, e não
está **por omissão** — nenhuma tem `proacl` NULL.

O consumidor de cada uma das 10 também foi verificado (`cron.job`, `pg_trigger`, grep nas edges),
porque "não é executável por `authenticated`" responde quem **não** chama; a justificativa precisa
dizer quem **chama**: 3 por cron (`detectar-outliers-diario`, `reposicao-alerta-pedido-minimo`,
`sayerlack-retry-orfaos`), 5 por edge com `service_role`, 1 só pelo tick de cron
(`reposicao_pedido_auto_aprovavel`, medida em `pg_proc.prosrc`) e 1 é **função de TRIGGER**
(`set_status_envio_portal_on_disparo`, `RETURNS trigger`, via `trg_set_status_envio_portal`) — essa
não tem sequer rota PostgREST.

> ⚠️ Pôr gate de papel numa dessas 10 **quebraria** o cron: pg_cron roda sem JWT ⇒ `auth.uid()` NULL
> ⇒ `has_role` false ⇒ higiene INAGENDÁVEL. É a mesma armadilha já anotada no fim do `AUTHZ_MANIFEST`
> para `private.expirar_reservas_vencidas_job`. ACK aqui não é indulgência: é o modelo de fecho certo.

## 7.2 As 3 que entraram no manifest — e a que o eixo NÃO revelou

Antes de registrar, o detector foi rodado contra o **corpo real** de cada uma (lição do §3), e o
corpo do repo foi comparado com o de prod por md5 do `prosrc` normalizado:

| função | gate real | `blocksOnCall` | md5 repo vs prod |
|---|---|---|---|
| `converter_sugestao_em_campanha_flat` | `IF auth.uid() IS NULL OR NOT (has_role(employee) OR has_role(master)) THEN RAISE` | ✅ | **igual** (`a2ea61e7…`) |
| `pedido_compra_split` | `IF auth.uid() IS NOT NULL THEN IF NOT (has_role…) THEN RAISE` | ✅ | **igual** (`9ccb9dd5…`) |
| `reposicao_pos_marcador` | `(SELECT cap_compras_ler(…)) IS NOT TRUE` (forma initplan) | ✅ | **igual** (`99ebc805…`) |

⚠️ **A forma do `pedido_compra_split` tem um limite que ficou escrito na entrada:** com `auth.uid()`
NULL o gate não roda. Isso não abre buraco de browser, e a razão é **medida, não presumida** —
`anon` não tem EXECUTE, então o único caminho de uid NULL é `service_role`/`postgres`. Se um dia
`anon` ganhar EXECUTE, a função vira anônima e o gate a deixa passar.

**`reposicao_pos_marcador` (follow-up 2) NÃO foi revelada pela ampliação** — ela lê
`reposicao_pedidos_compra_run` e não cita nenhum dos 4 tokens. Entrou por registro **manual**, pela
mesma rota da irmã. Isso é o dado honesto sobre o alcance: ampliar o eixo **reduz** o ponto cego,
não o elimina.

## 7.3 Evidência

| o quê | resultado |
|---|---|
| baseline `authz:check` (antes de tudo) | exit **0**, 1 aviso (o `omie_sync_identity_snapshot` não-parseável, pré-existente) |
| `authz:check` com tokens, **sem** classificar | exit **1**, **12 erros** — o dente do eixo |
| `authz:check` final | exit **0**, **o mesmo 1 aviso** — nenhuma dívida nova, nenhuma escondida |
| `bun run test` | **671 arquivos / 6.256 testes**, exit 0 |
| os 2 arquivos de teste de authz | 67 → **86** testes: **delta +19**, exatamente os escritos |
| `bun run scripts:typecheck` | exit **0** |
| `bunx eslint` nos 5 arquivos tocados | exit **0**, zero achados |

> A tabela acima foi medida **duas vezes**: a `main` andou **7 commits** durante a entrega (2 deles
> criando migrations). Rebase + **re-medição** antes de fechar — 15 reveladas, **0 sem
> classificação**, todos os números idênticos. É a regra do #1743 aplicada: base defasada dá achado
> falso, e neste caso o achado falso seria "o baseline está completo".

**Falsificação** (harness próprio; asserção pelo **exit code** do vitest, que não depende de locale):

| | sabotagem | esperado | obtido |
|---|---|---|---|
| C0/C1 | nenhuma (canário, antes e depois) | verde | exit 0 |
| F1 | tokens do eixo removidos do contrato | vermelho | exit 1 — e as **3** que caem são exatamente as do eixo de compras (causa conferida, não só o exit) |
| F2 | 1 chave de `ACKNOWLEDGED` removida | vermelho | exit 1 |
| F3 | 1 entrada de `AUTHZ_MANIFEST` removida | vermelho | exit 1 |
| F4 | chave de ACK com **typo** (`…claim_id`) | vermelho | exit 1 |
| F5 | mesma chave nas **duas** listas | vermelho | exit 1 |

F4 é o teste que separa "a lista está certa" de "a lista tem 10 strings dentro": chave escrita
errada não silencia nada. F5 protege contra o contrato que se contradiz — o manifest venceria em
silêncio e a justificativa do ACK seria mentira.

Os testes de manifest sabotam o **arquivo real** da migration, e o recorte é por função: a linha de
gate `IF auth.uid() IS NULL OR NOT (has_role…)` aparece **5×** em `20260512101121`, e a primeira
pertence a `fin_consolidado_intercompany` — um `replace` ingênuo teria sabotado a função errada e
deixado o teste verde pelo motivo errado.

## 7.4 Limites declarados e o que sobra

1. **`DROP FUNCTION` + `CREATE FUNCTION` reseta o ACL.** `CREATE OR REPLACE` o preserva; o par
   DROP+CREATE não, e a função renasce com o default privilege do Supabase (que concede às roles
   nomeadas). É o irmão exato do vetor `RECRIACAO` que a Parte C pega em **tabela**
   ([sentinela-grants-tabelas-fechadas.md](sentinela-grants-tabelas-fechadas.md)) e que **ninguém
   pega em função**. Enquanto não houver esse detector, a reconfirmação das 12 entradas por
   privilégio é o audit read-only — o mesmo `has_function_privilege` desta entrega.
2. **Migration que reescreve por `regexp_replace` é invisível ao gate estático** — e isto deixou de
   ser hipótese durante esta própria sessão: a `20260814022626` (#1737) recria
   `reposicao_pos_candidatos` aplicando `regexp_replace` sobre `pg_get_functiondef` da definição
   VIVA, sem escrever nenhum `CREATE FUNCTION`. O parser não a vê, então o *last-writer* do repo
   continua sendo a `20260814000125`. A Parte A segue medindo uma definição válida (não há
   falso-verde), mas **não está medindo a última**. O manifesto já registrava que o FU4-G fizera
   isso uma vez; agora aconteceu de novo, na mesma função, 2 dias depois. É padrão, não acidente.
3. **Drift medido, fora do escopo deste PR:** o corpo de `reposicao_pos_candidatos` em prod
   (`md5 63296444…`) **não** é o do repo (`2439966a…`) — prod não tem o diagnóstico do #1737
   (conferido por marcador no `prosrc`). A `20260814022626` mergeou e **ainda não foi aplicada** no
   SQL Editor. As outras 3 funções desta entrega batem byte a byte.
4. O gate continua provando que a chamada **governa um ramo alcançável que levanta exceção** — não
   que a exceção acontece para quem deve. Isso é asserção EXECUTADA (harness PG17), inalterado.
