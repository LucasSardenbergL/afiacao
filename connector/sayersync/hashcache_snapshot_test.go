// hashcache_snapshot_test.go — a poda do hash-cache pelo keys-snapshot, que é o
// que deixa o filtro por hash valer em delta (formulaperson) sem reabrir o furo do
// delete+recreate idêntico (Codex 4ª passada).
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A projeção da chave de cache tem que ser a linha do snapshot da MESMA fórmula
// fonte — inclusive com bytes que colidiriam num split ingênuo.
func TestLinhaSnapshotDaChave_roundtrip(t *testing.T) {
	casos := []struct{ cor, prod, base, emb string }{
		{"5059 - BS", "FO87.6782", "8", "1"},
		{"a|b", "1:2", "", "9"},
		{"12:x", "|", "3:abc", ""},
	}
	for _, person := range []bool{false, true} {
		for _, c := range casos {
			key := keyDe(c.cor, c.prod, c.base, c.emb, person)
			got, ok := linhaSnapshotDaChave(key)
			if !ok {
				t.Fatalf("chave válida %q não decodificou", key)
			}
			want := c.cor + "|" + c.prod + "|" + c.base + "|" + map[bool]string{false: "false", true: "true"}[person]
			if got != want {
				t.Fatalf("chave %q → %q, esperava %q", key, got, want)
			}
		}
	}
}

func TestLinhaSnapshotDaChave_formatoInesperado(t *testing.T) {
	for _, key := range []string{
		"",
		"5059 - BS|FO87.6782|8|1|false", // formato antigo
		"talvez|1:a1:b1:c1:d",
		"true|1:a1:b1:c",       // 3 campos
		"true|1:a1:b1:c1:d1:e", // sobra
		"true|9:a1:b1:c1:d",    // comprimento maior que o resto
		"true|01:a1:b1:c1:d",   // zero à esquerda (não é o que writeLP gera)
		"true|-1:a1:b1:c1:d",
	} {
		if linha, ok := linhaSnapshotDaChave(key); ok {
			t.Fatalf("chave malformada %q decodificou como %q", key, linha)
		}
	}
}

func TestPodarHashesPeloSnapshot(t *testing.T) {
	hc := newHashCache()
	vivaE1 := keyDe("CORA", "PA", "BA", "E1", true)
	vivaE2 := keyDe("CORA", "PA", "BA", "E2", true) // outra embalagem da MESMA fórmula fonte
	sumiu := keyDe("CORB", "PB", "BB", "E1", true)
	outroNamespace := keyDe("CORA", "PA", "BA", "E1", false) // mesma cor/produto/base, padrão
	padraoViva := keyDe("CORC", "PC", "BC", "E1", false)
	legado := "5059 - BS|FO87.6782|8|1|false"
	for _, k := range []string{vivaE1, vivaE2, sumiu, outroNamespace, padraoViva, legado} {
		hc.Set(k, "h")
	}

	podadas := podarHashesPeloSnapshot(hc, []string{"CORA|PA|BA|true", "CORC|PC|BC|false"})

	if podadas != 3 {
		t.Fatalf("esperava podar 3 (sumiu, outroNamespace, legado), podou %d", podadas)
	}
	for _, k := range []string{vivaE1, vivaE2, padraoViva} {
		if _, ok := hc.Get(k); !ok {
			t.Fatalf("podou chave viva %q", k)
		}
	}
	for _, k := range []string{sumiu, outroNamespace, legado} {
		if _, ok := hc.Get(k); ok {
			t.Fatalf("não podou %q, ausente do snapshot", k)
		}
	}
}

// A identidade da chave de cache (mapFormula) e a do snapshot (chavesDoSnapshot)
// têm que traduzir os MESMOS ids crus para a MESMA linha. Se divergirem, a poda tira
// tudo do cache todo dia (reenvio em massa) — este teste segura a deriva.
func TestPoda_identidadeDoPayloadCasaComOSnapshot(t *testing.T) {
	lk := newLookups()
	lk.CorPadrao["5"] = corInfo{CorID: "PAD-5", Nome: "Azul"}
	lk.CorPerson["5"] = corInfo{CorID: "PERS-5", Nome: "Verde"}
	lk.ProdutoCod["1"] = "PRODA"
	lk.BaseIdent["2"] = "BS"
	lk.EmbIdent["9"] = "EMB9"

	for _, person := range []bool{false, true} {
		for _, raw := range []formulaKey{
			{CorID: "5", CodProduto: "1", IDBase: "2", IDEmb: "9", Personalizada: person},
			{CorID: "77", CodProduto: "88", IDBase: "99", IDEmb: "9", Personalizada: person}, // sem lookup → id cru
		} {
			m := mapFormula(fxRow(raw.CorID, raw.CodProduto, raw.IDBase, raw.IDEmb,
				[]map[string]any{item("C1", 1, 1.0)}), person, lk)
			if m == nil {
				t.Fatalf("mapFormula descartou %+v", raw)
			}
			linha, ok := linhaSnapshotDaChave(formulaCacheKey(m))
			if !ok {
				t.Fatalf("chave de %+v não decodificou", raw)
			}
			snap := chavesDoSnapshot([]formulaKey{raw}, lk)
			if len(snap) != 1 || snap[0] != linha {
				t.Fatalf("identidade divergiu para %+v: cache→%q, snapshot→%v", raw, linha, snap)
			}
		}
	}
}

