// src/hotkeySell.js
import readline from 'readline';
import chalk from 'chalk';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import loadConfig from './loadConfig.js';
import loadWallets from './loadWallets.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getBondingCurve } from './getKeys.js';
import { createSellTXWithTip } from './createSellTX.js';
import sendBundle from './sendBundle.js';
import bs58 from 'bs58';

// Ensure raw mode so we can capture key presses
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// For storing pause state globally
export let isPaused = false;

function onKeyPress(str, key) {
  // If the user presses '/', toggle isPaused
  if (key && key.sequence === '/') {
    isPaused = !isPaused;
    if (isPaused) {
      console.log(chalk.yellow('\n[PAUSED] Press "/" again to resume...'));
    } else {
      console.log(chalk.green('\n[RESUMED] Continuing operations...'));
    }
  }

  // Example: The existing "=" hotkey logic would also appear here
  // if (key && key.sequence === '=') { ... }
}

// Listen for key presses
process.stdin.on('data', (data) => {
  // Convert the data buffer to a string
  const str = data.toString();
  // Check the first character or the entire sequence
  const key = { sequence: str };
  onKeyPress(str, key);
});

console.log(chalk.magenta("Hotkey '/' will pause/resume execution globally. '=' remains for last-three-sell."));

// Initialize the hotkey listener globally
export function initHotkeySell() {
  // Enable raw mode to capture single keypresses immediately
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Ensure raw mode so we can capture key presses
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}


  process.stdin.on('data', async (chunk) => {
    const key = chunk.toString();
    if (key === '=') {
      console.log(chalk.blue("Hotkey '=' pressed. Initiating sell of recent three buyer wallets..."));
      await sellRecentBuyerWallets();
    }
  });
}

