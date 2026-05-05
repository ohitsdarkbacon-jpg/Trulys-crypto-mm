const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType
} = require('discord.js');
const { generateWallet, getBalance, sendTransaction } = require('./wallets');
const { db } = require('./database');
const config = require('./config');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  client.user.setActivity('🔒 Securing trades | !mm setup');
});

// ─────────────────────────────────────────────
// MESSAGE COMMANDS
// ─────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(config.PREFIX)) return;

  const args = message.content.slice(config.PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  try {
    if (command === 'mm' || command === 'middleman') {
      const sub = args.shift()?.toLowerCase();
      switch (sub) {
        case 'setup':    return handleSetup(message);
        case 'panel':    return handlePanel(message);
        case 'confirm':  return handleConfirm(message, args);
        case 'cancel':   return handleCancel(message, args);
        case 'status':   return handleStatus(message, args);
        case 'release':  return handleRelease(message, args);
        case 'dispute':  return handleDispute(message, args);
        case 'close':    return handleClose(message);
        case 'add':      return handleAdd(message, args);
        default:         return handleHelp(message);
      }
    }
  } catch (err) {
    console.error(err);
    message.reply('❌ An error occurred: ' + err.message);
  }
});

// ─────────────────────────────────────────────
// BUTTON INTERACTIONS
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const [action, ...rest] = interaction.customId.split('_');

  try {
    switch (action) {
      case 'openTicket':    return handleOpenTicketButton(interaction);
      case 'confirmDeal':   return handleConfirmButton(interaction, rest[0]);
      case 'cancelDeal':    return handleCancelButton(interaction, rest[0]);
      case 'disputeDeal':   return handleDisputeButton(interaction, rest[0]);
      case 'closeTicket':   return handleCloseButton(interaction, rest[0]);
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '❌ Error: ' + err.message, ephemeral: true });
    }
  }
});

