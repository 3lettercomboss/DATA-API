// ============================================================
//  Roblox Crew Tags API — Railway + PostgreSQL
//  Endpoints are designed for Roblox HttpService (JSON in/out)
// ============================================================

require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ── Database ────────────────────────────────────────────────
// Railway injects DATABASE_URL automatically when you add the
// PostgreSQL plugin to your project.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ── Auth middleware ─────────────────────────────────────────
// Set API_KEY in Railway env vars. Your Roblox game sends it
// in the "x-api-key" header so outsiders can't hit your API.
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!process.env.API_KEY) return next(); // no key set = open (dev mode)
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}
app.use("/api", auth);

// ── Bootstrap tables on startup ─────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crews (
      id          SERIAL PRIMARY KEY,
      tag         VARCHAR(10)  NOT NULL UNIQUE,
      name        VARCHAR(50)  NOT NULL,
      owner_id    BIGINT       NOT NULL,
      color       VARCHAR(7)   DEFAULT '#FFFFFF',
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crew_members (
      id          SERIAL PRIMARY KEY,
      crew_id     INT    NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
      player_id   BIGINT NOT NULL,
      role        VARCHAR(20) DEFAULT 'member',
      joined_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(crew_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_members_player ON crew_members(player_id);

    CREATE TABLE IF NOT EXISTS whitelists (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(50)  NOT NULL UNIQUE,
      player_ids  JSONB        NOT NULL DEFAULT '[]',
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  console.log("✅ Database tables ready");
}

// ── Health check ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "roblox-crew-api" });
});

// =============================================================
//  CREW ENDPOINTS
// =============================================================

