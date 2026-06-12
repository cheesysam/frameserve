package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"crypto/subtle"
)

//go:embed static/*
var staticFS embed.FS

type Photo struct {
	URL   string `json:"url"`
	Name  string `json:"name"`
	Mtime int64  `json:"mtime"`
	Size  int64  `json:"size"`
}

type PhotosResponse struct {
	Photos []Photo `json:"photos"`
	Count  int     `json:"count"`
}

const (
	authCookieName = "frameserve_auth"
	// 365 days. “Set it and forget it” while still having *some* bounded lifetime.
	authCookieMaxAgeSeconds = 365 * 24 * 60 * 60

	// Build version. Bump on each release so the running build can be
	// identified at runtime via /healthz (handy for confirming a deploy
	// actually picked up the new image).
	version = "v8"
)

// favStore persists the list of favourited photo paths to a plain text file
// (one relative path per line). It's deliberately simple — a shared, single
// list good enough for a household photo frame. Guarded by a mutex since
// multiple devices can hit the endpoint concurrently.
type favStore struct {
	mu   sync.Mutex
	path string
}

func newFavStore(path string) *favStore {
	// Best-effort: make sure the parent dir exists so the first write succeeds.
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return &favStore{path: path}
}

// list returns the current favourites (de-duplicated, order preserved).
func (s *favStore) list() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *favStore) readLocked() ([]string, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || seen[line] {
			continue
		}
		seen[line] = true
		out = append(out, line)
	}
	return out, nil
}

