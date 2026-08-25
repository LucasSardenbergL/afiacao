# O REVOKE que não revoga — e o "read-only blindado" que era só do wrapper

> 2026-08-25. Auditoria do papel `claude_ro` no Postgres de produção (`fzvklzpomgnyikkfkzai`).
> Lição durável em `docs/agent/database.md` §1. **Nada foi aplicado no banco por esta sessão** — leitura
> e um PG17 local descartável; o único bloco de escrita está no fim, para o founder colar.

## Veredito em 5 linhas

1. O `REVOKE` proposto é **no-op silencioso** — grantee errado (é PUBLIC) e executor errado (`postgres` não
   é dono). Sai *Success* e nada muda. **Não foi entregue.**
2. Fechar o `net` por GRANT exige o dono `supabase_admin`, que o Supabase gerenciado não expõe — e revogar
   de PUBLIC sem re-`GRANT` mataria **52 dos 90 crons**.
3. O `net` é real como **exfiltração/SSRF**, não como invocação de edge.
4. **O furo maior estava noutro lugar:** `pg_read_all_data` deixa o `claude_ro` ler `auth.refresh_tokens` —
   **8 tokens vivos, 6 de `master`** — que viram sessão de master pela API pública. Esse **o founder
   consegue fechar**.
5. A leitura de `net._http_response` (canária) **sobrevive** a qualquer `REVOKE`.

## O que motivou

O `CLAUDE.md` e o `database.md` §1 chamavam o `claude_ro` de **"read-only blindado"**. A medição mostrou
que a frase valia para as tabelas de negócio e **não** valia para o schema `net`:

```
has_table_privilege('claude_ro','public.profiles','UPDATE')     -> false   (GRANT)
has_table_privilege('claude_ro','public.product_costs','UPDATE')-> false   (GRANT)
has_function_privilege('claude_ro', net.http_post, 'EXECUTE')   -> TRUE
has_table_privilege('claude_ro','net.http_request_queue','INSERT') -> TRUE
SELECT rolconfig FROM pg_roles WHERE rolname='claude_ro'        -> NULL
```

Com `rolconfig` vazio, o `default_transaction_read_only` não está preso ao papel — vem do `psqlrc` do
wrapper. **Confirmado positivamente:** a MESMA credencial, com `psql -X` (sem o `psqlrc`), abre sessão com
`default_transaction_read_only = off` e `transaction_read_only = off`. Com o wrapper, `on`. O freio é
100% client-side.

Hipótese de partida (razoável): `claude_ro` poderia enfileirar `net.http_post` e invocar uma edge, que roda
com `service_role` — uma primitiva de escrita **por fora do modelo de GRANT**.

## Achado 1 — o conserto proposto é no-op DUAS vezes

O conserto natural era `REVOKE EXECUTE ON FUNCTION net.http_post FROM claude_ro`. Ele falha por dois
motivos independentes, e **os dois em silêncio**.

**(a) Destinatário errado.** `claude_ro` não aparece em nenhum ACL do schema `net`. As funções têm
`proacl IS NULL` — ou seja, **nenhum grant explícito**, e o Postgres cai no ACL *default*, que é
`EXECUTE TO PUBLIC`. As tabelas têm `relacl = {supabase_admin=arwdDxtm/supabase_admin, =arwdDxtm/supabase_admin}`:
a 2ª entrada, de grantee vazio, é **PUBLIC com todos os privilégios** — e sem `*`, isto é, **sem grant option**.
`claude_ro` tem o privilégio por *ser* PUBLIC, não por grant nominal. Revogar por nome não tira nada.

É o espelho exato da armadilha já registrada no `database.md` (“`REVOKE FROM PUBLIC` **não** tira
`anon`/`authenticated`, que têm grant explícito”). A outra face: **`REVOKE FROM <papel>` não tira o que veio
de PUBLIC.** A regra por trás das duas é a mesma — *revogue do mesmo grantee que concedeu*.

**(b) Executor errado.** O SQL Editor roda como `postgres`, e `pg_has_role('postgres','supabase_admin','MEMBER')`
é **false**. O dono das funções e tabelas de `net` é `supabase_admin`. Um não-dono sem grant option não revoga.

E o modo de falhar é o pior possível. Provado em PG17 local espelhando a topologia medida
(`proacl NULL`, PUBLIC com `arwdDxtm` sem `*`, executor não-membro do dono):

