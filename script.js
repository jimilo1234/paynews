/* ===== WorkBuddy 个人工作台 · 固定账号版 ===== */
const $ = (s) => document.querySelector(s);

/* ---------- 后端配置（Supabase REST API 直连，不依赖 supabase-js 库） ----------
   去掉 CDN 加载 supabase-js 的整套逻辑，直接用 fetch 调 PostgREST 接口。
   数据直读直写后端，不再有 localStorage 缓存 / 双写同步 / realtime 订阅。 */
const SUPABASE_URL = "https://dpvngdnbzadshfjudwae.supabase.co";
const API_KEY = "sb_publishable_2fUmpkPt-ah1qjDqBRB1GQ_W8KXUaJn";
const REST_BASE = SUPABASE_URL + "/rest/v1";
const TABLE = "workbench_data";
const API_HEADERS = {
  "apikey": API_KEY,
  "Authorization": "Bearer " + API_KEY,
  "Content-Type": "application/json",
};

/* 直接从后端读取整条记录 */
async function fetchState() {
  // 每次请求都强制 no-store，从后端取最新，杜绝浏览器缓存导致“不同浏览器不一样”
  const url = `${REST_BASE}/${TABLE}?user_id=eq.${userId}&limit=1`;
  const res = await fetch(url, { headers: API_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error("fetch " + res.status);
  const arr = await res.json();
  return arr && arr[0] ? arr[0] : null;
}

/* 直接写入后端（upsert：有则更新，无则插入） */
let notesHistoryColReady = true; // notes_history 列就绪标志；列未建好时降级跳过，防整行 400

async function saveState() {
  if (!dataConfirmed) {
    // 数据未从后端成功加载，禁止用可能的空状态覆盖云端，避免误清空
    console.warn("[workbench] 数据未从后端确认，跳过本次保存以防误清空");
    setStatus("保存跳过 · 数据未加载", "warn");
    return;
  }
  /* 乐观并发锁：写入前先核对云端更新时间。
     若云端已有比本地"载入时刻"更新的数据，说明云端被别的端更新过（或旧实例刚清空过），
     此时放弃本次保存以免用过期/空本地数据覆盖云端，并提示先刷新。这是防误清空的最后一道闸。 */
  try {
    const chk = await fetch(`${REST_BASE}/${TABLE}?user_id=eq.${userId}&select=updated_at&limit=1`, { headers: API_HEADERS, cache: "no-store" });
    if (chk.ok) {
      const carr = await chk.json();
      if (carr && carr[0]) {
        const cloudT = new Date(carr[0].updated_at).getTime();
        const localT = new Date(state.updated_at || 0).getTime();
        if (cloudT > localT) {
          console.warn("[workbench] 云端数据较新，放弃保存以免覆盖，请先刷新");
          setStatus("保存跳过 · 云端有更新，请刷新", "warn");
          return;
        }
      }
    }
  } catch (e) { /* 核对失败不阻断，交给下方正式写入的错误处理 */ }
  /* 防误清空·基线保护（前端兜底）：若三个核心字段同时为空——典型是逻辑异常导致 state 被 default 覆盖——
     而载入基线中本来有内容，则回退到基线值，绝不向云端提交空数据。真正的“旧链接清不掉”靠后端触发器。 */
  try {
    const base = window.__loadBase;
    if (base) {
      const nowEmpty = (!state.todos || !state.todos.length) && (!state.stickyNotes || !state.stickyNotes.length) && (!state.notes || !state.notes.trim());
      const baseHas = (base.todos && base.todos.length) || (base.stickyNotes && base.stickyNotes.length) || (base.notes && base.notes.trim());
      if (nowEmpty && baseHas) {
        console.warn("[workbench] 检测到三核心字段同时为空（异常），回退到载入基线，不提交空数据");
        setStatus("保存拦截 · 异常空数据已拦截", "warn");
        state.todos = base.todos || [];
        state.stickyNotes = base.stickyNotes || [];
        state.notes = base.notes || "";
      }
    }
  } catch (e2) {}
  state.updated_at = new Date().toISOString();
  const buildBody = (withHist) => ({
    user_id: userId, name: state.name, todos: state.todos,
    links: state.links, notes: state.notes, theme: state.theme,
    sticky_notes: state.stickyNotes, calendar_marks: state.calendarMarks,
    gh_arrival: state.ghArrival, updated_at: state.updated_at,
    homeModules: state.homeModules,
    ...(withHist ? { notes_history: state.notesHistory } : {}),
  });
  let res = await fetch(`${REST_BASE}/${TABLE}`, {
    method: "POST",
    headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
    body: JSON.stringify(buildBody(notesHistoryColReady)),
  });
  /* notes_history 列尚未创建（用户还没 Run 加列 SQL）时整行会 400；降级重试不带 notes_history，
     保证待办/笔记/便利贴等核心数据可正常保存，历史暂只存本机 localStorage，加列后自动恢复。 */
  if (!res.ok && notesHistoryColReady) {
    notesHistoryColReady = false;
    console.warn("[workbench] notes_history 列尚不存在，本次及之后保存暂不含历史；加列后将自动恢复");
    res = await fetch(`${REST_BASE}/${TABLE}`, {
      method: "POST",
      headers: Object.assign({}, API_HEADERS, { "Prefer": "resolution=merge-duplicates" }),
      body: JSON.stringify(buildBody(false)),
    });
  }
  if (!res.ok) throw new Error("save " + res.status);
  return true;
}

/* ---------- DeepSeek 代理（密钥不暴露在前端，走 Supabase Edge Function） ---------- */
const DEEPSEEK_PROXY = SUPABASE_URL + "/functions/v1/deepseek-proxy";
async function callDeepSeek(body) {
  return fetch(DEEPSEEK_PROXY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + API_KEY,
      "apikey": API_KEY,
    },
    body: JSON.stringify(body),
  });
}

const DEFAULT_LINKS = [
  { emoji: "📧", name: "邮箱", url: "https://mail.qq.com" },
  { emoji: "📊", name: "腾讯文档", url: "https://docs.qq.com" },
  { emoji: "💬", name: "企业微信", url: "https://work.weixin.qq.com" },
  { emoji: "🐙", name: "GitHub", url: "https://github.com" },
  { emoji: "🎯", name: "TAPD", url: "https://www.tapd.cn" },
  { emoji: "🔍", name: "百度", url: "https://www.baidu.com" },
];

function defaultState() {
  return { name: "吉米", todos: [], links: DEFAULT_LINKS.slice(), notes: "", theme: "dark", stickyNotes: [], calendarMarks: {}, ghArrival: "", updated_at: "1970-01-01T00:00:00Z", notesHistory: [], homeModules: defaultHomeModules() };
}

/* 首页模块注册表：新增首页模块只需在此加一项，即自动出现在「首页管理」配置中 */
const MODULE_REGISTRY = [
  { id: "hero",     label: "问候与时钟" },
  { id: "todo",     label: "每日待办" },
  { id: "links",    label: "快捷链接" },
  { id: "water",    label: "喝水提醒" },
  { id: "calendar", label: "日历" },
  { id: "fortune",  label: "每日运势" },
  { id: "focus",    label: "专注计时" },
  { id: "gh",       label: "GH时间" },
  { id: "notes",    label: "笔记 / 新闻" },
];
function defaultHomeModules() {
  return MODULE_REGISTRY.map((m) => ({ id: m.id, visible: true }));
}
/* 归一化已存配置：保留自定义顺序、丢弃未知模块、补齐新增模块（后续新增可配置） */
function normalizeHomeModules(arr) {
  const saved = (Array.isArray(arr) ? arr : []).filter((m) => m && m.id && MODULE_REGISTRY.some((r) => r.id === m.id));
  const savedIds = new Set(saved.map((m) => m.id));
  const added = MODULE_REGISTRY.filter((m) => !savedIds.has(m.id)).map((m) => ({ id: m.id, visible: true }));
  return saved.concat(added).map((m) => ({ id: m.id, visible: m.visible !== false }));
}

