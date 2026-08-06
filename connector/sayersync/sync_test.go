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
	"strconv"
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
	// formulas para o keys-snapshot (IDs CRUS — a tradução é do sendKeysSnapshot).
	formulas []formulaKey
	// lookups retornado por LoadLookups (nil → newLookups() vazio).
	lookups *Lookups
	// lookupsErr: se definido, LoadLookups retorna esse erro (falha FATAL do ciclo).
	lookupsErr error
	// childItems para o shape child: map[id_formula (PK) → []item].
	childItems map[string][]map[string]any
	// childItemsHasOrdem registra o hasOrdem recebido em ExtractFormulaChildItems.
	childItemsHasOrdem *bool
	// originNow é o valor retornado por OriginNow().
	originNow time.Time
	// err: se definido, todas as chamadas retornam esse erro.
	err error
	// errByEntity: se definido para uma entidade, Extract dela retorna esse erro
	// (as demais funcionam) — para testar agregação de falhas parciais (F7).
	errByEntity map[string]error
	// extractCalls registra as entidades extraídas (para provar que tabela ausente
	// do mapping NÃO é consultada).
	extractCalls []string
}

func (f *fakeExtractor) Extract(_ context.Context, entity string, _ time.Time) ([]map[string]any, time.Time, error) {
	f.extractCalls = append(f.extractCalls, entity)
	if f.err != nil {
		return nil, time.Time{}, f.err
	}
	if e, ok := f.errByEntity[entity]; ok && e != nil {
		return nil, time.Time{}, e
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

func (f *fakeExtractor) LoadLookups(_ context.Context) (*Lookups, error) {
	if f.lookupsErr != nil {
		return nil, f.lookupsErr
	}
	if f.err != nil {
		return nil, f.err
	}
	if f.lookups != nil {
		return f.lookups, nil
	}
	return newLookups(), nil
}

func (f *fakeExtractor) ExtractFormulaChildItems(_ context.Context, hasOrdem bool) (map[string][]map[string]any, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.childItemsHasOrdem = &hasOrdem
	if f.childItems != nil {
		return f.childItems, nil
	}
	return make(map[string][]map[string]any), nil
}

// ExtractFormulasComItens espelha o contrato do pgExtractor (pai+filha atômicos):
// no fake não há transação — devolve rows + childItems pré-configurados.
func (f *fakeExtractor) ExtractFormulasComItens(ctx context.Context, entity string, hwm time.Time, hasOrdem bool) ([]map[string]any, map[string][]map[string]any, time.Time, error) {
	rows, maxDA, err := f.Extract(ctx, entity, hwm)
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	child, err := f.ExtractFormulaChildItems(ctx, hasOrdem)
	if err != nil {
		return nil, nil, time.Time{}, err
	}
	return rows, child, maxDA, nil
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
			"corantes":      maxDA,
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
			"corantes": {},
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

// TestSyncCorantes_noPriceOmitsKeys prova (F6) que um corante cujo delta só mudou a
// descrição (sem preço) NÃO carrega custo/volume_ml no payload — as chaves ficam
// AUSENTES (não null/0), para o servidor não apagar o último preço bom.
func TestSyncCorantes_noPriceOmitsKeys(t *testing.T) {
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
			// Só a descrição do corante mudou; preco_corante SEM delta para ele.
			"corantes": {
				{"id_corante": "C777", "descricao": "Novo nome"},
			},
			"preco_corante": {},
		},
		maxDA: map[string]time.Time{"corantes": maxDA},
	}

	if err := syncCorantes(context.Background(), ex, cli, st, counts, rm); err != nil {
		t.Fatalf("syncCorantes falhou: %v", err)
	}
	if len(srv.requests) == 0 {
		t.Fatal("nenhum POST recebido")
	}
	item := srv.requests[0].Body["corantes"].([]any)[0].(map[string]any)
	if _, has := item["custo"]; has {
		t.Errorf("custo deveria estar AUSENTE (sem preço no delta), got %v", item["custo"])
	}
	if _, has := item["volume_ml"]; has {
		t.Errorf("volume_ml deveria estar AUSENTE (sem preço no delta), got %v", item["volume_ml"])
	}
	// A descrição (a mudança real) deve estar presente.
	if item["descricao"] != "Novo nome" {
		t.Errorf("descricao esperada 'Novo nome', got %v", item["descricao"])
	}
}

// TestSyncCorantes_numericPriceAsString prova (F1) que custo/volume vindos como STRING
// (caso real do pgx para numeric) são parseados e enviados — antes virava 0.
func TestSyncCorantes_numericPriceAsString(t *testing.T) {
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
				{"id_corante": "C001", "descricao": "Corante"},
			},
			"preco_corante": {
				// custo/volume como STRING (numeric do PG via pgx stdlib).
				{"id_corante": "C001", "custo": "12.50", "volume_ml": "100"},
			},
		},
		maxDA: map[string]time.Time{"corantes": maxDA, "preco_corante": maxDA},
	}

	if err := syncCorantes(context.Background(), ex, cli, st, counts, rm); err != nil {
		t.Fatalf("syncCorantes falhou: %v", err)
	}
	item := srv.requests[0].Body["corantes"].([]any)[0].(map[string]any)
	// JSON numbers desserializam como float64.
	if item["custo"] != 12.5 {
		t.Errorf("custo esperado 12.5 (parseado da string), got %v (%T)", item["custo"], item["custo"])
	}
	if item["volume_ml"] != 100.0 {
		t.Errorf("volume_ml esperado 100 (parseado da string), got %v", item["volume_ml"])
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

// TestSyncCorantes_precoCoranteAusenteNaoFalha cobre o banco REAL (sem
// preco_corante): o sync segue só com os corantes, SEM erro — e a tabela ausente
// NEM é consultada (o errByEntity provaria a consulta indevida).
func TestSyncCorantes_precoCoranteAusenteNaoFalha(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	// Mapping SEM preco_corante (como no schema real).
	rm := newFakeMapping([]string{"corantes"}, FormulaShapeFlat)

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			// Corante real: id NUMÉRICO é a identidade (reconciliação 12/06);
			// volume_ml próprio (JÁ em ml).
			"corantes": {
				{"id_corante": int64(7), "codigo": "WP53", "descricao": "Amarelo Óxido", "volume_ml": "550"},
			},
		},
		maxDA: map[string]time.Time{"corantes": maxDA},
		// Se syncCorantes consultar preco_corante mesmo ausente do mapping, falha aqui.
		errByEntity: map[string]error{"preco_corante": errTest("não deveria consultar preco_corante")},
	}

	if err := syncCorantes(context.Background(), ex, cli, st, counts, rm); err != nil {
		t.Fatalf("preco_corante ausente NÃO pode falhar syncCorantes: %v", err)
	}
	if len(srv.requests) != 1 {
		t.Fatalf("esperava 1 POST de corantes, got %d", len(srv.requests))
	}
	item := srv.requests[0].Body["corantes"].([]any)[0].(map[string]any)
	if item["id_corante_sayersystem"] != "7" {
		t.Errorf("identidade do corante esperada '7' (id numérico, reconciliação 12/06), got %v", item["id_corante_sayersystem"])
	}
	if item["volume_ml"] != 550.0 {
		t.Errorf("volume_ml próprio do corante esperado 550 (JÁ em ml, sem conversão), got %v", item["volume_ml"])
	}
	if _, has := item["custo"]; has {
		t.Errorf("custo deveria estar ausente (sem preco_corante), got %v", item["custo"])
	}
	for _, chamada := range ex.extractCalls {
		if chamada == "preco_corante" {
			t.Error("preco_corante ausente do mapping NÃO deve ser consultado")
		}
	}
	if st.HWM["corantes"] == "" {
		t.Error("HWM de corantes deve avançar normalmente")
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

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache())
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

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, true, newLookups(), newHashCache())
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
	_ = syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache())
	if postCount.Load() != 0 {
		t.Error("entidade ausente não deve fazer POST")
	}
}

