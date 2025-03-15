// tracker.js - High-performance transaction monitoring for specific tokens
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import loadConfig from './src/loadConfig.js';
import loadWallets from './src/loadWallets.js';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getBondingCurve } from './src/getKeys.js';

/**
 * Monitor transactions for a specific token, filtering out transactions from wallets in wallets.txt
 * @param {string} tokenCA - The token mint address to monitor
 * @param {object} rl - Readline interface for user input
 */
async function trackTokenTransactions(tokenCA, rl) {
    // Load configuration and establish connection
    const config = await loadConfig();
    const connection = new Connection(config.rpcURL, {
        commitment: 'confirmed',
        wsEndpoint: config.wsURL
    });
    
    // Set minimum SOL threshold - only show transactions above this amount
    const MIN_SOL_THRESHOLD = 0.2;
    
    // Parse the token mint into a PublicKey
    const tokenMint = new PublicKey(tokenCA);
    
    // Set up the bonding curve PDAs for this token
    const pumpProgramId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    const bondingCurvePda = getBondingCurve(tokenMint, pumpProgramId);
    const bondingCurveAta = getAssociatedTokenAddressSync(tokenMint, bondingCurvePda, true);
    
    console.log(chalk.blue(`Starting high-performance transaction tracker for token: ${tokenCA}`));
    console.log(chalk.blue(`Bonding Curve PDA: ${bondingCurvePda.toBase58()}`));
    
    // Load wallets to exclude from monitoring
    const ourWallets = await loadWallets();
    const ourWalletAddresses = new Set(ourWallets.map(w => w.pubKey));
    console.log(chalk.yellow(`Loaded ${ourWalletAddresses.size} wallet(s) to exclude from tracking`));
    
    // Set up a table for displaying transactions
    const table = new Table({
        head: [
            chalk.cyan('Time'), 
            chalk.cyan('Wallet'), 
            chalk.cyan('Amount (SOL)'), 
            chalk.cyan('Tokens'),
            chalk.cyan('TX Signature')
        ],
        colWidths: [22, 44, 13, 15, 30]
    });
    
    // Keep track of seen signatures
    const seenSignatures = new Set();
    
    // Setup transaction monitoring
    console.log(chalk.green("Starting to monitor transactions..."));
    console.log(chalk.yellow("Press 'q' then Enter to quit monitoring"));
    
    // Function to prompt for user input
    rl.on('line', (input) => {
        if (input.trim().toLowerCase() === 'q') {
            console.log(chalk.yellow("Stopping transaction tracker..."));
            process.exit(0);
        }
    });

    // Batch process multiple transactions concurrently
    async function batchProcessTransactions(signatures) {
        // Filter out signatures we've already seen
        const newSignatures = signatures.filter(sig => !seenSignatures.has(sig.signature));
        
        if (newSignatures.length === 0) return;
        
        // Add all new signatures to the seen set
        newSignatures.forEach(sig => seenSignatures.add(sig.signature));
        
        // Process all transactions in parallel for speed
        const promises = newSignatures.map(async (sigInfo) => {
            try {
                // Get the full transaction in parsed form
                const tx = await connection.getParsedTransaction(
                    sigInfo.signature,
                    { maxSupportedTransactionVersion: 0 }
                );
                
                if (!tx || !tx.meta || !tx.blockTime) return null;
                
                // Get the fee payer (the wallet making the transaction)
                const wallet = tx.transaction.message.accountKeys[0].pubkey.toBase58();
                
                // Skip if it's one of our wallets
                if (ourWalletAddresses.has(wallet)) {
                    return null;
                }
                
                // Quick check if this transaction involves the token we're tracking
                if (!tx.meta.logMessages || !tx.meta.logMessages.some(msg => 
                    msg.includes(tokenCA) || msg.includes(bondingCurvePda.toBase58())
                )) {
                    return null;
                }
                
                // Look for a token mint instruction (buy) and SOL transfer (payment)
                let isBuy = false;
                let solAmount = 0;
                
                // Fast check for SOL transfers in the transaction
                if (tx.meta.preBalances && tx.meta.postBalances) {
                    const index = tx.transaction.message.accountKeys.findIndex(
                        ak => ak.pubkey.toBase58() === wallet
                    );
                    
                    if (index !== -1) {
                        const preBalance = tx.meta.preBalances[index];
                        const postBalance = tx.meta.postBalances[index];
                        solAmount = (preBalance - postBalance) / 1e9; // Convert lamports to SOL
                    }
                }
                
                // Skip immediately if the SOL amount is below threshold
                if (solAmount <= MIN_SOL_THRESHOLD) {
                    return null;
                }
                
                // Check for token transfer to the user
                let tokenAmount = 0;
                if (tx.meta.postTokenBalances && tx.meta.preTokenBalances) {
                    for (const post of tx.meta.postTokenBalances) {
                        if (post.mint === tokenCA) {
                            const pre = tx.meta.preTokenBalances.find(
                                p => p.accountIndex === post.accountIndex
                            );
                            
                            if (pre && post.owner === wallet) {
                                const preAmount = parseFloat(pre.uiTokenAmount.uiAmountString) || 0;
                                const postAmount = parseFloat(post.uiTokenAmount.uiAmountString) || 0;
                                const change = postAmount - preAmount;
                                
                                if (change > 0) {
                                    isBuy = true;
                                    tokenAmount = change;
                                }
                            }
                        }
                    }
                }
                
                // Only process buy transactions
                if (!isBuy) {
                    return null;
                }
                
                return {
                    time: new Date(tx.blockTime * 1000),
                    wallet,
                    solAmount,
                    tokenAmount,
                    signature: sigInfo.signature
                };
            } catch (error) {
                // Silently fail individual transaction processing
                return null;
            }
        });
        
        // Wait for all transaction processing to complete
        const results = await Promise.all(promises);
        
        // Filter out null results and add valid transactions to the table
        const validTransactions = results.filter(result => result !== null);
        
        if (validTransactions.length > 0) {
            // Sort by timestamp (newest first)
            validTransactions.sort((a, b) => b.time - a.time);
            
            // Add to table
            for (const tx of validTransactions) {
                const dateTime = tx.time.toLocaleString('en-US', { 
                    month: 'numeric', 
                    day: 'numeric',
                    hour: 'numeric', 
                    minute: 'numeric',
                    second: 'numeric',
                    hour12: false 
                });
                
                table.push([
                    dateTime,
                    tx.wallet,
                    tx.solAmount.toFixed(4),
                    tx.tokenAmount.toLocaleString(),
                    tx.signature.slice(0, 26) + '...'
                ]);
            }
            
            // Keep the table at a reasonable size by limiting to the most recent 20 transactions
            while (table.length > 20) {
                table.splice(table.length - 1, 1);
            }
            
            // Clear console and redisplay the table
            console.clear();
            console.log(chalk.green(`Transaction Tracker for ${tokenCA} (Showing transactions > ${MIN_SOL_THRESHOLD} SOL)`));
            console.log(table.toString());
            console.log(chalk.yellow("Press 'q' then Enter to quit monitoring"));
        }
    }

    // High-performance polling mechanism to check for new transactions
    let lastSignature = null;
    let pollInterval = 2000; // Start with 2 second polling interval
    let consecutiveEmptyPolls = 0;
    
    // Adaptive polling function
    async function adaptivePolling() {
        try {
            // Get recent signatures
            const options = lastSignature ? { until: lastSignature, limit: 50 } : { limit: 20 };
            const signatures = await connection.getSignaturesForAddress(
                bondingCurvePda,
                options
            );
            
            if (signatures.length > 0) {
                // Update the last signature we've seen
                lastSignature = signatures[0].signature;
                
                // Process all new signatures in batch
                await batchProcessTransactions(signatures);
                
                // If we found transactions, decrease the poll interval for responsiveness
                if (consecutiveEmptyPolls > 0) {
                    consecutiveEmptyPolls = 0;
                    pollInterval = Math.max(1000, pollInterval - 500); // Decrease poll interval, min 1 second
                }
            } else {
                consecutiveEmptyPolls++;
                
                // If we consistently find no transactions, gradually increase the polling interval
                if (consecutiveEmptyPolls > 3) {
                    pollInterval = Math.min(5000, pollInterval + 500); // Increase poll interval, max 5 seconds
                }
            }
        } catch (error) {
            console.error(chalk.red("Error polling for transactions:"), error);
            // On error, back off polling
            pollInterval = Math.min(5000, pollInterval + 1000);
        }
        
        // Schedule next poll with adaptive interval
        setTimeout(adaptivePolling, pollInterval);
    }
    
    // Initial data load - get recent transactions
    try {
        console.log(chalk.blue("Fetching recent transactions..."));
        const initialSignatures = await connection.getSignaturesForAddress(
            bondingCurvePda,
            { limit: 50 }
        );
        
        if (initialSignatures.length > 0) {
            lastSignature = initialSignatures[0].signature;
            await batchProcessTransactions(initialSignatures);
        }
        
        // Display initial table
        console.clear();
        console.log(chalk.green(`Transaction Tracker for ${tokenCA} (Showing transactions > ${MIN_SOL_THRESHOLD} SOL)`));
        console.log(table.toString());
        console.log(chalk.yellow("Press 'q' then Enter to quit monitoring"));
        
    } catch (error) {
        console.error(chalk.red("Error fetching initial transactions:"), error);
    }
    
    // Start the adaptive polling
    adaptivePolling();
    
    // Keep the process running
    return new Promise((resolve) => {
        // This promise intentionally never resolves to keep the tracker running
        // until the user quits
    });
}

export default trackTokenTransactions;