// testeSnapshot monta o servidor fake que registra, a cada POST /keys-snapshot, se a
// chave vigiada ainda estava no hashes.json EM DISCO naquele instante.
type testeSnapshot struct {
	dir            string
	vigiada        string
	snapshots      int
	vigiadaNoDisco []bool
	formulasPostes int
}

func (s *testeSnapshot) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/keys-snapshot":
		s.snapshots++
		var disco HashCache
		raw, err := os.ReadFile(filepath.Join(s.dir, "hashes.json"))
		if err == nil {
			_ = json.Unmarshal(raw, &disco)
		}
		_, presente := disco.Formulas[s.vigiada]
		s.vigiadaNoDisco = append(s.vigiadaNoDisco, presente)
	case "/formulas":
		s.formulasPostes++
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func isolarStateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	antes := stateDir
	stateDir = func() string { return dir }
	t.Cleanup(func() { stateDir = antes })
	return dir
}

// O cenário do furo, ponta a ponta: a personalizada é aceita e cacheada, some da
// origem, o snapshot a desativa no servidor e ela VOLTA idêntica dentro da janela do
// HWM. Tem que ser reenviada — e a poda tem que estar em disco antes do snapshot sair.
func TestSnapshot_deleteRecreateIdenticoReenvia(t *testing.T) {
	dir := isolarStateDir(t)
	key := keyDe("CORA", "PA", "BA", "EA", true)
	srv := &testeSnapshot{dir: dir, vigiada: key}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	cli := newTestClient(ts.URL)
	rm := newFakeMapping([]string{"formulaperson"}, FormulaShapeFlat)
	hc := newHashCache()
	st := &State{HWM: map[string]string{"formulaperson": "2026-10-27T13:00:00Z"}}
	counts := make(map[string]int)
	ctx := context.Background()
	linha := fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)})
	ex := &fakeExtractor{
		rows:      map[string][]map[string]any{"formulaperson": {linha}},
		originNow: time.Date(2026, 10, 27, 14, 0, 0, 0, time.UTC),
	}

	// 1. Delta envia e cacheia; o ciclo seguinte (mesma linha na janela) não reenvia.
	for i := 0; i < 2; i++ {
		if err := syncFormulas(ctx, ex, cli, st, counts, rm, true, newLookups(), hc); err != nil {
			t.Fatalf("ciclo %d: %v", i+1, err)
		}
	}
	if srv.formulasPostes != 1 {
		t.Fatalf("esperava 1 POST /formulas antes da deleção, houve %d", srv.formulasPostes)
	}
	if err := SaveHashCache(hc); err != nil {
		t.Fatal(err)
	}

	// 2. Some da origem → snapshot sem a chave → poda persistida ANTES do envio.
	ex.rows["formulaperson"] = nil
	ex.formulas = []formulaKey{{CorID: "OUTRA", CodProduto: "P", IDBase: "B", IDEmb: "E", Personalizada: true}}
	if err := podarEEnviarKeysSnapshot(ctx, cfg, ex, ex.originNow, newLookups(), hc); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if srv.snapshots != 1 || len(srv.vigiadaNoDisco) != 1 || srv.vigiadaNoDisco[0] {
		t.Fatalf("a chave sumida ainda estava no hashes.json quando o snapshot saiu (snapshots=%d, noDisco=%v)",
			srv.snapshots, srv.vigiadaNoDisco)
	}

	// 3. Volta idêntica no delta → reenvia.
	ex.rows["formulaperson"] = []map[string]any{linha}
	if err := syncFormulas(ctx, ex, cli, st, counts, rm, true, newLookups(), hc); err != nil {
		t.Fatalf("ciclo pós-recriação: %v", err)
	}
	if srv.formulasPostes != 2 {
		t.Fatalf("fórmula recriada idêntica depois do snapshot NÃO foi reenviada (POSTs /formulas=%d, esperava 2)", srv.formulasPostes)
	}
}

// CONTROLE do anterior: se a fórmula some e volta ENTRE dois snapshots, o servidor
// nunca a desativou — pular o reenvio é o certo, e o snapshot com ela presente não poda.
func TestSnapshot_formulaPresenteNaoPoda(t *testing.T) {
	dir := isolarStateDir(t)
	key := keyDe("CORA", "PA", "BA", "EA", true)
	srv := &testeSnapshot{dir: dir, vigiada: key}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	hc := newHashCache()
	hc.Set(key, "h")
	ex := &fakeExtractor{
		formulas:  []formulaKey{{CorID: "CORA", CodProduto: "PA", IDBase: "BA", IDEmb: "outra-emb", Personalizada: true}},
		originNow: time.Date(2026, 10, 27, 14, 0, 0, 0, time.UTC),
	}
	if err := podarEEnviarKeysSnapshot(context.Background(), cfg, ex, ex.originNow, newLookups(), hc); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if _, ok := hc.Get(key); !ok {
		t.Fatal("podou a chave de uma fórmula fonte presente no snapshot")
	}
}

