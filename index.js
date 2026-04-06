require("dotenv").config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require("discord.js");

// ─── Config ──────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_IDS = (process.env.GUILD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const BAN_LOG_CHANNEL_ID = process.env.BAN_LOG_CHANNEL_ID;
const UNBAN_LOG_CHANNEL_ID = process.env.UNBAN_LOG_CHANNEL_ID;
const KICK_LOG_CHANNEL_ID = process.env.KICK_LOG_CHANNEL_ID;
const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID;
const API_BASE = process.env.API_BASE || "https://crew-tag-data-production.up.railway.app";
const API_KEY = process.env.API_KEY || "";
const OWNER_IDS = (process.env.OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ─── Role Mapping ────────────────────────────────────────────
function parseRoles(env) {
  const m = {};
  if (!env) return m;
  for (const e of env.split(",")) { const [k, v] = e.trim().split(":"); if (k && v) m[k] = v; }
  return m;
}
const GUILD_RANK_ROLES = {};
if (GUILD_IDS[0] && process.env.RANK_ROLES_GUILD1) GUILD_RANK_ROLES[GUILD_IDS[0]] = parseRoles(process.env.RANK_ROLES_GUILD1);
if (GUILD_IDS[1] && process.env.RANK_ROLES_GUILD2) GUILD_RANK_ROLES[GUILD_IDS[1]] = parseRoles(process.env.RANK_ROLES_GUILD2);

// Strike role mapping (single server): "1:roleId,2:roleId,3:roleId"
const STRIKE_ROLES = parseRoles(process.env.STRIKE_ROLES || "");
const STRIKE_GUILD_ID = process.env.STRIKE_GUILD_ID || GUILD_IDS[0] || "";

// Extra roles to strip on demote/removal/3 strikes (per guild)
// Format: "roleId,roleId,roleId"
const EXTRA_STAFF_ROLES_GUILD1 = (process.env.EXTRA_STAFF_ROLES_GUILD1 || "").split(",").map((s) => s.trim()).filter(Boolean);
const EXTRA_STAFF_ROLES_GUILD2 = (process.env.EXTRA_STAFF_ROLES_GUILD2 || "").split(",").map((s) => s.trim()).filter(Boolean);
function getExtraStaffRoles(gid) {
  if (gid === GUILD_IDS[0]) return EXTRA_STAFF_ROLES_GUILD1;
  if (gid === GUILD_IDS[1]) return EXTRA_STAFF_ROLES_GUILD2;
  return [];
}

function getRankRoles(gid) { return GUILD_RANK_ROLES[gid] || {}; }
function getAllRankRoleIds(gid) { return Object.values(getRankRoles(gid)); }

async function assignStrikeRole(client, discordId, strikeNum) {
  if (!STRIKE_GUILD_ID) return;
  try {
    const guild = await client.guilds.fetch(STRIKE_GUILD_ID);
    const m = await guild.members.fetch(String(discordId));
    for (const [, roleId] of Object.entries(STRIKE_ROLES)) {
      if (m.roles.cache.has(roleId)) await m.roles.remove(roleId).catch(() => {});
    }
    const newRole = STRIKE_ROLES[String(strikeNum)];
    if (newRole) await m.roles.add(newRole).catch(() => {});
  } catch {}
}

async function stripStrikeRoles(client, discordId) {
  if (!STRIKE_GUILD_ID) return;
  try {
    const guild = await client.guilds.fetch(STRIKE_GUILD_ID);
    const m = await guild.members.fetch(String(discordId));
    for (const [, roleId] of Object.entries(STRIKE_ROLES)) {
      if (m.roles.cache.has(roleId)) await m.roles.remove(roleId).catch(() => {});
    }
  } catch {}
}

// ─── Constants ───────────────────────────────────────────────
const RANK_TABLE = {
  8: "Trial", 9: "Moderator", 10: "Administrator", 11: "Overseer",
  12: "Director", 13: "Head Management", 14: "Council", 15: "Community Manager",
  16: "Co-Owner", 17: "Owner",
};
const RANK_CHOICES = Object.entries(RANK_TABLE).map(([v, n]) => ({ name: n, value: v }));
const DURATION_CHOICES = [
  { name: "1 Day", value: "86400" }, { name: "7 Days", value: "604800" },
  { name: "30 Days", value: "2592000" }, { name: "Permanent", value: "-1" },
];
const DURATION_LABELS = { "86400": "1 Day", "604800": "7 Days", "2592000": "30 Days", "-1": "Permanent" };

const PROMO_CHANNEL_ID = process.env.PROMO_CHANNEL_ID;
const PROMOTION_REQS = {
  8: 80,    // Trial → Moderator
  9: 200,   // Moderator → Administrator
  10: 400,  // Administrator → Overseer
  11: 600,  // Overseer → Director
  12: 800,  // Director → Head Management
  13: 1000, // Head Management → Council
};

// ─── Helpers ─────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json", "x-api-key": API_KEY } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API request failed");
  return data;
}
async function resolveRobloxId(input) {
  if (!input) return null;
  if (/^\d+$/.test(input)) return { id: Number(input), username: null };
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  const d = await res.json();
  return d.data?.[0] ? { id: d.data[0].id, username: d.data[0].name } : null;
}
async function fetchRobloxUser(id) {
  try { const r = await fetch(`https://users.roblox.com/v1/users/${id}`); return await r.json(); } catch { return null; }
}
async function fetchHeadshot(id) {
  try {
    const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`);
    const d = await r.json(); return d.data?.[0]?.imageUrl || null;
  } catch { return null; }
}
async function fetchPresence(id) {
  try {
    const r = await fetch("https://presence.roblox.com/v1/presence/users", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userIds: [id] }),
    });
    const d = await r.json(); return d.userPresences?.[0] || null;
  } catch { return null; }
}
async function fetchCount(url) {
  try { const r = await fetch(url); const d = await r.json(); return d.count ?? null; } catch { return null; }
}
async function sendLog(client, chId, embed) {
  if (!chId) return;
  try { const ch = await client.channels.fetch(chId); if (ch) await ch.send({ embeds: [embed] }); } catch {}
}
function profileUrl(id) { return `https://www.roblox.com/users/${id}/profile`; }

// ─── Polished Embed Builders ─────────────────────────────────
const COLORS = {
  ban: 0xd32f2f, unban: 0x43a047, kick: 0xf9a825,
  staff: 0x1976d2, strike: 0xff6f00, error: 0xd32f2f,
  info: 0x2b2d31, success: 0x43a047, demote: 0xb71c1c,
};

function confirmEmbed({ action, color, username, playerId, reason, evidence, admin, headshot, extra }) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `Confirm ${action}`, iconURL: headshot || undefined })
    .setDescription(`Are you sure you want to **${action.toLowerCase()}** this user?`)
    .addFields(
      { name: "┃ Target", value: `> [${username}](${profileUrl(playerId)}) \`${playerId}\``, inline: false },
      { name: "┃ Reason", value: `> ${reason}`, inline: false },
    );
  if (extra) for (const f of extra) e.addFields({ name: `┃ ${f.name}`, value: `> ${f.value}`, inline: f.inline || false });
  e.addFields(
    { name: "┃ Evidence", value: evidence ? `> [View Evidence](${evidence})` : "> None provided", inline: false },
    { name: "┃ Moderator", value: `> ${admin}`, inline: false },
  );
  e.setFooter({ text: `ID: ${playerId}` }).setTimestamp();
  if (headshot) e.setThumbnail(headshot);
  return e;
}

