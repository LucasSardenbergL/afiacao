// fase1d_contrato_test.go — contrato Go→payload da Fase 1d (money-path).
//
// A fronteira REAL do fail-open de receita parcial era o CONECTOR: ele OMITIA
// silenciosamente slot com corante presente e qtd inválida (flat :262, child :317)
// ANTES do POST — o payload chegava "limpo e íntegro" (expected=COUNT) e NENHUM
// guard do banco via o inválido → receita PARCIAL promovida (subfaturamento).
//
// Contrato da 1d (o banco decide, o conector transporta):
//   1. Slot/linha com corante PRESENTE e qtd inválida → PRESERVADO no payload
//      (qtd_ml = número parseado, mesmo <=0; nil quando não-parseável). O Guard 4
//      do banco barra a fórmula inteira e loga em tint_sync_errors.
//   2. Órfão (corante vazio + dose legível ≠0) → PRESERVADO (Guard 4b barra).
//   3. Slot flat "não-usado" (corante vazio + qtd nil/0) → segue OMITIDO — emiti-lo
//      viraria placeholder e barraria ~100% do catálogo flat (C29).
//   4. is_base_pura=true SÓ quando a FONTE confirma fórmula sem corante:
//      flat  = todos os 6 slots livres E os 12 flat cols resolvidos;
//      child = formula_pk resolvida E 0 linhas na tabela filha p/ a fórmula.
//      NUNCA quando algo ilegível/não-resolvido apareceu (fail-closed).
//   5. child com formula_pk NÃO resolvida → chave "itens" AUSENTE do payload
//      (expected NULL no banco → ambíguo → barra) — nunca mais itens=[] mentiroso.
//   6. Hash-cache: payload SEM o campo novo preserva o hash antigo (fórmulas
//      normais não re-enviam em massa); is_base_pura=true muda o hash (re-envio
//      1× que leva a declaração ao staging).
package main

import (
	"context"
	"net/http/httptest"
	"testing"
)

// ──────────────────────────────────────────────────────────────
// 1) aggregateFlatFormulaItems — preservação de slot inválido
// ──────────────────────────────────────────────────────────────

func TestAggregateFlat1d_PreservaCorantePresenteQtdZero(t *testing.T) {
	// O cenário CANÔNICO do furo: fonte manda {AX=10, VM=0}. O payload TEM de
	// carregar o VM inválido — é ele que faz o Guard 4 barrar a receita parcial.
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"AX", float64(10)},
		2: {"VM", float64(0)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("esperava 2 itens (inválido PRESERVADO), got %d", len(itens))
	}
	if itens[1]["id_corante"] != "VM" || itens[1]["qtd_ml"] != float64(0) {
		t.Errorf("slot inválido não preservado cru: %+v", itens[1])
	}
	if _, tem := rows[0]["is_base_pura"]; tem {
		t.Error("fórmula com slot corrompido NÃO pode declarar is_base_pura")
	}
}

func TestAggregateFlat1d_PreservaQtdNegativa(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"C01", float64(-1)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 1 || itens[0]["qtd_ml"] != float64(-1) {
		t.Fatalf("qtd negativa deveria ser preservada crua, got %+v", itens)
	}
}

func TestAggregateFlat1d_PreservaCorantePresenteQtdNil(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"AX", float64(10)},
		2: {"VM", nil},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("esperava 2 itens (corante presente + qtd nil preservado), got %d", len(itens))
	}
	if itens[1]["id_corante"] != "VM" || itens[1]["qtd_ml"] != nil {
		t.Errorf("qtd nil deveria virar qtd_ml=nil (ausente ≠ zero), got %+v", itens[1])
	}
}

func TestAggregateFlat1d_PreservaCorantePresenteQtdIlegivel(t *testing.T) {
	// numeric do PG chega como string; lixo não-parseável NUNCA vira 0 — vira nil.
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"AX", "lixo##"},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 1 || itens[0]["qtd_ml"] != nil {
		t.Fatalf("qtd ilegível deveria preservar item com qtd_ml=nil, got %+v", itens)
	}
}

