// sync_test.go — testes da lógica de sync (sync.go) sem banco PG real.
//
// Usa a interface Extractor para injetar fixtures; usa httptest para o servidor.
// Não há dependência de banco de dados ou PG real.
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────
// fakeExtractor — implementação de Extractor para testes
// ─────────────────────────────────────────────────────────────

// fakeExtractor responde às extrações com dados pré-configurados.
type fakeExtractor struct {
	// rows retorna []map[string]any + maxDA por entidade.
	rows map[string][]map[string]any
	// maxDA por entidade (zero = não avança HWM).
	maxDA map[string]time.Time
	// formulas para o keys-snapshot.
	formulas []formulaKey
	// corNames para lookup de nome_cor em mapFormula.
	corNames map[string]string
	// embVolumes para lookup de volume_final_ml em mapFormula.
	embVolumes map[string]float64
	// originNow é o valor retornado por OriginNow().
	originNow time.Time
	// err: se definido, todas as chamadas retornam esse erro.
	err error
}

func (f *fakeExtractor) Extract(_ context.Context, entity string, _ time.Time) ([]map[string]any, time.Time, error) {
	if f.err != nil {
		return nil, time.Time{}, f.err
	}
	rows := f.rows[entity]
	maxDA := f.maxDA[entity]
	return rows, maxDA, nil
}

func (f *fakeExtractor) ExtractAllFormulasForSnapshot(_ context.Context) ([]formulaKey, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.formulas, nil
}

func (f *fakeExtractor) ExtractAllCorNames(_ context.Context) (map[string]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.corNames != nil {
		return f.corNames, nil
	}
	return make(map[string]string), nil
}

func (f *fakeExtractor) ExtractAllEmbVolumes(_ context.Context) (map[string]float64, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.embVolumes != nil {
		return f.embVolumes, nil
	}
	return make(map[string]float64), nil
}

func (f *fakeExtractor) OriginNow(_ context.Context) (time.Time, error) {
	if f.err != nil {
		return time.Time{}, f.err
	}
	if f.originNow.IsZero() {
		return time.Now(), nil
	}
	return f.originNow, nil
}

// newFakeExtractor cria um fakeExtractor vazio.
func newFakeExtractor() *fakeExtractor {
	return &fakeExtractor{
		rows:  make(map[string][]map[string]any),
		maxDA: make(map[string]time.Time),
	}
}

// ─────────────────────────────────────────────────────────────
// fakeResolvedMapping — mapping mínimo para testes
// ─────────────────────────────────────────────────────────────

// newFakeMapping cria um ResolvedMapping contendo as entidades passadas.
func newFakeMapping(entities []string, shape FormulaShape) *ResolvedMapping {
	rm := &ResolvedMapping{
		FormulaShape: shape,
		Resolved:     make(map[string]map[string]string),
	}
	for _, e := range entities {
		rm.Resolved[e] = map[string]string{}
	}
	return rm
}

// ─────────────────────────────────────────────────────────────
// helpers de servidor de teste
// ─────────────────────────────────────────────────────────────

// captureServer registra todos os POSTs recebidos.
type captureServer struct {
	requests []capturedRequest
	response AgentResponse
	statusFn func(path string) int // se nil, retorna 200
}

type capturedRequest struct {
	Path           string
	Body           map[string]any
	IdempotencyKey string
}

