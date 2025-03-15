// src/humanbuy.js
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
import readline from 'readline';
import humanBuyAmount from './pumpCalcBuy.js'; // Import for token calculation
import BN from 'bn.js';
import { BondingCurveLayout } from './PUMP_LAYOUT.js';

/**
 * Core utility functions - placed at the top to ensure they're defined before use
 */

// Check if wallet has sufficient balance while keeping minimum required SOL
async function checkWalletBalance(connection, wallet, requiredAmount, minKeepAmount = 0.05) {
    try {
        const owner = new PublicKey(wallet.pubKey);
        const walletBalance = await connection.getBalance(owner);
        const walletBalanceSol = walletBalance / 1e9; // Convert lamports to SOL
        
        // Calculate maximum available amount (ensuring minKeepAmount SOL remains)
        const maxAvailableAmount = Math.max(0, walletBalanceSol - minKeepAmount);
        
        return {
            balance: walletBalanceSol,
            maxAvailable: maxAvailableAmount,
            sufficient: maxAvailableAmount >= requiredAmount
        };
    } catch (error) {
        console.error(chalk.red(`Error checking wallet balance: ${error.message}`));
        return {
            balance: 0,
            maxAvailable: 0,
            sufficient: false
        };
    }
}

/**
 * Creates an associated token account for a wallet if it doesn't exist
 * @param {Connection} connection - Solana connection
 * @param {Object} wallet - Wallet object with pubKey and secretKey
 * @param {PublicKey} mintPubKey - Token mint public key
 * @returns {Promise<string>} - Token account address as string
 */
async function createTokenAccountIfNeeded(connection, wallet, mintPubKey) {
    try {
        // Get the wallet's public key
        const ownerPubKey = new PublicKey(wallet.pubKey);
        
        // Determine the associated token account address
        const associatedTokenAddress = getAssociatedTokenAddressSync(
            mintPubKey,
            ownerPubKey
        );
        
        // Check if the token account already exists
        try {
            const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
            
            // If account exists, return its address
            if (accountInfo) {
                console.log(chalk.blue(`Token account ${associatedTokenAddress.toBase58().substring(0, 10)}... already exists`));
                return associatedTokenAddress.toBase58();
            }
        } catch (error) {
            // Error checking account means we should create it
            console.log(chalk.yellow(`Error checking token account: ${error.message}`));
        }
        
        // Create a new associated token account
        console.log(chalk.blue(`Creating new token account for wallet ${ownerPubKey.toBase58().substring(0, 10)}...`));
        
        // Create the transaction
        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                ownerPubKey,              // Payer (wallet that pays for account creation)
                associatedTokenAddress,   // Associated token account address
                ownerPubKey,              // Owner of the token account
                mintPubKey,               // Token mint
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
        
        // Get a recent blockhash
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = ownerPubKey;
        
        // Convert the secret key from base58 string to Uint8Array
        const secretKey = bs58.decode(wallet.secretKey);
        
        // Sign the transaction
        transaction.sign({ publicKey: ownerPubKey, secretKey });
        
        // Send and confirm the transaction
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,  // Enable preflight to catch errors
            preflightCommitment: 'confirmed'
        });
        
        console.log(chalk.green(`Token account created. Signature: ${signature.substring(0, 16)}...`));
        
        // Wait for confirmation
        await connection.confirmTransaction(signature, 'confirmed');
        console.log(chalk.green(`Token account confirmed at ${associatedTokenAddress.toBase58().substring(0, 10)}...`));
        
        return associatedTokenAddress.toBase58();
    } catch (error) {
        console.error(chalk.red(`Error creating token account: ${error.message}`));
        throw error; // Re-throw to handle at the caller level
    }
}

