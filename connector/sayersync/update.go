// update.go — auto-atualização diária do conector sayersync.
//
// Fluxo:
//  1. Busca o manifesto JSON em Config.UpdateManifestURL (bucket público do Supabase Storage)
//  2. Compara a versão do manifesto com a versão atual (semver, anti-downgrade)
//  3. Baixa o novo binário e verifica o sha256
//  4. Faz backup do binário atual para <exe>.prev
//  5. Substitui o binário atual pelo novo (o serviço continuará rodando até o próximo restart)
//  6. Guarda um crash-loop guard: se ≥3 falhas de update em 24h → restaura o .prev e para de tentar
//
// Chamado uma vez por RunCycle quando a data mudou desde a última verificação.
//
// Segurança:
//  - UpdateManifestURL fica num bucket PÚBLICO read-only do Supabase; escrita = service_role apenas.
//  - sha256 verificado antes de instalar (falha → descarta o download, conta como falha).
//  - Anti-downgrade: só atualiza se manifest.version > current (semver estrito).
//  - Crash-loop guard: 3 falhas em 24h → restaura .prev + desativa tentativas por 24h.
//
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §6.4
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// UpdateManifest é o JSON lido do bucket público de releases.
type UpdateManifest struct {
	Version string `json:"version"` // semver sem prefixo "v": "0.2.0"
	SHA256  string `json:"sha256"`  // hex lowercase do binário Windows
	URL     string `json:"url"`     // URL pública do binário .exe
}

// crashLoopWindow é a janela de tempo para contagem de falhas do crash-loop guard.
const crashLoopWindow = 24 * time.Hour

// crashLoopThreshold é o número máximo de falhas antes de restaurar o .prev.
const crashLoopThreshold = 3

// ─────────────────────────────────────────────────────────────
// CheckAndApplyUpdate — ponto de entrada
// ─────────────────────────────────────────────────────────────

// CheckAndApplyUpdate verifica se há uma nova versão disponível e aplica a atualização.
// É idempotente e seguro chamar em cada ciclo: verifica uma vez por dia.
// Retorna nil se não há atualização necessária ou se a atualização foi bem-sucedida.
// Erros são logados mas não propagam para não interromper o ciclo de sync.
func CheckAndApplyUpdate(ctx context.Context, cfg *Config, st *State) {
	if cfg.UpdateManifestURL == "" {
		return // auto-update desativado
	}

	// Verifica uma vez por dia.
	if !shouldCheckUpdate(st) {
		return
	}

	// Registra a tentativa (independente de sucesso/falha).
	st.LastUpdateAttempt = time.Now().UTC().Format(time.RFC3339)

	// Verifica crash-loop guard antes de tentar.
	if isCrashLoopGuardActive(st) {
		logger.Warnf("update: crash-loop guard ativo (%d falhas em 24h) — pulando auto-update", st.UpdateFailCount)
		return
	}

	if err := doUpdate(ctx, cfg, st); err != nil {
		logger.Errorf("update: falha na atualização: %v", err)
		st.UpdateFailCount++

		// Crash-loop guard: 3 falhas → restaura .prev.
		if st.UpdateFailCount >= crashLoopThreshold {
			logger.Errorf("update: %d falhas acumuladas — restaurando binário .prev", st.UpdateFailCount)
			if restErr := restorePrev(); restErr != nil {
				logger.Errorf("update: falha ao restaurar .prev: %v", restErr)
			} else {
				logger.Infof("update: .prev restaurado com sucesso")
			}
		}
	} else {
		// Sucesso: reseta o contador de falhas.
		st.UpdateFailCount = 0
	}
}

// ─────────────────────────────────────────────────────────────
// shouldCheckUpdate — verifica se deve tentar update hoje
// ─────────────────────────────────────────────────────────────

func shouldCheckUpdate(st *State) bool {
	if st.LastUpdateAttempt == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, st.LastUpdateAttempt)
	if err != nil {
		return true
	}
	// Verifica uma vez por dia (UTC).
	now := time.Now().UTC()
	return last.UTC().Format("2006-01-02") != now.Format("2006-01-02")
}

