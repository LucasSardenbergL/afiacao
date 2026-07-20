# FU4-E — capability de ESCRITA em compras (`private.cap_compras_escrever`)

> Fecha a incoerência deixada consciente pelo E2/FU4 (#1434): o papel `gerencial` deixaria de
> **ler** a telemetria do motor de compras, mas seguiria podendo **alterá-la**.
> Money-path / autorização. Migration MANUAL (SQL Editor).

## 1. O problema

O #1434 substituiu o gate único `pode_ver_carteira_completa` por uma matriz de capability por
recurso × ação. As 9 tabelas `reposicao_*` de LEITURA passaram a exigir `private.cap_compras_ler`
(master-only), desacoplando compras do papel comercial.

Três RPCs de ESCRITA em compras ficaram no gate antigo — registrado como **FU4-E** no cabeçalho da
migration `20260718190000`:

| RPC | Efeito de escrita |
|---|---|
| `public.despinar_parametro(p_empresa text, p_sku text)` | `DELETE` em `reposicao_param_pin` |
| `public.reverter_parametro_auto(p_log_id uuid)` | reverte parâmetro aplicado; `UPDATE sku_parametros` + `INSERT reposicao_param_pin` + `UPDATE reposicao_param_auto_log` |
| `public.reverter_run_auto(p_run_id uuid)` | reverte um run inteiro (chama a anterior em loop) |

Todas `SECURITY DEFINER`, todas gateadas por
`IF NOT public.pode_ver_carteira_completa(<uid>) THEN RAISE EXCEPTION 'sem permissão'`.

Não é vazamento de custo/preço/crédito — é coerência interna de compras: quem não lê o estado do
motor não deveria poder mutá-lo.

## 2. Estado medido de PROD (psql-ro, 2026-07-19)

Medição que **corrige a premissa** com que a tarefa foi escrita:

- **#1434 está em DRAFT e a migration dele NUNCA foi aplicada.** O schema `private` tem apenas
  `carteira_visivel_para`, `is_super_admin`, `pode_ver_carteira_completa` — **zero** `cap_*`.
  Logo `private.cap_compras_ler` **não existe**.
- **#1427 (`20260718180000`) FOI aplicado** — ao contrário do que o cabeçalho do #1434 afirma
  (ele foi escrito em 18/07, quando ainda não estava). `private.pode_ver_carteira_completa`
  existe, e as 9 policies `reposicao_*` já apontam para ela.
- As 3 RPCs alvo usam **`public.pode_ver_carteira_completa`**, exatamente **1 ocorrência cada**.
  `reverter_parametro_auto` passa a variável `v_uid`; as outras duas passam `auth.uid()`.
- Owner `postgres`, ACL `{postgres=X, authenticated=X, service_role=X, sandbox_exec*=X}` nas três.
- `public.has_role(_user_id uuid, _role app_role)` — SECDEF, STABLE.
- `commercial_roles`: **2 farmer + 1 master**. Zero `gerencial`/`estrategico`/`super_admin`
  ⇒ a troca não retira acesso de ninguém vivo.

## 3. Decisão de estrutura: PR próprio, migration AUTÔNOMA

Aprovado pelo founder em 2026-07-19. `cap_compras_escrever` lê `has_role` **direto**, sem
referenciar `cap_compras_ler` nem o gate antigo — logo esta migration aplica-se **antes, depois ou
sem** o #1434, em qualquer ordem.

É o mesmo princípio que o próprio #1434 adotou ("robusta à ordem de aplicação") depois da falha do
#1423 (caller órfão). O founder aplica migrations à mão, uma de cada vez; uma esquecida falha em
SILÊNCIO. Ordem-independência é o que remove essa classe de falha.

Matriz de estados — **nenhum pior que hoje**:

| Aplicado | Resultado |
|---|---|
| ambas | estado-alvo: compras desacoplado do papel comercial nos dois lados |
| só esta | gerencial LÊ telemetria mas não MUTA — **mais restritivo** que hoje |
| só #1434 | a incoerência FU4-E original, já documentada |
| nenhuma | status quo |

Alternativas descartadas: **dobrar no #1434** (mexe em PR com CI verde e prova pronta, reabrindo
revisão de uma transação já grande) e **migration dependente** (cria ordem obrigatória entre dois
blocos manuais — o risco que o cabeçalho do #1434 argumenta ser inseguro).

## 4. Desenho

### 4.1 `private.cap_compras_escrever(uuid)`

```sql
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false)
```

Master-only, fail-closed em `_uid` nulo. Forma idêntica à `cap_compras_ler`, mas **função
separada** — exigência do spec §4.2 do #1434: é o que permite apertar um lado depois sem reabrir o
outro, mexendo em 1 função em vez das policies/RPCs.

`REVOKE ALL FROM PUBLIC, anon` + `GRANT EXECUTE TO authenticated, service_role`: obrigatório porque
o default privilege do Supabase concede `EXECUTE` em toda função nova (`database.md` §62 — o objeto
nasce aberto).

### 4.2 Troca do gate nas 3 RPCs — substituição programática guardada

Padrão da §3 do #1434: reescrever a partir do corpo VIVO (`pg_get_functiondef`), não colar corpo
verbatim (o repo diverge de prod em `CREATE OR REPLACE`; a última a recriar vence).

**Divergência obrigatória em relação ao #1434:** lá o replace fixava `auth.uid()` no padrão. Aqui
não pode — `reverter_parametro_auto` passa `v_uid`. Então troca-se apenas **nome + abre-parêntese**,
preservando o argumento verbatim:

```sql
regexp_replace(v_def, '(public\.|private\.)?pode_ver_carteira_completa\s*\(',
                      'private.cap_compras_escrever(', 'g')
```

O alternador aceita `private.` porque prod tem as duas formas do gate antigo (wrapper em `public` +
implementação em `private`); casar só `public.` deixaria passar uma reescrita futura.

Guards por função — qualquer divergência **aborta**, nunca aplica no-op silencioso:

1. função existe (por **assinatura**, `to_regprocedure` — não por `proname`, que escolheria um
   overload arbitrariamente);
2. **idempotência**: já migrada (tem gate novo, não tem antigo) ⇒ segue;
3. exatamente **1** ocorrência do gate antigo (medido);
4. replace **não** foi no-op;
5. gate antigo **sumiu** do texto novo;
6. gate novo **presente** no texto novo;
7. **pós-check no catálogo** após o `EXECUTE` (o guard textual valida a string que vai executar;
   isto valida o que o catálogo realmente guardou).

### 4.3 Precondições (abortam a transação)

- schema `private` ausente;
- qualquer das 3 funções ausente;
- `public.has_role(uuid, app_role)` ausente;
- **papel `gerencial`/`estrategico`/`super_admin` vivo** — replicando o guard do #1434: se alguém
  foi promovido entre a escrita e a aplicação, a troca tiraria acesso de uma pessoa viva sem aviso.
  Melhor abortar e revisar do que descobrir pelo suporte.

### 4.4 O que NÃO muda (deliberado)

Mensagem `'sem permissão'`, ausência de ERRCODE explícito (⇒ SQLSTATE `P0001`), `SECURITY DEFINER`,
`SET search_path`, assinatura, corpo, e o ACL (`CREATE OR REPLACE` preserva privilégios de função
existente — ao contrário de `DROP`+`CREATE`, que reaplicaria o default privilege do Supabase).
Trocar **só** o gate é precisamente o que a substituição programática garante.

## 5. Prova (PG17, `db/test-authz-cap-compras-escrever.sh`)

Molde: `db/test-authz-capability-matrix.sh`.

- **Lei #1 — executar, não só criar.** plpgsql é late-bound: `CREATE` passa com SQL inválido e só
  falha em runtime. As 3 RPCs são **chamadas de verdade**, com efeito de escrita verificado no dado.
- **Lei #2 — assert negativo com SQLSTATE + re-raise.** Captura `P0001` (o `RAISE EXCEPTION`
  sem errcode das 3) e re-lança o resto. Sem casar o **texto** da mensagem (anti-teatro de ILIKE);
  a sentinela do teste nunca contém o texto que o código emite.
