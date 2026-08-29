# A RLS viva estava fora do alcance dos audits — a quarta guarda (`authz:rls:prod`)

> 2026-08-27. Fecha o ponto cego que os três audits de autorização de prod declaravam mas não
> cobriam. Entrega: `bun run authz:rls:prod` (`db/audit-rls-prod.ts`), contrato curado em
> `scripts/authz-rls-esperado.ts`, comparador puro em `scripts/lib/authz-rls.ts`, dente em
> `db/test-audit-rls-prod.sh` (31 cenários, PG17 descartável) e `scripts/authz-rls.test.ts`
> (32 testes, CI). **Nenhum DDL saiu da sessão** — não havia o que corrigir.
> ⚠️ **§1–§6 são o registro da 1ª rodada (7 tabelas · 19 policies).** O escopo VIVO é o da 2ª
> rodada, no §7: **17 tabelas · 38 policies · 5 predicados** — a fonte é sempre
> `scripts/authz-rls-esperado.ts`, nunca um número neste diário.

## 1. A lacuna, e por que ela não era visível

Os três audits de prod cobrem três eixos de autorização e **nenhum** deles é a RLS:

| audit | o que lê | o que NÃO lê |
| --- | --- | --- |
| `authz:funcoes:prod` | `EXECUTE` das funções fechadas | policies |
| `authz:grants:prod` | `has_table_privilege` das tabelas fechadas | policies |
| `authz:audit:prod` | md5 do `prosrc` das RPCs do `AUTHZ_MANIFEST` + o gate no corpo vivo | policies |

`relrowsecurity`, `relforcerowsecurity` e `pg_policy` (`polname`, `polcmd`, `polroles`, `qual`,
`with_check`) não eram lidos por ninguém. Consequência direta: `ALTER TABLE … DISABLE ROW LEVEL
SECURITY` colado no SQL Editor do Lovable — ou um `CREATE POLICY … USING (true)` — sai **verde**
nos três.

O gate estático do CI (`scripts/lib/authz-grants.ts`, código `RLS_OFF`) pega o `DISABLE`, mas com
dois recortes que o tornam quase inócuo contra este vetor: ele lê **migration no repo**, e só das
**3 tabelas** de `AUTHZ_TABELAS_FECHADAS`. O que sobra é exatamente o que não passa por migration
nenhuma — que é o modo normal de operar este banco (`database.md` §1: escrita só via SQL Editor).

