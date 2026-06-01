# Tarefas — Enforcement de Atividades (Fase 2) — Design

> Status: **desenho aprovado pelo founder** (2026-05-31). Próximo passo: plano de implementação (`writing-plans`) — **mas a implementação só começa depois da Fase 1 ser verificada visualmente em produção** (decisão eu+codex: não empilhar código novo sobre base não-clicada).
> Validado em 3 consults com o codex (decisão de sequência + menu de mecanismos de enforcement + passe adversário neste spec). Estende o motor da Fase 1 (`docs/superpowers/specs/2026-05-28-tarefas-cobranca-vendedoras-design.md`), não é módulo novo.

## 1. Contexto e problema

A Fase 1 entregou o motor de **atribuição + cobrança** de tarefas (founder atribui → lembra → auto-baixa quando há prova determinística → e-mail de cobrança). Pedido da Fase 2, intenção verbatim do founder: **"formas de obrigar as atividades de serem feitas, para todas as áreas"** (vendas, estoque, tinta, produção, compras). Exemplo-âncora: o operador de tinta tem que **regular a máquina todo dia** e **anexar foto da tela** como prova — não pode marcar feito sem isso ("travas / comprovações físicas").

A Fase 1 cobre tarefa pontual atribuída a vendedora. Faltam dois eixos: **recorrência** (atividades que se repetem e não podem "sumir" se ignoradas) e **trava de comprovação** (não conclui sem evidência) — somados a **escalação com janela de tempo** pra fechar o ciclo de enforcement.

## 2. Objetivo da Fase 2

Estender o motor de Tarefas com **enforcement de execução**, geral (todas as áreas), ancorado em **3 mecanismos**:
1. **Trava de comprovação** (carro-chefe): conclui só anexando prova (foto e/ou leitura validada contra faixa).
2. **Recorrência + visibilidade do que faltou**: a tarefa reaparece todo período até ser feita; o pulado fica visível.
3. **Escalação + janela de tempo**: prazo por janela (ex: "antes das 9h") + escalação reusando a Fase 1.

**Modelo de trava (decisão do founder): "anexou = feito + auditoria por exceção"** — a prova destrava a conclusão **na hora** (sem fila de aprovação travando o operador); o sistema marca **pendente de auditoria** e o gestor/founder revê **só** exceções (alto-risco / reincidente / amostra aleatória).

**Flagship = operador de tinta** (acesso já existe via `/tintometrico`). Motor geral; rollout por área conforme o acesso de cada uma for resolvido — igual à Fase 1 (engine + persona-flagship primeiro).

### Não-objetivos (deferidos — codex)
- **Bloqueio downstream duro** (ex: travar venda de tinta sem a calibração) — poderoso e perigoso; só selecionado, fica pra v2.
- **Aprovação obrigatória em toda prova** — cria fila/gargalo; rejeitado em favor de auditoria por exceção.
- **OCR como porteiro** — frágil; v1 usa foto + leitura digitada + faixa. OCR depois como "alerta de divergência", não gate.
- **Leaderboard / streak / pontuação** — não obrigam nada, soam infantis no chão de fábrica.
- **Dual-control (4-olhos)** — só pra dinheiro/segurança/crítico; fora da v1.
- **Supervisor-tier real (por área)** — depende de fundação de acesso por área (greenfield); v1 tem só o **gancho** (coluna), null → founder.

## 3. Decisões de produto (com rationale)

### 3.1 Escopo & arquitetura
Enforcement geral pra todas as áreas, **estendendo o motor de Tarefas** (mesma `tarefas` + mesma escalação), NÃO um módulo separado. Flagship tinta primeiro. (codex: "extend the existing engine, not a separate module".)

### 3.2 Trava de comprovação — "anexou = feito + auditoria por exceção"
- Por template: `requer_comprovacao` + `tipo_comprovacao` ∈ (`nenhuma`/`foto`/`leitura`/`foto_e_leitura`).
- **Foto** → Supabase Storage (bucket dedicado) → `comprovacao_url`.
- **Leitura** → valor numérico digitado, **validado contra faixa** do template (`leitura_min`/`leitura_max` + `leitura_unidade`) — **server-side** (não dá pra fabricar valor fora da faixa).
- Concluir uma tarefa com `requer_comprovacao` **exige** a prova; sem ela, a conclusão é bloqueada (a trava). Com ela → `status='concluida'`, `conclusao_origem='comprovacao'`, `comprovacao_em=now()`.
- **A conclusão NÃO espera aprovação** — destrava na hora. O `auditoria_status` é setado pra `pendente` ou `ok` conforme 3.4.

