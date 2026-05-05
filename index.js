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

// Basic address format validators per coin
const ADDRESS_PATTERNS = {
  BTC:  /^(1|3|bc1)[a-zA-Z0-9]{25,62}$/,
  ETH:  /^0x[a-fA-F0-9]{40}$/,
  LTC:  /^(L|M|ltc1)[a-zA-Z0-9]{25,62}$/,
  SOL:  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  USDT: /^(0x[a-fA-F0-9]{40}|T[a-zA-Z0-9]{33})$/,
};

// Cooldown store to prevent confirm button spam (userId → timestamp)
const confirmCooldowns = new Map();
const CONFIRM_COOLDOWN_MS = 10_000;

// ─────────────────────────────────────────────
// PRICE FETCHING — retry + dual-endpoint for LTC reliability
// ─────────────────────────────────────────────

/**
 * Fetch live USD price for a coin.
 * Tries the simple/price endpoint first, falls back to the full coin endpoint.
 * Retries up to 3 times with a 1.5s delay between attempts.
 */
async function getCoinPriceUSD(coin, retries = 3) {
  if (coin === 'USDT') return 1;

  const id = COIN_IDS[coin];

  const fetchFromSimple = async () => {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = data[id]?.usd;
    if (!price) throw new Error('No price in response');
    return price;
  };

  const fetchFromCoinEndpoint = async () => {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const price = data.market_data?.current_price?.usd;
    if (!price) throw new Error('No price in response');
    return price;
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetchFromSimple();
    } catch {
      try {
        return await fetchFromCoinEndpoint();
      } catch {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
  }

  return null;
}

async function usdToCoin(usdAmount, coin) {
  if (coin === 'USDT') return { coinAmount: parseFloat(usdAmount.toFixed(2)), price: 1 };
  const price = await getCoinPriceUSD(coin);
  if (!price) return null;
  const coinAmount = parseFloat((usdAmount / price).toFixed(8));
  return { coinAmount, price };
}

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────

async function auditLog(guild, embed) {
  try {
    const logChannelId = config.AUDIT_LOG_CHANNEL_ID;
    if (!logChannelId) return;
    const ch = await guild.channels.fetch(logChannelId).catch(() => null);
    if (ch) ch.send({ embeds: [embed] });
  } catch { /* non-critical */ }
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

client.once('clientReady', () => {
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
        case 'deals':    return handleDeals(message);
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
    if (interaction.isButton()) {
      const [action, ...rest] = interaction.customId.split('_');
      switch (action) {
        case 'openTicket':    return handleOpenTicketButton(interaction);
        case 'confirmDeal':   return handleConfirmButton(interaction, rest[0]);
        case 'cancelDeal':    return handleCancelButton(interaction, rest[0]);
        case 'disputeDeal':   return handleDisputeButton(interaction, rest[0]);
        case 'closeTicket':   return handleCloseButton(interaction, rest[0]);
        case 'claimFunds':    return handleClaimFundsButton(interaction, rest[0]);
      }
    }

    if (interaction.isModalSubmit()) {
      const [action, ...rest] = interaction.customId.split('_');
      if (action === 'tradeModal')  return handleTradeModalSubmit(interaction, rest[0]);
      if (action === 'claimModal')  return handleClaimModalSubmit(interaction, rest[0]);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('coinSelect_')) {
        return handleCoinSelect(interaction);
      }
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '❌ Error: ' + err.message, flags: 64 });
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
      { name: '📌 Next',     value: 'Users open trades by clicking the button in that channel.\n\nOptionally set `AUDIT_LOG_CHANNEL_ID` in config to enable deal audit logging.' }
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
      '`2.` Choose your coin and fill in the form\n' +
      '`3.` Buyer deposits → Seller delivers → Buyer confirms\n' +
      '`4.` Seller clicks **💰 Claim Funds** and enters their payout address ✅'
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
// OPEN TICKET BUTTON
// ─────────────────────────────────────────────
async function handleOpenTicketButton(interaction) {
  await interaction.deferReply({ flags: 64 });

  const guild     = interaction.guild;
  const user      = interaction.user;
  const guildData = db.get(`guild_${guild.id}`);

  if (!guildData)
    return interaction.editReply('❌ Escrow system not configured. Ask an admin to run `!mm setup`.');

  const existing = findOpenTicketForUser(user.id);
  if (existing)
    return interaction.editReply(`❌ You already have an open ticket: <#${existing.channelId}>`);

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

  const coinEmbed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle('🔒 Trade Ticket — Step 1 of 2')
    .setDescription(
      `Welcome <@${user.id}>!\n\n` +
      '**Select the cryptocurrency** for this trade.\n' +
      'You\'ll enter the **USD amount** in the next step — the bot converts it at the live rate.'
    )
    .setFooter({ text: `Ticket: ${ticketId} · Prices via CoinGecko` });

  const coinSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`coinSelect_${ticketId}`)
      .setPlaceholder('Choose a coin…')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Bitcoin (BTC)').setValue('BTC').setEmoji('🟠'),
        new StringSelectMenuOptionBuilder().setLabel('Ethereum (ETH)').setValue('ETH').setEmoji('🔷'),
        new StringSelectMenuOptionBuilder().setLabel('Litecoin (LTC)').setValue('LTC').setEmoji('🪙'),
        new StringSelectMenuOptionBuilder().setLabel('Solana (SOL)').setValue('SOL').setEmoji('🟣'),
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

  const ticket = db.get(`ticket_${ticketId}`);
  if (!ticket) return interaction.reply({ content: '❌ Ticket not found.', flags: 64 });
  ticket.pendingCoin = coin;
  db.set(`ticket_${ticketId}`, ticket);

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
    .setPlaceholder('e.g. Trading $150 Amazon gift card')
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
  await interaction.deferReply({ flags: 64 });

  const ticket = db.get(`ticket_${ticketId}`);
  if (!ticket) return interaction.editReply('❌ Ticket not found.');

  const coin        = ticket.pendingCoin;
  const rawSeller   = interaction.fields.getTextInputValue('sellerUserId').trim().replace(/[<@!>]/g, '');
  const rawUsd      = interaction.fields.getTextInputValue('usdAmount').trim().replace(/[$,]/g, '');
  const description = interaction.fields.getTextInputValue('description').trim() || 'No description provided';

  const usdAmount = parseFloat(rawUsd);
  if (isNaN(usdAmount) || usdAmount <= 0)
    return interaction.editReply('❌ Invalid USD amount. Enter a positive number like `150.00`.');
  if (usdAmount < 1)
    return interaction.editReply('❌ Minimum trade value is **$1.00 USD**.');

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

  // Guard: prevent same two users from having multiple active deals
  const duplicateDeal = findActiveDealBetween(interaction.user.id, seller.id);
  if (duplicateDeal)
    return interaction.editReply(`❌ You already have an active deal with that user: \`${duplicateDeal.id}\``);

  // Notify while fetching price (can take a moment, especially for LTC)
  await interaction.editReply(`⏳ Fetching live **${coin}** price…`);

  const conversion = await usdToCoin(usdAmount, coin);
  if (!conversion)
    return interaction.editReply(
      `❌ Could not fetch live price for **${coin}** after multiple retries.\n` +
      `CoinGecko may be rate-limiting. Please wait 60 seconds and try again.`
    );

  const { coinAmount, price } = conversion;

  const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) return interaction.editReply('❌ Ticket channel not found.');

  await interaction.editReply('✅ Price fetched! Setting up deal…');
  await startDeal(channel, interaction.user, seller.user, coin, coinAmount, usdAmount, price, description, ticketId);
}

