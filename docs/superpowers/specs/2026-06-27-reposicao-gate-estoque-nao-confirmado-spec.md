# Spec — Gate de estoque-não-confirmado no motor de reposição (money-path)

> Status: DRAFT (metodologia validada por Codex consult 019f0968, jun/2026). Próximo: migration + prove-sql PG17 + challenge Codex xhigh.
> Domínio: `docs/agent/reposicao.md` + `docs/agent/money-path.md`. RPC alvo: `gerar_pedidos_sugeridos_ciclo`.

## 1. Problema (provado em produção, 2026-06-27)

O motor `gerar_pedidos_sugeridos_ciclo` gera compra quando `estoque_efetivo <= ponto_pedido`, lendo
`GREATEST(inventory_position.saldo, sku_estoque_atual.estoque_fisico) + pendente + em_transito`.

A função cold-start (`reposicao_cold_start_parametros`) faz SKU de primeira-compra aparecer na fila:
habilita + **semeia `sku_estoque_atual` de `omie_products.estoque`** (catálogo), `fonte_sync='cold_start_seed'`,
`ON CONFLICT DO NOTHING`. **Defeito:** `omie_products.estoque` está **82% zerado na OBEN** (681/3670 com saldo);
o estoque real vive em `inventory_position` (761/762) e no sync `ListarPosEstoque`. O seed grava 0 mesmo
quando o Omie tem saldo.

**Cronologia do incidente (UTC):** 13:14 cold-start criou 64 SKUs (seed=0) → 13:31 motor gerou pedido #775
lendo 0 → 13:40 `ListarPosEstoque` revelou saldo real (10, 8, 6, 4...). **31 de 43 itens** tinham saldo real
que o snapshot não viu → pedido compra o que já temos (capital empatado).

**Por que o fix óbvio falha:** "trocar a fonte do seed p/ inventory_position" não resolve — no instante da
geração, `inventory_position` TAMBÉM está vazio p/ o SKU recém-criado (9 dos 64 ainda ausentes; os outros
só foram preenchidos pelo `ListarPosEstoque` às 13:40, DEPOIS da geração). Ambas as fontes boas estão vazias
porque o SKU é novo.

## 2. Decisão (Codex consult, convergência)

O fix **não** é a fonte do seed. É: **o motor não pode tratar estoque DESCONHECIDO como zero numa decisão de
compra** (money-path: ausente ≠ zero, precisão > recall). `cold_start_seed` não é inventário — é um hack de
enfileiramento e deve contar como `unknown`.

**Gate no MOTOR, não no cold-start** (cold-start tem que seguir habilitando, senão o sync — que só cobre
habilitados — nunca pega o SKU → deadlock). O motor **suprime a sugestão** quando a decisão de compra se
apoiaria em estoque não-confirmado, e **loga** o suprimido (senão vira subcompra silenciosa).

## 3. Design

### 3.1 Fonte CONFIRMADA vs NÃO-CONFIRMADA (por SKU)
- **Confirmada** se QUALQUER: `sku_estoque_atual.fonte_sync LIKE 'ListarPosEstoque%'` (sync real do Omie,
  inclui 0 confirmado via `cExibeTodos:"S"`), OU `inventory_position` presente (`inv_saldo` não-nulo).
- **Não-confirmada** se a ÚNICA fonte é `fonte_sync='cold_start_seed'` E `inventory_position` ausente.
- (Linha sem `sku_estoque_atual` e sem `inventory_position` = também não-confirmada — não ocorre p/ habilitado,
  mas o gate trata fail-closed.)

### 3.2 Regra de supressão (fail-closed)
- **SKU isolado (sem grupo de equivalência):** se dispara compra (`estoque_efetivo <= ponto_pedido`) E a fonte
  é não-confirmada → **suprime + loga**.
- **Grupo de equivalência (≥2 membros):** o gate é no GRUPO (Codex). Se `estoque_grupo <= ponto_pedido` E
  QUALQUER membro contribuinte é não-confirmado → **suprime o grupo + loga**. (Membro não-confirmado pode ter
  saldo que levaria o grupo acima do ponto; assumir 0 = compra-fantasma.)
- Se o estoque CONFIRMADO já está acima do ponto, o `WHERE` existente já não inclui — gate não atua. ✓

### 3.3 Implementação na RPC (pontos exatos)
1. `grupo_estoque` (CTE): adicionar `bool_or(sea.fonte_sync='cold_start_seed' AND inv.saldo IS NULL)
   AS grupo_nao_confirmado`.
2. `sku_base`: trazer `sea.fonte_sync` + `ip.saldo IS NULL` → derivar `linha_nao_confirmada`; e `ge.grupo_nao_confirmado`.
3. Separar em CTE `avaliados` com flag `suprimido` (= dispara compra E não-confirmado, linha OU grupo) + `motivo`.
4. INSERT de pedido SÓ p/ `NOT suprimido`. INSERT no log p/ `suprimido`.

### 3.4 Tabela de log (observabilidade — Codex: senão é subcompra silenciosa)
`reposicao_estoque_nao_confirmado_log` (run-stamped): empresa, sku_codigo_omie, grupo_id, motivo
(`linha_seed_only`|`grupo_membro_seed_only`), estoque_efetivo, ponto_pedido, fonte_sync, criado_em. RLS
`pode_ver_carteira_completa`. Surface numa fila de exceção na tela de Reposição.

### 3.5 Preflight de geração manual (frontend)
Antes do "Recalcular": contar SKUs habilitados OBEN com `fonte_sync='cold_start_seed'` sem `inventory_position`.
Se > 0, avisar "N SKUs com estoque não confirmado serão pulados; rode o sync de estoque antes p/ não subcomprar."
(Defense-in-depth de UX — o gate do motor é a proteção real.)

