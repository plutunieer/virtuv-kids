// Virtuv Kids — local server: input page, answer generation via Claude CLI, history, parent page.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const ANSWERS = path.join(DATA, 'answers');
const HISTORY = path.join(DATA, 'history.json');
const MAX_RUNNING = 2; // at most this many Claude CLI processes at once
fs.mkdirSync(ANSWERS, { recursive: true });

// U3: blocklist (EN + DE). A question containing one of these words gets no answer.
const BLOCKLIST = [
  'weapon', 'gun', 'knives', 'rifle', 'pistol', 'knife', 'bomb', 'explosive', 'grenade',
  'waffe', 'gewehr', 'pistole', 'messer', 'bombe', 'sprengstoff', 'granate',
  'violence', 'violent', 'kill', 'murder', 'stab', 'shoot', 'shot', 'torture',
  'gewalt', 'töten', 'toeten', 'tötet', 'getötet', 'umbringen', 'mord', 'morden', 'ermordet',
  'erstechen', 'erstochen', 'erschießen', 'erschiessen', 'erschossen', 'folter',
  'sex', 'sexy', 'porn', 'porno', 'nude', 'naked', 'nackt',
  'drug', 'cocaine', 'heroin', 'cannabis', 'weed', 'meth',
  'droge', 'kokain', 'kiffen', 'haschisch',
];
// German nouns that also count at the end of compounds ("Taschenmesser", "Kriegswaffe").
const COMPOUND_ENDS = ['waffe', 'messer', 'bombe', 'gewehr', 'pistole', 'granate', 'mord', 'droge'];
const ALLOWED = new Set(['heroine', 'heroines', 'durchmesser', 'durchmessern', 'zeitmesser', 'zeitmessern',
  'vermesser', 'landvermesser', 'wasserbombe', 'wasserbomben', 'wasserpistole', 'wasserpistolen']);
const SUFFIXES = ['', 's', 'es', 'e', 'n', 'en', 'ed', 'ing', 'er', 'ern'];

function isBlocked(question) {
  const words = question.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some(w => !ALLOWED.has(w) && (
    BLOCKLIST.some(b => SUFFIXES.some(x => w === b + x)) ||
    COMPOUND_ENDS.some(b => SUFFIXES.some(x => w.endsWith(b + x)))
  ));
}

const SYSTEM_PROMPT = `You create answer pages for children. Output ONLY one complete HTML document, starting with <!DOCTYPE html>. No markdown, no code fences, no text outside the HTML.
Rules:
- Write in the same language as the child's question, whatever language that is.
- Every sentence has at most 10 words. Simple words a child knows.
- Big, colorful, friendly design. Font size at least 22px. Works on iPad and Mac.
- At least one animated illustration made with inline SVG and CSS animation (no image files, no external URLs).
- At least one clickable interactive element that reacts visibly (e.g. tap to reveal, mini quiz, tap the picture to make it move).
- Everything inline: no external scripts, stylesheets, fonts, images or links. No <a href> to other sites. No forms that send data.
- Only child-friendly content. Nothing scary, violent or sexual. If the question is unsuitable, gently suggest asking something else.
- Do not ask for names or personal information.
The user message is exactly the child's question.`;

let running = 0;

function generateAnswer(question) {
  return new Promise((resolve, reject) => {
    // U4: local Claude CLI (subscription). Remove everything that would bill via the API instead.
    const env = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
    const child = spawn('claude', [
      '-p', '--output-format', 'text', '--model', process.env.VK_MODEL || 'sonnet',
      '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', SYSTEM_PROMPT,
    ], { env, cwd: DATA });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, 180000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {}); // CLI missing or exited early; 'close'/'error' reports it
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const start = out.search(/<!DOCTYPE html>|<html/i);
      const end = out.lastIndexOf('</html>');
      if (code !== 0 || start < 0 || end < start) return reject(new Error(`claude failed (${code}): ${err.slice(0, 300)}`));
      resolve(out.slice(start, end + 7));
    });
    child.stdin.end(question);
  });
}

// Missing file = no history yet. A broken file throws, so it is never overwritten with [].
function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function saveEntry(entry) {
  const list = readHistory();
  list.push(entry);
  fs.writeFileSync(HISTORY + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(HISTORY + '.tmp', HISTORY);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'";
// Generated pages run sandboxed: own scripts only, no requests, no navigation, no popups.
const RAW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

function send(res, status, type, body, csp = APP_CSP) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': csp, ...BASE_HEADERS });
  res.end(body);
}

// U10: wrapper with home button; the answer itself sits in a sandboxed frame.
function answerWrapper(id, html) {
  const raw = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || 'Virtuv Kids';
  const title = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title.trim())}</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff}
