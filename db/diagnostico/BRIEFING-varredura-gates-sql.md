# Briefing — varredura da classe "o NOME prova o EFEITO" nos gates de SQL

Continuação dos PRs #1985 e #2001 (mergeados 2026-08-25). **Leia antes:**
`docs/historico/verificar-sonda-versao.md` §9 e §10 — a §10 é a varredura anterior, com o método
e a tabela dos 7 sites corrigidos.

## A classe

Gate textual que casa o **NOME** (ou a declaração) de algo no código-fonte e conclui daí que o
**EFEITO** dela aconteceu. Fechada duas vezes em TypeScript; nunca medida em SQL.

## Alvo

- Principal: `scripts/authz-funcoes.test.ts` + o manifesto que ele valida
  (`rg -l AUTHZ_MANIFEST scripts/ src/`).
- Secundário: `scripts/sonda-versao-sql.test.ts`.

## O suspeito, e por que ele é sério

O gate tem um `it('nenhuma entrada permite anon (estado medido em prod)')` que percorre o
**MANIFESTO** — uma estrutura de dados em TypeScript. "Medido em prod" descreve a **origem** do
dado (alguém mediu um dia), não o que o assert verifica hoje. O manifesto pode dizer
`permitido: false` para `anon` enquanto o `proacl` real da função em produção deixa `anon` executar.
É a classe: o texto está certo e a afirmação é outra.

O caminho pelo qual isso diverge **sem nenhum `GRANT` no repo** — e é por isso que a varredura
textual de migrations não pega — está no CLAUDE.md: **`DROP FUNCTION` + `CREATE` RESETA o ACL**
(só `CREATE OR REPLACE` preserva). Como o default de `EXECUTE` em função no Postgres inclui
`PUBLIC`, recriar uma função sensível sem reemitir o `REVOKE` **nomeando as roles** reabre para
`anon`/`authenticated` sem escrever uma única linha de `GRANT`. O `auditGrantsFuncoes` procura
`GRANT EXECUTE ... TO anon` no texto das migrations e não vê nada: não houve concessão, houve
**reset silencioso**.

## Método (`docs/agent/money-path.md` + CLAUDE.md)

1. **Assinatura com controle.** Monte a forma errada — uma migration com `DROP FUNCTION` +
   `CREATE` de função do manifesto, sem `REVOKE` depois — e verifique se `bun run test` aprova.
   Se aprovar, é da classe, e você tem **medição**, não dedução.
2. **Confronte manifesto × prod.** As 4 queries prontas estão em
   `db/diagnostico/authz-funcoes-acl-real.sql`. Leitura de banco você roda **direto**, com o
   wrapper read-only `~/.config/afiacao/psql-ro` (role `claude_ro`):
   `~/.config/afiacao/psql-ro -f db/diagnostico/authz-funcoes-acl-real.sql`.
   A **query 4** é a mais informativa para esta classe: `proacl IS NULL` é o rastro do
   `DROP`+`CREATE` — ninguém emitiu `GRANT`/`REVOKE` desde a última criação, e o default inclui
   `PUBLIC`.
3. **Conserto ancorado na fronteira**, no padrão do #2001: assert **POSICIONAL**, nunca
   enumeração de nomes — enumerar reprova código correto, e o conserto de um gate que reprova
   código correto é sempre afrouxá-lo. Se a fronteira for o banco (e o CI não consulta prod), o
   conserto legítimo pode ser um **gate de migration**: `DROP FUNCTION` de função classificada no
   manifesto exige `REVOKE` nomeando as roles no mesmo arquivo. Registre no PR por que essa
   fronteira, e não outra.
4. **Calibração nos dois sentidos:** a forma errada tem de reprovar; as formas legítimas **reais**
   medidas no repo têm de aprovar.
