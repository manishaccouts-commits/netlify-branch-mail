// Branch Mail portal backend for Netlify Functions. No npm packages: Node built-ins and fetch only.
const crypto = require("crypto");

const CFG = {
  sheetId: process.env.SHEET_ID || "",
  saJson: process.env.GOOGLE_SA_JSON || "",
  brevoKey: process.env.BREVO_API_KEY || "",
  senderEmail: process.env.SENDER_EMAIL || "",
  senderName: process.env.SENDER_NAME || "AASTHA Branch Mail",
  foreclosureTo: (process.env.FORECLOSURE_TO || "").split(",").map(s => s.trim()).filter(Boolean),
  mailLive: process.env.MAIL_LIVE === "1",
  testTo: process.env.MAIL_TEST_TO || "",
  secret: process.env.SESSION_SECRET || "",
};

// Paste the exact wording from Branch Mail v3.2 over the PASTE lines. Sending is blocked while PASTE remains.
const SUBJECT_TEMPLATE = "PASTE-SUBJECT-FROM-v3.2 HP NO {loan}";
const BODY_TEMPLATE = `PASTE-OPENING-LINE-FROM-v3.2

HP NO: {loan}
Customer Name: {customer}
Closing Amount: {amount}

PASTE-EOD-VALIDITY-LINE
PASTE-INTERNAL-ONLY-NOTE
`;

const QUEUE = "BM_QUEUE";
const USERS = "BM_USERS";
const HEADERS = ["REQ_ID", "SUBMITTED_AT", "SUBMITTED_BY", "LOAN_NO", "CUSTOMER", "BRANCH", "SETTLEMENT",
  "CALLER_CODE", "CALLER_NAME", "CC_MAIL", "STATUS", "LEADER_BY", "LEADER_AT", "SENT_AT", "SENT_BY", "NOTE"];
const OPEN = ["PENDING_LEADER", "APPROVED", "SENDING", "SENT"];
const IST_OFFSET = 330 * 60000;

