const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
} = require('discord.js');
const { generateWallet, getBalance, sendTransaction } = require('./wallets');
const { db } = require('./database');
const config = require('./config');

// ─────────────────────────────────────────────
// COIN CONFIG
// ─────────────────────────────────────────────
const SUPPORTED_COINS = ['BTC', 'ETH', 'LTC', 'SOL', 'USDT'];

const COIN_IDS = {
  BTC:  'bitcoin',
  ETH:  'ethereum',
  LTC:  'litecoin',
  SOL:  'solana',
  USDT: 'tether',
};

// Fetch live USD price for a coin; falls back to null on failure
async function getCoinPriceUSD(coin) {
  try {
    const id  = COIN_IDS[coin];
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
    );
    const data = await res.json();
    return data[id]?.usd ?? null;
  } catch {
    return null;
  }
}

// Convert USD to coin amount (8 decimal places max)
async function usdToCoin(usdAmount, coin) {
  if (coin === 'USDT') return { coinAmount: parseFloat(usdAmount.toFixed(2)), price: 1 };
  const price = await getCoinPriceUSD(coin);
  if (!price) return null;
  const coinAmount = parseFloat((usdAmount / price).toFixed(8));
  return { coinAmount, price };
}

// ─────────────────────────────────────────────
// CLIENT
// ─────────────────────────────────────────────
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
  const args    = message.content.slice(config.PREFIX.length).trim().split(/ +/);
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
// INTERACTIONS (Buttons + Modals + Selects)
// ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    // ── Buttons ──
    if (interaction.isButton()) {
      const [action, ...rest] = interaction.customId.split('_');
      switch (action) {
        case 'openTicket':   return handleOpenTicketButton(interaction);
        case 'confirmDeal':  return handleConfirmButton(interaction, rest[0]);
        case 'cancelDeal':   return handleCancelButton(interaction, rest[0]);
        case 'disputeDeal':  return handleDisputeButton(interaction, rest[0]);
        case 'closeTicket':  return handleCloseButton(interaction, rest[0]);
      }
    }

    // ── Modal submissions ──
    if (interaction.isModalSubmit()) {
      const [action, ...rest] = interaction.customId.split('_');
      if (action === 'tradeModal') return handleTradeModalSubmit(interaction, rest[0]);
    }

    // ── Select menus ──
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('coinSelect_')) {
        return handleCoinSelect(interaction);
      }
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
// ─────────────────────────────────────────────
async function handleSetup(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');

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
        deny:  [PermissionsBitField.Flags.SendMessages]
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
      { name: '📬 Panel',    value: `<#${panelChannel.id}>` },
      { name: '📌 Next',     value: 'Users open trades by clicking the button in that channel.' }
    );
  message.channel.send({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// PANEL
// ─────────────────────────────────────────────
async function handlePanel(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');
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
      '**Fee:** 1% taken on release · **Amounts entered in USD**\n\n' +
      '**How it works:**\n' +
      '`1.` Click **Open Trade Ticket** below\n' +
      '`2.` Fill in the form — enter the USD value of the trade\n' +
      '`3.` Bot converts to crypto at live rate\n' +
      '`4.` Buyer deposits → Seller delivers → Buyer confirms → Funds released ✅'
    )
    .setFooter({ text: 'Live prices via CoinGecko · Fresh wallet every deal.' })
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
// OPEN TICKET BUTTON — shows coin selector first
// ─────────────────────────────────────────────
async function handleOpenTicketButton(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const guild     = interaction.guild;
  const user      = interaction.user;
  const guildData = db.get(`guild_${guild.id}`);

  if (!guildData)
    return interaction.editReply('❌ Escrow system not configured. Ask an admin to run `!mm setup`.');

  const existing = findOpenTicketForUser(user.id);
  if (existing)
    return interaction.editReply(`❌ You already have an open ticket: <#${existing.channelId}>`);

  // Create the private channel immediately
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
          PermissionsBitField.Flags.ReadMessageHistory,
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

  // ── Step 1: coin selector embed ──
  const coinEmbed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle('🔒 Trade Ticket — Step 1 of 2')
    .setDescription(
      `Welcome <@${user.id}>!\n\n` +
      '**Select the cryptocurrency** you want to use for this trade.\n' +
      'You will enter the **USD amount** in the next step — the bot will convert it to crypto at the live rate.'
    )
    .setFooter({ text: `Ticket: ${ticketId} · Prices via CoinGecko` });

  const coinSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`coinSelect_${ticketId}`)
      .setPlaceholder('Choose a coin…')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Bitcoin (BTC)').setValue('BTC').setEmoji('₿'),
        new StringSelectMenuOptionBuilder().setLabel('Ethereum (ETH)').setValue('ETH').setEmoji('🔷'),
        new StringSelectMenuOptionBuilder().setLabel('Litecoin (LTC)').setValue('LTC').setEmoji('🪙'),
        new StringSelectMenuOptionBuilder().setLabel('Solana (SOL)').setValue('SOL').setEmoji('◎'),
        new StringSelectMenuOptionBuilder().setLabel('Tether (USDT)').setValue('USDT').setEmoji('💵'),
      )
  );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`closeTicket_${ticketId}`)
      .setLabel('❌ Close Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({
    content: `<@${user.id}>`,
    embeds: [coinEmbed],
    components: [coinSelect, closeRow],
  });

  await interaction.editReply(`✅ Ticket created: <#${ticketChannel.id}>`);
}

