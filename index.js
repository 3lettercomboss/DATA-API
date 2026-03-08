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

    CREATE TABLE IF NOT EXISTS group_tags (
      id                SERIAL PRIMARY KEY,
      name              VARCHAR(50)  NOT NULL UNIQUE,
      group_id          BIGINT       NOT NULL,
      tag               VARCHAR(50)  NOT NULL,
      color             VARCHAR(20),
      bold              BOOLEAN      DEFAULT false,
      italic            BOOLEAN      DEFAULT false,
      font_face         VARCHAR(50),
      font_weight       VARCHAR(50),
      vandel_colors     JSONB        DEFAULT '[]',
      anim_gradient     JSONB,
      gradient_rotation INT,
      offset_range      VARCHAR(50),
      stroke_gradient   JSONB,
      stroke_thickness  FLOAT,
      created_at        TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS player_tags (
      id                SERIAL PRIMARY KEY,
      player_id         BIGINT       NOT NULL,
      sort_order        INT          DEFAULT 0,
      text              VARCHAR(100) NOT NULL,
      color             VARCHAR(20),
      bold              BOOLEAN      DEFAULT false,
      italic            BOOLEAN      DEFAULT false,
      vandel_colors     JSONB        DEFAULT '[]',
      anim_gradient     JSONB,
      font_face         VARCHAR(50),
      font_weight       VARCHAR(50),
      gradient_rotation INT,
      offset_range      VARCHAR(50),
      created_at        TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS player_emojis (
      id         SERIAL PRIMARY KEY,
      player_id  BIGINT       NOT NULL UNIQUE,
      emojis     VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gradient_names (
      id         SERIAL PRIMARY KEY,
      player_id  BIGINT  NOT NULL UNIQUE,
      gradient   JSONB   NOT NULL,
      has_stroke BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
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
//  TAG ENDPOINTS
// =============================================================

// ── Get ALL tag data (game fetches this every 60s) ──────────
// GET /api/tags/all
// Returns: { ok, groupTags, playerTags, playerEmojis, gradientNames }
app.get("/api/tags/all", async (req, res) => {
  try {
    const [groupResult, playerResult, emojiResult, gradientResult] = await Promise.all([
      pool.query("SELECT * FROM group_tags ORDER BY name"),
      pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order"),
      pool.query("SELECT * FROM player_emojis ORDER BY player_id"),
      pool.query("SELECT * FROM gradient_names ORDER BY player_id"),
    ]);

    // Format group tags as array of objects
    const groupTags = groupResult.rows.map((r) => ({
      name: r.name,
      groupId: Number(r.group_id),
      tag: r.tag,
      color: r.color || undefined,
      bold: r.bold || undefined,
      italic: r.italic || undefined,
      fontFace: r.font_face || undefined,
      fontWeight: r.font_weight || undefined,
      vandelColors: r.vandel_colors && r.vandel_colors.length > 0 ? r.vandel_colors : undefined,
      animGradient: r.anim_gradient || undefined,
      gradientRotation: r.gradient_rotation != null ? r.gradient_rotation : undefined,
      offsetRange: r.offset_range || undefined,
      strokeGradient: r.stroke_gradient || undefined,
      strokeThickness: r.stroke_thickness != null ? r.stroke_thickness : undefined,
    }));

    // Format player tags grouped by playerId
    const playerTags = {};
    for (const r of playerResult.rows) {
      const pid = r.player_id.toString();
      if (!playerTags[pid]) playerTags[pid] = [];
      playerTags[pid].push({
        text: r.text,
        color: r.color || undefined,
        bold: r.bold || undefined,
        italic: r.italic || undefined,
        vandelColors: r.vandel_colors && r.vandel_colors.length > 0 ? r.vandel_colors : undefined,
        animGradient: r.anim_gradient || undefined,
        fontFace: r.font_face || undefined,
        fontWeight: r.font_weight || undefined,
        gradientRotation: r.gradient_rotation != null ? r.gradient_rotation : undefined,
        offsetRange: r.offset_range || undefined,
      });
    }

    // Format player emojis
    const playerEmojis = emojiResult.rows.map((r) => ({
      playerId: Number(r.player_id),
      emojis: r.emojis,
    }));

    // Format gradient names
    const gradientNames = gradientResult.rows.map((r) => ({
      playerId: Number(r.player_id),
      gradient: r.gradient,
      hasStroke: r.has_stroke || false,
    }));

    res.json({ ok: true, groupTags, playerTags, playerEmojis, gradientNames });
  } catch (err) {
    console.error("GET /api/tags/all error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── GROUP TAGS ──────────────────────────────────────────────

// GET /api/tags/groups — list all group tags
app.get("/api/tags/groups", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM group_tags ORDER BY name");
    res.json({ ok: true, groupTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/groups error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /api/tags/groups/:name — get a single group tag
app.get("/api/tags/groups/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const result = await pool.query("SELECT * FROM group_tags WHERE name = $1", [name]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Group tag not found" });
    }
    res.json({ ok: true, groupTag: result.rows[0] });
  } catch (err) {
    console.error("GET /api/tags/groups/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/groups — create or update a group tag (upsert)
// Body: { name, groupId, tag, color?, bold?, italic?, fontFace?, fontWeight?,
//         vandelColors?, animGradient?, gradientRotation?, offsetRange?,
//         strokeGradient?, strokeThickness? }
app.post("/api/tags/groups", async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.groupId || !b.tag) {
      return res.status(400).json({ ok: false, error: "name, groupId, and tag are required" });
    }
    const result = await pool.query(
      `INSERT INTO group_tags
        (name, group_id, tag, color, bold, italic, font_face, font_weight,
         vandel_colors, anim_gradient, gradient_rotation, offset_range,
         stroke_gradient, stroke_thickness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (name) DO UPDATE SET
         group_id=$2, tag=$3, color=$4, bold=$5, italic=$6, font_face=$7, font_weight=$8,
         vandel_colors=$9, anim_gradient=$10, gradient_rotation=$11, offset_range=$12,
         stroke_gradient=$13, stroke_thickness=$14
       RETURNING *`,
      [
        b.name, b.groupId, b.tag, b.color || null,
        b.bold || false, b.italic || false,
        b.fontFace || null, b.fontWeight || null,
        JSON.stringify(b.vandelColors || []),
        b.animGradient ? JSON.stringify(b.animGradient) : null,
        b.gradientRotation != null ? b.gradientRotation : null,
        b.offsetRange || null,
        b.strokeGradient ? JSON.stringify(b.strokeGradient) : null,
        b.strokeThickness != null ? b.strokeThickness : null,
      ]
    );
    res.status(201).json({ ok: true, groupTag: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/groups error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/groups/:name — delete a group tag
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

// ── PLAYER TAGS ─────────────────────────────────────────────

// GET /api/tags/players — list all player tags
app.get("/api/tags/players", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order");
    res.json({ ok: true, playerTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/players error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// GET /api/tags/players/:playerId — get all tags for a player
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

// POST /api/tags/players — create a player tag
// Body: { playerId, text, sortOrder?, color?, bold?, italic?, vandelColors?,
//         animGradient?, fontFace?, fontWeight?, gradientRotation?, offsetRange? }
app.post("/api/tags/players", async (req, res) => {
  try {
    const b = req.body;
    if (!b.playerId || !b.text) {
      return res.status(400).json({ ok: false, error: "playerId and text are required" });
    }
    const result = await pool.query(
      `INSERT INTO player_tags
        (player_id, sort_order, text, color, bold, italic, vandel_colors,
         anim_gradient, font_face, font_weight, gradient_rotation, offset_range)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        b.playerId, b.sortOrder || 0, b.text, b.color || null,
        b.bold || false, b.italic || false,
        JSON.stringify(b.vandelColors || []),
        b.animGradient ? JSON.stringify(b.animGradient) : null,
        b.fontFace || null, b.fontWeight || null,
        b.gradientRotation != null ? b.gradientRotation : null,
        b.offsetRange || null,
      ]
    );
    res.status(201).json({ ok: true, playerTag: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/players error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// PUT /api/tags/players/:id — update a player tag by row ID
app.put("/api/tags/players/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    const result = await pool.query(
      `UPDATE player_tags SET
        text = COALESCE($1, text),
        color = $2,
        bold = COALESCE($3, bold),
        italic = COALESCE($4, italic),
        vandel_colors = COALESCE($5, vandel_colors),
        anim_gradient = $6,
        font_face = $7,
        font_weight = $8,
        gradient_rotation = $9,
        offset_range = $10,
        sort_order = COALESCE($11, sort_order)
       WHERE id = $12
       RETURNING *`,
      [
        b.text || null,
        b.color !== undefined ? b.color : null,
        b.bold != null ? b.bold : null,
        b.italic != null ? b.italic : null,
        b.vandelColors ? JSON.stringify(b.vandelColors) : null,
        b.animGradient ? JSON.stringify(b.animGradient) : null,
        b.fontFace !== undefined ? b.fontFace : null,
        b.fontWeight !== undefined ? b.fontWeight : null,
        b.gradientRotation != null ? b.gradientRotation : null,
        b.offsetRange !== undefined ? b.offsetRange : null,
        b.sortOrder != null ? b.sortOrder : null,
        id,
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Player tag not found" });
    }
    res.json({ ok: true, playerTag: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/tags/players/:id error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/players/:id — delete a player tag by row ID
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

// DELETE /api/tags/players/by-player/:playerId — delete ALL tags for a player
app.delete("/api/tags/players/by-player/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query("DELETE FROM player_tags WHERE player_id = $1", [playerId]);
    res.json({ ok: true, message: `Deleted ${result.rowCount} tag(s)` });
  } catch (err) {
    console.error("DELETE /api/tags/players/by-player/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── PLAYER EMOJIS ───────────────────────────────────────────

// GET /api/tags/emojis — list all player emojis
app.get("/api/tags/emojis", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_emojis ORDER BY player_id");
    res.json({ ok: true, playerEmojis: result.rows });
  } catch (err) {
    console.error("GET /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/emojis — create or update player emojis (upsert)
// Body: { playerId, emojis }
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
      [playerId, emojis]
    );
    res.status(201).json({ ok: true, playerEmoji: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/emojis/:playerId — delete player emojis
app.delete("/api/tags/emojis/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await pool.query("DELETE FROM player_emojis WHERE player_id = $1", [playerId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Player emoji not found" });
    }
    res.json({ ok: true, message: "Player emoji deleted" });
  } catch (err) {
    console.error("DELETE /api/tags/emojis/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// ── GRADIENT NAMES ──────────────────────────────────────────

// GET /api/tags/gradients — list all gradient names
app.get("/api/tags/gradients", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM gradient_names ORDER BY player_id");
    res.json({ ok: true, gradientNames: result.rows });
  } catch (err) {
    console.error("GET /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// POST /api/tags/gradients — create or update a gradient name (upsert)
// Body: { playerId, gradient: [{t,r,g,b}, ...], hasStroke? }
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
    res.status(201).json({ ok: true, gradientName: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// DELETE /api/tags/gradients/:playerId — delete a gradient name
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
