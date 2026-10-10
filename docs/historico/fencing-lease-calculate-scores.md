# Fencing real do lease do `calculate-scores` (2026-10-10)

Follow-up do #1578. O lease row-based (`claim_calculate_scores`/`finalizar_calculate_scores`) era **cooperativo**: um run que perdesse o lease por TTL e continuasse vivo gravava o snapshot velho por cima do run novo — a única cerca era a premissa externa "a plataforma mata a edge antes do TTL".

## O que mudou

- `apply_score_updates(p_updates, p_run_id DEFAULT NULL)` (migration `20261010120000`): com token, só escreve se `sync_state` (`calculate_scores`/`global`) está `syncing` **com** `metadata->>'run_id' = p_run_id`, conferido sob **`FOR SHARE` na mesma transação** da escrita → `55000` sem escrita. `''`/espaços → `22004`. `NULL` → sem fencing (retrocompat). TTL **fora** do predicado (só a troca de dono revoga). `DROP`+`CREATE` (sobrecarga = 42725) em `BEGIN/COMMIT`, ACL reemitido por nome, `NOTIFY pgrst`.
- Edge `calculate-scores` v1.2: token fixo no run (`aplicarChunkCercado`, `_shared/lease.ts`); `55000` para o laço; seed **insert-only** (o `DO UPDATE` do seed era escrita fora da cerca).
- Granularidade por chunk; staging + publicação atômica ficou fora (parcialidade por crash já existia — declarada).

## Lições

1. **`PGRST202` não prova "função ausente".** É também o cache de schema velho de um banco que JÁ tem a assinatura nova. Fallback que rebaixa o run inteiro ao ver `PGRST202` tira a cerca de quem a tem (challenge Codex). Regra: espere/re-tente **com** o token, caia só no chunk, e emita `NOTIFY pgrst` na migration.
2. **Largada observada por dentro de transação aberta = falso verde.** A 1ª prova de concorrência (C3) esperava A aparecer numa tabela via INSERT feito *dentro* da transação ainda aberta de A — invisível às outras sessões até o COMMIT. O laço batia no timeout, B largava depois do commit e C3 ficava verde **mesmo sem lock**. Só a falsificação F2 (tirar o `FOR SHARE`) denunciou. Sinal de largada sai do banco (`\!` do psql → arquivo); bloqueio se **observa** (`pg_blocking_pids`), não se infere de `pg_sleep`; todo laço com teto devolve `TIMEOUT`, nunca veredito.
3. **Prova de lock nos dois sentidos.** "A trava primeiro → o claim espera" não cobre "B trava primeiro → A espera e o EPQ reavalia o predicado na versão nova → 55000". São mecanismos distintos; a sabotagem tem de derrubar ambos.
4. **Teste de corrida precisa de tomada REAL.** Com o lease fresco, o claim rival cai no `WHERE` e não toma nada — mede contenção de lock, não troca de dono. Expire o lease antes.

## Em aberto (declarado)

- Paginação por offset (`.range()`) no `calculate-scores`: um DELETE concorrente entre páginas pode pular uma linha → o vencedor não reescreve X. Correção: paginação por chave. Outro eixo (cobertura ≠ fencing).
- Janela residual do fallback: cache velho além de 2s pós-`NOTIFY` **e** lease perdido nesse intervalo. Fechar exige tirar o `DEFAULT NULL`.

Prova: `db/test-apply-score-updates-fencing.sh` (56/0, `LC_ALL=C` e `pt_BR`, falsificação 3/3) · `_shared/lease_test.ts` (41/41, 2 sabotagens).
