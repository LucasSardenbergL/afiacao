# PR 6 — Fila `/credito/fila` + recomendação IA + alerta > 2 h + enforcement DORMENTE (crédito-IA, plano detalhado 2026-11-25)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` (§9/§10 prevalecem; §9.10 é o critério de ligar) · roteiro `docs/superpowers/plans/2026-11-20-credito-ia.md` (linha do PR 6). Arquivo separado: o PR 4 acrescenta ao fim do plano compartilhado.

## Fatos de prod (psql-ro, 2026-11-25)

- `credito_limite` = 0, `credito_limite_proposta` = 0, `credito_decisao_pedido` = 0, `credito_solicitacao` = 0 → nada aprovado, nenhuma sombra ainda (o PR 5 não mergeou).
- `push_subscriptions` = **0 linhas no app inteiro** (o Lucas incluso). A infra existe (`public._push_enviar` → edge `enviar-push`, VAPID, pg_net 10 s), mas o alerta só chega quando o Lucas ativar o push num device. Por isso: contador in-app no menu também, e "Lucas tem ≥ 1 assinatura" é condição de prontidão.
- Do plano do PR 5: o app quase não cria pedido (2 em 120 d); 176 pedidos/14 d nascem no Omie. O enforcement em `criar_pedido`/`alterar_pedido` cobre **só pedidos do app** — o importado do Omie já está no Omie quando o vemos. Isto vai no PR para o Lucas (o enforcement morde pouco volume hoje; a sombra mede todo o volume).

## Fatias

- **6a (este PR, agora):** só objetos NOVOS — sem edge quente, sem tocar `private.credito_avaliar_reservar`/`venda_gate_credito_grupo`. Migration + prova PG17 + edge nova `credito-fila-recomendar` + tela.
- **6b (após o merge do PR 5):** `omie-vendas-sync` chama `credito_gate_v2_efetivo` atrás do flag. Só a edge muda; a RPC já existe (6a).

## Desenho 6a

### 1. Flag de enforcement (1 escritor, auditado, por empresa)
- `credito_enforcement (company PK ∈ oben|colacor|colacor_sc, ligado bool NOT NULL DEFAULT false, versao int, alterado_por uuid, alterado_em timestamptz, motivo text)`. Semeada com as 3 empresas **desligadas**. Guarda/portão do PR 2 (mutáveis: `ligado,versao,alterado_por,alterado_em,motivo`; DELETE/TRUNCATE recusados). RLS: SELECT gestor.
- `credito_enforcement_log` append-only: empresa, antes, depois, motivo, por, em, `prontidao` (snapshot jsonb).
- **Único escritor:** `credito_definir_enforcement(p_company, p_ligar, p_motivo)` — authenticated, exige `credito_sou_aprovador()` (cap + allowlist = o Lucas), motivo ≥ 3, advisory lock por empresa. **Ligar** exige `credito_enforcement_prontidao(company).pronto = true`; **desligar** sempre permitido (kill switch). SQL Editor (postgres, `auth.uid()` NULL) não liga.
- **Leitor da edge:** `credito_enforcement_ligado(p_company) RETURNS boolean` service_role. Linha ausente/empresa inválida → `false` (desligado = caminho do PR 1, que mantém o piso fail-closed).

### 2. Prontidão (§9.10 como query, não recado)
`credito_enforcement_prontidao(p_company) RETURNS jsonb` (gestor lê; o escritor reusa): `{pronto, condicoes:[{chave, ok, valor, criterio}]}`. `pronto` = todas ok. Condições:
1. `primeira_leva` — ≥ 1 `credito_limite` vigente e 0 propostas `pendente`.
2. `sombra_14d` — 1ª decisão `modo='sombra'` da empresa há ≥ 14 d **e** sombra em ≥ 10 dias SP distintos dos últimos 14 (denominador, não "no ar").
3. `sombra_sem_erro` — 0 decisões de sombra com erro nos últimos 3 d (lê `credito_sombra_avaliacao.erro` do PR 5 se existir via `to_regclass`; ausente → **não ok**, ausente ≠ ok).
4. `aprovador_alcancavel` — o aprovador tem ≥ 1 `push_subscriptions`.
5. `prereq_codigo` — lista FIXA de pré-requisitos de código ainda não entregues (herdados do PR 3/5): (a) lock no escritor de `omie_customer_account_map`; (d) retomada vincula PV à revisão; (e) despacho serializado por revisão; (f) tint/ATP antes da reserva + troca de parcela; e 6b (edge). `ok` só com lista vazia — quem entregar cada um faz `CREATE OR REPLACE` desta função removendo o item (no diff, revisável).
6. `catalogo_prazo` (só colacor) — ≥ 1 parcela resolvida por catálogo/override na conta; senão todo prazo é NULL → 🟡 em 100% (liga, mas tranca a venda inteira na fila).