const json = (status, body, headers = {}) => ({
  statusCode: status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const nowIST = () => new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit",
  month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const b64u = s => Buffer.from(s).toString("base64url");

// ---- login and session (signed cookie) ----
function checkPassword(pw, stored) {
  const [salt, digest] = String(stored || "").split("$");
  if (!salt || !digest) return false;
  const test = crypto.pbkdf2Sync(pw, Buffer.from(salt, "hex"), 200000, 32, "sha256");
  const want = Buffer.from(digest, "hex");
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}
const sign = payload => crypto.createHmac("sha256", CFG.secret).update(payload).digest("base64url");
function makeCookie(user) {
  const payload = b64u(JSON.stringify({ ...user, exp: Date.now() + 12 * 3600 * 1000 }));
  return `bm_session=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}
function readUser(event) {
  try {
    const cookie = event.headers.cookie || event.headers.Cookie || "";
    const m = /(?:^|;\s*)bm_session=([^;]+)/.exec(cookie);
    if (!m) return null;
    const [payload, sig] = m[1].split(".");
    const a = Buffer.from(sign(payload)), b = Buffer.from(sig || "");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const u = JSON.parse(Buffer.from(payload, "base64url").toString());
    return u.exp > Date.now() ? u : null;
  } catch {
    return null;
  }
}

// ---- Google Sheets over REST, signed with the service account key ----
let tokenCache = { token: "", exp: 0 };
async function googleToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const sa = JSON.parse(CFG.saJson);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64u(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = crypto.sign("sha256", Buffer.from(unsigned), sa.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("Google sign-in failed: " + (j.error_description || res.status));
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}
async function sheets(path, options = {}) {
  const token = await googleToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/${path}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const j = await res.json();
  if (!res.ok) throw new Error("Sheets error: " + ((j.error && j.error.message) || res.status));
  return j;
}
async function readRange(range) {
  return (await sheets(`values/${encodeURIComponent(range)}`)).values || [];
}
async function getUser(login) {
  const rows = await readRange(`${USERS}!A2:D`);
  const r = rows.find(x => String(x[0] || "").trim().toUpperCase() === login.trim().toUpperCase());
  return r ? { login: String(r[0]).trim(), name: r[1] || "", role: String(r[2] || "").trim().toUpperCase(), hash: r[3] || "" } : null;
}
async function listRequests() {
  const rows = await readRange(`${QUEUE}!A2:P`);
  return rows.map(r => Object.fromEntries(HEADERS.map((h, i) => [h, r[i] ?? ""])));
}
async function getRequest(id) {
  return (await listRequests()).find(r => r.REQ_ID === id) || null;
}
async function addRequest(obj) {
  const row = HEADERS.map(h => obj[h] ?? "");
  await sheets(`values/${encodeURIComponent(`${QUEUE}!A:P`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: [row] }) });
}
async function updateRequest(id, changes) {
  const ids = await readRange(`${QUEUE}!A:A`);
  const idx = ids.findIndex(r => r[0] === id);
  if (idx < 1) throw new Error("Request not found");
  const rowNo = idx + 1, range = `${QUEUE}!A${rowNo}:P${rowNo}`;
  const cur = (await readRange(range))[0] || [];
  const merged = HEADERS.map((h, i) => (h in changes ? changes[h] : cur[i] ?? ""));
  await sheets(`values/${encodeURIComponent(range)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [merged] }) });
}

// ---- mail (Brevo HTTPS API; Netlify does not allow SMTP ports) ----
const fill = (t, f) => t.replace(/\{(loan|customer|amount)\}/g, (_, k) => f[k]);
function buildMail(r) {
  const amount = Number(String(r.SETTLEMENT).replace(/,/g, "")).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f = { loan: r.LOAN_NO, customer: r.CUSTOMER, amount };
  let to = [...CFG.foreclosureTo], cc = r.CC_MAIL || "";
  let subject = fill(SUBJECT_TEMPLATE, f), body = fill(BODY_TEMPLATE, f);
  if (!CFG.mailLive) { to = [CFG.testTo]; cc = ""; subject = "[TEST] " + subject; }
  return { to, cc, subject, body };
}
async function sendBrevo({ to, cc, subject, body }) {
  const payload = { sender: { email: CFG.senderEmail, name: CFG.senderName }, to: to.map(email => ({ email })), subject, textContent: body };
  if (cc) payload.cc = [{ email: cc }];
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { "api-key": CFG.brevoKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${String(j.message || "").slice(0, 200)}`);
  return j.messageId || "";
}

