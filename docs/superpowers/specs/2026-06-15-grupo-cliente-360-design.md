# Grupo de Cliente 360 — design

> Spec de feature. Status: aprovado no brainstorming (2026-06-15). Próximo passo: writing-plans (Fase 1).

## Contexto e objetivo

Hoje o app modela cliente 1:1 (cada CNPJ/CPF = um `profiles.user_id` = um `omie_codigo_cliente`),
sem nenhuma noção de agrupamento. Mas o mesmo **dono real** frequentemente tem **vários
documentos** (CNPJs/CPF): fatura por mais de uma empresa, ou encerrou um CNPJ e abriu outro
(sucessão). Isso causa dois problemas:

1. **Cobrança/exposição fragmentada:** não dá pra ver quanto um dono deve no total — os recebíveis
   ficam espalhados por documento e por empresa (Colacor / Oben / Colacor SC).
2. **Plano de ligação duplicado:** a Farmer liga/oferta pro mesmo dono mais de uma vez (um por
   documento), e o histórico de um documento encerrado some.

**Objetivo:** um lugar no app pra **agrupar os documentos de um mesmo dono numa identidade única**
e ver **todos os dados e a cobrança somados em cima do grupo**, atravessando as 3 empresas.

## Escopo

**Dentro:**
- Modelo de dados de grupo (2 tabelas) + página pra criar/gerir grupos.
- Ficha **Grupo 360** (visão consolidada) — Fase 1: **Financeiro + Contatos**; Fase 2: **Comercial
  + dedup do plano de ligação**.
- Identidade do membro = **documento (CPF ou CNPJ, só dígitos)**, unificando os 3 empresas.

**Fora (explicitamente):**
- **Emissão de cobrança consolidada (1 boleto/título pro grupo).** A cobrança nasce no **Omie, por
  documento** (o app só sincroniza `fin_contas_receber` read-only — não emite). Consolidar a
  emissão seria mudança no Omie/contabilidade, fora do app. O grupo é **visão/soma**, não emissão.
- Mudar a sincronização Omie ou o modelo 1:1 existente de `profiles`/`omie_clientes`.

## Modelo de dados (2 tabelas novas)

### `cliente_grupos` — o dono/grupo
| coluna | tipo | nota |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `nome` | text NOT NULL | nome do dono/grupo |
| `notas` | text | livre |
| `ativo` | boolean | default true |
| `created_by` | uuid | FK `auth.users` |
| `created_at` / `updated_at` | timestamptz | |

### `cliente_grupo_membros` — os documentos do grupo
| coluna | tipo | nota |
| --- | --- | --- |
| `id` | uuid PK | |
| `grupo_id` | uuid NOT NULL | FK `cliente_grupos(id)` ON DELETE CASCADE |
| `documento` | text NOT NULL | **só dígitos** (CPF 11 / CNPJ 14). Identidade que unifica `profiles.cnpj`/`profiles.document` e `fin_contas_receber.cnpj_cpf` |
| `relation_type` | text NOT NULL | `'sucessao'` · `'multi_ativo'` · `'incerto'` (CHECK) |
| `valid_from` | date | início (sucessão) — opcional |
| `valid_to` | date | fim / encerramento (sucessão) — null = ativo |
| `confirmed_by` | uuid | FK `auth.users` |
| `confirmed_at` | timestamptz | |
| `note` | text | por que foi agrupado |

**Constraint chave:** `UNIQUE(documento)` — um documento pertence a **no máximo um** grupo. Mata a
transitividade (A=B, B=C) que o Codex apontou; cada documento mapeia pra exatamente um dono.

**Identidade = documento, não `user_id` nem `omie_codigo_cliente`** — porque o documento é a única
chave que cruza os 3 empresas e o financeiro (`fin_contas_receber.cnpj_cpf`). Um dono é **uma
identidade**; seus documentos podem transacionar em qualquer das 3 empresas.

### RLS
Staff-only, igual ao financeiro: SELECT/INSERT/UPDATE/DELETE só pra **master** OU gestor comercial
(`commercial_role IN ('gerencial','estrategico','super_admin')`) — mesmo gate de
`hasFinanceiroAccess` (`src/lib/financeiro/omie-request.ts`). Service role bypass pras edge functions.

## Data flow — como cada aba puxa os dados

Normalização: `documento` e `cnpj_cpf` comparados como **só dígitos**
(`regexp_replace(x,'\D','','g')`).

