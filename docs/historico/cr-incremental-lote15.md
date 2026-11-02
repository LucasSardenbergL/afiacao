# CR incremental com reconciliação de exclusões provada (plano v4, lote 15 — B3)

PR #3525 · desenho e evidência: [2026-11-01-fin-cr-incremental-design.md](../superpowers/specs/2026-11-01-fin-cr-incremental-design.md)

## O que entrou

`sync_contas_receber` deixou de relistar tudo 2×/dia (~450 páginas Omie por run). Por empresa: **A** conjunto
aberto inteiro, **B** alterados por `dAlt` em `[marca − 1 dia, hoje]`, **C** reconciliação de exclusões —
ausente de A∪B em 2 runs vira candidato e só sai do espelho com prova (listagem de 1 página do cliente na
janela de emissão), reconfirmação dos alterados de hoje e tombstone (`fin_contas_receber_excluidos`), com as
linhas travadas. Full semanal segue como rede de segurança. Bug vivo que motivou: 38 títulos ABERTOS
excluídos no Omie e eternos no espelho (oben 29, colacor_sc 7, colacor 2; R$ 16,5 mil; 14 ATRASADO).

Codex: desenho reprovado (P0: duas ausências não provam exclusão → prova por cliente); código reprovado
com 2 P0 + 5 P1 + 2 P2, todos aceitos (§8 do desenho).

## Em prod (2026-11-02)

- Migration `20261102020000` pelo `db:aplicar` (ensaio + apply, tentativa #864); validada por `psql-ro`:
  coluna, tombstone com RLS e 0 linhas, `anon`/`authenticated`/`PUBLIC` fechados, `FOR UPDATE OF r` no corpo.
- Edge `omie-financeiro` **v1.10-cr-incremental-reconcilia** (junto da `omie-vendas-sync` v1.31 do #3524,
  que o ledger também acusava) — envio 16:08Z, hashes 14/14 e 33/33, `pendencias:deploy` exit 0 às 16:40Z
  (`(versao, fonte)` CONFERE nas duas). 2,2 créditos.
- A regeneração do `types.ts` desse deploy desfez a nulabilidade de 35 colunas de novo → #3529.
- O `lovable-sensor-edicao` deu `EDICAO_DETECTADA` pelo eixo da resposta (`edit_id`/`commit_sha` presentes),
  mas o `commit_sha` devolvido era o próprio "Lovable update" do `types.ts` e as tool calls do agente foram
  só `sha256sum`/deploy/`curl`/leitura de log. Sinal a pesar: a resposta MCP pode carregar o id da
  regeneração tolerada.

## Cadência esperada e quando medir

Sem marcador, o 1º run (`fin-sync-cr-2x`, 08:20/14:20 UTC) é **full de bootstrap**; ao fechar ele publica
`fin_cr_full_ok`. O run seguinte é incremental e MARCA os ausentes; o próximo prova e apaga. Esperado:
`marcados` ≈ 29 / 7 / 2 no 1º incremental, `excluidos` > 0 no 2º, tombstones com evidência.

```sql
SELECT to_char(started_at AT TIME ZONE 'UTC','MM-DD HH24:MI') AS em, status,
       r.key AS empresa, r.value->>'modo' AS modo, r.value->>'reconciliacao' AS rec,
       r.value->>'marcados' AS marcados, r.value->>'candidatos' AS cand,
       r.value->>'inconclusivos' AS inconc, r.value->>'reobservados' AS reobs,
       r.value->>'excluidos' AS excl, left(error_message, 120) AS erro
  FROM public.fin_sync_log, jsonb_each(results) r
 WHERE action = 'sync_contas_receber' AND started_at > '2026-11-02 16:40+00'
 ORDER BY started_at DESC LIMIT 30;
SELECT company, count(*), min(excluido_em), max(excluido_em) FROM public.fin_contas_receber_excluidos GROUP BY 1;
```

Sinal de problema: `modo=incremental` com `error_message` repetido (marca não avança → janela B cresce), ou
`TETO` no C1 (filtro do Omie mudou). Residuais fora do lote: §8 do desenho.
