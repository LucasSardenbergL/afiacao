# Fase 1 — De-para de fornecedor automático (cold-start Sayerlack) — money-path

> Worktree `epic-elgamal-c31355`. Diagnóstico + Codex em sessão de 2026-06-26.
> Objetivo: itens compráveis sem de-para (cold-start, ex. FOA05) ganham de-para Sayerlack
> automático, deixando de ser invisíveis. **Fase 1 NÃO faz o item aparecer na fila** — isso
> depende da Fase 2 (parâmetro). De-para sozinho remove um bloqueio sem disparar compra.

## Diagnóstico (provado em prod, read-only)

O motor de reposição só enxerga SKU com **venda nos últimos 90d** (`venda_items_history` →
`v_sku_demanda_estatisticas` → `v_sku_classificacao_abc_xyz` → `v_sku_parametros_sugeridos` →
`atualizar_classificacao_skus` cria a linha em `sku_parametros`). Itens novos/renomeados (0 venda
sob o código novo) ficam fora de tudo. Duas travas: (1) sem de-para de fornecedor [DOMINANTE,
214/215 cold-start]; (2) sem parâmetro [172 + 215].

- Parser `src/lib/reposicao/sayerlack-sku.ts` extrai o código do portal da descrição Omie.
  Rodado contra os **189 de-paras manuais → 185 batem, 0 divergem, 4 não-validáveis (100%)**.
- Dos 214 cold-start sem de-para, parser resolve **65 seguros** (incl. FOA05 `12101724207`/`...210`);
  149 sem código Sayerlack (serras/adesivos — manuais).
- FOA05: hoje a descrição no Omie é `VERNIZ PU FOA05.6717.00BH` → parser extrai `FOA05.6717.00BH`.
  ⚠️ CONFIRMAR com o founder se o código real Sayerlack é `FOA05` ou `FOA5` (ele renomeou "apaguei o 0").

## Decisões (founder + Codex consult, session 019f0547-d379-77e1-a9e9-4829e523a373)

- Autonomia: **calcular + fazer aparecer; founder dá o aceite da compra**. NÃO auto-comprar.
- Apetite cold-start (Fase 2): **conservador, mínimo operacional**.
- Arquitetura (Codex): **híbrido B+** — parser espelhado em `_shared` (NÃO portar regex p/ SQL),
  edge calcula+valida gabarito, **RPC SQL transacional faz o insert** (auditável), acionada
  **após o sync do Omie** (não cron cego). Sequência **Fase 1 (de-para) → Fase 2 (parâmetro)**.
- Gates money-path do Codex: (a) só seguros (1 match); (b) trava se `validarGabarito` ≠ 0 divergências;
  (c) insert-only nunca sobrescreve; (d) **gate de colisão de destino** (sku_portal já ativo p/ outro SKU);
  (e) auditoria (parser version, descrição, extraído); (f) espelhar TODOS os guards do motor na view.
- Risco residual aceito: descrição Omie errada → 1 match limpo mas ERRADO (GIGO). Mitigado por
  colisão + alerta de auto-insert. A descrição do Omie É a fonte da verdade do código do portal.

## Tijolos

- [x] **1. Parser espelhado + paridade** — `supabase/functions/_shared/sayerlack-sku.ts` (byte-idêntico)
  + `src/lib/reposicao/__tests__/sayerlack-sku.parity.test.ts`. 65 testes verdes, falsificação OK, typecheck 0.
- [x] **2+3. View + audit + RPC** — `supabase/migrations/20260626193000_reposicao_depara_sayerlack_auto.sql`.
  PROVADO no PG17 (`db/test-reposicao-depara-auto.sh`): 6 grupos de asserts (elegibilidade, ins/col/exi/nel,
  efeito no banco, idempotência, gate service_role 42501, FALSIFICAÇÃO do gate de colisão). Todos verdes.
- [x] **4. Edge `reposicao-depara-sayerlack-auto`** — `supabase/functions/reposicao-depara-sayerlack-auto/index.ts`.
  Gate de gabarito (aborta se parser regrediu / base < 20) + chama a RPC. `deno check` verde.
- [x] **5. Acionamento** — cron `0 4 * * *` (após omie-sync-status-produtos 3:30, antes de gerar-pedidos 9:15).
  Bloco SQL no pacote de deploy (net.http_post + timeout_milliseconds, não vai pra migration: depende de vault/net).
- [ ] **6. Empacotar + entregar** — pacote de deploy (SQL Editor + edge no chat Lovable) + verificação por comportamento.

## SQL desenhado (PROVAR no PG17 antes de entregar — money-path)

