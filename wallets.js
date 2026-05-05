/**
 * wallets.js
 * Handles wallet generation, balance checking, and sending transactions.
 * 
 * NOTE: For production use, you MUST:
 * - Use a real node/API provider (Infura, QuickNode, Alchemy, Tatum, etc.)
 * - Store private keys securely (encrypted DB, HSM, etc.)
 * - Never log private keys
 */

const ethers = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const axios = require('axios');
const config = require('./config');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// ─── WALLET GENERATION ────────────────────────────────────────────────────────

async function generateWallet(coin) {
  switch (coin) {
    case 'ETH':
    case 'USDT':
      return generateEthWallet();
    case 'BTC':
      return generateBtcWallet();
    case 'LTC':
      return generateLtcWallet();
    case 'SOL':
      return generateSolWallet();
    default:
      throw new Error(`Unsupported coin: ${coin}`);
  }
}

function generateEthWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase,
  };
}

function generateBtcWallet() {
  const network = bitcoin.networks.bitcoin;
  const keyPair = ECPair.makeRandom({ network });
  const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
  const privateKey = keyPair.toWIF();
  return { address, privateKey };
}

function generateLtcWallet() {
  // Litecoin network params
  const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0,
  };
  const keyPair = ECPair.makeRandom({ network: litecoin });
  const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: litecoin });
  const privateKey = keyPair.toWIF();
  return { address, privateKey };
}

function generateSolWallet() {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const privateKey = bs58.encode(keypair.secretKey);
  return { address, privateKey };
}

// ─── BALANCE CHECK ────────────────────────────────────────────────────────────

async function getBalance(coin, address) {
  try {
    switch (coin) {
      case 'ETH': return await getEthBalance(address);
      case 'USDT': return await getUsdtBalance(address);
      case 'BTC': return await getBtcBalance(address);
      case 'LTC': return await getLtcBalance(address);
      case 'SOL': return await getSolBalance(address);
      default: return 0;
    }
  } catch (err) {
    console.error(`Balance check error for ${coin}:`, err.message);
    return 0;
  }
}

async function getEthBalance(address) {
  // Uses Infura — set INFURA_KEY in config
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${config.INFURA_KEY}`);
  const balance = await provider.getBalance(address);
  return parseFloat(ethers.formatEther(balance));
}

async function getUsdtBalance(address) {
  // USDT ERC-20 on Ethereum
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${config.INFURA_KEY}`);
  const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const ABI = ['function balanceOf(address) view returns (uint256)'];
  const contract = new ethers.Contract(USDT_ADDRESS, ABI, provider);
  const balance = await contract.balanceOf(address);
  return parseFloat(ethers.formatUnits(balance, 6)); // USDT has 6 decimals
}

async function getBtcBalance(address) {
  const res = await axios.get(`https://blockstream.info/api/address/${address}`);
  const { chain_stats } = res.data;
  const satoshis = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum;
  return satoshis / 1e8;
}

async function getLtcBalance(address) {
  const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`);
  return res.data.balance / 1e8;
}

async function getSolBalance(address) {
  const res = await axios.post('https://api.mainnet-beta.solana.com', {
    jsonrpc: '2.0', id: 1,
    method: 'getBalance',
    params: [address],
  });
  return res.data.result.value / 1e9; // lamports to SOL
}

// ─── SEND TRANSACTION ─────────────────────────────────────────────────────────

async function sendTransaction(coin, privateKey, fromAddress, toAddress, amount) {
  switch (coin) {
    case 'ETH': return sendEth(privateKey, toAddress, amount);
    case 'USDT': return sendUsdt(privateKey, toAddress, amount);
    case 'BTC': return sendBtc(privateKey, fromAddress, toAddress, amount);
    case 'LTC': return sendLtc(privateKey, fromAddress, toAddress, amount);
    case 'SOL': return sendSol(privateKey, toAddress, amount);
    default: throw new Error(`Unsupported coin: ${coin}`);
  }
}

async function sendEth(privateKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${config.INFURA_KEY}`);
  const wallet = new ethers.Wallet(privateKey, provider);
  const tx = await wallet.sendTransaction({
    to: toAddress,
    value: ethers.parseEther(amount.toString()),
  });
  await tx.wait();
  return tx.hash;
}

async function sendUsdt(privateKey, toAddress, amount) {
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${config.INFURA_KEY}`);
  const wallet = new ethers.Wallet(privateKey, provider);
  const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
  const contract = new ethers.Contract(USDT_ADDRESS, ABI, wallet);
  const tx = await contract.transfer(toAddress, ethers.parseUnits(amount.toString(), 6));
  await tx.wait();
  return tx.hash;
}

async function sendBtc(privateKey, fromAddress, toAddress, amount) {
  // Uses BlockCypher API to build & broadcast tx
  const satoshis = Math.floor(amount * 1e8);
  const network = bitcoin.networks.bitcoin;

  // Create tx skeleton via BlockCypher
  const skeletonRes = await axios.post(
    `https://api.blockcypher.com/v1/btc/main/txs/new?token=${config.BLOCKCYPHER_TOKEN}`,
    { inputs: [{ addresses: [fromAddress] }], outputs: [{ addresses: [toAddress], value: satoshis }] }
  );

  const tmx = skeletonRes.data;
  const keyPair = ECPair.fromWIF(privateKey, network);

  // Sign each input
  tmx.pubkeys = [];
  tmx.signatures = tmx.tosign.map((tosign, i) => {
    tmx.pubkeys.push(keyPair.publicKey.toString('hex'));
    const hash = Buffer.from(tosign, 'hex');
    const sig = keyPair.sign(hash);
    return Buffer.from(sig).toString('hex');
  });

  // Send signed tx
  const sendRes = await axios.post(
    `https://api.blockcypher.com/v1/btc/main/txs/send?token=${config.BLOCKCYPHER_TOKEN}`,
    tmx
  );
  return sendRes.data.hash;
}

async function sendLtc(privateKey, fromAddress, toAddress, amount) {
  const satoshis = Math.floor(amount * 1e8);
  const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0,
  };

  const skeletonRes = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/txs/new?token=${config.BLOCKCYPHER_TOKEN}`,
    { inputs: [{ addresses: [fromAddress] }], outputs: [{ addresses: [toAddress], value: satoshis }] }
  );

  const tmx = skeletonRes.data;
  const keyPair = ECPair.fromWIF(privateKey, litecoin);

  tmx.pubkeys = [];
  tmx.signatures = tmx.tosign.map((tosign) => {
    tmx.pubkeys.push(keyPair.publicKey.toString('hex'));
    const sig = keyPair.sign(Buffer.from(tosign, 'hex'));
    return Buffer.from(sig).toString('hex');
  });

  const sendRes = await axios.post(
    `https://api.blockcypher.com/v1/ltc/main/txs/send?token=${config.BLOCKCYPHER_TOKEN}`,
    tmx
  );
  return sendRes.data.hash;
}

async function sendSol(privateKeyB58, toAddress, amount) {
  const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const secretKey = bs58.decode(privateKeyB58);
  const fromKeypair = Keypair.fromSecretKey(secretKey);
  const toPublicKey = new PublicKey(toAddress);
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: toPublicKey, lamports })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return signature;
}

module.exports = { generateWallet, getBalance, sendTransaction };