function resultEmbed({ color, title, description, headshot, footer }) {
  const e = new EmbedBuilder().setColor(color).setDescription(description).setTimestamp();
  if (title) e.setAuthor({ name: title, iconURL: headshot || undefined });
  if (headshot) e.setThumbnail(headshot);
  if (footer) e.setFooter({ text: footer });
  return e;
}

function logEmbed({ color, title, username, playerId, displayName, reason, evidence, admin, headshot, duration }) {
  const now = Math.floor(Date.now() / 1000);
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: title, iconURL: headshot || undefined })
    .setDescription(
      `**${displayName || username}** (@${username})\n` +
      `[View Profile](${profileUrl(playerId)})\n` +
      `\`\`\`\nUser ID: ${playerId}\n\`\`\``
    )
    .addFields(
      { name: "┃ Reason", value: `> ${reason}`, inline: false },
      { name: "┃ Duration", value: `> ${duration || "—"}`, inline: true },
      { name: "┃ Time", value: `> <t:${now}:F>`, inline: true },
      { name: "┃ Evidence", value: evidence ? `> [View](${evidence})` : "> None", inline: false },
      { name: "┃ Moderator", value: `> ${admin}`, inline: false },
    )
    .setFooter({ text: `ID: ${playerId}` })
    .setTimestamp();
  if (headshot) e.setThumbnail(headshot);
  return e;
}

function publicEmbed({ color, icon, action, displayName, username, reason, extra, headshot }) {
  const desc = [`**${displayName}** (@${username}) has been **${action}**.`, `**Reason:** ${reason}`];
  if (extra) desc.push(extra);
  const e = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${icon} Moderation Action Taken` })
    .setDescription(desc.join("\n"))
    .setTimestamp();
  if (headshot) e.setThumbnail(headshot);
  return e;
}

function errorEmbed(desc) {
  return new EmbedBuilder().setColor(COLORS.error).setAuthor({ name: "Error" }).setDescription(desc);
}

// ─── Confirmation Flow ──────────────────────────────────────
async function confirm(interaction, embed) {
  const cId = `c-${interaction.id}`, xId = `x-${interaction.id}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cId).setLabel("Confirm").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(xId).setLabel("Cancel").setStyle(ButtonStyle.Danger),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
  try {
    const btn = await interaction.channel.awaitMessageComponent({
      filter: (i) => [cId, xId].includes(i.customId) && i.user.id === interaction.user.id, time: 30000,
    });
    if (btn.customId === xId) {
      await btn.update({ embeds: [resultEmbed({ color: COLORS.info, description: "Action cancelled." })], components: [] });
      return false;
    }
    await btn.deferUpdate();
    return true;
  } catch {
    await interaction.editReply({ embeds: [resultEmbed({ color: COLORS.info, description: "Action timed out." })], components: [] });
    return false;
  }
}

// ─── Role Helpers ────────────────────────────────────────────
async function assignRankRole(client, discordId, rankNum) {
  let count = 0;
  for (const guild of client.guilds.cache.values()) {
    const roles = getRankRoles(guild.id);
    const all = getAllRankRoleIds(guild.id);
    const newRole = roles[rankNum];
    if (!newRole) continue;
    try {
      const m = await guild.members.fetch(discordId);
      for (const id of all) { if (id !== newRole && m.roles.cache.has(id)) await m.roles.remove(id).catch(() => {}); }
      await m.roles.add(newRole);
      count++;
    } catch {}
  }
  return count;
}

async function stripAllRankRoles(client, discordId) {
  let count = 0;
  for (const guild of client.guilds.cache.values()) {
    const all = getAllRankRoleIds(guild.id);
    if (!all.length) continue;
    try {
      const m = await guild.members.fetch(String(discordId));
      for (const id of all) { if (m.roles.cache.has(id)) await m.roles.remove(id).catch(() => {}); }
      count++;
    } catch {}
  }
  return count;
}

// Full strip: rank roles + extra staff roles + strike roles
async function stripEverything(client, discordId) {
  await stripAllRankRoles(client, discordId);
  await stripStrikeRoles(client, discordId);
  // Strip extra staff roles in all guilds
  for (const guild of client.guilds.cache.values()) {
    const extras = getExtraStaffRoles(guild.id);
    if (!extras.length) continue;
    try {
      const m = await guild.members.fetch(String(discordId));
      for (const id of extras) { if (m.roles.cache.has(id)) await m.roles.remove(id).catch(() => {}); }
    } catch {}
  }
}

// ─── Mod State & Rate Limiter ────────────────────────────────
let modEnabled = true;
const rateLimits = new Map();
const RATE_LIMIT_MS = 60000;
function checkRL(uid, act) {
  const k = `${uid}:${act}`, n = Date.now(), l = rateLimits.get(k);
  return l && n - l < RATE_LIMIT_MS ? Math.ceil((RATE_LIMIT_MS - (n - l)) / 1000) : 0;
}
function setRL(uid, act) { rateLimits.set(`${uid}:${act}`, Date.now()); }

