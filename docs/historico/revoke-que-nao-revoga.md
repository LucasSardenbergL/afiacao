# O REVOKE que não revoga — e o "read-only blindado" que era só do wrapper

> 2026-08-25. Auditoria do papel `claude_ro` no Postgres de produção (`fzvklzpomgnyikkfkzai`).
> Lição durável em `docs/agent/database.md` §1. A auditoria em si não escreveu no banco (leitura + PG17
> local descartável); o founder **aplicou os blocos no mesmo dia** — o resultado medido está na seção
> **Pós-apply**, no fim, inclusive um defeito do SQL que eu entreguei.

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

> 🔄 **ATUALIZAÇÃO 2026-08-26 — a conclusão continua certa, a JUSTIFICATIVA caiu no mesmo dia.** Este
> achado apoiava a sobrevivência da canária em `pg_read_all_data` (que dá `SELECT` + USAGE implícito). Mas
> o item 2 da Decisão foi aplicado horas depois e **removeu exatamente essa membership** — medido agora:
> `pg_has_role('claude_ro','pg_read_all_data','MEMBER') = false`. A leitura de `net._http_response`
> continua funcionando (`has_table_privilege = true`), só que hoje ela vem **exclusivamente do grant a
> PUBLIC** — a única perna que sobrou. ⇒ O bloco de REVOKE **não pode** tocar o `SELECT` dessa tabela; se
> alguém fechar, é preciso `GRANT SELECT ON net._http_response TO postgres, service_role, claude_ro` no
> MESMO bloco, senão o ritual de verificação de deploy morre em silêncio.
>
> **A lição é sobre a forma do argumento, não sobre o ACL:** uma conclusão sustentada por UMA premissa
> ("sobrevive *porque* `pg_read_all_data`") herda a validade dessa premissa. Quando o mesmo documento
> **recomenda remover** a premissa numa seção e **depende dela** noutra, o registro fica internamente
> inconsistente no instante do apply — e ninguém percebe, porque o comportamento observável não muda. ⇒ Ao
> escrever "X sobrevive porque Y", procure no próprio texto se alguém está propondo matar o Y.

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
-- Conferido contra prod em 2026-08-26 00:53 UTC (pg_net 0.19.5).

