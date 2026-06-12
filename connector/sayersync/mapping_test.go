// mapping_test.go — testes unitários para o mapeamento declarativo, resolução de
// candidatos, detecção de shape dual da FORMULA e fingerprint.
// Não requer banco de dados real: usa fixtures de information_schema.
package main

import (
	"fmt"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────

// fixtureSchemaNominal retorna um map[tabela → map[coluna → true]] simulando
// information_schema.columns para um schema mínimo funcional com shape FLAT.
func fixtureSchemaNominal() map[string]map[string]bool {
	s := map[string]map[string]bool{
		"produto": {
			"id_produto": true, "descricao": true, "data_atualizacao": true,
		},
		"base": {
			"id_base": true, "descricao": true, "data_atualizacao": true,
		},
		"embalagens": {
			// "conteudo" é o primeiro candidato para volume_ml
			"id_emb": true, "descricao": true, "conteudo": true, "data_atualizacao": true,
		},
		"produto_base_embalagem": {
			"id_produto": true, "id_base": true, "id_emb": true, "data_atualizacao": true,
		},
		"corantes": {
			"id_corante": true, "descricao": true, "data_atualizacao": true,
		},
		"preco_corante": {
			"id_corante": true, "custo": true, "volume": true, "data_atualizacao": true,
		},
		"preco_baseemb": {
			"id_produto": true, "id_base": true, "id_emb": true,
			"custo": true, "imposto": true, "margem": true, "data_atualizacao": true,
		},
		"padracor": {
			"id_padraocor": true, "descricao": true, "data_atualizacao": true,
		},
		"colecao": {
			"id_colecao": true, "descricao": true,
		},
		"subcolecao": {
			"id_subcolecao": true, "id_colecao": true, "descricao": true,
		},
		"formula": {
			"id_padraocor": true, "id_produto": true, "id_base": true, "id_emb": true,
			"data_atualizacao": true,
		},
		"personcor": {
			"id_padraocor": true, "descricao": true, "data_atualizacao": true,
		},
		"formulaperson": {
			"id_padraocor": true, "id_produto": true, "id_base": true, "id_emb": true,
			"data_atualizacao": true,
		},
		"vendas":      {"id_venda": true, "data_venda": true},
		"vendas_item": {"id_venda": true, "id_corante": true, "qtd_ml": true},
	}
	// Adiciona colunas flat de formula (corante1..6 + qtd1ml..6ml).
	for i := 1; i <= 6; i++ {
		s["formula"][fmt.Sprintf("corante%d", i)] = true
		s["formula"][fmt.Sprintf("qtd%dml", i)] = true
	}
	return s
}

// fixtureSchemaChild retorna um schema onde FORMULA usa tabela filha formula_item.
func fixtureSchemaChild() map[string]map[string]bool {
	s := fixtureSchemaNominal()
	// Remove as colunas flat da formula.
	for i := 1; i <= 6; i++ {
		delete(s["formula"], fmt.Sprintf("corante%d", i))
		delete(s["formula"], fmt.Sprintf("qtd%dml", i))
	}
	// Adiciona a tabela filha.
	s["formula_item"] = map[string]bool{
		"id_formula": true, "id_corante": true, "ordem": true, "qtd_ml": true,
	}
	return s
}

// fixtureSchemaAltCandidates usa nomes alternativos para candidatos
// (ex: "preco" em vez de "custo", "aliquota" em vez de "imposto").
func fixtureSchemaAltCandidates() map[string]map[string]bool {
	s := fixtureSchemaNominal()
	// Substitui "custo" por "preco" em preco_corante.
	delete(s["preco_corante"], "custo")
	s["preco_corante"]["preco"] = true
	// Substitui "imposto" por "aliquota" em preco_baseemb.
	delete(s["preco_baseemb"], "imposto")
	s["preco_baseemb"]["aliquota"] = true
	// Substitui "volume" por "volume_ml" em preco_corante.
	delete(s["preco_corante"], "volume")
	s["preco_corante"]["volume_ml"] = true
	return s
}

// ──────────────────────────────────────────────────────────────
// Resolução de candidatos
// ──────────────────────────────────────────────────────────────

func TestValidate_NominalSchema(t *testing.T) {
	cols := fixtureSchemaNominal()
	rm, diff := resolveFromFixture(cols)

	if !diff.OK {
		t.Fatalf("Validate com schema nominal deve retornar OK; missing=%v", diff.Missing)
	}

	// Verifica que "volume_ml" da tabela embalagens resolveu para "conteudo" (primeiro candidato).
	got := rm.Resolved["embalagens"]["volume_ml"]
	if got != "conteudo" {
		t.Errorf("embalagens.volume_ml: esperava 'conteudo', got %q", got)
	}

	// Verifica shape flat detectado.
	if rm.FormulaShape != FormulaShapeFlat {
		t.Errorf("FormulaShape: esperava FormulaShapeFlat, got %q", rm.FormulaShape)
	}

	// Verifica que pelo menos corante1 foi mapeado nos flat cols.
	if rm.FlatFormulaCols["corante1"] == "" {
		t.Error("FlatFormulaCols[corante1] não deve estar vazio")
	}
}

func TestValidate_ChildShape(t *testing.T) {
	cols := fixtureSchemaChild()
	rm, diff := resolveFromFixture(cols)

	if !diff.OK {
		t.Fatalf("Validate com schema child deve retornar OK; missing=%v", diff.Missing)
	}
	if rm.FormulaShape != FormulaShapeChild {
		t.Errorf("FormulaShape: esperava FormulaShapeChild, got %q", rm.FormulaShape)
	}
}

func TestValidate_AltCandidates(t *testing.T) {
	cols := fixtureSchemaAltCandidates()
	rm, diff := resolveFromFixture(cols)

	if !diff.OK {
		t.Fatalf("Validate com candidatos alternativos deve retornar OK; missing=%v", diff.Missing)
	}

	// preco_corante.custo deve resolver para "preco" (segundo candidato).
	got := rm.Resolved["preco_corante"]["custo"]
	if got != "preco" {
		t.Errorf("preco_corante.custo: esperava 'preco', got %q", got)
	}

	// preco_corante.volume_ml deve resolver para "volume_ml" (terceiro candidato no fixture alterado).
	gotVol := rm.Resolved["preco_corante"]["volume_ml"]
	if gotVol != "volume_ml" {
		t.Errorf("preco_corante.volume_ml: esperava 'volume_ml', got %q", gotVol)
	}

	// preco_baseemb.imposto deve resolver para "aliquota".
	gotImp := rm.Resolved["preco_baseemb"]["imposto"]
	if gotImp != "aliquota" {
		t.Errorf("preco_baseemb.imposto: esperava 'aliquota', got %q", gotImp)
	}
}

// ── F4: embalagem de formulação — candidatos duais id_emb/id_embalagem ──────────

func TestValidate_FormulationEmbalagem_ResolvesViaIdEmbalagem(t *testing.T) {
	// Schema nominal já tem só id_emb na formula; adiciona id_embalagem (sem ambiguidade
	// removendo id_emb seria inválido pois é required) → testa que id_emb é o 1º candidato.
	cols := fixtureSchemaNominal()
	rm, diff := resolveFromFixture(cols)
	if !diff.OK {
		t.Fatalf("Validate deve passar; missing=%v", diff.Missing)
	}
	// id_emb é o 1º candidato da embalagem de formulação → resolve para id_emb.
	got := rm.Resolved["formula"]["id_embalagem_formulacao"]
	if got != "id_emb" {
		t.Errorf("id_embalagem_formulacao: esperava 'id_emb' (1º candidato), got %q", got)
	}
}

func TestValidate_FormulationEmbalagem_CandidatesCoverBothNames(t *testing.T) {
	// F4: o slot de embalagem de formulação DEVE listar tanto id_emb quanto id_embalagem
	// (+ id_embalagem_formulacao) como candidatos. Resolução é "primeiro que existir".
	cand := candidatesOpt("id_emb", "id_embalagem", "id_embalagem_formulacao")
	resolve := func(present string) string {
		tbl := map[string]bool{present: true}
		for _, c := range cand.Candidates {
			if tbl[strings.ToLower(c)] {
				return strings.ToLower(c)
			}
		}
		return ""
	}
	if got := resolve("id_emb"); got != "id_emb" {
		t.Errorf("com id_emb presente: esperava 'id_emb', got %q", got)
	}
	if got := resolve("id_embalagem"); got != "id_embalagem" {
		t.Errorf("com id_embalagem presente: esperava 'id_embalagem' (fallback), got %q", got)
	}
	if got := resolve("id_embalagem_formulacao"); got != "id_embalagem_formulacao" {
		t.Errorf("com id_embalagem_formulacao presente: esperava esse, got %q", got)
	}
	// Confirma que o mapeamento declarado da formula realmente expõe esses 3 candidatos.
	var found bool
	for _, tm := range expectedMappings() {
		if tm.Table != "formula" {
			continue
		}
		cm, ok := tm.Columns["id_embalagem_formulacao"]
		if !ok {
			t.Fatal("formula deve ter o logical 'id_embalagem_formulacao'")
		}
		found = true
		want := map[string]bool{"id_emb": true, "id_embalagem": true, "id_embalagem_formulacao": true}
		if len(cm.Candidates) != 3 {
			t.Errorf("esperava 3 candidatos, got %v", cm.Candidates)
		}
		for _, c := range cm.Candidates {
			if !want[c] {
				t.Errorf("candidato inesperado %q", c)
			}
		}
		if cm.Required {
			t.Error("embalagem de formulação deve ser opcional (não falha o ciclo se ausente)")
		}
	}
	if !found {
		t.Fatal("tabela 'formula' não encontrada no mapeamento")
	}
}

func TestValidate_FormulationEmbalagem_AmbiguityWarning(t *testing.T) {
	// Quando id_emb E id_embalagem coexistem na formula → aviso de ambiguidade.
	cols := fixtureSchemaNominal()
	cols["formula"]["id_embalagem"] = true       // agora id_emb (já existia) E id_embalagem coexistem
	cols["formulaperson"]["id_embalagem"] = true // idem na personalizada
	_, diff := resolveFromFixture(cols)
	if !diff.OK {
		t.Fatalf("ambiguidade NÃO deve falhar o ciclo (é só aviso); missing=%v", diff.Missing)
	}
	if _, ok := diff.ExtraInfo["formula_embalagem_ambigua"]; !ok {
		t.Error("esperava aviso 'formula_embalagem_ambigua' quando id_emb e id_embalagem coexistem")
	}
	if _, ok := diff.ExtraInfo["formulaperson_embalagem_ambigua"]; !ok {
		t.Error("esperava aviso 'formulaperson_embalagem_ambigua' quando id_emb e id_embalagem coexistem")
	}
}

func TestValidate_FormulationEmbalagem_NoAmbiguityWhenOnlyIdEmb(t *testing.T) {
	// Schema nominal tem só id_emb (não id_embalagem) → SEM aviso de ambiguidade.
	cols := fixtureSchemaNominal()
	_, diff := resolveFromFixture(cols)
	if _, ok := diff.ExtraInfo["formula_embalagem_ambigua"]; ok {
		t.Error("não deveria avisar ambiguidade quando só id_emb existe")
	}
}

func TestValidate_MissingRequiredTable_FailsClosed(t *testing.T) {
	cols := fixtureSchemaNominal()
	delete(cols, "corantes") // Remove tabela obrigatória.
	_, diff := resolveFromFixture(cols)

	if diff.OK {
		t.Fatal("Validate deve falhar quando tabela obrigatória está ausente")
	}
	if len(diff.Missing["corantes"]) == 0 {
		t.Error("Deve reportar colunas ausentes para 'corantes'")
	}
}

func TestValidate_MissingRequiredColumn_FailsClosed(t *testing.T) {
	cols := fixtureSchemaNominal()
	delete(cols["produto"], "id_produto") // Remove coluna obrigatória.
	_, diff := resolveFromFixture(cols)

	if diff.OK {
		t.Fatal("Validate deve falhar quando coluna obrigatória está ausente")
	}
}

func TestValidate_OptionalColumnMissing_StillOK(t *testing.T) {
	cols := fixtureSchemaNominal()
	// Remove colunas opcionais.
	delete(cols["formula"], "id_subcolecao")    // Opcional.
	delete(cols["colecao"], "data_atualizacao") // Opcional.
	_, diff := resolveFromFixture(cols)

	if !diff.OK {
		t.Fatalf("Validate deve passar com colunas opcionais ausentes; missing=%v", diff.Missing)
	}
}

// ──────────────────────────────────────────────────────────────
// Fingerprint
// ──────────────────────────────────────────────────────────────

func TestFingerprint_StableForSameSchema(t *testing.T) {
	cols := fixtureSchemaNominal()
	rm1, _ := resolveFromFixture(cols)
	rm2, _ := resolveFromFixture(cols)

	fp1 := Fingerprint(rm1)
	fp2 := Fingerprint(rm2)
	if fp1 != fp2 {
		t.Errorf("fingerprint não é estável para o mesmo schema: %q != %q", fp1, fp2)
	}
}

func TestFingerprint_DifferentForDifferentShape(t *testing.T) {
	rmFlat, _ := resolveFromFixture(fixtureSchemaNominal())
	rmChild, _ := resolveFromFixture(fixtureSchemaChild())

	fpFlat := Fingerprint(rmFlat)
	fpChild := Fingerprint(rmChild)
	if fpFlat == fpChild {
		t.Error("fingerprint deve ser diferente para shapes distintos (flat vs child)")
	}
}

func TestFingerprint_DeterministicAcrossIterations(t *testing.T) {
	// Go maps têm ordem de iteração aleatória; testa 5 vezes para confirmar determinismo.
	cols := fixtureSchemaNominal()
	var fps [5]string
	for i := range fps {
		rm, _ := resolveFromFixture(cols)
		fps[i] = Fingerprint(rm)
	}
	for i := 1; i < len(fps); i++ {
		if fps[i] != fps[0] {
			t.Errorf("fingerprint[%d]=%q difere de fingerprint[0]=%q", i, fps[i], fps[0])
		}
	}
}

func TestFingerprint_NonEmpty(t *testing.T) {
	rm, _ := resolveFromFixture(fixtureSchemaNominal())
	fp := Fingerprint(rm)
	if len(fp) != 64 { // sha256 hex = 64 caracteres
		t.Errorf("fingerprint deve ter 64 caracteres hex, got %d: %q", len(fp), fp)
	}
}

// ──────────────────────────────────────────────────────────────
// Detecção de shape dual da FORMULA
// ──────────────────────────────────────────────────────────────

func TestDetectFormulaShape_Flat(t *testing.T) {
	cols := fixtureSchemaNominal()
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FlatFormulaCols: make(map[string]string),
	}
	shape := detectFormulaShape(cols, rm)
	if shape != FormulaShapeFlat {
		t.Errorf("esperava FormulaShapeFlat, got %q", shape)
	}
	// Verifica que os 6 slots foram mapeados.
	for i := 1; i <= 6; i++ {
		k := fmt.Sprintf("corante%d", i)
		if rm.FlatFormulaCols[k] == "" {
			t.Errorf("FlatFormulaCols[%s] não foi mapeado", k)
		}
		qk := fmt.Sprintf("qtd%dml", i)
		if rm.FlatFormulaCols[qk] == "" {
			t.Errorf("FlatFormulaCols[%s] não foi mapeado", qk)
		}
	}
}

