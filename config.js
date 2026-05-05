module.exports = {
  TOKEN:            process.env.DISCORD_TOKEN,
  PREFIX:           process.env.PREFIX || '!',
  INFURA_KEY:       process.env.INFURA_KEY,
  FEE_WALLETS: {
    BTC:  process.env.FEE_WALLET_BTC,
    ETH:  process.env.FEE_WALLET_ETH,
    LTC:  process.env.FEE_WALLET_LTC,
    SOL:  process.env.FEE_WALLET_SOL,
    USDT: process.env.FEE_WALLET_ETH, // same as ETH
  },
};