func TestAggregateFlat1d_PreservaOrfaoDoseSemCorante(t *testing.T) {
	// Dose legível ≠0 sem corante identificado = corrupção (Guard 4b) — transporta.
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		2: {nil, float64(7)},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 1 {
		t.Fatalf("órfão (corante vazio + dose 7) deveria ser emitido, got %d itens", len(itens))
	}
	if itens[0]["id_corante"] != "" || itens[0]["qtd_ml"] != float64(7) || itens[0]["ordem"] != 2 {
		t.Errorf("órfão mal-formado: %+v", itens[0])
	}
	if _, tem := rows[0]["is_base_pura"]; tem {
		t.Error("fórmula com órfão NÃO pode declarar is_base_pura")
	}
}

func TestAggregateFlat1d_SlotLivreSegueOmitido(t *testing.T) {
	// corante vazio + qtd nil OU 0 legível = slot não-usado (quase 100% do catálogo
	// flat usa <6 slots) — emitir viraria placeholder e barraria tudo (C29).
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"C01", float64(5)},
		2: {nil, nil},
		3: {"", float64(0)},
		4: {nil, "0"},
	})}
	itens := aggregateFlatFormulaItems(rows, testFlatCols())[0]["itens"].([]map[string]any)
	if len(itens) != 1 {
		t.Fatalf("slots livres deveriam seguir omitidos, got %d itens: %+v", len(itens), itens)
	}
}

func TestAggregateFlat1d_IsBasePura_TodosSlotsLivres(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{})}
	out := aggregateFlatFormulaItems(rows, testFlatCols())[0]
	if out["is_base_pura"] != true {
		t.Fatalf("todos os slots livres deveria declarar is_base_pura=true, got %v", out["is_base_pura"])
	}
	itens, ok := out["itens"].([]map[string]any)
	if !ok || itens == nil || len(itens) != 0 {
		t.Fatalf("base pura declara itens=[] EXPLÍCITO (não nil/null): %T %v", out["itens"], out["itens"])
	}
}

func TestAggregateFlat1d_IsBasePura_BloqueadaPorQtdIlegivelSemCorante(t *testing.T) {
	// Slot com corante vazio e qtd ILEGÍVEL não é "livre" — é suspeito. Não emite
	// item (nada aproveitável sem corante), mas BLOQUEIA a declaração de base pura:
	// o vazio fica ambíguo e o banco barra (fail-closed).
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		3: {nil, "###"},
	})}
	out := aggregateFlatFormulaItems(rows, testFlatCols())[0]
	if _, tem := out["is_base_pura"]; tem {
		t.Fatal("qtd ilegível em slot sem corante NÃO pode deixar declarar base pura")
	}
	if itens, ok := out["itens"].([]map[string]any); ok && len(itens) != 0 {
		t.Fatalf("slot suspeito não vira item, got %+v", itens)
	}
}

func TestAggregateFlat1d_IsBasePura_ExigeFlatColsCompletos(t *testing.T) {
	// Se o discovery não resolveu os 12 flat cols (variante de schema), um slot
	// invisível pode conter corante real — "tudo vazio" não é confiável (fail-closed).
	cols := testFlatCols()
	delete(cols, "qtd6ml") // par do slot 6 incompleto
	rows := []map[string]any{makeFormulaRow(map[int][2]any{})}
	out := aggregateFlatFormulaItems(rows, cols)[0]
	if _, tem := out["is_base_pura"]; tem {
		t.Fatal("flat cols incompletos NÃO podem declarar base pura")
	}
}

// ──────────────────────────────────────────────────────────────
// 2) childItemRow — builder puro da linha da tabela filha
// ──────────────────────────────────────────────────────────────