// ─────────────────────────────────────────────
// START DEAL
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

  const ticket = db.get(`ticket_${ticketId}`);
  if (ticket) {
    ticket.dealId  = dealId;
    ticket.status  = 'ACTIVE';
    delete ticket.pendingCoin;
    db.set(`ticket_${ticketId}`, ticket);
  }

  const priceStr = coin === 'USDT'
    ? '1.00'
    : usdPrice.toLocaleString('en-US', { maximumFractionDigits: 2 });

  const embed = new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle(`🔒 Escrow Deal Active — \`${dealId}\``)
    .setDescription(`<@${buyer.id}> **(Buyer)** ↔ <@${seller.id}> **(Seller)**\n\n${description}`)
    .addFields(
      { name: '💵 Trade Value (USD)',  value: `**$${usdAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`, inline: true },
      { name: '🪙 Coin',              value: coin,                                              inline: true },
      { name: '📈 Rate',              value: `$${priceStr} / ${coin}`,                         inline: true },
      { name: '💰 Amount',            value: `${coinAmount} ${coin}`,                          inline: true },
      { name: '💸 Fee (1%)',          value: `${fee} ${coin} (~$${feeUsd})`,                   inline: true },
      { name: '📤 Seller Receives',   value: `${sellerReceives} ${coin} (~$${sellerUsd})`,     inline: true },
      {
        name: `📬 Deposit Address (${coin})`,
        value: `\`\`\`\n${wallet.address}\n\`\`\``,
      },
      {
        name: '📋 Steps',
        value:
          `**1.** <@${buyer.id}> — send \`${coinAmount} ${coin}\` to the address above\n` +
          `**2.** <@${seller.id}> — deliver the item/service to the buyer\n` +
          `**3.** <@${buyer.id}> — click **✅ Confirm Receipt** once satisfied\n` +
          `**4.** <@${seller.id}> — click **💰 Claim Funds** and enter your payout address`,
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

  // Plain copyable address (critical for mobile)
  await channel.send(`📋 **Copy deposit address** (tap & hold on mobile):\n\`${wallet.address}\``);

  // Schedule a deposit timeout warning at 30 minutes
  setTimeout(async () => {
    const freshDeal = db.get(dealId);
    if (!freshDeal || freshDeal.status !== 'PENDING_DEPOSIT') return;
    try {
      const balance = await getBalance(coin, wallet.address);
      if (balance < coinAmount * 0.99) {
        channel.send(
          `⏰ **Deposit reminder** — <@${buyer.id}>, no deposit detected after 30 minutes.\n` +
          `Expected: \`${coinAmount} ${coin}\` → \`${wallet.address}\`\n` +
          `If this trade is no longer needed, click **❌ Cancel**.`
        ).catch(() => {});
      }
    } catch { /* ignore */ }
  }, 30 * 60 * 1000);

  // Audit log
  await auditLog(channel.guild, new EmbedBuilder()
    .setColor('#f0a500')
    .setTitle(`📋 Deal Opened — \`${dealId}\``)
    .addFields(
      { name: 'Buyer',  value: `<@${buyer.id}>`,  inline: true },
      { name: 'Seller', value: `<@${seller.id}>`, inline: true },
      { name: 'Amount', value: `${coinAmount} ${coin} (~$${usdAmount})`, inline: true },
    )
    .setTimestamp()
  );
}

// ─────────────────────────────────────────────
// CONFIRM BUTTON  (buyer only)
// ─────────────────────────────────────────────
async function handleConfirmButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal)                              return interaction.reply({ content: '❌ Deal not found.', flags: 64 });
  if (deal.buyer !== interaction.user.id) return interaction.reply({ content: '❌ Only the buyer can confirm receipt.', flags: 64 });
  if (deal.status === 'COMPLETED')        return interaction.reply({ content: '✅ This deal is already completed.', flags: 64 });
  if (deal.status === 'CANCELLED')        return interaction.reply({ content: '❌ This deal was cancelled.', flags: 64 });
  if (deal.status === 'AWAITING_CLAIM')   return interaction.reply({ content: '⏳ Already confirmed — waiting for seller to claim funds.', flags: 64 });

  // Cooldown check
  const lastConfirm = confirmCooldowns.get(interaction.user.id);
  if (lastConfirm && Date.now() - lastConfirm < CONFIRM_COOLDOWN_MS) {
    const remaining = Math.ceil((CONFIRM_COOLDOWN_MS - (Date.now() - lastConfirm)) / 1000);
    return interaction.reply({ content: `⏳ Please wait ${remaining}s before trying again.`, flags: 64 });
  }
  confirmCooldowns.set(interaction.user.id, Date.now());

  await interaction.deferReply();

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    const embed = new EmbedBuilder()
      .setColor('#ff6600')
      .setTitle('⏳ Funds Not Yet Detected')
      .addFields(
        { name: '📬 Address',  value: `\`${deal.wallet}\``,          inline: false },
        { name: '🎯 Expected', value: `${deal.amount} ${deal.coin}`,  inline: true },
        { name: '💵 In USD',   value: `~$${deal.usdAmount?.toFixed(2) ?? '?'}`, inline: true },
        { name: '📊 Current',  value: `${balance} ${deal.coin}`,     inline: true },
      )
      .setDescription('Wait for network confirmations and try again. Usually 1–3 minutes.');
    return interaction.editReply({ embeds: [embed] });
  }

  deal.status = 'AWAITING_CLAIM';
  db.set(dealId, deal);

  const confirmedEmbed = new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle('✅ Receipt Confirmed!')
    .setDescription(
      `<@${deal.buyer}> has confirmed receipt of the item/service.\n\n` +
      `<@${deal.seller}> — click **💰 Claim Funds** below to enter your **${deal.coin} payout address** and receive \`${deal.sellerReceives} ${deal.coin}\` (~$${deal.sellerUsd ?? '?'}).`
    );

  const claimRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claimFunds_${dealId}`)
      .setLabel('💰 Claim Funds')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`disputeDeal_${dealId}`)
      .setLabel('⚠️ Dispute')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [confirmedEmbed], components: [claimRow] });

  await auditLog(interaction.guild, new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle(`✅ Receipt Confirmed — \`${dealId}\``)
    .addFields(
      { name: 'Buyer',  value: `<@${deal.buyer}>`,  inline: true },
      { name: 'Seller', value: `<@${deal.seller}>`, inline: true },
      { name: 'Status', value: 'Awaiting seller claim', inline: true },
    )
    .setTimestamp()
  );
}

