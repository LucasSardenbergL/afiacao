# Reposição — Auto-aplicação de parâmetros: olho e freio sobre o piloto que já roda

> Spec de design. Data: 2026-06-05. Empresa-alvo v1: **OBEN**.
> Status: aprovado pelo founder (brainstorming + codex consult xhigh). Próximo: plano de implementação.

## 1. Problema (e a descoberta que o reescreve)

**Pedido literal do founder:** "Não tenho tempo de revisar os parâmetros da reposição. Queria que ela tomasse a decisão, aplicasse, e no fim do dia me avisasse o que fez — aí eu vejo se quero reverter ou manter."

**Descoberta durante o brainstorming (contradição com evidência):** o piloto automático **já existe e roda em produção**.

- A função `atualizar_parametros_numericos_skus(p_empresa)` (`supabase/schema-snapshot.sql:589`, versão viva com COALESCE em `supabase/migrations/20260531140000_reposicao_atualizar_params_nao_zera.sql`) é chamada diariamente pelo edge `omie-cron-diario` (+ 3 telas de refresh manual). Ela **sobrescreve** `estoque_minimo`, `ponto_pedido`, `estoque_maximo`, `estoque_seguranca`, `cobertura_alvo_dias` com os `*_sugerido` da view `v_sku_parametros_sugeridos`, em **todo SKU com `status_sugestao='OK'`**. O COALESCE só evita ZERAR quando a sugestão é NULL (status ≠ OK); quando a sugestão é OK, sobrescreve normalmente.
- O motor de compras `gerar_pedidos_sugeridos_ciclo(p_empresa)` (`schema-snapshot.sql:2565`) lê `ponto_pedido` e `estoque_maximo` e **NÃO filtra `aprovado_em`**. Logo, os parâmetros calculados **já geram os pedidos de compra**, com ou sem revisão humana.
- A "aprovação" da tela `AdminReposicaoRevisao` (`useRevisaoParametros.ts:259`) é, do ponto de vista do motor, **carimbo de UI**: seta `aprovado_em`/`aprovado_por` (esconde da aba "pendente") e liga `aplicar_no_omie` (espelho Omie, que é manual e que o founder dispensa).

**Consequência:** a "revisão que o founder não tem tempo de fazer" nunca foi pré-requisito de compra. O sistema já decide e aplica. **O gap real do pedido é (a) visibilidade do que mudou e (b) capacidade de reverter** — não o "aplicar", que já existe.

**Dois fatos colaterais confirmados no código:**
1. **A edição/aprovação manual do founder é sobrescrita pelo cron** no dia seguinte sempre que a sugestão estiver OK. A própria `20260531140000` registra: "92 SKUs com config aprovada por humano, destruída pelo cron". Efeito prático: valores ajustados na mão "voltam sozinhos". Por isso **"reverter" exige uma trava** contra o cron — senão é inútil.
2. **Não há auto-aprovação de pedido de compra.** Caminho: `gerar_pedidos_sugeridos_ciclo` → `pedido_compra_sugerido` (`pendente_aprovacao`) → `aprovar_pedido_sugerido` (MANUAL, `schema-snapshot.sql:362`) → cron de disparo 13h. Nenhum trigger/cron pula `pendente_aprovacao` → `aprovado` sem humano. **Um parâmetro errado vira pedido sugerido, mas só vira compra real com o clique do founder.** Segunda rede intacta — desarma a "race das 09:15".

## 2. Objetivos / Não-objetivos

**Objetivos (v1):**
- Manter o auto-apply diário (que já roda), mas torná-lo **seguro, registrado, visível e reversível**.
- **Fusível** que segura os saltos claramente quebrados (input corrompido), aplicando o resto normalmente.
- **Resumo diário por e-mail** ordenado por impacto, incluindo os SKUs segurados pelo fusível.
- **Tela de reverter** (item-a-item e tudo-do-dia) com **trava** que impede o cron de re-aplicar o valor recusado até a sugestão mudar materialmente.
- Tudo **só no banco local**; **não** tocar o Omie, **não** ligar `aplicar_no_omie`.

