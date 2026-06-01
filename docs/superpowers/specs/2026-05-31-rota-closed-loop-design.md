# Closed-loop da Lista de Ligação por Rota (PR2c) — Design

**Data:** 2026-05-31
**Frente:** Inteligência comercial / Motor de Rota — fechar o ciclo da lista de ligação.
**Status:** design (aguardando aprovação do founder antes do plano).

---

## 1. Problema

A **lista de ligação por rota** (`/rota/ligacoes`) já prioriza, na véspera (D-1), quais clientes o vendedor deve ligar — pelas **cidades da rota de amanhã × valor econômico esperado**. Está em produção (phone-free, PR2a/#505), mas é uma **fila estática**:

- não registra que o vendedor ligou nem o resultado;
- **re-mostra o mesmo cliente** dia após dia (não há cadência ao vivo);
- não respeita "não quero ser ligado";
- não mede conversão.

Os 4 sinais que o motor já consome (`src/lib/whatsapp/contact-list.ts → gate()`) estão **hardcoded** no hook (`useRouteContactList.ts:171-174`), com o comentário no próprio código apontando: `contatadoHaDias: null // cadência ao vivo via route_contact_log entra no PR2c`. **Este é o PR2c.**

## 2. Objetivo & não-objetivos

**Objetivo (v1):** registrar o resultado de cada ligação (manual, 1 toque) → derivar cadência/opt-out/convertido reais → alimentar o motor existente → esconder/marcar na fila → medir conversão simples. **Sem WhatsApp/360dialog** (bloqueado em homework do founder); é o lado manual, reaproveitando a ligação que o vendedor já faz.

**Não-objetivos (v2+, cortados por YAGNI — validado com Codex):**
- vincular o `pedido_id` real do PV fechado (v1 mede conversão pelo status `convertido`, sem amarrar o pedido exato);
- auto-captura do fim da ligação no Dialer desktop (o vendedor externo está no celular com `tel:` nativo — não há evento capturável; manual é o caminho universal);
- follow-up agendado / "ligar depois" datado (já existe `/admin/route-planner` + visitas agendadas — não duplicar);
- observação de texto livre; tela analítica elaborada; edição de histórico; estados granulares ("ocupado", "telefone errado").

## 3. Estado atual (fatos do código)

- **Motor** `buildContactList(candidates, cfg)` (`contact-list.ts`) — **pronto, testado, em prod. NÃO será alterado.** O `gate()` já consome `optOut`, `fechouHoje`, `contatadoHaDias` (`< cfg.cadenciaMinDias` → exclui por `'cadencia'`). `cfg.cadenciaMinDias` (default 3) vem de `route_disparo_config` (tunável por master).
- **Hook** `useRouteContactList` — monta os candidatos com os 4 campos hardcoded. É onde vamos injetar os valores reais.
- **Tabela** `route_contact_log` (migration `20260528160000`, PR2a em prod):
  `id, data_rota, customer_user_id, farmer_id, canal CHECK(whatsapp|ligacao), valor_da_ligacao, bucket, status, pedido_id, created_at`. Índices `(customer_user_id, created_at DESC)` e `(data_rota)`. **RLS: SELECT = staff (employee/master); NÃO há policy de INSERT pra `authenticated`** (comentário: "escrito por service_role"). ⚠️ A tabela **não está no `schema-snapshot.sql`** (snapshot stale, gerado antes do PR2a) — confirmar existência em prod via SQL Editor antes da migration nova.
- **Captura** `CallButton` — celular: `tel:` nativo; desktop: `<Dialer>` in-app. O outcome é **manual** (cobre os dois).

## 4. Arquitetura da solução

```
Fila D-1  →  vendedor liga (CallButton)  →  marca outcome (1 toque)
  →  RPC registrar_contato_rota (farmer_id server-side, dedupe 2min, canal='ligacao')
  →  hook invalida a query  →  lê route_contact_log dos candidatos
  →  helper PURO route-outcome deriva {contatadoHaDias, jaConvertidoNaRota, optOut, badges}
  →  buildContactList (inalterado) reordena/esconde  →  fila + badges + métrica do dia
```

### 4.1 Vocabulário de outcome → `status` (canônico, sem inventar)
| Botão (vendedor)        | `status`       | Efeito na fila                                  |
| ----------------------- | -------------- | ----------------------------------------------- |
| **Fechou pedido**       | `convertido`   | sai da fila (seção "Resolvidos hoje"); cadência normal |
| **Falou, vai pensar**   | `respondido`   | sai da fila principal; cadência normal           |
| **Não atendeu**         | `sem_resposta` | **permanece** com badge "sem resposta Nx"; cadência **curta** |
| **Não quer ser ligado** | `opt_out`      | confirmação → some; bloqueio permanente (sticky) |

`canal = 'ligacao'` (fixo) separa do WhatsApp.

### 4.2 Escrita — RPC `SECURITY DEFINER` (não policy INSERT direta)
**Decisão (Codex):** RPC é o ponto de controle certo porque o log virou mecanismo de **cadência + opt-out** — um INSERT genérico deixaria um cliente forjar `opt_out`/`convertido` de cliente fora da carteira e sujar a fila.

`registrar_contato_rota(p_customer_user_id uuid, p_status text, p_data_rota date, p_bucket text default null, p_valor numeric default null) returns jsonb`:
- gate **staff** (employee/master) — `RAISE` se não; `farmer_id := auth.uid()` server-side (cliente não escolhe vendedor); `canal := 'ligacao'`; valida `p_status ∈ {convertido,respondido,sem_resposta,opt_out}`.
- **Dedupe idempotente:** se já existe registro do mesmo `farmer_id + customer_user_id + data_rota + status` nos últimos **2 min**, retorna o existente com `{deduped:true}` em vez de inserir (cobre duplo-toque/retry de rede do celular).
- retorna `{id, deduped}`.

`desfazer_contato_rota(p_id uuid) returns void` — deleta SE for do próprio `farmer_id = auth.uid()` E `created_at > now() - interval '5 min'` (suporta o **Undo** curto do UI; janela curta + own-scope = seguro).

**Reversão de opt-out (v1):** operacional via SQL Editor (master deleta a linha `opt_out` — `DELETE FROM route_contact_log WHERE customer_user_id=… AND status='opt_out'`). Documentado no PR. UI de reversão = v2 se virar recorrente. (Sem isso, opt-out vira dado morto — Codex.)

### 4.3 Helper puro `src/lib/route/route-outcome.ts` (TDD)
`derivarSinaisContato(registros: ContatoLog[], hoje: string, dataRotaFila: string): SinaisContato`
- entrada: registros de **um** cliente `{status, dataNegocio: 'YYYY-MM-DD'}` (a `dataNegocio` = `created_at` convertido pra **America/Sao_Paulo** no hook — fuso de negócio, não `Date.now()` solto), `hoje` (data de negócio), `dataRotaFila` (a `data_rota` da fila atual).
- saída: `{ optOut, jaConvertidoNaRota, contatadoHaDias, semRespostaRecenteN }`.
- regras:
  - `optOut` = existe registro `opt_out` (sticky; sem reversão = permanece).
  - `jaConvertidoNaRota` = existe `convertido` com `dataNegocio === dataRotaFila` (ancorado na rota, **não** `current_date` — a fila é D-1; alimenta o `fechouHoje` do gate).
  - **`contatadoHaDias` efetivo** (cadência diferenciada):
    - contato **real** (`respondido`/`convertido`): `dias = hoje − maxData(real)`.
    - `sem_resposta`: só "conta" (bloqueia) se foi **ontem/hoje** (dias ≤ 1) **ou** acumulou **≥ N** (default 3) registros `sem_resposta` recentes (janela 7d) — senão **não** bloqueia (cadência curta, deixa re-tentar).
    - resultado = **menor** `contatadoHaDias` entre os que "contam" (ou `null` se nenhum conta → motor não exclui por cadência).
  - `semRespostaRecenteN` = contagem de `sem_resposta` na janela (badge).
- **NÃO mexe no `gate()`** — só produz os 3 campos que ele já lê. Toda a sutileza de status vive aqui, testada isolada.

### 4.4 Hook `useRouteContactList`
- 1 query nova: `route_contact_log` dos `customer_user_id` da fila (chunked `.in()`, janela **90d**, ordenado) — **não** todos os logs (limite defensivo do Codex).
- por cliente → `derivarSinaisContato` → injeta `optOut`/`fechouHoje`/`contatadoHaDias` reais nos candidatos (substitui os hardcoded). Mantém o resto idêntico.
- expõe `jaConvertidoNaRota`/`semRespostaRecenteN` p/ a UI (badges/seção resolvidos).
- **mutation** `useRegistrarContato` (chama a RPC) + `useDesfazerContato` (undo) — invalidam `['route-contact-list']`.

### 4.5 UI `RotaListaLigacao`
- cada item ganha um **menu de outcome** (4 botões, touch-friendly). `opt_out` → `AlertDialog` de confirmação ("Não ligar novamente para {cliente}?").
- após registrar: **toast com "Desfazer"** (~5s) → `useDesfazerContato`.
- badges: "contatado há Xd" (real), "sem resposta Nx". `convertido` → seção **"Resolvidos hoje"** (não some no ar — feedback de progresso). `sem_resposta` permanece na fila com badge.
- **métrica do dia** (topo, simples, client-side a partir do log de hoje): `N ligados · N atenderam · N fecharam`. (o "medir conversão" do objetivo, sem tela analítica.)
- evento PostHog `rota.contato_registrado` (`{status}`), `rota.contato_desfeito`.

## 5. Degradação honesta & riscos
- log indisponível/erro → os 3 campos voltam ao default seguro (`optOut:false, fechouHoje:false, contatadoHaDias:null`) → a fila funciona como hoje (não quebra; só perde a cadência ao vivo). **Falha de leitura ≠ esconder cliente.**
- dedupe na RPC evita duplo-registro; undo cobre erro de clique; opt-out exige confirmação.
- fuso: tudo via data de negócio SP (helper recebe `hoje`/`dataNegocio` já normalizados; teste de fronteira meia-noite).
- RLS: SELECT já é staff; a RPC é o único caminho de escrita (server-side ownership). Sem novo INSERT genérico.

## 6. Plano de teste (helper TDD)
`route-outcome.test.ts` cobre: opt-out sticky; convertido-na-rota (com/sem match de data); contato real → `contatadoHaDias`; `sem_resposta` ontem (conta) vs 5 dias atrás isolado (não conta) vs ≥3 recentes (conta); menor-dos-que-contam; fronteira de meia-noite (fuso); lista vazia → defaults seguros.

## 7. Entregáveis & ordem
1. helper `route-outcome.ts` + testes (TDD).
2. migration `2026…_route_contact_log_escrita.sql` (RPC registrar/desfazer + grants) — **manual via SQL Editor** (founder cola); precedida de query de existência da tabela.
3. hook (leitura do log + mutations) + UI (menu outcome + badges + undo + métrica).
4. validação (typecheck/test/lint/build) + Codex adversarial + PR + registro no CLAUDE.md §5.

## 8. Métrica de sucesso
O vendedor para de ver o mesmo cliente repetido (cadência funciona); opt-out respeitado; o founder vê "fecharam N" por dia. Base pronta pra quando o WhatsApp/360dialog destravar (o `route_contact_log` já é a fonte de cadência cross-canal).