// ─────────────────────────────────────────────────────────────
// F5: shape child — itens juntados pela PK da fórmula (NÃO id_padraocor)
// ─────────────────────────────────────────────────────────────

// newChildFormulaMapping cria um ResolvedMapping shape=child com formula_pk resolvido.
func newChildFormulaMapping(entity, pkCol string) *ResolvedMapping {
	rm := newFakeMapping([]string{entity}, FormulaShapeChild)
	rm.Resolved[entity]["formula_pk"] = pkCol
	rm.ChildHasOrdem = true
	return rm
}

func TestSyncFormulas_child_joinsItemsByFormulaPK(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newChildFormulaMapping("formula", "id_formula")

	maxDA := time.Now()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				// id_padraocor (cor) != formula_pk (PK da fórmula). A junção DEVE usar a PK.
				{
					"id_padraocor": "COR_VERMELHO",
					"formula_pk":   "F100",
					"id_produto":   "P001",
					"id_base":      "B01",
					"id_emb":       "E01",
				},
				// Duas fórmulas com a MESMA cor mas PKs distintas — prova que juntar por
				// id_padraocor traria os itens errados (todos para a mesma cor).
				{
					"id_padraocor": "COR_VERMELHO",
					"formula_pk":   "F101",
					"id_produto":   "P001",
					"id_base":      "B02",
					"id_emb":       "E01",
				},
			},
		},
		maxDA: map[string]time.Time{"formula": maxDA},
		// Itens chaveados pela PK da fórmula (= formula_item.id_formula).
		childItems: map[string][]map[string]any{
			"F100": {
				{"id_corante": "C1", "ordem": 1, "qtd_ml": 10.0},
				{"id_corante": "C2", "ordem": 2, "qtd_ml": 5.0},
			},
			"F101": {
				{"id_corante": "C9", "ordem": 1, "qtd_ml": 99.0},
			},
		},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas child falhou: %v", err)
	}

	// hasOrdem deve ter sido propagado.
	if ex.childItemsHasOrdem == nil || !*ex.childItemsHasOrdem {
		t.Errorf("ExtractFormulaChildItems deveria receber hasOrdem=true, got %v", ex.childItemsHasOrdem)
	}

	if len(srv.requests) == 0 {
		t.Fatal("nenhum POST recebido")
	}
	list := srv.requests[0].Body["formulas"].([]any)
	if len(list) != 2 {
		t.Fatalf("esperava 2 fórmulas, got %d", len(list))
	}

	// Mapeia cada fórmula enviada pela combinação id_base (proxy da PK F100/F101).
	byBase := map[string]map[string]any{}
	for _, f := range list {
		m := f.(map[string]any)
		byBase[m["id_base"].(string)] = m
	}

	// F100 (id_base B01) deve ter 2 itens C1/C2 — provando junção pela PK, não pela cor.
	f100 := byBase["B01"]
	itens100, ok := f100["itens"].([]any)
	if !ok {
		t.Fatalf("F100: itens com tipo inesperado %T", f100["itens"])
	}
	if len(itens100) != 2 {
		t.Errorf("F100: esperava 2 itens (C1,C2), got %d: %v", len(itens100), itens100)
	}

	// F101 (id_base B02) deve ter 1 item C9 — se a junção fosse por id_padraocor (mesma cor),
	// ambas as fórmulas teriam os MESMOS itens (bug). Aqui cada uma tem os seus.
	f101 := byBase["B02"]
	itens101 := f101["itens"].([]any)
	if len(itens101) != 1 {
		t.Errorf("F101: esperava 1 item (C9), got %d: %v", len(itens101), itens101)
	}
	if len(itens101) == 1 {
		it := itens101[0].(map[string]any)
		if it["id_corante"] != "C9" {
			t.Errorf("F101: item esperado C9, got %v", it["id_corante"])
		}
	}
}

func TestSyncFormulas_child_emptyItemsWhenPKHasNoChildren(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newChildFormulaMapping("formula", "id_formula")

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{"id_padraocor": "COR1", "formula_pk": "F500", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"},
			},
		},
		maxDA:      map[string]time.Time{"formula": time.Now()},
		childItems: map[string][]map[string]any{ /* nenhum item para F500 */ },
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas child falhou: %v", err)
	}
	list := srv.requests[0].Body["formulas"].([]any)
	m := list[0].(map[string]any)
	itens, ok := m["itens"].([]any)
	if !ok && m["itens"] != nil {
		t.Fatalf("itens com tipo inesperado %T", m["itens"])
	}
	if len(itens) != 0 {
		t.Errorf("fórmula sem itens na filha deve ter itens=[], got %v", itens)
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
		AppURL:        ts.URL,
		StoreCode:     "loja-test",
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

	err := sendKeysSnapshot(context.Background(), cfg, ex, originNow, newLookups())
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

	// F2: a edge EXIGE todos estes campos do contrato — 400 sem eles.
	if ent, _ := req.Body["entity"].(string); ent != "formulas" {
		t.Errorf("entity esperado 'formulas', got %v", req.Body["entity"])
	}
	snapID, ok := req.Body["snapshot_id"].(string)
	if !ok || snapID == "" {
		t.Errorf("snapshot_id ausente/vazio no payload, got %v", req.Body["snapshot_id"])
	}
	if _, ok := req.Body["generated_at"]; !ok || req.Body["generated_at"] == nil {
		t.Error("generated_at ausente no payload do keys-snapshot")
	}
	if _, ok := req.Body["total_chunks"]; !ok {
		t.Error("total_chunks ausente no payload do keys-snapshot")
	}
	if _, ok := req.Body["chunk_index"]; !ok {
		t.Error("chunk_index ausente no payload do keys-snapshot")
	}

	keysRaw, ok := req.Body["keys"]
	if !ok {
		t.Fatal("payload não contém 'keys'")
	}
	keysList := keysRaw.([]any)
	if len(keysList) != 2 {
		t.Errorf("esperava 2 chaves, got %d", len(keysList))
	}

	// F3: formato de 4 partes "cor_id|cod_produto|id_base|personalizada" (SEM id_emb).
	k1 := keysList[0].(string)
	if k1 != "C1|P1|B1|false" {
		t.Errorf("chave[0] esperada 'C1|P1|B1|false' (4 partes, sem embalagem), got %q", k1)
	}
	k2 := keysList[1].(string)
	if k2 != "C2|P2|B2|true" {
		t.Errorf("chave[1] esperada 'C2|P2|B2|true' (4 partes, sem embalagem), got %q", k2)
	}
}

