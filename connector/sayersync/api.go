// api.go — cliente HTTP para a edge function tint-sync-agent.
//
// Endpoints usados:
//
//	POST /heartbeat      — sinal de vida + status do conector
//	POST /catalogs       — produtos, bases, embalagens, skus, corantes, precos_base
//	POST /formulas       — fórmulas e itens
//	POST /keys-snapshot  — chaves de todas as fórmulas (deleção soft pelo servidor)
//
// Política de retry (3× exponencial 1s/4s/16s):
//   - erro de rede (qualquer falha de transporte)
//   - HTTP 5xx
//   - HTTP 429 (rate-limit)
//   - HTTP 409 com corpo {"retry":true} (run anterior incompleto)
//
// Erros 4xx sem retry:true são permanentes (não retentados).
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §5 + §6.1
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ──────────────────────────────────────────────────────────────
// Tipos de resposta
// ──────────────────────────────────────────────────────────────

// AgentResponse é a resposta normalizada do tint-sync-agent.
// Campos desconhecidos são ignorados (json tolerante).
type AgentResponse struct {
	OK             bool            `json:"ok"`
	ErrorCount     int             `json:"error_count"`
	Errors         []AgentError    `json:"errors"`
	Complete       bool            `json:"complete"`
	AwaitingChunks int             `json:"awaiting_chunks"`
	Promotion      json.RawMessage `json:"promotion"`
	// Campos usados na resposta 409.
	Retry bool   `json:"retry"`
	Error string `json:"error"`
}

// AgentError representa um erro de item individual retornado pela edge.
type AgentError struct {
	Index   int    `json:"index"`
	Entity  string `json:"entity"`
	Key     string `json:"key"`
	Message string `json:"message"`
}

// HeartbeatPayload é o corpo enviado para POST /heartbeat.
type HeartbeatPayload struct {
	AgentVersion      string `json:"agent_version"`
	Hostname          string `json:"hostname"`
	UptimeSeconds     int64  `json:"uptime_seconds"`
	DBConnected       bool   `json:"db_connected"`
	SchemaFingerprint string `json:"schema_fingerprint,omitempty"`
	// SchemaMismatch: string descrevendo o diff quando há divergência; omitido quando OK.
	SchemaMismatch  string         `json:"schema_mismatch,omitempty"`
	LastCycleCounts map[string]int `json:"last_cycle_counts,omitempty"`
	// LastCycleErrors lista as entidades que falharam no último ciclo (F7). Vazio =
	// ciclo limpo. A tela de integração mostra isso para o founder saber que o
	// heartbeat está "verde mas com ressalva" em vez de falso-sucesso.
	LastCycleErrors []string `json:"last_cycle_errors,omitempty"`
}

// ──────────────────────────────────────────────────────────────
// HTTPError
// ──────────────────────────────────────────────────────────────

// HTTPError representa um erro HTTP recebido da edge (4xx / 5xx não-retentado).
type HTTPError struct {
	StatusCode int
	Body       string
	Path       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d em %s: %s", e.StatusCode, e.Path, truncate(e.Body, 200))
}

// isRetryableStatus retorna true para códigos HTTP que devem ser retentados
// (5xx + 429).
func isRetryableStatus(code int) bool {
	return code == 429 || code >= 500
}

// ──────────────────────────────────────────────────────────────
// Client
// ──────────────────────────────────────────────────────────────

// Client é o cliente HTTP para o tint-sync-agent.
// Criado por ciclo (conexão curta); thread-safe.
type Client struct {
	baseURL   string
	token     string
	storeCode string
	httpCli   *http.Client
}

