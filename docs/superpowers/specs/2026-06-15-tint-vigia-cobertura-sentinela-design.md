# Vigia da cobertura tintométrica no Sentinela (Saúde de Dados)

Data: 2026-06-15
Status: design fechado (founder delegou "decide você e o Codex"; revisado em modo adversarial pelo Codex `gpt-5.5`/xhigh em 2026-06-15). Pré-implementação.

## Problema

A cobertura do mapeamento tintométrico foi a prod numa sessão anterior: a função `public.tint_marcar_bases_mixmachine()` (SECURITY DEFINER) + cron `tint-marcar-bases-diario` (jobid 132, `0 11 * * *` = 08:00 BRT) marcam `is_tintometric=true` + `tint_type` por família ("Bases MixMachine"→`base`, "Concentrados MixMachine"→`concentrado`) nos produtos Omie ativos da conta `oben`. É idempotente/aditivo e **NUNCA desmarca** (desmarcar base mapeada quebraria a venda).

Falta o **vigia** que detecta quando essa cobertura sofre drift — registrado como "Não-feito" na spec `2026-06-14-tint-mapeamento-assistido-design.md` e explicitamente delegado pela própria migration de cobertura: *"drift 'saiu da família'/'ficou inativo' fica pro vigia do Sentinela = follow-up"*.

O vigia vive no Sentinela: `_data_health_compute()` (fonte única) + `data_health_watchdog()` (push/e-mail) + `fin_sync_heartbeat()` (resumo). **Só ALERTA, nunca corrige** — a correção é a função de cobertura ou o humano.

## Por que a cobertura quebra (o que vigiar)

O dropdown de mapeamento (`TintMapping.tsx:42-46`) filtra `account='oben' AND is_tintometric=true AND tint_type=<aba> AND ativo=true`. Logo:
- base elegível **sem `is_tintometric`** → **some** do mapeamento;
- base com **`tint_type` errado** → aparece na **aba trocada** (Bases × Concentrados);
- a edge `tint-omie-sync` tem teto de 20 páginas → bases novas entram pelo `omie-sync-metadados` (que pagina tudo + grava `familia`) **sem** a marca. O cron de cobertura conserta — quando roda.

## Decisões (eu + Codex)

| Dimensão | Decisão | Origem |
| --- | --- | --- |
| **Escopo** | 2 checks: **A** cobertura (núcleo) + **B** validade de vínculo. 3º sinal ("marcada-órfã") = follow-up. | Codex: "não funda; cobertura e vínculo têm causa/responsável/correção diferentes". |
| **Severidade** | `warning` (ambos). Híbrido critical descartado. | Codex: "zero-cobertura=critical exige baseline confiável; warning já emaila". |
| **Push** | **A no push** (watchdog+heartbeat). **B dashboard-only** na v1 (fora dos IN-lists); promove a push em 2ª migration após pre-flight zerar. | Codex: "promove ao push só após pre-flight limpo + responsável real". |
| **domain** | `estoque` (reusa; `HealthDomain` é tipo TS fechado — criar `tintometrico` quebraria o frontend). | Achado próprio (`src/lib/dataHealth/types.ts`). |

### O que o Codex mudou na minha proposta original (registro)

1. **[P1] Corrida temporal no A.** Minha proposta (`n=0 ? ok : stale`) alarmaria todo produto importado após as 08:00 até o cron do dia seguinte (catálogo sincroniza a cada ~2h; watchdog roda */30; heartbeat roda às 08:00 junto do cron de cobertura). Falso incidente garantido na próxima importação. **Fix: tolerância temporal por `created_at`** (o sync NÃO toca `created_at` em upsert; `updated_at` esconderia drift permanente porque o sync o atualiza toda passada).
2. **[P1] Check B não media integridade.** Faltavam `ts.account='oben'`, coerência de account e o alvo morto. Reescrito.
3. **Pre-flight obrigatório**, não "aceitar o 1º alerta": um source novo degradado é `inexistente→degradado`, não a transição `ok→degradado` que o watchdog pressupõe.

## Design dos checks

Ambos seguem o contrato do `_data_health_compute` (11 colunas; campos de "problema" só quando status≠ok; verde não polui).

### Check A — `tint_cobertura_bases` (núcleo · PUSH)

Conta bases/concentrados MixMachine **ativos** da conta `oben` cuja classificação tint diverge da família **há mais de 30h** (a tolerância cobre 1 ciclo do cron diário + folga; elimina a corrida temporal). `created_at` como relógio (estável a re-sync). Frescor = idade do drift mais antigo.