// isCrashLoopGuardActive retorna true se o guard de crash-loop está ativo.
// O guard ativa quando UpdateFailCount >= crashLoopThreshold E a última tentativa
// foi dentro da janela de 24h.
func isCrashLoopGuardActive(st *State) bool {
	if st.UpdateFailCount < crashLoopThreshold {
		return false
	}
	if st.LastUpdateAttempt == "" {
		return false
	}
	last, err := time.Parse(time.RFC3339, st.LastUpdateAttempt)
	if err != nil {
		return false
	}
	return time.Since(last) < crashLoopWindow
}

// ─────────────────────────────────────────────────────────────
// doUpdate — baixa e instala a nova versão
// ─────────────────────────────────────────────────────────────

func doUpdate(ctx context.Context, cfg *Config, st *State) error {
	// 1. Busca o manifesto.
	manifest, err := fetchManifest(ctx, cfg.UpdateManifestURL)
	if err != nil {
		return fmt.Errorf("doUpdate: buscar manifesto: %w", err)
	}

	// 2. Compara versões (anti-downgrade: só atualiza se manifest.version > current).
	if !isNewerVersion(manifest.Version, Version) {
		logger.Infof("update: versão atual %q já é a mais recente (manifesto: %q)", Version, manifest.Version)
		return nil
	}
	logger.Infof("update: nova versão disponível %q (atual: %q) — baixando", manifest.Version, Version)

	// 3. Baixa o binário.
	binData, err := downloadBinary(ctx, manifest.URL)
	if err != nil {
		return fmt.Errorf("doUpdate: baixar binário: %w", err)
	}

	// 4. Verifica sha256.
	if err := verifySHA256(binData, manifest.SHA256); err != nil {
		return fmt.Errorf("doUpdate: sha256 inválido: %w", err)
	}

	// 5. Instala (backup + substituição atômica).
	if err := installBinary(binData); err != nil {
		return fmt.Errorf("doUpdate: instalar binário: %w", err)
	}

	logger.Infof("update: versão %q instalada — reiniciar o serviço para ativar", manifest.Version)
	return nil
}

// ─────────────────────────────────────────────────────────────
// fetchManifest
// ─────────────────────────────────────────────────────────────

func fetchManifest(ctx context.Context, manifestURL string) (*UpdateManifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("criar request: %w", err)
	}

	cli := &http.Client{Timeout: 30 * time.Second}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET manifesto: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET manifesto: HTTP %d", resp.StatusCode)
	}

	var manifest UpdateManifest
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decodificar manifesto: %w", err)
	}
	if manifest.Version == "" || manifest.SHA256 == "" || manifest.URL == "" {
		return nil, fmt.Errorf("manifesto incompleto: version=%q sha256=%q url=%q",
			manifest.Version, manifest.SHA256, manifest.URL)
	}
	return &manifest, nil
}

// ─────────────────────────────────────────────────────────────
// downloadBinary
// ─────────────────────────────────────────────────────────────

func downloadBinary(ctx context.Context, binURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, binURL, nil)
	if err != nil {
		return nil, fmt.Errorf("criar request de download: %w", err)
	}

	cli := &http.Client{Timeout: 5 * time.Minute}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET binário: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET binário: HTTP %d", resp.StatusCode)
	}

	// Limita a 100 MB para evitar download malicioso.
	const maxBinarySize = 100 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBinarySize+1))
	if err != nil {
		return nil, fmt.Errorf("ler binário: %w", err)
	}
	if int64(len(data)) > maxBinarySize {
		return nil, fmt.Errorf("binário muito grande (> 100 MB)")
	}
	return data, nil
}

// ─────────────────────────────────────────────────────────────
// verifySHA256
// ─────────────────────────────────────────────────────────────