/* 后端列名是下划线（sticky_notes / calendar_marks / gh_arrival），前端 state 用驼峰。
   读取后必须做反向映射，否则便利贴/日历标记/GH到岗读不出来，且一旦触发保存会被空值覆盖清空。 */
function mapRow(row) {
  if (!row || typeof row !== "object") return row;
  const r = Object.assign({}, row);
  if (Array.isArray(row.sticky_notes)) r.stickyNotes = row.sticky_notes;
  else if (Array.isArray(row.stickyNotes)) r.stickyNotes = row.stickyNotes;
  else r.stickyNotes = [];
  if (row.calendar_marks && typeof row.calendar_marks === "object") r.calendarMarks = row.calendar_marks;
  else if (row.calendarMarks && typeof row.calendarMarks === "object") r.calendarMarks = row.calendarMarks;
  else r.calendarMarks = {};
  if (typeof row.gh_arrival === "string") r.ghArrival = row.gh_arrival;
  else if (typeof row.ghArrival === "string") r.ghArrival = row.ghArrival;
  else r.ghArrival = "";
  if (Array.isArray(row.notes_history)) r.notesHistory = row.notes_history; /* 列存在时后端为准（含空数组） */
  else if (Array.isArray(row.notesHistory)) r.notesHistory = row.notesHistory;
  else r.notesHistory = []; /* 列未建：PostgREST 不返回该键，回退空，由 loadData 合并本机 localStorage */
  /* 首页模块配置：读取后端数组（兼容 home_modules 命名），无则留空交给 applyState 归一 */
  if (Array.isArray(row.homeModules)) r.homeModules = row.homeModules;
  else if (Array.isArray(row.home_modules)) r.homeModules = row.home_modules;
  else r.homeModules = null;
  delete r.sticky_notes; delete r.calendar_marks; delete r.gh_arrival; delete r.notes_history;
  return r;
}

let state = defaultState();
let userId = null;
let saveTimer = null;
let editingLinks = false;
let dataConfirmed = false; // loadData 成功从后端确认过数据后才允许保存，防误清空

/* ---------- 工具 ---------- */
function setStatus(text, cls) {
  const el = $("#syncStatus");
  el.textContent = text;
  el.className = "sync-pill" + (cls ? " " + cls : "");
}
/* 防抖保存：500ms 内连续操作只写一次后端，直读直写无本地缓存 */
function scheduleSave(silent) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!silent) setStatus("保存中…", "syncing");
    try {
      await saveState();
      if (!silent) setStatus("已保存 ✓", "ok");
    } catch (e) {
      if (!silent) setStatus("保存失败 · 请检查网络", "err");
      console.warn("[workbench] 保存失败：", e);
    }
  }, 500);
}

/* 直接从后端读取整条记录，无本地缓存兜底 */
async function loadData() {
  setStatus("加载中…", "syncing");
  try {
    const data = await fetchState();
    const incoming = mapRow(data || {});
    // 智能比对：云端 updated_at 与本地一致则数据未变，仅同步内存、跳过重渲染（不打断正在编辑的笔记/待办）
    if (dataConfirmed && state.updated_at && incoming.updated_at && incoming.updated_at === state.updated_at) {
      state = Object.assign(defaultState(), incoming);
      try { window.__loadBase = { todos: state.todos || [], stickyNotes: state.stickyNotes || [], notes: state.notes || "" }; } catch (e2) {}
      setStatus(data ? "已就绪 ✓" : "首次使用 · 已就绪");
      return;
    }
    state = Object.assign(defaultState(), incoming);
    dataConfirmed = true; // 读取成功（无论有无记录），后续保存才被允许
    // 记录载入基线：供 saveState 的“防误清空基线保护”使用（前端兜底）
    try { window.__loadBase = { todos: state.todos || [], stickyNotes: state.stickyNotes || [], notes: state.notes || "" }; } catch (e2) {}
    applyState();
    /* 迁移/合并：把本机 localStorage 的历史并入内存（以后端为准、按 ts 去重），
       若有本机独占的历史则静默补传上云；列未建时静默失败、不影响使用，本机不丢。 */
    try {
      const lsHist = JSON.parse(localStorage.getItem(NOTES_HISTORY_KEY) || "[]");
      if (Array.isArray(lsHist) && lsHist.length) {
        const bd = Array.isArray(state.notesHistory) ? state.notesHistory : [];
        const seen = new Set(bd.map((x) => x && x.ts));
        const merged = bd.slice();
        for (const it of lsHist) { if (it && it.ts && !seen.has(it.ts)) { merged.push(it); seen.add(it.ts); } }
        merged.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
        while (merged.length > NOTES_MAX_HISTORY) merged.pop();
        state.notesHistory = merged;
        renderNotesHistory();
        if (merged.length > bd.length) scheduleSave(true); // 本机有未上云历史 → 静默补传
      }
    } catch (e2) {}
    setStatus(data ? "已就绪 ✓" : "首次使用 · 已就绪");
  } catch (e) {
    setStatus("读取失败 · 请检查网络", "err");
    dataConfirmed = false; // 读取异常：禁止保存，避免用空白覆盖云端
    applyState();
  }
}

/* ---------- 登录（固定授权账号） ---------- */
const VALID_ACCOUNT = "jimilo";
const VALID_PASS = "11223345";
const SESSION_KEY = "wb_logged_in";
function setMsg(t) { $("#setupMsg").textContent = t; }

let _homePollId = null;
function startHomePolling() {
  stopHomePolling();
  _homePollId = setInterval(() => { if (userId) loadData(); }, 30000); // 每30秒兜底拉取，数据未变则跳过重渲染
}
function stopHomePolling() {
  if (_homePollId) { clearInterval(_homePollId); _homePollId = null; }
}
async function enterWorkbench() {
  userId = "jimilo";
  localStorage.setItem(SESSION_KEY, "1");
  $("#setupModal").classList.add("hidden");
  loadData();
  startHomePolling();
}

function handleLogin() {
  const acc = $("#setupAccount").value.trim();
  const pass = $("#setupPass").value;
  if (!acc || !pass) { setMsg("请输入账号和密码"); return; }
  if (acc !== VALID_ACCOUNT || pass !== VALID_PASS) { setMsg("账号或密码错误"); return; }
  enterWorkbench();
}

function exitSpace() {
  userId = null; state = defaultState();
  stopHomePolling();
  localStorage.removeItem(SESSION_KEY);
  $("#setupModal").classList.remove("hidden");
  $("#setupAccount").value = ""; $("#setupPass").value = "";
  setMsg(""); setStatus("未登录", "");
}

/* ---------- 应用状态到界面 ---------- */
function applyState() {
  document.documentElement.setAttribute("data-theme", state.theme || "dark");
  $("#notes").value = state.notes || "";
  lastArchivedNotes = (state.notes || "").toString();
  renderNotesHistory();
  renderTodos();
  renderLinks();
  renderStickyBoard();
  marksData = state.calendarMarks || {};
  renderCalendar();
  if (state.ghArrival) { const g = $("#ghArrival"); if (g) { g.value = state.ghArrival; computeGH(); } }
  updateGreeting();
  // 首页模块显隐 + 顺序（可配置）
  state.homeModules = normalizeHomeModules(state.homeModules);
  applyHomeLayout();
  renderHomeManage();
}
function updateGreeting() {
  const now = new Date();
  const h = now.getHours();
  const greet = h < 6 ? "凌晨好" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const who = state.name && state.name !== "吉米" ? state.name : (state.name || "朋友");
  $("#greeting").textContent = `${greet}，${who} 👋`;
}