// ─────────────────────────────────────────────
// CLAIM FUNDS BUTTON  (seller only) → opens modal
// ─────────────────────────────────────────────
async function handleClaimFundsButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal)
    return interaction.reply({ content: '❌ Deal not found.', flags: 64 });
  if (deal.seller !== interaction.user.id)
    return interaction.reply({ content: '❌ Only the seller can claim funds.', flags: 64 });
  if (deal.status !== 'AWAITING_CLAIM')
    return interaction.reply({ content: '❌ Funds are not ready to be claimed yet. Wait for the buyer to confirm receipt.', flags: 64 });

  const modal = new ModalBuilder()
    .setCustomId(`claimModal_${dealId}`)
    .setTitle(`Claim ${deal.sellerReceives} ${deal.coin}`);

  const addressInput = new TextInputBuilder()
    .setCustomId('payoutAddress')
    .setLabel(`Your ${deal.coin} payout address`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(getAddressPlaceholder(deal.coin))
    .setMinLength(20)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(addressInput));
  await interaction.showModal(modal);
}

// ─────────────────────────────────────────────
// CLAIM MODAL SUBMIT
// ─────────────────────────────────────────────
async function handleClaimModalSubmit(interaction, dealId) {
  await interaction.deferReply({ flags: 64 });

  const deal = db.get(dealId);
  if (!deal)
    return interaction.editReply('❌ Deal not found.');
  if (deal.seller !== interaction.user.id)
    return interaction.editReply('❌ Only the seller can claim.');
  if (deal.status !== 'AWAITING_CLAIM')
    return interaction.editReply('❌ This deal is not in a claimable state.');

  const payoutAddress = interaction.fields.getTextInputValue('payoutAddress').trim();

  // Validate address format
  const pattern = ADDRESS_PATTERNS[deal.coin];
  if (pattern && !pattern.test(payoutAddress)) {
    return interaction.editReply(
      `❌ **Invalid ${deal.coin} address format.**\n` +
      `Please double-check your address and try again.\n` +
      `Expected format example: \`${getAddressPlaceholder(deal.coin)}\``
    );
  }

  await interaction.editReply(`⏳ Processing payout of \`${deal.sellerReceives} ${deal.coin}\` to \`${payoutAddress}\`…`);

  const channel = await interaction.guild.channels.fetch(deal.channelId).catch(() => null);
  await releaseToSeller(channel, deal, payoutAddress, dealId);
}