A lacuna já estava **nomeada** no cabeçalho do carimbo de evidência (PR #2044, ainda aberto):
"RLS vivo … não é reconciliado por nenhum dos três — um `ALTER TABLE … DISABLE ROW LEVEL SECURITY`
à mão sai verde". Nomear o ponto cego é o passo certo e não é a guarda: o que fecha o laço é ter
um comando que responda.

## 2. A decisão de ESCOPO — dois eixos com custos de ruído diferentes

A pergunta que abriu o desenho era "curar quais tabelas, das ~413 de `public`?". A medição em prod
(psql-ro, 2026-08-27) reformulou a pergunta:

```
335 tabelas (relkind='r') · 335 com RLS ligada · 0 desligada · 0 com FORCE
701 policies em 328 tabelas · 7 tabelas com RLS ligada e ZERO policy (todas de log/controle)
```

Com **100% das tabelas já com RLS ligada**, o eixo do *interruptor* não precisa de allowlist
nenhuma: o estado esperado é o mesmo para todas, e o veredito cabe numa linha. O eixo do
*conteúdo*, sim — 701 policies de ruído é relatório que ninguém lê, e sentinela que ninguém lê
está desligada. Daí os dois escopos:

- **Universal (sem allowlist)** — `relrowsecurity` de toda tabela de `public`. Veredito por
  **contagem de violações** ("0 desligadas"), nunca pelo total congelado: congelar `335` faria a
  sentinela gritar a cada migration nova e ser desligada. É a mesma escolha da sentinela do
  `claude_ro`, que mede "0 objetos sem SELECT" em vez do número 413.
- **Curado (allowlist)** — 7 tabelas, 19 policies. Critério de entrada escrito no cabeçalho do
  contrato, para a lista não virar depósito: *a RLS da tabela é a única ou a principal barreira
  entre um `authenticated` qualquer e (i) dinheiro, (ii) custo/preço, ou (iii) a raiz da
  autorização*. Entraram `user_roles`, `sales_orders`, `fin_contas_receber`, `product_costs`,
  `omie_products`, `tint_formulas`, `profiles`.

As ~328 tabelas restantes ficam **declaradamente** fora do eixo 2 — cobertas pelo interruptor,
não pelo conteúdo. Lacuna declarada, não cobertura implícita: a regra do repo é que contrato falso
é pior que lacuna, porque o verde passa a afirmar o que não mediu.

## 3. A representação — md5 do `pg_get_expr` normalizado, e o buraco que ele deixa

`qual`/`with_check` são expressões; comparar texto é frágil. O contrato guarda o **md5 do
`pg_get_expr` normalizado**, a mesma receita já usada em `AUTHZ_REESCRITAS_CONHECIDAS`:

```sql
md5(regexp_replace(btrim(pg_get_expr(polqual, polrelid)), '\s+', ' ', 'g'))
```

`pg_get_expr` remonta a expressão a partir da árvore de parse, então o md5 é estável a whitespace
e parênteses do DDL original — a policy recriada com o **mesmo DDL** volta ao mesmo md5 (cenário I
do harness prova isso).

🔴 **O que o md5 da expressão NÃO pega, e foi o achado que mudou o desenho:** mudança no **corpo de
uma função que a policy chama**. Reescrever `private.cap_pedido_escrever` para `SELECT true` deixa
o texto do `qual` byte-a-byte idêntico — o md5 não se move, e a RLS de `sales_orders` passa a
autorizar qualquer autenticado. Medindo quem cobriria isso: **nenhuma** das 4 funções-predicado
(`public.has_role`, `private.cap_custo_ler`, `private.cap_pedido_escrever`,
`public.fin_user_can_access`) está no `AUTHZ_MANIFEST` — ele cobre RPCs de money-path, não
predicados de RLS. Ninguém as vigiava.

Daí o **terceiro eixo**: md5 do `prosrc` das funções-predicado, com `prosecdef` e `proconfig`
junto — sob a **mesma normalização** de cima: `md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))`
(`db/audit-rls-prod.ts`). **Todo md5 de corpo citado neste arquivo é o normalizado**, e
`md5(prosrc)` cru devolve OUTRO valor — o trio de `5faf2a21…` mede `86052d07…` cru (aferido
2026-08-29). Elas são **descobertas por `pg_depend`** (`classid='pg_policy'` → `refclassid='pg_proc'`),
não por regex sobre o texto da policy: o §4 do `database.md` guarda duas varreduras textuais que
produziram falso-positivo integral, e uma função chamada dentro de um `COALESCE` não aparece onde
um grep espera. Função descoberta que não esteja declarada é `PREDICADO_NAO_DECLARADO` — erro,
não silêncio.

### O que a escolha inteira não pega (limites declarados)

1. **Bypass estrutural, que não passa por policy nenhuma** — `service_role` (`rolbypassrls`),
   `SECURITY DEFINER`, view com `security_invoker=off`, MV (que não tem RLS). Policy perfeita não
   impede nada disso.
2. **ACL por coluna** — RLS filtra LINHA. O `GRANT SELECT (omie_payload)` de `sales_orders` é
   invisível daqui; quem cobre é o `authz:grants:prod`, e mesmo ele só em nível de tabela.
3. ~~**O 2º nível do grafo de predicados**~~ — **FECHADO em 2026-08-28 (§9).** Era: `pg_depend`
   registra policy→função e **não** função→função, e o fecho era completo por **coincidência do
   grafo medido**, não por construção. O eixo 3 passou a medir o **fecho transitivo** (1º nível por
   `pg_depend`; do 2º em diante por varredura de `prosrc` resolvida pelo catálogo, escolhida entre
   três fontes MEDIDAS), e função alcançada em qualquer nível é `PREDICADO_NAO_DECLARADO` se não
   estiver na allowlist. O que sobrou fora — SQL dinâmico, seleção de campo, schema de sistema —
   está medido e listado no §9, junto do achado da falsificação nº 4.
4. **O md5 é textual, não semântico** — travado como cenário X do harness: reformatar o corpo do
   gate sem mudar a semântica **move o md5**, porque a normalização colapsa espaços mas não os
   remove (`EXISTS (\n SELECT` → `EXISTS ( SELECT` ≠ `EXISTS (SELECT`). É falso-positivo
   conservador, e quem renovar um md5 precisa saber disso — senão lê "mudou" como "foi atacado".
5. **A janela entre execuções** — roda on-demand, como os outros três; o CI não tem `psql-ro` e não
   deve ter. Cadência é o problema que o carimbo de evidência resolve (§6).
6. **Catálogo não prova alcance.** Medido: sob `psql-ro`, `SET ROLE authenticated` em prod devolve
   `permission denied to set role` — a prova executada **não é possível contra produção**, por
   limite do papel e não por escolha. Ela mora no harness (§5, PARTE B).

## 4. Um check ESTRUTURAL, que não depende de baseline

Além da reconciliação, o audit roda uma regra que vale contra o estado real, tenha ele baseline ou
não: **`FOR ALL` cujo `WITH CHECK` diverge do `USING`** (`FOR_ALL_ASSIMETRICO`). É a armadilha do
`database.md` §4 — `WITH CHECK` não se aplica a DELETE, então apertar só o lado da escrita deixa
quem tem apenas a capability de leitura **continuando a apagar**. Falha latente: não abre nada
enquanto as duas expressões coincidem, e por isso passa em qualquer teste de "o comportamento não
mudou".

Medido: as 4 policies `FOR ALL` das tabelas curadas (`user_roles`, `tint_formulas`,
`fin_contas_receber`, e a `Admins can update any profile`) são **simétricas** hoje — ou têm o mesmo
md5 nos dois lados, ou não têm `WITH CHECK` (e aí o Postgres reusa o `USING`, simétrico por
construção). O check existe para acusar o dia em que uma delas deixar de ser.

## 5. Falsificação — em dois níveis, porque são duas perguntas

**Nível 1 — o audit reage ao estado (PARTE A do harness, 26 cenários).** Cada eixo é sabotado no
banco e o cenário exige o **código certo**, não "acusou alguma coisa": `POLICY_NOVA` e
`POLICY_ALTERADA` pedem correções opostas (declarar × investigar), e um assert que casasse só a
presença as deixaria indistinguíveis. Depois de cada sabotagem, a correção exige o **verde de
volta** — o dente. Mais 3 **controles inócuos** (coluna nova na tabela curada, tabela nova COM RLS,
linha de dado nova) que exigem verde: sem eles, um detector que acusasse tudo passaria igual.

**Nível 2 — o EFEITO (PARTE B, 5 cenários), sob `SET ROLE authenticated` + `request.jwt.claim.sub`.**
Catálogo não prova alcance. Aqui a RLS é exercida:

| | quem | vê |
| --- | --- | --- |
| B2 | não-staff, RLS ligada | **0 linhas** |
| B3 | não-staff, após `DISABLE` | **2 linhas** ← o vetor é real, não teórico |
| B5 | não-staff, RLS ligada e policy INTACTA, gate reescrito para `true` | **2 linhas** |

B5 é o eixo 3 provado por fora: nada no texto da policy mudou, a RLS continua ligada, e o barrado
lê tudo.

**Nível 3 — sabotar o DETECTOR (meta-falsificação, fora do CI).** Seis sabotagens no comparador e
no runner, cada uma exigindo que o harness fique **vermelho**: eixo do interruptor desligado ·
`POLICY_NOVA` rebaixada a aviso · `FOR_ALL_ASSIMETRICO` neutralizado · md5 do corpo do predicado
ignorado · `TABELA_AUSENTE` degradada para silêncio · medição de policies zerada no runner. As 6
produziram vermelho. A última é a mais informativa: zerar a medição fez **19** cenários falharem —
medição vazia não passa como verde, ela vira `POLICY_SUMIU` em massa, que é o desenho fail-closed
funcionando.

> ⚠️ Método: **commite antes de falsificar**. A restauração é `git checkout --`, e sem o commit ela
> apaga o trabalho em vez da sabotagem.

## 6. A integração ao carimbo — e o achado que ela produziu

A tarefa pedia integrar a guarda ao **carimbo de evidência**, e a medição inicial dizia que isso
não era possível: `scripts/lib/authz-carimbo.ts` não existia na `main`, vivia no PR #2044, aberto e
com `mergeable: CONFLICTING`. A guarda foi desenhada e entregue autônoma por causa disso. **O #2044
mergeou no meio da sessão** (`8962f213c`), e a integração entrou no mesmo PR, feita de verdade:

- 5ª chave `rls` em `AUDITS` (não a 4ª — o `claudeRo` já tinha entrado 12 commits depois de o
  carimbo nascer), com `auditorFiles` apontando para o runner **e** para o comparador puro;
- `dadoDoContrato('rls')` devolve os **três** eixos, porque mexer só nos predicados muda o que prod
  tem de satisfazer tanto quanto mexer numa policy;
- `SCHEMA_VERSION` 1 → **2**. O bump não é cosmético: um carimbo v1 não tem o campo `audits.rls`, e
  sem o bump o gate leria essa ausência como "nada a dizer sobre RLS" em vez de "isto nunca foi
  medido". Fail-closed é o comportamento certo, e a renovação é o que devolve o verde — com o eixo
  novo medido junto;
- o cabeçalho do carimbo, que **listava a lacuna de RLS como ponto cego**, foi reescrito para
  descrever a cobertura REAL (interruptor universal, conteúdo curado em 7 de 335) em vez de
  continuar afirmando um buraco que já não existe. Contrato falso é pior que lacuna nos dois
  sentidos: o que finge cobrir e o que finge não cobrir.

### O achado: `PREDICADOS_PLATAFORMA` é um `Set`, e o eixo mais permissivo dos três

O canônico do carimbo trata `Set` com tag de tipo justamente porque `JSON.stringify(new Set(['a']))`
é `'{}'`. O contrato de RLS entrega um `Set` (`PREDICADOS_PLATAFORMA`) — e ele é o eixo cuja
mudança **afrouxa**: mover uma função para dentro dele é dizer "o corpo desta não precisa mais ser
congelado". Um fingerprint cego ali seria cego no pior lugar possível. Travado por teste.

### O achado adjacente, que valia sozinho o exercício

`recusarEnvDeTeste()`, no runner do carimbo, era uma **lista literal** de dois nomes
(`AUTHZ_FUNCOES_TEST_JSON`, `AUTHZ_GRANTS_TEST_JSON`). O audit de RLS chegou com um terceiro,
`AUTHZ_RLS_TEST_JSON`, que a lista não conhecia — e o runner teria **carimbado um contrato
sintético como se fosse produção**, sem uma linha de aviso. A guarda existia, estava correta no dia
em que foi escrita, e apodreceu na primeira extensão do sistema que ela protege.

A correção não foi acrescentar o terceiro nome: foi mover a regra para o núcleo puro
(`envDeTesteSetadas`) e casar por **PREFIXO** (`/^AUTHZ_[A-Z0-9_]*_TEST_JSON$/`), com um teste que
percorre `Object.keys(AUDITS)` e exige que a env canônica de **cada** audit seja recusada. Falso-
positivo ali custa uma mensagem de erro; falso-negativo custa um carimbo mentiroso — a assimetria
decide a direção. Audit futuro nasce coberto.

> **Classe:** *guarda com lista literal do que ela protege apodrece na primeira extensão.* A lista
> nasce completa e correta; quem a torna incompleta é o crescimento do próprio sistema, e nada no
> ponto de extensão avisa que ela existe. Quando a guarda pode ser expressa como PADRÃO do que
> protege, o padrão é o que sobrevive.

---

**Lição que sobra, além do domínio:** *um ponto cego declarado continua sendo um ponto cego.* O
limite estava escrito, correto e visível no cabeçalho do carimbo — e mesmo assim `relrowsecurity`
ficou sem leitor. Declarar o não-medido é o que impede o verde de mentir; não é o que fecha o
buraco. O que fecha é um comando que responda, com denominador na linha do veredito.

---

## 7. A 2ª rodada de curadoria (2026-08-27, mesmo dia) — 7 → 17 tabelas, 19 → 38 policies

A 1ª rodada entregou a guarda com 7 tabelas e disse, no cabeçalho, que as outras ~328 eram
**lacuna declarada**. Esta rodada mediu quais delas passam o critério já escrito — *"a RLS da tabela
é a única ou a principal barreira entre um `authenticated` qualquer e (i) dinheiro, (ii)
custo/preço, ou (iii) a raiz da autorização"* — e curou 10.

### O método: `pg_depend` + `prosrc`, não intuição sobre nome de tabela

O universo de candidatas não saiu de uma lista de palpites; saiu do **grafo policy→função** medido
em prod, que devolveu 652 arestas sobre 15 funções distintas. Ele reordena a pergunta: em vez de
"esta tabela parece money-path?", pergunta-se "**que gate esta tabela usa, e quem escreve a tabela
que o gate lê?**".

```
309 auth.uid · 208 public.has_role · 41 auth.role · 22 private.cap_carteira_ler
 18 public.fin_user_can_access · 15 cap_carteira_escrever · 14 cap_compras_ler
  8 carteira_visivel_para · 8 cap_custo_ler · 2 is_super_admin · 2 cap_estoque_reservar
  1 cap_preco_escrever · 1 cap_pedido_escrever · 1 cap_credito_escrever
```

### O achado que decidiu o escopo: curar a RAIZ cobre as folhas; curar as folhas não cobre a raiz

Lendo o `prosrc` das funções (não o nome delas), duas tabelas se revelaram raízes que nenhum audit
vigiava:

| raiz | quem a lê | o que uma linha nela concede |
| --- | --- | --- |
| `public.commercial_roles` | `cap_custo_ler` (8 policies de custo), `cap_carteira_ler` (22 tabelas), `is_super_admin`, e o `qual` de `margin_audit_log` **direto** | `(self,'estrategico')` → vê custo. `(self,'super_admin')` → custo + carteira + **o direito de conceder de novo** |
| `public.fin_permissoes` | `fin_user_can_access` (o `qual` inteiro de 18 policies `fin_*`) **e 4 policies de escrita que leem as colunas dela sem função nenhuma** | `pode_fechar_mes`, `pode_editar_orcamento`, `pode_conciliar`, `pode_eliminar_intercompany` — o direito de FECHAR O MÊS |

Isso resolveu a maior pergunta de escopo da rodada. As **21 tabelas de inteligência comercial** que
o `database.md` §4 lista como gateadas por carteira **não entraram**: a raiz delas
(`commercial_roles`) entrou, e curar 1 tabela cobre o vetor que curar 21 folhas não cobriria. Mesmo
raciocínio contra as ~36 `fin_*` restantes: as fontes de dinheiro, a conta bancária e as duas
raízes entraram; os agregados e logs derivados, não.

🔴 **E a assimetria que o `pg_depend` NÃO mostra:** a dependência de `fin_permissoes` por 4 policies
é por **TABELA**, não por função — `pg_depend` registra policy→função e é cego a ela. O eixo 3 (md5
do predicado) portanto não descobre essa raiz; quem a cobre é o congelamento do **conjunto de
policies**. É o mesmo formato do limite nº 3 do §3: o grafo medido fecha o caso por coincidência,
não por construção.

### O segundo achado: o filho é alcançável onde o pai não é

Medindo `has_table_privilege('authenticated', …)` em vez de assumir:

```
sales_orders  0101   ← sem SELECT, sem UPDATE (INSERT/DELETE só)
order_items   1000   ← SELECT aberto — e é ele que guarda unit_price/discount (70.489 linhas)
```

A 1ª rodada curou o **pai** (`sales_orders`) e deixou o **filho** de fora. Mas no pai quem barra a
leitura é o **grant** (e o `authz:grants:prod` o vigia); no filho, a RLS é a única barreira — e é no
filho que estão os números. Curar por "nome que soa money-path" teria repetido o erro; curar pelo
privilégio medido o encontrou.

### A regra de escopo que a rodada produziu (e escreveu no contrato)

Os três membros do critério **não se aplicam do mesmo jeito**, e a diferença é a alavanca:

- **membro (iii), raiz** → entra sempre, e **tabela vazia é irrelevante**. `fin_permissoes` tem 0
  linhas e entrou: o poder de uma raiz é estrutural (uma linha concede), e o que o contrato guarda
  ali é a FORMA — hoje **nenhuma** policy de escrita para `authenticated`. O alarme é o dia em que
  ela aparecer.
- **membros (i)/(ii), dinheiro e custo/preço** → entra a tabela que guarda o **número na fonte, com
  linha em prod**. Agregado, log e config cuja fonte já está congelada ficam de fora; tabela vazia
  também, **com gatilho de reentrada escrito** (`orders`, `cliente_grupos`, `cliente_grupo_membros`,
  `cliente_tier_preco` — todas 0 linhas).

`customer_contacts` foi recusada por um motivo diferente e vale registrar: ela é **dado pessoal**
(LGPD), não dinheiro/custo/raiz. O broad-staff dela é decisão MEDIDA (§4, com gatilho de
reavaliação próprio) — forçá-la nesta allowlist seria usar a sentinela errada para o problema, e o
verde dela passaria a afirmar algo que o critério não mede.

### O que a expansão custou, e o que ela não custou

10 tabelas novas puxaram **um único predicado novo** (`private.is_super_admin`) — sinal de que a
autorização deste banco converge para poucos gates, o que torna o eixo 3 barato e o md5 do corpo
deles caro. As 3 funções já declaradas voltaram do banco com o **md5 idêntico** ao do contrato
(`6e1a80…`, `cdfb90…`, `6599d0…`), e três md5 de policy novos bateram com entradas da 1ª rodada
(`eaca1331…` = `cap_custo_ler`; `8ddd30b6…` = `has_role(master)`; `19300d15…` = `auth.uid()=user_id`)
— cruzamento que confirma que a medição e a transcrição falam a mesma língua.

### Falsificação (4 sabotagens, todas exigindo o código CERTO)

| | sabotagem | exigido | obtido |
| --- | --- | --- | --- |
| F1 | 1 hex trocado no md5 de `Super admins can manage commercial roles` | `POLICY_ALTERADA` | exit 1, `POLICY_ALTERADA` |
| F2 | `fin_perm_service` apagada do contrato | `POLICY_NOVA` | exit 1, `POLICY_NOVA` |
| F3 | `private.is_super_admin` removida dos predicados | `PREDICADO_NAO_DECLARADO` | exit 1, `PREDICADO_NAO_DECLARADO` |
| F4 | `motivo` de uma entrada nova esvaziado | o teste NOVO vermelho | vitest exit 1 |

Depois de cada uma, a restauração exigiu o **verde de volta** — e veio (audit exit 0; harness
**31/31 nos dois locales**, `LC_ALL=C` e `pt_BR.UTF-8`).

### O resíduo durável: a allowlist agora se defende sozinha do depósito

F4 sabota um teste que **não existia**. A regra "cada entrada precisa de um `motivo`" era prosa no
cabeçalho, e prosa não reprova PR. Virou gate (`scripts/authz-rls.test.ts`): motivo de tabela >80
chars, de policy >40, de predicado >80. O piso é grosseiro de propósito — **não mede qualidade de
texto, mede que alguém escreveu algo**. Ele já pagou na primeira execução: pegou uma entrada da 1ª
rodada com `motivo` de 23 caracteres (`'`auth.uid() = user_id`.'`), que foi escrita de verdade.

> **Classe (irmã da lição do `recusarEnvDeTeste`, §6):** *convenção que só existe em prosa apodrece
> na primeira pessoa com pressa.* A diferença entre "o critério está escrito no cabeçalho" e "o
> critério reprova o PR" é a diferença entre uma lista curada e um depósito — e o cabeçalho já
> estava correto no dia em que foi escrito.

---

## 8. A 3ª rodada (2026-08-28) — escolher a tabela pelo predicado que ela ARRASTA

Duas sessões paralelas mediram a mesma pergunta no mesmo dia. A §7 é uma; esta é a outra, reduzida
ao **diferencial** depois que o #2068 mergeou (worktrees.md §Colisão de CÓDIGO: descobrir a
colisão com o PR pronto custa dois PRs). **17 → 20 tabelas, 38 → 50 policies, 5 → 8 predicados.**