func TestDetectFormulaShape_Child(t *testing.T) {
	cols := fixtureSchemaChild()
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FlatFormulaCols: make(map[string]string),
	}
	shape := detectFormulaShape(cols, rm)
	if shape != FormulaShapeChild {
		t.Errorf("esperava FormulaShapeChild, got %q", shape)
	}
}

func TestDetectFormulaShape_ChildTakesPriorityOverFlat(t *testing.T) {
	// Se ambas formula_item E colunas flat existirem, child tem prioridade.
	cols := fixtureSchemaNominal() // tem colunas flat
	cols["formula_item"] = map[string]bool{
		"id_formula": true, "id_corante": true, "ordem": true, "qtd_ml": true,
	}
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FlatFormulaCols: make(map[string]string),
	}
	shape := detectFormulaShape(cols, rm)
	if shape != FormulaShapeChild {
		t.Errorf("formula_item deve ter prioridade sobre flat; got %q", shape)
	}
}

func TestDetectFormulaShape_Unknown(t *testing.T) {
	cols := fixtureSchemaNominal()
	// Remove TODAS as colunas de corante da formula (sem tabela filha também).
	for i := 1; i <= 6; i++ {
		delete(cols["formula"], fmt.Sprintf("corante%d", i))
		delete(cols["formula"], fmt.Sprintf("qtd%dml", i))
	}
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FlatFormulaCols: make(map[string]string),
	}
	shape := detectFormulaShape(cols, rm)
	if shape != FormulaShapeUnknown {
		t.Errorf("esperava FormulaShapeUnknown, got %q", shape)
	}
}

