# Mapeamento assistido Tintométrico (Bases) — cobertura + auto-sugestão

Data: 2026-06-14
Status: design aprovado pelo founder ("pode seguir"), pré-implementação.

## Problema (founder, na tela `/tintometrico/catalogo` → Mapeamento → Bases)

Mapear cada base↔produto Omie é lento e incompleto:

1. **Produtos Omie que existem não aparecem pra mapear** (ex.: `WJOB.7796` galão existe no Omie da Oben, mas some da lista).
2. **O seletor não dá pra digitar** — é um `<Select>` Radix sem busca, lista enorme só rolável.
3. **Ordenação cega** — alfabética por `descricao` ([TintMapping.tsx:47](../../../src/pages/TintMapping.tsx)), não sabe qual base está sendo mapeada.
4. **Sem auto-sugestão** — tudo manual. Founder quer "ir com quais eu acredito que sejam, e ele só aprova".

## Diagnóstico (confirmado em prod via SQL Editor)

- A família no banco é **"Bases MixMachine"**, que após `lowercase().trim()` CASA com o filtro do `tint-omie-sync`. **Não é mismatch de string** (hipótese inicial descartada pelo diagnóstico).
- É **cobertura**: 67 bases (+5 concentrados) com a família certa estavam **sem `is_tintometric`** → fora do dropdown (que filtra `is_tintometric=true AND ativo=true AND tint_type=…`, [TintMapping.tsx:42-46](../../../src/pages/TintMapping.tsx)). Causa provável: teto de 20 páginas / rate-limit do `tint-omie-sync` ([tint-omie-sync:125-138](../../../supabase/functions/tint-omie-sync/index.ts)); produtos novos entram pelo sync geral sem a marca.
- As **80 bases ATIVAS já estão 100% mapeadas** (`bases_sem_mapa = 0`). As linhas "Selecionar…" que o founder vê são **SKUs OCULTOS** (`ativo=false`) que ele quer **reativar + mapear**.

## Solução

### (a) Cobertura — backfill [FEITO em prod 2026-06-14]

`UPDATE omie_products` marcou `is_tintometric=true` + `tint_type` nos produtos Omie **ativos** com família "Bases/Concentrados MixMachine" que escaparam. Resultado: **13 ativos** marcados (8 bases + 5 concentrados), incl. `WJOB.7796` GL (`PRD03644`) e irmãs 405/810ML. Os 59 restantes são `ativo=false` (descontinuados) → corretamente fora. UPDATE seguro/reversível (só toca classificação tint; não toca preço/estoque/descrição).

### (b) Motor de matching puro — `src/lib/tint/omie-match.ts` (TDD)

Score de relevância entre uma **linha-SKU** (`tint_produtos.descricao` + `tint_bases.descricao` + `tint_embalagens.descricao`/`volume_ml`) e um **produto Omie** (`codigo` + `descricao`):

- **código-base igual** → peso **ALTO**. Ex.: `WJOB.7796` (da `tint_bases.descricao`, que começa com o código) vs `WJOB.7796` extraído de `BASE ACRIL BRANC BRIL 05 WJOB.7796GL`. ⚠️ distingue `WJOB.7796` (branca) de `WJOI.7796` (intermediária) — mesmo número, bases diferentes. Novo helper `extrairCodigoBase` (formato `[A-Z]{2,4}\d{0,2}\.\d{3,4}(\.\d{2,4})?`, **SEM** sufixo de embalagem — o `sayerlack-sku.ts` exige sufixo colado, então não serve direto; reuso a mesma família de regex).
- **embalagem casa** → peso **MÉDIO**. O trecho da `descricao` Omie depois do código-base (`…7796GL` → `GL`; `…7796 405ML` → `405ML`) comparado, normalizado, com `tint_embalagens.descricao`.
- **palavras descritivas em comum** (ACRIL, FOSCO, BRANC, INTER…) → peso **BAIXO** (desempate).

**⚠️ Confiança ≠ score (correção Codex 2026-06-14, money-path):** a classificação `forte`/`revisar` vem da **cardinalidade de uma chave estrutural exata**, NUNCA do score. O score (pesos acima) serve **só pra ordenar o combobox** (tela de revisão), nunca pra produzir confiança — senão o desempate por palavras (`+1`) promoveria arbitrariamente um de dois candidatos com a MESMA chave dura a `forte`.