As duas convergiram sozinhas em 5 tabelas — `commercial_roles`, `fin_permissoes`,
`fin_contas_pagar`, `order_items`, `markup_policy` — o que é validação cruzada barata e vale
registrar. Divergiram no resto, e a divergência tem uma lição dentro.

### A tese: numa allowlist com eixo derivado, o valor de uma entrada é o que ela PUXA

O audit descobre os predicados **a partir das tabelas curadas** (`unnest(tabs)` → `pg_policy` →
`pg_depend`). Logo cada tabela que entra **obriga a declarar seus predicados**, e o alcance de um
predicado é muito maior que o da tabela que o trouxe. As 3 desta rodada guardam pouco — duas estão
**vazias** — e trazem três capabilities que audit nenhum congelava:

| tabela | linhas | traz | alcance do predicado |
| --- | --- | --- | --- |
| `pedido_compra_item` | 2.404 | `private.cap_compras_ler` | **18 policies / 14 tabelas** |
| `cliente_tier_preco` | 0 | `private.cap_preco_escrever` | 2 / 1 |
| `venda_excecao_credito` | 0 | `private.cap_credito_escrever` | 1 / 1 |

Curar **uma** tabela de 2.404 linhas põe 14 tabelas sob vigilância de eixo 3. Provado por
falsificação dirigida: remover `pedido_compra_item` do contrato faz `cap_compras_ler` virar
`PREDICADO_SUMIU` — a tabela é o que mantém o predicado dentro do alcance.