**Não-objetivos (cortados da v1, por decisão):**
- **Cold-start / primeira compra** (`v_sku_candidatos_primeira_compra` / `promover_candidato_primeira_compra`) — mais sensível; segue manual.
- **Espelhar no Omie** os mín/máx — o founder dispensa, inclusive hoje.
- **Multi-empresa** — v1 é OBEN; o desenho é por-empresa, parametrizável depois.
- **Tornar a aprovação um gate de compra** (motor só compra o aprovado) — reintroduziria o trabalho diário que é a dor original.
- **Override de demanda** como input — `demanda_multiplicador_override` é **inerte** hoje (a view não o lê; confirmado). Não há tratamento especial; é registrado como observação.

## 3. Decisões do founder (fechadas no brainstorming)

| # | Decisão | Valor |
|---|---------|-------|
| 1 | Confiança no cálculo | Alta — "quase sempre só aceito" |
| 2 | Escopo de aplicação | Aplica tudo `OK` **+ fusível** anti-input-corrompido |
| 3 | Alcance | **Só local** (não toca Omie, não liga `aplicar_no_omie`) |
| 4 | Aviso | **E-mail no fim do dia**, ordenado por impacto |
| 5 | Reverter | **Tela no app**, item-a-item ou tudo-do-dia |
| 6 | Pós-reversão | **Só re-aplica se a sugestão mudar** (materialmente) do valor recusado |
| 7 | Fusível | **Sim** — segura só os claramente quebrados |

## 4. Arquitetura

Princípio (padrão do projeto): **SQL puro + pg_cron, sem edge function nova**. Reusa `fornecedor_alerta` → `dispatch-notifications` para o e-mail.

Decisão central: **instrumentar o motor que já existe** em vez de construir um novo apply. As proteções (validação dura + fusível + trava) vivem na função core e valem em **todos os call sites** (cron + 3 telas) — senão uma tela aplicaria um valor que o cron seguraria. O **registro/run** (log antes→depois) só acontece no run automático diário.

### 4.1 Componentes

```
omie-cron-diario (edge, manhã)
   └─ chama aplicar_parametros_automatico_diario('oben')   [troca de 1 chamada — único toque no edge]
         ├─ advisory lock por empresa + guard "1 run/dia" (idempotência)
         ├─ cria run em reposicao_param_auto_run (status 'rodando')
         └─ chama atualizar_parametros_numericos_skus('oben', run_id)   [CORE, instrumentada]
                 ├─ CTE: estado ANTES + sugestão da view
                 ├─ por SKU: VALIDAÇÃO DURA → FUSÍVEL → TRAVA → decide valor final + status
                 ├─ UPDATE sku_parametros (só elegíveis)
                 └─ INSERT reposicao_param_auto_log (antes→depois, status, contexto, impacto)
         └─ marca run 'completo' + totais

3 telas de refresh manual
   └─ chamam atualizar_parametros_numericos_skus('oben')  [CORE, p_run_id NULL → aplica com proteções, sem log]

reposicao-param-auto-resumo (cron pg_cron, 18h BRT)
   └─ lê o run 'completo' do dia → pré-renderiza corpo → INSERT fornecedor_alerta (tipo novo)
         (idempotente: não re-enfileira se já enfileirou hoje)
   └─ dispatch-notifications (cron existente) → e-mail

Tela "Mudanças automáticas" (front)
   └─ lista o run do dia por impacto; Reverter este / Reverter tudo
         └─ RPC reverter_parametro_auto(log_id) / reverter_run_auto(run_id)
               (gate auth+empresa; só restaura se atual == 'depois' logado; grava o pin)
   └─ "Devolver ao automático" → RPC despinar_parametro(empresa, sku)
```

### 4.2 Por que instrumentar a core (e não duplicar)

A captura do "antes" precisa acontecer **dentro da transação que aplica** (senão o omie-cron-diario aplicaria de manhã e qualquer snapshot posterior diffaria contra o já-aplicado → diff vazio). Logo a core é o lugar. A assinatura ganha `p_run_id uuid DEFAULT NULL`:
- `p_run_id` presente (run diário) → captura antes→depois + grava log vinculado ao run.
- `p_run_id` NULL (telas) → aplica com as mesmas proteções, sem log.

⚠️ **Overload em Postgres:** `CREATE OR REPLACE FUNCTION ...(text, uuid DEFAULT NULL)` cria a assinatura `(text,uuid)` **sem** substituir a `(text)` existente. Para chamadas de 1-arg resolverem na nova função, é preciso **`DROP FUNCTION atualizar_parametros_numericos_skus(text)` e recriar como `(text, uuid DEFAULT NULL)`** numa transação. Validar que os 4 call sites (edge + 3 telas) chamam por nome com `p_empresa` (PostgREST/`.rpc`) — o default cobre o `p_run_id` ausente.

