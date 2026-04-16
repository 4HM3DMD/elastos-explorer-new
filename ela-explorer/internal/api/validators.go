package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

const maxUploadSize = 2 << 20 // 2 MB

var (
	safeFilename = regexp.MustCompile(`^[a-zA-Z0-9_.\-]+$`)

	validMIME = map[string]bool{
		"image/jpeg": true,
		"image/png":  true,
		"image/gif":  true,
		"image/webp": true,
	}
)

type logoEntry struct {
	Nickname string `json:"nickname"`
	Logo     string `json:"logo"`
}

func validatorKey(s string) bool {
	return isHexPubKey(s) || isAddress(s)
}

func validatorsDir() string {
	return os.Getenv("VALIDATORS_DIR")
}

// ─── GET /api/v1/admin/validators/logo.json ─────────────────────────

func (s *Server) getValidatorLogos(w http.ResponseWriter, r *http.Request) {
	dir := validatorsDir()
	if dir == "" {
		writeError(w, http.StatusServiceUnavailable, "VALIDATORS_DIR not configured")
		return
	}
	path := filepath.Join(dir, "logo.json")
	data, err := os.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "logo.json not found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}

// ─── POST /api/v1/admin/validators/logo ─────────────────────────────

var logoMu sync.Mutex

func (s *Server) uploadValidatorLogo(w http.ResponseWriter, r *http.Request) {
	dir := validatorsDir()
	if dir == "" {
		writeError(w, http.StatusServiceUnavailable, "VALIDATORS_DIR not configured")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "request too large (max 2 MB)")
		return
	}

	key := r.FormValue("key")
	nickname := r.FormValue("nickname")

	if !validatorKey(key) {
		writeError(w, http.StatusBadRequest, "key must be a 66-char hex pubkey or valid ELA address")
		return
	}
	if nickname == "" {
		writeError(w, http.StatusBadRequest, "nickname is required")
		return
	}

	file, header, err := r.FormFile("logo")
	if err != nil {
		writeError(w, http.StatusBadRequest, "logo file is required")
		return
	}
	defer file.Close()

	ct := header.Header.Get("Content-Type")
	if !validMIME[ct] {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("unsupported MIME type %q; use jpeg, png, gif, or webp", ct))
		return
	}

	filename := header.Filename
	if !safeFilename.MatchString(filename) {
		writeError(w, http.StatusBadRequest, "filename contains unsafe characters (allowed: a-z A-Z 0-9 _ . -)")
		return
	}
	if len(filename) > 128 {
		writeError(w, http.StatusBadRequest, "filename too long (max 128 chars)")
		return
	}

	imagesDir := filepath.Join(dir, "images")
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		slog.Error("failed to create images dir", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}

	imgPath := filepath.Join(imagesDir, filename)
	if filepath.Dir(imgPath) != imagesDir {
		writeError(w, http.StatusBadRequest, "path traversal detected")
		return
	}

	out, err := os.Create(imgPath)
	if err != nil {
		slog.Error("failed to create image file", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		slog.Error("failed to write image file", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}

	logoMu.Lock()
	defer logoMu.Unlock()

	logoPath := filepath.Join(dir, "logo.json")
	existing := make(map[string]logoEntry)

	if data, err := os.ReadFile(logoPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}

	existing[key] = logoEntry{Nickname: nickname, Logo: filename}

	updated, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		slog.Error("failed to marshal logo.json", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}

	tmpPath := logoPath + ".tmp"
	if err := os.WriteFile(tmpPath, updated, 0644); err != nil {
		slog.Error("failed to write logo.json.tmp", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}
	if err := os.Rename(tmpPath, logoPath); err != nil {
		slog.Error("failed to rename logo.json.tmp", "error", err)
		writeError(w, http.StatusInternalServerError, "server error")
		return
	}

	slog.Info("validator logo uploaded", "key", key[:16], "nickname", nickname, "file", filename)

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"url":    "/static/validator-logos/images/" + filename,
	})
}