### 3. RPC efetiva (dormente)
`credito_gate_v2_efetivo(p_sales_order_id, p_company, p_revisao) RETURNS jsonb` service_role:
- lê o flag **na mesma transação** (`FOR SHARE` na linha) → desligado: `{ligado:false}` e **não escreve nada** (nenhuma decisão/reserva/solicitação).
- ligado: lê a revisão imutável do PR 3 (`credito_operacao_revisao`: valor, prazo, código do cliente, conta), confere que é a revisão vigente do pedido, chama `private.credito_avaliar_reservar(..., 'efetivo', solicitante)`; devolve o retorno do núcleo + `ligado:true`.
- revisão inexistente/não vigente → RAISE (a edge 6b trata como gate indisponível → mantém o caminho do PR 1).

### 4. Fila
- View `credito_fila_v` (`security_invoker=on`): **efetivo** = `credito_solicitacao` aberta (+ decididas das últimas 48 h para histórico); **sombra** = última decisão `modo='sombra'`, `faixa='amarelo'`, motivo resolvível (exclui pendência cadastral), dos últimos 14 d, por pedido×empresa, pedido não cancelado. Colunas: origem, item_id, decisão, pedido, empresa, revisão, valor, prazo, motivo, limite/exposição/prazo máx, idade, recomendação (status/sugestão/prazo/confiança/códigos), cliente (exibição), status.
- Ações (só efetivo, só aprovador): **autorizar** e **recusar** via `credito_autorizar_solicitacao` do PR 2 (motivo obrigatório; discordância da IA exige motivo). **"Aprovar com outro prazo" fica fora** — exige nova revisão + contrato de troca de parcela (pré-requisito (f)); declarado.
- Retomada: com o enforcement desligado não há o que retomar. Ligado, a autorização vale para a **mesma revisão** e o reenvio do pedido (mesmo `criar_pedido`) encontra `autorizado` no núcleo → 🟢. Reenvio automático pós-aprovação = pré-requisito (d)/(e).

### 5. Recomendação assíncrona (IA)
- `credito_fila_recomendacao` (decisao_id PK, status `ok|erro`, recomendacao `aprovar|recusar|sem_recomendacao`, prazo_sugerido_dias, confianca, codigos text[] de um enum fechado, modelo, versao_prompt, entrada jsonb **só números/enums/flags**, erro, tentativas, created_at). 1 escritor: `credito_registrar_recomendacao(...)` service_role; linha `ok` é final; `erro` pode ser regravada (tentativas ≤ 3).
- Edge nova `credito-fila-recomendar` (Anthropic direto, `MODELO_PADRAO`, prompt caching, tool-use não forçado, `authorizeCronOrStaff`): pega até N itens sem recomendação ok (efetivo antes de sombra), monta a entrada com números da decisão + limite vigente + ficha numérica da proposta de origem, nunca nome/observação; saída validada (enum, faixa de prazo nos degraus da spec); sem tool-call/inválida → `sem_recomendacao`. Cron 10 min com `timeout_milliseconds` explícito.

### 6. Alerta > 2 h
- `credito_fila_alerta` (solicitacao_id PK, enviado_em, destinatarios uuid[]) — dedupe: 1 push por solicitação.
- `private.credito_fila_alertar()` (pg_cron 15 min): solicitações **abertas** (só efetivo — sombra não alerta) com `created_at < now() − 2 h` sem alerta → grava o alerta e chama `public._push_enviar(aprovadores, …, '/credito/fila', 'credito-fila')`. Best-effort: erro do push não desfaz o registro? **Não** — o registro e o enqueue do pg_net vão na mesma transação; falha do pg_net (síncrona) → sub-bloco, sem alerta gravado, nova tentativa no próximo tick.
- Menu: contador de solicitações abertas (efetivo) para o aprovador.

### 7. Tela `/credito/fila` (gestor/master lê; aprovador age)
Abas Efetivo / Sombra; banner "Enforcement desligado — itens da sombra são simulação, nenhuma venda foi segurada"; bloco de prontidão por empresa (condições com ✓/✗) e botão ligar/desligar só para o aprovador (diálogo com motivo; o servidor recusa ligar sem prontidão).

