# Plano — preço tintométrico auto-suficiente (Omie) → aposentar o CSV (flip)

> **Continuação de sessão (15/06 noite).** O motor set-based da promoção já está PRONTO e em prod
> (PR #858 mergeado; migrations `20260615140000` índices + `20260615160000` set-based aplicadas).
> O flip pra `automatic_primary` **não trava por código nem por timeout** — trava por **PREÇO**.
> Este doc é o handoff: a sessão nova começa pelo §"Plano ordenado" sem re-investigar.

## Onde paramos (estado real, descoberto via psql-ro em prod)

- **Balcão SEGURO:** `tint_integration_settings` (oben/M01) = `shadow_mode`, `sync_enabled=true`.
  Oficial = CSV puro (481.721 fórmulas ativas, todas com `preco_final_sayersystem` preenchido).
  Venda 100% normal. **Nada quebrado.**
- **Motor set-based:** aplicado em prod. Expansão de 484k roda em **2,6s** (read puro, medido por
  EXPLAIN ANALYZE). As ESCRITAS (2,1M itens) é que estouram o **timeout HTTP do EDITOR** (não o do
  banco — o banco tem 300s) → foi o "Query failed" repetido do founder no pré-flight interativo.

## O bloqueador REAL do flip: preço

A promoção é **NULL-honesta**: sem dado de preço no staging → `preco_final_sayersystem = NULL`.
E o staging **não tem preço** (`tint_staging_precos_base = 0`, corantes sem custo = 0 — o conector
não sincroniza preço). Então rodar o bootstrap **zeraria os 481k preços do CSV**.

E esse campo é **load-bearing na venda**: `useTintColorSelect.ts` (linhas ~316/323/327-333) usa
`preco_final_sayersystem` como fonte 'tabela' (preço auto-selecionado quando válido); só cai pro
'calculado' (Omie base+corantes) quando ele falta. Tela `TintPricing.tsx` e lista `TintFormulas.tsx`
também exibem ele.

## Decisão do founder (15/06): **preço calculado no app, auto-suficiente**

> "O preço é possível ser feito dentro do aplicativo: cálculo das quantidades × preços de venda."
> "Existem bases que eu não utilizo e nem vou comprar — não faz sentido me preocupar com elas.
>  Caso eu compre no futuro, deixar uma solução pronta; idem se eu parar de comprar."

Desenho certo (auto-cura, sem mapa por cor):
- **Preço = base (Omie, via vínculo do SKU) + Σ (qtd_corante × preço Omie / volume)**. A receita
  (qtds) vem do **sync**; os preços vêm do **Omie**. Motor já existe: `src/lib/tint/compute-price.ts`.
- Vincular a base ao Omie **uma vez por base que se vende** (tela Mapeamento,
  `/tintometrico/catalogo?tab=mapeamento`, `TintMapping.tsx`). Base não-vendida → sem preço, tudo bem.
- Começou a vender base nova → vincula 1×, funciona. Parou → não faz nada. **Sem manutenção.**

## Cobertura de vínculo Omie (medido em prod, 15/06)

- **Corantes: 14/14 vinculados ✅** (lado dos corantes pronto).
- **SKUs (base): 81/220 vinculados.** 139 sem vínculo, divididos em:
  - **A) 67 SKUs / 7 famílias NÃO existem no Omie** (candidatas a "não uso" — founder confirma):
    `NO22.9836 NC Fosco`, `NB.9142 NC Brilhante`, `FO87.6782 PU Semi Fosco`,
    `FO5.6837 PU Microtex Multiuso`, `JO10.7583 Acrílico Fosco Finíssimo`, `FL.6344 PU Fundo`,
    `JO20.7658 Acrílico Multiuso Met Max Fosco`.
  - **B) 72 SKUs existem no Omie, só falta vincular** (25 batem por descrição automática:
    base-code `W??X.NNNN` + volume token `405ML`/`450ML`[typo Omie]/`QT`=810/`GL`=3240/`BH`=18000;
    resto ambíguo/variação → revisão).
- **Sem histórico de vendas no banco** (`tint_vendas_itens = 0`) → impossível auto-detectar "vendido".
  Só o founder sabe quais bases usa; o desenho auto-suficiente não precisa que o agente saiba.

## Plano ordenado (próxima sessão — money-path, com teste)

1. **Fix `custoBase=0` (CORAÇÃO).** Garantir que a BASE entra no preço calculado. `compute-price.ts`
   retorna `custoBase:0` de propósito (a base é somada pelo caller `useTintColorSelect` via
   `precoBase = product.valor_unitario`). Auditar TODOS os caminhos de preço (inclusive a RPC
   `get_tint_price`, que o founder disse incluir só corantes) e garantir base+corantes em todos.
   Vitest de paridade + (se mexer em SQL) PG17.
2. **App preferir o preço Omie calculado** quando a base está vinculada; base SEM vínculo →
   mostrar **"base sem preço — vincular no Omie"** (não R$ 0). Isso é a auto-cura visível: ao
   adicionar uma base nova, fica óbvio + acionável. (Reordenar `autoSource` em `useTintColorSelect`.)
   - Nota: nulificar `preco_final_sayersystem` já faz `autoSource` cair pra 'calculado' sozinho;
     decidir se nula (depende 100% do Omie) OU preserva como fallback (COALESCE) pra base sem vínculo.
3. **Bootstrap server-side (sem timeout do editor).** Promover UM run de catálogo que cobre os 56
   pares (qualquer um com 220 skus, ex.: `1589f4be-2052-4070-a34e-68be5fb60050`) → `_tp_sku` = 56
   pares → `_pares` = todos → expande tudo numa chamada. Rodar via **pg_cron one-shot** (`cron.schedule`
   → roda → `cron.unschedule`), NÃO no editor interativo (HTTP timeout). Idempotente. Se §2 escolher
   preservar preço, ajustar a promoção (COALESCE no `preco_final_sayersystem`) + PG17.
4. **Flip:** `tint_integration_settings ... integration_mode='automatic_primary'` — **sem resetar
   `state.json`** (evita re-scan storm: cada run toca ~48/56 pares → re-expansão quase completa; o
   conector já mandou tudo pro staging em shadow). Deltas futuros são pequenos. Verificar (cores
   novas entrando, preço calculado correto). **CSV aposentado.**

## Armadilhas confirmadas (não repetir)

- **NÃO** rodar a promoção pesada no SQL Editor interativo → "Query failed" = timeout HTTP do editor
  (o banco aguenta; é a espera do editor que estoura). Bootstrap pesado = server-side (cron).
- **NÃO** resetar `state.json` no flip (re-scan de 605 runs × ~48 pares = redundância brutal).
- Promoção set-based já cobre colisão de chave oficial (subcoleção NULL vs whitespace + personalizada)
  — desempate `COALESCE(subcolecao,'') DESC, personalizada DESC` (achado P1 do Codex, corrigido).
- `psql-ro` (`~/.config/afiacao/psql-ro`) é só leitura — diagnóstico o agente roda sozinho; escrita
  é o founder colando no SQL Editor.

## Backlog pós-flip (v1.5, já levantado com o founder)

- "Banco de cores excluídas": as ~150 cores que o keys-snapshot desativa (revisar/perguntar à
  Sayerlack o motivo; manter arquivada ou reativar caso-a-caso). Tela de revisão.
- Histórico de versão de fórmula + "listagem do dia" do operador (dosagem manual de receitas
  não-originais).
- Cor custom cadastrada 1× refletindo em TODOS os acabamentos (regra de afinidade W??X.NNNN).