func (cs *captureServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(b, &body)
	cs.requests = append(cs.requests, capturedRequest{
		Path:           r.URL.Path,
		Body:           body,
		IdempotencyKey: r.Header.Get("x-idempotency-key"),
	})

	status := 200
	if cs.statusFn != nil {
		status = cs.statusFn(r.URL.Path)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	resp := cs.response
	resp.OK = status < 300
	_ = json.NewEncoder(w).Encode(resp)
}

func (cs *captureServer) countPathPrefix(prefix string) int {
	n := 0
	for _, r := range cs.requests {
		if strings.HasPrefix(r.Path, prefix) {
			n++
		}
	}
	return n
}

// ─────────────────────────────────────────────────────────────
// TestShouldKeysSnapshot
// ─────────────────────────────────────────────────────────────

func TestShouldKeysSnapshot_firstRun(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	// Sem snapshot anterior → deve enviar.
	if !shouldKeysSnapshot(st, time.Now()) {
		t.Error("primeira execução deve disparar keys-snapshot")
	}
}

func TestShouldKeysSnapshot_sameDay(t *testing.T) {
	now := time.Date(2026, 6, 9, 14, 0, 0, 0, time.UTC)
	st := &State{
		HWM:              make(map[string]string),
		LastKeysSnapshot: now.Add(-2 * time.Hour).Format(time.RFC3339),
	}
	if shouldKeysSnapshot(st, now) {
		t.Error("mesmo dia não deve re-enviar keys-snapshot")
	}
}

func TestShouldKeysSnapshot_nextDay(t *testing.T) {
	yesterday := time.Date(2026, 6, 8, 23, 59, 0, 0, time.UTC)
	today := time.Date(2026, 6, 9, 0, 1, 0, 0, time.UTC)
	st := &State{
		HWM:              make(map[string]string),
		LastKeysSnapshot: yesterday.Format(time.RFC3339),
	}
	if !shouldKeysSnapshot(st, today) {
		t.Error("dia diferente deve disparar keys-snapshot")
	}
}

func TestShouldKeysSnapshot_invalidDate(t *testing.T) {
	st := &State{
		HWM:              make(map[string]string),
		LastKeysSnapshot: "INVALID",
	}
	if !shouldKeysSnapshot(st, time.Now()) {
		t.Error("data inválida deve disparar keys-snapshot")
	}
}

// ─────────────────────────────────────────────────────────────
// TestShouldFullRescan
// ─────────────────────────────────────────────────────────────

func TestShouldFullRescan_notSunday(t *testing.T) {
	// Terça-feira
	tuesday := time.Date(2026, 6, 9, 10, 0, 0, 0, time.UTC)
	st := &State{HWM: make(map[string]string)}
	if shouldFullRescan(st, tuesday) {
		t.Error("terça-feira não deve disparar full rescan")
	}
}

func TestShouldFullRescan_sundayFirstTime(t *testing.T) {
	// Domingo, nunca rescaneado.
	sunday := time.Date(2026, 6, 7, 9, 0, 0, 0, time.UTC) // 7/jun/2026 é domingo
	if sunday.Weekday() != time.Sunday {
		t.Skip("ajustar data de teste para domingo")
	}
	st := &State{HWM: make(map[string]string)}
	if !shouldFullRescan(st, sunday) {
		t.Error("primeiro domingo deve disparar full rescan")
	}
}

func TestShouldFullRescan_sundaySameWeek(t *testing.T) {
	sunday := time.Date(2026, 6, 7, 9, 0, 0, 0, time.UTC)
	if sunday.Weekday() != time.Sunday {
		t.Skip("ajustar data de teste para domingo")
	}
	st := &State{
		HWM:            make(map[string]string),
		LastFullRescan: sunday.Add(-1 * time.Hour).Format(time.RFC3339), // mesma semana
	}
	if shouldFullRescan(st, sunday) {
		t.Error("domingo da mesma semana ISO não deve re-escanear")
	}
}

func TestShouldFullRescan_sundayNewWeek(t *testing.T) {
	lastSunday := time.Date(2026, 5, 31, 9, 0, 0, 0, time.UTC)
	thisSunday := time.Date(2026, 6, 7, 9, 0, 0, 0, time.UTC)
	for _, m := range []time.Time{lastSunday, thisSunday} {
		if m.Weekday() != time.Sunday {
			t.Skipf("data %s não é domingo — ajustar teste", m)
		}
	}
	st := &State{
		HWM:            make(map[string]string),
		LastFullRescan: lastSunday.Format(time.RFC3339),
	}
	if !shouldFullRescan(st, thisSunday) {
		t.Error("domingo de semana nova deve disparar full rescan")
	}
}

// ─────────────────────────────────────────────────────────────
// TestHWM helpers
// ─────────────────────────────────────────────────────────────

func TestHwmFromState_empty(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	hwm := hwmFromState(st, "produto")
	if !hwm.IsZero() {
		t.Errorf("HWM vazio deve retornar zero-time, got %v", hwm)
	}
}

func TestHwmFromState_subtractsMargin(t *testing.T) {
	now := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	st := &State{HWM: map[string]string{
		"produto": now.Format(time.RFC3339Nano),
	}}
	hwm := hwmFromState(st, "produto")
	expected := now.Add(-hwmMargin)
	if !hwm.Equal(expected) {
		t.Errorf("hwmFromState esperado %v, got %v", expected, hwm)
	}
}

func TestAdvanceHWM_advances(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	t1 := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	advanceHWM(st, "produto", t1)
	if st.HWM["produto"] == "" {
		t.Error("HWM não foi avançado")
	}
}

func TestAdvanceHWM_neverRegresses(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	t1 := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	t0 := t1.Add(-time.Hour) // anterior

	advanceHWM(st, "produto", t1)
	before := st.HWM["produto"]
	advanceHWM(st, "produto", t0)
	after := st.HWM["produto"]

	if before != after {
		t.Errorf("advanceHWM retrocedeu: %s → %s", before, after)
	}
}

func TestAdvanceHWM_zero(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	advanceHWM(st, "produto", time.Time{})
	if st.HWM["produto"] != "" {
		t.Error("zero-time não deve atualizar HWM")
	}
}

// ─────────────────────────────────────────────────────────────
// TestClearAllHWM
// ─────────────────────────────────────────────────────────────

func TestClearAllHWM(t *testing.T) {
	st := &State{HWM: map[string]string{
		"produto": "2026-01-01T00:00:00Z",
		"base":    "2026-02-01T00:00:00Z",
	}}
	clearAllHWM(st)
	if len(st.HWM) != 0 {
		t.Errorf("clearAllHWM deveria zerar todos os HWMs, tem %d", len(st.HWM))
	}
}

// ─────────────────────────────────────────────────────────────
// TestSyncSimpleEntity — envia itens e avança HWM
// ─────────────────────────────────────────────────────────────

func TestSyncSimpleEntity_sendsItemsAndAdvancesHWM(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"produto"}, FormulaShapeFlat)

	maxDA := time.Date(2026, 6, 9, 15, 0, 0, 0, time.UTC)
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"produto": {
				{"id_produto": "P001", "descricao": "Tinta X"},
				{"id_produto": "P002", "descricao": "Tinta Y"},
			},
		},
		maxDA: map[string]time.Time{"produto": maxDA},
	}

	err := syncSimpleEntity(context.Background(), ex, cli, st, counts, rm, "produto", "produtos", mapProduto)
	if err != nil {
		t.Fatalf("syncSimpleEntity falhou: %v", err)
	}

	// Deve ter enviado 1 POST para /catalogs.
	if srv.countPathPrefix("/catalogs") != 1 {
		t.Errorf("esperava 1 POST /catalogs, got %d", srv.countPathPrefix("/catalogs"))
	}

	// HWM deve ter avançado.
	if st.HWM["produto"] == "" {
		t.Error("HWM de 'produto' não foi avançado")
	}

	// Contador deve ser 2.
	if counts["produto"] != 2 {
		t.Errorf("counts[produto] esperado 2, got %d", counts["produto"])
	}
}