5. **Commite antes de falsificar** (restaurar costuma ser `git checkout --`), falsifique em código
   REAL (sabote, exija vermelho, restaure) e capture `exit 0` colado. Armadilhas em
   `docs/historico/evidencia-positiva-shell.md`: capture o `rc` **antes** de recortar a saída e
   propague-o (`[ "$rc" -eq 0 ]` como última instrução) — `echo $?` no fim fabrica veredito.

## Escrita: nunca aplique

Se a varredura achar função indevidamente aberta, o `REVOKE` vai para o **SQL Editor do Lovable**,
colado pelo founder (`docs/agent/database.md` §1). Atenção ao no-op medido no #1991:
`REVOKE ... FROM PUBLIC` **não** tira `anon`/`authenticated` quando existe grant explícito —
revogue **nomeando as roles**.

## Entrega

`heavy bun run test` (canônico do CI). PR próprio, respondendo no corpo **"instância única ou
classe?"** (passo 0 da skill `matar-classe`) e listando **todos** os sites varridos, inclusive os
limpos — prova de varredura completa, não de amostra.

---

## Medição de 2026-08-25 21:22 — leia antes de repetir o trabalho

Rodada contra a prod pelo wrapper read-only. **Dois resultados mudam o plano acima.**

### A hipótese do `DROP`+`CREATE` está REFUTADA

`proacl IS NULL` em **0 de 336** funções próprias (fora extensões). Toda função tem ACL explícito,
nenhuma no default do Postgres. Não existe em produção rastro de `DROP FUNCTION` + `CREATE` sem
`REVOKE`. A query 4 devolver zero linhas **é** esse resultado, não uma falha.

O grant a `anon` vem de outro lugar: é explícito (`anon=X/postgres`), no padrão do template Supabase
(`GRANT ... ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated`). Continue a varredura por aí,
não pelo reset.

### O que sobra depois de tirar o ruído

212 funções são executáveis por `anon`, mas o número bruto engana:

| Fatia | n | Alcançável por RPC? |
| --- | --- | --- |
| extensão `pgvector` | 118 | ruído |
| funções de **trigger** | 46 | não — o Postgres recusa chamada direta |
| chamáveis, `SECURITY INVOKER` | 47 | sim, mas o RLS da tabela decide |
| chamáveis, **`SECURITY DEFINER`** | **1** | sim, e **bypassa RLS** |

A única definer alcançável por `anon` é `public.get_public_tool_history(p_tool_id uuid)`, com
`anon=X` explícito. O nome sugere intencional e ela é usada em `src/queries/useUserTools.ts` — **não
tratada como furo**; precisa de veredito de produto sobre o histórico ser público.

**Ainda NÃO medido, e é o próximo passo:** 22 das 47 invoker ESCREVEM (`aprovar_pedido_sugerido`,
`cancelar_pedido_sugerido`, `gerar_pedidos_sugeridos_ciclo`, `registrar_aumento_via_vision` e
outras). Sendo invoker, o RLS de cada tabela decide se `anon` escreve de fato. Medir policy a policy
é o trabalho que sobrou.

### O achado de GATE é melhor do que a hipótese original

**O manifesto cobre 38 funções. A prod tem 336.**

O assert `'nenhuma entrada permite anon'` é literalmente verdadeiro **e vazio**:
`get_public_tool_history` permite `anon` e simplesmente não é uma entrada. O gate mede 38 de 38 e
reporta verde, e nada no verde diz que o universo é 336.

É a classe numa variação mais afiada: não é "o NOME prova o efeito", é **"o MANIFESTO prova o
universo"** — falta o DENOMINADOR. Prima da classe-irmã registrada na §10 de
`docs/historico/verificar-sonda-versao.md` (`N verificadas` sem dizer quantas ficaram fora) e do que
o CLAUDE.md já diz sobre sinal sem denominador. **É provavelmente aqui que o conserto deve morar**:
o gate tem de saber, e dizer, quantas funções da prod ele NÃO classifica.
