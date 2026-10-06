package agent

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

func TestCPUModelKnownArchitectureFields(t *testing.T) {
	for _, test := range []struct{ name, text, want string }{
		{"x86", "processor : 0\nmodel : 183\nmodel name :  Intel(R) Core(TM) i7-13700K\nprocessor : 1\nmodel name : other", "Intel(R) Core(TM) i7-13700K"},
		{"arm", "Processor : ARMv7 Processor rev 5 (v7l)\nHardware : Board model\n", "ARMv7 Processor rev 5 (v7l)"},
		{"arm64", "processor : 0\nmodel name : ARMv8 Processor rev 1 (aarch64)\nCPU implementer : 0x41", "ARMv8 Processor rev 1 (aarch64)"},
		{"mips", "system type : Embedded board\nprocessor : 0\ncpu model : MIPS 24Kc V7.4\nBogoMIPS : 400", "MIPS 24Kc V7.4"},
		{"riscv", "processor : 0\nhart : 0\nisa : rv64imafdc\nuarch : sifive,u74-mc", "sifive,u74-mc"},
		{"powerpc", "processor : 0\ncpu : POWER10 (raw), altivec supported", "POWER10 (raw), altivec supported"},
		{"preferred", "Processor : generic processor\nuarch : generic uarch\nModel Name : Exact Model", "Exact Model"},
		{"missing", "processor : 0\nprocessor : 1\nmodel : 85\nHardware : Board model\nCPU part : 0xd03\n", ""},
		{"unavailable", "model name : unknown\nuarch : N/A", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := parseCPUModel(strings.NewReader(test.text)); got != test.want {
				t.Fatalf("model = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCPUModelSanitizationAndByteBound(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"  AMD\t\r\nRyzen\x00\x1b 9  ", "AMD Ryzen 9"},
		{"Intel\u202e Core\ufffd\xff", "Intel Core\ufffd"},
		{strings.Repeat("a", 127) + "芯片", strings.Repeat("a", 127)},
		{strings.Repeat("芯", 43), strings.Repeat("芯", 42)},
		{"\x00\t\u202e\xff", ""},
	} {
		got := sanitizeCPUModel(test.input)
		if got != test.want || !utf8.ValidString(got) || len(got) > maxCPUModelBytes {
			t.Fatalf("sanitized model = %q, want %q", got, test.want)
		}
		for _, r := range got {
			if unicode.IsControl(r) || !unicode.IsPrint(r) {
				t.Fatal("non-displayable model character survived")
			}
		}
	}
}

type countedCPUInfoReader struct{ read int }

func (r *countedCPUInfoReader) Read(data []byte) (int, error) {
	for i := range data {
		if i%2 == 0 {
			data[i] = 'x'
		} else {
			data[i] = '\n'
		}
	}
	r.read += len(data)
	return len(data), nil
}
func TestCPUModelReaderIsBoundedAndFailureIsOptional(t *testing.T) {
	var reader countedCPUInfoReader
	if parseCPUModel(&reader) != "" || reader.read != maxCPUInfoBytes {
		t.Fatalf("unbounded cpuinfo: %d bytes", reader.read)
	}
	if parseCPUModel(io.LimitReader(strings.NewReader("model name : invisible"), 0)) != "" {
		t.Fatal("invented missing model")
	}
}

func TestCPUModelIsOptionalHostMetadata(t *testing.T) {
	hello, err := json.Marshal(LiveHello{Type: "hello", Host: HostInfo{CPUModel: "Test CPU"}})
	if err != nil || !strings.Contains(string(hello), `"cpu_model":"Test CPU"`) {
		t.Fatal("CPU model missing from hello")
	}
	empty, _ := json.Marshal(HostInfo{})
	metrics, _ := json.Marshal(benchmarkLiveMetrics())
	if strings.Contains(string(empty), "cpu_model") || strings.Contains(string(metrics), "cpu_model") {
		t.Fatal("empty/repeated CPU model on wire")
	}
}
