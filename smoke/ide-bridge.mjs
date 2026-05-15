// Phase 0 smoke tests #1, #2, #3 (combined):
//   #1 claude -p --output-format stream-json + IDE bridge + CLAUDE_CODE_SSE_PORT
//   #2 --permission-mode acceptEdits routes Edit/Write to openDiff
//   #3 system event "billing source" indicator on host with subscription auth
//
// Spins up a WebSocket "IDE bridge" stub matching the protocol documented at
// claudecode.nvim/PROTOCOL.md, writes ~/.claude/ide/<port>.lock, spawns
// `claude -p` with stream-json on stdin/stdout, sends a prompt that asks the
// agent to edit a temp file (which should trigger openDiff), logs every
// stream-json frame from stdout and every JSON-RPC message from the WS, then
// auto-rejects the diff and exits.

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = 10000 + Math.floor(Math.random() * 50000);
const AUTH = randomUUID();
const IDE_DIR = join(homedir(), '.claude', 'ide');
const LOCK = join(IDE_DIR, `${PORT}.lock`);

const WORK = mkdtempSync(join(tmpdir(), 'domo-smoke-'));
const TARGET = join(WORK, 'hello.txt');
writeFileSync(TARGET, 'hello\n');

mkdirSync(IDE_DIR, { recursive: true });
writeFileSync(
  LOCK,
  JSON.stringify({
    pid: process.pid,
    workspaceFolders: [WORK],
    ideName: 'domo-smoke',
    transport: 'ws',
    authToken: AUTH,
  }, null, 2),
);

const log = (tag, msg) => console.log(`[${tag}]`, typeof msg === 'string' ? msg : JSON.stringify(msg));

// Findings collector — surfaces a one-line summary at exit.
const findings = {
  bridgeConnected: false,
  authValidated: false,
  systemEventSeen: false,
  billingSource: null,
  apiKeySource: null,
  openDiffSeen: false,
  openDiffParams: null,
  toolNamesSeen: new Set(),
  streamJsonValid: true,
};

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ req }, cb) => {
    const got = req.headers['x-claude-code-ide-authorization'];
    if (got === AUTH) {
      findings.authValidated = true;
      cb(true);
    } else {
      log('ws', `auth rejected; got=${got}`);
      cb(false, 401, 'unauthorized');
    }
  },
});

wss.on('connection', (ws) => {
  findings.bridgeConnected = true;
  log('ws', 'claude connected to bridge');

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { log('ws', `bad json: ${raw}`); return; }
    log('ws<-', msg);

    // Respond to MCP-style requests so the CLI doesn't hang.
    if (msg.method === 'initialize') {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
          serverInfo: { name: 'domo-smoke', version: '0.0.1' },
          capabilities: { tools: { listChanged: false } },
        },
      }));
    } else if (msg.method === 'tools/list') {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: [
            { name: 'openDiff', description: 'open diff', inputSchema: { type: 'object' } },
            { name: 'openFile', description: 'open file', inputSchema: { type: 'object' } },
            { name: 'getCurrentSelection', description: 'sel', inputSchema: { type: 'object' } },
            { name: 'getLatestSelection', description: 'latest', inputSchema: { type: 'object' } },
            { name: 'getOpenEditors', description: 'editors', inputSchema: { type: 'object' } },
            { name: 'getWorkspaceFolders', description: 'folders', inputSchema: { type: 'object' } },
            { name: 'checkDocumentDirty', description: 'dirty', inputSchema: { type: 'object' } },
            { name: 'saveDocument', description: 'save', inputSchema: { type: 'object' } },
            { name: 'closeAllDiffTabs', description: 'close', inputSchema: { type: 'object' } },
          ],
        },
      }));
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      findings.toolNamesSeen.add(name);
      if (name === 'openDiff') {
        findings.openDiffSeen = true;
        findings.openDiffParams = msg.params?.arguments;
        log('ws', `openDiff received — parking, will auto-reject in 2s`);
        await delay(2000);
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: 'DIFF_REJECTED' }] },
        }));
      } else if (name === 'getWorkspaceFolders') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, folders: [{ name: 'smoke', uri: `file://${WORK}`, path: WORK }], rootPath: WORK }),
            }],
          },
        }));
      } else {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] },
        }));
      }
    } else if (msg.method) {
      // Notifications (selection_changed, etc.) — just log.
    }
  });

  ws.on('close', () => log('ws', 'claude disconnected'));
});

log('boot', `bridge listening on 127.0.0.1:${PORT}, lock=${LOCK}, cwd=${WORK}`);

// Scrub ANTHROPIC_API_KEY and the outer Claude Code session env vars
// (we're running inside a claude session ourselves), so the spawned claude
// starts as a fresh top-level process.
const env = { ...process.env };
for (const k of [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'AI_AGENT',
  'CLAUDE_EFFORT',
]) delete env[k];
env.CLAUDE_CODE_SSE_PORT = String(PORT);
env.ENABLE_IDE_INTEGRATION = 'true';
env.FORCE_CODE_TERMINAL = 'true'; // mirrors claudecode.nvim/lua/claudecode/terminal.lua

const child = spawn(
  'claude',
  [
    '-p',
    '--ide',
    '--debug', 'ide',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--add-dir', WORK,
  ],
  { cwd: WORK, env, stdio: ['pipe', 'pipe', 'pipe'] },
);

child.stderr.on('data', (b) => process.stderr.write(`[claude-stderr] ${b}`));

// Send one user message as stream-json. Format per Anthropic docs.
const userMsg = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Please use the Edit tool to change "hello" to "smoke ok" in ${TARGET}. Just one edit. After the edit, briefly confirm.`,
      },
    ],
  },
};
child.stdin.write(JSON.stringify(userMsg) + '\n');

// We do NOT end stdin yet — the CLI keeps the bridge open while it works.

let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split('\n');
  stdoutBuf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { findings.streamJsonValid = false; log('stdout', `(non-json) ${line}`); continue; }
    log('stdout', evt);
    if (evt.type === 'system') {
      findings.systemEventSeen = true;
      findings.billingSource ??= evt.permissionMode || evt.apiKeySource || evt.modelInfo?.firstParty;
      if (evt.apiKeySource) findings.apiKeySource = evt.apiKeySource;
      // Some claude versions report the source under different keys; keep the raw payload too.
    }
  }
});

const HARD_TIMEOUT_MS = 60_000;
const killer = setTimeout(() => {
  log('boot', 'hard timeout, killing claude');
  child.kill('SIGTERM');
}, HARD_TIMEOUT_MS);

child.on('exit', async (code, sig) => {
  clearTimeout(killer);
  log('boot', `claude exited code=${code} sig=${sig}`);
  // Give the bridge a moment to flush.
  await delay(100);
  wss.close();
  try { unlinkSync(LOCK); } catch { /* already gone */ }
  try { rmSync(WORK, { recursive: true, force: true }); } catch { /* already gone */ }

  console.log('\n========== SMOKE TEST RESULT ==========');
  console.log('bridge auth validated:', findings.authValidated);
  console.log('claude connected to bridge:', findings.bridgeConnected);
  console.log('stream-json output parsed cleanly:', findings.streamJsonValid);
  console.log('system event observed:', findings.systemEventSeen);
  console.log('apiKeySource:', findings.apiKeySource);
  console.log('openDiff received via bridge:', findings.openDiffSeen);
  if (findings.openDiffParams) {
    console.log('openDiff params keys:', Object.keys(findings.openDiffParams));
  }
  console.log('tool names received on bridge:', [...findings.toolNamesSeen]);
  console.log('=======================================');
  process.exit(0);
});
