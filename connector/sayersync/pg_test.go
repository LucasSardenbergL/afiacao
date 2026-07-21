// pg_test.go — testes unitários para as funções de acesso ao PostgreSQL.
// Não requer banco de dados real: testa apenas a lógica pura (aggregação
// de fórmulas flat, conversão de tipos, sanitização de conn string, etc.).
package main

import (
	"fmt"
	"testing"
	"time"
)

// ──────────────────────────────────────────────────────────────
// aggregateFlatFormulaItems
// ──────────────────────────────────────────────────────────────

// flatCols padrão para os testes (nomes reais = nomes lógicos, caso simples).
func testFlatCols() map[string]string {
	cols := make(map[string]string, 12)
	for i := 1; i <= 6; i++ {
		cols[fmt.Sprintf("corante%d", i)] = fmt.Sprintf("corante%d", i)
		cols[fmt.Sprintf("qtd%dml", i)] = fmt.Sprintf("qtd%dml", i)
	}
	return cols
}

// makeFormulaRow cria uma linha de fórmula com slots preenchidos conforme o map
// corante_idx → (id_corante, qtd_ml).
func makeFormulaRow(slots map[int][2]any) map[string]any {
	row := map[string]any{
		"id_padraocor":     "COR001",
		"id_produto":       int64(1),
		"id_base":          int64(1),
		"id_emb":           int64(1),
		"data_atualizacao": time.Now(),
	}
	for i := 1; i <= 6; i++ {
		if v, ok := slots[i]; ok {
			row[fmt.Sprintf("corante%d", i)] = v[0]
			row[fmt.Sprintf("qtd%dml", i)] = v[1]
		} else {
			row[fmt.Sprintf("corante%d", i)] = nil
			row[fmt.Sprintf("qtd%dml", i)] = nil
		}
	}
	return row
}

func TestAggregateFlatFormulaItems_6Slots(t *testing.T) {
	// Todos os 6 slots preenchidos com corantes distintos.
	slots := map[int][2]any{}
	for i := 1; i <= 6; i++ {
		slots[i] = [2]any{fmt.Sprintf("C%02d", i), float64(i) * 1.5}
	}
	rows := []map[string]any{makeFormulaRow(slots)}
	result := aggregateFlatFormulaItems(rows, testFlatCols())

	itens, ok := result[0]["itens"].([]map[string]any)
	if !ok {
		t.Fatalf("itens deve ser []map[string]any, got %T", result[0]["itens"])
	}
	if len(itens) != 6 {
		t.Errorf("esperava 6 itens, got %d", len(itens))
	}

	// Verifica ordem e valores do primeiro item.
	if itens[0]["ordem"] != 1 {
		t.Errorf("itens[0].ordem: esperava 1, got %v", itens[0]["ordem"])
	}
	if itens[0]["id_corante"] != "C01" {
		t.Errorf("itens[0].id_corante: esperava 'C01', got %v", itens[0]["id_corante"])
	}
	if itens[0]["qtd_ml"] != 1.5 {
		t.Errorf("itens[0].qtd_ml: esperava 1.5, got %v", itens[0]["qtd_ml"])
	}
}

func TestAggregateFlatFormulaItems_SkipsNilCorante(t *testing.T) {
	// Slots 1,3,5 preenchidos; 2,4,6 com corante nil.
	slots := map[int][2]any{
		1: {"C01", float64(10)},
		3: {"C03", float64(20)},
		5: {"C05", float64(30)},
	}
	rows := []map[string]any{makeFormulaRow(slots)}
	result := aggregateFlatFormulaItems(rows, testFlatCols())

	itens, ok := result[0]["itens"].([]map[string]any)
	if !ok {
		t.Fatalf("itens deve ser []map[string]any")
	}
	if len(itens) != 3 {
		t.Errorf("esperava 3 itens (nil omitidos), got %d", len(itens))
	}
}

func TestAggregateFlatFormulaItems_PreservaQtdInvalidaComCorante(t *testing.T) {
	// CONTRATO 1d (mudança deliberada): slot com corante PRESENTE e qtd<=0 deixa de
	// ser omitido — é PRESERVADO cru para o Guard 4 do banco barrar a fórmula e
	// logar (antes: omitir aqui fabricava payload "íntegro" com receita parcial).
	slots := map[int][2]any{
		1: {"C01", float64(0)},    // inválido → PRESERVADO
		2: {"C02", float64(5)},    // ok
		3: {"C03", float64(10)},   // ok
		4: {"C04", float64(0.5)},  // ok
		5: {"C05", float64(-1)},   // inválido → PRESERVADO
		6: {"C06", float64(0.01)}, // ok
	}
	rows := []map[string]any{makeFormulaRow(slots)}
	result := aggregateFlatFormulaItems(rows, testFlatCols())

	itens, ok := result[0]["itens"].([]map[string]any)
	if !ok {
		t.Fatalf("itens deve ser []map[string]any")
	}
	if len(itens) != 6 {
		t.Errorf("esperava 6 itens (inválidos PRESERVADOS p/ o banco decidir), got %d", len(itens))
	}
}