```
[A-func] exit=0        REVOKE ... FROM leitor   (rodado pelo operador)
     WARNING:  no privileges could be revoked for "http_post"
     REVOKE
  => leitor EXECUTE depois: t

[B-func] exit=0        REVOKE ... FROM PUBLIC   (rodado pelo operador)
     WARNING:  no privileges could be revoked for "http_post"
     REVOKE
  => leitor EXECUTE depois: t | INSERT depois: t
```

`exit=0`, a palavra `REVOKE` na saída, e **o privilégio de pé**. No SQL Editor isso aparece como
*Success*. É falso verde da mesma família dos já catalogados em `evidencia-positiva-shell.md`: a ausência
de erro sendo lida como confirmação.

**Falsificação (o teste não é teatro):** o MESMO `REVOKE` rodado pelo **dono** vira `EXECUTE: f | INSERT: f`.
Script: `db/test-revoke-nao-dono.sh`.

## Achado 2 — o conserto CERTO tem raio money-path e não está ao alcance do founder

O grantee certo é **PUBLIC**, e quem consegue revogar é o **dono `supabase_admin`** — que o Supabase
gerenciado não expõe. Além disso, revogar de PUBLIC **sem re-GRANT** derrubaria a camada de sync inteira:

- 90 cron jobs, **todos** com `username='postgres'`; **52 chamam `net.http_*`**;
- mais 4 funções `SECURITY DEFINER` de `postgres` que chamam `net.http_*`
  (`_push_enviar`, `afiacao_os_sync_kick`, `fin_sync_retry_tick`, `sayerlack_retry_orfaos`);
- nenhum deles tem grant explícito — **todos dependem do grant a PUBLIC**.

A lista de re-GRANT correta não precisa ser inventada: o próprio Supabase a escreve em
`extensions.grant_pg_net_access()` (event trigger `issue_pg_net_access`) —
`supabase_functions_admin, postgres, anon, authenticated, service_role`. Detalhe: aquele bloco de
`REVOKE ... FROM PUBLIC` + `GRANT` só roda para `extversion IN ('0.2','0.6','0.7','0.7.1','0.8','0.10.0','0.11.0')`.
A prod está em **pg_net 0.19.5** ⇒ o bloco é pulado, e o grant a PUBLIC que se vê hoje é o default do
próprio pg_net. Consequência: **um upgrade da extensão pode restaurar o grant a PUBLIC** — qualquer fecho
por ACL aqui é regressível e precisa de sentinela.

## Achado 3 — a escalada É alcançável, por uma porta que eu não tinha olhado

> ⚠️ **Este achado começou invertido.** Eu havia concluído "a escalada morre na credencial" e **rebaixado a
> severidade**. O ritual `/codex` derrubou a conclusão com uma frase: *"a suposição de que '401 sem header'
> esgota as fontes possíveis de JWT/credencial"*. Esgotava as que **eu** tinha listado — não as que existem.
> O registro fica com o erro à vista porque a lição é o erro, não o resultado.

**A porta:** `pg_read_all_data` + `BYPASSRLS` dão ao `claude_ro` leitura de **`auth.refresh_tokens`**.
Medido: **404 tokens, 8 não-revogados — 6 `master` + 2 `employee`**, o mais recente atualizado **no mesmo dia
da auditoria**. Um refresh token vivo é trocável por access JWT em
`POST /auth/v1/token?grant_type=refresh_token`, que só exige a **anon key — pública, está no bundle**.

⇒ A cadeia real, partindo de um papel **read-only**:

```
SELECT token FROM auth.refresh_tokens WHERE NOT revoked   (pg_read_all_data)
   → troca na Auth API com a anon key pública            → access JWT de master
   → authorizeCronOrStaff passa                          → sync-reprocess / calculate-scores / monthly-report
```

E ela **nem precisa do `net.http_post`** — a troca acontece na API pública. Com o `net.http_post` a coisa
toda roda de dentro do banco. Ou seja: o furo do `net` é real, mas **não é a joia da coroa**; a joia é o
`pg_read_all_data` sobre o schema `auth`. `auth.sessions` = 8 e `auth.one_time_tokens` = 1 estão igualmente
legíveis.

**O que eu tinha checado, e que continua verdade** — só não era a lista completa:

- as **94** edges se autogateiam em código (`authorizeCron` / `authorizeCronOrStaff` / `authorizeMaster`,
  ou JWT/OAuth nas duas que não usam o helper). As 4 citadas: `sync-reprocess` = `authorizeCron`;
  `calculate-scores`, `omie-sync-status-produtos`, `monthly-report` = `authorizeCronOrStaff`;
- o `CRON_SECRET` **não** está no texto do cron (0/90 comandos com bearer/JWT/authorization). O comando
  busca por subquery em `vault.decrypted_secrets` **em tempo de execução** — e o `claude_ro` leva
  `ERROR: permission denied for function _crypto_aead_det_decrypt`;
- `SUPABASE_SERVICE_ROLE_KEY` é env da edge, não vive no banco;
- `net.http_request_queue` está **vazia** (pg_net 0.19.5 drena) ⇒ não há header de onde colher credencial.

⇒ Um `net.http_post` do `claude_ro` **sem header** para qualquer edge volta **401**. Com o JWT de master
colhido de `auth.refresh_tokens`, **passa**.

**O deputy confuso, que o Codex levantou, está FECHADO** (verificado, não assumido): as 4 funções
`SECURITY DEFINER` de `postgres` que chamam `net.http_*` de fato buscam o `CRON_SECRET` no vault
(`prosrc ILIKE '%vault%'` e `'%CRON_SECRET%'` = `t` nas quatro) — seriam um deputy perfeito. Mas o ACL
delas é **nominal e estreito**: `{postgres=X/postgres, service_role=X/postgres, sandbox_exec_…=X/postgres}`,
**sem entrada PUBLIC**, e `has_function_privilege('claude_ro', …, 'EXECUTE')` = `f` nas quatro. Foi o
`REVOKE`/`GRANT` nominal em função SECDEF que segurou — exatamente a prática que o `database.md` §4 já
manda repetir.

> ⚠️ **Armadilha de medição encontrada no caminho:** `SELECT count(*) FROM vault.decrypted_secrets` retorna
> `1` **sem decifrar nada** — o `count` não referencia a coluna, então a função de decriptação nunca é
> chamada. Por 5 minutos isso pareceu "o read-only lê segredo decifrado". Só ao pedir a coluna é que veio o
> `permission denied`. **Contar linha não é ler dado** — em view com coluna computada, o privilégio só se
> prova projetando a coluna.

## Achado 4 — o `net` ainda importa, por um motivo que independe de credencial

Mesmo sem a cadeia do Achado 3, o `net` não é inócuo. `net.http_post` é **egress HTTP arbitrário**: somado a
`BYPASSRLS` + `pg_read_all_data`, é um **canal de exfiltração completo dentro do banco** — `SELECT` da base
inteira (clientes, custos, financeiro) e `POST` para qualquer URL, **sem credencial nenhuma**, sem passar por
gate de edge. E `net.http_get` + a leitura pública de `net._http_response` (160 respostas retidas) formam uma
primitiva de **SSRF com leitura** a partir da rede do banco — a fila estar vazia não reduz isso, porque ela é
drenada enquanto as *respostas* ficam armazenadas. Some-se `net.wake()`/`net.worker_restart()`, também
`EXECUTE` para PUBLIC: alavanca de **disponibilidade** sobre os 52 crons.

Ou seja: a frase do `database.md` “é read-only, então **zero risco de integridade**” estava certa e era
**a pergunta errada**. O risco do papel nunca foi integridade — é **confidencialidade e disponibilidade**
(e, pelo Achado 3, integridade também, por caminho indireto).

## Achado 5 — a leitura da canária sobrevive a qualquer REVOKE (a preocupação era legítima e está resolvida)

O ritual de verificação de sonda/canária (`deploy.md`) depende de ler `net._http_response`. Revogar demais
quebraria a verificação de deploy. **Não quebra:** `pg_read_all_data` concede `SELECT` **e USAGE de schema
implícito**, independente do ACL.

Prova natural já disponível em prod: o schema `cron` **não** tem `USAGE` para PUBLIC nem para `claude_ro`
no `nspacl`, e mesmo assim `SELECT count(*) FROM cron.job` devolve **90**. Prova sintética: na falsificação
PG17, depois de o dono revogar `ALL ... FROM PUBLIC`, `has_table_privilege(leitor, ..., 'SELECT')` continuou
`t` enquanto `EXECUTE`/`INSERT` viraram `f`.

## Decisão

