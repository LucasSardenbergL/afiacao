# Melhorias — canal interno de sugestões/problemas com triagem por IA

**Data:** 2026-06-10 · **Status:** aprovado em brainstorm (abordagem A) · **Autor:** Lucas + Claude

## 1. Problema e objetivo

Os funcionários encontram problemas e têm ideias de melhoria no dia a dia, mas não existe canal estruturado: chegam por WhatsApp/voz ao founder, se perdem, e não há triagem. O founder quer:

1. **Captar** toda sugestão/problema dentro do próprio app, com contexto automático (tela, empresa, autor).
2. **Triagem por IA na hora**: classificar (problema/sugestão/pergunta), estimar urgência, confirmar entendimento ao funcionário.
3. **Retorno rápido quando for pergunta de dados** que case com ferramenta pronta (ex.: "quais clientes compram o produto X e o que sugerir de substituto ao tirar de linha").
4. **Fila noturna pro founder**: tela master com a avaliação da IA por item + um **prompt pronto pra colar no Claude Code** e atacar o conserto.
5. **Loop fechado com o funcionário**: ele vê o status do que reportou (aberto → em andamento → resolvido/descartado) e a resposta do founder.

Decisões do brainstorm: só staff (sem clientes) · triagem + dados guiados (sem text-to-SQL aberto) · consumo noturno = tela no app + prompt pronto (SEM digest por e-mail) · funcionário vê status.

## 2. Princípios (herdados do projeto)