### 3.3 Tipos de prova na v1
- **Tinta (flagship):** `foto_e_leitura` — foto da tela + leitura da calibração validada contra a faixa.
- Outras áreas: `foto` (estado físico) ou `leitura` conforme o template. `nenhuma` = tarefa recorrente sem trava (só recorrência+escalação).

### 3.4 Auditoria por exceção (o que faz "obrigar" funcionar sem gargalo)
Ao concluir uma tarefa com prova, `auditoria_status`:
- **`pendente`** (entra na fila de auditoria do gestor/founder) se QUALQUER: template **alto-risco** (`alto_risco=true`), operador **reincidente** (≥ N instâncias recentes do mesmo template **vencidas/atrasadas** numa janela — N default **3** em 30 dias), ou **amostra aleatória** (default **10%**).
- **`ok`** caso contrário (não precisa revisão).
- Computado **server-side** no momento da conclusão (RPC `concluir_com_comprovacao`, 3.b do motor) — determinístico + a amostra usa um sorteio estável.
- O gestor/founder audita: marca `ok` ou `reprovada` (+ motivo). **Reprovada reabre a tarefa** (`status='aberta'`, prova invalidada) e registra evento — é a consequência que combate compliance falsa.

### 3.5 Recorrência
- `tarefa_templates` define a atividade recorrente: `cadencia` ∈ (`diaria`/`dias_uteis`/`semanal`/`dias_especificos` + `dias_semana int[]`), `janela_inicio`/`janela_fim` (time, opcional), `ativo`.
- Cron **`tarefas_materializar_recorrentes()`** (madrugada, ~06h BRT): pra cada template ativo cuja cadência **dispara hoje** e que **ainda não tem instância hoje**, cria uma `tarefas` (instância). Idempotente via **UNIQUE(`template_id`, `due_date`)**.
- A instância é uma `tarefas` normal: `modo='data'`, `due_date=hoje (BRT)`, `janela_fim`, `requer_comprovacao`/`tipo_comprovacao`/faixa copiados do template, `auto_satisfy_mode='off'` (conclusão é por prova, não auto-detecção).

### 3.6 Escalação + janela de tempo
- **Reusa a escalação da Fase 1** (`tarefas_escalonamento_tick` → `fornecedor_alerta` → e-mail). Instância recorrente vencida + tolerância escala de graça (já é `tarefas`).
- **Janela de tempo**: `janela_fim` (ex: 09:00) — a instância está "atrasada" se passou do `janela_fim` de hoje (BRT) sem concluir. (Refinamento sobre o `effective_due` da view, que hoje é por dia; ver 4.4.)
- **Gancho de supervisor**: `tarefa_templates.supervisor_user_id` (nullable). v1: null → escala pro founder (como Fase 1). Quando existir acesso por área, a escalação roteia pro supervisor antes do founder.

### 3.7 Persona / acesso (dependência)
"Todas as áreas" precisa que os operadores tenham acesso ao app. Hoje: vendedoras (commercial_roles) e **operador de tinta via `/tintometrico`** acessam claramente; outras personas (estoque/produção) = "departamento" greenfield (CLAUDE.md §5). **v1 = flagship tinta** (operador vê suas tarefas recorrentes num card dentro do `/tintometrico`); engine geral; rollout por área conforme o acesso for resolvido.

> ⚠️ **Risco-mestre (codex): resolução de POSSE, não recorrência.** O difícil de "todas as áreas" não é repetir tarefa — é *quem* recebe a tarefa hoje, quem cobre ausência, quem audita, quem é escalado, e o que acontece quando a atribuição da área muda. A v1 **assume single-assignee** (`tarefa_templates.assigned_to` = um operador) + os ganchos (`supervisor_user_id`, cobertura via `responsavel_efetivo`) — o que é honesto pro flagship tinta (1 operador). **Roteamento real por área/papel** (template → "quem for o operador de tinta hoje", rodízio de turno, supervisor-por-área) é trabalho de produto futuro, dependente da fundação de "departamento". Se isso ficar implícito, o módulo "funciona" mas gera tarefa errada pra pessoa errada quando escalar pra outras áreas. Registrado como a fronteira consciente da v1.

