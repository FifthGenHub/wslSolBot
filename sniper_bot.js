require('dotenv').config({ path: '/mnt/c/Users/Charl/solana_node_bot_secure/.env' });

function log(level, message, error = null) {
  const timestamp = new Date().toISOString();
  let formattedMessage = `[${timestamp}] [${level}] ${message}`;
  if (error) {
    formattedMessage += `\nError: ${error.message}\nStack: ${error.stack || 'No stack trace'}`;
  }
  console.log(formattedMessage);
  require('fs').appendFileSync('sniper_bot.log', formattedMessage + '\n');
}

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const { getAccount, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const borsh = require('@coral-xyz/borsh');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const botConfig = require('./config.json'); // Use botConfig to avoid linter issues
const { readFileSync, appendFileSync, existsSync, writeFileSync } = require('fs');
const { createHash } = require('crypto');
const { Mutex } = require('async-mutex');
const RateLimiter = require('limiter').RateLimiter;
const BN = require('bn.js');
const fs = require('fs');
const PUMP_FUN_PROGRAM_ID = new PublicKey(process.env.PUMP_FUN_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRwfCKubJ14M5uBEwF6P');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const CLEAR_TOKENS_ON_STARTUP = botConfig.CLEAR_TOKENS_ON_STARTUP;
const PAPER_TRADING = botConfig.PAPER_TRADING;
const AMOUNT_TO_TRADE = botConfig.AMOUNT_TO_TRADE;
const MAX_TOKEN_AGE_SECONDS = botConfig.MAX_TOKEN_AGE_SECONDS;
const MINIMUM_LIQUIDITY = botConfig.MINIMUM_LIQUIDITY;
const PRICE_THRESHOLD = botConfig.PRICE_THRESHOLD;
const MINIMUM_BALANCE = botConfig.MINIMUM_BALANCE;
const TRAILING_STOP_PERCENT = botConfig.TRAILING_STOP_PERCENT;
const TAKE_PROFIT = botConfig.TAKE_PROFIT;
const PNL_THRESHOLD = botConfig.PNL_THRESHOLD;
const DEFAULT_DECIMALS = botConfig.DEFAULT_DECIMALS;
const MAX_ATA_RETRIES = botConfig.MAX_ATA_RETRIES;
const RPC_DELAY_MS = botConfig.RPC_DELAY_MS;
const MAX_ATA_CREATIONS = botConfig.MAX_ATA_CREATIONS;
const HEALTH_CHECK_INTERVAL_MINUTES = botConfig.HEALTH_CHECK_INTERVAL_MINUTES;
const HEALTH_CHECK_INTERVAL_MS = HEALTH_CHECK_INTERVAL_MINUTES * 60 * 1000
const RUG_PULL_MIN_LIQUIDITY = 0.1; // Minimum liquidity threshold to detect rug pulls (in SOL)
const MAX_DAILY_TRADES = botConfig.MAX_DAILY_TRADES;
const MINIMUM_HOLDERS = botConfig.MINIMUM_HOLDERS;
const ACTIVITY_WINDOW_MINUTES = botConfig.ACTIVITY_WINDOW_MINUTES;
const MAX_TOKENS_HELD = botConfig.MAX_TOKENS_HELD;
const BLACKLIST_DURATION_HOURS = botConfig.BLACKLIST_DURATION_HOURS;
const FORCE_SELL_DEAD_MINUTES = botConfig.FORCE_SELL_DEAD_MINUTES;
const MIN_TXS_IN_WINDOW = botConfig.MIN_TXS_IN_WINDOW;
const MAX_PENDING_TOKENS = botConfig.MAX_PENDING_TOKENS;
const PARTIAL_TAKE_PROFIT_LEVELS = botConfig.PARTIAL_TAKE_PROFIT_LEVELS;
const PARTIAL_TAKE_PROFIT_PERCENTS = botConfig.PARTIAL_TAKE_PROFIT_PERCENTS;
const MOONBAG_PERCENT = botConfig.MOONBAG_PERCENT;
const AUTO_COMPOUND = botConfig.AUTO_COMPOUND;
const DYNAMIC_POSITION_SIZING = botConfig.DYNAMIC_POSITION_SIZING;
const STOP_LOSS_PERCENT = botConfig.STOP_LOSS_PERCENT;
const PROFIT_LOCK_THRESHOLD = botConfig.PROFIT_LOCK_THRESHOLD;
const WALLET_PATH = '/mnt/c/Users/Charl/solana_node_bot/my_mainnet_wallet.json';

// Define RPC_URL and FALLBACK_RPC_URL after loading .env
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const FALLBACK_RPC_URL = 'https://api.mainnet-beta.solana.com';

// Load constants from config.json
let appConfig;
try {
  appConfig = JSON.parse(readFileSync('config.json', 'utf-8'));
  log('INFO', 'Successfully loaded config.json');
} catch (error) {
  log('ERROR', 'Failed to load config.json, using defaults:', error);
  appConfig = {};
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
appConfig.MAX_ATA_RETRIES = appConfig.MAX_ATA_RETRIES || 3;
appConfig.RPC_DELAY_MS = appConfig.RPC_DELAY_MS || 200; // Increased default to 200ms
appConfig.MAX_ATA_CREATIONS = appConfig.MAX_ATA_CREATIONS || 10;
appConfig.PAPER_TRADING = appConfig.PAPER_TRADING !== undefined ? appConfig.PAPER_TRADING : true;
appConfig.HEALTH_CHECK_INTERVAL_MS = (appConfig.HEALTH_CHECK_INTERVAL_MINUTES || 30) * 60 * 1000;
const MAX_RETRIES = 3;
const SNIPE_DELAY_MS = 1000; // Added delay between sniping attempts

// --- Configurable retry for new mints ---
const HOLDERS_RETRY_COUNT = appConfig.HOLDERS_RETRY_COUNT || 3; // Number of retries
const HOLDERS_RETRY_DELAY_MS = appConfig.HOLDERS_RETRY_DELAY_MS || 2000; // 2 seconds
const HOLDERS_RETRY_TIMEOUT = appConfig.HOLDERS_RETRY_TIMEOUT || 10000; // 10 seconds

async function getTokenHolders(tokenMint) {
  for (let attempt = 1; attempt <= HOLDERS_RETRY_COUNT; attempt++) {
    try {
      // Use Solana RPC to get token largest accounts (holders)
      const resp = await withRateLimit(() => connection.getTokenLargestAccounts(tokenMint));
      return resp.value.length;
    } catch (e) {
      if (e.message && e.message.includes('Invalid param: not a Token mint')) {
        if (attempt < HOLDERS_RETRY_COUNT) {
          log('INFO', `Token ${tokenMint.toBase58()} not indexed yet (attempt ${attempt}/${HOLDERS_RETRY_COUNT}), retrying in ${HOLDERS_RETRY_DELAY_MS}ms...`);
          await delay(HOLDERS_RETRY_DELAY_MS);
          continue;
        } else {
          log('WARN', `Token ${tokenMint.toBase58()} still not indexed after ${HOLDERS_RETRY_COUNT} attempts. Skipping.`);
          return 0;
        }
      } else {
        log('WARN', `Failed to fetch holders for ${tokenMint.toBase58()}: ${e.message}`);
        return 0;
      }
    }
  }
  return 0;
}

async function getRecentTokenActivity(tokenMint) {
  try {
    // Use Solana RPC to get recent signatures for token mint
    const since = Date.now() / 1000 - ACTIVITY_WINDOW_MINUTES * 60;
    const sigs = await withRateLimit(() => connection.getSignaturesForAddress(tokenMint, { limit: 20 }));
    return sigs.some(sig => sig.blockTime && sig.blockTime > since);
  } catch (e) {
    log('WARN', `Failed to fetch activity for ${tokenMint.toBase58()}: ${e.message}`);
    return false;
  }
}

let connection;
let wallet;
let sdk;
const purchasedTokens = new Map();
const pendingTokens = new Map();
const purchasedTokensMutex = new Mutex();
const pendingTokensMutex = new Mutex();
let ataCreations = 0;
let virtualBalance;
const tradeHistory = [];
let subscriptionId;
const rpcLimiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' }); // 10 requests per second

// --- Track partial take-profits and moonbag for each token ---
const tokenProfitTracking = new Map(); // tokenMint -> { levelsHit: [], moonbagLeft: bool }

// Compute CreateEvent discriminator
const CREATE_EVENT_DISCRIMINATOR = Buffer.from(
  createHash('sha256').update('event:CreateEvent').digest().slice(0, 8)
);

async function withRateLimit(fn) {
  try {
    await rpcLimiter.removeTokens(1);
    return await fn();
  } catch (error) {
    // Only treat actual rate limit or network errors as rate limit errors
    if (error.message && (error.message.includes('ECONNREFUSED') || error.message.includes('timeout'))) {
      log('WARN', `RPC connection failed, attempting to reconnect...`);
      connection = new Connection(RPC_URL, 'confirmed');
      await delay(1000);
      return await fn();
    }
    // If it's a TokenAccountNotFoundError, don't log as rate limit error
    if (error.name === 'TokenAccountNotFoundError' || error.message?.includes('TokenAccountNotFoundError')) {
      throw error; // Let checkAtaExists handle this as expected
    }
    log('ERROR', `Rate limit or RPC error: ${error.message}, Stack: ${error.stack}`, error);
    throw error;
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function validatePumpFunProgram(connection, programId) {
  if (!programId) {
    log('ERROR', 'Program ID is undefined in validatePumpFunProgram');
    throw new Error('Program ID is undefined');
  }
  try {
    const accountInfo = await connection.getAccountInfo(programId);
    if (!accountInfo) {
      log('WARN', `Manual check: PumpFun program account ${programId.toBase58()} not found`);
    } else {
      log('INFO', `Manual check: PumpFun program account ${programId.toBase58()} found`);
    }
  } catch (error) {
    log('ERROR', `Manual check failed: ${error.message}`);
  }
  log('INFO', `Skipping PumpFun program validation for ${programId.toBase58()} (temporary bypass)`);
  return true;
}

async function validateMint(tokenMint) {
  try {
    const accountInfo = await withRateLimit(() => connection.getAccountInfo(tokenMint, 'confirmed'));
    if (!accountInfo) {
      log('WARN', `Mint ${tokenMint.toBase58()} does not exist`);
      return null;
    }
    log('INFO', `Mint ${tokenMint.toBase58()} owner: ${accountInfo.owner.toBase58()}, data length: ${accountInfo.data.length}`);
    if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
    if (accountInfo.owner.equals(new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'))) {
      return new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    }
    log('WARN', `Mint ${tokenMint.toBase58()} is not a valid SPL token`);
    return null;
  } catch (error) {
    log('ERROR', `Error validating mint ${tokenMint.toBase58()}: ${error.message}`, error);
    return null;
  }
}

async function validateBondingCurve(bondingCurveAddress, tokenMint) {
  try {
    const accountInfo = await withRateLimit(() => connection.getAccountInfo(new PublicKey(bondingCurveAddress), 'confirmed'));
    if (!accountInfo) {
      log('WARN', `Bonding curve ${bondingCurveAddress} does not exist for mint ${tokenMint.toBase58()}`);
      return false;
    }
    if (!accountInfo.owner.equals(new PublicKey(PUMP_FUN_PROGRAM_ID))) {
      log('WARN', `Bonding curve ${bondingCurveAddress} owner ${accountInfo.owner.toBase58()} does not match PumpFun program ${PUMP_FUN_PROGRAM_ID}`);
      return false;
    }
    log('INFO', `Bonding curve ${bondingCurveAddress} for mint ${tokenMint.toBase58()} is valid, owner: ${accountInfo.owner.toBase58()}, data length: ${accountInfo.data.length}`);
    return true;
  } catch (error) {
    log('ERROR', `Error validating bonding curve ${bondingCurveAddress} for mint ${tokenMint.toBase58()}: ${error.message}`, error);
    return false;
  }
}

async function checkAtaExists(tokenMint, tokenProgramId) {
  const ata = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, tokenProgramId);
  try {
    await withRateLimit(() => getAccount(connection, ata, 'confirmed', tokenProgramId));
    return { exists: true, ata };
  } catch (error) {
    // Only log as info if it's TokenAccountNotFoundError, else warn
    if (error.name === 'TokenAccountNotFoundError' || error.message?.includes('TokenAccountNotFoundError')) {
      log('INFO', `ATA ${ata.toBase58()} does not exist for mint ${tokenMint.toBase58()}`);
    } else {
      log('WARN', `Error checking ATA existence for mint ${tokenMint.toBase58()}: ${error.message}`, error);
    }
    return { exists: false, ata };
  }
}

async function sendTransactionWithRetry(transaction, signers, tokenMint) {
  if (PAPER_TRADING) {
    log('INFO', `[PAPER TRADING] Simulating transaction for token ${tokenMint.toBase58()}...`);
    return `SIMULATED-TXID-${Date.now()}`;
  }

  transaction.feePayer = wallet.publicKey;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log('INFO', `Fetching latest blockhash (Attempt ${attempt}/${MAX_RETRIES})...`);
      const { blockhash, lastValidBlockHeight } = await withRateLimit(() => connection.getLatestBlockhash('confirmed'));
      transaction.recentBlockhash = blockhash;
      log('INFO', `Sending transaction (Attempt ${attempt}/${MAX_RETRIES})...`);
      const signature = await withRateLimit(() => sendAndConfirmTransaction(connection, transaction, signers, {
        commitment: 'confirmed',
        maxRetries: 5,
        skipPreflight: false,
        confirmationTimeout: 30000,
      }));
      log('INFO', `Transaction confirmed with signature: ${signature}`);
      return signature;
    } catch (error) {
      log('WARN', `Transaction attempt ${attempt} failed for token ${tokenMint.toBase58()}: ${error.message}, Stack: ${error.stack}`, error);
      if (attempt === MAX_RETRIES) throw new Error(`Failed to send transaction after ${MAX_RETRIES} attempts: ${error.message}`);
      await delay(1000);
    }
  }
}

async function createAtaWithRetry(tokenMint, tokenProgramId) {
  const { exists, ata: tokenAta } = await checkAtaExists(tokenMint, tokenProgramId);
  if (exists) {
    log('INFO', `ATA already exists for token ${tokenMint.toBase58()}`);
    return { amount: 0 };
  }

  if (ataCreations >= MAX_ATA_CREATIONS) {
    throw new Error(`Reached maximum ATA creations (${MAX_ATA_CREATIONS}). Stopping to preserve balance.`);
  }

  for (let attempt = 1; attempt <= MAX_ATA_RETRIES; attempt++) {
    try {
      log('INFO', `Creating ATA for token ${tokenMint.toBase58()} (Attempt ${attempt}/${MAX_ATA_CREATIONS})...`);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
        {
          programId: ASSOCIATED_TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            { pubkey: tokenAta, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
            { pubkey: tokenMint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: tokenProgramId, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([0x01]),
        }
      );
      const txid = await sendTransactionWithRetry(tx, [wallet], tokenMint);
      ataCreations++;
      if (PAPER_TRADING) {
        virtualBalance -= 0.002 * Number(LAMPORTS_PER_SOL);
        virtualBalance -= 0.000005 * Number(LAMPORTS_PER_SOL);
        log('INFO', `[PAPER TRADING] Simulated ATA creation for token ${tokenMint.toBase58()}, TXID: ${txid}. Total ATA creations: ${ataCreations}`);
        log('INFO', `[PAPER TRADING] Virtual balance after ATA creation: ${virtualBalance / Number(LAMPORTS_PER_SOL)} SOL`);
        return { amount: 0 };
      }
      log('INFO', `Created ATA for token ${tokenMint.toBase58()}, TXID: ${txid}. Total ATA creations: ${ataCreations}`);
      return await withRateLimit(() => getAccount(connection, tokenAta, 'confirmed', tokenProgramId));
    } catch (error) {
      log('WARN', `ATA creation attempt ${attempt} failed for token ${tokenMint.toBase58()}: ${error.message}, Stack: ${error.stack}`, error);
      if (error.message.includes('InsufficientFunds') || error.message.includes('Custom: 1')) {
        throw new Error(`Insufficient funds to create ATA for ${tokenMint.toBase58()}. Stopping to preserve balance.`);
      }
      if (attempt === MAX_ATA_RETRIES) {
        throw new Error(`Failed to create ATA after ${MAX_ATA_RETRIES} attempts: ${error.message}`);
      }
      await delay(1000);
    }
  }
}

async function deriveBondingCurveAddress(tokenMint) {
  try {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
      new PublicKey(PUMP_FUN_PROGRAM_ID)
    );
    log('INFO', `Derived bonding curve address for mint ${tokenMint.toBase58()}: ${bondingCurve.toBase58()}`);
    return bondingCurve.toBase58();
  } catch (error) {
    log('ERROR', `Failed to derive bonding curve address for mint ${tokenMint.toBase58()}: ${error.message}`, error);
    return null;
  }
}

const bondingCurveSchema = borsh.struct([
  borsh.u64('virtualTokenReserves'),
  borsh.u64('virtualSolReserves'),
  borsh.u64('realTokenReserves'),
  borsh.u64('realSolReserves'),
  borsh.u64('tokenTotalSupply'),
  borsh.bool('complete'),
]);

async function fetchBondingCurveData(bondingCurveAddress, tokenMint) {
  try {
    if (!bondingCurveAddress) {
      throw new Error('Bonding curve address is undefined');
    }
    const bondingCurve = new PublicKey(bondingCurveAddress);
    const accountInfo = await withRateLimit(() => connection.getAccountInfo(bondingCurve, 'confirmed'));
    if (!accountInfo) {
      log('WARN', `Bonding curve account not found: ${bondingCurveAddress}`);
      return { bondingCurveAccount: null, liquidity: 0, price: 0 };
    }
    const bondingCurveAccount = bondingCurveSchema.decode(accountInfo.data);
    const liquidity = Number(bondingCurveAccount.realSolReserves) / Number(LAMPORTS_PER_SOL);
    const price = Number(bondingCurveAccount.virtualSolReserves) / Number(bondingCurveAccount.virtualTokenReserves);
    return { bondingCurveAccount, liquidity, price };
  } catch (error) {
    log('ERROR', `Error fetching bonding curve data for ${bondingCurveAddress}: ${error.message}`, error);
    return { bondingCurveAccount: null, liquidity: 0, price: 0 };
  }
}

async function getPoolInfo(bondingCurveAddress, tokenMint) {
  try {
    if (!bondingCurveAddress || !tokenMint) {
      log('WARN', `Invalid bondingCurveAddress (${bondingCurveAddress}) or tokenMint (${tokenMint ? tokenMint.toBase58() : 'null'})`);
      return { tokenMint: null, bondingCurve: null, liquidity: 0, price: 0 };
    }
    const { bondingCurveAccount, liquidity, price } = await fetchBondingCurveData(bondingCurveAddress, tokenMint);
    if (!bondingCurveAccount) {
      log('WARN', `No bonding curve account for ${bondingCurveAddress}`);
      return { tokenMint: null, bondingCurve: null, liquidity: 0, price: 0 };
    }
    if (bondingCurveAccount.complete) {
      log('INFO', `Bonding curve ${bondingCurveAddress} is complete, skipping trade`);
      return { tokenMint: null, bondingCurve: null, liquidity: 0, price: 0 };
    }
    return { tokenMint, bondingCurve: bondingCurveAddress, liquidity, price };
  } catch (error) {
    log('ERROR', `Error in getPoolInfo for ${bondingCurveAddress}: ${error.message}`, error);
    return { tokenMint: null, bondingCurve: null, liquidity: 0, price: 0 };
  }
}

async function extractTokenMintFromTx(signature, logFn) {
  try {
    logFn('INFO', `Fetching transaction ${signature} for token mint extraction...`);
    const tx = await withRateLimit(() => connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }));
    if (!tx) {
      logFn('WARN', `Transaction ${signature} not found`);
      return null;
    }

    const logs = tx.meta?.logMessages || [];
    if (!logs.some(log => log.includes('Instruction: Create'))) {
      logFn('INFO', `Transaction ${signature} is not a token creation`);
      return null;
    }

    const MAX_STRING_LENGTH = 1024;
    for (const log of logs) {
      if (log.startsWith('Program data:')) {
        const base64Data = log.split(' ')[2];
        try {
          const eventData = Buffer.from(base64Data, 'base64');
          logFn('INFO', `Program data (base64): ${base64Data}`);
          if (eventData.length < 16) {
            logFn('WARN', `Invalid event data length: ${eventData.length}`);
            continue;
          }
          if (!eventData.slice(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) {
            logFn('INFO', `Not a CreateEvent: discriminator mismatch`);
            continue;
          }
          const nameLength = eventData.readUInt32LE(8);
          if (nameLength > MAX_STRING_LENGTH) {
            logFn('WARN', `Invalid name length: ${nameLength}`);
            continue;
          }
          const symbolOffset = 12 + nameLength;
          if (symbolOffset + 4 > eventData.length) {
            logFn('WARN', `Invalid symbol offset: ${symbolOffset}`);
            continue;
          }
          const symbolLength = eventData.readUInt32LE(symbolOffset);
          if (symbolLength > MAX_STRING_LENGTH) {
            logFn('WARN', `Invalid symbol length: ${symbolLength}`);
            continue;
          }
          const uriOffset = symbolOffset + 4 + symbolLength;
          if (uriOffset + 4 > eventData.length) {
            logFn('WARN', `Invalid uri offset: ${uriOffset}`);
            continue;
          }
          const uriLength = eventData.readUInt32LE(uriOffset);
          if (uriLength > MAX_STRING_LENGTH) {
            logFn('WARN', `Invalid uri length: ${uriLength}`);
            continue;
          }
          const mintOffset = uriOffset + 4 + uriLength;
          const bondingCurveOffset = mintOffset + 32;
          if (bondingCurveOffset + 32 > eventData.length) {
            logFn('WARN', `Invalid data length for public keys: ${eventData.length}`);
            continue;
          }
          const mint = new PublicKey(eventData.slice(mintOffset, mintOffset + 32));
          const bondingCurve = new PublicKey(eventData.slice(bondingCurveOffset, bondingCurveOffset + 32));
          logFn('INFO', `CreateEvent parsed: mint=${mint.toBase58()}, bondingCurve=${bondingCurve.toBase58()}`);
          return { mint, bondingCurve };
        } catch (decodeError) {
          logFn('ERROR', `Failed to parse event in log: ${decodeError.message}`, decodeError);
        }
      }
    }
    logFn('INFO', `No CreateEvent found in transaction ${signature}`);
    return null;
  } catch (error) {
    logFn('ERROR', `Error extracting token mint from TX ${signature}: ${error.message}`, error);
    return null;
  }
}

// --- SAFETY: Track tokens that failed to buy/sell to avoid repeated attempts ---
const failedTokens = new Map(); // tokenMint -> { lastFailed: timestamp, failCount: number }
const GLOBAL_STOP_LOSS_SOL = 0.01; // Stop all trading if wallet drops below this

// --- Advanced Feature: Rug Pull/Honeypot Detection ---
const blacklistedTokens = new Map(); // tokenMint -> timestamp blacklisted until
const RUG_PULL_LIQUIDITY_DROP = 0.8; // 80% drop triggers blacklist
const BLACKLIST_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Advanced Feature: CSV Trade Logging ---
const tradeHistoryCsvFile = 'trade_history.csv';
function logTradeCsv(trade) {
  const header = 'type,tokenMint,amount,price,timestamp,txid,balanceAfter\n';
  const row = `${trade.type},${trade.tokenMint},${trade.amount},${trade.price},${trade.timestamp},${trade.txid},${trade.balanceAfter}\n`;
  if (!existsSync(tradeHistoryCsvFile)) writeFileSync(tradeHistoryCsvFile, header);
  appendFileSync(tradeHistoryCsvFile, row);
}

// --- Advanced Feature: Cooldown after failed trades ---
const failedCooldowns = new Map(); // tokenMint -> timestamp until can retry
const FAILED_COOLDOWN_MS = 60 * 1000; // 1 minute

async function ensureSdkConnection() {
  if (!connection || typeof connection.getAccountInfo !== 'function') {
    log('ERROR', 'Solana connection is not valid. Re-initializing connection.');
    connection = new Connection(RPC_URL, 'confirmed');
  }
  if (!sdk || !sdk.buy || !sdk.sell) {
    log('ERROR', 'PumpFunSDK is not valid. Re-initializing SDK.');
    const pumpFunProgramId = new PublicKey(PUMP_FUN_PROGRAM_ID);
    sdk = new PumpFunSDK(
      wallet,
      connection,
      TOKEN_PROGRAM_ID,
      pumpFunProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
  }
}

// --- Raydium/Jupiter fallback buy (minimal, no SDK) ---
const fetch = require('cross-fetch');

async function fallbackRaydiumBuy(tokenMint, amountToTrade) {
  try {
    // Use Jupiter aggregator for best route (Raydium/Orca etc)
    const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMint.toBase58()}&amount=${amountToTrade}&slippageBps=100`);
    const quote = await quoteResponse.json();
    if (!quote || !quote.outAmount) throw new Error('Failed to fetch quote from Jupiter');

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
    let txid;
    try {
      // Try versioned transaction first (Jupiter v0)
      const versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([wallet]);
      txid = await connection.sendTransaction(versionedTx, { skipPreflight: true, maxRetries: 5 });
    } catch (e) {
      // Fallback to legacy transaction if not versioned
      const transaction = Transaction.from(swapTransactionBuf);
      transaction.sign(wallet);
      txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
    }
    await connection.confirmTransaction(txid, 'confirmed');
    log('INFO', `[FALLBACK] Bought ${amountToTrade / Number(LAMPORTS_PER_SOL)} SOL worth of ${tokenMint.toBase58()} via Jupiter/Raydium, TXID: ${txid}`);
    return true;
  } catch (error) {
    log('ERROR', `[FALLBACK] Raydium/Jupiter buy failed for ${tokenMint.toBase58()}: ${error.message}`);
    return false;
  }
}

async function fallbackRaydiumSell(tokenMint, amountToSell) {
  try {
    // Use Jupiter aggregator for best route (Raydium/Orca etc)
    const quoteResponse = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${amountToSell}&slippageBps=100`);
    const quote = await quoteResponse.json();
    if (!quote || !quote.outAmount) throw new Error('Failed to fetch quote from Jupiter');

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
    let txid;
    try {
      // Try versioned transaction first (Jupiter v0)
      const versionedTx = VersionedTransaction.deserialize(swapTransactionBuf);
      versionedTx.sign([wallet]);
      txid = await connection.sendTransaction(versionedTx, { skipPreflight: true, maxRetries: 5 });
    } catch (e) {
      // Fallback to legacy transaction if not versioned
      const transaction = Transaction.from(swapTransactionBuf);
      transaction.sign(wallet);
      txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
    }
    await connection.confirmTransaction(txid, 'confirmed');
    log('INFO', `[FALLBACK] Sold ${amountToSell / Number(LAMPORTS_PER_SOL)} tokens of ${tokenMint.toBase58()} via Jupiter/Raydium, TXID: ${txid}`);
    return true;
  } catch (error) {
    log('ERROR', `[FALLBACK] Raydium/Jupiter sell failed for ${tokenMint.toBase58()}: ${error.message}`);
    return false;
  }
}

// --- Dynamic Goals Tracker ---
let goals = {
  survival: { desc: 'Keep at least 0.060 SOL', met: false },
  firstWin: { desc: 'First profitable trade', met: false },
  smallProfit: { desc: 'Reach 0.08 SOL', met: false },
  threeWins: { desc: '3 consecutive profitable trades', met: false, streak: 0 },
  doubleUp: { desc: 'Reach 0.15 SOL', met: false },
  rugAvoid: { desc: '10 trades without a rug', met: false, count: 0 },
  bigWin: { desc: 'Single trade with 100%+ profit', met: false },
};
let lastSolBalance = 0.076; // Starting balance
let lastTradeProfit = 0;
let rugCount = 0;

function updateGoals(trade) {
  // Survival
  if (!goals.survival.met && trade.balanceAfter >= 0.06) goals.survival.met = true;
  // First win
  if (!goals.firstWin.met && trade.profit && trade.profit > 0) goals.firstWin.met = true;
  // Small profit
  if (!goals.smallProfit.met && trade.balanceAfter >= 0.08) goals.smallProfit.met = true;
  // Double up
  if (!goals.doubleUp.met && trade.balanceAfter >= 0.15) goals.doubleUp.met = true;
  // Big win
  if (!goals.bigWin.met && trade.profitPercent && trade.profitPercent >= 100) goals.bigWin.met = true;
  // 3 consecutive wins
  if (trade.profit && trade.profit > 0) {
    goals.threeWins.streak++;
    if (goals.threeWins.streak >= 3) goals.threeWins.met = true;
  } else {
    goals.threeWins.streak = 0;
  }
  // Rug avoidance (simulate: negative profit = rug)
  if (trade.profit && trade.profit < 0) {
    rugCount++;
    goals.rugAvoid.count = 0;
  } else {
    goals.rugAvoid.count++;
    if (goals.rugAvoid.count >= 10) goals.rugAvoid.met = true;
  }
}

function logTradeWithFun(trade) {
  let emoji = '';
  let funMsg = '';
  if (trade.profitPercent && trade.profitPercent >= 100) {
    emoji = '🚀🚀🚀';
    funMsg = 'MOONSHOT! 100%+ PROFIT!';
  } else if (trade.profit && trade.profit > 0) {
    emoji = '💰';
    funMsg = 'Nice win!';
  } else if (trade.profit && trade.profit < 0) {
    emoji = '💀';
    funMsg = 'Ouch! Rug or loss!';
  } else {
    emoji = '🤔';
    funMsg = 'Break even.';
  }
  const lines = [
    '==================== TRADE ====================',
    `${emoji} ${trade.type.toUpperCase()} | Token: ${trade.tokenMint}`,
    `Amount: ${trade.amount} | Price: ${trade.price}`,
    trade.type === 'sell' && trade.profit !== undefined ? `Profit: ${trade.profit} SOL (${trade.profitPercent}%) ${funMsg}` : '',
    `Balance After: ${trade.balanceAfter} SOL`,
    `TXID: ${trade.txid}`,
    funMsg && !trade.profitPercent ? funMsg : '',
    '-----------------------------------------------',
    JSON.stringify(trade),
    '===============================================\n',
  ].filter(Boolean).join('\n');
  fs.appendFileSync('trades.log', lines + '\n');
}

async function executeTrade(tokenMint, amountToTrade, isBuy, bondingCurveAddress) {
  await ensureSdkConnection();
  log('INFO', 'PumpFunSDK connection ensured.');
  // --- Max Daily Trades ---
  const today = new Date().getUTCDate();
  if (today !== lastTradeDay) {
    dailyTradeCount = 0;
    lastTradeDay = today;
  }
  if (dailyTradeCount >= MAX_DAILY_TRADES) {
    log('WARN', `Max daily trades (${MAX_DAILY_TRADES}) reached. Skipping further trades today.`);
    return false;
  }
  // --- Blacklist check ---
  const blacklistUntil = blacklistedTokens.get(tokenMint.toBase58());
  if (blacklistUntil && Date.now() < blacklistUntil) {
    log('WARN', `Token ${tokenMint.toBase58()} is blacklisted due to suspected rug pull. Skipping.`);
    return false;
  }
  // --- Cooldown check ---
  const cooldownUntil = failedCooldowns.get(tokenMint.toBase58());
  if (cooldownUntil && Date.now() < cooldownUntil) {
    log('WARN', `Token ${tokenMint.toBase58()} is in cooldown after failed trade. Skipping until ${new Date(cooldownUntil).toISOString()}`);
    return false;
  }
  // --- Duplicate/Blacklist/Pending check before buy ---
  if (isBuy) {
    if (purchasedTokens.has(tokenMint.toBase58())) {
      log('INFO', `Skipping buy: Token ${tokenMint.toBase58()} already in purchasedTokens.`);
      return false;
    }
    if (pendingTokens.has(tokenMint.toBase58())) {
      log('INFO', `Skipping buy: Token ${tokenMint.toBase58()} already in pendingTokens.`);
      return false;
    }
    if (blacklistedTokens.has(tokenMint.toBase58()) && Date.now() < blacklistedTokens.get(tokenMint.toBase58())) {
      log('INFO', `Skipping buy: Token ${tokenMint.toBase58()} is blacklisted.`);
      return false;
    }
    // --- Minimum holders check ---
    const holders = await getTokenHolders(tokenMint);
    if (holders < MINIMUM_HOLDERS) {
      log('INFO', `Skipping buy: Token ${tokenMint.toBase58()} has only ${holders} holders (min required: ${MINIMUM_HOLDERS}).`);
      return false;
    }
    // --- Recent activity check ---
    const hasActivity = await getRecentTokenActivity(tokenMint);
    if (!hasActivity) {
      log('INFO', `Skipping buy: Token ${tokenMint.toBase58()} has no recent activity in last ${ACTIVITY_WINDOW_MINUTES} min.`);
      return false;
    }
  }
  await delay(500);
  try {
    log('INFO', `Starting ${isBuy ? 'buy' : 'sell'} trade for token ${tokenMint.toBase58()}...`);
    const balance = PAPER_TRADING ? virtualBalance : await withRateLimit(() => connection.getBalance(wallet.publicKey));
    // --- GLOBAL STOP LOSS ---
    if (!PAPER_TRADING && balance / Number(LAMPORTS_PER_SOL) < GLOBAL_STOP_LOSS_SOL) {
      if (isBuy) {
        log('ERROR', `Wallet balance below global stop-loss (${GLOBAL_STOP_LOSS_SOL} SOL). Stopping new buys.`);
        return false; // Block new buys only
      }
      // Allow sells to proceed
    }
    const minimumBalanceNeeded = amountToTrade + (0.002 * Number(LAMPORTS_PER_SOL));
    if (balance < minimumBalanceNeeded) {
      log('WARN', `Skipping ${isBuy ? 'buy' : 'sell'} for ${tokenMint.toBase58()}: Insufficient SOL balance: ${balance / Number(LAMPORTS_PER_SOL)} SOL available, ${minimumBalanceNeeded / Number(LAMPORTS_PER_SOL)} SOL needed`);
      if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
      return false;
    }
    log('INFO', `Pre-trade balance: ${balance / Number(LAMPORTS_PER_SOL)} SOL`);

    const poolInfo = await getPoolInfo(bondingCurveAddress, tokenMint);
    if (!poolInfo.tokenMint) {
      log('WARN', `Bonding curve ${bondingCurveAddress} is invalid or complete for token ${tokenMint.toBase58()}`);
      if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
      return false;
    }
    if (isBuy && (poolInfo.liquidity < MINIMUM_LIQUIDITY || poolInfo.price > PRICE_THRESHOLD)) {
      log('INFO', `Skipping buy for ${tokenMint.toBase58()}: Does not meet criteria: liquidity=${poolInfo.liquidity}, price=${poolInfo.price}`);
      return false;
    }
    log('INFO', `Pool info: liquidity=${poolInfo.liquidity} SOL, price=${poolInfo.price} SOL/token`);

    const tokenProgramId = await validateMint(tokenMint);
    if (!tokenProgramId) {
      log('WARN', `Removing invalid token ${tokenMint.toBase58()} from lists`);
      purchasedTokens.delete(tokenMint.toBase58());
      pendingTokens.delete(tokenMint.toBase58());
      return false;
    }

    if (!await validateBondingCurve(bondingCurveAddress, tokenMint)) {
      log('WARN', `Invalid bonding curve address: ${bondingCurveAddress}`);
      if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
      return false;
    }

    let tokenAccount;
    try {
      tokenAccount = await createAtaWithRetry(tokenMint, tokenProgramId);
    } catch (error) {
      log('ERROR', `Failed to create or validate ATA: ${error.message}`, error);
      if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
      return false;
    }

    const slippageBasisPoints = calculateSlippage(poolInfo.liquidity);
    const globalAccount = new PublicKey('4wTV1YmiU945riG3AgesrAg56J4rBaJoKM1N7i1MNqA1');
    const feeRecipient = new PublicKey('CebN5WGQ4jvTWKdj3W8nS4cU4QaFjCR1dp9hG9o3nKoL');
    let result = { transaction: null, signature: null };
    if (isBuy) {
      log('INFO', `Executing buy for token ${tokenMint.toBase58()} with amount ${amountToTrade / Number(LAMPORTS_PER_SOL)} SOL...`);
      let sdkFailed = false;
      if (!PAPER_TRADING) {
        try {
          // Always re-instantiate PumpFunSDK with the current connection and wallet before buy
          const pumpFunProgramId = new PublicKey(PUMP_FUN_PROGRAM_ID);
          sdk = new PumpFunSDK(
            wallet,
            connection,
            TOKEN_PROGRAM_ID,
            pumpFunProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          result = await sdk.buy(
            wallet,
            tokenMint,
            new BN(amountToTrade.toString()),
            slippageBasisPoints,
            {
              unitLimit: 1_400_000,
              unitPrice: 10000,
              bondingCurve: new PublicKey(bondingCurveAddress),
              global: globalAccount,
              feeRecipient: feeRecipient,
            }
          );
        } catch (sdkError) {
          log('ERROR', `SDK buy error: ${sdkError.message}, Stack: ${sdkError.stack}, TXID: ${result?.signature || 'N/A'}`, sdkError);
          sdkFailed = true;
        }
      }
      if (PAPER_TRADING || result.transaction) {
        if (PAPER_TRADING) {
          result.signature = `SIMULATED-BUY-${Date.now()}`;
          virtualBalance -= amountToTrade;
          virtualBalance -= 0.000005 * Number(LAMPORTS_PER_SOL);
          log('INFO', `[PAPER TRADING] Simulated buy for token ${tokenMint.toBase58()}, TXID: ${result.signature}`);
          purchasedTokens.set(tokenMint.toBase58(), {
            bondingCurveAddress,
            buyPrice: poolInfo.price,
            amount: amountToTrade / poolInfo.price,
            timestamp: Date.now(),
          });
          // Immediately call executeTrade for sell in paper trading
          await executeTrade(tokenMint, amountToTrade / poolInfo.price, false, bondingCurveAddress);
          return true;
        } else {
          result.transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })
          );
          const txid = await sendTransactionWithRetry(result.transaction, [wallet], tokenMint);
          result.signature = txid;
        }
        const release = await purchasedTokensMutex.acquire();
        try {
          purchasedTokens.set(tokenMint.toBase58(), {
            bondingCurveAddress,
            buyPrice: poolInfo.price,
            amount: amountToTrade / poolInfo.price,
            timestamp: Date.now(),
          });
        } finally {
          release();
        }
      } else if (sdkFailed) {
        // --- Fallback: Try Raydium/Jupiter buy ---
        log('ERROR', `[FALLBACK] Main buy logic failed for ${tokenMint.toBase58()}: ${sdkError ? sdkError.message : 'Unknown error'}`);
        if (failedTokens.has(tokenMint.toBase58())) {
          log('WARN', `[FALLBACK] Token ${tokenMint.toBase58()} already failed before, skipping to avoid infinite loop.`);
          return false;
        }
        failedTokens.set(tokenMint.toBase58(), { failCount: 1, lastFailed: Date.now() });
        const fallbackSuccess = await fallbackRaydiumBuy(tokenMint, amountToTrade);
        if (fallbackSuccess) {
          log('INFO', `[FALLBACK] Successfully bought ${tokenMint.toBase58()} using Raydium/Jupiter fallback.`);
          // Simulate a sell after fallback buy for testing
          log('INFO', `[FALLBACK] Simulating immediate sell for ${tokenMint.toBase58()} after fallback buy.`);
          await executeTrade(tokenMint, amountToTrade / poolInfo.price, false, bondingCurveAddress);
          return true;
        } else {
          log('ERROR', '[FALLBACK] Raydium/Jupiter buy failed.');
          return false;
        }
      } else {
        log('ERROR', 'Buy transaction failed: No transaction returned by SDK');
        return false;
      }
    } else {
      // PATCH: Always allow simulated sell in PAPER_TRADING mode
      let amountToSell = 0;
      if (PAPER_TRADING) {
      const purchased = purchasedTokens.get(tokenMint.toBase58());
      amountToSell = purchased ? purchased.amount : amountToTrade;
      } else {
      balance = Number(tokenAccount.amount) / Math.pow(10, DEFAULT_DECIMALS);
      amountToSell = Math.min(balance, amountToTrade / Math.pow(10, DEFAULT_DECIMALS));
      }
      const sellAmountBN = new BN(amountToSell.toFixed(0)).mul(new BN(10).pow(new BN(DEFAULT_DECIMALS)));
      if (amountToSell <= 0) {
        log('WARN', `No tokens available to sell: ${balance} tokens in ATA for ${tokenMint.toBase58()}`);
        purchasedTokens.delete(tokenMint.toBase58());
        return false;
      }
      log('INFO', `Selling ${amountToSell} tokens for ${tokenMint.toBase58()}...`);
      if (!PAPER_TRADING) {
        try {
          // Always re-instantiate PumpFunSDK with the current connection and wallet before sell
          const pumpFunProgramId = new PublicKey(PUMP_FUN_PROGRAM_ID);
          sdk = new PumpFunSDK(
            wallet,
            connection,
            TOKEN_PROGRAM_ID,
            pumpFunProgramId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          result = await sdk.sell(
            wallet,
            tokenMint,
            sellAmountBN,
            slippageBasisPoints,
            {
              unitLimit: 1_400_000,
              unitPrice: 10000,
              bondingCurve: new PublicKey(bondingCurveAddress),
              global: globalAccount,
              feeRecipient: feeRecipient,
            }
          );
        } catch (sdkError) {
          log('ERROR', `SDK sell error: ${sdkError.message}, Stack: ${sdkError.stack}, TXID: ${result?.signature || 'N/A'}`, sdkError);
          // --- Fallback: Try Raydium/Jupiter sell ---
          const fallbackSuccess = await fallbackRaydiumSell(tokenMint, amountToSell);
          if (fallbackSuccess) {
            log('INFO', `[FALLBACK] Successfully sold ${tokenMint.toBase58()} using Raydium/Jupiter fallback.`);
            return true;
          }
          purchasedTokens.delete(tokenMint.toBase58());
          return false;
        }
      }
      if (PAPER_TRADING || result.transaction) {
        if (PAPER_TRADING) {
          result.signature = `SIMULATED-SELL-${Date.now()}`;
          const solReceived = amountToSell * poolInfo.price;
          virtualBalance += solReceived;
          virtualBalance -= 0.000005 * Number(LAMPORTS_PER_SOL);
          log('INFO', `[PAPER TRADING] Simulated sell for token ${tokenMint.toBase58()}, TXID: ${result.signature}, SOL received: ${solReceived / Number(LAMPORTS_PER_SOL)} SOL`);
        } else {
          result.transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 })
          );
          const txid = await sendTransactionWithRetry(result.transaction, [wallet], tokenMint);
          result.signature = txid;
        }
        const release = await purchasedTokensMutex.acquire();
        try {
          purchasedTokens.delete(tokenMint.toBase58());
        } finally {
          release();
        }
      } else {
        log('ERROR', 'Sell transaction failed: No transaction returned by SDK');
        purchasedTokens.delete(tokenMint.toBase58());
        return false;
      }
    }

    // --- Rug Pull Detection: Check for sudden liquidity drop ---
    const prevPoolInfo = await getPoolInfo(bondingCurveAddress, tokenMint);
    await delay(1000); // short delay to check for drop
    const newPoolInfo = await getPoolInfo(bondingCurveAddress, tokenMint);
    if (prevPoolInfo.liquidity > 0 && newPoolInfo.liquidity < prevPoolInfo.liquidity * (1 - RUG_PULL_LIQUIDITY_DROP)) {
      blacklistedTokens.set(tokenMint.toBase58(), Date.now() + BLACKLIST_DURATION_MS);
      log('WARN', `Token ${tokenMint.toBase58()} blacklisted for 24h due to >80% liquidity drop (possible rug pull).`);
      return false;
    }

    if (result.signature) {
      log('INFO', `${isBuy ? 'Buy' : 'Sell'} executed for token ${tokenMint.toBase58()}, TXID: ${result.signature}`);
      const postBalance = PAPER_TRADING ? virtualBalance : await withRateLimit(() => connection.getBalance(wallet.publicKey));
      log('INFO', `Post-trade balance: ${postBalance / Number(LAMPORTS_PER_SOL)} SOL`);
      const tradeRecord = {
        type: isBuy ? 'buy' : 'sell',
        tokenMint: tokenMint.toBase58(),
        amount: isBuy ? amountToTrade / poolInfo.price : amountToSell,
        price: poolInfo.price,
        timestamp: Date.now(),
        txid: result.signature,
        balanceAfter: postBalance / Number(LAMPORTS_PER_SOL),
      };
      tradeHistory.push(tradeRecord);
      try {
        const tradeHistoryFile = 'trade_history.json';
        if (!existsSync(tradeHistoryFile)) {
          log('INFO', `Creating trade_history.json in ${process.cwd()}`);
          writeFileSync(tradeHistoryFile, '');
        }
        appendFileSync(tradeHistoryFile, JSON.stringify(tradeRecord) + '\n');
        log('INFO', `Saved trade to ${tradeHistoryFile} for token ${tokenMint.toBase58()}`);
      } catch (error) {
        log('ERROR', `Failed to write to trade_history.json: ${error.message}`, error);
      }
      // --- Max Daily Trades increment ---
      if (isBuy || !isBuy) dailyTradeCount++;
      // --- CSV Logging ---
      if (result.signature) logTradeCsv({
        type: isBuy ? 'buy' : 'sell',
        tokenMint: tokenMint.toBase58(),
        amount: isBuy ? amountToTrade / poolInfo.price : amountToSell,
        price: poolInfo.price,
        timestamp: Date.now(),
        txid: result.signature,
        balanceAfter: PAPER_TRADING ? virtualBalance / Number(LAMPORTS_PER_SOL) : await withRateLimit(() => connection.getBalance(wallet.publicKey)) / Number(LAMPORTS_PER_SOL)
      });
      // --- TESTING: Immediately sell after buy ---
      if (isBuy) {
        log('INFO', '[TESTING] Immediately selling after buy for testing purposes.');
        if (PAPER_TRADING) {
          // Directly simulate a sell for the same amount as the buy
          const sellAmount = amountToTrade / poolInfo.price;
          log('INFO', `[PAPER TRADING] Simulated sell for token ${tokenMint.toBase58()}, TXID: SIMULATED-SELL-${Date.now()}, amount: ${sellAmount}`);
          virtualBalance += amountToTrade; // Simulate getting SOL back
          virtualBalance -= 0.000005 * Number(LAMPORTS_PER_SOL); // Simulate fee
        } else {
          await executeTrade(tokenMint, amountToTrade / poolInfo.price, false, bondingCurveAddress);
        }
      }
      updateGoals(tradeRecord);
      logTradeWithFun(tradeRecord);
      return true;
    } else {
      log('ERROR', 'Trade failed: No signature returned');
      if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
      return false;
    }
  } catch (error) {
    log('ERROR', `Trade failed for token ${tokenMint.toBase58()}: ${error.message}`, error);
    // --- Mark token as failed ---
    const prev = failedTokens.get(tokenMint.toBase58()) || { failCount: 0, lastFailed: 0 };
    failedTokens.set(tokenMint.toBase58(), { failCount: prev.failCount + 1, lastFailed: Date.now() });
    failedCooldowns.set(tokenMint.toBase58(), Date.now() + FAILED_COOLDOWN_MS);
    if (!isBuy) purchasedTokens.delete(tokenMint.toBase58());
  }
}
// Fix: Correct template literal and block structure in monitorTokens()
async function monitorTokens() {
  while (true) {
    if (purchasedTokens.size === 0 && pendingTokens.size === 0) {
      log('INFO', 'No tokens to monitor, waiting...');
      await delay(5000);
      continue;
    }
    const purchasedTokensSnapshot = new Map(purchasedTokens);
    for (const [tokenMint, { bondingCurveAddress, buyPrice, amount, timestamp }] of purchasedTokensSnapshot) {
      const release = await purchasedTokensMutex.acquire();
      try {
        if (!purchasedTokens.has(tokenMint)) continue;
        if (!bondingCurveAddress) {
          log('WARN', `Invalid bondingCurveAddress for token ${tokenMint}, removing from purchased list`);
          purchasedTokens.delete(tokenMint);
          continue;
        }
        const poolInfo = await getPoolInfo(bondingCurveAddress, new PublicKey(tokenMint));
        // --- Blacklist and force sell for dead tokens ---
        if ((!poolInfo.price || poolInfo.price <= 0 || poolInfo.liquidity <= 0) && Date.now() - timestamp > 10 * 60 * 1000) {
          log('WARN', `Token ${tokenMint} has no price/liquidity for 10+ min. Attempting to sell and blacklist.`);
          await executeTrade(new PublicKey(tokenMint), amount, false, bondingCurveAddress);
          blacklistedTokens.set(tokenMint, Date.now() + BLACKLIST_DURATION_MS);
          purchasedTokens.delete(tokenMint);
          continue;
        }
        const currentPrice = poolInfo.price;
        if (currentPrice <= 0) {
          log('WARN', `Invalid price for ${tokenMint}: ${currentPrice}, removing from purchased list`);
          purchasedTokens.delete(tokenMint);
          continue;
        }
        log('INFO', `Current price for ${tokenMint}: ${currentPrice}, Buy price: ${buyPrice}`);
        const profit = (currentPrice - buyPrice) / buyPrice;
        // --- Advanced profit logic ---
        let tracking = tokenProfitTracking.get(tokenMint) || { levelsHit: [], moonbagLeft: false, highestPrice: buyPrice };
        // Update highest price for trailing stop
        if (currentPrice > (tracking.highestPrice || buyPrice)) tracking.highestPrice = currentPrice;
        // Partial take-profits
        let sold = false;
        for (let i = 0; i < PARTIAL_TAKE_PROFIT_LEVELS.length; i++) {
          const level = PARTIAL_TAKE_PROFIT_LEVELS[i];
          if (!tracking.levelsHit.includes(level) && profit >= (level - 1)) {
            const percent = PARTIAL_TAKE_PROFIT_PERCENTS[i] || 0;
            const sellAmount = amount * percent;
            if (sellAmount > 0.000001) {
              log('INFO', `Partial take-profit: Selling ${(percent * 100).toFixed(1)}% at ${level}x for ${tokenMint}`);
              await executeTrade(new PublicKey(tokenMint), sellAmount, false, bondingCurveAddress);
              tracking.levelsHit.push(level);
              sold = true;
            }
          }
        }
        // Profit lock: sell all if profit exceeds threshold
        if (profit >= PROFIT_LOCK_THRESHOLD - 1) {
          log('INFO', `Profit lock: Selling all for ${tokenMint} at ${(profit * 100).toFixed(2)}%`);
          await executeTrade(new PublicKey(tokenMint), amount, false, bondingCurveAddress);
          purchasedTokens.delete(tokenMint);
          tokenProfitTracking.delete(tokenMint);
          continue;
        }
        // Trailing stop (dynamic based on highest price)
        if (currentPrice <= (tracking.highestPrice || buyPrice) * (1 - TRAILING_STOP_PERCENT)) {
          log('INFO', `Trailing stop triggered for ${tokenMint}: currentPrice=${currentPrice}, highestPrice=${tracking.highestPrice}`);
          await executeTrade(new PublicKey(tokenMint), amount, false, bondingCurveAddress);
          purchasedTokens.delete(tokenMint);
          tokenProfitTracking.delete(tokenMint);
          continue;
        }
        // Stop loss
        if (currentPrice <= buyPrice * (1 - STOP_LOSS_PERCENT)) {
          log('INFO', `Stop loss triggered for ${tokenMint}: currentPrice=${currentPrice}, buyPrice=${buyPrice}`);
          await executeTrade(new PublicKey(tokenMint), amount, false, bondingCurveAddress);
          purchasedTokens.delete(tokenMint);
          tokenProfitTracking.delete(tokenMint);
          continue;
        }
        // Moonbag: after all partial take-profits, keep a small percent
        const allHit = PARTIAL_TAKE_PROFIT_LEVELS.every(l => tracking.levelsHit.includes(l));
        if (allHit && !tracking.moonbagLeft) {
          const moonbagAmount = amount * MOONBAG_PERCENT;
          if (moonbagAmount > 0.000001) {
            log('INFO', `Moonbag: Selling all except ${(MOONBAG_PERCENT * 100).toFixed(1)}% for ${tokenMint}`);
            await executeTrade(new PublicKey(tokenMint), amount - moonbagAmount, false, bondingCurveAddress);
            tracking.moonbagLeft = true;
            sold = true;
          }
        }
        // Remove from purchased if all sold
        if (sold) {
          // Update amount after partial sell
          const newAmount = amount * (1 - PARTIAL_TAKE_PROFIT_PERCENTS.reduce((a, b) => a + b, 0));
          if (newAmount < 0.000001 || (tracking.moonbagLeft && allHit)) {
            purchasedTokens.delete(tokenMint);
            tokenProfitTracking.delete(tokenMint);
          } else {
            purchasedTokens.set(tokenMint, { bondingCurveAddress, buyPrice, amount: newAmount, timestamp });
            tokenProfitTracking.set(tokenMint, tracking);
          }
        } else {
          // Update tracking
          tokenProfitTracking.set(tokenMint, tracking);
        }
        // Expiry
        if (Date.now() - timestamp > MAX_TOKEN_AGE_SECONDS * 1000) {
          log('INFO', `Token ${tokenMint} expired from purchased list, selling...`);
          await executeTrade(new PublicKey(tokenMint), amount, false, bondingCurveAddress);
          purchasedTokens.delete(tokenMint);
          tokenProfitTracking.delete(tokenMint);
        }
      } catch (error) {
        log('ERROR', `Error monitoring token ${tokenMint}: ${error.message}`, error);
        purchasedTokens.delete(tokenMint);
        tokenProfitTracking.delete(tokenMint);
      } finally {
        release();
      }
    }
    const pendingTokensSnapshot = new Map(pendingTokens);
    for (const [tokenMint, { bondingCurveAddress, timestamp }] of pendingTokensSnapshot) {
      const release = await pendingTokensMutex.acquire();
      try {
        if (!pendingTokens.has(tokenMint)) {
          log('INFO', `Token ${tokenMint} already removed from pending list`);
          continue;
        }
        if (!bondingCurveAddress) {
          log('WARN', `Invalid bondingCurveAddress for pending token ${tokenMint}, removing from pending list`);
          pendingTokens.delete(tokenMint);
          continue;
        }
        const poolInfo = await getPoolInfo(bondingCurveAddress, new PublicKey(tokenMint));
        if (!poolInfo.tokenMint) {
          log('INFO', `Pending token ${tokenMint} bonding curve is complete or invalid, removing from pending list`);
          pendingTokens.delete(tokenMint);
          continue;
        }
        if (poolInfo.liquidity >= MINIMUM_LIQUIDITY && poolInfo.price <= PRICE_THRESHOLD) {
          log('INFO', `Pending token ${tokenMint} now meets criteria, sniping...`);
          const releasePurchased = await purchasedTokensMutex.acquire();
          try {
            if (purchasedTokens.size >= 3) {
              log('INFO', `Skipping trade for ${tokenMint}: Maximum token hold limit (3) reached`);
              continue;
            }
            const success = await executeTrade(new PublicKey(tokenMint), AMOUNT_TO_TRADE, true, bondingCurveAddress);
            if (success) {
              log('INFO', `Successfully sniped pending token ${tokenMint}`);
              pendingTokens.delete(tokenMint);
            } else {
              log('WARN', `Failed to snipe pending token ${tokenMint}`);
            }
          } finally {
            releasePurchased();
          }
        } else if (Date.now() - timestamp > MAX_TOKEN_AGE_SECONDS * 1000) {
          log('INFO', `Pending token ${tokenMint} expired`);
          pendingTokens.delete(tokenMint);
        }
      } catch (error) {
        log('ERROR', `Error processing pending token ${tokenMint}: ${error.message}`, error);
      } finally {
        release();
      }
    }
    await delay(5000);
  }
}

