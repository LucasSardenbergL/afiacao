# Calendário de operação — Etapa 2 (demanda ajustada) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (money-path: o CLAUDE.md proíbe delegar edição money-path a subagente — execução nativa nesta sessão). Steps use checkbox (`- [ ]`).

**Goal:** a demanda média diária do motor (OBEN) passa a desconsiderar os dias fechados declarados no calendário — em SOMBRA (gravada lado a lado, sem alimentar PP/máximo) até a chave virar, com reversão imediata.

**Architecture:** uma função SQL pura `calendario_fator_demanda(empresa, data_fim)` calcula U/W/fator/guardas sobre a janela do legado; `v_sku_parametros_sugeridos` (CTE `base`) troca o `d` só quando a chave está ligada; `v_sku_demanda_estatisticas` fica crua e ganha `fator_calendario` no fim. Uma tabela de sombra recebe, por dia, d/PP/máximo nos dois modos, gravada por job diário que força o modo via GUC transacional.

**Tech Stack:** PostgreSQL 17 (prod = 17.6), harness PG17 `db/lib/pg-harness.sh`, Bun/TS para o replay.

**Spec:** `docs/superpowers/specs/2026-11-18-calendario-operacao-design.md` (§6.4, §7-E2).

## Global Constraints

- `U = Σ peso_base` (seg–sex da janela), `W = Σ peso_efetivo` nos mesmos dias, `fator = U/W`, `d_ajust = round(d × fator, 4)`; sem exceção na janela ⇒ `d` do legado BIT A BIT.
- Janela = a do numerador do legado: `[hojeSP − 90, hojeSP]` (91 dias, divisor 90).
- Peso efetivo: sem linha → base; `aberto`/`meia_equipe` → 1; `fechado` → 0; `pendente_dado` → sai de U e W. Pesos só 0/1.
- Guardas: `W/U < 0,6` (ou `U = 0`) ⇒ fator 1 (d cru) + `baixa_confianca`; teto do fator 1,35; nunca null→0.
- Só OBEN; COLACOR: `fator_calendario` NULL e `d` intocado.
- NÃO tocar: sigma (inclusive o fallback `d × 0,5`, que segue no `d` cru), rajada, EOQ, LT, `dias_uteis_entre`, ABC/XYZ (ranqueia por `valor_total_90d`, invariante a fator por empresa — pré-voo 2026-11-18).
- Migration sem `BEGIN`/`COMMIT` (vai pelo `bun run db:aplicar`), molde TRAVA → PRE (md5 `pg_get_viewdef` prod: parametros `cb7f8b8b2286ca815c0a76ea8aa412de`, estatisticas `f05c5621d0254b746c6ada8cb0c9d22a`) → CREATE → PÓS; `CREATE OR REPLACE VIEW` só acrescenta coluna no fim e repete `security_invoker=on`.
- Chave: `company_config.key = 'reposicao_demanda_calendario_oben_ativa'`, `'true'` liga; ausente/qualquer outro valor = sombra (fail-closed, padrão de `reposicao_teto_cobertura_oben_ativa`).

## Review Focus

1. Edição errada do calendário (janela inteira fechada) não pode explodir nem zerar `d` → teste `GUARDA_TUDO_FECHADO` na Task 2.
2. GUC de força com valor lixo (`'xyz'`) não pode ligar o ajuste → `GUC_LIXO` na Task 2.
3. Leitor sem SELECT em `company_config`/calendário (RLS) cai no legado, não em erro nem em zero → `RLS_CUSTOMER` na Task 2.
4. `pendente_dado` na janela não pode ser contado como fechado → `PENDENTE_FORA` na Task 2.
5. Job de sombra rodando 2× no mesmo dia não duplica linhas → `SOMBRA_IDEMPOTENTE` na Task 2.

---

### Task 1: Migration `supabase/migrations/20261120090000_calendario_demanda_sombra.sql`

