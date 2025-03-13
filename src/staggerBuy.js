import {
    Connection,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram
  } from '@solana/web3.js';
  import { getAssociatedTokenAddressSync } from '@solana/spl-token';
  import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';
  import { encode } from '@coral-xyz/anchor/dist/cjs/utils/bytes/utf8.js';
  import bs58 from 'bs58';
  import chalk from 'chalk';
  import fs from 'fs';
  import path from 'path';
  
  import loadConfig from './loadConfig.js';
  import loadWallets from './loadWallets.js';
  import { staggerTX } from './stagger.js';
  import { getKeypairFromBs58 } from './raydium/sell.js';
  import sendBundle from './sendBundle.js';
  import { isPaused } from './hotkeySell.js';

  export default staggerBuy;

  // Helper to derive the bonding curve PDA for a given mint and program ID.
  function getBondingCurve(mintPubkey, programId) {
    const [pda] = PublicKey.findProgramAddressSync(
      [encode("bonding-curve"), mintPubkey.toBuffer()],
      programId
    );
    return pda;
  }
  
  export async function staggerBuy(ca, minDelay, maxDelay, loops, useJito) {
    let config;
    try {
      config = await loadConfig();
    } catch (error) {
      console.error(chalk.red("Failed to load config:"), error);
      throw error;
    }
  
    // Map required config values, with fallbacks for naming differences
    const rpc = config.rpcURL || config.rpc;
    const ws = config.wsURL || config.ws;
    const blockEngineURL = config.blockEngineURL || config.blockEngineUrl;
    const computeUnit = config.computeUnit;      // (should be number of microLamports per CU)
    const computeLimit = config.computeLimit;    // (maximum compute units)
    const slippage = config.slippage;
    const jitoTipKey = config.jitoTip || config.jitoTipPK;
    const jitoTipAmountSol = parseFloat(config.jitoTipAmount || 0);  // in SOL, e.g. 0.00001
    const jitoTipLamports = Math.floor(jitoTipAmountSol * 1e9);      // tip amount in lamports
  
    // Establish connection to Solana RPC
    const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: ws });
    console.log(chalk.green(`RPC connection established: ${rpc}`));
  
    // Load wallets from file
    const wallets = await loadWallets();
    if (!wallets.length) {
      console.log(chalk.red("No wallets found. Ensure wallets.txt is correctly populated."));
      return;
    }
    console.log(chalk.green(`Loaded ${wallets.length} wallet(s) from wallets.txt`));
  
    // Prepare token mint and program IDs
    const mintPubKey = new PublicKey(ca);
    const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");  // Pump program
    const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
    const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
    const bCurveStr = bs58.encode(bondingCurvePda.toBuffer());
    const aCurveStr = bs58.encode(bondingCurveAta.toBuffer());
    console.log(chalk.blue(`Bonding Curve PDA: ${bCurveStr}`));
    console.log(chalk.blue(`Bonding Curve ATA: ${aCurveStr}`));
  
    // If JITO mode, prepare the tip-payer Keypair (from secret key)
    let jitoTipWallet = null;
    if (useJito) {
      if (!jitoTipKey || isNaN(jitoTipLamports) || jitoTipLamports <= 0) {
        console.error(chalk.red("JITO mode is enabled but tip payer key or amount is invalid in config."));
        return;
      }
      try {
        jitoTipWallet = getKeypairFromBs58(jitoTipKey);
        console.log(chalk.green("Loaded JITO tip-payer keypair."));
      } catch (e) {
        console.error(chalk.red("Failed to create Keypair from jitoTip:"), e);
        return;
      }
    }
  
    // Load custom staggered buy amounts if provided, else generate random amounts per wallet
    let buyAmountsConfig = {};
    const buyAmountsPath = path.resolve(process.cwd(), 'buyAmounts.json');
    if (fs.existsSync(buyAmountsPath)) {
      try {
        const rawData = fs.readFileSync(buyAmountsPath, 'utf8');
        buyAmountsConfig = JSON.parse(rawData);
        console.log(chalk.green("Loaded custom buy amounts from buyAmounts.json"));
      } catch {
        console.warn(chalk.yellow("Could not parse buyAmounts.json. Falling back to random buy amounts."));
      }
    }
    const walletBuyAmounts = wallets.map((wallet, index) => {
      const key = `wallet${index + 1}`;
      let amount;
      if (buyAmountsConfig[key] !== undefined) {
        amount = parseFloat(buyAmountsConfig[key]);
      } else {
        const min = parseFloat(config.minBuy), max = parseFloat(config.maxBuy);
        amount = Math.random() * (max - min) + min;
      }
      // Round to 3 decimal places for neatness
      amount = parseFloat(amount.toFixed(3));
      return { wallet, buyAmount: amount };
    });
  
    let totalBuyVolume = 0;
    console.log(chalk.green(`Starting staggered buys for ${loops} loop(s)...`));
  
    for (let i = 0; i < loops; i++) {
      console.log(chalk.cyan(`\n=== Loop ${i+1} of ${loops} ===`));
      for (const { wallet, buyAmount } of walletBuyAmounts) {
        // 1) Pause check
    while (isPaused) {
      console.log("Stagger Buy is paused... Press '/' to resume.");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
        try {
          const owner = new PublicKey(wallet.pubKey);
          const walletKeypair = getKeypairFromBs58(wallet.privKey);
          const balanceLamports = await connection.getBalance(owner);
          const balanceSol = balanceLamports / 1e9;
  
          // Ensure a reserve of 0.05 SOL for future fees/sell
          const reserveSOL = 0.05;
          const availableSol = balanceSol - reserveSOL;
          if (availableSol <= 0) {
            console.log(chalk.yellow(`Wallet ${wallet.pubKey}: balance too low after reserving ${reserveSOL} SOL, skipping.`));
            continue;
          }
  
          // Adjust buy amount if it exceeds available funds
          let adjustedBuy = buyAmount;
          if (adjustedBuy > availableSol) {
            console.log(chalk.yellow(`Wallet ${wallet.pubKey}: Buy amount ${adjustedBuy} SOL exceeds available ${availableSol.toFixed(4)} SOL. Adjusting down.`));
            adjustedBuy = parseFloat(availableSol.toFixed(4));
            if (adjustedBuy < parseFloat(config.minBuy)) {
              console.log(chalk.yellow(`Wallet ${wallet.pubKey}: Adjusted buy ${adjustedBuy} SOL is below minimum ${config.minBuy} SOL, skipping.`));
              continue;
            }
          }
          const buyAmountLamports = Math.floor(adjustedBuy * 1e9);
          totalBuyVolume += adjustedBuy;
          console.log(`Wallet ${wallet.pubKey}: Buying ~${adjustedBuy} SOL worth of tokens (${buyAmountLamports} lamports).`);
  
          // Prepare PublicKey objects for PDA and ATA (associated curve) for instruction
          const bondingCurve = bondingCurvePda;           // PublicKey of bonding curve PDA
          const aBondingCurve = bondingCurveAta;          // PublicKey of associated token account (PDA's token account)
  
          if (useJito) {
            // ** JITO Mode: create a bundled transaction with a priority fee (tip) **
  
            // Pick a random Jito tip account to receive the tip
            const jitoTipAccounts = [
              '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
              'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
              'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
              'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
              'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
              'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
              'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
              '3AVi9Tg9Uo68tJfuvoKvqKNWKc5wPdSSdeBnizKZ6jT'
            ];
            const randomIndex = Math.floor(Math.random() * jitoTipAccounts.length);
            const tipDestination = new PublicKey(jitoTipAccounts[randomIndex]);
            // Create the tip transfer instruction from the tip-payer wallet
            const tipInstruction = SystemProgram.transfer({
              fromPubkey: jitoTipWallet.publicKey,
              toPubkey: tipDestination,
              lamports: jitoTipLamports
            });
  
            // Create the buy instruction via staggerTX (custom function to build the Pump buy TX)
            const buyInstruction = await staggerTX(mintPubKey, bondingCurve, aBondingCurve, owner, buyAmountLamports, slippage);
  
            // Compile both instructions into a versioned message
            const latestBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
            const messageV0 = new TransactionMessage({
              payerKey: owner,
              instructions: [buyInstruction, tipInstruction],
              recentBlockhash: latestBlockhash
            }).compileToV0Message();
            const tx = new VersionedTransaction(messageV0);
            tx.sign([jitoTipWallet, walletKeypair]);  // sign with both tip payer and user wallet
            console.log(chalk.blue(`Wallet ${wallet.pubKey}: Signed JITO bundle transaction.`));
  
            // Simulate the transaction locally to catch errors
            const simulation = await connection.simulateTransaction(tx);
            if (simulation.value.err) {
              console.log(chalk.red(`Simulation failed for wallet ${wallet.pubKey}:`, simulation.value.err));
              continue; // skip sending if simulation shows error
            }
            console.log(chalk.green(`Simulation passed for wallet ${wallet.pubKey} in JITO mode.`));
  
            // Send the bundle to the Jito block engine
            const bundle = new Bundle([], /* default capacity */ 5);
            bundle.addTransactions(tx);
            try {
              const result = await sendBundle(bundle, blockEngineURL);
              console.log(chalk.green(`Wallet ${wallet.pubKey}: Bundle sent via Jito. Bundle ID: ${result}`));
              console.log(`Check bundle status: https://explorer.jito.wtf/bundle/${result}`);
            } catch (error) {
              if (error.message?.includes("already processed transaction")) {
                console.log(chalk.yellow("Bundle landed (already processed transaction)."));
                // We can choose to break out if the bundle landed to avoid duplicate sends
                break;
              } else {
                console.error(`Error sending JITO bundle for wallet ${wallet.pubKey}:`, error);
              }
            }
  
          } else {
            // ** Non-JITO Mode: create a transaction with compute budget instructions **
  
            // Build the buy instruction using staggerTX
            const buyInstruction = await staggerTX(mintPubKey, bondingCurve, aBondingCurve, owner, buyAmountLamports, slippage);
            // Compute budget instructions for priority fee and additional compute units
            const computeIxPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnit });
            const computeIxLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: computeLimit });
            // Compile transaction message (v0) with compute budget + buy instructions
            const latestBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
            const messageV0 = new TransactionMessage({
              payerKey: owner,
              instructions: [computeIxPrice, computeIxLimit, buyInstruction],
              recentBlockhash: latestBlockhash
            }).compileToV0Message();
            const tx = new VersionedTransaction(messageV0);
            tx.sign([walletKeypair]);  // only the wallet needs to sign in non-JITO mode
            console.log(chalk.blue(`Wallet ${wallet.pubKey}: Signed transaction (non-JITO mode).`));
  
            // Simulate the transaction to ensure it will succeed
            const simulation = await connection.simulateTransaction(tx);
            if (simulation.value.err) {
              console.log(chalk.red(`Simulation failed for wallet ${wallet.pubKey}:`, simulation.value.err));
              if (simulation.value.logs) {
                console.log(chalk.red("Simulation logs:\n"), simulation.value.logs.join("\n"));
              }
              continue;
            }
            console.log(chalk.green(`Simulation passed for wallet ${wallet.pubKey} in normal mode.`));
  
            // Send the transaction to the cluster
            try {
              const sig = await connection.sendTransaction(tx, {
                skipPreflight: true,
                preflightCommitment: 'confirmed',
                maxRetries: 3
              });
              console.log(chalk.green(`Wallet ${wallet.pubKey}: Buy transaction sent. Tx Signature: ${sig}`));
            } catch (sendErr) {
              console.error(`Error sending transaction for wallet ${wallet.pubKey}:`, sendErr);
              // (Optionally, continue to next wallet instead of breaking)
              continue;
            }
          } // end if (useJito)
  
          // Delay between transactions (stagger the buys)
          const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
          console.log(chalk.gray(`Waiting ${(delayMs/1000).toFixed(2)}s before next action...`));
          await new Promise(resolve => setTimeout(resolve, delayMs));
  
        } catch (err) {
          console.error(`Error processing wallet ${wallet?.pubKey || ''}:`, err);
          // Continue to next wallet in case of error
          continue;
        }
      } // end for each wallet
    } // end loops
  
    console.log(chalk.green(`\nStagger buy completed. Total buy volume: ${totalBuyVolume.toFixed(4)} SOL`));
  }
  