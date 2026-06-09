# Medida customizada nos dropdowns de especificação de ferramenta ("Outros")

**Data:** 2026-06-08
**Status:** design revisado pelo Codex (aguardando review do spec pelo founder)
**Origem:** o founder, no wizard de pedido de afiação (`/sales/new` → AddToolDialog), pediu que em **toda** definição de ferramenta, quando a opção desejada não existir no dropdown de uma especificação (ex.: "Número de dentes (Z)" da Serra Circular de Widea), exista um campo **"Outros"** para digitar uma medida nova e **salvá-la**, de modo que ela **reapareça nos próximos cadastros** daquele tipo de ferramenta.

---

## Decisões travadas (com o founder)

1. **Reuso:** a medida nova entra **no catálogo oficial** daquele campo (`tool_specifications.options`) e passa a aparecer no dropdown de **todo cadastro futuro** daquela ferramenta, para qualquer pessoa. Sem camada/tabela separada (o founder confirmou que pode ir direto pro catálogo oficial).
2. **Quem pode:** **só a equipe** (staff = `employee`/`master`). O cliente final, no portal (`/tools`), continua escolhendo apenas da lista fixa — não vê o "Outros".

## Achados do código que fundamentam o design

- **Tudo é banco-driven:** `tool_categories` → `tool_specifications` (cada spec tem `spec_type` ∈ `select|number|text` + `options` JSONB array de strings) → valores salvos em `user_tools.specifications` (JSONB). Não há opção hardcoded no React.
- **A renderização dos campos é genérica** (`specifications.map(...)` em [AddToolDialog.tsx](../../../src/components/AddToolDialog.tsx) L275-305) → a mudança de UI cobre **todas as categorias automaticamente**.
- **O modal é usado por staff E por cliente** — staff em `UnifiedOrder.tsx`/`AdminCustomers.tsx`, cliente em `Tools.tsx`. Por isso o gate "só equipe" existe na UI **e** no servidor.
- **`tool_specifications` — escrita hoje:** a policy `"Only admins can manage specifications"` no **schema-snapshot de produção** usa `has_role(auth.uid(), 'master'::app_role)` (a migration original `20260207193112` dizia `'admin'`, que não existe no enum — mas prod foi recriada com `'master'`). Ou seja, **master pode escrever via PostgREST hoje**, e a premissa de "policy morta" do rascunho anterior estava **errada** (achado do Codex). **Zero callsites no `src/` escrevem em `tool_specifications`** (confirmado por grep) — só leitura. → vamos **canalizar 100% da escrita pela RPC** e **dropar a policy de escrita** (deixa só a leitura pública), para que o `FOR UPDATE` da RPC serialize *toda* a escrita via API. Curadoria manual do master continua possível pelo **SQL Editor** (service_role, que ignora RLS).
- **Enum `app_role` = `('master','employee','customer')`** — não existe `'admin'`. Gate canônico de staff: `has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)`. Operação de escrita → `RAISE EXCEPTION` no forbidden (Pattern B).
- **Existem specs de FAIXA**, não só medida pontual: o campo `comprimento` tem options como `"de 120mm a 300mm"`, `"até 120mm"`. Pra esses, "digitar uma medida nova" não faz sentido semântico → ver flag `allow_custom_option`.
- **`useAuth()` já expõe `isStaff`** (`isAdmin || isEmployee || isMaster`).

## Abordagens consideradas (persistência)

| Abordagem | Por quê |
|---|---|
| **RPC `SECURITY DEFINER` que dá append no `options`** ✅ escolhida | Atende "catálogo oficial"; com a policy de escrita dropada, vira o **único** caminho de escrita via API → o `FOR UPDATE` serializa de verdade; normalização/dedupe/gate centralizados no servidor |
| PATCH do array direto do navegador | Rejeitada: read-modify-write concorrente **perde** opções; sem normalização/dedupe; e vamos justamente dropar a policy que o permitia |
| Tabela separada de opções custom + merge no dropdown | Rejeitada: o founder aceitou catálogo oficial → tabela à parte é complexidade sem ganho (YAGNI). Curadoria/promoção fica como follow-up |

---

## Design (revisado pós-Codex)

### 1. Migration

Três coisas, numa migration só (`<timestamp>_tool_spec_custom_option.sql`):