- **A captação NUNCA depende da IA.** O item é gravado client-side (RLS own) ANTES de invocar a edge. IA fora do ar → item entra na fila com `triagem_status='pendente'` e o funcionário recebe degradação honesta ("Recebido! A avaliação automática falhou, mas sua mensagem está na fila.").
- **IA nunca fabrica número.** Perguntas de dados passam por RPCs SQL determinísticas; a UI renderiza a **tabela crua** do resultado (jsonb `dados` na mensagem). A prosa da IA é curta e instruída a não repetir números (a prosa é descartável, a evidência é o produto — princípio do programa Buddy).
- **Visibilidade de carteira respeitada.** As RPCs de dados rodam com o `auth.uid()` do solicitante: master/gestor (`pode_ver_carteira_completa`) vê tudo; vendedora vê só a carteira dela (mesmo padrão dos hardenings #329/#340).
- **LLM caminho (a) canônico**: Anthropic direto, `claude-sonnet-4-6`, forced tool-use, prompt caching, gate `authorizeCronOrStaff` (referência: `tarefa-extrair-voz`).

## 3. Experiência

### 3.1 Funcionário (qualquer staff: employee/master)

- **Botão no topbar do AppShell** (ícone `Lightbulb`, tooltip "Sugerir melhoria · reportar problema"), visível em qualquer tela. Abre `MelhoriaDialog`:
  - Textarea livre + botão Enviar. Zero campos obrigatórios além do texto.
  - O app captura sozinho: `location.pathname` (rota de origem), empresa ativa (`CompanyContext`), autor (`auth.uid()`).
  - Ao enviar: grava item + 1ª mensagem → invoca a edge `melhoria-triagem` (síncrono, spinner "A IA está avaliando…", timeout ~30s) → a resposta da IA aparece no próprio dialog (thread inline).
  - Se a pergunta casou com ferramenta de dados: a mensagem da IA vem com tabela renderizada (ex.: lista de clientes que compram o produto) + aviso de que também foi pra fila do founder.
- **Página `/melhorias`** (sidebar, seção Principal): lista dos itens do próprio usuário com status e thread. Pode mandar **réplica** em item ainda aberto (cap de 5 réplicas/item, validado na UI e re-validado na edge) — cada réplica re-roda a triagem com a thread completa.
- Quando o founder resolve/descarta: o funcionário vê o status novo + `resposta_founder` ao abrir a página. Sem push (não-objetivo v1).

### 3.2 Founder (master)

- **Página `/gestao/melhorias`** (sidebar, seção Gestão, master-only): fila com filtros (status, tipo, urgência, módulo), ordenada por urgência+data. Por item:
  - Relato original + thread + contexto (autor, rota de origem, empresa) + avaliação técnica da IA (`avaliacao_founder`).
  - Botão **"Copiar prompt pro Claude Code"** — monta client-side (helper puro, sempre reflete a thread atual) um bloco com: quem reportou, quando, tela, empresa, relato completo, thread, avaliação/hipótese da IA, e instrução de investigação.
  - Ações: marcar `em_andamento` / `resolvido` / `descartado` + campo de resposta opcional (o funcionário vê).
  - Botão **"Re-triar"** em item com `triagem_status` pendente/erro (re-invoca a edge; master pode triar item de qualquer autor).
- **Badge na sidebar** (padrão dos badges existentes, poll gated): count de `status='aberto'`, master-only.

## 4. Ferramentas de dados (v1: 2 RPCs read-only)

Ambas `SECURITY DEFINER` com gate interno: exige staff (employee/master via `user_roles`), senão `RAISE`. Chamadas pela edge **com o JWT do usuário** (client anon + header Authorization do request original — NÃO service_role), pra `auth.uid()` ser o solicitante real.

### 4.1 `melhoria_clientes_por_produto(p_termo text)`

- Resolve produtos: `omie_products` com `descricao ILIKE '%termo%'` (ou código), `ativo=true`, limit 5 produtos casados (retorna os candidatos pro Claude desambiguar se preciso).
- Clientes: `order_items` (JOIN `sales_orders` — pedido válido = não-cancelado/não-rascunho, padrão #279) dos últimos 12 meses com `product_id` nos casados, agregado por `customer_user_id`: nome (via `profiles`), nº de pedidos, última compra, valor 12m. LIMIT 50, ordenado por valor desc.
- Visibilidade: `pode_ver_carteira_completa(auth.uid())` → todos os clientes; senão filtra pela carteira visível do solicitante (reusar o MESMO helper das policies #329 — verificar assinatura exata de `carteira_visivel_para` na implementação). Resultado filtrado → a IA avisa "mostrando só os clientes da sua carteira".

### 4.2 `melhoria_produtos_relacionados(p_termo text)`

- Resolve produto(s) pelo termo (igual acima).
- Retorna duas listas rotuladas:
  - **mesma_familia**: `omie_products` ativos com a mesma `familia` (mesma `account`), limit 10 — candidatos a substituto direto.
  - **comprados_juntos**: `farmer_association_rules` onde o produto ∈ `antecedent_product_ids` → `consequent_product_ids` (JOIN `omie_products` pra nome), com `confidence`/`lift`, limit 10.
- Juntas cobrem o caso canônico: "vou tirar X de linha → quem compra (4.1) e o que oferecer no lugar (4.2)".

Pergunta de dados que NÃO casa com nenhuma ferramenta → a IA classifica como `pergunta`, explica que vai pra fila, e a `avaliacao_founder` já vem armada pro founder responder à noite.

## 5. Edge function `melhoria-triagem`

- **Gate**: `authorizeCronOrStaff` — somente o caminho **staff** (o caminho cron não se aplica: triagem é sempre disparada por um usuário; requests via cron-secret são rejeitados). Input: `{ item_id }`. A edge lê item + thread do banco via service_role (anti-spoof: não confia em conteúdo do payload). Autorização: caller é o autor do item OU master.
- **Loop agentic**: Claude (`claude-sonnet-4-6`) com 3 tools — `clientes_por_produto`, `produtos_relacionados` (executam as RPCs §4 com o JWT do caller; resultado volta como tool_result) e `triar` (terminal). Máx. 3 chamadas de dados; depois força `triar` via `tool_choice`.
- **Tool `triar` (sempre a última)**:
  ```
  { tipo: problema|sugestao|pergunta,
    urgencia: baixa|media|alta,
    modulo: vendas|estoque|reposicao|financeiro|tintometrico|afiacao|whatsapp|rota|tarefas|producao|governanca|outro,
    titulo: string,                      // resumo de 1 linha
    resposta_ao_funcionario: string,     // pt-BR, cordial, curta; sem números fora dos dados
    avaliacao_founder: string }          // nota técnica: hipótese de causa, onde mexer
  ```
- **System prompt** com `cache_control` (caching): persona de triagem do OS interno; descrição dos módulos do app; regra anti-fabricação (números só de tool_result; prosa não repete números — a UI mostra a tabela); quando usar cada ferramenta; réplicas = re-triagem com thread completa.
- **Persistência** (service_role): UPDATE no item (tipo/urgencia/modulo/titulo/avaliacao_founder/`triagem_status='ok'`) + INSERT `melhoria_mensagens` (papel `ia`, `conteudo`=resposta, `dados`=jsonb `{tool, input, resultado}` quando houve dados). Retorna a resposta no response (o dialog renderiza na hora).
- **Erro** em qualquer ponto: `triagem_status='erro'` + response de degradação honesta. Item permanece na fila.

## 6. Modelo de dados

```sql
melhoria_itens (
  id uuid PK DEFAULT gen_random_uuid(),
  autor_user_id uuid NOT NULL,            -- auth.users do autor
  empresa text NOT NULL,                  -- colacor|oben|colacor_sc (empresa ativa no envio)
  rota_origem text,                       -- pathname onde o dialog foi aberto
  tipo text CHECK (... problema|sugestao|pergunta),        -- IA (null até triar)
  urgencia text CHECK (... baixa|media|alta),              -- IA
  modulo text,                            -- IA (lista §5, sem CHECK — lista evolui)
  titulo text,                            -- IA
  status text NOT NULL DEFAULT 'aberto' CHECK (aberto|em_andamento|resolvido|descartado),
  triagem_status text NOT NULL DEFAULT 'pendente' CHECK (pendente|ok|erro),
  avaliacao_founder text,                 -- nota técnica da IA pro founder
  resposta_founder text,                  -- resposta humana (funcionário vê)
  resolvido_em timestamptz,
  created_at/updated_at timestamptz NOT NULL DEFAULT now()
)
-- índices: (status, created_at DESC), (autor_user_id, created_at DESC)

melhoria_mensagens (
  id uuid PK DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES melhoria_itens ON DELETE CASCADE,
  autor_user_id uuid,                     -- null quando papel='ia'
  papel text NOT NULL CHECK (funcionario|ia|founder),
  conteudo text NOT NULL,
  dados jsonb,                            -- resultado de ferramenta (a UI renderiza tabela)
  created_at timestamptz NOT NULL DEFAULT now()
)
-- índice: (item_id, created_at)
```

**RLS** (espelhar o padrão das tabelas recentes, ex.: `tarefas`):
- `melhoria_itens` — SELECT: `autor_user_id = auth.uid()` OR master. INSERT: staff WITH CHECK `autor_user_id = auth.uid()`. UPDATE: master (status/resposta). Sem DELETE (descartar é status).
- `melhoria_mensagens` — SELECT: quem vê o item. INSERT: WITH CHECK `autor_user_id = auth.uid()` + papel coerente (`funcionario` se autor do item; `founder` se master) + item `status='aberto'|'em_andamento'`. Mensagens `papel='ia'` só via service_role (edge).
- Cap de 5 réplicas/item é app-level (UI + edge), não RLS.

## 7. Frontend

- `src/components/melhorias/MelhoriaDialog.tsx` — dialog do topbar (criação + thread inline + spinner de triagem).
- Botão no `AppShell` (topbar, junto do HelpDrawer).
- `src/pages/Melhorias.tsx` — rota `/melhorias` (lista própria, thread, réplica). Sidebar seção Principal, staff.
- `src/pages/GestaoMelhorias.tsx` — rota `/gestao/melhorias` (fila master: filtros, avaliação, copiar prompt, status, re-triar). Gate **master-only** (`isMaster` — mecanismo de guard igual ao das rotas protegidas existentes, mas predicado mais restrito que o `gestorComercialOuMaster` de outras telas de gestão; ver §11).
- Badge sidebar master (poll gated como os demais).
- `src/hooks/useMelhorias.ts` — queries/mutations/invoke.
- **Helpers puros TDD** em `src/lib/melhorias/` (espelhados verbatim na edge onde aplicável):
  - `montarPromptClaudeCode(item, mensagens)` — o bloco copiável (determinístico, client-side).
  - `validarTriagem(payload)` — valida/normaliza o output da tool `triar` (enums, campos).
  - `podeReplicar(item, mensagens)` — cap de réplicas + status aberto.
- Telemetria PostHog: `melhoria.criada`, `melhoria.ia_respondeu` (props: tipo, teve_dados), `melhoria.replica`, `melhoria.status_alterado`, `melhoria.prompt_copiado`.

## 8. Testes e validação

- **Vitest** nos helpers puros (prompt, validação, cap).
- **PG17 local** (`db/test-melhorias-rpcs.sh`, base `verify-snapshot-replay.sh`): RPCs com seed — clientes por produto (agregação, janela 12m, pedido válido), gate de carteira (vendedora vê só os dela; master vê tudo), produtos relacionados (família + associação), RLS das tabelas (own/master/anon-deny).
- **Smoke em prod** pós-deploy: criar item real, conferir triagem + tabela de dados + prompt copiável.

## 9. Custo e volume

<20 usuários staff, poucos itens/dia. Sonnet 4.6 com caching ≈ US$0,005–0,02/triagem → desprezível. Sem rate-limit na v1 (registrado como não-objetivo; adicionar se houver abuso).

## 10. Deploy (3 pernas manuais — §5 CLAUDE.md)

1. Migration única (tabelas + RLS + índices + 2 RPCs) → SQL Editor via `lovable-db-operator`.
2. Edge `melhoria-triagem` → chat do Lovable (verbatim da main, após merge).
3. Publish do frontend no Lovable.

## 11. Não-objetivos v1 (registrados)

- Anexo de foto/print no relato (storage) · digest por e-mail · text-to-SQL aberto · votos/dedupe entre sugestões · notificação push ao funcionário · rate-limit · realtime (polling/refetch basta) · edição do relato pelo funcionário (réplica cobre) · fila de gestão pra gestor comercial (master-only na v1) · pós-validação regex anti-número na prosa (hardening v1.5, padrão Buddy — v1 mitiga via tabela crua + instrução).

## 12. Riscos e mitigações

| Risco | Mitigação |
| --- | --- |
| IA fabrica número na prosa | Tabela crua renderizada do jsonb; prosa instruída a não repetir números; hardening regex em v1.5 |
| Vendedora vê cliente fora da carteira via pergunta de dados | RPC roda com `auth.uid()` do solicitante + gates #329; IA avisa escopo |
| Edge fora do ar | Captação independe da IA; `triagem_status='pendente'`; botão re-triar |
| Spoof de payload na edge | Edge lê conteúdo do banco por `item_id`; autorização autor-ou-master |
| Canal morre por falta de retorno | Status visível + resposta do founder no item; badge cobra o founder |