// ─────────────────────────────────────────────
// CANCEL BUTTON
// ─────────────────────────────────────────────
async function handleCancelButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal)
    return interaction.reply({ content: '❌ Deal not found.', flags: 64 });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id)
    return interaction.reply({ content: '❌ Not your deal.', flags: 64 });
  if (deal.status === 'COMPLETED')
    return interaction.reply({ content: '❌ Deal already completed — cannot cancel.', flags: 64 });
  if (deal.status === 'AWAITING_CLAIM')
    return interaction.reply({ content: '❌ Buyer already confirmed receipt — use **⚠️ Dispute** if there is an issue.', flags: 64 });

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

  await auditLog(interaction.guild, new EmbedBuilder()
    .setColor('#ff4444')
    .setTitle(`❌ Deal Cancelled — \`${dealId}\``)
    .addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true })
    .setTimestamp()
  );
}

// ─────────────────────────────────────────────
// DISPUTE BUTTON
// ─────────────────────────────────────────────
async function handleDisputeButton(interaction, dealId) {
  const deal = db.get(dealId);
  if (!deal)
    return interaction.reply({ content: '❌ Deal not found.', flags: 64 });
  if (deal.buyer !== interaction.user.id && deal.seller !== interaction.user.id)
    return interaction.reply({ content: '❌ Not your deal.', flags: 64 });

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
      '**Admins have been added to this ticket.** Please describe your issue in detail below.\n\n' +
      `Admin force-release: \`!mm release ${dealId} <address>\``
    )
    .addFields(
      { name: '💰 Amount', value: `${deal.amount} ${deal.coin}`, inline: true },
      { name: '💵 USD',    value: deal.usdAmount ? `~$${deal.usdAmount.toFixed(2)}` : 'N/A', inline: true },
      { name: '🔄 Status', value: `\`DISPUTE\``, inline: true },
    );

  await interaction.reply({ embeds: [embed] });

  await auditLog(interaction.guild, new EmbedBuilder()
    .setColor('#ff6600')
    .setTitle(`⚠️ Dispute — \`${dealId}\``)
    .addFields(
      { name: 'Filed By', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Amount',   value: `${deal.amount} ${deal.coin}`, inline: true },
    )
    .setTimestamp()
  );
}

