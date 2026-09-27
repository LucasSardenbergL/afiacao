# Conferência de prod pela nuvem — o chip que prendia o Mac (2026-09-27)

## O gatilho

Um `/fecho` numa sessão da NUVEM terminou, como tantos outros, num chip para uma sessão LOCAL:
*"Conferir prod da janela 26/09: 3 migrations e 4 edges"* — porque a nuvem não tinha `psql-ro` nem o
MCP do Lovable. O founder: *"eu não quero ficar fazendo esses testes que você mesmo deveria fazer
[…] visto a baixa capacidade do meu computador em rodar várias sessões em paralelo."*

O chip não nascia de regra nenhuma (nenhum doc manda a nuvem chipar). Nascia da SOMA de regras
fail-closed certas — "consulta que não respondeu não é veredito" — com a falta de braço: a única
saída honesta era delegar a quem tinha o braço, e quem tinha era o Mac.

## O que foi medido antes de desenhar

1. **A nuvem não alcança o Supabase por nenhum caminho.** `psql` existe no container, mas
   `db.<ref>.supabase.co` só tem AAAA (IPv6 — `Address family not supported`), o pooler em
   5432/6543 dá timeout, e HTTPS para `*.supabase.co` e `api.supabase.com` volta `CONNECT 403` do
   proxy. Pôr a credencial no ambiente da nuvem não resolveria nada.
2. **A credencial do `claude_ro` não pode sair do Mac.** `ci.yml` já decidiu ("o runner não tem
   `psql-ro`, e não deve ter"), e `database.md` §1 diz por quê: `pg_read_all_data` + BYPASSRLS +
   `net.http_post` herdado de PUBLIC é um canal de exfiltração completo. A saída óbvia — um workflow
   do GitHub com a credencial em segredo — reverteria esse invariante. Descartada.
3. **O MCP do Lovable é REMOTO** (`https://mcp.lovable.dev`, OAuth) — dá para ligá-lo como conector
   do claude.ai, e a sessão da nuvem passa a ter o mesmo braço da local, sem segredo em repo,
   runner ou ambiente.
4. **`query_database` não tem modo leitura** (piloto, Camada 3: entra como `postgres`, BYPASSRLS),
   **mas o lote multi-statement é UMA transação implícita** (medido lá). Medido aqui, em PG16: com
   `SET TRANSACTION READ ONLY;` na frente, o `INSERT` do mesmo lote morre com
   `cannot execute INSERT in a read-only transaction`, e o SELECT do lote enxerga
   `transaction_read_only = on`. Sozinho, o mesmo SET sai com WARNING e não trava nada.

## O desenho — o modelo TRANSPORTA, nunca redige

Os CLIs chamam `psql`; só o modelo chama ferramenta MCP. A ponte é `scripts/lib/transporte-nuvem.ts`:

- `--sql-nuvem` imprime UM texto: `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s';
  WITH … SELECT json`, com cada consulta do CLI embutida como subconsulta.
- A resposta traz, medidos pelo PRÓPRIO banco e amarrados num md5 do payload: `somente_leitura`,
  `teto`, o `sql_md5` do trecho marcado de `current_query()` (o texto EXECUTADO é o emitido) e o
  `medido_em`. O modelo não calcula md5 de cabeça: payload inventado não fecha a conta.
- `--dados-nuvem=<arquivo>` recusa (exit 2, marca `TRANSPORTE_*`) qualquer desvio e entrega ao
  juízo as MESMAS linhas do `psql -A -F '|' -t`. O juízo não sabe de onde a linha veio — é o ponto.

**A fidelidade vem do `record_out`, e a primeira versão errou.** Ela montava a linha com
`json_each_text(row_to_json(linha))`, que só coincide com o psql em text/numeric: o JSON fala
`true`, `2026-09-26T12:00:00+00:00` e `[1,2]`, o psql fala `t`, espaço e `{1,2}`. Trocado por
`q::text` — o literal de registro usa a MESMA função de saída de cada tipo que o psql imprime — e o
TS desfaz só o envelope (parênteses, vírgulas, aspas dobradas).

## As provas

- **vitest** (`scripts/lib/transporte-nuvem.test.ts` + os dois CLIs): cada recusa casa a SUA marca;
  o pacote pela nuvem sai **byte a byte igual** ao da sonda local, e o bloqueio do #2285 sobrevive
  ao transporte. 10 guardas sabotadas uma a uma, controle verde na mesma invocação: 10 vermelhas.
- **PG no núcleo do CI** (`db/test-transporte-nuvem.sh`, Eixo 5): o SQL rodado como o MCP roda (uma
  string) comparado com `cmp` ao psql em 5 consultas — boolean, timestamptz com microssegundo e
  `infinity`, array 2-D e com NULL, jsonb, NULL × vazio, quebra de linha DENTRO do campo, bigint fora
  do inteiro seguro do JS, SQL com `á`. Mais as recusas: escrita bloqueada (SQLSTATE 25006), trava
  ausente, statements separados (`psql -f`), SQL alterado, payload adulterado. `--falsificar`: 7
  sabotagens da lib num worktree do HEAD, todas vermelhas pela marca certa.

## O que NÃO está resolvido

- **O conector precisa ser ligado, uma vez, pelo founder** (claude.ai/customize/connectors →
  `https://mcp.lovable.dev`; a sessão lê conectores ao nascer). Até lá a nuvem não tem braço, e a
  regra é pedir o conector — não chipar para o Mac.
- **A 1ª medição real pelo MCP ainda não aconteceu.** O transporte foi provado contra PG16/PG17 e a
  semântica do lote foi medida no piloto; se o MCP reescrever o texto no caminho, o `sql_md5` recusa
  (`TRANSPORTE_SQL_DIVERGENTE`) — fail-closed, não verde falso.
- **Só a LEITURA ganhou transporte.** O PASSO 1 da sonda e migration são escrita: o envelope exige o
  pré-voo pelo `psql-ro`, então na nuvem seguem com o founder no SQL Editor (que abre de qualquer
  aparelho). Estender o envelope é decisão dele, com Codex.
- **O Codex não existe no container da nuvem** — é o mesmo problema desta nota, em outra ferramenta.
  A 2ª opinião deste desenho foi um revisor adversarial independente; o ritual `/codex` fica pendente.
- **Outros leitores de prod seguem só no Mac:** `edges-pendentes.sh` (na nuvem, use o
  `pendencias:deploy` pelo transporte), `deriva:corpo:prod`, as auditorias de authz. O transporte é
  genérico: ligá-los é passar as consultas deles pelo `gerarSqlNuvem`.

## A lição

**Capacidade presa a uma máquina vira fila humana.** Quando o braço só existe num lugar, toda regra
fail-closed certa ("não mediu, não é veredito") vira um chip para aquele lugar — e o gargalo passa a
ser a pessoa que clica. O conserto não foi afrouxar a regra nem copiar a credencial para mais
lugares: foi levar o BRAÇO (o canal que o founder já autoriza) até onde a sessão está, e fazer o
banco atestar o que o canal não garante.