func (s *favStore) writeLocked(items []string) error {
	// Atomic write: temp file + rename so a crash can't leave a half-written list.
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(strings.Join(items, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// add inserts name if not already present. Returns the updated list.
func (s *favStore) add(name string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.readLocked()
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		if it == name {
			return items, nil // already favourited
		}
	}
	items = append(items, name)
	if err := s.writeLocked(items); err != nil {
		return nil, err
	}
	return items, nil
}

// remove deletes name if present. Returns the updated list.
func (s *favStore) remove(name string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.readLocked()
	if err != nil {
		return nil, err
	}
	out := items[:0:0]
	for _, it := range items {
		if it != name {
			out = append(out, it)
		}
	}
	if err := s.writeLocked(out); err != nil {
		return nil, err
	}
	return out, nil
}

func main() {
	// Ensure correct Content-Type for self-hosted fonts (not in Go's default
	// MIME table on all platforms).
	_ = mime.AddExtensionType(".woff2", "font/woff2")

	port := getenv("PORT", "80")
	photosDir := getenv("PHOTOS_DIR", "/photos")

	// If AUTH_TOKEN is set, we enable auth for everything except /healthz.
	// Flow:
	//  - First visit: /?token=YOURTOKEN (or any path with token=...)
	//  - Server sets an HttpOnly cookie and redirects to the same URL without the token param.
	//  - Subsequent requests use the cookie.
	//
	// Also supports:
	//  - Authorization: Bearer YOURTOKEN
	authToken := strings.TrimSpace(os.Getenv("AUTH_TOKEN"))

	absPhotosDir, err := filepath.Abs(photosDir)
	if err != nil {
		log.Fatalf("failed to resolve PHOTOS_DIR: %v", err)
	}

	// Favourites are stored in a plain text file (one path per line). The
	// photos dir is typically mounted read-only, so this lives elsewhere —
	// mount a writable volume at /data in production.
	favFile, err := filepath.Abs(getenv("FAVOURITES_FILE", "data/favourites.txt"))
	if err != nil {
		log.Fatalf("failed to resolve FAVOURITES_FILE: %v", err)
	}
	favs := newFavStore(favFile)

	log.Printf("Frameserve starting: port=%s photos_dir=%s favourites_file=%s auth=%v", port, absPhotosDir, favFile, authToken != "")

	mux := http.NewServeMux()

	// Slideshow UI (no gallery)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r)
	})

	// Info page (how to use the site)
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/info" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		serveEmbeddedFile(w, r, "static/info.html", "text/html; charset=utf-8")
	})

	// Static assets
	mux.HandleFunc("/static/", func(w http.ResponseWriter, r *http.Request) {
		// Prevent directory listing; only serve embedded files
		path := strings.TrimPrefix(r.URL.Path, "/")
		if !strings.HasPrefix(path, "static/") {
			http.NotFound(w, r)
			return
		}
		serveEmbeddedFile(w, r, path, "")
	})

	// API: list photos
	mux.HandleFunc("/api/photos", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		photos, err := scanPhotos(absPhotosDir)
		if err != nil {
			http.Error(w, "failed to scan photos directory", http.StatusInternalServerError)
			log.Printf("scan error: %v", err)
			return
		}

		// Optional ordering controls via query params:
		// ?order=mtime_desc|mtime_asc|name_asc|name_desc (default mtime_desc)
		order := r.URL.Query().Get("order")
		sortPhotos(photos, order)

		resp := PhotosResponse{Photos: photos, Count: len(photos)}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")

		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(resp)
	})

	// API: favourites (shared list, persisted to a text file)
	//  - GET    -> {"favourites": ["folder/img.jpg", ...]}
	//  - POST   {"name":"folder/img.jpg"} -> add
	//  - DELETE {"name":"folder/img.jpg"} -> remove
	mux.HandleFunc("/api/favourites", func(w http.ResponseWriter, r *http.Request) {
		writeFavs := func(items []string) {
			if items == nil {
				items = []string{}
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			enc := json.NewEncoder(w)
			enc.SetIndent("", "  ")
			_ = enc.Encode(map[string]any{"favourites": items, "count": len(items)})
		}

		switch r.Method {
		case http.MethodGet:
			items, err := favs.list()
			if err != nil {
				http.Error(w, "failed to read favourites", http.StatusInternalServerError)
				log.Printf("favourites read error: %v", err)
				return
			}
			writeFavs(items)

		case http.MethodPost, http.MethodDelete:
			var body struct {
				Name string `json:"name"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
			name := strings.TrimSpace(body.Name)
			// Keep the line-based file format intact and only accept real images.
			if name == "" || strings.ContainsAny(name, "\n\r") || !isAllowedExt(name) {
				http.Error(w, "invalid name", http.StatusBadRequest)
				return
			}

			var items []string
			var err error
			if r.Method == http.MethodPost {
				items, err = favs.add(name)
			} else {
				items, err = favs.remove(name)
			}
			if err != nil {
				http.Error(w, "failed to update favourites", http.StatusInternalServerError)
				log.Printf("favourites write error: %v", err)
				return
			}
			writeFavs(items)

		default:
			w.Header().Set("Allow", "GET, POST, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Serve individual photos safely
	mux.HandleFunc("/photos/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		name := strings.TrimPrefix(r.URL.Path, "/photos/")
		if name == "" {
			http.NotFound(w, r)
			return
		}

		// Subdirectories are allowed, but reject backslashes outright.
		// Path traversal is handled by safeJoin below.
		if strings.Contains(name, `\`) {
			http.NotFound(w, r)
			return
		}

		// Extension allowlist
		if !isAllowedExt(name) {
			http.NotFound(w, r)
			return
		}

		fullPath, err := safeJoin(absPhotosDir, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}

		fi, err := os.Stat(fullPath)
		if err != nil || fi.IsDir() {
			http.NotFound(w, r)
			return
		}

		// Content-Type best effort based on extension
		ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}

		// Cache images aggressively; list refresh handles new images.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

		http.ServeFile(w, r, fullPath)
	})

	// Health check (left intentionally unauthenticated so health checks work cleanly)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok " + version))
	})

	var handler http.Handler = mux
	handler = securityHeaders(handler)

	// Wrap with auth if AUTH_TOKEN is configured
	if authToken != "" {
		handler = authMiddleware(authToken, handler)
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}

func getenv(k, def string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	return v
}

// serveIndex serves the slideshow page with the current build version injected
// into the asset URLs (e.g. styles.css?v=v3). Because the page itself is never
// cached, a new version means new asset URLs that no stale browser cache can
// shadow — so UI changes always take effect, even in privacy browsers that
// honor the original max-age of previously cached CSS/JS.
func serveIndex(w http.ResponseWriter, r *http.Request) {
	b, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	html := strings.ReplaceAll(string(b), "__VER__", version)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, html)
}

func serveEmbeddedFile(w http.ResponseWriter, r *http.Request, path string, forcedContentType string) {
	b, err := staticFS.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	if forcedContentType != "" {
		w.Header().Set("Content-Type", forcedContentType)
	} else {
		ext := strings.ToLower(filepath.Ext(path))
		if ct := mime.TypeByExtension(ext); ct != "" {
			w.Header().Set("Content-Type", ct)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
	}

	// Cache policy:
	//  - HTML pages: never cache (always reflect the latest server state).
	//  - CSS/JS: don't cache. These are tiny and drive the UI, so we want
	//    edits to take effect on the next load without stale-cache surprises
	//    (important for kiosks/TVs that are never manually refreshed).
	//  - Other static assets (e.g. icons): safe to cache for a day.
	lower := strings.ToLower(path)
	switch {
	case path == "static/index.html" || path == "static/info.html":
		w.Header().Set("Cache-Control", "no-store")
	case strings.HasSuffix(lower, ".css") || strings.HasSuffix(lower, ".js"):
		w.Header().Set("Cache-Control", "no-store")
	case strings.HasPrefix(path, "static/"):
		w.Header().Set("Cache-Control", "public, max-age=86400")
	default:
		w.Header().Set("Cache-Control", "no-store")
	}

	_, _ = w.Write(b)
}

func scanPhotos(dir string) ([]Photo, error) {
	var photos []Photo

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		// Don't abort the whole scan because one entry is unreadable.
		if walkErr != nil {
			return nil
		}

		if d.IsDir() {
			// Skip hidden directories and Synology's @eaDir thumbnail folders.
			base := d.Name()
			if path != dir && (base == "@eaDir" || strings.HasPrefix(base, ".")) {
				return filepath.SkipDir
			}
			return nil
		}

		name := d.Name()
		if !isAllowedExt(name) {
			return nil
		}

		// Relative path from the photos root, with forward slashes for URLs.
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)

		fi, err := d.Info()
		if err != nil {
			return nil
		}

		mtime := fi.ModTime().Unix()
		// Cache-bust param v=mtime so browsers refresh when a file changes.
		url := fmt.Sprintf("/photos/%s?v=%d", urlPathEscape(relSlash), mtime)

		photos = append(photos, Photo{
			URL:   url,
			Name:  relSlash,
			Mtime: mtime,
			Size:  fi.Size(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	return photos, nil
}

func sortPhotos(photos []Photo, order string) {
	switch order {
	case "mtime_asc":
		sort.Slice(photos, func(i, j int) bool { return photos[i].Mtime < photos[j].Mtime })
	case "name_asc":
		sort.Slice(photos, func(i, j int) bool { return strings.ToLower(photos[i].Name) < strings.ToLower(photos[i].Name) })
	case "name_desc":
		sort.Slice(photos, func(i, j int) bool { return strings.ToLower(photos[i].Name) > strings.ToLower(photos[j].Name) })
	case "mtime_desc", "":
		fallthrough
	default:
		sort.Slice(photos, func(i, j int) bool { return photos[i].Mtime > photos[j].Mtime })
	}
}

func isAllowedExt(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif":
		return true
	default:
		return false
	}
}

func safeJoin(baseDir, fileName string) (string, error) {
	if fileName == "" {
		return "", errors.New("empty name")
	}
	// Anchor at root then clean so any leading "../" is neutralized, while
	// still preserving legitimate subdirectories (e.g. "trip/2024/img.jpg").
	clean := filepath.Clean("/" + filepath.FromSlash(fileName))
	clean = strings.TrimPrefix(clean, string(filepath.Separator))

	joined := filepath.Join(baseDir, clean)

	baseAbs, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	joinedAbs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}

	rel, err := filepath.Rel(baseAbs, joinedAbs)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", errors.New("path escapes base dir")
	}
	return joinedAbs, nil
}

func urlPathEscape(s string) string {
	repl := strings.NewReplacer(
		"%", "%25",
		" ", "%20",
		"#", "%23",
		"?", "%3F",
	)
	return repl.Replace(s)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

		w.Header().Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'self'",
			"img-src 'self' data:",
			"style-src 'self'",
			"script-src 'self'",
		}, "; "))

		next.ServeHTTP(w, r)
	})
}

func stableHash(photos []Photo) string {
	h := sha256.New()
	for _, p := range photos {
		io.WriteString(h, p.Name)
		io.WriteString(h, ":")
		io.WriteString(h, strconv.FormatInt(p.Mtime, 10))
		io.WriteString(h, "\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ---- Auth (shared token) ----

func authMiddleware(token string, next http.Handler) http.Handler {
	want := []byte(token)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Let /healthz pass for infra health checks.
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}

		// If user provides token via query string once, set cookie then redirect.
		// Accept token=... or t=...
		q := r.URL.Query()
		if provided := firstNonEmpty(q.Get("token"), q.Get("t")); provided != "" {
			if constantTimeEqual(want, []byte(provided)) {
				setAuthCookie(w, r, token)

				// Redirect to same URL with token removed (so you can bookmark clean URLs later).
				cleanURL := *r.URL
				cq := cleanURL.Query()
				cq.Del("token")
				cq.Del("t")
				cleanURL.RawQuery = cq.Encode()

				http.Redirect(w, r, cleanURL.String(), http.StatusFound)
				return
			}
			// If they tried a token and it's wrong, fall through to unauthorized response.
		}

		// Cookie auth
		if c, err := r.Cookie(authCookieName); err == nil && c != nil {
			if constantTimeEqual(want, []byte(c.Value)) {
				next.ServeHTTP(w, r)
				return
			}
		}

		// Bearer token auth
		if bearer := parseBearer(r.Header.Get("Authorization")); bearer != "" {
			if constantTimeEqual(want, []byte(bearer)) {
				next.ServeHTTP(w, r)
				return
			}
		}

		unauthorized(w, r)
	})
}

func setAuthCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure := isProbablyHTTPS(r)

	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   authCookieMaxAgeSeconds,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

func unauthorized(w http.ResponseWriter, r *http.Request) {
	// Minimal, human-friendly response that works on TVs/kiosks.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)

	_, _ = io.WriteString(w, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Frameserve · Unauthorized</title>
  <link rel="icon" type="image/svg+xml" href="/static/camera.svg" />
  <link rel="apple-touch-icon" href="/static/camera.svg" />
  <meta name="theme-color" content="#000000" />
  <link rel="stylesheet" href="/static/fonts.css" />
  <link rel="stylesheet" href="/static/info.css" />
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Unauthorized</h1>
      <p>This Frameserve instance requires a shared access token.</p>
      <p><strong>One-time setup on this device:</strong></p>
      <p>Open this URL once (replace <code>YOURTOKEN</code>):</p>
      <p><code>`+htmlEscape(r.URL.Path)+`?token=YOURTOKEN</code></p>
      <p>After that, the device will stay logged in via a long-lived cookie.</p>
      <p class="muted">If you cleared cookies or switched browsers, repeat the one-time setup.</p>
      <div class="actions">
        <a class="btn" href="/info">How it works</a>
      </div>
    </div>
  </div>
</body>
</html>`)
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func parseBearer(authz string) string {
	authz = strings.TrimSpace(authz)
	if authz == "" {
		return ""
	}
	parts := strings.SplitN(authz, " ", 2)
	if len(parts) != 2 {
		return ""
	}
	if strings.ToLower(strings.TrimSpace(parts[0])) != "bearer" {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func isProbablyHTTPS(r *http.Request) bool {
	// Direct TLS
	if r.TLS != nil {
		return true
	}
	// Common reverse-proxy headers
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	return false
}

func htmlEscape(s string) string {
	repl := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return repl.Replace(s)
}
