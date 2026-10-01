# A porta `aplicar_sql` fechada por ALLOWLIST: fora o dono e o `claude_rw`, ninguém (2026-10-01)

## O achado

A revisão adversarial da fila de `aplicar_sql` (#2702) deixou registrado, fora do escopo, que a porta tinha mais chaves do que o bootstrap nomeava. Medido em prod pelo psql-ro em 2026-10-01:

- **`aplicar_sql(text,text,bigint)`** (SECURITY DEFINER, dono `postgres`) tinha `EXECUTE` para `service_role`, `sandbox_exec_fzvklzpomgnyikkfkzai` e `claude_rw`, além do dono. A ACL direta: `{postgres=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres,claude_rw=X/postgres}`.
- **`db_aplicacoes`** (o ledger) tinha escrita para `authenticated`, `service_role` (`arwdDxtm`) e `INSERT` para os dois `sandbox_exec`.
- `service_role` e `sandbox_exec_*` têm **BYPASSRLS** e **LOGIN** (o `sandbox_exec_*` é o papel do builder do Lovable; `service_role` é a chave das edge functions).

Quem tem uma dessas credenciais podia abrir uma tentativa no ledger e chamar a porta, ou seja, **executar DDL/DML arbitrário como `postgres`**, dono dos ~425 objetos de `public`. Era anterior à fila: o `CREATE OR REPLACE` preserva a ACL, e o bootstrap só revogava `PUBLIC`, `anon` e `authenticated` — pelo nome.

**A origem é o DEFAULT ACL do schema `public`** (medido): toda função que o `postgres` cria nasce executável por `anon`, `authenticated`, `service_role` e `sandbox_exec_*`; toda tabela nasce com escrita para `service_role` e `INSERT` para os `sandbox_exec`. Revogar pelo nome deixa passar todo papel que o default ACL inclua e o REVOKE não cite — e amanhã pode haver outro.

## A decisão

Founder, 2026-10-01: **fechar as duas pontas** (a porta e o ledger) para `service_role` e `sandbox_exec`. Nenhum código do app ou edge chama `aplicar_sql` (varredura em `supabase/functions` e `src`: só o `types.ts` gerado a lista; 0 crons).

## O fecho: ALLOWLIST, não lista de nomes

`db/aplicar-sql-acl-allowlist.sql` (aplicado pelo `db:aplicar`; sem `BEGIN/COMMIT`, a transação é do executor) remove, por varredura da ACL viva:

- **porta:** todo `EXECUTE` que não é do dono nem do `claude_rw`;
- **ledger:** toda escrita (tudo menos `SELECT`) fora dos dois. O `SELECT` de quem já lia fica — o staff lê a trilha pela policy.

É por allowlist e não por nome porque o problema é o default ACL: só nomear `service_role`/`sandbox_exec` deixaria o buraco aberto para o próximo papel que o default incluísse. O mesmo bloco entrou no `db/claude-rw-bootstrap.sql` (seção 4), para um rebuild futuro já nascer fechado, e o `BOOTSTRAP_OK` ganhou os dois predicados do allowlist (`NOT EXISTS` papel não-super, não-`pg_*`, fora {dono, claude_rw}, que execute a porta ou escreva no ledger).

A PÓS relê o estado FINAL pelos `has_*_privilege` (que enxergam herança), não a ACL direta, e aborta se sobrar qualquer um; e confere que o `claude_rw` não se trancou e que o staff não perdeu a leitura. Superusuário (ignora ACL) e papéis `pg_*` ficam fora da conta.

## A prova (`db/test-aplicar-sql-acl.sh`)

PG17 descartável, bootstrap REAL, **a deriva de prod recriada na fixture** (`GRANT` direto a `service_role` e ao builder, os dois com `LOGIN`/`BYPASSRLS`), e então o arquivo REAL aplicado.

- **Fiel ao executor:** o delta é aplicado numa transação (`BEGIN`/`COMMIT` em volta do arquivo). Sem isso cada `DO` autocommita e a PÓS vira decorativa — foi o que a 1ª versão da prova pegou em si mesma: com os blocos autocommitados, um fecho furado no ledger "passava" porque o laço da função, ainda intacto, já tinha limpado o resíduo numa transação anterior.
- **18 asserts:** a deriva colou antes; depois do fecho, `service_role` e o builder não executam a porta nem inserem no ledger (A1–A4), `PUBLIC` não executa (A5), e os dois contadores de allowlist dão 0 (A6, A7); o `claude_rw` e o staff seguem funcionando (A8–A10); o delta é idempotente (A11), a PRE recusa sem a porta (A12), e a **PÓS tem dente**: com o fecho furado mas a PÓS intacta, a transação ABORTA com a marca certa e o resíduo segue de pé (A13 porta, A14 ledger), que o delta limpo então fecha (A15).
- **Falsificação (2, controle verde na mesma invocação):** `fecho_so_nome` (volta ao REVOKE por nome) deixa A1/A2/A6 vermelhos; `ledger_sem_fecho` deixa A3/A4/A7 vermelhos.
- No núcleo do CI nos dois modos (`falsificar=2`): 18 asserts em 5 s, falsificação em 10 s pelo runner real — cabe folgado nas partes de teto 20.

## A entrega

Aplico `db/aplicar-sql-acl-allowlist.sql` pelo `db:aplicar` **depois do merge**, de um checkout limpo, para a prod não divergir do bootstrap da main — como na fila do #2702. Validação por fora (psql-ro): a ACL da porta e do ledger sem `service_role`/`sandbox_exec`, o `claude_rw` intacto, o staff lendo.

## Codex

Fecho de autorização no caminho mais poderoso do banco: **revisão independente pendente** junto com a da fila (#2702), quando a cota reabrir (03/10 19:11). Caminho B: a prova PG17 falsificável cobre o intervalo.
