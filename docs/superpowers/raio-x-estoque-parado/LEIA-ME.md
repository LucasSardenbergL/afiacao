# Raio-X do estoque parado — como medir

Spec: `docs/superpowers/specs/2026-10-14-raio-x-estoque-parado-design.md` · Plano: `docs/superpowers/plans/2026-10-14-raio-x-estoque-parado.md`
Artifact: https://claude.ai/artifact/MyvzRxHFpMnhfAufb6zg3p (retrato de 2026-10-14)

Medição (a partir de 2026-11-25), tudo read-only:
1. `Artifact read url=<URL> path=retrato.json` → salvar em `$RAIOX_OUT/retrato.json`.
2. `ArtifactData list collection=decisoes` → salvar como `{"<sku>": {...}}` em `$RAIOX_OUT/decisoes.json`.
3. `psql-ro -v desde=<meta.hoje do retrato> -f medicao.sql` → `atual.json` (mesma extração do passo 6 da Task 4 do plano).
4. `node medir.mjs retrato.json decisoes.json atual.json` → exige `MEDICAO-OK`.
Meta: 100% do Top 61 decidido e caixa_liberado ≥ R$ 60k. Portão da fase B (ferramenta) = essa meta medida.
