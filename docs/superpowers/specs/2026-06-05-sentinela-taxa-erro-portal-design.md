# Spec — Sentinela: check de taxa de erro do portal Sayerlack

> Sub-PR 2 do programa de unificação de pedidos de compra (decisão §9.1 do
> `2026-06-05-unificacao-pedidos-compra-design.md`). Adicionaria ao `_data_health_compute`
> um check de **taxa de falha** do disparo do portal, complementando os 2 checks
> binários de backlog (`reposicao_portal_pipeline` / `reposicao_portal_humano`).
> Data: 2026-06-05.

## ⏸️ STATUS: DEFERIDO (decisão founder + codex, 2026-06-05) — NÃO construído

**Decisão:** **adiar**, registrar pra revisitar com volume. A calibração + 2 consults ao
codex mostraram que o check é **marginal e provavelmente inerte** no volume atual, e o custo
(recriar o `_data_health_compute` — o arquivo com **3 incidentes de cascata** do repo) não se
paga pelo retorno. **O documento fica como registro** (design pronto + calibração) pra não
re-litigar.

**Calibração real (BLOCO B, 2026-06-05 — `pedidos_portal_tentativas` desde 15/05, ~3 semanas):**

| status_resultado | total (≈30d) | 7d | natureza |
| --- | --- | --- | --- |
| `sucesso_portal` | 20 | 3 | sucesso |
| `erro_nao_retentavel` | 10 | 0 | **SKU sem de-para = problema de DADO** (já vigiado por `reposicao_portal_humano` + `reposicao_mapeamento_sayerlack`) |
| `indeterminado_requer_conciliacao` | 7 | 5 | ambiguidade Browserless = confiabilidade de portal (mas **já no numerador do `humano`**) |

- **~1,7 disparo/dia** (37 tentativas / 3 semanas). Só 3 valores de `status_resultado` existem
  (zero `erro_retentavel`/`erro_excecao`/`falha_envio_portal`/`enviado_portal`/`aceito_portal_sem_protocolo`).
- Taxa "toda não-sucesso" = 17/37 = **46%** (dominada pelo gap de de-para já vigiado).
  Taxa "confiabilidade de portal" (excluindo `erro_nao_retentavel`) = 7/27 = **26%**.
- **Veredito codex (2 passes):** numerador deve excluir `erro_nao_retentavel`; medir **por
  PEDIDO** (não tentativa); 55/70 Wilson-LB; *"o check é MARGINAL, só vale como safety-net
  silenciosa se for barato — senão cortar e revisitar com mais volume / >5 pedidos distintos
  recorrentes."* O `humano` já pega o backlog; a taxa só agregaria "degradação sistêmica com
  backlog drenado" — marginal nesse volume.

**🔭 Gatilho de revisita:** quando o disparo do portal tiver volume suficiente pra a taxa ser
estatisticamente útil — heurística: **≥5 pedidos distintos com falha de portal recorrente numa
janela de 14–30d** (medir antes de construir). Até lá, os 2 checks de backlog + o
`reposicao_mapeamento_sayerlack` cobrem o que importa. (Mesmo padrão do `process-recurring-orders`,
diferido até haver schedule ativo — CLAUDE.md §5.)

**Se revisitado, o design já está pronto abaixo** (com a refinação por-pedido do codex). A
implementação seria: recriar `_data_health_compute` + (dashboard-only, SEM push) o check
`reposicao_portal_taxa_erro`, partindo do **corpo vivo** (confirmar com BLOCO A antes) e recriando
`data_health_watchdog`+`fin_sync_heartbeat` junto (regra anti-cascata).

---

> Status original (preservado): **EM DESENHO** (o design abaixo é o que seria construído).

## 1. Problema

Os 2 checks de portal atuais são **backlog point-in-time** — disparam quando há
um pedido travado AGORA (pipeline > 1h, humano > 2h). Eles são cegos a um modo de
degradação real: **o portal ainda entrega tudo, mas a fração de tentativas que falham
está subindo** (Browserless ficando flaky, um problema sistêmico nascendo). Como o
motor `sayerlack-retry-orfaos */15` drena o backlog, nada fica "travado" o suficiente
pra disparar os checks binários — mas cada disparo passou a custar 5 tentativas em vez
de 1, e isso é o precursor de um outage.

O check de **taxa** preenche essa lacuna: mede a fração de tentativas de portal que não
sucedem limpo numa janela móvel, como **leading indicator** de degradação.

## 2. Fonte de dados