// ── Create a crew ───────────────────────────────────────────
// POST /api/crews
// Body: { tag, name, ownerId, color? }
app.post("/api/crews", async (req, res) => {
  try {
    const { tag, name, ownerId, color } = req.body;

    if (!tag || !name || !ownerId) {
      return res.status(400).json({ ok: false, error: "tag, name, and ownerId are required" });
    }

    if (tag.length > 10) {
      return res.status(400).json({ ok: false, error: "Tag must be 10 characters or less" });
    }

    // Check if player already owns a crew
    const existing = await pool.query("SELECT id FROM crews WHERE owner_id = $1", [ownerId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, error: "Player already owns a crew" });
    }

    const result = await pool.query(
      `INSERT INTO crews (tag, name, owner_id, color)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tag.toUpperCase(), name, ownerId, color || "#FFFFFF"]
    );

    const crew = result.rows[0];

    // Auto-add owner as leader
    await pool.query(
      `INSERT INTO crew_members (crew_id, player_id, role) VALUES ($1, $2, 'leader')`,
      [crew.id, ownerId]
    );

    res.status(201).json({ ok: true, crew });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, error: "Tag already taken" });
    }
    console.error("POST /api/crews error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Get all crews (with member count) ───────────────────────
// GET /api/crews?limit=50&offset=0
app.get("/api/crews", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS member_count
       FROM crews c
       LEFT JOIN crew_members cm ON cm.crew_id = c.id
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ ok: true, crews: result.rows });
  } catch (err) {
    console.error("GET /api/crews error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Get crew by tag ─────────────────────────────────────────
// GET /api/crews/:tag
app.get("/api/crews/:tag", async (req, res) => {
  try {
    const { tag } = req.params;

    const crewResult = await pool.query("SELECT * FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crewResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    const crew = crewResult.rows[0];

    const membersResult = await pool.query(
      `SELECT player_id, role, joined_at FROM crew_members WHERE crew_id = $1 ORDER BY joined_at`,
      [crew.id]
    );

    res.json({ ok: true, crew, members: membersResult.rows });
  } catch (err) {
    console.error("GET /api/crews/:tag error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Update a crew (owner only) ──────────────────────────────
// PUT /api/crews/:tag
// Body: { ownerId, name?, color? }
app.put("/api/crews/:tag", async (req, res) => {
  try {
    const { tag } = req.params;
    const { ownerId, name, color } = req.body;

    if (!ownerId) {
      return res.status(400).json({ ok: false, error: "ownerId is required" });
    }

    const crew = await pool.query("SELECT * FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    if (crew.rows[0].owner_id.toString() !== ownerId.toString()) {
      return res.status(403).json({ ok: false, error: "Only the owner can update this crew" });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (name) { updates.push(`name = $${idx++}`); values.push(name); }
    if (color) { updates.push(`color = $${idx++}`); values.push(color); }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    values.push(tag.toUpperCase());
    const result = await pool.query(
      `UPDATE crews SET ${updates.join(", ")} WHERE tag = $${idx} RETURNING *`,
      values
    );

    res.json({ ok: true, crew: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/crews/:tag error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Delete a crew (owner only) ──────────────────────────────
// DELETE /api/crews/:tag
// Body: { ownerId }
app.delete("/api/crews/:tag", async (req, res) => {
  try {
    const { tag } = req.params;
    const { ownerId } = req.body;

    if (!ownerId) {
      return res.status(400).json({ ok: false, error: "ownerId is required" });
    }

    const crew = await pool.query("SELECT * FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    if (crew.rows[0].owner_id.toString() !== ownerId.toString()) {
      return res.status(403).json({ ok: false, error: "Only the owner can delete this crew" });
    }

    await pool.query("DELETE FROM crews WHERE tag = $1", [tag.toUpperCase()]);

    res.json({ ok: true, message: "Crew deleted" });
  } catch (err) {
    console.error("DELETE /api/crews/:tag error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// =============================================================
//  MEMBER ENDPOINTS
// =============================================================

// ── Add member to crew ──────────────────────────────────────
// POST /api/crews/:tag/members
// Body: { playerId, role? }
app.post("/api/crews/:tag/members", async (req, res) => {
  try {
    const { tag } = req.params;
    const { playerId, role } = req.body;

    if (!playerId) {
      return res.status(400).json({ ok: false, error: "playerId is required" });
    }

    const crew = await pool.query("SELECT id FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    // Check if player is already in any crew
    const alreadyIn = await pool.query("SELECT id FROM crew_members WHERE player_id = $1", [playerId]);
    if (alreadyIn.rows.length > 0) {
      return res.status(409).json({ ok: false, error: "Player is already in a crew" });
    }

    await pool.query(
      `INSERT INTO crew_members (crew_id, player_id, role) VALUES ($1, $2, $3)`,
      [crew.rows[0].id, playerId, role || "member"]
    );

    res.status(201).json({ ok: true, message: "Member added" });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, error: "Player already in this crew" });
    }
    console.error("POST /api/crews/:tag/members error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Remove member from crew ─────────────────────────────────
// DELETE /api/crews/:tag/members/:playerId
app.delete("/api/crews/:tag/members/:playerId", async (req, res) => {
  try {
    const { tag, playerId } = req.params;

    const crew = await pool.query("SELECT id, owner_id FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    // Prevent removing the owner
    if (crew.rows[0].owner_id.toString() === playerId.toString()) {
      return res.status(400).json({ ok: false, error: "Cannot remove the crew owner. Delete the crew instead." });
    }

    const result = await pool.query(
      "DELETE FROM crew_members WHERE crew_id = $1 AND player_id = $2",
      [crew.rows[0].id, playerId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Member not found in this crew" });
    }

    res.json({ ok: true, message: "Member removed" });
  } catch (err) {
    console.error("DELETE /api/crews/:tag/members/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Get a player's crew ─────────────────────────────────────
// GET /api/players/:playerId/crew
app.get("/api/players/:playerId/crew", async (req, res) => {
  try {
    const { playerId } = req.params;

    const result = await pool.query(
      `SELECT c.*, cm.role, cm.joined_at AS member_since
       FROM crew_members cm
       JOIN crews c ON c.id = cm.crew_id
       WHERE cm.player_id = $1`,
      [playerId]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: true, crew: null });
    }

    res.json({ ok: true, crew: result.rows[0] });
  } catch (err) {
    console.error("GET /api/players/:playerId/crew error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Transfer crew ownership ─────────────────────────────────
// POST /api/crews/:tag/transfer
// Body: { ownerId, newOwnerId }
app.post("/api/crews/:tag/transfer", async (req, res) => {
  try {
    const { tag } = req.params;
    const { ownerId, newOwnerId } = req.body;

    if (!ownerId || !newOwnerId) {
      return res.status(400).json({ ok: false, error: "ownerId and newOwnerId are required" });
    }

    const crew = await pool.query("SELECT * FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }

    if (crew.rows[0].owner_id.toString() !== ownerId.toString()) {
      return res.status(403).json({ ok: false, error: "Only the owner can transfer ownership" });
    }

    // New owner must be a member
    const member = await pool.query(
      "SELECT id FROM crew_members WHERE crew_id = $1 AND player_id = $2",
      [crew.rows[0].id, newOwnerId]
    );
    if (member.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "New owner must be a crew member" });
    }

    // Transfer
    await pool.query("UPDATE crews SET owner_id = $1 WHERE id = $2", [newOwnerId, crew.rows[0].id]);
    await pool.query("UPDATE crew_members SET role = 'leader' WHERE crew_id = $1 AND player_id = $2", [crew.rows[0].id, newOwnerId]);
    await pool.query("UPDATE crew_members SET role = 'member' WHERE crew_id = $1 AND player_id = $2", [crew.rows[0].id, ownerId]);

    res.json({ ok: true, message: "Ownership transferred" });
  } catch (err) {
    console.error("POST /api/crews/:tag/transfer error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// =============================================================
//  WHITELIST ENDPOINTS
// =============================================================

// ── Get all whitelists (game fetches this) ──────────────────
// GET /api/whitelists/all
app.get("/api/whitelists/all", async (req, res) => {
  try {
    const result = await pool.query("SELECT name, player_ids FROM whitelists ORDER BY name");
    const out = {};
    for (const row of result.rows) {
      out[row.name] = row.player_ids;
    }
    res.json({ ok: true, whitelists: out });
  } catch (err) {
    console.error("GET /api/whitelists/all error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── List all whitelists (with metadata) ─────────────────────
// GET /api/whitelists
app.get("/api/whitelists", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT name, jsonb_array_length(player_ids) AS count, updated_at FROM whitelists ORDER BY name"
    );
    res.json({ ok: true, whitelists: result.rows });
  } catch (err) {
    console.error("GET /api/whitelists error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Get a single whitelist ──────────────────────────────────
// GET /api/whitelists/:name
app.get("/api/whitelists/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const result = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    res.json({ ok: true, whitelist: result.rows[0] });
  } catch (err) {
    console.error("GET /api/whitelists/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Create or replace a whitelist ───────────────────────────
// POST /api/whitelists
// Body: { name, playerIds: [123, 456, ...] }
app.post("/api/whitelists", async (req, res) => {
  try {
    const { name, playerIds } = req.body;
    if (!name || !Array.isArray(playerIds)) {
      return res.status(400).json({ ok: false, error: "name and playerIds (array) are required" });
    }
    const result = await pool.query(
      `INSERT INTO whitelists (name, player_ids, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (name) DO UPDATE SET player_ids = $2, updated_at = NOW()
       RETURNING *`,
      [name, JSON.stringify(playerIds)]
    );
    res.status(201).json({ ok: true, whitelist: result.rows[0] });
  } catch (err) {
    console.error("POST /api/whitelists error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Add a player to a whitelist ─────────────────────────────
// POST /api/whitelists/:name/add
// Body: { playerId }
app.post("/api/whitelists/:name/add", async (req, res) => {
  try {
    const { name } = req.params;
    const { playerId } = req.body;
    if (!playerId) {
      return res.status(400).json({ ok: false, error: "playerId is required" });
    }
    const wl = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (wl.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    const ids = wl.rows[0].player_ids;
    if (ids.includes(playerId)) {
      return res.status(409).json({ ok: false, error: "Player already in whitelist" });
    }
    ids.push(playerId);
    await pool.query(
      "UPDATE whitelists SET player_ids = $1, updated_at = NOW() WHERE name = $2",
      [JSON.stringify(ids), name]
    );
    res.json({ ok: true, message: "Player added", playerIds: ids });
  } catch (err) {
    console.error("POST /api/whitelists/:name/add error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Remove a player from a whitelist ────────────────────────
// POST /api/whitelists/:name/remove
// Body: { playerId }
app.post("/api/whitelists/:name/remove", async (req, res) => {
  try {
    const { name } = req.params;
    const { playerId } = req.body;
    if (!playerId) {
      return res.status(400).json({ ok: false, error: "playerId is required" });
    }
    const wl = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (wl.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    const ids = wl.rows[0].player_ids.filter((id) => id !== playerId);
    if (ids.length === wl.rows[0].player_ids.length) {
      return res.status(404).json({ ok: false, error: "Player not in whitelist" });
    }
    await pool.query(
      "UPDATE whitelists SET player_ids = $1, updated_at = NOW() WHERE name = $2",
      [JSON.stringify(ids), name]
    );
    res.json({ ok: true, message: "Player removed", playerIds: ids });
  } catch (err) {
    console.error("POST /api/whitelists/:name/remove error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Delete a whitelist entirely ─────────────────────────────
// DELETE /api/whitelists/:name
app.delete("/api/whitelists/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const result = await pool.query("DELETE FROM whitelists WHERE name = $1", [name]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    res.json({ ok: true, message: "Whitelist deleted" });
  } catch (err) {
    console.error("DELETE /api/whitelists/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── Start server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Crew API running on port ${PORT}`);
  });
}).catch((err) => {
  console.error("❌ Failed to initialize database:", err);
  process.exit(1);
});