// Calculate optimal buy amount for a wallet based on token supply considerations
async function calculateDynamicBuyAmount(connection, wallet, config, bondingCurvePda, BondingCurveLayout) {
    try {
        // Get wallet balance info
        const balanceInfo = await checkWalletBalance(connection, wallet, 0);
        const walletBalance = balanceInfo.balance;
        
        // Always keep at least 0.05 SOL for fees
        const effectiveBalance = Math.max(0, walletBalance - 0.05);
        
        // If wallet has insufficient funds, return 0
        if (effectiveBalance <= 0) {
            return 0;
        }
        
        // Step 1: Get the bonding curve state
        let bcAccountInfo;
        try {
            bcAccountInfo = await connection.getAccountInfo(bondingCurvePda);
            if (!bcAccountInfo || !bcAccountInfo.data) {
                throw new Error("Bonding curve data not available");
            }
        } catch (error) {
            console.log(chalk.yellow(`Failed to fetch bonding curve data: ${error.message}. Using direct calculation.`));
            return calculateDirectBuyAmount(effectiveBalance);
        }
        
        // Step 2: Deserialize the bonding curve data
        let reservesDecoded;
        try {
            reservesDecoded = BondingCurveLayout.deserialize(bcAccountInfo.data);
            console.log(chalk.cyan(`Bonding curve data: vSol=${reservesDecoded.virtualSolReserves.toString().slice(0, 10)}, vToken=${reservesDecoded.virtualTokenReserves.toString().slice(0, 10)}, rToken=${reservesDecoded.realTokenReserves.toString().slice(0, 10)}`));
            
            // Get current real token reserves as a number
            const realTokenReserves = new BN(reservesDecoded.realTokenReserves.toString()).toNumber() / 1e6;
            console.log(chalk.cyan(`Current real token reserves: ${realTokenReserves.toFixed(2)}M tokens`));
            
            // If real token reserves are too low, reduce buy amount
            if (realTokenReserves < 1.0) {
                console.log(chalk.yellow(`Token reserves below 1M - limiting buy amount to prevent supply issues`));
                return Math.min(0.2, effectiveBalance * 0.5); // Limit to 0.2 SOL or half of balance
            }
        } catch (error) {
            console.log(chalk.yellow(`Failed to deserialize bonding curve: ${error.message}. Using direct calculation.`));
            return calculateDirectBuyAmount(effectiveBalance);
        }
        
        // Try to get estimate from humanBuyAmount like simpleBuy.js does
        let estimatedTokens = 0;
        try {
            // Test with 1 SOL to see what the impact would be
            const testSolAmount = Math.min(1.0, effectiveBalance * 0.5);
            const testLamports = Math.floor(testSolAmount * 1e9);
            
            // Use humanBuyAmount to estimate token output
            estimatedTokens = await humanBuyAmount(bondingCurvePda, testLamports);
            console.log(chalk.cyan(`${testSolAmount.toFixed(4)} SOL would yield approximately ${estimatedTokens.toFixed(6)} tokens`));
            
            // Calculate tokens per SOL ratio to use for scaling
            const ratio = estimatedTokens / testSolAmount;
            console.log(chalk.cyan(`Token/SOL ratio: ${ratio.toFixed(2)}`));
            
            // Calculate maximum SOL we should use to stay under 29M tokens
            const MAX_TARGET_TOKENS = 29000000; // Target 29M tokens to be safe
            const maxSolForTarget = MAX_TARGET_TOKENS / ratio;
            
            // Base our buy amount on this ratio
            let suggestedAmount = Math.min(
                effectiveBalance * 0.7,  // Up to 70% of available balance
                maxSolForTarget,         // Amount to get target tokens
                5.0                      // Hard cap at 5 SOL
            );
            
            // Minimum amount to make the transaction worthwhile
            suggestedAmount = Math.max(suggestedAmount, 0.1);
            
            console.log(chalk.green(`Suggested buy amount based on token output: ${suggestedAmount.toFixed(4)} SOL`));
            return suggestedAmount;
        } catch (error) {
            console.log(chalk.yellow(`Error estimating token output: ${error.message}`));
            // Fall back to direct calculation
            return calculateDirectBuyAmount(effectiveBalance);
        }
    } catch (error) {
        console.error(chalk.red(`Error in calculation: ${error.message}`));
        // Fall back to direct calculation
        return calculateDirectBuyAmount(effectiveBalance);
    }
}

