# Consolidação dos clientes duplicados (clones do import de março) — Design

> Data: 2026-06-13. Origem: o backfill de cadastro (spec 2026-06-12) rodou dry-run e revelou que os
> 1.633 "clientes-fantasma" NÃO precisam de cadastro novo — são **clones** de clientes que já têm
> profile. Founder decidiu **consolidar** (1 cliente por CNPJ, com nome, na carteira da vendedora certa).

## Causa-raiz (provada por dados, 2026-06-13)

O import de **2026-03-01/02** montou a carteira das vendedoras puxando os clientes do Omie e **casando
por `omie_codigo_cliente`, não por CNPJ**. Como cada cliente já existia no app (com nome, sob OUTRO
código Omie), o import não os reconheceu e criou **1.633 clones vazios** (auth.users `@placeholder.local`
+ `omie_clientes` + `carteira_assignments` + scores, **sem profile**).

Evidências:
- `omie_clientes` 6.909 = 5.276 com profile + 1.633 sem profile (clones). `auth.users` 6.914 ≈ 6.909 + 5 staff.
- Dry-run do backfill: `com_match=1633`, `ambiguos=0`, **`doc_em_outro_profile=1633`** (100% dos clones têm
  o CNPJ num profile existente — o gêmeo) e `created_at_recente=0`.
- Query A (`codigos_com_mais_de_um_vinculo=0`): cada `omie_codigo_cliente` está em 1 só `omie_clientes` →
  clone e gêmeo têm **códigos diferentes** (X≠Y), mesmo CNPJ.
- Query B (carteira × profile × source):
  | source | total | com nome | clone sem nome |
  |---|---|---|---|
  | `omie` (vendedor atribuído no Omie) | 1.246 | 8 | **1.238** |
  | `hunter_orphan` (sem vendedor) | 5.663 | 5.268 | 395 |
- Datas: os 1.238 + 395 = **1.633 clones** nasceram em 2026-03-01/02 (janela do import). Gêmeos com nome
  são mais antigos/espalhados (fev–mai).
- Histórico (onde está o valor):
  | tipo | clientes | c/ pedido app | faturamento app |
  |---|---|---|---|
  | clone `omie` | 1.238 | 26 | R$ 26.259 |
  | clone `hunter_orphan` | 395 | 5 | R$ 1.296 |
  | **com nome (gêmeos)** | 5.268 | 539 | **R$ 2.252.820** |
  → **o gêmeo concentra ~99% do faturamento** + nome + documento + profile. **Sobrevivente = o gêmeo.**
  (Score ativo cobre todos: vem de `order_items`/analytics, não de `sales_orders`.)

## Decisão

**Consolidar** cada par (clone, gêmeo): o **gêmeo sobrevive** (nome/doc/profile/histórico); a **atribuição
de carteira do clone** (owner=vendedora, `source='omie'`, `omie_codigo_vendedor`) **migra para o gêmeo**;
o clone é **absorvido/descartado**. Resultado: a vendedora vê o cliente real com nome+histórico; 1 cliente
por CNPJ.

## O NÓ central — a CARTEIRA é DERIVADA, e o app espelha o Omie (descoberto 2026-06-13)

**Cadeia de derivação** (a chave de tudo):
`Omie` → **`syncCustomers`** (`omie-analytics-sync`: casa código/doc → user_id, upsert onConflict user_id,
grava `omie_codigo_vendedor`) → **`omie_clientes`** (UNIQUE(user_id)) → **`carteira-rebuild`**
(`supabase/functions/carteira-rebuild/index.ts`: DERIVA `carteira_assignments` de `omie_clientes ×
omie_vendedor_map` — vendedor mapeado → `source='omie'`/owner=vendedora; sem vendedor →
`hunter_orphan`/owner=hunter(founder); upsert onConflict `customer_user_id`; **idempotente, roda em cron**)
→ scores.

