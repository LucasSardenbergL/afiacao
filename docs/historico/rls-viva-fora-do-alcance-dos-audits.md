# A RLS viva estava fora do alcance dos audits — a quarta guarda (`authz:rls:prod`)

> 2026-08-27. Fecha o ponto cego que os três audits de autorização de prod declaravam mas não
> cobriam. Entrega: `bun run authz:rls:prod` (`db/audit-rls-prod.ts`), contrato curado em
> `scripts/authz-rls-esperado.ts`, comparador puro em `scripts/lib/authz-rls.ts`, dente em
> `db/test-audit-rls-prod.sh` (31 cenários, PG17 descartável) e `scripts/authz-rls.test.ts`
> (32 testes, CI). **Nenhum DDL saiu da sessão** — não havia o que corrigir.

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

## 6. O que ficou de fora desta entrega, e por quê

A tarefa pedia integrar a guarda ao **carimbo de evidência** — quarta chave em `AUDITS` de
`scripts/lib/authz-carimbo.ts`, mais o bump de `SCHEMA_VERSION`. Medido antes de codar: esse
arquivo **não existe na `main`**. Ele vive no PR #2044, aberto, não-draft e com `mergeable:
CONFLICTING` — e o `AUDITS` de lá já tem **quatro** chaves, não três (`funcoes`, `grants`, `audit`
e `claudeRo`, esta última acrescentada 12 commits depois de o carimbo nascer). A chave de RLS seria
a **quinta**.

Basear esta entrega no branch do #2044 herdaria o conflito e prenderia a guarda numa fila que não
controlo; trazer o carimbo inteiro para cá duplicaria o trabalho de outra sessão. A guarda foi
entregue **autônoma na main**, no mesmo formato dos outros quatro audits — que é o padrão do repo,
não um mecanismo novo: o carimbo é a camada que os *enumera*, e enumerar um audit que já existe é
uma edição de poucas linhas. O acoplamento pendente está registrado no `database.md` §1 e num chip.

---

**Lição que sobra, além do domínio:** *um ponto cego declarado continua sendo um ponto cego.* O
limite estava escrito, correto e visível no cabeçalho do carimbo — e mesmo assim `relrowsecurity`
ficou sem leitor. Declarar o não-medido é o que impede o verde de mentir; não é o que fecha o
buraco. O que fecha é um comando que responda, com denominador na linha do veredito.
