# Radar de Clientes — prospecção de empresas novas (estilo Radar do Omie) — Design

**Data:** 2026-06-10 · **Status:** aprovado pelo founder (brainstorming concluído)
**Decisores:** founder (produto/escopo) + Claude (arquitetura/recomendações)

---

## 1. Contexto e objetivo

O founder quer, dentro do app, uma funcionalidade similar ao **Radar de Clientes do Omie** — que é uma ferramenta de **prospecção** (hunter): localizar empresas que ainda NÃO são clientes, por segmento/região, com dados de contato, e agir sobre elas. Não confundir com gestão de carteira existente (farmer), que o app já cobre (scores, churn, positivação, lista de ligação da rota).

O Radar do Omie (referência): busca empresas por palavra-chave/CNAE, período de abertura e localização (estado/cidade/bairro); mostra lista E mapa; por empresa exibe endereço completo, telefone, e-mail, CNAEs e sócios; ações de 1 clique (cadastrar como cliente, criar conta CRM, enviar e-mail). Produto pago da Omie.Store, construído sobre dados públicos de CNPJ.

**Frase-síntese do nosso produto:** vigilância contínua dos CNPJs do Brasil nos segmentos de interesse — todo mês o sistema captura as empresas novas da Receita Federal, joga numa fila de prospecção, e o founder/gestor tria, contata, cadastra no Omie com 1 clique e distribui as boas pras vendedoras via Tarefas.

## 2. Decisões tomadas (com o founder, uma a uma)

| Decisão | Escolha | Alternativas descartadas |
| --- | --- | --- |
| Objetivo | **Prospecção** (igual ao Omie) | Radar da carteira existente; os dois juntos |
| Cobertura | **Brasil + CNAEs curados** (lista expansível) | Só MG; Brasil livre via API paga |
| Fonte de dados | **Dump mensal gratuito de dados abertos do CNPJ (RFB)** | API paga (Casa dos Dados/CNPJá ~R$100-300/mês — plugável depois sem jogar nada fora) |
| Cadência | **Mensal** (lag ~3-6 semanas aceito; é o mesmo lag do Omie) | Plataforma premium com captura diária (R$300-1000+/mês) |
| Pipeline | **GitHub Action mensal** (após primeira carga manual validar) | Semi-manual permanente |
| Quem usa | **Só founder/gestor** (tria e distribui via Tarefas) | Vendedoras direto; pessoa dedicada |
| Ações no lead | **Registrar contato + cadastrar no Omie + atribuir Tarefa** | Só registrar contato |
| Visual | **Lista + mapa já na v1** (mapa agregado por cidade) | Lista primeiro, mapa depois |
| Segmento | **Configurável por busca** dentro do universo curado | Lista fixa moveleiro |

**Expectativas honestas acordadas:** lag mensal; telefone/e-mail são os cadastrais da RFB (qualidade variável — mesma do Omie); volume real medido na 1ª carga (se >1M, aperta a curadoria antes de ingerir).

## 3. Arquitetura

### 3.1 Pipeline de ingestão (mensal)

```
RFB dados abertos CNPJ (mensal, ~6GB zipado, nacional)
  │  GitHub Action (schedule mensal + workflow_dispatch):
  │  baixa Estabelecimentos*.zip + Empresas*.zip + Cnaes.zip + Municipios.zip,
  │  processa com DuckDB (join + filtro: situação ATIVA + CNAE principal OU
  │  secundário ∈ lista curada), resolve município→lat/lng (base IBGE),
  │  produz linhas normalizadas
  ▼
POST em chunks (~2-5k linhas) → edge function radar-ingest
  (auth: x-cron-secret — CRON_SECRET vira secret do GitHub, founder configura 1×)
  ▼
Postgres: upsert em radar_empresas + finalize (diff de novos, re-cruza
"já é cliente", atualiza state)
```