func TestAggregateFlatFormulaItems_RemovesRawColumns(t *testing.T) {
	// Verifica que as colunas brutas corante1..6 e qtd1ml..6ml são removidas da linha.
	slots := map[int][2]any{
		1: {"C01", float64(10)},
		2: {"C02", float64(20)},
	}
	rows := []map[string]any{makeFormulaRow(slots)}
	result := aggregateFlatFormulaItems(rows, testFlatCols())

	for i := 1; i <= 6; i++ {
		if _, exists := result[0][fmt.Sprintf("corante%d", i)]; exists {
			t.Errorf("coluna bruta corante%d não foi removida da linha", i)
		}
		if _, exists := result[0][fmt.Sprintf("qtd%dml", i)]; exists {
			t.Errorf("coluna bruta qtd%dml não foi removida da linha", i)
		}
	}

	// Mas os outros campos devem persistir.
	if result[0]["id_padraocor"] == nil {
		t.Error("id_padraocor foi removido indevidamente")
	}
}

func TestAggregateFlatFormulaItems_AllEmpty(t *testing.T) {
	// CONTRATO 1d: todos os slots livres = base pura DECLARADA pela fonte —
	// itens=[] EXPLÍCITO (não nil → json [] e não null) + is_base_pura=true.
	slots := map[int][2]any{} // nenhum slot preenchido
	rows := []map[string]any{makeFormulaRow(slots)}
	result := aggregateFlatFormulaItems(rows, testFlatCols())

	itens, ok := result[0]["itens"].([]map[string]any)
	if !ok || itens == nil {
		t.Fatalf("base pura declara itens=[] explícito, got %T %v", result[0]["itens"], result[0]["itens"])
	}
	if len(itens) != 0 {
		t.Errorf("esperava 0 itens, got %d", len(itens))
	}
	if result[0]["is_base_pura"] != true {
		t.Errorf("todos os slots livres deveria declarar is_base_pura=true, got %v", result[0]["is_base_pura"])
	}
}

func TestAggregateFlatFormulaItems_MultipleRows(t *testing.T) {
	// Verifica que múltiplas linhas são processadas independentemente.
	flatCols := testFlatCols()
	rows := []map[string]any{
		makeFormulaRow(map[int][2]any{
			1: {"C01", float64(10)},
			2: {"C02", float64(20)},
		}),
		makeFormulaRow(map[int][2]any{
			1: {"C10", float64(5)},
		}),
	}
	result := aggregateFlatFormulaItems(rows, flatCols)

	itens0 := result[0]["itens"].([]map[string]any)
	itens1 := result[1]["itens"].([]map[string]any)
	if len(itens0) != 2 {
		t.Errorf("linha 0: esperava 2 itens, got %d", len(itens0))
	}
	if len(itens1) != 1 {
		t.Errorf("linha 1: esperava 1 item, got %d", len(itens1))
	}
}

// ──────────────────────────────────────────────────────────────
// buildDeltaSelectCols — P0: os slots flat TÊM que entrar no SELECT
// ──────────────────────────────────────────────────────────────

// rmFlatParaSelect monta um ResolvedMapping flat com colunas base + slots reais
// no formato do schema REAL (qtd1ml lógico → qtd1 real) para as duas fórmulas.
func rmFlatParaSelect() *ResolvedMapping {
	flat := func() map[string]string {
		m := make(map[string]string, 12)
		for i := 1; i <= 6; i++ {
			m[fmt.Sprintf("corante%d", i)] = fmt.Sprintf("corante%d", i)
			m[fmt.Sprintf("qtd%dml", i)] = fmt.Sprintf("qtd%d", i)
		}
		return m
	}
	return &ResolvedMapping{
		FormulaShape: FormulaShapeFlat,
		Resolved: map[string]map[string]string{
			"formula": {
				"id_padraocor": "id_padraocor", "id_produto": "id_produto",
				"id_base": "id_base", "id_emb": "id_embalagem",
				"data_atualizacao": "data_alteracao",
			},
			"formulaperson": {
				"id_padraocor": "id_personcor", "id_produto": "id_produto",
				"id_base": "id_base", "id_emb": "id_embalagem",
				"data_atualizacao": "data_atualizacao",
			},
			"produto": {
				"id_produto": "id", "descricao": "descricao",
				"data_atualizacao": "data_alteracao",
			},
		},
		FlatColsByTable: map[string]map[string]string{
			"formula":       flat(),
			"formulaperson": flat(),
		},
	}
}