// ─────────────────────────────────────────────
// SETUP  !mm setup  (admin)
// Creates category + panel channel
// ─────────────────────────────────────────────
async function handleSetup(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('❌ Admin only.');
  }

  const guild = message.guild;

  const category = await guild.channels.create({
    name: '🔒 ESCROW TRADES',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] }
    ]
  });

  const panelChannel = await guild.channels.create({
    name: '📬・open-a-trade',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        allow: [PermissionsBitField.Flags.ViewChannel],
        deny: [PermissionsBitField.Flags.SendMessages]
      }
    ]
  });

  db.set(`guild_${guild.id}`, { categoryId: category.id, panelChannelId: panelChannel.id });

  await postPanel(panelChannel);

  const embed = new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle('✅ Escrow System Ready')
    .addFields(
      { name: '📁 Category', value: category.name },
      { name: '📬 Panel', value: `<#${panelChannel.id}>` },
      { name: '📌 Next', value: 'Users open trades by clicking the button in that channel.' }
    );

  message.channel.send({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// PANEL  !mm panel  (admin) — reposts button embed
// ─────────────────────────────────────────────
async function handlePanel(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('❌ Admin only.');
  }
  await postPanel(message.channel);
  message.delete().catch(() => {});
}

async function postPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor('#0d1117')
    .setTitle('💎 Crypto Escrow — MM Service')
    .setDescription(
      '> Secure peer‑to‑peer crypto trades with a neutral middleman.\n' +
      '> A **private ticket** is created for you and your partner.\n\n' +
      '**Coins:** `BTC` · `ETH` · `LTC` · `SOL` · `USDT`\n' +
      '**Fee:** 1% taken on release\n\n' +
      '**How it works:**\n' +
      '`1.` Click **Open Trade Ticket** below\n' +
      '`2.` Mention your trading partner + coin + amount\n' +
      '`3.` Buyer deposits → Seller delivers → Buyer confirms → Funds released ✅'
    )
    .setFooter({ text: 'Fresh wallet generated for every deal.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('openTicket')
      .setLabel('🔒 Open Trade Ticket')
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ─────────────────────────────────────────────
// OPEN TICKET BUTTON — creates private channel
// ─────────────────────────────────────────────
async function handleOpenTicketButton(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const user  = interaction.user;
  const guildData = db.get(`guild_${guild.id}`);

  if (!guildData) {
    return interaction.editReply('❌ Escrow system not configured. Ask an admin to run `!mm setup`.');
  }

  // Prevent duplicate open tickets
  const existing = findOpenTicketForUser(user.id);
  if (existing) {
    return interaction.editReply(`❌ You already have an open ticket: <#${existing.channelId}>`);
  }

  // Create private channel
  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const ticketChannel = await guild.channels.create({
    name: `trade-${safeName}-${Date.now().toString(36)}`,
    type: ChannelType.GuildText,
    parent: guildData.categoryId,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      },
    ]
  });

  const ticketId = 'TKT-' + Math.random().toString(36).substr(2, 6).toUpperCase();
  db.set(`ticket_${ticketId}`, {
    ticketId,
    channelId: ticketChannel.id,
    opener: user.id,
    status: 'SETUP',
    guildId: guild.id,
    createdAt: Date.now(),
  });

  // Setup prompt
  const embed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle('🔒 Trade Ticket — Setup')
    .setDescription(
      `Welcome <@${user.id}>! Set up your trade by replying with:\n\n` +
      '```\n@seller <coin> <amount> <description>\n```\n' +
      '**Example:**\n```\n@JohnDoe BTC 0.01 Trading for $50 Amazon gift card\n```\n' +
      '**Coins:** BTC, ETH, LTC, SOL, USDT\n\n' +
      '_Your trading partner will be added automatically._'
    )
    .setFooter({ text: `Ticket: ${ticketId} • Times out in 5 min` });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`closeTicket_${ticketId}`)
      .setLabel('❌ Close Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: [closeRow] });

  collectTradeSetup(ticketChannel, user, ticketId);

  await interaction.editReply(`✅ Ticket created: <#${ticketChannel.id}>`);
}

// ─────────────────────────────────────────────
// COLLECT TRADE SETUP INPUT
// ─────────────────────────────────────────────
function collectTradeSetup(channel, opener, ticketId) {
  const filter = (m) => m.author.id === opener.id && !m.author.bot;
  const collector = channel.createMessageCollector({ filter, max: 1, time: 300000 });

  collector.on('collect', async (m) => {
    const parts  = m.content.trim().split(/ +/);
    const seller = m.mentions.users.first();
    const coin   = parts[1]?.toUpperCase();
    const amount = parseFloat(parts[2]);
    const desc   = parts.slice(3).join(' ') || 'No description';
    const valid  = ['BTC', 'ETH', 'LTC', 'SOL', 'USDT'];

    if (!seller)              return retry(channel, opener, ticketId, 'Missing @seller mention.');
    if (!valid.includes(coin)) return retry(channel, opener, ticketId, `Invalid coin. Use: ${valid.join(', ')}`);
    if (!amount || amount <= 0) return retry(channel, opener, ticketId, 'Invalid amount.');
    if (seller.id === opener.id) return retry(channel, opener, ticketId, 'You cannot trade with yourself.');
    if (seller.bot)            return retry(channel, opener, ticketId, 'Cannot trade with a bot.');

    await startDeal(channel, opener, seller, coin, amount, desc, ticketId);
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      channel.send('⏰ Timed out. Click **Close Ticket** or an admin can run `!mm close`.');
    }
  });
}

async function retry(channel, opener, ticketId, reason) {
  const embed = new EmbedBuilder()
    .setColor('#ff4444')
    .setTitle('❌ ' + reason)
    .setDescription('Please try again:\n```\n@seller <coin> <amount> <description>\n```');
  await channel.send({ embeds: [embed] });
  collectTradeSetup(channel, opener, ticketId);
}

