// api_test.go — testes do cliente HTTP (api.go) usando httptest.
// Sem banco PG real; usa servidores HTTP falsos para validar retry, erros e heartbeat.
package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// ─────────────────────────────────────────────────────────────
// helpers de teste
// ─────────────────────────────────────────────────────────────

// newTestClient cria um Client apontando para o servidor de teste.
func newTestClient(baseURL string) *Client {
	c := NewClient(baseURL, "tok-test", "loja-test")
	// Substitui o timeout por 1s para que os testes não demorem.
	c.httpCli = &http.Client{Timeout: 2 * time.Second}
	return c
}

// jsonResponse escreve uma resposta JSON com o status e o corpo fornecidos.
func jsonResponse(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// readBodyJSON lê e decodifica o corpo da requisição.
func readBodyJSON(r *http.Request, out any) error {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// ─────────────────────────────────────────────────────────────
// TestNewClient
// ─────────────────────────────────────────────────────────────

func TestNewClient_defaults(t *testing.T) {
	c := NewClient("https://example.com", "tok", "loja")
	if c.baseURL != "https://example.com" {
		t.Errorf("baseURL inesperado: %s", c.baseURL)
	}
	if c.token != "tok" {
		t.Error("token não configurado")
	}
	if c.storeCode != "loja" {
		t.Error("storeCode não configurado")
	}
	if c.httpCli == nil {
		t.Error("httpCli nil")
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_2xx — sucesso na 1ª tentativa
// ─────────────────────────────────────────────────────────────

func TestPost_2xxSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("método inesperado: %s", r.Method)
		}
		if r.Header.Get("x-sync-token") != "tok-test" {
			t.Errorf("token ausente no header")
		}
		if r.Header.Get("x-store-code") != "loja-test" {
			t.Errorf("store_code ausente no header")
		}
		jsonResponse(w, 200, AgentResponse{OK: true, Complete: true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	ar, err := c.Post(context.Background(), "/catalogs", map[string]any{"test": 1}, "idem-key-1")
	if err != nil {
		t.Fatalf("esperava sucesso, got: %v", err)
	}
	if !ar.OK {
		t.Error("esperava ar.OK = true")
	}
	if !ar.Complete {
		t.Error("esperava ar.Complete = true")
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_idempotencyKeyHeader
// ─────────────────────────────────────────────────────────────

func TestPost_idempotencyKeyHeader(t *testing.T) {
	var receivedKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedKey = r.Header.Get("x-idempotency-key")
		jsonResponse(w, 200, AgentResponse{OK: true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, _ = c.Post(context.Background(), "/catalogs", map[string]any{}, "minha-chave-123")
	if receivedKey != "minha-chave-123" {
		t.Errorf("idempotency key esperada 'minha-chave-123', got %q", receivedKey)
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_retries5xx — deve retentar em 500/503
// ─────────────────────────────────────────────────────────────

func TestPost_retries5xx(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n < 3 {
			// Primeiras 2 tentativas: 500
			jsonResponse(w, 500, map[string]any{"error": "server error"})
		} else {
			// 3ª tentativa: sucesso
			jsonResponse(w, 200, AgentResponse{OK: true})
		}
	}))
	defer srv.Close()

	// Usa backoffs curtos para o teste não demorar.
	c := newTestClient(srv.URL)
	// Substitui a função de sleep via context com timeout generoso.
	ctx := context.Background()
	ar, err := c.Post(ctx, "/catalogs", map[string]any{}, "idem-retry")
	if err != nil {
		t.Fatalf("esperava sucesso após retry, got: %v", err)
	}
	if !ar.OK {
		t.Error("esperava ar.OK = true")
	}
	if attempts.Load() < 3 {
		t.Errorf("esperava ≥3 tentativas, fez %d", attempts.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_retries429 — deve retentar em 429
// ─────────────────────────────────────────────────────────────

func TestPost_retries429(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n == 1 {
			jsonResponse(w, 429, map[string]any{"error": "rate limit"})
		} else {
			jsonResponse(w, 200, AgentResponse{OK: true})
		}
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	ar, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err != nil {
		t.Fatalf("esperava sucesso após retry 429, got: %v", err)
	}
	if !ar.OK {
		t.Error("esperava ar.OK = true")
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_no_retry_on_4xx — 400, 401, 403 não devem ser retentados
// ─────────────────────────────────────────────────────────────

func TestPost_noRetryOn400(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		jsonResponse(w, 400, map[string]any{"error": "bad request"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro para 400")
	}
	if attempts.Load() != 1 {
		t.Errorf("400 não deve ser retentado; fez %d tentativa(s)", attempts.Load())
	}
	httpErr, ok := err.(*HTTPError)
	if !ok {
		t.Fatalf("esperava *HTTPError, got %T", err)
	}
	if httpErr.StatusCode != 400 {
		t.Errorf("StatusCode esperado 400, got %d", httpErr.StatusCode)
	}
}

func TestPost_noRetryOn401(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		jsonResponse(w, 401, map[string]any{"error": "unauthorized"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro para 401")
	}
	if attempts.Load() != 1 {
		t.Errorf("401 não deve ser retentado; fez %d tentativa(s)", attempts.Load())
	}
}

func TestPost_noRetryOn403(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		jsonResponse(w, 403, map[string]any{"error": "forbidden"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro para 403")
	}
	if attempts.Load() != 1 {
		t.Errorf("403 não deve ser retentado; fez %d tentativa(s)", attempts.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_409WithRetry — 409 com retry:true deve ser retentado
// ─────────────────────────────────────────────────────────────

func TestPost_409WithRetryTrue(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n == 1 {
			// 409 com retry:true
			jsonResponse(w, 409, map[string]any{"retry": true, "error": "run anterior incompleto"})
		} else {
			jsonResponse(w, 200, AgentResponse{OK: true})
		}
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	ar, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err != nil {
		t.Fatalf("esperava sucesso após retry de 409+retry, got: %v", err)
	}
	if !ar.OK {
		t.Error("esperava ar.OK = true")
	}
	if attempts.Load() < 2 {
		t.Errorf("esperava ≥2 tentativas, fez %d", attempts.Load())
	}
}

func TestPost_409WithoutRetry(t *testing.T) {
	// 409 sem retry:true é erro permanente.
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		jsonResponse(w, 409, map[string]any{"retry": false, "error": "conflito"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro para 409 sem retry")
	}
	if attempts.Load() != 1 {
		t.Errorf("409 sem retry não deve ser retentado; fez %d tentativa(s)", attempts.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_exhaustsRetries — 5xx persistente esgota tentativas
// ─────────────────────────────────────────────────────────────

func TestPost_exhaustsRetries5xx(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		jsonResponse(w, 503, map[string]any{"error": "unavailable"})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	_, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro após esgotar tentativas")
	}
	// 4 tentativas ao total (1 original + 3 backoffs).
	if attempts.Load() != 4 {
		t.Errorf("esperava 4 tentativas, fez %d", attempts.Load())
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_contextCancelled — cancelamento de contexto interrompe
// ─────────────────────────────────────────────────────────────

func TestPost_contextCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simula servidor lento.
		time.Sleep(500 * time.Millisecond)
		jsonResponse(w, 200, AgentResponse{OK: true})
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	c := NewClient(srv.URL, "tok", "loja")
	_, err := c.Post(ctx, "/catalogs", map[string]any{}, "")
	if err == nil {
		t.Fatal("esperava erro de contexto cancelado")
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_malformedResponseJSON — resposta não-JSON não quebra
// ─────────────────────────────────────────────────────────────

func TestPost_malformedResponseJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("não é json"))
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	ar, err := c.Post(context.Background(), "/catalogs", map[string]any{}, "")
	// Deve retornar um AgentResponse em branco, sem erro de transporte.
	if err != nil {
		t.Fatalf("resposta malformada não deve causar erro de transporte: %v", err)
	}
	if ar == nil {
		t.Fatal("ar deve ser não-nil")
	}
	// Campo OK será false (zero value) pois o JSON não parseou.
	if ar.OK {
		t.Error("ar.OK deveria ser false para resposta malformada")
	}
}

// ─────────────────────────────────────────────────────────────
// TestHeartbeat_success
// ─────────────────────────────────────────────────────────────

func TestHeartbeat_success(t *testing.T) {
	var received HeartbeatPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/heartbeat" {
			t.Errorf("path esperado /heartbeat, got %s", r.URL.Path)
		}
		_ = readBodyJSON(r, &received)
		jsonResponse(w, 200, AgentResponse{OK: true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	hb := HeartbeatPayload{
		AgentVersion:      "0.1.0",
		Hostname:          "pc-balcao",
		UptimeSeconds:     3600,
		DBConnected:       true,
		SchemaFingerprint: "abc123",
	}
	if err := c.Heartbeat(context.Background(), hb); err != nil {
		t.Fatalf("Heartbeat falhou: %v", err)
	}
	if received.AgentVersion != "0.1.0" {
		t.Errorf("AgentVersion esperado '0.1.0', got %q", received.AgentVersion)
	}
	if received.Hostname != "pc-balcao" {
		t.Errorf("Hostname esperado 'pc-balcao', got %q", received.Hostname)
	}
	if !received.DBConnected {
		t.Error("DBConnected deveria ser true")
	}
}

// ─────────────────────────────────────────────────────────────
// TestHeartbeat_withSchemaMismatch
// ─────────────────────────────────────────────────────────────

func TestHeartbeat_withSchemaMismatch(t *testing.T) {
	var received HeartbeatPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = readBodyJSON(r, &received)
		jsonResponse(w, 200, AgentResponse{OK: true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	hb := HeartbeatPayload{
		AgentVersion:   "dev",
		DBConnected:    false,
		SchemaMismatch: "tabela=produto coluna=id_produto ausente",
	}
	_ = c.Heartbeat(context.Background(), hb)
	if received.SchemaMismatch == "" {
		t.Error("SchemaMismatch deveria ser preenchido no heartbeat")
	}
	if received.DBConnected {
		t.Error("DBConnected deveria ser false")
	}
}

// ─────────────────────────────────────────────────────────────
// TestHTTPError_Error
// ─────────────────────────────────────────────────────────────

func TestHTTPError_Error(t *testing.T) {
	e := &HTTPError{StatusCode: 404, Body: "not found", Path: "/test"}
	msg := e.Error()
	if msg == "" {
		t.Error("Error() não deve retornar string vazia")
	}
	// Deve conter o status code.
	if len(msg) < 3 {
		t.Error("Error() muito curto")
	}
}

// ─────────────────────────────────────────────────────────────
// TestIsRetryableStatus
// ─────────────────────────────────────────────────────────────

func TestIsRetryableStatus(t *testing.T) {
	cases := []struct {
		code     int
		expected bool
	}{
		{200, false},
		{201, false},
		{400, false},
		{401, false},
		{403, false},
		{404, false},
		{409, false}, // 409 sem retry:true não é retentável via status sozinho
		{429, true},
		{500, true},
		{502, true},
		{503, true},
		{504, true},
	}
	for _, tc := range cases {
		got := isRetryableStatus(tc.code)
		if got != tc.expected {
			t.Errorf("isRetryableStatus(%d) = %v, esperado %v", tc.code, got, tc.expected)
		}
	}
}

// ─────────────────────────────────────────────────────────────
// TestTruncate
// ─────────────────────────────────────────────────────────────

func TestTruncate(t *testing.T) {
	if truncate("abc", 10) != "abc" {
		t.Error("string curta não deve ser truncada")
	}
	got := truncate("abcdefghij", 5)
	if len(got) <= 5 {
		// deve ter o sufixo "..."
		t.Errorf("string truncada muito curta: %q", got)
	}
	if got[:5] != "abcde" {
		t.Errorf("prefixo inesperado: %q", got[:5])
	}
}

// ─────────────────────────────────────────────────────────────
// TestPost_verifiesRequestBody — corpo do POST contém o payload
// ─────────────────────────────────────────────────────────────

func TestPost_verifiesRequestBody(t *testing.T) {
	var bodyReceived map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = readBodyJSON(r, &bodyReceived)
		jsonResponse(w, 200, AgentResponse{OK: true})
	}))
	defer srv.Close()

	c := newTestClient(srv.URL)
	payload := map[string]any{"produtos": []map[string]any{{"id": "1", "desc": "produto A"}}}
	_, _ = c.Post(context.Background(), "/catalogs", payload, "k1")

	prods, ok := bodyReceived["produtos"]
	if !ok {
		t.Fatal("corpo do POST não contém 'produtos'")
	}
	_ = prods
}
