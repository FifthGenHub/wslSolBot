const { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const WebSocket = require('ws');
const bs58 = require('bs58');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

// Logging setup
const logStream = fs.createWriteStream('raydium_sniper.log', { flags: 'a' });

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  logStream.write(`[${timestamp}] ${message}\n`);
}

// --- ENVIRONMENT CHECKS ---
if (!process.env.HELIUS_API_KEY) {
  console.error('Missing HELIUS_API_KEY in .env');
  process.exit(1);
}
if (!process.env.WALLET_PATH || !fs.existsSync(process.env.WALLET_PATH)) {
  console.error('Missing or invalid WALLET_PATH in .env');
  process.exit(1);
}
const PAPER_TRADING = true; // Set to false to trade with real funds

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; // From .env
const connection = new Connection(`https://mainnet.helius-rpc.com?api-key=${HELIUS_API_KEY}`, 'confirmed');
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync('/mnt/c/Users/Charl/solana_node_bot/my_mainnet_wallet.json', 'utf8')))
);
log(`Wallet Public Key: ${wallet.publicKey.toBase58()}`);

// --- UPDATED RAYDIUM AMM PROGRAM ADDRESS (2025) ---
const RAYDIUM_AMM_PROGRAM = new PublicKey('RVKd61ztZW9GdKzvKzF1dM1iQb1r7Q2Q8k5Y6bRZzjL');
const AMOUNT_TO_TRADE = 0.01 * LAMPORTS_PER_SOL; // ~$1.34 per trade
const MINIMUM_LIQUIDITY = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL minimum liquidity
const TAKE_PROFIT = 1.0; // 100% profit
const STOP_LOSS = -0.5; // 50% stop-loss
const MAX_TOKEN_AGE_SECONDS = 1800; // 30 minutes

const purchasedTokens = new Map();

