import { useState, useEffect, useRef } from "react";

const DB_TABLES = {
  users: [
    { id: 1, name: "Arjun Sharma", email: "arjun@example.com", age: 28 },
    { id: 2, name: "Priya Patel", email: "priya@example.com", age: 34 },
    { id: 3, name: "Ravi Kumar", email: "ravi@example.com", age: 22 },
  ],
};

let nextId = 4;

const ENDPOINTS = [
  { method: "GET", path: "/api/users", description: "Fetch all users" },
  { method: "GET", path: "/api/users/1", description: "Fetch user by ID" },
  { method: "POST", path: "/api/users", description: "Create new user" },
  { method: "DELETE", path: "/api/users/1", description: "Delete user by ID" },
];

const STEPS = ["client", "network", "backend", "query_planner", "db", "response"];

const STEP_LABELS = {
  client: "Client",
  network: "Network",
  backend: "Backend",
  query_planner: "Query Planner",
  db: "Database",
  response: "Response",
};

const STEP_ICONS = {
  client: "🌐",
  network: "📡",
  backend: "⚙️",
  query_planner: "🧠",
  db: "🗄️",
  response: "✅",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateTrace(method, path, body, dbState) {
  const isById = path.match(/\/api\/users\/(\d+)/);
  const userId = isById ? parseInt(isById[1]) : null;

  if (method === "GET" && !userId) {
    return {
      steps: [
        { step: "client", log: `→ ${method} ${path}`, code: `fetch('${path}')` },
        { step: "network", log: "TCP connection established → request forwarded to port 3000", code: null },
        {
          step: "backend",
          log: "Router matched: GET /api/users → handler called",
          code: `app.get('/api/users', async (req, res) => {\n  const users = await db.query(\n    'SELECT * FROM users'\n  );\n  res.json(users);\n});`,
        },
        {
          step: "query_planner",
          log: "No WHERE clause → full table scan on 'users'\nEstimated rows: " + dbState.users.length,
          code: `QUERY PLAN:\n→ Seq Scan on users\n   cost=0.00..1.${dbState.users.length}0\n   rows=${dbState.users.length}`,
        },
        {
          step: "db",
          log: `Pages loaded into memory → ${dbState.users.length} rows returned`,
          code: `SELECT * FROM users;\n-- ${dbState.users.length} row(s) returned`,
        },
        {
          step: "response",
          log: `200 OK — ${dbState.users.length} users serialized to JSON`,
          result: dbState.users,
        },
      ],
    };
  }

  if (method === "GET" && userId) {
    const found = dbState.users.find((u) => u.id === userId);
    return {
      steps: [
        { step: "client", log: `→ ${method} ${path}`, code: `fetch('${path}')` },
        { step: "network", log: "TCP connection established → request forwarded", code: null },
        {
          step: "backend",
          log: `Router matched: GET /api/users/:id → id=${userId}`,
          code: `app.get('/api/users/:id', async (req, res) => {\n  const user = await db.query(\n    'SELECT * FROM users WHERE id = $1',\n    [req.params.id]\n  );\n  if (!user) return res.status(404);\n  res.json(user);\n});`,
        },
        {
          step: "query_planner",
          log: `WHERE id=${userId} → Index Scan on users_pkey\nDirect B-Tree lookup, O(log n)`,
          code: `QUERY PLAN:\n→ Index Scan on users_pkey\n   Index Cond: (id = ${userId})\n   cost=0.15..8.17 rows=1`,
        },
        {
          step: "db",
          log: found
            ? `Row found via index → id=${userId}`
            : `No row found for id=${userId}`,
          code: `SELECT * FROM users WHERE id = ${userId};\n-- ${found ? "1 row" : "0 rows"} returned`,
        },
        found
          ? { step: "response", log: `200 OK — user serialized`, result: found }
          : { step: "response", log: `404 Not Found — no user with id=${userId}`, result: { error: "User not found" }, isError: true },
      ],
    };
  }

  if (method === "POST") {
    const newUser = { id: nextId++, ...body };
    return {
      steps: [
        { step: "client", log: `→ POST ${path} with body`, code: `fetch('${path}', {\n  method: 'POST',\n  body: JSON.stringify(${JSON.stringify(body, null, 2)})\n})` },
        { step: "network", log: "Request with JSON body forwarded", code: null },
        {
          step: "backend",
          log: "Body parsed → validation passed → INSERT prepared",
          code: `app.post('/api/users', async (req, res) => {\n  const { name, email, age } = req.body;\n  const user = await db.query(\n    'INSERT INTO users (name,email,age) VALUES ($1,$2,$3) RETURNING *',\n    [name, email, age]\n  );\n  res.status(201).json(user);\n});`,
        },
        {
          step: "query_planner",
          log: "INSERT → no planning needed, append to table\nTransaction BEGIN",
          code: `BEGIN;\nINSERT INTO users ...\n-- WAL log written\n-- Page updated in buffer\nCOMMIT;`,
        },
        {
          step: "db",
          log: `Row written to disk → id=${newUser.id} assigned\nTransaction committed`,
          code: `INSERT INTO users (name, email, age)\nVALUES ('${newUser.name}', '${newUser.email}', ${newUser.age})\nRETURNING *;\n-- 1 row inserted`,
        },
        { step: "response", log: `201 Created — new user returned`, result: newUser, isInsert: true, newUser },
      ],
    };
  }

  if (method === "DELETE") {
    const found = dbState.users.find((u) => u.id === userId);
    return {
      steps: [
        { step: "client", log: `→ DELETE ${path}`, code: `fetch('${path}', { method: 'DELETE' })` },
        { step: "network", log: "DELETE request forwarded", code: null },
        {
          step: "backend",
          log: `Router matched: DELETE /api/users/:id → id=${userId}`,
          code: `app.delete('/api/users/:id', async (req, res) => {\n  await db.query(\n    'DELETE FROM users WHERE id = $1',\n    [req.params.id]\n  );\n  res.status(204).send();\n});`,
        },
        {
          step: "query_planner",
          log: `Index scan to locate row → DELETE with transaction`,
          code: `BEGIN;\nDELETE FROM users WHERE id = ${userId};\n-- WAL log written\nCOMMIT;`,
        },
        {
          step: "db",
          log: found ? `Row id=${userId} marked for deletion → VACUUM later` : `No row found for id=${userId}`,
          code: `DELETE FROM users WHERE id = ${userId};\n-- ${found ? "1 row deleted" : "0 rows affected"}`,
        },
        found
          ? { step: "response", log: `204 No Content — deleted successfully`, result: null, isDelete: true, deletedId: userId }
          : { step: "response", log: `404 Not Found`, result: { error: "User not found" }, isError: true },
      ],
    };
  }
}

export default function App() {
  const [dbState, setDbState] = useState({ users: [...DB_TABLES.users] });
  const [selectedEndpoint, setSelectedEndpoint] = useState(ENDPOINTS[0]);
  const [postBody, setPostBody] = useState({ name: "New User", email: "new@example.com", age: 25 });
  const [activeStep, setActiveStep] = useState(null);
  const [completedSteps, setCompletedSteps] = useState([]);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [finalResult, setFinalResult] = useState(null);
  const [currentStepData, setCurrentStepData] = useState(null);
  const [pathOverride, setPathOverride] = useState("");
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const getPath = () => pathOverride || selectedEndpoint.path;

  async function runSimulation() {
    if (running) return;
    setRunning(true);
    setLogs([]);
    setFinalResult(null);
    setActiveStep(null);
    setCompletedSteps([]);
    setCurrentStepData(null);

    const path = getPath();
    const trace = generateTrace(selectedEndpoint.method, path, postBody, dbState);

    for (const stepData of trace.steps) {
      setActiveStep(stepData.step);
      setCurrentStepData(stepData);
      setLogs((l) => [...l, { step: stepData.step, log: stepData.log, code: stepData.code }]);
      await sleep(900);
      setCompletedSteps((c) => [...c, stepData.step]);

      if (stepData.isInsert && stepData.newUser) {
        setDbState((prev) => ({ users: [...prev.users, stepData.newUser] }));
      }
      if (stepData.isDelete && stepData.deletedId) {
        setDbState((prev) => ({ users: prev.users.filter((u) => u.id !== stepData.deletedId) }));
      }
    }

    const last = trace.steps[trace.steps.length - 1];
    setFinalResult(last.result);
    setActiveStep(null);
    setRunning(false);
  }

  const methodColor = {
    GET: "#4ade80",
    POST: "#60a5fa",
    DELETE: "#f87171",
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0a0f",
      color: "#e2e8f0",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
      padding: "0",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .step-node {
          transition: all 0.3s ease;
          cursor: default;
        }
        .step-node.active {
          box-shadow: 0 0 0 2px #facc15, 0 0 24px #facc1566;
          transform: scale(1.05);
        }
        .step-node.done {
          box-shadow: 0 0 0 1px #4ade8055;
        }
        .pulse { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .flow-arrow {
          animation: flow 1.2s linear infinite;
        }
        @keyframes flow {
          0% { stroke-dashoffset: 20; }
          100% { stroke-dashoffset: 0; }
        }
        .endpoint-btn {
          transition: all 0.15s;
          border: 1px solid #1e1e2e;
          cursor: pointer;
        }
        .endpoint-btn:hover { border-color: #333; background: #111 !important; }
        .endpoint-btn.selected { border-color: #facc15 !important; background: #1a1a0a !important; }
        .run-btn {
          transition: all 0.2s;
          cursor: pointer;
        }
        .run-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 20px #facc1555;
        }
        .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .log-line { animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
        .db-row { transition: all 0.4s ease; }
        .db-row.new { animation: highlight 1.5s ease; }
        @keyframes highlight {
          0%, 100% { background: transparent; }
          30% { background: #4ade8022; }
        }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1a1a2e", padding: "20px 32px", display: "flex", alignItems: "center", gap: "16px", background: "#050508" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px #4ade80" }} />
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "0.05em", color: "#facc15" }}>API → BACKEND → DB</span>
        <span style={{ color: "#444", fontSize: 12 }}>// full request lifecycle simulator</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 0, minHeight: "calc(100vh - 61px)" }}>

        {/* LEFT PANEL */}
        <div style={{ borderRight: "1px solid #1a1a2e", display: "flex", flexDirection: "column", background: "#050508" }}>

          {/* Endpoints */}
          <div style={{ padding: "20px", borderBottom: "1px solid #1a1a2e" }}>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: "0.15em", marginBottom: 12 }}>ENDPOINTS</div>
            {ENDPOINTS.map((ep) => (
              <div
                key={ep.method + ep.path}
                className={`endpoint-btn ${selectedEndpoint === ep ? "selected" : ""}`}
                style={{ padding: "10px 14px", marginBottom: 6, borderRadius: 6, background: "#08080f", display: "flex", alignItems: "center", gap: 10 }}
                onClick={() => { setSelectedEndpoint(ep); setPathOverride(""); }}
              >
                <span style={{ fontSize: 10, fontWeight: 700, color: methodColor[ep.method], minWidth: 42 }}>{ep.method}</span>
                <span style={{ fontSize: 11, color: "#aaa" }}>{ep.description}</span>
              </div>
            ))}
          </div>

          {/* Path override */}
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #1a1a2e" }}>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: "0.15em", marginBottom: 8 }}>REQUEST PATH</div>
            <input
              value={pathOverride || selectedEndpoint.path}
              onChange={(e) => setPathOverride(e.target.value)}
              style={{
                width: "100%", background: "#0d0d18", border: "1px solid #1e1e2e", borderRadius: 6,
                padding: "8px 12px", color: "#e2e8f0", fontSize: 12, outline: "none",
                fontFamily: "inherit"
              }}
            />
          </div>

          {/* POST body */}
          {selectedEndpoint.method === "POST" && (
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #1a1a2e" }}>
              <div style={{ fontSize: 10, color: "#555", letterSpacing: "0.15em", marginBottom: 10 }}>REQUEST BODY</div>
              {["name", "email", "age"].map((field) => (
                <div key={field} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>{field}</div>
                  <input
                    value={postBody[field]}
                    onChange={(e) => setPostBody((b) => ({ ...b, [field]: field === "age" ? parseInt(e.target.value) || 0 : e.target.value }))}
                    style={{
                      width: "100%", background: "#0d0d18", border: "1px solid #1e1e2e", borderRadius: 6,
                      padding: "7px 10px", color: "#e2e8f0", fontSize: 12, outline: "none", fontFamily: "inherit"
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Run button */}
          <div style={{ padding: "20px" }}>
            <button
              className="run-btn"
              disabled={running}
              onClick={runSimulation}
              style={{
                width: "100%", padding: "14px", background: running ? "#1a1a0a" : "#facc15",
                color: running ? "#facc15" : "#000", border: "none", borderRadius: 8,
                fontSize: 13, fontWeight: 700, fontFamily: "inherit", letterSpacing: "0.08em"
              }}
            >
              {running ? "⟳ RUNNING..." : "▶ SEND REQUEST"}
            </button>
          </div>

          {/* DB State */}
          <div style={{ padding: "0 20px 20px", flex: 1, overflow: "auto" }}>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: "0.15em", marginBottom: 10 }}>🗄️ DATABASE STATE — users</div>
            <div style={{ border: "1px solid #1a1a2e", borderRadius: 8, overflow: "hidden", fontSize: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "30px 1fr 1fr", background: "#0d0d18", padding: "6px 10px", color: "#555", borderBottom: "1px solid #1a1a2e" }}>
                <span>id</span><span>name</span><span>email</span>
              </div>
              {dbState.users.length === 0 && (
                <div style={{ padding: "12px 10px", color: "#333", textAlign: "center" }}>empty table</div>
              )}
              {dbState.users.map((u) => (
                <div key={u.id} className="db-row" style={{ display: "grid", gridTemplateColumns: "30px 1fr 1fr", padding: "7px 10px", borderBottom: "1px solid #111", color: "#888" }}>
                  <span style={{ color: "#facc15" }}>{u.id}</span>
                  <span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ display: "flex", flexDirection: "column" }}>

          {/* Flow visualization */}
          <div style={{ padding: "28px 32px", borderBottom: "1px solid #1a1a2e", background: "#06060c" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
              {STEPS.map((step, i) => (
                <div key={step} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? 1 : 0 }}>
                  <div
                    className={`step-node ${activeStep === step ? "active" : ""} ${completedSteps.includes(step) ? "done" : ""}`}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                      padding: "12px 16px", borderRadius: 10,
                      background: activeStep === step ? "#1a1a0a" : completedSteps.includes(step) ? "#0a140a" : "#0d0d18",
                      border: `1px solid ${activeStep === step ? "#facc15" : completedSteps.includes(step) ? "#4ade8044" : "#1a1a2e"}`,
                      minWidth: 72,
                    }}
                  >
                    <span className={activeStep === step ? "pulse" : ""} style={{ fontSize: 20 }}>{STEP_ICONS[step]}</span>
                    <span style={{ fontSize: 9, color: activeStep === step ? "#facc15" : completedSteps.includes(step) ? "#4ade80" : "#444", letterSpacing: "0.1em", textAlign: "center" }}>
                      {STEP_LABELS[step].toUpperCase()}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div style={{ flex: 1, height: 2, margin: "0 4px", background: completedSteps.includes(STEPS[i + 1]) ? "#4ade8033" : activeStep === STEPS[i + 1] ? "#facc1555" : "#1a1a2e", position: "relative" }}>
                      {activeStep === STEPS[i + 1] && (
                        <div style={{ position: "absolute", top: -3, left: "30%", width: 8, height: 8, borderRadius: "50%", background: "#facc15", boxShadow: "0 0 8px #facc15", animation: "pulse 0.8s ease-in-out infinite" }} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", flex: 1, minHeight: 0 }}>

            {/* Logs */}
            <div style={{ borderRight: "1px solid #1a1a2e", display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #1a1a2e", fontSize: 10, color: "#555", letterSpacing: "0.15em" }}>
                EXECUTION LOG
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                {logs.length === 0 && (
                  <div style={{ color: "#333", fontSize: 12, textAlign: "center", marginTop: 40 }}>Hit ▶ to start the simulation</div>
                )}
                {logs.map((l, i) => (
                  <div key={i} className="log-line" style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 14 }}>{STEP_ICONS[l.step]}</span>
                      <span style={{ fontSize: 10, color: "#facc15", letterSpacing: "0.1em" }}>{STEP_LABELS[l.step].toUpperCase()}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.7, whiteSpace: "pre-wrap", paddingLeft: 22 }}>{l.log}</div>
                    {l.code && (
                      <pre style={{
                        marginTop: 8, marginLeft: 22, padding: "10px 14px", background: "#0d0d18",
                        border: "1px solid #1a1a2e", borderRadius: 6, fontSize: 10, color: "#60a5fa",
                        overflow: "auto", lineHeight: 1.8, whiteSpace: "pre-wrap"
                      }}>{l.code}</pre>
                    )}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Response */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #1a1a2e", fontSize: 10, color: "#555", letterSpacing: "0.15em" }}>
                RESPONSE
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
                {!finalResult && logs.length === 0 && (
                  <div style={{ color: "#222", fontSize: 12, textAlign: "center", marginTop: 40 }}>
                    Response will appear here
                  </div>
                )}
                {finalResult !== undefined && finalResult !== null && (
                  <div>
                    <div style={{ fontSize: 10, color: "#4ade80", letterSpacing: "0.1em", marginBottom: 12 }}>
                      ✓ SUCCESS
                    </div>
                    <pre style={{
                      padding: "16px", background: "#0a140a", border: "1px solid #1a2e1a",
                      borderRadius: 8, fontSize: 11, color: "#4ade80", overflow: "auto",
                      lineHeight: 1.8, whiteSpace: "pre-wrap"
                    }}>{JSON.stringify(finalResult, null, 2)}</pre>
                  </div>
                )}
                {finalResult === null && completedSteps.includes("response") && (
                  <div>
                    <div style={{ fontSize: 10, color: "#4ade80", letterSpacing: "0.1em", marginBottom: 12 }}>✓ 204 No Content</div>
                    <div style={{ fontSize: 12, color: "#666", padding: "16px", background: "#0a140a", borderRadius: 8, border: "1px solid #1a2e1a" }}>
                      Row deleted. No body returned.
                    </div>
                  </div>
                )}

                {/* Concept callout */}
                {currentStepData && completedSteps.length > 0 && (
                  <div style={{ marginTop: 20, padding: "14px 16px", background: "#0d0d18", border: "1px solid #1e1e2e", borderRadius: 8 }}>
                    <div style={{ fontSize: 10, color: "#facc15", letterSpacing: "0.1em", marginBottom: 8 }}>💡 WHAT'S HAPPENING</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.8 }}>
                      {completedSteps[completedSteps.length - 1] === "client" && "The browser/client sends an HTTP request with method + headers + optional body."}
                      {completedSteps[completedSteps.length - 1] === "network" && "The request travels over TCP/IP. In production, passes through load balancer → server."}
                      {completedSteps[completedSteps.length - 1] === "backend" && "Node.js Express matches the route, calls the handler. This is where auth, validation, and business logic live."}
                      {completedSteps[completedSteps.length - 1] === "query_planner" && "The DB's query planner decides HOW to execute your SQL — index scan vs table scan. This is where performance is won or lost."}
                      {completedSteps[completedSteps.length - 1] === "db" && "Pages are loaded from disk into RAM (buffer pool). Data is filtered, transformed, and returned."}
                      {completedSteps[completedSteps.length - 1] === "response" && "The backend serializes the result to JSON and sends it back with an HTTP status code."}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