// ─────────────────────────────────────────────
// COIN SELECT → show modal
// ─────────────────────────────────────────────
async function handleCoinSelect(interaction) {
  const ticketId = interaction.customId.split('_')[1];
  const coin     = interaction.values[0];

  // Store chosen coin temporarily
  const ticket = db.get(`ticket_${ticketId}`);
  if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
  ticket.pendingCoin = coin;
  db.set(`ticket_${ticketId}`, ticket);

  // ── Show modal for trade details ──
  const modal = new ModalBuilder()
    .setCustomId(`tradeModal_${ticketId}`)
    .setTitle(`Trade Setup — ${coin}`);

  const sellerInput = new TextInputBuilder()
    .setCustomId('sellerUserId')
    .setLabel("Seller's User ID or @mention")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 123456789012345678')
    .setRequired(true);

  const usdInput = new TextInputBuilder()
    .setCustomId('usdAmount')
    .setLabel('Trade amount in USD ($)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g. 150.00')
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Trade description')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g. Trading for $150 Amazon gift card')
    .setMaxLength(300)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(sellerInput),
    new ActionRowBuilder().addComponents(usdInput),
    new ActionRowBuilder().addComponents(descInput),
  );

  await interaction.showModal(modal);
}

// ─────────────────────────────────────────────
// TRADE MODAL SUBMIT
// ─────────────────────────────────────────────
async function handleTradeModalSubmit(interaction, ticketId) {
  await interaction.deferReply({ ephemeral: true });

  const ticket = db.get(`ticket_${ticketId}`);
  if (!ticket) return interaction.editReply('❌ Ticket not found.');

  const coin        = ticket.pendingCoin;
  const rawSeller   = interaction.fields.getTextInputValue('sellerUserId').trim().replace(/[<@!>]/g, '');
  const rawUsd      = interaction.fields.getTextInputValue('usdAmount').trim().replace(/[$,]/g, '');
  const description = interaction.fields.getTextInputValue('description').trim() || 'No description provided';

  // Validate USD
  const usdAmount = parseFloat(rawUsd);
  if (isNaN(usdAmount) || usdAmount <= 0)
    return interaction.editReply('❌ Invalid USD amount. Enter a positive number like `150.00`.');
  if (usdAmount < 1)
    return interaction.editReply('❌ Minimum trade value is **$1.00 USD**.');

  // Validate seller
  let seller;
  try {
    seller = await interaction.guild.members.fetch(rawSeller);
  } catch {
    return interaction.editReply('❌ Could not find that user. Make sure you entered a valid User ID.');
  }

  if (seller.id === interaction.user.id)
    return interaction.editReply('❌ You cannot trade with yourself.');
  if (seller.user.bot)
    return interaction.editReply('❌ Cannot trade with a bot.');

  // Convert USD → coin
  const conversion = await usdToCoin(usdAmount, coin);
  if (!conversion)
    return interaction.editReply(`❌ Could not fetch live price for **${coin}**. Please try again in a moment.`);

  const { coinAmount, price } = conversion;

  // Fetch the ticket channel
  const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) return interaction.editReply('❌ Ticket channel not found.');

  await interaction.editReply('✅ Trade is being set up…');

  await startDeal(channel, interaction.user, seller.user, coin, coinAmount, usdAmount, price, description, ticketId);
}