// ─────────────────────────────────────────────
// CLOSE TICKET BUTTON
// ─────────────────────────────────────────────
async function handleCloseButton(interaction, ticketId) {
  const ticket   = db.get(`ticket_${ticketId}`);
  const isAdmin  = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
  const isOpener = ticket && ticket.opener === interaction.user.id;

  if (!isAdmin && !isOpener)
    return interaction.reply({ content: '❌ Only admins or the ticket opener can close.', flags: 64 });

  await interaction.reply('🔒 Closing ticket in 5 seconds…');
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ─────────────────────────────────────────────
// RELEASE FUNDS
// ─────────────────────────────────────────────
async function releaseToSeller(channel, deal, payoutAddress, dealId) {
  const send = async (payload) => {
    if (channel) await channel.send(payload).catch(() => {});
  };

  await send({ embeds: [
    new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`💸 Processing Payout — \`${dealId}\``)
      .setDescription(`Sending \`${deal.sellerReceives} ${deal.coin}\` to:\n\`${payoutAddress}\`\n\n_This may take a moment…_`)
  ]});

  try {
    const txHash = await sendTransaction(deal.coin, deal.privateKey, deal.wallet, payoutAddress, deal.sellerReceives);
    deal.status        = 'COMPLETED';
    deal.txHash        = txHash;
    deal.payoutAddress = payoutAddress;
    db.set(dealId, deal);

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`closeTicket_${deal.ticketId}`)
        .setLabel('🔒 Close Ticket Now')
        .setStyle(ButtonStyle.Secondary)
    );

    await send({
      content: `<@${deal.buyer}> <@${deal.seller}>`,
      embeds: [new EmbedBuilder()
        .setColor('#00ff88')
        .setTitle(`🎉 Deal Complete — \`${dealId}\``)
        .setDescription('✅ Trade successful! Funds have been released to the seller.')
        .addFields(
          { name: '✅ Status',    value: '`COMPLETED`',                                    inline: true },
          { name: '💰 Sent',      value: `${deal.sellerReceives} ${deal.coin}`,            inline: true },
          { name: '💵 USD Value', value: deal.sellerUsd ? `~$${deal.sellerUsd}` : 'N/A',  inline: true },
          { name: '📬 Paid To',   value: `\`${payoutAddress}\``,                          inline: false },
          { name: '🔗 TX Hash',   value: txHash ? `\`${txHash}\`` : '_Pending confirmation_' },
        )
        .setFooter({ text: 'Ticket closes in 60 seconds.' })
        .setTimestamp()
      ],
      components: [closeRow],
    });

    if (channel) setTimeout(() => channel.delete().catch(() => {}), 60000);

    if (channel?.guild) {
      await auditLog(channel.guild, new EmbedBuilder()
        .setColor('#00ff88')
        .setTitle(`🎉 Deal Completed — \`${dealId}\``)
        .addFields(
          { name: 'Buyer',   value: `<@${deal.buyer}>`,  inline: true },
          { name: 'Seller',  value: `<@${deal.seller}>`, inline: true },
          { name: 'Sent',    value: `${deal.sellerReceives} ${deal.coin}`, inline: true },
          { name: 'TX Hash', value: txHash ? `\`${txHash}\`` : 'N/A' },
        )
        .setTimestamp()
      );
    }

  } catch (err) {
    console.error(err);
    await send(
      `❌ **Payout failed:** \`${err.message}\`\n` +
      `Contact an admin with deal ID \`${dealId}\`.\n` +
      `Admin can force-release with: \`!mm release ${dealId} ${payoutAddress}\``
    );
  }
}

