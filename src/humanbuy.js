// src/humanbuy.js
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import loadConfig from './loadConfig.js';
import loadWallets from './loadWallets.js';
import chalk from 'chalk';
import { createHumanTX } from './createTX.js';
import { humanSellTX } from './createSellTX.js';
import bs58 from 'bs58';
import { getBondingCurve } from './getKeys.js';
import { isPaused } from './hotkeySell.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline'; // Add readline import

// Function to get the user's choice for sell structure
async function getSellStructureChoice(rl) {
    console.log(chalk.cyan("\n=== Sell Structure ==="));
    console.log(chalk.yellow("1:") + chalk.white(" Predetermined (First sell after 3 buys, subsequent sells after 2-4 buys)"));
    console.log(chalk.yellow("2:") + chalk.white(" Custom (Set your own buy-sell pattern after first sell)"));
    
    return new Promise((resolve) => {
        rl.question(chalk.cyan("Select sell structure option (1-2): "), (answer) => {
            if (answer === "1" || answer.toLowerCase() === "predetermined") {
                resolve({
                    mode: "predetermined",
                    firstSellAfter: 3,
                    subsequentSellRange: [2, 4],
                    doubleSellProbability: 0.367,
                    tripleSellProbability: 0.125
                });
            } else if (answer === "2" || answer.toLowerCase() === "custom") {
                resolve(getCustomSellStructure(rl));
            } else {
                console.log(chalk.red("Invalid selection. Using predetermined sell structure."));
                resolve({
                    mode: "predetermined",
                    firstSellAfter: 3,
                    subsequentSellRange: [2, 4],
                    doubleSellProbability: 0.367,
                    tripleSellProbability: 0.125
                });
            }
        });
    });
}

// Get custom sell structure settings from user
async function getCustomSellStructure(rl) {
    // Settings object with default values
    const settings = {
        mode: "custom",
        firstSellAfter: 3, // This is fixed as per requirement
        subsequentSellRange: [2, 4],
        doubleSellProbability: 0.367,
        tripleSellProbability: 0.125
    };
    
    // Get buy range
    const buyRange = await new Promise((resolve) => {
        rl.question(chalk.cyan("Enter buy range before each sell (format: X-Y, or S to skip): "), (answer) => {
            if (answer.toLowerCase() === "s") {
                resolve(null); // Skip this setting
            } else {
                const match = answer.match(/^(\d+)-(\d+)$/);
                if (match) {
                    const min = parseInt(match[1]);
                    const max = parseInt(match[2]);
                    if (min <= max && min >= 1) {
                        resolve([min, max]);
                    } else {
                        console.log(chalk.red("Invalid range. Using default 2-4."));
                        resolve(null);
                    }
                } else {
                    console.log(chalk.red("Invalid format. Using default 2-4."));
                    resolve(null);
                }
            }
        });
    });
    
    if (buyRange) {
        settings.subsequentSellRange = buyRange;
    }
    
    // Get double sell probability
    const doubleSellProb = await new Promise((resolve) => {
        rl.question(chalk.cyan("Enter probability (0-1) for double sells (or S to skip): "), (answer) => {
            if (answer.toLowerCase() === "s") {
                resolve(null); // Skip this setting
            } else {
                const prob = parseFloat(answer);
                if (!isNaN(prob) && prob >= 0 && prob <= 1) {
                    resolve(prob);
                } else {
                    console.log(chalk.red("Invalid probability. Using default 0.367."));
                    resolve(null);
                }
            }
        });
    });
    
    if (doubleSellProb !== null) {
        settings.doubleSellProbability = doubleSellProb;
    }
    
    // Get triple sell probability
    const tripleSellProb = await new Promise((resolve) => {
        rl.question(chalk.cyan("Enter probability (0-1) for triple sells (or S to skip): "), (answer) => {
            if (answer.toLowerCase() === "s") {
                resolve(null); // Skip this setting
            } else {
                const prob = parseFloat(answer);
                if (!isNaN(prob) && prob >= 0 && prob <= 1) {
                    resolve(prob);
                } else {
                    console.log(chalk.red("Invalid probability. Using default 0.125."));
                    resolve(null);
                }
            }
        });
    });
    
    if (tripleSellProb !== null) {
        settings.tripleSellProbability = tripleSellProb;
    }
    
    console.log(chalk.green("\nCustom sell structure configured:"));
    console.log(chalk.green(`- First sell after: ${settings.firstSellAfter} buys`));
    console.log(chalk.green(`- Subsequent sells range: ${settings.subsequentSellRange[0]}-${settings.subsequentSellRange[1]} buys`));
    console.log(chalk.green(`- Double sell probability: ${settings.doubleSellProbability.toFixed(3)}`));
    console.log(chalk.green(`- Triple sell probability: ${settings.tripleSellProbability.toFixed(3)}`));
    
    return settings;
}

