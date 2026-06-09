# Medida customizada nos dropdowns de especificação de ferramenta ("Outros")

**Data:** 2026-06-08
**Status:** design aprovado pelo founder (aguardando review do spec)
**Origem:** o founder, no wizard de pedido de afiação (`/sales/new` → AddToolDialog), pediu que em **toda** definição de ferramenta, quando a opção desejada não existir no dropdown de uma especificação (ex.: "Número de dentes (Z)" da Serra Circular de Widea), exista um campo **"Outros"** para digitar uma medida nova e **salvá-la**, de modo que ela **reapareça nos próximos cadastros** daquele tipo de ferramenta.

---

## Decisões travadas (com o founder)

1. **Reuso:** a medida nova entra **no catálogo oficial** daquele campo (`tool_specifications.options`) e passa a aparecer no dropdown de **todo cadastro futuro** daquela ferramenta, para qualquer pessoa. Sem camada/tabela separada (o founder confirmou que pode ir direto pro catálogo oficial).
2. **Quem pode:** **só a equipe** (staff = `employee`/`master`). O cliente final, no portal (`/tools`), continua escolhendo apenas da lista fixa — não vê o "Outros".

## Achados do código que fundamentam o design

- **Tudo é banco-driven:** `tool_categories` → `tool_specifications` (cada spec tem `spec_type` ∈ `select|number|text` + `options` JSONB) → valores salvos em `user_tools.specifications` (JSONB). Não há opção hardcoded no React.
- **A renderização dos campos é genérica** (`specifications.map(...)` em [AddToolDialog.tsx](../../../src/components/AddToolDialog.tsx) L275-305) → a mudança de UI cobre **todas as categorias automaticamente**, sem tocar categoria por categoria.
- **O modal é usado por staff E por cliente** — staff em `UnifiedOrder.tsx`/`AdminCustomers.tsx`, cliente em `Tools.tsx`. Por isso o gate "só equipe" precisa existir na UI **e** no servidor.
- **`tool_specifications` é admin-only para escrita, e o enum `app_role` é `('master','employee','customer')` — não existe `'admin'`.** A policy `"Only admins can manage specifications"` (que usa `has_role(...,'admin')`) é, portanto, **efetivamente morta**: ninguém escreve nessa tabela via PostgREST hoje. → confirma que precisamos de uma **RPC `SECURITY DEFINER`** para gravar a opção (não dá pra simplesmente afrouxar a RLS, e read-modify-write do array via PATCH no cliente perderia escritas concorrentes).
- **Gate de staff canônico no SQL:** `has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role)`. Para operação de **escrita**, o padrão do projeto (Pattern B do Codex) é `RAISE EXCEPTION` no forbidden, não retornar NULL.
- **`useAuth()` já expõe `isStaff`** (`isAdmin || isEmployee || isMaster`).

## Abordagens consideradas (persistência)

| Abordagem | Por quê |
|---|---|
| **RPC `SECURITY DEFINER` que dá append no `options`** ✅ escolhida | Atende "catálogo oficial"; contorna a RLS admin-only sem abri-la pra todos; append **atômico** com lock de linha evita corrida de escrita no JSONB; normalização/dedupe/gate centralizados no servidor |
| PATCH do array direto do navegador | Rejeitada: RLS hoje barra staff comum; read-modify-write concorrente **perde** opções; sem normalização/dedupe |
| Tabela separada de opções custom + merge no dropdown | Rejeitada: o founder aceitou catálogo oficial → tabela à parte é complexidade sem ganho (YAGNI). Curadoria/promoção fica como follow-up se um dia precisar |

---

## Design

### 1. Servidor — RPC `adicionar_opcao_tool_spec(p_spec_id uuid, p_valor text) RETURNS jsonb`

Retorna o array `options` **atualizado** (para o front sincronizar sem refetch).

Comportamento (plpgsql, `SECURITY DEFINER`, `SET search_path = public`):
1. **Gate staff:** `IF NOT (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)) THEN RAISE EXCEPTION 'não autorizado' USING errcode = '42501'; END IF;`
2. **Normaliza** o texto: `btrim` + colapsa espaços internos (`regexp_replace(..., '\s+', ' ', 'g')`).
3. **Valida:** rejeita vazio (`RAISE`); rejeita comprimento > 60 caracteres (`RAISE`) — anti-abuso/anti-inflar JSONB.
4. **Lê com lock:** `SELECT options, spec_type INTO ... FROM tool_specifications WHERE id = p_spec_id FOR UPDATE;` → `IF NOT FOUND THEN RAISE EXCEPTION 'especificação inexistente'`. Guard: `IF spec_type <> 'select' THEN RAISE EXCEPTION 'só dropdowns aceitam opção nova'` (campos number/text já são texto livre — não devem virar lista).
5. **Garante array:** `options` null vira `'[]'::jsonb`.
6. **Dedupe case-insensitive:** se já existe elemento equivalente (`lower(e) = lower(v_norm)`), **não duplica** — retorna o `options` atual (idempotente). Isso evita "290mm" vs "290mm " vs "290MM".
7. **Append atômico:** `UPDATE ... SET options = options || to_jsonb(v_norm) ... RETURNING options`. A medida nova entra **no fim** da lista.
8. **Grants:** `REVOKE ALL ... FROM anon, public;` + `GRANT EXECUTE ... TO authenticated;` (o gate interno restringe a staff; `anon` nem chega).