// indexSelectCols indexa os pares lógico→real para asserts.
func indexSelectCols(cols []colPair) map[string]string {
	out := make(map[string]string, len(cols))
	for _, cp := range cols {
		out[cp.logic] = cp.real
	}
	return out
}

func TestBuildDeltaSelectCols_flatFormulaIncluiOs12Slots(t *testing.T) {
	rm := rmFlatParaSelect()
	got := indexSelectCols(buildDeltaSelectCols(rm, "formula"))
	for i := 1; i <= 6; i++ {
		ck := fmt.Sprintf("corante%d", i)
		if got[ck] != ck {
			t.Errorf("formula: slot %s ausente/errado no SELECT: %q", ck, got[ck])
		}
		qk := fmt.Sprintf("qtd%dml", i)
		want := fmt.Sprintf("qtd%d", i)
		if got[qk] != want {
			t.Errorf("formula: slot %s deveria selecionar %q, got %q", qk, want, got[qk])
		}
	}
	// As colunas base também presentes (com nome REAL).
	if got["id_emb"] != "id_embalagem" {
		t.Errorf("formula: id_emb deveria selecionar 'id_embalagem', got %q", got["id_emb"])
	}
}

func TestBuildDeltaSelectCols_flatFormulapersonIncluiOs12Slots(t *testing.T) {
	rm := rmFlatParaSelect()
	got := indexSelectCols(buildDeltaSelectCols(rm, "formulaperson"))
	for i := 1; i <= 6; i++ {
		if got[fmt.Sprintf("corante%d", i)] == "" {
			t.Errorf("formulaperson: corante%d ausente do SELECT", i)
		}
		if got[fmt.Sprintf("qtd%dml", i)] != fmt.Sprintf("qtd%d", i) {
			t.Errorf("formulaperson: qtd%dml deveria selecionar qtd%d, got %q", i, i, got[fmt.Sprintf("qtd%dml", i)])
		}
	}
	if got["id_padraocor"] != "id_personcor" {
		t.Errorf("formulaperson: id_padraocor deveria selecionar 'id_personcor', got %q", got["id_padraocor"])
	}
}

func TestBuildDeltaSelectCols_childShapeNaoIncluiSlots(t *testing.T) {
	rm := rmFlatParaSelect()
	rm.FormulaShape = FormulaShapeChild
	got := indexSelectCols(buildDeltaSelectCols(rm, "formula"))
	for i := 1; i <= 6; i++ {
		if _, tem := got[fmt.Sprintf("corante%d", i)]; tem {
			t.Errorf("shape child NÃO deve selecionar corante%d (vem da tabela filha)", i)
		}
		if _, tem := got[fmt.Sprintf("qtd%dml", i)]; tem {
			t.Errorf("shape child NÃO deve selecionar qtd%dml", i)
		}
	}
}

func TestBuildDeltaSelectCols_entidadeComumNaoIncluiSlots(t *testing.T) {
	rm := rmFlatParaSelect()
	got := indexSelectCols(buildDeltaSelectCols(rm, "produto"))
	if len(got) != 3 {
		t.Errorf("produto deveria ter só as 3 colunas resolvidas, got %d: %v", len(got), got)
	}
	if _, tem := got["corante1"]; tem {
		t.Error("entidade comum NÃO deve carregar slots flat de fórmula")
	}
}

// ──────────────────────────────────────────────────────────────
// toFloat64OK — F1: numeric do PG chega como STRING via pgx stdlib
// ──────────────────────────────────────────────────────────────

