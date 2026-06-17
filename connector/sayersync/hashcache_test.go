// hashcache_test.go — testes do cache de hashes de conteúdo das fórmulas.
//
// O cache resolve o LOOP de re-envio: a tabela FORMULA da origem tem
// data_atualizacao sempre NULL, então o HWM nunca avança e o conector re-enviava
// todas as ~485k fórmulas a cada ciclo. A detecção por hash de CONTEÚDO envia só
// o que mudou. Estes testes blindam a estabilidade do hash (precisão > recall:
// um falso-negativo deixa o catálogo de produção desatualizado).
package main

import (
	"testing"
)

// ─────────────────────────────────────────────────────────────
// formulaContentHash — hash estável do payload canônico
// ─────────────────────────────────────────────────────────────

// fxFormula monta um payload de fórmula como o que mapFormula+traduzItensCorante
// produzem (o que de fato é POSTado em /formulas).
func fxFormula() map[string]any {
	return map[string]any{
		"cor_id":          "5059 - BS",
		"cod_produto":     "FO87.6782",
		"id_base":         "8",
		"id_embalagem":    "1",
		"personalizada":   false,
		"nome_cor":        "BEGE 059 - BS",
		"subcolecao":      "SL",
		"volume_final_ml": float64(810),
		"itens": []map[string]any{
			{"id_corante": "2", "ordem": 1, "qtd_ml": float64(5.16)},
			{"id_corante": "13", "ordem": 2, "qtd_ml": float64(2.4645)},
			{"id_corante": "14", "ordem": 3, "qtd_ml": float64(0.7701)},
		},
	}
}

func TestFormulaContentHash_estavel(t *testing.T) {
	a := formulaContentHash(fxFormula())
	b := formulaContentHash(fxFormula())
	if a == "" {
		t.Fatal("hash vazio")
	}
	if a != b {
		t.Fatalf("hash não-determinístico: %q != %q", a, b)
	}
}

func TestFormulaContentHash_ordemDosItensNaoImporta(t *testing.T) {
	m1 := fxFormula()
	m2 := fxFormula()
	// Inverte a ordem dos itens em m2 (mesmo conteúdo, ordem diferente de chegada).
	it := m2["itens"].([]map[string]any)
	m2["itens"] = []map[string]any{it[2], it[0], it[1]}

	if formulaContentHash(m1) != formulaContentHash(m2) {
		t.Fatal("hash mudou só por reordenar itens — deve ser invariante à ordem")
	}
}

func TestFormulaContentHash_conteudoDiferenteMudaHash(t *testing.T) {
	base := formulaContentHash(fxFormula())

	cases := map[string]func(m map[string]any){
		"qtd_ml de um item":  func(m map[string]any) { m["itens"].([]map[string]any)[0]["qtd_ml"] = float64(9.99) },
		"id_corante de item": func(m map[string]any) { m["itens"].([]map[string]any)[0]["id_corante"] = "99" },
		"ordem de um item":   func(m map[string]any) { m["itens"].([]map[string]any)[0]["ordem"] = 6 },
		"cor_id":             func(m map[string]any) { m["cor_id"] = "OUTRA" },
		"id_base":            func(m map[string]any) { m["id_base"] = "9" },
		"id_embalagem":       func(m map[string]any) { m["id_embalagem"] = "2" },
		"volume_final_ml":    func(m map[string]any) { m["volume_final_ml"] = float64(3600) },
		"nome_cor":           func(m map[string]any) { m["nome_cor"] = "OUTRO NOME" },
		"subcolecao":         func(m map[string]any) { m["subcolecao"] = "XX" },
		"personalizada":      func(m map[string]any) { m["personalizada"] = true },
		"item a mais": func(m map[string]any) {
			m["itens"] = append(m["itens"].([]map[string]any), map[string]any{"id_corante": "7", "ordem": 4, "qtd_ml": float64(1.0)})
		},
		"item a menos": func(m map[string]any) { m["itens"] = m["itens"].([]map[string]any)[:2] },
	}
	for nome, mutar := range cases {
		m := fxFormula()
		mutar(m)
		if got := formulaContentHash(m); got == base {
			t.Errorf("mudança em %q NÃO alterou o hash (falso-negativo: catálogo ficaria stale)", nome)
		}
	}
}

func TestFormulaContentHash_quantizaRuidoDeFloat(t *testing.T) {
	// 5.159999847412109 = float32(5.16) promovido a float64 (visto no staging real).
	// Quantizar a 4 casas deve produzir o MESMO hash que 5.16 — senão o conector
	// re-envia espúrio a cada ciclo (recria o loop).
	m2 := fxFormula()
	m2["itens"].([]map[string]any)[0]["qtd_ml"] = float64(5.159999847412109)
	if formulaContentHash(fxFormula()) != formulaContentHash(m2) {
		t.Fatal("ruído de float em qtd_ml (5.159999847412109 vs 5.16) mudou o hash — falta quantização")
	}

	// Ruído sub-resolução em volume_final_ml também é absorvido (810.00003 → 810.0000).
	m3 := fxFormula()
	m3["volume_final_ml"] = float64(810.00003)
	if formulaContentHash(fxFormula()) != formulaContentHash(m3) {
		t.Fatal("ruído de float em volume_final_ml (810.00003 vs 810) mudou o hash")
	}

	// Mas mudança REAL acima da resolução (>= 0.0001 ml) DEVE ser detectada.
	m4 := fxFormula()
	m4["itens"].([]map[string]any)[0]["qtd_ml"] = float64(5.1605)
	if formulaContentHash(fxFormula()) == formulaContentHash(m4) {
		t.Fatal("mudança real de 0.0005 ml NÃO foi detectada — quantização grossa demais")
	}
}