async function humanbuy(ca, walletSelection, maxDelayMs, minDelayMs) {
    // Create a readline interface for user input
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    try {
        // Load configuration
        const config = await loadConfig();
        const rpc = config.rpcURL;
        const ws = config.wsURL;

        // Load buy amounts from buyAmounts.json
        let buyAmounts = {};
        const buyAmountsPath = path.resolve(process.cwd(), 'buyAmounts.json');

        if (fs.existsSync(buyAmountsPath)) {
            try {
                const rawdata = fs.readFileSync(buyAmountsPath, 'utf8');
                buyAmounts = JSON.parse(rawdata);
                console.log(chalk.green("Loaded buy amounts from buyAmounts.json"));
            } catch (error) {
                console.warn(chalk.yellow("Error loading buyAmounts.json, will use default amounts instead:", error.message));
            }
        } else {
            console.warn(chalk.yellow("buyAmounts.json not found, will use default amounts instead"));
        }

        // Use delay values directly in milliseconds - no conversion needed
        const maxDelay = maxDelayMs;
        const minDelay = minDelayMs;

        // Connect to Solana
        const connection = new Connection(rpc, {
            commitment: 'confirmed',
            wsEndpoint: ws
        });

        // Load program constants
        const PUMP_PUBLIC_KEY = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
        const pump = new PublicKey(PUMP_PUBLIC_KEY);
        const pumpProgramId = new PublicKey(PUMP_PUBLIC_KEY);
        const mintPubKey = new PublicKey(ca);

        // Generate bonding curve addresses
        const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
        const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
        const bCurve = bs58.encode(bondingCurvePda.toBuffer());
        const aCurve = bs58.encode(bondingCurveAta.toBuffer());

        // Load all available wallets
        const allWallets = await loadWallets();
        if (allWallets.length === 0) {
            console.log(chalk.red("No wallets found in wallets.txt. Please check the file."));
            return;
        }

        // Map wallets to their configured buy amounts
        const walletBuyAmounts = allWallets.map((wallet, index) => {
            const walletKey = `wallet${index + 1}`;
            let buyAmount;

            if (buyAmounts[walletKey] !== undefined && buyAmounts[walletKey] !== null) {
                buyAmount = parseFloat(buyAmounts[walletKey]);
            } else {
                // Use default from config if no amount is specified
                buyAmount = parseFloat(config.minBuy);
            }

            return { wallet, buyAmount, index: index + 1, originalAmount: buyAmount }; // Store 1-based index and original amount
        });

        // Select wallets based on user's choice
        let selectedWallets;
        
        if (walletSelection.type === "random") {
            // Random selection mode
            const count = Math.min(walletSelection.count, walletBuyAmounts.length);
            
            if (count === walletBuyAmounts.length) {
                // Use all wallets if count matches or exceeds available wallets
                selectedWallets = walletBuyAmounts;
                console.log(chalk.green(`Using all ${count} available wallets`));
            } else {
                // Randomly select count wallets
                selectedWallets = [];
                const availableIndices = Array.from({ length: walletBuyAmounts.length }, (_, i) => i);
                
                for (let i = 0; i < count; i++) {
                    // Select a random index from remaining available indices
                    const randomPosition = Math.floor(Math.random() * availableIndices.length);
                    const selectedIndex = availableIndices[randomPosition];
                    
                    // Remove the selected index from available indices
                    availableIndices.splice(randomPosition, 1);
                    
                    // Add the wallet to selected wallets
                    selectedWallets.push(walletBuyAmounts[selectedIndex]);
                }
                
                console.log(chalk.green(`Randomly selected ${count} wallets: ${selectedWallets.map(w => w.index).join(', ')}`));
            }
        } else {
            // Specific selection mode
            const indices = walletSelection.indices
                .filter(idx => idx >= 1 && idx <= walletBuyAmounts.length) // Filter valid indices
                .filter((idx, pos, arr) => arr.indexOf(idx) === pos); // Remove duplicates
            
            if (indices.length === 0) {
                console.log(chalk.red("No valid wallet indices provided. Using wallet #1."));
                selectedWallets = [walletBuyAmounts[0]];
            } else {
                // Convert from 1-based to 0-based indices and map to wallets
                selectedWallets = indices.map(idx => walletBuyAmounts[idx - 1]);
                console.log(chalk.green(`Selected specific wallets: ${indices.join(', ')}`));
            }
        }

        // Get sell structure settings from user
        console.log(chalk.cyan("\nConfiguring sell transaction behavior..."));
        const sellStructure = await getSellStructureChoice(rl);
        
        // Variables to track progress
        let buyCounter = 0;
        let buysUntilNextSell = sellStructure.firstSellAfter; // Always start with 3 buys before first sell
        let skippedWallets = 0;
        
        // Create maps to track wallets that have bought and sold in this session
        let successfulBuyWallets = new Map(); // Wallets that successfully bought tokens in this session
        let usedSellWallets = new Set(); // Wallets that have already been used for selling
        
        // Rebuy tracking
        let rebuyCountMap = new Map(); // Track how many times each wallet has been rebought
        let blacklistedWallets = new Set(); // Wallets that have reached their rebuy limit
        const MAX_REBUY_COUNT = 3; // Maximum times a wallet can be rebought

        console.log(chalk.green(`Starting Human Buy process for token ${ca}`));
        console.log(chalk.cyan(`Press '/' to pause/resume at any time`));
        
        // Display wallet details and buy amounts
        console.log(chalk.cyan('\nWallets and Buy Amounts:'));
        selectedWallets.forEach((item, i) => {
            console.log(chalk.cyan(
                `${i + 1}) Wallet #${item.index}: ${item.wallet.pubKey.substring(0, 10)}... - ${item.buyAmount} SOL`
            ));
        });
        console.log(); // Empty line for readability
        
        // Flag to track if we've used all wallets
        let allWalletsUsed = false;
        // Counter to track position in the wallet cycling
        let walletCyclePosition = 0;
        // Copy of selected wallets for cycling through them
        let walletCycle = [...selectedWallets];
        
        // Main transaction loop - continue until manual stop
        while (true) {
            // Check if we should pause
            while (isPaused) {
                console.log(chalk.yellow("Process paused. Press '/' to resume."));
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Check if we've used all wallets and need to switch to rebuy mode
            if (walletCyclePosition >= walletCycle.length) {
                // Refresh wallet cycle by adding wallets from usedSellWallets that aren't blacklisted
                walletCycle = [];
                
                for (const pubKey of usedSellWallets) {
                    // Skip blacklisted wallets
                    if (blacklistedWallets.has(pubKey)) continue;
                    
                    // Find the original wallet info
                    const originalWalletInfo = selectedWallets.find(w => w.wallet.pubKey === pubKey);
                    if (!originalWalletInfo) continue;
                    
                    // Get current rebuy count (default to 0 if not set)
                    const rebuyCount = rebuyCountMap.get(pubKey) || 0;
                    
                    // Skip if wallet has reached rebuy limit
                    if (rebuyCount >= MAX_REBUY_COUNT) {
                        blacklistedWallets.add(pubKey);
                        console.log(chalk.yellow(`Wallet ${pubKey.substring(0, 10)}... has reached rebuy limit of ${MAX_REBUY_COUNT}, blacklisting.`));
                        continue;
                    }
                    
                    // Calculate reduced buy amount (75% of previous amount)
                    const previousAmount = originalWalletInfo.originalAmount * Math.pow(0.75, rebuyCount);
                    const newAmount = previousAmount * 0.75;
                    
                    // Add to wallet cycle with adjusted amount
                    walletCycle.push({
                        ...originalWalletInfo,
                        buyAmount: newAmount,
                        isRebuy: true,
                        rebuyCount: rebuyCount + 1
                    });
                }
                
                // If no wallets are available for rebuy, we're done
                if (walletCycle.length === 0) {
                    console.log(chalk.red("All wallets have reached their rebuy limit. Stopping."));
                    break;
                }
                
                // Reset position
                walletCyclePosition = 0;
                
                console.log(chalk.green(`Starting rebuy cycle with ${walletCycle.length} wallets.`));
                
                // Shuffle the wallets for randomness
                walletCycle.sort(() => Math.random() - 0.5);
            }
            
            // Get the next wallet to use
            const walletInfo = walletCycle[walletCyclePosition++];
            const { wallet, buyAmount, index: walletIndex, isRebuy, rebuyCount } = walletInfo;
            
            // Calculate a random delay between min and max
            const randomDelay = Math.round(minDelay + Math.random() * (maxDelay - minDelay));
            
            // Log info about the current operation
            if (isRebuy) {
                console.log(chalk.blue(`REBUY #${rebuyCount} for wallet #${walletIndex}: ${wallet.pubKey.substring(0, 10)}...`));
                console.log(chalk.blue(`Reduced buy amount: ${buyAmount.toFixed(6)} SOL (${(buyAmount/walletInfo.originalAmount*100).toFixed(1)}% of original), Delay: ${randomDelay} ms`));
            } else {
                console.log(chalk.blue(`Processing wallet #${walletIndex}: ${wallet.pubKey.substring(0, 10)}...`));
                console.log(chalk.blue(`Buy amount: ${buyAmount} SOL, Delay: ${randomDelay} ms`));
            }
            
            // Apply the configured delay before transaction
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // Check wallet balance before attempting to execute buy
                const owner = new PublicKey(wallet.pubKey);
                const walletBalance = await connection.getBalance(owner);
                const walletBalanceSol = walletBalance / 1e9; // Convert lamports to SOL
                
                // Skip wallet if balance is too low for the configured amount
                if (walletBalanceSol <= buyAmount + 0.005) { // Adding 0.005 for transaction fees
                    console.log(chalk.yellow(`Wallet #${walletIndex} SOL balance (${walletBalanceSol.toFixed(4)}) too low for buy amount ${buyAmount}, skipping.`));
                    skippedWallets++;
                    continue; // Skip to next wallet
                }
                
                // Execute buy transaction with the exact configured amount
                const buyResult = await executeBuy(connection, wallet, ca, bCurve, aCurve, pump, buyAmount, mintPubKey);
                
                if (buyResult.success) {
                    buyCounter++;
                    
                    if (isRebuy) {
                        // Update the rebuy count map
                        rebuyCountMap.set(wallet.pubKey, rebuyCount);
                        console.log(chalk.green(`Rebuy #${rebuyCount} (Buy #${buyCounter} overall) completed successfully using ${buyAmount.toFixed(6)} SOL from wallet #${walletIndex}`));
                    } else {
                        console.log(chalk.green(`Buy #${buyCounter} completed successfully using ${buyAmount} SOL from wallet #${walletIndex}`));
                    }
                    
                    // Add wallet to the successful buy wallets map with its token account and balance
                    successfulBuyWallets.set(wallet.pubKey, {
                        wallet,
                        walletIndex,
                        tokenAccountPubKey: buyResult.tokenAccountPubKey,
                        balance: buyResult.tokenBalance
                    });
                    
                    // Check if we should execute a sell after this buy
                    if (buyCounter >= buysUntilNextSell) {
                        console.log(chalk.magenta(`Triggering sell transaction after ${buyCounter} buys`));
                        
                        // Determine how many sells to do based on probabilities
                        let sellsToExecute = 1;
                        const random = Math.random();
                        
                        if (random < sellStructure.tripleSellProbability) {
                            sellsToExecute = 3;
                            console.log(chalk.magenta(`Triple sell triggered (probability: ${sellStructure.tripleSellProbability.toFixed(3)})`));
                        } else if (random < sellStructure.tripleSellProbability + sellStructure.doubleSellProbability) {
                            sellsToExecute = 2;
                            console.log(chalk.magenta(`Double sell triggered (probability: ${sellStructure.doubleSellProbability.toFixed(3)})`));
                        }
                        
                        // Execute the sell(s)
                        let sellSuccess = false;
                        for (let j = 0; j < sellsToExecute; j++) {
                            if (successfulBuyWallets.size === 0) {
                                console.log(chalk.yellow(`No more wallets available for sell #${j+1}`));
                                break;
                            }
                            
                            // Pass the last used wallet (current one that just bought) to avoid selecting it
                            const thisSellSuccess = await executeSessionSell(
                                connection, 
                                successfulBuyWallets, 
                                usedSellWallets, 
                                ca, 
                                bCurve, 
                                aCurve, 
                                pump,
                                wallet.pubKey // Pass the wallet that just bought tokens to avoid selecting it
                            );
                            
                            sellSuccess = sellSuccess || thisSellSuccess;
                            
                            // Minimal delay between multiple sells - reduced to 200ms
                            if (j < sellsToExecute - 1) {
                                await new Promise(resolve => setTimeout(resolve, 200));
                            }
                        }
                        
                        if (sellSuccess) {
                            // Set next sell interval based on sell structure settings
                            const min = sellStructure.subsequentSellRange[0];
                            const max = sellStructure.subsequentSellRange[1];
                            const nextSellAfter = min + Math.floor(Math.random() * (max - min + 1));
                            buysUntilNextSell = buyCounter + nextSellAfter;
                            console.log(chalk.magenta(`Next sell scheduled after ${nextSellAfter} more buys (total: ${buysUntilNextSell})`));
                        } else {
                            // If sell failed, try again after 2 more buys
                            buysUntilNextSell = buyCounter + 2;
                            console.log(chalk.magenta(`Sell failed. Will try again after 2 more buys (total: ${buysUntilNextSell})`));
                        }
                    }
                } else {
                    console.log(chalk.yellow(`Buy transaction failed for wallet #${walletIndex}, skipping.`));
                    skippedWallets++;
                }
            } catch (error) {
                console.error(chalk.red(`Error processing wallet #${walletIndex}: ${error.message}`));
                skippedWallets++;
                // Continue to next wallet
            }
            
            // Log periodic summary every 10 buys
            if (buyCounter % 10 === 0) {
                console.log(chalk.green(`\n--- Progress Summary ---`));
                console.log(chalk.green(`Total buys: ${buyCounter}`));
                console.log(chalk.green(`Total sells: ${usedSellWallets.size}`));
                console.log(chalk.green(`Skipped wallets: ${skippedWallets}`));
                console.log(chalk.green(`Rebuys: ${Array.from(rebuyCountMap.values()).reduce((sum, count) => sum + count, 0)}`));
                console.log(chalk.green(`Blacklisted wallets: ${blacklistedWallets.size}`));
                console.log(chalk.green(`Next sell at buy #: ${buysUntilNextSell}`));
                console.log(chalk.green(`------------------\n`));
            }
            
            // Check if user wants to exit (this will be handled by the pause mechanism)
        }
    } catch (error) {
        console.error(chalk.red(`Fatal error in human buy process: ${error.message}`));
        console.error(error);
    } finally {
        // Make sure to close the readline interface when done
        rl.close();
        console.log(chalk.green(`Human Buy process terminated.`));
        console.log(chalk.green(`Final Summary:`));
        console.log(chalk.green(`- Total buys: ${buyCounter || 0}`));
        console.log(chalk.green(`- Total sells: ${usedSellWallets?.size || 0}`));
        console.log(chalk.green(`- Skipped wallets: ${skippedWallets || 0}`));
    }
}

