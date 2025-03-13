// bundleGroupMode.js
import { loadWallets } from './loadWallets.js'; // Adjust path if different
import { createBuyTx, createSellTx, sendBundle } from './transactionUtils.js'; // Adjust path if different
import { loadConfig } from './loadConfig.js'; // Adjust path if different
import { PublicKey } from '@solana/web3.js';

export async function bundleBuySellInGroups() {
    // Load configuration and wallets
    const config = loadConfig();
    const wallets = loadWallets();
    const groupSize = 3;
    const delayBetweenActions = config.delay || 5000; // Delay in ms, default to 5 seconds
    const tokenMint = new PublicKey(config.tokenMint); // Token to trade, from config

    // Group wallets into sets of three
    const groups = [];
    for (let i = 0; i < wallets.length; i += groupSize) {
        groups.push(wallets.slice(i, i + groupSize));
    }

    console.log(`Starting bundle buy/sell mode with ${groups.length} groups of up to 3 wallets each.`);

    // Continuous loop (can be stopped manually, e.g., via Ctrl+C)
    while (true) {
        for (const group of groups) {
            try {
                // Create and send buy transactions for the group
                const buyTxs = group.map(wallet =>
                    createBuyTx(wallet, config.buyAmount, tokenMint)
                );
                await sendBundle(buyTxs);
                console.log(`Sent buy bundle for group: ${group.map(w => w.pubKey.toBase58())}`);
            } catch (error) {
                console.error(`Error sending buy bundle: ${error.message}`);
            }

            // Wait before selling
            await new Promise(resolve => setTimeout(resolve, delayBetweenActions));

            try {
                // Create and send sell transactions for the same group
                const sellTxs = group.map(wallet =>
                    createSellTx(wallet, config.sellAmount, tokenMint)
                );
                await sendBundle(sellTxs);
                console.log(`Sent sell bundle for group: ${group.map(w => w.pubKey.toBase58())}`);
            } catch (error) {
                console.error(`Error sending sell bundle: ${error.message}`);
            }

            // Wait before the next group's actions
            await new Promise(resolve => setTimeout(resolve, delayBetweenActions));
        }
    }
}