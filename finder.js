/*
finder.js

Usage: node finder.js

This script:
  1. Prompts the user for a token mint (CA).
  2. Fetches all token holders for the specified token mint.
  3. For each holder, retrieves every token (coin) traded in the last 15 days.
  4. Compares wallets and outputs pairs that share at least 4 coins in common.
*/

import { Connection, PublicKey } from '@solana/web3.js';
import readline from 'readline';
import chalk from 'chalk';

// ─── READLINE SETUP FOR PROMPT ─────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askTokenMint() {
  return new Promise((resolve) => {
    rl.question(chalk.yellow("Enter token mint (CA): "), (answer) => {
      resolve(answer.trim());
    });
  });
}

// ─── CONFIGURATION ──────────────────────────────────────────

// Replace with your actual Helius API key.
const HELIUS_RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=7b7ac854-fbdf-413f-be38-a6faab746fc9";
const connection = new Connection(HELIUS_RPC_ENDPOINT, "finalized");

// Standard SPL Token Program ID.
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ─── HELPER FUNCTIONS ──────────────────────────────────────────

// Fetch token holders by scanning token accounts with a non‑zero balance.
async function fetchHolders(tokenMint) {
  console.log(chalk.blue("DEBUG: Fetching holders..."));
  const holders = new Set();
  try {
    const parsedAccounts = await connection.getParsedProgramAccounts(
      new PublicKey(TOKEN_PROGRAM_ID),
      {
        encoding: "jsonParsed",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: tokenMint,
            },
          },
          { dataSize: 165 }
        ]
      }
    );
    console.log(chalk.blue(`DEBUG: Retrieved ${parsedAccounts.length} accounts from the program.`));
    for (const acc of parsedAccounts) {
      const info = acc.account.data.parsed.info;
      if (Number(info.tokenAmount.uiAmount) > 0) {
        holders.add(info.owner);
      }
    }
    console.log(chalk.blue(`DEBUG: Found ${holders.size} unique holders with non-zero balance.`));
  } catch (e) {
    console.error(chalk.red("ERROR: Fetching holders:"), e);
  }
  return Array.from(holders);
}

// For a given wallet, scan its transaction history and collect unique token mints
// from SPL Token transfer instructions within the last 15 days.
async function getTradedCoins(wallet) {
  const coins = new Set();
  const now = Math.floor(Date.now() / 1000);
  const fifteenDaysAgo = now - 15 * 24 * 60 * 60;
  
  try {
    console.log(chalk.blue(`DEBUG: Fetching transaction signatures for wallet: ${wallet}`));
    const signatures = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000 });
    console.log(chalk.blue(`DEBUG: Wallet ${wallet} has ${signatures.length} transaction signatures.`));
    
    let processedCount = 0;
    for (const sigInfo of signatures) {
      processedCount++;
      if (!sigInfo.blockTime || sigInfo.blockTime < fifteenDaysAgo) continue;
      
      // Print progress every 50 transactions.
      if (processedCount % 50 === 0) {
        console.log(chalk.gray(`DEBUG: Processed ${processedCount} transactions for wallet: ${wallet}`));
      }
      
      // Pass maxSupportedTransactionVersion to avoid version errors.
      const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
      if (tx && tx.transaction && tx.transaction.message && tx.transaction.message.instructions) {
        for (const inst of tx.transaction.message.instructions) {
          // Look for SPL Token instructions with parsed data.
          if (inst.program === "spl-token" && inst.parsed) {
            const info = inst.parsed.info;
            if (info && info.mint) {
              coins.add(info.mint);
            }
          }
        }
      }
    }
    console.log(chalk.blue(`DEBUG: Wallet ${wallet} traded ${coins.size} unique coin(s) in the last 15 days.`));
  } catch (e) {
    console.error(chalk.red(`ERROR: Fetching trades for wallet ${wallet}:`), e);
  }
  return coins;
}

// Compare the traded coins of all holders and output pairs with at least 4 common coins.
async function analyzeCommonCoins(tokenMint) {
  console.log(chalk.blue("DEBUG: Starting analysis of traded coins..."));
  const holders = await fetchHolders(tokenMint);
  console.log(chalk.green(`INFO: Found ${holders.length} holders.`));
  
  const walletTrades = {};
  
  // Retrieve traded coins for each wallet.
  for (let i = 0; i < holders.length; i++) {
    const wallet = holders[i];
    console.log(chalk.blue(`DEBUG: [${i + 1}/${holders.length}] Fetching trades for wallet: ${wallet}`));
    const coins = await getTradedCoins(wallet);
    walletTrades[wallet] = coins;
  }
  
  // Compare every pair of wallets.
  console.log(chalk.blue("DEBUG: Comparing wallets for common coins..."));
  const commonPairs = [];
  const walletList = Object.keys(walletTrades);
  for (let i = 0; i < walletList.length; i++) {
    for (let j = i + 1; j < walletList.length; j++) {
      const walletA = walletList[i];
      const walletB = walletList[j];
      const coinsA = walletTrades[walletA];
      const coinsB = walletTrades[walletB];
      const commonCoins = [...coinsA].filter(coin => coinsB.has(coin));
      if (commonCoins.length >= 4) {
        commonPairs.push({
          wallets: [walletA, walletB],
          coins: commonCoins
        });
      }
    }
  }
  
  // Output results.
  if (commonPairs.length === 0) {
    console.log(chalk.yellow("INFO: No wallet pairs found with at least 4 coins in common."));
  } else {
    console.log(chalk.green(`INFO: Found ${commonPairs.length} wallet pair(s) with at least 4 coins in common:`));
    commonPairs.forEach(pair => {
      console.log(chalk.cyan(`Wallets: ${pair.wallets.join(" & ")}`));
      console.log(chalk.magenta(`Common Coins: ${pair.coins.join(", ")}`));
      console.log(chalk.gray("-----------------------------------------------------"));
    });
  }
}

// ─── MAIN ENTRY POINT ──────────────────────────────────────────

async function main() {
  const tokenMint = await askTokenMint();
  console.log(chalk.green(`Using token mint: ${tokenMint}`));
  await analyzeCommonCoins(tokenMint);
  console.log(chalk.green("INFO: Analysis complete."));
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(chalk.red("ERROR: Analysis encountered an error:"), e);
  rl.close();
  process.exit(1);
});
