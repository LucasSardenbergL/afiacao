# Embalagem econômica — auto-cadastro dos pares QT+GL de todos os WP (design)

> 2026-07-09 · money-path (advisory) · reposição/compras · autor: Claude + founder (Lucas)
> Domínio: `docs/agent/reposicao.md` §Embalagem econômica · Feature v1: `docs/superpowers/specs/2026-06-04-embalagem-economica-design.md`

## 1. Problema

A tela **Embalagem econômica** (`/admin/reposicao/embalagem`) compara, por concentrado WP, o quartinho (QT) contra o galão (GL) pelo **menor custo por unidade-base**, respeitando **giro** e **proporcionalidade**, e recomenda quantas embalagens comprar (ex.: preciso 6 QT → se o GL for mais barato/base, sugere **2 GL**; senão, **6 QT**). É advisory: a compra é manual no Omie.

O founder quer que **todos os concentrados WP** entrem nessa análise, mantendo só o preço atualizado à mão. Hoje **só 3 cores aparecem** (WP01, WP04, WP87).

**Causa-raiz (confirmada, não é a lógica):** a lógica de recomendação já existe e está correta (`src/lib/reposicao/embalagem-helpers.ts`). O gargalo é **o cadastro dos pares**: a tela só mostra uma cor que tenha par QT+GL na tabela `sku_embalagem_equivalencia`, e essa tabela é populada **à mão no SQL Editor** — sem tela, sem seed, sem automação. Cada WP novo exige SQL manual, e por isso só 3 dos 14 estão lá.

## 2. Objetivo

Manter `sku_embalagem_equivalencia` (empresa `oben`) **populada automaticamente** com os pares QT+GL dos concentrados WP ativos no Omie, para que **todo WP apareça sozinho** na tela — o founder só mexe no Omie (cadastro/ativação) e nos preços. Zero SQL recorrente.

### Não-objetivos (YAGNI)
- **Não** reconstruir a lógica de recomendação (giro/carrego/proporcionalidade) — já existe e fica intacta.
- **Não** mexer no motor automático de compra — nenhum WP passa por ele (confirmado; §4).
- **Não** desativar cadastro automaticamente quando uma perna é inativada no Omie (insert-only; ver §6 dívida).
- **Não** generalizar para outras linhas de concentrado (TE/TEH tingidores, YXP "BA", seladoras) — escopo travado em `WP.3900` (§6).
- **Não** criar tela de gestão de pares nem edição de fator na UI (a proporção 4:1 é fixa).
- **Não** forçar o sync de catálogo do Omie a partir desta feature (é outra edge; ver §5 fluxo).

## 3. O que já existe (não tocar)

- **`embalagem-helpers.ts`** — `escolherEmbalagemEconomica`/`avaliarOpcao`: com giro, ordena por **custo total ajustado** (custo direto + capital de carrego − crédito da sobra que gira); sem giro, por **custo/base** puro (galão) com aviso. Guard anti-overbuy marginal (R$5). É o "2 GL vs 6 QT".
- **`sku_embalagem_equivalencia`** — os pares (grupo_id agrupa QT+GL da mesma cor; `unidade_base='QT'`, `fator_para_base` QT=1/GL=4). Constraint `uniq_sku_emb_equiv_ativo (empresa, sku_codigo_omie) WHERE ativo` = cada SKU ativo em ≤1 grupo.
- **`sku_preco_fornecedor_capturado`** — preço manual (append-only; `PrecoEmbalagemDialog` insere, a tela lê o mais recente). **Fluxo de preço fica intacto.**
- **`useEmbalagemConsulta.ts`** — lê a tabela, junta preço + demanda + custo de capital, monta os grupos (descarta grupo de <2 membros). A tela mostra o que estiver na tabela → **nenhuma mudança na query é necessária** para os 14 aparecerem.

## 4. Descoberta (produção, 2026-07-09, via psql-ro)

- **14 concentrados WP.3900 na conta Oben**, cada um agora com **QT e GL ativos** (o founder cadastrou no Omie; entraram após forçar o sync de catálogo).
- Pareamento por cor é **limpo e determinístico**: descrição `^WP<cor>.3900(QT|GL) ...`; a cor (`WP\d+\.\d+`) casa o QT com o GL. Zero sufixos fora de QT/GL (nenhum balde/litro a confundir).
- **Nenhum WP está no motor** (`sku_parametros` vazio para todos: sem fornecedor, sem ponto de pedido) → esta feature é **advisory pura**; mexer no cadastro **não afeta o ciclo automático de compra**.
- Estado do cadastro: **3 grupos** (WP01, WP04, WP87). Faltam **11** (WP02, WP03, WP06, WP07, WP08, WP12, WP42, WP53, WP69, WP71, WP88).
- **Sync de catálogo** (`omie-sync-metadados-daily`, o único writer que cria produto novo) roda **1×/dia às 08:30 UTC (05:30 BRT)** e está saudável. Produto criado no Omie depois disso só entra no próximo run — por isso os galões "sumiam". Diagnóstico: timing, não bug.