```sql
SELECT 'tint_cobertura_bases'::text, 'estoque'::text,
  CASE WHEN t.n = 0 THEN 'ok' ELSE 'stale' END,
  EXTRACT(EPOCH FROM t.idade_max)::bigint, (30*3600)::bigint,
  'omie_products oben ativo família MixMachine sem is_tintometric/tint_type correto há >30h (created_at)'::text,
  CASE WHEN t.n = 0 THEN 'Cobertura tint: toda base/concentrado MixMachine ativo está classificado corretamente'
       ELSE 'Cobertura tint: '||t.n||' base(s)/concentrado(s) MixMachine ativo(s) com classificação divergente há +30h (sem is_tintometric → some do mapeamento; ou tint_type na aba errada)' END,
  NULL,
  CASE WHEN t.n > 0 THEN 'O cron tint-marcar-bases-diario (jobid 132) não rodou/foi revertido, ou houve reclassificação manual — bases elegíveis há +30h seguem sem a marca tint correta' ELSE NULL END,
  'Rode select public.tint_marcar_bases_mixmachine(); no SQL Editor (idempotente, só aditivo) e confira o cron tint-marcar-bases-diario via net._http_response'::text,
  CASE WHEN t.n = 0 THEN 'info' ELSE 'warning' END
FROM (
  SELECT count(*)::bigint AS n,
         max(now() - op.created_at) AS idade_max
  FROM public.omie_products op
  WHERE op.account = 'oben' AND op.ativo = true
    AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
    AND op.created_at < now() - interval '30 hours'
    AND ( op.is_tintometric IS NOT TRUE
       OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))
            WHEN 'bases mixmachine' THEN 'base'
            WHEN 'concentrados mixmachine' THEN 'concentrado' END )
) t
```

- **Nasce verde**: a cobertura está limpa hoje (`marcados_agora=0`) e a tolerância de 30h exclui qualquer importação recente.
- `IS DISTINCT FROM CASE` é NULL-safe; o `WHERE … IN` restringe a família, então o `CASE` nunca retorna NULL (Codex confirmou).
- `count(*)` agregado sem `GROUP BY` sempre produz 1 linha (n=0 quando vazio → o check não some).

### Check B — `tint_vinculo_omie` (validade do vínculo de venda · DASHBOARD-ONLY)

Ortogonal ao A (mede `tint_skus`, não o catálogo): vínculo de venda **ativo** apontando para produto Omie **morto** (inativo / account divergente) + produto Omie em **>1 SKU ativa** (vínculo ambíguo — `useTintColorSelect.ts:55` lê reverso com `.limit(1)`, então 2 SKUs = base arbitrária no re-mapeamento). FK garante que `omie_product_id` sempre existe → INNER JOIN basta.

```sql
SELECT 'tint_vinculo_omie'::text, 'estoque'::text,
  CASE WHEN v.morto + v.ambiguo = 0 THEN 'ok' ELSE 'stale' END,
  NULL::bigint, NULL::bigint, 'tint_skus ativa→omie inativo/account divergente + omie em >1 sku ativa'::text,
  CASE WHEN v.morto + v.ambiguo = 0 THEN 'Vínculo tint↔Omie: íntegro'
       ELSE 'Vínculo tint↔Omie: '||v.morto||' SKU(s) ativa(s) apontando p/ produto Omie inativo/divergente, '||v.ambiguo||' produto(s) Omie em >1 SKU ativa (re-mapeamento pega base arbitrária)' END,
  NULL,
  CASE WHEN v.morto + v.ambiguo > 0 THEN 'SKU de venda aponta p/ produto descontinuado no Omie (some do dropdown), ou o mesmo produto Omie está vinculado a 2+ bases (vínculo ambíguo)' ELSE NULL END,
  'Em /tintometrico/catalogo → Mapeamento: re-mapeie as SKUs apontando p/ produto inativo e desfaça os vínculos duplicados'::text,
  CASE WHEN v.morto + v.ambiguo = 0 THEN 'info' ELSE 'warning' END
FROM (
  SELECT
    (SELECT count(*)::bigint FROM public.tint_skus ts
       JOIN public.omie_products op ON op.id = ts.omie_product_id
      WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE
        AND (op.ativo IS NOT TRUE OR op.account IS DISTINCT FROM ts.account)) AS morto,
    (SELECT count(*)::bigint FROM (
       SELECT ts.omie_product_id FROM public.tint_skus ts
        WHERE ts.account = 'oben' AND ts.ativo IS NOT FALSE AND ts.omie_product_id IS NOT NULL
        GROUP BY ts.omie_product_id HAVING count(*) > 1) d) AS ambiguo
) v
```