## 5. Modelo de dados (2 tabelas + 1 de pin)

```sql
-- Cabeçalho do run diário (idempotência: 1 run "de mudança" por empresa/dia)
CREATE TABLE reposicao_param_auto_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  data_negocio_brt date NOT NULL,                 -- (now() AT TIME ZONE 'America/Sao_Paulo')::date
  status text NOT NULL DEFAULT 'rodando',         -- rodando | completo | erro
  total_avaliados int,
  total_aplicados int,
  total_segurados int,                            -- fusível
  total_pinados int,                              -- trava de reversão
  impacto_total_rs numeric,                       -- soma do impacto simulado (conhecido)
  impacto_desconhecido_n int,                     -- SKUs sem custo → impacto não somado
  resumo_enviado_em timestamptz,                  -- idempotência do e-mail
  criado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz
);
CREATE UNIQUE INDEX uq_param_auto_run_dia
  ON reposicao_param_auto_run (empresa, data_negocio_brt) WHERE status = 'completo';

-- Log canônico: 1 linha por SKU avaliado no run (fonte do resumo, do undo e da auditoria)
CREATE TABLE reposicao_param_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reposicao_param_auto_run(id),
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  status text NOT NULL,                           -- aplicado | segurado | pinado | sem_mudanca | bloqueado_validacao
  -- antes → depois dos 5 campos de config
  ponto_pedido_antes numeric, ponto_pedido_depois numeric,
  estoque_minimo_antes numeric, estoque_minimo_depois numeric,
  estoque_maximo_antes numeric, estoque_maximo_depois numeric,
  estoque_seguranca_antes numeric, estoque_seguranca_depois numeric,
  cobertura_antes numeric, cobertura_depois numeric,
  -- impacto da compra simulada
  impacto_rs numeric,                             -- NULL = desconhecido (custo ausente)
  qtde_compra_antes numeric, qtde_compra_depois numeric,
  custo_unitario numeric, custo_fonte text,       -- cmc | preco_medio | null
  -- contexto p/ explicabilidade (codex P2)
  demanda_media_diaria numeric, lt_medio_dias_uteis numeric,
  classe_consolidada text, z_score numeric,
  -- revert
  revertido_em timestamptz, revertido_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_param_auto_log_run ON reposicao_param_auto_log (run_id);
CREATE INDEX idx_param_auto_log_sku ON reposicao_param_auto_log (empresa, sku_codigo_omie);

-- Pin (trava de reversão): SKU que o founder reverteu não é re-aplicado até a sugestão mudar
CREATE TABLE reposicao_param_pin (
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  ponto_pedido_rejeitado numeric NOT NULL,        -- o "depois" que ele recusou (arredondado)
  estoque_maximo_rejeitado numeric NOT NULL,
  pinado_em timestamptz NOT NULL DEFAULT now(),
  pinado_por uuid,
  PRIMARY KEY (empresa, sku_codigo_omie)
);
```

RLS: leitura para staff com acesso de carteira completa (`pode_ver_carteira_completa(auth.uid())`, padrão do módulo); escrita só por `service_role` (motor) e pelas RPCs `SECURITY DEFINER` (revert/pin). `reposicao_param_pin` é escrito só pelas RPCs.

## 6. A core instrumentada — regras por SKU

Dentro de uma única transação (CTE), para cada SKU de `p_empresa` com linha na view:

**Escopo do registro vs aplicação:** as proteções (validação/fusível/trava) e a aplicação seguem o **universo atual da função** (todos os SKUs da empresa presentes na view — comportamento de aplicação inalterado, menor risco no money-path). O **log e o resumo** escopam aos SKUs **elegíveis ao motor de compras** (`habilitado_reposicao_automatica=true AND COALESCE(tipo_reposicao,'automatica')='automatica'`), para o resumo refletir só o que efetivamente gera compra (não polui com `produto_acabado`/desabilitado, que o motor ignora).

