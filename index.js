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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ── Auth middleware ─────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!process.env.API_KEY) return next();
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}
app.use("/api", auth);

// ── Bootstrap tables on startup (with retries) ─────────────
async function initDB(retries = 5, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await _createTables();
    } catch (err) {
      console.log(`⏳ DB connection attempt ${i + 1}/${retries} failed, retrying in ${delay / 1000}s...`);
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function _createTables() {
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

    -- ═══════════════════════════════════════════════════
    --  TAG SYSTEM TABLES
    -- ═══════════════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS group_tags (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(100) NOT NULL UNIQUE,
      group_id          BIGINT NOT NULL,
      tag               VARCHAR(100) NOT NULL,
      color             VARCHAR(7),
      bold              BOOLEAN DEFAULT false,
      italic            BOOLEAN DEFAULT false,
      font_face         VARCHAR(50),
      font_weight       VARCHAR(20),
      vandel_colors     JSONB,
      anim_gradient     JSONB,
      gradient_rotation FLOAT,
      offset_range      JSONB,
      stroke_gradient   JSONB,
      stroke_thickness  FLOAT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS player_tags (
      id                SERIAL PRIMARY KEY,
      player_id         BIGINT NOT NULL,
      tag_text          VARCHAR(100) NOT NULL,
      color             VARCHAR(7),
      bold              BOOLEAN DEFAULT false,
      italic            BOOLEAN DEFAULT false,
      vandel_colors     JSONB,
      anim_gradient     JSONB,
      font_face         VARCHAR(50),
      font_weight       VARCHAR(20),
      gradient_rotation FLOAT,
      offset_range      JSONB,
      sort_order        INT DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_player_tags_pid ON player_tags(player_id);

    CREATE TABLE IF NOT EXISTS player_emojis (
      id          SERIAL PRIMARY KEY,
      player_id   BIGINT NOT NULL UNIQUE,
      emojis      JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gradient_names (
      id          SERIAL PRIMARY KEY,
      player_id   BIGINT NOT NULL UNIQUE,
      gradient    JSONB NOT NULL,
      has_stroke  BOOLEAN DEFAULT false,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ Database tables ready");
}

// ── Health check ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "roblox-crew-api" });
});

// =============================================================
//  CREW ENDPOINTS (existing — unchanged)
// =============================================================

app.post("/api/crews", async (req, res) => {
  try {
    const { tag, name, ownerId, color } = req.body;
    if (!tag || !name || !ownerId) {
      return res.status(400).json({ ok: false, error: "tag, name, and ownerId are required" });
    }
    if (tag.length > 10) {
      return res.status(400).json({ ok: false, error: "Tag must be 10 characters or less" });
    }
    const existing = await pool.query("SELECT id FROM crews WHERE owner_id = $1", [ownerId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, error: "Player already owns a crew" });
    }
    const result = await pool.query(
      `INSERT INTO crews (tag, name, owner_id, color) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tag.toUpperCase(), name, ownerId, color || "#FFFFFF"]
    );
    const crew = result.rows[0];
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

app.get("/api/crews", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const result = await pool.query(
      `SELECT c.*, COUNT(cm.id)::int AS member_count
       FROM crews c LEFT JOIN crew_members cm ON cm.crew_id = c.id
       GROUP BY c.id ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, crews: result.rows });
  } catch (err) {
    console.error("GET /api/crews error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

app.delete("/api/crews/:tag/members/:playerId", async (req, res) => {
  try {
    const { tag, playerId } = req.params;
    const crew = await pool.query("SELECT id, owner_id FROM crews WHERE tag = $1", [tag.toUpperCase()]);
    if (crew.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Crew not found" });
    }
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

app.get("/api/players/:playerId/crew", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query(
      `SELECT c.*, cm.role, cm.joined_at AS member_since
       FROM crew_members cm JOIN crews c ON c.id = cm.crew_id
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
    const member = await pool.query(
      "SELECT id FROM crew_members WHERE crew_id = $1 AND player_id = $2",
      [crew.rows[0].id, newOwnerId]
    );
    if (member.rows.length === 0) {
      return res.status(400).json({ ok: false, error: "New owner must be a crew member" });
    }
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
//  TAG SYSTEM ENDPOINTS
// =============================================================

// ── Get ALL tag data in one call (for Roblox game servers) ──
// GET /api/tags/all
// Returns: { groupTags, playerTags, playerEmojis, gradientNames }
app.get("/api/tags/all", async (req, res) => {
  try {
    const [groupTagsRes, playerTagsRes, playerEmojisRes, gradientNamesRes] = await Promise.all([
      pool.query("SELECT * FROM group_tags ORDER BY name"),
      pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order"),
      pool.query("SELECT * FROM player_emojis"),
      pool.query("SELECT * FROM gradient_names"),
    ]);

    // Group player_tags by player_id
    const playerTagsMap = {};
    for (const row of playerTagsRes.rows) {
      const pid = row.player_id.toString();
      if (!playerTagsMap[pid]) playerTagsMap[pid] = [];
      playerTagsMap[pid].push({
        text: row.tag_text,
        color: row.color,
        bold: row.bold,
        italic: row.italic,
        vandelColors: row.vandel_colors,
        animGradient: row.anim_gradient,
        fontFace: row.font_face,
        fontWeight: row.font_weight,
        gradientRotation: row.gradient_rotation,
        offsetRange: row.offset_range,
      });
    }

    res.json({
      ok: true,
      groupTags: groupTagsRes.rows.map((r) => ({
        name: r.name,
        groupId: Number(r.group_id),
        tag: r.tag,
        color: r.color,
        bold: r.bold,
        italic: r.italic,
        fontFace: r.font_face,
        fontWeight: r.font_weight,
        vandelColors: r.vandel_colors,
        animGradient: r.anim_gradient,
        gradientRotation: r.gradient_rotation,
        offsetRange: r.offset_range,
        strokeGradient: r.stroke_gradient,
        strokeThickness: r.stroke_thickness,
      })),
      playerTags: playerTagsMap,
      playerEmojis: playerEmojisRes.rows.map((r) => ({
        playerId: Number(r.player_id),
        emojis: r.emojis,
      })),
      gradientNames: gradientNamesRes.rows.map((r) => ({
        playerId: Number(r.player_id),
        gradient: r.gradient,
        hasStroke: r.has_stroke,
      })),
    });
  } catch (err) {
    console.error("GET /api/tags/all error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════
//  GROUP TAGS CRUD
// ═══════════════════════════════════════════════════

// GET /api/tags/groups
app.get("/api/tags/groups", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM group_tags ORDER BY name");
    res.json({ ok: true, groupTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/groups error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/groups
// Body: { name, groupId, tag, color?, bold?, italic?, fontFace?, fontWeight?,
//         vandelColors?, animGradient?, gradientRotation?, offsetRange?,
//         strokeGradient?, strokeThickness? }
//
// animGradient format: [{ t: 0.0, r: 70, g: 0, b: 0 }, ...]
// vandelColors format: ["#FFFFFF", "#DFE9FF", ...]
app.post("/api/tags/groups", async (req, res) => {
  try {
    const {
      name, groupId, tag, color, bold, italic, fontFace, fontWeight,
      vandelColors, animGradient, gradientRotation, offsetRange,
      strokeGradient, strokeThickness,
    } = req.body;

    if (!name || !groupId || !tag) {
      return res.status(400).json({ ok: false, error: "name, groupId, and tag are required" });
    }

    const result = await pool.query(
      `INSERT INTO group_tags
        (name, group_id, tag, color, bold, italic, font_face, font_weight,
         vandel_colors, anim_gradient, gradient_rotation, offset_range,
         stroke_gradient, stroke_thickness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        name, groupId, tag, color || null, bold || false, italic || false,
        fontFace || null, fontWeight || null,
        vandelColors ? JSON.stringify(vandelColors) : null,
        animGradient ? JSON.stringify(animGradient) : null,
        gradientRotation || null,
        offsetRange ? JSON.stringify(offsetRange) : null,
        strokeGradient ? JSON.stringify(strokeGradient) : null,
        strokeThickness || null,
      ]
    );

    res.status(201).json({ ok: true, groupTag: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ ok: false, error: "A group tag with that name already exists" });
    }
    console.error("POST /api/tags/groups error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// PUT /api/tags/groups/:name
app.put("/api/tags/groups/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const fields = req.body;

    const existing = await pool.query("SELECT id FROM group_tags WHERE name = $1", [name]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Group tag not found" });
    }

    const allowedFields = {
      group_id: "groupId", tag: "tag", color: "color", bold: "bold", italic: "italic",
      font_face: "fontFace", font_weight: "fontWeight", vandel_colors: "vandelColors",
      anim_gradient: "animGradient", gradient_rotation: "gradientRotation",
      offset_range: "offsetRange", stroke_gradient: "strokeGradient",
      stroke_thickness: "strokeThickness",
    };

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [dbCol, bodyKey] of Object.entries(allowedFields)) {
      if (fields[bodyKey] !== undefined) {
        updates.push(`${dbCol} = $${idx++}`);
        const val = fields[bodyKey];
        values.push(typeof val === "object" && val !== null ? JSON.stringify(val) : val);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: "Nothing to update" });
    }

    updates.push(`updated_at = NOW()`);
    values.push(name);

    const result = await pool.query(
      `UPDATE group_tags SET ${updates.join(", ")} WHERE name = $${idx} RETURNING *`,
      values
    );

    res.json({ ok: true, groupTag: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/tags/groups/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/groups/:name
app.delete("/api/tags/groups/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const result = await pool.query("DELETE FROM group_tags WHERE name = $1", [name]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Group tag not found" });
    }
    res.json({ ok: true, message: "Group tag deleted" });
  } catch (err) {
    console.error("DELETE /api/tags/groups/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════
//  PLAYER TAGS CRUD
// ═══════════════════════════════════════════════════

// GET /api/tags/players
app.get("/api/tags/players", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order");
    res.json({ ok: true, playerTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/players error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /api/tags/players/:playerId
app.get("/api/tags/players/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query(
      "SELECT * FROM player_tags WHERE player_id = $1 ORDER BY sort_order",
      [playerId]
    );
    res.json({ ok: true, playerTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/players/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/players
// Body: { playerId, text, color?, bold?, italic?, vandelColors?, animGradient?,
//         fontFace?, fontWeight?, gradientRotation?, offsetRange?, sortOrder? }
app.post("/api/tags/players", async (req, res) => {
  try {
    const {
      playerId, text, color, bold, italic, vandelColors, animGradient,
      fontFace, fontWeight, gradientRotation, offsetRange, sortOrder,
    } = req.body;

    if (!playerId || !text) {
      return res.status(400).json({ ok: false, error: "playerId and text are required" });
    }

    const result = await pool.query(
      `INSERT INTO player_tags
        (player_id, tag_text, color, bold, italic, vandel_colors, anim_gradient,
         font_face, font_weight, gradient_rotation, offset_range, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        playerId, text, color || null, bold || false, italic || false,
        vandelColors ? JSON.stringify(vandelColors) : null,
        animGradient ? JSON.stringify(animGradient) : null,
        fontFace || null, fontWeight || null,
        gradientRotation || null,
        offsetRange ? JSON.stringify(offsetRange) : null,
        sortOrder || 0,
      ]
    );

    res.status(201).json({ ok: true, playerTag: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/players error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/players/:id
app.delete("/api/tags/players/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM player_tags WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Player tag not found" });
    }
    res.json({ ok: true, message: "Player tag deleted" });
  } catch (err) {
    console.error("DELETE /api/tags/players/:id error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// Delete all tags for a player
// DELETE /api/tags/players/by-player/:playerId
app.delete("/api/tags/players/by-player/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    await pool.query("DELETE FROM player_tags WHERE player_id = $1", [playerId]);
    res.json({ ok: true, message: "All tags removed for player" });
  } catch (err) {
    console.error("DELETE /api/tags/players/by-player/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════
//  PLAYER EMOJIS CRUD
// ═══════════════════════════════════════════════════

// GET /api/tags/emojis
app.get("/api/tags/emojis", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_emojis");
    res.json({ ok: true, playerEmojis: result.rows });
  } catch (err) {
    console.error("GET /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/emojis  (upsert — set emojis for a player)
// Body: { playerId, emojis: ["🐹", "🎀"] }
app.post("/api/tags/emojis", async (req, res) => {
  try {
    const { playerId, emojis } = req.body;
    if (!playerId || !emojis) {
      return res.status(400).json({ ok: false, error: "playerId and emojis are required" });
    }

    const result = await pool.query(
      `INSERT INTO player_emojis (player_id, emojis)
       VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET emojis = $2
       RETURNING *`,
      [playerId, JSON.stringify(emojis)]
    );

    res.json({ ok: true, playerEmoji: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/emojis/:playerId
app.delete("/api/tags/emojis/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query("DELETE FROM player_emojis WHERE player_id = $1", [playerId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Player emojis not found" });
    }
    res.json({ ok: true, message: "Player emojis deleted" });
  } catch (err) {
    console.error("DELETE /api/tags/emojis/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ═══════════════════════════════════════════════════
//  GRADIENT NAMES CRUD
// ═══════════════════════════════════════════════════

// GET /api/tags/gradients
app.get("/api/tags/gradients", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM gradient_names");
    res.json({ ok: true, gradientNames: result.rows });
  } catch (err) {
    console.error("GET /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/gradients  (upsert — set gradient for a player)
// Body: { playerId, gradient: [{t:0,r:168,g:168,b:168}, ...], hasStroke?: true }
app.post("/api/tags/gradients", async (req, res) => {
  try {
    const { playerId, gradient, hasStroke } = req.body;
    if (!playerId || !gradient) {
      return res.status(400).json({ ok: false, error: "playerId and gradient are required" });
    }

    const result = await pool.query(
      `INSERT INTO gradient_names (player_id, gradient, has_stroke)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id) DO UPDATE SET gradient = $2, has_stroke = $3
       RETURNING *`,
      [playerId, JSON.stringify(gradient), hasStroke || false]
    );

    res.json({ ok: true, gradientName: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/gradients/:playerId
app.delete("/api/tags/gradients/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query("DELETE FROM gradient_names WHERE player_id = $1", [playerId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Gradient name not found" });
    }
    res.json({ ok: true, message: "Gradient name deleted" });
  } catch (err) {
    console.error("DELETE /api/tags/gradients/:playerId error:", err);
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