iframe{border:0;width:100%;height:100%;display:block}
#vk-home{position:fixed;bottom:calc(16px + env(safe-area-inset-bottom));left:16px;z-index:9;font:700 26px system-ui,sans-serif;background:#ff7a59;color:#fff;border:0;border-radius:40px;padding:12px 20px;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer}
</style></head><body>
<iframe sandbox="allow-scripts" src="/a/${id}/raw" title="${esc(title.trim())}"></iframe>
<button id="vk-home" onclick="location.href='/'" aria-label="Home">🏠</button>
</body></html>`;
}

function parentPage() {
  const rows = readHistory().slice().reverse().map(e => {
    const when = new Date(e.time).toLocaleString('de-DE');
    const q = esc(e.question);
    if (e.blocked) return `<li class="off"><span class="t">${when}</span><span class="q">${q}</span><span class="tag">gesperrt</span></li>`;
    if (e.error) return `<li class="off"><span class="t">${when}</span><span class="q">${q}</span><span class="tag">fehlgeschlagen</span></li>`;
    return `<li><span class="t">${when}</span><a class="q" href="/a/${e.id}">${q}</a></li>`;
  }).join('');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Virtuv Kids – Eltern</title><style>
body{font-family:system-ui,sans-serif;background:#f6f4ff;color:#222;margin:0;padding:24px}
h1{margin:0 0 16px}ul{list-style:none;padding:0;max-width:800px}
li{background:#fff;border-radius:14px;padding:14px 18px;margin:10px 0;display:flex;gap:16px;align-items:center;box-shadow:0 2px 6px rgba(0,0,0,.06)}
.t{color:#777;white-space:nowrap;font-size:14px}.q{font-size:18px;color:#4b3bd6;text-decoration:none;flex:1}
.off .q{color:#999}.tag{background:#ffe3e3;color:#b00;border-radius:8px;padding:2px 8px;font-size:13px}
a.back{display:inline-block;margin-bottom:12px;color:#4b3bd6}</style></head><body>
<a class="back" href="/">← zur Kinderseite</a><h1>Gestellte Fragen</h1>
${rows ? `<ul>${rows}</ul>` : '<p>Noch keine Fragen.</p>'}</body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', d => {
      if (body === null) return; // already too large: drain and discard the rest
      body += d;
      if (body.length > 10000) { body = null; reject(Object.assign(new Error('too large'), { status: 413 })); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Only answer requests addressed to this Mac (blocks DNS rebinding) and, for /ask, from our own page (blocks CSRF).
function allowedHosts() {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4').map(i => i.address);
  return new Set(['localhost', ...ips].map(h => `${h}:${PORT}`));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!allowedHosts().has(req.headers.host)) return send(res, 421, 'text/plain; charset=utf-8', 'Falsche Adresse');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/eltern') {
      return send(res, 200, 'text/html; charset=utf-8', parentPage());
    }
    const m = url.pathname.match(/^\/a\/([a-f0-9]{16})(\/raw)?$/);
    if (req.method === 'GET' && m) {
      const file = path.join(ANSWERS, m[1] + '.html');
      if (!fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
      const html = fs.readFileSync(file, 'utf8');
      return m[2]
        ? send(res, 200, 'text/html; charset=utf-8', html, RAW_CSP)
        : send(res, 200, 'text/html; charset=utf-8', answerWrapper(m[1], html));
    }
    if (req.method === 'POST' && url.pathname === '/ask') {
      const origin = req.headers.origin;
      if (!String(req.headers['content-type']).startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) {
        return send(res, 403, 'application/json', JSON.stringify({ error: 'forbidden' }));
      }
      let question = '';
      try { question = String(JSON.parse(await readBody(req)).question || '').trim().slice(0, 300); } catch (e) {
        if (e.status) return send(res, e.status, 'application/json', JSON.stringify({ error: 'too large' }));
      }
      if (!question) return send(res, 400, 'application/json', JSON.stringify({ error: 'empty' }));
      const time = new Date().toISOString();
      if (isBlocked(question)) {
        saveEntry({ time, question, blocked: true });
        return send(res, 200, 'application/json', JSON.stringify({ blocked: true }));
      }
      if (running >= MAX_RUNNING) return send(res, 429, 'application/json', JSON.stringify({ error: 'busy' }));
      running++;
      let html;
      try {
        html = await generateAnswer(question);
      } catch (e) {
        console.error(e);
        saveEntry({ time, question, error: true });
        return send(res, 500, 'application/json', JSON.stringify({ error: 'failed' }));
      } finally {
        running--;
      }
      const id = crypto.randomBytes(8).toString('hex');
      fs.writeFileSync(path.join(ANSWERS, id + '.html'), html);
      saveEntry({ id, time, question });
      return send(res, 200, 'application/json', JSON.stringify({ id }));
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Nicht gefunden');
  } catch (e) {
    console.error(e);
    send(res, 500, 'application/json', JSON.stringify({ error: 'failed' }));
  }
});

if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Virtuv Kids läuft:\n  Mac:  http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  iPad: http://${ip}:${PORT}`));
  console.log(`  Eltern: /eltern`);
});

module.exports = { isBlocked };