**Por isso o clone vai pra vendedora e o gêmeo pro founder:** o clone tem `omie_clientes.omie_codigo_vendedor`
preenchido (vendedor do Omie) → carteira da vendedora; o gêmeo tem `omie_codigo_vendedor=NULL` →
hunter_orphan/founder.

**Consequência dura:** **qualquer mudança manual em `carteira_assignments` é DESFEITA pelo próximo
`carteira-rebuild`** (ele re-deriva de `omie_clientes`). E qualquer mudança em `omie_clientes` é desfeita
pelo próximo `syncCustomers` (relê do Omie, que ainda tem os 2 cadastros X e Y). **A consolidação só é
estável se atacar a FONTE (Omie) ou se houver uma camada de override que o sync respeite.** Mover linhas
no app sem isso = ping-pong a cada cron.

- 1:1 confirmado: `doc_duplicado_no_lote=0` no dry-run → cada clone tem documento único → 1 gêmeo único.
- Blast radius: **26 tabelas** com `customer_user_id`; UNIQUEs em carteira/scores/contacts/processes; 32 FKs
  p/ auth.users — re-apontar tudo é pesado e colide com UNIQUE.

**Pergunta aberta (impacta a estratégia):** os 2 códigos (X, Y) são da MESMA conta Omie ou de contas/
empresas diferentes (Oben×Colacor)? `empresa_omie` no banco é default 'colacor' (não-confiável); só o
casamento nas 3 contas (backfill) sabe.

## Estratégia DECIDIDA (Codex consult, 2026-06-13): "B-lite" — canonicalização na PROJEÇÃO

**Não fundir fisicamente.** Manter A (clone) e B (gêmeo) em `omie_clientes` (UNIQUE(user_id) não suporta 2
códigos por user). **NÃO tocar `syncCustomers`** (preservar X→A e Y→B impede recriação/ping-pong; o sync
segue atualizando cada código normalmente). Canonicalizar **só na derivação da carteira**.

1. **Tabela nova `customer_canonical_alias`** (imutável/auditável): `alias_user_id` (clone A) PK,
   `canonical_user_id` (gêmeo B), `documento`, `status` (active/inactive), `reason`, `batch_id`, `created_at`.
   Popular com `status='inactive'` primeiro → zero efeito até ativar (gate do canário).
2. **`carteira-rebuild` passa a consultar aliases ATIVOS:** calcula carteira bruta de A e B → substitui
   `A→B` → agrupa por canônico → **prioridade vendedor Omie mapeado vence `hunter_orphan`** → **conflito
   (2 vendedores p/ o mesmo canônico) = fail-closed (não sobrescreve)** → grava `B eligible=true` e
   **`A eligible=false` EXPLÍCITO**. A tela já filtra `eligible=true` (`escopo-clientes.ts:84`) → resolve o
   visual direto, sem deletar nada.
3. **Scores (fase 2):** preservar a linha rica de B; atualizar só `farmer_id` p/ o novo owner (o repo já
   reconhece que `calculate-scores` não reconcilia ownership). Filas/caches derivados: recalcular.
4. **Clone = DESATIVAR, nunca DELETAR.** `ON DELETE CASCADE` apagaria carteira/contatos/processos sem
   rollback simples. Manter auth placeholder + omie_clientes + alias + `eligible=false` + scores dormentes.
   Exclusão só depois de zero-referências + backup + estabilização.
5. **Pedidos/itens/financeiro:** deixar onde estão (B já concentra ~99%). Calls/visitas/contatos/processos:
   migrar depois, tabela por tabela, com regra explícita p/ cada UNIQUE. **Nunca** num UPDATE genérico das 26.

