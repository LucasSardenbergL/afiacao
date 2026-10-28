package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Contrato do plano: o conector só executa o que o servidor planeja, e qualquer desvio é ERRO —
// "zero janelas" fabricado pararia a cobertura do giro sem ninguém ver.

const extracaoTeste = "6f1c2a10-0000-4000-8000-000000000001"

func planoServer(t *testing.T, status int, corpo any) (*captureServer, *Client) {
	t.Helper()
	srv := &captureServer{
		statusFn: func(string) int { return status },
		bodyFn:   func(string) any { return corpo },
	}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return srv, NewClient(ts.URL, "tok", "M01")
}

func TestPlano_OkFalseEhErro(t *testing.T) {
	_, cli := planoServer(t, 200, map[string]any{"ok": false, "janelas": []any{}, "max_lotes": 20})
	if p, err := cli.PlanoPreparacoes(context.Background()); err == nil {
		t.Fatalf("ok:false tem de ser erro, veio plano %+v", p)
	} else if !strings.Contains(err.Error(), "ok:false") {
		t.Fatalf("erro deveria nomear ok:false, veio %v", err)
	}
}

func TestPlano_500EhErro(t *testing.T) {
	antes := backoffsPost
	backoffsPost = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { backoffsPost = antes })
	srv, cli := planoServer(t, 500, map[string]any{"ok": false, "error": "plano_indisponivel"})
	if p, err := cli.PlanoPreparacoes(context.Background()); err == nil {
		t.Fatalf("HTTP 500 tem de ser erro, veio plano %+v", p)
	}
	if n := srv.countPathPrefix("/preparations/plano"); n != 4 {
		t.Fatalf("5xx é retentável: esperado 4 POSTs, veio %d", n)
	}
}

func TestPlano_4xxEhErroSemRetry(t *testing.T) {
	srv, cli := planoServer(t, 401, map[string]any{"ok": false, "error": "Invalid token or store"})
	if _, err := cli.PlanoPreparacoes(context.Background()); err == nil {
		t.Fatal("HTTP 401 tem de ser erro")
	}
	if n := srv.countPathPrefix("/preparations/plano"); n != 1 {
		t.Fatalf("4xx é permanente: esperado 1 POST, veio %d", n)
	}
}

func TestPlano_CorpoForaDoContratoEhErro(t *testing.T) {
	casos := map[string]any{
		"sem janelas":   map[string]any{"ok": true, "max_lotes": 20},
		"sem max_lotes": map[string]any{"ok": true, "janelas": []any{}},
		"max_lotes 0":   map[string]any{"ok": true, "janelas": []any{}, "max_lotes": 0},
		"modo estranho": map[string]any{"ok": true, "max_lotes": 20, "janelas": []any{
			map[string]any{"extracao_id": extracaoTeste, "modo": "x", "desde": "2026-10-20T03:00:00Z", "ate": "2026-10-21T03:00:00Z"}}},
		"desde >= ate": map[string]any{"ok": true, "max_lotes": 20, "janelas": []any{
			map[string]any{"extracao_id": extracaoTeste, "modo": "cura", "desde": "2026-10-21T03:00:00Z", "ate": "2026-10-21T03:00:00Z"}}},
		"sem extracao_id": map[string]any{"ok": true, "max_lotes": 20, "janelas": []any{
			map[string]any{"modo": "cura", "desde": "2026-10-20T03:00:00Z", "ate": "2026-10-21T03:00:00Z"}}},
		"sem ok": map[string]any{"janelas": []any{}, "max_lotes": 20},
	}
	for nome, corpo := range casos {
		t.Run(nome, func(t *testing.T) {
			_, cli := planoServer(t, 200, corpo)
			if p, err := cli.PlanoPreparacoes(context.Background()); err == nil {
				t.Fatalf("%s: tinha de ser erro, veio %+v", nome, p)
			}
		})
	}
}