// TestSendKeysSnapshot_dedupsSourceFormulaAcrossEmbalagens prova que a mesma fórmula
// fonte em múltiplas embalagens colapsa numa única chave de 4 partes (F3).
func TestSendKeysSnapshot_dedupsSourceFormulaAcrossEmbalagens(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	originNow := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	ex := &fakeExtractor{
		formulas: []formulaKey{
			// Mesma (cor,prod,base,personalizada=false), embalagens diferentes → 1 chave.
			{CorID: "C1", CodProduto: "P1", IDBase: "B1", IDEmb: "E1", Personalizada: false},
			{CorID: "C1", CodProduto: "P1", IDBase: "B1", IDEmb: "E2", Personalizada: false},
			{CorID: "C1", CodProduto: "P1", IDBase: "B1", IDEmb: "E3", Personalizada: false},
			// Personalizada=true da mesma cor/prod/base → chave distinta.
			{CorID: "C1", CodProduto: "P1", IDBase: "B1", IDEmb: "E1", Personalizada: true},
		},
		originNow: originNow,
	}

	if err := sendKeysSnapshot(context.Background(), cfg, ex, originNow, newLookups()); err != nil {
		t.Fatalf("sendKeysSnapshot falhou: %v", err)
	}
	keysList := srv.requests[0].Body["keys"].([]any)
	if len(keysList) != 2 {
		t.Fatalf("esperava 2 chaves após dedup (3 embalagens colapsam em 1 + a personalizada), got %d: %v", len(keysList), keysList)
	}
	got := map[string]bool{}
	for _, k := range keysList {
		got[k.(string)] = true
	}
	if !got["C1|P1|B1|false"] {
		t.Error("faltou a chave da fórmula padrão deduplicada 'C1|P1|B1|false'")
	}
	if !got["C1|P1|B1|true"] {
		t.Error("faltou a chave da fórmula personalizada 'C1|P1|B1|true'")
	}
}

// TestSendKeysSnapshot_snapshotIDStableAcrossChunks prova que todos os chunks de um
// mesmo snapshot diário compartilham o MESMO snapshot_id (F2 — a edge agrupa por ele).
func TestSendKeysSnapshot_snapshotIDStableAcrossChunks(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	// 60000 chaves DISTINTAS (CorID único) → 2 chunks após dedup.
	formulas := make([]formulaKey, 60000)
	for i := range formulas {
		formulas[i] = formulaKey{
			CorID:      "C" + strconv.Itoa(i),
			CodProduto: "P",
			IDBase:     "B",
			IDEmb:      "E1",
		}
	}
	ex := &fakeExtractor{formulas: formulas, originNow: time.Now()}

	if err := sendKeysSnapshot(context.Background(), cfg, ex, time.Now(), newLookups()); err != nil {
		t.Fatalf("sendKeysSnapshot falhou: %v", err)
	}
	if len(srv.requests) != 2 {
		t.Fatalf("esperava 2 chunks, got %d", len(srv.requests))
	}
	id0, _ := srv.requests[0].Body["snapshot_id"].(string)
	id1, _ := srv.requests[1].Body["snapshot_id"].(string)
	if id0 == "" || id1 == "" {
		t.Fatalf("snapshot_id vazio: chunk0=%q chunk1=%q", id0, id1)
	}
	if id0 != id1 {
		t.Errorf("snapshot_id deve ser IGUAL entre chunks do mesmo snapshot: chunk0=%q chunk1=%q", id0, id1)
	}
	// total_chunks coerente.
	if tc, _ := srv.requests[0].Body["total_chunks"].(float64); int(tc) != 2 {
		t.Errorf("total_chunks esperado 2, got %v", srv.requests[0].Body["total_chunks"])
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
		AppURL:        ts.URL,
		StoreCode:     "loja-test",
		TokenPlainDev: "tok-test",
	}

	// Gera 60000 chaves DISTINTAS → deve gerar 2 chunks (50000 + 10000).
	// (CorID único: após o dedup do F3, chaves iguais colapsariam.)
	formulas := make([]formulaKey, 60000)
	for i := range formulas {
		formulas[i] = formulaKey{
			CorID:      "C" + strconv.Itoa(i),
			CodProduto: "P",
			IDBase:     "B",
			IDEmb:      "E",
		}
	}
	ex := &fakeExtractor{formulas: formulas}
	originNow := time.Now()

	err := sendKeysSnapshot(context.Background(), cfg, ex, originNow, newLookups())
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
		AppURL:        ts.URL,
		StoreCode:     "loja-test",
		TokenPlainDev: "tok-test",
	}

	ex := &fakeExtractor{formulas: []formulaKey{}}
	err := sendKeysSnapshot(context.Background(), cfg, ex, time.Now(), newLookups())
	if err != nil {
		t.Fatalf("snapshot vazio não deve dar erro: %v", err)
	}
	// Deve enviar 1 chunk vazio (total_chunks=1 pois ceil(0/50000)=0→ forçado 1).
	if postCount.Load() != 1 {
		t.Errorf("esperava 1 POST para snapshot vazio, got %d", postCount.Load())
	}
}

// TestSendKeysSnapshot_traduzIdentidades prova que as chaves do snapshot usam a
// MESMA identidade canônica dos payloads de fórmula (cor por fonte padrão/person,
// produto/base por codigo) — sem isso a deleção por snapshot nunca casa.
func TestSendKeysSnapshot_traduzIdentidades(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cfg := &Config{AppURL: ts.URL, StoreCode: "loja-test", TokenPlainDev: "tok-test"}
	lk := newLookups()
	lk.CorPadrao["5"] = corInfo{CorID: "PAD-5", Nome: "Azul"}
	lk.CorPerson["5"] = corInfo{CorID: "PERS-5", Nome: "Verde"}
	lk.ProdutoCod["1"] = "PRODA"
	lk.BaseIdent["2"] = "BS"

	originNow := time.Date(2026, 6, 12, 12, 0, 0, 0, time.UTC)
	ex := &fakeExtractor{
		formulas: []formulaKey{
			// IDs CRUS da origem; a MESMA cor "5" nas duas fontes → identidades distintas.
			{CorID: "5", CodProduto: "1", IDBase: "2", IDEmb: "9", Personalizada: false},
			{CorID: "5", CodProduto: "1", IDBase: "2", IDEmb: "9", Personalizada: true},
			// Sem entrada no lookup → id cru (fallback).
			{CorID: "77", CodProduto: "88", IDBase: "99", IDEmb: "9", Personalizada: false},
		},
		originNow: originNow,
	}

	if err := sendKeysSnapshot(context.Background(), cfg, ex, originNow, lk); err != nil {
		t.Fatalf("sendKeysSnapshot falhou: %v", err)
	}
	keysList := srv.requests[0].Body["keys"].([]any)
	got := map[string]bool{}
	for _, k := range keysList {
		got[k.(string)] = true
	}
	if !got["PAD-5|PRODA|BS|false"] {
		t.Errorf("faltou a chave PADRÃO traduzida 'PAD-5|PRODA|BS|false'; got %v", got)
	}
	if !got["PERS-5|PRODA|BS|true"] {
		t.Errorf("faltou a chave PERSONALIZADA traduzida 'PERS-5|PRODA|BS|true'; got %v", got)
	}
	if !got["77|88|99|false"] {
		t.Errorf("sem lookup, a chave deve usar os ids crus '77|88|99|false'; got %v", got)
	}
}