- **Curadoria de CNAEs vive em arquivo versionado no repo** (`scripts/radar/cnaes-alvo.txt`, código + comentário). Expandir segmento = editar arquivo + rodar a Action (workflow_dispatch). O banco não guarda a curadoria; guarda o resultado.
- **Lista inicial** (proposta no plano, founder revisa): núcleo moveleiro (fabricação de móveis 31.0x, madeira/esquadrias 16.2x), serralheria/esquadrias metálicas (25.1x/25.4x), vidro (23.1x), e adjacências industriais do lado Colacor. Estimativa: 150–400k empresas ativas no Brasil. Construção civil ampla (41/43) fica FORA da lista inicial (universo gigante, baixa precisão de alvo).
- **Primeira carga é manual** (Claude roda o mesmo script DuckDB localmente e envia os chunks): valida URL/formato do dump, volume real e o caminho inteiro antes de automatizar.
- A Action NÃO acessa o banco diretamente — só fala com a edge via HTTP autenticado (mesmo padrão dos crons atuais).

### 3.2 Tabelas (migrations manuais via SQL Editor, skill lovable-db-operator)

- **`radar_empresas`** — universo prospectável. PK `cnpj` (text 14, só dígitos). Cadastrais: `razao_social`, `nome_fantasia`, `cnae_principal`, `cnae_descricao`, `cnaes_secundarios text[]`, `data_abertura date`, `porte`, `capital_social`, endereço (`logradouro`, `numero`, `complemento`, `bairro`, `municipio_codigo`, `municipio_nome`, `uf`, `cep`), `ddd1/telefone1`, `ddd2/telefone2`, `email`, `socios_nomes text` (concatenado, exibição). Operacionais: `primeira_vista_em` (default now() só no INSERT — define "novo do lote"), `ultimo_lote` (YYYY-MM; quem não veio no lote vigente = fechou/saiu → filtro default exclui, linha preservada com histórico), `ja_cliente bool`, `prospeccao_status` (`a_contatar` | `contatado_sem_resposta` | `em_conversa` | `descartado` | `virou_cliente`), `prospeccao_atualizado_em`, `descarte_motivo`. **RLS:** SELECT = `pode_ver_carteira_completa(auth.uid())`; escrita = service_role (mutação humana só via RPC).
- **`radar_contatos`** — histórico append-only: `cnpj` FK, `acao`, `nota`, `criado_por` (server-side), `created_at`. Escrita via RPC.
- **`radar_municipios`** — `codigo` (convenção da RFB) PK, `nome`, `uf`, `lat`, `lng`. Carregada pelo mesmo pipeline (chunk tipo `municipios`). Alimenta o mapa agregado.
- **`radar_ingest_state`** — 1 linha por lote: `mes_referencia`, `status` (running/complete/error), `total_recebido`, `novos`, timestamps, `erro`. Padrão `omie_nao_vinculados_state`; a UI só considera lote `complete`.

### 3.3 RPCs (SECURITY DEFINER, gate gestor/master — padrão route_contact_log)

- **`registrar_contato_radar(cnpj, acao, nota)`** — valida gate + vocabulário, atualiza `prospeccao_status`/`prospeccao_atualizado_em` na empresa, loga em `radar_contatos`, `criado_por = auth.uid()` server-side. Dedupe curto anti duplo-clique.
- **`desfazer_contato_radar(id)`** — own + <5min, reverte o status pro anterior (undo no toast).
- **`radar_contagem_por_municipio(filtros)`** — agregação server-side pro mapa (count por município respeitando os filtros ativos; NUNCA baixar a lista inteira pro client).

### 3.4 Edge function `radar-ingest`