### 6.1 Validação dura (codex P1 #2) — antes de qualquer gravação
A sugestão só é candidata a aplicar se **todos** valerem:
- os 5 campos sugeridos são `NOT NULL` e **finitos** (rejeita `NaN`/`Inf`/string vazia coercida);
- não-negativos;
- `estoque_maximo_sugerido >= ponto_pedido_sugerido >= estoque_minimo_sugerido`;
- `cobertura_alvo_dias` sã (`> 0`).

Falhou → **não aplica** (preserva o valor anterior), `status='bloqueado_validacao'`, entra no resumo. (Defesa contra a view cuspir parcial/incoerente mesmo com `status_sugestao='OK'`.)

> Observação: o COALESCE atual já preserva quando o sugerido é NULL (status ≠ OK). A validação dura amplia isso para "OK porém incoerente".

### 6.2 Fusível (decisão 7) — contenção de input corrompido, por-SKU
Calcula o salto vs o valor **anterior** (não-nulo). Segura o SKU **inteiro** (não aplica nenhum dos 5; mantém os anteriores) se **qualquer** gatilho disparar:
- `estoque_maximo_sugerido > FUSIVEL_MULT × estoque_maximo_anterior` (anterior não-nulo e > 0), **default `FUSIVEL_MULT = 3`**; ou
- cobertura implícita do máximo > `FUSIVEL_COBERTURA_DIAS`, i.e. `estoque_maximo_sugerido / NULLIF(demanda_media_diaria,0) > FUSIVEL_COBERTURA_DIAS`, **default `120` dias**.

Segurado → `status='segurado'`, valor anterior preservado, entra no resumo na seção "segurei, confira". Limiares em `company_config` (ajustáveis pelo founder sem deploy). SKU **sem valor anterior** (primeira parametrização) **não** é segurado por multiplicador (não há base) — mas é coberto pelo gatilho de cobertura.

### 6.3 Trava de reversão (decisão 6, codex P1 #3) — fingerprint material
Se existe pin ativo para o SKU:
- Compara o **fingerprint material** = `(round(ponto_pedido_sugerido), round(estoque_maximo_sugerido))` com `(ponto_pedido_rejeitado, estoque_maximo_rejeitado)`.
- **Igual** → não aplica, mantém o pinado, `status='pinado'`. (Não re-empurra o valor recusado.)
- **Diferente** → a sugestão mudou materialmente → aplica normalmente **e apaga o pin** (a trava só vale para o valor que ele recusou).

Arredondamento para inteiro (quantidades) elimina o ruído decimal que tornaria "mudou" sempre verdadeiro na view que recomputa ao vivo.

### 6.4 Aplicação + log
Passou por 6.1–6.3 e o valor difere do atual (arredondado) → aplica os 5 campos (como hoje) e `status='aplicado'`. Igual ao atual (arredondado) → **não gera linha de log** (contado apenas em `total_avaliados` do run); evita inflar o log com milhares de SKUs inalterados. Métricas derivadas (demanda/lt/z) seguem sempre frescas (não são config — comportamento atual preservado).

### 6.5 Impacto da compra simulada (codex P1 #7)
Para cada SKU aplicado/segurado, calcula o impacto = **Δ da compra que o ciclo geraria agora**:
```
qtde(param) = CASE WHEN (estoque_fisico+pendente+em_transito) <= ponto_pedido(param)
                   THEN GREATEST(0, estoque_maximo(param) - (estoque_fisico+pendente+em_transito))
                   ELSE 0 END
impacto_rs = (qtde(depois) - qtde(antes)) × custo_unitario
```
`custo_unitario` de `inventory_position.cmc` (custo médio contábil, conta canônica OBEN — ver CLAUDE.md §5), fallback `preco_medio`. **Custo ausente → `impacto_rs = NULL` (desconhecido)**, contabilizado em `impacto_desconhecido_n`, nunca como zero. A posição de inventário é a do momento do run (manhã) — aproximação aceitável.

## 7. Wrapper diário + idempotência (codex P1 #5)

`aplicar_parametros_automatico_diario(p_empresa)` (`SECURITY DEFINER`, service-role-friendly):
1. `pg_advisory_xact_lock(hashtext('param_auto_'||p_empresa))` — serializa runs concorrentes.
2. Se já existe run `completo` para `(empresa, hoje BRT)` → **return early** (no-op; não duplica).
3. `INSERT reposicao_param_auto_run (status='rodando') RETURNING id`.
4. Chama a core com `run_id` (toda a aplicação + log numa transação).
5. `UPDATE run SET status='completo', totais..., concluido_em=now()`.
6. Em erro na core: a transação faz **rollback** (sem aplicação parcial), o run fica `status='erro'`, e o edge tolera (o `try/catch` do `omie-cron-diario` não deve derrubar o resto do sync). Nesse dia não há resumo (o cron das 18h só lê run `completo`).

