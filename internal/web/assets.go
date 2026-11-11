package web

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
)

// dist holds the UI bundles built from src/ui by scripts/build-ui.mjs (esbuild).
//
//go:embed all:dist
var embedded embed.FS

//go:embed static/favicon.svg
var favicon []byte

type assets struct {
	files fs.FS
}

var assetFiles = map[string]struct{ file, contentType string }{
	"/assets/app.js":    {"app.js", "text/javascript; charset=utf-8"},
	"/assets/viewer.js": {"viewer.js", "text/javascript; charset=utf-8"},
	"/assets/login.js":  {"login.js", "text/javascript; charset=utf-8"},
	"/assets/app.css":   {"app.css", "text/css; charset=utf-8"},
}

// loadAssets serves the embedded bundles, or CLOAKHUB_UI_DIST during development.
func loadAssets() *assets {
	if dir := os.Getenv("CLOAKHUB_UI_DIST"); dir != "" {
		return &assets{files: os.DirFS(dir)}
	}
	sub, _ := fs.Sub(embedded, "dist")
	return &assets{files: sub}
}

func (a *assets) response(r *http.Request, path string) *response {
	entry, ok := assetFiles[path]
	if !ok {
		return nil
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return emptyResponse(405, nil)
	}
	body, err := fs.ReadFile(a.files, entry.file)
	if err != nil {
		return textResponse("UI assets are not built; run node scripts/build-ui.mjs", 503, nil)
	}
	return newResponse(200, entry.contentType, body, map[string]string{"Cache-Control": "no-cache"})
}