Actions (gate `x-cron-secret` OU staff master, padrão `authorizeCronOrStaff`):
- `begin_lote {mes}` — abre o state (guard "already running").
- `chunk {linhas[]}` — upsert por `cnpj`; em conflito atualiza SÓ campos cadastrais (preserva `primeira_vista_em`, `prospeccao_status` e histórico); seta `ultimo_lote = mes`.
- `chunk_municipios {linhas[]}` — upsert em `radar_municipios`.
- `finalize {mes}` — re-cruza `ja_cliente` (set-based, ver 3.5), computa contagem de novos do lote, fecha o state como `complete`. Idempotente.

### 3.5 Cruzamento "já é cliente"

Documento normalizado só-dígitos, contra a união de dois conjuntos (lição do clientes-não-vinculados: checar os DOIS):
1. `profiles.document` (clientes com conta no app);
2. `omie_clientes_nao_vinculados.cnpj_cpf` (clientes do Omie sem conta — snapshot refreshado diariamente às 8h30).

⚠️ `omie_clientes` NÃO tem documento (só códigos) — não serve pro cruzamento direto. Badge "já é cliente" (não esconde a linha); filtro default exclui. Re-cruzado em todo `finalize` e imediatamente quando um lead é cadastrado via radar.

### 3.6 Ações sobre o lead

1. **Registrar contato** — vocabulário e UX espelham a lista de ligação da rota (não atendeu / falei / descartar com motivo / virou cliente), com undo curto.
2. **Cadastrar no Omie** — action nova na edge `omie-sync` (que já tem credenciais das 3 contas e o vocabulário `IncluirCliente`): founder escolhe a empresa destino (default Oben), payload pré-preenchido com os dados da RFB (razão, fantasia, CNPJ, endereço, telefone, e-mail). Sucesso → grava o código Omie retornado, marca `virou_cliente` + `ja_cliente`. Gate master/gestor via JWT staff. Erro do Omie exibido honesto (ex.: CNPJ já cadastrado → tratar como reconciliação: marca `ja_cliente`).
3. **Atribuir Tarefa** — cria tarefa pro sistema existente com `customer_user_id = NULL` (coluna é nullable; lead não tem profile) e título/descrição pré-preenchidos com empresa + telefone + cidade. Baixa manual pela vendedora (sem auto-satisfy — honesto: o matcher casa por cliente, que ainda não existe). Disponível a qualquer momento (não exige cadastro prévio no Omie).

### 3.7 Tela `/radar` (sidebar → Gestão, gate `gestorComercialOuMaster`)

- **KPIs:** novos no último lote · a contatar · em conversa · viraram cliente (mês).
- **Filtros** (server-side, `useUrlState`): busca por razão/fantasia, UF, município, CNAE (multi), faixa de `data_abertura`, **toggle "só cidades da rota"** (cruza com `route_schedule` via `normalizeCityKey` existente), status de prospecção, incluir/excluir `ja_cliente`.
- **Default da fila:** lote vigente, novas primeiro (`data_abertura desc`), excluindo descartadas e já-clientes.
- **Lista:** densa, `useInfiniteQuery` + busca/filtros NO SERVIDOR (universo de centenas de milhares — lição do cap 1000: nunca carregar tudo client-side).
- **Mapa:** Leaflet lazy (padrão `AdminRoutePlanner`), pins agregados por município via `radar_contagem_por_municipio`; clique no pin filtra a lista pra cidade. Endereço individual abre via link Google Maps (sem geocodificação por endereço).
- **Painel de detalhe (Sheet):** dados completos + sócios + histórico de contatos + as 3 ações.
- Padrões do repo: `PageSkeleton`, `EmptyState tone="operational"`, `text-status-*`, telemetria `track('radar.*')` (`radar.lead_contatado`, `radar.lead_cadastrado_omie`, `radar.lead_descartado`, `radar.tarefa_criada`, `radar.busca`).

### 3.8 Vigia (Sentinela)

Check `radar_ingest` no `_data_health_compute`: staleness — sem lote `complete` há >40 dias = warning (a RFB publica mensalmente; Action quebrada/URL mudada é o modo de falha esperado). Segue o rito do arquivo quente: partir da migration de MAIOR timestamp e recriar `data_health_watchdog` + `fin_sync_heartbeat` JUNTO (lição §5). Entra na fase 4, depois de existirem ≥2 lotes.

