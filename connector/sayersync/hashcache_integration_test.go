// hashcache_integration_test.go — testes de integração do hash-cache em
// syncFormulas: o comportamento que mata o loop (só envia o que mudou),
// detecção de novas/removidas, e o furo do ErrorCount>0 (Codex #5).
//
// Todos usam maxDA ZERO no fakeExtractor — espelha a produção: a FORMULA tem
// data_atualizacao NULL, então maxDA volta zero, o HWM nunca avança, a extração é
// sempre full-scan e a poda está sempre ativa. O filtro por hash é o ÚNICO freio
// do re-envio.
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fxRow monta uma linha de origem de fórmula (shape flat) com itens.
func fxRow(cor, prod, base, emb string, itens []map[string]any) map[string]any {
	return map[string]any{
		"id_padraocor": cor, "id_produto": prod, "id_base": base, "id_emb": emb,
		"itens": itens,
	}
}

func item(idCor string, ordem int, qtd float64) map[string]any {
	return map[string]any{"id_corante": idCor, "ordem": ordem, "qtd_ml": qtd}
}

// keyDe computa a chave de cache que syncFormulas geraria para uma fórmula (lookup
// vazio: os ids crus passam direto). Robusto ao formato interno da chave.
func keyDe(cor, prod, base, emb string, person bool) string {
	return formulaCacheKey(map[string]any{
		"cor_id": cor, "cod_produto": prod, "id_base": base, "id_embalagem": emb, "personalizada": person,
	})
}

func TestSyncFormulas_primeiroCicloEnviaTudo_segundoNaoReenviaSemMudanca(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				fxRow("COR001", "P001", "B01", "E01", []map[string]any{item("C001", 1, 10.0)}),
				fxRow("COR002", "P002", "B02", "E01", []map[string]any{item("C002", 1, 5.5)}),
			},
		},
	}

	// Ciclo 1: cache vazio = full sync → envia as 2.
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 1: %v", err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 1 {
		t.Fatalf("ciclo 1: esperava 1 POST /formulas, got %d", got)
	}
	if hc.Len() != 2 {
		t.Fatalf("ciclo 1: cache deveria ter 2 hashes, tem %d", hc.Len())
	}

	// Ciclo 2: nada mudou → NÃO envia. Esta é a morte do loop de 485k.
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 1 {
		t.Fatalf("ciclo 2 RE-ENVIOU (loop!): total de POSTs /formulas = %d, esperava 1", got)
	}
}

func TestSyncFormulas_reenviaSomenteAMudada(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				fxRow("COR001", "P001", "B01", "E01", []map[string]any{item("C001", 1, 10.0)}),
				fxRow("COR002", "P002", "B02", "E01", []map[string]any{item("C002", 1, 5.5)}),
			},
		},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 1: %v", err)
	}

	// Muda o conteúdo de COR002 (qtd_ml 5.5 → 9.9).
	ex.rows["formula"][1] = fxRow("COR002", "P002", "B02", "E01", []map[string]any{item("C002", 1, 9.9)})

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}

	if got := srv.countPathPrefix("/formulas"); got != 2 {
		t.Fatalf("esperava 2 POSTs (1 por ciclo), got %d", got)
	}
	list := srv.requests[1].Body["formulas"].([]any)
	if len(list) != 1 {
		t.Fatalf("ciclo 2 deveria enviar só a fórmula mudada (1), enviou %d", len(list))
	}
	if cor := list[0].(map[string]any)["cor_id"]; cor != "COR002" {
		t.Fatalf("ciclo 2 enviou a fórmula errada: cor_id=%v, esperava COR002", cor)
	}
}