Chave dura = `(código-base exato, embalagem exata)`. `forte` ⟺ existe **exatamente 1** produto Omie elegível (base ativa) cuja chave dura bate **inequivocamente** com a da linha-SKU. `count == 0` ou `> 1` → `revisar`.

Parsing à prova de money-path (Codex):
- Extrair **exatamente 1** código de cada lado; 0 ou >1 códigos → `revisar` (não chuta). Âncora de posição: **início** na `tint_bases.descricao`, **fim** na `descricao` Omie (anti-substring `XWJOB.7796`/`WJOB.77960`).
- Comparação **exata, código inteiro**: `WJOB ≠ WJOI`, `JO10 ≠ JO5`, `.7644 ≠ .7644.00`. **Não** remover `.00` nem normalizar pontuação (`4,05L` ≠ `405L`).
- Embalagem: **igualdade textual exata** (normalizada upper/trim) entre o trecho pós-código da Omie e `tint_embalagens.descricao`. **Sem alias implícito** (`QT` ≠ `810ML`, `GL` ≠ `3600ML`) — casar por volume/alias/inferência ⇒ `revisar`. Fracionado (`405ML`/`450ML`) é embalagem distinta, nunca aproximada. (Se a query de embalagens mostrar que descricao×sufixo divergem sistematicamente, uma **tabela de alias EXPLÍCITA** entra — nunca alias implícito.)
- **Unicidade GLOBAL** no universo elegível (todas as bases ativas), não só "na mesma família" — duplicata no ERP (2 produtos com a mesma chave dura) ⇒ `revisar`.
- Candidato cujo produto Omie **já está mapeado a outra base** ⇒ `revisar` (não rouba/duplica vínculo existente).

Funções puras: `extrairCodigoBase`, `embalagemDaDescricaoOmie`, `scoreProduto` (só ordena), `ranquearProdutos(linha, produtos)` (combobox), `sugerirMapeamento(linha, produtos, jaMapeados)` (confiança por cardinalidade de chave dura).

### (c) Seletor (combobox) — substitui o `<Select>`

cmdk `Command` + `Popover` (espelha [CityMultiSelector](../../../src/components/reposicao/routePlanner/CityMultiSelector.tsx) / [PaymentComboboxEdit](../../../src/components/salesOrderEdit/PaymentComboboxEdit.tsx)). Busca digitável (reusa `normalizarBusca` de [cores-do-cliente.ts](../../../src/lib/tint/cores-do-cliente.ts), filtra por `codigo`+`descricao`). Resultados em grupos: **"Sugeridos pra esta base"** no topo (código-base igual, score desc) + resto **agrupado por código-base** (resolve "agrupar nomes parecidos"). Custo/estoque na linha pra ajudar a escolha. Cap de 1000 do PostgREST eliminado (`.range`/paginação — hoje 114 < 1000, preventivo).

### (d) Auto-sugestão + aprovação

Botão **"Sugerir mapeamentos"**: roda o motor sobre as bases **não-mapeadas visíveis** (respeita o filtro de ocultos), pré-preenche cada uma com o melhor palpite em **estado local** (badge "sugestão", **nada salvo**). Founder **aprova em lote** (salva todos) **ou ajusta linha a linha**. Aprovar um SKU oculto **reativa (`ativo=true`) + mapeia** numa mutação otimista. Sugestões `revisar` ficam destacadas mas exigem clique explícito.

## Não-objetivos (v1)

- Abrir o dropdown pra **todo o catálogo Omie** (founder quer curado: só bases/concentrados).
- Tratar concentrados como foco (founder diz estar ok; o motor cobre, mas tende a 0 pendência).
- **Reescrever o sync** (follow-up).
- Reativar SKUs ocultos em massa sem mapear (a reativação acontece *ao aprovar a sugestão*).

## Follow-up — cobertura automatizada [FEITO 2026-06-14; migration manual pendente]

