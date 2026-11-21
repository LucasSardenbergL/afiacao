# Clientes · "Todos · A–Z" por nome normalizado (2026-11-21)

Último item do programa da tela `/admin/customers` (#4027, #4028, #4032/#4036, #4044, #4057).
Migration `20261121132032_clientes_nome_ordenacao.sql` + front. **Deploy: migration → Publish.**

## Problema

A ordem A–Z da base completa (RPC `listar_clientes_base`, #4044) usava `profiles.name` cru. Os nomes vêm do Omie
sujos. Medição read-only em PROD (`psql-ro`, 16.099 clientes não-funcionários):

| Classe | Linhas | Efeito no A–Z cru |
|---|---|---|
| Prefixo de MEI `NN.NNN.NNN ` (raiz do CNPJ no nome) | 1.969 | ~20 páginas de "04.763.245 MARCO…" antes do "A" |
| Entidade HTML (`&amp;` 363×, `&apos;` 64×) | 420 | `&apos;JL ARTESANATO&apos;` abria a lista |
| Símbolo inicial (`.`, `(`, `+`, `&`) | 5 | `. ON ART E DESIGN` era o 1º cliente |
| Espaço duplicado / caixa mista / acento | 6 / 451 / 11 | ordem instável entre variantes |
| Começa por dígito sem ser MEI | 35 | marcas reais ("3M DO BRASIL"): continuam sob 0–9 |

O CPF do titular MEI fica no **fim** do nome ([medição de 2026-11-10](clientes-mei-cpf-no-nome-medicao-2026-11-10.md)),
então não mexe no começo do A–Z e não faz parte desta entrega.

## Desenho

- `private.nome_ordenacao(text)`, IMMUTABLE, faz `translate` de acentos nas duas caixas, depois `lower`, troca
  entidade HTML por espaço, tira o prefixo MEI, troca todo não-alfanumérico por espaço e colapsa os espaços.
  Nome só de lixo vira `NULL` e vai para o fim.
  - A PROD não tem `unaccent`, e mesmo com ela `unaccent()` é só STABLE. Por isso o `translate`.
  - **O `translate` vem ANTES do `lower` e nas duas caixas.** Sob collation `C`, `lower('Ô')` não baixa a caixa de
    não-ASCII. O teste nos dois collations pegou isso: no C, a postcondição deu "marco ant nio". Assim a chave não
    depende do collation do banco.
- `listar_clientes_base` ordena por `nome_ordenacao NULLS LAST, name, user_id` e devolve a chave numa coluna nova
  no fim. Assim o `.order()` do cliente repete as mesmas chaves por cima da página. Para mudar o `RETURNS TABLE` é
  preciso `DROP` + `CREATE`, e o `REVOKE` é reemitido nomeando `PUBLIC` e `anon`. A migration segue o molde
  TRAVA → PRE (md5 do predecessor = PROD) → CREATE → PÓS (A1–A7, com comportamento nos casos reais).
- **Sem coluna gerada em `profiles`.** `Auth.tsx` faz upsert de perfil, e um INSERT/UPSERT de linha inteira
  quebraria numa coluna gerada. **Sem índice.** O `count(*) OVER ()` lê o recorte inteiro (~16 mil linhas) de
  qualquer jeito, então um índice não evitaria o sort e só custaria escrita.
- Carteira (ordena em memória): `chaveOrdenacaoNome` + `ordenarPorNome` em `src/lib/carteira/escopo-clientes.ts`
  usam as mesmas regras, com desempate pelo nome cru e depois pelo `user_id`. O vitest cobre os mesmos casos da
  postcondição A2.
- Busca e nome exibido continuam sobre o `name` cru.

## Prova

- `db/test-clientes-nome-ordenacao.sh` (PG17). Aplica a predecessora (= PROD) e depois esta. Controle verde em
  **ICU en-US e C**, 39 + 39 OK. Falsificação 17/17 na mesma invocação: as 10 herdadas de #4044 mais A–Z pelo nome
  cru, NULL no topo, chave devolvida ≠ chave ordenada, prefixo MEI e entidade que não saem, PUBLIC aberto e PRE
  cega ao predecessor.
- Simulação em PROD (expressão inline via `psql-ro`): a 1ª página abre com as 35 marcas de dígito ("1009",
  "3M DO BRASIL"…) e depois "A&A CONSTRUCOES", "A CASA"… Nenhuma chave NULL.

## Nota de processo

O hook `migration-collision-guard` deu 🔴 apontando a predecessora `20261121120001` como "em voo" em 13 worktrees.
Era falso positivo: o arquivo já está na `origin/main` e o corpo em PROD é idêntico (md5 `46eb4a00…`). A PRE
anti-deriva da migration é a proteção real contra outra sessão ter recriado a função no meio.

## Incidente pós-merge: `types.ts` duplicado (main vermelha ~43 min)

Linha do tempo (UTC): o founder colou a migration antes do merge → **17:13** o Lovable (`gpt-engineer-app[bot]`,
`4807f3921` "Work in progress") regenerou `src/integrations/supabase/types.ts` já com `nome_ordenacao` → **17:21** o
squash do #4061 acrescentou a MESMA linha em outro ponto do bloco (o git mesclou sem conflito) → typecheck da main:
`TS2300 Duplicate identifier 'nome_ordenacao'` → **18:04** o #4063 (sessão churn-sem-historico) removeu a duplicata.

Lição: com a ordem "migration → Publish" e o apply ANTES do merge, o Lovable regenera o `types.ts` e o tipo que o PR
editou à mão chega em dobro. Depois do apply, e antes do merge, faça `git fetch` e confira
`git log origin/main -- src/integrations/supabase/types.ts`: se o bot já trouxe a coluna, rebaseie e tire a sua
linha. O PR verde não pega isso, porque o CI rodou na base anterior ao commit do bot.
