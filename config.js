/**
 * config.js
 * ⚠️ FILL IN YOUR API KEYS BEFORE RUNNING
 * Never commit this file to GitHub with real keys!
 */

module.exports = {
  // Discord Bot Token — from https://discord.com/developers/applications
  TOKEN: 'YOUR_DISCORD_BOT_TOKEN',

  // Bot command prefix
  PREFIX: '!',

  // Infura API Key — for ETH/USDT — https://infura.io
  INFURA_KEY: 'YOUR_INFURA_PROJECT_ID',

  // BlockCypher Token — for BTC/LTC — https://www.blockcypher.com
  BLOCKCYPHER_TOKEN: 'YOUR_BLOCKCYPHER_TOKEN',

  // Your fee collection wallet addresses (1% fee goes here)
  FEE_WALLETS: {
    BTC: 'YOUR_BTC_FEE_WALLET',
    ETH: 'YOUR_ETH_FEE_WALLET',
    LTC: 'YOUR_LTC_FEE_WALLET',
    SOL: 'YOUR_SOL_FEE_WALLET',
    USDT: 'YOUR_ETH_FEE_WALLET', // USDT uses ETH address
  },
};
