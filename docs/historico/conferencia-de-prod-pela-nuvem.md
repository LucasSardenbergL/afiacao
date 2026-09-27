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

- `--sql-nuvem` imprime UM texto: a 1ª linha é `SET TRANSACTION READ ONLY; SET LOCAL
  statement_timeout = '30s';`, depois vem `WITH … SELECT json`, com cada consulta do CLI embutida
  inteira como subconsulta.
- A resposta traz, medidos pelo PRÓPRIO banco e amarrados num md5 do payload: `somente_leitura`,
  `teto`, `medido_em`, as `marcas` (o SQL do transporte aparece `1/1` vez no lote) e o `sql_md5` de
  `current_query()` do 1º caractere até a marca final (o texto EXECUTADO é o emitido). O md5 pega
  erro de TRANSCRIÇÃO, não forja: quem inventa um payload também sabe calcular md5. A regra que
  fecha essa porta é de procedimento: nunca montar, reconstruir nem calcular o payload.
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
  ao transporte. Contrato de mutação (`scripts/mutcheck.d/transporte-nuvem.mut`): 16 guardas, 16
  pegas, e 1 sobrevivente DECLARADA (a linha pelo `row_to_json`, que só a prova PG pega).
- **PG no núcleo do CI** (`db/test-transporte-nuvem.sh`, Eixo 5): o SQL rodado como o MCP roda (uma
  string) comparado com `cmp` ao psql em 7 consultas — boolean, timestamptz com microssegundo e
  `infinity`, array 2-D e com NULL, jsonb, NULL × vazio, quebra de linha DENTRO do campo, bigint fora
  do inteiro seguro do JS, SQL com `á`, a tabela `marca` com colunas `q`/`l` e SQL multilinha com
  comentário, dollar-quoting e aspa escapada. Mais as recusas: escrita bloqueada (SQLSTATE 25006),
  trava ausente, statements separados (`psql -f`), SQL alterado, payload adulterado, statement antes
  da trava e o SQL em dobro no lote. `--falsificar`: 10 sabotagens da lib num worktree do HEAD,
  todas vermelhas pela marca certa.

## A revisão adversarial e a v2 (`transporte-nuvem/2`)

Um revisor independente atacou a v1. O que ele achou e o conserto:

- **O hash começava na marca de INÍCIO.** Um statement enfiado antes da trava ficava fora dele.
  Pior, e medido (T11): passar a `READ ONLY` depois de escrever é permitido, então esse `INSERT`
  roda e PERSISTE. Agora o `sql_md5` cobre do 1º caractere, e a leitura sai recusada. A trava
  detecta, não impede: está escrito assim no doc.
- **O SQL em dobro no lote.** `<sql> COMMIT; INSERT …; <sql>`: o `COMMIT` fecha a transação
  implícita, o `INSERT` roda sem trava, e o `sql_md5` (até a 1ª marca final) fecha com a 1ª cópia.
  Só a contagem de marcas (`2/2`) recusa (T12).
- **A v1 juntava as linhas da consulta numa só,** e por isso recusava comentário, dollar-quoting e
  aspa escapada. Os nomes internos (`WITH marca`, alias `q`) também sombreavam uma tabela `marca`
  do usuário: dado errado, sem erro. A v2 embute a consulta inteira, com `__sql_nuvem_*` e
  `ROW(alias.*)` (T5:colisao, e a sabotagem `namespace-ingenuo` reproduz o defeito).
- **`medido_em` impossível.** O `Date` do JS aceita 30/02 e o transforma em 02/03 sem avisar. Agora
  a conferência é por ida e volta.
- **A afirmação sobre o md5 estava errada** (a frase dizia que payload inventado não fechava a
  conta). Corrigida acima.

## A 1ª conferência real e o incidente que ela causou (#2595)

O conector foi ligado no meio da sessão e as ferramentas entraram SEM reiniciar (depois caiu, também
no meio). A conferência da janela de 26/09 rodou pelo transporte: `md5`, `sql_md5` com UTF-8 e o
atestado `on` bateram em prod. O `query_database` acrescenta ~105 caracteres DEPOIS do SQL, e o
início chega intacto. Resultado: as 4 migrations aplicadas (o chip falava em 3), e as edges no ar.

O erro foi o deploy seguinte. Outra sessão já tinha pedido `sync-reprocess` 15 minutos antes, e o
ledger ainda não via: a nossa mensagem o deployou de novo, à toa. Terminado o deploy, o agente do
Lovable leu o log de build do workspace e "corrigiu" erros de tipo por conta própria. Vieram 3
commits `Changes` direto na `main`, um deles com `Number(codigoPedido)` em money-path (ausente vira
0), e o `sonda:fingerprint` ficou vermelho para todos. Revertido no #2595 (a reversão pura reprova no
`sonda:bump`, então a `VERSAO` bumpou). A lição que é desta nota: `list_messages` e PRs abertos
ANTES do `send_message`, porque o ledger ainda não via o deploy da outra sessão. A proibição de
edição no prompt e o sensor pós-envio vieram de outra sessão, no mesmo dia (#2596).

## O que NÃO está resolvido

- **O conector é do founder, e cai.** Sem ele a nuvem não tem braço, e a regra é pedir a reconexão
  em uma linha, não chipar para o Mac.
- **A v2 ainda não rodou em prod** (quem rodou foi a v1). Ela depende de o MCP não PREFIXAR nada ao
  texto, e o medido é que o início chega intacto. Se prefixar, o `sql_md5` recusa
  (`TRANSPORTE_SQL_DIVERGENTE`): falha fechada, sem verde falso.
- **Qual banco respondeu não está no payload.** A amarra é o `project_id` da chamada. Pôr a
  identidade do cluster no payload (`pg_control_system()`) depende de medir se o papel do conector
  pode lê-la.
- **Só a LEITURA ganhou transporte.** O PASSO 1 da sonda e migration são escrita: o envelope exige o
  pré-voo pelo `psql-ro`, então na nuvem seguem com o founder no SQL Editor (que abre de qualquer
  aparelho). Estender o envelope é decisão dele, com Codex.
- **O Codex não rodou nesta sessão.** A rede do ambiente negava `api.openai.com` (`CONNECT 403`,
  medido), e no mesmo dia o founder decidiu que o Codex roda só no Mac, na cota do plano (#2597).
  Na nuvem, a 2ª opinião é o Caminho B: a deste desenho foi um revisor adversarial independente.
- **Outros leitores de prod seguem só no Mac:** `edges-pendentes.sh` (na nuvem, use o
  `pendencias:deploy` pelo transporte), `deriva:corpo:prod`, as auditorias de authz. O transporte é
  genérico: ligá-los é passar as consultas deles pelo `gerarSqlNuvem`.

## A lição

**Capacidade presa a uma máquina vira fila humana.** Quando o braço só existe num lugar, toda regra
fail-closed certa ("não mediu, não é veredito") vira um chip para aquele lugar — e o gargalo passa a
ser a pessoa que clica. O conserto não foi afrouxar a regra nem copiar a credencial para mais
lugares: foi levar o BRAÇO (o canal que o founder já autoriza) até onde a sessão está, e fazer o
banco atestar o que o canal não garante.