func TestSyncSimpleEntity_emptyDelta(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"produto"}, FormulaShapeFlat)

	ex := &fakeExtractor{
		rows:  map[string][]map[string]any{"produto": {}},
		maxDA: make(map[string]time.Time),
	}

	err := syncSimpleEntity(context.Background(), ex, cli, st, counts, rm, "produto", "produtos", mapProduto)
	if err != nil {
		t.Fatalf("erro inesperado: %v", err)
	}

	// Nenhum POST deve ter sido feito (delta vazio).
	if postCount.Load() != 0 {
		t.Errorf("delta vazio não deve fazer POST, fez %d", postCount.Load())
	}
}

func TestSyncSimpleEntity_entityNotInMapping(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	// Mapping sem "produto".
	rm := newFakeMapping([]string{"base"}, FormulaShapeFlat)

	ex := newFakeExtractor()

	err := syncSimpleEntity(context.Background(), ex, cli, st, counts, rm, "produto", "produtos", mapProduto)
	if err != nil {
		t.Fatalf("entidade ausente no mapping não deve dar erro: %v", err)
	}
	if postCount.Load() != 0 {
		t.Errorf("entidade ausente não deve fazer POST, fez %d", postCount.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestSendInBatches — divide em lotes quando > batchSize
// ─────────────────────────────────────────────────────────────

func TestSendInBatches_splitsIntoBatches(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}

	// Gera 2500 itens → 3 lotes (1000 + 1000 + 500).
	items := make([]map[string]any, 2500)
	for i := range items {
		items[i] = map[string]any{"id_produto": i}
	}
	maxDA := time.Date(2026, 6, 9, 10, 0, 0, 0, time.UTC)
	err := sendInBatches(context.Background(), cli, "/catalogs", "produtos", items, "produto", st, maxDA)
	if err != nil {
		t.Fatalf("sendInBatches falhou: %v", err)
	}
	// 3 lotes esperados.
	if postCount.Load() != 3 {
		t.Errorf("esperava 3 POST (lotes), got %d", postCount.Load())
	}
	// HWM deve ter avançado.
	if st.HWM["produto"] == "" {
		t.Error("HWM não avançou após sendInBatches")
	}
}

func TestSendInBatches_hwmOnlyAfterAllBatches(t *testing.T) {
	// Simula falha permanente no 2º lote (400 não é retentado) — HWM não deve ter avançado.
	var callCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n >= 2 {
			// 400 é erro permanente, não retentado — o lote 2 sempre falha.
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "bad request"})
		} else {
			_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
		}
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}

	// 2000 itens → 2 lotes; 2º falha permanentemente (400).
	items := make([]map[string]any, 2000)
	for i := range items {
		items[i] = map[string]any{"id_produto": i}
	}
	maxDA := time.Now()
	err := sendInBatches(context.Background(), cli, "/catalogs", "produtos", items, "produto", st, maxDA)
	if err == nil {
		t.Fatal("esperava erro ao falhar o 2º lote")
	}
	if st.HWM["produto"] != "" {
		t.Error("HWM não deve avançar se algum lote falhou")
	}
}