// Direct calculation based on wallet balance
function calculateDirectBuyAmount(effectiveBalance) {
    // Use percentage of available balance based on balance size
    let buyPercentage;
    if (effectiveBalance > 5) {
        // For rich wallets (>5 SOL), use 40-60% of balance
        buyPercentage = 0.4 + (Math.random() * 0.2);
    } else if (effectiveBalance > 1) {
        // For medium wallets (1-5 SOL), use 50-70% of balance
        buyPercentage = 0.5 + (Math.random() * 0.2);
    } else {
        // For small wallets (<1 SOL), use 60-80% of balance
        buyPercentage = 0.6 + (Math.random() * 0.2);
    }
    
    // Calculate amount
    let buyAmount = effectiveBalance * buyPercentage;
    
    // Cap at 5 SOL for very large wallets
    buyAmount = Math.min(buyAmount, 5.0);
    
    // Ensure a minimum of 0.1 SOL for the transaction to be worthwhile
    buyAmount = Math.max(buyAmount, Math.min(0.1, effectiveBalance * 0.9));
    
    console.log(chalk.green(`Direct calculation: ${effectiveBalance.toFixed(4)} SOL * ${buyPercentage.toFixed(2)} = ${buyAmount.toFixed(4)} SOL`));
    
    // Round to 6 decimal places for precision
    return Math.floor(buyAmount * 1000000) / 1000000;
}

// Function from simpleBuy.js to calculate token output
function buyQuote(solLamportsBN, reserves) {
    if (solLamportsBN.eq(new BN(0)) || !reserves) {
        return new BN(0);
    }
    const product = reserves.virtualSolReserves.mul(reserves.virtualTokenReserves);
    const newSolReserves = reserves.virtualSolReserves.add(solLamportsBN);
    const newTokenAmount = product.div(newSolReserves).add(new BN(1));
    let tokensToReceive = reserves.virtualTokenReserves.sub(newTokenAmount);
    tokensToReceive = BN.min(tokensToReceive, reserves.realTokenReserves);
    return tokensToReceive;
}

// New function to determine number of buys before next sell
function determineNextSellPoint() {
    // Metrics: Min: 4, Max: 17, Avg: 7.37
    
    // We'll use a weighted random approach to maintain the average
    // Create a distribution that centers around the average
    const min = 4;
    const max = 17;
    const avg = 7.37;
    
    // Generate a random number between 0 and 1
    const rand = Math.random();
    
    // Use a beta-like distribution to bias toward the average
    // This approach gives more weight to values near the average
    let buyCount;
    
    // 70% chance of being close to average (avg ± 2)
    if (rand < 0.7) {
        buyCount = Math.round(avg - 2 + (Math.random() * 4));
    } 
    // 20% chance of being a bit further from average
    else if (rand < 0.9) {
        // Either lower or higher than the central range
        if (Math.random() < 0.5) {
            buyCount = Math.round(min + Math.random() * (avg - min - 2));
        } else {
            buyCount = Math.round((avg + 2) + Math.random() * (max - avg - 2));
        }
    }
    // 10% chance of being at the extremes
    else {
        if (Math.random() < 0.5) {
            buyCount = min;
        } else {
            buyCount = max;
        }
    }
    
    // Ensure we're within bounds
    buyCount = Math.max(min, Math.min(max, buyCount));
    
    return buyCount;
}

