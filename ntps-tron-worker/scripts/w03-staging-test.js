"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const VERBOSE = process.argv.includes("--verbose");
const JSON_OUT = process.argv.includes("--json");
const ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const ONLY = ONLY_ARG ? ONLY_ARG.slice("--only=".length).toUpperCase() : null;

const WORKER_DIR = process.env.WORKER_DIR || path.resolve(__dirname, "..");
const WORKER_ENTRY = path.join(WORKER_DIR, "dist", "index.js");

const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DEST_ADDRESS = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const BLOCKED_ADDRESS = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const BURN_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const HOT_WALLET_ADDRESS = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const FAKE_HOT_WALLET_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function uuid() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(line) {
  if (VERBOSE) console.log(`    [worker] ${line}`);
}

class FakeDb {
  constructor() {
    this.tables = {
      terminals: [],
      wallets: [],
      whitelist_addresses: [],
      withdrawal_requests: [],
      transactions: [],
      deposit_addresses: [],
      aml_blocked_addresses: [],
      audit_logs: [],
      worker_checkpoints: [],
      asset_rates: [{ asset: "USDT", usd_rate: 1 }],
    };
    this.amlMode = "ok";
    this.requestLog = [];
  }

  seedApprovedWithdrawal({ destAddress = DEST_ADDRESS, amount = 25.5, verified = true } = {}) {
    const terminalId = uuid();
    const walletId = uuid();
    const txId = uuid();
    const wlId = uuid();
    const reqId = uuid();

    this.tables.terminals.push({
      id: terminalId,
      terminal_id: "NT-OMEGA-7K9P-3M2X",
      type: "master",
      owner_user_id: uuid(),
      label: "Staging Test Terminal",
      tier: "Gold",
      status: "active",
      daily_limit_usd: 500000,
      per_tx_limit_usd: 150000,
      allowed_assets: ["USDT", "BTC", "ETH"],
    });

    this.tables.wallets.push({
      id: walletId,
      terminal_id: terminalId,
      asset: "USDT",
      network: "TRC20",
      available: 100000,
      pending: 0,
    });

    this.tables.whitelist_addresses.push({
      id: wlId,
      terminal_id: terminalId,
      label: "Staging destination",
      asset: "USDT",
      network: "TRC20",
      address: destAddress,
      verified,
    });

    this.tables.transactions.push({
      id: txId,
      reference: `WD-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      terminal_id: terminalId,
      type: "withdrawal",
      asset: "USDT",
      network: "TRC20",
      amount,
      fee: 0,
      status: "pending",
      tx_hash: null,
      memo: "W-03 staging test",
      created_at: new Date().toISOString(),
    });

    this.tables.withdrawal_requests.push({
      id: reqId,
      transaction_id: txId,
      whitelist_address_id: wlId,
      state: "approved",
      broadcast_at: null,
      attempt_count: 0,
      last_attempt_at: null,
      last_error: null,
      tx_hash_candidate: null,
      destination_snapshot: destAddress,
      created_at: new Date().toISOString(),
    });

    return { reqId, txId, wlId, terminalId, walletId, destAddress, amount };
  }

  snapshot(reqId) {
    const req = this.tables.withdrawal_requests.find((r) => r.id === reqId);
    const tx = req ? this.tables.transactions.find((t) => t.id === req.transaction_id) : null;
    return {
      state: req ? req.state : null,
      lastError: req ? req.last_error : null,
      txHashCandidate: req ? req.tx_hash_candidate : null,
      txStatus: tx ? tx.status : null,
      txHash: tx ? tx.tx_hash : null,
      auditEvents: this.tables.audit_logs.map((a) => a.event_type),
    };
  }
}

function attachEmbeds(db, row, selectParam) {
  if (!selectParam) return row;
  const out = { ...row };
  if (selectParam.includes("whitelist_addresses(") && row.whitelist_address_id) {
    const wl = db.tables.whitelist_addresses.find((w) => w.id === row.whitelist_address_id);
    out.whitelist_addresses = wl ? { ...wl } : null;
  }
  if (selectParam.includes("transactions(") && row.transaction_id) {
    const tx = db.tables.transactions.find((t) => t.id === row.transaction_id);
    out.transactions = tx ? { ...tx } : null;
  }
  if (selectParam.includes("wallets(") && row.wallet_id) {
    const w = db.tables.wallets.find((x) => x.id === row.wallet_id);
    out.wallets = w ? { ...w } : null;
  }
  return out;
}

function applyPostgrestFilters(rows, searchParams) {
  let out = [...rows];
  for (const [key, value] of searchParams.entries()) {
    if (key === "select" || key === "order" || key === "limit") continue;
    if (value.startsWith("eq.")) {
      const target = value.slice(3);
      out = out.filter((r) => String(r[key]) === String(target));
    } else if (value.startsWith("neq.")) {
      const target = value.slice(4);
      out = out.filter((r) => String(r[key]) !== String(target));
    } else if (value.startsWith("gte.")) {
      const target = value.slice(4);
      out = out.filter((r) => String(r[key] ?? "") >= target);
    } else if (value.startsWith("lt.")) {
      const target = value.slice(3);
      out = out.filter((r) => r[key] != null && String(r[key]) < target);
    }
  }
  return out;
}

function startFakeSupabase(db) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const send = (code, payload) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const fnName = url.pathname.replace(/^\/rest\/v1\/rpc\//, "").split("/")[0];
        db.requestLog.push({ method: req.method, table: `rpc:${fnName}`, query: url.search });
        return send(404, {
          code: "PGRST202",
          message: `Could not find the function public.${fnName} in the schema cache`,
          details: null,
          hint: null,
        });
      }

      const table = url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0];
      const method = req.method;
      db.requestLog.push({ method, table, query: url.search });

      if (table === "aml_blocked_addresses") {
        if (db.amlMode === "table_missing") {
          return send(404, {
            code: "42P01",
            message: 'relation "public.aml_blocked_addresses" does not exist',
            details: null,
            hint: null,
          });
        }
        if (db.amlMode === "transient") {
          return send(400, {
            code: "ETIMEDOUT",
            message: "connect ETIMEDOUT 10.0.0.5:5432",
            details: null,
            hint: null,
          });
        }
        if (db.amlMode === "unknown") {
          return send(500, {
            code: "XX000",
            message: "internal error while reading AML registry",
            details: null,
            hint: null,
          });
        }
      }

      if (!db.tables[table]) {
        return send(404, {
          code: "42P01",
          message: `relation "public.${table}" does not exist`,
        });
      }

      if (method === "GET") {
        const filtered = applyPostgrestFilters(db.tables[table], url.searchParams);
        const selectParam = url.searchParams.get("select") || "";
        const rows = filtered.map((row) => attachEmbeds(db, row, selectParam));

        if ((req.headers.accept || "").includes("vnd.pgrst.object")) {
          if (rows.length === 0) {
            return send(406, {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: "Results contain 0 rows",
            });
          }
          return send(200, rows[0]);
        }
        return send(200, rows);
      }

      if (method === "POST") {
        const payload = body ? JSON.parse(body) : {};
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map((r) => ({ id: r.id || uuid(), ...r }));
        db.tables[table].push(...inserted);
        return send(201, inserted);
      }

      if (method === "PATCH") {
        const payload = body ? JSON.parse(body) : {};
        const matched = applyPostgrestFilters(db.tables[table], url.searchParams);
        for (const row of matched) Object.assign(row, payload);
        if ((req.headers.accept || "").includes("vnd.pgrst.object")) {
          return send(200, matched[0] ?? null);
        }
        return send(200, matched);
      }

      if (method === "DELETE") {
        const matched = applyPostgrestFilters(db.tables[table], url.searchParams);
        db.tables[table] = db.tables[table].filter((r) => !matched.includes(r));
        return send(200, matched);
      }

      return send(405, { message: "method not allowed" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function startFakeTron() {
  const state = { broadcastAttempts: [], calls: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      state.calls.push(`${req.method} ${url.pathname}`);
      const send = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/wallet/getaccount" || url.pathname === "/walletsolidity/getaccount") {
        return send({
          address: HOT_WALLET_ADDRESS,
          balance: 500_000_000, // 500 TRX reserve (satisfies W-20)
        });
      }

      if (url.pathname === "/wallet/getcontract") {
        return send({
          origin_address: HOT_WALLET_ADDRESS,
          contract_address: USDT_CONTRACT,
          bytecode: "",
          abi: {
            entrys: [
              {
                name: "transfer",
                type: "Function",
                stateMutability: "Nonpayable",
                inputs: [
                  { name: "_to", type: "address" },
                  { name: "_value", type: "uint256" },
                ],
                outputs: [{ name: "", type: "bool" }],
              },
              {
                name: "balanceOf",
                type: "Function",
                stateMutability: "View",
                inputs: [{ name: "_owner", type: "address" }],
                outputs: [{ name: "balance", type: "uint256" }],
              },
            ],
          },
        });
      }

      if (
        url.pathname.includes("broadcast") ||
        url.pathname.includes("triggersmartcontract") ||
        url.pathname.includes("createtransaction")
      ) {
        state.broadcastAttempts.push({ path: url.pathname, body: body.slice(0, 400) });
        return send({ result: false, code: "OTHER_ERROR", message: "blocked by test harness" });
      }

      if (url.pathname.includes("/v1/accounts/")) {
        return send({ data: [], success: true });
      }

      return send({ ok: true });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

function startWorker({ supabasePort, tronPort, extraEnv = {} }) {
  if (!fs.existsSync(WORKER_ENTRY)) {
    throw new Error(`Worker build not found at ${WORKER_ENTRY}. Run "npm run build" in ${WORKER_DIR} first.`);
  }

  const tronOrigin = `http://127.0.0.1:${tronPort}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
    SUPABASE_SERVICE_ROLE_KEY: "staging-fake-service-role-key",
    TRON_FULL_HOST: tronOrigin,
    TRON_ALLOWED_HOSTS: tronOrigin,
    TRONGRID_API_KEY: "",
    USDT_CONTRACT_ADDRESS: USDT_CONTRACT,
    HOT_WALLET_PRIVATE_KEY: FAKE_HOT_WALLET_KEY,
    ALLOW_PLAINTEXT_KEY: "true",
    POLL_INTERVAL_MS: "1000",
    WITHDRAWAL_RETRY_BASE_MS: "250",
    ALERT_WEBHOOK_URL: "",
    ALERT_EDGE_FUNCTION_URL: "",
    AML_BLOCKED_ADDRESSES: "",
    AML_ALLOW_DEGRADED_MODE: "false",
    ...extraEnv,
  };

  const shimPath = path.resolve(__dirname, "ws-shim.js");
  if (fs.existsSync(shimPath)) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --require ${shimPath}`.trim();
  }

  const child = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: WORKER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const out = [];
  child.stdout.on("data", (d) => {
    const s = d.toString();
    out.push(s);
    s.split("\n").filter(Boolean).forEach(log);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    out.push(s);
    s.split("\n").filter(Boolean).forEach(log);
  });

  return { child, output: () => out.join("") };
}

const SCENARIOS = [
  {
    id: "S1",
    name: "Transient Supabase network/DB error -> fail closed (AML_UNAVAILABLE)",
    amlMode: "transient",
    seed: () => ({ destAddress: DEST_ADDRESS }),
    expect: {
      state: "review",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_AML_UNAVAILABLE",
      noBroadcast: true,
      lastErrorPrefix: "AML_UNAVAILABLE:",
    },
  },
  {
    id: "S2",
    name: "Missing aml_blocked_addresses table (migration 004 pending) -> fail closed",
    amlMode: "table_missing",
    seed: () => ({ destAddress: DEST_ADDRESS }),
    expect: {
      state: "review",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_AML_UNAVAILABLE",
      noBroadcast: true,
      lastErrorPrefix: "AML_UNAVAILABLE:",
    },
  },
  {
    id: "S3",
    name: "Unknown DB error (XX000) -> fail closed",
    amlMode: "unknown",
    seed: () => ({ destAddress: DEST_ADDRESS }),
    expect: {
      state: "review",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_AML_UNAVAILABLE",
      noBroadcast: true,
      lastErrorPrefix: "AML_UNAVAILABLE:",
    },
  },
  {
    id: "S4",
    name: "Confirmed AML registry block -> AML_BLOCKED",
    amlMode: "ok",
    seed: () => ({ destAddress: BLOCKED_ADDRESS }),
    seedAml: (db) => {
      db.tables.aml_blocked_addresses.push({
        id: uuid(),
        address: BLOCKED_ADDRESS,
        network: "TRC20",
        reason: "OFAC SDN match (staging fixture)",
        risk_level: "sanctioned",
        source: "compliance_list",
        active: true,
        created_at: new Date().toISOString(),
      });
    },
    expect: {
      state: "review",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_AML_BLOCKED",
      noBroadcast: true,
      lastErrorPrefix: "AML_BLOCKED:",
    },
  },
  {
    id: "S5",
    name: "Builtin TRON burn address -> AML_BLOCKED",
    amlMode: "ok",
    seed: () => ({ destAddress: BURN_ADDRESS }),
    expect: {
      state: "review",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_AML_BLOCKED",
      noBroadcast: true,
      lastErrorPrefix: "AML_BLOCKED:",
    },
  },
  {
    id: "S6",
    name: "Clean AML registry check -> proceeds to broadcast claim",
    amlMode: "ok",
    seed: () => ({ destAddress: DEST_ADDRESS }),
    expect: {
      state: "broadcast",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_BROADCAST_STARTED",
      noBroadcast: false,
      lastErrorPrefix: null,
    },
  },
  {
    id: "S7",
    name: "Missing table + explicit AML_ALLOW_DEGRADED_MODE=true -> proceeds to broadcast",
    amlMode: "table_missing",
    seed: () => ({ destAddress: DEST_ADDRESS }),
    env: { AML_ALLOW_DEGRADED_MODE: "true" },
    expect: {
      state: "broadcast",
      txHashNull: true,
      auditEvent: "WITHDRAWAL_BROADCAST_STARTED",
      noBroadcast: false,
      lastErrorPrefix: null,
    },
  },
];

async function runScenario(scenario) {
  const db = new FakeDb();
  const supabase = await startFakeSupabase(db);
  const tron = await startFakeTron();
  let worker = null;

  try {
    db.amlMode = scenario.amlMode;
    const seeded = db.seedApprovedWithdrawal(scenario.seed());
    if (scenario.seedAml) scenario.seedAml(db);

    worker = startWorker({
      supabasePort: supabase.port,
      tronPort: tron.port,
      extraEnv: scenario.env || {},
    });

    const deadline = Date.now() + 20_000;
    let snap = db.snapshot(seeded.reqId);
    while (Date.now() < deadline) {
      snap = db.snapshot(seeded.reqId);
      const hasBroadcastStarted = snap.auditEvents.includes("WITHDRAWAL_BROADCAST_STARTED");
      if (snap.state !== "approved" && (scenario.expect.noBroadcast || hasBroadcastStarted)) {
        break;
      }
      await sleep(150);
    }
    await sleep(400);
    snap = db.snapshot(seeded.reqId);

    const checks = [];
    const push = (label, pass, detail) => checks.push({ label, pass, detail });

    if (scenario.expect.state === "broadcast") {
      // Wait-free check: worker may either still be retrying in 'broadcast' or have returned to 'review' after exhausting fake Tron retries
      push(
        `Broadcast was initiated (${scenario.expect.auditEvent})`,
        snap.auditEvents.includes("WITHDRAWAL_BROADCAST_STARTED"),
        `events=[${snap.auditEvents.join(", ")}]`
      );
    } else {
      push(
        `Final state = ${scenario.expect.state}`,
        snap.state === scenario.expect.state,
        `actual=${snap.state}`
      );
    }

    if (scenario.expect.txHashNull) {
      push(
        "transactions.tx_hash remains NULL",
        snap.txHash === null || snap.txHash === undefined,
        `actual=${String(snap.txHash)}`
      );
    }

    push(
      `Audit event ${scenario.expect.auditEvent} recorded`,
      snap.auditEvents.includes(scenario.expect.auditEvent),
      `events=[${snap.auditEvents.join(", ")}]`
    );

    if (scenario.expect.noBroadcast) {
      push(
        "Zero broadcast attempts reached TRON node",
        tron.state.broadcastAttempts.length === 0,
        `attempts=${tron.state.broadcastAttempts.length}`
      );
    } else {
      push(
        "Broadcast attempt reached TRON node as expected",
        tron.state.broadcastAttempts.length > 0,
        `attempts=${tron.state.broadcastAttempts.length}`
      );
    }

    if (scenario.expect.lastErrorPrefix) {
      push(
        `last_error starts with "${scenario.expect.lastErrorPrefix}"`,
        typeof snap.lastError === "string" &&
          snap.lastError.startsWith(scenario.expect.lastErrorPrefix),
        `actual=${String(snap.lastError).slice(0, 90)}`
      );
    }

    return {
      id: scenario.id,
      name: scenario.name,
      passed: checks.every((c) => c.pass),
      checks,
      snapshot: snap,
      broadcastAttempts: tron.state.broadcastAttempts.length,
      amlCalls: db.requestLog.filter((r) => r.table === "aml_blocked_addresses").length,
      workerOutput: worker.output(),
    };
  } finally {
    if (worker && !worker.child.killed) worker.child.kill("SIGKILL");
    supabase.server.close();
    tron.server.close();
    await sleep(120);
  }
}

function printReport(results) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  console.log("");
  console.log("=".repeat(78));
  console.log("  W-03 — AML Fail-Closed Staging Harness Report");
  console.log("=".repeat(78));
  console.log("");

  for (const r of results) {
    const icon = r.passed ? "[PASS]" : "[FAIL]";
    console.log(`${icon}  ${r.id} - ${r.name}`);
    if (r.amlCalls !== undefined) {
      console.log(`       AML registry calls: ${r.amlCalls}`);
    }
    for (const c of r.checks) {
      console.log(`       ${c.pass ? "OK" : "X "} ${c.label}`);
      if (!c.pass) console.log(`          -> ${c.detail}`);
    }
    console.log("");
  }

  console.log("-".repeat(78));
  console.log(`  Summary: ${passed}/${total} scenarios passed | failed: ${failed}`);
  console.log("-".repeat(78));

  if (failed > 0) {
    console.log("\n  Re-run with --verbose for full worker logs.");
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`\n  -- ${r.id} tail --`);
      console.log(
        r.workerOutput
          .split("\n")
          .filter(Boolean)
          .slice(-15)
          .map((l) => "     " + l)
          .join("\n")
      );
    }
  }
  console.log("");
  return failed === 0;
}

(async () => {
  if (!fs.existsSync(WORKER_ENTRY)) {
    console.error(`Worker build not found at ${WORKER_ENTRY}. Run "npm run build" in ntps-tron-worker first.`);
    process.exit(2);
  }

  console.log("\nW-03 staging harness");
  console.log(`  worker: ${WORKER_ENTRY}`);

  const results = [];
  for (const scenario of SCENARIOS) {
    if (ONLY && scenario.id !== ONLY) continue;
    process.stdout.write(`  Running ${scenario.id} ... `);
    try {
      const r = await runScenario(scenario);
      results.push(r);
      console.log(r.passed ? "PASS" : "FAIL");
    } catch (err) {
      results.push({
        id: scenario.id,
        name: scenario.name,
        passed: false,
        checks: [{ label: "Scenario execution", pass: false, detail: String(err.message) }],
        snapshot: {},
        broadcastAttempts: 0,
        workerOutput: String(err.stack || err),
      });
      console.log("ERROR");
    }
  }

  const ok = printReport(results);
  if (JSON_OUT) {
    const outPath = path.resolve(__dirname, "w03-report.json");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          workerEntry: WORKER_ENTRY,
          total: results.length,
          passed: results.filter((r) => r.passed).length,
          failed: results.filter((r) => !r.passed).length,
          results: results.map((r) => ({
            id: r.id,
            name: r.name,
            passed: r.passed,
            checks: r.checks,
            snapshot: r.snapshot,
            broadcastAttempts: r.broadcastAttempts,
          })),
        },
        null,
        2
      )
    );
    console.log(`  JSON report written: ${outPath}`);
  }

  process.exit(ok ? 0 : 1);
})();