func TestPlano_EmAndamentoZeroJanelasNaoEhErro(t *testing.T) {
	_, cli := planoServer(t, 200, map[string]any{"ok": true, "janelas": []any{}, "max_lotes": 20, "motivo": "em_andamento"})
	p, err := cli.PlanoPreparacoes(context.Background())
	if err != nil {
		t.Fatalf("em_andamento é resposta legítima: %v", err)
	}
	if len(p.Janelas) != 0 || p.Motivo != "em_andamento" || p.MaxLotes != 20 {
		t.Fatalf("plano inesperado: %+v", p)
	}
}

func TestPlano_DuasJanelas(t *testing.T) {
	srv, cli := planoServer(t, 200, map[string]any{"ok": true, "max_lotes": 20, "motivo": nil, "janelas": []any{
		map[string]any{"extracao_id": extracaoTeste, "modo": "incremental", "desde": "2026-10-27T03:00:00Z", "ate": "2026-10-28T15:00:00Z"},
		map[string]any{"extracao_id": "6f1c2a10-0000-4000-8000-000000000002", "modo": "cura", "desde": "2026-09-01T03:00:00Z", "ate": "2026-09-08T03:00:00Z"},
	}})
	p, err := cli.PlanoPreparacoes(context.Background())
	if err != nil {
		t.Fatalf("plano válido: %v", err)
	}
	if len(p.Janelas) != 2 || p.MaxLotes != 20 {
		t.Fatalf("esperado 2 janelas e max_lotes 20, veio %+v", p)
	}
	j := p.Janelas[1]
	if j.ExtracaoID != "6f1c2a10-0000-4000-8000-000000000002" || j.Modo != "cura" ||
		!j.Desde.Equal(time.Date(2026, 9, 1, 3, 0, 0, 0, time.UTC)) || !j.Ate.Equal(time.Date(2026, 9, 8, 3, 0, 0, 0, time.UTC)) {
		t.Fatalf("janela 2 desserializada errado: %+v", j)
	}
	if srv.requests[0].Path != "/preparations/plano" {
		t.Fatalf("rota errada: %s", srv.requests[0].Path)
	}
}

func TestJanelaEfetiva_CortaNoRelogioDaOrigem(t *testing.T) {
	servidor := time.Date(2026, 10, 28, 15, 0, 0, 0, time.UTC)
	j := JanelaPlano{ExtracaoID: extracaoTeste, Modo: "incremental", Desde: time.Date(2026, 10, 28, 3, 0, 0, 0, time.UTC), Ate: servidor}
	origem := servidor.Add(-3 * time.Hour) // origem 3 h atrás do servidor
	e, ok := janelaEfetiva(j, origem)
	if !ok || !e.Ate.Equal(origem) || !e.Desde.Equal(j.Desde) {
		t.Fatalf("esperado Ate = originNow, veio %+v ok=%v", e, ok)
	}
	// Origem adiantada não estica a janela além do plano.
	e2, ok2 := janelaEfetiva(j, servidor.Add(time.Hour))
	if !ok2 || !e2.Ate.Equal(servidor) {
		t.Fatalf("origem adiantada não pode esticar o ate: %+v", e2)
	}
}

func TestJanelaEfetiva_OrigemAntesDoDesde(t *testing.T) {
	j := JanelaPlano{ExtracaoID: extracaoTeste, Modo: "incremental", Desde: time.Date(2026, 10, 28, 3, 0, 0, 0, time.UTC), Ate: time.Date(2026, 10, 28, 15, 0, 0, 0, time.UTC)}
	if _, ok := janelaEfetiva(j, j.Desde.Add(-time.Minute)); ok {
		t.Fatal("origem antes do desde → nada a extrair")
	}
	if _, ok := janelaEfetiva(j, j.Desde); ok {
		t.Fatal("origem = desde → janela vazia, nada a extrair")
	}
}
