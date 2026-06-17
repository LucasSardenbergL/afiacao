// state.go — persiste o estado de progresso do conector em state.json,
// ao lado do executável. Inclui high-water marks por entidade (relógio do
// PG de ORIGEM — §11 P1-D), e metadados do último keys-snapshot e full re-scan.
//
// A escrita é atômica (tmp → rename) para evitar corrupção caso o processo
// seja encerrado no meio da gravação.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// State persiste em state.json ao lado do executável.
type State struct {
	// HWM é o high-water mark por entidade: entity → ISO 8601 timestamp.
	// Representa o MAX(data_atualizacao) observado no resultado da última
	// extração bem-sucedida (relógio do PG de ORIGEM, nunca now() do conector).
	// Chave vazia (nunca sincronizado) = zero-time = full sync na primeira execução.
	HWM map[string]string `json:"hwm"`

	// LastKeysSnapshot é o ISO 8601 do último keys-snapshot enviado com sucesso.
	// Usado para determinar se é hora de enviar o próximo (1×/dia).
	LastKeysSnapshot string `json:"last_keys_snapshot,omitempty"`

	// LastFullRescan é o ISO 8601 do último full re-scan (ignora HWM).
	// Realizado toda semana (domingo de madrugada) como rede de segurança contra
	// UPDATEs na origem que não toquem data_atualizacao.
	LastFullRescan string `json:"last_full_rescan,omitempty"`

	// UpdateFailCount conta falhas do auto-update para o crash-loop guard.
	// Ao atingir 3 falhas (a tentativa é 1×/dia → ~3 dias) com a última tentativa
	// dentro da janela de 24h, o conector restaura o binário anterior (.prev) e
	// pausa as tentativas até a janela expirar. Zera ao primeiro update sem falha.
	UpdateFailCount int `json:"update_fail_count,omitempty"`

	// LastUpdateAttempt é o ISO 8601 (UTC) da última tentativa de auto-update.
	// Throttle: no máximo uma verificação por dia. Também define a janela de 24h
	// do crash-loop guard (acima).
	LastUpdateAttempt string `json:"last_update_attempt,omitempty"`
}

// stateDir retorna o diretório onde state.json é lido/gravado. É uma variável
// (e não chamada direta a exeDir) para permitir override em testes; em produção
// aponta para o diretório do executável.
var stateDir = exeDir

// statePath retorna o caminho do state.json ao lado do executável.
func statePath() string {
	return filepath.Join(stateDir(), "state.json")
}

// LoadState carrega o state.json. Se o arquivo não existir, retorna um State
// vazio (sem erro) — comportamento correto na primeira execução (full sync).
func LoadState() (*State, error) {
	path := statePath()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return &State{HWM: make(map[string]string)}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("erro ao ler state.json: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("state.json malformado: %w", err)
	}
	if s.HWM == nil {
		s.HWM = make(map[string]string)
	}
	return &s, nil
}

// SaveState persiste o State em state.json com escrita atômica (tmp → rename).
func SaveState(s *State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("erro ao serializar state: %w", err)
	}

	path := statePath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("erro ao escrever state tmp: %w", err)
	}
	return os.Rename(tmp, path)
}