### 🔴 A correção que a rodada trouxe: convergência medida sobre amostra selecionada por semelhança

A §7 concluiu, do próprio resultado, que "a autorização deste banco converge para poucos gates" —
10 tabelas novas trazendo **uma** função só. Esta rodada mediu o inverso: **3 tabelas trouxeram 3
funções**. A diferença não está no banco, está no **método de seleção**. A 2ª rodada escolheu por
*parentesco* com o que já estava curado (o resto do `fin_*`, o resto do que `cap_custo_ler`
gateia) — e tabela irmã compartilha o gate da irmã **por construção**. A amostra confirmava a
hipótese porque tinha sido selecionada por ela.

> **Classe:** *uma amostra escolhida por semelhança com o que já se conhece não pode testar a
> hipótese de que tudo se parece.* O resultado é verdadeiro sobre a amostra e não se estende — e o
> jeito de perceber é medir o UNIVERSO (aqui: as 14 funções que gateiam policy em `public`, das
> quais 8 estão congeladas), não crescer a amostra pela borda dela mesma.

### Três armadilhas de medição, todas do tipo "verde por dado que não foi consultado"

1. **`n_live_tup` é ESTIMATIVA do autovacuum, e mentiu.** `pg_stat_user_tables` dava `0` para
   `commercial_roles`; `count(*)` dá **3**. Decidir escopo por ela teria descartado uma raiz da
   autorização. É "ausente ≠ zero" numa forma nova: a estimativa lida como contagem.
2. **O nome mente; a FK não.** `public.orders` parecia o pedido de venda — está **vazia e órfã**.
   Os 70.489 `unit_price` estão em `order_items`, cuja FK aponta para **`sales_orders`**, já
   curada: era o *filho* da tabela curada que estava de fora.
3. **Tabela de CONCESSÃO vazia não é tabela sem risco.** `fin_permissoes`, `cliente_tier_preco` e
   `venda_excecao_credito` têm 0 linhas, e é o **primeiro INSERT indevido** que é o dano. Um corte
   por volume teria descartado as três.

### E uma armadilha de FERRAMENTA, que quase virou um achado falso

O primeiro teste de merge contra o PR paralelo usou **`FETCH_HEAD`** — que um `git fetch` disparado
por um *hook* entre dois comandos havia sobrescrito. O merge rodou contra o branch **errado**,
saiu limpo, e a leitura natural ("sem conflito, e as entradas do outro somem") teria sido reportada
como achado grave. Refeito com ref nomeada estável (`origin/pr2068`): **conflito nos 3 arquivos**,
que era a realidade. ⇒ **`FETCH_HEAD` é volátil e não pertence a você**: para comparar contra um
branch alheio, materialize uma ref nomeada (`git fetch origin <branch>:refs/remotes/origin/<apelido>`)
antes de qualquer operação que leve mais de um comando.

### 7.1 A declaração de lacuna apodreceu em UM dia — e virou dado

O §7 acima entregou as lacunas como **prosa no cabeçalho do contrato**, com a razão de cada
recusa escrita. Doze horas depois, a **3ª rodada** (`b76a5838e`, sessão paralela) curou
`venda_excecao_credito`, `cliente_tier_preco` e `pedido_compra_item` — três tabelas que aquele
parágrafo declarava, por nome, como lacuna. O cabeçalho seguiu afirmando o contrário.

**Verde em todos os gates.** E não por descuido do desenho: os audits reconciliam o **contrato
contra prod**, e ninguém reconcilia a **declaração contra o contrato**. É a mesma classe de
"contrato falso é pior que lacuna", só que na direção espelhada — a que finge **não** cobrir. Essa
direção é mais difícil de notar, porque nada quebra e a única vítima é a próxima sessão, que lê a
razão errada e refaz a recusa.

E a razão que a 3ª rodada derrubou é o achado que valia o exercício. Eu recusei
`venda_excecao_credito` e `cliente_tier_preco` argumentando:

> "Os gates delas são, medido, `has_role(master)` puro: a raiz é `user_roles`, já curada."

Medição correta, conclusão errada. O argumento vale para o eixo da **raiz** e é **cego ao eixo 3**:
congelar `user_roles` não congela o **corpo** de `private.cap_credito_escrever` — reescrevê-lo para
`SELECT true` não move o md5 de policy nenhuma, que é exatamente o ponto cego que o eixo 3 existe
para fechar (§3). Curar a tabela **arrasta** o predicado para o congelamento; era esse o valor, e
ele não estava na tabela, estava na aresta.

> **Lição de domínio:** *"a raiz já está coberta" não é razão para recusar* — raiz e predicado são
> eixos diferentes. A pergunta certa é se o **gate daquela tabela** já é congelado por alguém.

### O resíduo: `LACUNAS_DECLARADAS`

A declaração saiu da prosa e virou `Record<string, string>` no próprio contrato, com quatro gates:

1. **nenhuma chave de `LACUNAS_DECLARADAS` é chave de `AUTHZ_RLS_ESPERADO`** — o defeito exato,
   pego por um teste de três linhas;
2. chave qualificada (`schema.tabela`) e razão com substância (>80 chars);
3. **sentinela do próprio gate:** a lista não pode ser esvaziada — sem o piso, `for` sobre lista
   vazia deixaria os dois primeiros passando por **vacuidade**, e o contrato voltaria a não
   declarar nada;
4. o eixo entrou no `dadoDoContrato('rls')`, então **mudar a declaração move o
   `contratoFingerprint`** — provado mudando UM motivo e medindo o hash antes/depois
   (`6dd89233…` → `015e3e4a…` → volta). Sem isso o eixo seria decorativo: tirar uma tabela da lista
   sem curá-la faria o contrato parar de dizer "isto não é coberto", e o carimbo atestaria uma
   cobertura que ninguém mediu.