// ─────────────────────────────────────────────
// TEXT COMMANDS
// ─────────────────────────────────────────────
async function handleConfirm(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm confirm <dealID>`');
  const deal = db.get(dealId);
  if (!deal)                             return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id)  return message.reply('❌ Only the buyer can confirm.');
  if (deal.status === 'AWAITING_CLAIM')  return message.reply('⏳ Already confirmed — waiting for seller to claim.');

  const balance = await getBalance(deal.coin, deal.wallet);
  if (balance < deal.amount * 0.99) {
    return message.reply(
      `⏳ Funds not detected yet.\nExpected: \`${deal.amount} ${deal.coin}\` | Balance: \`${balance} ${deal.coin}\``
    );
  }

  deal.status = 'AWAITING_CLAIM';
  db.set(dealId, deal);

  const claimRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claimFunds_${dealId}`)
      .setLabel('💰 Claim Funds')
      .setStyle(ButtonStyle.Success),
  );

  message.channel.send({
    content: `✅ Receipt confirmed by <@${deal.buyer}>!\n\n<@${deal.seller}> — click **💰 Claim Funds** below to enter your payout address.`,
    components: [claimRow],
  });
}

async function handleCancel(message, args) {
  const dealId = args[0];
  if (!dealId) return message.reply('❌ Usage: `!mm cancel <dealID>`');
  const deal = db.get(dealId);
  if (!deal) return message.reply('❌ Deal not found.');
  if (deal.buyer !== message.author.id && deal.seller !== message.author.id)
    return message.reply('❌ Not your deal.');
  if (deal.status === 'COMPLETED')      return message.reply('❌ Already completed.');
  if (deal.status === 'AWAITING_CLAIM') return message.reply('❌ Already confirmed — use `!mm dispute` if there is an issue.');

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

  const [balance, livePrice] = await Promise.all([
    getBalance(deal.coin, deal.wallet),
    getCoinPriceUSD(deal.coin),
  ]);
  const liveUsdValue = livePrice ? (balance * livePrice).toFixed(2) : null;

  const colors = {
    PENDING_DEPOSIT: '#f0a500',
    AWAITING_CLAIM:  '#0099ff',
    COMPLETED:       '#00ff88',
    CANCELLED:       '#ff4444',
    DISPUTE:         '#ff6600',
  };

  const embed = new EmbedBuilder()
    .setColor(colors[deal.status] || '#888888')
    .setTitle(`📋 Status — \`${dealId}\``)
    .addFields(
      { name: '🔄 Status',     value: `\`${deal.status}\``,       inline: true },
      { name: '🪙 Coin',       value: deal.coin,                   inline: true },
      { name: '💵 Deal USD',   value: deal.usdAmount ? `$${deal.usdAmount.toFixed(2)}` : 'N/A', inline: true },
      { name: '💰 Amount',     value: `${deal.amount} ${deal.coin}`, inline: true },
      { name: '📊 Escrow Bal', value: `${balance} ${deal.coin}${liveUsdValue ? ` (~$${liveUsdValue})` : ''}`, inline: true },
      { name: '📈 Live Rate',  value: livePrice ? `$${livePrice.toLocaleString()} / ${deal.coin}` : 'N/A', inline: true },
      { name: '👤 Buyer',      value: `<@${deal.buyer}>`,          inline: true },
      { name: '👤 Seller',     value: `<@${deal.seller}>`,         inline: true },
      { name: '\u200b',        value: '\u200b',                    inline: true },
      { name: '📦 Description', value: deal.description },
      { name: '📬 Wallet',     value: `\`${deal.wallet}\`` },
    )
    .setTimestamp(deal.createdAt);

  message.channel.send({ embeds: [embed] });
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
    .setDescription(
      `Filed by <@${message.author.id}>. Admins have been added. Please explain your issue.\n\n` +
      `Admin command: \`!mm release ${dealId} <address>\``
    );
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

