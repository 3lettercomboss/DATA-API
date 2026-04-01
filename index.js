require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!process.env.API_KEY) return next();
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}
app.use("/api", auth);

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

    CREATE TABLE IF NOT EXISTS banned_players (
      id              SERIAL PRIMARY KEY,
      player_id       BIGINT       NOT NULL UNIQUE,
      username        VARCHAR(50)  DEFAULT '',
      display_name    VARCHAR(50)  DEFAULT '',
      banned          BOOLEAN      DEFAULT true,
      ban_reason      TEXT         DEFAULT '',
      ban_time        BIGINT       DEFAULT 0,
      action_taken_by VARCHAR(50)  DEFAULT '',
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS previous_bans (
      id              SERIAL PRIMARY KEY,
      player_id       BIGINT       NOT NULL,
      reason          TEXT         DEFAULT '',
      time            BIGINT       NOT NULL,
      action_taken_by VARCHAR(50)  DEFAULT 'Unknown',
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_previous_bans_player ON previous_bans(player_id);
  `);
  console.log("Database tables ready");
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "roblox-crew-api" });
});

// =============================================================
//  CREW ENDPOINTS
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

// =============================================================
//  MEMBER ENDPOINTS
// =============================================================

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
//  TAG ENDPOINTS
// =============================================================

app.get("/api/tags/all", async (req, res) => {
  try {
    const [groupResult, playerResult, emojiResult, gradientResult] = await Promise.all([
      pool.query("SELECT * FROM group_tags ORDER BY name"),
      pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order"),
      pool.query("SELECT * FROM player_emojis ORDER BY player_id"),
      pool.query("SELECT * FROM gradient_names ORDER BY player_id"),
    ]);

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

    const playerEmojis = emojiResult.rows.map((r) => ({
      playerId: Number(r.player_id),
      emojis: r.emojis,
    }));

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

app.get("/api/tags/groups", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM group_tags ORDER BY name");
    res.json({ ok: true, groupTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/groups error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

app.get("/api/tags/players", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_tags ORDER BY player_id, sort_order");
    res.json({ ok: true, playerTags: result.rows });
  } catch (err) {
    console.error("GET /api/tags/players error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

app.get("/api/tags/emojis", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM player_emojis ORDER BY player_id");
    res.json({ ok: true, playerEmojis: result.rows });
  } catch (err) {
    console.error("GET /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/tags/emojis", async (req, res) => {
  try {
    const { playerId, emojis } = req.body;
    if (!playerId || !emojis) {
      return res.status(400).json({ ok: false, error: "playerId and emojis are required" });
    }
    const result = await pool.query(
      `INSERT INTO player_emojis (player_id, emojis) VALUES ($1, $2)
       ON CONFLICT (player_id) DO UPDATE SET emojis = $2 RETURNING *`,
      [playerId, emojis]
    );
    res.status(201).json({ ok: true, playerEmoji: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/emojis error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

app.get("/api/tags/gradients", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM gradient_names ORDER BY player_id");
    res.json({ ok: true, gradientNames: result.rows });
  } catch (err) {
    console.error("GET /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/tags/gradients", async (req, res) => {
  try {
    const { playerId, gradient, hasStroke } = req.body;
    if (!playerId || !gradient) {
      return res.status(400).json({ ok: false, error: "playerId and gradient are required" });
    }
    const result = await pool.query(
      `INSERT INTO gradient_names (player_id, gradient, has_stroke) VALUES ($1, $2, $3)
       ON CONFLICT (player_id) DO UPDATE SET gradient = $2, has_stroke = $3 RETURNING *`,
      [playerId, JSON.stringify(gradient), hasStroke || false]
    );
    res.status(201).json({ ok: true, gradientName: result.rows[0] });
  } catch (err) {
    console.error("POST /api/tags/gradients error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

app.get("/api/whitelists/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const result = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    const row = result.rows[0];
    res.json({ ok: true, name: row.name, playerIds: row.player_ids, whitelist: row });
  } catch (err) {
    console.error("GET /api/whitelists/:name error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/whitelists", async (req, res) => {
  try {
    const { name, playerIds } = req.body;
    if (!name || !Array.isArray(playerIds)) {
      return res.status(400).json({ ok: false, error: "name and playerIds (array) are required" });
    }
    const result = await pool.query(
      `INSERT INTO whitelists (name, player_ids, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (name) DO UPDATE SET player_ids = $2, updated_at = NOW() RETURNING *`,
      [name, JSON.stringify(playerIds)]
    );
    res.status(201).json({ ok: true, whitelist: result.rows[0] });
  } catch (err) {
    console.error("POST /api/whitelists error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/whitelists/:name/add", async (req, res) => {
  try {
    const { name } = req.params;
    const raw = req.body.playerId ?? req.body.playerIds;
    if (!raw) {
      return res.status(400).json({ ok: false, error: "playerId is required" });
    }
    const toAdd = (Array.isArray(raw) ? raw.flat() : [raw]).map(Number).filter(Boolean);
    if (toAdd.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid player IDs provided" });
    }
    const wl = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (wl.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    const ids = wl.rows[0].player_ids;
    let added = 0;
    for (const pid of toAdd) {
      if (!ids.includes(pid)) {
        ids.push(pid);
        added++;
      }
    }
    if (added === 0) {
      return res.status(409).json({ ok: false, error: "Player(s) already in whitelist" });
    }
    await pool.query(
      "UPDATE whitelists SET player_ids = $1, updated_at = NOW() WHERE name = $2",
      [JSON.stringify(ids), name]
    );
    res.json({ ok: true, message: `Added ${added} player(s)`, playerIds: ids });
  } catch (err) {
    console.error("POST /api/whitelists/:name/add error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/whitelists/:name/remove", async (req, res) => {
  try {
    const { name } = req.params;
    const raw = req.body.playerId ?? req.body.playerIds;
    if (!raw) {
      return res.status(400).json({ ok: false, error: "playerId is required" });
    }
    const toRemove = new Set((Array.isArray(raw) ? raw.flat() : [raw]).map(Number));
    const wl = await pool.query("SELECT * FROM whitelists WHERE name = $1", [name]);
    if (wl.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Whitelist not found" });
    }
    const before = wl.rows[0].player_ids.length;
    const ids = wl.rows[0].player_ids.filter((id) => !toRemove.has(id));
    if (ids.length === before) {
      return res.status(404).json({ ok: false, error: "Player(s) not in whitelist" });
    }
    await pool.query(
      "UPDATE whitelists SET player_ids = $1, updated_at = NOW() WHERE name = $2",
      [JSON.stringify(ids), name]
    );
    res.json({ ok: true, message: `Removed ${before - ids.length} player(s)`, playerIds: ids });
  } catch (err) {
    console.error("POST /api/whitelists/:name/remove error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

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

// =============================================================
//  MODERATION / BAN ENDPOINTS
// =============================================================

app.get("/api/moderation/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const playerResult = await pool.query(
      "SELECT * FROM banned_players WHERE player_id = $1",
      [playerId]
    );
    if (playerResult.rows.length === 0) {
      return res.json({ ok: true, data: null });
    }
    const row = playerResult.rows[0];
    const prevResult = await pool.query(
      "SELECT reason, time, action_taken_by FROM previous_bans WHERE player_id = $1 ORDER BY time",
      [playerId]
    );
    const data = {
      UserId: Number(row.player_id),
      Username: row.username,
      DisplayName: row.display_name,
      Banned: row.banned,
      BanReason: row.ban_reason,
      BanTime: Number(row.ban_time),
      ActionTakenBy: row.action_taken_by,
      PreviousBans: prevResult.rows.length > 0
        ? prevResult.rows.reduce((acc, r, i) => {
            acc[`-ban${i}`] = { Reason: r.reason, Time: Number(r.time), ActionTakenBy: r.action_taken_by };
            return acc;
          }, {})
        : null,
    };
    res.json({ ok: true, data });
  } catch (err) {
    console.error("GET /api/moderation/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.put("/api/moderation/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const b = req.body;
    const result = await pool.query(
      `INSERT INTO banned_players (player_id, username, display_name, banned, ban_reason, ban_time, action_taken_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         username = COALESCE($2, banned_players.username),
         display_name = COALESCE($3, banned_players.display_name),
         banned = $4, ban_reason = $5, ban_time = $6, action_taken_by = $7, updated_at = NOW()
       RETURNING *`,
      [
        playerId,
        b.Username || "",
        b.DisplayName || "",
        b.Banned || false,
        b.BanReason || "",
        b.BanTime || 0,
        b.ActionTakenBy || "",
      ]
    );
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/moderation/:playerId error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/moderation/:playerId/ban", async (req, res) => {
  try {
    const { playerId } = req.params;
    const { Reason, Admin, Username, DisplayName } = req.body;

    const existing = await pool.query(
      "SELECT * FROM banned_players WHERE player_id = $1",
      [playerId]
    );

    if (existing.rows.length > 0 && existing.rows[0].ban_reason && existing.rows[0].ban_reason !== "") {
      await pool.query(
        `INSERT INTO previous_bans (player_id, reason, time, action_taken_by) VALUES ($1, $2, $3, $4)`,
        [
          playerId,
          existing.rows[0].ban_reason,
          existing.rows[0].ban_time || Math.floor(Date.now() / 1000),
          existing.rows[0].action_taken_by || "Unknown",
        ]
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const result = await pool.query(
      `INSERT INTO banned_players (player_id, username, display_name, banned, ban_reason, ban_time, action_taken_by, updated_at)
       VALUES ($1, $2, $3, true, $4, $5, $6, NOW())
       ON CONFLICT (player_id) DO UPDATE SET
         username = COALESCE(NULLIF($2, ''), banned_players.username),
         display_name = COALESCE(NULLIF($3, ''), banned_players.display_name),
         banned = true, ban_reason = $4, ban_time = $5, action_taken_by = $6, updated_at = NOW()
       RETURNING *`,
      [
        playerId,
        Username || "",
        DisplayName || "",
        Reason || "",
        now,
        Admin || "Unknown",
      ]
    );
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("POST /api/moderation/:playerId/ban error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/moderation/:playerId/unban", async (req, res) => {
  try {
    const { playerId } = req.params;
    const { Admin } = req.body;
    const result = await pool.query(
      `UPDATE banned_players SET
         banned = false, ban_reason = '', ban_time = 0,
         action_taken_by = $1, updated_at = NOW()
       WHERE player_id = $2 RETURNING *`,
      [Admin || "Unknown", playerId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Player not found in moderation records" });
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("POST /api/moderation/:playerId/unban error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.get("/api/moderation", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM banned_players WHERE banned = true ORDER BY updated_at DESC"
    );
    res.json({ ok: true, banned: result.rows });
  } catch (err) {
    console.error("GET /api/moderation error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

app.post("/api/moderation/migrate", async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== "object") {
      return res.status(400).json({ ok: false, error: "Expected Firebase JSON export as body" });
    }
    let imported = 0;
    let previousBansImported = 0;
    for (const [userId, record] of Object.entries(data)) {
      if (!record || typeof record !== "object") continue;
      await pool.query(
        `INSERT INTO banned_players (player_id, username, display_name, banned, ban_reason, ban_time, action_taken_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (player_id) DO UPDATE SET
           username = $2, display_name = $3, banned = $4,
           ban_reason = $5, ban_time = $6, action_taken_by = $7, updated_at = NOW()`,
        [
          userId,
          record.Username || "",
          record.DisplayName || "",
          record.Banned || false,
          record.BanReason || "",
          record.BanTime || 0,
          record.ActionTakenBy || "",
        ]
      );
      imported++;
      if (record.PreviousBans && typeof record.PreviousBans === "object") {
        for (const [, ban] of Object.entries(record.PreviousBans)) {
          if (!ban || typeof ban !== "object") continue;
          await pool.query(
            `INSERT INTO previous_bans (player_id, reason, time, action_taken_by) VALUES ($1, $2, $3, $4)`,
            [userId, ban.Reason || "", ban.Time || 0, ban.ActionTakenBy || "Unknown"]
          );
          previousBansImported++;
        }
      }
    }
    res.json({ ok: true, message: `Imported ${imported} player(s), ${previousBansImported} previous ban(s)` });
  } catch (err) {
    console.error("POST /api/moderation/migrate error:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Crew API running on port ${PORT}`);
  });
}).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