- **Por que dashboard-only na v1**: o backlog de B não é medido (sem acesso ao banco). Colocá-lo no push agora violaria "verde não polui" / `inexistente→degradado`. Aparece no `/SaudeDados` e no `DataHealthBadge` (gestor/master), sem e-mail. Promove a push numa 2ª migration **após o pre-flight confirmar 0**.
- `ts.ativo IS NOT FALSE` trata `ativo` NULL como ativo (idiomático). Subqueries escalares não-correlacionadas em `SELECT` sem `FROM` são válidas (Codex confirmou).
- **Ortogonal ao A** de propósito: A = catálogo (produto ativo sem marca); B = vínculo de venda apontando p/ produto morto/duplicado. Não inclui `is_tintometric/tint_type` do alvo para não dupla-contar com A nem assumir `tint_type` da SKU.

## Pre-flight obrigatório (antes de aplicar)

Read-only, no SQL Editor do Lovable. **Decide a base da migration e confirma que o A nasce verde:**

```sql
-- 1) DEF VIVA do compute (base da migration; NÃO partir de migration antiga)
SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure);
-- 2) conjunto e contagem atuais (esperado: 18)
SELECT count(*) AS total_checks FROM public._data_health_compute();
SELECT source FROM public._data_health_compute() ORDER BY source;
-- 3) backlog do Check A (ESPERADO 0 — se >0, investigar o cron ANTES de aplicar)
SELECT count(*) FILTER (WHERE op.created_at < now() - interval '30 hours') AS a_drift_30h,
       count(*) AS a_drift_total
FROM public.omie_products op
WHERE op.account='oben' AND op.ativo=true
  AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
  AND (op.is_tintometric IS NOT TRUE OR op.tint_type IS DISTINCT FROM
       CASE lower(btrim(op.familia)) WHEN 'bases mixmachine' THEN 'base' WHEN 'concentrados mixmachine' THEN 'concentrado' END);
-- 4) backlog do Check B (informativo; dashboard-only, então não bloqueia)
SELECT (SELECT count(*) FROM public.tint_skus ts JOIN public.omie_products op ON op.id=ts.omie_product_id
          WHERE ts.account='oben' AND ts.ativo IS NOT FALSE AND (op.ativo IS NOT TRUE OR op.account IS DISTINCT FROM ts.account)) AS morto,
       (SELECT count(*) FROM (SELECT omie_product_id FROM public.tint_skus WHERE account='oben' AND ativo IS NOT FALSE AND omie_product_id IS NOT NULL
          GROUP BY omie_product_id HAVING count(*)>1) d) AS ambiguo;
```

Regras de decisão:
- (2) `total_checks ≠ 18` ⇒ drift do conjunto; reconciliar antes.
- (1) corpo diverge da base da migration (a 210000 do repo) ⇒ rebasear a migration sobre o corpo vivo (preservar o `estoque_reposicao` prod-only e o que estiver vivo).
- (3) `a_drift_30h > 0` ⇒ o A NÃO nasceria verde; rodar `tint_marcar_bases_mixmachine()` e investigar o cron ANTES de aplicar.
- (4) só informa o estado de B (dashboard-only não emaila).

## Estratégia da migration (arquivo QUENTE — anti-cascata)

`_data_health_compute` já reverteu checks 5×. Regras (CLAUDE.md §5/§10 + Codex item 6):

1. **Base = def VIVA** (pre-flight passo 1), provável `20260611210000` (HEAD do repo: 18 checks, `estoque_reposicao` via marcador). Recriar as **3 funções juntas** numa transação (`BEGIN/COMMIT`) — tudo-ou-nada.
2. **Deltas (e SÓ eles):**
   - `_data_health_compute`: +2 UNION ALL (A, B) **antes do `alert_channel`** (mantém alert_channel por último).
   - `data_health_watchdog`: IN-list += `'tint_cobertura_bases'` (só A). **Preservar** o tratamento especial de `vendas_familia_ausente` (append da lista no e-mail) e `estoque_reposicao`.
   - `fin_sync_heartbeat`: IN-list do resumo += `'tint_cobertura_bases'` (só A). `alert_channel` continua heartbeat-only.
   - B **fora de ambos** os IN-lists (dashboard-only).
3. Preservar `REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;`.
4. **Não** tocar `supabase/migrations/` existentes; arquivo novo `20260615NNNNNN_tint_vigia_cobertura_sentinela.sql`; aplicar manual no SQL Editor.

**Contagem-alvo pós-apply:** compute 18→**20**; watchdog IN 13→**14**; heartbeat IN 14→**15**. (Diferente do "15/16" que o Codex citou assumindo A+B ambos no push — aqui B é dashboard-only.)

## Validação