**`pedidos_portal_tentativas`** (log por-tentativa, gravado best-effort por
`enviar-pedido-portal-sayerlack` via `gravarTentativa`, "PR1" 2026-05-15):

| coluna | uso |
| --- | --- |
| `pedido_id` | (não usado no agregado v1) |
| `iniciado_em` (NOT NULL) | janela temporal |
| `concluido_em` | — |
| `status_resultado` (NOT NULL) | classificação da tentativa (sucesso/falha) |
| `browserless_response_ms`, `elapsed_ms` | contexto (latência) — v2 |
| `erro` | mensagem (contexto no message do check) |

Cada linha = **uma tentativa** de disparo. Captura falha transitória mesmo quando o
pedido depois suceda — é por isso que é a fonte certa pra TAXA (≠ `status_envio_portal`,
que é o estado CORRENTE/mutável do pedido e perde o transitório recuperado).

**Vocabulário de `status_resultado`** (mesmo do `status_envio_portal`; o BLOCO B de
calibração revela o conjunto REAL — não assumir que esta lista é completa):
- **Sucesso limpo**: `sucesso_portal`, `enviado_portal`, `aceito_portal_sem_protocolo`
- **Falha transitória** (retry recupera): `erro_retentavel`, `erro_excecao`
- **Falha dura** (precisa humano): `erro_nao_retentavel`, `falha_envio_portal`
- **Ambíguo** (PO talvez no fornecedor): `indeterminado_requer_conciliacao`

Portal = Sayerlack = OBEN-only → todas as tentativas são OBEN-Sayerlack; **sem filtro
de empresa na v1** (contar tentativas cruas; join a `pedido_compra_sugerido` dropa linha
de pedido deletado, sem ganho).

## 3. Integração (corpo vivo)

- Estende `public._data_health_compute()` — corpo vivo = `20260604150000_tipo_produto_vigia_cobertura.sql`
  (16 checks; confirmar com BLOCO A antes de escrever). Novo check entra ANTES do
  `alert_channel` (último), depois de `omie_tipo_produto_oben`.
- **Recriar `data_health_watchdog` + `fin_sync_heartbeat` JUNTO** (regra anti-cascata
  do CLAUDE.md). Adicionar o source novo ao IN-list dos dois (watchdog 11→12 push;
  heartbeat 12→13).
- `source = 'reposicao_portal_taxa_erro'`, `domain = 'estoque'`, `severity = 'warning'`
  (igual aos outros de portal; a mensagem carrega a urgência). É **count/ratio**, não
  frescor → `age_seconds`/`expected_max_age_seconds` = NULL (padrão `sayerlack_fabricado`).
- Frontend NÃO muda (`get_data_health` repassa; `SaudeDados` agrupa por domain e renderiza
  `message`).

## 4. Decisões (FECHADAS por consult codex 2026-06-05 + achado de frontend)

> Codex deu o desenho; ajustado por um achado do código (ver §4.6). Os NÚMEROS de
> limiar ficam pendentes da calibração (BLOCO B) — devem sentar ACIMA do normal real.

1. **Numerador = falha de CONFIABILIDADE DE PORTAL, por PEDIDO** (codex 2º pass, com o dado real):
   `indeterminado_requer_conciliacao`, `erro_retentavel`, `erro_excecao`, `falha_envio_portal`.
   **EXCLUIR `erro_nao_retentavel`** do numerador E do denominador — é reject por SKU não
   mapeado (problema de DADO determinístico, já vigiado por `humano` + `mapeamento_sayerlack`),
   não outcome de processamento do portal; incluí-lo poluiria o sinal e inflaria o baseline
   (46% vs 26%). **Medir por PEDIDO, não por tentativa** (volume baixo: tentativa superestima
   flakiness com retry do mesmo pedido):
   `denom` = pedidos distintos com ≥1 tentativa de status **processável** (sucesso ou falha de
   portal) na janela; `num` = pedidos distintos com ≥1 tentativa de falha-de-portal.
   `taxa = num/denom`. (O 1º pass do codex dizia "toda não-sucesso por tentativa"; o dado real
   reformulou — ver bloco DEFERIDO no topo.)
2. **Limiar = fixo sobre Wilson 95% lower bound** (codex), NÃO taxa crua. Decisão usa o
   piso de confiança (z=1.96); a mensagem mostra a taxa crua. Impede "8/10=80%" de alarmar
   com amostra fraca. Candidato `stale ≥ 55% / broken ≥ 70%` — **CALIBRAR acima do normal**
   (se o BLOCO B mostrar normal ~50%, subir pra ~75/88; o limiar tem que ter folga sobre
   o baseline ou o check vira ruído). Sem baseline relativo na v1 (volume baixo o mata).