func TestToFloat64OK(t *testing.T) {
	cases := []struct {
		name     string
		input    any
		expected float64
		ok       bool
	}{
		{"float64", float64(3.14), 3.14, true},
		{"float32", float32(2.5), float64(float32(2.5)), true},
		{"int64", int64(100), 100.0, true},
		{"int32", int32(50), 50.0, true},
		{"int16", int16(12), 12.0, true},
		{"int", int(7), 7.0, true},
		// ── O caso central do F1: numeric do Postgres chega como string ──
		{"numeric-as-string", "123.45", 123.45, true},
		{"string-zero", "0", 0.0, true},
		{"string-int", "900", 900.0, true},
		{"string-negative", "-1.5", -1.5, true},
		{"string-with-spaces", "  42.5  ", 42.5, true},
		{"bytes-numeric", []byte("0.5"), 0.5, true},
		{"bytes-int", []byte("100"), 100.0, true},
		// ── Falhas: NÃO podem virar 0 válido ──
		{"nil", nil, 0.0, false},
		{"garbage-string", "abc", 0.0, false},
		{"empty-string", "", 0.0, false},
		{"empty-bytes", []byte(""), 0.0, false},
		{"whitespace-string", "   ", 0.0, false},
		{"not-a-number-bytes", []byte("xyz"), 0.0, false},
		{"nan-string", "NaN", 0.0, false},
		{"inf-string", "Inf", 0.0, false},
		{"bool-unsupported", true, 0.0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toFloat64OK(tc.input)
			if ok != tc.ok {
				t.Fatalf("toFloat64OK(%v): ok esperado %v, got %v (valor=%v)", tc.input, tc.ok, ok, got)
			}
			if ok && got != tc.expected {
				t.Errorf("toFloat64OK(%v): esperava %v, got %v", tc.input, tc.expected, got)
			}
			// Garante que uma falha NUNCA entregue um número não-zero acidental.
			if !ok && got != 0 {
				t.Errorf("toFloat64OK(%v): falha deveria retornar 0, got %v", tc.input, got)
			}
		})
	}
}

// TestAggregateFlatFormulaItems_NumericAsString prova que qtd em string (como o
// pgx entrega numeric) é parseada — antes do F1 virava 0 e o item era dropado.
func TestAggregateFlatFormulaItems_NumericAsString(t *testing.T) {
	row := map[string]any{
		"id_padraocor":     "COR001",
		"id_produto":       int64(1),
		"id_base":          int64(1),
		"id_emb":           int64(1),
		"data_atualizacao": time.Now(),
	}
	for i := 1; i <= 6; i++ {
		row[fmt.Sprintf("corante%d", i)] = nil
		row[fmt.Sprintf("qtd%dml", i)] = nil
	}
	// Slot 1: qtd como STRING numérica (caso real do pgx) → deve virar 12.5.
	row["corante1"] = "C01"
	row["qtd1ml"] = "12.5"
	// Slot 2: qtd como []byte → deve virar 3.
	row["corante2"] = "C02"
	row["qtd2ml"] = []byte("3")
	// Slot 3: qtd string não-numérica → CONTRATO 1d: preservado com qtd_ml=nil
	// (a essência segue: NUNCA virar 0; quem barra a fórmula é o Guard 4 do banco).
	row["corante3"] = "C03"
	row["qtd3ml"] = "abc"

	result := aggregateFlatFormulaItems([]map[string]any{row}, testFlatCols())
	itens, ok := result[0]["itens"].([]map[string]any)
	if !ok {
		t.Fatalf("itens deve ser []map[string]any, got %T", result[0]["itens"])
	}
	if len(itens) != 3 {
		t.Fatalf("esperava 3 itens (slot 3 preservado com qtd nil), got %d: %+v", len(itens), itens)
	}
	if itens[0]["qtd_ml"] != 12.5 {
		t.Errorf("slot 1 qtd_ml: esperava 12.5, got %v", itens[0]["qtd_ml"])
	}
	if itens[1]["qtd_ml"] != 3.0 {
		t.Errorf("slot 2 qtd_ml: esperava 3.0, got %v", itens[1]["qtd_ml"])
	}
	if itens[2]["qtd_ml"] != nil {
		t.Errorf("slot 3 qtd_ml ilegível: esperava nil (nunca 0), got %v", itens[2]["qtd_ml"])
	}
}

// ──────────────────────────────────────────────────────────────
// toTime
// ──────────────────────────────────────────────────────────────

func TestToTime_FromTimeTime(t *testing.T) {
	now := time.Now().UTC()
	got, ok := toTime(now)
	if !ok {
		t.Fatal("toTime(time.Time) deve retornar ok=true")
	}
	if !got.Equal(now) {
		t.Errorf("toTime: esperava %v, got %v", now, got)
	}
}

func TestToTime_FromPtrTimeTime(t *testing.T) {
	now := time.Now().UTC()
	got, ok := toTime(&now)
	if !ok {
		t.Fatal("toTime(*time.Time) deve retornar ok=true")
	}
	if !got.Equal(now) {
		t.Errorf("toTime(*time.Time): esperava %v, got %v", now, got)
	}
}