Falsificação: F5 **recria o bug histórico** (declarar `venda_excecao_credito` como lacuna com ela
curada) → vermelho com a mensagem certa; F6 esvazia a lista → a sentinela grita; F7 remove o eixo
do carimbo → o teste de identidade dos QUATRO eixos reprova; F8 é o teste de fingerprint acima.

> **Classe (a terceira irmã, depois do `recusarEnvDeTeste` e do gate de `motivo`):** *prosa que
> descreve dado apodrece quando o dado muda, e nada no ponto de extensão avisa.* Nas três vezes a
> guarda estava **correta no dia em que foi escrita**; quem a tornou falsa foi o crescimento
> normal do sistema. Quando a afirmação pode ser expressa como **dado ao lado do dado que ela
> descreve**, é essa forma que sobrevive.

### 7.2 A mesma classe um nível acima: a CONTAGEM do grupo também era prosa

O §7.1 tirou da prosa a lista de tabelas recusadas. O que ficou para trás, no mesmo cabeçalho,
foram as lacunas em **bloco** — os grupos que não cabem como chave de tabela:

> "as **22** tabelas de `private.cap_carteira_ler` e as **8** de `private.carteira_visivel_para`;
> as **36** `fin_*` restantes (de 41; 5 curadas); e as outras **13** de `private.cap_compras_ler`
> (de 14)."

Medido em prod hoje (2026-08-28, psql-ro): **22 · 8 · 41 · 14**. O parágrafo estava **certo**, como
estava certo o da §7.1 no dia em que foi escrito. A diferença entre os dois é só o **gatilho de
apodrecimento**, e o do grupo é mais barato de puxar: a lista de tabelas apodrece quando uma
rodada **cura**; a contagem do grupo apodrece quando uma **migration** gateia mais uma tabela pela
mesma capability — o evento mais banal deste repo, e o que menos passa por revisão de autorização.
Nos dois casos o texto seguiria verde afirmando um número que ninguém mede.

**Por que um teste estático não resolvia.** O §7.1 fechou-se com um cruzamento de três linhas
(`LACUNAS_DECLARADAS` × `AUTHZ_RLS_ESPERADO`), porque as duas pontas viviam no arquivo. Aqui a
outra ponta é **prod**: só o banco sabe quantas tabelas `cap_carteira_ler` gateia hoje. O gate tem
de ser o **audit**, não o CI — e isso põe o eixo 4 no lugar certo, junto do 1-3, com o mesmo
psql-ro e o mesmo exit code.

#### O desenho, e as três decisões que ele obrigou

`LACUNAS_POR_GRUPO` é uma lista de `{def, tabelasNoGrafo, tabelasMd5, medidoEm, motivo}`, e
`db/audit-rls-prod.ts` reconta o grupo em prod a cada execução (`pg_depend` para grupo de
predicado, `starts_with` para grupo de prefixo), desconta as curadas e compara.

1. **Duas formas de definir grupo, não uma.** Três dos quatro grupos são "as tabelas que chamam tal
   capability" — uma aresta do grafo de `pg_depend`. O quarto (`fin_*`) é de **nome**, e reduzi-lo
   ao predicado teria sido a armadilha: o gate comum do domínio financeiro
   (`public.fin_user_can_access`) alcança **18** tabelas medidas, não 41. Uma `fin_nova` gateada
   por outra função continuaria sendo lacuna do grupo, e um grupo definido pelo predicado **não a
   veria entrar** — a mesma cegueira, com um sensor por cima dela.

2. **Declarar o TOTAL, derivar a lacuna.** A forma óbvia seria congelar "36 lacunas". Ela tem um
   cego exato: uma migration acrescenta uma tabela ao grupo (22→23) e uma rodada cura outra (0→1)
   no mesmo dia — a subtração devolve 22 e nada fica vermelho. O total só se move por prod, que é
   a única ponta que este eixo não controla; o número de lacunas é **recalculado** do contrato ao
   lado a cada execução, e por isso não pode apodrecer. É a subtração que dá o denominador da linha
   do veredito: `78 tabela(s) distinta(s) no grafo, 6 curada(s), 72 lacuna(s)`.

3. **`tabelasMd5` ao lado da contagem, pelo mesmo argumento.** Se "duas mudanças opostas se
   cancelam" justifica declarar o total, ela justifica fechar a **substituição**: uma tabela sai do
   grupo e outra entra no mesmo intervalo, e o total não se move. O md5 da lista ordenada custa uma
   linha por grupo e fecha isso; o achado imprime a **lista viva**, então o md5 nunca é o fim da
   leitura. O sort é feito em **JS** e não em SQL de propósito — o `ORDER BY` do Postgres usa
   colação, e `_` ordena antes de letra em `C` e é ignorado em ICU/pt_BR: o mesmo conjunto daria
   md5 diferente conforme o locale do servidor. As duas computações (JS e
   `md5(string_agg(… ORDER BY … COLLATE "C"))`) foram conferidas uma contra a outra antes de o
   número entrar no contrato.

**Dois códigos, não um.** `LACUNA_GRUPO_MUDOU` pede re-medir e renovar o número;
`LACUNA_GRUPO_CURADO` pede **apagar** a entrada, porque o grupo deixou de ser lacuna — é o espelho
exato de §7.1 um nível acima (a declaração mentindo na direção que finge **não** cobrir). Elas são
correções opostas, como `POLICY_NOVA` × `POLICY_ALTERADA`.

> 🔴 **A inversão perigosa, e o guard que ela obrigou.** `lacunas === 0` é verdade tanto para
> "todas curadas" quanto para "a medição voltou vazia". Diagnosticar a segunda como a primeira
> convidaria a **apagar a declaração por causa de uma query quebrada** — o pior desfecho possível
> num eixo cuja função é impedir que a declaração suma. Lista vazia cai no `MUDOU`, que lê como
> "o grupo encolheu para 0" e manda investigar.

#### Falsificação

Catálogo (harness PG17, `db/test-audit-rls-prod.sh`, **40 ok / 0 fail** nos dois locales): `GB`
migration gateia mais uma tabela pelo predicado → `LACUNA_GRUPO_MUDOU`; `GD` tabela nova casa o
prefixo → idem; `GF` **rename dentro do grupo** (contagem igual, conjunto outro) → acusa pelo md5;
`GH` grupo inteiramente curado → `LACUNA_GRUPO_CURADO` e **não** `MUDOU`; e o dente de cada um
(`GC`/`GE`/`GG`/`GI`: a acusação some quando o estado volta).

Contrato e carimbo: contagem alterada à mão → o audit real acusa contra prod; eixo removido do
`dadoDoContrato('rls')` → o teste de identidade dos **cinco** eixos reprova; `LACUNAS_POR_GRUPO`
esvaziada → a sentinela de vacuidade grita nos **dois** lugares (o piso estático do CI e o
`erroFatal` do runner contra prod), porque `for` sobre lista vazia passa por vacuidade.

> **A classe, agora com três instâncias e um padrão de crescimento:** *prosa que descreve dado
> apodrece* (§7.1) — e quando a prosa descreve **prod**, o gate não pode ser estático. A pergunta
> que sobra de cada declaração é uma só: **qual é a outra ponta?** Se ela está no arquivo, o gate é
> um teste; se está no banco, o gate é o audit. Escolher errado produz um gate que existe e não
> mede — que é pior que não ter, porque parece cobertura.
## 9. O limite nº 3 fechado por CONSTRUÇÃO (2026-08-28) — o fecho transitivo dos predicados

O §3 declarava, no item 3 dos limites: *"o fecho é completo por **coincidência do grafo medido**,
não por construção"*. Uma capability que passasse a chamar uma auxiliar nova sairia do alcance sem
alarme — e o verde do audit passaria a afirmar mais do que mediu. Esta rodada fechou isso.

### A escolha da fonte foi MEDIDA, e a opção "honesta" morreu na medição

`pg_depend` não registra função→função: o catálogo só rastreia o corpo de uma função SQL quando
ela é criada com o corpo-padrão `BEGIN ATOMIC`. Corpo **citado** (`AS $$ … $$`) — que é como toda
migration deste banco escreve — é string opaca para ele. Logo a descoberta do 2º nível precisa de
outra fonte, e as três candidatas foram medidas antes de escolher:

