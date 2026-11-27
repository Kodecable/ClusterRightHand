package executor

import "testing"

func TestResolveWriteIDs(t *testing.T) {
	existing := &fileAttr{uid: 1000, gid: 100}
	cases := []struct {
		name     string
		uid, gid int
		existing *fileAttr
		wantUID  int
		wantGID  int
	}{
		{"both omitted on an existing file", -1, -1, existing, 1000, 100},
		{"only owner on an existing file", 2000, -1, existing, 2000, 100},
		{"only group on an existing file", -1, 200, existing, 1000, 200},
		{"both specified on an existing file", 2000, 200, existing, 2000, 200},
		{"both omitted on a new file", -1, -1, nil, -1, -1},
		{"only owner on a new file", 2000, -1, nil, 2000, -1},
		{"only group on a new file", -1, 200, nil, -1, 200},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			uid, gid := resolveWriteIDs(testCase.uid, testCase.gid, testCase.existing)
			if uid != testCase.wantUID || gid != testCase.wantGID {
				t.Fatalf("ids = %d:%d, want %d:%d", uid, gid, testCase.wantUID, testCase.wantGID)
			}
		})
	}
}
