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
`derivarSinaisContato(registros, hoje, dataRotaFila, cfg?): SinaisContato`
- **entrada:** registros de **um cliente** — agrega TODOS os farmers que o contataram (os sinais de fila são por **CLIENTE**, não por quem ligou; o `farmer_id` no log é só auditoria — Codex #8). Cada registro `{ status, dataNegocio: 'YYYY-MM-DD', dataRota: 'YYYY-MM-DD' }`: `dataNegocio` = `created_at` convertido pra **America/Sao_Paulo** no hook (fuso de negócio, não `Date.now()` solto); `dataRota` = a coluna `data_rota` gravada. `hoje` = data de negócio (SP); `dataRotaFila` = `data_rota` da fila atual. `cfg` = `{ limiarSemResposta=3, janelaCadenciaDias=7 }`.
- **saída** (separa o que ALIMENTA O GATE do que é só BADGE — Codex #2):
  - `optOut: boolean`, `jaConvertidoNaRota: boolean`, **`contatadoHaDiasParaGate: number|null`** (o ÚNICO que vira `ContactCandidate.contatadoHaDias`).
  - badge/UI: `ultimoContatoRealHaDias: number|null`, `semRespostaRecenteN: number`, `ultimaSemRespostaHaDias: number|null`, `cadenciaBloqueadaPor: 'real'|'sem_resposta_esgotada'|null`.
- **regras (Codex):**
  - `optOut` = existe QUALQUER `opt_out` — **sticky, SEM janela** (full history; senão um opt-out de 100d cairia fora da janela e voltaria a ser ligável — Codex #4).
  - `jaConvertidoNaRota` = existe `convertido` com **`registro.dataRota === dataRotaFila`** (a coluna `data_rota` gravada, **NÃO** `dataNegocio`/`created_at` — a fila é D-1: liga hoje, rota amanhã → comparar `created_at` nunca casaria; Codex #3). Alimenta o `fechouHoje` do gate.
  - **cadência — separa "tentativa registrada" de "evento que bloqueia o gate" (Codex #1):**
    - `ultimoContatoRealHaDias` = `hoje − max(dataNegocio de {respondido,convertido})` (ou null).
    - `semRespostaRecenteN` = nº de **DIAS DISTINTOS** com `sem_resposta` na `janelaCadenciaDias` — conta DIAS, **não linhas** (3 "não atendeu" no mesmo turno = 1 dia; Codex #5).
    - `ultimaSemRespostaHaDias` = `hoje − max(dataNegocio de sem_resposta na janela)` (ou null).
    - **bloqueio:** contato real bloqueia (cadência normal) → `diasReal = ultimoContatoRealHaDias`. `sem_resposta` **só bloqueia** quando `semRespostaRecenteN >= limiarSemResposta` → `diasSemResp = ultimaSemRespostaHaDias`; **abaixo do limiar NÃO bloqueia** (cadência curta, deixa re-tentar — só vira badge).
    - `contatadoHaDiasParaGate` = **menor** entre `diasReal` e `diasSemResp` (só dos que bloqueiam); `null` se nenhum bloqueia → o gate não exclui por cadência.
    - `cadenciaBloqueadaPor` = qual dos dois deu o menor ('real'/'sem_resposta_esgotada'); null se nenhum.
- **exemplo (Codex):** `respondido` há 10d **+** `sem_resposta` ontem com N=1 (<3) → `contatadoHaDiasParaGate=10` (não bloqueia o retry curto da não-atendida), badge "sem resposta 1×". Se virar N=3 → passa a bloquear pela `ultimaSemRespostaHaDias`.
- **NÃO mexe no `gate()`/`buildContactList`** (inalterados) — só produz `contatadoHaDiasParaGate`→`contatadoHaDias`, `jaConvertidoNaRota`→`fechouHoje`, `optOut`→`optOut`. Toda a sutileza vive aqui, testada isolada.

### 4.4 Hook `useRouteContactList`
- 1 query nova: `route_contact_log` (cols `customer_user_id, status, created_at, data_rota`) dos `customer_user_id` da fila (chunked `.in()`), filtro **`status='opt_out' OR created_at >= hoje−90d`** — opt_out full-history + cadência na janela 90d (Codex #4); **não** todos os logs (limite defensivo).
- converte `created_at` → `dataNegocio` (America/Sao_Paulo) por registro.
- por cliente → `derivarSinaisContato` → injeta `optOut`/`fechouHoje(=jaConvertidoNaRota)`/`contatadoHaDias(=contatadoHaDiasParaGate)` reais nos candidatos (substitui os hardcoded). Mantém o resto idêntico.
- expõe os campos de badge (`ultimoContatoRealHaDias`/`semRespostaRecenteN`/`cadenciaBloqueadaPor`/`jaConvertidoNaRota`) p/ a UI.
- **mutations**: `useRegistrarContato` (RPC `registrar_contato_rota`) + `useDesfazerContato` (RPC `desfazer_contato_rota`) — invalidam `['route-contact-list']`.

### 4.5 UI `RotaListaLigacao`
- cada item ganha um **menu de outcome** (4 botões, touch-friendly). `opt_out` → `AlertDialog` de confirmação ("Não ligar novamente para {cliente}?").
- após registrar: **toast com "Desfazer"** (~5s) → `useDesfazerContato`.
- badges: "contatado há Xd" (de `ultimoContatoRealHaDias`), "sem resposta N×" (de `semRespostaRecenteN`). `convertido` → seção **"Resolvidos hoje"** (feedback de progresso, não some no ar). `sem_resposta` (<limiar) **permanece** na fila com badge — o gate não o bloqueia.
- **métrica do dia** (topo, simples, client-side): `N ligados · N atenderam · N fecharam`, ancorada em **`dataNegocio (created_at em SP) === hoje`** (turno do vendedor), **não** `data_rota` (Codex #7 — "ligados hoje" ≠ "resolvidos nesta rota"). O "medir conversão" do objetivo, sem tela analítica.
- evento PostHog `rota.contato_registrado` (`{status}`), `rota.contato_desfeito`.

## 5. Degradação honesta & riscos
- log indisponível/erro → os 3 campos voltam ao default seguro (`optOut:false, fechouHoje:false, contatadoHaDias:null`) → a fila funciona como hoje (não quebra; só perde a cadência ao vivo). **Falha de leitura ≠ esconder cliente.**
- dedupe na RPC evita duplo-registro; undo cobre erro de clique; opt-out exige confirmação.
- fuso: tudo via data de negócio SP (helper recebe `hoje`/`dataNegocio` já normalizados; teste de fronteira meia-noite).
- RLS: SELECT já é staff; a RPC é o único caminho de escrita (server-side ownership). Sem novo INSERT genérico.
- **opt-out é RISCO REAL, não detalhe (Codex #6):** um clique errado tira um cliente bom da operação até alguém rodar SQL → a confirmação + o **Undo curto bem testado** são obrigatórios na v1. Reversão histórica = SQL manual do master (documentada no PR); RPC de reverter = v2 se virar recorrente.
- **concorrência (Codex #8):** o dedupe da RPC é por `farmer+customer+data_rota+status` (idempotência do toque do vendedor), mas os SINAIS de fila são derivados por **CLIENTE** (agregam todos os farmers) → gestor e dono registrando no mesmo cliente não divergem a fila. `farmer_id` no log = auditoria de quem contatou.

## 6. Plano de teste (helper TDD)
`route-outcome.test.ts` cobre: opt-out **sticky sem janela** (opt_out 100d atrás ainda bloqueia); `jaConvertidoNaRota` por **`data_rota`** (convertido registrado hoje p/ rota de amanhã esconde na fila de amanhã; convertido de outra rota não esconde); contato real → `ultimoContatoRealHaDias`/`contatadoHaDiasParaGate`; **`sem_resposta` ISOLADO (N<3) NÃO bloqueia** (só badge), incl. ontem; **≥3 DIAS distintos** de `sem_resposta` bloqueia, mas **3 linhas no MESMO dia = N=1** (conta dias, não linhas); respondido-há-10d + sem_resposta-ontem → `contatadoHaDiasParaGate=10`; `cadenciaBloqueadaPor` correto; fronteira de meia-noite (fuso SP); lista vazia → defaults seguros.

## 7. Entregáveis & ordem
1. helper `route-outcome.ts` + testes (TDD).
2. migration `2026…_route_contact_log_escrita.sql` (RPC registrar/desfazer + grants) — **manual via SQL Editor** (founder cola); precedida de query de existência da tabela.
3. hook (leitura do log + mutations) + UI (menu outcome + badges + undo + métrica).
4. validação (typecheck/test/lint/build) + Codex adversarial + PR + registro no CLAUDE.md §5.

## 8. Métrica de sucesso
O vendedor para de ver o mesmo cliente repetido (cadência funciona); opt-out respeitado; o founder vê "fecharam N" por dia. Base pronta pra quando o WhatsApp/360dialog destravar (o `route_contact_log` já é a fonte de cadência cross-canal).