// ─────────────────────────────────────────────
// START DEAL — adds seller, generates wallet
// ─────────────────────────────────────────────
async function startDeal(channel, buyer, seller, coin, amount, description, ticketId) {
  const fee            = parseFloat((amount * 0.01).toFixed(8));
  const sellerReceives = parseFloat((amount - fee).toFixed(8));

  const wallet = await generateWallet(coin);
  const dealId = 'DEAL-' + Math.random().toString(36).substr(2, 8).toUpperCase();

  // Add seller to channel
  await channel.permissionOverwrites.edit(seller.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });

  // Rename channel to include both users
  const buyerName  = buyer.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const sellerName = seller.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  channel.setName(`trade-${buyerName}-${sellerName}`).catch(() => {});

  const deal = {
    id: dealId,
    ticketId,
    channelId: channel.id,
    status: 'PENDING_DEPOSIT',
    coin,
    amount,
    fee,
    sellerReceives,
    description,
    buyer: buyer.id,
    seller: seller.id,
    wallet: wallet.address,
    privateKey: wallet.privateKey,
    createdAt: Date.now(),
    guildId: channel.guild.id,
  };
  db.set(dealId, deal);

  // Update ticket record
  const ticket = db.get(`ticket_${ticketId}`);
  if (ticket) {
    ticket.dealId = dealId;
    ticket.status = 'ACTIVE';
    db.set(`ticket_${ticketId}`, ticket);
  }

  const embed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle(`🔒 Escrow Deal Active — \`${dealId}\``)
    .setDescription(`<@${buyer.id}> **(Buyer)** ↔ <@${seller.id}> **(Seller)**`)
    .addFields(
      { name: '📦 Description', value: description },
      { name: '🪙 Coin', value: coin, inline: true },
      { name: '💰 Amount', value: `${amount} ${coin}`, inline: true },
      { name: '💸 Fee (1%)', value: `${fee} ${coin}`, inline: true },
      { name: '📤 Seller Receives', value: `${sellerReceives} ${coin}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: `📬 Buyer — Deposit ${amount} ${coin} here:`, value: `\`\`\`${wallet.address}\`\`\`` },
      {
        name: '📋 Steps',
        value:
          `**1.** <@${buyer.id}> — send \`${amount} ${coin}\` to the address above\n` +
          `**2.** <@${seller.id}> — deliver the item/gift card to the buyer\n` +
          `**3.** <@${buyer.id}> — click **✅ Confirm Receipt** once you get the item → funds auto-released`
      },
      { name: '🕐 Status', value: '`PENDING_DEPOSIT`' },
    )
    .setFooter({ text: '🔐 Funds held securely until buyer confirms receipt.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirmDeal_${dealId}`).setLabel('✅ Confirm Receipt').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancelDeal_${dealId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`disputeDeal_${dealId}`).setLabel('⚠️ Dispute').setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ content: `<@${buyer.id}> <@${seller.id}>`, embeds: [embed], components: [row] });
}

// ─────────────────────────────────────────────
// CONFIRM BUTTON
// ─────────────────────────────────────────────
async function handleConfirmButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal) return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id) return interaction.reply({ content: '❌ Only the buyer can confirm.', ephemeral: true });
  if (deal.status === 'COMPLETED') return interaction.reply({ content: '✅ Already completed.', ephemeral: true });
  if (deal.status === 'CANCELLED')  return interaction.reply({ content: '❌ Cancelled.', ephemeral: true });

  await interaction.deferReply();

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    return interaction.editReply(
      `⏳ Funds not yet detected in escrow.\n` +
      `Expected: \`${deal.amount} ${deal.coin}\`\nCurrent: \`${balance} ${deal.coin}\`\n\n` +
      `Wait for network confirmations then try again.`
    );
  }

  deal.status = 'AWAITING_PAYOUT_ADDRESS';
  db.set(dealId, deal);

  await interaction.editReply(
    `✅ Funds confirmed! <@${deal.seller}>, please reply in this channel with your **${deal.coin} payout wallet address** to receive \`${deal.sellerReceives} ${deal.coin}\`.`
  );

  const channel = interaction.channel;
  const filter  = (m) => m.author.id === deal.seller && !m.author.bot;
  const collector = channel.createMessageCollector({ filter, max: 1, time: 300000 });

  collector.on('collect', async (m) => {
    await releaseToSeller(channel, deal, m.content.trim(), dealId);
  });
  collector.on('end', (collected) => {
    if (collected.size === 0) {
      channel.send(`⏰ Timed out. <@${deal.seller}> run \`!mm release ${dealId} <your_address>\` to retry.`);
    }
  });
}

// ─────────────────────────────────────────────
// CANCEL BUTTON
// ─────────────────────────────────────────────
async function handleCancelButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal) return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id) {
    return interaction.reply({ content: '❌ Not your deal.', ephemeral: true });
  }
  if (deal.status === 'COMPLETED') return interaction.reply({ content: '❌ Already completed.', ephemeral: true });

  await interaction.deferReply();

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance > 0) {
    return interaction.editReply(`⚠️ \`${balance} ${deal.coin}\` already in escrow. Use the **⚠️ Dispute** button instead.`);
  }

  deal.status = 'CANCELLED';
  db.set(dealId, deal);

  const embed = new EmbedBuilder()
    .setColor('#ff4444')
    .setTitle(`❌ Deal Cancelled — \`${dealId}\``)
    .setDescription(`Cancelled by <@${interaction.user.id}>. No funds were in escrow.\n\nTicket closes in 30 seconds.`);

  await interaction.editReply({ embeds: [embed] });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 30000);
}