| fonte | disponível? | arestas | falso-positivo |
| --- | --- | --- | --- |
| `pg_depend` função→função | **não existe** para corpo citado | 0 | — |
| `pg_proc.prosqlbody` (árvore de parse, PG14+) | **1 função em 577** nossas; **nenhuma** das 10 predicado | 0 | — |
| `prosrc` + token NU (identificador solto) | sim | 15 | **4** |
| `prosrc` + token `nome(` resolvido pelo CATÁLOGO | sim | **11** | **0** |

`prosqlbody` seria a opção honesta — árvore de parse em vez de texto — e está **vazia neste
banco**. Não é preferência: é `AS $$ … $$` em toda migration, mais `public.fin_user_can_access`
ser plpgsql, a que `prosqlbody` nunca se aplica. **Opção descartada por medição.**

O token NU tem recall máximo e **4 falso-positivos em 15 arestas**, todos da armadilha do
`database.md` §4, e vale registrar a proveniência exata porque ela é didática:

- `auth.uid → auth.jwt` e `auth.role → auth.jwt`: a palavra `jwt` sai da **string literal**
  `'request.jwt.claim.sub'`. Nunca houve chamada.
- `has_role → auth.role` e `fin_user_can_access → auth.role`: a palavra `role` sai da **coluna**
  `role`, em `WHERE user_id = _user_id AND role = _role`.

27% de ruído numa allowlist fail-closed é ruído que treina a ignorar a allowlist — e o ruído aqui
não é aleatório, é sistemático nos nomes mais centrais da autorização.

### Por que a opção escolhida NÃO é "regex sobre corpo de função"

É a distinção que separa esta varredura das duas que produziram falso-positivo integral: **a
regex não decide nada**. Ela só PROPÕE candidatos, e quem resolve é `pg_proc` — se o token não
for o nome de uma função que existe, não vira aresta. E o casamento é por `proname` **nu**, sem
schema: pega a chamada qualificada e a não-qualificada (a lição do `SET SCHEMA` em
`database.md:159`, onde a regex media os não-qualificados e cegava justamente a classe que
quebrava), todas as sobrecargas, e a função que **sombreia** uma builtin. Over-inclusivo por
construção — que é a direção certa quando falso-negativo é o modo de falha caro e falso-positivo
custa uma mensagem de erro.

### O que continua fora, medido e não deduzido

1. **SQL dinâmico** (`EXECUTE` em plpgsql) — nenhum método estático o alcança. **0 funções** que
   gateiam policy em `public` o usam.
2. **Sintaxe de seleção de campo** (`SELECT t.f FROM t` ≡ `f(t)`, válida no PG) — ausente de todo
   corpo daqui.
3. **Nome de função fora de `[A-Za-z_][A-Za-z0-9_]*`** — **0 em 635**.
4. **Schema de sistema** — fora do alcance de quem edita este banco; as duas builtins alcançadas
   hoje (`current_setting`, `now`) são `lang=internal`, sem corpo SQL reescrevível. O
   **sombreamento** delas, esse sim gravável, é pego pelo casamento por nome nu.
5. **Saturação do teto de níveis** vira **exit 2**, não lista curta: truncar em silêncio é
   exatamente o falso-negativo que este eixo existe para fechar.

### Prod não mudou — e é isso que o denominador agora DIZ

O fecho contra as 20 tabelas curadas devolve as **mesmas 10 funções já declaradas**, em 523 ms.
A coincidência do §3 continua valendo hoje; a diferença é que ela virou **fato medido a cada
execução** em vez de suposição num comentário: o veredito passou a sair com
`fecho transitivo, profundidade 1; 0 alcancada(s) so por outra funcao`. No dia em que uma
capability delegar a uma auxiliar nova, essa linha muda **e** a auxiliar tem de ser declarada.

### Falsificação (4 sabotagens no DETECTOR) — e a que saiu VERDE

| # | sabotagem | resultado exigido |
| --- | --- | --- |
| 1 | termo recursivo REMOVIDO (volta ao 1º nível) | 22 vermelhos — Z1 sem `PREDICADO_ALTERADO`, Z3 sem `PREDICADO_NAO_DECLARADO`, e `PREDICADO_SUMIU` de `zz_gate2_b` derrubando todo cenário limpo |
| 2 | tokenizer NU (sem exigir o parêntese) | 1 vermelho, e só ele: Z6, `presente indevido: [PREDICADO_NAO_DECLARADO]` |
| 3 | `TETO_NIVEL = 1` (fecho trunca) | **exit 2**, não 1 — "SATUROU o teto"; 33 vermelhos |
| 4 | achado transitivo rebaixado de `error` a `warn` | ⚠️ **saiu VERDE**: 41/41 e 40/40 |

🔴 **A nº 4 é o achado da rodada.** Rebaixar `PREDICADO_NAO_DECLARADO` a aviso quando `nivel > 1`
é exatamente o silêncio que a allowlist fail-closed proíbe — e passou por 41 cenários e 40 testes.
A causa é o **par intrínseco do 2º nível**: para alcançar uma função nova, o corpo do chamador
precisa mudar, então `PREDICADO_ALTERADO` sempre acompanha, e sozinho já produz o exit 1. O Z3
casava a presença do código em qualquer lugar da saída, e o exit vindo de qualquer origem: as
duas âncoras **sobreviviam à sabotagem**.

A correção ancora no bit que a sabotagem move, nos dois oráculos: o vitest passou a exigir
`level === 'error'`, e o harness passou a capturar **stdout e stderr separados**, com um 5º
parâmetro em `esperar` para "este código tem de sair como ERRO". O stream é o diferenciador
**ASCII-safe** (o audit manda `error`→stderr e `warn`→stdout, e é o mesmo bit do exit code);
casar o emoji ❌/⚠️ seria casar byte não-ASCII, contra a lição #1483. Com o expect, a sabotagem 4
produz 1 vermelho no harness e 2 no vitest.

> **Classe:** *quando um achado sempre vem ACOMPANHADO de outro, a asserção que casa "o código
> apareceu" e "o exit foi 1" pode estar medindo só o acompanhante.* Não é o caso genérico do
> assert fraco — é o caso em que a co-ocorrência é **estrutural** (aqui: alcançar uma função nova
> exige mudar o corpo de quem a chama) e portanto nunca falta. A âncora tem de ser a propriedade
> que **só** o achado sob teste tem — aqui, o NÍVEL de severidade, não a presença nem o exit.

### O andaime também é fail-closed: o contrato de teste é derivado por regra INDEPENDENTE

O harness deriva o contrato sintético do banco limpo. Se derivasse com a **mesma** query do fecho,
um bug na descoberta apareceria dos dois lados e o cenário-baseline ficaria verde por cegueira.
A derivação usa outra regra — `pg_depend` (1º nível) **união** "toda função `zz_gate*`" —, então
descobrir de menos vira `PREDICADO_SUMIU` e descobrir demais vira `PREDICADO_NAO_DECLARADO`: os
dois sentidos caem no cenário A, que só é verde quando as duas regras coincidem. Foi exatamente
esse mecanismo que produziu os 22 vermelhos da sabotagem nº 1.