// Execute a buy transaction for a wallet with exact buy amount
async function executeBuy(connection, wallet, ca, bCurve, aCurve, pump, buyAmount, mintPubKey) {
    const owner = new PublicKey(wallet.pubKey);
    const walletBalance = await connection.getBalance(owner);
    const walletBalanceSol = walletBalance / 1e9; // Convert lamports to SOL
    
    // Double-check balance to ensure it's sufficient for the exact buy amount
    if (walletBalanceSol <= buyAmount + 0.005) {
        console.log(chalk.yellow(`Wallet ${wallet.pubKey.substring(0, 10)}... SOL balance (${walletBalanceSol.toFixed(4)}) insufficient for ${buyAmount} SOL buy, skipping.`));
        return { success: false };
    }
    
    // Convert to lamports - using the exact amount from buyAmounts.json
    const buyAmountLamports = Math.floor(buyAmount * 1e9);
    
    console.log(chalk.green(`Buying exactly ${buyAmount} SOL worth of tokens from wallet ${wallet.pubKey.substring(0, 10)}...`));
    
    const mint = new PublicKey(ca);
    const bondingCurve = new PublicKey(bCurve);
    const aBondingCurve = new PublicKey(aCurve);
    
    try {
        // Create the transaction (humanTX doesn't use JITO)
        const fullTX = await createHumanTX(mint, bondingCurve, aBondingCurve, pump, wallet, buyAmountLamports);
        
        // Set up a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Transaction timed out after 5 seconds")), 5000);
        });
        
        // Send transaction with timeout
        const sendPromise = connection.sendTransaction(fullTX, {
            skipPreflight: true,
            preflightCommitment: 'confirmed'
        });
        
        // Race the send against the timeout
        const signature = await Promise.race([sendPromise, timeoutPromise]);
        console.log(chalk.green(`Buy transaction sent: ${signature.substring(0, 16)}...`));
        
        // OPTIMIZATION: Removed the 1000ms delay that was here
        
        // Check if the wallet now has a token balance
        try {
            const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint: mintPubKey });
            
            if (tokenAccounts.value.length === 0) {
                console.log(chalk.yellow(`No token account created for this wallet yet, transaction may still be processing.`));
                return { success: true }; // Assume success since we got a signature
            }
            
            const tokenAccountPubKey = tokenAccounts.value[0].pubkey;
            const tokenBalanceInfo = await connection.getTokenAccountBalance(tokenAccountPubKey);
            const tokenBalance = tokenBalanceInfo.value.amount;
            
            console.log(chalk.green(`Wallet now has ${tokenBalanceInfo.value.uiAmount} tokens`));
            
            return { 
                success: true, 
                tokenAccountPubKey: tokenAccountPubKey.toBase58(),
                tokenBalance
            };
        } catch (balanceError) {
            console.log(chalk.yellow(`Couldn't check token balance: ${balanceError.message}`));
            return { success: true }; // Assume success since we got a signature
        }
    } catch (error) {
        console.error(chalk.red(`Error sending buy transaction: ${error.message}`));
        return { success: false };
    }
}