// ─────────────────────────────────────────────────────────────
// TestSyncCorantes — merge corantes + preco_corante
// ─────────────────────────────────────────────────────────────

func TestSyncCorantes_mergesPrice(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"corantes", "preco_corante"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"corantes": {
				{"id_corante": "C001", "descricao": "Corante Vermelho"},
			},
			"preco_corante": {
				{"id_corante": "C001", "custo": 12.50, "volume_ml": 100.0},
			},
		},
		maxDA: map[string]time.Time{
			"corantes":     maxDA,
			"preco_corante": maxDA,
		},
	}

	err := syncCorantes(context.Background(), ex, cli, st, counts, rm)
	if err != nil {
		t.Fatalf("syncCorantes falhou: %v", err)
	}

	// Verifica que o payload contém o corante enriquecido com custo.
	if len(srv.requests) == 0 {
		t.Fatal("nenhum POST recebido")
	}
	req := srv.requests[0]
	corantes, ok := req.Body["corantes"]
	if !ok {
		t.Fatal("payload não contém 'corantes'")
	}
	list, ok := corantes.([]any)
	if !ok || len(list) == 0 {
		t.Fatal("lista de corantes vazia ou tipo inesperado")
	}
	item, ok := list[0].(map[string]any)
	if !ok {
		t.Fatal("item de corante com tipo inesperado")
	}
	if item["custo"] == nil {
		t.Error("corante não foi enriquecido com custo")
	}
}

func TestSyncCorantes_precoOnlyDelta(t *testing.T) {
	// Apenas preco_corante tem delta (corante sem mudança) → envia registro parcial.
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"corantes", "preco_corante"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"corantes":     {},
			"preco_corante": {
				{"id_corante": "C002", "custo": 5.0, "volume_ml": 50.0},
			},
		},
		maxDA: map[string]time.Time{
			"preco_corante": maxDA,
		},
	}

	err := syncCorantes(context.Background(), ex, cli, st, counts, rm)
	if err != nil {
		t.Fatalf("syncCorantes falhou: %v", err)
	}

	if len(srv.requests) == 0 {
		t.Fatal("nenhum POST recebido")
	}
	req := srv.requests[0]
	corantes, ok := req.Body["corantes"]
	if !ok {
		t.Fatal("payload não contém 'corantes'")
	}
	list := corantes.([]any)
	if len(list) != 1 {
		t.Errorf("esperava 1 corante parcial, got %d", len(list))
	}
	item := list[0].(map[string]any)
	if item["id_corante_sayersystem"] != "C002" {
		t.Errorf("id_corante_sayersystem esperado 'C002', got %v", item["id_corante_sayersystem"])
	}
}

func TestSyncCorantes_bothEmpty_noPost(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"corantes", "preco_corante"}, FormulaShapeFlat)

	ex := &fakeExtractor{
		rows:  map[string][]map[string]any{"corantes": {}, "preco_corante": {}},
		maxDA: make(map[string]time.Time),
	}

	_ = syncCorantes(context.Background(), ex, cli, st, counts, rm)
	if postCount.Load() != 0 {
		t.Errorf("delta duplo vazio não deve fazer POST, fez %d", postCount.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestSyncFormulas — fórmulas flat e child
// ─────────────────────────────────────────────────────────────

func TestSyncFormulas_flat_personalizada_false(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{
					"id_padraocor": "COR001",
					"id_produto":   "P001",
					"id_base":      "B01",
					"id_emb":       "E01",
					"itens": []map[string]any{
						{"id_corante": "C001", "qtd_ml": 10.0},
					},
				},
			},
		},
		maxDA: map[string]time.Time{"formula": maxDA},
	}

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, nil, false)
	if err != nil {
		t.Fatalf("syncFormulas flat falhou: %v", err)
	}

	// Deve ter enviado para /formulas.
	if srv.countPathPrefix("/formulas") != 1 {
		t.Errorf("esperava 1 POST /formulas, got %d", srv.countPathPrefix("/formulas"))
	}
	req := srv.requests[0]
	formulas, ok := req.Body["formulas"]
	if !ok {
		t.Fatal("payload não contém 'formulas'")
	}
	list := formulas.([]any)
	if len(list) != 1 {
		t.Errorf("esperava 1 fórmula, got %d", len(list))
	}
	item := list[0].(map[string]any)
	if item["personalizada"] != false {
		t.Errorf("personalizada esperado false, got %v", item["personalizada"])
	}
	if item["cor_id"] != "COR001" {
		t.Errorf("cor_id esperado 'COR001', got %v", item["cor_id"])
	}
	if item["cod_produto"] != "P001" {
		t.Errorf("cod_produto esperado 'P001', got %v", item["cod_produto"])
	}
	if item["id_base"] != "B01" {
		t.Errorf("id_base esperado 'B01', got %v", item["id_base"])
	}
	if item["id_embalagem"] != "E01" {
		t.Errorf("id_embalagem esperado 'E01', got %v", item["id_embalagem"])
	}
}

