package main

// preparacoes_plano.go — cliente do PLANO de extração das preparações (giro de corante, Fase 1).
//
// O servidor planeja; o conector só executa. Não há HWM local nem constante de política aqui:
// a cada ciclo o conector pede a POST /preparations/plano até 2 janelas por DATA DE DOSAGEM,
// cada uma com um extracao_id emitido pelo servidor, e o teto de lotes por extração.
// Contrato: docs/superpowers/plans/2026-10-27-giro-corante-fase1.md §"Contrato do payload".
//
// Falha FECHADA: HTTP ≠ 200, ok:false ou corpo fora do contrato é ERRO — nunca "zero janelas"
// (que o ciclo leria como "nada a fazer" e a cobertura pararia calada).

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

// JanelaPlano é uma janela [Desde, Ate) do plano; uma janela = uma extração.
type JanelaPlano struct {
	ExtracaoID string    `json:"extracao_id"`
	Modo       string    `json:"modo"`
	Desde      time.Time `json:"desde"`
	Ate        time.Time `json:"ate"`
}

// PlanoPreparacoes é a resposta de /preparations/plano.
type PlanoPreparacoes struct {
	Janelas  []JanelaPlano
	MaxLotes int
	// Motivo de zero janelas ("em_andamento" | "fila_cheia"); vazio quando há janela.
	Motivo string
}

var (
	modosDoPlano   = map[string]bool{"backfill": true, "incremental": true, "rescan": true, "cura": true}
	motivosDoPlano = map[string]bool{"em_andamento": true, "fila_cheia": true}
	uuidRe         = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

type planoBruto struct {
	OK       *bool         `json:"ok"`
	Janelas  []JanelaPlano `json:"janelas"`
	MaxLotes *int          `json:"max_lotes"`
	Motivo   *string       `json:"motivo"`
}

// PlanoPreparacoes pede o plano ao servidor. Qualquer desvio do contrato é erro.
func (c *Client) PlanoPreparacoes(ctx context.Context) (*PlanoPreparacoes, error) {
	_, bruto, err := c.postBruto(ctx, "/preparations/plano", map[string]any{}, "")
	if err != nil {
		return nil, fmt.Errorf("plano de preparações: %w", err)
	}
	// 200 EXATO: o Post aceita qualquer < 400, e um 202 com "zero janelas" seria lido como "nada a fazer".
	if bruto.Status != 200 {
		return nil, fmt.Errorf("plano de preparações: HTTP %d (esperado 200)", bruto.Status)
	}
	var p planoBruto
	if err := json.Unmarshal(bruto.Corpo, &p); err != nil {
		return nil, fmt.Errorf("plano de preparações: resposta não é JSON do contrato: %w", err)
	}
	if p.OK == nil || !*p.OK {
		return nil, fmt.Errorf("plano de preparações: servidor respondeu ok:false")
	}
	if p.Janelas == nil || len(p.Janelas) > 2 || p.MaxLotes == nil || *p.MaxLotes < 1 {
		return nil, fmt.Errorf("plano de preparações: resposta sem janelas/max_lotes válidos")
	}
	if p.Motivo != nil && !motivosDoPlano[*p.Motivo] {
		return nil, fmt.Errorf("plano de preparações: motivo fora do vocabulário")
	}
	for i, j := range p.Janelas {
		if !uuidRe.MatchString(j.ExtracaoID) || !modosDoPlano[j.Modo] || j.Desde.IsZero() || !j.Desde.Before(j.Ate) {
			return nil, fmt.Errorf("plano de preparações: janela %d fora do contrato", i)
		}
	}
	out := &PlanoPreparacoes{Janelas: p.Janelas, MaxLotes: *p.MaxLotes}
	if p.Motivo != nil {
		out.Motivo = *p.Motivo
	}
	return out, nil
}

// janelaEfetiva corta a janela no relógio da ORIGEM: o conector nunca pede dosagens de um
// futuro que a origem ainda não viveu (o manifesto declara consultado_em >= janela_ate).
// false = nada a extrair (a origem está antes do início da janela).
func janelaEfetiva(j JanelaPlano, originNow time.Time) (JanelaPlano, bool) {
	if originNow.Before(j.Ate) {
		j.Ate = originNow
	}
	if !j.Desde.Before(j.Ate) {
		return j, false
	}
	return j, true
}