// New function to determine number of consecutive sells
function determineConsecutiveSells(availableWallets) {
    // Metrics: Min: 1, Max: 7, Avg: 2.95
    
    // First, we need to respect the available wallets limit
    const maxPossible = Math.min(7, availableWallets);
    
    // If we only have 1 wallet, we can only do 1 sell
    if (maxPossible <= 1) {
        return 1;
    }
    
    // Now implement a weighted distribution similar to the buy logic
    const min = 1;
    const avg = 2.95;
    
    // Generate a random number
    const rand = Math.random();
    
    let sellCount;
    
    // 65% chance of being close to average (avg ± 1)
    if (rand < 0.65) {
        sellCount = Math.round(avg - 1 + (Math.random() * 2));
    }
    // 25% chance of being a bit further from average
    else if (rand < 0.9) {
        // Either lower or higher than the central range
        if (Math.random() < 0.4) { // Slightly bias toward higher values to maintain average
            sellCount = Math.round(min + Math.random() * (avg - min - 1));
        } else {
            sellCount = Math.round((avg + 1) + Math.random() * (maxPossible - avg - 1));
        }
    }
    // 10% chance of being at the extremes
    else {
        if (Math.random() < 0.3) { // Bias toward higher values to maintain average
            sellCount = min;
        } else {
            sellCount = maxPossible;
        }
    }
    
    // Ensure we're within bounds
    sellCount = Math.max(min, Math.min(maxPossible, sellCount));
    
    return sellCount;
}

// Function to generate a random delay between sells
function getRandomSellDelay() {
    // Metrics: 650ms - 2000ms
    return 650 + Math.floor(Math.random() * 1350);
}

