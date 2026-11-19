# Calendário de operação — Etapa 2 (demanda ajustada, em sombra)

Spec: `docs/superpowers/specs/2026-11-18-calendario-operacao-design.md` §6.4/§7-E2 · Plano: `docs/superpowers/plans/2026-11-18-calendario-operacao-etapa2.md` · Etapa 1: [calendario-operacao-etapa1.md](calendario-operacao-etapa1.md).

## O que entrega

- **Migration** `20261120090000_calendario_demanda_sombra.sql` (manual, via `bun run db:aplicar`, sem envelope; TRAVA → PRE md5 → CREATE → PÓS):
  - `calendario_fator_demanda(empresa, data_fim)`: na janela do numerador do legado (`[hojeSP − 90, hojeSP]`), `U` = dias úteis − `pendente_dado`, `W` = `U` − fechados (`meia_equipe` pesa 1), `fator = U/W`; `W/U < 0,6` ⇒ fator 1 + `baixa_confianca`; teto 1,35; STRICT, SECURITY INVOKER, sem PUBLIC/anon.
  - `v_sku_parametros_sugeridos` (CTE `base`, ponto único): `d = round(d_legado × fator, 4)` **só com a chave ligada**; SS/PP/máximo/cobertura seguem o `d`; **EOQ usa o `d` cru** (spec: EOQ intacto); σ (inclusive o fallback `d × 0,5`) intacto. Colunas novas no fim: `demanda_media_diaria_legado`, `demanda_media_diaria_calendario`, `fator_calendario`, `calendario_baixa_confianca`, `calendario_modo`. Só OBEN (COLACOR: fator NULL).
  - `v_sku_demanda_estatisticas`: crua + `fator_calendario` no fim. ABC/XYZ não muda (ranqueia por `valor_total_90d`; o fator é escalar por empresa).
  - Chave: `company_config.key = 'reposicao_demanda_calendario_oben_ativa'` = `'true'` ⇒ valendo; ausente/outro ⇒ sombra. **Nasce desligada.**
  - Sombra: `reposicao_demanda_calendario_sombra` (d/SS/PP/máximo nos dois modos, por dia; sem custo), job `reposicao_demanda_calendario_sombra_registrar('OBEN')` (owner-only por allowlist), cron `reposicao-demanda-calendario-sombra` 10:20 UTC. O job força o modo pela GUC `reposicao.demanda_calendario_forcar` (mesma fórmula nos dois lados) e só grava SKU com 1 linha por leitura e insumos iguais nas duas leituras.
- **Prova** `db/test-calendario-demanda.sh` (PG17, predecessoras EXATAS da prod em `db/fixtures/calendario-demanda-predecessoras-prod-20261118.sql`, md5 conferido): 36 asserts, 15 sabotagens com controle verde, em `LC_ALL=C` e `pt_BR.UTF-8`.
- **Replay** `scripts/reposicao-replay/calendario-demanda.ts` (+ espelho TS do fator com paridade dos cenários SQL em `calendario-demanda.test.ts`).
- **Sonda** `db/sonda-calendario-demanda-sombra.sql` (psql-ro, `fim|ok`): neutralidade servida, sombra por dia, efeito no param-auto nos dois modos, capital da última sombra.

## Lições (caras)

- **GUC customizada em `CREATE FUNCTION … SET` é recusada para não-superusuário** (PG15+): no Supabase o `postgres` não é superusuário → `42501 permission denied to set parameter` no `db:aplicar --ensaio`. O PG17 local roda como superusuário e não vê. `set_config(…, true)` em runtime é permitido. **Só o ensaio pega esta classe.**
- **A prod tem `public.set_config` SECURITY DEFINER executável por `authenticated`** que só aceita `fin.%` — sombreia `pg_catalog.set_config` para quem tem `public` antes no `search_path`. Chame `pg_catalog.set_config` explicitamente. Bônus: confirma que nenhum usuário liga o ajuste por RPC.
- **Falsificação contra uma migration com trava de texto (md5 na PÓS)**: a sabotagem do corpo da view é barrada pela camada externa e o assert comportamental nunca roda; o harness desliga só a trava de texto nessas sabotagens (`sem_trava_de_texto`) e a trava é falsificada à parte.
- **Detector de INFRA que só conhece `ERROR:`** fica cego em `lc_messages=pt_BR` (`ERRO:`) — a falsificação em pt_BR é que mostrou.

## Replay §7-E2 (extração 2026-11-18, hash `7dbacf184952`; coorte ativos + habilitados)