/* ---------- 统一心跳（合并所有每秒定时器，切到后台自动暂停省内存/省电） ---------- */
const tickHandlers = [];
let tickerId = null, tickCount = 0;
function onTick(fn, everySec) { tickHandlers.push({ fn, every: everySec || 1 }); }
function runTick() {
  tickCount++;
  for (const h of tickHandlers) {
    if (tickCount % h.every === 0) { try { h.fn(); } catch (e) {} }
  }
}
function startTicker() { if (!tickerId) tickerId = setInterval(runTick, 1000); }
function stopTicker() { if (tickerId) { clearInterval(tickerId); tickerId = null; } }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopTicker();
  else { runTick(); startTicker(); }   // 回到前台立刻补一次，界面不会停在旧时间
});

/* ---------- 时钟 + 日期 ---------- */
const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
function tick() {
  const now = new Date();
  $("#clock").innerHTML =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:<span class="sec">${String(now.getSeconds()).padStart(2, "0")}</span>`;
  $("#heroDate").textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
  if (state.name) updateGreeting();
}
tick();
onTick(tick);
startTicker();

/* ---------- 天气 ---------- */
const WMO = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️",
  55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "⛈️",
  71: "🌨️", 73: "🌨️", 75: "❄️", 80: "🌦️",
  81: "🌧️", 82: "⛈️", 95: "⛈️", 96: "⛈️", 99: "⛈️",
};
const WMO_TXT = {
  0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "小雨",
  55: "中雨", 61: "小雨", 63: "中雨", 65: "大雨",
  71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨",
  81: "阵雨", 82: "强阵雨", 95: "雷阵雨", 96: "雷阵雨", 99: "雷阵雨",
};
let weatherData = null;
function loadWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,weather_code`
    + `&hourly=temperature_2m,weather_code`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min`
    + `&timezone=auto&forecast_days=7`;
  fetch(url).then((r) => r.json()).then((d) => {
    weatherData = d;
    const t = Math.round(d.current.temperature_2m);
    const code = d.current.weather_code;
    $("#weather").innerHTML =
      `${WMO[code] || "🌡️"} ${t}°C <span class="weather-hint">▾</span>`;
    $("#weather").title = `${WMO_TXT[code] || "天气"} ${t}°C · 悬浮查看详情`;
  }).catch(() => { $("#weather").textContent = "🌤️ 天气暂不可用"; });
}

/* 悬浮弹出：今日逐小时 + 未来 7 天 */
const WK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function buildWeatherPop() {
  if (!weatherData) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const curHour = now.getHours();

  const hT = weatherData.hourly.time, hTmp = weatherData.hourly.temperature_2m, hCode = weatherData.hourly.weather_code;
  const hourly = [];
  for (let i = 0; i < hT.length; i++) {
    if (!hT[i].startsWith(todayKey)) continue;
    const hr = Number(hT[i].slice(11, 13));
    if (hr < curHour) continue;
    hourly.push(`<div class="wx-hour"><span class="wx-h">${hr}:00</span><span class="wx-ico">${WMO[hCode[i]] || "🌡️"}</span><span class="wx-t">${Math.round(hTmp[i])}°</span></div>`);
  }
  const dT = weatherData.daily.time, dCode = weatherData.daily.weather_code,
    dMax = weatherData.daily.temperature_2m_max, dMin = weatherData.daily.temperature_2m_min;
  const daily = [];
  for (let i = 0; i < dT.length; i++) {
    const dt = new Date(dT[i] + "T00:00");
    const label = i === 0 ? "今天" : i === 1 ? "明天" : WK[dt.getDay()];
    daily.push(`<div class="wx-day"><span class="wx-d">${label}</span><span class="wx-ico">${WMO[dCode[i]] || "🌡️"}</span><span class="wx-range"><span class="wx-lo">${Math.round(dMin[i])}°</span> ~ <span class="wx-hi">${Math.round(dMax[i])}°</span></span></div>`);
  }
  $("#weatherPop").innerHTML =
    `<div class="wx-sec-title">今日逐小时</div><div class="wx-hourly">${hourly.join("")}</div>` +
    `<div class="wx-sec-title">未来 7 天</div><div class="wx-daily">${daily.join("")}</div>`;
}
let wxPinned = false;
function showWx() { if (!weatherData) return; buildWeatherPop(); $("#weatherPop").classList.add("show"); }
function hideWx() { if (!wxPinned) $("#weatherPop").classList.remove("show"); }
const wxWrap = $(".weather-wrap");
wxWrap.addEventListener("mouseenter", showWx);
wxWrap.addEventListener("mouseleave", hideWx);
wxWrap.addEventListener("click", (e) => {
  e.stopPropagation();
  wxPinned = !wxPinned;
  if (wxPinned) showWx(); else $("#weatherPop").classList.remove("show");
});
document.addEventListener("click", () => { if (wxPinned) { wxPinned = false; $("#weatherPop").classList.remove("show"); } });
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (p) => loadWeather(p.coords.latitude, p.coords.longitude),
    () => loadWeather(39.9042, 116.4074), { timeout: 5000 });
} else loadWeather(39.9042, 116.4074);

/* ---------- 待办 ---------- */
const todoForm = $("#todoForm"), todoInput = $("#todoInput"), todoList = $("#todoList");
function renderTodos() {
  todoList.innerHTML = "";
  let left = 0;
  (state.todos || []).forEach((t, i) => {
    if (!t.done) left++;
    const li = document.createElement("li");
    li.className = "todo-item" + (t.done ? " done" : "");
    li.innerHTML = `<input type="checkbox" ${t.done ? "checked" : ""} data-i="${i}" />
      <span>${t.text.replace(/[<>&]/g, "")}</span>
      <button class="todo-del" data-i="${i}" title="删除">✕</button>`;
    todoList.appendChild(li);
  });
  $("#todoCount").textContent = `${state.todos.length ? left : 0}/${state.todos.length}`;
}
todoForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = todoInput.value.trim();
  if (!v) return;
  state.todos.push({ text: v, done: false });
  todoInput.value = ""; renderTodos(); scheduleSave();
});
todoList.addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  if (e.target.classList.contains("todo-del")) state.todos.splice(i, 1);
  else if (e.target.type === "checkbox") state.todos[i].done = e.target.checked;
  renderTodos(); scheduleSave();
});

/* ---------- 快捷链接 ---------- */
const linksGrid = $("#linksGrid");
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function renderLinks() {
  linksGrid.innerHTML = "";
  (state.links || []).forEach((l, i) => {
    const a = document.createElement("a");
    a.className = "link-item" + (editingLinks ? " editing" : "");
    if (editingLinks) {
      a.href = "javascript:void(0)";
      a.innerHTML = `<span class="emoji">${l.emoji}</span>
        <span class="link-edit-fields">
          <input class="link-edit-input" data-f="name" data-i="${i}" value="${esc(l.name)}" placeholder="名称" />
          <input class="link-edit-input link-edit-url" data-f="url" data-i="${i}" value="${esc(l.url)}" placeholder="地址 https://" />
        </span>
        <button class="link-del-edit" data-del="${i}" title="删除">✕</button>`;
    } else {
      a.href = l.url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `<span class="emoji">${l.emoji}</span><span>${esc(l.name)}</span>`;
    }
    linksGrid.appendChild(a);
  });
}
linksGrid.addEventListener("input", (e) => {
  const i = e.target.dataset.i, f = e.target.dataset.f;
  if (i === undefined || !f) return;
  state.links[i][f] = e.target.value; scheduleSave();
});
linksGrid.addEventListener("click", (e) => {
  const del = e.target.dataset.del;
  if (del === undefined) return;
  state.links.splice(Number(del), 1); renderLinks(); scheduleSave();
});
$("#editLinks").addEventListener("click", () => {
  editingLinks = !editingLinks;
  $("#editLinks").textContent = editingLinks ? "完成" : "编辑";
  $("#addLink").hidden = !editingLinks;
  renderLinks();
});
$("#addLink").addEventListener("click", () => {
  state.links.push({ emoji: "🔗", name: "新链接", url: "https://" });
  renderLinks(); scheduleSave();
});

/* ---------- 喝水提醒（仅本机存储，不写后端） ---------- */
const WATER_KEY = "wb_water_v1";
const WATER_TOTAL = 8;
const waterCupsEl = $("#waterCups");
const waterCountEl = $("#waterCount");
function todayKey() { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function loadWater() {
  try {
    const raw = localStorage.getItem(WATER_KEY);
    if (raw) { const o = JSON.parse(raw); if (o && o.date === todayKey() && Array.isArray(o.cups)) return o; }
  } catch (e) {}
  return { date: todayKey(), cups: new Array(WATER_TOTAL).fill(false) };
}
let waterState = loadWater();
function saveWater() { try { localStorage.setItem(WATER_KEY, JSON.stringify(waterState)); } catch (e) {} }
function renderWater() {
  if (!waterCupsEl) return;
  waterCupsEl.innerHTML = "";
  waterState.cups.forEach((filled, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cup" + (filled ? " filled" : "");
    b.setAttribute("aria-label", "第" + (i + 1) + "杯水");
    b.innerHTML = '<span class="cup-water"></span>';
    b.addEventListener("click", () => {
      waterState.cups[i] = !waterState.cups[i];
      saveWater(); renderWater();
    });
    waterCupsEl.appendChild(b);
  });
  if (waterCountEl) waterCountEl.textContent = waterState.cups.filter(Boolean).length + "/" + WATER_TOTAL;
}
function initWater() {
  if (waterState.date !== todayKey()) waterState = loadWater(); // 打开时已跨天则重置
  renderWater();
  onTick(() => { if (waterState.date !== todayKey()) { waterState = loadWater(); renderWater(); } }); // 每天0点自动重置
}

/* ---------- 每日运势（基于八字，调 DeepSeek） ---------- */
const BAZI = "癸酉 乙卯 丙申 丙申";
const FORTUNE_CACHE_KEY = "wb_fortune_v1";
const FORTUNE_HISTORY_KEY = "wb_fortune_history";
const FORTUNE_MAX_HISTORY = 30;

function fortuneNow() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const weekStr = WEEK[now.getDay()];
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { now, dateStr, weekStr, timeStr };
}
function loadFortuneHistory() {
  try { return JSON.parse(localStorage.getItem(FORTUNE_HISTORY_KEY) || "[]") || []; } catch (e) { return []; }
}
function pushFortuneHistory(item) {
  const list = loadFortuneHistory();
  list.unshift(item);
  while (list.length > FORTUNE_MAX_HISTORY) list.pop();
  try { localStorage.setItem(FORTUNE_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderFortuneHistory();
}
function renderFortuneHistory() {
  const box = $("#fortuneList");
  if (!box) return;
  const list = loadFortuneHistory();
  if (!list.length) { box.innerHTML = '<p class="fh-empty">暂无记录</p>'; return; }
  box.innerHTML = list.map((it) =>
    `<details class="fh-item">` +
      `<summary><span class="fh-time">${it.dateStr} ${it.weekStr} ${it.timeStr}</span></summary>` +
      `<p class="fh-text">${esc(it.text)}</p>` +
    `</details>`
  ).join("");
}
async function fetchFortune(opts) {
  opts = opts || {};
  const manual = !!opts.manual;
  const { now, dateStr, weekStr } = fortuneNow();
  if (!manual) {
    // 自动加载：同日本地缓存优先，避免重复消耗额度
    try {
      const cached = JSON.parse(localStorage.getItem(FORTUNE_CACHE_KEY) || "null");
      if (cached && cached.date === dateStr) { $("#quoteText").textContent = cached.text; return; }
    } catch (e) {}
  }
  const btn = $("#fortuneBtn");
  if (btn) { btn.disabled = true; btn.textContent = "推算中…"; }
  $("#quoteText").textContent = "正在为你推算今日运势…";
  const prompt =
    `你是一位专业且温和的命理师。用户的八字为「${BAZI}」。今天是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekStr}。\n` +
    `请基于该八字，用简体中文给出今天的每日运势，涵盖：整体、事业、财运、感情、健康五个方面；语气积极、有建设性、不说教。\n` +
    `不要使用任何 Markdown 标题或加粗，用换行分段，总字数控制在 200 字以内。`;
  try {
    const res = await callDeepSeek({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], stream: false });
    if (!res.ok) { $("#quoteText").textContent = "今日运势获取失败，请稍后重试。"; return; }
    const data = await res.json();
    const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "今日运势暂不可用。").trim();
    const { timeStr } = fortuneNow();
    const full = `【推算时间：${dateStr} ${weekStr} ${timeStr}】\n\n${text}`;
    $("#quoteText").textContent = full;
    try { localStorage.setItem(FORTUNE_CACHE_KEY, JSON.stringify({ date: dateStr, text: full })); } catch (e) {}
    pushFortuneHistory({ dateStr, weekStr, timeStr, text: full });
  } catch (e) {
    $("#quoteText").textContent = "网络异常，今日运势获取失败。";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "手动推算"; }
  }
}
const fortuneBtn = $("#fortuneBtn");
if (fortuneBtn) fortuneBtn.addEventListener("click", () => fetchFortune({ manual: true }));
const fortuneClear = $("#fortuneClear");
if (fortuneClear) fortuneClear.addEventListener("click", () => {
  try { localStorage.removeItem(FORTUNE_HISTORY_KEY); } catch (e) {}
  renderFortuneHistory();
});
renderFortuneHistory();
fetchFortune();

/* ---------- 专注计时 ---------- */
const WORK = 25 * 60, BREAK = 5 * 60;
let timerLeft = WORK, timerId = null, isWork = true;
const timerDisplay = $("#timerDisplay");
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function renderTimer() { timerDisplay.textContent = fmt(timerLeft); }
function timerStep() {
  timerLeft--;
  if (timerLeft < 0) {
    isWork = !isWork; timerLeft = isWork ? WORK : BREAK;
    $("#timerMode").textContent = isWork ? "工作 · 25 分钟" : "休息 · 5 分钟";
  }
  renderTimer();
}
$("#timerStart").addEventListener("click", (e) => {
  if (timerId) { clearInterval(timerId); timerId = null; e.target.textContent = "继续"; timerDisplay.classList.remove("run"); }
  else { timerId = setInterval(timerStep, 1000); e.target.textContent = "暂停"; timerDisplay.classList.add("run"); }
});
$("#timerReset").addEventListener("click", () => {
  clearInterval(timerId); timerId = null; isWork = true; timerLeft = WORK;
  $("#timerMode").textContent = "工作 · 25 分钟";
  $("#timerStart").textContent = "开始"; timerDisplay.classList.remove("run"); renderTimer();
});
renderTimer();

/* ---------- GH时间（到岗 / GH 计算） ---------- */
const GH_START = "09:00";          // 标准到岗
const GH_WORK_MINS = 8 * 60 + 30; // 工作时长 8h30m = 510 分钟（9:00 → 17:30）
function ghToMin(t) { const [h, m] = (t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function ghFmt(min) {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}
function computeGH() {
  const el = $("#ghArrival");
  if (!el) return;
  const arrival = el.value || GH_START;
  const am = ghToMin(arrival);
  const base = ghToMin(GH_START);          // 540
  const baseOff = base + GH_WORK_MINS;     // 1050 → 17:30
  let off, late = 0;
  if (am <= base) { off = baseOff; late = 0; }
  else { off = am + GH_WORK_MINS; late = am - base; }
  $("#ghOff").textContent = ghFmt(off);
  $("#ghNote").textContent = late > 0
    ? `比 ${GH_START} 晚到 ${late} 分钟，GH 顺延至 ${ghFmt(off)}`
    : `准时到岗，今日 ${ghFmt(off)} GH`;
  if (state.ghArrival !== arrival) { state.ghArrival = arrival; scheduleSave(); }
  updateGHCountdown();
}
/* 实时倒计时：距离 GH 还有多久 */
function updateGHCountdown() {
  const offEl = $("#ghOff"), cdEl = $("#ghCountdown");
  if (!offEl || !cdEl) return;
  const offStr = (offEl.textContent || "17:30").trim();
  const parts = offStr.split(":");
  if (parts.length < 2) return;
  const oh = Number(parts[0]), om = Number(parts[1]);
  if (isNaN(oh) || isNaN(om)) return;
  const now = new Date();
  const offDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), oh, om, 0, 0);
  let diff = Math.floor((offDate - now) / 1000); // 秒
  if (diff <= 0) {
    cdEl.textContent = "已到 GH 时间 ✓";
    cdEl.classList.add("gh-cd-reached");
    return;
  }
  cdEl.classList.remove("gh-cd-reached");
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const seg = [];
  if (h) seg.push(h + " 小时");
  if (m) seg.push(m + " 分钟");
  seg.push(s + " 秒");
  cdEl.textContent = "距离 GH 还有 " + seg.join(" ");
}
(function initGH() {
  if (state.ghArrival) { const el = $("#ghArrival"); if (el) el.value = state.ghArrival; }
  computeGH();
  onTick(updateGHCountdown);
  const el = $("#ghArrival");
  if (el) { el.addEventListener("input", computeGH); el.addEventListener("change", computeGH); }
})();

/* ---------- 日历（可翻年月 + 点击标记） ---------- */
let marksData = state.calendarMarks || {};
const todayDate = new Date();
let calY = todayDate.getFullYear();
let calM = todayDate.getMonth();

function renderCalendar() {
  $("#calHead").textContent = `${calY}年 ${calM + 1}月`;
  const first = new Date(calY, calM, 1).getDay();
  const days = new Date(calY, calM + 1, 0).getDate();
  const grid = $("#calGrid");
  grid.innerHTML = "";
  ["日", "一", "二", "三", "四", "五", "六"].forEach((w) => {
    const c = document.createElement("div"); c.className = "cal-cell weekday"; c.textContent = w; grid.appendChild(c);
  });
  for (let i = 0; i < first; i++) {
    const c = document.createElement("div"); c.className = "cal-cell muted"; grid.appendChild(c);
  }
  for (let d = 1; d <= days; d++) {
    const key = calY + "-" + (calM + 1) + "-" + d;
    const isToday = (calY === todayDate.getFullYear() && calM === todayDate.getMonth() && d === todayDate.getDate());
    const c = document.createElement("div");
    let cls = "cal-cell";
    if (isToday) cls += " today";
    if (marksData[key]) cls += " marked";
    c.className = cls;
    const txt = marksData[key] ? marksData[key].replace(/"/g, "&quot;").replace(/</g, "&lt;") : "";
    c.innerHTML = '<span class="cal-num">' + d + '</span>' + (marksData[key] ? '<span class="cal-dot" title="' + txt + '"></span>' : '');
    c.addEventListener("click", () => openMarkModal(key, calY, calM + 1, d));
    grid.appendChild(c);
  }
}
function stepMonth(n) {
  calM += n;
  if (calM < 0) { calM = 11; calY--; }
  if (calM > 11) { calM = 0; calY++; }
  renderCalendar();
}
$("#calPrev").addEventListener("click", () => stepMonth(-1));
$("#calNext").addEventListener("click", () => stepMonth(1));
$("#calPrevYear").addEventListener("click", () => { calY--; renderCalendar(); });
$("#calNextYear").addEventListener("click", () => { calY++; renderCalendar(); });

let markCurrentKey = null;
function openMarkModal(key, y, m, d) {
  markCurrentKey = key;
  $("#markDateLabel").textContent = `${y}年${m}月${d}日`;
  $("#markInput").value = marksData[key] || "";
  $("#markDelete").style.display = marksData[key] ? "inline-block" : "none";
  $("#markModal").hidden = false;
  setTimeout(() => $("#markInput").focus(), 50);
}
function closeMarkModal() { $("#markModal").hidden = true; markCurrentKey = null; }
$("#markClose").addEventListener("click", closeMarkModal);
$("#markModal").addEventListener("click", (e) => { if (e.target === $("#markModal")) closeMarkModal(); });
$("#markSave").addEventListener("click", () => {
  if (!markCurrentKey) return;
  const v = $("#markInput").value.trim();
  if (!state.calendarMarks) state.calendarMarks = {};
  if (v) state.calendarMarks[markCurrentKey] = v; else delete state.calendarMarks[markCurrentKey];
  marksData = state.calendarMarks;
  scheduleSave();
  renderCalendar();
  closeMarkModal();
});
$("#markDelete").addEventListener("click", () => {
  if (markCurrentKey) {
    if (!state.calendarMarks) state.calendarMarks = {};
    delete state.calendarMarks[markCurrentKey];
    marksData = state.calendarMarks;
    scheduleSave();
    renderCalendar(); closeMarkModal();
  }
});
renderCalendar();

/* ---------- 笔记 ---------- */
const notes = $("#notes");
notes.addEventListener("input", () => { state.notes = notes.value; scheduleSave(); scheduleNotesArchive(); });

/* ---------- 随手笔记 · 历史存档（每次修改自动留痕，类似每日运势历史） ---------- */
const NOTES_HISTORY_KEY = "wb_notes_history";
const NOTES_MAX_HISTORY = 50;
let lastArchivedNotes = (state.notes || "").toString();
let notesArchiveTimer = null;
function pushNotesHistory(text) {
  text = (text || "").toString();
  const list = state.notesHistory || (state.notesHistory = []);
  if (list.length && list[0].text === text) return; /* 与最近一条完全相同则跳过，避免连续重复存档 */
  const now = new Date();
  const item = {
    ts: now.toISOString(),
    dateStr: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
    weekStr: WEEK[now.getDay()],
    timeStr: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    text: text,
  };
  list.unshift(item);
  while (list.length > NOTES_MAX_HISTORY) list.pop();
  lastArchivedNotes = text;
  /* 本机先存一份兜底，保证即使后端列未建好也不丢；后端列就绪后 scheduleSave 会一并同步 */
  try { localStorage.setItem(NOTES_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderNotesHistory();
  scheduleSave(); /* 触发（防抖）保存，把历史一并写入后端，跨设备可回看 */
}
function renderNotesHistory() {
  const box = $("#notesHistoryList");
  if (!box) return;
  const list = state.notesHistory || [];
  if (!list.length) { box.innerHTML = '<p class="fh-empty">暂无记录</p>'; return; }
  box.innerHTML = list.map((it) =>
    `<details class="fh-item">` +
      `<summary><span class="fh-time">${it.dateStr} ${it.weekStr} ${it.timeStr}</span></summary>` +
      `<p class="fh-text">${esc(it.text)}</p>` +
    `</details>`
  ).join("");
}
function scheduleNotesArchive() {
  clearTimeout(notesArchiveTimer);
  if ((state.notes || "").toString() === lastArchivedNotes) return; /* 内容没变就不排程 */
  notesArchiveTimer = setTimeout(() => {
    if ((state.notes || "").toString() !== lastArchivedNotes) pushNotesHistory(state.notes);
  }, 1500);
}
const notesHistoryClear = $("#notesHistoryClear");
if (notesHistoryClear) notesHistoryClear.addEventListener("click", () => {
  state.notesHistory = [];
  try { localStorage.removeItem(NOTES_HISTORY_KEY); } catch (e) {}
  lastArchivedNotes = (state.notes || "").toString();
  renderNotesHistory();
  scheduleSave();
});

/* ---------- 主题 ---------- */
$("#themeToggle").addEventListener("click", () => {
  state.theme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  scheduleSave();
});

/* ---------- 刷新 / 退出 ---------- */
$("#syncNow").addEventListener("click", async () => {
  if (!userId) return;
  setStatus("刷新中…", "syncing");
  try {
    const data = await fetchState();
    if (data) { state = Object.assign(defaultState(), mapRow(data)); applyState(); }
    setStatus("已刷新 ✓", "ok");
  } catch (e) { setStatus("刷新失败", "err"); }
});
$("#exitSpace").addEventListener("click", exitSpace);

/* ---------- 登录层交互 ---------- */
$("#setupEnter").addEventListener("click", handleLogin);
$("#setupPass").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });
$("#setupAccount").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLogin(); });

/* ---------- 启动：恢复登录态 ---------- */
(async function boot() {
  initWater();
  if (localStorage.getItem(SESSION_KEY)) {
    enterWorkbench();
  } else {
    setStatus("未登录", "");
  }
})();

/* ---------- 侧边栏折叠 + 页面切换 ---------- */
const sidebar = $("#sidebar");
const sidebarToggle = $("#sidebarToggle");
const sidebarOverlay = $("#sidebarOverlay");
const appEl = document.querySelector(".app");
const isMobile = () => window.innerWidth < 860;

function updateToggleIcon() {
  // 移动端抽屉用 ✕ 表示“收起”，桌面端用 « / »
  sidebarToggle.textContent = isMobile()
    ? "✕"
    : (sidebar.classList.contains("collapsed") ? "»" : "«");
}
function syncSidebarUI() {
  const collapsed = sidebar.classList.contains("collapsed");
  // 移动端且展开时显示遮罩，点击遮罩即可收起
  if (isMobile() && !collapsed) sidebarOverlay.classList.add("show");
  else sidebarOverlay.classList.remove("show");
  updateToggleIcon();
}
if (localStorage.getItem("wb_sb_collapsed") === "1" || isMobile()) {
  sidebar.classList.add("collapsed");
  appEl.classList.add("nav-collapsed");
}
syncSidebarUI();
sidebarToggle.addEventListener("click", () => {
  const c = sidebar.classList.toggle("collapsed");
  appEl.classList.toggle("nav-collapsed", c);
  localStorage.setItem("wb_sb_collapsed", c ? "1" : "0");
  syncSidebarUI();
});
const menuFab = $("#menuFab");
menuFab.addEventListener("click", () => {
  sidebar.classList.remove("collapsed");
  appEl.classList.remove("nav-collapsed");
  localStorage.setItem("wb_sb_collapsed", "0");
  syncSidebarUI();
});
// 移动端：点击遮罩收起抽屉
sidebarOverlay.addEventListener("click", () => {
  sidebar.classList.add("collapsed");
  appEl.classList.add("nav-collapsed");
  localStorage.setItem("wb_sb_collapsed", "1");
  syncSidebarUI();
});
// 跨断点（旋转屏幕 / 缩放窗口）时刷新图标与遮罩
window.addEventListener("resize", syncSidebarUI);
/* ---------- 侧边栏：一级菜单折叠 + 页面切换 ---------- */
// 一级菜单（如 AI）点击展开/收起其子项
document.querySelectorAll(".nav-parent").forEach((btn) => {
  btn.addEventListener("click", () => {
    const sub = document.getElementById("sub" + btn.dataset.toggle);
    const open = sub.classList.toggle("open");
    btn.classList.toggle("open", open);
  });
});
/* ---------- 内嵌页面按需加载 / 后台自动释放（省内存核心） ----------
   所有外部站点 iframe 在 HTML 里写成 data-src，不随首屏加载。
   只有真正切到该页面时才挂载；离开超过 IDLE 分钟后自动卸载（about:blank）释放内存，
   下次再进入自动重新加载，用户无感。 */
const FRAME_IDLE_MS = 3 * 60 * 1000; // 离开 3 分钟后释放后台页面
const releaseTimers = new Map();
function frameList(root) { return root ? root.querySelectorAll("iframe[data-src]") : []; }
function mountFrames(root) {
  frameList(root).forEach((f) => {
    const want = f.dataset.src;
    if (want && f.getAttribute("src") !== want) f.setAttribute("src", want);
  });
  updateMemPill();
}
function releaseFrames(root) {
  let freed = 0;
  frameList(root).forEach((f) => {
    const cur = f.getAttribute("src");
    if (cur && cur !== "about:blank") { f.setAttribute("src", "about:blank"); freed++; }
  });
  if (freed) updateMemPill();
  return freed;
}
function loadedFrameCount() {
  let n = 0;
  document.querySelectorAll("iframe[data-src]").forEach((f) => {
    const s = f.getAttribute("src");
    if (s && s !== "about:blank") n++;
  });
  return n;
}
function updateMemPill() {
  const el = $("#memPill");
  if (!el) return;
  const n = loadedFrameCount();
  el.textContent = "🧠 " + n;
  el.classList.toggle("mem-hot", n >= 3);
  el.title = n ? `已加载 ${n} 个内嵌页面 · 点击立即释放后台页面` : "无内嵌页面占用内存";
}
function scheduleRelease(pageEl) {
  if (!pageEl || !frameList(pageEl).length) return;
  clearTimeout(releaseTimers.get(pageEl.id));
  releaseTimers.set(pageEl.id, setTimeout(() => releaseFrames(pageEl), FRAME_IDLE_MS));
}
/* 手动一键释放：卸载所有非当前页面的内嵌页 */
function releaseBackground() {
  let freed = 0;
  document.querySelectorAll(".page").forEach((p) => {
    if (p.classList.contains("hidden")) freed += releaseFrames(p);
  });
  const news = $("#newsPanel");
  if (news && news.classList.contains("hidden")) freed += releaseFrames(news);
  return freed;
}

// 页面切换（首页/英语/豆姐/DP 等带 data-page 的项）
const allPages = document.querySelectorAll(".page");
document.querySelectorAll(".nav-item[data-page]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const page = btn.dataset.page;
    const targetId = "page" + page.charAt(0).toUpperCase() + page.slice(1);
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    allPages.forEach((p) => {
      const isTarget = p.id === targetId;
      p.classList.toggle("hidden", !isTarget);
      if (isTarget) {
        clearTimeout(releaseTimers.get(p.id));
        mountFrames(p);           // 进入才加载
        if (targetId === "pageHome") loadData(); // 切回首页即拉取最新（数据未变则跳过重渲染）
      } else {
        scheduleRelease(p);       // 离开延时释放
      }
    });
  });
});
/* ---------- 首页模块显隐 + 顺序（注册表驱动，可配置） ---------- */
function applyHomeLayout() {
  const grid = document.querySelector("#pageHome .grid");
  if (!grid) return;
  const order = Array.isArray(state.homeModules) ? state.homeModules : defaultHomeModules();
  const vis = {};
  order.forEach((m) => { if (m && m.id) vis[m.id] = m.visible !== false; });
  const cards = {};
  grid.querySelectorAll(":scope > [data-module]").forEach((el) => { cards[el.dataset.module] = el; });
  // 按配置顺序重排（appendChild 自动移到末尾），并应用显隐
  order.forEach((m) => {
    const el = cards[m.id];
    if (!el) return;
    el.style.display = vis[m.id] ? "" : "none";
    grid.appendChild(el);
  });
  // 兜底：配置里没有的卡片（理论上不会）默认显示并追加到末尾
  grid.querySelectorAll(":scope > [data-module]").forEach((el) => {
    if (!order.find((m) => m.id === el.dataset.module)) el.style.display = "";
  });
}

/* 首页管理页：可拖拽模块列表 */
function renderHomeManage() {
  const list = $("#moduleList");
  if (!list) return;
  const cfg = Array.isArray(state.homeModules) ? state.homeModules : defaultHomeModules();
  list.innerHTML = "";
  cfg.forEach((m) => {
    const meta = MODULE_REGISTRY.find((r) => r.id === m.id) || { label: m.id };
    const li = document.createElement("li");
    li.className = "module-item";
    li.draggable = true;
    li.dataset.id = m.id;
    li.innerHTML =
      '<span class="mi-handle" title="拖拽排序">⠿</span>' +
      '<span class="mi-label">' + meta.label + '</span>' +
      '<label class="mi-switch"><input type="checkbox" class="mi-toggle"' + (m.visible !== false ? " checked" : "") + ' /><span class="mi-slider"></span></label>';
    list.appendChild(li);
  });
}
// 显隐开关即时写入 state（不立即保存，等「保存」按钮）
$("#moduleList").addEventListener("change", (e) => {
  if (!e.target.classList.contains("mi-toggle")) return;
  const li = e.target.closest(".module-item");
  const id = li && li.dataset.id;
  const item = (state.homeModules || []).find((m) => m.id === id);
  if (item) item.visible = e.target.checked;
});
// 拖拽排序（原生 HTML5 DnD，无第三方依赖）
(function initHomeManageDnD() {
  const list = $("#moduleList");
  if (!list) return;
  let dragEl = null;
  list.addEventListener("dragstart", (e) => {
    const li = e.target.closest(".module-item");
    if (!li) return;
    dragEl = li; li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const li = e.target.closest(".module-item");
    if (!li || li === dragEl) return;
    const rect = li.getBoundingClientRect();
    const after = (e.clientY - rect.top) / rect.height > 0.5;
    if (dragEl) list.insertBefore(dragEl, after ? li.nextSibling : li);
  });
  list.addEventListener("dragend", () => {
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  });
})();
// 保存：按列表当前顺序 + 开关写入 state 并持久化，首页立即生效
function saveHomeManage() {
  const list = $("#moduleList");
  if (!list) return;
  const next = [];
  list.querySelectorAll(".module-item").forEach((li) => {
    next.push({ id: li.dataset.id, visible: li.querySelector(".mi-toggle").checked });
  });
  state.homeModules = next;
  applyHomeLayout();
  scheduleSave();
  setStatus("布局已保存 ✓", "ok");
}
const hmSave = $("#hmSave"); if (hmSave) hmSave.addEventListener("click", saveHomeManage);
const hmReset = $("#hmReset"); if (hmReset) hmReset.addEventListener("click", () => {
  state.homeModules = defaultHomeModules();
  renderHomeManage(); applyHomeLayout(); scheduleSave();
  setStatus("已恢复默认 ✓", "ok");
});

/* 整个标签页切走超过 5 分钟：释放所有后台内嵌页，回来时当前页自动重新加载 */
let hiddenReleaseTimer = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(hiddenReleaseTimer);
    hiddenReleaseTimer = setTimeout(releaseBackground, 5 * 60 * 1000);
  } else {
    clearTimeout(hiddenReleaseTimer);
    const cur = document.querySelector(".page:not(.hidden)");
    if (cur) mountFrames(cur);   // 回到前台，当前页若被释放则自动补回
    updateMemPill();
  }
});

$("#memPill") && $("#memPill").addEventListener("click", () => {
  const n = releaseBackground();
  const el = $("#memPill");
  if (el) {
    const old = el.textContent;
    el.textContent = n ? "已释放 " + n + " 个" : "无可释放";
    setTimeout(() => updateMemPill(), 1400);
  }
});
updateMemPill();

/* ---------- 笔记 / 新闻 切换 ---------- */
let panelMode = "note";
let newsReleaseTimer = null;
function setPanel(mode) {
  panelMode = mode;
  const isNote = mode === "note";
  $("#notePanel").classList.toggle("hidden", !isNote);
  $("#newsPanel").classList.toggle("hidden", isNote);
  $("#panelTitle").textContent = isNote ? "📝 随手笔记" : "📰 新闻";
  $("#panelToggle").textContent = isNote ? "切换到新闻 ↻" : "切换到笔记 ↻";
  $("#newsOpen").hidden = isNote;
  // 新闻 iframe 同样按需加载 / 离开后释放
  const news = $("#newsPanel");
  if (news) {
    clearTimeout(newsReleaseTimer);
    if (isNote) newsReleaseTimer = setTimeout(() => releaseFrames(news), FRAME_IDLE_MS);
    else mountFrames(news);
  }
}
setPanel("note");
$("#panelToggle").addEventListener("click", () => setPanel(panelMode === "note" ? "news" : "note"));

/* ---------- 整点/十分 自动切回笔记 ---------- */
const SNAP_MINS = [0, 10, 20, 30, 40, 50];
let lastSnap = -1;
onTick(() => {
  const m = new Date().getMinutes();
  if (SNAP_MINS.includes(m) && m !== lastSnap) {
    lastSnap = m;
    if (panelMode !== "note") setPanel("note");
  }
}, 15);


/* ---------- 便利贴（可拖动 / 增删改） ---------- */
const STICKY_COLORS = ["#ffe9a8", "#c9e7ff", "#d6f5d6", "#ffd6e7", "#e3d6ff"];
let stickyColorIdx = 0;
const stickyBoard = $("#stickyBoard");
function findSticky(id) { return (state.stickyNotes || []).find((x) => x.id === id); }
function renderStickyBoard() {
  if (!stickyBoard) return;
  stickyBoard.innerHTML = "";
  (state.stickyNotes || []).forEach((n) => {
    const el = document.createElement("div");
    el.className = "sticky";
    el.dataset.id = n.id;
    el.style.left = (typeof n.x === "number" ? n.x : 20) + "px";
    el.style.top = (typeof n.y === "number" ? n.y : 20) + "px";
    el.style.background = n.color || STICKY_COLORS[0];
    el.innerHTML =
      '<div class="sticky-head">' +
        '<span class="sticky-grip" title="按住拖动">⠿</span>' +
        '<input class="sticky-title" value="' + esc(n.title || "") + '" placeholder="标题" />' +
        '<button class="sticky-copy" title="一键复制内容">📋</button>' +
        '<button class="sticky-del" title="删除">×</button>' +
      '</div>' +
      '<textarea class="sticky-body" placeholder="写点什么…">' + esc(n.body || "") + '</textarea>';
    el.querySelector(".sticky-title").addEventListener("input", (e) => {
      const item = findSticky(n.id); if (item) { item.title = e.target.value; scheduleSave(); }
    });
    el.querySelector(".sticky-body").addEventListener("input", (e) => {
      const item = findSticky(n.id); if (item) { item.body = e.target.value; scheduleSave(); }
    });
    el.querySelector(".sticky-copy").addEventListener("click", () => copySticky(n.id, el.querySelector(".sticky-copy")));
    el.querySelector(".sticky-del").addEventListener("click", () => {
      state.stickyNotes = (state.stickyNotes || []).filter((x) => x.id !== n.id);
      renderStickyBoard(); scheduleSave();
    });
    enableStickyDrag(el, n);
    stickyBoard.appendChild(el);
  });
}
function copySticky(id, btn) {
  const item = findSticky(id);
  if (!item) return;
  const text = [item.title, item.body].map((s) => String(s || "")).join("\n").replace(/\n{2,}/g, "\n").trim();
  const flash = (ok, msg) => {
    if (!btn) return;
    const oldTitle = btn.getAttribute("title");
    const oldHtml = btn.innerHTML;
    if (ok) { btn.classList.add("copied"); btn.innerHTML = "✓"; btn.setAttribute("title", msg || "已复制"); }
    else { btn.innerHTML = "✕"; btn.setAttribute("title", msg || "复制失败"); }
    setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = oldHtml; btn.setAttribute("title", oldTitle); }, 1300);
  };
  if (!text) { flash(false, "没有内容可复制"); return; }
  const done = () => flash(true, "已复制");
  const fail = () => flash(false, "复制失败");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
  } else {
    legacyCopy(text, done, fail);
  }
}
function legacyCopy(text, done, fail) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    ok ? done() : fail();
  } catch (e) { fail(); }
}
let stickyZ = 10;
function enableStickyDrag(el, n) {
  let startX = 0, startY = 0, origX = 0, origY = 0, dragging = false, pid = null, moved = false;
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    const t = e.target;
    // 手柄始终可拖；输入框 / 文本域 / 按钮内不触发拖动（保证正常编辑与删除）
    if (!(t.classList && t.classList.contains("sticky-grip")) &&
        t.closest && t.closest("input, textarea, button")) return;
    dragging = true; moved = false; pid = e.pointerId;
    el.classList.add("dragging");
    el.style.zIndex = ++stickyZ;
    startX = e.clientX; startY = e.clientY;
    origX = el.offsetLeft; origY = el.offsetTop;   // 以真实渲染位置为基准，避免 state 缺 x/y 时跳位
    try { el.setPointerCapture(pid); } catch (err) {}
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    let nx = origX + (e.clientX - startX);
    let ny = origY + (e.clientY - startY);
    if (Math.abs(nx - origX) > 2 || Math.abs(ny - origY) > 2) moved = true;
    const board = stickyBoard;
    if (board && board.clientWidth) {
      const maxX = Math.max(0, board.clientWidth - el.offsetWidth - 4);
      const maxY = Math.max(0, Math.max(board.clientHeight, board.scrollHeight) - el.offsetHeight - 4);
      nx = Math.min(Math.max(0, nx), maxX);
      ny = Math.min(Math.max(0, ny), maxY);
    } else {
      nx = Math.max(0, nx); ny = Math.max(0, ny);
    }
    el.style.left = nx + "px"; el.style.top = ny + "px";
    const it = findSticky(n.id); if (it) { it.x = nx; it.y = ny; }
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false; el.classList.remove("dragging");
    try { el.releasePointerCapture(pid); } catch (err) {}
    pid = null;
    if (moved) scheduleSave();
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("lostpointercapture", onUp);
}
function addSticky() {
  state.stickyNotes = state.stickyNotes || [];
  const color = STICKY_COLORS[stickyColorIdx % STICKY_COLORS.length];
  stickyColorIdx++;
  const offset = state.stickyNotes.length * 26;
  state.stickyNotes.push({
    id: "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    title: "新便利贴", body: "", x: 24 + (offset % 320), y: 24 + (offset % 220), color,
  });
  renderStickyBoard(); scheduleSave();
}
function initSticky() {
  const btn = $("#addSticky");
  if (btn) btn.addEventListener("click", addSticky);
}
initSticky();

/* ---------- 数据导出 / 导入（防丢 + 自助恢复） ---------- */
function downloadJSON(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function currentSnapshot() {
  return {
    user_id: userId || "jimilo",
    name: state.name,
    todos: state.todos,
    links: state.links,
    notes: state.notes,
    theme: state.theme,
    stickyNotes: state.stickyNotes,
    calendarMarks: state.calendarMarks,
    ghArrival: state.ghArrival,
  };
}
const exBtn = $("#exportData");
if (exBtn) exBtn.addEventListener("click", async () => {
  const json = JSON.stringify(currentSnapshot(), null, 2);
  let copied = false;
  try { await navigator.clipboard.writeText(json); copied = true; } catch (e) {}
  downloadJSON("workbench-backup.json", json);
  setStatus(copied ? "已导出并复制到剪贴板 ✓" : "已导出为文件 ✓", "ok");
  setTimeout(() => { if ($("#syncStatus").textContent.indexOf("导出") >= 0) setStatus("已保存 ✓", "ok"); }, 2500);
});
const imBtn = $("#importData");
if (imBtn) imBtn.addEventListener("click", () => { const m = $("#importModal"); if (m) m.hidden = false; });
function closeImport() { const m = $("#importModal"); if (m) m.hidden = true; }
const icBtn = $("#importClose"); if (icBtn) icBtn.addEventListener("click", closeImport);
const icaBtn = $("#importCancel"); if (icaBtn) icaBtn.addEventListener("click", closeImport);
const ifBtn = $("#importConfirm");
if (ifBtn) ifBtn.addEventListener("click", async () => {
  const raw = $("#importInput").value.trim();
  const stEl = $("#importStatus");
  if (!raw) { stEl.textContent = "请先粘贴 JSON"; stEl.className = "import-status err"; return; }
  const j = (v, d) => { if (v == null) return d; try { return JSON.parse(v); } catch (e) { return v || d; } };
  let parsed;
  try {
    const o = JSON.parse(raw);
    parsed = {
      name: state.name,
      todos: o.todos || j(o.wb_todos, []) || [],
      links: o.links || j(o.wb_links, []) || [],
      notes: o.notes != null ? o.notes : (o.wb_notes || ""),
      theme: o.theme || o.wb_theme || state.theme,
      stickyNotes: o.stickyNotes || j(o.wb_sticky, []) || [],
      calendarMarks: o.calendarMarks || j(o.wb_marks, {}) || {},
      ghArrival: o.ghArrival || o.wb_gh || "",
    };
  } catch (e) {
    stEl.textContent = "JSON 解析失败：" + e.message; stEl.className = "import-status err"; return;
  }
  if (!Array.isArray(parsed.todos)) parsed.todos = [];
  if (!Array.isArray(parsed.links)) parsed.links = [];
  if (!Array.isArray(parsed.stickyNotes)) parsed.stickyNotes = [];
  if (!parsed.calendarMarks || typeof parsed.calendarMarks !== "object") parsed.calendarMarks = {};
  if (typeof parsed.notes !== "string") parsed.notes = String(parsed.notes || "");
  Object.assign(state, parsed);
  await saveState();   // 立即写入后端
  applyState();
  stEl.textContent = "✅ 已导入并写入后端"; stEl.className = "import-status ok";
  setTimeout(closeImport, 1000);
});