// Execute a buy transaction for a wallet with dynamically calculated amount
async function executeBuy(connection, wallet, ca, bCurve, aCurve, pump, buyAmount, mintPubKey, bondingCurvePda) {
    // Double-check balance to ensure it's sufficient for the buy amount
    const balanceCheck = await checkWalletBalance(connection, wallet, buyAmount);
    if (!balanceCheck.sufficient) {
        console.log(chalk.yellow(`Wallet ${wallet.pubKey.substring(0, 10)}... SOL balance (${balanceCheck.balance.toFixed(4)}) insufficient for ${buyAmount} SOL buy, skipping.`));
        return { success: false };
    }
    
    // Convert to lamports
    const buyAmountLamports = Math.floor(buyAmount * 1e9);
    
    // Check if purchase would yield estimated token output
    try {
        const estimatedTokens = await humanBuyAmount(bondingCurvePda, buyAmountLamports);
        console.log(chalk.blue(`Buy would yield approximately ${estimatedTokens.toFixed(6)} tokens`));
        
        // Placeholder for token supply limit check
        // const currentSupply = 0; // Replace with actual tracking mechanism
        // const maxSupply = 29000000;
        // if (currentSupply + estimatedTokens > maxSupply) {
        //     console.log(chalk.yellow(`Buy would exceed token supply limit of ${maxSupply}, skipping.`));
        //     return { success: false };
        // }
    } catch (error) {
        console.log(chalk.yellow(`Could not estimate token output: ${error.message}`));
        // Continue with the buy even if estimation fails
    }
    
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
        
        // Check if the wallet now has a token balance
        try {
            const tokenAccounts = await connection.getTokenAccountsByOwner(new PublicKey(wallet.pubKey), { mint: mintPubKey });
            
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
async function executeSessionSells(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, lastUsedWalletPubKey = null) {
    // Count available wallets (wallets with tokens that haven't been used for selling)
    const availableWalletCount = Array.from(successfulBuyWallets.entries())
        .filter(([pubKey, _]) => !usedSellWallets.has(pubKey)).length;
    
    if (availableWalletCount === 0) {
        console.log(chalk.yellow("No wallets available for selling."));
        return { success: false, count: 0 };
    }
    
    // Determine number of consecutive sells based on available wallets
    const consecutiveSellCount = determineConsecutiveSells(availableWalletCount);
    console.log(chalk.magenta(`Planning to execute ${consecutiveSellCount} consecutive sells (${availableWalletCount} wallets available)`));
    
    // Keep track of successful sells
    let successfulSells = 0;
    let lastSellWallet = lastUsedWalletPubKey;
    
    // Execute the sells one by one
    for (let i = 0; i < consecutiveSellCount; i++) {
        // Execute a single sell, avoiding the last used wallet
        const sellResult = await executeSessionSell(
            connection, 
            successfulBuyWallets, 
            usedSellWallets, 
            ca, 
            bCurve, 
            aCurve, 
            pump,
            lastSellWallet
        );
        
        if (sellResult.success) {
            successfulSells++;
            lastSellWallet = sellResult.wallet; // Track the wallet used for this sell
            
            // Apply variable delay between sells
            if (i < consecutiveSellCount - 1) {
                const delay = getRandomSellDelay();
                console.log(chalk.blue(`Waiting ${delay}ms before next sell...`));
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } else {
            // If a sell fails, we might want to stop the sequence
            console.log(chalk.yellow(`Sell #${i+1} failed, stopping consecutive sells.`));
            break;
        }
    }
    
    return { success: successfulSells > 0, count: successfulSells };
}

// Modified executeSessionSell function to return the wallet used
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
        
        return { success: false, wallet: null };
    }
    
    // Pick a random wallet from eligible wallets
    const randomIndex = Math.floor(Math.random() * eligibleWallets.length);
    const selectedWalletInfo = eligibleWallets[randomIndex];
    
    console.log(chalk.blue(`Randomly selected wallet #${selectedWalletInfo.walletIndex} (${selectedWalletInfo.wallet.pubKey.substring(0, 10)}...) for sell`));
    
    // Execute the sell with the selected wallet
    const result = await executeWalletSell(connection, successfulBuyWallets, usedSellWallets, ca, bCurve, aCurve, pump, selectedWalletInfo);
    
    // Return success status and the wallet used
    return { 
        success: result, 
        wallet: result ? selectedWalletInfo.wallet.pubKey : null 
    };
}

// Helper function to execute sell for a specific wallet - ENHANCED WITH TOKEN ACCOUNT CREATION
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
            try {
                const owner = new PublicKey(selectedWalletInfo.wallet.pubKey);
                const tokenAccounts = await connection.getTokenAccountsByOwner(owner, { mint });
                
                if (tokenAccounts.value.length === 0) {
                    console.log(chalk.yellow(`No token account found for wallet #${selectedWalletInfo.walletIndex}, attempting to create one...`));
                    
                    try {
                        // Create a token account for this wallet/token pair
                        tokenAccountPubKey = await createTokenAccountIfNeeded(connection, selectedWalletInfo.wallet, mint);
                        
                        // A newly created account will have zero balance, but we'll attempt the sell anyway
                        console.log(chalk.yellow(`Created token account, but it has zero balance. Attempting sell with minimum amount.`));
                        sellAmountLamports = "1"; // Minimum possible amount, will likely fail at blockchain level
                    } catch (createError) {
                        console.error(chalk.red(`Failed to create token account: ${createError.message}`));
                        
                        // Mark this wallet as used to avoid trying it again
                        usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
                        
                        return false;
                    }
                } else {
                    tokenAccountPubKey = tokenAccounts.value[0].pubkey.toBase58();
                    
                    // Check current balance
                    try {
                        const tokenBalance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
                        sellAmountLamports = tokenBalance.value.amount;
                        
                        if (parseInt(sellAmountLamports) <= 0) {
                            console.log(chalk.yellow(`Token account exists but has no balance. Attempting sell with minimum amount anyway.`));
                            sellAmountLamports = "1"; // Will likely fail at blockchain level
                        } else {
                            console.log(chalk.blue(`Found token account with ${tokenBalance.value.uiAmount} tokens.`));
                        }
                    } catch (balanceError) {
                        console.log(chalk.yellow(`Error checking token balance: ${balanceError.message}. Using minimum amount.`));
                        sellAmountLamports = "1"; // Will likely fail at blockchain level
                    }
                }
            } catch (accountError) {
                console.log(chalk.yellow(`Error finding token accounts: ${accountError.message}`));
                
                // Let's try to create a token account as a last resort
                try {
                    tokenAccountPubKey = await createTokenAccountIfNeeded(connection, selectedWalletInfo.wallet, mint);
                    sellAmountLamports = "1"; // Minimum possible amount
                } catch (createError) {
                    console.error(chalk.red(`Failed to create token account as last resort: ${createError.message}`));
                    usedSellWallets.add(selectedWalletInfo.wallet.pubKey);
                    return false;
                }
            }
        } else {
            // We have the token account, check its balance
            try {
                const tokenBalance = await connection.getTokenAccountBalance(new PublicKey(tokenAccountPubKey));
                sellAmountLamports = tokenBalance.value.amount;
                
                if (parseInt(sellAmountLamports) <= 0) {
                    console.log(chalk.yellow(`Selected wallet has no token balance to sell, but will attempt with minimum amount.`));
                    sellAmountLamports = "1"; // Minimum amount
                } else {
                    console.log(chalk.blue(`Selling ${tokenBalance.value.uiAmount} tokens from wallet #${selectedWalletInfo.walletIndex}`));
                }
            } catch (balanceError) {
                console.log(chalk.yellow(`Error checking token balance: ${balanceError.message}. Using minimum amount.`));
                sellAmountLamports = "1"; // Minimum amount
            }
        }
        
        // Execute the sell transaction regardless of token balance
        console.log(chalk.blue(`Executing sell transaction for wallet #${selectedWalletInfo.walletIndex} using token account ${tokenAccountPubKey.substring(0, 10)}...`));
        
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
        
        return false;
    }
}