## 4. Modelo de dados

### 4.1 `tarefa_templates` (definição recorrente — NOVA)
| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | (a `tarefas.template_id` já referencia isto — hook da Fase 1) |
| `descricao` | text NOT NULL | |
| `categoria` | text NOT NULL | reusa o CHECK de `tarefas.categoria` (+ `outro`) |
| `area` | text NOT NULL | vendas/estoque/tinta/producao/compras/outro (categorização + futuro roteamento) |
| `empresa` | text NOT NULL | |
| `assigned_to` | uuid NOT NULL | operador responsável (v1: usuário específico) |
| `cadencia` | text NOT NULL CHECK ∈ (diaria, dias_uteis, semanal, dias_especificos) | |
| `dias_semana` | int[] | usado sse cadencia=dias_especificos/semanal (0=dom..6=sáb) |
| `janela_inicio` | time | opcional |
| `janela_fim` | time | opcional — fim da janela do dia (prazo intradiário) |
| `tolerancia_dias` | int NOT NULL default 0 | recorrente costuma ser tolerância 0 (vence no dia) |
| `requer_comprovacao` | boolean NOT NULL default false | |
| `tipo_comprovacao` | text NOT NULL default 'nenhuma' CHECK ∈ (nenhuma, foto, leitura, foto_e_leitura) | |
| `leitura_min` / `leitura_max` | numeric | faixa válida (sse tipo inclui leitura) |
| `leitura_unidade` | text | ex: "g/L", "°C" |
| `alto_risco` | boolean NOT NULL default false | sempre audita |
| `amostra_auditoria_pct` | int NOT NULL default 10 | % de amostra aleatória |
| `reincidente_limite` | int NOT NULL default 3 | faltas recentes p/ marcar reincidente |
| `supervisor_user_id` | uuid | gancho de escalação (null → founder) |
| `ativo` | boolean NOT NULL default true | |
| `created_by` / `created_at` / `updated_at` | | |

