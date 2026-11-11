package browser

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/txchen/cloakhub/internal/procs"
)

// XclipWriter sets a display's CLIPBOARD selection with xclip.
type XclipWriter struct{}

// WriteText writes text to the display's clipboard.
func (XclipWriter) WriteText(display, text string) error {
	cmd := exec.Command("xclip", "-selection", "clipboard")
	cmd.Env = procs.SetEnv(os.Environ(), "DISPLAY", display)
	cmd.Stdin = strings.NewReader(text)
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("xclip exited with status %d", exit.ExitCode())
		}
		return err
	}
	return nil
}

const (
	maxClipboardText    = 1_048_576
	cdpClipboardTimeout = 1500 * time.Millisecond
)

const clipboardExpression = `(() => {
  const clipboardStateKey = "__cloakhubClipboardState";
  const selectedText = () => {
    const active = document.activeElement;
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      typeof active.selectionStart === "number" &&
      typeof active.selectionEnd === "number"
    ) {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
    return window.getSelection()?.toString() || "";
  };
  if (!window[clipboardStateKey]) {
    const state = { text: selectedText() };
    const capture = () => {
      const text = selectedText();
      if (text) state.text = text;
    };
    document.addEventListener("copy", capture, true);
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") capture();
    }, true);
    window[clipboardStateKey] = state;
  }
  return window[clipboardStateKey].text || "";
})()`

// CdpClipboardReader reads the most recent copied or selected page text over CDP.
type CdpClipboardReader struct {
	// ListTargets returns /json for a CDP port; tests replace it.
	ListTargets func(cdpPort int) ([]map[string]any, error)
	// Evaluate runs the clipboard expression on one page; tests replace it.
	Evaluate func(webSocketURL string) (string, error)
}

// ReadText tries each page target until one reports text.
func (c CdpClipboardReader) ReadText(cdpPort int) (string, error) {
	list := c.ListTargets
	if list == nil {
		list = listCdpTargets
	}
	evaluate := c.Evaluate
	if evaluate == nil {
		evaluate = evaluateClipboard
	}
	targets, err := list(cdpPort)
	if err != nil {
		return "", err
	}
	for _, target := range targets {
		url, _ := target["webSocketDebuggerUrl"].(string)
		if target["type"] != "page" || url == "" {
			continue
		}
		// A page can disappear between discovery and evaluation; try the next one.
		if text, err := evaluate(url); err == nil && text != "" {
			if len(text) > maxClipboardText {
				text = text[:maxClipboardText]
			}
			return text, nil
		}
	}
	return "", nil
}

func listCdpTargets(cdpPort int) ([]map[string]any, error) {
	client := http.Client{Timeout: cdpClipboardTimeout}
	response, err := client.Get("http://127.0.0.1:" + strconv.Itoa(cdpPort) + "/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 {
		return nil, fmt.Errorf("CDP target discovery returned %d", response.StatusCode)
	}
	var targets []map[string]any
	if err := json.NewDecoder(response.Body).Decode(&targets); err != nil {
		return nil, nil
	}
	return targets, nil
}

func evaluateClipboard(url string) (string, error) {
	dialer := websocket.Dialer{HandshakeTimeout: cdpClipboardTimeout}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return "", errors.New("CDP clipboard connection failed")
	}
	defer conn.Close()
	_ = conn.NetConn().SetDeadline(time.Now().Add(cdpClipboardTimeout))
	request, _ := json.Marshal(map[string]any{
		"id":     1,
		"method": "Runtime.evaluate",
		"params": map[string]any{"awaitPromise": true, "expression": clipboardExpression, "returnByValue": true},
	})
	if err := conn.WriteMessage(websocket.TextMessage, request); err != nil {
		return "", err
	}
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return "", errors.New("CDP clipboard evaluation timed out")
		}
		var reply struct {
			ID    int `json:"id"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			Result *struct {
				ExceptionDetails any `json:"exceptionDetails"`
				Result           struct {
					Value any `json:"value"`
				} `json:"result"`
			} `json:"result"`
		}
		if err := json.Unmarshal(message, &reply); err != nil {
			return "", err
		}
		if reply.ID != 1 {
			continue
		}
		if reply.Error != nil || (reply.Result != nil && reply.Result.ExceptionDetails != nil) {
			return "", errors.New("CDP clipboard evaluation failed")
		}
		if reply.Result != nil {
			if text, ok := reply.Result.Result.Value.(string); ok {
				return text, nil
			}
		}
		return "", nil
	}
}
