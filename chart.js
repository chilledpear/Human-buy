// chart.js
// This script accepts a coin contract address (CA) as a command-line argument,
// fetches transaction signatures for that address, computes an implied market cap
// for each transaction (using a fixed buy SOL amount and circulating supply from config),
// groups transactions into 1‑minute intervals (computing OHLC data for reference),
// and then outputs to the terminal (and to a text file) every buy/sell transaction
// with the timestamp, wallet address, token change, SOL spent/received, implied price,
// and market cap. At the end, it prints a prompt instructing an AI to create a candlestick chart
// and compress the data into 60 aggregated buy/sell amounts for replication using 60 wallets.

import { Connection, PublicKey } from '@solana/web3.js';
import loadConfig from './src/loadConfig.js';
import fs from 'fs';

async function main() {
  let outputLines = [];
  const addLine = (line) => {
    console.log(line);
    outputLines.push(line);
  };

  addLine("Loading configuration...");
  const config = await loadConfig();

  // Use circulatingSupply and fixedBuySOL from config (with defaults if not provided)
  const circulatingSupply = config.circulatingSupply ? parseFloat(config.circulatingSupply) : 1e6;
  const fixedBuySOL = config.fixedBuySOL ? parseFloat(config.fixedBuySOL) : 0.02;

  addLine("Circulating Supply: " + circulatingSupply);
  addLine("Fixed Buy SOL: " + fixedBuySOL);

  addLine("Establishing connection to: " + config.rpcURL);
  const connection = new Connection(config.rpcURL, { commitment: 'confirmed' });

  // Read coin contract address from command line
  const coinCA = process.argv[2];
  if (!coinCA) {
    console.error("Usage: node chart.js <coin-contract-address>");
    process.exit(1);
  }
  const address = new PublicKey(coinCA);

  addLine("Fetching transaction signatures for address: " + coinCA);
  let allSignatures = [];
  let options = { limit: 1000 };
  let signatures = await connection.getSignaturesForAddress(address, options);
  while (signatures.length > 0) {
    allSignatures = allSignatures.concat(signatures);
    const lastSignature = signatures[signatures.length - 1].signature;
    options.before = lastSignature;
    signatures = await connection.getSignaturesForAddress(address, options);
    addLine(`Fetched ${allSignatures.length} signatures so far...`);
  }
  addLine("Total transactions fetched: " + allSignatures.length);

  // Process transactions to extract buy/sell data.
  // Each valid transaction will yield:
  //    t           : timestamp (ISO string)
  //    wallet      : fee payer wallet address (first account in message)
  //    tokenChange : change in token balance (positive = Buy, negative = Sell)
  //    type        : "Buy" or "Sell"
  //    solAmount   : fixed SOL amount spent (for buy) or received (for sell)
  //    impliedPrice: fixedBuySOL / |tokenChange| (SOL per token)
  //    marketCap   : impliedPrice * circulatingSupply
  const txData = [];
  let processed = 0;
  for (const sigInfo of allSignatures) {
    try {
      const tx = await connection.getParsedTransaction(sigInfo.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (!tx || !tx.blockTime || !tx.meta) continue;

      // Determine the fee payer wallet address (usually the first account)
      const walletAddress = tx.transaction.message.accountKeys[0].pubkey.toString();

      // Compute token change for the coin (matching mint)
      let tokenChange = null;
      if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
        for (const pre of tx.meta.preTokenBalances) {
          if (pre.mint === coinCA) {
            const post = tx.meta.postTokenBalances.find(p => p.accountIndex === pre.accountIndex);
            if (post && pre.uiTokenAmount && post.uiTokenAmount) {
              const preAmt = parseFloat(pre.uiTokenAmount.uiAmountString) || 0;
              const postAmt = parseFloat(post.uiTokenAmount.uiAmountString) || 0;
              tokenChange = postAmt - preAmt;
              break;
            }
          }
        }
      }
      if (tokenChange === null || tokenChange === 0) continue;

      const type = tokenChange > 0 ? "Buy" : "Sell";
      const impliedPrice = fixedBuySOL / Math.abs(tokenChange); // SOL per token
      const marketCap = impliedPrice * circulatingSupply; // in SOL
      // For our purposes, assume SOL spent (or received) equals fixedBuySOL.
      const solAmount = fixedBuySOL;

      txData.push({
        t: new Date(tx.blockTime * 1000).toISOString(),
        wallet: walletAddress,
        tokenChange: tokenChange,
        type: type,
        solAmount: solAmount,
        impliedPrice: impliedPrice,
        marketCap: marketCap
      });
    } catch (err) {
      console.error("Error processing transaction", sigInfo.signature, err);
    }
    processed++;
    if (processed % 50 === 0) {
      addLine(`Processed ${processed} transactions...`);
    }
  }
  addLine(`Processed transactions. Total valid buy/sell transactions: ${txData.length}`);

  // Optionally, group transactions into 1-minute buckets to compute OHLC for market cap (for reference)
  const minuteBuckets = {};
  txData.forEach(record => {
    const ts = Math.floor(new Date(record.t).getTime() / 1000);
    const bucket = Math.floor(ts / 60) * 60;
    if (!minuteBuckets[bucket]) minuteBuckets[bucket] = [];
    minuteBuckets[bucket].push(record.marketCap);
  });
  const ohlcData = [];
  const sortedTimestamps = Object.keys(minuteBuckets)
    .map(n => parseInt(n, 10))
    .sort((a, b) => a - b);
  sortedTimestamps.forEach(bucket => {
    const values = minuteBuckets[bucket];
    if (values.length === 0) return;
    const open = values[0];
    const close = values[values.length - 1];
    const high = Math.max(...values);
    const low = Math.min(...values);
    ohlcData.push({
      t: new Date(bucket * 1000).toISOString(),
      o: open,
      h: high,
      l: low,
      c: close
    });
  });
  addLine(`Computed OHLC for ${ohlcData.length} intervals.`);
  addLine("Sample OHLC data (first 5 intervals): " + JSON.stringify(ohlcData.slice(0, 5), null, 2));

  // Output all buy/sell transactions to the terminal (and capture to file)
  addLine("\nBuy/Sell Transactions:");
  txData.forEach(record => {
    addLine(
      `${record.t} | Wallet: ${record.wallet} | ${record.type} | Tokens: ${record.tokenChange} | SOL: ${record.solAmount} | Implied Price: ${record.impliedPrice.toFixed(6)} SOL | Market Cap: ${record.marketCap.toFixed(6)} SOL`
    );
  });

  // At the bottom, output an AI prompt.
  addLine("\n--- AI PROMPT ---");
  addLine("Using the above buy/sell transaction data (which includes timestamps, wallet addresses, token changes, SOL amounts, implied prices, and market caps),");
  addLine("please generate an OHLC candlestick chart that visually represents the market cap over time.");
  addLine("Then, compress this data into 60 aggregated buy/sell amounts such that 60 wallets (each capable of a maximum 1 SOL buy) can");
  addLine("replicate a similar chart pattern. Provide a detailed visual description of the chart, including key market cap levels, trends,");
  addLine("and any significant volatility.");
  addLine("--- END AI PROMPT ---");

  // Write all output lines to a text file.
  fs.writeFileSync('output.txt', outputLines.join("\n"), 'utf8');
  addLine("\nData exported to output.txt successfully.");
}

main().catch(err => {
  console.error("Error in chart.js:", err);
});