3. **Gate de volume = ≥20 tentativas E ≥5 pedidos distintos** na janela (codex). Abaixo →
   amostra insuficiente.
4. **Janela adaptativa 14d→30d** (codex): usa 14d se passa o gate, senão 30d. (7d é ruído
   em baixo volume.) Se o BLOCO B mostrar 30d ainda <20 tentativas, ampliar/abaixar o gate.
5. **Contexto na mensagem, não gatilho** (codex): mostrar a taxa crua + x/n + janela +
   piso de confiança. `tentativas_ate_sucesso` fica pra v2.
6. ⚠️ **DESVIO da recomendação do codex — amostra insuficiente → `'ok'`, NÃO `'unknown'`:**
   o codex assumiu `unknown` = neutro. **Mas o frontend deste projeto trata `unknown` =
   VERMELHO** (`health-helpers.ts:12` badge→red em qualquer `broken||unknown`;
   `DataHealthBanner.tsx:11`; teste "SEM VERDE SILENCIOSO: unknown => vermelho"). Como o
   Sayerlack é baixo volume, o check ficaria `unknown` quase sempre → **badge do Sentinela
   vermelho permanente → fadiga de alarme** (mina os outros checks). Então amostra
   insuficiente retorna **`'ok'`** com mensagem honesta ("amostra insuficiente (N tent.,
   P pedidos em Dd) — sem avaliação"). Precedente: `reposicao_sayerlack_fabricado` é
   count-based e só emite `ok`/`stale` (n=0 → `ok`). "0 dispatches" não é catástrofe — os
   checks de backlog (`pipeline`/`disparo`) já cobrem "pipeline morto".
   **Consequência boa:** o check nunca emite `unknown` → **ZERO mudança na semântica do
   `data_health_watchdog`** (não preciso trocar o `<> 'ok'`; risco de cascata eliminado).
   Limitação v1: o card não distingue "portal saudável" de "poucos disparos" (a mensagem
   bridge). Lesser-evil claro vs. badge vermelho permanente.

### Lógica final do status

> ⚠️ O bloco abaixo é a 1ª formulação (por TENTATIVA). A versão FINAL (codex 2º pass) é
> **por PEDIDO** (ver §4.1): `n`→`denom` (pedidos processáveis), `x`→`num` (pedidos com falha
> de portal), gate primário = `denom ≥ 5 pedidos distintos` (o ≥20 tentativas sai). O esqueleto
> (Wilson LB, janela adaptativa, gate-fail→`ok`, agregados escalares) permanece igual.

```
n = tentativas na janela ; pedidos = count(distinct pedido_id) ; x = não-sucessos
gate: n >= 20 AND pedidos >= 5
  NÃO passa  → 'ok'      (msg "amostra insuficiente …")
  passa      → wilson_lb >= BROKEN_THR → 'broken'
               wilson_lb >= STALE_THR  → 'stale'
               senão                   → 'ok'  (msg com a taxa)
```
Wilson LB (z=1.96, z²=3.8416): `(p + z²/2n − z·√((p(1−p) + z²/4n)/n)) / (1 + z²/n)`, p=x/n.
Guard `greatest(…,0)` sob o sqrt (erro de float). Subquery com **agregados escalares**
(não GROUP BY) → o check SEMPRE retorna 1 linha, mesmo com a tabela vazia (não pode sumir).

## 5. Não-objetivos (v1)

- Latência (`browserless_response_ms`) como sinal — v2.
- Taxa por SKU/fornecedor — Sayerlack é o único portal; v2 se nascer outro.
- Push de alerta pelo canal do portal — segue o padrão `fornecedor_alerta` → `dispatch-notifications`.
- Mudar os 2 checks binários existentes — ficam VERBATIM.

## 6. Validação

- PG17 local (`db/verify-snapshot-replay.sh` base): recriar as 3 funções, semear
  `pedidos_portal_tentativas` com cenários (alta taxa → stale/broken; baixa → ok;
  volume baixo → unknown; tabela vazia → unknown) e asseverar o status de cada.
- Confirmar que os 16 checks pré-existentes seguem presentes (anti-regressão de cascata).
- BLOCO A confirma o corpo vivo == repo antes de escrever.
