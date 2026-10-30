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

// Codex P1 (2 rodadas): o último keys-snapshot do state.json pode ter saído de um
// código que não poda (≤0.2.5 — upgrade direto, ou downgrade e volta). Nesse caso os
// hashes de personalizada saem; os de padrão ficam.
func TestAlinhar_snapshotNaoPodadoDescartaPersonalizada(t *testing.T) {
	person := keyDe("CORA", "PA", "BA", "EA", true)
	padrao := keyDe("CORB", "PB", "BB", "EB", false)
	for _, marca := range []string{"", "2026-10-27T10:00:00Z"} { // cache da 0.2.5 (sem marca) e downgrade-e-volta
		hc := newHashCache()
		hc.SnapshotPodado = marca
		hc.Set(person, "h1")
		hc.Set(padrao, "h2")
		hc.clearDirty()

		alinharCacheAoSnapshot(hc, "2026-10-28T10:00:00Z")

		if _, ok := hc.Get(person); ok {
			t.Fatalf("marca %q: manteve hash de personalizada", marca)
		}
		if h, ok := hc.Get(padrao); !ok || h != "h2" {
			t.Fatalf("marca %q: perdeu hash de padrão", marca)
		}
		if hc.SnapshotPodado != "2026-10-28T10:00:00Z" || !hc.Dirty() {
			t.Fatalf("marca %q: não alinhou (marca=%q dirty=%v)", marca, hc.SnapshotPodado, hc.Dirty())
		}
	}
}

// CONTROLE: snapshot podado por este código (ou nenhum snapshot ainda) não mexe.
func TestAlinhar_snapshotPodadoNaoMexe(t *testing.T) {
	person := keyDe("CORA", "PA", "BA", "EA", true)
	for _, marca := range []string{"2026-10-28T10:00:00Z", ""} {
		hc := newHashCache()
		hc.SnapshotPodado = marca
		hc.Set(person, "h1")
		hc.clearDirty()
		alinharCacheAoSnapshot(hc, marca)
		if _, ok := hc.Get(person); !ok || hc.Dirty() {
			t.Fatalf("marca %q igual ao state: cache mexido (presente=%v dirty=%v)", marca, ok, hc.Dirty())
		}
	}
}

// A marca só é gravada depois do ENVIO do snapshot, com o valor que vira LastKeysSnapshot.
func TestSnapshot_marcaGravadaSoAposEnvio(t *testing.T) {
	dir := isolarStateDir(t)
	originNow := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	ex := &fakeExtractor{formulas: []formulaKey{{CorID: "CORA", CodProduto: "PA", IDBase: "BA", IDEmb: "E", Personalizada: true}}}

	// Envio falha (servidor 500) → marca não muda.
	ruim := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer ruim.Close()
	hc := newHashCache()
	hc.SnapshotPodado = "anterior"
	cfg := &Config{AppURL: ruim.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	if err := podarEEnviarKeysSnapshot(context.Background(), cfg, ex, originNow, newLookups(), hc); err == nil {
		t.Fatal("envio com 500 não reportou erro")
	}
	if hc.SnapshotPodado != "anterior" {
		t.Fatalf("marca avançou (%q) sem o snapshot ter sido aceito", hc.SnapshotPodado)
	}

	// Envio ok → marca = originNow em RFC3339, persistida.
	srv := &testeSnapshot{dir: dir}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cfg.AppURL = ts.URL
	if err := podarEEnviarKeysSnapshot(context.Background(), cfg, ex, originNow, newLookups(), hc); err != nil {
		t.Fatal(err)
	}
	want := originNow.Format(time.RFC3339)
	disco, err := loadHashCacheFrom(filepath.Join(dir, "hashes.json"))
	if err != nil {
		t.Fatal(err)
	}
	if hc.SnapshotPodado != want || disco.SnapshotPodado != want {
		t.Fatalf("marca após envio: memória=%q disco=%q, esperava %q", hc.SnapshotPodado, disco.SnapshotPodado, want)
	}
}

// Ponta a ponta do P1: a versão nova cacheia a personalizada (marca T1); a 0.2.5
// roda um snapshot que a desativa sem podar e avança o state para T2; a versão nova
// volta e a fórmula reaparece idêntica → tem que reenviar.
func TestDowngradeEVolta_personalizadaIdenticaReenvia(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	rm := newFakeMapping([]string{"formulaperson"}, FormulaShapeFlat)
	st := &State{HWM: map[string]string{"formulaperson": "2026-10-27T13:00:00Z"}, LastKeysSnapshot: "2026-10-27T10:00:00Z"}
	linha := fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)})
	ex := &fakeExtractor{rows: map[string][]map[string]any{"formulaperson": {linha}}}
	ctx := context.Background()

	hc := newHashCache()
	hc.SnapshotPodado = st.LastKeysSnapshot
	if err := syncFormulas(ctx, ex, cli, st, make(map[string]int), rm, true, newLookups(), hc); err != nil {
		t.Fatal(err)
	}
	if srv.countPathPrefix("/formulas") != 1 {
		t.Fatal("envio inicial não aconteceu")
	}

	st.LastKeysSnapshot = "2026-10-28T10:00:00Z" // snapshot da 0.2.5: desativou, não podou
	alinharCacheAoSnapshot(hc, st.LastKeysSnapshot)
	if err := syncFormulas(ctx, ex, cli, st, make(map[string]int), rm, true, newLookups(), hc); err != nil {
		t.Fatal(err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 2 {
		t.Fatalf("personalizada idêntica após snapshot não podado foi pulada (POSTs /formulas=%d, esperava 2)", got)
	}
}

// Ligação: o RunCycle real alinha o cache ao state ANTES de sincronizar. Sem full
// rescan, sem snapshot no dia e formulaperson em delta — a única coisa que pode tirar
// a personalizada do cache é o alinhamento.
func TestRunCycle_alinhaCacheAoSnapshotDoState(t *testing.T) {
	c := prepararCiclo(t, schemaComVendasItem())
	agora := time.Now().UTC()
	c.ex.originNow = agora
	c.ex.rows["formula"] = []map[string]any{fxRow("CORB", "PB", "BB", "EB", []map[string]any{item("C2", 1, 2.0)})}
	person := keyDe("CORA", "PA", "BA", "EA", true)
	padrao := keyDe("CORB", "PB", "BB", "EB", false)

	st := &State{
		HWM:              map[string]string{"formulaperson": agora.Add(-time.Hour).Format(time.RFC3339)},
		LastFullRescan:   agora.Format(time.RFC3339),
		LastKeysSnapshot: agora.Format(time.RFC3339), // snapshot de hoje, feito por quem não poda
	}
	if err := SaveState(st); err != nil {
		t.Fatal(err)
	}
	hc := newHashCache()
	hc.SnapshotPodado = agora.Add(-24 * time.Hour).Format(time.RFC3339)
	hc.Set(person, "h1")
	hc.Set(padrao, "h2")
	if err := SaveHashCache(hc); err != nil {
		t.Fatal(err)
	}

	RunCycle(context.Background(), c.cfg)

	if c.srv.countPathPrefix("/keys-snapshot") != 0 {
		t.Fatal("o teste pressupõe ciclo sem snapshot (ele podaria por conta própria)")
	}
	disco, err := LoadHashCache()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := disco.Get(person); ok {
		t.Fatal("RunCycle não descartou a personalizada com o último snapshot não podado")
	}
	if _, ok := disco.Get(padrao); !ok {
		t.Fatal("RunCycle descartou hash de padrão")
	}
}