// ─────────────────────────────────────────────
// DISPUTE BUTTON
// ─────────────────────────────────────────────
async function handleDisputeButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal) return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id) {
    return interaction.reply({ content: '❌ Not your deal.', ephemeral: true });
  }

  deal.status = 'DISPUTE';
  db.set(dealId, deal);

  // Pull admins into the ticket
  const guild     = interaction.guild;
  const adminRole = guild.roles.cache.find(r => r.permissions.has(PermissionsBitField.Flags.Administrator));
  if (adminRole) {
    await interaction.channel.permissionOverwrites.edit(adminRole.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor('#ff6600')
    .setTitle(`⚠️ Dispute Opened — \`${dealId}\``)
    .setDescription(
      `Filed by <@${interaction.user.id}>.\n\n` +
      `**Admins have been added to this ticket** and will review the situation.\n` +
      `Please describe your issue in detail below.`
    );

  await interaction.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// CLOSE TICKET BUTTON
// ─────────────────────────────────────────────
async function handleCloseButton(interaction, ticketId) {
  const ticket = db.get(`ticket_${ticketId}`);
  const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
  const isOpener = ticket && ticket.opener === interaction.user.id;

  if (!isAdmin && !isOpener) {
    return interaction.reply({ content: '❌ Only admins or the ticket opener can close.', ephemeral: true });
  }

  await interaction.reply('🔒 Closing ticket in 5 seconds...');
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ─────────────────────────────────────────────
// RELEASE FUNDS (admin text command)
// ─────────────────────────────────────────────
async function releaseToSeller(channel, deal, payoutAddress, dealId) {
  const loadEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`💸 Processing — \`${dealId}\``)
    .setDescription(`Sending \`${deal.sellerReceives} ${deal.coin}\` to \`${payoutAddress}\`...`);

  await channel.send({ embeds: [loadEmbed] });

  try {
    const txHash = await sendTransaction(deal.coin, deal.privateKey, deal.wallet, payoutAddress, deal.sellerReceives);

    deal.status = 'COMPLETED';
    deal.txHash = txHash;
    deal.payoutAddress = payoutAddress;
    db.set(dealId, deal);

    const doneEmbed = new EmbedBuilder()
      .setColor('#00ff88')
      .setTitle(`🎉 Deal Complete — \`${dealId}\``)
      .addFields(
        { name: '✅ Status',   value: '`COMPLETED`' },
        { name: '💰 Sent',    value: `${deal.sellerReceives} ${deal.coin}` },
        { name: '📬 Address', value: `\`${payoutAddress}\`` },
        { name: '🔗 TX Hash', value: txHash ? `\`${txHash}\`` : 'Pending...' },
      )
      .setDescription('✅ Trade complete! Ticket will close in 60 seconds.')
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`closeTicket_${deal.ticketId}`)
        .setLabel('🔒 Close Ticket Now')
        .setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ content: `<@${deal.buyer}> <@${deal.seller}>`, embeds: [doneEmbed], components: [closeRow] });

    setTimeout(() => channel.delete().catch(() => {}), 60000);

  } catch (err) {
    console.error(err);
    channel.send(`❌ Payout failed: \`${err.message}\`\nContact an admin with deal ID \`${dealId}\`.`);
  }
}

// ─────────────────────────────────────────────
// TEXT COMMANDS (for inside ticket channels)
// ─────────────────────────────────────────────
async function handleConfirm(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm confirm <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id) return message.reply('❌ Only the buyer can confirm.');

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    return message.reply(`⏳ Funds not yet detected.\nExpected: \`${deal.amount} ${deal.coin}\` | Balance: \`${balance} ${deal.coin}\``);
  }

  deal.status = 'AWAITING_PAYOUT_ADDRESS';
  db.set(dealId, deal);
  message.channel.send(`✅ Confirmed! <@${deal.seller}>, reply with your **${deal.coin} payout address**.`);

  const collector = message.channel.createMessageCollector({
    filter: (m) => m.author.id === deal.seller && !m.author.bot,
    max: 1, time: 300000
  });
  collector.on('collect', async (m) => {
    await releaseToSeller(message.channel, deal, m.content.trim(), dealId);
  });
}