func verifySHA256(data []byte, expectedHex string) error {
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	// Compara em lowercase para evitar falha por case.
	if strings.ToLower(got) != strings.ToLower(expectedHex) {
		return fmt.Errorf("sha256 esperado %q, calculado %q", expectedHex, got)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────
// installBinary
// ─────────────────────────────────────────────────────────────

// installBinary instala o novo binário de forma atômica:
//  1. Grava o novo binário em <exe>.new
//  2. Faz backup do atual para <exe>.prev
//  3. Move o .new para <exe>
//
// Em caso de falha em qualquer passo, o binário original é preservado.
func installBinary(data []byte) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("determinar caminho do executável: %w", err)
	}
	// Resolve symlinks para obter o caminho real.
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("resolver symlinks do executável: %w", err)
	}

	newPath := exePath + ".new"
	prevPath := exePath + ".prev"

	// Grava o novo binário.
	if err := os.WriteFile(newPath, data, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("gravar binário .new: %w", err)
	}

	// Backup do atual para .prev (sobrescreve prev anterior se existir).
	curData, err := os.ReadFile(exePath)
	if err != nil {
		_ = os.Remove(newPath)
		return fmt.Errorf("ler binário atual para backup: %w", err)
	}
	if err := os.WriteFile(prevPath, curData, 0755); err != nil { //nolint:gosec
		_ = os.Remove(newPath)
		return fmt.Errorf("gravar .prev: %w", err)
	}

	// Substitui o executável atual (em Windows, o arquivo em uso não pode ser renomeado
	// enquanto o processo está em execução; o serviço usará o novo binário no próximo restart).
	if err := os.Rename(newPath, exePath); err != nil {
		// Tenta desfazer o .new se falhou.
		_ = os.Remove(newPath)
		return fmt.Errorf("renomear .new para exe: %w", err)
	}

	return nil
}

// ─────────────────────────────────────────────────────────────
// restorePrev — crash-loop guard
// ─────────────────────────────────────────────────────────────

// restorePrev restaura o binário anterior a partir de <exe>.prev.
func restorePrev() error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("determinar caminho do executável: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("resolver symlinks: %w", err)
	}
	prevPath := exePath + ".prev"

	prevData, err := os.ReadFile(prevPath)
	if err != nil {
		return fmt.Errorf("ler .prev: %w", err)
	}
	if err := os.WriteFile(exePath, prevData, 0755); err != nil { //nolint:gosec
		return fmt.Errorf("restaurar .prev para exe: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────
// isNewerVersion — comparação semver simples (sem dep extra)
// ─────────────────────────────────────────────────────────────

// isNewerVersion retorna true se candidateVersion > currentVersion (semver).
// Aceita versões com ou sem prefixo "v".
// Compara os três componentes (major.minor.patch) numericamente.
// Anti-downgrade: retorna false se candidateVersion <= currentVersion.
// Exceção: se a versão atual for uma build de desenvolvimento (não parseável como semver,
// ex.: "dev"), qualquer versão de release válida é considerada "mais nova" — permite
// que builds de teste sejam substituídos por releases reais.
func isNewerVersion(candidate, current string) bool {
	cMaj, cMin, cPat, ok1 := parseSemver(candidate)
	curMaj, curMin, curPat, ok2 := parseSemver(current)
	if !ok1 {
		// Candidato não é semver válido → não atualiza (seguro por default).
		return false
	}
	if !ok2 {
		// Versão atual não é semver (ex.: "dev") → qualquer release válido é mais novo.
		return true
	}
	if cMaj != curMaj {
		return cMaj > curMaj
	}
	if cMin != curMin {
		return cMin > curMin
	}
	return cPat > curPat
}

// parseSemver extrai (major, minor, patch) de uma string semver.
// Aceita "1.2.3" ou "v1.2.3".
func parseSemver(v string) (major, minor, patch int, ok bool) {
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	maj, err1 := strconv.Atoi(parts[0])
	min, err2 := strconv.Atoi(parts[1])
	// Remove sufixo de pre-release se presente (ex.: "0" de "0-beta").
	patStr := strings.SplitN(parts[2], "-", 2)[0]
	pat, err3 := strconv.Atoi(patStr)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, 0, false
	}
	return maj, min, pat, true
}
