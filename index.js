require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
} = require('discord.js');

// Load configuration from environment variables. See `.env` for details.
const {
  DISCORD_TOKEN,
  GUILD_ID,
  SUBMISSIONS_CHANNEL_ID,
  OC_CATEGORY_ID,
  MOD_ROLE_ID,
  GM_ROLE_ID,
  LOG_CHANNEL_ID,
} = process.env;

let existingOCNames = new Set();

/**
 * Parse a message content for an OC name. Accepts messages prefaced with
 * "OC:" or "Name:". Falls back to the entire content if no prefix is found.
 *
 * @param {string} content The message content
 * @returns {string} The extracted OC name or an empty string
 */
function parseOCName(content) {
  const trimmed = content.trim();
  const match =
    trimmed.match(/^\s*oc\s*:\s*(.+)$/i) ||
    trimmed.match(/^\s*name\s*:\s*(.+)$/i);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Create a slug suitable for Discord channel names. Removes accents,
 * converts to lowercase, replaces non‑alphanumeric characters with
 * hyphens, and trims leading/trailing hyphens.
 *
 * @param {string} text Input text
 * @returns {string} Sanitised slug
 */
function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // replace non‑alphanumeric with hyphen
    .replace(/(^-|-$)/g, '') // trim leading/trailing hyphens
    .slice(0, 90);
}

// Load existing OC names from the public Google Sheet (read‑only).
// If the sheet changes structure, update SHEET_GID or parsing below.
const PUBLISHED_SHEET_KEY = process.env.PUBLISHED_SHEET_KEY;
const FORM_RESPONSES_GID = process.env.FORM_RESPONSES_GID || '693027147';

/**
 * Fetch and parse the ranking sheet to get a set of existing OC full names.
 * This uses the public CSV export of the sheet. If the sheet is private,
 * publish it or provide service account access.
 *
 * @returns {Promise<Set<string>>} Set of full names
 */
async function loadExistingOCs() {
  try {
    const url = `https://docs.google.com/spreadsheets/d/e/${PUBLISHED_SHEET_KEY}/pub?output=csv&gid=${FORM_RESPONSES_GID}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch sheet: ${res.status}`);
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
const names = new Set();

const NAME_COLUMN_INDEX = 1; // Column B (A=0, B=1)

// Skip header row (row 1). Start reading from row 2 (B2, B3, ...)
for (let i = 1; i < lines.length; i++) {
  const cells = lines[i].split(',');
  const rawName = (cells[NAME_COLUMN_INDEX] || '').trim();
  if (rawName) {
    names.add(rawName.toLowerCase());
  }
}

return names;

  } catch (err) {
    console.warn('Unable to load existing OCs from sheet:', err.message);
    return new Set();
  }
}

// Create the Discord client with intents to read messages and assign roles
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Preload existing OC names on startup
  loadExistingOCs().then((set) => {
    existingOCNames = set;
    console.log('Loaded existing OCs from sheet:', [...set]);
  });
});

/**
 * Handle incoming messages and process OC submissions.
 */
client.on('messageCreate', async (message) => {
  try {
    // Ignore bots and DM messages
    if (message.author.bot && !message.webhookId) return;
    if (!message.guild) return;
    // Ensure we are only responding in the designated guild and channel
    if (message.guild.id !== GUILD_ID) return;
    if (message.channel.id !== SUBMISSIONS_CHANNEL_ID) return;

    // Extract the full name. Prefer embed titles if present (e.g. "OC: Name").
    let fullName;
    if (message.embeds && message.embeds.length > 0) {
      const embed = message.embeds[0];
      if (embed.title) {
        const match = embed.title.match(/OC\s*:\s*(.+)/i);
        if (match) {
          fullName = match[1].trim();
        }
      }
    }
    // Fallback to plain text parsing if no embed title matched
    if (!fullName) {
      fullName = parseOCName(message.content);
    }
    if (!fullName) return;

existingOCNames = await loadExistingOCs();

    // Check against loaded names to prevent duplicates
if (existingOCNames && existingOCNames.has(fullName.toLowerCase())) {
      await message.reply(
        `An OC named **${fullName}** already exists in the roster.\n` +
          `If you believe this is an error or you wish to update your existing character, please contact a moderator.`
      );
      return;
    }

    // Require at least two parts (first and last name)
    const parts = fullName.split(/\s+/);
    if (parts.length < 2) {
      await message.reply(
        'Please include both first and last name when submitting an OC (e.g., "OC: Mito Uzumaki").'
      );
      return;
    }

    const firstName = parts[0];
    const lastName = parts.slice(1).join('-');
    const roleName = firstName;
    const channelSlug = slugify(fullName);
    const channelName = `oc-${channelSlug}`;

    const guild = await client.guilds.fetch(GUILD_ID);

    // Check if the role already exists (case-insensitive match)
    let role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === roleName.toLowerCase()
    );
    if (!role) {
      role = await guild.roles.create({
        name: roleName,
        reason: `Created OC role for ${fullName}`,
      });
    }

    // Check if the channel already exists
    let channel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === channelName
    );
    if (!channel) {
      // Build permission overwrites
      const overwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: role.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AddReactions,
          ],
        },
        {
          id: MOD_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ];
      // Include GM role if provided
      if (GM_ROLE_ID) {
        overwrites.push({
          id: GM_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ManageChannels,
          ],
        });
      }

      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: OC_CATEGORY_ID || null,
        permissionOverwrites: overwrites,
        reason: `Created OC channel for ${fullName}`,
      });

      // Send a starter message in the new channel
      await channel.send(
        `A new Prodigy has been reborn!\n` +
          `This is your private OC channel for **${fullName}**.\n` +
          `Use this space to organise character details, jutsu lists, and updates.\n` +
          `Only you, moderators, and game masters can view this channel.`
      );

      // If the original message contained an embed (e.g. from the submission webhook),
      // replicate it here so the player can see their character description.
      if (message.embeds && message.embeds.length > 0) {
        try {
          // Use the raw embed data for resending
          const embedData = message.embeds[0].data || message.embeds[0].toJSON();
          await channel.send({ embeds: [embedData] });
        } catch (e) {
          console.warn('Failed to copy embed to new channel:', e);
        }
      }
    }

    // Assign the OC role to the submitting member
    if (!message.member.roles.cache.has(role.id)) {
      await message.member.roles.add(role);
    }

    // Log the creation in the designated log channel if configured
    if (LOG_CHANNEL_ID) {
      const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel.send(
          `OC created: **${fullName}**\n` +
            `Role: <@&${role.id}> (ID: ${role.id})\n` +
            `Channel: <#${channel.id}> (ID: ${channel.id})\n` +
            `By: <@${message.author.id}>`
        );
      }
    }
  } catch (err) {
    console.error('Error handling OC submission:', err);
  }
});

// Start the bot
client.login(DISCORD_TOKEN);