**(a) Coluna `allow_custom_option`** em `tool_specifications`:
```sql
ALTER TABLE public.tool_specifications
  ADD COLUMN IF NOT EXISTS allow_custom_option boolean NOT NULL DEFAULT true;
-- Fecha os campos de FAIXA (onde "digitar medida" não faz sentido):
UPDATE public.tool_specifications
  SET allow_custom_option = false
  WHERE spec_type = 'select'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(options) o
                WHERE o ILIKE 'de %a %' OR o ILIKE 'até %' OR o ILIKE 'entre %');
```
Default `true` honra o "em todas" do founder para os campos de medida pontual; os de faixa nascem fechados.

**(b) Dropar a policy de escrita** (canaliza tudo pela RPC; zero callsites usam):
```sql
DROP POLICY IF EXISTS "Only admins can manage specifications" ON public.tool_specifications;
```
Leitura (`"Anyone can read tool specifications"`) permanece. service_role (SQL Editor) ignora RLS → curadoria do master intacta.

**(c) RPC `adicionar_opcao_tool_spec(p_spec_id uuid, p_valor text) RETURNS jsonb`** — retorna `{ "options": [...], "valor_canonico": "..." }`.

`LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''` (vazio — evita hijack via `pg_temp`; **todos** os objetos qualificados: `public.tool_specifications`, `public.has_role`, `'…'::public.app_role`, `auth.uid()`; built-ins de `pg_catalog` resolvem sozinhos). Comportamento:
1. **Gate staff:** `IF NOT (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role)) THEN RAISE EXCEPTION 'não autorizado' USING errcode='42501'; END IF;`
2. **Rejeita NULL** (`p_valor IS NULL → RAISE`) — senão `btrim(NULL)`/concat viram NULL e **corrompem** `options` (P1 do Codex).
3. **Normaliza:** `normalize(btrim(p_valor), NFC)` + colapsa espaços (`regexp_replace(..., '\s+', ' ', 'g')`); **remove/rejeita** caracteres de controle.
4. **Valida:** vazio após normalizar → `RAISE`; `length > 60` → `RAISE`; valor reservado (`__OUTROS__` e afins) → `RAISE` (defesa em profundidade, mesmo o front não usando sentinela).
5. **Lê com lock:** `SELECT options, spec_type, allow_custom_option INTO ... WHERE id = p_spec_id FOR UPDATE;` → `NOT FOUND → RAISE`. Guards: `spec_type <> 'select' → RAISE`; `allow_custom_option = false → RAISE` (campo não aceita custom).
6. **Limite de quantidade:** se a lista já tem ≥ 200 opções → `RAISE` (anti-inflar JSONB; 60 chars/opção não basta sozinho).
7. **Dedupe case-insensitive:** se já existe `lower(e) = lower(v_norm)`, **não duplica** → devolve `{options atual, valor_canonico = o elemento existente}` (idempotente).
8. **Append atômico:** `UPDATE ... SET options = COALESCE(options,'[]'::jsonb) || jsonb_build_array(v_norm) ... RETURNING options`. Retorna `{options novo, valor_canonico = v_norm}`.
9. **Grants:** `REVOKE ALL ON FUNCTION ... FROM anon, public;` + `GRANT EXECUTE ON FUNCTION ... TO authenticated;` (gate interno restringe a staff). Tudo na mesma transação da criação.

> **`valor_canonico` no retorno** elimina divergência de collation/Unicode entre o dedupe do SQL e do TS: o **servidor** diz qual string selecionar; o front não recalcula (P2 do Codex).

### 2. Helper puro TS (oráculo testável, espelha o SQL)

`src/lib/tools/spec-option.ts`:
- `normalizarOpcaoSpec(valor: string): string | null` — `normalize('NFC')` + trim + colapsa espaços + remove control chars; retorna `null` se vazio, > 60 chars, ou valor reservado. **Mesma regra do SQL** (para validação otimista no front; o canônico final vem do servidor).
- Testado com vitest: trim/colapsa/NFC/limite/vazio/reservado.

### 3. Front — `AddToolDialog.tsx`