// Codex review P1: a edge pode reportar erro de item SEM um Index confiável (Index
// ausente vira 0 em Go). Para nunca cachear um rejeitado como aceito (catálogo
// stale), o lote INTEIRO com ErrorCount>0 não é cacheado — todos re-tentam no
// próximo ciclo (precisão > recall; erro de item é raro e logado).
func TestSyncFormulas_naoCacheiaLoteComErroDeItem(t *testing.T) {
	srv := &captureServer{response: AgentResponse{ErrorCount: 1, Errors: []AgentError{{Index: 0}}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				fxRow("COR001", "P001", "B01", "E01", []map[string]any{item("C001", 1, 10.0)}),
				fxRow("COR002", "P002", "B02", "E01", []map[string]any{item("C002", 1, 5.5)}),
			},
		},
	}

	// Ciclo 1: a edge reporta 1 erro de item → lote NÃO cacheado E o ciclo FALHA
	// visível (Codex review P1: erro persistente não pode passar como sucesso).
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err == nil {
		t.Fatal("ciclo 1 com erro de item deveria retornar erro (visibilidade no heartbeat)")
	}
	if hc.Len() != 0 {
		t.Fatalf("lote com erro de item não deve cachear nada (precisão > recall), cache tem %d", hc.Len())
	}

	// Ciclo 2: edge aceita tudo → AMBAS re-enviadas (nada havia sido cacheado), sem erro.
	srv.response = AgentResponse{}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 2 {
		t.Fatalf("esperava 2 POSTs, got %d", got)
	}
	if list := srv.requests[1].Body["formulas"].([]any); len(list) != 2 {
		t.Fatalf("ciclo 2 deveria re-enviar AMBAS (lote não cacheado), enviou %d", len(list))
	}
	if hc.Len() != 2 {
		t.Fatalf("ciclo 2 (sem erros) deveria cachear as 2, cache tem %d", hc.Len())
	}
}

// Codex review P2: full-scan que volta VAZIO (entidade esvaziou na origem) deve
// podar as chaves órfãs — senão, recriadas com o mesmo conteúdo, o hash antigo as
// faria pular (catálogo stale).
func TestSyncFormulas_podaComExtracaoVazia(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)}),
				fxRow("CORB", "PB", "BB", "EB", []map[string]any{item("C2", 1, 2.0)}),
			},
		},
	}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 1: %v", err)
	}
	if hc.Len() != 2 {
		t.Fatalf("ciclo 1: esperava 2, tem %d", hc.Len())
	}

	// Origem esvazia (todas as fórmulas sumiram).
	ex.rows["formula"] = nil
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}
	if hc.Len() != 0 {
		t.Fatalf("extração vazia em full-scan deveria podar as chaves órfãs, cache tem %d", hc.Len())
	}
}

func TestSyncFormulas_podaRemoveFormulaRemovidaDaOrigem(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {
				fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)}),
				fxRow("CORB", "PB", "BB", "EB", []map[string]any{item("C2", 1, 2.0)}),
				fxRow("CORC", "PC", "BC", "EC", []map[string]any{item("C3", 1, 3.0)}),
			},
		},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 1: %v", err)
	}
	if hc.Len() != 3 {
		t.Fatalf("ciclo 1: esperava 3 no cache, tem %d", hc.Len())
	}

	// CORC some da origem.
	ex.rows["formula"] = ex.rows["formula"][:2]
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}
	if hc.Len() != 2 {
		t.Fatalf("poda no full-scan deveria remover a fórmula ausente: cache tem %d, esperava 2", hc.Len())
	}
	if _, ok := hc.Get(keyDe("CORC", "PC", "BC", "EC", false)); ok {
		t.Fatal("CORC removida da origem ainda está no cache")
	}
}

// Codex #7/#8: formula (false) e formulaperson (true) compartilham o cache;
// processar uma NÃO pode podar as chaves da outra.
func TestSyncFormulas_podaNaoCruzaPersonalizada(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula", "formulaperson"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula":       {fxRow("CORA", "PA", "BA", "EA", []map[string]any{item("C1", 1, 1.0)})},
			"formulaperson": {fxRow("CORB", "PB", "BB", "EB", []map[string]any{item("C2", 1, 2.0)})},
		},
	}

	// Processa formula (false), depois formulaperson (true), como no ciclo real.
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("formula: %v", err)
	}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, true, newLookups(), hc); err != nil {
		t.Fatalf("formulaperson: %v", err)
	}

	if _, ok := hc.Get(keyDe("CORA", "PA", "BA", "EA", false)); !ok {
		t.Fatal("processar formulaperson PODOU a chave de formula (poda cruzou o namespace personalizada)")
	}
	if _, ok := hc.Get(keyDe("CORB", "PB", "BB", "EB", true)); !ok {
		t.Fatal("formulaperson não foi cacheada")
	}
}

// Codex review P1 (2ª passada): edge inconsistente — Errors populado mas
// ErrorCount=0. O gate tem que falhar FECHADO (não cachear), senão um rejeitado
// vira "enviado" e fica stale.
func TestSyncFormulas_loteComErrorsSemErrorCount(t *testing.T) {
	srv := &captureServer{response: AgentResponse{ErrorCount: 0, Errors: []AgentError{{Index: 0, Message: "x"}}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {fxRow("COR001", "P001", "B01", "E01", []map[string]any{item("C001", 1, 10.0)})},
		},
	}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err == nil {
		t.Fatal("Errors populado (mesmo com ErrorCount=0) deveria falhar o ciclo")
	}
	if hc.Len() != 0 {
		t.Fatalf("Errors populado deveria falhar fechado (não cachear), cache tem %d", hc.Len())
	}
}