async function handleCancel(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm cancel <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id && deal.seller !== message.author.id) return message.reply('❌ Not your deal.');
  if (deal.status === 'COMPLETED') return message.reply('❌ Already completed.');

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance > 0) return message.reply(`⚠️ Funds in escrow. Use \`!mm dispute ${dealId}\` for admin help.`);

  deal.status = 'CANCELLED';
  db.set(dealId, deal);
  message.channel.send('❌ Cancelled. No funds were in escrow. Channel closes in 15 seconds...');
  setTimeout(() => message.channel.delete().catch(() => {}), 15000);
}

async function handleStatus(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm status <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');

  const balance = await getBalance(deal.coin, deal.wallet);
  const colors  = { PENDING_DEPOSIT: '#f0a500', AWAITING_PAYOUT_ADDRESS: '#0099ff', COMPLETED: '#00ff88', CANCELLED: '#ff4444', DISPUTE: '#ff6600' };

  const embed = new EmbedBuilder()
    .setColor(colors[deal.status] || '#888')
    .setTitle(`📋 Status — \`${dealId}\``)
    .addFields(
      { name: '🔄 Status',  value: `\`${deal.status}\``,        inline: true },
      { name: '🪙 Coin',   value: deal.coin,                    inline: true },
      { name: '💰 Amount', value: `${deal.amount} ${deal.coin}`, inline: true },
      { name: '👤 Buyer',  value: `<@${deal.buyer}>`,           inline: true },
      { name: '👤 Seller', value: `<@${deal.seller}>`,          inline: true },
      { name: '💵 Escrow', value: `${balance} ${deal.coin}`,    inline: true },
      { name: '📦 Desc',   value: deal.description },
      { name: '📬 Wallet', value: `\`${deal.wallet}\`` },
    )
    .setTimestamp(deal.createdAt);

  message.channel.send({ embeds: [embed] });
}

async function handleRelease(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
  const [dealId, payoutAddress] = args;
  if (!dealId || !payoutAddress) return message.reply('❌ Usage: `!mm release <dealID> <address>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  await releaseToSeller(message.channel, deal, payoutAddress, dealId);
}

async function handleDispute(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm dispute <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id && deal.seller !== message.author.id) return message.reply('❌ Not your deal.');

  deal.status = 'DISPUTE';
  db.set(dealId, deal);

  const adminRole = message.guild.roles.cache.find(r => r.permissions.has(PermissionsBitField.Flags.Administrator));
  if (adminRole) {
    await message.channel.permissionOverwrites.edit(adminRole.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor('#ff6600')
    .setTitle(`⚠️ Dispute — \`${dealId}\``)
    .setDescription(`Filed by <@${message.author.id}>. Admins added. Please explain your issue.`);
  message.channel.send({ embeds: [embed] });
}

async function handleClose(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
  message.channel.send('🔒 Closing in 5 seconds...');
  setTimeout(() => message.channel.delete().catch(() => {}), 5000);
}

async function handleAdd(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admin only.');
  const user = message.mentions.users.first();
  if (!user) return message.reply('❌ Usage: `!mm add @user`');
  await message.channel.permissionOverwrites.edit(user.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
  });
  message.channel.send(`✅ Added <@${user.id}> to this ticket.`);
}

async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle('💎 Escrow Bot — Commands')
    .addFields(
      { name: '`!mm setup`',                        value: '*(Admin)* Create escrow category + panel channel' },
      { name: '`!mm panel`',                        value: '*(Admin)* Repost the Open Trade button' },
      { name: '`!mm status <dealID>`',              value: 'View deal status + escrow balance' },
      { name: '`!mm confirm <dealID>`',             value: 'Buyer confirms item received → releases funds' },
      { name: '`!mm cancel <dealID>`',              value: 'Cancel deal if no funds sent yet' },
      { name: '`!mm dispute <dealID>`',             value: 'Open dispute — adds admins to ticket' },
      { name: '`!mm release <dealID> <address>`',   value: '*(Admin)* Force-release funds' },
      { name: '`!mm add @user`',                    value: '*(Admin)* Add someone to the ticket' },
      { name: '`!mm close`',                        value: '*(Admin)* Delete this ticket channel' },
    );
  message.channel.send({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function findOpenTicketForUser(userId) {
  const all = db.all();
  return Object.values(all).find(
    (v) => v.ticketId && v.opener === userId && v.status === 'SETUP'
  ) || null;
}

client.login(config.TOKEN);