Em vez de mexer no edge `tint-omie-sync` (money-path, frágil), a cobertura virou um passo SQL idempotente que reusa o que o sync geral já entrega: o `omie-sync-metadados` pagina o catálogo INTEIRO (sem teto, `while pagina <= totalPaginas`) e grava a coluna `familia` em `account='oben'` → o produto novo já está em `omie_products` com a família, faltando só a marca.

Função **`tint_marcar_bases_mixmachine()`** (`SECURITY DEFINER`, `REVOKE` de anon/authenticated/public) + cron **`tint-marcar-bases-diario`** (`0 11 * * *`, SQL local sem `net.http_post`): marca `is_tintometric=true` + `tint_type` por família, **idempotente e aditivo**. Migration `20260614210000_tint_cobertura_bases_mixmachine.sql`. PG17 `db/test-tint-cobertura.sh` (A1-A4: marca faltante, corrige drift de `tint_type`, ignora não-elegível, idempotente).

**Codex consult (2026-06-14):** `is_tintometric` é flag OPERACIONAL de venda (abre o fluxo de cor em `useCart`/`useSalesOrderEdit`/`replicar-pedido`) — mas marcar por família é CONSISTENTE com o que o `tint-omie-sync` já faz pras 106 bases existentes (não introduz comportamento novo). Fixes incorporados: corrige drift de `tint_type` (não só ausência); usa `familia` autoritativa (sem fallback `metadata`, que é jsonb compartilhado e sofre sobrescrita).

**Não-feito (registrado, decisão consciente):**
- **Vigia no Sentinela** — bases elegíveis não-marcadas / `tint_type` divergente / vínculo com produto inativo ou ausente / produto Omie vinculado a >1 SKU (FK não garante unicidade). É a rede que pega quando o cron falha ou o drift acontece. ⚠️ toca `_data_health_compute` (arquivo quente multi-sessão, risco de cascata — fazer com o pré-flight do CLAUDE.md).
- **Desmarcar drift** ("saiu da família"/"ficou inativo") — NÃO automatizar: desmarcar base já mapeada (`tint_skus.omie_product_id`) transformaria a base em produto vendido sem cor. O vigia acima sinaliza; a ação fica humana.
- **Aposentar o `tint-omie-sync`** (redundante com o sync geral exceto o botão manual de `TintImport` + retry de rate-limit) — e o upsert dele regrava `metadata` incompleto. Refactor maior.
- **Desenho "ideal" do Codex** (tela de mapeamento lista candidatos por família e só marca `is_tintometric` na aprovação humana) — desacopla a semântica dual do flag; refactor de maior porte, fora do escopo desta sessão.

## Validação

- Motor: testes vitest com fixtures dos casos **reais** (WJOB/WJOI.7796 em QT/GL/BH/405/810ML; JO10.7644.00; JLO.7581.00) — incl. o caso-borda WJOB vs WJOI.
- **Codex challenge** no algoritmo de matching (casos-borda de string — é o que ele pega bem).
- `bun run typecheck` (strict) + `bun lint` + `bun run test` + `bun run build`, via `heavy`.
- Empírico: founder mapeia a WJOB.7796 galão (que estava escondida) pela tela nova.

## Apêndice — SQL do backfill (rodado em prod 2026-06-14; rastreabilidade)

UPDATE ad-hoc (NÃO virou migration — o conserto durável é o follow-up do sync). Marcou **13 ativos** (8 bases + 5 concentrados), incl. `PRD03644` (WJOB.7796 GL). Os 59 não tocados são `ativo=false`.

```sql
update omie_products
set is_tintometric = true,
    tint_type = case
      when lower(btrim(coalesce(nullif(btrim(familia),''), metadata->>'descricao_familia'))) = 'bases mixmachine' then 'base'
      when lower(btrim(coalesce(nullif(btrim(familia),''), metadata->>'descricao_familia'))) = 'concentrados mixmachine' then 'concentrado'
    end,
    updated_at = now()
where account = 'oben'
  and ativo = true
  and lower(btrim(coalesce(nullif(btrim(familia),''), metadata->>'descricao_familia'))) in ('bases mixmachine','concentrados mixmachine')
  and is_tintometric is not true;
```

Reverter (se preciso): `set is_tintometric=false, tint_type=null` no mesmo filtro — ⚠️ reverteria também os pré-existentes; escopar por `updated_at` se quiser só os do backfill.

