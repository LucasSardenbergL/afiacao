# Raio-X do estoque parado — como medir

> **Migrado para o app (fase B, 2026-10-18).**
> - Decisões, contagens e medição agora vivem no app, em `admin/reposicao/baixo-giro` › aba **Raio-X**.
> - A medição é o card **"Caixa liberado"** (RPC `raio_x_medicao`), lido direto na tela, sem os passos abaixo.
> - As 17 decisões do Artifact foram levadas para `raio_x_decisao` (`origem='artifact_fase_a'`) pelo `scripts/raio-x/carga-fase-a.ts`.
> - O Artifact ficou **só leitura**, sem os dados apagados.
> - Detalhe: `docs/historico/raio-x-estoque-parado-fase-b.md`.

Spec: `docs/superpowers/specs/2026-10-14-raio-x-estoque-parado-design.md` · Plano: `docs/superpowers/plans/2026-10-14-raio-x-estoque-parado.md`
Artifact (só leitura): https://claude.ai/artifact/MyvzRxHFpMnhfAufb6zg3p (retrato de 2026-10-15; uso e consumo pelo tipo do item do Omie)

Gerar um retrato novo: `node gerar.mjs --banco $RAIOX_OUT [AAAA-MM-DD]` (psql-ro, read-only; pré-voo exige sync < 24h).

Medição da fase A pelo Artifact. É **histórica**: ficou substituída pelo card do app. Tudo read-only:
1. `Artifact read url=<URL> path=retrato.json` → salvar em `$RAIOX_OUT/retrato.json`.
2. `ArtifactData list collection=decisoes` → salvar como `{"<sku>": {...}}` em `$RAIOX_OUT/decisoes.json`.
3. `psql-ro -v desde=<meta.hoje do retrato> -f medicao.sql` → `atual.json` (mesma extração do passo 6 da Task 4 do plano).
4. `node medir.mjs retrato.json decisoes.json atual.json` → exige `MEDICAO-OK`.

Meta, que continua valendo e agora é lida no card do app a partir de 2026-11-25: 100% do Top 61 decidido e caixa_liberado ≥ R$ 60k. O portão da fase B foi trocado pelo founder em 2026-10-15: o sinal aceito foi o **uso** (17 decisões), não essa meta medida. Ver a spec da fase B, §0.