### Tijolo 2 — view (objeto NOVO, sem CREATE OR REPLACE de prod)
```sql
CREATE OR REPLACE VIEW public.v_reposicao_depara_sayerlack_elegivel
WITH (security_invoker='on') AS
SELECT 'OBEN'::text AS empresa, op.omie_codigo_produto::text AS sku_omie,
       op.descricao AS sku_descricao, op.familia
FROM public.omie_products op
LEFT JOIN public.sku_status_omie sso
  ON sso.empresa='OBEN' AND sso.sku_codigo_omie = op.omie_codigo_produto::text
LEFT JOIN public.familia_nao_comprada fnc
  ON fnc.empresa='OBEN' AND fnc.familia = op.familia
WHERE op.account='oben' AND op.ativo=true
  AND COALESCE(op.tipo_produto, op.metadata->>'tipo_produto','') <> '04'
  AND COALESCE(op.valor_unitario,0) > 0
  AND COALESCE(op.descricao,'') NOT ILIKE '%450ML'
  AND COALESCE(op.descricao,'') NOT ILIKE '%405ML'
  AND fnc.id IS NULL
  AND COALESCE(sso.ativo_no_omie,true)=true
  AND NOT EXISTS (SELECT 1 FROM public.sku_fornecedor_externo fe
                  WHERE fe.empresa='OBEN' AND fe.sku_omie = op.omie_codigo_produto::text
                    AND fe.ativo=true AND fe.fornecedor_nome ILIKE '%SAYERLACK%');
```

### Tijolo 3 — audit + RPC
```sql
CREATE TABLE IF NOT EXISTS public.reposicao_depara_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid, criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL DEFAULT 'OBEN', sku_omie text NOT NULL, sku_descricao text,
  sku_portal_extraido text, parser_version int,
  resultado text NOT NULL CHECK (resultado IN ('inserido','colisao_destino','ja_existe','nao_elegivel')),
  detalhe text
);
ALTER TABLE public.reposicao_depara_auto_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY depara_auto_log_sel ON public.reposicao_depara_auto_log FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

CREATE OR REPLACE FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(
  p_candidatos jsonb, p_parser_version int DEFAULT NULL, p_run_id uuid DEFAULT NULL
) RETURNS TABLE(inseridos int, colisao_destino int, ja_existe int, nao_elegivel int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_ins int:=0; v_col int:=0; v_exi int:=0; v_nel int:=0; c record; v_res text; v_det text;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role' THEN
    RAISE EXCEPTION 'acesso negado: requer service_role' USING ERRCODE='42501';
  END IF;
  FOR c IN SELECT * FROM jsonb_to_recordset(p_candidatos)
           AS x(sku_omie text, sku_portal text, unidade_portal text, sku_descricao text) LOOP
    v_det := NULL;
    IF EXISTS (SELECT 1 FROM sku_fornecedor_externo fe WHERE fe.empresa='OBEN'
               AND fe.fornecedor_nome ILIKE '%SAYERLACK%' AND fe.sku_omie=c.sku_omie) THEN
      v_res:='ja_existe'; v_exi:=v_exi+1;
    ELSIF EXISTS (SELECT 1 FROM sku_fornecedor_externo fe WHERE fe.empresa='OBEN'
               AND fe.fornecedor_nome ILIKE '%SAYERLACK%' AND fe.ativo=true
               AND upper(btrim(fe.sku_portal))=upper(btrim(c.sku_portal)) AND fe.sku_omie<>c.sku_omie) THEN
      v_res:='colisao_destino'; v_col:=v_col+1; v_det:='sku_portal já mapeado p/ outro SKU';
    ELSIF NOT EXISTS (SELECT 1 FROM v_reposicao_depara_sayerlack_elegivel e WHERE e.sku_omie=c.sku_omie) THEN
      v_res:='nao_elegivel'; v_nel:=v_nel+1;
    ELSE
      INSERT INTO sku_fornecedor_externo (empresa,fornecedor_nome,sku_omie,sku_portal,unidade_portal,fator_conversao,ativo,observacoes)
      VALUES ('OBEN','RENNER SAYERLACK S/A',c.sku_omie,c.sku_portal,COALESCE(NULLIF(c.unidade_portal,''),'UN'),1,true,
              'extraído automaticamente (parser v'||COALESCE(p_parser_version::text,'?')||', cold-start)')
      ON CONFLICT (empresa,fornecedor_nome,sku_omie) DO NOTHING;
      IF FOUND THEN v_res:='inserido'; v_ins:=v_ins+1; ELSE v_res:='ja_existe'; v_exi:=v_exi+1; END IF;
    END IF;
    INSERT INTO reposicao_depara_auto_log (run_id,empresa,sku_omie,sku_descricao,sku_portal_extraido,parser_version,resultado,detalhe)
    VALUES (p_run_id,'OBEN',c.sku_omie,c.sku_descricao,c.sku_portal,p_parser_version,v_res,v_det);
  END LOOP;
  RETURN QUERY SELECT v_ins,v_col,v_exi,v_nel;
END $$;
REVOKE ALL ON FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(jsonb,int,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(jsonb,int,uuid) TO service_role;
```