func TestSyncFormulas_flat_personalizada_true(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formulaperson"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formulaperson": {
				{
					"id_padraocor": "CUST001",
					"id_produto":   "P002",
					"id_base":      "B02",
					"id_emb":       "E02",
				},
			},
		},
		maxDA: map[string]time.Time{"formulaperson": maxDA},
	}

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, nil, true)
	if err != nil {
		t.Fatalf("syncFormulas personalizada falhou: %v", err)
	}

	req := srv.requests[0]
	list := req.Body["formulas"].([]any)
	item := list[0].(map[string]any)
	if item["personalizada"] != true {
		t.Errorf("personalizada esperado true, got %v", item["personalizada"])
	}
}

func TestSyncFormulas_entityNotInMapping(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	// Mapping sem "formula".
	rm := newFakeMapping([]string{"produto"}, FormulaShapeFlat)

	ex := newFakeExtractor()
	_ = syncFormulas(context.Background(), ex, cli, st, counts, rm, nil, false)
	if postCount.Load() != 0 {
		t.Error("entidade ausente não deve fazer POST")
	}
}

// ─────────────────────────────────────────────────────────────
// TestSendKeysSnapshot — envia snapshot de chaves
// ─────────────────────────────────────────────────────────────

func TestSendKeysSnapshot_correctFormat(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cfg := &Config{
		AppURL:       ts.URL,
		StoreCode:    "loja-test",
		TokenPlainDev: "tok-test",
	}

	originNow := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	ex := &fakeExtractor{
		formulas: []formulaKey{
			{CorID: "C1", CodProduto: "P1", IDBase: "B1", IDEmb: "E1", Personalizada: false},
			{CorID: "C2", CodProduto: "P2", IDBase: "B2", IDEmb: "E2", Personalizada: true},
		},
		originNow: originNow,
	}

	err := sendKeysSnapshot(context.Background(), cfg, ex, originNow)
	if err != nil {
		t.Fatalf("sendKeysSnapshot falhou: %v", err)
	}

	if len(srv.requests) == 0 {
		t.Fatal("nenhum POST recebido")
	}
	req := srv.requests[0]
	if req.Path != "/keys-snapshot" {
		t.Errorf("path esperado /keys-snapshot, got %s", req.Path)
	}

	keysRaw, ok := req.Body["keys"]
	if !ok {
		t.Fatal("payload não contém 'keys'")
	}
	keysList := keysRaw.([]any)
	if len(keysList) != 2 {
		t.Errorf("esperava 2 chaves, got %d", len(keysList))
	}

	// Verifica o formato "cor_id|cod_produto|id_base|id_emb|personalizada".
	k1 := keysList[0].(string)
	if k1 != "C1|P1|B1|E1|false" {
		t.Errorf("chave[0] inesperada: %q", k1)
	}
	k2 := keysList[1].(string)
	if k2 != "C2|P2|B2|E2|true" {
		t.Errorf("chave[1] inesperada: %q", k2)
	}

	// Verifica generated_at.
	genAt, ok := req.Body["generated_at"]
	if !ok || genAt == nil {
		t.Error("generated_at ausente no payload do keys-snapshot")
	}
}

func TestSendKeysSnapshot_chunksLargePayload(t *testing.T) {
	var postCount atomic.Int32
	var lastIsLast bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if v, ok := body["is_last_chunk"]; ok {
			lastIsLast = v.(bool)
		}
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{
		AppURL:       ts.URL,
		StoreCode:    "loja-test",
		TokenPlainDev: "tok-test",
	}

	// Gera 60000 chaves → deve gerar 2 chunks (50000 + 10000).
	formulas := make([]formulaKey, 60000)
	for i := range formulas {
		formulas[i] = formulaKey{
			CorID:      "C",
			CodProduto: "P",
			IDBase:     "B",
			IDEmb:      "E",
		}
	}
	ex := &fakeExtractor{formulas: formulas}
	originNow := time.Now()

	err := sendKeysSnapshot(context.Background(), cfg, ex, originNow)
	if err != nil {
		t.Fatalf("sendKeysSnapshot com 60000 chaves falhou: %v", err)
	}
	if postCount.Load() != 2 {
		t.Errorf("esperava 2 chunks, enviou %d", postCount.Load())
	}
	if !lastIsLast {
		t.Error("último chunk deve ter is_last_chunk=true")
	}
}