1. **Não entregar o `REVOKE` em `net`.** Está provado que é no-op silencioso pelas duas pontas. Entregar SQL
   que imprime *Success* sem mudar nada seria fabricar a sensação de furo fechado — pior que o furo.
2. **A prioridade inverteu: o que fecha de verdade é tirar o `pg_read_all_data`.** É ele que dá o
   `auth.refresh_tokens` (Achado 3), e é a única peça da cadeia que o founder **consegue** executar —
   `postgres` tem `admin_option` sobre `pg_read_all_data` (medido `t`). Custo: minha leitura passa a
   depender de `GRANT` explícito por schema. Decisão do founder, porque troca alcance de diagnóstico por
   fecho de credencial.
3. **`ALTER ROLE claude_ro [IN DATABASE postgres] SET default_transaction_read_only = on`** como freio
   complementar (viável: `postgres` tem `admin_option` sobre `claude_ro` **e** `CREATEROLE`). **Soft** — um
   `SET … = off` na sessão sobrepõe. Fecha o caminho **acidental** e o de **bypass-do-wrapper**, não o
   titular da credencial. Escrever que ele "impede o claude_ro de escrever" seria teatro; escrever que ele
   "protege contra acidente e wrapper ausente" é exato.
4. **Registrar o REVOKE correto** (abaixo) para o dia em que houver `supabase_admin` — ticket Supabase.
5. **Sem migration versionada.** Nenhuma migration do repo gerencia o papel `claude_ro` (ele nasceu
   ad-hoc); um `ALTER ROLE` em `supabase/migrations/` quebraria qualquer ambiente reconstruído do zero,
   onde o papel não existe, e entraria no `audit:migrations` como objeto não rastreável. Fica como bloco
   único no SQL Editor, documentado no `database.md` §1 — que é onde o setup do papel já mora.

### Tirar o `pg_read_all_data` sem cegar o diagnóstico (executável pelo `postgres`)

Antes de escrever este bloco eu **conferi que cada linha é executável pelo `postgres`** — repetir aqui o erro
do Achado 1 (entregar SQL que no-opa) seria cômico. O ACL de prod diz que dá:

| alvo | dono | o que autoriza o `postgres` |
|---|---|---|
| `public` (413 tabelas), `supabase_migrations` | `postgres` | é o dono |
| schema `cron` | `supabase_admin` | `postgres=U*` (USAGE **com** grant option) |
| `cron.job`, `cron.job_run_details` | `supabase_admin` | `postgres=r*` / `a*r*w*d*…` |
| `auth.refresh_tokens` | `supabase_auth_admin` | `postgres=ar*wdDxtm` ⇒ **grant option de SELECT** |
| `net.*` | `supabase_admin` | nada — **e não precisa**: USAGE e SELECT já vêm de PUBLIC |

```sql
REVOKE pg_read_all_data FROM claude_ro;

-- devolve só o que o diagnóstico usa
GRANT USAGE  ON SCHEMA public, supabase_migrations, cron TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, supabase_migrations TO claude_ro;
GRANT SELECT ON cron.job, cron.job_run_details TO claude_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;

-- auth: telemetria de login SIM, credencial NÃO.
-- `token` e `parent` são os valores trocáveis por sessão — ficam DE FORA, de propósito.
GRANT SELECT (instance_id, id, user_id, revoked, created_at, updated_at, session_id)
  ON auth.refresh_tokens TO claude_ro;
```

O `GRANT` por coluna existe porque `auth.refresh_tokens.created_at` é a melhor trilha de uso que o banco
tem — `fase-sem-sinal.md` a usa para medir login de employee. Cortar o schema inteiro pagaria o fecho com a
telemetria; cortar **só as duas colunas de token** não paga nada.

⚠️ `GRANT … ON ALL TABLES` só pega o que o executor possui ou tem grant option; o resto sai com `WARNING` e
**sem** privilégio — confira com `has_table_privilege`, nunca pelo "Success" (é a lição do Achado 1 aplicada
ao próprio conserto). E `ALTER DEFAULT PRIVILEGES` vale só para o que **o executor** criar dali em diante:
tabela nova criada por outro dono nasce invisível ao `claude_ro`.

## O bloco correto, para quando houver `supabase_admin` (NÃO rodar como `postgres` — vira no-op)