O **edge `omie-cron-diario`** troca a chamada `atualizar_parametros_numericos_skus('oben')` por `aplicar_parametros_automatico_diario('oben')`. Único toque no edge (1 linha) → exige 1 redeploy.

## 8. Resumo diário (e-mail)

Cron pg_cron `reposicao-param-auto-resumo` **18h BRT** (`0 21 * * *` UTC, padrão do projeto), SQL local (sem `net.http_post` → sem armadilha do timeout 5s):
- Lê o run `completo` de hoje. Se `resumo_enviado_em` já setado → no-op (idempotente).
- Pré-renderiza `titulo` + `mensagem` (corpo completo, padrão do digest WhatsApp-SLA): "**N parâmetros mudaram hoje (OBEN)** · ΔR$ total estimado · **Top mudanças por impacto** (SKU, antes→depois de PP/máx, ΔR$) · **Segurados pelo fusível (M)** — confira · link para a tela".
- `INSERT fornecedor_alerta (tipo='param_auto_resumo', ...)` (estende o CHECK do tipo, preservando os existentes) → `dispatch-notifications` (cron existente) envia.
- `UPDATE run SET resumo_enviado_em=now()`.

⚠️ `dispatch-notifications` manda `titulo`+`mensagem` genérico (sem filtro de tipo). O corpo é **pré-renderizado** aqui (mesmo padrão do `whatsapp_sla_digest`).

## 9. Tela "Mudanças automáticas" + RPCs de revert

Front (rota nova em Reposição, gated staff): lista o run do dia ordenada por `impacto_rs` desc (desconhecidos ao fim, marcados), antes→depois dos 5 campos, badge de status (aplicado/segurado/pinado), seção "segurados pelo fusível". Ações:

- **Reverter este** → `reverter_parametro_auto(p_log_id)` (`SECURITY DEFINER`):
  - gate `pode_ver_carteira_completa(auth.uid())` **+** empresa do log (codex P1 #10);
  - lê a linha do log; **só restaura se os valores atuais de `sku_parametros` ainda forem == os "depois" logados** (codex P1 #4). Se divergir (edição posterior) → retorna `conflito`, não atropela;
  - `UPDATE sku_parametros` para os "antes"; marca `revertido_em/por`;
  - **grava o pin** `(empresa, sku, ponto_pedido_rejeitado=depois, estoque_maximo_rejeitado=depois)` → trava §6.3;
  - retorna `{revertido|conflito}` para o toast (undo curto opcional).
- **Reverter tudo do dia** → `reverter_run_auto(p_run_id)`: aplica o item-a-item acima a cada linha `aplicado` do run; reporta quantos revertidos / em conflito.
- **Devolver ao automático** → `despinar_parametro(p_empresa, p_sku)`: apaga o pin (o cron volta a poder aplicar a sugestão).

Reverter é **por run_id** (não data) — codex P1 #4/#5. Reverter "dias depois" só faz sentido se o estado atual ainda for o que aquele run pôs (a guarda de conflito protege).

## 10. Mapa codex consult (xhigh, 11 P1 + 5 P2) → tratamento

| Achado | Tratamento |
|---|---|
| P1 Omie isolation | A automação **não liga** `aplicar_no_omie`; não há cron de push Omie (manual). §2/§3. |
| P1 `status='OK'` não é contrato | Validação dura §6.1. |
| P1 revert/re-apply incoerente | Fingerprint material (PP+máx arredondados) §6.3. |
| P1 revert clobbera edição | Só restaura se atual == "depois" logado; senão conflito §9. |
| P1 idempotência > 1/dia | Tabela run + unique parcial + advisory lock §7. |
| P1 race 09:15 | **Desarmada**: não há auto-aprovação de pedido (§1, fato 2); pedido espera clique. |
| P1 impacto R$ errado | Compra simulada Δqtde×custo §6.5; custo ausente = desconhecido. |
| P1 `aprovado_em` em massa | A core **não** carimba `aprovado_em` (a função atual já não carimba); metadata própria no log. Auditado: watchdog limbo não lê `aprovado_em`; leitores são só UI (aba pendente). |
| P1 histórico engana | Log custom é canônico. Trigger genérico já tem churn diário hoje; opcional: GUC de sessão na core → trigger rotula `'automacao'` (limpa label; não bloqueante). |
| P1 auth nas RPCs | Gate `pode_ver_carteira_completa` + empresa §9. |
| P2 override semântica | `demanda_multiplicador_override` é **inerte** (view não lê) — sem tratamento especial; observação. |
| P2 elegibilidade exata | A core já casa o universo da view; guardas `habilitado`/`tipo_reposicao` herdadas (a view/RPC já as respeitam). Reconferir `COALESCE(tipo_reposicao,'automatica')`. |
| P2 log de pulados | `status` cobre segurado/pinado/bloqueado/sem_mudanca → todos no log §5. |
| P2 contexto no log | Demanda/lt/classe/z no log §5. |
| P2 fusível catastrófico | **Adotado** §6.2 (decisão 7). |

## 11. Riscos e mitigações

- **Tocar o edge `omie-cron-diario` (money-path):** mudança mínima (1 chamada). Mitigação: o wrapper é best-effort; se falhar, a aplicação não pode regredir silenciosamente. Validar em PG17 que o wrapper aplica idêntico à função atual quando não há pin/fusível.
- **DROP+CREATE da core:** confirmar os 4 call sites e que `(text)` 1-arg resolve na nova `(text, uuid DEFAULT NULL)`. Testar `.rpc` das telas.
- **Fusível tarde demais (a 1ª vez):** se um valor quebrado já foi aplicado antes da v1 ir ao ar, o fusível só pega o **próximo** salto. A tela de reverter cobre o legado.
- **Churn do histórico genérico:** já existe hoje; não piora. GUC de label é opcional.
- **Telas de refresh manual herdam fusível/trava:** comportamento correto (não aplicam lixo nem burlam a trava). Follow-up: feedback "X segurados" e override explícito na tela.

## 12. Plano de validação

- **Helper puro TDD** (oráculo da SQL): `src/lib/reposicao/param-auto-helpers.ts` — `passaValidacao(sugestao)`, `disparaFusivel(antes, sugestao, demanda, limiares)`, `fingerprintMaterial(p)`, `decideStatus(...)`, `impactoSimulado(antes, depois, posicao, custo)`. Vitest.
- **SQL em PostgreSQL 17 local** (base `db/verify-snapshot-replay.sh`): semear `sku_parametros` + a view + `inventory_position`; asserts — aplica normal; segura por multiplicador; segura por cobertura; bloqueia incoerente (máx<PP); pin bloqueia valor igual e libera quando muda; idempotência (2º run mesmo dia = no-op); revert restaura e cria pin; revert com estado divergente = conflito; impacto desconhecido quando custo ausente.
- **Codex challenge** no diff antes do merge (money-path).

## 13. Limiares do fusível (defaults, ajustáveis em `company_config`)

- `param_auto_fusivel_mult = 3` (estoque_máximo novo > 3× o anterior).
- `param_auto_fusivel_cobertura_dias = 120` (máximo implica > 120 dias de cobertura).
- `param_auto_resumo_hora_brt = 18`.

## 14. Rollout

1. Migration (2+1 tabelas + RLS + extensão do CHECK de `fornecedor_alerta` + seeds de `company_config`) — **manual no SQL Editor** (CLAUDE.md §5).
2. Migration da core reescrita (DROP+CREATE `atualizar_parametros_numericos_skus(text,uuid)`) + `aplicar_parametros_automatico_diario` + RPCs de revert/pin + cron `reposicao-param-auto-resumo` — **manual no SQL Editor**.
3. **Redeploy do edge `omie-cron-diario`** (1 linha) via chat do Lovable, verbatim da main.
4. Frontend (tela + hook) — merge + **Publish**.
5. Validação em prod: rodar 1 ciclo, conferir o run/log, o e-mail das 18h, reverter 1 SKU e ver o pin segurar no dia seguinte.

## 15. Não-objetivos explícitos (recapitulação)

Cold-start, Omie, multi-empresa, gate de aprovação de compra, override como input. Todos fora da v1 por decisão consciente.
