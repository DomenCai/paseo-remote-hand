#!/usr/bin/env python3
# 在 hand 上运行。外层 SSH 只调度测试；被测 SSH/SCP 由 brain 发起。
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import shlex
import subprocess as sp
import sys
import tempfile
import time

Q = shlex.quote
BASE = pathlib.Path("/tmp/remote-hand-poc2")
SIZE = 50 * 1024**2
SSH_TIMEOUT = 300
failed = []


def run(args, **kw):
    return sp.run(args, capture_output=True, text=True, timeout=SSH_TIMEOUT, **kw)


def remote(command, **kw):
    return run(HOST + [command], **kw)


def output(result):
    print(result.stdout.strip(), flush=True)
    for line in result.stderr.splitlines():
        if line and not line.startswith("** "):
            print(line, flush=True)
    print(f"rc={result.returncode}", flush=True)


def check(number, label, ok):
    print(f"CHECK {number} {'PASS' if ok else 'FAIL'} {label}", flush=True)
    if not ok:
        failed.append(number)


def event_rows(args, event):
    rows = run(args, check=True)
    return [
        json.loads(x["message"]) for x in json.loads(rows.stdout)
        if x["message"].startswith('{"event":"' + event + '"')
    ]


def hand_ready():
    return event_rows(["paseo", "plugin", "logs", "remote-hand", "--json"], "hand-ready")[-1]


def brain_state():
    return event_rows(HOST + ["paseo plugin logs remote-hand --json"], "brain-listening")[-1]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def timed(command):
    start = time.monotonic()
    result = remote(command)
    return result, time.monotonic() - start


def rss(hand):
    vals = run(["ps", "-o", "pid=,rss=", "-p", f"{hand['pid']},{hand['worker']}"], check=True)
    return {int(pid): int(kib) for pid, kib in (line.split() for line in vals.stdout.splitlines())}


def backpressure(hand, ssh, scratch):
    source = scratch / "hand.50"
    expected = digest(source)
    events = ["paseo", "plugin", "logs", "remote-hand", "--json"]
    previous = len(event_rows(events, "stream-close"))
    baseline = rss(hand)
    peak = dict(baseline)
    samples = []
    # 先读 4 MiB 再停下此测试专用的 ssh 子进程，直接阻塞 brain 的 TCP 接收。
    reader = """
import hashlib, os, signal, subprocess, sys, time
h = hashlib.sha256()
n = 0
with subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE) as child:
    while n < 4 * 1024**2:
        b = child.stdout.read(65536)
        if not b:
            sys.exit(2)
        h.update(b)
        n += len(b)
    os.kill(child.pid, signal.SIGSTOP)
    print(f"paused_at={time.time():.3f}", flush=True)
    try:
        time.sleep(8)
    finally:
        os.kill(child.pid, signal.SIGCONT)
    print(f"resumed_at={time.time():.3f}", flush=True)
    while b := child.stdout.read(262144):
        h.update(b)
        n += len(b)
    print(h.hexdigest(), n)
    sys.exit(child.wait())
"""
    cmd = f"python3 -c {Q(reader)} {ssh} {Q('cat ' + Q(str(source)))}"
    print(f"$ {ssh} 'cat {source}'  # brain: SIGSTOP test ssh for 8 s after 4 MiB; SIGCONT; sha256", flush=True)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        slow = pool.submit(timed, cmd)
        while not slow.done():
            observed = rss(hand)
            samples.append((time.time(), observed))
            for pid, kib in observed.items():
                peak[pid] = max(peak[pid], kib)
            time.sleep(.15)
        result, elapsed = slow.result()
    output(result)
    print(f"slow seconds={elapsed:.2f} rss_baseline_KiB={baseline} rss_peak_KiB={peak}", flush=True)
    paused = re.search(r"paused_at=(\d+\.\d+)", result.stdout)
    resumed = re.search(r"resumed_at=(\d+\.\d+)", result.stdout)
    if paused and resumed:
        inside = [sample for ts, sample in samples if float(paused[1]) <= ts <= float(resumed[1])]
        if inside:
            print(f"paused_rss_KiB start={inside[0]} end={inside[-1]} peak="
                  f"{ {pid: max(r[pid] for r in inside) for pid in baseline} }", flush=True)
    streams = event_rows(events, "stream-close")[previous:]
    evidence = next((e for e in reversed(streams) if e["sent"] >= SIZE and e["reason"] == "fin"), {})
    print(f"hand stream: {json.dumps(evidence)}", flush=True)
    check(6, "slow output and window backpressure", result.returncode == 0
          and result.stdout.strip().endswith(f"{expected} {SIZE}") and bool(paused and resumed)
          and evidence.get("pauses", 0) > 0 and evidence.get("peakOutstanding") == hand["window"])