### Pré-requisito OBRIGATÓRIO (Codex): mesma conta vs cross-account — RESOLVIDO (mapa, 2026-06-13)
**`cross_account=1633` (100%), `mesma_conta=0`.** Amostra uniforme: clone na conta **`servicos`
(Colacor SC)**, gêmeo na conta **`vendas` (Oben)**. `sem_gemeo=0`, `ambiguos=0`, `conta_multipla=0`,
`conta_indefinida=0` → mapa 100% limpo, 1.633 apelidos gravados (inativos).

**Contexto de negócio (founder, 2026-06-13):** *"são os mesmos clientes, elas atendem separado por CNPJ
apenas por uma vantagem fiscal"*. Ou seja: **1 cliente real**, faturado via 2 CNPJs do grupo (Oben +
Colacor SC) por economia tributária — NÃO são clientes distintos.

**Implicação na estratégia:** confirma a B-lite (canonicalizar = "1 cliente canônico, 2 identidades ERP",
exatamente o que o Codex recomendou pro cross-account). **NÃO** dar profile a cada cadastro (criaria 2
entradas pro mesmo cliente). **NÃO** inativar nada no Omio (a separação fiscal é real e fica intacta).
- **Canônico = o gêmeo Oben** (conta `vendas`): tem nome+documento+profile + ~99% do faturamento + é onde
  o Farmer/positivação/score (tudo vendas Oben, §5) já vive → é o registro útil pra a vendedora.
- O clone Colacor SC (`servicos`) tem o vínculo de vendedor (a vendedora) + histórico de afiação → o
  rebuild faz o **canônico herdar o vendedor do clone** e marca o clone `eligible=false` (escondido,
  preservado). Unificar histórico de afiação na view = fase posterior (o sintoma é só o NOME).

### Bugs estruturais que o Codex achou (relevantes ao plano)
- `carteira-rebuild` cruza só o **código numérico, ignora a conta** (`omie_vendedor_map` é account-aware,
  `carteira-rebuild:68` não usa) → ao consertar o rebuild, considerar account-awareness.
- `carteira-rebuild` **omite `eligible` no upsert** hoje → rollback/reativação ficam incompletos; o rebuild
  novo PRECISA escrever `eligible=true/false` explícito.
- `syncCustomers`/`omie-vendas-sync` usam mapa global por código sem conta; cron só sincroniza Oben.
- Omie `AlterarCliente` tem campo `inativo`, mas a doc não garante que inativos somem de `ListarClientes` (e
  o código nem lê) → "inativar X" sozinho **não** é trava confiável; mais um motivo pra B-lite na projeção.

### Arquitetura "correta" (médio prazo, NÃO no hotfix): `omie_customer_links`
Substituir `omie_clientes` por `(omie_account, omie_codigo_cliente, canonical_user_id, omie_codigo_vendedor,
inativo)` UNIQUE(account, codigo) → vários códigos/contas → 1 cliente. Robusto, mas exige migrar o sync de
pedidos também. Fica pra depois.

## Correções pós-Codex adversarial (Fase 2 código, 2026-06-13) — INCORPORADAS
Codex deu veredito "não ativaria ainda" (5 P1 + 3 P2). Todas triadas como reais e corrigidas:
- **P1.1/P1.2 (conflito/rollback stateful):** o "não emitir" em conflito mantinha o clone escondido stale.
  **Fix:** conflito (≥2 vendedores no grupo OU código→2 vendedores) → NÃO canonicaliza; cada membro vira
  legado **VISÍVEL** (`eligible=true`, dono próprio) — nunca esconde sem unificar. Teste de transição.
- **P1.4 (fail-closed nas leituras estruturais):** `mapRes.error`/`hunterRes.error`/`vendedor_map` vazio →
  **aborta (500) antes de qualquer upsert** (senão a carteira inteira ia pro Hunter).
- **P1.5/P2.8 (paginação/determinismo):** `.order('alias_user_id')` + `.order('user_id')` nas paginações;
  clientes ordenados por id no helper → escolha de código determinística (`Math.min`).