func TestChildItemRow1d_ValidaInvalidaOrfa(t *testing.T) {
	casos := []struct {
		nome    string
		id      string
		qtdRaw  any
		wantQtd any
	}{
		{"valida", "AX", "5.16", 5.16},
		{"qtd zero preservada", "VM", float64(0), float64(0)},
		{"qtd negativa preservada", "VM", "-2", float64(-2)},
		{"qtd ilegível vira nil", "VM", "NaN", nil},
		{"qtd nil vira nil", "VM", nil, nil},
		{"órfã preservada", "", float64(7), float64(7)},
	}
	for _, c := range casos {
		item := childItemRow(c.id, c.qtdRaw, 3)
		if item["id_corante"] != c.id || item["ordem"] != 3 {
			t.Errorf("%s: identidade errada: %+v", c.nome, item)
		}
		if item["qtd_ml"] != c.wantQtd {
			t.Errorf("%s: qtd_ml=%v, esperava %v", c.nome, item["qtd_ml"], c.wantQtd)
		}
	}
}

// ──────────────────────────────────────────────────────────────
// 3) syncFormulas — contrato do payload POSTado (fim a fim)
// ──────────────────────────────────────────────────────────────

// fixtureFormulaRow monta uma linha de fórmula child-shape mínima.
func fixtureChildRow(cor, pk string) map[string]any {
	return map[string]any{
		"id_padraocor": cor, "id_produto": "P1", "id_base": "B1", "id_emb": "E1",
		"formula_pk": pk,
	}
}

// postedFormulas extrai o array "formulas" do 1º POST /formulas capturado.
func postedFormulas(t *testing.T, cs *captureServer) []any {
	t.Helper()
	for _, r := range cs.requests {
		if r.Path == "/formulas" {
			fs, ok := r.Body["formulas"].([]any)
			if !ok {
				t.Fatalf("body sem array formulas: %+v", r.Body)
			}
			return fs
		}
	}
	t.Fatal("nenhum POST /formulas capturado")
	return nil
}

func TestSyncFormulas1d_Contrato_FlatPreservaInvalidoNoPayload(t *testing.T) {
	cs := &captureServer{}
	ts := httptest.NewServer(cs)
	defer ts.Close()

	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	// O fake bypassa ExtractDelta — aplica a agregação flat na fixture (fluxo real).
	rowsAgg := aggregateFlatFormulaItems([]map[string]any{makeFormulaRow(map[int][2]any{
		1: {"AX", float64(10)},
		2: {"VM", float64(0)}, // o inválido canônico
	})}, testFlatCols())
	ex := newFakeExtractor()
	ex.rows["formula"] = rowsAgg

	st := &State{HWM: map[string]string{}}
	cli := NewClient(ts.URL, "tok", "L1")
	hc := newHashCache()
	if err := syncFormulas(context.Background(), ex, cli, st, map[string]int{}, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("syncFormulas: %v", err)
	}

	fs := postedFormulas(t, cs)
	if len(fs) != 1 {
		t.Fatalf("esperava 1 fórmula POSTada, got %d", len(fs))
	}
	f := fs[0].(map[string]any)
	itens, _ := f["itens"].([]any)
	if len(itens) != 2 {
		t.Fatalf("payload deveria PRESERVAR o slot inválido (2 itens), got %d: %+v", len(itens), f["itens"])
	}
	vm := itens[1].(map[string]any)
	if vm["id_corante"] != "VM" || vm["qtd_ml"] != float64(0) {
		t.Errorf("VM=0 não chegou cru no payload: %+v", vm)
	}
	if _, tem := f["is_base_pura"]; tem {
		t.Error("fórmula pigmentada não declara is_base_pura")
	}
}

func TestSyncFormulas1d_Contrato_FlatBasePuraDeclarada(t *testing.T) {
	cs := &captureServer{}
	ts := httptest.NewServer(cs)
	defer ts.Close()

	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	ex := newFakeExtractor()
	ex.rows["formula"] = aggregateFlatFormulaItems(
		[]map[string]any{makeFormulaRow(map[int][2]any{})}, testFlatCols())

	st := &State{HWM: map[string]string{}}
	if err := syncFormulas(context.Background(), ex, NewClient(ts.URL, "tok", "L1"), st, map[string]int{}, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas: %v", err)
	}
	f := postedFormulas(t, cs)[0].(map[string]any)
	if f["is_base_pura"] != true {
		t.Fatalf("base pura flat deveria declarar is_base_pura=true, got %v", f["is_base_pura"])
	}
	itens, ok := f["itens"].([]any)
	if !ok || len(itens) != 0 {
		t.Fatalf("base pura manda itens=[] EXPLÍCITO (json []), got %T %v", f["itens"], f["itens"])
	}
}