def main(project):
    state = brain_state()
    hand = hand_ready()
    cfg = state["config"]
    ssh = f"ssh -F {Q(cfg)} mac-local"
    scp = f"scp -F {Q(cfg)}"
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="test-", dir=BASE))
    d = Q(str(scratch))
    print(f"test_dir={scratch} cfg={cfg}", flush=True)
    remote(f"umask 077; mkdir {d}", check=True)

    def ready():
        script = f"cd -- {Q(str(project))} || exit 1\nprintf 'REMOTE_HAND_READY\\n'\nexit 17\n"
        res = remote(f"{ssh} /bin/zsh -f -s", input=script)
        print(f"$ {ssh} /bin/zsh -f -s <<'EOF'\n{script}EOF", flush=True)
        output(res)
        return res.stdout == "REMOTE_HAND_READY\n" and res.returncode == 17

    check(1, "signed login", ready())
    cmd = (
        f'umask 077; cp "$(awk \'$1=="IdentityFile" {{print $2}}\' {Q(cfg)})" {d}/old; '
        f'ssh-keygen -q -t ed25519 -N "" -f {d}/wrong; '
        f'sed "s|^  IdentityFile .*|  IdentityFile {d}/wrong|" {Q(cfg)} >{d}/wrong.cfg; '
        f'ssh -n -F {d}/wrong.cfg mac-local true'
    )
    print(f"$ ssh -F {d}/wrong.cfg mac-local true (fresh Ed25519 identity)", flush=True)
    wrong = remote(cmd)
    output(wrong)
    wrong_ok = wrong.returncode == 255 and "Permission denied (publickey)" in wrong.stderr

    for number, cmd, code, stdout in [
        (3, f"{ssh} 'exit 42'", 42, ""),
        (4, f"printf abc | {ssh} 'cat; echo done'", 0, "abcdone\n"),
    ]:
        print(f"$ {cmd}", flush=True)
        res = remote(cmd)
        output(res)
        check(number, "exit status" if number == 3 else "half close", res.returncode == code and res.stdout == stdout)

    print("$ dd if=/dev/urandom bs=1m count=50  # one independent input on each host", flush=True)
    run(["dd", "if=/dev/urandom", f"of={scratch}/hand.50", "bs=1m", "count=50"], check=True)
    remote(f"umask 077; dd if=/dev/urandom of={d}/brain.50 bs=1m count=50", check=True)
    hand_hash = digest(scratch / "hand.50")
    brain_hash = remote(f"shasum -a 256 {d}/brain.50", check=True).stdout.split()[0]

    def transfer(label, command, expected, size=SIZE):
        print(f"$ {command}", flush=True)
        res, elapsed = timed(command)
        output(res)
        print(f"{label} expected_sha256={expected} seconds={elapsed:.2f} MiB/s={size / 2**20 / elapsed:.2f}", flush=True)
        return res.returncode == 0 and re.search(r"^" + expected + r"\b", res.stdout, re.M) is not None

    down = f"{ssh} 'cat {d}/hand.50' >{d}/down && shasum -a 256 {d}/down"
    up = f"{ssh} 'shasum -a 256' <{d}/brain.50"
    down_ok = transfer("down 50 MiB", down, hand_hash)
    up_ok = transfer("up 50 MiB", up, brain_hash)
    check(5, "ordered data in both directions", down_ok and up_ok)

    backpressure(hand, ssh, scratch)

    with concurrent.futures.ThreadPoolExecutor() as pool:
        a = pool.submit(transfer, "parallel down 50 MiB", down.replace("/down", "/parallel-down"), hand_hash)
        b = pool.submit(transfer, "parallel up 50 MiB", up, brain_hash)
        check(7, "two concurrent SSH sessions", a.result() and b.result())

    remote(f"umask 077; dd if=/dev/urandom of={d}/scp.src bs=1m count=10", check=True)
    up_cmd = f"{scp} {d}/scp.src mac-local:{d}/scp.hand"
    down_cmd = f"{scp} mac-local:{d}/scp.hand {d}/scp.back"
    print(f"$ {up_cmd}\n$ {down_cmd}\n$ shasum -a 256 {d}/scp.src {d}/scp.back", flush=True)
    scp_result = remote(f"umask 077; {up_cmd} && {down_cmd} && shasum -a 256 {d}/scp.src {d}/scp.back")
    output(scp_result)
    scp_hashes = [x.split()[0] for x in scp_result.stdout.splitlines() if x]
    check(8, "SFTP upload/download", scp_result.returncode == 0
          and scp_hashes == [digest(scratch / "scp.hand")] * 2)

    tcc_path = project / "README.md"
    print(f"$ {ssh} {Q('shasum -a 256 ' + Q(str(tcc_path)))}", flush=True)
    tcc = remote(f"{ssh} {Q('shasum -a 256 ' + Q(str(tcc_path)))}")
    output(tcc)
    local = digest(tcc_path)
    print(f"local_sha256={local}", flush=True)
    check(9, "project file hash", tcc.returncode == 0 and tcc.stdout.startswith(local + " "))

    # 同一个 pid 代表这一轮 SSH。先见到正在增长的输出，再 reload hand。
    hand_command = f"printf 'start\\n' >>{d}/invocations; echo START; cat {d}/hand.50; sleep 30"
    cmd = (
        f'{ssh} {Q(hand_command)} >{d}/interrupted 2>{d}/disconnect.err & '
        f'child=$!; wait "$child"; rc=$?; cat {d}/disconnect.err >&2; '
        f'printf "bytes=%s\\n" "$(wc -c <{d}/interrupted | tr -d " ")"; exit "$rc"'
    )
    print(f"$ {ssh} {Q(hand_command)} >{d}/interrupted", flush=True)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        interrupted = pool.submit(remote, cmd)
        seen = remote(
            f'i=0; while [ "$i" -lt 150 ]; do '
            f'if [ -f {d}/interrupted ] && [ "$(wc -c < {d}/interrupted)" -gt 262144 ]; then '
            f'wc -c <{d}/interrupted; exit 0; fi; i=$((i+1)); sleep .1; done; exit 1'
        )
        print(f"before_reload_bytes={seen.stdout.strip()}", flush=True)
        start = time.monotonic()
        reload_job = pool.submit(run, ["paseo", "plugin", "reload", "remote-hand"])
        broken = interrupted.result(timeout=25)
        elapsed = time.monotonic() - start
        reload_job.result().check_returncode()
    output(broken)
    partial = re.search(r"bytes=(\d+)", broken.stdout)
    print(f"disconnect_seconds={elapsed:.2f}", flush=True)
    for _ in range(20):
        new_state = brain_state()
        if new_state != state:
            break
        time.sleep(.5)
    recovered = ready()
    record = scratch / "invocations"
    invocations = record.read_text().splitlines() if record.exists() else []
    print(f"hand_invocations={len(invocations)}", flush=True)
    check(10, "reload aborts partial transfer and restores login", seen.returncode == 0
          and 0 < int(seen.stdout) < SIZE and broken.returncode == 255 and elapsed <= 20
          and partial is not None and int(partial[1]) < SIZE + 6 and new_state != state and recovered
          and invocations == ["start"])

    print(f"$ ssh -F {d}/old.cfg mac-local true (old identity, new pinned host key)", flush=True)
    stale = remote(
        f'cmp -s {d}/old "$(awk \'$1=="IdentityFile" {{print $2}}\' {Q(cfg)})" && exit 8; '
        f'sed "s|^  IdentityFile .*|  IdentityFile {d}/old|" {Q(cfg)} >{d}/old.cfg; '
        f'ssh -n -F {d}/old.cfg mac-local true'
    )
    output(stale)
    check(2, "fresh wrong key and stale key rejected", wrong_ok
          and stale.returncode == 255 and "Permission denied (publickey)" in stale.stderr)

    new_hand = hand_ready()
    brain_pid = event_rows(HOST + ["paseo plugin logs remote-hand --json"], "plugin-loaded")[-1]["pid"]
    pids = f"{new_hand['pid']},{new_hand['worker']}"
    rss(new_hand)
    tests = [
        (False, f"lsof -nP -a -p {pids} -iTCP -sTCP:LISTEN"),
        (False, f"lsof -nP -a -p {pids} -iUDP"),
        (True, f"lsof -nP -a -p {brain_pid} -iTCP -sTCP:LISTEN"),
        (True, f"lsof -nP -a -p {brain_pid} -iUDP"),
    ]
    listening = []
    for on_brain, cmd in tests:
        print(f"$ {'brain: ' if on_brain else ''}{cmd}", flush=True)
        res = remote(cmd) if on_brain else run(shlex.split(cmd))
        output(res)
        listening.append(res)
    brain_tcp = listening[2]
    check(11, "hand has no TCP/UDP listeners; brain listens on one loopback",
          all(r.returncode == 1 and not r.stdout and not r.stderr for r in (listening[0], listening[1], listening[3]))
          and brain_tcp.returncode == 0 and len(brain_tcp.stdout.splitlines()) == 2
          and f"TCP 127.0.0.1:{new_state['port']} (LISTEN)" in brain_tcp.stdout)
    # 旧密钥只用于这一项负测试，始终留在 brain 的私有临时目录内。
    remote(f"rm -f {d}/old {d}/wrong {d}/wrong.pub", check=True)
    raise SystemExit(bool(failed))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the remote-hand development checks from hand.")
    parser.add_argument("brain_ssh_host", help="SSH host or alias used to reach brain")
    parser.add_argument("--project-dir", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent,
                        help="directory on hand with a README.md to read over SSH (default: script directory)")
    parser.add_argument("--backpressure", type=pathlib.Path, metavar="TEST_DIR",
                        help="rerun only the backpressure check with an existing test directory")
    args = parser.parse_args()
    HOST = ["ssh", "-T", "-o", "BatchMode=yes", "--", args.brain_ssh_host]
    if args.backpressure:
        path = args.backpressure.resolve()
        if path.parent != BASE.resolve() or not path.name.startswith("test-"):
            sys.exit("Expected an existing test directory under /tmp/remote-hand-poc2")
        backpressure(hand_ready(), f"ssh -F {Q(brain_state()['config'])} mac-local", path)
        sys.exit(bool(failed))
    project = args.project_dir.resolve()
    if not (project / "README.md").is_file():
        parser.error("--project-dir must contain README.md")
    main(project)