/**
 * Selects wallets for trading based on specified criteria
 * @param {Array} walletList - Complete list of available wallets with their metadata
 * @param {Object} selectionConfig - Configuration for wallet selection
 * @param {string} selectionConfig.type - Selection mode: "random" or "specific"
 * @param {number} selectionConfig.count - Number of wallets to use (for "random" mode)
 * @param {Array} selectionConfig.indices - Specific wallet indices to select (for "specific" mode)
 * @returns {Array} - Selected wallet objects ready for trading
 */
function selectWalletsForTrading(walletList, selectionConfig) {
    // Validate inputs
    if (!walletList || walletList.length === 0) {
        console.log(chalk.red("No wallets available for selection"));
        return [];
    }
    
    // Handle different selection modes
    if (selectionConfig.type === "random") {
        return selectRandomWallets(walletList, selectionConfig.count);
    } else {
        return selectSpecificWallets(walletList, selectionConfig.indices);
    }
}

/**
 * Selects a random subset of wallets
 * @param {Array} walletList - All available wallets
 * @param {number} count - Number of wallets to select
 * @returns {Array} - Selected wallets
 */
function selectRandomWallets(walletList, count) {
    // Cap count to available wallets
    const walletCount = Math.min(count || 1, walletList.length);
    
    // If requesting all wallets, return the full list
    if (walletCount === walletList.length) {
        console.log(chalk.green(`Using all ${walletCount} available wallets`));
        return [...walletList];
    } 
    
    // Otherwise, randomly select wallets
    const selectedWallets = [];
    const availableIndices = Array.from({ length: walletList.length }, (_, i) => i);
    
    for (let i = 0; i < walletCount; i++) {
        if (availableIndices.length === 0) break;
        
        // Select a random index from remaining available indices
        const randomPosition = Math.floor(Math.random() * availableIndices.length);
        const selectedIndex = availableIndices[randomPosition];
        
        // Remove the selected index from available indices
        availableIndices.splice(randomPosition, 1);
        
        // Add the wallet to selected wallets
        selectedWallets.push(walletList[selectedIndex]);
    }
    
    console.log(chalk.green(`Randomly selected ${selectedWallets.length} wallets: ${selectedWallets.map(w => w.index).join(', ')}`));
    return selectedWallets;
}

/**
 * Selects specific wallets by their indices
 * @param {Array} walletList - All available wallets
 * @param {Array} indices - 1-based indices of wallets to select
 * @returns {Array} - Selected wallets
 */