// ──────────────────────────────────────────────────────────────
// Helper local: resolve mapeamento a partir de fixture
// (sem banco de dados)
// ──────────────────────────────────────────────────────────────

// resolveFromFixture executa a lógica de Validate diretamente a partir de
// um map de colunas (fixture), sem precisar de banco real.
// Espelha a lógica de Validate sem a camada de I/O do banco.
func resolveFromFixture(cols map[string]map[string]bool) (*ResolvedMapping, *SchemaDiff) {
	diff := &SchemaDiff{
		OK:        true,
		Missing:   make(map[string][]string),
		Warnings:  make(map[string][]string),
		ExtraInfo: make(map[string]string),
	}
	rm := &ResolvedMapping{
		Resolved:        make(map[string]map[string]string),
		FormulaShape:    FormulaShapeUnknown,
		FlatFormulaCols: make(map[string]string),
	}

	for _, tm := range expectedMappings() {
		tblCols, exists := cols[tm.Table]
		if !exists {
			for logicName, cm := range tm.Columns {
				if cm.Required {
					diff.Missing[tm.Table] = append(diff.Missing[tm.Table], logicName)
					diff.OK = false
				}
			}
			continue
		}

		rm.Resolved[tm.Table] = make(map[string]string)
		for logicName, cm := range tm.Columns {
			resolved := ""
			for _, cand := range cm.Candidates {
				if tblCols[strings.ToLower(cand)] {
					resolved = strings.ToLower(cand)
					break
				}
			}
			if resolved == "" {
				if cm.Required {
					diff.Missing[tm.Table] = append(diff.Missing[tm.Table], logicName)
					diff.OK = false
				} else {
					diff.Warnings[tm.Table] = append(diff.Warnings[tm.Table], logicName)
				}
			} else {
				rm.Resolved[tm.Table][logicName] = resolved
			}
		}
	}

	rm.FormulaShape = detectFormulaShape(cols, rm)
	diff.ExtraInfo["formula_shape"] = string(rm.FormulaShape)
	// Espelha Validate (F4): aviso de ambiguidade da embalagem de formulação.
	noteFormulationAmbiguity(cols, "formula", diff)
	noteFormulationAmbiguity(cols, "formulaperson", diff)
	return rm, diff
}