- Lê `isStaff` do `useAuth()`.
- **Botão "Outro" SEPARADO do Select** (não um `SelectItem` com value sentinela — o Codex mostrou que sentinela pode ser digitado como valor real, persistir em `user_tools`, e gerar dois itens Radix com mesmo `value`). Abaixo de cada dropdown, **só se `isStaff && spec.allow_custom_option`**, um link/botão pequeno **"➕ Não está na lista? Adicionar…"**.
- Estado novo, chaveado por **`spec.id`** (não `spec_key` — evita colisão entre categorias com mesma key): `addingForId: string | null`, `novoValor: string`, `savingOption: boolean`.
- Em modo adicionar (para aquele `spec.id`): troca a área do campo por um `Input` + **Salvar / Cancelar** + confirmação textual leve ("Isto adiciona ao catálogo permanente desta ferramenta").
  - **Salvar:** valida com `normalizarOpcaoSpec` (feedback rápido); `setSavingOption(true)`; chama `supabase.rpc('adicionar_opcao_tool_spec', { p_spec_id: spec.id, p_valor: novoValor })`.
    - **On success:** captura um `reqId` no início e **descarta a resposta se a categoria/spec mudou** (guard de resposta obsoleta). Usa `options` retornado para substituir `specifications[].options` daquela spec (estado local, sem refetch) e seleciona `valor_canonico` em `specValues`. Sai do modo adicionar. Toast "Medida adicionada".
    - **On error:** `toast.error` com a mensagem; sai do modo adicionar.
  - **Cancelar:** sai sem gravar.
- **Bloqueia o submit** do cadastro (`Adicionar Ferramenta`) enquanto `savingOption` (evita enviar no meio de uma adição).
- O cliente final (não-staff) nunca vê o botão "Outro".

### Fluxo de dados

```
staff clica "Adicionar…" → input → confirma → Salvar
  → rpc adicionar_opcao_tool_spec(spec.id, texto)
      → [servidor] gate staff → rejeita NULL → normaliza(NFC)/valida/reservado
        → lock FOR UPDATE → guards(spec_type/allow_custom/limite) → dedupe
        → append atômico → retorna {options, valor_canonico}
  → front (se resposta não-obsoleta): atualiza options local + seleciona valor_canonico
  → próximo cadastro daquela ferramenta: loadSpecifications lê do banco → a medida já está no dropdown
```

---

## Escopo de banco / ritual Lovable

- **1 migration** (coluna `allow_custom_option` + UPDATE de faixas + DROP da policy de escrita + RPC). Sem tabela nova.
- **Aplicação manual** no SQL Editor do Lovable (bloco pronto + validação pós-apply: coluna existe, policy de escrita ausente, função existe, grants corretos). Via skill `lovable-db-operator`.
- **Publish do frontend** no Lovable.
- **Sem edge function.**

## Validação

- **Helper puro TS testado (vitest)** — oráculo da normalização.
- **Teste SQL local PG17 OBRIGATÓRIO** (não opcional — exigência do Codex; base `db/verify-snapshot-replay.sh` + stubs de `auth.uid()`/`has_role` por GUC de sessão). Cobre: append, dedupe case-insensitive, **NULL** (não corrompe), catálogo malformado/`options` NULL, gate (staff passa / cliente/anon `RAISE`), guard `spec_type`/`allow_custom_option`/limite, sentinela reservada, e serialização sob `FOR UPDATE` (duas chamadas concorrentes não duplicam).
- **Codex já consultado no design** (achados P1/P2 incorporados acima). Adversarial no código vem na fase de revisão.

## Limitações conscientes da v1 (YAGNI)

- **A adição é uma ação de catálogo deliberada e imediata** (commit no servidor ao salvar) — não é transacional com o insert da ferramenta. Cancelar/fechar/falhar o cadastro depois deixa a opção no catálogo (é o trade-off de "catálogo crescente"; a confirmação inline reduz typo). **Undo no toast + auditoria de quem adicionou** = follow-up v2 (o founder cortou camada separada; não reintroduzir agora).
- Medida nova entra **no fim** do dropdown (sem reordenar por valor numérico — formatos variados: `300mm (12")`, `25,4mm` → parsing frágil).
- Vale **só para dropdowns** (`spec_type='select'`) com `allow_custom_option = true`. Campos `number`/`text` já aceitam qualquer valor; campos de faixa nascem fechados.
- Sem tela de curadoria (remover/renomear/promover) — correção é `UPDATE`/`DELETE` manual do master no SQL Editor.
- Sem escopo por-cliente (a opção é global naquele campo) — decisão explícita do founder.

## Fora de escopo (observação)

- **Cliente pode inserir specs arbitrárias em `user_tools.specifications`/`generated_name` via API** (a RLS de `user_tools` permite) — isso é **pré-existente** e independente desta feature; o **catálogo** fica protegido pela RPC staff-gate. Endurecer a escrita de `user_tools` é outro trabalho, fora deste spec.

## Não-objetivos

- Não mexer no fluxo de cliente final (portal continua lista-fixa na UI).
- Não tocar em preço/serviço/pedido — só amplia o catálogo de medidas escolhíveis.
- A RPC **só** dá append no array `options` de uma spec existente (não altera `spec_label`/`spec_type`/`allow_custom_option`/etc.).