function selectSpecificWallets(walletList, indices) {
    if (!indices || !Array.isArray(indices) || indices.length === 0) {
        console.log(chalk.red("No valid wallet indices provided. Using first wallet."));
        return walletList.length > 0 ? [walletList[0]] : [];
    }
    
    // Filter valid indices and remove duplicates
    const validIndices = indices
        .filter(idx => idx >= 1 && idx <= walletList.length) // Filter valid indices
        .filter((idx, pos, arr) => arr.indexOf(idx) === pos); // Remove duplicates
    
    if (validIndices.length === 0) {
        console.log(chalk.red("No valid wallet indices provided. Using first wallet."));
        return walletList.length > 0 ? [walletList[0]] : [];
    }
    
    // Convert from 1-based to 0-based indices and map to wallets
    const selectedWallets = validIndices.map(idx => walletList[idx - 1]);
    console.log(chalk.green(`Selected specific wallets: ${validIndices.join(', ')}`));
    
    return selectedWallets;
}

// Main function that handles the buy/sell process
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

        // Use delay values directly in milliseconds
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

        // Initialize tracking variables
        let buyCounter = 0;
        let skippedWallets = 0;
        let successfulBuyWallets = new Map(); // Wallets that successfully bought tokens in this session
        let usedSellWallets = new Set(); // Wallets that have already been used for selling
        let rebuyCountMap = new Map(); // Track rebuy counts
        let blacklistedWallets = new Set(); // Blacklisted wallets
        let buysUntilNextSell; // Will be set using metrics-based approach

        // Map wallets to initial placeholder values
        const walletBuyAmounts = allWallets.map((wallet, index) => {
            return { 
                wallet, 
                buyAmount: null,  // Placeholder - will be calculated at transaction time
                index: index + 1, 
                originalAmount: null  // Will be set at transaction time
            };
        });

        // Select wallets based on user's choice using the consolidated function
        const selectedWallets = selectWalletsForTrading(walletBuyAmounts, walletSelection);

        // Set up metrics-based sell pattern
        console.log(chalk.cyan("\nUsing metrics-based sell pattern..."));
        console.log(chalk.green(`- Buys before sell: 4-17 (avg: 7.37)`));
        console.log(chalk.green(`- Consecutive sells: 1-7 (avg: 2.95)`));
        console.log(chalk.green(`- Sell delay: 650-2000ms`));
        
        // Initial sell point - use the deterministic function
        buysUntilNextSell = buyCounter + determineNextSellPoint();
        console.log(chalk.green(`First sell scheduled after ${buysUntilNextSell} buys`));
        
        // Set constant for maximum rebuy
        const MAX_REBUY_COUNT = 10; // Maximum times a wallet can be rebought - increased to 10

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
                    
                    try {
                        // We need to recalculate the buy amount just before rebuy
                        console.log(chalk.blue(`Calculating rebuy amount for wallet ${pubKey.substring(0, 10)}...`));
                        const newAmount = await calculateDynamicBuyAmount(
                            connection, 
                            originalWalletInfo.wallet, 
                            config, 
                            bondingCurvePda, 
                            BondingCurveLayout
                        );
                        
                        // If calculated amount is too small, blacklist the wallet
                        if (newAmount < 0.01) {
                            console.log(chalk.yellow(`Wallet ${pubKey.substring(0, 10)}... has insufficient funds for meaningful rebuy, blacklisting.`));
                            blacklistedWallets.add(pubKey);
                            continue;
                        }
                        
                        // Log the rebuy amount calculation
                        const balanceInfo = await checkWalletBalance(connection, originalWalletInfo.wallet, 0);
                        console.log(chalk.blue(`Rebuy #${rebuyCount+1} for wallet ${pubKey.substring(0, 10)}... - Balance: ${balanceInfo.balance.toFixed(6)} SOL, Buy amount: ${newAmount.toFixed(6)} SOL`));
                        
                        // Add to wallet cycle with calculated amount
                        walletCycle.push({
                            ...originalWalletInfo,
                            buyAmount: newAmount,
                            isRebuy: true,
                            rebuyCount: rebuyCount + 1
                        });
                    } catch (error) {
                        console.error(chalk.red(`Error calculating rebuy amount for wallet ${pubKey.substring(0, 10)}...: ${error.message}`));
                        // Skip this wallet due to calculation error
                        continue;
                    }
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
                console.log(chalk.blue(`Processing REBUY #${rebuyCount} for wallet #${walletIndex}: ${wallet.pubKey.substring(0, 10)}...`));
            } else {
                console.log(chalk.blue(`Processing wallet #${walletIndex}: ${wallet.pubKey.substring(0, 10)}...`));
            }
            console.log(chalk.blue(`Delay: ${randomDelay} ms`));
            
            // Apply the configured delay before transaction
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // First verify wallet has sufficient balance
                const balanceCheck = await checkWalletBalance(connection, wallet, 0);
                if (balanceCheck.balance <= 0.05) {
                    console.log(chalk.yellow(`Wallet #${walletIndex} SOL balance (${balanceCheck.balance.toFixed(4)}) too low, skipping.`));
                    skippedWallets++;
                    continue; // Skip to next wallet
                }
                
                // Calculate buy amount just-in-time right before the transaction
                console.log(chalk.blue(`Calculating optimal buy amount for wallet #${walletIndex}...`));
                const calculatedBuyAmount = await calculateDynamicBuyAmount(
                    connection, 
                    wallet, 
                    config, 
                    bondingCurvePda, 
                    BondingCurveLayout
                );
                
                // Update the wallet info with the calculated amount
                walletInfo.buyAmount = calculatedBuyAmount;
                walletInfo.originalAmount = calculatedBuyAmount;
                
                // Execute buy transaction with the calculated amount
                const buyResult = await executeBuy(connection, wallet, ca, bCurve, aCurve, pump, calculatedBuyAmount, mintPubKey, bondingCurvePda);
                
                if (buyResult.success) {
                    buyCounter++;
                    
                    if (isRebuy) {
                        // Update the rebuy count map
                        rebuyCountMap.set(wallet.pubKey, rebuyCount);
                        console.log(chalk.green(`Rebuy #${rebuyCount} (Buy #${buyCounter} overall) completed successfully using ${walletInfo.buyAmount.toFixed(6)} SOL from wallet #${walletIndex}`));
                    } else {
                        console.log(chalk.green(`Buy #${buyCounter} completed successfully using ${walletInfo.buyAmount.toFixed(6)} SOL from wallet #${walletIndex}`));
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
                        console.log(chalk.magenta(`Triggering sell sequence after ${buyCounter} buys`));
                        
                        // Execute the consecutive sells using our new function
                        const sellResult = await executeSessionSells(
                            connection,
                            successfulBuyWallets,
                            usedSellWallets,
                            ca,
                            bCurve,
                            aCurve,
                            pump,
                            wallet.pubKey // Avoid selecting the wallet that just bought
                        );
                        
                        if (sellResult.success) {
                            // Set next sell interval based on our metrics
                            const nextSellAfter = determineNextSellPoint();
                            buysUntilNextSell = buyCounter + nextSellAfter;
                            console.log(chalk.magenta(`Completed ${sellResult.count} consecutive sells. Next sell scheduled after ${nextSellAfter} more buys (at buy #${buysUntilNextSell})`));
                        } else {
                            // If sell failed, try again after a short interval
                            const nextAttempt = 2 + Math.floor(Math.random() * 3); // 2-4 buys before retry
                            buysUntilNextSell = buyCounter + nextAttempt;
                            console.log(chalk.magenta(`Sell sequence failed. Will try again after ${nextAttempt} more buys (at buy #${buysUntilNextSell})`));
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
            if (buyCounter % 10 === 0 && buyCounter > 0) {
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

export default humanbuy;