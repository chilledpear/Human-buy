import loadWallets from './loadWallets.js';
import loadConfig from './loadConfig.js';
import { createTX } from './createTX.js';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getBondingCurve } from './getKeys.js';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { isPaused } from './hotkeySell.js'; 


// Load buyAmounts.json
const buyAmountsPath = path.resolve(process.cwd(), 'buyAmounts.json');
let buyAmountsData = {};
if (fs.existsSync(buyAmountsPath)) {
    const rawJson = fs.readFileSync(buyAmountsPath, 'utf8');
    buyAmountsData = JSON.parse(rawJson);
} else {
    console.error("buyAmounts.json not found. Please ensure the file is present.");
    process.exit(1);
}



/**
 * Rapid Buy Mode 1:
 * - If one wallet is selected, execute buy and prompt for another wallet (continuous mode).
 * - If multiple wallets are selected, execute buys sequentially with a fixed 500ms delay between each.
 */
export async function rapidBuyMode1(tokenCA, rl) {
  // Load configuration and RPC connection
  const config = await loadConfig();
  const rpc = config.rpcURL;
  const ws = config.wsURL;
  const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: ws });
  const slippage = config.slippage || 0.15;  // default slippage if not specified

  // Load wallets from file
  const wallets = await loadWallets();
  if (!wallets || wallets.length === 0) {
    console.log(chalk.red('No wallets found. Please ensure wallets.txt is not empty.'));
    return;
  }

  // Display available wallets with indices
  console.log(chalk.green('Available wallets:'));
  wallets.forEach((w, idx) => {
    console.log(chalk.yellow(`${idx + 1}:`) + ` ${w.pubKey}`);
  });

  // Helper to prompt user using the provided readline interface
  const promptUser = (promptText) => {
    return new Promise(resolve => {
      rl.question(promptText, answer => resolve(answer.trim()));
    });
  };

  // Prompt user for wallet indices (allow one or multiple, comma-separated)
  let indicesInput = await promptUser(chalk.yellow('Enter wallet number(s) to buy from (e.g., 1 or 1,2,3): '));
  indicesInput = indicesInput.replace(/\s+/g, '');  // remove spaces
  if (!indicesInput) {
    console.log(chalk.red('No input provided. Operation cancelled.'));
    return;
  }
  const indexList = indicesInput.split(',').filter(x => x !== '');
  const parsedIndices = indexList.map(n => parseInt(n, 10))
                                 .filter(n => !isNaN(n) && n >= 1 && n <= wallets.length);
  if (parsedIndices.length === 0) {
    console.log(chalk.red('No valid wallet indices selected. Operation cancelled.'));
    return;
  }

  // Determine if single or multiple selection
  if (parsedIndices.length > 1) {
    // **Multiple wallets selected** – execute one buy per wallet with 500ms delay between
    const selectedIndices = parsedIndices.map(i => i - 1);
    const selectedWallets = selectedIndices.map(i => wallets[i]);

    // Prepare token/pump program accounts for the buy transactions
    const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const pumpProgramId = new PublicKey(PUMP_PUBLIC_KEY);
    const pump = new PublicKey(PUMP_PUBLIC_KEY);
    const mintPubKey = new PublicKey(tokenCA);
    const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
    const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
    // Use base58 encoding for consistency when creating transactions
    const bCurve = bondingCurvePda.toBase58();
    const aCurve = bondingCurveAta.toBase58();

    for (let idx = 0; idx < selectedWallets.length; idx++) {
      const wallet = selectedWallets[idx];
      console.log(chalk.green(`\nProcessing wallet ${wallet.pubKey} (${idx + 1}/${selectedWallets.length})`));
      try {
        const ownerPubKey = new PublicKey(wallet.pubKey);
        const solBalance = await connection.getBalance(ownerPubKey);
        // Determine a buy amount in lamports (use a random value between config.minBuy and config.maxBuy)
        const walletKey = `wallet${idx + 1}`;
        let buyAmountSOL = buyAmountsData[walletKey];

        if (buyAmountSOL === undefined) {
        console.error(`No buy amount specified for ${walletKey} in buyAmounts.json. Skipping...`);
        continue;
        }
        const buyAmountLamports = Math.floor(parseFloat(buyAmountSOL) * 1e9);


        // Check if wallet has enough SOL to cover the buy amount (and likely fees)
        if (solBalance < buyAmountLamports) {
          console.log(chalk.red(`Wallet ${wallet.pubKey} has insufficient SOL for the buy amount, skipping.`));
          continue;
        }

        // Create and send the buy transaction for this wallet

                // PAUSE CHECK
          while (isPaused) {
            console.log("Multiple Sell is paused... Press '/' to resume.");
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
        const mint = mintPubKey;
        const bondingCurve = new PublicKey(bCurve);
        const aBondingCurve = new PublicKey(aCurve);
        const buyTxObj = await createTX(mint, bondingCurve, aBondingCurve, pump, wallet, buyAmountLamports, slippage);
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({
          payerKey: buyTxObj.payer.publicKey,
          instructions: buyTxObj.instructions,
          recentBlockhash: latestBlockhash.blockhash
        }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        tx.sign([buyTxObj.payer]);
        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await connection.confirmTransaction(signature, 'confirmed');
        console.log(chalk.green(`Buy transaction successful for wallet ${wallet.pubKey}. Signature: ${signature}`));
      } catch (error) {
        console.error(chalk.red(`Error processing wallet ${wallet.pubKey}: ${error.message}`));
      }

      // Apply a fixed 500ms delay before moving to the next wallet (if any)
      if (idx < selectedWallets.length - 1) {
        await new Promise(res => setTimeout(res, 500));
      }
    }

    console.log(chalk.green('\nCompleted rapid buys for the selected wallets.'));
  } else {
    // **Single wallet selected** – continuous mode: execute buy and then prompt for another wallet
    let walletIndex = parsedIndices[0] - 1;
    while (true) {
      const wallet = wallets[walletIndex];
      console.log(chalk.green(`\nProcessing wallet ${wallet.pubKey}...`));
      try {
        const ownerPubKey = new PublicKey(wallet.pubKey);
        const solBalance = await connection.getBalance(ownerPubKey);
        // Determine buy amount (use random between minBuy and maxBuy as above)
        const minBuy = parseFloat(config.minBuy) || 0;
        const maxBuy = parseFloat(config.maxBuy) || minBuy;
        let buyAmountSOL = minBuy;
        if (maxBuy > minBuy) {
          buyAmountSOL = Math.random() * (maxBuy - minBuy) + minBuy;
        }
        buyAmountSOL = parseFloat(buyAmountSOL.toFixed(9));
        const buyAmountLamports = Math.floor(buyAmountSOL * 1e9);

        if (solBalance < buyAmountLamports) {
          console.log(chalk.red(`Wallet ${wallet.pubKey} has insufficient SOL for the buy amount, skipping this transaction.`));
        } else {
          // Prepare PDAs and create/send the transaction
          const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
          const pumpProgramId = new PublicKey(PUMP_PUBLIC_KEY);
          const pump = new PublicKey(PUMP_PUBLIC_KEY);
          const mintPubKey = new PublicKey(tokenCA);
          const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
          const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
          const bCurve = bondingCurvePda.toBase58();
          const aCurve = bondingCurveAta.toBase58();

          const mint = mintPubKey;
          const bondingCurve = new PublicKey(bCurve);
          const aBondingCurve = new PublicKey(aCurve);
          const buyTxObj = await createTX(mint, bondingCurve, aBondingCurve, pump, wallet, buyAmountLamports, slippage);
          const latestBlockhash = await connection.getLatestBlockhash('confirmed');
          const msg = new TransactionMessage({
            payerKey: buyTxObj.payer.publicKey,
            instructions: buyTxObj.instructions,
            recentBlockhash: latestBlockhash.blockhash
          }).compileToV0Message();
          const tx = new VersionedTransaction(msg);
          tx.sign([buyTxObj.payer]);
          const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          await connection.confirmTransaction(signature, 'confirmed');
          console.log(chalk.green(`Buy transaction successful for wallet ${wallet.pubKey}. TXID: ${signature}`));
        }
      } catch (error) {
        console.error(chalk.red(`Error processing wallet ${wallets[walletIndex].pubKey}: ${error.message}`));
      }

      // Prompt for the next wallet index
      const nextInput = await promptUser(chalk.yellow("Enter another wallet number to buy from (or press Enter to exit): "));
      if (!nextInput) {
        // Empty input (user pressed Enter) – exit the continuous mode
        break;
      }
      const nextIndexNum = parseInt(nextInput, 10);
      if (isNaN(nextIndexNum) || nextIndexNum < 1 || nextIndexNum > wallets.length) {
        console.log(chalk.red('Invalid wallet number. Exiting Rapid Buy Mode 1.'));
        break;
      }
      // Set the next wallet index (convert to 0-based)
      walletIndex = nextIndexNum - 1;
      // Loop continues for the new wallet selection
    }

    console.log(chalk.green('\nExited Rapid Buy Mode 1.'));
  }
}

/**
 * Rapid Buy Mode 2:
 * - User must select multiple wallets (at least 2).
 * - Users provide Min Delay and Max Delay (ms). The first interval uses Max Delay, the delays decrease gradually to Min Delay by the last interval.
 */
export async function rapidBuyMode2(tokenCA, rl) {
  // Load configuration and connection
  const config = await loadConfig();
  const rpc = config.rpcURL;
  const ws = config.wsURL;
  const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: ws });
  const slippage = config.slippage || 0.15;

  // Load all wallets
  const wallets = await loadWallets();
  if (!wallets || wallets.length === 0) {
    console.log(chalk.red('No wallets found. Please ensure wallets.txt is not empty.'));
    return;
  }
  console.log(chalk.green('Available wallets:'));
  wallets.forEach((w, idx) => {
    console.log(chalk.yellow(`${idx + 1}:`) + ` ${w.pubKey}`);
  });

  const promptUser = (promptText) => {
    return new Promise(resolve => {
      rl.question(promptText, answer => resolve(answer.trim()));
    });
  };

  // Prompt for multiple wallet indices
  let selectedIndices;
  while (true) {
    const indicesInput = await promptUser(chalk.yellow('Enter wallet numbers to buy from (comma-separated, e.g., 1,2,3): '));
    const indexList = indicesInput.split(',').map(x => x.trim()).filter(x => x !== '');
    const parsedIndices = indexList.map(n => parseInt(n, 10))
                                   .filter(n => !isNaN(n) && n >= 1 && n <= wallets.length);
    if (parsedIndices.length < 2) {
      console.log(chalk.red('Please select at least two wallets for Rapid Buy Mode 2.'));
      continue;
    }
    selectedIndices = parsedIndices.map(i => i - 1);
    break;
  }

  const selectedWallets = selectedIndices.map(i => wallets[i]);

  // Prompt for Min Delay and Max Delay (ms)
  const minDelayInput = await promptUser(chalk.yellow('Enter minimum delay between buys (ms): '));
  const maxDelayInput = await promptUser(chalk.yellow('Enter maximum delay between buys (ms): '));
  const minDelay = parseInt(minDelayInput, 10);
  const maxDelay = parseInt(maxDelayInput, 10);
  if (isNaN(minDelay) || isNaN(maxDelay) || minDelay < 0 || maxDelay < 0 || maxDelay < minDelay) {
    console.log(chalk.red('Invalid delay values provided. Operation cancelled.'));
    return;
  }

  // Prepare token and program accounts
  const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const pumpProgramId = new PublicKey(PUMP_PUBLIC_KEY);
  const pump = new PublicKey(PUMP_PUBLIC_KEY);
  const mintPubKey = new PublicKey(tokenCA);
  const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
  const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
  const bCurve = bondingCurvePda.toBase58();
  const aCurve = bondingCurveAta.toBase58();

  const totalWallets = selectedWallets.length;
  const intervals = totalWallets - 1;  // number of delays between transactions

  for (let idx = 0; idx < selectedWallets.length; idx++) {
    const wallet = selectedWallets[idx];
    console.log(chalk.green(`\nProcessing wallet ${wallet.pubKey} (${idx + 1}/${totalWallets})`));
    try {
      const ownerPubKey = new PublicKey(wallet.pubKey);
      const solBalance = await connection.getBalance(ownerPubKey);
      // Determine buy amount in lamports (random between minBuy and maxBuy)
      const walletKey = `wallet${idx + 1}`;
    let buyAmountSOL = buyAmountsData[walletKey];

    if (buyAmountSOL === undefined) {
    console.error(`No buy amount specified for ${walletKey} in buyAmounts.json. Skipping...`);
    continue;
    }
    const buyAmountLamports = Math.floor(parseFloat(buyAmountSOL) * 1e9);


      if (solBalance < buyAmountLamports) {
        console.log(chalk.red(`Wallet ${wallet.pubKey} has insufficient SOL for the buy amount, skipping.`));
        continue;
      }

      // Create and send buy transaction

      // PAUSE CHECK
      while (isPaused) {
      console.log("Multiple Sell is paused... Press '/' to resume.");
 await new Promise(resolve => setTimeout(resolve, 500));
}
      const mint = mintPubKey;
      const bondingCurve = new PublicKey(bCurve);
      const aBondingCurve = new PublicKey(aCurve);
      const buyTxObj = await createTX(mint, bondingCurve, aBondingCurve, pump, wallet, buyAmountLamports, slippage);
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const msg = new TransactionMessage({
        payerKey: buyTxObj.payer.publicKey,
        instructions: buyTxObj.instructions,
        recentBlockhash: latestBlockhash.blockhash
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([buyTxObj.payer]);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(signature, 'confirmed');
      console.log(chalk.green(`Buy transaction successful for wallet ${wallet.pubKey}. Signature: ${signature}`));
    } catch (error) {
      console.error(chalk.red(`Error processing wallet ${wallet.pubKey}: ${error.message}`));
    }

    // Calculate and wait for the dynamic delay before the next transaction (if any)
    if (idx < totalWallets - 1) {
      let delayMs;
      if (intervals > 1) {
        // Linearly interpolate delay between maxDelay (first interval) and minDelay (last interval)
        const fraction = idx / (intervals - 1);  // fraction of progress through intervals
        delayMs = Math.floor(maxDelay - fraction * (maxDelay - minDelay));
      } else {
        // Only one interval (two wallets selected) – use minDelay
        delayMs = minDelay;
      }
      if (delayMs < minDelay) delayMs = minDelay;
      if (delayMs > maxDelay) delayMs = maxDelay;
      console.log(chalk.cyan(`Waiting for ${delayMs}ms before next transaction...`));
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  console.log(chalk.blue(`Executing buy for ${walletKey}: ${buyAmountSOL} SOL (${buyAmountLamports} lamports)`));

  console.log(chalk.green('\nFinished processing selected wallets in Rapid Buy Mode 2.'));
}