async function healthCheck() {
  while (true) {
    try {
      log('INFO', `Health check: purchasedTokens=${purchasedTokens.size}, pendingTokens=${pendingTokens.size}, virtualBalance=${virtualBalance / Number(LAMPORTS_PER_SOL)} SOL, ataCreations=${ataCreations}, totalTrades=${tradeHistory.length}`);
      await withRateLimit(() => connection.getSlot());
    } catch (error) {
      log('ERROR', `Health check failed: ${error.message}`, error);
    }
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }
}

async function snipeToken() {
  log('INFO', 'Starting sniper bot...');
  try {
    const releasePurchased = await purchasedTokensMutex.acquire();
    try {
      if (CLEAR_TOKENS_ON_STARTUP === true) {
        log('INFO', `Clearing ${purchasedTokens.size} tokens from purchasedTokens to allow new trades`);
        purchasedTokens.clear();
      } else {
        log('INFO', `Keeping ${purchasedTokens.size} tokens in purchasedTokens (CLEAR_TOKENS_ON_STARTUP is false)`);
      }
    } finally {
      releasePurchased();
    }

    const releasePending = await pendingTokensMutex.acquire();
    try {
      if (CLEAR_TOKENS_ON_STARTUP === true) {
        log('INFO', `Clearing ${pendingTokens.size} tokens from pendingTokens`);
        pendingTokens.clear();
      } else {
        log('INFO', `Keeping ${pendingTokens.size} tokens in pendingTokens (CLEAR_TOKENS_ON_STARTUP is false)`);
      }
    } finally {
      releasePending();
    }

    ataCreations = 0;
    log('INFO', `Reset ATA creation count to ${ataCreations}`);

    const programId = new PublicKey(PUMP_FUN_PROGRAM_ID);
    log('INFO', `Calling validatePumpFunProgram with programId: ${programId ? programId.toBase58() : 'undefined'}`);
    await validatePumpFunProgram(connection, programId);
    const balance = await withRateLimit(() => connection.getBalance(wallet.publicKey));
    // --- Wallet balance and virtual balance setup ---
    if (PAPER_TRADING) {
      virtualBalance = 1.0 * Number(LAMPORTS_PER_SOL);
      log('INFO', '[PAPER TRADING] Virtual balance initialized: ' + (virtualBalance / Number(LAMPORTS_PER_SOL)) + ' SOL');
      log('INFO', '[PAPER TRADING] Minimum balance checks are skipped.');
    } else {
      virtualBalance = balance;
      log('INFO', '[LIVE TRADING] Balance initialized: ' + (virtualBalance / Number(LAMPORTS_PER_SOL)) + ' SOL');
      if (balance < AMOUNT_TO_TRADE + 0.002 * Number(LAMPORTS_PER_SOL)) {
        log('ERROR', 'Wallet balance too low for trading: ' + (balance / Number(LAMPORTS_PER_SOL)) + ' SOL');
        return;
      }
      if (balance < MINIMUM_BALANCE) {
        log('ERROR', 'Wallet balance below minimum threshold: ' + (balance / Number(LAMPORTS_PER_SOL)) + ' SOL');
        return;
      }
    }
    const recentTxs = await withRateLimit(() => connection.getSignaturesForAddress(wallet.publicKey, { limit: 10 }));
    log('INFO', `Recent wallet transactions: ${JSON.stringify(recentTxs, null, 2)}`);

    log('INFO', `Setting up log subscription...`);
    subscriptionId = connection.onLogs(
      programId,
      async ({ logs, signature, err }) => {
        // Prevent new trades if already holding a token
        const release = await purchasedTokensMutex.acquire();
        try {
          if (purchasedTokens.size >= 3) return;
        } finally {
          release();
        }
        try {
          log('INFO', `Processing log for TXID: ${signature}`);
          if (err) {
            if (err.InstructionError && err.InstructionError[1].Custom === 6005) {
              log('INFO', `Bonding curve completed in TX ${signature}`);
              const tx = await withRateLimit(() => connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
              }));
              if (tx && tx.transaction.message.staticAccountKeys) {
                const bondingCurveAddress = tx.transaction.message.staticAccountKeys.find(key =>
                  key.toBase58().includes('bonding-curve')
                )?.toBase58();
                if (bondingCurveAddress) {
                  const release = await pendingTokensMutex.acquire();
                  try {
                    for (const [tokenMint, { bondingCurve }] of pendingTokens) {
                      if (bondingCurve === bondingCurveAddress) {
                        log('INFO', `Bonding curve ${bondingCurveAddress} completed for token ${tokenMint}, removing from pending list`);
                        pendingTokens.delete(tokenMint);
                      }
                    }
                  } finally {
                    release();
                  }
                }
              }
            }
            return;
          }
          if (!logs.some(log => log.includes('Instruction: Create'))) {
            log('INFO', `TX ${signature} is not a token creation`);
            return;
          }
          log('INFO', `Received logs for TXID: ${signature}`);
          const tokenInfo = await extractTokenMintFromTx(signature, log);
          if (!tokenInfo) {
            log('INFO', `No token info extracted from TX ${signature}`);
            return;
          }

          const { mint, bondingCurve } = tokenInfo;
          log('INFO', `Validating bonding curve for mint ${mint.toBase58()}...`);
          const derivedBondingCurve = await deriveBondingCurveAddress(mint);
          if (!derivedBondingCurve || derivedBondingCurve !== bondingCurve.toBase58()) {
            log('WARN', `Bonding curve mismatch for mint ${mint.toBase58()}: parsed=${bondingCurve.toBase58()}, derived=${derivedBondingCurve || 'null'}`);
            return;
          }

          let txTimestamp = Date.now();
          log('INFO', `Fetching transaction ${signature} to check block time...`);
          let tx = null;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            log('INFO', `Fetching transaction ${signature} (Attempt ${attempt}/${MAX_RETRIES})...`);
            try {
              tx = await withRateLimit(() => connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
              }));
              if (tx && tx.blockTime) {
                txTimestamp = tx.blockTime * 1000;
                break;
              }
              log('WARN', `No block time for TX ${signature} on attempt ${attempt}`);
              if (attempt === MAX_RETRIES) {
                log('WARN', `Failed to fetch block time for TX ${signature} after ${MAX_RETRIES} attempts, using current time as fallback`);
              }
              await delay(1000);
            } catch (error) {
              log('WARN', `Failed to fetch transaction ${signature} on attempt ${attempt}: ${error.message}`);
              if (attempt === MAX_RETRIES) {
                log('WARN', `Failed to fetch transaction ${signature} after ${MAX_RETRIES} attempts, using current time as fallback`);
              }
              await delay(1000);
            }
          }

          const currentTime = Date.now();
          log('INFO', `Transaction timestamp: ${txTimestamp}, Current time: ${currentTime}, Age: ${Math.round((currentTime - txTimestamp) / 1000)} seconds`);
          if (currentTime - txTimestamp > MAX_TOKEN_AGE_SECONDS * 1000) {
            log('INFO', `Token ${mint.toBase58()} is too old: ${Math.round((currentTime - txTimestamp) / 1000)} seconds`);
            return;
          }

          log('INFO', `Fetching pool info for mint ${mint.toBase58()}...`);
          const poolInfo = await getPoolInfo(bondingCurve.toBase58(), mint);
          log('INFO', `Pool info for ${mint.toBase58()}: liquidity=${poolInfo.liquidity}, price=${poolInfo.price}, tokenMint=${poolInfo.tokenMint ? poolInfo.tokenMint.toBase58() : 'null'}`);
          if (
            poolInfo.liquidity >= MINIMUM_LIQUIDITY &&
            poolInfo.price <= PRICE_THRESHOLD &&
            poolInfo.tokenMint
          ) {
            const release = await purchasedTokensMutex.acquire();
            try {
              if (purchasedTokens.size >= 3) {
                log('INFO', `Skipping trade for ${mint.toBase58()}: Maximum token hold limit (3) reached`);
                return;
              }
              log('INFO', `Sniping new token ${mint.toBase58()} with bonding curve ${bondingCurve.toBase58()}`);
              const success = await executeTrade(
                mint,
                AMOUNT_TO_TRADE,
                true,
                bondingCurve.toBase58()
              );
              if (success) {
                log('INFO', `Successfully sniped token ${mint.toBase58()}`);
              } else {
                log('WARN', `Failed to snipe token ${mint.toBase58()}`);
                const releasePending = await pendingTokensMutex.acquire();
                try {
                  if (!pendingTokens.has(mint.toBase58()) && !(await getPoolInfo(bondingCurve.toBase58(), mint)).tokenMint) {
                    log('INFO', `Adding token ${mint.toBase58()} to pending list for retry`);
                    pendingTokens.set(mint.toBase58(), {
                      bondingCurve: bondingCurve.toBase58(),
                      timestamp: currentTime,
                    });
                  }
                } finally {
                  releasePending();
                }
              }
            } finally {
              release();
            }
          } else {
            log('INFO', `Token ${mint.toBase58()} does not meet criteria: liquidity=${poolInfo.liquidity}, price=${poolInfo.price}`);
            const releasePending = await pendingTokensMutex.acquire();
            try {
              if (!poolInfo.tokenMint && !pendingTokens.has(mint.toBase58())) {
                log('INFO', `Adding token ${mint.toBase58()} to pending list for bonding curve completion`);
                pendingTokens.set(mint.toBase58(), {
                  bondingCurve: bondingCurve.toBase58(),
                  timestamp: currentTime,
                });
              }
            } finally {
              releasePending();
            }
          }
        } catch (error) {
          log('ERROR', `Callback error for TX ${signature}: ${error.message}`, error);
        } finally {
          await delay(SNIPE_DELAY_MS); // Added delay between sniping attempts
        }
      },
      'confirmed'
    );
    log('INFO', `Log subscription established with ID: ${subscriptionId}`);
    await Promise.all([
      monitorTokens().catch(error => log('ERROR', `Error in monitorTokens: ${error.message}`, error)),
      healthCheck().catch(error => log('ERROR', `Error in healthCheck: ${error.message}`, error)),
    ]);
  } catch (error) {
    log('ERROR', `Fatal error in snipeToken: ${error.message}`, error);
  }
}

