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

1. ~~**`DROP FUNCTION` + `CREATE FUNCTION` reseta o ACL.**~~ **FECHADO em 2026-08-15 → §9.**
   `CREATE OR REPLACE` preserva o ACL; o par DROP+CREATE não, e a função renasce com o default
   privilege do Supabase. Era o irmão exato do vetor `RECRIACAO` que a Parte C pega em **tabela**
   ([sentinela-grants-tabelas-fechadas.md](sentinela-grants-tabelas-fechadas.md)) e que ninguém
   pegava em função. A **Parte E** agora pega — e a medição que a desenhou mostrou que o default
   privilege concede a **`anon`**, não só às roles autenticadas.
2. **Migration que reescreve por `regexp_replace` é invisível ao gate estático** — e isto deixou de
   ser hipótese durante esta própria sessão: a `20260814022626` (#1739) recria
   `reposicao_pos_candidatos` aplicando `regexp_replace` sobre `pg_get_functiondef` da definição
   VIVA, sem escrever nenhum `CREATE FUNCTION`. O parser não a vê, então o *last-writer* do repo
   continua sendo a `20260814000125`. A Parte A segue medindo uma definição válida (não há
   falso-verde), mas **não está medindo a última**. O manifesto já registrava que o FU4-G fizera
   isso uma vez; agora aconteceu de novo, na mesma função, 2 dias depois. É padrão, não acidente.
3. **O md5 de `reposicao_pos_candidatos` diverge entre repo e prod — e isso é ESPERADO, não deploy
   pendente.** ⚠️ Correção de uma leitura errada feita na entrega original: a divergência
   (`repo 2439966a…` vs `prod 63296444…`) foi lida como "a `20260814022626` não foi aplicada", e
   **foi** — medido em prod: a coluna `omie_po_inexistente_antes_de`, a função
   `reposicao_marco_pre_omie()`, o trigger `trg_po_inexistente_antes_de_guard` e o predicado causal
   dentro do corpo, **todos presentes** (e as colunas de frescor da `20260814000125` também).
   A causa da divergência é o item 2 acima: quem reescreve por `regexp_replace` produz um corpo que
   **por construção** não é byte-igual a nenhum `CREATE FUNCTION` literal do repo. As outras 3
   funções desta entrega — que são recriadas por `CREATE OR REPLACE` normal — batem byte a byte.
   > **Lição, e é a razão de esta correção valer mais que o erro:** num repo onde o apply é manual,
   > "md5 repo ≠ md5 prod" é um teste bom para função escrita por `CREATE OR REPLACE` e **inválido**
   > para função reescrita por `regexp_replace` — ali ele acusa deploy pendente **sempre**, mesmo com
   > tudo aplicado. Detector de drift precisa saber por qual TÉCNICA o objeto foi escrito.
   > O erro original piorou por um segundo motivo, banal e transferível: o marcador que usei para
   > "prod tem a mudança?" foi tirado do TÍTULO do PR (`parou`/`diagnóstico`), não do SQL — palavras
   > que nunca estiveram no corpo. **Marcador de presença sai do artefato, nunca da prosa sobre ele.**
4. O gate continua provando que a chamada **governa um ramo alcançável que levanta exceção** — não
   que a exceção acontece para quem deve. Isso é asserção EXECUTADA (harness PG17), inalterado.

---

# 8. A migration que reescreve a definição VIVA deixa de ser invisível (2026-08-14)

> Follow-up do §7.4 item 2, fechado. A Parte A é last-writer sobre o TEXTO das migrations e
> procura `CREATE [OR REPLACE] FUNCTION`. Quem recria a função aplicando `regexp_replace` sobre
> `pg_get_functiondef()` da definição VIVA não escreve nenhum `CREATE` — e o "last-writer" que a
> Parte A mede **não é a última definição**. Agora o CI vê, nomeia e para de afirmar o que não mediu.

## 8.1 A medição, que é a entrega

O detector foi rodado contra as **648** migrations, e o resultado foi conferido contra um oráculo
**independente**: o corpo VIVO das 19 funções do `AUTHZ_MANIFEST` em prod (psql-ro), comparado com
o last-writer do repo por md5 do corpo normalizado.

| | resultado |
|---|---|
| migrations com o padrão (`pg_get_functiondef` + transformação + `EXECUTE`) | **7 de 648** |
| …que tocam função do `AUTHZ_MANIFEST` | **3** |
| …**posteriores** ao last-writer ⇒ Parte A medindo a definição errada | **2**, cobrindo **3 funções** |
| funções do manifest cujo corpo em prod **difere** do last-writer do repo | **3**: `get_preco_cockpit`, `get_defasagem_cliente`, `reposicao_pos_candidatos` |
| o detector prevê exatamente esse conjunto | **precisão e recall 3/3**, zero falso positivo/negativo |
| `checkGate` no corpo **VIVO** das 19 | **OK nas 19** — não há falso-verde hoje |

Dois achados que só a medição dá:

- **`get_preco_cockpit` em prod já NÃO chama `pode_ver_carteira_completa`** (o E2 a trocou por
  `private.cap_custo_ler` via `regexp_replace`). O manifest ainda a lista como alternativa
  aceitável e o corpo do repo ainda a chama: o CI estava verde validando uma cláusula que prod
  não tem mais. Quem protege de fato lá é `has_role(employee|master)`, e ele satisfaz o `anyOf`.
  **PAGO em 2026-08-15** (vale também para a `get_defasagem_cliente`, onde a cláusula sobrara só
  como menção em comentário): as duas entradas do manifest perderam o `{ call:
  'pode_ver_carteira_completa' }` do `anyOf`. A remeasurement por psql-ro reconfirmou o fato e
  acrescentou um agravante que o §8.1 não tinha visto — **a cláusula nunca foi bloqueio nessas
  duas, nem no repo**: lá ela é `v_pode_num := pode_ver_carteira_completa(…)`, mascaramento de
  campo, a forma que o próprio manifest declara não ser expressável em `requiredGate`. Como
  `anyOf` fecha na primeira cláusula que BLOQUEIA, ela nunca era avaliada; e no único cenário em
  que importaria (se `has_role` sumisse do corpo) ela cairia em `weak` e reprovaria igual. Não era
  uma alternativa de gate enfraquecendo o contrato — era um **erro de categoria** que fazia o
  leitor inferir um caminho de bloqueio inexistente. Gate efetivo inalterado, nenhum buraco aberto
  nem fechado; `authz:check` e `authz:audit:prod` (19/19 no corpo VIVO) verdes com o gate enxuto.
  As duas entradas **permanecem** em `authz-reescritas-conhecidas.ts`: o que as põe lá é a
  divergência de MASCARAMENTO repo (`pode_ver_carteira_completa`) × prod (`cap_custo_ler`), que
  segue de pé — pagá-la é a migration de reconciliação do item 5 abaixo.
- **A `20260814022626` FOI aplicada em prod** — o §7.4 item 3 a registrou como "mergeou e ainda
  não foi aplicada", e o estado mudou desde então. Medido pelo predicado, não pelo md5: prod tem
  `omie_po_inexistente_antes_de <= m.finalizado_em` e **não** tem `omie_registrado_em <= …`; o
  last-writer do repo (`20260814000125`) tem exatamente o inverso. Confirmar o estado de aplicação
  ANTES de comparar repo×prod não é formalidade: sem isso o diff acusa a coisa errada.

## 8.2 Por que (b) e não (a) — decidido por medição, não por preferência

A direção (a) — *exigir que a migration carregue uma pós-condição EXECUTADA equivalente ao gate* —
**não tem dente, e isso é medido**: as 2 migrations que disparam o detector **já carregam**
pós-condição executada com `RAISE EXCEPTION` sobre a definição viva (a do E2 e o `DO $pos$` da
`20260814022626`). Um gate que exigisse isso ficaria **verde hoje** e não teria detectado nada.
Pior: o CI só consegue ver que a pós-condição **existe** textualmente — e o §1 deste mesmo
documento já provou que sentinela textual prova presença, nunca controle. Exigi-la estaticamente
compraria a ilusão de cobertura, que é o erro que o cabeçalho de `authz-contract.ts` adverte.

(c) — *audit read-only de prod* — é o **oráculo**, mas por construção não roda no CI (que não tem
psql-ro). Virou comando próprio e a âncora da baseline.

Sobrou **(b)**, fail-closed nomeando o arquivo, com precisão medida 3/3. E a semântica escolhida
importa mais que o mecanismo: **a Parte D não proíbe o padrão** — ele preserva `SECURITY DEFINER`,
`STABLE`, `SET search_path`, o gate e o ACL, que um corpo colado perderia, e foi assim que os
próprios gates `cap_custo_ler`/`cap_compras_ler` entraram. O que ela impede é o CI **afirmar o que
não mediu**.

## 8.3 O que entrou

- **`scripts/lib/authz-reescrita.ts`** — núcleo puro. Segue o data-flow do `EXECUTE` até
  `pg_get_functiondef` em 2 níveis (`v_def := pg_get_functiondef(…)` → `v_novo := regexp_replace(v_def, …)`
  → `EXECUTE v_novo`). Sem seguir a variável, a regra viraria "tem os dois no arquivo" e marcaria
  as **82** migrations que apenas ASSERTAM sobre a definição viva — ruído que desligaria o detector.
- **Parte D no `authz:check`** — erro `[REESCRITA_VIVA_NAO_MEDIDA]` nomeando arquivo e função;
  `[REESCRITA_VIVA_ALVO_OPACO]` (aviso) quando o alvo não é resolvível, listando os literais
  colhidos para o leitor julgar; silêncio quando um `CREATE OR REPLACE` posterior restabeleceu a
  auditabilidade.
- **`scripts/authz-reescritas-conhecidas.ts`** — baseline do passado (migration committada é
  imutável: "o autor reescreve" só vale para o futuro). A entrada **não** diz "está tudo bem": ela
  DECLARA o não-medido, com a prova executada e o `md5ProdEsperado`.
- **O verde parou de mentir** — a linha final do `authz:check` agora lista as funções do manifest
  que não são medidas estaticamente. Era o que faltava para "o gate está verde" deixar de ser lido
  como "a função está coberta" (§2.1).
- **`bun run authz:audit:prod`** (`db/audit-authz-reescritas-prod.ts`) — roda o **mesmo**
  `checkGate` no corpo VIVO das 19 e confere o md5 ancorado. É o que torna a baseline uma asserção
  verificável em vez de desculpa: reescrita nova por fora muda o md5 e acende, sem nenhum arquivo
  do repo ter mudado.

## 8.4 Evidência

| o quê | resultado |
|---|---|
| `bun run authz:check` | exit **0** — 8 avisos (3 baselinados + 4 alvo-opaco + 1 pré-existente), **0 erros novos** |
| `bun run authz:audit:prod` | exit **0** — gate vale nas 19 vivas, as 3 baselinadas batem no md5 |
| suíte completa (`vitest`) | **672 arquivos / 6.275 testes**, exit **0** (medida DUAS vezes: a `main` andou 4 commits durante a entrega; rebase + re-medição antes de fechar, e os números do detector ficaram idênticos — 7/648, 2 posteriores) |
| testes de authz (4 arquivos) | 112 → **129**: delta **+17**, exatamente os escritos |
| `scripts:typecheck` · `eslint` (7 arquivos) · `shellcheck` | exit **0** |

**Falsificação** — `db/test-authz-reescrita-falsificacao.sh`, **0 falhas em C e em pt_BR.UTF-8**:

| | sabotagem | esperado | obtido |
|---|---|---|---|
| C0/C1 | nenhuma (canário, antes e depois) | verde | exit 0 |
| F1 | entrada da baseline removida | vermelho | exit 1, `REESCRITA_VIVA_NAO_MEDIDA`, **nomeando arquivo e função certos** |
| F2 | detector desligado | vermelho | exit 1 — cai o teste anti-decoração da baseline |
| F3 | migration NOVA reescrevendo função do manifest | vermelho | exit 1, nomeando o arquivo novo |
| F4 | md5 da baseline sabotado | vermelho **só no audit** | `audit:prod` exit 1 `MD5_DIVERGIU`; `authz:check` segue 0 (não vê prod — é o desenho) |

F2 é o que separa "a baseline existe" de "o silêncio é justificado": com o detector morto, a
baseline vira decoração e nada mais a segura.

> Dois erros de MÉTODO desta sessão, registrados porque os dois quase viraram conclusão falsa:
> (1) a 1ª versão do audit trazia o `prosrc` achatando `chr(10)` para espaço — sem quebras de
> linha, `--` deixa de terminar na linha e o `stripComments` apaga o corpo inteiro a partir do
> primeiro comentário. O audit acusou **8 das 19 "sem gate em prod"**, todas falso-alarme; a
> correção é trafegar o corpo em base64. (2) o `restaurar()` da 1ª falsificação usava
> `git checkout -- scripts/` com trabalho **não commitado** e apagou a implementação. O harness
> promovido carrega um guard que aborta nesse estado — e a regra geral é **commitar antes de
> falsificar**.

## 8.5 Limites declarados e o que sobra

1. **O detector não simula a reescrita, de propósito.** Reproduzir `regexp_replace` do Postgres em
   JS produziria um corpo que ninguém executou — heurística sobre heurística, e o verde afirmaria
   cobertura inventada. Ele entrega o que é honesto: **saber que a Parte A não mede a última
   definição**, e nomear arquivo e função. Qual corpo saiu dali é asserção EXECUTADA ou `authz:audit:prod`.
2. **4 migrations ficam em `ALVO_OPACO`** (escolhem alvo por loop sobre `pg_proc`). Nenhum literal
   delas bate no manifest — o aviso diz quais foram colhidos —, mas um filtro dinâmico
   (`proname LIKE 'get_%'`) que alcançasse o manifest passaria como aviso, não erro.
3. **O `md5ProdEsperado` é conferido só pelo audit**, que roda on-demand. Entre duas execuções, uma
   reescrita manual no SQL Editor fica invisível — mesma natureza do audit de grants, e o motivo de
   os dois existirem separados do CI.
4. ~~**`DROP FUNCTION` + `CREATE FUNCTION` reseta o ACL**~~ — o item 1 do §7.4 foi **FECHADO em
   2026-08-15 pela Parte E** (§9): `authz:check` passou a vigiar o grant de EXECUTE das funções
   classificadas, e `bun run authz:funcoes:prod` mede o ACL vivo em prod.
5. **A reconciliação repo×prod de `get_preco_cockpit` e `get_defasagem_cliente` está ABERTA**
   (aberta pelo pagamento da dívida de contrato do §8.1, em 2026-08-15). O gate de bloqueio já é o
   mesmo nos dois lados — `has_role(employee|master)` —, então **não há risco de autorização
   pendente**; o que diverge é o MASCARAMENTO do numérico: repo `pode_ver_carteira_completa`, prod
   `cap_custo_ler`. Enquanto durar, a Parte A mede um corpo que não é o que roda e as duas seguem
   na baseline de reescritas. Fechar = uma migration `CREATE OR REPLACE` trazendo o corpo do repo
   para o de prod, o que as devolve à auditabilidade estática e apaga as duas entradas da baseline.
   Custo real: migration nova ⇒ ritual `lovable-db-operator` + apply MANUAL no SQL Editor, e o
   corpo colado precisa preservar `SECURITY DEFINER`/`STABLE`/`SET search_path`/ACL — exatamente o
   que o §8.2 lembra que um corpo colado perde de graça. Não é urgente; é dívida declarada.

---

# 9. O grant de EXECUTE de FUNÇÃO entra no contrato — Parte E (2026-08-15)

> Fecha o **§7.4 item 1**, reafirmado no §8.5 item 4 — o último item aberto de VIGILÂNCIA
> deste documento (o §8.5 item 5, aberto no mesmo dia, é dívida de RECONCILIAÇÃO repo×prod:
> não é ponto cego do CI, e não há autorização pendente nele).
> `CREATE OR REPLACE FUNCTION` PRESERVA o ACL; o par `DROP FUNCTION` + `CREATE
> FUNCTION` **não** — a função renasce com o default privilege do projeto. As Partes A/D julgam o
> GATE no corpo, a Parte C julga grant de TABELA, e **nada** julgava grant de FUNÇÃO.

## 9.1 A medição, que é a entrega

Duas fontes, porque nenhuma sozinha responde: as **651** migrations do repo e o banco de prod
(psql-ro). Medido antes de escrever qualquer detector.

| | resultado |
|---|---|
| `DROP FUNCTION` + `CREATE` da MESMA função | **18, em 12 migrations** |
| …que atingem `AUTHZ_MANIFEST` ou `ACKNOWLEDGED_SENSITIVE` | **5** (3 manifest, 2 ACK) |
| …que restauram o fecho com `REVOKE` **na própria migration** | **5 de 5** |
| **`pg_default_acl` de `public`, objtype `f`** | **`{postgres=X, anon=X, authenticated=X, service_role=X, …}`** |
| `pg_default_acl` de `private`, objtype `f` | **não existe** ⇒ função nasce `proacl` NULL = EXECUTE implícito a PUBLIC |
| funções classificadas medidas em prod | **40** (19 manifest + 21 ACK), 40 presentes, **0** ausentes |
| …alcançáveis por `anon` | **0** — a medição de 2026-08-14 continua valendo |
| …com `proacl` NULL | **0** |
| funções com âncora de ACL no repo | **39 de 40** |
| `GRANT ON ALL FUNCTIONS IN SCHEMA` / `ALTER DEFAULT PRIVILEGES` no repo | **0 / 0** |

Três achados que só a medição dá:

- **O vetor concede a `anon`, não só a `authenticated`.** O §7.4 dizia "as roles nomeadas"; o
  `pg_default_acl` diz *quais*. Uma função recriada em `public` nasce alcançável pela role
  ANÔNIMA. Em `private`, sem default privilege, ela nasce com `proacl` NULL, que é EXECUTE
  implícito a PUBLIC — e prod já tinha **3 funções `private` nesse estado**, duas delas SECDEF
  (`private.frec_sem_margem`, `private.fbrec_sem_margem`); nenhuma era do contrato, e por isso
  ficaram registradas aqui como achado colateral, não como entrega.
  **→ desfecho em §9.1.1 (2026-08-18): fechadas, e o "é pior" desta linha estava errado.**
- **O repo já usava o idioma certo sem que nada o exigisse.** As 5 recriações que tocam o
  contrato emitem o `REVOKE` de volta. A mais instrutiva é a `20260704120000`
  (`get_ultimos_precos_cliente`): `DROP` + `CREATE` + `REVOKE EXECUTE … FROM anon, PUBLIC`, sem
  `GRANT` a `authenticated` — que volta sozinho, pelo default privilege. O autor sabia do vetor.
  O que faltava não era conhecimento, era a garantia de que o **próximo** também saberia.
- **`REVOKE … FROM PUBLIC` não fecha nada.** O grant de `anon`/`authenticated` é explícito (veio
  do default privilege por NOME), então só some com um REVOKE que as nomeie. Um detector que
  aceitasse `FROM PUBLIC` como fecho ficaria verde exatamente sobre o buraco.


## 9.1.1 Desfecho do achado colateral (2026-08-18) — as 3 de `private`

Fechadas em `20260818120000_authz_private_execute_fecho.sql`, com prova executada em
`db/test-authz-private-execute-fecho.sh` (PG17, **21 asserts**, 3 falsificações, verde em
`lc_messages` **C e pt_BR.UTF-8**). Revisado adversarialmente pelo Codex (gpt-5.6-sol, xhigh),
que **derrubou duas afirmações factuais minhas** — ambas remedidas e corrigidas abaixo.

**Correção factual ao §9.1.** "Em `private` é pior" está errado no EFEITO, e a diferença importa
para não se desenhar defesa contra o risco errado: o default de `public` para funções é
`{postgres=X, anon=X, authenticated=X, service_role=X}` — ou seja, **os dois** deixam `anon` com
EXECUTE. A diferença é de FORMA, e favorece `private`: com `proacl` NULL um
`REVOKE … FROM PUBLIC` basta, enquanto em `public` é preciso revogar de `anon`/`authenticated`
**por nome**. O que `private` de fato nega é ROTA (o PostgREST não publica o schema), não EXECUTE
— o `nspacl` concede USAGE a `anon` e `authenticated`.

**Nenhuma das 3 era explorável — mas por razões que não eram privilégio, e é isso que as tornava
frágeis.**

| | por que não era alcançável | quão robusto |
|---|---|---|
| `frec_sem_margem` / `fbrec_sem_margem` | `RETURNS trigger` ⇒ chamada direta morre no handler de trigger (`0A000`) | **robusto, mas não pelo motivo que escrevi** — ver correção abaixo |
| `custo_canonico` | SECURITY INVOKER que chama `regua_num_finito`, cujo ACL nega `anon` (L4) | **acidental** — F3 abre o helper e `anon` **executa**. Dependia de um ACL vizinho |

**Correção 1 — "morre em `0A000` tenha ou não EXECUTE" era FALSO.** A ACL é verificada **antes**
da invocação. Medido em PG17: **com** EXECUTE → `0A000`; **sem** → `42501` (L3 e L12). O erro da
minha versão original foi provar só o caso "com EXECUTE" e generalizar. A consequência prática
inverte o argumento a favor do fecho: o `REVOKE` não é decorativo, ele **move a barreira** do
handler de trigger para o privilégio.

**Correção 2 — `CREATE TRIGGER` exige DUAS coisas**, privilégio `TRIGGER` na **tabela** e
`EXECUTE` na **função**; o assert original dizia "authenticated não consegue" sem distinguir qual
faltava — não provava o que afirmava. Agora as 3 categorias (L11a/b/c): sem nenhum → barra; **com
`TRIGGER` e sem `EXECUTE` → ainda barra**; com os dois → passa. O controle positivo é o que
prova que a causa é o `EXECUTE`. Confirmado também que disparar trigger **não** revalida EXECUTE
(L9/L10), e que existem exatamente **2** vínculos em `pg_trigger` para estas funções (L13) — o
`REVOKE` não neutralizaria um vínculo já instalado, então isso se responde por `pg_trigger`, não
por ACL.

Fechar não custou nada, e isso foi medido em vez de suposto: `get_skus_margem_positiva()` (SECDEF
de owner `postgres`) segue chamando o helper revogado (L8).

**Por que a Parte B não as exigiu** — o mesmo ponto cego já anotado em `get_carteira_margem_faixa`,
numa 2ª forma. O detector é **léxico sobre o corpo** (`SENSITIVE_TABLES`/`SENSITIVE_COLUMNS`), e
estes corpos falam o **jargão do modelo** (`m_ij`, `lie`, `m_bundle`), não os tokens do dicionário.
Somam-se dois detalhes: `custo_canonico` nem chega à Parte B (ela só examina SECDEF), e
`p_cost_price` **não casa** `\bcost_price\b` — o `_` antes de `cost` não é fronteira de palavra.
Ampliar o dicionário não resolve (`m_ij` como token sensível teria recall absurdo); o remédio
continua sendo registro manual, como lá.

### A categoria nova: `ACL_ONLY_INTERNAL`

A 1ª versão pôs as 3 em `ACKNOWLEDGED_SENSITIVE`, porque o teste "não inventa função" exige que
toda chave de `AUTHZ_FUNCOES_FECHADAS` esteja classificada. O Codex achou o modo de falha que eu
não vi: **aquele Set não é documentação, é a lista que faz a Parte B PULAR.** Com `custo_canonico`
lá, a entrada seria inerte hoje (a função é INVOKER, e a Parte B só examina SECDEF) e **perigosa
amanhã**: se ela renascesse SECDEF — a regressão que o gate existe para pegar — a entrada
preexistente a suprimiria em silêncio.

Daí a categoria própria, com **discriminante obrigatório**: quem está em `ACL_ONLY_INTERNAL` tem
de continuar `SECURITY INVOKER`, e virar SECDEF é **erro** da Parte B
(`[ACL_ONLY_INTERNAL_VIROU_SECDEF]`), não aviso. O check roda **antes** do filtro de
`touchesSensitive` de propósito — depender do detector léxico deixaria a regressão passar
exatamente na função que motivou a categoria (o corpo dela não casa token nenhum). Três testes
cobrem isso, incluindo o de que a falha não depende do detector.

Isso **não** é o teste afrouxado para ficar verde: é ele partido em duas afirmações mais fortes
(união dos três catálogos + discriminante que as separa), cada uma com a checagem que a sustenta.
`frec_sem_margem` e `fbrec_sem_margem` seguem em `ACKNOWLEDGED_SENSITIVE`, onde encaixam com
precedente exato (2 das 21 entradas já eram `RETURNS trigger` SECDEF).

Também saiu do desenho, pela mesma revisão, o `GRANT EXECUTE … TO service_role` em
`custo_canonico`: o único consumidor medido é a SECDEF de owner `postgres`, que a alcança como
owner — o grant só ampliaria superfície.

### A causa-raiz ficou de fora, e a razão MUDOU depois de medida

A formulação intuitiva **não funciona**:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;  -- INÓCUO
```

Medido com canário (L14): a função criada depois disso ainda nasce com `proacl` NULL e
`has_function_privilege('anon', …) = true`. Default privilege **por schema** não remove o EXECUTE
do default **global embutido** do Postgres — só adiciona, ou desfaz um `GRANT` feito também por
schema. A forma que funciona é a **global**, sem `IN SCHEMA` (L15) — mas ela é por **role
criadora** e vale para **todos** os schemas: mudança de postura do projeto inteiro, não um ajuste
de `private`.

Minha justificativa original ("fecharia a classe, mas só vale para o role que executa ⇒ cobertura
parcial") estava certa na conclusão e **errada no mecanismo**. As razões que sobram, agora
corretas: (1) a forma por schema é inócua e a global é invasiva e por-role-criadora — o apply aqui
é manual, então a cobertura seria parcial com aparência de total, e a Parte E passaria a confiar
numa premissa falsa; (2) muda a **premissa medida** que o cabeçalho de
`scripts/authz-funcoes-fechadas.ts` declara, e a Parte E emite
`[FUNCAO_DEFAULT_PRIVILEGE_ALTERADO]` justamente para isso; (3) o ganho é menor do que parece — as
10 `cap_*` de `private` precisam de `authenticated=X` e já recebem GRANT explícito, então o default
fechado só trocaria "nasce aberta em silêncio" por "quebra em runtime". Fail-closed é desejável,
mas é mudança de comportamento de deploy e merece entrega própria, com prova própria.

**Lição que sobra desta entrega.** As duas afirmações que caíram eram do mesmo tipo: eu **provei um
caso e generalizei para a categoria** ("com EXECUTE morre em 0A000" → "tenha ou não"; "o comando
fecha o default" → sem testar a forma por schema). O antídoto que funcionou não foi ler a doc com
mais cuidado — foi o **canário**: criar o objeto depois da mudança e medir o ACL dele. Assert que
cobre só o caso favorável é o mesmo teatro que a Lei #3 combate, uma camada acima.

## 9.2 Por que os DOIS, e não só o estático

A pergunta do §8.2 de novo, com resposta diferente — porque o dado é diferente:

- o **estático** tem dente aqui (ao contrário da direção (a) do §8.2, que ficaria verde hoje): o
  vetor atingiu o contrato **5 vezes**, e a sabotagem F1 prova que remover o `REVOKE` de uma
  dessas migrations fica vermelha nomeando arquivo e função;
- o **audit de prod** é o único que enxerga o que o repo não registra — e isso não é hipótese:
  **3 das 40** têm o fecho SÓ em prod (§9.4). Para elas o gate estático não tem o que ancorar.

## 9.3 O que entrou

- **`scripts/authz-funcoes-fechadas.ts`** — allowlist curada, com `permitido: {anon, authenticated}`
  declarado a partir do MEDIDO em prod, nunca do desejado. Booleano, não lista de privilégios:
  função só tem `EXECUTE`.
- **`scripts/lib/authz-funcoes.ts`** — núcleo puro, as duas guardas. Modela, por role proibida, um
  estado "aberta por quem" ao longo dos eventos pós-âncora (`GRANT` abre · `CREATE` depois de
  `DROP` abre · `REVOKE` pelo NOME fecha). Rastrear a ORDEM evita os dois falsos: `GRANT` seguido
  de `REVOKE` não é buraco, e `REVOKE` seguido de `DROP`+`CREATE` **é**.
- **Âncora INCLUSIVA (`>=`), e é a decisão de desenho que a medição ditou.** A Parte C de tabela
  olha o estritamente-posterior ao fecho. Aqui as **5** recriações reais fazem
  `DROP`+`CREATE`+`REVOKE` na PRÓPRIA migration-âncora: com `>` estrito, o detector nasceria cego
  para o seu único caso real.
- **Parte E no `authz:check`**, com códigos `FUNCAO_*`, e o verde passou a declarar as funções que
  ele NÃO vigia — a mesma regra do §8.3, agora para o eixo de ACL.
- **`bun run authz:funcoes:prod`** (`db/audit-grants-funcoes-fechadas.ts`) — compara
  `has_function_privilege` + `proacl` com o contrato. **Diverge de propósito da irmã de tabela:
  `fechadaPor: null` avisa mas NÃO pula a comparação.** Em tabela, `null` é "o fecho ainda não
  mergeou" e comparar seria ruído; em função é "prod está fechada e o REVOKE não está no repo".
  Como o estático já não cobre esses casos, pular aqui também os deixaria sem NENHUMA guarda —
  justamente as 3 entradas mais frágeis. O primeiro run saiu `✅ … em 37 função(ões)` e foi isso
  que denunciou o erro: um verde que contava 37 de 40 e chamava as 3 restantes de "não comparadas".

## 9.4 Revelado e baselinado, não acomodado

`public.detectar_skus_sem_grupo` e `public.set_status_envio_portal_on_disparo` estão fechadas para
`authenticated` em PROD (`auth=NÃO`, ACL explícito `{postgres,service_role,sandbox_exec}`), mas o
repo ainda as **CONCEDE**: a `20260510235956` ("Fatia E3 Fase 1") revoga de `PUBLIC, anon` e
mantém `GRANT EXECUTE … TO authenticated` nas 18 SECDEF que trata. O fecho delas aconteceu fora do
repo. Somadas à `public.cmc_ledger_capture` — que não tem GRANT/REVOKE em migration nenhuma —, são
**3 funções cujo fecho existe só em produção**.

A saída fácil era declarar `permitido.authenticated = true` e o gate ficaria verde. Seria fabricar
contrato falso na pior direção: passaria a AUTORIZAR a role que hoje não alcança, e um DROP+CREATE
que a reabrisse ficaria verde para sempre. `fechadaPor: null` diz a verdade — o fecho não está no
repo, o estático não vigia, o audit de prod é a única guarda —, e o verde do `authz:check` nomeia
as três.

> **✅ Follow-up ENTREGUE** em `20260818121919_authz_fecho_execute_registrado_3_funcoes.sql` — as 3
> passaram a ter âncora e o `authz:check` não emite mais nenhum `FUNCAO_FECHO_PENDENTE`. Ver §9.7.

## 9.5 Evidência

| o quê | resultado |
|---|---|
| `bun run authz:check` | exit **0** — 11 avisos (8 pré-existentes + 3 `FUNCAO_FECHO_PENDENTE`), **0 erros** |
| `bun run authz:funcoes:prod` | exit **0** — o EXECUTE de prod bate com o contrato nas **40** |
| testes de authz (5 arquivos) | 129 → **175**: delta **+46**, exatamente os escritos |
| `scripts:typecheck` · `eslint` (6 arquivos) · `shellcheck` | exit **0** |
| medição refeita após rebase | a main andou (650 → **651** migrations) e os números do detector ficaram **idênticos**: 18/12, 5 no contrato |

**Falsificação** — `db/test-authz-funcoes-falsificacao.sh`, **0 falhas em C e em pt_BR.UTF-8**:

| | sabotagem | esperado | obtido |
|---|---|---|---|
| C0/C1 | nenhuma (canário, antes e depois) | verde | exit 0 |
| F1 | `REVOKE` removido da migration-âncora que faz DROP+CREATE | vermelho | exit 1, `FUNCAO_RECRIADA_SEM_FECHO`, **nomeando arquivo e função certos** |
| F2 | migration nova com `GRANT EXECUTE … TO anon` | vermelho | exit 1, `FUNCAO_REABERTURA`, nomeando o arquivo novo |
| F3 | migration nova com DROP+CREATE sem REVOKE | vermelho | exit 1, `FUNCAO_RECRIADA_SEM_FECHO` |
| F3b | **a mesma, COM o REVOKE de volta** | **verde** | exit 0 |
| F3c | a mesma, com REVOKE PARCIAL (só `anon`) | vermelho | exit 1 |
| F4 | detector desligado | vermelho | exit 1 — caem os testes anti-inércia |
| F5 | allowlist afrouxada (`permitido.anon = true`) | vermelho | exit 1 — cai o teste de sanidade |
| F6 | contrato declara fechada uma função que prod tem ABERTA | vermelho **só no audit** | `authz:funcoes:prod` exit 1 `FUNCAO_DRIFT_PROD`; `authz:check` segue 0 |

F3b é o par que impede o detector de virar ruído: sem ela, F3 passaria mesmo que a Parte E
acusasse toda migration que menciona a função, e o gate seria desligado no primeiro PR legítimo.
F3c é o que separa esta parte de um detector que só procura a palavra `REVOKE`.

> **Três erros de MÉTODO desta sessão, registrados porque cada um quase virou conclusão falsa:**
> (1) A contraprova F3b nasceu mirando `get_regua_preco`, do `AUTHZ_MANIFEST` — e ficava vermelha
> pela **Parte A** (recriar função do manifest com corpo de fixture é gate ausente), não pela E.
> **Uma contraprova que exige VERDE precisa ser invisível para as outras partes**; o alvo mudou
> para uma função de `ACKNOWLEDGED_SENSITIVE`.
> (2) O primeiro teste anti-inércia sabotava por `replace(/REVOKE\s+EXECUTE[^;]*;/)` e não casava
> `REVOKE ALL` — as duas formas convivem no repo. A sabotagem não acontecia e o teste afirmava
> "o detector é cego" quando o cego era o `replace`. **Sabotagem que não casa nada precisa falhar
> o harness**, e é por isso que o F1 do `.sh` carrega um `assert novo != s`.
> (3) O prefixo `FUNCAO_` NÃO desambigua: `FUNCAO_REABERTURA` **contém** `REABERTURA`, e o teste
> da Parte C, que filtrava por substring solta, passou a contar achados da Parte E no primeiro run
> conjunto. **Quem filtra achado por código tem de casar o código DELIMITADO** (`[REABERTURA]`),
> que é como o `authz-gate-check` o emite. Há agora um teste que trava isso.

## 9.6 Limites declarados e o que sobra

1. **A Parte E prova o que o REPO declara, não o que prod tem** — mesma divisão das outras partes.
   Um `GRANT EXECUTE` colado à mão no SQL Editor é invisível para ela; quem o pega é o
   `authz:funcoes:prod`, que roda on-demand. Entre duas execuções, a janela existe.
2. ~~**3 funções sem âncora no repo** (§9.4) não são vigiadas pelo CI.~~ **RESOLVIDO** na entrega do
   §9.7: as 3 ganharam âncora, e hoje `fechadaPor: null` não sobra em nenhuma das 40.
3. **O detector julga por NOME, não por assinatura.** Overloads colapsam em `schema.name`, que é a
   granularidade do `AUTHZ_MANIFEST`. Um `DROP`+`CREATE` que recriasse só UM overload e revogasse
   dele passaria como fecho completo. No audit de prod a regra é fail-closed entre overloads (um
   alcançável basta para acusar); no estático, não.
4. **`ALTER DEFAULT PRIVILEGES` sobre FUNCTIONS sai como AVISO**, não erro — ele muda a premissa
   de todo o resto (é dele que a função recriada herda o ACL) e pode até estar fechando o vetor de
   raiz. Hoje há **0** no repo; se aparecer um, a medição da allowlist precisa ser refeita.
5. **`CREATE FUNCTION` de função NOVA não é vigiado por esta parte.** Ela ancora no fecho de
   funções já classificadas; quem exige que uma SECDEF sensível nova seja classificada é a Parte B.
   Uma função nova que não toque o eixo sensível nasce alcançável por `anon` e ninguém reclama —
   é o modelo da plataforma, e mudar isso é decisão de produto, não de sentinela.

## 9.7 O fecho das 3 saiu de prod e entrou no repo (follow-up do §9.4, PR pós-#1768)

`20260818121919_authz_fecho_execute_registrado_3_funcoes.sql` emite os 3
`REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated`. Com a âncora apontada nas 3
entradas de `scripts/authz-funcoes-fechadas.ts`, o `authz:check` deixou de emitir
`FUNCAO_FECHO_PENDENTE` (11 → 8 avisos) e o `authz:funcoes:prod` passou a fechar com **40 vigiadas
e 0 fora do repo** — o `⚠️` que o verde carregava sumiu.

**A migration é NO-OP em prod, e isso é o ponto, não um defeito.** As 3 já estavam fechadas
(medido; reconfirmado 2026-08-18). O que não existia era o REGISTRO. O ganho é duplo: o vetor
`DROP`+`CREATE` nelas passa a ser pego no PR, e um replay do repo (DR) passa a reproduzir o ACL de
prod — antes não reproduzia, e a diferença não era cosmética: sem GRANT/REVOKE algum sobre
`cmc_ledger_capture`, um replay a fazia nascer alcançável **por `anon`**.

> ⚠️ **Consequência de ser no-op: o apply em prod é INOBSERVÁVEL por ACL.** `has_function_privilege`
> devolve o mesmo antes e depois do Run, então o `authz:funcoes:prod` verde **não é evidência de
> que a migration foi colada** — é evidência de que prod bate com o contrato, que já batia. É o
> caso em que a "query de validação pós-apply" do ritual `lovable-db-operator` não consegue
> discriminar, e dizer isso vale mais do que entregar uma query que finge discriminar. O único
> observável do apply é o `INSERT` opcional em `supabase_migrations.schema_migrations`.

**Prova executada** — `db/test-authz-fecho-execute-registrado.sh` (PG17 descartável, 28 asserts,
exit 0). Ele reproduz a premissa em vez de presumi-la: aplica o default privilege MEDIDO
(`public`/`f` → `{postgres,anon,authenticated,service_role}`) e o estado que a `20260510235956`
deixava, e só então roda a migration real. O que ficou provado, e não alegado:

| # | asserção |
|---|---|
| A1c | sem esta migration, um replay do repo faz `cmc_ledger_capture` nascer alcançável por **`anon`** |
| A2 | `REVOKE … FROM PUBLIC` **não** tira `authenticated` nem `anon` — a armadilha nº 1 de `database.md`, executada |
| A3-A5b | depois da migration, as 2 roles do browser não alcançam nenhuma das 3 |
| A6 | `service_role` **mantém** EXECUTE nas 3 — o fecho para exatamente onde devia |
| A7/A8 | o cron (`postgres`, superuser) executa; `authenticated` é barrado com **42501**, com re-raise de qualquer outra SQLSTATE |
| **A9/A10** | **os 2 triggers DISPARAM para `authenticated` sem EXECUTE na função** — Postgres não checa esse privilégio no disparo, o privilégio checado é o DML na tabela |
| A12/A12b | os 3 `REVOKE` são **top-level** |
| F1/F2/F3 | sabotar o REVOKE (tirar `authenticated`; deixar só `PUBLIC`) fica **vermelho**; a migration verdadeira volta ao verde |

**A9/A10 é a asserção que autorizou a entrega.** "Revogar não quebra os triggers" era exatamente o
tipo de alegação plausível que, errada, derrubaria a escrita em `pedido_compra_sugerido` e
`inventory_position`. Provada executando, virou fato.

**A12 congela uma falha silenciosa nova.** O parser de `scripts/lib/authz-funcoes.ts` julga
statements que começam com o verbo, sobre um SQL sem comentários/strings — mas `stripNoise` **não
trata dollar-quote**. Um `REVOKE` embrulhado em `DO $$ … $$` deixa de ser statement para o gate: o
banco fecharia igual, a âncora ficaria **muda**, e a migration não cumpriria o que se propõe sem
nada ficar vermelho. É a razão de os 3 REVOKE serem top-level, e A12 é o que impede alguém de
"melhorar" isso depois com um guard de existência.