// TestBuildSnapshotQuery_filtraLiberadoQuandoResolvido prova que o snapshot da
// formula (que TEM liberado no real) filtra COALESCE(liberado,true)=true — para a
// chave casar com os payloads, que dropam bloqueadas — e que formulaperson (sem
// liberado) NÃO ganha WHERE.
func TestBuildSnapshotQuery_filtraLiberadoQuandoResolvido(t *testing.T) {
	rm := &ResolvedMapping{
		Tables: map[string]string{"formula": "formula", "formulaperson": "formulaperson"},
		Resolved: map[string]map[string]string{
			"formula": {
				"id_padraocor": "id_padraocor", "id_produto": "id_produto",
				"id_base": "id_base", "id_emb": "id_embalagem", "liberado": "liberado",
			},
			"formulaperson": {
				"id_padraocor": "id_personcor", "id_produto": "id_produto",
				"id_base": "id_base", "id_emb": "id_embalagem",
			},
		},
	}

	q1, err := buildSnapshotQuery(rm, "formula")
	if err != nil {
		t.Fatalf("buildSnapshotQuery formula: %v", err)
	}
	if !strings.Contains(q1, `COALESCE("liberado", true) = true`) {
		t.Errorf("query da formula deveria filtrar liberado: %q", q1)
	}
	if !strings.Contains(q1, `"id_embalagem"`) {
		t.Errorf("query da formula deveria usar o nome REAL id_embalagem: %q", q1)
	}

	q2, err := buildSnapshotQuery(rm, "formulaperson")
	if err != nil {
		t.Fatalf("buildSnapshotQuery formulaperson: %v", err)
	}
	if strings.Contains(q2, "WHERE") {
		t.Errorf("formulaperson (sem liberado) NÃO deveria ter WHERE: %q", q2)
	}
	if !strings.Contains(q2, `"id_personcor"`) {
		t.Errorf("query da formulaperson deveria usar o nome REAL id_personcor: %q", q2)
	}

	// Coluna obrigatória não resolvida → erro (não monta SQL quebrado).
	rmRuim := &ResolvedMapping{Resolved: map[string]map[string]string{
		"formula": {"id_padraocor": "id_padraocor"},
	}}
	if _, err := buildSnapshotQuery(rmRuim, "formula"); err == nil {
		t.Error("colunas faltando deveriam dar erro, não SQL inválido")
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
	// Regressão de CAMPO (12/06): "ativo" NÃO existe em tint_staging_produtos e a
	// edge espalha todos os campos no INSERT → campo extra derruba o lote inteiro.
	if _, has := m["ativo"]; has {
		t.Errorf("payload de produto NÃO pode ter 'ativo' (derruba o lote na staging), got %v", m["ativo"])
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

// TestMappers_identidadeConfirmadaProd prova a MATRIZ DE IDENTIDADE confirmada
// contra os dados de produção (query nas tabelas tint_* em 2026-06-12):
// produto=codigo ("JO05.7796") · base/embalagem/corante=id NUMÉRICO ("90"/"38"/"3")
// · padracor/colecao/subcolecao=codigo (fallback id) · personcor=codigo_cor.
// Mudar qualquer uma dessas escolhas duplica o catálogo do app (o CSV-import
// histórico gravou exatamente assim).
func TestMappers_identidadeConfirmadaProd(t *testing.T) {
	// produto: codigo-first (prod: cod_produto="JO05.7796").
	m := mapProduto(map[string]any{"id_produto": int64(3), "codigo": "JO05.7796", "descricao": "Tinta"})
	if m["cod_produto"] != "JO05.7796" {
		t.Errorf("produto: identidade esperada 'JO05.7796' (codigo), got %v", m["cod_produto"])
	}
	m = mapProduto(map[string]any{"id_produto": int64(3), "descricao": "Tinta"})
	if m["cod_produto"] != "3" {
		t.Errorf("produto sem codigo: fallback no id, got %v", m["cod_produto"])
	}
	// base: id NUMÉRICO mesmo COM codigo presente na row (prod: "90"; o código W
	// vive na descrição — usar codigo aqui duplicaria todas as bases do app).
	mb := mapBase(map[string]any{"id_base": int64(90), "codigo": "WJOB.7796", "descricao": "WJOB.7796 - BASE ACRIL FOSCA BRANCA"})
	if mb["id_base_sayersystem"] != "90" {
		t.Errorf("base: identidade esperada '90' (id numérico), got %v", mb["id_base_sayersystem"])
	}
	// corante: id NUMÉRICO (reconciliação 12/06: app tem "1".."16", 0 dos "WP01"
	// casavam). corante.codigo "WP04" é só descrição; a identidade é o id "3".
	mc := mapCorante(map[string]any{"id_corante": int64(3), "codigo": "WP04", "descricao": "WP04.3900 - CONCENTRADO AZUL"})
	if mc["id_corante_sayersystem"] != "3" {
		t.Errorf("corante: identidade esperada '3' (id numérico), got %v", mc["id_corante_sayersystem"])
	}
	// padracor: codigo VERBATIM — o " - BS" JÁ VEM no codigo (gabarito:
	// "001B - BS"); sufixar duplicaria (bug v0.1.4/5).
	mp := mapPadracor(map[string]any{"id_padraocor": int64(10), "codigo": "151N - BS", "descricao": "CINZA CLARO - BS"})
	if mp["id_padraocor"] != "151N - BS" {
		t.Errorf("padracor: identidade esperada '151N - BS' (verbatim), got %v", mp["id_padraocor"])
	}
	if mp["descricao"] != "CINZA CLARO - BS" {
		t.Errorf("padracor: nome esperado 'CINZA CLARO - BS' (verbatim), got %v", mp["descricao"])
	}
	// colecao / subcolecao: codigo-first (prod subcolecao="1", compatível).
	mcol := mapColecao(map[string]any{"id_colecao": int64(1), "codigo": "CL-1", "descricao": "Coleção"})
	if mcol["id_colecao"] != "CL-1" {
		t.Errorf("colecao: identidade esperada 'CL-1', got %v", mcol["id_colecao"])
	}
	msub := mapSubcolecao(map[string]any{"id_subcolecao": int64(2), "id_colecao": int64(1), "codigo": "1", "descricao": "SAYERLACK"})
	if msub["id_subcolecao"] != "1" {
		t.Errorf("subcolecao: identidade esperada '1', got %v", msub["id_subcolecao"])
	}
	if msub["id_colecao"] != "1" {
		t.Errorf("subcolecao: id_colecao segue cru, got %v", msub["id_colecao"])
	}
	// personcor: codigo_cor VERBATIM com espaço no fim PRESERVADO (gabarito:
	// "0105 IVE " — chave da era-CSV é byte-a-byte); descricao vazia cai na ident.
	mper := mapPersoncor(map[string]any{"id_padraocor": int64(5), "codigo": "0105 IVE ", "descricao": ""})
	if mper["id_padraocor"] != "0105 IVE " {
		t.Errorf("personcor: identidade esperada '0105 IVE ' (com espaço!), got %q", mper["id_padraocor"])
	}
	if mper["descricao"] != "0105 IVE " {
		t.Errorf("personcor: descricao vazia deve cair na identidade, got %q", mper["descricao"])
	}
}

func TestMapEmbalagem_includesVolume(t *testing.T) {
	row := map[string]any{"id_emb": "38", "descricao": "405 ML", "volume_ml": 900.0}
	m := mapEmbalagem(row)
	if m == nil {
		t.Fatal("mapEmbalagem nil")
	}
	// Identidade da embalagem = id NUMÉRICO (prod: "38"); a descrição é só display.
	if m["id_embalagem_sayersystem"] != "38" {
		t.Errorf("id_embalagem_sayersystem esperado '38' (id), got %v", m["id_embalagem_sayersystem"])
	}
	// 900 > limiar de litros → assume ml, fica 900.
	if m["volume_ml"] != 900.0 {
		t.Errorf("volume_ml esperado 900, got %v", m["volume_ml"])
	}
}

// TestMapEmbalagem_identidadeEhID prova que a identidade NÃO usa a descrição
// mesmo quando presente (prod: id_embalagem_sayersystem="1" com descricao
// "QT (0.810 L)" — usar a descrição duplicaria as embalagens do app).
func TestMapEmbalagem_identidadeEhID(t *testing.T) {
	m := mapEmbalagem(map[string]any{"id_emb": int64(1), "descricao": "QT (0.810 L)"})
	if m["id_embalagem_sayersystem"] != "1" {
		t.Errorf("identidade deve ser o id '1' (nunca a descrição): got %v", m["id_embalagem_sayersystem"])
	}
	if m["descricao"] != "QT (0.810 L)" {
		t.Errorf("descricao segue no payload como display: got %v", m["descricao"])
	}
}

// TestMapEmbalagem_conteudoEmLitrosViraML prova a conversão litros→ml na row
// (origem real: conteudo=0.810 → 810ml).
func TestMapEmbalagem_conteudoEmLitrosViraML(t *testing.T) {
	m := mapEmbalagem(map[string]any{"id_emb": "E01", "descricao": "GALAO", "volume_ml": "0.810"})
	if m["volume_ml"] != 810.0 {
		t.Errorf("conteudo 0.810L deveria virar 810ml, got %v", m["volume_ml"])
	}
}

// TestMapEmbalagem_volumeAsString prova (F1) que volume numeric vindo como string vira número.
func TestMapEmbalagem_volumeAsString(t *testing.T) {
	m := mapEmbalagem(map[string]any{"id_emb": "E01", "descricao": "Lata", "volume_ml": "900"})
	if m["volume_ml"] != 900.0 {
		t.Errorf("volume_ml esperado 900 (parseado da string), got %v (%T)", m["volume_ml"], m["volume_ml"])
	}
}

// TestMapEmbalagem_volumeMissingOmitsKey prova que volume ausente/inválido OMITE a chave
// (não envia 0 — 0 quebraria a regra de 3 no servidor).
func TestMapEmbalagem_volumeMissingOmitsKey(t *testing.T) {
	m := mapEmbalagem(map[string]any{"id_emb": "E01", "descricao": "Lata"}) // sem volume_ml
	if _, has := m["volume_ml"]; has {
		t.Errorf("volume_ml deveria estar ausente quando não há valor, got %v", m["volume_ml"])
	}
	mBad := mapEmbalagem(map[string]any{"id_emb": "E02", "descricao": "X", "volume_ml": "abc"})
	if _, has := mBad["volume_ml"]; has {
		t.Errorf("volume_ml deveria estar ausente quando não-parseável, got %v", mBad["volume_ml"])
	}
}

// TestMapPrecoBaseEmb_numericAsStringAndOmission cobre (F1+F6) custo/imposto/margem como
// string (parseados) e ausentes (chaves omitidas, degradação honesta de preço).
func TestMapPrecoBaseEmb_numericAsStringAndOmission(t *testing.T) {
	// Todos os campos como string numérica.
	m := mapPrecoBaseEmb(map[string]any{
		"id_produto": "P1", "id_base": "B1", "id_emb": "E1",
		"custo": "10.5", "imposto": "0.18", "margem": "0.30",
	})
	if m == nil {
		t.Fatal("mapPrecoBaseEmb nil para linha completa")
	}
	if m["custo"] != 10.5 {
		t.Errorf("custo esperado 10.5, got %v", m["custo"])
	}
	if m["imposto_pct"] != 0.18 {
		t.Errorf("imposto_pct esperado 0.18, got %v", m["imposto_pct"])
	}
	if m["margem_pct"] != 0.30 {
		t.Errorf("margem_pct esperado 0.30, got %v", m["margem_pct"])
	}

	// Sem custo/imposto/margem → chaves omitidas (mas chave do SKU presente).
	m2 := mapPrecoBaseEmb(map[string]any{"id_produto": "P1", "id_base": "B1", "id_emb": "E1"})
	if m2 == nil {
		t.Fatal("mapPrecoBaseEmb não deve ser nil só por faltar preço (chave do SKU existe)")
	}
	for _, k := range []string{"custo", "imposto_pct", "margem_pct"} {
		if _, has := m2[k]; has {
			t.Errorf("%s deveria estar ausente quando não há valor, got %v", k, m2[k])
		}
	}
	if m2["cod_produto"] != "P1" {
		t.Errorf("cod_produto esperado 'P1', got %v", m2["cod_produto"])
	}
}

func TestMapSku_requiresAllKeys(t *testing.T) {
	mapSku := mapSkuWith(newLookups(), nil)
	// Linha incompleta → nil.
	row := map[string]any{"id_produto": "P001", "id_base": "B01"} // falta id_emb
	if mapSku(row) != nil {
		t.Error("mapSku deve retornar nil quando faltam campos")
	}
	// Linha completa (sem lookup → ids crus como fallback).
	row["id_emb"] = "E01"
	m := mapSku(row)
	if m == nil {
		t.Fatal("mapSku deve retornar não-nil para linha completa")
	}
	if m["cod_produto"] != "P001" || m["id_base"] != "B01" || m["id_embalagem"] != "E01" {
		t.Errorf("sem lookup, mapSku deve usar os ids crus: %v", m)
	}
}

// TestMapSku_traduzFKsViaLookup prova que os 3 FKs do SKU viram a identidade
// canônica (codigo do produto/base, descricao da embalagem) quando o lookup tem
// a entrada — e que FK sem entrada cai no id cru com miss contado (agregado).
func TestMapSku_traduzFKsViaLookup(t *testing.T) {
	lk := newLookups()
	lk.ProdutoCod["1"] = "PROD-A"
	lk.BaseIdent["2"] = "BS"
	lk.EmbIdent["3"] = "GALAO 3.6L"
	miss := &missCounter{}
	mapSku := mapSkuWith(lk, miss)

	m := mapSku(map[string]any{"id_produto": int64(1), "id_base": int64(2), "id_emb": int64(3)})
	if m["cod_produto"] != "PROD-A" {
		t.Errorf("cod_produto esperado 'PROD-A', got %v", m["cod_produto"])
	}
	if m["id_base"] != "BS" {
		t.Errorf("id_base esperado 'BS', got %v", m["id_base"])
	}
	if m["id_embalagem"] != "GALAO 3.6L" {
		t.Errorf("id_embalagem esperado 'GALAO 3.6L', got %v", m["id_embalagem"])
	}
	if miss.n != 0 {
		t.Errorf("nenhum miss esperado, got %d", miss.n)
	}

	// FK sem entrada → id cru + miss contado.
	m2 := mapSku(map[string]any{"id_produto": int64(99), "id_base": int64(2), "id_emb": int64(3)})
	if m2["cod_produto"] != "99" {
		t.Errorf("FK sem lookup deve cair no id cru, got %v", m2["cod_produto"])
	}
	if miss.n != 1 {
		t.Errorf("esperava 1 miss agregado, got %d", miss.n)
	}
}

func TestMapFormula_personalizadaField(t *testing.T) {
	row := map[string]any{
		"id_padraocor": "COR001",
		"id_produto":   "P001",
		"id_base":      "B01",
		"id_emb":       "E01",
	}
	lk := newLookups()
	// personalizada=false — lookups vazios → ids crus (fallback).
	m := mapFormula(row, false, lk)
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
	m = mapFormula(row, true, lk)
	if m["personalizada"] != true {
		t.Errorf("personalizada esperado true, got %v", m["personalizada"])
	}
}

func TestMapFormula_emptyCorID(t *testing.T) {
	row := map[string]any{"id_padraocor": "", "id_produto": "P001"}
	if mapFormula(row, false, newLookups()) != nil {
		t.Error("mapFormula deve retornar nil para id_padraocor vazio")
	}
}

// TestMapFormula_corPadraoEPersonNaoColidem mata o bug do mapa único de cores:
// padraocor.id e personcor.id podem ter o MESMO valor numérico ("5") designando
// cores DIFERENTES — a fórmula padrão resolve em CorPadrao e a personalizada em
// CorPerson, nunca no mapa errado.
func TestMapFormula_corPadraoEPersonNaoColidem(t *testing.T) {
	lk := newLookups()
	lk.CorPadrao["5"] = corInfo{CorID: "PAD-0005", Nome: "Azul Padrão"}
	lk.CorPerson["5"] = corInfo{CorID: "PERS-0005", Nome: "Verde Personalizado"}

	row := map[string]any{
		"id_padraocor": "5",
		"id_produto":   "P001",
		"id_base":      "B01",
		"id_emb":       "E01",
	}

	mPadrao := mapFormula(row, false, lk)
	if mPadrao["cor_id"] != "PAD-0005" {
		t.Errorf("fórmula padrão: cor_id esperado 'PAD-0005', got %v", mPadrao["cor_id"])
	}
	if mPadrao["nome_cor"] != "Azul Padrão" {
		t.Errorf("fórmula padrão: nome_cor esperado 'Azul Padrão', got %v", mPadrao["nome_cor"])
	}

	mPerson := mapFormula(row, true, lk)
	if mPerson["cor_id"] != "PERS-0005" {
		t.Errorf("fórmula personalizada: cor_id esperado 'PERS-0005', got %v", mPerson["cor_id"])
	}
	if mPerson["nome_cor"] != "Verde Personalizado" {
		t.Errorf("fórmula personalizada: nome_cor esperado 'Verde Personalizado', got %v", mPerson["nome_cor"])
	}
}

// TestMapFormula_liberadoFalseDropa prova que fórmula bloqueada (liberado=false,
// bool nativo OU string "f" do PG) não é enviada; liberado=true/ausente passa.
func TestMapFormula_liberadoFalseDropa(t *testing.T) {
	lk := newLookups()
	base := func(extra map[string]any) map[string]any {
		row := map[string]any{
			"id_padraocor": "C1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1",
		}
		for k, v := range extra {
			row[k] = v
		}
		return row
	}
	if mapFormula(base(map[string]any{"liberado": false}), false, lk) != nil {
		t.Error("liberado=false (bool) deve dropar a fórmula")
	}
	if mapFormula(base(map[string]any{"liberado": "f"}), false, lk) != nil {
		t.Error("liberado='f' (string do PG) deve dropar a fórmula")
	}
	if mapFormula(base(map[string]any{"liberado": true}), false, lk) == nil {
		t.Error("liberado=true NÃO deve dropar")
	}
	if mapFormula(base(nil), false, lk) == nil {
		t.Error("liberado ausente NÃO deve dropar (não dropar por falta de dado)")
	}
	if mapFormula(base(map[string]any{"liberado": nil}), false, lk) == nil {
		t.Error("liberado=nil NÃO deve dropar")
	}
}

func TestToBoolOK(t *testing.T) {
	cases := []struct {
		in       any
		want, ok bool
	}{
		{true, true, true},
		{false, false, true},
		{"t", true, true},
		{"f", false, true},
		{"true", true, true},
		{"FALSE", false, true},
		{[]byte("f"), false, true},
		{nil, false, false},
		{"banana", false, false},
		{int64(1), false, false},
	}
	for _, tc := range cases {
		got, ok := toBoolOK(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("toBoolOK(%v): esperava (%v,%v), got (%v,%v)", tc.in, tc.want, tc.ok, got, ok)
		}
	}
}

// TestNormalizaVolumeML cobre a conversão litros→ml: a origem grava "conteudo"
// em LITROS (0.810 → 810ml); valor acima do limiar assume ml já (flag de aviso).
func TestNormalizaVolumeML(t *testing.T) {
	if ml, assumiu := normalizaVolumeML(0.81); ml != 810 || assumiu {
		t.Errorf("0.81L: esperava (810,false), got (%v,%v)", ml, assumiu)
	}
	if ml, assumiu := normalizaVolumeML(3.6); ml != 3600 || assumiu {
		t.Errorf("3.6L: esperava (3600,false), got (%v,%v)", ml, assumiu)
	}
	if ml, assumiu := normalizaVolumeML(100); ml != 100000 || assumiu {
		t.Errorf("100 (limiar, inclusivo): esperava (100000,false), got (%v,%v)", ml, assumiu)
	}
	// 900 > limiar → já está em ml; warning path sinalizado pelo assumiuML.
	if ml, assumiu := normalizaVolumeML(900); ml != 900 || !assumiu {
		t.Errorf("900: esperava (900,true), got (%v,%v)", ml, assumiu)
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
		maxDA: map[string]time.Time{"formula": maxDA},
	}

	lk := newLookups()
	lk.CorPadrao["COR001"] = corInfo{CorID: "COR001", Nome: "Branco Neve"}
	lk.EmbVolumeML["E01"] = 900.0

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, lk, newHashCache())
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

	err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache())
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

// TestSyncFormulas_traduzIdCoranteDosItens prova a MECÂNICA de tradução: o
// id_corante CRU dos itens passa por CoranteIdent antes do payload, e item sem
// entrada no lookup mantém o cru. (Em prod, v0.1.7: CoranteIdent é id→id — o
// corante é identificado pelo número 1..16; aqui injetamos 7→"892" só para provar
// que a tradução É aplicada, independente do valor.)
func TestSyncFormulas_traduzIdCoranteDosItens(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	lk := newLookups()
	lk.CoranteIdent["7"] = "892"

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{
					"id_padraocor": "C1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1",
					// Itens como o aggregateFlatFormulaItems entrega (ids CRUS).
					"itens": []map[string]any{
						{"id_corante": "7", "ordem": 1, "qtd_ml": 10.0},
						{"id_corante": "99", "ordem": 2, "qtd_ml": 5.0}, // sem lookup → cru
					},
				},
			},
		},
		maxDA: map[string]time.Time{"formula": time.Now()},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, lk, newHashCache()); err != nil {
		t.Fatalf("syncFormulas falhou: %v", err)
	}
	item := srv.requests[0].Body["formulas"].([]any)[0].(map[string]any)
	itens := item["itens"].([]any)
	if len(itens) != 2 {
		t.Fatalf("esperava 2 itens, got %d", len(itens))
	}
	it0 := itens[0].(map[string]any)
	if it0["id_corante"] != "892" {
		t.Errorf("item[0].id_corante esperado '892' (traduzido de 7), got %v", it0["id_corante"])
	}
	it1 := itens[1].(map[string]any)
	if it1["id_corante"] != "99" {
		t.Errorf("item[1].id_corante sem lookup deve manter o cru '99', got %v", it1["id_corante"])
	}
}