- **P2.7 (cadeia A→B→C):** helper retorna `chainViolations`; o edge **aborta** se não-vazio.
- **P1.3 (resolução de vendedor ignora a conta Omie):** pré-existente, a B-lite pode agravar. **Não
  consertado no hotfix** (o `omie_clientes.empresa_omie` é default 'colacor' não-confiável → sem fonte
  limpa da conta do cliente client-side; refactor maior). **Mitigação:** o fail-closed (conflito → legado
  visível) impede atribuição errada. **MEDIR antes do canário** (runbook abaixo); se 0 colisões, é não-issue.
- **P2.6 (eligible=false legítimo):** gate de deploy (runbook): confirmar `count(eligible=false)=0` antes.

### Runbook de pré-ativação (gates antes do canário)
```sql
-- GATE P2.6: hoje NÃO deve haver eligible=false (o rebuild novo seta true explícito; só a B-lite cria false)
select count(*) as eligible_false_hoje from public.carteira_assignments where eligible = false; -- esperado 0

-- MEDIÇÃO P1.3: códigos de vendedor que aparecem em >1 conta no map (risco de falso conflito/atribuição)
select count(*) as codigos_vendedor_multi_conta from (
  select omie_codigo_vendedor from public.omie_vendedor_map
  group by omie_codigo_vendedor having count(distinct omie_account) > 1
) t; -- se 0 → não-issue; se >0 → o fail-closed protege, mas revisar os afetados
```
### Rollback robusto
`update customer_canonical_alias set status='inactive'` + rerodar o rebuild reativa os clones (com vendedor
viram omie eligible=true). Backstop garantido (independe do rebuild):
`update carteira_assignments set eligible=true where customer_user_id in (select alias_user_id from customer_canonical_alias)`.

## Fases (revisadas pós-Codex)
1. ✅ **Mapa + alias (Fase 1)** — PR #781 em prod. Mapa rodado: **cross_account=1633 (clone `servicos` →
   gêmeo `vendas`), mesma_conta=0, sem_gemeo=0, ambiguos=0**; 1.633 aliases gravados (inativos).
2. 🔄 **Rebuild canônico (Fase 2)** — CONSTRUÍDO. `computeCarteira` ganhou `aliasMap` (clone→canônico) +
   `eligible` explícito no `ComputedAssignment`. Helper `rebuild-helpers.ts` (9 testes TDD: legado inalterado,
   canonicalização herda vendedor, clone eligible=false, conflito fail-closed, órfão→hunter). Espelhado no
   edge `carteira-rebuild` + carrega aliases ATIVOS (fail-closed em erro de leitura) + upsert com `eligible`.
   typecheck 0 · 3233 testes · deno check 0. Codex adversarial no código: **rodando**. Deploy ANTES de ativar.
3. ⏳ **Dry-run:** rodar o rebuild novo com 0 aliases ativos → confirma comportamento inalterado.
4. ⏳ **Canário:** ativar 10–20 aliases → rodar rebuild → **1 ciclo completo `syncCustomers → carteira-rebuild`**
   → conferir tela na lente da vendedora + owner dos scores + ausência de clones elegíveis.
5. ⏳ **Lote:** ativar o resto em levas.
6. **Rollback:** `update customer_canonical_alias set status='inactive'` + rerodar rebuild (o `eligible`
   explícito reativa os clones).

## Fase 1 — MAPA (read-only, começa já)

Nova action `mapa_consolidacao` no `omie-analytics-sync` (reusa `fetchAlvosSemProfile` + enumeração das 3
contas + `fetchProfileDocUserMap`):
- Para cada clone (omie_clientes sem profile): casa por código nas 3 contas → `{documento, conta_omie}`.
- Resolve o gêmeo: documento normalizado → `profiles` (user_id + name).
- (Opcional v1.1) checa se o código do gêmeo (Y) ainda aparece na enumeração do Omie (vivo/morto).
- Persiste o mapa numa tabela `consolidacao_mapa` (clone_user_id, clone_codigo, clone_conta, documento,
  gemeo_user_id, gemeo_name, gemeo_codigo, ambiguo, observacao). Migration leve.
