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
junto. Elas são **descobertas por `pg_depend`** (`classid='pg_policy'` → `refclassid='pg_proc'`),
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
3. **O 2º nível do grafo de predicados** — `pg_depend` registra policy→função, mas **não** registra
   função→função. O md5 de `cap_custo_ler` não se move quando o corpo de `has_role` muda. Hoje o
   fecho é completo por **coincidência do grafo medido** (`cap_custo_ler` e `cap_pedido_escrever` só
   chamam `has_role`, que já é predicado direto de outras policies), não por construção.
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