## Prova (`db/test-credito-fila.sh`, PG17, `C` e `pt_BR.UTF-8`)
E1 flag desligado → `credito_gate_v2_efetivo` devolve `ligado:false` e as 4 tabelas de trilha ficam intocadas (contagem antes = depois). E2 ligado → piso vencido 🔴 sem solicitação; estouro 🟡 + solicitação aberta + item na fila; dentro do limite 🟢 + reserva `efetivo`. E3 ligar sem prontidão → recusa (P0001); desligar sempre; não-aprovador → 42501; SQL sem `auth.uid()` → 42501; log grava antes/depois. E4 escrita direta no flag (UPDATE/INSERT/DELETE) → 42501. E5 alerta: solicitação de 2h01 → 1 alerta + 1 `net.http_post` (stub); 2º tick → 0; 1h59 → 0; sombra → 0. E6 recomendação: `ok` imutável; `erro` regravável até 3; entrada com chave de texto livre recusada. E7 fila: sombra pendência cadastral fora; cancelado fora; última decisão por pedido. Falsificação com controle verde na mesma invocação: F1 gate ignora o flag; F2 linha ausente = ligado; F3 ligar sem checar prontidão; F4 alerta sem dedupe; F5 alerta inclui sombra.

## Revisão pós-Codex (desenho, 2026-11-25 — gpt-6.2-astra high; parecer completo nas notas da sessão)

Veredito: **bloquearia como desenhado**. Todos os P0/P1 acatados no 6a; o que é do 6b ou de ativação virou pré-requisito na prontidão:

| Achado | Como ficou |
|---|---|
| P0 revisão superada tratada como "indisponível" → despacho de r1 | `credito_gate_v2_efetivo` devolve `resultado` explícito (`desligado`·`avaliado`·`revisao_inexistente`·`revisao_superada`·`conta_divergente`), toma o MESMO advisory lock do registrador de revisão e lê a conta do PEDIDO. Leitor separado do flag na edge removido: a RPC decide. |
| P1 kill switch dependente da prontidão | desligar nunca chama a prontidão fora de sub-bloco; cancela as solicitações abertas da empresa e loga a contagem. |
| P1 lista de pré-requisitos incompleta | + (c) carga/transferência no efetivo, (g) exposição do grupo com empresas desligadas e PVs do Omie, (h) ensaio real de push/retomada, (i) recusa encerra a revisão no núcleo, (j) backtest + prova 2 sessões. Sombra exige lote < 1 h E 0 erros (cron parado ≠ ok). Prazo: 0 revisões de 30 d sem prazo. |
| P1 alerta mentia (`_push_enviar` volta em silêncio) | estado `sem_canal` (sem segredo/assinatura/aprovador, retentado a cada tick) ≠ `enfileirado`; reconfere SOB LOCK (`FOR UPDATE SKIP LOCKED`), só efetivo ATUAL e com flag ligado; tag por solicitação. `enfileirado` = enqueue, não entrega → ensaio real é pré-requisito (h). |
| P1 IA: injection validada tarde; 2 workers pagam 2 chamadas | entrada projetada campo a campo da DECISÃO (sem o jsonb da ficha; risco só se for a mesma versão do limite) e validada antes da chamada; claim atômico (5 min) antes da chamada; claim velho → `descartada`; `erro` retentável até 3 → `esgotada`; abstenção válida é final; coerência sugestão×prazo×confiança no CHECK e na edge; disparo só cron. |
| P1 fila: "última amarela" ressuscita | sombra = última avaliação (qualquer faixa) e só depois o filtro; efetivo marca `superada` (decisão mais nova) e `congelada` (flag desligado); `credito_decidir_fila` é o ÚNICO caminho de autorização (REVOKE de authenticated na RPC do PR 2) e recusa item superado/congelado. |
| P2 SLA/tag | "1º tick após completar 2 h"; tag por solicitação. |
| **Codex DIFF** (2ª rodada, 1 P0 + 7 P1) | conta do PEDIDO escolhe o flag (`pedido_inexistente`/`conta_divergente`/`revisao_inexistente` explícitos); vigência única na view (maior `seq` registrada + última decisão amarela DESSA revisão + pedido vivo + flag) usada pela ação; sombra lida de `credito_sombra_decisao` (PR 5) e migration renomeada para `20261125230000`; orçamento global 5/10 min + toda retomada conta tentativa + SDK sem retry + teto de 110 s; prazo sugerido é informativo e autorizar mostra o prazo integral (discordância se a IA sugeriu menor); front não afirma vazio/desligado sem leitura; `verify_jwt=false`; ACL da view por allowlist; `claude_ro` lê a prontidão; prontidão `IS TRUE` e prazo pelo resolvedor real; + pré-requisitos (k) núcleo efetivo herda a lógica da sombra e (l) leva/cobertura/reconciliação. |
| 6b (P0/P1) | contrato das 4 saídas (piso → flag → v2 → despacho), claim por revisão, tint/ATP antes da reserva, edição com PV confirmado — pré-requisitos (d)/(e)/(f) da prontidão; o 6b só liga a chamada dormente com prova de paridade desligado. |