// --- SDK Initialization: Add check for undefined connection ---
async function main() {
  let rpcUrl = RPC_URL;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      log('INFO', `Connecting to RPC: ${rpcUrl} (Attempt ${attempt}/${MAX_RETRIES})`);
      connection = new Connection(rpcUrl, 'confirmed');
      await withRateLimit(() => connection.getSlot());
      log('INFO', `Successfully connected to RPC: ${rpcUrl}`);
      break;
    } catch (error) {
      log('WARN', `Primary RPC failed: ${error.message}`, error);
      if (attempt === MAX_RETRIES) {
        log('INFO', `Switching to fallback RPC: ${FALLBACK_RPC_URL}`);
        rpcUrl = FALLBACK_RPC_URL;
        connection = new Connection(rpcUrl, 'confirmed');
        break;
      }
      await delay(1000);
    }
  }

  try {
    log('INFO', `Loading wallet from ${WALLET_PATH}...`);
    if (!existsSync(WALLET_PATH)) {
      throw new Error(`Wallet file not found at ${WALLET_PATH}`);
    }
    const walletJson = JSON.parse(readFileSync(WALLET_PATH, 'utf-8'));
    if (!Array.isArray(walletJson) || walletJson.length !== 64) {
      throw new Error(`Invalid wallet format in ${WALLET_PATH}: Expected 64-byte keypair array`);
    }
    wallet = Keypair.fromSecretKey(Uint8Array.from(walletJson));
    log('INFO', `Wallet Public Key: ${wallet.publicKey.toBase58()}`);
    log('INFO', `Wallet Secret Key Available: ${!!wallet.secretKey}`);
    log('INFO', `Wallet Secret Key Available: ${!!wallet.secretKey}`);
    let pumpFunProgramId;
    log('INFO', `PUMP_FUN_PROGRAM_ID value: ${PUMP_FUN_PROGRAM_ID ? PUMP_FUN_PROGRAM_ID.toBase58() : 'undefined'}`);
    try {
      pumpFunProgramId = new PublicKey(PUMP_FUN_PROGRAM_ID);
      log('INFO', `PumpFun Program ID ${PUMP_FUN_PROGRAM_ID.toBase58()}`);
    } catch (error) {
      log('ERROR', `Failed to create PublicKey for PUMP_FUN_PROGRAM_ID: ${error.message}`);
      throw new Error(`Invalid PumpFun Program ${error.message}`);
    }
    log('INFO', `Initializing PumpFun SDK...`);
    if (!connection) throw new Error('Connection is undefined when initializing PumpFunSDK!');
    sdk = new PumpFunSDK(
      wallet,
      connection,
      TOKEN_PROGRAM_ID,
      pumpFunProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    log('INFO', `SDK initialized successfully`);
    // --- One-time import from trade_history.json to trades.log ---
    function importTradeHistoryToLog() {
      try {
        if (!fs.existsSync('trade_history.json')) return;
        const data = fs.readFileSync('trade_history.json', 'utf-8');
        let trades = [];
        try {
          trades = JSON.parse(data);
        } catch (e) {
          // If file is line-delimited JSON, parse each line
          trades = data.split('\n').filter(Boolean).map(line => JSON.parse(line));
        }
        trades.forEach(trade => logTradeWithFun(trade));
        console.log('Imported previous trades to trades.log!');
      } catch (err) {
        console.error('Failed to import trade history:', err);
      }
    }
    // Call this ONCE at startup
    importTradeHistoryToLog();
    await snipeToken();
  } catch (error) {
    log('ERROR', `Error in main: ${error.message}, ${error.stack}`, error);
    process.exit(1);
  }
}