- **RLS real:** tudo sob `SET ROLE authenticated` + GUC de uid, com guard de sanidade do harness
  (se o `SET ROLE` não pegar, todo assert seria falso-verde — psql roda como superuser).
- **Lei #3 — falsificação.** Sabotar `cap_compras_escrever` para aceitar o gate antigo deve deixar
  os asserts negativos **vermelhos**; restauração cirúrgica; e conferir **contagem e nomes** dos
  vermelhos (exit code não distingue "pegou o bug" de "não rodou nada").
- **Idempotência:** 2ª aplicação da migration com banco limpo passa (o founder cola à mão; queda de
  rede não pode travar a retentativa), e não desfaz o gate novo.
- **Autonomia:** um assert prova que a migration aplica **sem** `private.cap_compras_ler` existir —
  é a propriedade que sustenta a decisão da §3.

## 6. Entregáveis

1. `supabase/migrations/20260719120000_authz_cap_compras_escrever_fu4e.sql`
2. `db/test-authz-cap-compras-escrever.sh` (harness PG17 com falsificação)
3. Bloco pronto para colar no SQL Editor do Lovable + query de validação pós-apply
4. PR com a nota de deploy manual

Sem mudança de frontend: as 3 RPCs mantêm assinatura, retorno e mensagem de erro.