// TestSyncFormulas_liberadoFalseNaoEnviaEContaBloqueada prova (no nível do sync)
// que fórmula bloqueada (liberado=false) sai do payload SEM contar como dropped:
// counts reflete só as enviadas e a liberada segue normalmente.
func TestSyncFormulas_liberadoFalseNaoEnviaEContaBloqueada(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{"id_padraocor": "C1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1", "liberado": true},
				{"id_padraocor": "C2", "id_produto": "P1", "id_base": "B1", "id_emb": "E1", "liberado": false},
			},
		},
		maxDA: map[string]time.Time{"formula": time.Now()},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas falhou: %v", err)
	}
	list := srv.requests[0].Body["formulas"].([]any)
	if len(list) != 1 {
		t.Fatalf("esperava 1 fórmula (a bloqueada fica de fora), got %d", len(list))
	}
	if list[0].(map[string]any)["cor_id"] != "C1" {
		t.Errorf("a fórmula enviada deveria ser a liberada C1, got %v", list[0])
	}
	if counts["formula"] != 1 {
		t.Errorf("counts[formula] esperado 1 (bloqueada não conta), got %d", counts["formula"])
	}
}

// TestSyncFormulas_semLookupUsaCruENaoDropa prova que a falta de entrada nos
// lookups NÃO derruba a fórmula: tudo cai no id cru (degradação honesta).
func TestSyncFormulas_semLookupUsaCruENaoDropa(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				{"id_padraocor": int64(12), "id_produto": int64(3), "id_base": int64(4), "id_emb": int64(5)},
			},
		},
		maxDA: map[string]time.Time{"formula": time.Now()},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), newHashCache()); err != nil {
		t.Fatalf("syncFormulas falhou: %v", err)
	}
	list := srv.requests[0].Body["formulas"].([]any)
	if len(list) != 1 {
		t.Fatalf("fórmula sem lookup NÃO pode ser dropada; got %d", len(list))
	}
	item := list[0].(map[string]any)
	if item["cor_id"] != "12" || item["cod_produto"] != "3" || item["id_base"] != "4" || item["id_embalagem"] != "5" {
		t.Errorf("sem lookup, os ids crus devem ser enviados: %v", item)
	}
	// nome_cor/volume_final_ml omitidos (sem lookup — degradação honesta, não 0).
	if _, has := item["nome_cor"]; has {
		t.Errorf("nome_cor deveria estar ausente sem lookup, got %v", item["nome_cor"])
	}
	if _, has := item["volume_final_ml"]; has {
		t.Errorf("volume_final_ml deveria estar ausente sem lookup, got %v", item["volume_final_ml"])
	}
}