> A migration **não** cria tabela nem mexe na RLS de `tool_specifications`. É só a função.

### 2. Helper puro TS (oráculo testável, espelha o SQL)

`src/lib/tools/spec-option.ts`:
- `normalizarOpcaoSpec(valor: string): string | null` — trim + colapsa espaços; retorna `null` se vazio ou > 60 chars. **Mesma regra do SQL.**
- `acharOpcaoCanonica(options: string[], valorNormalizado: string): string | null` — acha na lista o item que bate case-insensitive (para o front selecionar o valor **canônico** depois do append/dedupe, em vez de assumir que o que digitou é exatamente o que ficou).

Testado com vitest (trim/colapsa/limite/vazio; dedupe case-insensitive; seleção do canônico).

### 3. Front — `AddToolDialog.tsx`

- Lê `isStaff` do `useAuth()` (hoje só lê `user`).
- No `SelectContent` de cada spec `select`, **só se `isStaff`**, acrescenta no fim:
  `<SelectItem value="__OUTROS__">➕ Outros (digitar medida)…</SelectItem>` (sentinela não-vazio, seguro pro Radix).
- Estado novo: `addingFor: string | null` (spec_key em modo "adicionar"), `novoValor: string`, `savingOption: boolean`.
- Quando `onValueChange` recebe `'__OUTROS__'`: **não** seta o valor — entra em modo adicionar (`setAddingFor(spec.spec_key)`).
- Em modo adicionar, troca o `Select` por um `Input` + **Salvar / Cancelar**:
  - **Salvar:** valida com `normalizarOpcaoSpec` (feedback rápido); chama `supabase.rpc('adicionar_opcao_tool_spec', { p_spec_id: spec.id, p_valor: novoValor })`. On success: usa o array retornado para **substituir `options` daquela spec** no estado local `specifications`, seleciona o valor **canônico** (`acharOpcaoCanonica`) em `specValues`, sai do modo adicionar, toast "Medida adicionada". On error: `toast.error`.
  - **Cancelar:** sai do modo adicionar sem gravar.
- O sentinela `__OUTROS__` nunca é persistido (interceptado antes de `setSpecValues`).

### Fluxo de dados

```
staff escolhe "Outros…" → input → Salvar
  → rpc adicionar_opcao_tool_spec(spec.id, texto)
      → [servidor] gate staff → normaliza → lock → dedupe → append → RETURNING options
  → front recebe options atualizado
      → atualiza specifications[].options (estado local, sem refetch)
      → specValues[spec_key] = valor canônico
  → próximo cadastro daquela ferramenta: loadSpecifications lê do banco → a medida já está no dropdown
```

---

## Escopo de banco / ritual Lovable

- **1 migration** `supabase/migrations/<timestamp>_tool_spec_add_option_rpc.sql` — só a RPC (CREATE FUNCTION + REVOKE/GRANT). Sem tabela nova, sem alterar RLS.
- **Aplicação manual** no SQL Editor do Lovable (bloco pronto + validação pós-apply: função existe, grants corretos). Via skill `lovable-db-operator`.
- **Publish do frontend** no Lovable para a UI ir ao ar.
- **Sem edge function.**

## Validação

- Helper puro TS testado (vitest) — oráculo da normalização/dedupe.
- **Consulta ao Codex no design** antes de implementar (catálogo de afiação é money-path-adjacent: vale 2ª opinião em append concorrente, gate, dedupe, sentinela do Radix).
- (Opcional, alto sinal) teste SQL local PG17 da RPC (append/dedupe/gate) na base `db/verify-snapshot-replay.sh`, se o custo valer — decisão no plano.

## Limitações conscientes da v1 (YAGNI)

- Medida nova entra **no fim** do dropdown (sem reordenar por valor numérico — os formatos são variados: `300mm (12")`, `25,4mm`, `22,23mm` → parsing seria frágil).
- Vale **só para dropdowns** (`spec_type = 'select'`). Campos `number`/`text` já aceitam qualquer valor (não há lista pra crescer).
- **Sem tela de curadoria** para remover/renomear/promover opção custom depois — se entrar lixo, correção é `UPDATE` manual do master no SQL Editor. Registrado como follow-up.
- Sem escopo por-cliente (a opção é global naquele campo) — foi a decisão explícita do founder.

## Não-objetivos

- Não mexer no fluxo de cliente final (portal continua lista-fixa).
- Não tocar em preço/serviço/pedido — só amplia o catálogo de medidas escolhíveis.
- Não reescrever specs arbitrárias: a RPC **só** dá append no array `options` de uma spec existente (não altera `spec_label`/`spec_type`/etc.).
