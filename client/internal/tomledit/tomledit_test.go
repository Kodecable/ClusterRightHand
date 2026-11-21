package tomledit

import (
	"strings"
	"testing"
)

func TestCheckEditCatchesAnEditThatDoesMore(t *testing.T) {
	before := []byte("a = 1\nb = 2\n")
	after := []byte("a = 5\n")
	if err := checkEdit(before, after, Edit{Op: Set, Path: []string{"a"}, Value: 5}); err == nil {
		t.Fatal("an edit that also deleted b passed the check")
	}
	if err := checkEdit(before, []byte("a = 5\nb = 2\n"), Edit{Op: Set, Path: []string{"a"}, Value: 5}); err != nil {
		t.Fatal(err)
	}
}

func TestReplaceTablesKeepsTheRestOfTheDocument(t *testing.T) {
	doc := []byte("# managed by ops\nnode_id = \"n\"  # this node\n\n[[trust]]\nname = \"old\"\nrole = \"local\"\nuids = [0]\n")
	tables := "[[trust]]\nname = \"new\"\nrole = \"local\"\nuids = [0, 1000]"
	out, done, err := Apply(doc, []Edit{{Op: ReplaceTables, Path: []string{"trust"}, Tables: tables}})
	if err != nil || len(done) != 1 {
		t.Fatalf("%v, %v", done, err)
	}
	text := string(out)
	if !strings.HasPrefix(text, "# managed by ops\nnode_id = \"n\"  # this node\n") || strings.Contains(text, "old") || !strings.Contains(text, `name = "new"`) {
		t.Fatalf("result:\n%s", text)
	}
	// The same tables again change nothing.
	again, done, err := Apply(out, []Edit{{Op: ReplaceTables, Path: []string{"trust"}, Tables: tables}})
	if err != nil || len(done) != 0 || string(again) != text {
		t.Fatalf("again: %v, %v\n%s", done, err, again)
	}
	// Tables of another name are refused: the edit would change more than it says.
	if _, _, err := Apply(doc, []Edit{{Op: ReplaceTables, Path: []string{"trust"}, Tables: "[[other]]\na = 1"}}); err == nil {
		t.Fatal("replaced [[trust]] with [[other]]")
	}
}

func TestSettingTheSameValueIsNoChange(t *testing.T) {
	doc := []byte("server = 'https://a'   # quoted the other way\n")
	out, done, err := Apply(doc, []Edit{{Op: Set, Path: []string{"server"}, Value: "https://a"}})
	if err != nil || len(done) != 0 || string(out) != string(doc) {
		t.Fatalf("%q, %v, %v", out, done, err)
	}
}