```sql
-- Requer o DONO (supabase_admin). Como postgres: exit 0 + WARNING + nada muda.
REVOKE EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.http_get(text,jsonb,jsonb,integer)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.http_delete(text,jsonb,jsonb,integer,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.wake(), net.worker_restart()              FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON net.http_request_queue, net._http_response FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA net FROM PUBLIC;   -- a fila é bigserial: sem isto sobra caminho

-- OBRIGATÓRIO no mesmo bloco: sem isto, 52 dos 90 crons + 4 funções SECDEF de postgres param.
GRANT EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer)
  TO supabase_functions_admin, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION net.http_get(text,jsonb,jsonb,integer)
  TO supabase_functions_admin, postgres, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION net.http_delete(text,jsonb,jsonb,integer,jsonb)
  TO supabase_functions_admin, postgres, anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON net.http_request_queue, net._http_response
  TO supabase_functions_admin, postgres, service_role;
```

Três avisos que o Codex acrescentou e que valem para o ticket:

- **Revogar só o `EXECUTE` de `net.http_post` não fecha nada.** Em 0.19.5 a função é SQL: ela **insere na
  `net.http_request_queue`** e chama **`net.wake()`**. Com a fila em `PUBLIC ALL` e `wake()` em
  `PUBLIC EXECUTE`, o chamador reproduz os dois passos na mão. Por isso o bloco acima revoga fila,
  sequências e `wake()`/`worker_restart()` — não só as três `http_*`.
- **Não re-conceder a `anon`/`authenticated` no automático.** Os fatos medidos provam necessidade para
  `postgres` (52 crons + 4 SECDEF); os demais papéis da lista do Supabase devem ser justificados por call
  graph real antes de voltar.
- **pg_net 0.19.5: upgrade da extensão pode restaurar o grant a PUBLIC** — reconferir `proacl`/`relacl`
  depois de qualquer bump. Qualquer fecho por ACL aqui é regressível.

`SELECT` de `net._http_response` **não** precisa de re-GRANT enquanto o `claude_ro` tiver `pg_read_all_data`
(Achado 5); se o item 2 da Decisão for adiante, ele passa a vir do `GRANT` explícito no schema `net`.

## Lições transferíveis

- **Revogue do grantee que concedeu.** `proacl IS NULL` não quer dizer "sem privilégio": quer dizer *ACL
  default*, que para função é `EXECUTE TO PUBLIC`. Antes de escrever `REVOKE`, leia o ACL **cru**
  (`proacl::text` / `relacl::text`) — `aclexplode(coalesce(acl, acldefault(...)))` **sintetiza** o default e
  faz PUBLIC parecer um grant que não está lá.
- **`REVOKE` por não-dono é no-op com exit 0.** O sinal é um `WARNING`, não um erro. Todo `REVOKE`/`GRANT`
  entregue para apply manual precisa de **query de verificação do privilégio** (`has_*_privilege`), nunca do
  "Success" do editor.
- **Contar linha não é ler dado.** `count(*)` numa view com coluna computada não avalia a computação — o
  privilégio só se prova projetando a coluna.
- **`pg_read_all_data` traz USAGE de schema implícito**, invisível no `nspacl`. Ao dimensionar o que um
  papel enxerga, `has_schema_privilege` conta a herança; ler o ACL cru, não.
- **"Read-only" é uma afirmação sobre o PAPEL; o wrapper é uma afirmação sobre a SESSÃO.** Documentar as
  duas com a mesma palavra ("blindado") foi o que deixou o furo invisível por 72 dias.
- **Leitura irrestrita É escrita, com um passo a mais.** `pg_read_all_data` sobre o schema `auth` entrega
  refresh token de `master`; refresh token vira access JWT na API pública, com a anon key que está no
  bundle. Um papel "só leitura" que alcança `auth.*` não é read-only — é write com latência. **Ao conceder
  `pg_read_all_data`, o schema `auth` é o que precisa ficar de fora**, não as tabelas de negócio.
- **"Não achei credencial" ≠ "não há credencial".** Eu tinha checado vault, texto do cron, fila do pg_net e
  env da edge, e concluí *401*. A lista estava certa e **incompleta** — faltava `auth.refresh_tokens`. Uma
  enumeração de fontes de credencial só vale como negativa se for enumeração do **schema inteiro**; caso
  contrário é ausência de dado se passando por prova (mesma família de `evidencia-positiva-shell.md`). Foi
  o `/codex` que virou a mesa: em auditoria, a 2ª opinião ataca a **suposição de completude**, que é
  justamente a que o autor não enxerga.
