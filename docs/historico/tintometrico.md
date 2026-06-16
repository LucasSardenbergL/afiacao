# Tintométrico — entregas e lições

Narrativa das entregas do módulo tintométrico (`/tintometrico/*`, account `oben`). Registre aqui ao concluir; regras vivas vão pro CLAUDE.md, lição reutilizável pra `docs/agent/`.

---

## Vínculo `tint_skus` ↔ Omie — resgate de 62 cores que somem do seletor (2026-06-15, [PR #870](https://github.com/LucasSardenbergL/afiacao/pull/870))

### Problema
Cores fabricáveis (fórmula ativa) somiam do seletor de venda (`src/components/tintColorSelect/useTintColorSelect.ts`): a busca descarta SKU sem produto Omie (`.not('omie_product_id','is',null)` + `if (!sku?.omie_product_id) continue`). Havia **139 `tint_skus` (`oben`) com `omie_product_id NULL`**. O founder suspeitava que os produtos Omie existiam e só faltava o vínculo (`UPDATE tint_skus SET omie_product_id`), e pediu **certeza de que o produto não existe antes de tratar como ausência** — nunca remover SKU nem fabricar vínculo.

### Diagnóstico
Auditoria read-only iterativa (founder colava no SQL Editor; cada query validada antes em PG17 local). Achados que reorientaram a tarefa:
- **Medir por COR, não por SKU.** Uma cor só some se **todos** os seus SKUs forem órfãos. Dos 8.489 cores: **102 somem**, 8.360 parciais (vendem em alguma embalagem), 27 completas. Os "139 SKUs órfãos" superestimavam — 40% eram balde **BH (18 L)** de cores que já vendiam em GL/QT.
- **O SKU é compartilhado por muitas cores.** `tint_skus` = (base × embalagem × acabamento), **sem cor**; a cor vive em `tint_formulas.sku_id`. Logo **vincular 1 SKU resgata todas as cores que o usam** (ex.: `WJOB.7658 QT` → 54 cores ACR MAX de uma vez).
- **Chave de matching real:** código-base Sayer + sigla de embalagem na **descrição** do Omie (`...WJOI.7796GL`). `codigo_etiqueta` era 100% NULL e `omie_products.codigo` é PRD interno — inúteis. Sigla colada (GL/QT/BH) ou volume com espaço (`405ML`/`810ML`). Não confiar em "FOSCA/BRILHO" textual (`BRIL 05` = fosca). Prefixos alternativos pro mesmo número (`WJAB.7585` vs `WJOB.7585`) são linhas antigas, quase sempre inativas.
- **Resultado:** das 102, **62 resgatáveis** (produto Omie existe e ativo, só faltava vínculo — concentradas em `WJOB.7658`=54 e `WFOB.6564`=8) e **40 legítimas** — produtos que o negócio não vende/compra (corretas sumindo; decisão do founder de não cadastrar/reativar). O caso âncora 346J estava OK (vende em GL/QT/405; só o balde BH órfão).

### Fix
Migration `20260615182814_vincular_tint_skus_omie_orfaos.sql`: 4 `UPDATE tint_skus` **idempotentes** (só toca `omie_product_id IS NULL`) com **guard falha-fechada** — `EXISTS` produto `oben` ativo: ID errado ou produto inativo ⇒ não grava (nunca seta lixo nem NULL). 2 dos 4 resgatam as 62 cores; 2 completam cobertura.

### Verificação (camadas)
- PG17 local: idempotência (UPDATE 1 → UPDATE 0), guard barrando produto inativo, query de resgate exato.
- Banco (founder rodou): 4 vínculos ✅ ativos, resgate = **62** confirmado.
- App: founder confirmou **"preto metálico apareceu na hora"** no seletor (sem Publish — é dado; cache React Query/PWA).
- Saúde de Dados: query de ambiguidade (mesmo critério do vigia `tint_vinculo_omie`: produto em >1 SKU ativa) veio **vazia** → não criou par ambíguo, vigia verde.

### Lições (reutilizáveis)
1. **Impacto de catálogo mede-se na entidade que o usuário vê (cor), não na tabela técnica (SKU).** Contar SKUs órfãos exagera; contar cores com 0 SKU vendável é a verdade.
2. **`tint_skus` não tem cor** — é base×embalagem×acabamento, compartilhado por N fórmulas. 1 vínculo resgata N cores; ao consertar, pense em cores impactadas, não SKUs.
3. **Matching tint↔Omie:** código-base Sayer + sigla de embalagem na **descrição** do Omie. Ignore `codigo_etiqueta` (NULL) e `codigo` (PRD interno). Cuidado com prefixo alternativo (linha antiga inativa) e com "FOSCA/BRILHO" textual.
4. **Money-path "ausente ≠ ausência":** comprovar contra o catálogo **completo** + prefixos alternativos antes de declarar que não há produto. Aqui separou 62 reais de 40 descontinuadas sem remover nem inventar nada.
5. **Cross-join `ILIKE '%x%'` estoura o `statement_timeout` do SQL Editor** (wildcard nas 2 pontas = não-sargável). Pivotar pra extrair o token com regex e **JOIN por igualdade** (`=`/`IN`).
6. **Vínculo de catálogo = UPDATE idempotente + guard falha-fechada** (`WHERE ... IS NULL AND EXISTS produto ativo`). Depois, conferir o vigia `tint_vinculo_omie` (produto em >1 SKU ativa = par ambíguo que suja a Saúde de Dados).
7. **Validar cada SQL no PG17 local antes de mandar pro founder colar** — ele não tem terminal; query errada queima a vez dele (padrão `db/test-*.sh`).

### Coordenação
Sessão paralela entregou `20260615133000_tint_remapeia_skus_omie_desalinhadas.sql` (conserta 4 SKUs com vínculo **errado** — disjunto dos 4 NULL desta). Sem colisão de SKU/produto; conflito de merge foi só nos audits gerados (resolvido por `bun run audit:migrations`).