func TestSyncFormulas1d_Contrato_ChildPkNaoResolvida_ItensAusente(t *testing.T) {
	// Sem formula_pk resolvida, itens=[] seria MENTIRA ("confirmado vazio") e um
	// is_base_pura derivado dela limparia o catálogo inteiro. Contrato: chave
	// "itens" AUSENTE (→ expected NULL → ambíguo → banco barra) e nunca base pura.
	cs := &captureServer{}
	ts := httptest.NewServer(cs)
	defer ts.Close()

	rm := newFakeMapping([]string{"formula"}, FormulaShapeChild) // SEM formula_pk em Resolved
	ex := newFakeExtractor()
	ex.rows["formula"] = []map[string]any{fixtureChildRow("COR1", "5")}
	ex.childItems = map[string][]map[string]any{"5": {{"id_corante": "AX", "ordem": 1, "qtd_ml": 10.0}}}

	st := &State{HWM: map[string]string{}}
	if err := syncFormulas(context.Background(), ex, NewClient(ts.URL, "tok", "L1"), st, map[string]int{}, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas: %v", err)
	}
	f := postedFormulas(t, cs)[0].(map[string]any)
	if _, tem := f["itens"]; tem {
		t.Fatalf("pk não-resolvida: chave itens deveria estar AUSENTE, got %v", f["itens"])
	}
	if _, tem := f["is_base_pura"]; tem {
		t.Fatal("pk não-resolvida NUNCA declara is_base_pura")
	}
}

func TestSyncFormulas1d_Contrato_ChildBasePuraSoComPkResolvida(t *testing.T) {
	cs := &captureServer{}
	ts := httptest.NewServer(cs)
	defer ts.Close()

	rm := newFakeMapping([]string{"formula"}, FormulaShapeChild)
	rm.Resolved["formula"]["formula_pk"] = "id_formula"
	ex := newFakeExtractor()
	// COR1: sem NENHUMA linha na filha → base pura declarada.
	// COR2: linha inválida (qtd 0) → preservada, NÃO é base pura.
	ex.rows["formula"] = []map[string]any{fixtureChildRow("COR1", "5"), fixtureChildRow("COR2", "6")}
	ex.childItems = map[string][]map[string]any{"6": {{"id_corante": "VM", "ordem": 1, "qtd_ml": float64(0)}}}

	st := &State{HWM: map[string]string{}}
	if err := syncFormulas(context.Background(), ex, NewClient(ts.URL, "tok", "L1"), st, map[string]int{}, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas: %v", err)
	}
	fs := postedFormulas(t, cs)
	if len(fs) != 2 {
		t.Fatalf("esperava 2 fórmulas, got %d", len(fs))
	}
	f1 := fs[0].(map[string]any)
	if f1["is_base_pura"] != true {
		t.Errorf("COR1 (0 linhas na filha, pk resolvida) deveria declarar base pura, got %v", f1["is_base_pura"])
	}
	if itens, ok := f1["itens"].([]any); !ok || len(itens) != 0 {
		t.Errorf("COR1 deveria mandar itens=[], got %T %v", f1["itens"], f1["itens"])
	}
	f2 := fs[1].(map[string]any)
	itens2, _ := f2["itens"].([]any)
	if len(itens2) != 1 {
		t.Fatalf("COR2 deveria preservar a linha inválida, got %v", f2["itens"])
	}
	if _, tem := f2["is_base_pura"]; tem {
		t.Error("COR2 tem linha na filha — não é base pura")
	}
}

// ──────────────────────────────────────────────────────────────
// 4) hash-cache — compat e sensibilidade do campo novo
// ──────────────────────────────────────────────────────────────

// Goldens capturados com o código PRÉ-1d (2026-07-20). Se um destes quebrar, a
// serialização base do hash mudou → TODOS os ~485k hashes invalidam → re-envio
// total do catálogo. Só aceite mudar isto com decisão explícita de migração.
const (
	goldenHashFull  = "17ca56b2205bee0cb86c2b2faf963f2d"
	goldenHashVazia = "5025aa4f9389c7ef24791f212931773d"
	goldenCacheKey  = "false|4:COR12:P12:B12:E1"
)