## 4. Threat model (engine que emite decisão — `docs/agent/threat-model-template.md`)

| O que PROVA | O que NÃO prova | Default fail-closed |
|---|---|---|
| Não compra com estoque só-seed | Que o sync real está fresco (camada do Sentinela) | Estoque não-confirmado ⇒ **NÃO compra** (suprime) |
| Zero-real (ListarPosEstoque/0) ainda compra | Que o Omie nunca omite um SKU ativo | SKU omitido ⇒ `ativo_no_omie=false` ⇒ sai do motor |
| Grupo com membro seed-only não compra | — | Qualquer dúvida no grupo ⇒ suprime o grupo |

**1 assert por default declarado** (doc×código não podem divergir). Cobertura de zero-confirmado: empírica —
448 SKUs OBEN sincronizados, 120 com `ListarPosEstoque/estoque_fisico=0` (a API retorna zeros via `cExibeTodos:"S"`).

## 5. Plano de prova PG17 (`prove-sql-money-path`, com falsificação)

Cenários (asserts positivos E negativos):
1. **Seed-only dispara compra** (cold_start_seed=0, sem inv) → **suprimido** + linha no log. (positivo do gate)
2. **Confirmado-zero compra** (ListarPosEstoque/0, sem inv) → **incluído** (compra legítima de 1ª compra). (não trapeia zero-real)
3. **Confirmado-com-saldo acima do ponto** → não incluído (já era). (regressão)
4. **Grupo: 1 membro ListarPosEstoque c/ saldo + 1 membro seed-only**, grupo <= ponto → **grupo suprimido**.
5. **Grupo: todos confirmados, abaixo do ponto** → incluído normalmente.
6. **inventory_position presente + sea=cold_start_seed** → confirmado (inv conta) → incluído/avaliado normal.
**Falsificação:** remover a cláusula do gate → cenário 1 PASSA a comprar (vermelho). Trocar `bool_or` por
`bool_and` no grupo → cenário 4 vaza (vermelho). Sem o vermelho, o assert não tem dente.

## 6. Modos de falha (Codex) + mitigação

- **Starvation:** sync parado por dias ⇒ motor suprime 1ª-compra p/ sempre. Correto (fail-closed) MAS **precisa
  alertar** → o Sentinela já vigia sync congelado (`diagnose-supabase-sync`); o log de suprimidos dá visibilidade.
- **Sync parcial:** run paginada/falha parcial pode deixar uns seed. A edge `omie-sync-estoque` já é fail-closed
  (erro de varredura é FATAL → throw → Sentinela). Não tratar parcial como confirmação. ✓ (já vale)
- **Confirmação stale:** `ListarPosEstoque` de semana passada conta como confirmado? V1: sim (binário). V2 (futuro):
  regra de frescor `ultima_sincronizacao`. Registrar como dívida.
- **Snapshot já gravado (#775):** o gate só age em pedidos FUTUROS. Ação imediata: Recalcular (apaga+regera).
- **inventory_position aparece depois, sea continua seed:** `inv` presente ⇒ confirmado (Codex: sim se fresco). ✓
- **Race trigger manual:** geração logo após cold-start pula linhas (seguro). Preflight (3.5) dá visibilidade.

## 7.5 Hardening pós-Codex challenge (xhigh, sessão 019f0968 — 209k tokens)

Corrigido (P1 de lógica, provado em `db/test-gate-estoque-nao-confirmado.sh` C6/C7 + FAL4):
- **Missing `sku_estoque_atual` (LINHA):** `sea` ausente = estoque DESCONHECIDO, não zero confirmado → suprime
  (C6). Só na LINHA isolada; no GRUPO **não** conta (galão legitimamente vive sem `sea` próprio — o estoque vem de
  outro membro; tratar como não-confirmado regredia 7 grupos do galão: STALE/NOMAP/INAT/ANC/MIN/OPQT).
- **`inv` por PRESENÇA da linha, não `saldo`:** linha e grupo usam `.sku IS NULL` (existe linha de
  `inventory_position`?), não `saldo IS NULL` — senão um `saldo` NULL faria a linha comprar e o grupo suprimir
  (Codex P1, inconsistência).
- **Membro INATIVO não envenena (GRUPO):** membro seed-only com `ativo_no_omie=false` NÃO vota no
  `grupo_nao_confirmado` (senão um galão descontinuado bloquearia a âncora ativa p/ sempre — Codex P1 starvation). FAL4.

Dívida conhecida (V2, NÃO bloqueante — registrada):
- **Frescor da confirmação:** `inv_saldo` aceita a linha mais recente sem bound de frescor — herança do motor galão
  (o `GREATEST(inv.saldo, sea)` já usa `inv_saldo` sem frescor). Stale severo é pego pelo Sentinela. V2: regra de frescor.
- **Log mostra a âncora, não o membro culpado (P2):** após troca p/ galão, o log grava `sku`/`fonte_sync` da âncora;
  o membro seed-only que causou a supressão não aparece. Observabilidade; o pedido/grupo ainda é identificável.

## 7.6 Coordenação / aplicação
- NÃO toca `omie-sync-estoque` (cobertura já OK) nem `reposicao_cold_start_parametros` (seed segue, só vira inócuo).
- RPC `gerar_pedidos_sugeridos_ciclo` é função QUENTE (já sofreu PR duplicado) → pré-flight `pg_get_functiondef`
  da prod antes de `CREATE OR REPLACE` (a última a recriar vence). PR aberto #1102 mexe em sync pedidos-compra
  (disjunto). Timestamp de migration > `20260627130000`.
- Escrita money-path = handoff p/ o founder colar no SQL Editor (gate humano).
