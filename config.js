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
  INFURA_KEY: '28362088b1084d088f7f200eca9fbda3',

  // BlockCypher Token — for BTC/LTC — https://www.blockcypher.com
  BLOCKCYPHER_TOKEN: '5f5140bfc90840c3a486ccf6a3320004',

  // Your fee collection wallet addresses (1% fee goes here)
  FEE_WALLETS: {
    BTC: 'bc1qfz9uy464zgw7x8982487cjg2n9vwg8lyfds6wz',
    ETH: '0x2B7e3690096e27B66C5864aaCD722A923490843F',
    LTC: 'LggbDmxgvmUKD2x9UsKszQT3XpPMYAsdvW',
    SOL: 'DoBZvHVJpC2JJgmS5Km7Y5DjgTAq8ej9jTHnvWAy6cqN',
    USDT: '0x2B7e3690096e27B66C5864aaCD722A923490843F', // USDT uses ETH address
  },
};