// NewClient cria um Client com timeout de 60s.
func NewClient(baseURL, token, storeCode string) *Client {
	return &Client{
		baseURL:   baseURL,
		token:     token,
		storeCode: storeCode,
		httpCli: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// Post envia um POST para path com body serializado como JSON.
// Aplica retry 3× com backoff exponencial (1s / 4s / 16s) nas condições:
//   - erro de transporte/rede
//   - HTTP 5xx
//   - HTTP 429
//   - HTTP 409 com {retry:true}
//
// idempotencyKey é enviado no header x-idempotency-key (pode ser vazio).
func (c *Client) Post(ctx context.Context, path string, body any, idempotencyKey string) (*AgentResponse, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("Post %s: falha ao serializar payload: %w", path, err)
	}

	backoffs := []time.Duration{1 * time.Second, 4 * time.Second, 16 * time.Second}
	var lastErr error

	for attempt := 0; attempt <= len(backoffs); attempt++ {
		// Aguarda o backoff antes das retentativas (não antes da 1ª tentativa).
		if attempt > 0 {
			wait := backoffs[attempt-1]
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
			logger.Infof("api: retry %d/%d para %s", attempt, len(backoffs), path)
		}

		ar, reqErr := c.singlePost(ctx, path, data, idempotencyKey)
		if reqErr == nil {
			// Sucesso de transporte — verifica se é 409+retry (retentável).
			if ar != nil && ar.Retry {
				lastErr = fmt.Errorf("Post %s: servidor solicitou retry (run anterior incompleto)", path)
				if attempt < len(backoffs) {
					continue
				}
				return nil, lastErr
			}
			return ar, nil
		}

		// Classifica o erro.
		if httpErr, ok := reqErr.(*HTTPError); ok {
			if isRetryableStatus(httpErr.StatusCode) && attempt < len(backoffs) {
				lastErr = reqErr
				continue
			}
			// 4xx permanente ou esgotou tentativas.
			return nil, reqErr
		}

		// Erro de transporte/rede.
		lastErr = reqErr
		if attempt < len(backoffs) {
			continue
		}
	}

	return nil, lastErr
}

// singlePost executa uma única requisição HTTP POST sem retry.
// Retorna (nil, *HTTPError) para respostas HTTP >= 400, exceto 409+retry
// que retorna (*AgentResponse, nil) para que o caller decida retentar.
func (c *Client) singlePost(ctx context.Context, path string, data []byte, idempotencyKey string) (*AgentResponse, error) {
	url := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("singlePost: erro ao criar request para %s: %w", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-sync-token", c.token)
	req.Header.Set("x-store-code", c.storeCode)
	if idempotencyKey != "" {
		req.Header.Set("x-idempotency-key", idempotencyKey)
	}

	httpResp, err := c.httpCli.Do(req)
	if err != nil {
		return nil, err // erro de transporte
	}
	defer httpResp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(httpResp.Body, 1<<20)) // 1 MB máx
	if err != nil {
		return nil, fmt.Errorf("singlePost: falha ao ler resposta de %s: %w", path, err)
	}

	// Tenta decodificar o JSON de resposta (tolerante).
	var ar AgentResponse
	if len(bodyBytes) > 0 {
		// Ignora erros de parse para não mascarar o status HTTP.
		_ = json.Unmarshal(bodyBytes, &ar)
	}

	// 409 + retry:true → retorna o AgentResponse para que o caller retente.
	if httpResp.StatusCode == 409 && ar.Retry {
		return &ar, nil
	}

	// Qualquer status >= 400 vira HTTPError.
	if httpResp.StatusCode >= 400 {
		return nil, &HTTPError{
			StatusCode: httpResp.StatusCode,
			Body:       string(bodyBytes),
			Path:       path,
		}
	}

	return &ar, nil
}

// Heartbeat envia o payload de heartbeat para POST /heartbeat.
// É best-effort: falha não propaga erro ao ciclo principal.
func (c *Client) Heartbeat(ctx context.Context, hb HeartbeatPayload) error {
	_, err := c.Post(ctx, "/heartbeat", hb, "")
	return err
}

// ──────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────

// truncate trunca uma string para no máximo maxLen caracteres.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