// Execute a sell from a random wallet that has bought tokens in this session
async function executeSessionSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastUsedWalletPubKey = null) {
    // Filter out wallets that have already been used for selling and the last used wallet
    const eligibleWallets = Array.from(successfulBuyWallets.entries())
        .filter(([pubKey, _]) => {
            // Filter out wallets that have been used for selling
            if (usedSellWallets.has(pubKey)) return false;
            
            // Filter out the most recently used wallet (if provided and there are enough wallets)
            if (lastUsedWalletPubKey === pubKey && successfulBuyWallets.size > 1) {
                console.log(chalk.yellow(`Skipping most recently used wallet ${pubKey.substring(0, 10)}... for sell to avoid patterns`));
                return false;
            }
            
            return true;
        })
        .map(([_, info]) => info);
    
    if (eligibleWallets.length === 0) {
        console.log(chalk.yellow("No eligible wallets available for selling (all wallets have been used or have no balance)."));
        
        // Special case: If we only have the last used wallet left and we're avoiding it, but have no alternatives
        if (lastUsedWalletPubKey && successfulBuyWallets.has(lastUsedWalletPubKey) && !usedSellWallets.has(lastUsedWalletPubKey)) {
            console.log(chalk.yellow("Only the most recently used wallet is available. Using it as fallback."));
            const lastWalletInfo = successfulBuyWallets.get(lastUsedWalletPubKey);
            return executeWalletSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastWalletInfo);
        }
        
        return false;
    }
    
    // Pick a random wallet from eligible wallets
    const randomIndex = Math.floor(Math.random() * eligibleWallets.length);
    const selectedWalletInfo = eligibleWallets[randomIndex];
    
    console.log(chalk.blue(`Randomly selected wallet #${selectedWalletInfo.walletIndex} (${selectedWalletInfo.wallet.pubKey.substring(0, 10)}...) for sell`));
    
    // Execute the sell with the selected wallet
    return executeWalletSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, selectedWalletInfo);
}