func TestSendKeysSnapshot_emptyFormulas(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postCount.Add(1)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{
		AppURL:       ts.URL,
		StoreCode:    "loja-test",
		TokenPlainDev: "tok-test",
	}

	ex := &fakeExtractor{formulas: []formulaKey{}}
	err := sendKeysSnapshot(context.Background(), cfg, ex, time.Now())
	if err != nil {
		t.Fatalf("snapshot vazio não deve dar erro: %v", err)
	}
	// Deve enviar 1 chunk vazio (total_chunks=1 pois ceil(0/50000)=0→ forçado 1).
	if postCount.Load() != 1 {
		t.Errorf("esperava 1 POST para snapshot vazio, got %d", postCount.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestMappers — mapeadores de linha
// ─────────────────────────────────────────────────────────────

func TestMapProduto_validRow(t *testing.T) {
	row := map[string]any{"id_produto": "P001", "descricao": "Tinta X"}
	m := mapProduto(row)
	if m == nil {
		t.Fatal("mapProduto não deve retornar nil para linha válida")
	}
	if m["cod_produto"] != "P001" {
		t.Errorf("cod_produto esperado 'P001', got %v", m["cod_produto"])
	}
	if m["ativo"] != true {
		t.Errorf("ativo esperado true, got %v", m["ativo"])
	}
}

func TestMapProduto_emptyID(t *testing.T) {
	row := map[string]any{"id_produto": "", "descricao": "X"}
	if mapProduto(row) != nil {
		t.Error("mapProduto deve retornar nil para id_produto vazio")
	}
}

func TestMapBase_validRow(t *testing.T) {
	row := map[string]any{"id_base": "B01", "descricao": "Base Transparente"}
	m := mapBase(row)
	if m == nil || m["id_base_sayersystem"] != "B01" {
		t.Errorf("mapBase falhou: id_base_sayersystem esperado 'B01', got %v", m)
	}
}

func TestMapEmbalagem_includesVolume(t *testing.T) {
	row := map[string]any{"id_emb": "E01", "descricao": "Lata 900ml", "volume_ml": 900.0}
	m := mapEmbalagem(row)
	if m == nil {
		t.Fatal("mapEmbalagem nil")
	}
	if m["id_embalagem_sayersystem"] != "E01" {
		t.Errorf("id_embalagem_sayersystem esperado 'E01', got %v", m["id_embalagem_sayersystem"])
	}
	if m["volume_ml"] == nil {
		t.Error("volume_ml ausente")
	}
}

func TestMapSku_requiresAllKeys(t *testing.T) {
	// Linha incompleta → nil.
	row := map[string]any{"id_produto": "P001", "id_base": "B01"} // falta id_emb
	if mapSku(row) != nil {
		t.Error("mapSku deve retornar nil quando faltam campos")
	}
	// Linha completa.
	row["id_emb"] = "E01"
	if mapSku(row) == nil {
		t.Error("mapSku deve retornar não-nil para linha completa")
	}
}

func TestMapFormula_personalizadaField(t *testing.T) {
	row := map[string]any{
		"id_padraocor": "COR001",
		"id_produto":   "P001",
		"id_base":      "B01",
		"id_emb":       "E01",
	}
	emptyNames := map[string]string{}
	emptyVols := map[string]float64{}
	// personalizada=false
	m := mapFormula(row, false, emptyNames, emptyVols)
	if m == nil {
		t.Fatal("mapFormula retornou nil para linha válida")
	}
	if m["personalizada"] != false {
		t.Errorf("personalizada esperado false, got %v", m["personalizada"])
	}
	if m["cor_id"] != "COR001" {
		t.Errorf("cor_id esperado 'COR001', got %v", m["cor_id"])
	}
	if m["cod_produto"] != "P001" {
		t.Errorf("cod_produto esperado 'P001', got %v", m["cod_produto"])
	}
	if m["id_base"] != "B01" {
		t.Errorf("id_base esperado 'B01', got %v", m["id_base"])
	}
	if m["id_embalagem"] != "E01" {
		t.Errorf("id_embalagem esperado 'E01', got %v", m["id_embalagem"])
	}
	// personalizada=true
	m = mapFormula(row, true, emptyNames, emptyVols)
	if m["personalizada"] != true {
		t.Errorf("personalizada esperado true, got %v", m["personalizada"])
	}
}

func TestMapFormula_emptyCorID(t *testing.T) {
	row := map[string]any{"id_padraocor": "", "id_produto": "P001"}
	if mapFormula(row, false, nil, nil) != nil {
		t.Error("mapFormula deve retornar nil para id_padraocor vazio")
	}
}

func TestSyncFormulas_formulaContainsNomCorAndVolume(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{
					"id_padraocor": "COR001",
					"id_produto":   "P001",
					"id_base":      "B01",
					"id_emb":       "E01",
				},
			},
		},
		maxDA:      map[string]time.Time{"formula": maxDA},
		corNames:   map[string]string{"COR001": "Branco Neve"},
		embVolumes: map[string]float64{"E01": 900.0},
	}

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, nil, false)
	if err != nil {
		t.Fatalf("syncFormulas falhou: %v", err)
	}

	req := srv.requests[0]
	list := req.Body["formulas"].([]any)
	item := list[0].(map[string]any)

	if item["nome_cor"] != "Branco Neve" {
		t.Errorf("nome_cor esperado 'Branco Neve', got %v", item["nome_cor"])
	}
	if item["volume_final_ml"] != 900.0 {
		t.Errorf("volume_final_ml esperado 900.0, got %v", item["volume_final_ml"])
	}
}