func TestFormulaContentHash_ausenteDiferenteDeVazio(t *testing.T) {
	// Presença ≠ ausência (Codex #1): nome_cor ausente não é o mesmo input canônico
	// que nome_cor="".
	comVazio := fxFormula()
	comVazio["nome_cor"] = ""
	semCampo := fxFormula()
	delete(semCampo, "nome_cor")

	if formulaContentHash(comVazio) == formulaContentHash(semCampo) {
		t.Fatal("nome_cor='' e nome_cor ausente produziram o mesmo hash")
	}

	// idem subcolecao e volume_final_ml.
	comVol := fxFormula()
	semVol := fxFormula()
	delete(semVol, "volume_final_ml")
	if formulaContentHash(comVol) == formulaContentHash(semVol) {
		t.Fatal("volume_final_ml presente e ausente produziram o mesmo hash")
	}
}

func TestFormulaContentHash_encodingInjetivo(t *testing.T) {
	// Codex review P2: sem length-prefix, mover um byte separador entre campos
	// adjacentes colide. "A\x1fB" | "C"  vs  "A" | "B\x1fC" devem dar hashes
	// DIFERENTES (senão é falso-negativo: duas fórmulas distintas com 1 hash).
	a := fxFormula()
	a["cor_id"] = "A\x1fB"
	a["cod_produto"] = "C"
	b := fxFormula()
	b["cor_id"] = "A"
	b["cod_produto"] = "B\x1fC"
	if formulaContentHash(a) == formulaContentHash(b) {
		t.Fatal("colisão de fronteira entre campos — encoding não é injetivo (falta length-prefix)")
	}

	// Idem entre itens: mover um item-corante de fronteira não pode colidir.
	c := fxFormula()
	c["itens"] = []map[string]any{{"id_corante": "1", "ordem": 1, "qtd_ml": 2.0}}
	d := fxFormula()
	d["itens"] = []map[string]any{{"id_corante": "1", "ordem": 1, "qtd_ml": 20.0}}
	if formulaContentHash(c) == formulaContentHash(d) {
		t.Fatal("qtd 2.0 vs 20.0 colidiram — fronteira de item não injetiva")
	}
}

func TestFormulaContentHash_itensVazioOuAusente(t *testing.T) {
	semItens := fxFormula()
	delete(semItens, "itens")
	itensVazio := fxFormula()
	itensVazio["itens"] = []map[string]any{}
	// Ambos "sem itens" — devem ser estáveis e iguais entre si (lista vazia ==
	// ausência de itens é aceitável; o importante é não quebrar).
	if formulaContentHash(semItens) == "" || formulaContentHash(itensVazio) == "" {
		t.Fatal("hash de fórmula sem itens não deve ser vazio")
	}
}

// ─────────────────────────────────────────────────────────────
// formulaCacheKey — identidade da linha enviada (por-embalagem)
// ─────────────────────────────────────────────────────────────

func TestFormulaCacheKey_deterministica(t *testing.T) {
	a := formulaCacheKey(fxFormula())
	b := formulaCacheKey(fxFormula())
	if a == "" || a != b {
		t.Fatalf("chave não-determinística: %q vs %q", a, b)
	}
}

func TestFormulaCacheKey_injetiva(t *testing.T) {
	// Codex review P2: a chave não pode colidir se um campo de identidade contém o
	// separador "|" — senão duas fórmulas distintas dividem a mesma entrada de cache
	// e alternam o hash (re-send loop só nelas).
	a := formulaCacheKey(map[string]any{"cor_id": "A|B", "cod_produto": "C", "id_base": "1", "id_embalagem": "1", "personalizada": false})
	b := formulaCacheKey(map[string]any{"cor_id": "A", "cod_produto": "B|C", "id_base": "1", "id_embalagem": "1", "personalizada": false})
	if a == b {
		t.Fatal("chaves colidiram com '|' no conteúdo — formulaCacheKey não é injetiva")
	}
}

func TestFormulaCacheKey_distinguePersonalizada(t *testing.T) {
	a := fxFormula()
	b := fxFormula()
	b["personalizada"] = true
	if formulaCacheKey(a) == formulaCacheKey(b) {
		t.Fatal("personalizada true/false produziu a mesma chave")
	}
}

func TestFormulaCacheKey_distingueEmbalagem(t *testing.T) {
	// Cada linha enviada é por-embalagem; itens escalam com o volume (Codex #3).
	a := fxFormula()
	b := fxFormula()
	b["id_embalagem"] = "2"
	if formulaCacheKey(a) == formulaCacheKey(b) {
		t.Fatal("embalagens diferentes produziram a mesma chave — colapsaria linhas distintas")
	}
}
