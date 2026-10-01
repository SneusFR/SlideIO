// Minimal Chrome DevTools Protocol driver (headless Chrome + the `ws` package
// already installed in backend/node_modules). Used by weapons-capture.mjs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(new URL("../../backend/package.json", import.meta.url));
const WebSocket = require("ws");

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

const getJson = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });

export async function launch({ width, height, url, port = 9333 }) {
  if (!CHROME) throw new Error("no Chrome / Edge found");
  const dir = mkdtempSync(join(tmpdir(), "hudcdp-"));
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`, "--hide-scrollbars", "--no-first-run",
    "--force-device-scale-factor=1", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
    "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "about:blank",
  ], { stdio: "ignore" });
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await getJson(`http://127.0.0.1:${port}/json`); if (targets.length) break; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) logs.push(msg.params.type + " " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 2500));
  return {
    logs,
    send,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(clip, scale = 1) {
      const r = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale } });
      return Buffer.from(r.data, "base64");
    },
    close() { try { ws.close(); } catch { /* ignore */ } proc.kill(); },
  };
}