// ─────────────────────────────────────────────
// START DEAL — adds seller, generates wallet
// ─────────────────────────────────────────────
async function startDeal(channel, buyer, seller, coin, coinAmount, usdAmount, usdPrice, description, ticketId) {
  const fee            = parseFloat((coinAmount * 0.01).toFixed(8));
  const feeUsd         = parseFloat((usdAmount  * 0.01).toFixed(2));
  const sellerReceives = parseFloat((coinAmount - fee).toFixed(8));
  const sellerUsd      = parseFloat((usdAmount  - feeUsd).toFixed(2));

  const wallet = await generateWallet(coin);
  const dealId = 'DEAL-' + Math.random().toString(36).substr(2, 8).toUpperCase();

  // Add seller to channel
  await channel.permissionOverwrites.edit(seller.id, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
  });

  // Rename channel
  const buyerName  = buyer.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const sellerName = seller.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  channel.setName(`trade-${buyerName}-${sellerName}`).catch(() => {});

  const deal = {
    id: dealId,
    ticketId,
    channelId: channel.id,
    status: 'PENDING_DEPOSIT',
    coin,
    amount: coinAmount,
    usdAmount,
    usdPrice,
    fee,
    feeUsd,
    sellerReceives,
    sellerUsd,
    description,
    buyer:      buyer.id,
    seller:     seller.id,
    wallet:     wallet.address,
    privateKey: wallet.privateKey,
    createdAt:  Date.now(),
    guildId:    channel.guild.id,
  };
  db.set(dealId, deal);

  // Update ticket record
  const ticket = db.get(`ticket_${ticketId}`);
  if (ticket) {
    ticket.dealId  = dealId;
    ticket.status  = 'ACTIVE';
    delete ticket.pendingCoin;
    db.set(`ticket_${ticketId}`, ticket);
  }

  const priceStr = coin === 'USDT' ? '1.00' : usdPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });

  const embed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle(`🔒 Escrow Deal Active — \`${dealId}\``)
    .setDescription(`<@${buyer.id}> **(Buyer)** ↔ <@${seller.id}> **(Seller)**\n\n${description}`)
    .addFields(
      { name: '💵 Trade Value (USD)',    value: `**$${usdAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`, inline: true },
      { name: '🪙 Coin',                value: coin,                                        inline: true },
      { name: '📈 Rate',                value: `$${priceStr} / ${coin}`,                   inline: true },
      { name: '💰 Amount',              value: `${coinAmount} ${coin}`,                    inline: true },
      { name: '💸 Fee (1%)',            value: `${fee} ${coin} (~$${feeUsd})`,             inline: true },
      { name: '📤 Seller Receives',     value: `${sellerReceives} ${coin} (~$${sellerUsd})`, inline: true },
      {
        name: `📬 Deposit Address (${coin})`,
        value:
          `> Tap to copy on mobile:\n` +
          `\`\`\`\n${wallet.address}\n\`\`\``,
      },
      {
        name: '📋 Steps',
        value:
          `**1.** <@${buyer.id}> — send \`${coinAmount} ${coin}\` to the address above\n` +
          `**2.** <@${seller.id}> — deliver the item/gift card to the buyer\n` +
          `**3.** <@${buyer.id}> — click **✅ Confirm Receipt** once delivered → funds auto-released`,
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

  // ── Send embed first ──
  await channel.send({ content: `<@${buyer.id}> <@${seller.id}>`, embeds: [embed], components: [row] });

  // ── Then send address as a plain copyable message (critical for mobile) ──
  await channel.send(
    `📋 **Copy address below** (tap & hold on mobile):\n` +
    `\`${wallet.address}\``
  );
}

// ─────────────────────────────────────────────
// CONFIRM BUTTON
// ─────────────────────────────────────────────
async function handleConfirmButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal)                         return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id) return interaction.reply({ content: '❌ Only the buyer can confirm.', ephemeral: true });
  if (deal.status === 'COMPLETED')   return interaction.reply({ content: '✅ Already completed.', ephemeral: true });
  if (deal.status === 'CANCELLED')   return interaction.reply({ content: '❌ Already cancelled.', ephemeral: true });

  await interaction.deferReply();

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    const embed = new EmbedBuilder()
      .setColor('#ff6600')
      .setTitle('⏳ Funds Not Yet Detected')
      .addFields(
        { name: '📬 Address',  value: `\`${deal.wallet}\``, inline: false },
        { name: '🎯 Expected', value: `${deal.amount} ${deal.coin}`, inline: true },
        { name: '💵 In USD',   value: `~$${deal.usdAmount?.toFixed(2) ?? '?'}`, inline: true },
        { name: '📊 Current',  value: `${balance} ${deal.coin}`, inline: true },
      )
      .setDescription('Wait for network confirmations and try again. Usually takes 1–3 minutes.');
    return interaction.editReply({ embeds: [embed] });
  }

  deal.status = 'AWAITING_PAYOUT_ADDRESS';
  db.set(dealId, deal);

  const embed = new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle('✅ Funds Confirmed!')
    .setDescription(
      `<@${deal.seller}> — funds are in escrow! Please **reply in this channel** with your **${deal.coin} payout address** to receive \`${deal.sellerReceives} ${deal.coin}\` (~$${deal.sellerUsd ?? '?'}).`
    );

  await interaction.editReply({ embeds: [embed] });

  const collector = interaction.channel.createMessageCollector({
    filter: (m) => m.author.id === deal.seller && !m.author.bot,
    max: 1, time: 300000,
  });
  collector.on('collect', async (m) => {
    await releaseToSeller(interaction.channel, deal, m.content.trim(), dealId);
  });
  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.channel.send(`⏰ Timed out. <@${deal.seller}> run \`!mm release ${dealId} <your_address>\` to retry.`);
    }
  });
}