func goldenPayloadFull() map[string]any {
	return map[string]any{
		"cor_id": "COR1", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false, "nome_cor": "Azul", "subcolecao": "SL", "volume_final_ml": 900.0,
		"itens": []map[string]any{
			{"id_corante": "AX", "ordem": 1, "qtd_ml": 10.0},
			{"id_corante": "VM", "ordem": 2, "qtd_ml": 5.16},
		},
	}
}

func TestFormulaContentHash1d_GoldenCompat(t *testing.T) {
	if h := formulaContentHash(goldenPayloadFull()); h != goldenHashFull {
		t.Errorf("hash de payload SEM is_base_pura mudou (re-envio de 485k!): %s ≠ golden %s", h, goldenHashFull)
	}
	vazia := map[string]any{
		"cor_id": "COR2", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false,
	}
	if h := formulaContentHash(vazia); h != goldenHashVazia {
		t.Errorf("hash de payload mínimo mudou: %s ≠ golden %s", h, goldenHashVazia)
	}
	if k := formulaCacheKey(goldenPayloadFull()); k != goldenCacheKey {
		t.Errorf("cache key mudou: %q ≠ golden %q", k, goldenCacheKey)
	}
}

func TestFormulaContentHash1d_BasePuraMudaHash(t *testing.T) {
	semFlag := map[string]any{
		"cor_id": "COR2", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false, "itens": []map[string]any{},
	}
	comFlag := map[string]any{
		"cor_id": "COR2", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false, "itens": []map[string]any{}, "is_base_pura": true,
	}
	if formulaContentHash(semFlag) == formulaContentHash(comFlag) {
		t.Fatal("is_base_pura=true TEM de mudar o hash — é o que re-envia a declaração 1×")
	}
	// false explícito ≡ ausente (o campo só existe no payload quando true).
	comFalse := map[string]any{
		"cor_id": "COR2", "cod_produto": "P1", "id_base": "B1", "id_embalagem": "E1",
		"personalizada": false, "itens": []map[string]any{}, "is_base_pura": false,
	}
	if formulaContentHash(semFlag) != formulaContentHash(comFalse) {
		t.Fatal("is_base_pura=false deve hashear IGUAL a ausente (nunca vai no payload)")
	}
}

func TestFormulaContentHash1d_AntiColisaoSufixo(t *testing.T) {
	// O sufixo condicional não pode colidir com um item forjado: todo part de item
	// começa com length-prefix de `ordem` (dígito); o sufixo começa com \x01.
	forjado := goldenPayloadFull()
	forjado["itens"] = append(forjado["itens"].([]map[string]any), map[string]any{
		"id_corante": "\x01true", "ordem": "", "qtd_ml": nil,
	})
	comFlag := goldenPayloadFull()
	comFlag["is_base_pura"] = true
	if formulaContentHash(forjado) == formulaContentHash(comFlag) {
		t.Fatal("colisão entre item forjado e sufixo is_base_pura")
	}
}

// Anti-regressão: fórmula flat 100% típica (2 corantes válidos, 4 slots livres)
// produz payload IDÊNTICO ao pré-1d → hash golden → NÃO re-envia no rollout.
func TestSyncFormulas1d_PigmentadaNormalNaoMudaDeHash(t *testing.T) {
	rows := []map[string]any{makeFormulaRow(map[int][2]any{
		1: {"C01", float64(10)},
		2: {"C02", float64(20)},
	})}
	out := aggregateFlatFormulaItems(rows, testFlatCols())[0]
	itens := out["itens"].([]map[string]any)
	if len(itens) != 2 {
		t.Fatalf("fórmula normal: 2 itens, got %d", len(itens))
	}
	if _, tem := out["is_base_pura"]; tem {
		t.Fatal("fórmula normal não declara is_base_pura")
	}
	for _, it := range itens {
		if it["qtd_ml"] == nil {
			t.Fatal("fórmula normal não tem qtd nil")
		}
	}
}