| data-base | fator (U/W) | SKUs com PP | viés cru → ajust. | venda no LT > PP: cru → ajust. | ΔPP (un) | capital adicional (ΔPP × cmc) |
|---|---|---|---|---|---|---|
| 19/01/2026 | 1,2264 (65/53) | 121 | 0,96 → 1,18 | 9 → 8 | 31 | R$ 6.116 |
| 02/02/2026 | 1,2264 (65/53) | 122 | 1,11 → 1,37 | 8 → 8 | 29 | R$ 8.050 |
| 02/03/2026 | 1,2745 (65/51) | 119 | 0,84 → 1,07 | 5 → 5 | 35 | R$ 7.975 |
| 16/03/2026 | 1,2500 (65/52) | 119 | 0,75 → 0,94 | 12 → 10 | 35 | R$ 8.689 |
| 06/04/2026 | 1,0656 (65/61) | 124 | 0,96 → 1,03 | 12 → 12 | 10 | R$ 2.065 |
| 01/09/2026 | 1,0317 (65/63) | 126 | 0,86 → 0,89 | 6 → 6 | 7 | R$ 752 |

Viés = Σ(d × 30) / venda realizada nos 30 dias corridos seguintes. "Venda no LT > PP" NÃO é ruptura (ignora posição e recebimentos). Paridade do PP F0 = 100% em todas as datas.

Leitura: março melhora (0,75 → 0,94 em 16/03). **Janeiro e fevereiro passam do ponto** (1,18 e 1,37) — parte é da régua (os 30 dias seguintes contêm o Carnaval, que derruba a venda realizada), parte é excesso real de compra pré-Carnaval (§7-E2 c; débito "antecipação pré-Carnaval" da spec §10). **06/04 e 01/09 não são neutros com o calendário real**: as janelas contêm feriados declarados (Sexta Santa/Tiradentes; Corpus Christi/ponte). A igualdade exata da §7-E2 (a) vale em janela sem exceção — provada no PG17 (V01, com vendas cortadas na data-base) e, em prod, pela PÓS (em sombra, `d` servido = legado em todas as linhas).

## Codex

- Desenho: parecer da spec (§9, `gpt-6-astra`/max, 279 s, 118.838 tokens).
- Código, 1ª rodada: `gpt-6.2-astra` · max · 744 s · 270.397 tokens — **REPROVA** (0 P0, 8 P1). Corrigidos: EOQ no d cru (P1-6), sombra sem custo (P1-2), allowlist de ACL (P1-3), corrida entre leituras e linha duplicada (P1-4/5), replay na janela da SQL e coorte/rótulo honestos (P1-7/8). **Rebatido (risco aceito):** P1-1 — uma sessão SQL que define a GUC e chama o atualizador persiste o ajuste; exige SQL com escrita, que já grava `sku_parametros` direto; não há caminho por PostgREST/RPC. P2 aceito: duplo arredondamento (≤ 1 na 4ª casa; na borda move um PP em 1 un. para qualquer lado).

## Pendências

- **Virar a chave** (decisão do founder, prazo 05/01/2027): `INSERT INTO company_config (key, value) VALUES ('reposicao_demanda_calendario_oben_ativa', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`. Reverter: `DELETE … WHERE key = 'reposicao_demanda_calendario_oben_ativa'` (efeito no próximo cálculo do atualizador).
- Replay: congelar TSB e mascarar ADI/CV² em dia fechado (§6.4, último item) — não muda produção.
- Prova não cobre leitura da view por papel (o snapshot não carrega GRANTs); o catálogo (A02) e a PÓS cobrem o EXECUTE.

## Aplicação em produção (2026-11-18)

- PR #3983 mergeado (`3a61ccb19`, bytes da migration idênticos na main). `bun run db:aplicar` com ensaio fresco verde: **recibo #1196** (sha256 `416da5a6…`).
- 2ª testemunha (psql-ro, `fim|ok`): md5 das views = o do arquivo (`cec8b647…` / `5cc2c267…`); `calendario_fator_demanda` sem anon, com authenticated/claude_ro; job executável só por `postgres`; cron `reposicao-demanda-calendario-sombra` `20 10 * * *` ativo.
- Sonda `db/sonda-calendario-demanda-sombra.sql`: chave ausente (= sombra); fator de hoje 65/62 = 1,0484 (fechados 07/09, 12/10, 02/11 na janela 20/08–18/11); **neutralidade servida 356/356** (d = legado em toda linha); efeito no param-auto no mesmo snapshot: 12 SKUs mudariam PP/máx em sombra (o atualizador faria de qualquer jeito) × 29 valendo ⇒ **+17 pela virada**; fusível igual (1).
- 1ª execução manual do job (`db/executar-sombra-calendario-20261118.sql`, **recibo #1198**, antes do 1º cron, porque PL/pgSQL só falha ao executar): 356 SKUs gravados, 0 descartados, 167 OK; **ΔPP +32 un ≈ R$ 2.017**, Δmáximo ≈ R$ 2.017 (EOQ intacto: o máximo sobe só o que o PP sobe).
- Pendente: virar a chave (founder, até 05/01/2027); acompanhar a sombra diária pela sonda em dezembro.