// ─────────────────────────────────────────────
// CANCEL BUTTON
// ─────────────────────────────────────────────
async function handleCancelButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal) return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id)
    return interaction.reply({ content: '❌ Not your deal.', ephemeral: true });
  if (deal.status === 'COMPLETED')
    return interaction.reply({ content: '❌ Deal already completed — cannot cancel.', ephemeral: true });

  await interaction.deferReply();

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance > 0) {
    return interaction.editReply(
      `⚠️ \`${balance} ${deal.coin}\` is already in escrow — cancellation blocked.\nUse the **⚠️ Dispute** button to get admin help.`
    );
  }

  deal.status = 'CANCELLED';
  db.set(dealId, deal);

  const embed = new EmbedBuilder()
    .setColor('#ff4444')
    .setTitle(`❌ Deal Cancelled — \`${dealId}\``)
    .setDescription(`Cancelled by <@${interaction.user.id}>.\nNo funds were in escrow.\n\n_Ticket closes in 30 seconds._`);
  await interaction.editReply({ embeds: [embed] });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 30000);
}

// ─────────────────────────────────────────────
// DISPUTE BUTTON
// ─────────────────────────────────────────────
async function handleDisputeButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal) return interaction.reply({ content: '❌ Deal not found.', ephemeral: true });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id)
    return interaction.reply({ content: '❌ Not your deal.', ephemeral: true });

  deal.status = 'DISPUTE';
  db.set(dealId, deal);

  const adminRole = interaction.guild.roles.cache.find(r =>
    r.permissions.has(PermissionsBitField.Flags.Administrator)
  );
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
      '**Admins have been added to this ticket** and will review the situation.\n' +
      'Please describe your issue in detail below.'
    )
    .addFields(
      { name: '💰 Amount',  value: `${deal.amount} ${deal.coin}`, inline: true },
      { name: '💵 USD',     value: deal.usdAmount ? `~$${deal.usdAmount.toFixed(2)}` : 'N/A', inline: true },
      { name: '🔄 Status',  value: `\`${deal.status}\``, inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// CLOSE TICKET BUTTON
// ─────────────────────────────────────────────
async function handleCloseButton(interaction, ticketId) {
  const ticket   = db.get(`ticket_${ticketId}`);
  const isAdmin  = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
  const isOpener = ticket && ticket.opener === interaction.user.id;

  if (!isAdmin && !isOpener)
    return interaction.reply({ content: '❌ Only admins or the ticket opener can close.', ephemeral: true });

  await interaction.reply('🔒 Closing ticket in 5 seconds…');
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ─────────────────────────────────────────────
// RELEASE FUNDS
// ─────────────────────────────────────────────
async function releaseToSeller(channel, deal, payoutAddress, dealId) {
  const loadEmbed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`💸 Processing Payout — \`${dealId}\``)
    .setDescription(`Sending \`${deal.sellerReceives} ${deal.coin}\` to:\n\`${payoutAddress}\`\n\n_This may take a moment…_`);
  await channel.send({ embeds: [loadEmbed] });

  try {
    const txHash = await sendTransaction(deal.coin, deal.privateKey, deal.wallet, payoutAddress, deal.sellerReceives);
    deal.status        = 'COMPLETED';
    deal.txHash        = txHash;
    deal.payoutAddress = payoutAddress;
    db.set(dealId, deal);

    const doneEmbed = new EmbedBuilder()
      .setColor('#00ff88')
      .setTitle(`🎉 Deal Complete — \`${dealId}\``)
      .setDescription('✅ Trade successful! Funds have been released to the seller.')
      .addFields(
        { name: '✅ Status',        value: '`COMPLETED`',                                       inline: true },
        { name: '💰 Sent',          value: `${deal.sellerReceives} ${deal.coin}`,               inline: true },
        { name: '💵 USD Value',     value: deal.sellerUsd ? `~$${deal.sellerUsd}` : 'N/A',    inline: true },
        { name: '📬 Paid To',       value: `\`${payoutAddress}\``,                             inline: false },
        { name: '🔗 TX Hash',       value: txHash ? `\`${txHash}\`` : '_Pending confirmation_' },
      )
      .setFooter({ text: 'Ticket closes in 60 seconds.' })
      .setTimestamp();

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`closeTicket_${deal.ticketId}`)
        .setLabel('🔒 Close Ticket Now')
        .setStyle(ButtonStyle.Secondary)
    );

    await channel.send({
      content: `<@${deal.buyer}> <@${deal.seller}>`,
      embeds: [doneEmbed],
      components: [closeRow],
    });
    setTimeout(() => channel.delete().catch(() => {}), 60000);

  } catch (err) {
    console.error(err);
    channel.send(
      `❌ **Payout failed:** \`${err.message}\`\n` +
      `Contact an admin with deal ID \`${dealId}\`.\n` +
      `Admin can force-release with: \`!mm release ${dealId} <address>\``
    );
  }
}