- Relatório: total pares 1:1, clones sem gêmeo (genuínos novos — esperado 0), gêmeos com >1 clone, mesma
  conta vs contas diferentes (dup pura vs multi-empresa).

## Fase 2 — Design da fusão + trava (Codex)

Para cada par no mapa, gerar (sem executar) os UPDATEs/DELETEs:
- `carteira_assignments`: migrar a linha do clone (owner=vendedora, source='omie', codigo_vendedor) para
  o gêmeo; remover/`eligible=false` a do clone. Tratar UNIQUE(customer_user_id) e o caso de o gêmeo já ter
  linha (hunter_orphan/founder) — decidir se o gêmeo "troca de dono" (founder→vendedora).
- `sales_orders`, `customer_visit_scores`, `farmer_client_scores`, `farmer_calls`, `route_visits`, etc.:
  re-apontar `customer_user_id` clone→gêmeo (FK-by-FK; cuidar de UNIQUE em scores → preferir recálculo via
  cron a mover linha).
- `omie_clientes`: resolver os 2 códigos (eleger o vivo; trava anti-ping-pong no sync).
- Clone: descartar `auth.users`/`omie_clientes`/score ao final, OU só desativar (eligible=false) na v1.
- **Codex valida cada classe de escrita** (money-path: carteira/score/vendas/identidade).

## Fase 3-5 — Dry-run → Canário (10–20) → Lote

- Dry-run: contar exatamente o que muda, sem gravar.
- Canário: fundir 10–20 pares reais; founder confere a tela da vendedora + scores.
- Lote: resto em levas, idempotente, com relatório.

## Não-objetivos (v1)
- Deduplicar no Omie (é ação do founder no ERP; o app pode só travar a recriação).
- Fundir clientes sem gêmeo (não existem — `doc_em_outro_profile=1633`).
- Resolver multi-empresa (mesmo CNPJ em Oben + Colacor) como caso especial até o mapa mostrar que existe.

## Estado — ✅ CONCLUÍDO EM PRODUÇÃO (2026-06-13)
- ✅ Causa-raiz provada · ✅ cross-account (mesmos clientes, 2 CNPJs fiscais) · ✅ sobrevivente (gêmeo Oben).
- ✅ Fase 1 (mapa, PR #781) · ✅ Fase 2 (rebuild canônico, PR #784, Codex 5 P1+3 P2 incorporados).
- ✅ Deploy do `carteira-rebuild` · ✅ dry-run (0 aliases → `upserted:6909, conflicts:[], eligible_false=0`,
  carteira inalterada) · ✅ canário 15 (Tatiana 1→16) · ✅ **LOTE COMPLETO: 1.633 aliases ativos,
  eligible_false=1.633, Tatiana 1→571, Regina 7→674.**
- ✅ **Manutenção automática:** cron `carteira-rebuild-nightly` (4h30 BRT) roda o edge novo → re-aplica a
  B-lite após cada sync. Nada a configurar.
- **Rollback** (se preciso): `update customer_canonical_alias set status='inactive'` + rodar o rebuild.

### Follow-ups (NÃO bloqueiam — fase posterior, registrados pelo Codex)
- Histórico de afiação (clone Colacor SC) **não** unificado na view do gêmeo — scoring/WhatsApp leem
  assignments sem filtrar `eligible`, então atividade do clone alimenta o clone escondido. O gêmeo já tem
  ~99% do faturamento (vendas); unificar serviços+vendas = trabalho futuro se necessário.
- Limpeza física (apagar clones) **descartada** por design: são cadastros fiscais legítimos no Omie.
- `omie_customer_links` (account-aware, vários códigos→1 cliente) = arquitetura "correta" de médio prazo.

## Fases (revisadas pós-Codex)