// Se a poda não persiste, o snapshot NÃO sai (o servidor desativaria fórmulas cujo
// hash continuaria no disco).
func TestSnapshot_saveFalhaNaoEnvia(t *testing.T) {
	arquivo := filepath.Join(t.TempDir(), "nao-e-dir")
	if err := os.WriteFile(arquivo, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	antes := stateDir
	stateDir = func() string { return arquivo } // hashes.json "dentro de um arquivo" → save falha
	t.Cleanup(func() { stateDir = antes })

	srv := &testeSnapshot{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	hc := newHashCache()
	hc.Set(keyDe("CORB", "PB", "BB", "EB", true), "h") // será podada → cache dirty → save tenta
	ex := &fakeExtractor{formulas: []formulaKey{{CorID: "CORA", CodProduto: "PA", IDBase: "BA", IDEmb: "E", Personalizada: true}}}

	if err := podarEEnviarKeysSnapshot(context.Background(), cfg, ex, time.Now(), newLookups(), hc); err == nil {
		t.Fatal("save da poda falhou e o snapshot não reportou erro")
	}
	if srv.snapshots != 0 {
		t.Fatalf("snapshot saiu (%d POST) com a poda fora do disco", srv.snapshots)
	}
}

// Codex P1 (revisão do 2da786a9): um hashes.json v1 (≤0.2.5) não satisfaz a invariante
// da poda — o snapshot antigo desativava a personalizada sem tirá-la do cache. A carga
// descarta os hashes de personalizada e mantém os de padrão.
func TestHashCache_v1DescartaPersonalizada(t *testing.T) {
	person := keyDe("CORA", "PA", "BA", "EA", true)
	padrao := keyDe("CORB", "PB", "BB", "EB", false)
	for _, versao := range []string{`"version":1,`, ``} { // v1 explícito e arquivo sem versão
		path := filepath.Join(t.TempDir(), "hashes.json")
		raw := `{` + versao + `"formulas":{"` + person + `":"h1","` + padrao + `":"h2"}}`
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		hc, err := loadHashCacheFrom(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := hc.Get(person); ok {
			t.Fatalf("cache %q manteve hash de personalizada", versao)
		}
		if h, ok := hc.Get(padrao); !ok || h != "h2" {
			t.Fatalf("cache %q perdeu o hash de padrão", versao)
		}
		if hc.Version != hashCacheVersion || !hc.Dirty() {
			t.Fatalf("cache %q não migrou (version=%d dirty=%v)", versao, hc.Version, hc.Dirty())
		}
	}
}

// CONTROLE: cache já v2 carrega intacto.
func TestHashCache_v2CarregaIntacto(t *testing.T) {
	person := keyDe("CORA", "PA", "BA", "EA", true)
	path := filepath.Join(t.TempDir(), "hashes.json")
	raw := `{"version":2,"formulas":{"` + person + `":"h1"}}`
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	hc, err := loadHashCacheFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := hc.Get(person); !ok || hc.Dirty() {
		t.Fatalf("cache v2 mexido na carga (presente=%v dirty=%v)", ok, hc.Dirty())
	}
}

// O cenário do Codex ponta a ponta: a 0.2.5 cacheou a personalizada, o snapshot dela
// a desativou no servidor sem podar o cache, e ela volta idêntica no 1º ciclo da
// versão nova. Tem que ser reenviada.
func TestUpgrade_cacheV1PersonalizadaVoltaIdenticaReenvia(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	rm := newFakeMapping([]string{"formulaperson"}, FormulaShapeFlat)
	st := &State{HWM: map[string]string{"formulaperson": "2026-10-27T13:00:00Z"}}
	linha := fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)})
	ex := &fakeExtractor{rows: map[string][]map[string]any{"formulaperson": {linha}}}

	m := mapFormula(linha, true, newLookups())
	path := filepath.Join(t.TempDir(), "hashes.json")
	raw, _ := json.Marshal(map[string]any{"version": 1, "formulas": map[string]string{
		formulaCacheKey(m): formulaContentHash(m), // hash EXATO do conteúdo que volta
	}})
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	hc, err := loadHashCacheFrom(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := syncFormulas(context.Background(), ex, cli, st, make(map[string]int), rm, true, newLookups(), hc); err != nil {
		t.Fatal(err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 1 {
		t.Fatalf("personalizada com hash herdado da v1 foi pulada (POSTs /formulas=%d, esperava 1)", got)
	}
}