// Main function to process selling from the most recent buyer wallets
async function sellRecentBuyerWallets() {
  try {
    const config = await loadConfig();
    const defaultCoinCA = config.defaultCoinCA;
    if (!defaultCoinCA) {
      console.error(chalk.red("No defaultCoinCA set in config.json. Please set defaultCoinCA to your coin's mint address."));
      return;
    }
    console.log(chalk.green("[DEBUG] Using defaultCoinCA:"), defaultCoinCA);

    // Create a fresh connection
    const connection = new Connection(config.rpcURL, {
      commitment: 'confirmed',
      wsEndpoint: config.wsURL
    });
    console.log(chalk.green("[DEBUG] Created connection to RPC:"), config.rpcURL);

    // Load wallets from file
    const wallets = await loadWallets();
    console.log(chalk.green("[DEBUG] Loaded", wallets.length, "wallets from wallets.txt"));

    // Prepare an array to hold wallet info objects (including the most recent purchase timestamp)
    let walletInfoArray = [];
    const coinMint = new PublicKey(defaultCoinCA);

    // Process each wallet one-by-one
    for (const wallet of wallets) {
      try {
        const owner = new PublicKey(wallet.pubKey);
        // Derive the associated token account for the coin
        const associatedTokenAccount = getAssociatedTokenAddressSync(coinMint, owner, true);
        console.log(chalk.green(`[DEBUG] Wallet ${wallet.pubKey}: Derived token account: ${associatedTokenAccount.toBase58()}`));

        // Query the token accounts owned by this wallet for the given mint
        const tokenAccountsRes = await connection.getTokenAccountsByOwner(owner, { mint: coinMint });
        if (tokenAccountsRes.value.length === 0) {
          console.log(chalk.yellow(`[DEBUG] Wallet ${wallet.pubKey}: No token account found for coin ${defaultCoinCA}.`));
          continue;
        }
        // Use the first token account from the result
        const tokenAccountPubKey = tokenAccountsRes.value[0].pubkey;
        const balanceInfo = await connection.getTokenAccountBalance(tokenAccountPubKey);
        const tokenBalance = parseFloat(balanceInfo.value.uiAmount) || 0;
        console.log(chalk.green(`[DEBUG] Wallet ${wallet.pubKey}: Token balance is ${tokenBalance} tokens (raw: ${balanceInfo.value.amount}).`));
        if (tokenBalance <= 0) {
          console.log(chalk.yellow(`[DEBUG] Wallet ${wallet.pubKey}: Token balance is zero, skipping sell.`));
          continue;
        }

        // Retrieve recent signatures for the token account (limit up to 100)
        const sigInfos = await connection.getSignaturesForAddress(tokenAccountPubKey, { limit: 100 });
        console.log(chalk.green(`[DEBUG] Wallet ${wallet.pubKey}: Retrieved ${sigInfos.length} recent signature(s).`));
        if (sigInfos.length === 0) {
          console.log(chalk.yellow(`[DEBUG] Wallet ${wallet.pubKey}: No recent signatures found, skipping.`));
          continue;
        }

        // Determine the most recent block time among these signatures
        let mostRecentBlockTime = 0;
        for (const sigInfo of sigInfos) {
          // Use the blockTime if available; otherwise, query using the slot number.
          let blockTime = sigInfo.blockTime;
          if (!blockTime) {
            try {
              blockTime = await connection.getBlockTime(sigInfo.slot);
            } catch (err) {
              console.error(chalk.red(`[DEBUG] Error getting block time for wallet ${wallet.pubKey} at slot ${sigInfo.slot}:`), err);
              continue;
            }
          }
          if (blockTime && blockTime > mostRecentBlockTime) {
            mostRecentBlockTime = blockTime;
          }
        }
        if (mostRecentBlockTime === 0) {
          console.log(chalk.yellow(`[DEBUG] Wallet ${wallet.pubKey}: Could not determine a valid block time, skipping.`));
          continue;
        }
        console.log(chalk.green(`[DEBUG] Wallet ${wallet.pubKey}: Most recent purchase timestamp is ${mostRecentBlockTime}.`));
        walletInfoArray.push({
          wallet,
          tokenAccountPubKey: tokenAccountPubKey.toBase58(),
          tokenBalance,
          blockTime: mostRecentBlockTime
        });
      } catch (err) {
        console.error(chalk.red("[DEBUG] Error processing wallet", wallet.pubKey, ":", err));
      }
    }

    if (walletInfoArray.length === 0) {
      console.error(chalk.red("[DEBUG] No wallets with valid token balances and purchase timestamps found."));
      return;
    }

    // Sort the wallets by blockTime descending (most recent purchase first)
    walletInfoArray.sort((a, b) => b.blockTime - a.blockTime);
    console.log(chalk.green("[DEBUG] Sorted wallets by most recent purchase:"), JSON.stringify(walletInfoArray, null, 2));

    // Select the top three wallets
    const recentBuyers = walletInfoArray.slice(0, 3);
    console.log(chalk.green("[DEBUG] Recent buyer wallets (most recent first):"), JSON.stringify(recentBuyers, null, 2));

    // For each selected wallet, build and send a sell transaction
    for (const info of recentBuyers) {
      console.log(chalk.blue(`[DEBUG] Initiating sell for wallet ${info.wallet.pubKey} with blockTime ${info.blockTime}...`));
      await sellForWallet(info.wallet, defaultCoinCA, info.tokenAccountPubKey, connection);
      // Wait a short delay between each sell
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // After selling, print the main menu again.
    console.log(chalk.magenta("\nReturning to Main Menu...\n"));
    console.log(chalk.bgBlack.green('=== Main Menu ==='));
    console.log(chalk.bold.red('CTRL + C to exit at any point'));
    console.log(chalk.yellow('1:') + chalk.hex('#4ECDC4')(' Buy Modes'));
    console.log(chalk.yellow('2:') + chalk.hex('#FF6B6B')(' Sell Modes'));
    console.log(chalk.yellow('3:') + chalk.hex('#45B7D1')(' Wallets'));
    console.log(chalk.yellow('4:') + chalk.hex('#FF8C42')(' Transfer'));
    console.log(chalk.yellow('Q:') + chalk.hex('#C04CFD')(' Quit'));
    console.log(chalk.magenta("Hotkey '=' is active globally to sell the last three buyer wallets."));

  } catch (err) {
    console.error(chalk.red("[DEBUG] Error in sellRecentBuyerWallets:"), err);
  }
}

// Function to build and send a sell transaction for a given wallet
async function sellForWallet(wallet, coinCA, tokenAccountPubKey, connection) {
  try {
    const config = await loadConfig();
    console.log(chalk.green("[DEBUG] Preparing to sell tokens for wallet:"), wallet.pubKey, "(coin:", coinCA + ")");
    const pumpPublicKey = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    const pump = new PublicKey(pumpPublicKey);
    const coinMint = new PublicKey(coinCA);

    // Derive bonding curve PDA and its associated token account
    const bondingCurvePda = getBondingCurve(coinMint, pump);
    const bondingCurveAta = getAssociatedTokenAddressSync(coinMint, bondingCurvePda, true);
    const bCurve = bs58.encode(bondingCurvePda.toBuffer());
    const aCurve = bs58.encode(bondingCurveAta.toBuffer());
    console.log(chalk.green("[DEBUG] Bonding curve PDA for coin", coinCA, "is:"), bCurve);

    // Re-check token balance for safety
    const tokenAccount = new PublicKey(tokenAccountPubKey);
    const balanceInfo = await connection.getTokenAccountBalance(tokenAccount);
    const tokenBalance = parseFloat(balanceInfo.value.uiAmount) || 0;
    console.log(chalk.green(`[DEBUG] Wallet ${wallet.pubKey}: Current token balance: ${tokenBalance} tokens (raw: ${balanceInfo.value.amount}).`));
    if (tokenBalance <= 0) {
      console.log(chalk.yellow(`[DEBUG] Wallet ${wallet.pubKey}: Token balance is zero, skipping sell.`));
      return;
    }

    console.log(chalk.green(`[DEBUG] Building sell transaction for wallet ${wallet.pubKey}...`));
    // Build the sell transaction (sell entire raw balance)
    const sellTxObj = await createSellTXWithTip(
      coinMint,
      bondingCurvePda,
      bondingCurveAta,
      pump,
      wallet,
      parseInt(balanceInfo.value.amount, 10),
      tokenAccountPubKey
    );
    console.log(chalk.green("[DEBUG] Sell transaction built for wallet:"), wallet.pubKey);

    // Compile the transaction into a versioned transaction
    const latestBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
    const messageV0 = new TransactionMessage({
      payerKey: sellTxObj.payer.publicKey,
      instructions: sellTxObj.instructions,
      recentBlockhash: latestBlockhash,
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([sellTxObj.payer]);
    console.log(chalk.green("[DEBUG] Sell transaction signed for wallet:"), wallet.pubKey);

    // Send the sell transaction
    let sellTxid;
    try {
      sellTxid = await connection.sendTransaction(versionedTx, {
        skipPreflight: true,
        commitment: 'confirmed'
      });
      console.log(chalk.green("[DEBUG] Sell transaction sent for wallet:"), wallet.pubKey, "TXID:", sellTxid);
    } catch (err) {
      console.error(chalk.red("[DEBUG] Error sending sell transaction for wallet:"), wallet.pubKey, err);
    }
  } catch (err) {
    console.error(chalk.red("[DEBUG] Error in sellForWallet for wallet:"), wallet.pubKey, err);
  }
}