func TestSyncFormulas_missingIdBaseDropped(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				// Linha completa — deve ser enviada.
				{
					"id_padraocor": "COR001",
					"id_produto":   "P001",
					"id_base":      "B01",
					"id_emb":       "E01",
				},
				// Linha sem id_base — deve ser descartada.
				{
					"id_padraocor": "COR002",
					"id_produto":   "P001",
					"id_base":      "",
					"id_emb":       "E01",
				},
			},
		},
		maxDA: map[string]time.Time{"formula": maxDA},
	}

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, nil, false)
	if err != nil {
		t.Fatalf("syncFormulas falhou: %v", err)
	}

	if srv.countPathPrefix("/formulas") != 1 {
		t.Errorf("esperava 1 POST /formulas, got %d", srv.countPathPrefix("/formulas"))
	}
	req := srv.requests[0]
	list := req.Body["formulas"].([]any)
	if len(list) != 1 {
		t.Errorf("esperava 1 fórmula (linha sem id_base descartada), got %d", len(list))
	}
}

// ─────────────────────────────────────────────────────────────
// TestFormatSchemaDiff
// ─────────────────────────────────────────────────────────────

func TestFormatSchemaDiff_ok(t *testing.T) {
	diff := &SchemaDiff{OK: true}
	s := formatSchemaDiff(diff)
	if s == "" {
		t.Error("formatSchemaDiff não deve retornar vazio")
	}
}

func TestFormatSchemaDiff_mismatch(t *testing.T) {
	diff := &SchemaDiff{
		OK:      false,
		Missing: map[string][]string{"produto": {"id_produto", "descricao"}},
	}
	s := formatSchemaDiff(diff)
	if !strings.Contains(s, "produto") {
		t.Errorf("esperava 'produto' no diff formatado: %q", s)
	}
}

func TestFormatSchemaDiff_nil(t *testing.T) {
	s := formatSchemaDiff(nil)
	if s != "" {
		t.Errorf("nil diff deve retornar string vazia, got %q", s)
	}
}

// ─────────────────────────────────────────────────────────────
// TestToString + TestToIntStr
// ─────────────────────────────────────────────────────────────

func TestToString_variants(t *testing.T) {
	if toString(nil) != "" {
		t.Error("toString(nil) deve ser ''")
	}
	if toString("hello") != "hello" {
		t.Error("toString string")
	}
	if toString([]byte("bytes")) != "bytes" {
		t.Error("toString bytes")
	}
	if toString(42) == "" {
		t.Error("toString int não deve ser vazio")
	}
}

func TestToIntStr_variants(t *testing.T) {
	if toIntStr(nil) != "" {
		t.Error("toIntStr(nil) deve ser ''")
	}
	if toIntStr(int64(100)) != "100" {
		t.Error("toIntStr int64")
	}
	if toIntStr("42") != "42" {
		t.Error("toIntStr string")
	}
}

// ─────────────────────────────────────────────────────────────
// TestBuildHeartbeat
// ─────────────────────────────────────────────────────────────

func TestBuildHeartbeat_fields(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	hb := buildHeartbeat(st, true, "fp123", "")
	if hb.DBConnected != true {
		t.Error("DBConnected deve ser true")
	}
	if hb.SchemaFingerprint != "fp123" {
		t.Errorf("fingerprint esperado 'fp123', got %q", hb.SchemaFingerprint)
	}
	if hb.AgentVersion == "" {
		t.Error("AgentVersion não deve ser vazio")
	}
	// SchemaMismatch deve ser omitido quando vazio.
	if hb.SchemaMismatch != "" {
		t.Errorf("mismatch deve ser vazio, got %q", hb.SchemaMismatch)
	}
}

