package events

import "testing"

func TestRecordsPagesAndReopens(t *testing.T) {
	dataRoot := t.TempDir()
	log, err := Open(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	work := "work"
	for i := 0; i < 5; i++ {
		// Equal timestamps must still page without skipping (the cursor is the id).
		log.Record(Input{ProfileID: &work, Type: "browser.started", Message: "m", OccurredAt: "2026-01-01T00:00:00.000Z", Details: map[string]any{"n": i}})
	}
	log.Record(Input{Type: "hub.started", Message: "hub"})
	log.Close()
	log.Record(Input{Type: "ignored", Message: "after close"})

	reopened, err := Open(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	first, _ := reopened.List(Query{ProfileID: "work", Limit: 2})
	if len(first.Events) != 2 || first.NextBefore == nil || first.Events[0].Details["n"].(float64) != 4 {
		t.Fatalf("first page %+v", first)
	}
	var seen []int64
	cursor := *first.NextBefore
	for _, e := range first.Events {
		seen = append(seen, e.ID)
	}
	for {
		page, _ := reopened.List(Query{ProfileID: "work", Limit: 2, Before: cursor})
		for _, e := range page.Events {
			seen = append(seen, e.ID)
		}
		if page.NextBefore == nil {
			break
		}
		cursor = *page.NextBefore
	}
	if len(seen) != 5 {
		t.Errorf("paged %v", seen)
	}
	all, _ := reopened.List(Query{})
	if len(all.Events) != 6 || all.Events[0].Type != "hub.started" || all.Events[0].ProfileID != nil || all.Events[0].Level != "info" {
		t.Errorf("all %+v", all.Events)
	}
	filtered, _ := reopened.List(Query{Since: "2026-01-02T00:00:00.000Z", Type: "browser.started"})
	if len(filtered.Events) != 0 {
		t.Errorf("since filter %+v", filtered)
	}
}