- **Financeiro (Fase 1):** soma `fin_contas_receber` onde `regexp_replace(cnpj_cpf,'\D','','g') ∈`
  documentos do grupo, agregando across `company` (oben/colacor/colacor_sc). Recebível em aberto,
  aging (a vencer / 1–30 / 31–60 / 61–90 / 90+), inadimplência. **Também por documento** (expor a
  composição — não esconder que é fusão). Implementado como **view** `v_grupo_contas_receber`.
  > Os nomes exatos das colunas de saldo/vencimento/status de `fin_contas_receber` (ex.: `saldo`,
  > `data_vencimento`, `status_titulo`) são confirmados contra o schema real no passo
  > `lovable-db-operator` antes de aplicar — o join (`company` + `cnpj_cpf`) é o que está fixado.
- **Contatos (Fase 1):** `profiles` (nome, razão social, vendedor via `omie_clientes`/
  `commercial`), `addresses` (cidade/endereço), telefone (`profiles` e/ou `sales_orders.customer_phone`)
  dos documentos membros.
- **Comercial (Fase 2):** faturamento total, mix consolidado, recência/queda do dono — reusa a
  lógica do farmer-industrial, com `cliente_key = grupo` quando o documento está num grupo. Métrica
  pela regra do design Codex (ver `unificacao-cnpj.md`): **recência/mix/faturamento somados
  (post-merge); frequência/queda NÃO pooled** (janela móvel + por-documento), pra não esconder
  cliente caindo.
- **Dedup do plano de ligação (Fase 2):** o plano semanal trata o grupo como 1 cliente
  (`call_key = grupo`): liga uma vez, oferta o mix que falta no grupo inteiro.

## Telas

### Gestão de grupos (sob **Gestão**, ex. `/gestao/grupos-cliente`)
- Lista: nome do dono · nº de documentos · exposição total (recebível em aberto) · status.
- Criar/editar: nomeia o dono; **busca documento** por nome ou CNPJ/CPF; adiciona; marca
  `relation_type` (sucessão/multi_ativo/incerto) e nota.
- **Sugestões (não automático):** os diagnósticos de `unificacao-cnpj.md` (sucessão com âncora
  telefone/endereço + multi-sinal nome+telefone+cidade) aparecem como *"estes documentos parecem o
  mesmo dono — confirmar?"*. Caminho principal = **owner-asserted** (lição empírica: detector
  sozinho é ruído).

### Ficha "Grupo 360"
- **Header:** nome do dono · nº de documentos · `relation_types` · **exposição total**.
- **Aba Financeiro (F1):** recebíveis em aberto, aging, inadimplência — somados nos 3, **+ tabela
  por documento**.
- **Aba Contatos (F1):** telefones, endereços, vendedor dos documentos.
- **Aba Comercial (F2):** faturamento total, mix consolidado, recência/queda do dono.

## Acesso
- Gerir grupo + ver o 360: **master** OU gestor comercial (`gerencial`/`estrategico`/`super_admin`).
- RLS staff-only nas 2 tabelas + na(s) view(s).

## Fases
- **Fase 1:** 2 tabelas + RLS + página de gestão + Grupo 360 (Financeiro + Contatos) + view
  `v_grupo_contas_receber`. É o núcleo de "cobrança em cima do grupo".
- **Fase 2:** aba Comercial + dedup no plano da Farmer (integra a skill farmer-industrial, lendo a
  tabela de grupos e aplicando a semântica de métrica do `unificacao-cnpj.md`).

## Implementação — rituais (do CLAUDE.md)
- **Banco:** via `lovable-db-operator`. Migration custom NÃO aplica sozinha no Lovable — a skill
  gera o arquivo + o bloco pro SQL Editor + a query de validação + a nota de PR + regenera o audit.
- **Somas de dinheiro:** via `prove-sql-money-path`. A view de recebível é **money-path** — testar
  num Postgres 17 local (semear, asserts positivos e negativos, falsificar) ANTES de aplicar, pra
  não somar errado a exposição do dono.
- **Testes:** unit das views de agregação (soma across empresa correta; por-documento bate com o
  total; documento sem grupo não vaza; CPF e CNPJ ambos casam).

## Riscos / pontos de atenção
- **Acurácia da soma de cobrança** (money-path) — daí o `prove-sql-money-path`.
- **Documento sujo** (formatação, zeros à esquerda) — normalizar sempre por dígitos; CPF=11/CNPJ=14.
- **Membro sem grupo** = comportamento atual (1 documento = 1 cliente) — o grupo é camada opt-in,
  não quebra nada de quem não está agrupado.
- **Não confundir com emissão** — deixar explícito na UI que é visão consolidada, cobrança continua
  saindo do Omie por documento.

## Continuidade
- O modelo (`relation_type`, `valid_from/valid_to`, documento, não-pooling de frequência) vem do
  design feito com o Codex em `.claude/skills/farmer-industrial/references/unificacao-cnpj.md`.
- Fase 2 conecta de volta na skill `farmer-industrial` (dedup + comercial do grupo).