// ---- actions ----
async function login(body) {
  const u = await getUser(String(body.login || ""));
  if (!u || !checkPassword(String(body.password || ""), u.hash)) return json(401, { error: "Wrong login or password." });
  const user = { login: u.login, name: u.name, role: u.role };
  return json(200, { user }, { "Set-Cookie": makeCookie(user) });
}
async function submit(user, b) {
  const loan = String(b.loan_no || "").trim();
  const amount = Number(String(b.settlement || "").replace(/,/g, ""));
  const customer = String(b.customer || "").trim(), branch = String(b.branch || "").trim();
  const cc = String(b.cc_mail || "").trim();
  if (!loan) return json(400, { error: "Enter the loan number." });
  if (!(amount > 0)) return json(400, { error: "Enter a valid closing amount." });
  if (!customer || !branch) return json(400, { error: "Enter the customer name and branch." });
  if (!cc.includes("@")) return json(400, { error: "Enter the caller's email address (it goes in Cc)." });
  if ((await listRequests()).some(r => r.LOAN_NO === loan && OPEN.includes(r.STATUS)))
    return json(400, { error: `Loan ${loan} already has an open request.` });
  const id = "BM-" + new Date(Date.now() + IST_OFFSET).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  await addRequest({ REQ_ID: id, SUBMITTED_AT: nowIST(), SUBMITTED_BY: user.login, LOAN_NO: loan, CUSTOMER: customer,
    BRANCH: branch, SETTLEMENT: amount, CALLER_CODE: "", CALLER_NAME: String(b.caller_name || "").trim(), CC_MAIL: cc, STATUS: "PENDING_LEADER" });
  return json(200, { message: `Request ${id} submitted. Waiting for leader approval.` });
}
async function decide(user, b) {
  if (!["LEADER", "ADMIN"].includes(user.role)) return json(403, { error: "Only a leader or admin can approve." });
  const r = await getRequest(String(b.req_id || ""));
  if (!r || r.STATUS !== "PENDING_LEADER") return json(400, { error: "This request is no longer waiting for approval." });
  const status = b.action === "approve" ? "APPROVED" : "REJECTED";
  await updateRequest(r.REQ_ID, { STATUS: status, LEADER_BY: user.login, LEADER_AT: nowIST() });
  return json(200, { message: `${r.REQ_ID} ${status.toLowerCase()}.` });
}
async function preview(user, b) {
  if (!["LEADER", "ADMIN"].includes(user.role)) return json(403, { error: "Not allowed." });
  const r = await getRequest(String(b.req_id || ""));
  if (!r) return json(404, { error: "Request not found." });
  const m = buildMail(r);
  return json(200, { mail: { to: m.to.join(", "), cc: m.cc, subject: m.subject, body: m.body },
    ready: !(m.subject + m.body).includes("PASTE") });
}
async function send(user, b) {
  if (user.role !== "ADMIN") return json(403, { error: "Only admin can send mail." });
  if (b.confirm !== true) return json(400, { error: "Tick 'I checked the preview' first." });
  const r = await getRequest(String(b.req_id || ""));
  if (!r || !["APPROVED", "FAILED"].includes(r.STATUS)) return json(400, { error: "This request is not approved for sending." });
  if (!CFG.mailLive && !CFG.testTo) return json(400, { error: "Test mode needs MAIL_TEST_TO set." });
  const m = buildMail(r);
  if ((m.subject + m.body).includes("PASTE")) return json(400, { error: "Paste the Branch Mail v3.2 wording into netlify/functions/api.js first." });
  await updateRequest(r.REQ_ID, { STATUS: "SENDING" });
  try {
    await sendBrevo(m);
  } catch (err) {
    await updateRequest(r.REQ_ID, { STATUS: "FAILED", NOTE: err.message.slice(0, 200) });
    return json(502, { error: "Send failed: " + err.message });
  }
  await updateRequest(r.REQ_ID, { STATUS: "SENT", SENT_AT: nowIST(), SENT_BY: user.login, NOTE: "" });
  return json(200, { message: `${r.REQ_ID} sent to ${m.to.join(", ")}.` });
}

exports.handler = async (event) => {
  try {
    if (!CFG.secret || !CFG.sheetId || !CFG.saJson) return json(500, { error: "Settings missing: SESSION_SECRET, SHEET_ID or GOOGLE_SA_JSON." });
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });
    const body = JSON.parse(event.body || "{}");
    const action = body.action;
    if (action === "login") return await login(body);
    if (action === "logout") return json(200, { ok: true }, { "Set-Cookie": "bm_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
    const user = readUser(event);
    if (!user) return json(401, { error: "Please log in." });
    if (action === "me") return json(200, { user: { login: user.login, name: user.name, role: user.role } });
    if (action === "list") {
      const rows = await listRequests();
      return json(200, { rows: user.role === "CALLER" ? rows.filter(r => r.SUBMITTED_BY.toUpperCase() === user.login.toUpperCase()) : rows });
    }
    if (action === "submit") return await submit(user, body);
    if (action === "decide") return await decide(user, body);
    if (action === "preview") return await preview(user, body);
    if (action === "send") return await send(user, body);
    return json(400, { error: "Unknown action." });
  } catch (err) {
    return json(500, { error: err.message || "Server error" });
  }
};

// exported for local tests only
exports.__test = { checkPassword, makeCookie, readUser, buildMail };