## 5. Design — 5 peças

### (1) Função de sincronização `reposicao_sincronizar_embalagem_wp(p_empresa text default 'oben')`
`SECURITY DEFINER`, idempotente, **insert-only**. Pseudo-lógica:

```
elegiveis := cores WP.3900 em omie_products (account = p_empresa, ativo)
             com AMBOS os sufixos QT e GL ativos
             -- cor = substring(descricao, '^(WP[0-9]+\.[0-9]+)')
             -- sufixo = substring(descricao, '^WP[0-9]+\.[0-9]+([A-Z0-9]+)') ∈ {QT, GL}
para cada cor em elegiveis:
    grupo := grupo_id existente de qualquer SKU (QT|GL) dessa cor já cadastrado ativo
             OU gen_random_uuid()               -- reusa grupo; só cria novo p/ cor sem cadastro
    para (sku, fator) em [(qt_codigo, 1), (gl_codigo, 4)]:
        se NÃO existe linha ativa p/ (p_empresa, sku::text):
            INSERT (empresa=p_empresa, grupo_id=grupo, sku_codigo_omie=sku::text,
                    unidade_base='QT', fator_para_base=fator, fornecedor_nome='Sayerlack',
                    ativo=true, criado_por='auto:embalagem-wp')
retorna jsonb { cores_elegiveis, pares_criados, linhas_inseridas, colisoes[] }
```

- **Idempotente:** a checagem "já existe linha ativa p/ o SKU" faz rodar N× = mesmo resultado. A `uniq_sku_emb_equiv_ativo` é a rede de segurança (colisão de SKU já ativo em outro grupo → registrar em `colisoes` e pular, nunca abortar o batch).
- **Fator 4 é seguro AQUI** (apesar do alerta geral "não derivar fator do sufixo" em `reposicao.md`): restrito a `WP.3900` concentrados, cuja litragem base é fixa (QT 0,81 L / GL 3,24 L = 4), já usada pelo motor e pelos 3 cadastros manuais existentes. O escopo travado é o que torna o hardcode 4 legítimo.
- **`criado_por='auto:embalagem-wp'`** distingue os automáticos dos manuais (`founder`) — permite re-derivar/limpar só os automáticos no futuro sem tocar os manuais.

### (2) Log de auditoria `reposicao_embalagem_sync_log`
`(id, empresa, executado_em timestamptz default now(), disparado_por text, cores_elegiveis int, pares_criados int, detalhes jsonb)`. `disparado_por` = `'cron'` ou `'manual:<email>'`. RLS staff-only (leitura); escrita só pela função (SECURITY DEFINER).

### (3) Cron diário
`pg_cron`, **≈09:00 UTC** (depois do catálogo das 08:30), chamando a função SQL-local. Mantém em dia sem intervenção. À prova de WPs futuros: cadastro entra no dia seguinte à criação no Omie, sozinho.

### (4) Botão "Sincronizar cadastro" na tela
Em `AdminReposicaoEmbalagem.tsx`: `supabase.rpc('reposicao_sincronizar_embalagem_wp', { p_empresa: 'oben' })`, toast com `pares_criados`, invalida `['embalagem-consulta']`. Para forçar na hora, sem esperar o cron.

### (5) Backfill no deploy
A migração executa a função **uma vez** ao ser aplicada → os 11 pares faltantes entram imediatamente (decisão do founder: "fazer de todos já"). Após aplicar, os 14 aparecem na tela.

## 6. Regras & invariantes

- **Escopo:** apenas descrições `^WP[0-9]+\.[0-9]+` com sufixo **QT** ou **GL**, `account='oben'`, `ativo=true`. Nada mais.
- **Ambos ativos:** a cor só é cadastrada quando QT **e** GL estão ativos no Omie.
- **Insert-only:** nunca UPDATE/DELETE de cadastro. Reusa grupo existente; nunca duplica SKU ativo.
- **Determinístico:** a cor é a chave de pareamento; cada cor → 1 grupo.
- **Dívida aceita (não-objetivo):** inativar uma perna no Omie **não** desativa o cadastro (a tela mostra com preço velho). Evita que um sync transitório apague cadastro. Correção, se necessária, é manual. Registrar em `reposicao.md`.

