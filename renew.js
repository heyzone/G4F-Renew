const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= CONFIG ========================= */

const RENEW_URL = process.env.RENEW_URL || "https://game4free.net/dkegdkegke-ege-ge-ge";

// 格式: host:port:user:pass 或 host:port（无认证）
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || "";
const GOST_PORT    = parseInt(process.env.GOST_PORT || "18080", 10);
const MAX_RETRY    = parseInt(process.env.MAX_RETRY || "2", 10);

const SCREEN_DIR = path.resolve(__dirname, "screenshots");

const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/* ========================= RANDOM NAME ========================= */

const RANDOM_NAMES = [
  "James", "Oliver", "Ethan", "Lucas", "Mason",
  "Logan", "Aiden", "Jackson", "Sebastian", "Henry",
  "Alexander", "William", "Benjamin", "Elijah", "Daniel",
  "Matthew", "Joseph", "David", "Carter", "Owen",
  "Wyatt", "Jack", "Luke", "Jayden", "Dylan",
  "Grayson", "Levi", "Isaac", "Gabriel", "Nathan",
];

function randomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
}

/* ========================= UTILS ========================= */

function ensureScreenDir() {
  if (!fs.existsSync(SCREEN_DIR)) fs.mkdirSync(SCREEN_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function snap(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("📸 Screenshot:", file);
  } catch {}
}

async function dumpHTML(page, name) {
  try {
    ensureScreenDir();
    const file = path.join(SCREEN_DIR, `${Date.now()}_${name}.html`);
    fs.writeFileSync(file, await page.content(), "utf-8");
    console.log("🧾 HTML Dump:", file);
  } catch {}
}

/* ========================= GOST ========================= */

/**
 * 将带认证的 SOCKS5 代理通过 gost 转为本地 HTTP 代理
 * Chrome 的 --proxy-server 不支持带认证的 socks5，需要 gost 中转
 */
function parseProxy(raw) {
  const parts = raw.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return { upstream: `socks5://${user}:${pass}@${host}:${port}` };
  } else if (parts.length === 2) {
    const [host, port] = parts;
    return { upstream: `socks5://${host}:${port}` };
  }
  throw new Error(`SOCKS5_PROXY 格式错误: ${raw}`);
}

async function waitPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(1000);
    const ok = await new Promise((res) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("error",   () => res(false));
    });
    if (ok) return true;
  }
  return false;
}

async function startGost(socks5Raw, localPort) {
  const { upstream } = parseProxy(socks5Raw);
  const args = ["-L", `http://127.0.0.1:${localPort}`, "-F", upstream];
  console.log("🚀 启动 gost:", "gost", args.join(" "));

  const proc = spawn("gost", args, { stdio: "ignore", detached: true });

  if (!(await waitPort(localPort))) {
    throw new Error("❌ gost 本地端口未就绪");
  }
  console.log(`✅ gost 已就绪: 127.0.0.1:${localPort}`);
  return proc;
}

/* ========================= TELEGRAM ========================= */

async function sendTelegram(text) {
  try {
    if (!TELEGRAM_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await r.json();
    if (!data.ok) console.log("⚠️ Telegram send failed:", data);
    else console.log("📨 Telegram 通知已发送");
  } catch (e) {
    console.log("⚠️ Telegram error:", e?.message || e);
  }
}

/* ========================= AD BLOCK ========================= */

async function blockAds(context) {
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.includes("doubleclick")     ||
      url.includes("googlesyndication") ||
      url.includes("adservice")       ||
      url.includes("adsystem")        ||
      url.includes("exoclick")        ||
      url.includes("popads")
    ) {
      return route.abort();
    }
    route.continue();
  });
}

async function hideAdsByCSS(page) {
  await page.addStyleTag({
    content: `
      iframe[src*="doubleclick"],
      iframe[src*="googlesyndication"],
      iframe[src*="exoclick"],
      iframe[src*="popads"] { display:none !important; }
    `,
  });
}

async function removeOverlay(page) {
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      if (
        s.position === "fixed" &&
        parseInt(s.zIndex || "0") > 1000 &&
        el.offsetWidth  > 200 &&
        el.offsetHeight > 200 &&
        !el.innerText.includes("Renew")
      ) {
        el.remove();
      }
    });
    document.body.style.overflow = "auto";
  });
}

/* ========================= MAIN FLOW ========================= */