- **PG17** (`db/test-tint-vigia-cobertura.sh`, molde = `db/test-data-health-familia-ausente.sh`): aplica snapshot → base viva → migration nova; semeia cenários (elegível-não-marcada >30h conta; importação <30h NÃO conta — prova a tolerância; tint_type errado conta; inativo/colacor fora; SKU ativa→omie inativo conta no B; produto em 2 SKUs conta no ambíguo). Asserta: compila; **20 checks**; nenhum dos 18 some; A=ok com população limpa, stale com drift>30h; B conta certo; **push end-to-end** do A (watchdog insere/dismissa em fin_alertas+fornecedor_alerta; heartbeat inclui A no resumo); **B NÃO emaila** (ausente dos IN-lists).
- **Diff mecânico** do corpo: os 18 checks anteriores e os IN-lists (fora os deltas) byte-idênticos à base viva.
- **Pós-apply** (read-only): `total_checks=20`; A=`ok`; B reflete a verdade; watchdog/heartbeat com a contagem-alvo.

## Follow-up (não bloqueia a v1)

1. **Promover B ao push** numa 2ª migration, após o pre-flight confirmar `morto+ambiguo=0` (ou após o founder limpar o backlog).
2. **3º sinal — "marcada-órfã ativa"**: produto `is_tintometric=true`, `ativo=true`, cuja família saiu de bases/concentrados MixMachine (continua no dropdown porque o filtro não olha família). Dashboard-only. **Excluir `ativo=false`** (tombstone benigno — Codex). Baixo volume; fica para v2.
3. **Raiz da corrida** (torna a tolerância de 30h folgada): rodar a cobertura após cada sync relevante, ou gravar um marcador durável da última correção bem-sucedida (sync_state) — aí o A poderia apertar a janela.

## Comportamento em produção (pós-implementação · 2026-07-08)

Primeiros disparos reais do Check A (03/07 e 08/07); diagnóstico read-only (`psql-ro`) confirmou que **o alerta é auto-curável — sem ação humana.** Registro p/ o próximo plantão não re-diagnosticar:

- **Ciclo de auto-cura (UTC):** watchdog detecta o drift ~03:00 → grava `fin_alertas` + enfileira e-mail; o cron corretor `tint-marcar-bases-diario` (jobid 132, `0 11 * * *`) roda 11:00 e marca; o watchdog seguinte (11:30, `*/30`) vê o check `ok` e **auto-dismissa** (`data_health_watchdog` ramo ELSE: `UPDATE fin_alertas SET dismissed_at=now()`). Fecha sozinho em ≤2h30.
- **Janela morta do heartbeat:** `fin-sync-heartbeat` (jobid 83, `0 11 * * 1-5`) monta o resumo às 11:00 UTC — **30 min ANTES** do auto-dismiss das 11:30. Logo o e-mail matinal **sempre** mostra o alerta como ativo, mesmo já corrigido no mesmo dia. É ordem de crons, não bug.
- **Não é falso-positivo de importação:** o item divergente tinha `age_seconds ≈ 78 dias` (produto antigo) — a tolerância de 30h fez seu papel. Gatilho real = reclassificação de `familia` / reativação / perda da marca sobre produto **existente**, não base recém-importada. O alerta guarda só `age_seconds`, não o código do SKU (candidato a melhoria: anexar o código, como faz `vendas_familia_ausente`).
- **Recorrência:** 2× em 23 dias, ambas auto-resolvidas. Ruído baixo.
- **Reconhecer da próxima:** e-mail matinal com `tint_cobertura_bases: stale` → `select dismissed_at from fin_alertas where tipo='data_health_tint_cobertura_bases' order by criado_em desc limit 1;`. Se preenchido (~11:30 UTC) = self-heal, nenhuma ação. Revalida com o backlog do pre-flight passo 3 (esperado 0).
- **Matar o ruído (opcional):** Follow-up item 3 — acoplar `tint_marcar_bases_mixmachine()` ao fim de `omie-sync-metadados` (correção na fonte) fecha a janela antes de o watchdog alertar. Alternativa mais fraca: subir o cron 132 para `*/30`.

## Apêndice — veredito do Codex (destilado)

> "Não aplique como está. O SQL compila, mas há dois erros de desenho: [P1] Check A confunde latência esperada com falha (corrida das 08:00); [P1] Check B não mede a integridade alegada (faltam account/coerência/alvo). Pre-flight obrigatório — source novo degradado é inexistente→degradado, não ok→degradado. warning para ambos. A no push após eliminar a corrida; B dashboard-only até pre-flight limpo. Preserve alert_channel (heartbeat-only), vendas_familia_ausente (tratamento especial) e estoque_reposicao."

Sessão completa do Codex: reasoning xhigh, 90.5k tokens, `gpt-5.5`.
