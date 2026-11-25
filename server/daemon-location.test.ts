import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostTarget } from "@getpaseo/client/node";
import { localDaemonAddress, resolvePaseoHome } from "./daemon-location.mjs";

test("Windows Paseo home follows the daemon's profile and PASEO_HOME syntax", () => {
  const windows = { platform: "win32", userHome: "C:\\Users\\Test User", cwd: "D:\\Workspace" };
  assert.equal(resolvePaseoHome("~/.paseo", windows), "C:\\Users\\Test User\\.paseo");
  assert.equal(resolvePaseoHome("~/Paseo Test", windows), "C:\\Users\\Test User\\Paseo Test");
  assert.equal(resolvePaseoHome("E:/Isolated Paseo", windows), "E:\\Isolated Paseo");
  assert.equal(resolvePaseoHome(".\\paseo-test", windows), "D:\\Workspace\\paseo-test");
});

test("local daemon discovery maps wildcard TCP and rejects nonlocal pipes and hosts", () => {
  assert.equal(localDaemonAddress("0.0.0.0:6767", "win32"), "ws://127.0.0.1:6767/ws");
  assert.equal(localDaemonAddress("[::]:6767", "win32"), "ws://[::1]:6767/ws");
  const pipe = "\\\\.\\pipe\\Paseo Test";
  for (const value of [pipe, `pipe://${pipe}`, "\\\\.\\PIPE\\Paseo Test"]) {
    const target = parseHostTarget(localDaemonAddress(value, "win32"));
    assert.equal(target.kind, "socket");
    assert.equal(target.socketPath, pipe);
  }
  for (const value of ["pipe://\\\\remote\\pipe\\paseo", "127.0.0.2:6767", "ws://example.com/ws", "unix:///tmp/paseo.sock"]) {
    assert.throws(() => localDaemonAddress(value, "win32"), /local Paseo daemon/);
  }
});
