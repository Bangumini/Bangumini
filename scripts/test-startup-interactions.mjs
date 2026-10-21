import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStartupFixture } from "./fixtures/startup-interactions.mjs";

// 使用系统 Edge/Chrome，无需安装 Playwright；其他平台可设置 BANGUMINI_TEST_BROWSER。
const browser = [
  process.env.BANGUMINI_TEST_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(candidate => candidate && existsSync(candidate));
assert.ok(browser, "找不到测试浏览器，请将 BANGUMINI_TEST_BROWSER 设置为 Chromium/Edge 的可执行文件路径");
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "bangumini-startup-test-"));
const { server, url } = await startStartupFixture(root, path.join(profile, "vite"));

// CDP 管道只连接独立临时 profile，不暴露调试端口，也不操作用户浏览器。
// 使用真实时钟等待 React 提交，避免虚拟时钟提前结束或掩盖 transition 饥饿。
async function runBrowser(address) {
  const child = spawn(browser, [
    "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-extensions",
    `--user-data-dir=${profile}`, "about:blank",
  ], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(30000),
  });
  let nextId = 0;
  let buffer = "";
  let stderr = "";
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // 初始化协议时也可能退出，提前注册处理，最终仍由 await result 抛出错误。
  result.catch(() => {});
  const commands = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    commands.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  child.stdio[4].setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id) {
        const command = commands.get(message.id);
        commands.delete(message.id);
        if (message.error) command?.reject(new Error(message.error.message));
        else command?.resolve(message.result);
      } else if (message.method === "Runtime.bindingCalled" && message.params.name === "reportStartupTest") {
        resolveResult(JSON.parse(message.params.payload));
      } else if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params.exceptionDetails;
        rejectResult(new Error(detail.exception?.description ?? detail.text));
      }
    }
  });
  const fail = error => {
    rejectResult(error);
    for (const command of commands.values()) command.reject(error);
    commands.clear();
  };
  const closed = new Promise(resolve => {
    child.on("error", fail);
    child.on("close", code => {
      fail(new Error(`测试浏览器退出 ${code}: ${stderr}`));
      resolve();
    });
  });
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: "reportStartupTest" }, sessionId);
    await send("Page.navigate", { url: address }, sessionId);
    const outcome = await result;
    // 正常关闭确保 localStorage 落盘，下一进程验证的是重启而非内存复用。
    send("Browser.close").catch(() => {});
    await closed;
    return outcome;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

async function check(scenario, restart = false) {
  const result = await runBrowser(`${url}?scenario=${encodeURIComponent(scenario)}`);
  assert.equal(result.status, "passed", `${scenario}: ${JSON.stringify(result.detail)}`);
  assert.ok(result.detail.pendingRequests > 0, "必须在网络请求未完成时验证交互");
  assert.equal(result.detail.offlineVerified, true, "离线后也必须能切页、筛选并打开缓存详情");
  assert.equal(result.detail.restored, restart, "重启必须复用持久化数据，而不是 Query 内存");
  console.log(`PASS ${scenario}${restart ? " (restart)" : ""}: 筛选、Enter、返回、双击均不等待网络`);
}

try {
  const scenarios = process.argv.slice(2);
  if (scenarios.length === 0) scenarios.push("complete", "missing-airing", "missing-episodes", "stale-airing");
  for (const scenario of scenarios) {
    assert.ok(["complete", "missing-airing", "missing-episodes", "stale-airing"].includes(scenario), `未知场景: ${scenario}`);
    await check(scenario);
  }
  if (scenarios.includes("stale-airing")) await check("stale-airing", true);
} finally {
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