// ─────────────────────────────────────────────
// !mm deals  (admin) — list all active deals
// ─────────────────────────────────────────────
async function handleDeals(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return message.reply('❌ Admin only.');

  const all = db.all();
  const active = Object.values(all).filter(v =>
    v.id?.startsWith('DEAL-') &&
    v.guildId === message.guild.id &&
    !['COMPLETED', 'CANCELLED'].includes(v.status)
  );

  if (!active.length) return message.reply('✅ No active deals at the moment.');

  const lines = active.map(d =>
    `\`${d.id}\` | ${d.coin} | \`${d.status}\` | <@${d.buyer}> ↔ <@${d.seller}> | $${d.usdAmount?.toFixed(2) ?? '?'}`
  );

  const embed = new EmbedBuilder()
    .setColor('#0099ff')
    .setTitle(`📊 Active Deals — ${active.length} open`)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  message.channel.send({ embeds: [embed] });
}

async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setColor('#00ff88')
    .setTitle('💎 Escrow Bot — Commands')
    .setDescription('All amounts are entered in USD and converted to crypto at the live rate.')
    .addFields(
      { name: '`!mm setup`',                      value: '*(Admin)* Create escrow category + panel channel' },
      { name: '`!mm panel`',                      value: '*(Admin)* Repost the Open Trade button' },
      { name: '`!mm deals`',                      value: '*(Admin)* List all active deals in this server' },
      { name: '`!mm status <dealID>`',            value: 'View deal status, live balance & current USD value' },
      { name: '`!mm confirm <dealID>`',           value: 'Buyer confirms receipt → seller can claim funds' },
      { name: '`!mm cancel <dealID>`',            value: 'Cancel deal if no funds sent yet' },
      { name: '`!mm dispute <dealID>`',           value: 'Open dispute — adds admins to ticket' },
      { name: '`!mm release <dealID> <address>`', value: '*(Admin)* Force-release funds to an address' },
      { name: '`!mm add @user`',                  value: '*(Admin)* Add someone to the ticket channel' },
      { name: '`!mm close`',                      value: '*(Admin)* Delete this ticket channel' },
    )
    .setFooter({ text: 'Set AUDIT_LOG_CHANNEL_ID in config.js to enable deal audit logging.' });
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

function findActiveDealBetween(userId1, userId2) {
  const all = db.all();
  return Object.values(all).find(v =>
    v.id?.startsWith('DEAL-') &&
    !['COMPLETED', 'CANCELLED'].includes(v.status) &&
    ((v.buyer === userId1 && v.seller === userId2) || (v.buyer === userId2 && v.seller === userId1))
  ) || null;
}

function getAddressPlaceholder(coin) {
  const examples = {
    BTC:  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    ETH:  '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    LTC:  'ltc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    SOL:  '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
    USDT: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  };
  return examples[coin] ?? 'Enter your address';
}

// ─────────────────────────────────────────────
client.login(config.TOKEN);
