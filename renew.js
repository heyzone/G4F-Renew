const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

/* ========================= CONFIG ========================= */

const RENEW_URL = process.env.RENEW_URL || "https://game4free.net/dkegdkegke-ege-ge-ge";

const SOCKS5_PROXY = process.env.SOCKS5_PROXY || "";
const GOST_PORT    = parseInt(process.env.GOST_PORT || "18080", 10);
const MAX_RETRY    = parseInt(process.env.MAX_RETRY || "2", 10);

const EXT_NOPECHA = path.resolve(__dirname, "extensions/nopecha/unpacked");
const SCREEN_DIR  = path.resolve(__dirname, "screenshots");

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

function parseProxy(raw) {
  const idx1 = raw.indexOf(":");
  const idx2 = raw.indexOf(":", idx1 + 1);
  const idx3 = raw.indexOf(":", idx2 + 1);

  if (idx3 !== -1) {
    const host = raw.slice(0, idx1);
    const port = raw.slice(idx1 + 1, idx2);
    const user = raw.slice(idx2 + 1, idx3);
    const pass = raw.slice(idx3 + 1);
    return { upstream: `socks5://${user}:${pass}@${host}:${port}` };
  } else if (idx2 !== -1) {
    return { upstream: `socks5://${raw}` };
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
      url.includes("doubleclick")       ||
      url.includes("googlesyndication") ||
      url.includes("adservice")         ||
      url.includes("adsystem")          ||
      url.includes("exoclick")          ||
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

/* ========================= EXTENSION CHECK ========================= */

async function waitExtensionLoaded(context) {
  console.log("🧩 等待 NopeCHA 扩展加载...");
  for (let i = 0; i < 40; i++) {
    const sw = context.serviceWorkers();
    const bg = context.backgroundPages();
    if (sw.length > 0 || bg.length > 0) {
      console.log("✅ NopeCHA 扩展已加载");
      return true;
    }
    await sleep(500);
  }
  console.log("⚠️ NopeCHA 扩展加载超时，继续尝试...");
  return false;
}

/* ========================= RECAPTCHA ========================= */

async function clickRecaptchaCheckbox(page) {
  console.log("☑️ 等待 reCAPTCHA iframe...");

  const iframeHandle = await page.waitForSelector(
    'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]',
    { timeout: 60000 }
  );

  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error("❌ 无法获取 reCAPTCHA iframe frame");

  const checkbox = await frame.waitForSelector("#recaptcha-anchor", { timeout: 30000 });

  console.log("🖱️ 点击 reCAPTCHA checkbox...");
  await checkbox.click({ force: true });
  await page.waitForTimeout(2000);
}

async function waitRecaptchaToken(page, timeoutMs = 300000) {
  console.log("⏳ 等待 NopeCHA 解题并生成 token（最多5分钟）...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const token = await frame.evaluate(() => {
          const t = document.querySelector("textarea[name='g-recaptcha-response']");
          return t?.value || "";
        });
        if (token && token.length > 30) {
          console.log("✅ reCAPTCHA token 已生成:", token.slice(0, 12) + "...");
          return token;
        }
      } catch {}
    }
    await page.waitForTimeout(2000);
  }

  throw new Error("❌ reCAPTCHA token 等待超时（5分钟）");
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
    // 检查 NopeCHA 扩展
    if (!fs.existsSync(path.join(EXT_NOPECHA, "manifest.json"))) {
      throw new Error("❌ NopeCHA manifest.json 不存在，请检查扩展路径");
    }

    const launchArgs = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--disable-extensions-except=${EXT_NOPECHA}`,
      `--load-extension=${EXT_NOPECHA}`,
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

    // 等待 NopeCHA 扩展加载
    await waitExtensionLoaded(context);

    page = await context.newPage();

    // ── 1. 打开续期页面 ──
    console.log("🌍 打开续期页面:", RENEW_URL);
    await page.goto(RENEW_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(3000);

    // ── 2. 等待 CF 盾通过 ──
    console.log("🛡️ 等待 Cloudflare 验证通过...");
    try {
      await page.waitForFunction(
        () => !document.title.includes("Just a moment"),
        { timeout: 60000, polling: 2000 }
      );
      console.log("✅ CF 验证已通过");
    } catch {
      console.log("⚠️ CF 验证等待超时，继续...");
    }

    await page.waitForTimeout(2000);
    await hideAdsByCSS(page);
    await snap(page, "page_loaded");

    // ── 3. 填入随机英文名 ──
    console.log("✏️ 查找并填写英文名输入框...");
    const inputSelectors = [
      "input[placeholder*='name' i]",
      "input[name='name']",
      "input[id='name']",
      "input[type='text']",
    ];

    let filled = false;
    for (const sel of inputSelectors) {
      try {
        const el = page.locator(sel).first();
        await el.waitFor({ state: "visible", timeout: 8000 });
        await el.click({ force: true });
        await el.fill("");
        await el.type(chosenName, { delay: 80 });
        console.log(`✅ 已填入名字 "${chosenName}"，selector: ${sel}`);
        filled = true;
        break;
      } catch {}
    }

    if (!filled) {
      await snap(page, "no_input_found");
      throw new Error("❌ 找不到英文名输入框");
    }

    await page.waitForTimeout(1000);

    // ── 4. 点击 reCAPTCHA checkbox（触发 NopeCHA 自动解题） ──
    await clickRecaptchaCheckbox(page);

    // ── 5. 等待 NopeCHA 自动生成 token ──
    await waitRecaptchaToken(page, 300000);

    await snap(page, "recaptcha_passed");

    // ── 6. 等待按钮从 "Complete Verification" 变为 "Renew" 后点击 ──
    console.log("⏳ 等待按钮变为 Renew...");
    const renewBtn = page.locator("button:has-text('Renew')");
    await renewBtn.waitFor({ state: "visible", timeout: 30000 });
    await renewBtn.click({ force: true });
    console.log("✅ 已点击 Renew 按钮");

    await page.waitForTimeout(3000);

    // ── 7. 等待成功文字 ──
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
      throw new Error("❌ 未检测到成功提示 'The server has been renewed'");
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
  let gost     = null;
  let proxyArg = "";

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