// TestSyncFormulas_subcolecaoViaLookupSoPadrao prova que a subcoleção vem da COR
// (CorPadrao.SubIdent — no schema real a formula não tem id_subcolecao) e que a
// personalizada NUNCA carrega subcolecao.
func TestSyncFormulas_subcolecaoViaLookupSoPadrao(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()

	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula", "formulaperson"}, FormulaShapeFlat)

	lk := newLookups()
	lk.CorPadrao["10"] = corInfo{CorID: "AZ-10", Nome: "Azul", SubIdent: "SUB-07"}
	lk.CorPerson["10"] = corInfo{CorID: "PERS-10", Nome: "Cliente X"}

	rows := map[string][]map[string]any{
		"formula":       {{"id_padraocor": "10", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
		"formulaperson": {{"id_padraocor": "10", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
	}
	ex := &fakeExtractor{
		rows:  rows,
		maxDA: map[string]time.Time{"formula": time.Now(), "formulaperson": time.Now()},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, lk, newHashCache()); err != nil {
		t.Fatalf("syncFormulas padrão falhou: %v", err)
	}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, true, lk, newHashCache()); err != nil {
		t.Fatalf("syncFormulas personalizada falhou: %v", err)
	}

	padrao := srv.requests[0].Body["formulas"].([]any)[0].(map[string]any)
	if padrao["subcolecao"] != "SUB-07" {
		t.Errorf("fórmula padrão: subcolecao esperada 'SUB-07' (via cor), got %v", padrao["subcolecao"])
	}
	person := srv.requests[1].Body["formulas"].([]any)[0].(map[string]any)
	if _, has := person["subcolecao"]; has {
		t.Errorf("fórmula personalizada NÃO deve carregar subcolecao, got %v", person["subcolecao"])
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
		AppURL:        ts.URL,
		StoreCode:     "loja",
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

	counts, failed, _, err := runEntityCycles(context.Background(), cfg, ex, rm, st, newHashCache())
	if err != nil {
		t.Fatalf("runEntityCycles falhou: %v", err)
	}
	if len(failed) != 0 {
		t.Errorf("happy path não deve ter entidades falhas, got %v", failed)
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

	_, _, _, err := runEntityCycles(context.Background(), cfg, ex, rm, st, newHashCache())
	if err == nil {
		t.Error("sem token deve retornar erro")
	}
}

// TestRunEntityCycles_lookupsFalham_eFatal prova que a falha ao carregar os
// lookups de identidade é FATAL: nada é enviado (sem identidade não dá pra montar
// payload coerente) e o lk retornado é nil (RunCycle pula o keys-snapshot).
func TestRunEntityCycles_lookupsFalham_eFatal(t *testing.T) {
	var postCount atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		postCount.Add(1)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{AppURL: ts.URL, StoreCode: "loja", TokenPlainDev: "tok"}
	st := &State{HWM: make(map[string]string)}
	rm := newFakeMapping([]string{"produto"}, FormulaShapeFlat)
	ex := newFakeExtractor()
	ex.rows["produto"] = []map[string]any{{"id_produto": "P1", "descricao": "Tinta"}}
	ex.lookupsErr = errTest("pg caiu no meio")

	_, _, lk, err := runEntityCycles(context.Background(), cfg, ex, rm, st, newHashCache())
	if err == nil {
		t.Fatal("falha nos lookups deve ser erro FATAL do ciclo")
	}
	if lk != nil {
		t.Error("lk deve ser nil quando os lookups falham")
	}
	if postCount.Load() != 0 {
		t.Errorf("nada deve ser enviado sem lookups, foram %d POSTs", postCount.Load())
	}
	if st.HWM["produto"] != "" {
		t.Error("HWM não pode avançar quando o ciclo falha antes de enviar")
	}
}

// ─────────────────────────────────────────────────────────────
// F7: falha parcial NÃO pode reportar verde
// ─────────────────────────────────────────────────────────────

// TestRunEntityCycles_aggregatesPartialFailures prova que uma entidade com erro
// entra em `failed` (sem abortar as outras) em vez de ser engolida silenciosamente.
func TestRunEntityCycles_aggregatesPartialFailures(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{AppURL: ts.URL, StoreCode: "loja", TokenPlainDev: "tok"}
	st := &State{HWM: make(map[string]string)}
	rm := newFakeMapping([]string{"produto", "base", "corantes", "preco_corante", "formula"}, FormulaShapeFlat)
	maxDA := time.Now()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"produto": {{"id_produto": "P1", "descricao": "Tinta"}},
			"formula": {{"id_padraocor": "PC1", "id_produto": "P1", "id_base": "B1", "id_emb": "E1"}},
		},
		maxDA: map[string]time.Time{"produto": maxDA, "formula": maxDA},
		// base e corantes falham na extração.
		errByEntity: map[string]error{
			"base":     errTest("boom base"),
			"corantes": errTest("boom corantes"),
		},
	}

	counts, failed, _, err := runEntityCycles(context.Background(), cfg, ex, rm, st, newHashCache())
	if err != nil {
		t.Fatalf("erro fatal inesperado: %v", err)
	}
	// produto/formula devem ter ido apesar das falhas (não-aborto).
	if counts["produto"] == 0 {
		t.Error("produto deveria ter sido enviado mesmo com base/corantes falhando")
	}
	// base e corantes devem aparecer em failed.
	failedSet := map[string]bool{}
	for _, f := range failed {
		failedSet[f] = true
	}
	if !failedSet["base"] {
		t.Errorf("'base' deveria estar em failed, got %v", failed)
	}
	if !failedSet["corantes"] {
		t.Errorf("'corantes' deveria estar em failed, got %v", failed)
	}
	if failedSet["produto"] {
		t.Errorf("'produto' NÃO deveria estar em failed, got %v", failed)
	}
}

// TestBuildHeartbeat_andSerialize_carriesLastCycleErrors prova que as entidades
// falhas viajam no heartbeat (campo last_cycle_errors) — a tela mostra "verde com
// ressalva" em vez de falso-sucesso (F7).
func TestHeartbeat_carriesLastCycleErrors(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	hb := buildHeartbeat(&State{HWM: map[string]string{}}, true, "fp123", "")
	hb.LastCycleCounts = map[string]int{"produto": 5}
	hb.LastCycleErrors = []string{"base", "corantes"}

	if err := cli.Heartbeat(context.Background(), hb); err != nil {
		t.Fatalf("heartbeat falhou: %v", err)
	}
	errsRaw, ok := gotBody["last_cycle_errors"]
	if !ok {
		t.Fatalf("last_cycle_errors ausente no payload do heartbeat: %v", gotBody)
	}
	errsList, ok := errsRaw.([]any)
	if !ok || len(errsList) != 2 {
		t.Fatalf("last_cycle_errors esperava 2 entradas, got %v", errsRaw)
	}
	if errsList[0] != "base" || errsList[1] != "corantes" {
		t.Errorf("last_cycle_errors inesperado: %v", errsList)
	}
}

// TestHeartbeat_omitsEmptyLastCycleErrors prova que um ciclo limpo NÃO emite o campo
// (omitempty) — a tela só destaca quando há ressalva real.
func TestHeartbeat_omitsEmptyLastCycleErrors(t *testing.T) {
	var gotBody map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cli := newTestClient(ts.URL)
	hb := buildHeartbeat(&State{HWM: map[string]string{}}, true, "fp123", "")
	hb.LastCycleCounts = map[string]int{"produto": 5}
	// LastCycleErrors deixado nil.

	if err := cli.Heartbeat(context.Background(), hb); err != nil {
		t.Fatalf("heartbeat falhou: %v", err)
	}
	if _, ok := gotBody["last_cycle_errors"]; ok {
		t.Errorf("ciclo limpo não deveria emitir last_cycle_errors, got %v", gotBody["last_cycle_errors"])
	}
}

// errTest é um error simples para os testes de agregação.
type errTestType string

func (e errTestType) Error() string { return string(e) }
func errTest(s string) error        { return errTestType(s) }

// TestRunCycle_returnsFalseOnConnectFailure prova que RunCycle propaga falha como
// false (→ `once` sai com exit != 0). PG inexistente = falha de conexão.
func TestRunCycle_returnsFalseOnConnectFailure(t *testing.T) {
	// Servidor que responde 200 na hora ao heartbeat best-effort (evita os 21s de
	// retry/backoff do cliente quando o endpoint está fora do ar).
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer ts.Close()

	cfg := &Config{
		AppURL:        ts.URL,
		StoreCode:     "loja",
		TokenPlainDev: "tok",
		// Porta de PG impossível → Connect falha rápido.
		PGConn: "postgres://nouser:nopass@127.0.0.1:1/nodb?connect_timeout=1",
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if RunCycle(ctx, cfg) {
		t.Error("RunCycle deveria retornar false quando não conecta ao PG")
	}
}

// TestRunCycle_autoUpdatePersistsDespitePGFailure prova o REQUISITO de auto-cura:
// o auto-update roda CEDO no ciclo (antes do early-return de falha de conexão com
// o PG) e seu estado é persistido FORA do SaveState do fim do ciclo — que esse
// early-return pula. Sem isso, o throttle "1×/dia" e o crash-loop guard não
// sobreviveriam a ciclos com o PG local fora (re-tentaria o update a cada ciclo).
// Falsificação: mover a chamada para depois do early-return, ou tirar o save
// dedicado, deixa este teste vermelho.
func TestRunCycle_autoUpdatePersistsDespitePGFailure(t *testing.T) {
	// state.json isolado num diretório temporário (seam stateDir).
	dir := t.TempDir()
	prev := stateDir
	stateDir = func() string { return dir }
	defer func() { stateDir = prev }()

	// Manifesto responde 404 → update falha (silenciosamente) → UpdateFailCount++.
	manifestSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer manifestSrv.Close()

	// Heartbeat best-effort responde 200 na hora (evita o backoff de retry).
	hbSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(AgentResponse{OK: true})
	}))
	defer hbSrv.Close()

	cfg := &Config{
		AppURL:            hbSrv.URL,
		StoreCode:         "loja",
		TokenPlainDev:     "tok",
		PGConn:            "postgres://nouser:nopass@127.0.0.1:1/nodb?connect_timeout=1", // Connect falha → early-return
		UpdateManifestURL: manifestSrv.URL,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if RunCycle(ctx, cfg) {
		t.Error("RunCycle deveria retornar false quando não conecta ao PG")
	}

	// O auto-update precisa ter rodado e persistido o estado APESAR do early-return.
	st, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if st.LastUpdateAttempt == "" {
		t.Error("LastUpdateAttempt deveria ter sido persistido apesar do early-return do RunCycle")
	}
	if st.UpdateFailCount != 1 {
		t.Errorf("UpdateFailCount esperado 1 (manifesto 404), got %d", st.UpdateFailCount)
	}
}

// ─────────────────────────────────────────────────────────────
// composeCorPadrao — sufixo " - BS" (Base Solvente) das cores padrão
// ─────────────────────────────────────────────────────────────

// TestComposeCorPadrao prova a identidade VERBATIM da cor padrão. O GABARITO de
// 12/06 (export oficial do SayerSystem) provou que o " - BS" (Base Solvente) JÁ
// VEM DENTRO do codigo ("001B - BS", "01 - ACRIL BS") — sufixar aqui DUPLICARIA
// (bug das v0.1.4/5) — e que espaços nas pontas são PRESERVADOS (chave da era-CSV
// é byte-a-byte). Cores personalizadas não passam por aqui.
func TestComposeCorPadrao(t *testing.T) {
	// Caso REAL do gabarito: codigo já carrega o sufixo → passa VERBATIM.
	corID, nome := composeCorPadrao("001B - BS", "PRETO - BS", "10")
	if corID != "001B - BS" {
		t.Errorf("corID esperado '001B - BS' (verbatim, SEM duplicar sufixo), got %q", corID)
	}
	if nome != "PRETO - BS" {
		t.Errorf("nome esperado 'PRETO - BS' (verbatim), got %q", nome)
	}

	// REGRESSÃO anti-v0.1.4/5: nada de append — codigo sem sufixo fica sem sufixo.
	corID, _ = composeCorPadrao("151N", "CINZA CLARO", "10")
	if corID != "151N" {
		t.Errorf("corID esperado '151N' verbatim (NUNCA sufixar), got %q", corID)
	}

	// Espaços nas pontas PRESERVADOS (gabarito: "0105 IVE " com espaço final).
	corID, _ = composeCorPadrao("  151T ", "x", "9")
	if corID != "  151T " {
		t.Errorf("espacos preservados: esperado '  151T ' byte-a-byte, got %q", corID)
	}

	// codigo ausente/só-espaço → id CRU (diverge visível, nunca chuta).
	corID, _ = composeCorPadrao("", "LEEK GREEN", "42")
	if corID != "42" {
		t.Errorf("sem codigo: corID deve ser o id cru '42', got %q", corID)
	}
	corID, _ = composeCorPadrao("   ", "x", "43")
	if corID != "43" {
		t.Errorf("codigo só-espaço: corID deve ser o id cru '43', got %q", corID)
	}

	// descricao vazia/só-espaço → nome vazio (mapFormula omite nome_cor).
	_, nome = composeCorPadrao("151N", "", "10")
	if nome != "" {
		t.Errorf("descricao vazia deve dar nome vazio, got %q", nome)
	}
}

// TestCorPersonalizadaSemSufixoBS prova que a PERSONALIZADA usa codigo_cor
// verbatim (gabarito: "COFFEE ME 077", "0105 IVE ") — nada é composto/sufixado.
func TestCorPersonalizadaSemSufixoBS(t *testing.T) {
	lk := newLookups()
	lk.CorPerson["5"] = corInfo{CorID: "AZUL PURO", Nome: "AZUL PURO CORAL"}
	m := mapFormula(map[string]any{
		"id_padraocor": "5", "id_produto": "1", "id_base": "2", "id_emb": "3",
	}, true, lk)
	if m == nil {
		t.Fatal("mapFormula nil")
	}
	if m["cor_id"] != "AZUL PURO" {
		t.Errorf("personalizada NÃO leva sufixo BS: esperado 'AZUL PURO', got %v", m["cor_id"])
	}
}
