package proposal

import (
	"archive/zip"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

type Draft struct {
	Title              string `json:"title"`
	Abstract           string `json:"abstract"`
	Motivation         string `json:"motivation"`
	Goal               string `json:"goal"`
	PlanStatement      string `json:"planStatement"`
	ImplementationTeam any    `json:"implementationTeam"`
	BudgetStatement    string `json:"budgetStatement"`
	Milestone          any    `json:"milestone"`
	Relevance          any    `json:"relevance"`
}

// ParseDraftZIP decodes hex-encoded ZIP data and extracts proposal.json.
func ParseDraftZIP(hexData string) (*Draft, error) {
	raw, err := hex.DecodeString(hexData)
	if err != nil {
		return nil, fmt.Errorf("hex decode: %w", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}

	for _, f := range zr.File {
		if f.Name != "proposal.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("open proposal.json: %w", err)
		}
		defer rc.Close()

		data, err := io.ReadAll(rc)
		if err != nil {
			return nil, fmt.Errorf("read proposal.json: %w", err)
		}
		var draft Draft
		if err := json.Unmarshal(data, &draft); err != nil {
			return nil, fmt.Errorf("parse proposal.json: %w", err)
		}
		return &draft, nil
	}
	return nil, fmt.Errorf("proposal.json not found in ZIP")
}

// ResolveRelevance handles the relevance field being either a string or an
// array in some proposals' draft data.
func ResolveRelevance(v any) string {
	switch r := v.(type) {
	case string:
		return r
	case []any:
		if len(r) == 0 {
			return ""
		}
		parts := make([]string, 0, len(r))
		for _, item := range r {
			if s, ok := item.(string); ok {
				parts = append(parts, s)
			} else if m, ok := item.(map[string]any); ok {
				if b, err := json.Marshal(m); err == nil {
					parts = append(parts, string(b))
				}
			}
		}
		result := parts[0]
		for i := 1; i < len(parts); i++ {
			result += "\n" + parts[i]
		}
		return result
	default:
		if v == nil {
			return ""
		}
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// TeamJSON serializes the implementation team field to JSON.
func TeamJSON(team any) string {
	if team == nil {
		return "[]"
	}
	b, err := json.Marshal(team)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// MilestoneJSON serializes the milestone field to JSON.
func MilestoneJSON(milestone any) string {
	if milestone == nil {
		return ""
	}
	b, err := json.Marshal(milestone)
	if err != nil {
		return ""
	}
	return string(b)
}
