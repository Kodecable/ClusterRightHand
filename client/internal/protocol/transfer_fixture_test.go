package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestTransferFixture cross-checks the data connection values and the file.push/file.pull specs and
// results against test/interop/transfer_fixture.json, which the TypeScript implementation generates.
// Every positive decodes and re-encodes to the same bytes; every negative is rejected.
func TestTransferFixture(t *testing.T) {
	path := filepath.Join("..", "..", "..", "test", "interop", "transfer_fixture.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var fixture struct {
		Prologue string `json:"prologue"`
		Positive []struct {
			ID          string `json:"id"`
			Description string `json:"description"`
			Codec       string `json:"codec"`
			Hex         string `json:"hex"`
		} `json:"positive"`
		Negative []struct {
			ID          string `json:"id"`
			Description string `json:"description"`
			Codec       string `json:"codec"`
			Hex         string `json:"hex"`
		} `json:"negative"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if fixture.Prologue != DataNoiseProloguePrefix {
		t.Errorf("prologue = %q, want %q", fixture.Prologue, DataNoiseProloguePrefix)
	}

	decode := func(codec string, raw []byte) ([]byte, error) {
		switch codec {
		case "frame":
			frame, err := DecodeFrame(raw)
			if err != nil {
				return nil, err
			}
			return frame.Encode()
		case "task-spec":
			var spec TaskSpec
			if err := Unmarshal(raw, &spec); err != nil {
				return nil, err
			}
			return Marshal(spec)
		case "task-result":
			var result TaskResult
			if err := Unmarshal(raw, &result); err != nil {
				return nil, err
			}
			return Marshal(result)
		case "data-init":
			var init DataConnectionInit
			if err := Unmarshal(raw, &init); err != nil {
				return nil, err
			}
			return Marshal(init)
		case "data-response":
			var response DataConnectionResponse
			if err := Unmarshal(raw, &response); err != nil {
				return nil, err
			}
			return Marshal(response)
		case "data-frame":
			var frame DataFrame
			if err := Unmarshal(raw, &frame); err != nil {
				return nil, err
			}
			return Marshal(frame)
		default:
			t.Fatalf("unknown fixture codec %q", codec)
			return nil, nil
		}
	}

	for _, entry := range fixture.Positive {
		t.Run(entry.ID, func(t *testing.T) {
			raw, err := hex.DecodeString(entry.Hex)
			if err != nil {
				t.Fatalf("hex: %v", err)
			}
			encoded, err := decode(entry.Codec, raw)
			if err != nil {
				t.Fatalf("decode %s: %v", entry.ID, err)
			}
			if got := hex.EncodeToString(encoded); got != entry.Hex {
				t.Fatalf("re-encoded %s differs:\n got %s\nwant %s", entry.ID, got, entry.Hex)
			}
		})
	}

	for _, entry := range fixture.Negative {
		t.Run(entry.ID, func(t *testing.T) {
			raw, err := hex.DecodeString(entry.Hex)
			if err != nil {
				t.Fatalf("hex: %v", err)
			}
			if encoded, err := decode(entry.Codec, raw); err == nil {
				t.Fatalf("decoded %s (%s), want a refusal; re-encoded %x", entry.ID, entry.Description, encoded)
			}
		})
	}
}
