//go:build !windows

package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/term"
)

const ringCap = 250 * 1024

var daemon = flag.Bool("daemon", false, "")

type ring struct{ b []byte }

func (r *ring) add(p []byte) {
	if len(p) >= ringCap {
		r.b = append(r.b[:0], p[len(p)-ringCap:]...)
		return
	}
	if len(r.b)+len(p) > ringCap {
		copy(r.b, r.b[len(r.b)+len(p)-ringCap:])
		r.b = r.b[:ringCap-len(p)]
	}
	r.b = append(r.b, p...)
}

func main() {
	sock := flag.String("s", defaultSock(), "unix socket path")
	flag.Parse()
	args := flag.Args()
	if *daemon {
		if len(args) == 0 {
			die("missing command")
		}
		dieIf(runServer(*sock, args))
		return
	}
	if len(args) == 0 {
		if !canDial(*sock) {
			die("no ptymux server at %s", *sock)
		}
		dieIf(runClient(*sock))
		return
	}
	if !canDial(*sock) {
		dieIf(startDaemon(*sock, args))
		deadline := time.Now().Add(2 * time.Second)
		for !canDial(*sock) {
			if time.Now().After(deadline) {
				die("server did not start; see %s", logPath())
			}
			time.Sleep(25 * time.Millisecond)
		}
	}
	dieIf(runClient(*sock))
}

func runServer(sock string, args []string) error {
	_ = os.Remove(sock)
	if err := os.MkdirAll(filepath.Dir(sock), 0700); err != nil {
		return err
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	defer os.Remove(sock)
	defer ln.Close()
	_ = os.Chmod(sock, 0600)

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = withTerm(os.Environ())
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return err
	}
	defer ptmx.Close()

	var mu sync.Mutex
	hist := &ring{}
	clients := map[net.Conn]bool{}
	done := make(chan struct{})

	go func() {
		buf := make([]byte, 32768)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := append([]byte(nil), buf[:n]...)
				mu.Lock()
				hist.add(chunk)
				for c := range clients {
					if _, e := c.Write(chunk); e != nil {
						c.Close()
						delete(clients, c)
					}
				}
				mu.Unlock()
			}
			if err != nil {
				close(done)
				return
			}
		}
	}()
	go func() { _ = cmd.Wait(); ptmx.Close() }()

	for {
		c, err := ln.Accept()
		if err != nil {
			select {
			case <-done:
				return nil
			default:
				continue
			}
		}
		mu.Lock()
		if len(hist.b) > 0 {
			_, _ = c.Write(hist.b)
		}
		clients[c] = true
		mu.Unlock()
		go handleClient(c, ptmx, &mu, clients)
	}
}

func handleClient(c net.Conn, ptmx *os.File, mu *sync.Mutex, clients map[net.Conn]bool) {
	defer func() {
		mu.Lock()
		delete(clients, c)
		mu.Unlock()
		c.Close()
	}()
	h := make([]byte, 3)
	for {
		if _, err := io.ReadFull(c, h); err != nil {
			return
		}
		p := make([]byte, binary.BigEndian.Uint16(h[1:]))
		if _, err := io.ReadFull(c, p); err != nil {
			return
		}
		switch h[0] {
		case 0:
			if len(p) > 0 {
				_, _ = ptmx.Write(p)
			}
		case 1:
			if len(p) == 4 {
				_ = pty.Setsize(ptmx, &pty.Winsize{
					Rows: binary.BigEndian.Uint16(p[0:2]),
					Cols: binary.BigEndian.Uint16(p[2:4]),
				})
			}
		}
	}
}

func runClient(sock string) error {
	c, err := net.Dial("unix", sock)
	if err != nil {
		return err
	}
	defer c.Close()
	var wmu sync.Mutex
	if err := sendSize(c, &wmu); err != nil {
		return err
	}
	old, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err == nil {
		defer term.Restore(int(os.Stdin.Fd()), old)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGWINCH)
	defer signal.Stop(sig)
	go func() {
		for range sig {
			_ = sendSize(c, &wmu)
		}
	}()
	errc := make(chan error, 2)
	go func() { errc <- copyFrames(c, os.Stdin, &wmu) }()
	go func() { _, e := io.Copy(os.Stdout, c); errc <- e }()
	return <-errc
}

func copyFrames(w io.Writer, r io.Reader, mu *sync.Mutex) error {
	buf := make([]byte, 32768)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if e := sendFrame(w, 0, buf[:n], mu); e != nil {
				return e
			}
		}
		if err != nil {
			return nil
		}
	}
}

func sendSize(w io.Writer, mu *sync.Mutex) error {
	cols, rows, err := term.GetSize(int(os.Stdout.Fd()))
	if err != nil {
		return nil
	}
	p := make([]byte, 4)
	binary.BigEndian.PutUint16(p[0:2], uint16(rows))
	binary.BigEndian.PutUint16(p[2:4], uint16(cols))
	return sendFrame(w, 1, p, mu)
}

func sendFrame(w io.Writer, typ byte, p []byte, mu *sync.Mutex) error {
	mu.Lock()
	defer mu.Unlock()
	for len(p) > 0 || typ == 1 {
		n := len(p)
		if n > 65535 {
			n = 65535
		}
		h := []byte{typ, byte(n >> 8), byte(n)}
		if _, err := w.Write(append(h, p[:n]...)); err != nil {
			return err
		}
		if typ == 1 || n == len(p) {
			return nil
		}
		p = p[n:]
	}
	return nil
}

func startDaemon(sock string, args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	log, err := os.OpenFile(logPath(), os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	a := []string{"-daemon", "-s", sock}
	a = append(a, args...)
	cmd := exec.Command(exe, a...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = log, log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd.Start()
}

func canDial(sock string) bool {
	c, err := net.DialTimeout("unix", sock, 100*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func defaultSock() string {
	if x := os.Getenv("XDG_RUNTIME_DIR"); x != "" {
		return filepath.Join(x, "ptymux.sock")
	}
	u := os.Getenv("USER")
	if u == "" {
		if cu, err := user.Current(); err == nil {
			u = cu.Username
		}
	}
	if u == "" {
		u = "unknown"
	}
	return filepath.Join(os.TempDir(), "ptymux-"+u+".sock")
}

func logPath() string { return filepath.Join(os.TempDir(), "ptymux.log") }

func withTerm(env []string) []string {
	out := env[:0]
	for _, e := range env {
		if len(e) < 5 || e[:5] != "TERM=" {
			out = append(out, e)
		}
	}
	return append(out, "TERM=xterm-256color")
}

func dieIf(err error) {
	if err != nil {
		die("%v", err)
	}
}

func die(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "ptymux: "+f+"\n", a...)
	os.Exit(1)
}