// Helper function to execute sell for a specific wallet (extracted from executeSessionSell)
async function executeWalletSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, selectedWalletInfo) {
    try {
        const mint = new PublicKey(ca);
        const bondingCurve = new PublicKey(bCurve);
        const aBondingCurve = new PublicKey(aCurve);
        
        // Get updated token balance
        let tokenAccountPubKey = selectedWalletInfo.tokenAccountPubKey;
        let sellAmountLamports;
        
        // If we don't have the token account info yet (could happen if buy tx was too recent)
        if (!tokenAccountPubKey) {
            const owner = new PublicKey(selectedWalletInfo.wallet.pubKey);
            const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint });
            
            if (tokenAccounts.value.length === 0) {
                console.log(chalk.yellow(`No token account found for this wallet, skipping sell.`));
                
                // Mark this wallet as used to avoid trying it again
                usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
                
                // Try another wallet, passing the same lastUsedWalletPubKey
                return executeSessionSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastUsedWalletPubKey);
            }
            
            tokenAccountPubKey = tokenAccounts.value[0].pubkey.toBase58();
        }
        
        // Get current token balance
        const tokenBalance = await connection.getTokenAccountBalance(new PublicKey(tokenAccountPubKey));
        sellAmountLamports = tokenBalance.value.amount;
        
        if (parseInt(sellAmountLamports) <= 0) {
            console.log(chalk.yellow(`Selected wallet has no token balance to sell, skipping.`));
            
            // Mark this wallet as used
            usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
            
            // Try another wallet, passing the same lastUsedWalletPubKey
            return executeSessionSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastUsedWalletPubKey);
        }
        
        console.log(chalk.blue(`Selling ${tokenBalance.value.uiAmount} tokens from wallet #${selectedWalletInfo.walletIndex}`));
        
        // Execute the sell transaction
        const fullTXSell = await humanSellTX(
            mint, 
            bondingCurve, 
            aBondingCurve, 
            pump, 
            selectedWalletInfo.wallet, 
            sellAmountLamports, 
            tokenAccountPubKey
        );
        
        // Set up a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Sell transaction timed out after 5 seconds")), 5000);
        });
        
        // Send transaction with timeout
        const sendPromise = connection.sendTransaction(fullTXSell, {
            skipPreflight: true,
            preflightCommitment: 'confirmed'
        });
        
        // Race the send against the timeout
        const signature = await Promise.race([sendPromise, timeoutPromise]);
        console.log(chalk.green(`Sell transaction sent: ${signature.substring(0, 16)}...`));
        
        // Mark this wallet as used for selling
        usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
        
        // Remove it from the successful buy wallets map (it no longer has a balance)
        successfulBuyWallets.delete(selectedWalletInfo.wallet.pubKey);
        
        return true;
    } catch (error) {
        console.error(chalk.red(`Error executing sell: ${error.message}`));
        
        // If there was an error, we should try another wallet
        usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
        
        // If we have other eligible wallets, try again
        if (eligibleWallets.length > 1) {
            console.log(chalk.yellow(`Trying another wallet for sell operation...`));
            return executeSessionSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastUsedWalletPubKey);
        }
        
        return false;
    }
}

export default humanbuy;