// ─────────────────────────────────────────────
// TEXT COMMANDS (inside ticket channels)
// ─────────────────────────────────────────────
async function handleConfirm(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm confirm <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id) return message.reply('❌ Only the buyer can confirm.');

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    return message.reply(
      `⏳ Funds not detected yet.\n` +
      `Expected: \`${deal.amount} ${deal.coin}\` | Balance: \`${balance} ${deal.coin}\``
    );
  }

  deal.status = 'AWAITING_PAYOUT_ADDRESS';
  db.set(dealId, deal);
  message.channel.send(`✅ Confirmed! <@${deal.seller}>, reply with your **${deal.coin} payout address**.`);

  const collector = message.channel.createMessageCollector({
    filter: (m) => m.author.id === deal.seller && !m.author.bot,
    max: 1, time: 300000,
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
  message.channel.send('❌ Cancelled. No funds were in escrow. Channel closes in 15 seconds…');
  setTimeout(() => message.channel.delete().catch(() => {}), 15000);
}

async function handleStatus(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm status <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');

  const balance = await getBalance(deal.coin, deal.wallet);
  const colors  = {
    PENDING_DEPOSIT: '#f0a500',
    AWAITING_PAYOUT_ADDRESS: '#0099ff',
    COMPLETED: '#00ff88',
    CANCELLED: '#ff4444',
    DISPUTE: '#ff6600',
  };

  const embed = new EmbedBuilder()
    .setColor(colors[deal.status] || '#888888')
    .setTitle(`📋 Status — \`${dealId}\``)
    .addFields(
      { name: '🔄 Status',       value: `\`${deal.status}\``,              inline: true },
      { name: '🪙 Coin',         value: deal.coin,                          inline: true },
      { name: '💵 USD Value',    value: deal.usdAmount ? `$${deal.usdAmount.toFixed(2)}` : 'N/A', inline: true },
      { name: '💰 Amount',       value: `${deal.amount} ${deal.coin}`,     inline: true },
      { name: '📊 Escrow Bal',   value: `${balance} ${deal.coin}`,         inline: true },
      { name: '📈 Rate',         value: deal.usdPrice ? `$${deal.usdPrice.toLocaleString()} / ${deal.coin}` : 'N/A', inline: true },
      { name: '👤 Buyer',        value: `<@${deal.buyer}>`,                inline: true },
      { name: '👤 Seller',       value: `<@${deal.seller}>`,               inline: true },
      { name: '\u200b',          value: '\u200b',                           inline: true },
      { name: '📦 Description',  value: deal.description },
      { name: '📬 Wallet',       value: `\`${deal.wallet}\`` },
    )
    .setTimestamp(deal.createdAt);

  message.channel.send({ embeds: [embed] });

  // Also send plain copyable address
  message.channel.send(`📋 **Deposit address (tap to copy):**\n\`${deal.wallet}\``);
}

async function handleRelease(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');
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
  if (deal.buyer !== message.author.id && deal.seller !== message.author.id)
    return message.reply('❌ Not your deal.');

  deal.status = 'DISPUTE';
  db.set(dealId, deal);

  const adminRole = message.guild.roles.cache.find(r =>
    r.permissions.has(PermissionsBitField.Flags.Administrator)
  );
  if (adminRole) {
    await message.channel.permissionOverwrites.edit(adminRole.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setColor('#ff6600')
    .setTitle(`⚠️ Dispute — \`${dealId}\``)
    .setDescription(`Filed by <@${message.author.id}>. Admins have been added. Please explain your issue in detail.`);
  message.channel.send({ embeds: [embed] });
}

async function handleClose(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');
  message.channel.send('🔒 Closing in 5 seconds…');
  setTimeout(() => message.channel.delete().catch(() => {}), 5000);
}

async function handleAdd(message, args) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');
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
    .setDescription('All amounts are displayed in USD and converted to crypto at the live rate.')
    .addFields(
      { name: '`!mm setup`',                      value: '*(Admin)* Create escrow category + panel channel' },
      { name: '`!mm panel`',                      value: '*(Admin)* Repost the Open Trade button' },
      { name: '`!mm status <dealID>`',            value: 'View deal status, USD value, and escrow balance' },
      { name: '`!mm confirm <dealID>`',           value: 'Buyer confirms item received → releases funds' },
      { name: '`!mm cancel <dealID>`',            value: 'Cancel deal if no funds sent yet' },
      { name: '`!mm dispute <dealID>`',           value: 'Open dispute — adds admins to ticket' },
      { name: '`!mm release <dealID> <address>`', value: '*(Admin)* Force-release funds to an address' },
      { name: '`!mm add @user`',                  value: '*(Admin)* Add someone to the ticket channel' },
      { name: '`!mm close`',                      value: '*(Admin)* Delete this ticket channel' },
    );
  message.channel.send({ embeds: [embed] });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function findOpenTicketForUser(userId) {
  const all = db.all();
  return Object.values(all).find(
    (v) => v.ticketId && v.opener === userId && (v.status === 'SETUP' || v.status === 'ACTIVE')
  ) || null;
}

client.login(config.TOKEN);

client.login(config.TOKEN);