Harness: **31 → 41 cenários**. Z1 reescreve o corpo do gate de 2º nível com a policy **e** o
chamador byte-a-byte intactos; Z3 exige que uma 3ª função criada DEPOIS do contrato seja
DESCOBERTA; Z5 mantém fora do fecho quem ninguém chama (senão o eixo viraria "declare as 577
funções do banco"); Z6 trava a armadilha do §4 com o nome numa string **e** numa coluna homônima,
sem chamada. E a PARTE B ganhou o **B7**, que é o B5 um passo adiante: lá o corpo alterado era o
da função que a policy CHAMA; aqui nem esse muda — policy, predicado direto e RLS idênticos, e o
barrado passa a ver 2 linhas.

## 10. A 4ª rodada (2026-08-28) — a carteira, e uma razão que era falsa quando foi escrita

A §7.2 fechou a declaração dos grupos e deixou uma pendência nomeada: `cap_carteira_ler` (22
tabelas) e `carteira_visivel_para` (8) eram os últimos gates de alcance grande com o **corpo não
congelado** — nenhuma tabela curada os chamava, logo o eixo 3 não os alcançava.

**A escolha, medida e não intuída.** A tese do §8 — *o valor de uma entrada é o que ela PUXA* —
diz para procurar a tabela com mais arestas, não a mais importante. A medição achou **6** tabelas
na interseção dos dois grupos, e todas as seis puxam **três** predicados de uma vez:
`cap_carteira_ler` (22) · `cap_carteira_escrever` (15) · `carteira_visivel_para` (8). As seis são
intercambiáveis nesse eixo — mesmas 4 policies, mesmos 3 predicados —, então o desempate teve de
vir de outro lugar: `public.farmer_client_scores` foi a única com **número de margem**
(`gross_margin_pct`, `avg_monthly_spend_180d`) **e** linha em prod (6.633). Uma entrada, quatro
policies, três gates congelados.

> **O que a rodada acrescenta ao §8:** a tese diz para maximizar arestas, e não diz como desempatar
> quando o máximo empata. A resposta é **descer para o critério original** (i)/(ii)/(iii) como
> desempate, não como porta de entrada. "Puxa mais" seleciona o conjunto; "guarda o número"
> escolhe dentro dele.

#### 🔴 O achado: uma razão declarada que já nascia falsa

`LACUNAS_DECLARADAS['public.carteira_assignments']` justificava a recusa assim:

> "O predicado dela não fica órfão: **já é congelado** por ser chamado pelas policies das tabelas
> de carteira."

Era **falso no dia em que foi escrito**. As policies das tabelas de carteira chamam
`carteira_visivel_para`, sim — mas nenhuma dessas tabelas estava no contrato, e o eixo 3 só
descobre predicado a partir de **policy curada**. O predicado não era congelado por ninguém.

Isto é uma quarta instância da classe, e a mais desconfortável: as três anteriores (§7.1, §7.2)
eram declarações **corretas que apodreceram**. Esta nunca foi correta. E nenhum gate a pegaria —
os testes de §2 conferem que a lacuna tem razão **com substância** (>80 chars) e que ela não está
curada; nenhum confere que a razão é **verdadeira**, porque "verdadeira" aqui é uma afirmação sobre
o grafo de prod. A rodada a tornou verdadeira em vez de só corrigir o texto: curar
`farmer_client_scores` arrasta exatamente o predicado que a razão dizia estar coberto.

> **Lição:** *razão de recusa também é afirmação sobre prod, e envelhece igual — só que ela pode
> nascer errada, não só ficar.* O gate barato existe e é o mesmo do resto: quando a razão diz
> "já é congelado por X", isso é uma consulta (`AUTHZ_RLS_PREDICADOS`), não uma opinião.

#### O que a rodada mediu e não mexeu

`cap_carteira_ler` e `cap_carteira_escrever` têm o **mesmo `srcMd5`** (`836e8f46…`): hoje **quem
lê a carteira também a escreve**. Não é bug a corrigir aqui — é o estado, e congelá-lo é o que faz
o dia da divergência (ou o dia em que afrouxar a leitura arrastar a escrita junto) virar alarme. É
o mesmo padrão do trio `cap_compras_ler`/`cap_preco_escrever`/`cap_credito_escrever` (`5faf2a21…`).

As 4 policies são `roles = PUBLIC` (`polroles = {0}`), não `authenticated`: o gate é **inteiro** a
expressão mais o GRANT de tabela.

**Sessão paralela, e o que ela não mudou.** O §9 (fecho transitivo dos predicados) mergeou
entre o §7.2 e esta rodada, no mesmo arquivo. Ele não alcança os gates de carteira e nem
poderia: o fecho parte de **policy curada**, e nenhuma tabela de carteira estava no contrato —
é a mesma razão pela qual a razão de recusa acima era falsa. A entrada foi conferida contra o
auditor NOVO, que reporta `fecho transitivo, profundidade 1; 0 alcancada(s) so por outra
funcao`: os três predicados entram como chamada DIRETA, não pelo fecho.

**Efeito no eixo 4, sem editar uma linha dele:** as contagens declaradas (`tabelasNoGrafo`) não se
movem — a tabela continua no grafo. O que muda é o número **derivado**, e ele mudou sozinho:
`7 curada(s), 71 lacuna(s)` contra `6 / 72`. É a prova de que a decisão do §7.2 (declarar o total,
derivar a lacuna) faz o que prometeu.

### 11.1 A 2ª opinião derrubou a escolha — e o motivo é reutilizável

A separação do §11 removia **apenas** `estrategico` da capability de escrita. O ritual `/codex`
(xhigh, conduzido sem o founder copiar/colar) derrubou isso com um argumento que se sustenta:

> "Você provou a mecânica, não a regra de negócio. Remover somente `estrategico`, deixando
> `gerencial` e `super_admin`, parece taxonomia inferida pelo nome, não política confirmada. O
> teste vermelho ao reinseri-lo apenas congela essa suposição."

Está certo, e o remédio dele é melhor: **`master`-only** reproduz o acesso **efetivo medido** (nenhum
usuário possui os três papéis) e falha **fechado** para todo papel ainda não decidido. Se as duas
opções são invenção, ganha a que **preserva comportamento por construção**.

> **Lição:** *um teste que fica vermelho quando você desfaz a sua escolha prova que a escolha está
> implementada, não que ela está certa.* Falsificação mede o **dente do assert**, nunca a
> **correção da regra** — para essa, o oráculo é outro (revisão independente, ou o dado que
> mostraria a política real).

O custo foi pago com os olhos abertos e está no cabeçalho da migration:
`20260718190000_authz_capability_matrix_e2.sql` **registrou** a intenção de que os três papéis
tivessem carteira. `master`-only **descarta uma decisão registrada** — não apenas evita inventar
uma. A troca: em autorização, o dia em que existir um `gerencial` de verdade é um dia melhor para
decidir do que hoje, e nesse dia a negação é visível.

O corpo novo foi copiado **byte-a-byte** de `private.cap_compras_ler`, e o harness trava isso
(`A15b`): o md5 tem de colapsar em `5faf2a21…`, o trio que o contrato já documenta. Texto
equivalente-porém-diferente criaria um **quarto md5 para a mesma regra** — ruído puro no eixo 3.

#### Onde a 2ª opinião errou, por falta de contexto do repo — e o furo que apareceu ao verificar

O Codex propôs, para a janela entre merge e apply, um contrato com `accepted = {antigo, novo}`.
Não cabe: o contrato deste repo significa **"estado medido em prod"**, e mover o md5 antes do apply
deixaria o gate do carimbo vermelho em **todo PR do repo**, não só no da mudança.

Mas a preocupação tinha fundo, e verificá-la achou um buraco de verdade:

> `docs/migrations-audit.md` registra esta migration como o objeto `function
> private.cap_carteira_escrever` e a checa por **EXISTÊNCIA**. A função existe desde julho. Logo o
> audit devolve ✅ **com ou sem o apply** — falso verde para **todo `CREATE OR REPLACE` de objeto
> já existente**.

É a mesma classe do arquivo inteiro, no mecanismo que existe justamente para pegar "mergeou e
ninguém aplicou": **existência fazendo as vezes de estado**. Fica registrado como pendência com o
formato da correção já claro — para objeto recriado, o inventário precisa guardar o md5 do corpo
ESPERADO, não só o nome.

### 11.2 Aplicada — e a medição pós-apply que quase não aconteceu

`20260828213000_cap_carteira_escrever_master_only.sql` foi colada no SQL Editor em 2026-08-29. A
verificação pediu **cinco** medições, e o valor da rodada está em ter exigido as cinco:

| o que | esperado | medido |
|---|---|---|
| `srcMd5` de `cap_carteira_escrever` | `5faf2a21…` (previsto ANTES do apply) | `5faf2a21…` ✅ |
| `prosecdef` / `proconfig` | `true` / `search_path=public` | idem ✅ |
| `srcMd5` de `cap_carteira_ler` | `836e8f46…` (intacta) | idem ✅ |
| `EXECUTE` de `authenticated` | preservado | `true` ✅ |
| `EXECUTE` de `anon` | negado (PUBLIC segue revogado) | `false` ✅ |

O md5 bater com o que fora **previsto antes** do apply é o que transforma "rodei" em evidência: se
viesse outro valor, o certo seria parar, não carimbar. (Os dois md5 desta tabela são **normalizados**,
§3 — conferir com `md5(prosrc)` cru dá `86052d07…`/`4a2f49ed…` e faz a tabela parecer falsa.)

#### A armadilha de leitura que apareceu no meio

As duas últimas linhas **não voltaram** na primeira medição. A saída trouxe três resultados e um
`ERROR: permission denied for schema private` no fim — e um `grep` pelas linhas que interessavam
teria mostrado três ✅ e **nenhum sinal do que faltou**.

A causa: `has_function_privilege('anon', 'private.cap_carteira_escrever(uuid)', 'EXECUTE')` resolve
a função **pela assinatura em texto**, e isso exige `USAGE` no schema — que o `claude_ro` não tem.
Ler `pg_proc` direto funciona (catálogo é legível); **resolver o nome, não**. A forma por **OID**
(`has_function_privilege(rol, p.oid, 'EXECUTE')`, com `p` vindo de um join em `pg_proc`) não passa
por resolução de nome e devolve o dado.

> **Lição:** *a mesma função do Postgres tem sobrecargas com requisitos de permissão diferentes.*
> Sob um papel read-only deliberadamente estreito, prefira sempre a forma por **OID** — e trate
> linha que não voltou como **ausência de dado**, nunca como o valor que você esperava. Aqui o
> `psql` sinalizou com um ERROR; num caso com `LEFT JOIN` ou agregação, o mesmo buraco sairia como
> `NULL` silencioso.

### 11.3 O furo do §11.1, fechado — e as duas armadilhas que quase o fecharam errado

O §11.1 registrou a pendência: `docs/migrations-audit.md` checa objeto por **existência**, e a
função existia desde julho — logo o audit devolvia ✅ com ou sem o apply. Medido antes de corrigir:
**231 dos 1307 objetos** do inventário (18%) são definidos por mais de uma migration. É latente,
não um incidente: nenhuma migration está hoje por aplicar.

**O desenho errado, e por que o número o derrubou.** A correção óbvia — comparar o md5 do corpo e
reprovar quando difere — foi medida antes de ser escrita: **88 funções** divergiam do repo. Se
isso virasse ❌, o audit ganharia 88 alarmes que em sua maioria **não** significam "falta colar
SQL", e sim **deriva de prod** (edição direta no SQL Editor, que é o modo normal de operar este
banco). Alarme falso em massa é como uma seção nova nasce desligada.

