import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import chalk from 'chalk';
import bs58 from 'bs58';
import prompt from 'prompt-sync';
import loadConfig from './loadConfig.js';
import loadWallets from './loadWallets.js';
import createBuyTX from './createBuyTX.js';  // Import transaction creation utility

// Initialize prompt-sync for user input (used for selecting wallets and amounts)
const input = prompt();

/**
 * specialBuy - Allows user to select specific wallets and perform buy transactions
 * with individual amounts per wallet.
 */
async function specialBuy() {
    // Load configuration and establish a connection to the Solana RPC
    const config = await loadConfig();
    const connection = new Connection(config.rpcURL, {
        commitment: 'confirmed',
        wsEndpoint: config.wsURL
    });  // Using the same RPC URL and WS endpoint as other features&#8203;:contentReference[oaicite:0]{index=0}

    // Load all wallets from wallets.txt
    const wallets = await loadWallets();
    if (!wallets || wallets.length === 0) {
        console.log(chalk.red("No wallets found in wallets.txt"));  //&#8203;:contentReference[oaicite:1]{index=1}
        return;
    }

    // Display available wallets with indices for user selection
    console.log(chalk.blue("Available wallets:"));
    wallets.forEach((w, index) => {
        // Show index and a shortened version of the public key for clarity
        const pubKeyStr = w.pubKey;
        const shortKey = pubKeyStr.length > 8 
            ? pubKeyStr.substring(0, 4) + "..." + pubKeyStr.substring(pubKeyStr.length - 4) 
            : pubKeyStr;
        console.log(chalk.blue(`[${index}]`), shortKey);
    });

    // Prompt user to select multiple wallets by index (e.g., "0,2,5")
    const selection = input("Enter wallet indices to use (comma-separated): ");
    if (!selection) {
        console.log(chalk.red("No wallets selected."));
        return;
    }
    // Parse the selection into an array of indices
    const selectedIndices = selection.split(',')
        .map(s => s.trim())
        .filter(s => s !== '')
        .map(Number);
    // Validate all indices
    const validIndices = [];
    for (let idx of selectedIndices) {
        if (Number.isInteger(idx) && idx >= 0 && idx < wallets.length) {
            if (!validIndices.includes(idx)) {
                validIndices.push(idx);
            }
        } else {
            console.log(chalk.red(`Invalid wallet index: ${idx}. Please enter valid indices.`));
            return;
        }
    }
    if (validIndices.length === 0) {
        console.log(chalk.red("No valid wallets selected."));
        return;
    }

    // Prompt for a buy amount for each selected wallet&#8203;:contentReference[oaicite:2]{index=2}
    const walletSelections = [];  // to hold {wallet, index, amount} for each selection
    for (let idx of validIndices) {
        const wallet = wallets[idx];
        const shortKey = wallet.pubKey.substring(0, 4) + "..." + wallet.pubKey.substring(wallet.pubKey.length - 4);
        const amountStr = input(`Enter buy amount (SOL) for wallet [${idx}] (${shortKey}): `);
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) {
            console.log(chalk.red(`Invalid amount entered for wallet [${idx}]. Skipping this wallet.`));
            continue;  // skip this wallet if amount is invalid
        }
        walletSelections.push({ wallet, index: idx, amount });
    }
    if (walletSelections.length === 0) {
        console.log(chalk.red("No valid wallet selections to process."));
        return;
    }

    // Prompt for the token mint (coin address) to buy
    const tokenCA = input("Enter Token CA (mint address of the token to buy): ");
    if (!tokenCA) {
        console.log(chalk.red("Token mint address is required."));
        return;
    }
    const tokenMint = new PublicKey(tokenCA);

    console.log(chalk.green(`\nInitiating buy transactions for ${walletSelections.length} wallet(s)...`));

    // Iterate through each selected wallet and attempt the buy transaction
    for (const { wallet, index, amount } of walletSelections) {
        try {
            const walletPubKey = new PublicKey(wallet.pubKey);
            // Retrieve SOL balance for the wallet&#8203;:contentReference[oaicite:3]{index=3}
            const balanceLamports = await connection.getBalance(walletPubKey);
            const balanceSOL = balanceLamports / 1e9;  // convert lamports to SOL
            console.log(`Wallet [${index}] balance: ${balanceSOL.toFixed(6)} SOL`);

            const lamportsToBuy = Math.floor(amount * 1e9);  // convert buy amount to lamports
            if (lamportsToBuy > balanceLamports) {
                console.log(chalk.red(
                    `Wallet [${index}] has insufficient balance for ${amount} SOL (available: ${balanceSOL} SOL).`
                ));
                continue;  // skip this wallet due to insufficient funds
            }

            // Create the buy transaction for this wallet
            const buyTx = await createBuyTX(wallet, amount, tokenMint);
            // Sign and send the transaction using the wallet's keypair
            const walletKeypair = Keypair.fromSecretKey(bs58.decode(wallet.privKey));
            let txSignature;
            try {
                // Try sending normally (signs with provided keypair)
                txSignature = await connection.sendTransaction(buyTx, [walletKeypair], {
                    skipPreflight: true,
                    maxRetries: 5,
                    commitment: 'confirmed'
                });
            } catch (sendErr) {
                // If sendTransaction failed (e.g., already signed), send raw transaction
                const rawTx = buyTx.serialize();
                txSignature = await connection.sendRawTransaction(rawTx, {
                    skipPreflight: true,
                    maxRetries: 5,
                    commitment: 'confirmed'
                });
            }

            // Log success with transaction signature
            console.log(chalk.green(`Wallet [${index}] buy successful! TXID: ${txSignature}`));  //&#8203;:contentReference[oaicite:4]{index=4}
        } catch (error) {
            // Log any errors without stopping execution for other wallets
            console.log(chalk.red(`Wallet [${index}] buy failed: ${error.message || error}`));
        }
    }
}

export default specialBuy;