// Fetch token metadata using Helius
async function fetchTokenMetadata(tokenMint) {
  try {
    const response = await fetch(`https://api.helius.xyz/v0/tokens/metadata?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [tokenMint] }),
    });
    const data = await response.json();
    if (!data || data.length === 0) return null;
    return data[0];
  } catch (error) {
    log(`Error fetching metadata for ${tokenMint}: ${error.message}`);
    return null;
  }
}

// Fetch pool details (simplified; ideally decode using Raydium IDL)
async function fetchPoolDetails(poolAddress) {
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(poolAddress));
    if (!accountInfo) return null;

    // Simplified: Check SOL balance as a proxy for liquidity
    const solBalance = await connection.getBalance(new PublicKey(poolAddress));
    return { liquidity: solBalance };
  } catch (error) {
    log(`Error fetching pool details for ${poolAddress}: ${error.message}`);
    return null;
  }
}

// --- IMPROVED ERROR HANDLING FOR FETCH ---
async function safeFetch(url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    return await res.json();
  } catch (e) {
    log(`Fetch error for ${url}: ${e.message}`);
    return null;
  }
}

// Fetch token price via Jupiter API (in SOL)
async function fetchTokenPrice(tokenMint, amount) {
  const quote = await safeFetch(`https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=${amount}&slippageBps=100`);
  if (!quote) return null;
  return quote.outAmount / LAMPORTS_PER_SOL; // Price in SOL
}

// Execute a swap using Jupiter API
async function executeSwap(tokenMint, amount, isBuy) {
  if (PAPER_TRADING) {
    log(`${isBuy ? 'Bought' : 'Sold'} [PAPER TRADING] ${amount / LAMPORTS_PER_SOL} SOL worth of ${tokenMint}`);
    return true;
  }
  try {
    const quote = await safeFetch(`https://quote-api.jup.ag/v6/quote?inputMint=${isBuy ? 'So11111111111111111111111111111111111111112' : tokenMint}&outputMint=${isBuy ? tokenMint : 'So11111111111111111111111111111111111111112'}&amount=${amount}&slippageBps=100`);
    if (!quote) throw new Error('Failed to fetch quote from Jupiter');

    const swapResponse = await fetch(`https://quote-api.jup.ag/v6/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });
    const swap = await swapResponse.json();
    if (!swap.swapTransaction) throw new Error('Failed to get swap transaction');

    const swapTransactionBuf = Buffer.from(swap.swapTransaction, 'base64');
    const transaction = Transaction.from(swapTransactionBuf);
    transaction.sign(wallet);

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
    });
    await connection.confirmTransaction(txid, 'confirmed');
    log(`${isBuy ? 'Bought' : 'Sold'} ${amount / LAMPORTS_PER_SOL} SOL worth of ${tokenMint}, TXID: ${txid}`);
    return true;
  } catch (error) {
    log(`Swap failed for ${tokenMint}: ${error.message}`);
    return false;
  }
}
async function snipeNewPools() {
  log('Starting Raydium sniper bot...');

  const balance = await connection.getBalance(wallet.publicKey);
  log(`Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_API_KEY}`);

  ws.on('open', () => {
    log('Connected to Helius WebSocket');
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [RAYDIUM_AMM_PROGRAM.toBase58()],
          commitment: 'confirmed',
        },
        { commitment: 'confirmed' },
      ],
    }));
  });

  ws.on('message', async (data) => {
    log('Received WebSocket message');
    const message = JSON.parse(data);
    log(`Message content: ${JSON.stringify(message, null, 2)}`);

    if (message.method !== 'logNotification') {
      log('Skipping message: Not a log notification');
      return;
    }

    const logData = message.params?.result?.value;
    if (!logData) {
      log('Skipping message: No log data');
      return;
    }

    const signature = logData.signature;
    if (!signature) {
      log('Skipping message: No transaction signature');
      return;
    }

    // Fetch the full transaction using the signature
    const transactionResponse = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!transactionResponse) {
      log(`Failed to fetch transaction for signature ${signature}`);
      return;
    }

    const transaction = transactionResponse.transaction;
    if (!transaction) {
      log('Skipping transaction: No transaction data');
      return;
    }

    // Decode the transaction to find Raydium pool creation (initialize instruction)
    const instructions = transaction.message?.instructions || [];
    const raydiumInstruction = instructions.find(inst =>
      inst?.programId === RAYDIUM_AMM_PROGRAM.toBase58() &&
      inst?.data
    );

    if (!raydiumInstruction) {
      log('Skipping transaction: No Raydium AMM initialize instruction found');
      return;
    }

    // Log all accounts in the instruction for debugging
    log(`Raydium instruction accounts: ${raydiumInstruction.accounts?.join(', ') || 'No accounts'}`);

    // Extract pool address and token mint (simplified; in production, use Raydium IDL)
    const poolAddress = raydiumInstruction.accounts?.[0]; // First account is typically the pool
    const tokenMint = raydiumInstruction.accounts?.[4]; // Token mint is usually the 5th account (depends on instruction layout)

    if (!poolAddress || !tokenMint) {
      log('Failed to extract pool address or token mint');
      return;
    }

    const poolDetails = await fetchPoolDetails(poolAddress);
    if (!poolDetails || poolDetails.liquidity < MINIMUM_LIQUIDITY) {
      log(`Skipping pool ${poolAddress}: Insufficient liquidity (${poolDetails?.liquidity / LAMPORTS_PER_SOL} SOL)`);
      return;
    }

    const metadata = await fetchTokenMetadata(tokenMint);
    if (!metadata) {
      log(`Skipping token ${tokenMint}: Failed to fetch metadata`);
      return;
    }

    const slot = transactionResponse.slot;
    const blockTimeResponse = await safeFetch(`https://api.helius.xyz/v0/blocks/${slot}?api-key=${HELIUS_API_KEY}`);
    if (!blockTimeResponse || !blockTimeResponse.time) {
      log(`Failed to fetch block time for slot ${slot}`);
      return;
    }
    const blockTime = blockTimeResponse.time;
    const currentTime = Math.floor(Date.now() / 1000);
    const tokenAgeSeconds = currentTime - blockTime;
    if (tokenAgeSeconds > MAX_TOKEN_AGE_SECONDS) {
      log(`Skipping token ${tokenMint}: Too old (${tokenAgeSeconds}s)`);
      return;
    }

    log(`New pool detected: Token ${tokenMint}, Liquidity ${poolDetails.liquidity / LAMPORTS_PER_SOL} SOL`);
    const buyPrice = await fetchTokenPrice(tokenMint, AMOUNT_TO_TRADE);
    if (!buyPrice) {
      log(`Skipping token ${tokenMint}: Failed to fetch buy price`);
      return;
    }

    const success = await executeSwap(tokenMint, AMOUNT_TO_TRADE, true);
    if (success) {
      purchasedTokens.set(tokenMint, {
        buyPrice: buyPrice,
        amount: AMOUNT_TO_TRADE / LAMPORTS_PER_SOL,
      });
      log(`Sniped ${tokenMint}: Bought ${AMOUNT_TO_TRADE / LAMPORTS_PER_SOL} SOL worth at ${buyPrice} SOL`);
    }
  });

  ws.on('error', (error) => log(`WebSocket error: ${error.message}`));
  ws.on('close', (code, reason) => {
    log(`WebSocket closed: ${code} - ${reason}`);
    log('Attempting to reconnect in 5 seconds...');
    setTimeout(() => {
      snipeNewPools();
    }, 5000);
  });
}

// Monitor purchased tokens and sell if profit/loss conditions are met
async function monitorAndSell() {
  while (true) {
    for (const [tokenMint, { buyPrice, amount }] of purchasedTokens.entries()) {
      const currentPrice = await fetchTokenPrice(tokenMint, amount * LAMPORTS_PER_SOL);
      if (!currentPrice) continue;

      const profit = (currentPrice - buyPrice) / buyPrice;
      log(`Monitoring ${tokenMint}: Profit ${(profit * 100).toFixed(2)}%`);

      if (profit >= TAKE_PROFIT || profit <= STOP_LOSS) {
        const success = await executeSwap(tokenMint, amount * LAMPORTS_PER_SOL, false);
        if (success) {
          log(`Sold ${tokenMint} at profit ${(profit * 100).toFixed(2)}%`);
          purchasedTokens.delete(tokenMint);
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
  }
}

// Start the bot
Promise.all([
  snipeNewPools(),
  monitorAndSell(),
]).catch(error => log(`Fatal error: ${error.message}`));

process.on('SIGINT', () => {
  log('Shutting down...');
  logStream.end();
  process.exit(0);
});