Separar os estados é o que torna a seção útil. Medido em prod (2026-08-29), entre as funções
recriadas com corpo extraível:

| estado | nº | o que significa |
|---|---|---|
| corpo vivo == **última** migration | 68 | ✅ em dia |
| corpo vivo == migration **anterior** | **0** | ❌ *a posterior não foi aplicada* — o defeito |
| corpo vivo == **nenhuma** declarada | 24 | 🔴 deriva de prod — **não** é "falta colar" |

O estado do meio é o único que manda agir, e é exatamente o que a checagem por existência dava
como ✅.

#### 🔴 Duas armadilhas, ambas pegas por medir DUAS vezes

A classificação foi implementada em **SQL** (a seção emitida) e em **TypeScript** (um script de
medição), com a exigência de que as duas batessem. **Não bateram**, duas vezes:

1. **Migration UUID ignorada.** A primeira comparação usava a última migration **custom** que
   define a função. Mas as de nome UUID — aplicadas sozinhas pelo builder do Lovable — também
   redefinem objetos: medido, a última definição de `public.fin_user_can_access` está numa delas.
   ⚠️ *Correção do que eu havia escrito aqui:* afirmei que ignorá-las **acusaria DERIVA numa
   função em dia**. Medi, e é falso — na seção final, restrita a objetos recriados, **nenhuma
   função muda de classificação**. O dano real é **cobertura**: com as UUID a seção vigia 98
   funções, sem elas 87, e as 11 que saem simplesmente deixam de ser checadas. Silêncio, não
   alarme falso — o modo de falha mais discreto, e o mesmo que o §11.1 documenta. A afirmação
   errada sobreviveu a um commit porque a falsificação que eu montei para ela media a coisa
   errada (contagem de DERIVA, que **cai** ao excluir UUID porque a cobertura encolhe).
2. **Comentário strippado do corpo.** O extrator roda sobre o SQL com comentários **removidos**;
   `pg_proc.prosrc` os **guarda**. O md5 do texto strippado nunca bate com o banco para qualquer
   função com `--` no corpo. Efeito medido: **52 DERIVA com o texto strippado × 24 com o cru** —
   28 alarmes falsos.

> **Lição:** *duas implementações que PRECISAM bater são o oráculo mais barato que existe para um
> hash.* Nenhuma das duas armadilhas apareceria numa implementação só: cada uma produzia um
> resultado plausível, autoconsistente e errado. A mesma técnica pegou a armadilha do `btrim`
> (§11.2) — três defeitos, um método.
>
> E a lição de escopo: *a correção certa de um falso ✅ raramente é um ❌.* Aqui era **três**
> estados, porque "não aplicada" e "deriva" pedem ações opostas e a checagem ingênua as
> confundia.

### 11.4 Pendências abertas no fecho de 2026-08-29 (cópia durável dos chips)

Três pendências saíram desta série com chip criado. **Chip é destino perecível** — mora dentro da
sessão que o criou, e não há fila global. Se a sessão for arquivada antes do clique, não há
caminho conhecido de volta. Por isso o conteúdo essencial fica aqui.

**1. Confirmar o deploy das 8 edges mergeadas entre 28 e 29/08.** Cinco sessões paralelas
mergearam mudanças em `supabase/functions/` na mesma janela; neste repo merge **não** deploya edge
(chat do Lovable, manual), e a sessão dona pode ter fechado sem pedir. Arquivos: `_shared/`
(`sonda-fingerprints.ts`, `sonda-versao-contrato_test.ts`), `analytics-outbox-drain`,
`elevenlabs-transcribe`, `generate-bundle-argument`, e os quatro `omie-sync-*`
(`ctes-recebidos`, `nfes-recebidas`, `pedidos-compra`, `sku-items`, `vendas-items`). O pedido de
deploy tem de nomear **todos**, `_shared` incluído — prompt que nomeia um só deixa a edge sem
bootar (#2020). ⚠️ Duas são de SEGURANÇA (gate de IA paga): se não estiverem no ar, o gate está no
repo e não em produção. Confirmar antes via `versao.ts`/sonda, para não pedir deploy redundante.

**2. Triar as 27 funções em `🔴 DERIVA`.** A Seção 3 do #2105 passou a enxergá-las: corpo vivo que
não bate com **nenhuma** migration do repo — edição direta no SQL Editor que o repo nunca soube.
Zero em `NAO APLICADA` (bom). O produto é uma lista classificada (o vivo é mais novo ou mais
velho? divergência semântica ou formatação? é money-path?), não "consertar as 27" — a maioria deve
ser deriva benigna. Se alguma for money-path com divergência semântica, **isso** é o achado.

**3. Decidir o vocabulário morto de `commercial_role`.** 8 valores no enum, **3 linhas** na tabela
(`farmer`×2, `master`×1), e as capabilities de carteira testando três valores que ninguém tem — o
CLAUDE.md ainda descreve um terceiro vocabulário ("gestor/vendedor"). A evidência barata para
decidir entre migração abandonada, provisionamento sob demanda e divergência de fonte está no
§11.1, na ordem que a 2ª opinião propôs. ⚠️ Não repetir a afirmação errada corrigida no §11.1: os
`farmer` **têm** acesso à carteira, linha a linha, por `carteira_visivel_para`.
