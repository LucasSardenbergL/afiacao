# Giro de corante — Fase 1 (advisory)

Spec: `docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md` · Plano: `docs/superpowers/plans/2026-10-27-giro-corante-fase1.md`.

Medir o consumo real de corante dosado no SayerSystem (OBEN/M01) e mostrar, por WP, a faixa de giro e a recomendação de lata — **sem tocar o motor de compra** (`gerar_pedidos_sugeridos_ciclo`, `sku_parametros`). A Fase 2 (consumo dosado SUBSTITUI a demanda WP do Omie) é decidida pelo sensor `reposicao.corantes_aberta` e pela consulta `db/consultas/reconciliacao-corante-fase2.sql`.

## PR A — banco (#3387, mergeado 2026-10-28 como `74bf22837`)

- Migrations aplicadas em prod por `db:aplicar` a partir do commit da main: `20261028100000` (recibo #746), `20261028100100` (#747), `20261028100200` (#748).
- 2ª testemunha por psql-ro: `tint_promocao_tick` = `e5f375b0…` (só o predicado das preparações), ledger = `b9f9b6cb…`; 7 tabelas novas com RLS, `anon` sem privilégio, `authenticated` só SELECT; cron `tint-preparacoes-tick` ativo (15 s); 14 WP com canister 2.300 ml **não confirmado** (faixa "sem recomendação" até o Lucas conferir o canister do "400").
- Pós-apply: as 7 tabelas em `scripts/authz-tabelas-fechadas.ts`, os 7 pares (função, `20261028100000`) conciliados em `db/deriva-corpo-baseline.json` (o tick `ALTERA`; as outras 6 `SO_CITA` — o detector de patch por âncora marca o arquivo inteiro), carimbo regravado.
- Provas PG17 (C e pt_BR.UTF-8): consumo 170 + 15 falsificações, giro 34 + 8, reconciliação 11 + 7. No CI só o controle das três (as falsificações estouravam a parte de 20 min do `provas-sql`).

## Lições

- **Função SECURITY INVOKER herda o EXECUTE default de `anon`** (privilégio default do Supabase): não vaza nada enquanto as tabelas por baixo negarem SELECT a `anon` — conferir as DUAS pontas, não só o ACL da função.
- **Migration que cria funções E faz um patch por âncora** no mesmo arquivo cai inteira no detector de deriva (`alvosDePatch` olha o arquivo, não o bloco): toda função citada depois do próprio CREATE precisa de `SO_CITA` na baseline, senão o carimbo pós-apply sai com `PATCH_NAO_CONCILIADO`.
- **Aplique do commit da MAIN** (`git checkout --detach origin/main`), não do branch do PR: depois do squash, o commit do branch fica órfão e o recibo do ledger apontaria para bytes sem dono.

## PRs B (edge), C (app), D (conector)

Em andamento noutra sessão — registrar aqui ao entregar.
