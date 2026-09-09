# De quem é a atomicidade da migration — e a cobertura que a recusa não trouxe

**2026-09-09.** Decidido com medição do corpus (716 migrations) + 2ª opinião Codex (gpt-6-astra,
max, 556s/184k tokens). **A decisão em si já aterrissou por outra sessão** (#2421 → #2434); este
documento registra o raciocínio e delimita o que ficou faltando, que é o que esta entrega faz.

## O conflito

Dois caminhos de escrita ATIVOS, com exigências OPOSTAS sobre os mesmos bytes:

| Caminho | Quem garante a atomicidade | O que exige do arquivo |
|---|---|---|
| **A** — SQL Editor / MCP `query_database` | ninguém que se possa nomear | **precisa** de `BEGIN; … COMMIT;` |
| **B** — `bun run db:aplicar` | o executor (abre a transação, grava o recibo nela) | **proíbe** — `EXECUTE` recusa comando de transação |

`aplicar_sql` roda o corpo por `EXECUTE p_sql` dentro do `BEGIN;` do próprio `db-aplicar.sh`.
Arquivo com envelope ⇒ `ERROR: EXECUTE of transaction commands is not implemented`. O sha256 do
ledger é sobre os bytes exatos ⇒ **não existe "duas versões do arquivo"**.

## O que a medição mostrou (e refutou)

- `BEGIN;`/`COMMIT;` em coluna 0 **fora** de dollar-quote: **115/115**, pareados. **Dentro**: zero.
  **Zero `PROCEDURE`** no corpus ⇒ `COMMIT;` dentro de `$$` nunca é legítimo aqui.
- A mina é só o **`END;`** — sinônimo de `COMMIT` no top level, mas fecha bloco PL/pgSQL e aparece
  em coluna 0 **dentro** de `$function$` (linha 272 de `20260908163659_…`). Um strip que o inclua
  decapita o corpo em silêncio.
- **Só 12 de 112** arquivos com envelope são emoldurados ponta-a-ponta: 18 têm `SELECT` de
  verificação **depois** do `COMMIT;`, 1 tem DDL **antes** do `BEGIN;`.
  ⇒ **A atomicidade "do arquivo" que a doutrina afirmava já era parcial na prática.**

## A decisão (aterrissou em #2434): detectar e recusar, nunca transformar

O wrapper passa a ser decidido pelo **destino**: obrigatório no Caminho A, recusado no `db:aplicar`.
Vence descascar pela **assimetria dos erros** — falso-positivo do detector custa uma recusa que um
humano lê; falso-negativo cai no erro do PG, alto e transacionalmente limpo; **nenhuma direção
corrompe bytes**. Um descascador tem a terceira direção, silenciosa. E teria de morar DENTRO de
`aplicar_sql` (no cliente, o que roda deixa de ser o que o sha registrou — foi o que #2421 tentou
e o banco recusou), isto é, superfície nova na função `SECURITY DEFINER` mais poderosa do banco.

## O que ESTA entrega acrescenta

A decisão e a prova da recusa do ENVELOPE aterrissaram por outras sessões (#2421 → #2434 →
`516fcfbe5`). Ficaram de fora três coisas:

1. **`RECUSA_FORA_DE_TRANSACAO`** — a classe que NÃO tem conserto. A recusa do envelope se
   resolve tirando o `BEGIN;`; `CREATE INDEX CONCURRENTLY` não roda em transação alguma, e o
   recibo só é atômico porque há uma. O padrão é ancorado em CREATE/DROP/REINDEX para não casar
   `REFRESH MATERIALIZED VIEW CONCURRENTLY` (10 arquivos o usam legitimamente).
2. **O CONTROLE (A12) + a sabotagem que o prova (S7).** A10/A11 mostram que os guards pegam o
   que devem; um guard que recusasse TUDO passaria nas duas. A12 é a fixture que tem de APLICAR:
   corpo de função com `BEGIN`/`END;` em coluna 0 dentro de `$funcao$` (81 arquivos do repo têm)
   e `REFRESH MV CONCURRENTLY`. S7 alarga o guard para casar `END;` e exige que A12 caia.
3. **A12b, o eixo POR FORA** — compara o corpo que o **Postgres guardou** (`prosrc`) com o do
   arquivo. Todo o resto mede o que o SCRIPT decidiu, e sensor que só consulta a máquina vigiada
   herda o defeito dela.
4. **A doutrina**, que não mencionava `db:aplicar` em lugar nenhum: `SKILL.md`,
   `postcondicao-embutida.md` §1 e o envelope do `database.md` seguiam mandando envolver em
   `BEGIN; … COMMIT;`. Quem lesse a skill escreveria migration com envelope e bateria na recusa.

### Falsificação (todas exigem VERMELHO, com controle verde na mesma invocação)

`S6` guard de CIC desligado → o PG recusa (4) · `S7` guard alargado para `END;` → o **controle**
cai (2), provando que A12 mede · `S8` transformação no CLIENTE → o banco recusa (`sha divergente`)
— foi o que derrubou o #2421 · `S9` transformação **SERVER-SIDE** → aplica limpo (0), passa por
todo guard e por todo o ledger, e **só A12b vê o corpo mudar**.

S8 e S9 juntos são o argumento de por que A12b existe: nenhuma sabotagem do cliente a derruba, e
sem S9 ela seria verde por **inalcançável** — verde por não medir nada.

Prova: PG17.10, locales `C` e `pt_BR.UTF-8`, normal (36 ✅) e `--falsificar` (24 ✅), zero ❌.

## Limites declarados

- **Sub-detecção é de propósito:** `END;` NÃO é detectado (ambíguo com bloco PL/pgSQL). Arquivo que
  feche o envelope com `END;` falha com o erro do PG — alto e limpo.
- **O ledger não é à prova do próprio escritor:** `claude_rw` tem `GRANT UPDATE` nele
  (`db/claude-rw-bootstrap.sql:179`), de propósito — é como o script marca `falhou` quando a função
  abortou. Trilha honesta, não inviolável. Fora do escopo.
- **`FOR UPDATE` trava por `p_id`, não por sha:** dois `db:aplicar` simultâneos do mesmo arquivo
  ganham ids distintos e **ambos executam**; só depois o índice único deixa um virar `aplicada`.
  "Re-aplicar é no-op" vale em SEQUÊNCIA, não sob concorrência. Fora do escopo; registrado.
- **A asserção de `search_path` do harness é fraca:** confere `proconfig IS NOT NULL`, então trocar
  o `search_path` por lixo passa. Fora do escopo; registrado.