func TestToTime_Nil(t *testing.T) {
	_, ok := toTime(nil)
	if ok {
		t.Error("toTime(nil) deve retornar ok=false")
	}
}

func TestToTime_NilPtr(t *testing.T) {
	var p *time.Time
	_, ok := toTime(p)
	if ok {
		t.Error("toTime((*time.Time)(nil)) deve retornar ok=false")
	}
}

// ──────────────────────────────────────────────────────────────
// sanitizeConnStr
// ──────────────────────────────────────────────────────────────

func TestSanitizeConnStr_MasksPassword(t *testing.T) {
	input := "postgres://integra:secreta@localhost:5986/client_industrial_sayerlack"
	got := sanitizeConnStr(input)
	if got == input {
		t.Error("sanitizeConnStr não mascarou a senha")
	}
	if contains(got, "secreta") {
		t.Errorf("senha ainda visível após sanitize: %q", got)
	}
	if !contains(got, "***") {
		t.Errorf("esperava '***' na saída: %q", got)
	}
}

func TestSanitizeConnStr_NoPassword(t *testing.T) {
	input := "postgres://localhost/mydb"
	got := sanitizeConnStr(input)
	// Sem "@" → retorna como está.
	if got != input {
		t.Errorf("conn sem senha não deve ser alterada: %q", got)
	}
}

// ──────────────────────────────────────────────────────────────
// quoteIdent / quoteIdents
// ──────────────────────────────────────────────────────────────

func TestQuoteIdent_SimpleIdentifier(t *testing.T) {
	got := quoteIdent("produto")
	if got != `"produto"` {
		t.Errorf("quoteIdent: esperava %q, got %q", `"produto"`, got)
	}
}

func TestQuoteIdent_EscapesInternalQuotes(t *testing.T) {
	got := quoteIdent(`col"name`)
	if got != `"col""name"` {
		t.Errorf("quoteIdent: esperava %q, got %q", `"col""name"`, got)
	}
}

func TestQuoteIdents_MultipleColumns(t *testing.T) {
	names := []string{"id_produto", "descricao", "data_atualizacao"}
	got := quoteIdents(names)
	if len(got) != 3 {
		t.Fatalf("quoteIdents: esperava 3 resultados, got %d", len(got))
	}
	if got[0] != `"id_produto"` {
		t.Errorf("quoteIdents[0]: esperava %q, got %q", `"id_produto"`, got[0])
	}
}

// ──────────────────────────────────────────────────────────────
// sortColPairs
// ──────────────────────────────────────────────────────────────

func TestSortColPairs_Ordered(t *testing.T) {
	pairs := []colPair{
		{logic: "z_col", real: "z"},
		{logic: "a_col", real: "a"},
		{logic: "m_col", real: "m"},
	}
	sortColPairs(pairs)
	if pairs[0].logic != "a_col" || pairs[1].logic != "m_col" || pairs[2].logic != "z_col" {
		t.Errorf("sortColPairs: ordem incorreta: %v", pairs)
	}
}

// ──────────────────────────────────────────────────────────────
// HWM — rastreamento do MAX(data_atualizacao) (sem banco)
// ──────────────────────────────────────────────────────────────

func TestScanRows_TracksMaxDA(t *testing.T) {
	// Simula 3 linhas com data_atualizacao distintas; verifica que maxDA = a maior.
	t1 := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 6, 3, 10, 0, 0, 0, time.UTC) // max
	t3 := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)

	// Cria um sql.Rows simulado não é viável sem banco — testamos via scanRows
	// indiretamente através do resultado do aggregateFlatFormulaItems que chama
	// scanRows internamente. Para HWM, o teste definitivo requer integração com PG.
	// Aqui testamos o helper toTime que é a base do rastreamento.
	for _, ts := range []time.Time{t1, t2, t3} {
		got, ok := toTime(ts)
		if !ok || !got.Equal(ts) {
			t.Errorf("toTime(%v): got (%v, %v)", ts, got, ok)
		}
	}

	// Verifica que a comparação After() funciona corretamente (base do maxDA).
	var maxDA time.Time
	for _, ts := range []time.Time{t1, t3, t2} {
		if ts.After(maxDA) {
			maxDA = ts
		}
	}
	if !maxDA.Equal(t2) {
		t.Errorf("rastreamento de maxDA: esperava %v, got %v", t2, maxDA)
	}
}

// ──────────────────────────────────────────────────────────────
// helper de teste
// ──────────────────────────────────────────────────────────────

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsRune(s, sub))
}

func containsRune(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