## 4. Entrega em 4 fatias (1 PR cada — as 4 juntas SÃO a v1)

1. **Fundação de dados** — migrations (4 tabelas + RLS + RPCs) + edge `radar-ingest` + script local DuckDB (`scripts/radar/`) + **primeira carga real manual** (valida URL do dump, volume e pipeline ponta a ponta). Critério de pronto: `radar_empresas` populada com o universo curado, state `complete`, contagens reportadas ao founder.
2. **Tela utilizável** — `/radar` com lista + filtros + detalhe + registrar contato (RPC) + KPIs. Founder já trabalha a fila.
3. **Ações + mapa** — cadastrar no Omie + atribuir Tarefa + mapa Leaflet agregado.
4. **Automação** — GitHub Action mensal + check no Sentinela + (se necessário) ajuste da curadoria com base no uso real.

## 5. Riscos e mitigação

- **URL/layout do dump da RFB mudou em jan/2026** (fato confirmado em pesquisa; candidatos: `arquivos.receitafederal.gov.br` share / `dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/<YYYY-MM>/`). A 1ª carga manual descobre o caminho real; a Action ganha descoberta de mês + falha ruidosa (e o Sentinela pega staleness).
- **Volume real da curadoria** — medido no DuckDB ANTES de ingerir; >1M = apertar lista. Estimativa de banco: ~200–600MB (campo a confirmar na 1ª carga; reportar ao founder o tamanho real).
- **Qualidade de contato** (telefone/e-mail cadastral) — expectativa já acordada; UI não promete mais do que tem (campos vazios exibidos como "—").
- **LGPD** — dados públicos da RFB para contato B2B ativo (mesma base do produto do Omie). Sem disparo de e-mail em massa na v1.
- **`tarefas` sem cliente vinculado** — tarefa de prospecção é manual-only (sem auto-baixa); documentado na UI da tarefa (origem `radar`).
- **CNPJ alfanumérico (RFB, vigência prevista jul/2026)** — limitação v1 registrada em review: o CHECK `^[0-9]{14}$`, a normalização e o recruza assumem CNPJ numérico; empresas com CNPJ alfanumérico serão EXCLUÍDAS silenciosamente do radar quando começarem a aparecer nos dumps (e o radar mira recém-abertas, onde surgirão primeiro). Gatilho de revisita: primeiro lote com CNPJs alfanuméricos no relatório da carga (o script reporta linhas descartadas).

## 6. Não-objetivos da v1 (cortes conscientes)

- Busca livre fora dos CNAEs curados (expandir = editar arquivo + re-rodar Action; API paga plugável no futuro).
- Geocodificação por endereço / pin exato por empresa (link Google Maps cobre).
- Acesso para vendedoras (founder-only; distribuição é via Tarefas).
- Disparo de e-mail/WhatsApp em massa para leads.
- Enriquecimento por fontes pagas (site, redes sociais, faturamento estimado).
- Sócios como entidade navegável (v1 = texto concatenado).
- Score/IA de priorização de lead (fila determinística: lote vigente + data de abertura + filtros; "valor do lead" é decisão de produto futura).
- Captura diária real (juntas comerciais) — só se o lag mensal doer na prática.

## 7. Follow-ups registrados (pós-v1)

- Mapa de calor/expansão de rota (leads por cidade × cidades da rota — insumo pra abrir cidade nova).
- Notificação mensal "chegaram N empresas novas do seu segmento" (e-mail via `fornecedor_alerta`, padrão digest).
- Cruzar leads com `route_schedule` D-1 (lead na cidade da rota de amanhã → sugerir visita de prospecção na lista de ligação).
- Histórico de situação cadastral (lead que fechou → aprendizado de curadoria).