**Interfaces — Produces:**
- `public.calendario_fator_demanda(p_empresa text, p_data_fim date) RETURNS TABLE(janela_inicio date, janela_fim date, dias_base int, dias_efetivos int, dias_pendentes int, fator_bruto numeric, fator numeric, baixa_confianca boolean)` — SQL, STABLE, STRICT, SECURITY INVOKER; EXECUTE só `authenticated`, `service_role`, `claude_ro` (se existir).
- `v_sku_demanda_estatisticas` + coluna final `fator_calendario numeric` (OBEN = fator; demais NULL).
- `v_sku_parametros_sugeridos`: `demanda_media_diaria` = efetivo; colunas finais `demanda_media_diaria_legado`, `demanda_media_diaria_calendario`, `fator_calendario`, `calendario_baixa_confianca`, `calendario_modo` (`'sombra'|'valendo'`).
- GUC `reposicao.demanda_calendario_forcar` ∈ {`sombra`,`valendo`} sobrepõe a chave na sessão; outro valor é ignorado.
- Tabela `reposicao_demanda_calendario_sombra` (PK `data_ref, empresa, sku_codigo_omie`) + `reposicao_demanda_calendario_sombra_registrar(p_empresa text)` (VOLATILE, só owner/service_role) + cron diário.

- [ ] Step 1: escrever a migration a partir do viewdef de prod (`logs/etapa2/raw_*.sql`), editando só `base`, a lista final e o fim de estatisticas.
- [ ] Step 2: PÓS embutida: ACL da função (sem PUBLIC/anon), `security_invoker` nas duas views, neutralidade (`calendario_modo='sombra'` ⇒ `demanda_media_diaria = demanda_media_diaria_legado` em todas as linhas), cron agendado.

### Task 2: Prova PG17 `db/test-calendario-demanda.sh` + `db/nucleo-ci.d/test-calendario-demanda.txt`

Receita ZONA 1 de `db/test-hoje-sp-views-defaults.sh` (stubs → prelude → snapshot) + migrations `20261119100000` e a nova; relógio por `test.agora`. Asserts (nomes fixos):
- `NEUTRO_SEM_EXCECAO`: janela sem exceção ⇒ `d`, PP e máximo idênticos com a chave ligada e desligada (EXCEPT vazio + contagem > 0).
- `FATOR_RECESSO`: 11 úteis fechados em 65 ⇒ fator `65/54` com 4 casas; `d_ajust = round(d × fator, 4)`.
- `TETO_135`, `GUARDA_06` (W/U = 0,55 ⇒ fator 1 + baixa_confianca), `GUARDA_TUDO_FECHADO`, `PENDENTE_FORA`, `MEIA_EQUIPE_1`, `COLACOR_INTOCADA`, `SOMBRA_NAO_ALIMENTA` (chave desligada ⇒ PP/máximo = legado), `CHAVE_LIGA`, `GUC_LIXO`, `RLS_CUSTOMER`, `ACL_ANON`, `SOMBRA_IDEMPOTENTE`, `PRE_ABORTA` (viewdef alheio ⇒ RAISE).
- `--falsificar`: uma sabotagem por assert relevante, controle verde na mesma invocação; rodar em `LC_ALL=C` e `pt_BR.UTF-8`.

### Task 3: Replay §7-E2 (b)(c) + números de prod (a)(e)

- `scripts/reposicao-replay/calendario-demanda.ts`: para datas-base 2026-01-19, 02-02, 03-02, 03-16, 04-06, 09-01 roda o F0 (`diagnosticoF0`/`pontoDePedidoF0`) com e sem fator (calendário exportado por `extrair.sql` → `calendario.csv`); saída: viés agregado (previsto/realizado nos 30 dias seguintes), rupturas evitadas, ΔPP × cmc por SKU.
- (a)(e) em prod: `db/sonda-calendario-demanda-sombra.sql` via psql-ro (`fim|ok`): neutralidade em janela limpa, distribuição de fator/ΔPP e mudança de status do param-auto (`aplicado`/`segurado`) se a chave virasse hoje.
- Limite registrado: congelar a TSB do replay em dia fechado (§6.4 último item) não muda produção e fica como pendência explícita no PR.

### Task 4: Entrega

- [ ] `heavy bun run test`, `heavy bun run typecheck`, `bun lint`, `bunx knip`, `bun run lint:shell`.
- [ ] Codex código via `scripts/codex-async.sh` em background; registro no PR.
- [ ] PR (diário `docs/historico/calendario-operacao-etapa2.md`), `db:aplicar --ensaio` → `db:aplicar`, sonda psql-ro da sombra no dia seguinte ao 1º cron.
