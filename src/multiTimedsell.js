// multiTimedSell.js
import loadWallets from './loadWallets.js';
import { createSellTX } from './createSellTX.js';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getBondingCurve } from './getKeys.js';
import chalk from 'chalk';
import loadConfig from './loadConfig.js';

async function multiTimedSell(tokenCA, rl) {
    // Load configuration and establish connection
    const config = await loadConfig();
    const rpc = config.rpcURL;
    const ws = config.wsURL;
    const connection = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: ws });

    // Load all wallets from file
    const wallets = await loadWallets();
    if (!wallets || wallets.length === 0) {
        console.log(chalk.red('No wallets found. Please ensure wallets.txt is not empty.'));
        return;
    }

    // Display available wallets with indices
    console.log(chalk.green('Available wallets:'));
    wallets.forEach((wallet, index) => {
        console.log(chalk.yellow(`${index + 1}:`) + ` ${wallet.pubKey}`);
    });

    // Helper function to prompt user for input (using provided readline interface)
    function promptUser(promptText) {
        return new Promise(resolve => {
            rl.question(promptText, answer => resolve(answer.trim()));
        });
    }

    // Prompt user to select multiple wallets by entering indices (comma-separated)
    let selectedIndices;
    while (true) {
        const indicesInput = await promptUser(chalk.yellow('Enter indices of wallets to sell from (comma-separated): '));
        const indexList = indicesInput.split(',').map(x => x.trim()).filter(x => x !== '');
        // Convert to 1-based integers and filter out invalid entries
        const parsedIndices = indexList.map(num => parseInt(num, 10))
                                       .filter(num => !isNaN(num) && num >= 1 && num <= wallets.length);
        if (parsedIndices.length === 0) {
            console.log(chalk.red('No valid wallet indices selected. Please try again.'));
            continue;
        }
        // Convert to zero-based indices for array access
        selectedIndices = parsedIndices.map(i => i - 1);
        break;
    }

    // Prepare the chosen wallet objects
    const selectedWallets = selectedIndices.map(i => wallets[i]);

    // Prompt user for a delay for each selected wallet (in milliseconds)
    const delays = [];
    for (let j = 0; j < selectedWallets.length; j++) {
        const wallet = selectedWallets[j];
        const walletLabel = selectedIndices[j] + 1;  // original index (1-based) of this wallet from the list
        const delayInput = await promptUser(chalk.yellow(`Enter delay for wallet ${walletLabel} (${wallet.pubKey}) in ms: `));
        let delay = parseInt(delayInput, 10);
        if (isNaN(delay) || delay < 0) {
            console.log(chalk.red('Invalid delay input. Using default delay of 1000ms.'));
            delay = 1000;
        }
        delays.push(delay);
    }

    // Set up token and program accounts for selling
    const PUMP_PUBLIC_KEY = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const pump = new PublicKey(PUMP_PUBLIC_KEY);
    const pumpProgramId = new PublicKey(PUMP_PUBLIC_KEY);
    const mintPubKey = new PublicKey(tokenCA);
    const bondingCurvePda = getBondingCurve(mintPubKey, pumpProgramId);
    const bondingCurveAta = getAssociatedTokenAddressSync(mintPubKey, bondingCurvePda, true);
    // Use base58 encoding of PDAs for transaction creation consistency
    const bCurve = bondingCurvePda.toBase58();
    const aCurve = bondingCurveAta.toBase58();

    // Iterate through each selected wallet and perform the sell transaction
    for (let idx = 0; idx < selectedWallets.length; idx++) {
        const wallet = selectedWallets[idx];

        // Apply the specific delay for this wallet before processing
        const delay = delays[idx];
        console.log(chalk.cyan(`Waiting for ${delay}ms before processing wallet ${wallet.pubKey}...`));
        await new Promise(resolve => setTimeout(resolve, delay));

        console.log(chalk.green(`\nProcessing wallet ${wallet.pubKey} (${idx + 1}/${selectedWallets.length})`));
        try {
            const ownerPubKey = new PublicKey(wallet.pubKey);
            // Check SOL balance to ensure the wallet can pay transaction fees
            const solBalance = await connection.getBalance(ownerPubKey);
            if (solBalance <= 0) {
                console.log(chalk.red(`Wallet ${wallet.pubKey} has insufficient SOL balance, skipping.`));
                continue;  // skip to next wallet
            }
            // Get token account for the specified token in this wallet
            const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPubKey, { mint: mintPubKey });
            if (tokenAccounts.value.length === 0) {
                console.log(chalk.red(`No token account for mint ${tokenCA} in wallet ${wallet.pubKey}, skipping.`));
                continue;
            }
            const tokenAccountPubKey = tokenAccounts.value[0].pubkey.toBase58();

            // Fetch token balance
            const tokenBalanceInfo = await connection.getTokenAccountBalance(new PublicKey(tokenAccountPubKey));
            const tokenBalance = tokenBalanceInfo.value.uiAmount;
            const tokenBalanceLamports = tokenBalanceInfo.value.amount;
            if (!tokenBalance || tokenBalance <= 0) {
                console.log(chalk.red(`Token balance is zero in wallet ${wallet.pubKey}, skipping.`));
                continue;
            }
            console.log(chalk.blue(`Selling ${tokenBalance} tokens from wallet ${wallet.pubKey}...`));

            // Create the sell transaction for this wallet
            const mint = mintPubKey;
            const bondingCurve = new PublicKey(bCurve);
            const aBondingCurve = new PublicKey(aCurve);
            const sellTx = await createSellTX(mint, bondingCurve, aBondingCurve, pump, wallet, tokenBalanceLamports, tokenAccountPubKey);

            // Build and sign the transaction
            const latestBlockhash = await connection.getLatestBlockhash('finalized');
            const messageV0 = new TransactionMessage({
                payerKey: sellTx.payer.publicKey,
                instructions: sellTx.instructions,
                recentBlockhash: latestBlockhash.blockhash
            }).compileToV0Message();
            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([sellTx.payer]);

            // Send the transaction
            const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
            await connection.confirmTransaction(signature, 'confirmed');
            console.log(chalk.green(`Sell transaction successful for wallet ${wallet.pubKey}. Signature: ${signature}`));
        } catch (error) {
            // Log the error and continue to the next wallet
            console.error(chalk.red(`Error processing wallet ${wallet.pubKey}: ${error.message}`));
        }
        // (No break on error – the loop continues to the next wallet even if this one failed)
    }

    console.log(chalk.green('\nFinished processing selected wallets.'));
}

export default multiTimedSell;