// ─── Promotion Notification ──────────────────────────────────
async function sendPromotionNotification(client, staffEntry, totalLogs, headshot) {
  const currentRank = staffEntry.rank;
  const required = PROMOTION_REQS[currentRank];
  const nextRank = currentRank + 1;
  const nextRankName = RANK_TABLE[nextRank];
  const currentRankName = RANK_TABLE[currentRank];
  if (!nextRankName || !PROMO_CHANNEL_ID) return;

  if (!headshot) headshot = await fetchHeadshot(staffEntry.player_id);
  const promoId = `promo-${staffEntry.player_id}-${Date.now()}`;
  const denyId = `deny-${staffEntry.player_id}-${Date.now()}`;

  const embed = new EmbedBuilder()
    .setColor(0x7c4dff)
    .setAuthor({ name: "⭐ Promotion Eligible", iconURL: headshot || undefined })
    .setDescription(
      `**${staffEntry.username}** (<@${staffEntry.discord_id}>) is eligible for promotion!\n\n` +
      `**┃ Current Rank**\n> ${currentRankName}\n` +
      `**┃ Next Rank**\n> ${nextRankName}\n` +
      `**┃ Logs**\n> ${totalLogs}/${required}\n\n` +
      `*A Community Manager or above must review and approve.*`
    )
    .setFooter({ text: `Player ID: ${staffEntry.player_id}` })
    .setTimestamp();
  if (headshot) embed.setThumbnail(headshot);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(promoId).setLabel("Promote").setStyle(ButtonStyle.Success).setEmoji("⬆️"),
    new ButtonBuilder().setCustomId(denyId).setLabel("Deny").setStyle(ButtonStyle.Danger).setEmoji("✖️"),
  );

  const ch = await client.channels.fetch(PROMO_CHANNEL_ID);
  const msg = await ch.send({ embeds: [embed], components: [row] });

  const collector = msg.createMessageComponentCollector({ time: 7 * 24 * 60 * 60 * 1000 });
  collector.on("collect", async (btn) => {
    const isReviewerOwner = OWNER_IDS.includes(btn.user.id);
    let reviewerStaff = null;
    try { const d = await api("GET", `/api/staff/discord/${btn.user.id}`); reviewerStaff = d.staff; } catch {}
    if (!isReviewerOwner && (!reviewerStaff || reviewerStaff.rank < 15)) {
      return btn.reply({ content: "Only **Community Manager** and above can review promotions.", flags: MessageFlags.Ephemeral });
    }
    const reviewerName = reviewerStaff?.username || btn.user.tag;

    if (btn.customId === denyId) {
      const denyEmbed = EmbedBuilder.from(embed)
        .setColor(0xd32f2f)
        .setAuthor({ name: "❌ Promotion Denied", iconURL: headshot || undefined })
        .setDescription(embed.data.description.replace("*A Community Manager or above must review and approve.*", `**Denied by:** ${reviewerName}`));
      await msg.edit({ embeds: [denyEmbed], components: [] });
      await btn.deferUpdate();
      collector.stop();
      return;
    }
    if (btn.customId === promoId) {
      try {
        await api("POST", "/api/staff", { playerId: staffEntry.player_id, discordId: staffEntry.discord_id, username: staffEntry.username, rank: nextRank });
        await assignRankRole(client, String(staffEntry.discord_id), nextRank);
        const promoEmbed = EmbedBuilder.from(embed).setColor(0x43a047).setAuthor({ name: "✅ Promoted!", iconURL: headshot || undefined })
          .setDescription(`**${staffEntry.username}** (<@${staffEntry.discord_id}>) has been promoted!\n\n**┃ ${currentRankName}** → **${nextRankName}**\n**┃ Total Logs:** ${totalLogs}\n**┃ Approved by:** ${reviewerName}`);
        await msg.edit({ embeds: [promoEmbed], components: [] });
        await btn.deferUpdate();
        await sendLog(client, STAFF_LOG_CHANNEL_ID, new EmbedBuilder().setColor(0x43a047).setAuthor({ name: "⬆️ Staff Promotion", iconURL: headshot || undefined })
          .setDescription(`**${staffEntry.username}** (<@${staffEntry.discord_id}>) promoted to **${nextRankName}**!\nApproved by **${reviewerName}** · ${totalLogs} logs`).setTimestamp());
      } catch (err) {
        await btn.reply({ content: `Promotion failed: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      collector.stop();
    }
  });
}

// ─── Log Recording & Promotion Check ────────────────────────
async function recordModLog(client, staffEntry, actionType, targetPlayerId, reason) {
  if (!staffEntry) return;
  try {
    const logData = await api("POST", "/api/logs/increment", {
      playerId: staffEntry.player_id,
      amount: 1,
    });
    const totalLogs = logData.totalLogs;
    const required = PROMOTION_REQS[staffEntry.rank];
    if (required && totalLogs >= required && PROMO_CHANNEL_ID) {
      await sendPromotionNotification(client, staffEntry, totalLogs, null);
    }
  } catch (err) {
    console.error("[ModLog] Failed to record log:", err);
  }
}

// ─── Slash Commands ──────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("mod").setDescription("Moderation commands")
    .addSubcommand((s) => s.setName("ban").setDescription("Ban a player")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setRequired(true))
      .addStringOption((o) => o.setName("duration").setDescription("Ban duration").setRequired(true).addChoices(...DURATION_CHOICES))
      .addStringOption((o) => o.setName("evidence").setDescription("Evidence link").setRequired(true))
      .addAttachmentOption((o) => o.setName("file").setDescription("Evidence file").setRequired(false)))
    .addSubcommand((s) => s.setName("unban").setDescription("Unban a player")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Unban reason").setRequired(true))
      .addStringOption((o) => o.setName("evidence").setDescription("Evidence link").setRequired(true))
      .addAttachmentOption((o) => o.setName("file").setDescription("Evidence file").setRequired(false)))
    .addSubcommand((s) => s.setName("kick").setDescription("Kick a player from all servers")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Kick reason").setRequired(true))
      .addStringOption((o) => o.setName("evidence").setDescription("Evidence link").setRequired(true))
      .addAttachmentOption((o) => o.setName("file").setDescription("Evidence file").setRequired(false)))
    .addSubcommand((s) => s.setName("history").setDescription("View moderation history")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true))),

  new SlashCommandBuilder().setName("staff").setDescription("Staff management")
    .addSubcommand((s) => s.setName("add").setDescription("Add or update staff")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true))
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(true))
      .addStringOption((o) => o.setName("rank").setDescription("Rank").setRequired(true).addChoices(...RANK_CHOICES)))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove staff")
      .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(false))
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(false)))
    .addSubcommand((s) => s.setName("list").setDescription("View all staff"))
    .addSubcommand((s) => s.setName("strike").setDescription("Issue a strike to a staff member")
      .addUserOption((o) => o.setName("discord").setDescription("Discord user to strike").setRequired(true))
      .addStringOption((o) => o.setName("reason").setDescription("Strike reason").setRequired(true)))
    .addSubcommand((s) => s.setName("strikes").setDescription("View a staff member's strikes")
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(true)))
    .addSubcommand((s) => s.setName("clearstrikes").setDescription("Clear all strikes for a staff member")
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(true)))
    .addSubcommand((s) => s.setName("logs").setDescription("View a staff member's mod log count")
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(true)))
    .addSubcommand((s) => s.setName("addlogs").setDescription("Manually add logs to a staff member (Owner only)")
      .addUserOption((o) => o.setName("discord").setDescription("Discord user").setRequired(true))
      .addIntegerOption((o) => o.setName("amount").setDescription("Number of logs to add").setRequired(true))),

  new SlashCommandBuilder().setName("user").setDescription("Look up a Roblox profile")
    .addStringOption((o) => o.setName("username").setDescription("Roblox username or ID").setRequired(true)),

  new SlashCommandBuilder().setName("zeelive").setDescription("Toggle moderation on/off")
    .addStringOption((o) => o.setName("status").setDescription("ON or OFF").setRequired(true)
      .addChoices({ name: "ON", value: "on" }, { name: "OFF", value: "off" })),
];

// ─── Register ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const body = commands.map((c) => c.toJSON());
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log("Cleared old global commands");
  } catch (err) {
    console.error("Failed to clear global commands:", err.message);
  }
  for (const gid of GUILD_IDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body });
      console.log(`Registered ${body.length} commands in ${gid}`);
    } catch (err) {
      console.error(`Failed to register commands in ${gid}:`, err.message);
    }
  }
}

// ─── Bot ─────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.once("clientReady", async () => {
  console.log(`Online as ${client.user.tag}`);

  // ── Role Audit: strip staff roles from non-staff members ──
  async function auditRoles() {
    try {
      const staffData = await api("GET", "/api/staff");
      const staffDiscordIds = new Set(
        (staffData.staff || []).filter((s) => s.discord_id).map((s) => String(s.discord_id))
      );

      for (const guild of client.guilds.cache.values()) {
        const allRoleIds = [...getAllRankRoleIds(guild.id), ...getExtraStaffRoles(guild.id)];
        if (!allRoleIds.length) continue;

        const members = await guild.members.fetch();
        for (const [, member] of members) {
          if (member.user.bot) continue;
          if (OWNER_IDS.includes(member.id)) continue;
          const hasAny = allRoleIds.some((id) => member.roles.cache.has(id));
          if (hasAny && !staffDiscordIds.has(member.id)) {
            for (const roleId of allRoleIds) {
              if (member.roles.cache.has(roleId)) await member.roles.remove(roleId).catch(() => {});
            }
            console.log(`[Audit] Stripped roles from ${member.user.tag} (not in staff data)`);
          }
        }
      }
    } catch (err) {
      console.error("[Audit] Role audit error:", err);
    }
  }

  // Run on startup then every 5 minutes
  await auditRoles();
  setInterval(auditRoles, 300000);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  const sub = interaction.options.getSubcommand(false);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const isOwner = OWNER_IDS.includes(interaction.user.id);

  // ── /zeelive ───────────────────────────────────────────
  if (commandName === "zeelive") {
    if (!isOwner) return interaction.editReply({ embeds: [errorEmbed("Only owners can toggle moderation.")] });
    modEnabled = interaction.options.getString("status") === "on";
    return interaction.editReply({ embeds: [resultEmbed({
      color: modEnabled ? COLORS.success : COLORS.error,
      title: modEnabled ? "🟢 Moderation Enabled" : "🔴 Moderation Disabled",
      description: modEnabled ? "All `/mod` commands are now **active**." : "All `/mod` commands are **disabled**.",
    })]});
  }

  if (commandName === "mod" && !modEnabled && !isOwner) {
    return interaction.editReply({ embeds: [errorEmbed("Moderation is currently **disabled**.")] });
  }

  // ── Staff check ────────────────────────────────────────
  let staffEntry = null;
  try { const d = await api("GET", `/api/staff/discord/${interaction.user.id}`); staffEntry = d.staff || null; } catch {}

  if (!staffEntry && !isOwner) return interaction.editReply({ embeds: [errorEmbed("You are not registered as staff.")] });

  if (interaction.guild && !isOwner && staffEntry) {
    const expected = getRankRoles(interaction.guild.id)[staffEntry.rank];
    if (!expected || !interaction.member.roles.cache.has(expected))
      return interaction.editReply({ embeds: [errorEmbed("Your Discord role does not match your staff rank.")] });
    if (commandName === "staff" && ["add", "remove", "strike", "clearstrikes"].includes(sub) && staffEntry.rank < 15)
      return interaction.editReply({ embeds: [errorEmbed("Only **Community Manager** and above can manage staff.")] });
  }

  // ── Resolve admin display name ─────────────────────────
  const adminDisplay = staffEntry?.username || interaction.user.tag;

  // ── /staff list ────────────────────────────────────────
  if (commandName === "staff" && sub === "list") {
    try {
      const d = await api("GET", "/api/staff");
      if (!d.staff?.length) return interaction.editReply({ embeds: [resultEmbed({ color: COLORS.info, description: "No staff members found." })] });
      const lines = d.staff.map((s) => {
        const r = RANK_TABLE[s.rank] || `Rank ${s.rank}`;
        const dc = s.discord_id ? ` · <@${s.discord_id}>` : "";
        return `**${r}** — ${s.username || s.player_id}${dc}`;
      });
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("📋 Staff Members").setDescription(lines.join("\n").slice(0, 4096)).setFooter({ text: `${d.staff.length} member(s)` }).setTimestamp()] });
    } catch (err) { return interaction.editReply({ embeds: [errorEmbed(err.message)] }); }
  }

  // ── /staff strike ──────────────────────────────────────
  if (commandName === "staff" && sub === "strike") {
    const target = interaction.options.getUser("discord");
    const reason = interaction.options.getString("reason");

    let targetStaff;
    try { const d = await api("GET", `/api/staff/discord/${target.id}`); targetStaff = d.staff; } catch {}
    if (!targetStaff) return interaction.editReply({ embeds: [errorEmbed(`<@${target.id}> is not a staff member.`)] });

    const targetHeadshot = await fetchHeadshot(targetStaff.player_id);

    const strikeData = await api("POST", "/api/strikes", {
      playerId: targetStaff.player_id, discordId: target.id, reason, issuedBy: adminDisplay,
    });
    const total = strikeData.totalStrikes;

    // Assign strike role
    await assignStrikeRole(client, target.id, Math.min(total, 3));

    // Build strike embed
    const barFull = "🔴";
    const barEmpty = "⚫";
    const strikeBar = Array(3).fill(null).map((_, i) => i < total ? barFull : barEmpty).join(" ");

    const embed = new EmbedBuilder()
      .setColor(total >= 3 ? COLORS.demote : COLORS.strike)
      .setAuthor({ name: "⚠️ Strike Issued", iconURL: targetHeadshot || undefined })
      .setDescription(
        `**${targetStaff.username}** (<@${target.id}>) received a strike.\n\n` +
        `${strikeBar}  **${total}/3 Strikes**\n\n` +
        `**┃ Reason**\n> ${reason}\n\n` +
        `**┃ Issued by**\n> ${adminDisplay}`
      )
      .setFooter({ text: `Player ID: ${targetStaff.player_id}` })
      .setTimestamp();
    if (targetHeadshot) embed.setThumbnail(targetHeadshot);

    // 3 strikes → auto-demote + ban
    if (total >= 3) {
      // Remove from staff
      try { await api("DELETE", `/api/staff/${targetStaff.player_id}`); } catch {}
      await stripEverything(client, target.id);

      // Ban from game
      try {
        await api("POST", `/api/moderation/${targetStaff.player_id}/ban`, {
          Reason: "Auto-banned: 3 strikes", Admin: "System", Username: targetStaff.username, Duration: -1,
        });
      } catch {}

      embed.addFields({
        name: "🚨 AUTO-ACTION",
        value: "> Player has been **demoted**, **stripped of all roles**, and **banned from the game**.",
      });

      // Log it
      await sendLog(client, STAFF_LOG_CHANNEL_ID, logEmbed({
        color: COLORS.demote, title: "🚨 Auto-Demote & Ban (3 Strikes)",
        username: targetStaff.username, playerId: targetStaff.player_id,
        displayName: targetStaff.username, reason: `3 strikes reached. Last: ${reason}`,
        evidence: null, admin: "System", headshot: targetHeadshot, duration: "Permanent",
      }));
    }

    await sendLog(client, STAFF_LOG_CHANNEL_ID, embed);
    return interaction.editReply({ embeds: [embed] });
  }

  // ── /staff strikes (view) ─────────────────────────────
  if (commandName === "staff" && sub === "strikes") {
    const target = interaction.options.getUser("discord");
    let targetStaff;
    try { const d = await api("GET", `/api/staff/discord/${target.id}`); targetStaff = d.staff; } catch {}

    let pid = targetStaff?.player_id;
    if (!pid) return interaction.editReply({ embeds: [errorEmbed(`<@${target.id}> is not a staff member.`)] });

    const targetHeadshot = await fetchHeadshot(pid);
    const d = await api("GET", `/api/strikes/${pid}`);
    const total = d.count || 0;

    const barFull = "🔴";
    const barEmpty = "⚫";
    const strikeBar = Array(3).fill(null).map((_, i) => i < total ? barFull : barEmpty).join(" ");

    let desc = `${strikeBar}  **${total}/3 Strikes**`;
    if (d.strikes?.length) {
      desc += "\n\n";
      desc += d.strikes.map((s, i) => {
        const t = `<t:${Math.floor(new Date(s.created_at).getTime() / 1000)}:R>`;
        return `\`${i + 1}.\` ${s.reason || "No reason"} — by ${s.issued_by || "Unknown"} (${t})`;
      }).join("\n");
    } else {
      desc += "\n\nNo strikes on record.";
    }

    const embed = new EmbedBuilder()
      .setColor(total > 0 ? COLORS.strike : COLORS.success)
      .setAuthor({ name: `${targetStaff?.username || "Unknown"}'s Strikes`, iconURL: targetHeadshot || undefined })
      .setDescription(desc)
      .setFooter({ text: `Player ID: ${pid}` })
      .setTimestamp();
    if (targetHeadshot) embed.setThumbnail(targetHeadshot);

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /staff clearstrikes ────────────────────────────────
  if (commandName === "staff" && sub === "clearstrikes") {
    const target = interaction.options.getUser("discord");
    let targetStaff;
    try { const d = await api("GET", `/api/staff/discord/${target.id}`); targetStaff = d.staff; } catch {}
    if (!targetStaff) return interaction.editReply({ embeds: [errorEmbed(`<@${target.id}> is not a staff member.`)] });

    await api("DELETE", `/api/strikes/${targetStaff.player_id}`);
    await stripStrikeRoles(client, target.id);

    return interaction.editReply({ embeds: [resultEmbed({
      color: COLORS.success,
      title: "✅ Strikes Cleared",
      description: `All strikes for **${targetStaff.username}** (<@${target.id}>) have been cleared.`,
      headshot: await fetchHeadshot(targetStaff.player_id),
    })]});
  }

  // ── /staff logs ────────────────────────────────────────
  if (commandName === "staff" && sub === "logs") {
    const target = interaction.options.getUser("discord");
    let targetStaff;
    try { const d = await api("GET", `/api/staff/discord/${target.id}`); targetStaff = d.staff; } catch {}
    if (!targetStaff) return interaction.editReply({ embeds: [errorEmbed(`<@${target.id}> is not a staff member.`)] });

    const targetHeadshot = await fetchHeadshot(targetStaff.player_id);
    const totalLogs = targetStaff.log_count || 0;
    const currentRank = targetStaff.rank;
    const currentRankName = RANK_TABLE[currentRank] || `Rank ${currentRank}`;
    const required = PROMOTION_REQS[currentRank];
    const nextRank = currentRank + 1;
    const nextRankName = RANK_TABLE[nextRank];

    let progressText = "";
    if (required && nextRankName) {
      const pct = Math.min(totalLogs / required, 1);
      const filled = Math.round(pct * 10);
      const empty = 10 - filled;
      const bar = "█".repeat(filled) + "░".repeat(empty);
      progressText = `\n\n**┃ Progress to ${nextRankName}**\n> \`${bar}\` ${totalLogs}/${required} (${Math.round(pct * 100)}%)`;
      if (totalLogs >= required) progressText += "\n> ⭐ **Eligible for promotion!**";
    } else {
      progressText = "\n\n> Max promotion rank reached via logs.";
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.staff)
      .setAuthor({ name: `${targetStaff.username}'s Logs`, iconURL: targetHeadshot || undefined })
      .setDescription(
        `**┃ Rank**\n> ${currentRankName}\n` +
        `**┃ Total Logs**\n> ${totalLogs}` +
        progressText
      )
      .setFooter({ text: `Player ID: ${targetStaff.player_id}` })
      .setTimestamp();
    if (targetHeadshot) embed.setThumbnail(targetHeadshot);

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /staff addlogs ─────────────────────────────────────
  if (commandName === "staff" && sub === "addlogs") {
    if (!isOwner) return interaction.editReply({ embeds: [errorEmbed("Only owners can manually add logs.")] });

    const target = interaction.options.getUser("discord");
    const amount = interaction.options.getInteger("amount");
    if (amount < 1) return interaction.editReply({ embeds: [errorEmbed("Amount must be at least 1.")] });

    let targetStaff;
    try { const d = await api("GET", `/api/staff/discord/${target.id}`); targetStaff = d.staff; } catch {}
    if (!targetStaff) return interaction.editReply({ embeds: [errorEmbed(`<@${target.id}> is not a staff member.`)] });

    const targetHeadshot = await fetchHeadshot(targetStaff.player_id);

    const logData = await api("POST", "/api/logs/increment", {
      playerId: targetStaff.player_id,
      amount,
    });
    const totalLogs = logData.totalLogs;

    // Check promotion — just notify, don't call recordModLog (that would re-increment)
    const required = PROMOTION_REQS[targetStaff.rank];
    const nextRankName = RANK_TABLE[targetStaff.rank + 1];
    let promoNote = "";
    if (required && totalLogs >= required && nextRankName && PROMO_CHANNEL_ID) {
      try {
        await sendPromotionNotification(client, targetStaff, totalLogs, targetHeadshot);
        promoNote = "\n⭐ Promotion notification sent!";
      } catch {}
    }

    return interaction.editReply({ embeds: [resultEmbed({
      color: COLORS.success,
      title: "📝 Logs Added",
      description: `Added **${amount}** log(s) to **${targetStaff.username}** (<@${target.id}>).\n\n**┃ Total Logs**\n> ${totalLogs}${promoNote}`,
      headshot: targetHeadshot,
      footer: `Added by ${adminDisplay}`,
    })] });
  }

  // ── /staff remove (Discord user only) ──────────────────
  if (commandName === "staff" && sub === "remove" && !interaction.options.getString("username") && interaction.options.getUser("discord")) {
    const discordTarget = interaction.options.getUser("discord");
    try {
      const sd = await api("GET", `/api/staff/discord/${discordTarget.id}`);
      if (!sd.staff) return interaction.editReply({ embeds: [errorEmbed(`<@${discordTarget.id}> is not a staff member.`)] });
      const tp = sd.staff.player_id, tu = sd.staff.username || `${tp}`;
      await api("DELETE", `/api/staff/${tp}`);
      await stripEverything(client, discordTarget.id);
      const th = await fetchHeadshot(tp);
      return interaction.editReply({ embeds: [resultEmbed({
        color: COLORS.error, title: "Staff Member Removed",
        description: `**${tu}** (\`${tp}\`) has been removed from staff.`, headshot: th, footer: `Removed by ${adminDisplay}`,
      })]});
    } catch (err) { return interaction.editReply({ embeds: [errorEmbed(err.message)] }); }
  }

  // ── Resolve Roblox player ──────────────────────────────
  const playerInput = interaction.options.getString("username");
  if (!playerInput && commandName !== "staff") return interaction.editReply({ embeds: [errorEmbed("Please provide a username.")] });

  if (!playerInput) return interaction.editReply({ embeds: [errorEmbed("Please provide a **username** or **Discord user**.")] });

  const resolved = await resolveRobloxId(playerInput);
  if (!resolved) return interaction.editReply({ embeds: [errorEmbed(`Could not find Roblox user **${playerInput}**.`)] });

  const { id: playerId } = resolved;
  const robloxUser = await fetchRobloxUser(playerId);
  const username = resolved.username || robloxUser?.name || "Unknown";
  const displayName = robloxUser?.displayName || username;
  const headshot = await fetchHeadshot(playerId);
  const evidence = interaction.options.getString("evidence") || null;
  const file = interaction.options.getAttachment("file");
  const evidenceUrl = file ? file.url : evidence;

  try {
    // ── /mod ban ──────────────────────────────────────────
    if (commandName === "mod" && sub === "ban") {
      const cd = checkRL(interaction.user.id, "ban");
      if (cd > 0 && !isOwner) return interaction.editReply({ embeds: [errorEmbed(`Cooldown: **${cd}s** remaining.`)] });

      const reason = interaction.options.getString("reason");
      const durVal = interaction.options.getString("duration");
      const durLabel = DURATION_LABELS[durVal] || "Permanent";
      const durSec = parseInt(durVal);

      const ok = await confirm(interaction, confirmEmbed({
        action: "Ban", color: COLORS.ban, username, playerId, reason, evidence: evidenceUrl,
        admin: adminDisplay, headshot, extra: [{ name: "Duration", value: durLabel }],
      }));
      if (!ok) return;

      await api("POST", `/api/moderation/${playerId}/ban`, { Reason: reason, Admin: adminDisplay, Username: username, DisplayName: displayName, Duration: durSec });
      await interaction.editReply({ embeds: [resultEmbed({ color: COLORS.ban, title: "🔨 Banned", description: `**${username}** has been banned. (**${durLabel}**)`, headshot })], components: [] });
      await interaction.channel.send({ embeds: [publicEmbed({ color: COLORS.ban, icon: "🔨", action: "banned", displayName, username, reason, extra: `**Duration:** ${durLabel}`, headshot })] });
      await sendLog(client, BAN_LOG_CHANNEL_ID, logEmbed({ color: COLORS.ban, title: "🔨 Ban", username, playerId, displayName, reason, evidence: evidenceUrl, admin: adminDisplay, headshot, duration: durLabel }));
      await recordModLog(client, staffEntry, "ban", playerId, reason);
      setRL(interaction.user.id, "ban");
      return;
    }

    // ── /mod unban ────────────────────────────────────────
    if (commandName === "mod" && sub === "unban") {
      const cd = checkRL(interaction.user.id, "unban");
      if (cd > 0 && !isOwner) return interaction.editReply({ embeds: [errorEmbed(`Cooldown: **${cd}s** remaining.`)] });

      const reason = interaction.options.getString("reason");
      const ok = await confirm(interaction, confirmEmbed({ action: "Unban", color: COLORS.unban, username, playerId, reason, evidence: evidenceUrl, admin: adminDisplay, headshot }));
      if (!ok) return;

      await api("POST", `/api/moderation/${playerId}/unban`, { Admin: adminDisplay });
      await interaction.editReply({ embeds: [resultEmbed({ color: COLORS.unban, title: "🔓 Unbanned", description: `**${username}** has been unbanned.`, headshot })], components: [] });
      await interaction.channel.send({ embeds: [publicEmbed({ color: COLORS.unban, icon: "🔓", action: "unbanned", displayName, username, reason, headshot })] });
      await sendLog(client, UNBAN_LOG_CHANNEL_ID, logEmbed({ color: COLORS.unban, title: "🔓 Unban", username, playerId, displayName, reason, evidence: evidenceUrl, admin: adminDisplay, headshot, duration: "—" }));
      await recordModLog(client, staffEntry, "unban", playerId, reason);
      setRL(interaction.user.id, "unban");
      return;
    }

    // ── /mod kick ─────────────────────────────────────────
    if (commandName === "mod" && sub === "kick") {
      const cd = checkRL(interaction.user.id, "kick");
      if (cd > 0 && !isOwner) return interaction.editReply({ embeds: [errorEmbed(`Cooldown: **${cd}s** remaining.`)] });

      const reason = interaction.options.getString("reason");
      const ok = await confirm(interaction, confirmEmbed({ action: "Kick", color: COLORS.kick, username, playerId, reason, evidence: evidenceUrl, admin: adminDisplay, headshot }));
      if (!ok) return;

      await api("POST", `/api/moderation/${playerId}/kick`, { Reason: reason, Admin: adminDisplay });
      await interaction.editReply({ embeds: [resultEmbed({ color: COLORS.kick, title: "👢 Kicked", description: `**${username}** has been kicked.`, headshot })], components: [] });
      await interaction.channel.send({ embeds: [publicEmbed({ color: COLORS.kick, icon: "👢", action: "kicked", displayName, username, reason, headshot })] });
      await sendLog(client, KICK_LOG_CHANNEL_ID, logEmbed({ color: COLORS.kick, title: "👢 Kick", username, playerId, displayName, reason, evidence: evidenceUrl, admin: adminDisplay, headshot, duration: "—" }));
      await recordModLog(client, staffEntry, "kick", playerId, reason);
      setRL(interaction.user.id, "kick");
      return;
    }

    // ── /mod history ──────────────────────────────────────
    if (commandName === "mod" && sub === "history") {
      const d = await api("GET", `/api/moderation/${playerId}`);
      if (!d.data) return interaction.editReply({ embeds: [resultEmbed({ color: COLORS.info, title: `${displayName} (@${username})`, description: "No moderation records.", headshot, footer: `ID: ${playerId}` })] });

      const r = d.data;
      const durText = r.BanDuration === -1 ? "Permanent" : r.BanDuration === 86400 ? "1 Day" : r.BanDuration === 604800 ? "7 Days" : r.BanDuration === 2592000 ? "30 Days" : r.BanDuration > 0 ? `${Math.round(r.BanDuration / 86400)} Days` : "Permanent";
      const expText = r.BanExpires > 0 ? `<t:${r.BanExpires}:R>` : "Never";

      let desc = r.Banned
        ? `🔴 **BANNED**\n> ${r.BanReason || "No reason"}\n> By: ${r.ActionTakenBy || "Unknown"} · ${r.BanTime ? `<t:${r.BanTime}:R>` : "N/A"}\n> Duration: **${durText}** · Expires: ${expText}`
        : `🟢 **Not Banned**`;

      if (r.PreviousBans) {
        const entries = Object.values(r.PreviousBans);
        if (entries.length) {
          desc += `\n\n**Previous Bans (${entries.length})**\n`;
          desc += entries.map((b, i) => `\`${i + 1}.\` ${b.Reason || "No reason"} — ${b.ActionTakenBy || "Unknown"} (${b.Time ? `<t:${b.Time}:R>` : "?"})`).join("\n");
        }
      }

      const embed = new EmbedBuilder()
        .setColor(r.Banned ? COLORS.ban : COLORS.success)
        .setAuthor({ name: `${r.DisplayName || displayName} (@${r.Username || username})`, iconURL: headshot || undefined })
        .setDescription(desc.slice(0, 4096))
        .setFooter({ text: `ID: ${r.UserId}` }).setTimestamp();
      if (headshot) embed.setThumbnail(headshot);
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /user ─────────────────────────────────────────────
    if (commandName === "user") {
      if (!robloxUser) return interaction.editReply({ embeds: [errorEmbed(`Could not fetch profile for **${playerInput}**.`)] });

      const [pres, fr, fo, fg] = await Promise.all([
        fetchPresence(playerId),
        fetchCount(`https://friends.roblox.com/v1/users/${playerId}/friends/count`),
        fetchCount(`https://friends.roblox.com/v1/users/${playerId}/followers/count`),
        fetchCount(`https://friends.roblox.com/v1/users/${playerId}/followings/count`),
      ]);

      const sm = { 0: ["🔴", "Offline"], 1: ["🟢", "Online"], 2: ["🎮", "In Game"], 3: ["🔧", "In Studio"] };
      const [si, sl] = pres ? (sm[pres.userPresenceType] || ["❔", "Unknown"]) : ["❔", "Unknown"];
      const created = robloxUser.created ? Math.floor(new Date(robloxUser.created).getTime() / 1000) : null;
      const bio = robloxUser.description?.trim() ? robloxUser.description.slice(0, 200) : "No bio set";

      let modStatus = "🟢 Clean";
      try { const md = await api("GET", `/api/moderation/${playerId}`); if (md.data?.Banned) modStatus = `🔴 Banned`; } catch {}

      const f = (n) => n != null ? n.toLocaleString() : "—";
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setAuthor({ name: `${si} ${sl}`, iconURL: headshot || undefined })
        .setTitle(`${displayName} (@${username})`)
        .setURL(profileUrl(playerId))
        .setDescription(`> ${bio}\n\u200b`)
        .addFields(
          { name: "👥 Friends", value: f(fr), inline: true },
          { name: "📣 Followers", value: f(fo), inline: true },
          { name: "👁 Following", value: f(fg), inline: true },
          { name: "📅 Created", value: created ? `<t:${created}:D> (<t:${created}:R>)` : "Unknown", inline: true },
          { name: "⚖️ Status", value: modStatus, inline: true },
        ).setFooter({ text: `ID: ${playerId}` }).setTimestamp();
      if (headshot) embed.setThumbnail(headshot);
      if (pres?.userPresenceType === 2 && pres.lastLocation) embed.spliceFields(3, 0, { name: "🕹️ Playing", value: pres.lastLocation, inline: true });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Profile").setStyle(ButtonStyle.Link).setURL(profileUrl(playerId)).setEmoji("👤"),
      );
      if (pres?.userPresenceType === 2 && pres.rootPlaceId)
        row.addComponents(new ButtonBuilder().setLabel("Join Game").setStyle(ButtonStyle.Link).setURL(`https://www.roblox.com/games/${pres.rootPlaceId}`).setEmoji("🎮"));

      return interaction.editReply({ embeds: [embed], components: [row] });
    }

    // ── /staff add ────────────────────────────────────────
    if (commandName === "staff" && sub === "add") {
      const rankNum = parseInt(interaction.options.getString("rank"));
      const discordUser = interaction.options.getUser("discord");
      const rankName = RANK_TABLE[rankNum] || `Rank ${rankNum}`;

      if ((rankNum === 16 || rankNum === 17) && !isOwner)
        return interaction.editReply({ embeds: [errorEmbed("Only owners can assign **Co-Owner** or **Owner**.")] });

      await api("POST", "/api/staff", { playerId, discordId: discordUser.id, username, rank: rankNum });
      const rc = await assignRankRole(client, discordUser.id, rankNum);

      const embed = new EmbedBuilder()
        .setColor(COLORS.staff)
        .setAuthor({ name: "✅ Staff Member Added", iconURL: headshot || undefined })
        .setDescription(
          `**${username}** has been added as **${rankName}**.\n\n` +
          `**┃ Discord**\n> <@${discordUser.id}>\n` +
          `**┃ User ID**\n> \`${playerId}\`\n` +
          (rc > 0 ? `\n✅ Role assigned in ${rc} server(s)` : "\n⚠️ Could not assign roles")
        )
        .setFooter({ text: `Added by ${adminDisplay}` }).setTimestamp();
      if (headshot) embed.setThumbnail(headshot);
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /staff remove (by username) ──────────────────────
    if (commandName === "staff" && sub === "remove") {
      let staffDiscordId;
      try { const sd = await api("GET", `/api/staff/${playerId}`); staffDiscordId = sd.staff?.discord_id; } catch {}
      try { await api("DELETE", `/api/staff/${playerId}`); } catch { return interaction.editReply({ embeds: [errorEmbed(`**${username}** is not staff.`)] }); }
      if (staffDiscordId) { await stripEverything(client, staffDiscordId); }
      return interaction.editReply({ embeds: [resultEmbed({ color: COLORS.error, title: "Staff Member Removed", description: `**${username}** (\`${playerId}\`) removed from staff.`, headshot, footer: `Removed by ${adminDisplay}` })] });
    }
  } catch (err) {
    console.error(`/${commandName} ${sub || ""} error:`, err);
    return interaction.editReply({ embeds: [errorEmbed(err.message || "Something went wrong.")] });
  }
});

// ─── Spam Detection ──────────────────────────────────────────
const SPAM_WINDOW = 5000;      // 5 second window — catches rapid-fire only
const SPAM_THRESHOLD = 3;      // 3 identical messages within 5s = spam
const spamTracker = new Map(); // userId → [{ content, time, channelId, messageId }]
const spamBanned = new Set();

function cleanOld(entries, now) {
  return entries.filter((e) => now - e.time < SPAM_WINDOW);
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (OWNER_IDS.includes(message.author.id)) return;

  const userId = message.author.id;
  const now = Date.now();
  const content = message.content.trim().toLowerCase();
  if (!content) return;

  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  const tracker = spamTracker.get(userId);
  tracker.push({ content, time: now, channelId: message.channel.id, messageId: message.id });
  const cleaned = cleanOld(tracker, now);
  spamTracker.set(userId, cleaned);

  if (spamBanned.has(userId)) return;

  // Only check for duplicate messages
  const duplicateCount = cleaned.filter((m) => m.content === content).length;
  if (duplicateCount < SPAM_THRESHOLD) return;

  spamBanned.add(userId);

  try {
    // Delete their spam messages across channels they spammed in
    const channelIds = [...new Set(cleaned.filter((m) => m.content === content).map((m) => m.channelId))];
    for (const chId of channelIds) {
      try {
        const ch = await client.channels.fetch(chId);
        const msgs = await ch.messages.fetch({ limit: 50 });
        const spamMsgs = msgs.filter((m) => m.author.id === userId);
        for (const [, msg] of spamMsgs) {
          await msg.delete().catch(() => {});
        }
      } catch {}
    }

    // Timeout for 24 hours
    try {
      const member = await message.guild.members.fetch(userId);
      await member.timeout(24 * 60 * 60 * 1000, "Spam detected by Zee LIVE");
    } catch {}

    // If staff → demote + game ban
    let robloxUsername = null;
    try {
      const staffData = await api("GET", `/api/staff/discord/${userId}`);
      if (staffData.staff) {
        robloxUsername = staffData.staff.username;
        await api("DELETE", `/api/staff/${staffData.staff.player_id}`);
        await stripEverything(client, userId);
        await api("POST", `/api/moderation/${staffData.staff.player_id}/ban`, {
          Reason: "Auto-banned: Spam detected", Admin: "Zee LIVE Anti-Spam",
          Username: robloxUsername, Duration: -1,
        });
      }
    } catch {}

    // Public announcement
    const embed = new EmbedBuilder()
      .setColor(0xd32f2f)
      .setAuthor({ name: "🛡️ Zee LIVE Anti-Spam" })
      .setDescription(
        `<@${userId}> has been **muted** for spamming.\n\n` +
        `**┃ Detected**\n> ${duplicateCount}x repeated message\n` +
        `**┃ Action**\n> 24h Timeout + Messages Deleted` +
        (robloxUsername ? `\n> Game ban (${robloxUsername})` : "") +
        `\n\n*This action was taken automatically.*`
      )
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });

    await sendLog(client, BAN_LOG_CHANNEL_ID, new EmbedBuilder()
      .setColor(0xd32f2f)
      .setAuthor({ name: "🛡️ Auto-Spam Detection" })
      .setDescription(
        `**User:** <@${userId}> (\`${userId}\`)\n` +
        `**Type:** ${duplicateCount}x repeated message\n` +
        `**Channel:** <#${message.channel.id}>\n` +
        `**Action:** 24h Timeout + Messages Deleted` +
        (robloxUsername ? ` + Game Ban (${robloxUsername})` : "") +
        `\n**Message:** \`${content.slice(0, 100)}\``
      )
      .setTimestamp()
    );
  } catch (err) {
    console.error("[Anti-Spam] Error:", err);
  }

  setTimeout(() => spamBanned.delete(userId), 30000);
});

setInterval(() => {
  const now = Date.now();
  for (const [userId, tracker] of spamTracker) {
    const cleaned = cleanOld(tracker, now);
    if (cleaned.length === 0) spamTracker.delete(userId);
    else spamTracker.set(userId, cleaned);
  }
}, 60000);

(async () => {
  try {
    await registerCommands();
  } catch (err) {
    console.error("Command registration failed:", err.message);
  }
  await client.login(DISCORD_TOKEN);
})();
