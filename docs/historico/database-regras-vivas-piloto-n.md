# Piloto N do plano v3: `database.md` reescrito como regras vivas (2026-10-27)

Item N de "Depois do Top 5" do [plano de melhoria v3](../superpowers/plans/2026-10-21-plano-melhoria-v3/README.md) (§3 · decisão 🧭 #5, aprovada pelo founder em 2026-10-21 com as condições de merge do §5 item 5). É a mesma transformação do [piloto N do `money-path.md`](money-path-regras-vivas-piloto-n.md), agora no `docs/agent/database.md`, com as lições daquele piloto aplicadas **antes** do merge, e não depois.

## O que mudou

- `docs/agent/database.md`: 355 linhas / 195.038 bytes → 288 linhas / ~121 KB (**−38% em bytes**; contexto estimado por chars/4: ~48,8k → ~30,3k tokens). Cada regra reescrita fica com o que fazer, quando dispara, a exceção e onde está a prova, e termina com `(L<n>)`: a linha do doc antigo de onde veio.
- O corte é menor que o do `money-path.md` (−62%) porque o `database.md` já era mais denso em regra: 72 dos 225 blocos seguiram **idênticos** (comando, predicado SQL, nome de gate), e só os 153 que carregavam narrativa foram reescritos.
- 5 arquivos novos `database-casos-*.md` (~176 KB) com os 153 blocos antigos **verbatim**, copiados por script de `d850983fa`, cada um sob `## L<n>`. Só os links relativos a `docs/agent/` foram reapontados. Nenhum caso foi reescrito.
- Numeração §1–§7 (com §2b) e os 11 títulos de seção/subseção **preservados byte a byte** (`diff` dos `^#` antigo × novo: vazio).

## Condições de merge (README do plano v3, §5 item 5)

### 1. 2º leitor independente auditando o TEXTO das regras

O Codex (`scripts/codex-async.sh -r high`, gpt-6-astra, 161 s, cota em 49%) comparou o doc antigo com o novo bloco a bloco: **200 blocos conferidos, 10 achados**. Conferi os 10 contra o texto antigo, e os 10 procedem:

| L antiga | Classe | O que faltava no doc vivo |
|---|---|---|
| L27 | enfraquecida | cobertura "0 objetos sem SELECT" em `private` como eixo cumulativo, não só como explicação |
| L30 | alterada | as sondas diretas (`auth.refresh_tokens`, `vault.decrypted_secrets`) têm de FALHAR; a da ponte tem de SUCEDER |
| L238 | perdida | tabela fora da curadoria por estar vazia reentra na primeira linha |
| L241 | alterada | guard `COUNT(policies has_role)=N`, e por que o re-run é seguro (wrapped ainda casa `%has_role%`) |
| L252 | alterada | o negativo completo `!~ 'gerencial\|estrategico\|pode_ver_carteira_completa'` |
| L267 | enfraquecida | `NULL` > `RAISE` só quando os callers tratam o NULL |
| L277 | perdida | separar contato exige view operacional + fechar a tabela |
| L296 | perdida | `~~` e `SIMILAR TO` só com literal |
| L296 | enfraquecida | falso-positivo com âncora exige a validação a montante no corpo |
| L302 | perdida | varredura por `tsc` + canário que tem de errar na mesma rodada (TS2688 = "0 erros" por cegueira) |

Todos voltaram ao doc. Na 2ª rodada (mesmo Codex, 28 s), ele conferiu o texto atual achado a achado: **10/10 fechados, 0 perdas novas** nos bullets tocados.

**Lição que se repetiu:** os 10 achados são do mesmo tipo que a auditoria do `money-path.md` achou depois do merge. Quem reescreve comprime justamente a cláusula que acha óbvia (a 2ª metade de um predicado, a condição de uma exceção). Desta vez o achado veio antes do merge, como a lição do piloto anterior pedia.

### 2. Regressão de âncoras

`git grep "database.md"` fora do próprio doc: **567 citações**.

- **Por número:** `§1` a `§7` e `§2b` existem, com o mesmo título. As citações a `§56`, `§59`, `§61`–`§66` e `§75` são de numeração anterior ao doc atual e já não resolviam antes; ficaram fora do escopo, como o `§35` do piloto do `money-path.md`.
- **Por nome (`§"..."`):** `§"o ENVELOPE"` (80 citações) e `§"migration committada é IMUTÁVEL"` resolvem como antes (o 2º por caixa: o título é "Migration committada é IMUTÁVEL"). `§"o \`reloptions\` preserva o LITERAL"` (em `supabase/schema-snapshot.manifest.md`) já era aproximado antes e segue igual: o bullet é "`reloptions` de view preserva o LITERAL". `§"a classe inteira roda fora do CI"` e `§"Aposentar código"` estão na mesma linha que cita o `database.md`, mas são âncoras de outros docs.
- **Por texto lido por teste:** `scripts/authz-carimbo.test.ts` exige "FATIAS CURADAS enumeradas em \`AUDITS\`" e proíbe contagem por extenso: preservado (o teste roda no `bun run test`).
- **Citação `arquivo:linha`:** o `<!--cita: …-->` de `omie-vendas-sync/index.ts:3829` seguiu no bullet do agregado; `bun run docs:citacoes` verde.
- Nenhum gate ou hook lê outro trecho literal do `database.md`.

### 3. Setas do CLAUDE.md

As 21 obrigações que o CLAUDE.md resume com seta para o `database.md` (acesso/psql-ro, ENVELOPE, ON_ERROR_STOP, migration custom, `supabase/migrations/`, `CREATE OR REPLACE`/`security_invoker`/view-gate `off`/`DROP`+ACL, PostgREST, REVOKE de duas pontas, RLS, jsonb multi-writer, aliases `@placeholder.local`) foram buscadas no doc novo: **21/21 presentes**. Três delas (pré-flight `pg_get_functiondef`, view só acrescenta coluna, `DROP` apaga o ACL) estão no §5, e a seta do CLAUDE.md diz §4. Já era assim antes; ficou registrado e não foi mexido aqui.

### 4. Proxy de "erro de execução"

22 perguntas que as sessões fazem, tiradas das armadilhas do CLAUDE.md e das regras mais citadas. Para cada uma, `grep -F -A2 <palavra-chave>` precisa cair num trecho que carregue a obrigação. Scripts em `logs/piloto-n-db/` (gitignorado).

| Métrica | Doc antigo | Doc novo |
|---|---|---|
| perguntas respondidas | 21/22 | **22/22** |
| bytes devolvidos pelos 22 greps | 98.945 | **54.531** (−45%) |

A que falhava antes, **P13** ("vou mover função de schema"), caía no bullet do `SET SCHEMA`, que não apontava o `db/preflight-dependencia-funcao.sql`. O apontamento foi acrescentado.

## O que NÃO foi feito

- Nenhuma regra foi fundida ou cortada; o piloto mede o efeito de mover narrativa, não de podar regra.
- `deploy.md` segue fora, porque o `gates:frescura` lê o texto dele.
- Nenhum código, migration ou gate foi tocado.