func TestBuildHeartbeat_withMismatch(t *testing.T) {
	st := &State{HWM: make(map[string]string)}
	hb := buildHeartbeat(st, false, "", "tabela=produto col=id_produto")
	if hb.SchemaMismatch == "" {
		t.Error("SchemaMismatch deve ser preenchido")
	}
	if hb.DBConnected {
		t.Error("DBConnected deve ser false")
	}
}

// ─────────────────────────────────────────────────────────────
// TestRunEntityCycles — ciclo completo com fakeExtractor
// ─────────────────────────────────────────────────────────────

func TestRunEntityCycles_happyPath(t *testing.T) {
	var postPaths []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		postPaths = append(postPaths, r.URL.Path)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{
		AppURL:       ts.URL,
		StoreCode:    "loja",
		TokenPlainDev: "tok",
	}
	st := &State{HWM: make(map[string]string)}
	maxDA := time.Now()

	entities := []string{
		"produto", "base", "embalagens", "produto_base_embalagem",
		"corantes", "preco_corante", "preco_baseemb",
		"padracor", "colecao", "subcolecao", "personcor", "formula", "formulaperson",
	}
	rm := newFakeMapping(entities, FormulaShapeFlat)

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"produto":                {{"id_produto": "P1", "descricao": "Tinta"}},
			"base":                   {{"id_base": "B1", "descricao": "Base"}},
			"embalagens":             {{"id_emb": "E1", "descricao": "Lata", "volume_ml": 900.0}},
			"produto_base_embalagem": {{"id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
			"corantes":               {{"id_corante": "C1", "descricao": "Corante"}},
			"preco_corante":          {{"id_corante": "C1", "custo": 10.0, "volume_ml": 100.0}},
			"preco_baseemb":          {{"id_produto": "P1", "id_base": "B1", "id_emb": "E1", "custo": 1.0, "imposto": 0.1, "margem": 0.2}},
			"padracor":               {{"id_padraocor": "PC1", "descricao": "Branco"}},
			"colecao":                {{"id_colecao": "COL1", "descricao": "Neutros"}},
			"subcolecao":             {{"id_subcolecao": "S1", "id_colecao": "COL1", "descricao": "Sub1"}},
			"personcor":              {{"id_padraocor": "PERS1", "descricao": "Personalizado"}},
			"formula":                {{"id_padraocor": "PC1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
			"formulaperson":          {{"id_padraocor": "PERS1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
		},
		maxDA: map[string]time.Time{
			"produto":                maxDA,
			"base":                   maxDA,
			"embalagens":             maxDA,
			"produto_base_embalagem": maxDA,
			"corantes":               maxDA,
			"preco_corante":          maxDA,
			"preco_baseemb":          maxDA,
			"padracor":               maxDA,
			"colecao":                maxDA,
			"subcolecao":             maxDA,
			"personcor":              maxDA,
			"formula":                maxDA,
			"formulaperson":          maxDA,
		},
	}

	counts, err := runEntityCycles(context.Background(), cfg, ex, rm, st, nil)
	if err != nil {
		t.Fatalf("runEntityCycles falhou: %v", err)
	}

	// Deve ter enviado POSTs.
	if len(postPaths) == 0 {
		t.Error("nenhum POST foi enviado")
	}

	// Deve conter POSTs para /catalogs e /formulas.
	hasCatalogs := false
	hasFormulas := false
	for _, p := range postPaths {
		if p == "/catalogs" {
			hasCatalogs = true
		}
		if p == "/formulas" {
			hasFormulas = true
		}
	}
	if !hasCatalogs {
		t.Error("nenhum POST para /catalogs")
	}
	if !hasFormulas {
		t.Error("nenhum POST para /formulas")
	}

	// HWMs devem ter avançado para entidades com delta.
	if st.HWM["produto"] == "" {
		t.Error("HWM de 'produto' não avançou")
	}
	if st.HWM["formula"] == "" {
		t.Error("HWM de 'formula' não avançou")
	}

	// Counts não devem ser zero para as entidades enviadas.
	if counts["produto"] == 0 {
		t.Error("counts[produto] deve ser > 0")
	}
	if counts["formula"] == 0 {
		t.Error("counts[formula] deve ser > 0")
	}
}

// TestRunEntityCycles_noToken — sem token, retorna erro imediatamente
func TestRunEntityCycles_noToken(t *testing.T) {
	cfg := &Config{
		AppURL:    "http://localhost",
		StoreCode: "loja",
		// sem token
	}
	st := &State{HWM: make(map[string]string)}
	rm := newFakeMapping([]string{"produto"}, FormulaShapeFlat)
	ex := newFakeExtractor()

	_, err := runEntityCycles(context.Background(), cfg, ex, rm, st, nil)
	if err == nil {
		t.Error("sem token deve retornar erro")
	}
}