### Prova PG17 (db/test-reposicao-depara-auto.sh) — asserts obrigatórios
1. seed catálogo: 1 elegível c/ código (insere), 1 com de-para já ativo (ja_existe),
   1 fabricado '04' (nao_elegivel), 1 colisão (2 SKUs → mesmo sku_portal → 2º = colisao_destino).
2. positivo: elegível vira 1 linha em sku_fornecedor_externo + audit 'inserido'.
3. negativo: colisão NÃO insere + audit 'colisao_destino' (re-raise SQLSTATE não esperada).
4. idempotência: rodar 2× → 2ª rodada tudo 'ja_existe', 0 inseridos.
5. gate: SET ROLE/`auth.role()` ≠ service_role → 42501 (no PG17, stubar auth.role()).
6. **falsificar**: remover o gate de colisão → exigir vermelho (2ª linha colidida inserida).

## Tijolo 4 — edge `reposicao-depara-sayerlack-auto` (esboço)
- `authorizeCronOrStaff`. Importa parser de `../_shared/sayerlack-sku.ts`.
- fetchAll `v_reposicao_depara_sayerlack_elegivel` (paginado, fura cap 1000).
- Busca mapeamentos manuais Sayerlack OBEN ativos + descrições (omie_products) → `validarGabarito`.
  **Se `divergem.length > 0` → ABORTA** (não grava, retorna alerta — parser regrediu).
- `sugerirMapeamentos(elegiveis)` → `seguros`.
- Chama RPC `reposicao_aplicar_depara_sayerlack_auto(seguros, PARSER_VERSION, run_id)`.
- Loga contagem (inseridos/colisao/ja_existe/nao_elegivel) + alerta se inseridos>0 (diff p/ revisão).

## Tijolo 5 — acionamento
- Cron chamando a edge ~15min após `omie-sync-status-produtos` (que atualiza descrições).
- `net.http_post` com `timeout_milliseconds` explícito (armadilha do default 5s — sync.md).

## Fase 2 — parâmetro de fallback cold-start (DESIGN PRELIMINAR, não implementado)

> O que de fato faz o item APARECER na fila (o objetivo original do founder). Aguarda o "vai" dele.
> Money-path: decide quanto comprar de item sem histórico. Ritual: Codex + PG17 + falsificação.

- **Universo:** SKUs compráveis COM de-para Sayerlack ativo (pós-Fase 1) que NÃO têm linha em
  `sku_parametros` (cold-start puro, ex. FOA05) OU têm linha sem `ponto_pedido`/`estoque_maximo`.
  A função `atualizar_classificacao_skus` só cria linha p/ quem está em `v_sku_parametros_sugeridos`
  (= vendeu em 90d), então a Fase 2 precisa de lógica PRÓPRIA de criação de linha (não reusa essa).
- **Fallback conservador (founder escolheu "mínimo operacional"):** `estoque_minimo=1`, `ponto_pedido=1`
  (compra quando posição ≤ 1), `estoque_maximo = ponto_pedido + lote_minimo_fornecedor` (=2 default),
  `estoque_seguranca=0`, `habilitado_reposicao_automatica=true`, `tipo_reposicao='automatica'`,
  `fornecedor_nome` = do de-para (RENNER SAYERLACK). Marcar a linha como cold-start (origem/flag).
- **⚠️ ARMADILHA DO FUSÍVEL (achado no research):** `atualizar_parametros_numericos_skus` tem fusível
  `max_sug > 3*max_antes → 'segurado'`. Um fallback `max_antes=2` é PLACEHOLDER, não valor real;
  quando a 1ª demanda real chega e sugere, digamos, 10, `10 > 3*2=6 → segurado` → o item fica PRESO
  no fallback conservador mesmo com demanda. Fix: a transição cold-start→primeira-demanda-real precisa
  BYPASSAR o fusível (ex.: marcar a linha como placeholder e o core aplicar o sugerido sem fusível na
  1ª vez; ou não contar o placeholder como `max_antes`). Provar no PG17 que o item "gradua" do fallback
  para o valor real assim que vende.
- **Não auto-aprova:** o item passa a aparecer na fila; o founder dá o aceite (decisão da Fase 1 mantida).
- Sequência: roda no cron APÓS a Fase 1 (de-para) e a `preencher_parametros_faltantes_skus` (8:00 UTC).

## Deploy (founder cola; Lovable não auto-aplica)
1. SQL Editor: migration tijolo 2+3 (idempotente) → validação pós-apply.
2. Chat Lovable: deploy da edge verbatim de `supabase/functions/reposicao-depara-sayerlack-auto/index.ts`.
3. SQL Editor: migration do cron (tijolo 5).
4. `bun run audit:migrations` + commit. Verificar por comportamento (rodar a edge 1×, conferir audit).
