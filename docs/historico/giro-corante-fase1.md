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

- **B — edge `tint-sync-agent` v1.3** (#3391, mergeado 2026-10-28 11:23Z): `/preparations` com manifesto, saneado por allowlist (`cliente` nunca chega a staging, log ou resposta) e tudo-ou-nada (lote inválido → nada gravado, run `error`, 422 `{preparacao_id, motivo}`); `/preparations/plano` repassa `tint_consumo_plano_extracao`. Codex: 1 P1 (200 sem enfileiramento em loja fora de `automatic_primary` → 422 `modo_sem_promocao` antes de escrever) + 4 P2, todos corrigidos; falsificação com 13 sabotagens. **Deploy: chat Lovable, quem decide é `pendencias:deploy`.**
- **C — aba "Corantes"** (#3392): lê `v_corante_giro`, vocabulário fechado (valor desconhecido = aviso de leitura), `null → "—"`, dado parado mostra o último cálculo sem a regra, sensor `reposicao.corantes_aberta` no ledger 1× por montagem e só com leitura pronta. Codex: 3 P1 + 1 P2 tratados; falsificação com 9 sabotagens. **Publish depois da edge e do conector.**
- **D — conector, Tasks 9–10** (#3394): cliente do plano (200 exato, contrato estrito, nunca "zero janelas" por erro), janela cortada no relógio da ORIGEM, `vendas_item` isolada (não derruba o catálogo, fingerprint idêntico ao 0.2.x provado por hash), `test-pg17.sh`. Codex: 4 P2 corrigidos; falsificação com 10 sabotagens. **🚧 Tasks 11–12 aguardam o passo 0 do founder**; sem elas não há release 0.3.0.

- **Deploy da edge v1.3 atestado (2026-10-28 21:40Z, pela sessão via MCP):** pacote `55ca7febf6c6` @ `8bac43068` (banco ✅), 11/11 hashes conferidos pelo agente, 1 crédito. Sensor pós-envio `EDICAO_DETECTADA` **só** pelo `commit_sha` da resposta — `56bf9395f` regenerou apenas o `types.ts` (+417, as tabelas do PR A) e o agente não usou tool de escrita: nada a reverter. Sonda `db/sonda-tsa-v13-20261028.sql` (tentativa #750, aplicada do commit do branch `69c63b5f9`, não da main) → `DEPLOY CONFIRMADO`; `pendencias:deploy` exit 0 (83/83 confere). Publish segue para depois do conector.

### Lições (B/C/D)

- **Sabotagem que fica verde pode ser INALCANÇÁVEL, não redundante.** No D, a sabotagem "a isolada vaza para o fingerprint" passou verde porque o laço isolado rodava antes do laço do catálogo, que recriava a entrada. Refeita depois do laço, ficou vermelha. Antes de concluir "o teste não pega", confira se a sabotagem chega a executar.
- **Compatibilidade de identificador se prova contra o binário anterior, não contra a intenção.** O fingerprint do conector é fixado por hashes medidos em `origin/main` (via `git archive` num diretório temporário), para 3 schemas.
- **`Date.parse` normaliza data inexistente (`02-30` → março) e o Postgres arredonda além do µs.** Fronteira de janela comparada em JS precisa de parser de calendário estrito e de recusar fração além de 6 dígitos.
- **Gate de empresa por contexto sem provider é decorativo.** `AdminReposicaoBaixoGiro` lê sempre o default `OBEN` (vale para a página inteira). A aba é segura porque a view é só OBEN por construção; ligar a página ao seletor global é outra entrega.