-- 1) Fechar PUBLIC
REVOKE EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer)   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.http_get(text,jsonb,jsonb,integer)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.http_delete(text,jsonb,jsonb,integer,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.wake()                                      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION net.worker_restart()                            FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON net.http_request_queue          FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON net._http_response              FROM PUBLIC;
REVOKE ALL ON SEQUENCE net.http_request_queue_id_seq                       FROM PUBLIC;

-- 2) OBRIGATÓRIO no mesmo bloco: sem isto, 52 dos 90 crons + 4 funções SECDEF de postgres param.
GRANT EXECUTE ON FUNCTION net.http_post(text,jsonb,jsonb,jsonb,integer)   TO supabase_functions_admin, postgres, service_role;
GRANT EXECUTE ON FUNCTION net.http_get(text,jsonb,jsonb,integer)          TO supabase_functions_admin, postgres, service_role;
GRANT EXECUTE ON FUNCTION net.http_delete(text,jsonb,jsonb,integer,jsonb) TO supabase_functions_admin, postgres, service_role;
GRANT EXECUTE ON FUNCTION net.wake()                                      TO supabase_functions_admin, postgres, service_role;
GRANT INSERT, UPDATE, DELETE ON net.http_request_queue                    TO supabase_functions_admin, postgres, service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE net.http_request_queue_id_seq     TO supabase_functions_admin, postgres, service_role;
```

> ⚠️ **A versão anterior deste bloco tinha TRÊS defeitos que só apareceram ao re-medir para o ticket
> (2026-08-26).** Ficam à vista porque a lição é o erro — e porque os três são a MESMA classe: *revoguei um
> privilégio e re-concedi outro*, prima do "GRANT que pousa e não alcança" da seção Pós-apply.
>
> 1. **`net.wake()` era revogado e nunca re-concedido.** As três `http_*` são **`SECURITY INVOKER`**
>    (`prosecdef = false`, medido) e chamam `net.wake()` no fim — logo quem precisa do `EXECUTE` é o
>    **chamador** (`postgres`), não o dono. Sem a linha de `GRANT … wake()`, os 52 crons quebram com todo o
>    resto correto.
> 2. **A sequence era revogada e nunca re-concedida.** `net.http_request_queue.id` é `bigserial`
>    (`default=nextval('net.http_request_queue_id_seq'::regclass)`, medido — não é `IDENTITY`), e `nextval`
>    exige `USAGE`/`UPDATE` **do chamador**. O `REVOKE ALL ON ALL SEQUENCES` com re-`GRANT` só nas TABELAS
>    dava `permission denied for sequence http_request_queue_id_seq`.
> 3. **O `GRANT` incluía `anon, authenticated`** — contradizendo o aviso escrito três linhas abaixo dele.
>    O bloco desmentia o próprio texto.
>
> ⚠️ **Não generalizar para `ALL FUNCTIONS IN SCHEMA net`.** `http_post` também chama
> `net._urlencode_string` e `net._encode_url_with_params_array`, ainda como INVOKER: um
> `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC` quebra os crons mesmo com as três `http_*`
> re-concedidas. O raio do REVOKE aqui se mede pelo **call graph do INVOKER**, não pelo nome do schema.
>
> ⚠️ **`SELECT` em `net._http_response` fica de fora do REVOKE de propósito** — ver Achado 5, que MUDOU.

Três avisos que o Codex acrescentou e que valem para o ticket:

- **Revogar só o `EXECUTE` de `net.http_post` não fecha nada.** Em 0.19.5 a função é **plpgsql e `SECURITY INVOKER`**: ela **insere na
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

---

## Pós-apply — 2026-08-25 (medido, não presumido)

O founder colou os blocos. Verificação por `psql-ro` e por sessão `psql -X`:

| o que | esperado | medido |
|---|---|---|
| `pg_read_all_data` no papel | removido | **0 memberships** ✅ |
| GUC preso ao papel | `on` | `pg_db_role_setting` = `{default_transaction_read_only=on}` ✅ |
| GUC **fora** do wrapper (`psql -X`) | `on` | `txn_ro=on`, `sessao_ro=on` (antes: `off`/`off`) ✅ |
| cobertura do `GRANT` em `public` | sem no-op | **413/413** com SELECT, 0 de fora ✅ |
| `cron.job` · `net._http_response` (canária) | legíveis | `t` · `t` ✅ |
| `auth.refresh_tokens.token` | negado | `ERROR: permission denied` ✅ |

**O `rolconfig` continua `NULL`** — o valor foi para `pg_db_role_setting`, porque o bloco usou
`ALTER ROLE … IN DATABASE postgres SET …`. Quem verificar só `pg_roles.rolconfig` vai concluir que não
aplicou. Foi um aviso do Codex que entrou no bloco e quase virou falso-vermelho na conferência.

### O defeito do SQL que eu entreguei

O `GRANT SELECT (…) ON auth.refresh_tokens` **pousou** — `information_schema.column_privileges` mostra as 7
colunas, com `token` e `parent` corretamente de fora. Mas ele é **inalcançável**: eu concedi USAGE em
`public`, `supabase_migrations` e `cron` e **esqueci `auth`**. O USAGE de `auth` vinha do
`pg_read_all_data` — implícito, invisível no `nspacl`, exatamente o mecanismo que o Achado 5 celebra. Ao
tirar a membership, ele foi junto. O erro que volta não é `permission denied for column`, é
**`permission denied for schema auth`**.

E não dá para consertar: `auth` é de `supabase_admin` e o `postgres` tem `U` **sem `*`** ⇒
`GRANT USAGE ON SCHEMA auth TO claude_ro` seria **mais um no-op silencioso**, a terceira vez neste mesmo
arquivo.

**Saldo:** segurança **melhor** que o desenho (o schema `auth` inteiro ficou fora, não só duas colunas);
promessa **não cumprida** — a telemetria de login do `fase-sem-sinal.md` morreu, e morreu em definitivo. Para
medir uso, sobra o PostHog. Junto foram-se `storage`, `realtime`, `graphql_public` e `extensions`; nenhum é
consultado em prod por este repo (verificado por `git grep`), então ficam como estão.

### A lição, que é a mesma do Achado 1 aplicada a mim

Eu conferi o **grant option da tabela** (`postgres=ar*wdDxtm`) e comemorei que o `GRANT` por coluna era
executável. Não conferi o **alcance do schema**. Privilégio de tabela sem USAGE de schema é gaveta trancada
dentro de sala trancada: o `GRANT` "funciona", o catálogo registra, e o acesso não existe.

⇒ **Ao remover `pg_read_all_data`, liste os schemas que o papel alcançava POR HERANÇA antes de escrever o
bloco** — `has_schema_privilege` responde `t` para eles enquanto a membership existe, e vira `f` no instante
seguinte. A conferência que pega isso é *rodar a consulta real*, não somar privilégios no papel.

### Bloco 3 — rodado e verificado, mas NÃO por mim

Invalidar os refresh tokens vivos foi aplicado horas depois, e **eu já não conseguia conferir** (perdi a
leitura de `auth`). A saída foi entregar um bloco que **se auto-verifica** — a consulta devolve a evidência
em vez de "Success" —, e o founder colou os números de volta:

```
vivos_antes = 3 · revogados_agora = 3 · ainda_vivos = 0
```

Coerente nos dois eixos: `antes == revogados` (ninguém entrou entre o `count` e o `UPDATE`, mesma snapshot
do statement) e a confirmação independente em `0`.

**Eram 8 na auditoria e 3 na hora do apply** — não é discrepância, é a natureza do dado: refresh token
rotaciona e expira, então "8 vivos, 6 de master" era **retrato datado**, nunca estoque. É a mesma regra do
§2 do `database.md` ("evidência de banco tem VALIDADE"), aqui aplicada a uma tabela que se move sozinha:
a contagem serve para dimensionar a exposição, não para conferir o fecho — quem confere o fecho é o `0`.

⚠️ **`jwt_exp = 3600`:** revogar o refresh token **não** derruba o access JWT já emitido. O staff só é
efetivamente deslogado conforme os tokens correntes expiram, em até **1 hora**. Para corte imediato não há
alavanca no banco — a validade do JWT é verificada pela assinatura, sem consulta.

⇒ **Quando quem aplica não é quem consegue verificar, o bloco entregue tem de carregar a própria
verificação** (CTE que reporta antes/depois), e a confirmação tem de ser um 2º statement independente. Pedir
"me diga se deu certo" devolve o "Success" do editor — que este arquivo inteiro existe para desqualificar.

---

## A sentinela — 2026-08-25, mesmo dia

Tudo que este arquivo narra é **estado colado à mão**. Não há migration que o defenda, e não pode
haver: um `ALTER ROLE claude_ro` em `supabase/migrations/` quebraria qualquer ambiente reconstruído
do zero (item 5 da Decisão). Estado que nenhum artefato versionado defende regride em silêncio —
outro bloco manual, um `GRANT` de rotina, um upgrade de extensão que o Supabase faz sem avisar.

`bun run authz:claude-ro:prod` (`db/audit-claude-ro-hardening.ts`) é o artefato que faltava: 25
asserções contra a PROD, exit `0`/`1`/`2`. Dente em `db/test-audit-claude-ro-hardening.sh` — PG17
descartável com a topologia medida, 19 cenários, o binário REAL rodando com `PSQL_RO` redirecionado.

**Quatro decisões de projeto vieram direto dos erros narrados acima:**

1. **O GUC é lido da UNIÃO de `rolconfig` + `pg_db_role_setting`.** É a armadilha da seção
   Pós-apply: o bloco usou `IN DATABASE`, `rolconfig` ficou `NULL`, e conferir só ele dá
   falso-vermelho. O dente prova os dois caminhos — move o GUC de fonte e exige que o veredito
   **não** mude.
2. **A cobertura de `public` é "0 objetos sem SELECT", não "413".** O `413` é 332 tabelas + 79
   views + 2 matviews, e o denominador cresce a cada migration. Congelar o total faria a sentinela
   ficar vermelha na próxima tabela criada, e sentinela que grita à toa é desligada. O `0` é
   invariante ao crescimento e ainda pega a regressão real: o `ALTER DEFAULT PRIVILEGES` só vale
   para o que o `postgres` cria, então tabela nascida de outro dono nasce invisível.
3. **Sonda executiva, porque catálogo não prova alcance.** `has_table_privilege` não conta o USAGE
   do schema — foi exatamente assim que o `GRANT` de 7 colunas em `auth.refresh_tokens` pousou e
   ficou inerte. A sentinela **roda** `SELECT` em `auth.refresh_tokens` e em
   `vault.decrypted_secrets` e exige que falhem. O veredito casa a **SQLSTATE `42501`**, não o
   texto: `lc_messages` do servidor pode mudar e "permission denied" viraria "permissão negada",
   quebrando uma asserção que não tem nada a ver com privilégio.
4. **Objeto AUSENTE é divergência, não "negado com sucesso".** `has_schema_privilege` erra com
   `3F000` em schema inexistente; um objeto que sumiu lido como negado seria o falso-verde
   perfeito — a sentinela comemorando por ter perdido o que vigiava.

**E uma lição nova, que só apareceu ao escrever o dente:** um `GRANT` explícito a PUBLIC **não**
restaura `proacl IS NULL`. Depois de `REVOKE … FROM PUBLIC` + `GRANT … TO PUBLIC`, o catálogo passa
a registrar nominalmente o que antes era ACL *default*, e o fingerprint acusa — corretamente. "É o
default" e "foi concedido a PUBLIC" conferem o mesmo privilégio hoje e são **estados diferentes**:
o primeiro muda sozinho num upgrade da extensão, o segundo não. Só o `DROP`+`CREATE` da função
devolve o `NULL`. Quem for reverter um fecho no `net` algum dia precisa saber disso, senão vai
achar que a sentinela está com defeito.

⚠️ **O baseline tem VALIDADE, como toda evidência de banco (§2 do `database.md`).** Um upgrade
legítimo do pg_net vai fazer o fingerprint divergir — é o comportamento desejado, e a linha
`versão do pg_net` no relatório existe para dizer na hora que a causa foi o upgrade. A resposta
certa é **reavaliar o novo ACL e atualizar o baseline**, nunca afrouxar a comparação.

---

## Encaminhado ao suporte — 2026-08-26

O fecho depende de `supabase_admin`, que o Supabase gerenciado não expõe ⇒ o único caminho é o suporte.
Pedido redigido (PT + EN), com o bloco corrigido acima, o baseline medido e uma **query de verificação que
foi executada contra prod antes de ser enviada** (`exit 0` — mandar SQL quebrado num ticket seria repetir o
Achado 1 numa terceira ponta). Canal do Lovable, verificado em `lovable.dev/support`: **email para
`support@lovable.dev`**, não há formulário de ticket (o `/support` não tem formulário e a home devolve 403
a browser headless).

**ENVIADO em 2026-08-26 03:06 UTC** — thread Gmail `1a03c0904655abf1`, confirmado com evidência positiva
(label `SENT`, `toRecipients = support@lovable.dev`, assunto e corpo conferidos), não pelo retorno da
chamada. **Aguardando resposta.**

### As 7 funções que SOBRAM com `EXECUTE` p/ PUBLIC — auditadas (2026-08-26)

O bloco fecha 5 funções (`http_post/get/delete`, `wake`, `worker_restart`) e deixa **7** de pé, porque
`http_post` chama duas delas como INVOKER e revogá-las quebraria os crons. Isso levanta a pergunta óbvia:
**as 7 dão alguma primitiva ao atacante depois do bloco?** Medido, não presumido — `_await_response`,
`_encode_url_with_params_array`, `_http_collect_response`, `_urlencode_string`, `check_worker_is_up`,
`http_collect_response`, `wait_until_running`:

| eixo | resultado |
|---|---|
| `prosecdef` (SECURITY DEFINER) | **`false` nas 7** |
| insere em `http_request_queue` | `false` nas 7 |
| chama `wake()` / `net.http_*` | `false` nas 7 |
| apaga de `_http_response` | `false` nas 7 |

⇒ **Não há deputy confuso em `net`.** O `secdef=false` é o eixo que decide: mesmo que uma delas tocasse a
fila, tocaria **com o privilégio do chamador** — que o bloco revoga. As 7 restantes leem `_http_response`
ou são puras (encode/urlencode/status do worker). Fechar `EXECUTE` nelas custaria os 52 crons e não
compraria nada.

⚠️ **REVISÃO INDEPENDENTE PENDENTE** (`money-path.md`, Caminho B). O ritual `/codex` sobre este bloco
falhou por **cota esgotada** (`codex-async.sh` exit 75) e a auditoria acima é **minha**, do mesmo autor do
bloco. Ela é medição reproduzível, não opinião — mas o que ela NÃO ataca é a **suposição de completude**,
que é justamente a que o autor não enxerga: foi exatamente assim que o Achado 3 saiu invertido, e foi o
`/codex` que virou a mesa. Enquanto o suporte não executar, a janela para a 2ª opinião continua aberta.

O pedido carrega as 4 perguntas que o registro deixou em aberto, uma delas a que mais importa a longo
prazo: **como impedir que um upgrade do pg_net restaure as ACLs públicas.** Enquanto não houver resposta,
qualquer fecho aqui é **regressível** — o sentinela é reconferir `proacl`/`relacl` após todo bump da
extensão. **Esse vigia existe desde a véspera e é automático:** `bun run authz:claude-ro:prod` compara o
ACL inteiro do schema `net` com o baseline e acusa mudança em qualquer direção, com `extversion` como
asserção ao lado — ver a seção anterior.

⚠️ **Só há resposta positiva quando o suporte colar a saída da query.** O "aplicamos, está resolvido" de um
ticket é exatamente o mesmo *Success* que este arquivo inteiro existe para desqualificar — com o agravante
de que quem aplica não é quem consegue verificar. Por isso a query foi ao ticket com o **antes** colado ao
lado do **depois esperado**.