## 7. Authz & segurança (lição do repo)

O cron roda como `postgres` (SQL-local, **sem JWT** → `auth.uid()` NULL). A lição documentada (`reposicao.md` §Outras frentes): **gate `auth.role()='service_role'` MATA cron SQL-local** (42501 silencioso). Portanto:
- `REVOKE EXECUTE FROM public, anon` na função; `GRANT EXECUTE TO authenticated, service_role`.
- Gate interno permissivo ao cron: se **há** usuário logado (`auth.uid() IS NOT NULL`), exigir staff; se **não há** (cron postgres), passar. Nunca gatear por `auth.role()`.
- PG17: o teste que stuba o contexto do cron deve stubar **`auth.uid()=NULL`** (não `service_role`), senão mascara o bug.

## 8. Money-path & prova

Advisory (nenhum WP no motor), mas a tabela é **lida pelo motor** → tratar como money-path adjacente. Prova obrigatória em **PG17 local com falsificação** (`prove-sql-money-path`) antes de entregar:
- **Positivos:** backfill cria os N pares; idempotência (2ª run = 0 novos); reuso de grupo (WP01 pré-existente não duplica); cor com só QT ativo **não** entra; troca fator QT=1/GL=4 correta.
- **Negativos/colisão:** SKU já ativo em outro grupo → vai para `colisoes`, batch não aborta; SQLSTATE esperado capturado e o resto re-lançado.
- **Authz:** `SET ROLE authenticated` sem staff → negado; contexto cron (`auth.uid()=NULL`) → permitido (stub correto).
- **Falsificação:** sabotar a função (ex.: remover o filtro "ambos ativos", ou o `IF NOT EXISTS`) e **exigir vermelho** no teste.

## 9. Arquivos afetados

- **Migração** (nova) — tabela `reposicao_embalagem_sync_log` + função `reposicao_sincronizar_embalagem_wp` + `cron.schedule` + backfill (`SELECT reposicao_sincronizar_embalagem_wp('oben')`). Fonte versionada + bloco pra colar no SQL Editor (ritual `lovable-db-operator`).
- **`src/pages/AdminReposicaoEmbalagem.tsx`** — botão "Sincronizar cadastro" + mutation + toast + invalidação.
- **`db/test-embalagem-auto-cadastro-wp.sh`** (novo) — harness PG17.
- **`docs/agent/reposicao.md`** — nota curta na §Embalagem econômica (a automática + a dívida da inativação).

## 10. Deploy (Lovable — 3 camadas manuais)

- **Migração:** colar no SQL Editor (não auto-aplica; ritual `lovable-db-operator`). Inclui o backfill → 14 pares na hora. Validar com a query de contagem de grupos.
- **Frontend:** Publish no editor Lovable (o botão novo).
- **Edge:** nenhuma (função é SQL-local; sem edge nova).
- **Cron:** criado pela própria migração (`cron.schedule`); confirmar em `cron.job`.

## 11. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Fator errado para linha não-WP | Escopo travado `WP.3900`; PG17 falsifica |
| Cron morto por gate authz (lição) | REVOKE/GRANT + gate `auth.uid()` NULL-aware; PG17 stuba NULL |
| Colisão de SKU aborta o batch | `colisoes[]` + continua; constraint como rede |
| WP novo não aparece no mesmo dia | Esperado: catálogo 05:30 + cron 09:00; botão força na hora |
| Automática apaga cadastro por sync transitório | Insert-only; nunca desativa |

## 12. Decisões resolvidas (com o founder)

✅ Automático (cron + botão) · ✅ escopo `WP.3900` · ✅ ambos ativos · ✅ backfill de todos no deploy · ✅ proporção 4:1 fixa · ✅ diagnóstico do sync (saudável — timing) encerrado, 14 galões confirmados no banco.

## 13. Referências
- `docs/superpowers/specs/2026-06-04-embalagem-economica-design.md` (v1 da tela)
- `docs/superpowers/specs/2026-06-26-reposicao-embalagem-no-motor-spec.md` (o mesmo QT×GL no motor — que os WP **não** usam)
- `reposicao.md` §Embalagem econômica, §Portal Sayerlack (padrão de-para auto: view→RPC insert-only→audit), §Outras frentes (lição cron SQL-local authz)
- `supabase/migrations/20260604182408_embalagem_economica.sql` (schema base)