// Codex review P2 (2ª passada): com erro no lote, o HWM NÃO pode avançar — senão,
// para uma fonte com data preenchida (maxDA>0, ex. formulaperson), as linhas
// não-cacheadas não voltam no próximo delta e ficam stale até o full rescan.
func TestSyncFormulas_loteComErroNaoAvancaHWM(t *testing.T) {
	srv := &captureServer{response: AgentResponse{ErrorCount: 1, Errors: []AgentError{{Index: 0}}}}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {fxRow("COR001", "P001", "B01", "E01", []map[string]any{item("C001", 1, 10.0)})},
		},
		maxDA: map[string]time.Time{"formula": time.Now()}, // fonte COM data
	}
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err == nil {
		t.Fatal("lote com erro deveria falhar o ciclo")
	}
	if st.HWM["formula"] != "" {
		t.Fatalf("HWM avançou (%q) apesar de lote com erro — linhas rejeitadas ficariam stale", st.HWM["formula"])
	}
}

// Codex review (4ª passada) P1: para uma fonte com HWM funcional (delta por
// timestamp), o hash-filter NÃO deve ser aplicado. Senão um delete+recreate com
// conteúdo idêntico (o servidor soft-deletou via keys-snapshot; a fórmula volta) é
// pulado pelo `old==hash` e fica ausente no servidor. O hash-cache só substitui o
// HWM quando ele está travado (full-scan, hwm zero — o caso da FORMULA).
func TestSyncFormulas_deltaComHWMNaoFiltraPorHash(t *testing.T) {
	srv := &captureServer{}
	ts := httptest.NewServer(srv)
	defer ts.Close()
	cli := newTestClient(ts.URL)
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()
	st := &State{HWM: make(map[string]string)}

	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {fxRow("COR1", "P1", "B1", "E1", []map[string]any{item("C1", 1, 1.0)})},
		},
	}

	// Ciclo 1 (HWM zero = full-scan): envia e cacheia.
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 1: %v", err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 1 {
		t.Fatalf("ciclo 1 deveria enviar, POSTs=%d", got)
	}

	// Agora a fonte tem HWM (delta real). Mesma fórmula, conteúdo idêntico — mas o
	// delta DEVE re-enviar (não filtrar por hash): o delete+recreate-idêntico seria
	// pulado e ficaria stale no servidor.
	st.HWM["formula"] = "2020-01-01T00:00:00Z"
	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err != nil {
		t.Fatalf("ciclo 2: %v", err)
	}
	if got := srv.countPathPrefix("/formulas"); got != 2 {
		t.Fatalf("delta com HWM deveria RE-ENVIAR (não filtrar por hash), total POSTs=%d, esperava 2", got)
	}
}

// Codex review (6ª passada) P1: 2xx com ok:false (ou corpo vazio/malformado, que o
// Client desserializa para um AgentResponse zerado) NÃO é confirmação de aceite —
// sem ok:true explícito não se pode cachear, senão a fórmula é pulada depois apesar
// de a edge não ter aceitado.
func TestSyncFormulas_naoCacheiaSemConfirmacaoOK(t *testing.T) {
	var posts int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":false}`)) // 2xx SEM confirmação de aceite
	}))
	defer ts.Close()
	cli := newTestClient(ts.URL)
	st := &State{HWM: make(map[string]string)}
	counts := make(map[string]int)
	rm := newFakeMapping([]string{"formula"}, FormulaShapeFlat)
	hc := newHashCache()
	ex := &fakeExtractor{
		rows: map[string][]map[string]any{
			"formula": {fxRow("COR1", "P1", "B1", "E1", []map[string]any{item("C1", 1, 1.0)})},
		},
	}

	if err := syncFormulas(context.Background(), ex, cli, st, counts, rm, false, newLookups(), hc); err == nil {
		t.Fatal("edge sem ok:true deveria falhar o ciclo (sem confirmação não há aceite)")
	}
	if hc.Len() != 0 {
		t.Fatalf("não deve cachear sem confirmação ok:true, cache tem %d", hc.Len())
	}
}