### 4.2 `tarefas` — colunas novas de prova/auditoria (na instância)
Já existem (hooks Fase 1): `template_id`, `requer_comprovacao`, `comprovacao_url`. Adicionar:
| coluna | tipo | nota |
|---|---|---|
| `tipo_comprovacao` | text | denormalizado do template na materialização |
| `comprovacao_leitura` | numeric | valor digitado |
| `comprovacao_em` | timestamptz | |
| `janela_fim` | time | denormalizado (prazo intradiário) |
| `auditoria_status` | text CHECK ∈ (nao_requer, dispensada, pendente, aprovada, reprovada) default 'nao_requer' | `nao_requer`=sem prova; `dispensada`=prova exigida mas não sorteada (auto-ok); `pendente`/`aprovada`/`reprovada`=fila de auditoria (codex P3 #15) |
| `auditoria_motivo` | text | |
| `auditada_por` | uuid | |
| `auditada_em` | timestamptz | |
| `supervisor_user_id` | uuid | **copiado do template na materialização** (codex P3 #16 — se o template mudar depois, a posse histórica não fica ambígua) |
| `conclusao_origem` | (estende o CHECK da Fase 1 c/ `'comprovacao'`) | |

UNIQUE parcial **(`template_id`, `assigned_to`, `due_date`) WHERE template_id IS NOT NULL** — idempotência da materialização. ⚠️ Inclui `assigned_to` (codex P1 #2): `(template_id, due_date)` sozinho sub-materializaria se um template tiver vários operadores.

### 4.3 Storage
Bucket dedicado (ex: `tarefa-comprovacoes`), **privado**. Convenção de path inclui o id do usuário+tarefa (ex: `{auth.uid}/{tarefa_id}/{arquivo}`) e a policy do bucket valida que o path bate com o caller (codex P2 #12 — senão `comprovacao_url` poderia apontar pro arquivo de outro). RLS: operador escreve só no próprio prefixo; gestor/founder lê pra auditar. A RPC `concluir_com_comprovacao` valida que a `comprovacao_url` aponta pro path da tarefa/usuário (não aceita URL arbitrária). (Detalhe de policies no plano.)

### 4.4 View `v_tarefas_estado` — refinar `atrasada` com janela intradiária
Hoje `atrasada` = `now()::date(BRT) > effective_due`. Estender: se a instância tem `janela_fim`, fica atrasada quando `now()(BRT) > (due_date + janela_fim)` — i.e., passou da hora-limite do dia. Sem `janela_fim`, mantém o comportamento por dia. Adicionar derivados: `requer_auditoria` (auditoria_status='pendente').

## 5. Motor (SQL puro + pg_cron + 1 RPC; sem edge function nova)

### 5.1 Materialização (`tarefas_materializar_recorrentes()`, cron diário ~06h BRT)
Pra cada `tarefa_templates` ativo, gera as instâncias faltantes de cada **dia de disparo** entre `max(last_materialized, hoje - 7d)` e **hoje (BRT)** (⚠️ **backfill** — codex P1 #5: se o cron pular um dia, sem instância não há linha atrasada → o enforcement quebra; janela máx 7d evita explosão). INSERT `tarefas` (instância) copiando descricao/categoria/empresa/assigned_to/requer_comprovacao/tipo_comprovacao/leitura_min/max/janela_fim/tolerancia_dias/**supervisor_user_id** + `template_id`, `modo='data'`, `due_date=<dia>`, `auto_satisfy_mode='off'`, `auditoria_status = case when requer_comprovacao then 'dispensada' else 'nao_requer' end`. `on conflict (template_id, assigned_to, due_date) do nothing` (idempotente). Cadência (em BRT): `diaria`=todo dia; `dias_uteis`=seg-sex **excluindo feriados via `calendario_feriados`** (codex P2 #7 — a tabela + `dias_uteis_entre()` já existem no repo); `semanal`/`dias_especificos`=`extract(dow) = any(dias_semana)`.
- ⚠️ **Assignee inativo/sem acesso (codex P1 #6):** materializa só se `assigned_to` está ativo (perfil/role válido); senão **pula + registra um evento de exceção** (não cria tarefa impossível que vira só ruído de escalação). Cobertura (`carteira_coverage`) aplica via `responsavel_efetivo` da view pra exibição/escalação, como na Fase 1.

### 5.2 Conclusão com prova (RPC `concluir_com_comprovacao(p_tarefa_id, p_url, p_leitura)`, SECURITY DEFINER)
Ponto de **enforcement** (server-side):
1. Carrega a tarefa + valida que o caller é o responsável (ou cobertura/gestor).
2. **Bloqueia re-conclusão (codex P1 #4):** se `status<>'aberta'` → `RAISE` (não dá pra re-chamar numa tarefa já concluída — senão a operadora re-sorteia a amostra até não cair na auditoria).
3. Se `requer_comprovacao`: exige `comprovacao_url` (se tipo inclui foto) e/ou `comprovacao_leitura` na **faixa** `[leitura_min, leitura_max]` (se tipo inclui leitura) — senão `RAISE` (a trava).
4. Computa `auditoria_status` **uma única vez** e persiste atômico: `pendente` se `alto_risco` OR **reincidente** OR amostra (`random()*100 < amostra_auditoria_pct`); senão `dispensada`. (Definição **fixa** de reincidente — codex P1 #4/P2 #10: `≥ reincidente_limite` instâncias **deste template + assignee** com `status='aberta' AND atrasada` ou `reprovada` numa janela de 30d; depende do backfill 5.1 manter as faltas como linhas persistidas.)
5. UPDATE `tarefas` (status=concluida, conclusao_origem='comprovacao', comprovacao_url/leitura, comprovacao_em, auditoria_status) + evento `concluida_comprovacao`.
> **Leitura na faixa ≠ leitura real (codex P2 #8):** validar `[min,max]` só prova plausibilidade, não que a medição foi feita. Por isso template **alto-risco exige `foto_e_leitura`** (a foto é o cross-check); leitura sozinha é auto-atestado consciente.

### 5.3 Auditoria (RPC `auditar_tarefa(p_tarefa_id, p_aprovar, p_motivo)`, gestor/founder)
`aprovar` → `auditoria_status='aprovada'`, registra auditada_por/em. `reprovar` → `auditoria_status='reprovada'` + **reabre** (`status='aberta'`, limpa comprovacao_em — a prova fica registrada no evento p/ histórico) + **`escalado_em = null`** (⚠️ codex P1 #3: sem zerar, a tarefa reaberta nunca re-escala porque a Fase 1 é fire-once) + evento `auditoria_reprovada`. (A reprovação reabrir = a **consequência real** contra compliance falsa.)

### 5.4 Escalação — reusa a Fase 1
`tarefas_escalonamento_tick` já escala `tarefas` vencidas+tolerância. Instâncias recorrentes entram de graça. Ajuste mínimo: a view considerar `janela_fim` no `atrasada`/`escalavel` (4.4). Supervisor: quando `template.supervisor_user_id` existir, rotear (v1 null→founder).

### 5.5 Anti-bypass — a trava forçada NO BANCO (codex P1 #1, crítico)
A RPC de prova **não basta**: a RLS da Fase 1 permite a `assigned_to` dar `UPDATE` na própria `tarefas` → a operadora poderia `update tarefas set status='concluida'` **direto via PostgREST**, pulando a prova. Enforcement em duas camadas:
1. **Trigger `BEFORE UPDATE` em `tarefas`** (`SECURITY INVOKER`, roda como o caller): se a transição é `status → 'concluida'` numa tarefa com `requer_comprovacao=true`, **só permite quando `current_user` é o owner da função definer** (no Supabase, `postgres`) **ou `service_role`** — i.e., a conclusão veio de dentro de `concluir_com_comprovacao` (SECURITY DEFINER, roda como `postgres`). UPDATE direto de um usuário `authenticated` → `RAISE` (bloqueado). NÃO usar GUC tipo `app.via_rpc` (cliente pode spoofar — codex); o gate é por `current_user`.
2. **Travar as colunas sensíveis** de mutação por usuário comum: `comprovacao_url`, `comprovacao_leitura`, `comprovacao_em`, `auditoria_status`, `auditada_por/em`, `requer_comprovacao` — o mesmo trigger rejeita mudança nelas fora do owner/`service_role` (senão a operadora forja os campos de prova e depois conclui). Conclusão **sem** prova (tarefa sem `requer_comprovacao`) segue livre pela RLS normal.
> Isso fecha o buraco: a única porta pra concluir uma tarefa com-prova é a RPC, que valida a evidência. `service_role` (crons/auditoria) e o owner passam; `authenticated` direto não.

## 6. Surfacing

### 6.1 Operador (flagship: card no `/tintometrico`)
"Minhas tarefas de hoje" (padrão do `MinhasTarefasCard` da Fase 1): instâncias recorrentes do dia, atrasada em vermelho. Concluir abre o **fluxo de prova**: foto (PhotoUpload → Storage) e/ou leitura (input numérico com a faixa visível) → chama `concluir_com_comprovacao`. Sem a prova, o botão Concluir fica desabilitado/explica a trava.

### 6.2 Founder / gestor
- **"Provas pra auditar"**: lista de `auditoria_status='pendente'`, com a foto/leitura + Aprovar/Reprovar (→ `auditar_tarefa`). **Visibilidade de backlog (codex P2 #9):** mostrar contagem de pendentes + idade da mais antiga, pra "auditoria por exceção" não virar "auditoria nunca". (Escalar auto a pendente >N dias = v2.)
- **Templates**: CRUD de `tarefa_templates` (criar atividade recorrente: área, cadência, janela, tipo de prova, faixa, alto-risco). Gated master/gestor.
- Escalações de recorrentes chegam pelo mesmo e-mail da Fase 1.

## 7. RLS
- `tarefa_templates`: SELECT = gestor/master OR `assigned_to=auth.uid()` (operador vê os templates dele); IUD = gestor/master (`pode_ver_carteira_completa` ou equivalente de gestão — confirmar helper p/ áreas não-comerciais).
- `tarefas` instâncias: já cobertas pela RLS da Fase 1 (assigned_to / cobertura / gestor).
- Storage bucket: operador escreve a prova da própria tarefa; gestor/founder lê.
- RPCs SECURITY DEFINER fazem o gate de quem pode concluir/auditar.

## 8. Composição com a Fase 1
- Mesma `tarefas` + mesma view + mesma escalação + mesmo e-mail. Fase 2 = `tarefa_templates` + materialização + RPCs de prova/auditoria + colunas de prova/auditoria na instância + janela intradiária na view.
- Mantém o princípio: conclusão por **ação explícita** (aqui, prova) — nunca auto-close silencioso. Auto-detecção (matcher) **não** se aplica a recorrentes (auto_satisfy_mode='off').

## 9. Edge cases
- **Operador não fez até o fim do dia**: instância fica atrasada (janela_fim) → escala. No dia seguinte, NOVA instância é materializada (a de ontem continua aberta+atrasada, visível — "o pulado não some").
- **Reprovada na auditoria**: reabre; se já passou a janela, volta atrasada → re-cobra (mas `escalado_em` fire-once já disparou — decisão: reabrir limpa `escalado_em`? Sim, pra re-escalar se continuar parada. Detalhe no plano.)
- **Template desativado**: para de materializar; instâncias abertas seguem o ciclo.
- **Leitura fora da faixa**: RPC `RAISE` → não conclui (a trava).
- **Foto faltando** (tipo inclui foto): RPC `RAISE`.
- **Fuso**: materialização + janela + atrasada tudo em `America/Sao_Paulo` (igual Fase 1).
- **Idempotência**: UNIQUE(template_id, due_date) → cron pode rerodar.

## 10. O que NÃO entra (anti-scope-creep)
Ver §2 Não-objetivos. Resumo: bloqueio downstream, aprovação-em-tudo, OCR-gate, leaderboard/streak, dual-control, supervisor-tier real — todos deferidos. Fase 2 fica em: **recorrência + trava de prova (foto/leitura+faixa) + auditoria por exceção + escalação com janela**, flagship tinta.

## 11. Trabalho de migração (constraint do Lovable)
Blocos SQL via SQL Editor (manual), no padrão da Fase 1:
- **BLOCO A**: `tarefa_templates` + CHECKs + índices.
- **BLOCO B**: colunas novas em `tarefas` (prova/auditoria/janela) + estende CHECK `conclusao_origem` c/ `'comprovacao'` + UNIQUE parcial (template_id, due_date).
- **BLOCO C**: refina a view `v_tarefas_estado` (janela intradiária + `requer_auditoria`) + RLS de `tarefa_templates`.
- **BLOCO D**: RPCs `concluir_com_comprovacao` / `auditar_tarefa` + função/cron `tarefas_materializar_recorrentes` + `cron.schedule` + **trigger anti-bypass `BEFORE UPDATE` em `tarefas`** (§5.5).
- **BLOCO E (infra)**: bucket de Storage `tarefa-comprovacoes` + policies (provavelmente via chat do Lovable / SQL de storage).
Cada bloco com query de validação. PR com **"ATENÇÃO: migration manual necessária"**.

## 12. Registro de revisão com o codex
- **Consult (sequência):** começar pelo **design** da Fase 2 (trabalho reversível) enquanto a Fase 1 aguarda verificação visual; **não implementar código** até a Fase 1 ser clicada (não empilhar sobre base não-verificada). Deferir o fast-follow "editar tarefa" (YAGNI).
- **Consult (menu de enforcement):** ancorar em 3 mecanismos (trava de prova / recorrência / escalação+janela); **bloqueio downstream** seletivo (deferido v1); **foto = "anexou=feito + auditoria por exceção"** (não aprovação-em-tudo, que vira gargalo); **OCR** deferido (foto+leitura+faixa na v1); **gimmicks** (leaderboard/streak/dual-control) fora; risco-mestre = **compliance falsa** → combater com consequência real (reprovar reabre), visibilidade do pulado, auditoria de exceção, e enforcement só no que importa. Estender o motor da Fase 1, não criar módulo.
- **Consult (passe adversário no spec):** **P1 incorporados** — (1) **anti-bypass por trigger no banco** (RLS deixava `assigned_to` concluir direto via PostgREST, furando a trava → trigger gate por `current_user`=owner/`service_role` + travar colunas de prova; §5.5); (2) UNIQUE `(template_id, assigned_to, due_date)`; (3) reabrir zera `escalado_em`; (4) amostra decidida 1× + bloqueia re-concluir; (5) materializador **com backfill** (janela 7d) — sem instância não há linha atrasada; (6) assignee inativo → pula+loga, não cria tarefa impossível. **P2/P3 incorporados:** `dias_uteis` via `calendario_feriados` existente; leitura=auto-atestado (alto-risco exige foto+leitura); visibilidade de backlog da auditoria; path do Storage validado por dono; status de auditoria renomeados (nao_requer/dispensada/pendente/aprovada/reprovada); supervisor copiado na instância; janela overnight = constraint. **Risco-mestre registrado:** resolução de POSSE pra "todas as áreas" é o difícil; v1 = single-assignee + ganchos, roteamento por área/papel é futuro (§3.7).