main().catch(error => {
  log('ERROR', `Fatal ${error.message}`, error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  log('ERROR', `Uncaught ${error.message}`, error);
  log('INFO', 'Restarting bot in 10 seconds...');
  setTimeout(() => process.exit(1), 10 * 1000);
  }, 10 * 1000);
;

process.on('SIGINT', async () => {
  log('INFO', 'Shutting down...');
  if (subscriptionId !== undefined) {
    await connection.removeOnLogsListener(subscriptionId);
    log('INFO', `Removed log subscription with ID: ${subscriptionId}`);
  }
  const releasePending = await pendingTokensMutex.acquire();
  try {
    if (pendingTokens.size > 0) {
      const pendingData = JSON.stringify([...pendingTokens]);
      appendFileSync('pending_tokens.json', pendingData + '\n');
      log('INFO', `Saved ${pendingTokens.size} pending tokens to pending_tokens.json`);
    }
  } finally {
    releasePending();
  }
  if (tradeHistory.length > 0) {
    appendFileSync('trade_history.json', JSON.stringify(tradeHistory) + '\n');
    log('INFO', `Saved ${tradeHistory.length} trades to trade_history.json`);
  }
  process.exit(0);
});

function calculateSlippage(liquidity) {
  if (liquidity < 0.1) return 5000n; // 50%
  if (liquidity < 1) return 3000n;   // 30%
  return 1000n;                      // 10%
}

module.exports = { executeTrade };