async function renewOnce(proxyServer) {
  ensureScreenDir();

  const chosenName = randomName();
  console.log(`📝 本次随机英文名: ${chosenName}`);

  let page    = null;
  let context = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pw-profile-"));

  try {
    const launchArgs = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ];

    if (proxyServer) {
      launchArgs.push(`--proxy-server=${proxyServer}`);
    }

    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      slowMo:   40,
      viewport: { width: 1280, height: 720 },
      args: launchArgs,
    });

    context.setDefaultTimeout(120000);
    await blockAds(context);

    page = await context.newPage();

    // ── 1. 打开续期页面 ──
    console.log("🌍 打开续期页面:", RENEW_URL);
    await page.goto(RENEW_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(3000);

    // ── 2. 等待 CF Turnstile 通过（最多 60 秒） ──
    console.log("🛡️ 等待 Cloudflare 验证通过...");
    try {
      // 等待 CF challenge 消失：body 不再是 challenge 页面
      await page.waitForFunction(
        () => !document.title.includes("Just a moment"),
        { timeout: 60000, polling: 2000 }
      );
      console.log("✅ CF 验证已通过");
    } catch {
      console.log("⚠️ CF 验证等待超时，继续尝试...");
    }

    await page.waitForTimeout(2000);
    await hideAdsByCSS(page);
    await removeOverlay(page);

    await snap(page, "page_loaded");

    // ── 3. 找到输入框并填入随机英文名 ──
    console.log("✏️ 查找并填写英文名输入框...");

    // 按优先级尝试多种 selector
    const inputSelectors = [
      "input[name='name']",
      "input[id='name']",
      "input[placeholder*='name' i]",
      "input[placeholder*='Name']",
      "input[type='text']",
      "input:not([type='hidden']):not([type='submit']):not([type='button'])",
    ];

    let filled = false;
    for (const sel of inputSelectors) {
      try {
        const el = page.locator(sel).first();
        await el.waitFor({ state: "visible", timeout: 8000 });
        await el.click({ force: true });
        await el.fill("");
        await el.type(chosenName, { delay: 80 });
        console.log(`✅ 已填入名字 "${chosenName}"，使用 selector: ${sel}`);
        filled = true;
        break;
      } catch {}
    }

    if (!filled) {
      await snap(page, "no_input_found");
      await dumpHTML(page, "no_input_found");
      throw new Error("❌ 找不到英文名输入框");
    }

    await page.waitForTimeout(1000);

    // ── 4. 点击 Renew 按钮 ──
    console.log("🟢 查找并点击 Renew 按钮...");

    const renewSelectors = [
      "button:has-text('Renew')",
      "input[type='submit'][value*='Renew' i]",
      "a:has-text('Renew')",
      "[class*='renew' i]",
      "button[type='submit']",
    ];

    let clicked = false;
    for (const sel of renewSelectors) {
      try {
        const btn = page.locator(sel).first();
        await btn.waitFor({ state: "visible", timeout: 8000 });
        await btn.click({ force: true });
        console.log(`✅ 已点击 Renew 按钮，selector: ${sel}`);
        clicked = true;
        break;
      } catch {}
    }

    if (!clicked) {
      await snap(page, "no_renew_btn");
      await dumpHTML(page, "no_renew_btn");
      throw new Error("❌ 找不到 Renew 按钮");
    }

    await page.waitForTimeout(3000);

    // ── 5. 点击后若再次出现 CF Turnstile（弹窗内），等待通过 ──
    try {
      await page.waitForFunction(
        () => !document.title.includes("Just a moment"),
        { timeout: 30000, polling: 2000 }
      );
    } catch {}

    await page.waitForTimeout(2000);

    // ── 6. 等待成功文字 ──
    console.log("⏳ 等待续期成功提示...");
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes("The server has been renewed"),
        { timeout: 60000, polling: 2000 }
      );
      console.log("🎉 检测到成功文字: The server has been renewed");
    } catch {
      await snap(page, "no_success_text");
      await dumpHTML(page, "no_success_text");
      throw new Error("❌ 未检测到成功提示文字 'The server has been renewed'");
    }

    await snap(page, "renew_success");
    console.log("✅ 续期成功！");

    return { ok: true, name: chosenName };

  } catch (e) {
    const msg = e?.message || String(e);
    console.error("💥 renewOnce error:", msg);
    if (page) {
      await snap(page, "error");
      await dumpHTML(page, "error");
    }
    return { ok: false, error: msg };

  } finally {
    try { if (context) await context.close(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

/* ========================= ENTRY ========================= */

(async () => {
  let gost      = null;
  let proxyArg  = "";

  // ── 启动 gost 代理转发 ──
  if (SOCKS5_PROXY) {
    try {
      gost     = await startGost(SOCKS5_PROXY, GOST_PORT);
      proxyArg = `http://127.0.0.1:${GOST_PORT}`;
    } catch (e) {
      console.log("⚠️ gost 启动失败，将不使用代理:", e?.message || e);
    }
  }

  let lastError     = "";
  let successResult = null;

  for (let i = 1; i <= MAX_RETRY; i++) {
    console.log(`\n🔄 尝试 ${i}/${MAX_RETRY}\n`);
    const result = await renewOnce(proxyArg);

    if (result.ok) {
      successResult = result;
      break;
    }

    lastError = result.error || "未知错误";
    console.log("⚠️ 本次失败，准备重试...");
    await sleep(5000);
  }

  // ── 停止 gost ──
  if (gost) {
    try { gost.kill("SIGTERM"); console.log("🛑 gost 已停止"); } catch {}
  }

  if (successResult) {
    await sendTelegram(
      `✅ <b>Game4Free Renew 成功</b>\n\n` +
      `🖥 <b>URL</b>: ${RENEW_URL}\n` +
      `👤 <b>输入名字</b>: ${successResult.name}\n` +
      `📋 <b>状态</b>: The server has been renewed.`
    );
    process.exit(0);
  }

  await sendTelegram(
    `❌ <b>Game4Free Renew 失败</b>\n\n<code>${lastError}</code>`
  );
  console.log("❌ 多次尝试均失败，退出 1");
  process.exit(1);
})();